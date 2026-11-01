// Unit tests for the steering helpers in src/anim/motion.js: the
// acceleration-limited turn step, rate ramps, target leading and yaw/pitch
// steering. (tests/motion-check.mjs covers the externs built on them.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { approachAngle, rampRate, leadDirection, motionOf, spinStep, yawToward, pitchToward } from "../../src/anim/motion.js";
import { rotate, headingOf } from "../../src/battlefield/math.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A stand-in for the battlefield's WorldObject: a basis that turns.
function object() {
  return {
    basis: { right: [1, 0, 0], up: [0, 1, 0], at: [0, 0, 1] },
    spin: { pitch: 0, yaw: 0, roll: 0 },
    turn(yaw, pitch = 0, roll = 0) {
      const b = this.basis;
      const steps = [[b.right.slice(), pitch], [b.up.slice(), yaw], [b.at.slice(), roll]].filter((s) => s[1]);
      const r = (v) => steps.reduce((v, [k, d]) => rotate(v, k, d), v);
      this.basis = { right: r(b.right), up: r(b.up), at: r(b.at) };
    },
  };
}

test("approachAngle: from rest, a far angle starts the turn", () => {
  const rate = { v: 0 };
  const step = approachAngle(90, true, 180, rate, 0.1, 90);
  assert.ok(near(rate.v, 18), "rate = accel * dt");
  assert.ok(near(step, 1.8), "step = accel * dt²");
  const back = { v: 0 };
  assert.ok(near(approachAngle(-90, true, 180, back, 0.1, 90), -1.8));
  assert.ok(near(back.v, -18));
});

test("approachAngle: from rest, an angle within one step is left alone", () => {
  const rate = { v: 0 };
  assert.equal(approachAngle(0.5, true, 180, rate, 0.1, 90), 0);
  assert.equal(rate.v, 0);
});

test("approachAngle: turns to the angle without passing maxVel, and brakes", () => {
  for (const target of [90, -135, 30]) {
    const rate = { v: 0 };
    const dt = 1 / 30, maxVel = 90, accel = 180;
    let left = target, turned = 0, peak = 0;
    for (let i = 0; i < 600 && !(Math.abs(left) < 0.5 && Math.abs(rate.v) < 10); i++) {
      const step = approachAngle(left, true, accel, rate, dt, maxVel);
      left -= step;
      turned += step;
      peak = Math.max(peak, Math.abs(rate.v));
    }
    assert.ok(peak <= maxVel + 1e-9, `rate stays within maxVel (${peak})`);
    assert.ok(Math.abs(turned - target) < 2, `turned ${turned} of ${target}`);
  }
});

test("approachAngle: braking slows by twice the acceleration", () => {
  // 1° to go at 60°/s: it would overshoot, so it brakes 2 * 180 * 0.1.
  const rate = { v: 60 };
  const step = approachAngle(1, true, 180, rate, 0.1, 90);
  assert.ok(near(rate.v, 24), `rate ${rate.v}`);
  assert.ok(near(step, 2.4));
  const back = { v: -10 };
  approachAngle(-0.1, true, 180, back, 0.1, 90);
  assert.equal(back.v, 0, "braking stops at 0");
});

test("approachAngle: without braking it keeps accelerating to maxVel", () => {
  const rate = { v: 80 };
  approachAngle(1, false, 180, rate, 0.1, 90);
  assert.equal(rate.v, 90);
});

test("rampRate: nudges from rest, accelerates, and caps at maxVel", () => {
  assert.ok(near(rampRate(0, 1, 100, 50, 100), 1), "1/100 of accel from rest");
  assert.ok(near(rampRate(10, 1, 100, 50, 100), 20), "accel per second");
  assert.equal(rampRate(45, 1, 100, 50, 100), 50, "capped");
  assert.equal(rampRate(-45, -1, 100, 50, 100), -50, "capped going back");
  assert.ok(near(rampRate(0, -1, 100, 50, 100), -1));
});

test("rampRate: braking is four times the acceleration and stops at 0", () => {
  assert.ok(near(rampRate(50, 0, 100, 50, 100), 10), "50 - 4*100*0.1");
  assert.equal(rampRate(30, 0, 100, 50, 100), 0, "does not pass 0");
  assert.equal(rampRate(-30, 0, 100, 50, 100), 0);
  assert.ok(near(rampRate(50, -1, 100, 50, 100), 10), "reversing brakes first");
});

test("leadDirection: a still target is straight ahead", () => {
  const d = leadDirection([0, 0, 0], 10, [30, 0, 40], [0, 0, 0]);
  assert.ok(near(d[0], 0.6, 1e-3) && near(d[1], 0) && near(d[2], 0.8, 1e-3), d.join());
});

test("leadDirection: aims where a moving target will be", () => {
  const pos = [0, 0, 0], s = 20, target = [0, 0, 50], vel = [10, 0, 0];
  const d = leadDirection(pos, s, target, vel);
  // Find t where the shot meets the target and check the paths agree.
  const t = 50 / (s * d[2]);
  const shot = d.map((v) => v * s * t);
  const where = target.map((p, i) => p + vel[i] * t);
  assert.ok(shot.every((v, i) => Math.abs(v - where[i]) < 0.2), `${shot} vs ${where}`);
  assert.ok(d[0] > 0, "leads to the side the target moves to");
});

test("leadDirection: (0, 0, 1) when the target can't be reached in time", () => {
  assert.deepEqual(leadDirection([0, 0, 0], 1, [0, 0, 100], [0, 0, 0]), [0, 0, 1]);
  assert.deepEqual(leadDirection([0, 0, 0], 5, [0, 0, 10], [0, 0, 50]), [0, 0, 1], "target faster than the shot");
});

test("motionOf adds the motion fields once", () => {
  const o = {};
  const m = motionOf(o);
  assert.equal(m.targetYaw, 0);
  assert.equal(motionOf(o), m);
});

test("yawToward sets a signed target angle", () => {
  const o = object();
  yawToward(o, [1, 0, 0]);
  assert.ok(near(motionOf(o).targetYaw, 90), "towards right is +");
  yawToward(o, [-1, 0, 0]);
  assert.ok(near(motionOf(o).targetYaw, -90));
  yawToward(o, [0, 5, 1]);
  assert.ok(near(motionOf(o).targetYaw, 0), "height is ignored");
  assert.ok(near(motionOf(o).targetCos, 1));
});

test("spinStep turns the object onto the yaw target and stops", () => {
  const o = object();
  const m = motionOf(o);
  m.maxAngAccel.yaw = 360;
  m.maxAngVel.yaw = 180;
  yawToward(o, [1, 0, 1]); // 45° right
  for (let i = 0; i < 300 && m.targetYaw !== 0; i++) spinStep(o, 1 / 30);
  assert.equal(m.targetYaw, 0, "target worked off");
  assert.equal(o.spin.yaw, 0, "spin stopped");
  const h = headingOf(o.basis.at) / 100;
  assert.ok(Math.abs(h - 45) < 2, `heading ${h}`);
});

test("pitchToward pitches towards a point ahead, and stops for one behind", () => {
  const o = object();
  const m = motionOf(o);
  m.maxAngAccel.pitch = 360;
  m.maxAngVel.pitch = 180;
  // Above and ahead: positive step (towards up), spin.pitch negative (up).
  const step = pitchToward(o, [0, 1, 1], 0.1);
  assert.ok(step > 0, `step ${step}`);
  assert.ok(o.spin.pitch < 0, "a negative pitch rate looks up");
  assert.equal(pitchToward(o, [0, 1, -1], 0.1), 0);
  assert.equal(o.spin.pitch, 0);
});
