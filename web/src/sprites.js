// RTLIB32's sprite system (the Sprite* exports).
//
// A type 20 resource defines a sprite: +0x08 u32 entry count, +0x1c u32
// level (higher draws on top), +0x21 u8 pick mode, +0x26 u32 resource ids:
// bitmaps (type 1) are its cels; type 18 entries are queues.
//
// Scripts drive sprites with messages: immediately through builtin 0xce
// (SpriteSendMessage, dispatcher 0x1003e1dd), or by giving a sprite a queue
// (statement 0xb9), a type 18 resource holding a list of the same messages
// that SpriteAnimate (0x1003a613) steps through over time.
//
// Coordinates are relative to the screen centre (320, 240), and a bitmap is
// drawn centred on the sprite position plus the bitmap's own x/y offset.

import { decodeBitmap } from "./bitmap.js";
import { WIDTH, HEIGHT } from "./display.js";

const EMPTY = { width: 1, height: 1, x: 0, y: 0, pixels: new Uint8Array(1) };
const drawable = (t) => t === 1 || t === 21;

export const ORIGIN_X = WIDTH / 2;
export const ORIGIN_Y = HEIGHT / 2;

// Queue record sizes by message type (filled in at 0x10039e0b).
const SIZES = { 1: 0x16, 2: 0x2e, 3: 2, 4: 2, 5: 0x3c, 6: 0xe, 7: 0x16, 8: 2, 9: 0x2c, 10: 0xe, 11: 8, 12: 0xe, 13: 6, 14: 6, 15: 8, 16: 0x12, 17: 0xc, 18: 6, 19: 6, 20: 2, 21: 6, 22: 0x22, 23: 0x10 };

export class Sprites {
  constructor(engine) {
    this.engine = engine;
    this.list = new Map(); // resource id -> sprite
    this.bitmaps = new Map(); // resource id -> decoded bitmap
  }

  bitmap(id) {
    if (this.engine.bin.type(id) === 21) return this.engine.texts.bitmap(id) || EMPTY;
    let b = this.bitmaps.get(id);
    if (!b) {
      b = decodeBitmap(this.engine.res(id));
      this.bitmaps.set(id, b);
    }
    return b;
  }

  // The sprite for a type 20 resource, created on first use (0x100123f3).
  get(id) {
    let s = this.list.get(id);
    if (s) return s;
    const e = this.engine;
    const src = e.dynamic.get(id) ?? id;
    if (e.bin.type(src) !== 20) return null;
    const r = e.bin.resident(src);
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const n = dv.getUint32(8, true);
    const cels = [], queues = [];
    for (let i = 0; i < n && 0x26 + 4 * i + 4 <= r.length; i++) {
      const rid = dv.getUint32(0x26 + 4 * i, true);
      const t = e.bin.type(rid);
      // Types 15 and 21 are also cels in the original (21 looks like text);
      // only plain bitmaps are drawn so far.
      if (t === 1 || t === 15 || t === 21) cels.push(rid);
      else if (t === 18) queues.push(rid);
    }
    s = {
      id, cels, queues, level: dv.getUint32(0x1c, true), pick: r[0x21],
      x: 0, y: 0, cel: 0, visible: false,
      queue: null, // {b, dv, pos}
      wait: 0, anim: null, click: null,
    };
    this.list.set(id, s);
    return s;
  }

  // Builtin 0xce: [type, ...args], applied now.
  send(id, msg) {
    const s = this.get(id);
    if (!s) return 0;
    const [type, ...a] = msg;
    switch (type) {
      case 1: // animate cels a..b, ?, delay
        this.startAnim(s, a[0] | 0, a[1] | 0, a[3] | 0);
        break;
      case 8: // hide
        s.visible = false;
        break;
      case 12: // move to x, y
        s.x = a[0] | 0;
        s.y = a[1] | 0;
        break;
      case 18: // show, at cel n (none or -1: the current one)
        if (a.length && a[0] >= 0) s.cel = a[0];
        s.visible = true;
        break;
      default:
        this.engine.vm.noteUnknown("sprite message", type);
    }
    this.engine.dirty = true;
    return 1;
  }

  // Statement 0xb9 (0x10018f65): give a sprite a queue (type 18), or clear
  // it (queue 0). `hide` hides the sprite first.
  setQueue(id, queueId, hide) {
    const s = this.get(id);
    if (!s) return;
    if (hide) s.visible = false;
    s.anim = null;
    s.wait = 0;
    if (!queueId) {
      s.queue = null;
      return;
    }
    if (this.engine.bin.type(queueId) !== 18) return this.engine.log(`queue ${queueId} is not type 18`);
    const b = this.engine.bin.resident(queueId);
    s.queue = { b, dv: new DataView(b.buffer, b.byteOffset, b.byteLength), pos: 0 };
    this.step(s, 0);
  }

