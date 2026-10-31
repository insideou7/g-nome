// Type 21 resources: text drawn with a Windows font (0x1002065b).
//   u32 colour index, u32 font name (string id), u32 initial text (string
//   id), u32 font height, i32 x, i32 y, u32 box width, u32 box height,
//   u32 alignment flags (1 = centre horizontally, 2 = right, 4 = centre
//   vertically, 8 = bottom, 0 = left/top), u8 ?, u8 height is a variable,
//   u8 no word break, u8 ?.
// The original renders through GDI into a bitmap; we use a canvas when there
// is one and otherwise produce no pixels.
//
// 0x10020d8f draws the text with DrawTextA into a (width + 1) x (height + 1)
// bitmap, or into the DT_CALCRECT size when either is 0. The format is the
// alignment flags | DT_NOCLIP | DT_NOPREFIX, plus DT_WORDBREAK unless byte 38
// is set. DT_SINGLELINE is never set, so a box's text wraps at spaces onto
// lines one cell high (the map descriptions on the network host screen).
// We keep a text that fits on one line as before and wrap only when it is
// wider than its box and the box has room for a second line, so small
// differences between browser and GDI font widths can't push a one-line
// label's last word out of its box.
//
// The font comes from CreateFontIndirectA (0x100208a4) with lfHeight = the
// height field and everything else 0, so the height is the cell height
// (ascent + descent), not the em size a CSS font size gives. GDI draws
// TrueType at a whole pixel size: the largest one whose cell, with ascent
// and descent each rounded up to whole pixels, fits the height. METRICS
// holds usWinAscent / usWinDescent per 2048 units; "System" uses Arial's.
/** @import { Engine } from "./engine.js" */

const ARIAL = { ascent: 1854, descent: 434 };
/** @type {Record<string, { ascent: number, descent: number }>} */
const METRICS = { arial: ARIAL, "courier new": { ascent: 1705, descent: 615 } };
const pixelSize = (/** @type {any} */ m, /** @type {number} */ height) => {
  let p = Math.max(1, Math.floor((height * 2048) / (m.ascent + m.descent)));
  while (p > 1 && Math.ceil((p * m.ascent) / 2048) + Math.ceil((p * m.descent) / 2048) > height) p--;
  return p;
};

// DrawTextA's DT_WORDBREAK: break at spaces so each line fits `width`; a
// word longer than the line stays whole. Line breaks in the text are kept.
/**
 * @param {OffscreenCanvasRenderingContext2D} c
 * @param {string} text
 * @param {number} width
 */
function wrap(c, text, width) {
  const lines = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && c.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export class Texts {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.list = new Map();
  }
  /**
   * @param {number} id
   */
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
      boxW: dv.getUint32(24, true),
      boxH: dv.getUint32(28, true),
      flags: dv.getUint32(32, true),
      wordBreak: r.byteLength < 39 || r[38] === 0,
      bitmap: null,
    };
    this.list.set(id, t);
    return t;
  }
  /**
   * @param {number} id
   * @param {string} text
   */
  setText(id, text) {
    const t = this.get(id);
    if (!t) return false;
    t.text = text;
    t.bitmap = null;
    this.engine.dirty = true;
    return true;
  }
  /**
   * @param {number} id
   * @param {any} color
   */
  setColor(id, color) {
    const t = this.get(id);
    if (!t) return false;
    if (t.color !== color) {
      t.color = color;
      t.bitmap = null;
      this.engine.dirty = true;
    }
    return true;
  }
  // A bitmap like decodeBitmap's: {width, height, x, y, pixels}.
  /**
   * @param {number} id
   */
  bitmap(id) {
    const t = this.get(id);
    if (!t) return null;
    if (t.bitmap) return t.bitmap;
    const Canvas = globalThis.OffscreenCanvas;
    let w = 1, h = 1, pixels = new Uint8Array(1);
    if (Canvas && t.text) {
      const m = METRICS[t.font.toLowerCase()] || ARIAL;
      const px = pixelSize(m, t.size);
      const font = `${px}px "${t.font}", Arial, sans-serif`;
      const probe = /** @type {OffscreenCanvasRenderingContext2D} */ (new Canvas(1, 1).getContext("2d"));
      probe.font = font;
      w = Math.max(1, Math.ceil(probe.measureText(t.text).width));
      const ascent = Math.ceil((px * m.ascent) / 2048);
      const cell = ascent + Math.ceil((px * m.descent) / 2048);
      /** @type {[string, number, number][]} */
      let runs;
      const boxed = Boolean(t.wordBreak && t.boxW && t.boxH >= 2 * cell && w > t.boxW);
      if (boxed) {
        // Lines start at the top: DT_VCENTER and DT_BOTTOM need DT_SINGLELINE.
        w = t.boxW + 1;
        h = t.boxH + 1;
        const lx = t.flags & 1 ? t.boxW / 2 : t.flags & 2 ? t.boxW : 0;
        runs = wrap(probe, t.text, t.boxW).map((l, i) => [l, lx, ascent + i * cell]);
      } else {
        // The bitmap keeps the old 1.2 x height and baseline, which line the
        // titles up with their frames; only the glyphs got smaller.
        h = Math.max(1, Math.ceil(t.size * 1.2));
        runs = [[t.text, 0, Math.round(1 + (t.size * m.ascent) / (m.ascent + m.descent))]];
      }
      const c = /** @type {OffscreenCanvasRenderingContext2D} */ (new Canvas(w, h).getContext("2d"));
      c.font = font;
      c.textBaseline = "alphabetic";
      c.textAlign = !boxed ? "left" : t.flags & 1 ? "center" : t.flags & 2 ? "right" : "left";
      c.fillStyle = "#fff";
      for (const [text, x, y] of runs) c.fillText(text, x, y);
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
