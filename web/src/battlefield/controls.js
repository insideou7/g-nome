// In-mission controls: RENDER.R32 subclasses the game window (0x1000dc7a)
// to turn key and mouse presses into action scripts, and CheckActionState
// (0x1000c631) polls whether an action's key is held.
//
// Tables (type 11), as the scripts pass them:
//   2544  actions: row = action, col 0 = script run on a press, col 1 = flag
//         bits checked against the caller's mask, cols 2..5 = 1 if the
//         action is allowed in control mode 0..3 (column = mode + 2)
//   2546  held actions:  rows {action, device, key}, ended by action -1
//   2545, 2547  pressed actions (MapActionKeys): the same layout
// Device: 0 key alone, 1 Ctrl+key, 2 Shift+key, 5 key without modifiers,
// 4 mouse button (1 left, 2 right, 3 middle), 3 and 6 joysticks 1 and 2
// (keys in joystick.js).
import { table } from "../builtins.js";
import { Joystick } from "./joystick.js";
/** @import { Engine } from "../engine.js" */

const CTRL = 0x11, SHIFT = 0x10;

export class Controls {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.down = new Set(); // virtual keys held
    this.buttons = new Set(); // mouse buttons held: 1 left, 2 right, 3 middle
    this.mouse = false; // MouseOnOff
    /** @type {any} */
    this.map = null; // MapActionKeys: {actions, events: [ids], column, mask}
    this.joystick = new Joystick();
  }

  /**
   * @param {number} id
   */
  rows(id) {
    const t = table(this.engine.vm, id);
    if (!t) return [];
    const w = t.strides[0] || 3;
    const out = [];
    for (let o = 0; o + 2 < t.data.length; o += w) {
      if (t.data[o] === -1) break;
      out.push([t.data[o], t.data[o + 1], t.data[o + 2]]);
    }
    return out;
  }

  // actions[action][col], or 0
  /**
   * @param {number} actions
   * @param {number} action
   * @param {number} col
   */
  action(actions, action, col) {
    const t = table(this.engine.vm, actions);
    if (!t) return 0;
    const o = action * (t.strides[0] || 1) + col;
    return o >= 0 && o < t.data.length ? t.data[o] : 0;
  }

  /**
   * @param {any} device
   * @param {number} key
   */
  held(device, key) {
    const ctrl = this.down.has(CTRL), shift = this.down.has(SHIFT);
    switch (device) {
      case 0:
      case 5:
        // Shift or Ctrl bound on its own (a port addition, input.js) is
        // held whenever it is down
        if (key === CTRL || key === SHIFT) return this.down.has(key);
        return !ctrl && !shift && this.down.has(key);
      case 1:
        return ctrl && this.down.has(key);
      case 2:
        return shift && this.down.has(key);
      case 4:
        return this.mouse && this.buttons.has(key);
      default:
        return false; // no joysticks
    }
  }

  // CheckActionState(actions, binds, action, column, mask): 1 held, 0 bound
  // but not held, -1 not bound or not allowed here
  /**
   * @param {number} actions
   * @param {number} binds
   * @param {number} action
   * @param {number} column
   * @param {number} mask
   */
  check(actions, binds, action, column, mask) {
    if (!this.action(actions, action, column) || !(mask & this.action(actions, action, 1))) return -1;
    let r = -1;
    for (const [a, device, key] of this.rows(binds)) {
      if (a !== action) continue;
      if (device === 3 || device === 6) {
        const j = this.joystick.held(device === 3 ? 0 : 1, key);
        if (j === 1) return 1;
        if (j === 0) r = 0;
        continue;
      }
      r = 0;
      if (this.held(device, key)) return 1;
    }
    return r;
  }

  // A press: run the scripts of the actions bound to it (the window
  // procedure's loop over both event tables). Repeats are ignored.
  /**
   * @param {"key" | "mouse" | "joy1" | "joy2"} device
   * @param {number} key
   */
  press(device, key) {
    const m = this.map;
    if (!m) return;
    const ctrl = this.down.has(CTRL), shift = this.down.has(SHIFT);
    for (const id of m.events) {
      for (const [action, dev, k] of this.rows(id)) {
        if (k !== key) continue;
        if (device === "mouse" ? dev !== 4 : device === "joy1" ? dev !== 3 : device === "joy2" ? dev !== 6 : !matchesKey(dev, ctrl, shift, k)) continue;
        if (!this.action(m.actions, action, m.column) || !(m.mask & this.action(m.actions, action, 1))) continue;
        const script = this.action(m.actions, action, 0);
        if (script) this.engine.callScript(script, [action]);
      }
    }
  }

  // RangeJoystickAxis(binds, action, min, max, deadZone) 0x1000d184: -1
  // with no joystick on, else the first binding of the action read as an
  // axis (-1 when it is not a joystick axis).
  /**
   * @param {number} binds
   * @param {number} action
   * @param {number} min
   * @param {number} max
   * @param {number} deadZone
   */
  axis(binds, action, min, max, deadZone) {
    const j = this.joystick;
    if (!j.flags) return -1;
    if (action === -1) return 0;
    const row = this.rows(binds).find(([a]) => a === action);
    if (!row || (row[1] !== 3 && row[1] !== 6)) return -1;
    return j.range(row[1] === 3 ? 0 : 1, row[2], min, max, deadZone);
  }

  // Once a frame: poll the joysticks. A button or hat press goes to a
  // pending CaptureKey as device 3 or 6, else to the press bindings
  // (window procedure 0x1000dc7a, messages MM_JOY1/2BUTTONDOWN).
  /**
   * @param {number} now ms
   */
  pollJoystick(now) {
    this.joystick.poll(now, (n, key) => {
      if (this.engine.input.captured(n ? 6 : 3, key)) return;
      this.press(n ? "joy2" : "joy1", key);
    });
  }

  /**
   * @param {number} vk
   */
  keyDown(vk) {
    const repeat = this.down.has(vk);
    this.down.add(vk);
    if (!repeat) this.press("key", vk);
  }

  /**
   * @param {number} vk
   */
  keyUp(vk) {
    this.down.delete(vk);
  }

  // button: DOM numbering (0 left, 1 middle, 2 right)
  /**
   * @param {number} button
   */
  mouseDown(button) {
    const b = [1, 3, 2][button] || 1;
    this.buttons.add(b);
    if (this.mouse) this.press("mouse", b);
  }

  /**
   * @param {number} button
   */
  mouseUp(button) {
    this.buttons.delete([1, 3, 2][button] || 1);
  }
}

/**
 * @param {number} dev
 * @param {boolean} ctrl
 * @param {boolean} shift
 * @param {number} key
 */
function matchesKey(dev, ctrl, shift, key) {
  if (key === CTRL || key === SHIFT) return dev === 0 || dev === 5;
  return (dev === 0 && !ctrl && !shift) || (dev === 1 && ctrl && !shift) || (dev === 2 && shift && !ctrl) || (dev === 5 && !ctrl && !shift);
}