  startAnim(s, from, to, delay) {
    s.anim = { cur: from, to, step: to >= from ? 1 : -1, delay: Math.max(delay, 1), t: 0 };
    s.cel = from;
    s.visible = true;
  }

  // Advance every sprite by `ms` (SpriteAnimate).
  tick(ms) {
    for (const s of this.list.values()) this.step(s, ms);
  }

  step(s, ms) {
    if (s.anim) {
      s.anim.t += ms;
      while (s.anim && s.anim.t >= s.anim.delay) {
        s.anim.t -= s.anim.delay;
        if (s.anim.cur === s.anim.to) {
          s.anim = null;
          ms = 0;
          break;
        }
        s.anim.cur += s.anim.step;
        s.cel = s.anim.cur;
        this.engine.dirty = true;
      }
      if (s.anim) return;
    }
    if (s.wait > 0) {
      s.wait -= ms;
      if (s.wait > 0) return;
      s.wait = 0;
    }
    // Run queue records until one blocks.
    for (let guard = 0; s.queue && guard < 1000; guard++) {
      const q = s.queue;
      if (q.pos + 2 > q.b.length) {
        s.queue = null;
        break;
      }
      const p = q.pos, dv = q.dv;
      const type = dv.getUint16(p, true);
      const size = type === 21 ? dv.getUint32(p + 2, true) : SIZES[type];
      if (!size) {
        this.engine.log(`sprite ${s.id}: unknown queue record ${type}`);
        s.queue = null;
        break;
      }
      q.pos += size;
      this.engine.dirty = true;
      switch (type) {
        case 1: // animate cels
          this.startAnim(s, dv.getInt32(p + 2, true), dv.getInt32(p + 6, true), dv.getInt32(p + 14, true));
          return;
        case 8:
          s.visible = false;
          break;
        case 11: // wait ms
          s.wait = dv.getInt32(p + 2, true);
          return;
        case 12:
          s.x = dv.getInt32(p + 2, true);
          s.y = dv.getInt32(p + 6, true);
          break;
        case 18: {
          const c = dv.getInt32(p + 2, true);
          if (c >= 0) s.cel = c;
          s.visible = true;
          break;
        }
        case 20: // end; the runtime then runs its pending script
          this.engine.post(0x4c8);
          s.queue = null;
          return;
        case 21: // a script statement, run by the runtime's message proc
          this.engine.runStatement(q.b.subarray(p + 6, p + size));
          break;
        default:
          this.engine.vm.noteUnknown("sprite queue record", type);
      }
    }
  }

  // Bounds of the current cel, in script coordinates (SpriteGetBounds).
  bounds(s) {
    const id = s.cels[s.cel];
    if (id === undefined || !drawable(this.engine.bin.type(id))) return { left: s.x, top: s.y, right: s.x, bottom: s.y };
    const b = this.bitmap(id);
    const left = s.x + b.x - (b.width >> 1), top = s.y + b.y - (b.height >> 1);
    return { left, top, right: left + b.width, bottom: top + b.height };
  }

  visibleSorted() {
    return [...this.list.values()].filter((s) => s.visible && drawable(this.engine.bin.type(s.cels[Math.min(s.cel, s.cels.length - 1)]))).sort((a, b) => a.level - b.level);
  }

  draw(pixels) {
    for (const s of this.visibleSorted()) {
      const id = s.cels[Math.min(s.cel, s.cels.length - 1)];
      const b = this.bitmap(id);
      const r = this.bounds(s);
      blit(pixels, b, r.left + ORIGIN_X, r.top + ORIGIN_Y);
    }
  }

  // Top-most pickable sprite whose opaque pixel is at (x, y) (script coords).
  pick(x, y) {
    const list = this.visibleSorted().reverse();
    for (const s of list) {
      if (!s.pick && !s.click) continue;
      const r = this.bounds(s);
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
      const b = this.bitmap(s.cels[Math.min(s.cel, s.cels.length - 1)]);
      if (b.pixels[(y - r.top) * b.width + (x - r.left)]) return s;
    }
    return null;
  }
}

export function blit(dst, b, x0, y0) {
  const { width: w, height: h, pixels } = b;
  for (let y = 0; y < h; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= HEIGHT) continue;
    const row = dy * WIDTH;
    for (let x = 0; x < w; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= WIDTH) continue;
      const c = pixels[y * w + x];
      if (c) dst[row + dx] = c;
    }
  }
}
