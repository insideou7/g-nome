// Joysticks: RENDER.R32 reads two WinMM joysticks (joyGetPosEx on ids 0
// and 1). The browser has the Gamepad API instead; this module makes the
// first two gamepads look like those joysticks, so the original rules for
// held actions, axis ranges and button presses apply unchanged.
//
// Bindings use device 3 for joystick 1 and device 6 for joystick 2, with
// these keys (CheckActionState 0x1000c631, button poll 0x1000c460):
//   1/2  X above/below centre    3/4  Y above/below centre
//   5/6  Z                       7/8  R
//   9/10 U (threshold 1000)      11/12 V
//   13-16 hat up, down, left, right (POV 0, 18000, 27000, 9000)
//   17-24 buttons 1-8 (CheckActionState only knows 17-20)
// Axes count as pushed beyond 8000 of 65535 from the centre.
//
// A standard-mapping gamepad reads the way Windows' joystick driver reports
// an Xbox pad: X/Y the left stick, U/R the right stick, Z the two triggers
// (left up, right down), buttons 1-8 A B X Y LB RB Back Start, the d-pad as
// the hat. Any other gamepad passes its first six axes as X Y Z R U V and
// its buttons in order, with no hat.

const MAX = 65535;
const CENTRE = MAX >> 1; // EnableJoystick: (min + max) >> 1
// wCaps bits (JOYCAPS_HASZ, HASR, HASU, HASV, HASPOV)
const HAS_Z = 1, HAS_R = 2, HAS_U = 4, HAS_V = 8, HAS_POV = 0x10;
const POV_CENTRED = 0xffff;
// joyGetPosEx buttons 1-8 from standard-mapping gamepad buttons
const STANDARD_BUTTONS = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11];
// Press message key for each hat direction (0x1000c460)
const POV_KEYS = new Map([[0, 13], [18000, 14], [27000, 15], [9000, 16]]);
// The poll runs every wPeriodMin + 20 ms; most drivers give wPeriodMin 10.
const POLL_MS = 30;

/**
 * @typedef {{ x: number, y: number, z: number, r: number, u: number, v: number,
 *   buttons: number, pov: number, caps: number }} JoyState
 */

/** @param {number} a -1..1 */
const pos = (a) => Math.round((Math.max(-1, Math.min(1, a || 0)) + 1) * (MAX / 2));

/**
 * A gamepad as joyGetPosEx would report it.
 * @param {any} pad
 * @returns {JoyState}
 */
