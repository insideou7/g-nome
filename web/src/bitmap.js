// Type 1 bitmaps (and the bitmaps inside type 2 textures). Ported from
// tools/gnome_extract.py; format notes in docs/formats/g-nome-bin.md.
//   u32 width, u32 height, u32 flags (0x80 = RLE, else packed), i32 x, i32 y
//   (hotspot), u32 resource id, then the body. Colour 0 is transparent.

export function parseBitmap(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: dv.getUint32(0, true),
    height: dv.getUint32(4, true),
    flags: dv.getUint32(8, true),
    x: dv.getInt32(12, true),
    y: dv.getInt32(16, true),
    body: bytes.subarray(24),
  };
}

// Returns {width, height, x, y, pixels: Uint8Array(width * height)}.
export function decodeBitmap(bytes) {
  const bm = parseBitmap(bytes);
  bm.pixels = bm.flags & 0x80 ? decodeRle(bm) : decodePacked(bm);
  delete bm.body;
  return bm;
}

function decodeRle({ width: w, height: h, body }) {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    let p = body[2 * r] | (body[2 * r + 1] << 8);
    let x = 0;
    const base = r * w;
    for (;;) {
      const c = body[p++];
      if (c === 0) break;
      if (c < 0x80) {
        out.fill(body[p++], base + x, base + x + c);
        x += c;
      } else {
        const n = c === 0xff ? body[p++] : 0xff - c;
        out.set(body.subarray(p, p + n), base + x);
        p += n;
        x += n;
      }
    }
  }
  return out;
}

// Packed bitmaps: DIB rows padded to 4 bytes, bottom row first. (Text on
// the main menu backdrop, resource 8400, reads upside down otherwise.)
function decodePacked({ width: w, height: h, body }) {
  const raw = decompressPacked(body);
  const stride = (w + 3) & ~3;
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) out.set(raw.subarray(r * stride, r * stride + w), (h - 1 - r) * w);
  return out;
}

const LZW_BITS = { 0x4000: 10, 0x6000: 11, 0x8000: 12 };

// RTLIB32's DecompressBitmapData stream: blocks with a u16 header (top 3
// bits method, low 13 bits size). 0 = stored, 0x4000/0x6000/0x8000 = LZW
// chunks (u16 size + data) with 10/11/12-bit codes, 0xE000 = end.
export function decompressPacked(body) {
  const parts = [];
  let total = 0;
  let p = 0;
  for (;;) {
    const head = body[p] | (body[p + 1] << 8);
    p += 2;
    const method = head & 0xe000, size = head & 0x1fff;
    if (method === 0xe000 || p > body.length) break;
    const block = body.subarray(p, p + size);
    p += size;
    if (method === 0) {
      parts.push(block);
      total += block.length;
      continue;
    }
    const bits = LZW_BITS[method];
    if (!bits) throw new Error(`unknown packing method ${method.toString(16)}`);
    for (let q = 0; q < block.length; ) {
      const n = block[q] | (block[q + 1] << 8);
      const out = lzwChunk(block.subarray(q + 2, q + 2 + n), bits);
      parts.push(out);
      total += out.length;
      q += 2 + n;
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// Fixed-width MSB-first codes; 0-255 are bytes, new strings from 256, the
// all-ones code ends the chunk, no reset.
function lzwChunk(data, bits) {
  const end = (1 << bits) - 1;
  const prefix = new Int32Array(end);
  const suffix = new Uint8Array(end);
  const out = [];
  let pos = 0, acc = 0, nacc = 0;
  const code = () => {
    while (nacc < bits) {
      acc = ((acc << 8) | (data[pos++] ?? 0)) & 0xffffff;
      nacc += 8;
    }
    nacc -= bits;
    const c = (acc >> nacc) & end;
    acc &= (1 << nacc) - 1;
    return c;
  };
  const string = (c) => {
    const s = [];
    while (c > 0xff) {
      s.push(suffix[c]);
      c = prefix[c];
    }
    s.push(c);
    return s.reverse();
  };
  let old = code();
  if (old === end) return new Uint8Array(0);
  out.push(old);
  let next = 256;
  for (;;) {
    const c = code();
    if (c === end) break;
    let s;
    if (c < next) s = string(c);
    else {
      s = string(old);
      s.push(s[0]);
    }
    for (const v of s) out.push(v);
    if (next < end) {
      prefix[next] = old;
      suffix[next] = s[0];
      next++;
    }
    old = c;
  }
  return Uint8Array.from(out);
}
