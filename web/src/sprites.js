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
//
// Motion: messages and queue records 5 (curve), 9 (line) and 10 (step) move
// a sprite one step each time its move clock runs out. The clock interval
// is the sprite's "speed" (SpriteSetSpeed, sprite +0x54; message/record
// 17), and its cel interval is its "motion" (SpriteSetMotion, +0x58;
// message/record 15, also the delay of records 1 and 2). While a sprite
// moves along a path, its cel range (records 1 and 16) cycles at the
// motion rate. No G-NOME script or queue uses paths or speeds, so this
// follows RTLIB32 (0x1003a613 and the functions it calls) without a game
// screen to compare against; web/tests/sprite-motion-check.mjs tests it.

import { decodeBitmap } from "./bitmap.js";
import { WIDTH, HEIGHT } from "./display.js";
/** @import { Engine } from "./engine.js" */

const EMPTY = { width: 1, height: 1, x: 0, y: 0, pixels: new Uint8Array(1) };
const drawable = (/** @type {number} */ t) => t === 1 || t === 15 || t === 21;

// The runtime's queue callback (0x1001effb) stores the id of the sprite whose
// queue is running in global 5017 before it runs a record 20 or 21. Script
// 8391, run from the menus' slide-out queues, reads it to remove the
// sprite's click and hover regions.
export const G_QUEUE_SPRITE = 5017;

export const ORIGIN_X = WIDTH / 2;
export const ORIGIN_Y = HEIGHT / 2;

// Queue record sizes by message type (filled in at 0x10039e0b).
// A type 2 record has 0xe + 4 x count bytes (count at +6, up to 10 cels).
/** @type {Record<number, number>} */
const SIZES = { 1: 0x16, 2: 0x2e, 3: 2, 4: 2, 5: 0x3c, 6: 0xe, 7: 0x16, 8: 2, 9: 0x2c, 10: 0xe, 11: 8, 12: 0xe, 13: 6, 14: 6, 15: 8, 16: 0x12, 17: 0xc, 18: 6, 19: 6, 20: 2, 21: 6, 22: 0x22, 23: 0x10 };

