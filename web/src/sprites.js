// RTLIB32's sprite system (the Sprite* exports).
//
// A type 20 resource defines a sprite: +0x08 u32 entry count, +0x1c u32
// level (higher draws on top), +0x21 u8 pick mode, +0x26 u32 resource ids:
// bitmaps (type 1) are its cels; type 18 entries are queues. A type 15 cel
// is a reference to a bitmap: a u32 bitmap id and 12 zero bytes (all 290 in
// G-NOME.BIN), used by the shared arrow buttons.
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
const drawable = (t) => t === 1 || t === 15 || t === 21;

// The runtime's queue callback (0x1001effb) stores the id of the sprite whose
// queue is running in global 5017 before it runs a record 20 or 21. Script
// 8391, run from the menus' slide-out queues, reads it to remove the
// sprite's click and hover regions.
export const G_QUEUE_SPRITE = 5017;

export const ORIGIN_X = WIDTH / 2;
export const ORIGIN_Y = HEIGHT / 2;

// Queue record sizes by message type (filled in at 0x10039e0b).
// A type 2 record has 0xe + 4 x count bytes (count at +6, up to 10 cels).
const SIZES = { 1: 0x16, 2: 0x2e, 3: 2, 4: 2, 5: 0x3c, 6: 0xe, 7: 0x16, 8: 2, 9: 0x2c, 10: 0xe, 11: 8, 12: 0xe, 13: 6, 14: 6, 15: 8, 16: 0x12, 17: 0xc, 18: 6, 19: 6, 20: 2, 21: 6, 22: 0x22, 23: 0x10 };

export class Sprites {
  constructor(engine) {
    this.engine = engine;
    this.list = new Map(); // resource id -> sprite
    this.bitmaps = new Map(); // resource id -> decoded bitmap
  }

  bitmap(id) {
    if (this.engine.bin.type(id) === 15) {
      const r = this.engine.res(id);
      id = new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(0, true);
    }
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
      x: 0, y: 0, cel: 0, visible: false, flipX: false, flipY: false,
      queue: null, // {b, dv, pos}
      wait: 0, anim: null, click: null,
      layers: null, // cel numbers shown together (message 2)
      radar: null, // {w, h, pixels} painted by RadarClear/RadarDraw
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
      case 1: // animate cels a..b, delay (0x1003e476)
        s.layers = null;
        this.startAnim(s, a[0] | 0, a[1] | 0, a[2] | 0);
        break;
      case 8: // hide
        s.visible = false;
        break;
      case 7: // mirror: horizontal, vertical (0x1003ea2f)
        s.flipX = !!a[0];
        s.flipY = !!a[1];
        break;
      case 12: // move to x, y
        s.x = a[0] | 0;
        s.y = a[1] | 0;
        break;
      case 18: // show, at cel n; out of range keeps the current cel (SpriteShow)
        if (a.length && a[0] >= 0 && a[0] < s.cels.length) s.cel = a[0];
        s.layers = null;
        s.visible = true;
        break;
      case 2: {
        // Show several cels at once, drawn in order (0x1003e647 builds a
        // type 2 queue record: cel numbers at +0xe, count at +6, the last
        // argument at +2; 0x10042800 draws it). The INTERFACE key prompt
        // uses it for its box (cel 0) and the joystick choice text (cel 1).
        const cels = a.slice(0, -1).map((c) => c | 0).filter((c) => c >= 0 && c < s.cels.length);
        if (!cels.length) break;
        s.layers = cels;
        s.cel = cels[0];
        s.visible = true;
        break;
      }
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
    s.layers = null;
    s.wait = 0;
    if (!queueId) {
      s.queue = null;
      return;
    }
    if (this.engine.bin.type(queueId) !== 18) return this.engine.log(`queue ${queueId} is not type 18`);
    // A copy: loop records (6) count down in place.
    const b = this.engine.bin.resident(queueId).slice();
    s.queue = { b, dv: new DataView(b.buffer, b.byteOffset, b.byteLength), pos: 0 };
    this.step(s, 0);
  }

