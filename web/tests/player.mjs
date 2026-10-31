// A headless player for tests: boots the engine in Node on the game files,
// clicks and types like a person would, and reports what the screen shows.
//
//   const p = await Player.start("game/g-nome/G-NOME");
//   p.key(VK.ESCAPE);
//   await p.waitFor(() => p.hasRect(8344), "main menu");
//   p.click(163, 455); // GAME
//
// Coordinates are screen pixels (0..639, 0..479). Time moves only when the
// test calls wait() or waitFor(), one 30 Hz frame per tick, so runs are
// repeatable. The engine draws into a Display with no canvas; text objects
// have no pixels without a canvas, so tests read them with texts() instead.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { Engine } from "../src/engine.js";
import { Display, WIDTH, HEIGHT } from "../src/display.js";
import { ORIGIN_X, ORIGIN_Y } from "../src/sprites.js";

export const VK = { ENTER: 0x0d, ESCAPE: 0x1b, SPACE: 0x20, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, N: 0x4e, Y: 0x59 };
export const FRAME_MS = 1000 / 30;

// Log lines that mean something went wrong inside the engine.
const BAD_LOG = /failed|not a |unknown queue record|not found|^smacker: .*: /;

export function gameFiles(dir) {
  const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  return {
    read: async (n) => {
      const real = names.get(n.toUpperCase());
      if (!real) throw new Error(`missing game file ${n}`);
      return new Uint8Array(readFileSync(join(dir, real)));
    },
    has: (n) => names.has(n.toUpperCase()),
  };
}

export class Player {
  static async start(dir, opts = {}) {
    const p = new Player();
    p.logs = [];
    p.errors = []; // log lines matching BAD_LOG, and exceptions from tick()
    p.display = new Display();
    p.engine = new Engine(gameFiles(dir), {
      display: p.display,
      log: (m) => {
        p.logs.push(m);
        if (BAD_LOG.test(m)) p.errors.push(m);
        if (opts.verbose) console.log(`    | ${m}`);
      },
    });
    await p.engine.init();
    p.engine.boot();
    p.ticks = 0;
    return p;
  }

  // --- time -------------------------------------------------------------

  async wait(ticks = 1) {
    const e = this.engine;
    for (let i = 0; i < ticks && !e.quit; i++) {
      try {
        e.tick(FRAME_MS);
      } catch (err) {
        this.errors.push(`tick ${this.ticks} threw: ${err.stack || err}`);
      }
      this.ticks++;
      await new Promise((r) => setImmediate(r)); // let file reads finish
    }
  }

  // Tick until pred() holds; throws after `max` ticks.
  async waitFor(pred, what, max = 300) {
    for (let i = 0; i <= max; i++) {
      if (pred()) return i;
      if (this.engine.quit) break;
      await this.wait(1);
    }
    throw new Error(`timed out after ${max} ticks waiting for ${what}`);
  }

  // --- input ------------------------------------------------------------

  key(vk) {
    this.engine.input.keyDown(vk);
    this.engine.input.keyUp(vk);
  }
  async holdKey(vk, ticks) {
    this.engine.input.keyDown(vk);
    await this.wait(ticks);
    this.engine.input.keyUp(vk);
  }
  click(x, y) {
    this.engine.mouseMove(x, y);
    this.engine.mouseDown(x, y);
    this.engine.mouseUp(x, y);
  }
  hover(x, y) {
    this.engine.mouseMove(x, y);
  }

  // --- what is on screen ------------------------------------------------