export class Sprites {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.list = new Map(); // resource id -> sprite
    this.bitmaps = new Map(); // resource id -> decoded bitmap
  }

  /**
   * @param {number} id
   */
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
  /**
   * @param {number} id
   */
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
      // Motion clocks, in engine time (ms): speed is the move interval,
      // delay (set by startAnim and message 15) the cel interval.
      speed: 0, moveAt: 0, celAt: 0,
      keepTime: false, // message 13: clocks advance from the last deadline, not from now
      range: null, // {from, to}: the cels that cycle while the sprite moves
      path: null, // the motion record running (see runPath)
      pausedAt: /** @type {number | undefined} */ (undefined), // SpritePause: engine time it paused at
    };
    this.list.set(id, s);
    return s;
  }

  // Builtin 0xce: [type, ...args], applied now.
  /**
   * @param {number} id
   * @param {any} msg
   */
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
        const cels = a.slice(0, -1).map((/** @type {number} */ c) => c | 0).filter((/** @type {number} */ c) => c >= 0 && c < s.cels.length);
        if (!cels.length) break;
        s.layers = cels;
        s.cel = cels[0];
        s.visible = true;
        break;
      }
      case 5: // curve: x1, y1 (passed halfway), x2, y2, steps, relative (0x1003e7f8)
      case 9: // line: x1, y1, steps, steps-are-pixels, relative (0x1003ec3c)
      case 10: { // step: x, y, relative (0x1003edba; needs all three)
        if (type === 10 && a.length < 3) return 0;
        const v = (/** @type {number} */ i) => a[i] | 0;
        // A sent motion replaces the queue (0x1003e606) and runs at once.
        s.queue = null;
        s.anim = null;
        s.wait = 0;
        if (type === 5) this.startCurve(s, v(0), v(1), v(2), v(3), v(4), !!a[5]);
        else if (type === 9) this.startLine(s, v(0), v(1), v(2), !!a[3], !!a[4]);
        else s.path = { kind: "step", x: v(0), y: v(1), rel: !!a[2] };
        if (this.runPath(s)) s.path = null;
        break;
      }
      case 13: // keep time: flag (0x1003f0ff)
        s.keepTime = !!a[0];
        s.moveAt = s.celAt = 0;
        break;
      case 14:
        // Sets bit 15 of the sprite's flags (0x1003f25a -> 0x10036e10): it
        // switches the position between the sprite and its current frame
        // record, and back. The port keeps one position, so only redraw.
        break;
      case 15: // motion: cel interval in ms (0x1003f2de)
        this.setMotion(s, a[0] | 0);
        break;
      case 16: // cel range: current, from, to (0x1003f1b4 -> 0x10036cc1)
        this.setRange(s, a[0] | 0, a[1] | 0, a[2] | 0);
        break;
      case 17: // speed: move interval in ms[, motion] (0x1003f391)
        this.setSpeed(s, a[0] | 0);
        if (a.length > 1) this.setMotion(s, a[1] | 0);
        break;
      default:
        this.engine.vm.noteUnknown("sprite message", type);
    }
    this.engine.dirty = true;
    return 1;
  }

  // SpriteSetSpeed (0x10035caa) and SpriteSetMotion (0x10035c02): set an
  // interval and restart its clock from now.
  /**
   * @param {any} s
   * @param {number} ms
   */
  setSpeed(s, ms) {
    s.speed = ms;
    s.moveAt = this.engine.time + ms;
  }

  /**
   * @param {any} s
   * @param {number} ms
   */
  setMotion(s, ms) {
    s.delay = ms;
    s.celAt = this.engine.time + ms;
  }

  // 0x10036cc1: the cels from..to cycle (backwards when to < from) and
  // `cur` is shown, or `from` when cur is outside them. Out of range: no-op.
  /**
   * @param {any} s
   * @param {number} cur
   * @param {number} from
   * @param {number} to
   */
  setRange(s, cur, from, to) {
    const n = s.cels.length;
    if (from >>> 0 >= n || to >>> 0 >= n) return false;
    s.range = { from, to };
    const lo = Math.min(from, to), hi = Math.max(from, to);
    s.cel = cur < lo || cur > hi ? from : cur;
    s.layers = null;
    return true;
  }

  // 0x10036f00: the next cel of the range, wrapping to `from`.
  /**
   * @param {any} s
   */
  cycleCel(s) {
    const { from, to } = s.range;
    let c = s.cel + (to >= from ? 1 : -1);
    if (to >= from ? c > to : c < to) c = from;
    s.cel = c;
    this.engine.dirty = true;
  }

  // Record 5 set up (0x1003a042): a quadratic curve from the sprite's
  // position through (x1, y1) at its midpoint to (x2, y2), in `steps` steps.
  /**
   * @param {any} s
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {number} steps
   * @param {boolean} rel
   */
  startCurve(s, x1, y1, x2, y2, steps, rel) {
    if (rel) {
      x1 += s.x; y1 += s.y; x2 += s.x; y2 += s.y;
    }
    s.path = { kind: "curve", x0: s.x, y0: s.y, x1, y1, x2, y2, i: 0, n: steps >>> 0 };
  }

  // Record 9 set up: a line from the sprite's position to (x1, y1). With
  // `pixels`, `steps` is the step length instead (0x10039e82).
  /**
   * @param {any} s
   * @param {number} x1
   * @param {number} y1
   * @param {number} steps
   * @param {boolean} pixels
   * @param {boolean} rel
   */
  startLine(s, x1, y1, steps, pixels, rel) {
    if (rel) {
      x1 += s.x; y1 += s.y;
    }
    let n = steps >>> 0;
    if (pixels) {
      const d = Math.max(Math.abs(x1 - s.x), Math.abs(y1 - s.y));
      n = Math.ceil(d / (n || 1));
    }
    s.path = { kind: "line", x0: s.x, y0: s.y, x1, y1, i: 0, n };
  }

  // One service of a motion record (0x10043fb0, 0x10043bf0, 0x10043e0a).
  // Returns true when it is finished.
  /**
   * @param {any} s
   */
  runPath(s) {
    const now = this.engine.time, p = s.path;
    const due = (/** @type {any} */ at) => (s.keepTime && at ? at : now);
    // While the sprite moves, its cel range cycles at the motion rate.
    if (s.range && s.range.from !== s.range.to && now >= s.celAt) {
      s.celAt = due(s.celAt) + (s.delay ?? 0);
      this.cycleCel(s);
    }
    if (now < s.moveAt) return false;
    s.moveAt = due(s.moveAt) + s.speed;
    this.engine.dirty = true;
    if (p.kind === "step") {
      if (p.rel) {
        s.x += p.x;
        s.y += p.y;
      } else {
        s.x = p.x;
        s.y = p.y;
      }
      return true;
    }
    p.i++;
    if (p.i <= p.n) {
      const [x, y] = p.kind === "line" ? linePoint(p.i, p.n, p.x0, p.y0, p.x1, p.y1) : curvePoint(p.i, p.n, p.x0, p.y0, p.x1, p.y1, p.x2, p.y2);
      s.x = x;
      s.y = y;
    }
    return p.i >= p.n;
  }

  // Statement 0xb9 (0x10018f65): give a sprite a queue (type 18), or clear
  // it (queue 0). `hide` hides the sprite first.
  /**
   * @param {number} id
   * @param {any} queueId
   * @param {any} hide
   */
  setQueue(id, queueId, hide) {
    const s = this.get(id);
    if (!s) return;
    if (hide) s.visible = false;
    s.anim = null;
    s.layers = null;
    s.wait = 0;
    s.path = null;
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
  /**
   * @param {any} s
   * @param {number} from
   * @param {number} to
   * @param {number} delay
   */
  startAnim(s, from, to, delay) {
    if (from >>> 0 >= s.cels.length || to >>> 0 >= s.cels.length) return false;
    s.delay = delay;
    s.range = { from, to };
    s.anim = { cur: from, to, step: to >= from ? 1 : -1, delay: Math.max(delay, 1), t: 0 };
    s.cel = from;
    s.visible = true;
    return true;
  }

  // Advance every sprite by `ms` (SpriteAnimate). Paused sprites wait.
  /**
   * @param {number} ms
   */
  tick(ms) {
    for (const s of this.list.values()) if (s.pausedAt === undefined) this.step(s, ms);
  }

  // SpritePause (builtin 0x8C, 0x10037413): id 0 = every sprite. Pausing
  // keeps the time (sprite flag 0x1000); resuming moves the sprite's clocks
  // on by the paused span (+0x50), so a motion picks up where it stopped.
  /**
   * @param {number} id
   * @param {boolean} on
   */
  pause(id, on) {
    const all = id ? [this.list.get(id)] : [...this.list.values()];
    const now = this.engine.time;
    for (const s of all) {
      if (!s || (s.pausedAt !== undefined) === on) continue;
      if (on) {
        s.pausedAt = now;
        continue;
      }
      const d = now - s.pausedAt;
      if (s.moveAt) s.moveAt += d;
      if (s.celAt) s.celAt += d;
      s.pausedAt = undefined;
    }
  }

  /**
   * @param {any} s
   * @param {number} ms
   */
  step(s, ms) {
    if (s.path) {
      if (!this.runPath(s)) return;
      s.path = null;
    }
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
      const val = (/** @type {number} */ o, /** @type {number} */ flag) => (q.b[p + flag] ? this.engine.vm.getVar(dv.getUint32(p + o, true)) | 0 : dv.getInt32(p + o, true));
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
        case 5: // curve: +2 steps, +6 u8 relative, +0xc x1, +0x10 y1, +0x14 x2,
          // +0x18 y2; "is a variable" flags +7..+0xb
          this.startCurve(s, val(0xc, 7), val(0x10, 8), val(0x14, 9), val(0x18, 0xa), val(2, 0xb), !!q.b[p + 6]);
          if (!this.runPath(s)) return;
          s.path = null;
          break;
        case 9: // line: +2 steps, +6 u8 relative, +7 u8 steps-are-pixels,
          // +0xc x1, +0x10 y1; flags +8, +9, +0xa
          this.startLine(s, val(0xc, 8), val(0x10, 9), val(2, 0xa), !!q.b[p + 7], !!q.b[p + 6]);
          if (!this.runPath(s)) return;
          s.path = null;
          break;
        case 10: // step: +2 u8 relative, +6 x, +0xa y (flags +3, +4)
          s.path = { kind: "step", x: val(6, 3), y: val(0xa, 4), rel: !!q.b[p + 2] };
          if (!this.runPath(s)) return;
          s.path = null;
          break;
        case 13: // keep time: +2 flag
          s.keepTime = !!(dv.getUint32(p + 2, true) & 1);
          s.moveAt = s.celAt = 0;
          break;
        case 15: // motion: +2 ms (flag +6)
          this.setMotion(s, val(2, 6));
          break;
        case 16: // cel range: +2 current, +6 from, +0xa to (flags +0xe..+0x10)
          this.setRange(s, val(2, 0xe), val(6, 0xf), val(0xa, 0x10));
          break;
        case 17: // speed: +2 ms, +6 motion if not 0 (flags +0xa, +0xb)
          this.setSpeed(s, val(2, 0xa));
          if (dv.getInt32(p + 6, true) !== 0) this.setMotion(s, val(6, 0xb));
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
  /**
   * @param {any} s
   */
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
  /**
   * @param {any} s
   */
  shownCels(s) {
    return s.layers ? s.layers.map((/** @type {number} */ c) => s.cels[c]) : [s.cels[Math.min(s.cel, s.cels.length - 1)]];
  }

  /**
   * @param {any} pixels
   */
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
  /**
   * @param {number} x
   * @param {number} y
   */
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

// SpriteLinePoint (0x100373ca -> 0x10042ff0): point i of n along a line,
// each coordinate rounded half away from zero.
/**
 * @param {number} i
 * @param {number} n
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
export function linePoint(i, n, x0, y0, x1, y1) {
  const h = n >>> 1;
  const f = (/** @type {number} */ d) => (d >= 0 ? Math.floor((d * i + h) / n) : Math.trunc((d * i - h) / n));
  return [x0 + f(x1 - x0), y0 + f(y1 - y0)];
}

// 0x10042f50: point i of n on the quadratic curve from (x0, y0) to (x2, y2)
// that passes through (x1, y1) halfway; t is in 1/1024ths.
/**
 * @param {number} i
 * @param {number} n
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 */
export function curvePoint(i, n, x0, y0, x1, y1, x2, y2) {
  const t = Math.floor((i * 0x400 + (n >>> 1)) / n), k = t * (0x400 - t);
  const f = (/** @type {number} */ a0, /** @type {number} */ a1, /** @type {number} */ a2) => a0 + (Math.floor((t * t * (a2 - a0) + k * (4 * (a1 - a0) - (a2 - a0))) / 0x100000) | 0);
  return [f(x0, x1, x2), f(y0, y1, y2)];
}

/**
 * @param {any} dst
 * @param {any} b
 * @param {number} x0
 * @param {number} y0
 */
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
