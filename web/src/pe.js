// Minimal PE resource reader, for the cursors in RTLIB32.DLL.

// Returns Map(type -> Map(id -> Uint8Array)) for numeric types and ids
// (first language of each).
export function peResources(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (dv.getUint32(pe, true) !== 0x4550) throw new Error("not a PE file");
  const nsec = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  const rsrcRva = dv.getUint32(opt + 96 + 2 * 8, true); // data directory 2
  const secs = [];
  for (let i = 0; i < nsec; i++) {
    const s = opt + optSize + 40 * i;
    secs.push({ va: dv.getUint32(s + 12, true), size: Math.max(dv.getUint32(s + 8, true), dv.getUint32(s + 16, true)), raw: dv.getUint32(s + 20, true) });
  }
  const off = (rva) => {
    const s = secs.find((s) => rva >= s.va && rva < s.va + s.size);
    if (!s) throw new Error(`rva ${rva.toString(16)} not mapped`);
    return rva - s.va + s.raw;
  };
  const base = off(rsrcRva);
  const entries = (dir) => {
    const n = dv.getUint16(base + dir + 12, true) + dv.getUint16(base + dir + 14, true);
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = base + dir + 16 + 8 * i;
      const name = dv.getUint32(e, true), to = dv.getUint32(e + 4, true);
      out.push({ id: name & 0x80000000 ? null : name, sub: to & 0x80000000 ? to & 0x7fffffff : null, leaf: to & 0x80000000 ? null : to });
    }
    return out;
  };
  const res = new Map();
  for (const t of entries(0)) {
    if (t.id === null || t.sub === null) continue;
    const m = new Map();
    for (const r of entries(t.sub)) {
      if (r.id === null || r.sub === null) continue;
      const lang = entries(r.sub)[0];
      if (!lang || lang.leaf === null) continue;
      const d = base + lang.leaf;
      const p = off(dv.getUint32(d, true));
      m.set(r.id, bytes.subarray(p, p + dv.getUint32(d + 4, true)));
    }
    res.set(t.id, m);
  }
  return res;
}

// Decode the cursors: Map(group id -> {width, height, hotX, hotY, rgba}).
// A cursor resource is u16 hotspot x, y, then a BITMAPINFOHEADER whose
// height counts both masks, a 2-colour table, the XOR mask and the AND
// mask, both 1 bit per pixel, bottom row first, rows padded to 4 bytes.
export function peCursors(bytes) {
  const res = peResources(bytes);
  const groups = res.get(12), cursors = res.get(1);
  const out = new Map();
  if (!groups || !cursors) return out;
  for (const [gid, g] of groups) {
    const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
    if (gv.getUint16(4, true) < 1) continue;
    const c = cursors.get(gv.getUint16(6 + 12, true));
    if (!c) continue;
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const hotX = dv.getUint16(0, true), hotY = dv.getUint16(2, true);
    const h0 = 4, w = dv.getInt32(h0 + 4, true), h = dv.getInt32(h0 + 8, true) / 2;
    const bpp = dv.getUint16(h0 + 14, true);
    if (bpp !== 1) continue;
    const pal = h0 + dv.getUint32(h0, true);
    const stride = ((w + 31) >> 5) << 2;
    const xor = pal + 8, and = xor + stride * h;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const bit = 0x80 >> (x & 7);
        const a = c[and + row * stride + (x >> 3)] & bit;
        const v = c[xor + row * stride + (x >> 3)] & bit;
        const o = (y * w + x) * 4;
        if (!a) {
          const q = pal + (v ? 4 : 0);
          rgba[o] = c[q + 2];
          rgba[o + 1] = c[q + 1];
          rgba[o + 2] = c[q];
          rgba[o + 3] = 255;
        } else if (v) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0; // inverted pixels: draw black
          rgba[o + 3] = 255;
        }
      }
    }
    out.set(gid, { width: w, height: h, hotX, hotY, rgba });
  }
  return out;
}
