// Type 21 resources: text drawn with a Windows font (0x1002065b).
//   u32 colour index, u32 font name (string id), u32 initial text (string
//   id), u32 font height, i32 x, i32 y, u32 ?, u32 ?, u32 alignment flags
//   (1 = centre horizontally, 2 = right, 4 = centre vertically, 8 = bottom,
//   0 = left/top), u32 ?.
// The original renders through GDI into a bitmap; we use a canvas when there
// is one and otherwise produce no pixels.
//
// The font comes from CreateFontIndirectA (0x100208a4) with lfHeight = the
// height field and everything else 0, so the height is the cell height
// (ascent + descent), not the em size a CSS font size gives. GDI draws
// TrueType at a whole pixel size: the largest one whose cell, with ascent
// and descent each rounded up to whole pixels, fits the height. METRICS
// holds usWinAscent / usWinDescent per 2048 units; "System" uses Arial's.
const ARIAL = { ascent: 1854, descent: 434 };
const METRICS = { arial: ARIAL, "courier new": { ascent: 1705, descent: 615 } };
const pixelSize = (m, height) => {
  let p = Math.max(1, Math.floor((height * 2048) / (m.ascent + m.descent)));
  while (p > 1 && Math.ceil((p * m.ascent) / 2048) + Math.ceil((p * m.descent) / 2048) > height) p--;
  return p;
};

export class Texts {
  constructor(engine) {
    this.engine = engine;
    this.list = new Map();
  }
  get(id) {
    let t = this.list.get(id);
    if (t) return t;
    const e = this.engine;
    if (e.bin.type(id) !== 21) return null;
    const r = e.bin.resident(id);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    t = {
      color: dv.getUint32(0, true),
      font: e.getString(dv.getUint32(4, true)) || "Arial",
      text: e.getString(dv.getUint32(8, true)) || "",
      size: dv.getUint32(12, true),
      x: dv.getInt32(16, true),
      y: dv.getInt32(20, true),
      flags: dv.getUint32(32, true),
      bitmap: null,
    };
    this.list.set(id, t);
    return t;
  }
  setText(id, text) {
    const t = this.get(id);
    if (!t) return false;
    t.text = text;
    t.bitmap = null;
    this.engine.dirty = true;
    return true;
  }
  // A bitmap like decodeBitmap's: {width, height, x, y, pixels}.
  bitmap(id) {
    const t = this.get(id);
    if (!t) return null;
    if (t.bitmap) return t.bitmap;
    const Canvas = globalThis.OffscreenCanvas;
    let w = 1, h = 1, pixels = new Uint8Array(1);
    if (Canvas && t.text) {
      const m = METRICS[t.font.toLowerCase()] || ARIAL;
      const font = `${pixelSize(m, t.size)}px "${t.font}", Arial, sans-serif`;
      const probe = new Canvas(1, 1).getContext("2d");
      probe.font = font;
      w = Math.max(1, Math.ceil(probe.measureText(t.text).width));
      // The bitmap keeps the old 1.2 x height and baseline, which line the
      // titles up with their frames; only the glyphs got smaller.
      h = Math.max(1, Math.ceil(t.size * 1.2));
      const c = new Canvas(w, h).getContext("2d");
      c.font = font;
      c.textBaseline = "alphabetic";
      c.fillStyle = "#fff";
      c.fillText(t.text, 0, Math.round(1 + (t.size * m.ascent) / (m.ascent + m.descent)));
      const img = c.getImageData(0, 0, w, h).data;
      pixels = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (img[i * 4 + 3] > 110) pixels[i] = t.color;
    }
    // Hotspot offset so the sprite's centred drawing lands where the flags say.
    let x = t.x, y = t.y;
    if (t.flags & 2) x -= w >> 1;
    else if (!(t.flags & 1)) x += (w - 1) >> 1;
    if (t.flags & 8) y -= h >> 1;
    else if (!(t.flags & 4)) y += (h - 1) >> 1;
    t.bitmap = { width: w, height: h, x, y, pixels };
    return t.bitmap;
  }
}