  // Active click regions in screen pixels: {l, t, r, b, script, arg}.
  rects() {
    return this.engine.clickRects
      .filter((r) => !r.off)
      .map((r) => ({ l: r.l + ORIGIN_X, t: r.t + ORIGIN_Y, r: r.r + ORIGIN_X, b: r.b + ORIGIN_Y, script: r.script, arg: r.arg }));
  }
  hasRect(script) {
    return this.rects().some((r) => r.script === script);
  }
  // The script a click at (x, y) would run, or 0 (sprites first, as the
  // engine does).
  clickTarget(x, y) {
    const s = this.engine.sprites.pick(x - ORIGIN_X, y - ORIGIN_Y);
    if (s && s.click && !s.clickOff) return s.click.script;
    const r = this.rects().reverse().find((r) => x >= r.l && x < r.r && y >= r.t && y < r.b);
    return r ? r.script : 0;
  }
  sprites() {
    return [...this.engine.sprites.list.values()].filter((s) => s.visible);
  }
  sprite(id) {
    const s = this.engine.sprites.list.get(id);
    return s && s.visible ? s : null;
  }
  // Text shown by visible sprites (type 21 cels), in draw order.
  texts() {
    const e = this.engine;
    const out = [];
    for (const s of e.sprites.visibleSorted()) {
      const cel = s.cels[s.cel];
      if (cel && e.bin.type(cel) === 21) {
        const t = e.texts.get(cel);
        if (t && t.text) out.push(t.text);
      }
    }
    return out;
  }
  // A plugin (the movie player) is drawing over everything.
  get moviePlaying() {
    return this.engine.plugins.some((p) => p.ownsScreen);
  }

  // The screen as RGBA, with the 3D view under the sprites where they are
  // transparent (what the browser shows).
  screen() {
    const d = new Uint8ClampedArray(this.display.image.data);
    const u = this.display.underlay;
    const src = u && u.canvas && u.canvas.rgba ? u.canvas : null;
    if (!src) return d;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const X = x + (u.x || 0), Y = y + (u.y || 0);
        if (X < 0 || Y < 0 || X >= WIDTH || Y >= HEIGHT) continue;
        const o = (Y * WIDTH + X) * 4;
        if (d[o + 3]) continue;
        const i = (y * src.width + x) * 4;
        d[o] = src.rgba[i];
        d[o + 1] = src.rgba[i + 1];
        d[o + 2] = src.rgba[i + 2];
        d[o + 3] = 255;
      }
    }
    return d;
  }

  // Facts about a rectangle of the screen: how many distinct colours, and
  // how many pixels are not black.
  region(l = 0, t = 0, r = WIDTH, b = HEIGHT, rgba = this.screen()) {
    const colours = new Set();
    let lit = 0;
    for (let y = t; y < b; y++) {
      for (let x = l; x < r; x++) {
        const o = (y * WIDTH + x) * 4;
        const c = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
        colours.add(c);
        if (c) lit++;
      }
    }
    return { colours: colours.size, lit, area: (r - l) * (b - t) };
  }

  // Number of pixels that differ between two screen() captures in a rect.
  static diff(a, b, l = 0, t = 0, r = WIDTH, bt = HEIGHT) {
    let n = 0;
    for (let y = t; y < bt; y++) {
      for (let x = l; x < r; x++) {
        const o = (y * WIDTH + x) * 4;
        if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) n++;
      }
    }
    return n;
  }

  savePng(path, rgba = this.screen()) {
    const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      const o = y * (WIDTH * 4 + 1);
      raw[o] = 0;
      for (let i = 0; i < WIDTH * 4; i += 4) {
        const s = y * WIDTH * 4 + i;
        raw[o + 1 + i] = rgba[s];
        raw[o + 2 + i] = rgba[s + 1];
        raw[o + 3 + i] = rgba[s + 2];
        raw[o + 4 + i] = 255;
      }
    }
    const chunk = (tag, data) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0);
      b.write(tag, 4, "latin1");
      data.copy(b, 8);
      b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag, "latin1"), data])), 8 + data.length);
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(WIDTH, 0);
    ihdr.writeUInt32BE(HEIGHT, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(path, Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  }

  // Statements, builtins and externs the scripts called that the engine
  // does not implement yet: name -> count.
  unknown() {
    return new Map(this.engine.vm.unknown);
  }
}
