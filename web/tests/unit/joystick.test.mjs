// Unit tests for the joystick layer: src/battlefield/joystick.js (gamepads
// read as RENDER.R32's WinMM joysticks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Joystick, readPad } from "../../src/battlefield/joystick.js";

// A standard-mapping gamepad with the given axes and pressed buttons.
const pad = (axes = [0, 0, 0, 0], down = []) => ({
  connected: true,
  mapping: "standard",
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })),
});

test("a standard gamepad reads like Windows reports an Xbox pad", () => {
  const s = readPad(pad([1, -1, 0, 0], [0, 9, 12]));
  assert.equal(s.x, 65535);
  assert.equal(s.y, 0);
  assert.equal(s.buttons, 1 | (1 << 7), "A is button 1, Start button 8");
  assert.equal(s.pov, 0, "d-pad up is POV 0");
  assert.equal(readPad(pad([0, 0, 0, 0], [13, 15])).pov, 13500, "down-right");
  assert.equal(readPad(pad()).pov, 0xffff, "centred");
  assert.ok(readPad(pad([], [6])).z > 60000, "left trigger raises Z");
});

test("EnableJoystick reports which joysticks answer", () => {
  const pads = [null, pad()];
  const j = new Joystick(() => pads);
  assert.equal(j.enable(1), 1);
  pads.push(pad());
  assert.equal(j.enable(1), 3);
  assert.equal(j.enable(0), 0);
  assert.equal(new Joystick(() => []).enable(1), 0);
});

test("held: axes past 8000, hat directions, buttons only when down", () => {
  const p = pad([0.5, -0.1, 0, 0], [0, 14]);
  const j = new Joystick(() => [p]);
  assert.equal(j.held(0, 1), -1, "nothing before EnableJoystick");
  j.enable(1);
  assert.equal(j.held(0, 1), 1, "X right of centre");
  assert.equal(j.held(0, 2), 0);
  assert.equal(j.held(0, 4), 0, "-0.1 is inside 8000");
  assert.equal(j.held(0, 15), 1, "hat left");
  assert.equal(j.held(0, 13), 0);
  assert.equal(j.held(0, 17), 1, "button 1");
  assert.equal(j.held(0, 18), -1, "a button that is up says nothing");
  assert.equal(j.held(0, 11), -1, "no V axis");
  assert.equal(j.held(1, 1), -1, "no joystick 2");
});

test("range scales the axis like RangeJoystickAxis", () => {
  const p = pad([0, 0, 0, 0]);
  const j = new Joystick(() => [p]);
  j.enable(1);
  assert.equal(j.range(0, 4, -50, 100, 1), 0, "centre is in the dead zone");
  p.axes[1] = 1;
  assert.equal(j.range(0, 4, -50, 100, 1), 100, "full Y: max");
  assert.equal(j.range(0, 3, -50, 100, 1), -50, "odd key turns the axis round");
  p.axes[1] = -1;
  assert.equal(j.range(0, 4, 20, 100, 1), 20, "a non-negative min is returned as is");
  assert.equal(j.range(0, 4, 0, 100, 0), 0);
  p.axes[1] = 1;
  assert.equal(j.range(0, 4, 0, 100, 0), 100, "no dead zone: (max - min) * pos / range");
  assert.equal(j.range(0, 13, 0, 100, 1), -1, "the hat is no axis");
});

test("poll presses buttons on the way down, again every other poll while held, and the hat on a move", () => {
  const p = pad();
  const j = new Joystick(() => [p]);
  j.enable(1);
  const got = [];
  const poll = (t) => j.poll(t, (n, key) => got.push(`${n}:${key}`));
  poll(100);
  assert.deepEqual(got, []);
  p.buttons[1].pressed = true;
  poll(140);
  poll(150); // too soon after the last poll
  poll(180);
  poll(220);
  assert.deepEqual(got, ["0:18", "0:18"]);
  got.length = 0;
  p.buttons[1].pressed = false;
  p.buttons[15].pressed = true;
  poll(260);
  poll(300);
  assert.deepEqual(got, ["0:16"], "hat right once");
});

test("a gamepad that shows up after EnableJoystick is taken in while it is on", () => {
  const pads = [];
  const j = new Joystick(() => pads);
  assert.equal(j.enable(1), 0);
  pads.push(pad([], [0]));
  j.poll(100, () => {});
  assert.equal(j.flags, 1);
  j.enable(0);
  j.poll(200, () => {});
  assert.equal(j.flags, 0, "not while off");
});
