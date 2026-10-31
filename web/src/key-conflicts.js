// Conflict marks on OPTIONS > INTERFACE, the key mapping screen. The
// original lets two game functions share a key without saying so; this
// port addition outlines every cell whose key also drives another function
// in red.
//
// The screen edits table 6323: 63 rows of {action, ?, device, key} x 3, one
// pair per Mapping column. Twelve rows show at a time, from row G2095; the
// row of table 6418 for a visible line holds its top and bottom (columns 3
// and 5, script coordinates).
//
// Two bindings conflict when they are the same input (device 0 and 5 are
// both the key without modifiers) and their actions can be active at the
// same time: table 2544 columns 2-5 say in which control modes an action
// works. So Space for action 9 and action 42 (which no mode allows) is no
// conflict. Joystick bindings (devices 3 and 6) are left out: the browser
// has no joystick.

import { table } from "./builtins.js";
import { ORIGIN_X, ORIGIN_Y } from "./sprites.js";
/** @import { Engine } from "./engine.js" */

const KEY_MAP = 6323;
const ROW_SIZE = 8;
const LINES = 6418; // per visible line: column 3 top, 5 bottom
const LINE_SIZE = 10;
const VISIBLE = 12;
const FIRST_ROW = 2095; // global: the table row on the first line
const ACTIONS = 2544; // columns 2-5: allowed in control mode 0-3
const CELL_SCRIPT = 6365; // Mapping 1 cells' click script: the screen is up
// Left edges of the Mapping 1-3 cells (canvas pixels) and their width.
const COLUMN_X = [268, 345, 422];
const CELL_W = 72;

// A binding as one string per input, or null when it is empty or a joystick.
/**
 * @param {number} device
 * @param {any} key
 */
function inputKey(device, key) {
  if (!key && !device) return null;
  if (device === 3 || device === 6) return null;
  return `${device === 5 ? 0 : device}/${key}`;
}

export class KeyConflicts {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    /** @type {any} */
    this.cells = []; // [{row, col}] in conflict, over the whole table
    this.sig = "";
    this.wasShown = false;
  }

  get shown() {
    const e = this.engine;
    if (!e.vm || e.fadedOut || e.display?.frozen || e.world?.shown) return false;
    if (e.plugins?.some((/** @type {any} */ p) => p.ownsScreen)) return false;
    return e.clickRects.some((/** @type {any} */ r) => r.script === CELL_SCRIPT && !r.off);
  }

  // Modes (bits 0-3) in which an action can be active.
  /**
   * @param {number} action
   */
  modes(action) {
    const t = table(this.engine.vm, ACTIONS);
    if (!t) return 0xf;
    const w = t.strides[0] || 17;
    let m = 0;
    for (let i = 0; i < 4; i++) if (t.data[action * w + 2 + i]) m |= 1 << i;
    return m;
  }

  // Every cell whose input also drives another action in a shared mode.
  find() {
    const t = table(this.engine.vm, KEY_MAP);
    if (!t) return [];
    const byInput = new Map(); // input -> [{row, col, action, modes}]
    for (let row = 0; row * ROW_SIZE < t.data.length; row++) {
      const o = row * ROW_SIZE;
      const action = t.data[o];
      for (let col = 0; col < 3; col++) {
        const k = inputKey(t.data[o + 2 + 2 * col], t.data[o + 3 + 2 * col]);
        if (!k) continue;
        if (!byInput.has(k)) byInput.set(k, []);
        byInput.get(k).push({ row, col, action, modes: this.modes(action) });
      }
    }
    const out = [];
    for (const list of byInput.values()) {
      for (const a of list) {
        if (list.some((/** @type {any} */ b) => b.action !== a.action && a.modes & b.modes)) out.push({ row: a.row, col: a.col });
      }
    }
    return out;
  }

  // Once a frame: recheck, and redraw when something changed.
  update() {
    const shown = this.shown;
    if (shown) {
      this.cells = this.find();
      const sig = `${this.engine.vm.getGlobal(FIRST_ROW)}:${this.cells.map((/** @type {any} */ c) => `${c.row}.${c.col}`).join(",")}`;
      if (sig !== this.sig && this.engine.display) this.engine.display.dirty = true;
      this.sig = sig;
    }
    if (shown !== this.wasShown && this.engine.display) this.engine.display.dirty = true;
    this.wasShown = shown;
  }

  // The visible cells in conflict, as canvas rectangles {row, col, x, y, w, h}.
  visibleCells() {
    const e = this.engine;
    const lines = table(e.vm, LINES);
    if (!lines) return [];
    const first = e.vm.getGlobal(FIRST_ROW);
    const out = [];
    for (const c of this.cells) {
      const line = c.row - first;
      if (line < 0 || line >= VISIBLE) continue;
      const top = lines.data[line * LINE_SIZE + 3] + ORIGIN_Y;
      const bottom = lines.data[line * LINE_SIZE + 5] + ORIGIN_Y;
      out.push({ row: c.row, col: c.col, x: COLUMN_X[c.col], y: top, w: CELL_W, h: bottom - top });
    }
    return out;
  }

  // Drawn over the presented frame (Display.overlay).
  /**
   * @param {any} ctx
   */
  draw(ctx, fade = 1) {
    if (!this.shown || !this.cells.length) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = "#ff3030";
    ctx.lineWidth = 2;
    for (const r of this.visibleCells()) ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.restore();
  }
}
