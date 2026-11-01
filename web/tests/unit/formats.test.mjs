// Unit tests for the resource parsers: G-NOME.BIN's header and index
// (src/binfile.js), bitmaps with their RLE and LZW packing (src/bitmap.js),
// FRME animations and OB3D/OPRT objects (src/anim/formats.js). Every file
// is built in the test, so no game files are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BinFile, KEY, RT, palette256, WIN_STATIC_LOW, WIN_STATIC_HIGH } from "../../src/binfile.js";
import { parseBitmap, decodeBitmap, decompressPacked } from "../../src/bitmap.js";
import { Frme, parseObjectDef, IDENTITY } from "../../src/anim/formats.js";

// Little-endian byte writer.
class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(...v) {
    this.bytes.push(...v.map((x) => x & 0xff));
    return this;
  }
  u16(v) {
    return this.u8(v, v >> 8);
  }
  u32(v) {
    return this.u8(v, v >>> 8, v >>> 16, v >>> 24);
  }
  f32(v) {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    return this.u8(...b);
  }
  str(s) {
    return this.u8(...[...s].map((c) => c.charCodeAt(0)));
  }
  get length() {
    return this.bytes.length;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

// ------------------------------------------------------------------ bitmaps

const bitmapHeader = (w, h, flags, x = 0, y = 0) => new Writer().u32(w).u32(h).u32(flags).u32(x).u32(y).u32(1234);

test("parseBitmap reads the header and hotspot", () => {
  const bm = parseBitmap(bitmapHeader(3, 2, 0x80, -5, 7).u8(9, 9).done());
  assert.deepEqual({ ...bm, body: [...bm.body] }, { width: 3, height: 2, flags: 0x80, x: -5, y: 7, body: [9, 9] });
});

test("RLE bitmaps: runs, short and long literals, row offsets", () => {
  // 6x2. Row 0: run of 4 x colour 7, literal [1, 2]. Row 1: long literal
  // (0xff, n) of 6 bytes.
  const rows = [
    [4, 7, 0xff - 2, 1, 2, 0],
    [0xff, 6, 10, 11, 12, 13, 14, 15, 0],
  ];
  const w = bitmapHeader(6, 2, 0x80);
  let off = 4;
  for (const r of rows) {
    w.u16(off);
    off += r.length;
  }
  for (const r of rows) w.u8(...r);
  const bm = decodeBitmap(w.done());
  assert.deepEqual([...bm.pixels], [7, 7, 7, 7, 1, 2, 10, 11, 12, 13, 14, 15]);
});

test("RLE rows that end early leave colour 0 (transparent)", () => {
  const w = bitmapHeader(4, 1, 0x80).u16(2).u8(2, 5, 0);
  assert.deepEqual([...decodeBitmap(w.done()).pixels], [5, 5, 0, 0]);
});

test("packed bitmaps: stored blocks, rows padded to 4, bottom row first", () => {
  // 3x2: stored rows are bottom first, each padded to 4 bytes.
  const raw = [4, 5, 6, 0, 1, 2, 3, 0];
  const w = bitmapHeader(3, 2, 0).u16(raw.length).u8(...raw).u16(0xe000);
  assert.deepEqual([...decodeBitmap(w.done()).pixels], [1, 2, 3, 4, 5, 6]);
});

// LZW as RTLIB32 packs it: fixed-width MSB-first codes, 0-255 bytes, new
// strings from 256, all-ones code ends, no reset.
function lzw(data, bits) {
  const end = (1 << bits) - 1;
  const dict = new Map();
  let next = 256;
  const codes = [];
  let w = String.fromCharCode(data[0]);
  for (let i = 1; i < data.length; i++) {
    const c = String.fromCharCode(data[i]);
    if (dict.has(w + c) || (w + c).length === 1) w += c;
    else {
      codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
      if (next < end) dict.set(w + c, next++);
      w = c;
    }
  }
  codes.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  codes.push(end);
  const out = [];
  let acc = 0, n = 0;
  for (const c of codes) {
    acc = (acc << bits) | c;
    n += bits;
    while (n >= 8) {
      out.push((acc >> (n - 8)) & 0xff);
      n -= 8;
    }
    acc &= (1 << n) - 1;
  }
  if (n) out.push((acc << (8 - n)) & 0xff);
  return out;
}

test("decompressPacked: LZW chunks with 10, 11 and 12-bit codes", () => {
  const text = [..."TOBEORNOTTOBEORTOBEORNOT#TOBEORNOTTOBEORTOBEORNOT".repeat(4)].map((c) => c.charCodeAt(0));
  for (const [method, bits] of [[0x4000, 10], [0x6000, 11], [0x8000, 12]]) {
    const chunk = lzw(text, bits);
    assert.ok(chunk.length < text.length, "it compresses");
    const w = new Writer().u16(method | (chunk.length + 2)).u16(chunk.length).u8(...chunk).u16(0xe000);
    assert.deepEqual([...decompressPacked(w.done())], text, `${bits}-bit codes`);
  }
});

test("decompressPacked: the KwKwK case (a code defined by itself)", () => {
  const data = Array(40).fill(65);
  const chunk = lzw(data, 12);
  const w = new Writer().u16(0x8000 | (chunk.length + 2)).u16(chunk.length).u8(...chunk).u16(0xe000);
  assert.deepEqual([...decompressPacked(w.done())], data);
});

test("decompressPacked: blocks join up; unknown methods throw", () => {
  const w = new Writer().u16(2).u8(1, 2).u16(3).u8(3, 4, 5).u16(0xe000);
  assert.deepEqual([...decompressPacked(w.done())], [1, 2, 3, 4, 5]);
  assert.throws(() => decompressPacked(new Writer().u16(0x2001).u8(0).done()), /unknown packing method/);
});

// --------------------------------------------------------------------- FRME

test("Frme: joint matrices per frame and part", () => {
  const w = new Writer().str("FRME").u32(2).u32(2).u32(0);
  for (let i = 0; i < 2 * 2 * 12; i++) w.f32(i);
  const f = new Frme(w.done());
  assert.equal(f.parts, 2);
  assert.equal(f.frames, 2);
  const m = f.matrix(1, 2); // frame 1, tag 2 -> record 3, floats 36..47
  assert.deepEqual([...m], [36, 37, 38, 0, 39, 40, 41, 0, 42, 43, 44, 0, 45, 46, 47, 1]);
  const pose = f.pose(0);
  assert.deepEqual([...pose.keys()], [1, 2]);
  assert.equal(pose.get(1)[12], 9);
});

test("Frme: frame count is clamped to the data (resource 4733)", () => {
  const w = new Writer().str("FRME").u32(1).u32(3).u32(0);
  for (let i = 0; i < 2 * 12; i++) w.f32(0);
  assert.equal(new Frme(w.done()).frames, 2);
  assert.throws(() => new Frme(new Writer().str("NOPE").u32(0).u32(0).u32(0).done()), /not an FRME/);
  assert.equal(IDENTITY.length, 16);
});

// ------------------------------------------------------------------ OB3D/OPRT

test("parseObjectDef reads every record kind and the properties", () => {
  const w = new Writer().str("OB3D").u32(4);
  w.u32(1).u32(-2).u32(3); // kind 1
  w.u32(2).f32(0).f32(150.5).u32(RT.MODL).u32(777); // kind 2: LOD band
  w.u32(6).u32(5).u32(9001); // kind 6
  w.u32(8).u32(11); // kind 8
  w.u32(7).u32(6).u32(3).u32(10).u32(-20).u32(30); // kind 7: 6 words, 3 set
  const o = parseObjectDef(w.done());
  assert.equal(o.tag, "OB3D");
  assert.equal(o.slots, 4);
  assert.deepEqual(o.entries.map((e) => e.kind), [1, 2, 6, 8]);
  assert.deepEqual(o.entries[0], { kind: 1, a: -2, b: 3 });
  assert.deepEqual(o.entries[1], { kind: 2, min: 0, max: 150.5, resType: 7, id: 777 });
  assert.deepEqual(o.entries[2], { kind: 6, a: 5, b: 9001 });
  assert.deepEqual([...o.props], [10, -20, 30, 0, 0, 0], "unset properties are 0");
  assert.equal(o.propWords, 6);
  assert.equal(o.propSlot, 4);
});

test("parseObjectDef rejects other tags and unknown records", () => {
  assert.throws(() => parseObjectDef(new Writer().str("FRME").u32(0).done()), /not an OB3D/);
  assert.throws(() => parseObjectDef(new Writer().str("OPRT").u32(0).u32(3).done()), /unknown object record 3/);
});

// ----------------------------------------------------------------- G-NOME.BIN

// A small .BIN: three resources (a script and a palette in the script
// buffer, a bitmap in pack 2), plugins, externs, strings and initial values.
function makeBin() {
  const w = new Writer().str("7L").u8(0, 0, 0, 0, 0).str("Test Game").u8(0);
  while (w.length < 0x58) w.u8(0);
  w.u32(0); // entry script
  while (w.length < 0x138 + 14 * 8) w.u8(0);
  const keys = new Map();
  const put = (k, bytes) => {
    keys.set(k, [w.length, bytes.length]);
    w.u8(...bytes);
  };
  const script = [0xa2, 0x00];
  const pal = [1, 2, 3, 4];
  put(KEY.SCRIPT_BUF, [0xee, 0xee, ...script, ...pal]);
  const index = new Writer();
  index.u16(RT.SCRIPT).u32(2).u32(script.length);
  index.u16(RT.PALETTE).u32(4).u32(pal.length);
  index.u16(RT.BITMAP | (2 << 8)).u32(3).u32(2);
  put(KEY.INDEX, index.bytes);
  put(KEY.VAR_INIT, new Writer().u32(5).u32(-7).u32(9).u32(100).bytes);
  put(KEY.STRINGS, new Writer().str("hello").u8(0).str("world").u8(0).bytes);
  put(KEY.PLUGINS, new Writer().str("RENDER").u8(0).str("NETGN").u8(0).bytes);
  put(KEY.EXTERN_NAMES, new Writer().str("Foo").u8(0).str("Bar").u8(0).bytes);
  put(KEY.EXTERN_PLUGIN, new Writer().u32(0).u32(1).bytes);
  put(KEY.PALETTE, Array(236 * 4).fill(0).map((_, i) => i & 0xff));
  const bytes = w.done();
  const dv = new DataView(bytes.buffer);
  for (const [k, [off, size]] of keys) {
    dv.setUint32(0x138 + 8 * k, off, true);
    dv.setUint32(0x138 + 8 * k + 4, size, true);
  }
  return bytes;
}

test("BinFile reads the header, index and key resources", () => {
  const bin = new BinFile(makeBin(), async () => new Uint8Array(0));
  assert.equal(bin.title, "Test Game");
  assert.equal(bin.count, 3);
  assert.deepEqual([0, 1, 2, 3].map((i) => bin.type(i)), [RT.SCRIPT, RT.PALETTE, RT.BITMAP, -1]);
  assert.equal(bin.pack(2), 2);
  assert.deepEqual([0, 1, 2].map((i) => bin.isResident(i)), [true, true, false]);
  assert.deepEqual([...bin.resident(0)], [0xa2, 0x00]);
  assert.deepEqual(bin.varInit, [[5, -7], [9, 100]]);
  assert.equal(bin.string(0), "hello");
  assert.equal(bin.string(6), "world");
  assert.deepEqual(bin.plugins, ["RENDER", "NETGN"]);
  assert.equal(bin.externLabel(1), "NETGN.Bar");
  assert.equal(bin.externLabel(5), "?.extern_5");
  assert.equal(bin.palette.length, 236 * 4);
});

test("BinFile.load reads packs once and slices resources from them", async () => {
  const reads = [];
  const bin = new BinFile(makeBin(), async (n) => (reads.push(n), Uint8Array.from([0, 0, 0, 0xab, 0xcd, 0])));
  assert.deepEqual([...(await bin.load(2))], [0xab, 0xcd]);
  assert.deepEqual([...(await bin.load(2))], [0xab, 0xcd]);
  assert.deepEqual(reads, [2], "pack read once");
  assert.deepEqual([...(await bin.load(1))], [1, 2, 3, 4], "resident resources come from the .BIN");
  await assert.rejects(bin.load(3), /out of range/);
});

test("BinFile rejects files without the 7L magic", () => {
  assert.throws(() => new BinFile(new Uint8Array(0x200), null), /no 7L magic/);
});

test("palette256 fills in Windows' 20 static colours", () => {
  const pal236 = new Uint8Array(236 * 4).map((_, i) => (i % 4 === 3 ? 0xff : i));
  const p = palette256(pal236);
  assert.equal(p.length, 768);
  assert.deepEqual([...p.subarray(0, 3)], WIN_STATIC_LOW[0]);
  assert.deepEqual([...p.subarray(255 * 3)], WIN_STATIC_HIGH[9]);
  assert.deepEqual([...p.subarray(30, 33)], [0, 1, 2], "slot 10 = first game colour, alpha byte dropped");
  assert.deepEqual([...p.subarray(245 * 3, 246 * 3)], [...pal236.subarray(235 * 4, 235 * 4 + 3)]);
});