export function readPad(pad) {
  const axes = pad.axes || [];
  const btn = pad.buttons || [];
  const pressed = (/** @type {number} */ i) => !!(btn[i] && (btn[i].pressed || btn[i].value > 0.5));
  const value = (/** @type {number} */ i) => (btn[i] ? +btn[i].value || (btn[i].pressed ? 1 : 0) : 0);
  let buttons = 0;
  if (pad.mapping === "standard") {
    STANDARD_BUTTONS.forEach((b, i) => {
      if (pressed(b)) buttons |= 1 << i;
    });
    const up = pressed(12), down = pressed(13), left = pressed(14), right = pressed(15);
    const dx = (right ? 1 : 0) - (left ? 1 : 0), dy = (up ? 1 : 0) - (down ? 1 : 0);
    const pov = dx || dy ? ((Math.round((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360) * 100 : POV_CENTRED;
    return {
      x: pos(axes[0]),
      y: pos(axes[1]),
      z: pos(value(6) - value(7)),
      r: pos(axes[3]),
      u: pos(axes[2]),
      v: CENTRE,
      buttons,
      pov,
      caps: HAS_Z | HAS_R | HAS_U | HAS_POV,
    };
  }
  for (let i = 0; i < 32 && i < btn.length; i++) if (pressed(i)) buttons |= 1 << i;
  const caps = (axes.length > 2 ? HAS_Z : 0) | (axes.length > 3 ? HAS_R : 0) | (axes.length > 4 ? HAS_U : 0) | (axes.length > 5 ? HAS_V : 0);
  return { x: pos(axes[0]), y: pos(axes[1]), z: pos(axes[2]), r: pos(axes[3]), u: pos(axes[4]), v: pos(axes[5]), buttons, pov: POV_CENTRED, caps };
}

export class Joystick {
  /**
   * @param {() => any} [pads] the gamepad list (navigator.getGamepads)
   */
  constructor(pads) {
    this.pads = pads || (() => /** @type {any} */ (globalThis).navigator?.getGamepads?.() ?? []);
    this.on = false; // the scripts' EnableJoystick setting
    this.flags = 0; // ctx+0x110: bit 0 joystick 1 present, bit 1 joystick 2
    this.toggled = [0, 0]; // ctx+0x480/0x484, see poll
    this.pov = [0, 0]; // last hat position
    this.last = -Infinity; // time of the last poll
  }

  // Joystick n (0 or 1): the nth connected gamepad.
  /**
   * @param {number} n
   * @returns {JoyState | null}
   */
  read(n) {
    let list;
    try {
      list = this.pads();
    } catch {
      return null;
    }
    const pad = [...(list || [])].filter((p) => p && p.connected !== false)[n];
    return pad ? readPad(pad) : null;
  }

  // EnableJoystick(on) 0x1000d80b: which joysticks answer now. Returns the
  // flags (bit 0 joystick 1, bit 1 joystick 2).
  /**
   * @param {any} on
   */
  enable(on) {
    this.on = !!on;
    this.flags = 0;
    if (this.on) for (let n = 0; n < 2; n++) if (this.read(n)) this.flags |= 1 << n;
    return this.flags;
  }

  // One binding's part in CheckActionState: 1 held, 0 bound and readable
  // but not held, -1 says nothing (no joystick, no such axis, or a button:
  // the original only reports buttons that are down).
  /**
   * @param {number} n
   * @param {number} key
   */
  held(n, key) {
    if (!(this.flags & (1 << n))) return -1;
    const s = this.read(n);
    if (!s) {
      this.flags &= ~(1 << n); // joyGetPosEx failed
      return -1;
    }
    const above = (/** @type {number} */ v, t = 8000) => (v > CENTRE + t ? 1 : 0);
    const below = (/** @type {number} */ v, t = 8000) => (v < CENTRE - t ? 1 : 0);
    const has = (/** @type {number} */ bit) => !!(s.caps & bit);
    switch (key) {
      case 1: return above(s.x);
      case 2: return below(s.x);
      case 3: return above(s.y);
      case 4: return below(s.y);
      case 5: return has(HAS_Z) ? above(s.z) : -1;
      case 6: return has(HAS_Z) ? below(s.z) : -1;
      case 7: return has(HAS_R) ? above(s.r) : -1;
      case 8: return has(HAS_R) ? below(s.r) : -1;
      case 9: return has(HAS_U) ? above(s.u, 1000) : -1;
      case 10: return has(HAS_U) ? below(s.u, 1000) : -1;
      case 11: return has(HAS_V) ? above(s.v) : -1;
      case 12: return has(HAS_V) ? below(s.v) : -1;
      case 13: case 14: case 15: case 16:
        if (!has(HAS_POV)) return -1;
        return s.pov === [0, 18000, 27000, 9000][key - 13] ? 1 : 0;
      case 17: case 18: case 19: case 20:
        return s.buttons & (1 << (key - 17)) ? 1 : -1;
      default:
        return -1;
    }
  }

  // RangeJoystickAxis(binds, action, min, max, deadZone) 0x1000d184 for a
  // binding already found: the axis scaled to min..max. Odd keys read the
  // axis turned around. With deadZone, a fifth of the axis around the
  // centre gives 0, and each side scales on its own (min is returned as
  // is when it is not negative).
  /**
   * @param {number} n
   * @param {number} key
   * @param {number} min
   * @param {number} max
   * @param {number} deadZone
   */
  range(n, key, min, max, deadZone) {
    if (key < 1 || key > 12) return -1;
    const s = this.read(n);
    const raw = s ? [s.x, s.y, s.z, s.r, s.u, s.v][(key - 1) >> 1] : CENTRE;
    const lo = 0, hi = MAX, c = CENTRE;
    const v = key & 1 ? hi - raw + lo : raw;
    const div = (/** @type {number} */ a, /** @type {number} */ b) => Math.trunc(a / b);
    if (!deadZone) return div((max - min) * v, hi - lo);
    const d = div(hi - lo, 5);
    if (Math.abs(v - c) < d) return 0;
    if (c <= v) return div((v - d - c) * max, hi - d - c);
    if (min >= 0) return min;
    return min + div((v - lo) * min, lo + d - c);
  }

  // The poll (0x1000c460, from RENDER.R32's service every wPeriodMin + 20
  // ms while a joystick is on). Calls press(n, key) for each new press.
  // Buttons go through an XOR with the last state, so a button held down
  // presses again every other poll, as in the original. The hat presses
  // when it moves to one of its four directions.
  //
  // Browsers only list a gamepad after one of its buttons is pressed on
  // the page, so while the scripts have the joystick on, a gamepad that
  // shows up later is taken in (a port addition; the original only
  // looks in EnableJoystick).
  /**
   * @param {number} now ms
   * @param {(n: number, key: number) => void} press
   */
  poll(now, press) {
    if (!this.on || now - this.last <= POLL_MS) return;
    this.last = now;
    for (let n = 0; n < 2; n++) {
      const s = this.read(n);
      if (!s) continue;
      this.flags |= 1 << n;
      this.toggled[n] ^= s.buttons;
      const before = this.pov[n];
      this.pov[n] = s.pov;
      for (let i = 0; i < 8; i++) if (s.buttons & this.toggled[n] & (1 << i)) press(n, 0x11 + i);
      const k = POV_KEYS.get(s.pov);
      if (s.pov !== before && k) press(n, k);
    }
  }
}
