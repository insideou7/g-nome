// The engine: what RTLIB32.DLL does around the script VM. It owns the
// resource file, the VM, the message queue that drives scripts, and the
// plugins (smacker, render, netgn) that provide extern functions.

import { peCursors } from "./pe.js";
import { BinFile, palette256 } from "./binfile.js";
import { VM } from "./vm.js";
import { installStatements, stmtLength } from "./statements.js";
import { STATEMENTS } from "./stmt-impl.js";
import { BUILTINS } from "./builtins.js";
import { installPlugins } from "./plugins/index.js";
import { Input } from "./input.js";
import { Texts } from "./text.js";
import { Sprites, ORIGIN_X, ORIGIN_Y, blit } from "./sprites.js";

// 7THLEVEL.INI stand-in: section -> key -> value. Persisted by the shell.
export class Ini {
  constructor(data = {}) {
    this.data = data;
  }
  get(section, key) {
    return this.data[section.toLowerCase()]?.[key.toLowerCase()];
  }
  set(section, key, v) {
    (this.data[section.toLowerCase()] ||= {})[key.toLowerCase()] = String(v);
    this.onChange?.(this.data);
  }
}

// Window messages the runtime posts to itself.
export const MSG = {
  RUN_PENDING: 0x4c8, // run the script set by statement 0x74
  RUN_SCRIPT: 0x7fff0001, // our own: run wparam with args lparam
  QUIT: 0x10,
};

export class Engine {
  // files: { read(name) -> Promise<Uint8Array>, has(name) -> bool }
  // opts: { log, trace, display, audio }
  constructor(files, opts = {}) {
    this.files = files;
    this.log = opts.log || console.log;
    this.traceOn = !!opts.trace;
    this.display = opts.display || null; // see display.js
    this.audio = opts.audio || null;
    this.queue = [];
    this.time = 0;
    this.quit = false;
    this.pendingScript = 0; // rt+0x3df3
    this.cursorMode = 0; // rt+0x3cc7
    this.loaded = new Set();
    this.strings = new Map(); // string slots (ids 1..0x7fff)
    this.ini = opts.ini || new Ini();
    this.input = new Input(this);
    this.background = { mode: 2, color: 0, bitmap: 0 };
    this.tables = new Map(); // type 11 tables, decoded on first use
    this.dynamic = new Map(); // copied resources: new id -> source id
    this.nextDynamic = 0;
    this.sprites = new Sprites(this);
    this.texts = new Texts(this);
    this.clickRects = []; // statement 0x10: {l, t, r, b, script, arg, off}
    this.hoverRects = []; // statement 0x0e: {l, t, r, b, enter, enterArg, leave, leaveArg, sprite}
    this.hover = -1;
    this.dirty = true;
    this.timers = new Map(); // statement 0xc4: id -> {script, ms, due, repeat}
    this.fades = []; // queued palette fades {to, ms}
    this.fadedOut = false;
    this.lists = new Map(); // type 14 statement lists
  }

  // Run one statement outside any script (sprite queue record 21, type 14
  // statement lists).
  runStatement(bytes) {
    try {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return this.vm.execStmt(-1, bytes, dv, 0).ok;
    } catch (e) {
      this.log(`statement failed: ${e.message}`);
      return 0;
    }
  }