  // Cels out of range start nothing (0x10036cc1). Returns true if started.
  startAnim(s, from, to, delay) {
    if (from >>> 0 >= s.cels.length || to >>> 0 >= s.cels.length) return false;
    s.delay = delay;
    s.anim = { cur: from, to, step: to >= from ? 1 : -1, delay: Math.max(delay, 1), t: 0 };
    s.cel = from;
    s.visible = true;
    return true;
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
      const size = type === 21 ? dv.getUint32(p + 2, true) : type === 2 ? 0xe + 4 * dv.getUint32(p + 6, true) : SIZES[type];
      if (!size) {
        this.engine.log(`sprite ${s.id}: unknown queue record ${type}`);
        s.queue = null;
        break;
      }
      q.pos += size;
      this.engine.dirty = true;
      const val = (o, flag) => (q.b[p + flag] ? this.engine.vm.getVar(dv.getUint32(p + o, true)) | 0 : dv.getInt32(p + o, true));
      switch (type) {
        case 6: { // loop (0x1003a527): +2 counter, +6 count, +10 target offset; 0 loops forever
          const n = dv.getInt32(p + 2, true);
          if (n === 1) {
            dv.setInt32(p + 2, dv.getInt32(p + 6, true), true);
            break;
          }
          if (n) dv.setInt32(p + 2, n - 1, true);
          q.pos = dv.getInt32(p + 10, true);
          if (guard > 500) { // an empty loop
            s.queue = null;
            return;
          }
          break;
        }
        case 7: { // mirror (0x1003abd0): +2 x, +6 y, then move by +0xe, +0x12
          s.flipX = !!val(2, 0xc);
          s.flipY = !!val(6, 0xd);
          s.x += val(0xe, 10);
          s.y += val(0x12, 11);
          break;
        }
        case 23: // a cel drawn by a plugin callback (3D models); not yet
          break;
        case 2: { // show several cels at once (0x10042800): +2 ms to wait
          // after (-1 keeps the last), +6 count, +0xb "+2 is a variable",
          // +0xd bit i "cel i is a variable", +0xe the cel numbers. The
          // cockpit crosshair (sprite 562) uses it for its lock states:
          // queue 564 (cels 1 and 2) while a target is being acquired, 565
          // (cels 3 and 4) once it is locked.
          const n = dv.getUint32(p + 6, true), vars = q.b[p + 0xd];
          const cels = [];
          for (let i = 0; i < n; i++) {
            const raw = dv.getInt32(p + 0xe + 4 * i, true);
            const c = i < 8 && vars & (1 << i) ? this.engine.vm.getVar(raw) | 0 : raw;
            if (c >= 0 && c < s.cels.length) cels.push(c);
          }
          if (cels.length) {
            s.layers = cels;
            s.cel = cels[0];
            s.anim = null;
            s.visible = true;
          }
          const raw = dv.getInt32(p + 2, true);
          if (raw !== -1) s.delay = val(2, 0xb);
          if (s.delay > 0) {
            s.wait = s.delay;
            return;
          }
          break;
        }
        case 1: { // animate cels (0x1003a042): +2 from, +6 to, +0xe delay (-1 keeps
          // the last one), "is a variable" flags at +0x12..+0x14
          const raw = dv.getInt32(p + 0xe, true);
          const delay = raw === -1 ? s.delay ?? 0 : val(0xe, 0x14);
          s.layers = null;
          if (this.startAnim(s, val(2, 0x12), val(6, 0x13), delay)) return;
          break;
        }
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
          if (c >= 0 && c < s.cels.length) s.cel = c;
          s.layers = null;
          s.visible = true;
          break;
        }
        case 20: // end; the runtime then runs its pending script
          this.engine.vm.setGlobal(G_QUEUE_SPRITE, s.id);
          this.engine.post(0x4c8);
          s.queue = null;
          return;
        case 21: // a script statement, run by the runtime's message proc
          // Run it from the message loop, never inside a running script:
          // a call record (statement 1) reserves no locals, so its frame
          // would overwrite the running script's (script 8308's loop
          // counter, when 8391 runs from a slide-out queue).
          if (this.engine.vm.depth > 0) {
            q.pos = p;
            return;
          }
          this.engine.vm.setGlobal(G_QUEUE_SPRITE, s.id);
          this.engine.runStatement(q.b.subarray(p + 6, p + size));
          break;
        default:
          this.engine.vm.noteUnknown("sprite queue record", type);
      }
    }
  }

  // Bounds of the current cel, in script coordinates (SpriteGetBounds).
  bounds(s) {
    const id = s.cels[Math.min(s.cel, s.cels.length - 1)];
    if (id === undefined || !drawable(this.engine.bin.type(id))) return { left: s.x, top: s.y, right: s.x, bottom: s.y };
    const b = this.bitmap(id);
    const left = s.x + b.x - ((b.width - 1) >> 1), top = s.y + b.y - ((b.height - 1) >> 1);
    return { left, top, right: left + b.width, bottom: top + b.height };
  }

  visibleSorted() {
    return [...this.list.values()].filter((s) => s.visible && drawable(this.engine.bin.type(s.cels[Math.min(s.cel, s.cels.length - 1)]))).sort((a, b) => a.level - b.level);
  }

  // The cels a sprite shows: its current one, or a message 2 layer list.
  shownCels(s) {
    return s.layers ? s.layers.map((c) => s.cels[c]) : [s.cels[Math.min(s.cel, s.cels.length - 1)]];
  }

  draw(pixels) {
    for (const s of this.visibleSorted()) {
      // The cockpit radar (battlefield/radar.js) paints its sprite's bounds;
      // the sprite's own cels go over it.
      if (s.radar) {
        const r = this.bounds(s);
        if (r.right - r.left === s.radar.w && r.bottom - r.top === s.radar.h) blit(pixels, { width: s.radar.w, height: s.radar.h, pixels: s.radar.pixels }, r.left + ORIGIN_X, r.top + ORIGIN_Y);
      }
      for (const id of this.shownCels(s)) {
        if (!drawable(this.engine.bin.type(id))) continue;
        const b = this.bitmap(id);
        const left = s.x + b.x - ((b.width - 1) >> 1), top = s.y + b.y - ((b.height - 1) >> 1);
        blit(pixels, b, left + ORIGIN_X, top + ORIGIN_Y, s.flipX, s.flipY);
      }
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
      let bx = x - r.left, by = y - r.top;
      if (s.flipX) bx = b.width - 1 - bx;
      if (s.flipY) by = b.height - 1 - by;
      if (b.pixels[by * b.width + bx]) return s;
    }
    return null;
  }
}

export function blit(dst, b, x0, y0, flipX = false, flipY = false) {
  const { width: w, height: h, pixels } = b;
  for (let y = 0; y < h; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= HEIGHT) continue;
    const row = dy * WIDTH;
    const src = (flipY ? h - 1 - y : y) * w;
    for (let x = 0; x < w; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= WIDTH) continue;
      const c = pixels[src + (flipX ? w - 1 - x : x)];
      if (c) dst[row + dx] = c;
    }
  }
}
