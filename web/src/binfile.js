// G-NOME.BIN: header, resource table and the "key resources".
// Layout: docs/formats/g-nome-bin.md and docs/rtlib32-engine.md.

const HEADER_KEYS = 0x138;
export const KEY = {
  INDEX: 0,
  VAR_INIT: 3, // {u32 var id, i32 value} pairs: initial global values
  STRINGS: 4,
  SCRIPT_BUF: 5,
  PALETTE: 6,
  PLUGINS: 10,
  EXTERN_NAMES: 11,
  EXTERN_PLUGIN: 12,
};

export const RT = {
  BITMAP: 1,
  TEXTURE: 2,
  FRME: 4,
  MODL: 7,
  MPRT: 8,
  OB3D: 9,
  OPRT: 10,
  TYPE11: 11,
  SOUND: 12,
  PALETTE: 17,
  SCRIPT: 19,
};

/**
 * @param {Uint8Array} bytes
 */
function cstrings(bytes) {
  const out = [];
  let s = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(latin1(bytes, s, i));
      s = i + 1;
    }
  }
  return out;
}

/**
 * @param {any} b
 * @param {number} start
 * @param {number} end
 */
export function latin1(b, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

export class BinFile {
  // `bytes`: the whole G-NOME.BIN. `readPack(n)`: async, returns the bytes of
  // G-NOME.<n as %03d>.
  /**
   * @param {Uint8Array} bytes
   * @param {any} readPack
   */
  constructor(bytes, readPack) {
    if (bytes[0] !== 0x37 || bytes[1] !== 0x4c) throw new Error("not a 7th Level .BIN (no 7L magic)");
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readPack = readPack;
    this.packs = new Map();
    const dv = this.dv;
    this.keys = [];
    for (let i = 0; i < 14; i++) {
      this.keys.push([dv.getUint32(HEADER_KEYS + 8 * i, true), dv.getUint32(HEADER_KEYS + 8 * i + 4, true)]);
    }
    let te = 7;
    while (bytes[te] && te < 0x58) te++;
    this.title = latin1(bytes, 7, te); // NUL-terminated at 0x07

    this.entryScript = dv.getUint32(0x58, true);
    const [ioff, isize] = this.keys[KEY.INDEX];
    this.count = isize / 10;
    this.flags = new Uint16Array(this.count);
    this.offsets = new Uint32Array(this.count);
    this.sizes = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const p = ioff + 10 * i;
      this.flags[i] = dv.getUint16(p, true);
      this.offsets[i] = dv.getUint32(p + 2, true);
      this.sizes[i] = dv.getUint32(p + 6, true);
    }
    this.plugins = cstrings(this.key(KEY.PLUGINS));
    this.externNames = cstrings(this.key(KEY.EXTERN_NAMES));
    const ep = this.key(KEY.EXTERN_PLUGIN);
    this.externPlugin = Array.from({ length: ep.length / 4 }, (_, i) => new DataView(ep.buffer, ep.byteOffset).getUint32(4 * i, true));
    this.stringBytes = this.key(KEY.STRINGS);
    const vi = this.key(KEY.VAR_INIT);
    const vdv = new DataView(vi.buffer, vi.byteOffset, vi.byteLength);
    this.varInit = [];
    for (let p = 0; p + 8 <= vi.length; p += 8) this.varInit.push([vdv.getUint32(p, true), vdv.getInt32(p + 4, true)]);
    this.palette = this.key(KEY.PALETTE); // 236 x RGBX for slots 10..245
  }

  /**
   * @param {number} k
   */
  key(k) {
    const [off, size] = this.keys[k];
    return this.bytes.subarray(off, off + size);
  }

  /**
   * @param {number} id
   */
  type(id) {
    return id < this.count ? this.flags[id] & 0xff : -1;
  }

  /**
   * @param {number} id
   */
  pack(id) {
    return this.flags[id] >> 8;
  }

  /**
   * @param {number} id
   */
  isResident(id) {
    const t = this.type(id);
    return t >= 13 && t <= 22;
  }

  // Resident resources (types 13..22: scripts, palettes, tables) live in the
  // script buffer, which is part of the .BIN.
  /**
   * @param {number} id
   */
  resident(id) {
    const base = this.keys[KEY.SCRIPT_BUF][0];
    const o = base + this.offsets[id];
    return this.bytes.subarray(o, o + this.sizes[id]);
  }

  // NUL-terminated string at a byte offset into the string table.
  /**
   * @param {number} offset
   */
  string(offset) {
    const b = this.stringBytes;
    let e = offset;
    while (e < b.length && b[e]) e++;
    return latin1(b, offset, e);
  }

  /**
   * @param {number} id
   */
  async load(id) {
    if (id >= this.count) throw new Error(`resource ${id} out of range`);
    if (this.isResident(id)) return this.resident(id);
    const n = this.pack(id);
    let p = this.packs.get(n);
    if (!p) {
      p = this.readPack(n);
      this.packs.set(n, p);
    }
    const bytes = await p;
    return bytes.subarray(this.offsets[id], this.offsets[id] + this.sizes[id]);
  }

  /**
   * @param {number} i
   */
  externLabel(i) {
    const p = this.externPlugin[i];
    return `${this.plugins[p] ?? "?"}.${this.externNames[i] ?? "extern_" + i}`;
  }
}

// Windows keeps palette slots 0-9 and 246-255; the game provides 10-245.
export const WIN_STATIC_LOW = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240]];
export const WIN_STATIC_HIGH = [[255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];

// 236 x RGBX -> full 256 x RGB (Uint8Array(768)).
/**
 * @param {any} pal236
 */
export function palette256(pal236) {
  const out = new Uint8Array(768);
  WIN_STATIC_LOW.forEach((c, i) => out.set(c, i * 3));
  for (let i = 0; i < 236; i++) out.set(pal236.subarray(i * 4, i * 4 + 3), (10 + i) * 3);
  WIN_STATIC_HIGH.forEach((c, i) => out.set(c, (246 + i) * 3));
  return out;
}