  // A type 14 resource: statements back to back (0x1001e9b0).
  statementList(id) {
    let l = this.lists.get(id);
    if (!l) {
      l = [];
      if (this.bin.type(id) === 14) {
        const b = this.bin.resident(id);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let p = 0; p < b.length; ) {
          const n = stmtLength(b, dv, p);
          if (!n) break;
          l.push(b.subarray(p, p + n));
          p += n;
        }
      }
      this.lists.set(id, l);
    }
    return l;
  }

  serviceTimers() {
    for (const [id, t] of [...this.timers]) {
      if (this.time < t.due) continue;
      if (t.repeat) t.due = this.time + Math.max(t.ms, 1);
      else this.timers.delete(id);
      this.run(t.script);
    }
  }

  // Draw background and sprites into the display.
  compose() {
    if (!this.dirty || this.plugins.some((p) => p.ownsScreen)) return;
    this.dirty = false;
    const d = this.display;
    const bg = this.background;
    // While the battlefield is shown, the 3D view is the background
    // (Resume3D: SpriteSetBackground(-1)); colour 0 lets it show through.
    if (this.world?.shown) d.pixels.fill(0);
    else if (bg.mode === 0 && this.bin.type(bg.bitmap) === 1) {
      d.pixels.fill(0);
      const b = this.sprites.bitmap(bg.bitmap);
      blit(d.pixels, b, 0, 0);
    } else if (bg.mode === 1) d.pixels.fill(bg.color);
    else d.pixels.fill(0);
    this.sprites.draw(d.pixels);
    d.dirty = true;
  }

  // Mouse, in canvas pixels (0..639, 0..479).
  mouseUp(cx, cy, button = 0) {
    this.world?.controls.mouseUp(button);
  }

  mouseDown(cx, cy, button = 0) {
    this.world?.controls.mouseDown(button);
    if (this.clicksOff) return; // statement 0x10 global switch
    const x = cx - ORIGIN_X, y = cy - ORIGIN_Y;
    const s = this.sprites.pick(x, y);
    if (s && s.click) return this.runLater(s.click.script, [s.id, s.click.arg]);
    for (let i = this.clickRects.length - 1; i >= 0; i--) {
      const r = this.clickRects[i];
      if (!r.off && x >= r.l && x < r.r && y >= r.t && y < r.b) return this.runLater(r.script, [0, r.arg]);
    }
  }
  mouseMove(cx, cy) {
    const x = cx - ORIGIN_X, y = cy - ORIGIN_Y;
    let hit = -1;
    for (let i = this.hoverRects.length - 1; i >= 0; i--) {
      const r = this.hoverRects[i];
      if (r.sprite) {
        if (this.sprites.pick(x, y)?.id === r.sprite) { hit = i; break; }
      } else if (x >= r.l && x < r.r && y >= r.t && y < r.b) { hit = i; break; }
    }
    if (hit === this.hover) return;
    const old = this.hoverRects[this.hover];
    if (old && old.leave) this.runLater(old.leave, [0, old.leaveArg]);
    this.hover = hit;
    const r = this.hoverRects[hit];
    if (r && r.enter) this.runLater(r.enter, [1, r.enterArg]);
  }

  // Builtin 0x19 (ResCopyResource): a new id that behaves like `id`.
  copyResource(id) {
    const n = this.nextDynamic++ + this.bin.count;
    this.dynamic.set(n, this.dynamic.get(id) ?? id);
    return n;
  }

  async init() {
    // The mouse cursors are resources of RTLIB32.DLL (next to G-NOME.BIN).
    try {
      this.cursors = peCursors(await this.files.read("RTLIB32.DLL"));
    } catch {
      this.cursors = new Map();
    }
    const binBytes = await this.files.read("G-NOME.BIN");
    const packs = new Map();
    this.bin = new BinFile(binBytes, (n) => packs.get(n));
    // Load every pack up front (~75 MB) so resource access is synchronous,
    // like the original's.
    const needed = new Set();
    for (let i = 0; i < this.bin.count; i++) if (!this.bin.isResident(i)) needed.add(this.bin.pack(i));
    for (const n of needed) {
      const name = `G-NOME.${String(n).padStart(3, "0")}`;
      packs.set(n, await this.files.read(name));
    }
    this.bin.readPack = (n) => packs.get(n);
    this.nextDynamic = 0;
    this.res = (id) => {
      if (this.dynamic.has(id)) id = this.dynamic.get(id);
      if (this.bin.isResident(id)) return this.bin.resident(id);
      const p = packs.get(this.bin.pack(id));
      return p.subarray(this.bin.offsets[id], this.bin.offsets[id] + this.bin.sizes[id]);
    };
    this.palette = palette256(this.bin.palette);
    this.vm = new VM(this.bin, {
      log: this.log,
      trace: this.traceOn ? (id, pos, op) => this.log(`  [${id}+${pos.toString(16)}] op ${op.toString(16)}`) : null,
    });
    this.vm.engine = this;
    installStatements(this.vm, STATEMENTS);
    for (const [id, f] of Object.entries(BUILTINS)) this.vm.builtins.set(Number(id), f);
    installPlugins(this);
    for (const p of this.plugins) if (p.preload) await p.preload();
    if (this.display) this.display.setPalette(this.palette);
  }

  post(msg, wparam = 0, lparam = 0) {
    this.queue.push({ msg, wparam, lparam });
  }

  // RtStartup: run the entry script (resource id at .BIN offset 0x58).
  boot() {
    this.log(`${this.bin.title}: ${this.bin.count} resources, entry script ${this.bin.entryScript}`);
    this.run(this.bin.entryScript);
  }

  callScript(id, args) {
    try {
      return this.vm.callScript(id, 0, args);
    } catch (e) {
      this.log(`script ${id} failed: ${e.message}`);
      return 0;
    }
  }

  run(id) {
    try {
      return this.vm.runScript(id);
    } catch (e) {
      this.log(`script ${id} failed: ${e.message}`);
      if (this.traceOn) this.log(e.stack);
      return 0;
    }
  }

  // One frame of the message loop.
  tick(ms) {
    this.time += ms;
    const q = this.queue;
    this.queue = [];
    for (const m of q) this.dispatch(m);
    for (const p of this.plugins) if (p.service) p.service(ms);
    this.sprites.tick(ms);
    this.serviceTimers();
    this.serviceFades(ms);
    if (this.display) {
      this.compose?.();
      this.display.present();
    }
  }

  dispatch({ msg, wparam, lparam }) {
    switch (msg) {
      case MSG.RUN_PENDING: // 0x10023f41
        if (this.pendingScript) {
          const id = this.pendingScript;
          this.pendingScript = 0;
          this.log(`run pending script ${id}`);
          this.run(id);
        }
        break;
      case MSG.RUN_SCRIPT:
        this.callScript(wparam, lparam);
        break;
      case MSG.QUIT:
        this.quit = true;
        break;
      default:
        if (this.onMessage) this.onMessage(msg, wparam, lparam);
    }
  }

  // String ids (0x100227ee): 0x8000 | offset is a constant in the .BIN's
  // string table; smaller ids are 255-character slots scripts can write.
  getString(id) {
    if (!id) return undefined;
    if (id & 0x8000) return this.bin.string(id & 0x7fff);
    return this.strings.get(id) ?? "";
  }
  setString(id, s) {
    if (id && !(id & 0x8000)) this.strings.set(id, s.slice(0, 255));
  }

  // Run a script from the message loop with arguments (RtRunMsg).
  runLater(id, args = []) {
    this.post(MSG.RUN_SCRIPT, id, args);
  }

  setPaletteResource(id) {
    if (this.bin.type(id) !== 17) return this.log(`palette: ${id} is not a palette`);
    const p = this.bin.resident(id);
    for (let i = 0; i < 236; i++) this.palette.set(p.subarray(i * 4, i * 4 + 3), (10 + i) * 3);
    this.display?.setPalette(this.palette, 10, 236);
  }

  // Statement 0xa4. mode 0: bitmap resource, 1: solid colour, 2: none.
  setBackground(mode, res, alt, color) {
    this.background = { mode, bitmap: res, color };
    this.dirty = true;
  }

  // Statement 0x1b (0x100226c8, 0x10022d83): 0 leaves the cursor alone,
  // 1 is the Windows arrow, 4 hides it, 2-3 and 5-9 are RTLIB32.DLL's
  // cursors 1001-1007. Calls onCursor(cursor or "default" or null).
  setCursor(mode) {
    if (this.traceOn) this.log(`cursor mode ${mode}`);
    this.cursorMode = mode;
    if (!mode || !this.onCursor) return;
    const ids = { 2: 1001, 3: 1002, 5: 1003, 6: 1004, 7: 1005, 8: 1006, 9: 1007 };
    if (mode === 1) this.onCursor("default");
    else if (ids[mode]) this.onCursor(this.cursors.get(ids[mode]) || "default");
    else this.onCursor(null);
  }

  // Statements 0x3c / 0x3d: palette fade in / out (0x1000c4d0). In 256
  // colour mode RTLIB32 fades colours 10-245 in `speed` steps (1-100, 0
  // means 100), one per frame, and the script waits for it. Here scripts
  // carry on, so a fade-out freezes the last frame while it darkens and the
  // next fade-in reveals whatever the scripts drew meanwhile.
  fade(fadeIn, speed) {
    if (fadeIn === !this.fadedOut) return; // already there (flag +0x94b1)
    this.fadedOut = !fadeIn;
    if (!this.display) return;
    const steps = speed > 0 && speed <= 100 ? speed : 100;
    if (!fadeIn) {
      this.compose?.();
      this.display.freeze();
    }
    this.fades.push({ to: fadeIn ? 1 : 0, ms: (steps * 1000) / 60 });
  }

  // Advance queued fades by `ms`.
  serviceFades(ms) {
    const d = this.display;
    while (d && this.fades.length && ms > 0) {
      const f = this.fades[0];
      if (f.to === 1 && d.frozen) d.unfreeze();
      const left = Math.abs(f.to - d.fade) * f.ms;
      if (left <= ms) {
        d.fade = f.to;
        ms -= left;
        this.fades.shift();
        if (f.to === 1 && d.frozen) d.unfreeze();
      } else {
        d.fade += Math.sign(f.to - d.fade) * (ms / f.ms);
        ms = 0;
      }
      d.dirty = true;
    }
  }

  // A movie owns the whole palette: stop fades without changing the state.
  cancelFades() {
    this.fades = [];
    if (!this.display) return;
    this.display.unfreeze();
    this.display.fade = 1;
  }
}
