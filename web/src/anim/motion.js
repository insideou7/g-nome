// RENDER.R32's velocity, steering and movement externs (0x1000ba71,
// 0x10011b21-0x100181fe) and the helpers they share. Spec: the "Motion"
// section of docs/formats/animation.md.
//
// These work on the battlefield's WorldObject (engine.world.get(id)): pos,
// last, vel, gravity, speed, basis {right, up, at}, spin {pitch, yaw, roll}
// in degrees per second, move(dt) and turn(yaw, pitch, roll). The fields the
// battlefield doesn't keep are added by `motionOf` below, named after the
// object struct offsets they stand for.
//
// Units: positions and speeds in scripts are hundredths of a world unit,
// angles hundredths of a degree, times milliseconds.
import { SCRIPT_SCALE } from "./animation.js";
/** @import { Engine } from "../engine.js" */

const DEG = 180 / Math.PI;
const ftol = (/** @type {number} */ x) => Math.trunc(x) | 0;
const FLYING = new Set([181, 182]); // property 0 (class): moves along `at`

// Object properties the speed code reads (obj + 0xEC + 16·slot + 4n).
const P = { CLASS: 0, TARGET_SPEED: 12, MIN_SPEED: 33, SPEED: 34, MAX_SPEED: 35, DRAIN: 95 };

const sub = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (/** @type {number[]} */ a) => Math.hypot(a[0], a[1], a[2]);
// RwNormalizeVector leaves a zero vector alone.
const norm = (/** @type {number[]} */ a) => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : a.slice();
};
const clamp1 = (/** @type {number} */ x) => Math.max(-1, Math.min(1, x));
const acosDeg = (/** @type {number} */ c) => Math.acos(clamp1(c)) * DEG;

// The motion fields of an object, created on first use.
/**
 * @param {any} o
 */
export function motionOf(o) {
  if (!o.motion) {
    o.motion = {
      xz: false, // +0x54 bit 0x10: velocity is kept in the ground plane
      maxAccel: 0, // +0xC0, world units/s²
      maxAngAccel: { pitch: 0, yaw: 0, roll: 0 }, // +0xC4, +0xC8, +0xCC, degrees/s²
      maxAngVel: { pitch: 0, yaw: 0, roll: 0 }, // +0xD0, +0xD4, +0xD8, degrees/s
      targetYaw: 0, // +0x74: degrees still to turn; the spin step works it off
      targetCos: 0, // +0x78: cos of the angle to the target when it was set
      twistRate: 0, // +0x6C, degrees/s
      twistLeft: 0, // +0x70: degrees of twist still to go
    };
  }
  return o.motion;
}

// FUN_1001c460: an acceleration-limited step towards an angle. `rate` is
// {v} (degrees/s, updated); `brake` allows slowing down so as to stop on
// the angle. Returns the angle to turn this step.
/**
 * @param {number} angle
 * @param {number | boolean} brake
 * @param {number} accel
 * @param {any} rate
 * @param {number} dt
 * @param {number} maxVel
 */
export function approachAngle(angle, brake, accel, rate, dt, maxVel) {
  let next = 0; // the rate after one more step of acceleration
  if (rate.v > 0) next = dt * accel + rate.v;
  else if (rate.v < 0) next = rate.v - dt * accel;
  const a2 = accel * 2;
  const stopPos = (next * next + dt * next * a2) / (accel * 4);
  const stopNeg = -((next * next - a2 * dt * next) / (accel * 4));
  const overshoot = brake && ((angle > 0 && next > 0 && stopPos > angle) || (angle < 0 && next < 0 && angle > stopNeg));
  if (overshoot) {
    if (rate.v >= 0) rate.v = Math.max(0, rate.v - dt * a2);
    else rate.v = Math.min(0, dt * a2 + rate.v);
    return rate.v * dt;
  }
  if (rate.v === 0) {
    // Starting from rest: a single small step, or a nudge into motion.
    const s = dt * dt * accel;
    if (angle > s * 2) {
      rate.v = dt * accel;
      return s;
    }
    if (angle < -s * 2) {
      rate.v = -(accel * dt);
      return -s;
    }
    if (angle <= s && angle < -s) return -s;
    return angle <= s ? 0 : s;
  }
  if (rate.v > 0) {
    if (angle <= 0) rate.v = Math.max(-maxVel, rate.v - dt * a2);
    else rate.v = Math.min(maxVel, dt * accel + rate.v);
  } else if (angle >= 0) rate.v = Math.min(maxVel, dt * a2 + rate.v);
  else rate.v = Math.max(-maxVel, rate.v - dt * accel);
  return rate.v * dt;
}

// FUN_1001a290 (UpdateOrient; also the spin half of UpdatePosOrient and
// UpdateTimeStep): work the pending yaw target off with the yaw rate, then
// turn by all three rates.
/**
 * @param {any} o
 * @param {number} dt
 */
export function spinStep(o, dt) {
  const m = motionOf(o);
  if (m.targetYaw !== 0) {
    const rate = { v: o.spin.yaw };
    const step = approachAngle(m.targetYaw, m.targetCos > 0, m.maxAngAccel.yaw, rate, dt, m.maxAngVel.yaw);
    o.spin.yaw = rate.v;
    m.targetYaw -= step;
    const passed = !((step < 0 || m.targetYaw > 0) && (step > 0 || m.targetYaw < 0));
    if (passed || (Math.abs(m.targetYaw) < 0.5 && Math.abs(step) <= 0.1)) {
      m.targetYaw = 0;
      o.spin.yaw = 0;
    }
  }
  // FUN_100050d0(obj, roll·dt, pitch·dt, yaw·dt)
  o.turn(o.spin.yaw * dt, o.spin.pitch * dt, o.spin.roll * dt);
}

// FUN_1001c7df: aim the yaw at direction d (only x and z count). Sets the
// target (degrees, + turns towards `right`) for the spin step; returns 0.
/**
 * @param {any} o
 * @param {number[]} d
 */
export function yawToward(o, d) {
  const m = motionOf(o);
  const at = o.basis.at;
  const ld = Math.hypot(d[0], d[2]);
  const la = Math.hypot(at[0], at[2]);
  if (!ld || !la) return 0;
  const c = clamp1((d[0] / ld) * (at[0] / la) + (at[2] / la) * (d[2] / ld));
  const right = o.basis.right;
  const a = acosDeg(c);
  m.targetYaw = right[0] * d[0] + right[2] * d[2] <= 0 ? -a : a;
  m.targetCos = c;
  return 0;
}

// FUN_1001c926: pitch towards direction d by one step of dt seconds, when d
// is ahead (at·d ≥ 0 in x/z); otherwise stop pitching. The angle is between
// the two elevations. Returns the step in degrees.
/**
 * @param {any} o
 * @param {number[]} d
 * @param {number} dt
 */
export function pitchToward(o, d, dt) {
  const m = motionOf(o);
  const at = o.basis.at;
  if (at[0] * d[0] + at[2] * d[2] < 0) {
    o.spin.pitch = 0;
    return 0;
  }
  const ld = len(d), la = len(at);
  const hd = Math.hypot(d[0], d[2]), ha = Math.hypot(at[0], at[2]);
  const c = clamp1((at[1] / la) * (d[1] / ld) + (ha / la) * (hd / ld));
  const up = o.basis.up;
  const a = dot(up, d) <= 0 ? -acosDeg(c) : acosDeg(c);
  // The pitch rate runs the other way round (a positive pitch looks down).
  const rate = { v: -o.spin.pitch };
  const step = approachAngle(a, c > 0, m.maxAngAccel.pitch, rate, dt, m.maxAngVel.pitch);
  o.spin.pitch = -rate.v;
  return step;
}

// mode 1 = pitch (one step now), 2 = yaw (sets the spin step's target)
const steer = (/** @type {any} */ o, /** @type {number[]} */ d, /** @type {number} */ mode, /** @type {number} */ dt) => (mode === 2 ? yawToward(o, d) : mode === 1 ? pitchToward(o, d, dt) : 0);

// FUN_1001a6c5 / FUN_1001a702: velocity along `at`, or along `at` flattened
// to the ground plane.
/**
 * @param {any} o
 * @param {number} s
 */
function setVelForward(o, s) {
  o.vel = o.basis.at.map((/** @type {number} */ v) => v * s);
}
/**
 * @param {any} o
 * @param {number} s
 */
function setVelXZ(o, s) {
  const d = norm([o.basis.at[0], 0, o.basis.at[2]]);
  o.vel = d.map((/** @type {number} */ v) => v * s);
}

// FUN_1001d51a: the direction to fly at speed s to meet a target moving at
// vel, found by bisection on t in [0, tMax] of |target + vel·t - pos| - s·t.
// (0, 0, 1) when there is no meeting point in that time.
/**
 * @param {any} pos
 * @param {number} s
 * @param {any} target
 * @param {any} vel
 */
export function leadDirection(pos, s, target, vel, tMax = 10) {
  const rel = sub(pos, target);
  const f = (/** @type {number} */ t) => len(sub(vel.map((/** @type {number} */ v) => v * t), rel)) - s * t;
  let lo = 0, hi = tMax;
  if (!(f(lo) > 0) || f(hi) > 0) return [0, 0, 1];
  while (hi - lo > 0.01) {
    const mid = (hi + lo) / 2;
    if (f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  const t = (hi + lo) / 2;
  return norm(sub(vel.map((/** @type {number} */ v) => v * t), rel));
}

/**
 * @param {Engine} engine
 * @returns {Externs}
 */
export function motionExterns(engine) {
  // The battlefield's UpdatePosOrient / UpdateTimeStep use this for their spin.
  engine.spinStep = spinStep;
  const obj = (/** @type {number} */ id) => engine.world?.get?.(id) || null;
  const prop = (/** @type {number} */ id, /** @type {number} */ n) => engine.render3d?.objects?.getProperty(id, n) ?? 0;
  const setProp = (/** @type {number} */ id, /** @type {number} */ n, /** @type {any} */ v) => engine.render3d?.objects?.setProperty(id, n, v);
  const syncRate = (/** @type {number} */ id) => engine.animation?.syncRate?.(id);
  const dirty = (/** @type {any} */ o) => (o.moved = true); // +0x54 |= 8
  const S = SCRIPT_SCALE;

  // DotProduct / DotProduct2D: the object's direction (`at`) against the
  // direction to the target, ×10000. Clump numbers pick a part of the model
  // when the renderer can say where it is (render3d.clumpWorld); otherwise
  // the object itself is used.
  const clumpWorld = (/** @type {number} */ id, /** @type {any} */ k) => (k ? engine.render3d?.clumpWorld?.(id, k) : null);
  const dotProduct = (/** @type {boolean} */ flat) => (/** @type {number} */ id, /** @type {any} */ clump, /** @type {any} */ target, /** @type {any} */ tclump) => {
    const o = obj(id), t = obj(target);
    if (!o || !t) return 0;
    const tp = clumpWorld(target, tclump)?.pos || t.pos;
    let d = sub(tp, o.pos);
    let at = clumpWorld(id, clump)?.at || o.basis.at;
    if (flat) {
      d = [d[0], 0, d[2]];
      at = [at[0], 0, at[2]];
    }
    return ftol(dot(norm(at), norm(d)) * 10000);
  };

  // FUN_1001cb46 / FUN_1001cc90: steer towards / away from the target.
  const towards = (/** @type {any} */ o, /** @type {any} */ t, /** @type {any} */ mode, /** @type {number} */ dt, height = 0) => {
    const d = [t.pos[0] - o.pos[0], t.pos[1] + height / 2 - o.pos[1], t.pos[2] - o.pos[2]];
    return Math.abs(d[0]) + Math.abs(d[2]) > 0.0001 ? steer(o, d, mode, dt) : 0;
  };
  const away = (/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ mode, /** @type {number} */ dt) => {
    const d = sub(o.pos, t.pos);
    if (!(Math.abs(d[0]) + Math.abs(d[2]) > 0.0001)) return 0;
    return mode === 2 ? yawToward(o, d) : pitchToward(o, d, dt);
  };
  // FUN_1001d001 (follow: keep `r` off the target's side) and FUN_1001d241
  // (circle around it at radius r): blend the direction to the target with
  // the perpendicular one; inside the radius, head out instead.
  const blend = (/** @type {number[]} */ d, /** @type {number[]} */ perp, /** @type {number} */ r, /** @type {number} */ dist) => {
    let k = r / dist;
    if (r > dist) {
      k = dist / r;
      d = [-d[0], 0, -d[2]];
    }
    return [d[0] * (1 - k) + perp[0] * k, 0, d[2] * (1 - k) + perp[2] * k];
  };
  const follow = (/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ r) => {
    let d = [t.pos[0] - o.pos[0], 0, t.pos[2] - o.pos[2]];
    const dist = Math.abs(d[0]) + Math.abs(d[2]);
    if (!(dist > 0.0001)) return 0;
    const side = d[0] * t.basis.right[0] + d[2] * t.basis.right[2];
    if (d[0] * t.basis.at[0] + d[2] * t.basis.at[2] > 0) r *= side;
    const perp = side >= 0 ? [d[2], 0, -d[0]] : [-d[2], 0, d[0]];
    return yawToward(o, blend(d, perp, r, dist));
  };
  const circle = (/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ r) => {
    let d = [t.pos[0] - o.pos[0], 0, t.pos[2] - o.pos[2]];
    const dist = Math.abs(d[0]) + Math.abs(d[2]);
    if (!(dist > 0.0001)) return 0;
    const side = d[0] * o.basis.right[0] + d[2] * o.basis.right[2];
    const perp = side <= 0 ? [d[2], 0, -d[0]] : [-d[2], 0, d[0]];
    return yawToward(o, blend(d, perp, r, dist));
  };

  // A basis looking along d with the world up (PointAt, PointAtXZ). The
  // original leaves `right` and `up` unnormalised when d is tilted, which
  // squashes the model; they are normalised here.
  const lookAlong = (/** @type {any} */ o, /** @type {number[]} */ d) => {
    const at = norm(d);
    const right = norm([at[2], 0, -at[0]]);
    const up = norm(cross(at, right));
    o.basis = { right, up, at };
    dirty(o);
  };

  const withObj = (/** @type {any} */ fn, dflt = 0) => (/** @type {number} */ id, /** @type {any} */ ...a) => {
    const o = obj(id);
    return o ? fn(o, ...a) : dflt;
  };
  const withTwo = (/** @type {any} */ fn) => (/** @type {number} */ id, /** @type {any} */ target, /** @type {any} */ ...a) => {
    const o = obj(id), t = obj(target);
    return o && t ? fn(o, t, ...a) : 0;
  };

  return {
    // --- speed ----------------------------------------------------------
    SetVelocityForward: withObj((/** @type {any} */ o, /** @type {number} */ v) => {
      motionOf(o).xz = false;
      o.speed = v / S;
      setVelForward(o, o.speed);
      syncRate(o.id);
      return 1;
    }),
    SetVelocityXZ: withObj((/** @type {any} */ o, /** @type {number} */ v) => {
      motionOf(o).xz = true;
      o.speed = v / S;
      setVelXZ(o, o.speed);
      return 1;
    }),
    GetVelocityForward: withObj((/** @type {any} */ o) => ftol(o.speed * S)),
    SetMaxAccel: withObj((/** @type {any} */ o, /** @type {number} */ v) => ((motionOf(o).maxAccel = v / S), 1)),
    // SetMaxAngularAccel(obj, roll, pitch, yaw) / SetMaxAngularVelocity
    SetMaxAngularAccel: withObj((/** @type {any} */ o, /** @type {number} */ roll, /** @type {number} */ pitch, /** @type {number} */ yaw) => {
      motionOf(o).maxAngAccel = { pitch: pitch / 100, yaw: yaw / 100, roll: roll / 100 };
      return 1;
    }),
    SetMaxAngularVelocity: withObj((/** @type {any} */ o, /** @type {number} */ roll, /** @type {number} */ pitch, /** @type {number} */ yaw) => {
      motionOf(o).maxAngVel = { pitch: pitch / 100, yaw: yaw / 100, roll: roll / 100 };
      return 1;
    }),
    // SetObjectMotion(obj, stride): world units per animation frame ×1000
    SetObjectMotion(id, v) {
      const s = engine.animation?.state?.get(id);
      if (s) s.stride = v / 1000;
      return 1;
    },

    // ApproachTargetSpeed(obj, ms) 0x1000ba71: accelerate towards property
    // 12 (target speed), never slower than property 33 while animated and
    // moving; property 34 gets the new speed. Returns minus a "drain" cost:
    // property 95 × |target| × 7 (5 once there) / (property 35 × 10).
    ApproachTargetSpeed: withObj((/** @type {any} */ o, /** @type {number} */ ms) => {
      const id = o.id;
      const m = motionOf(o);
      const cur = o.speed;
      const step = (m.maxAccel * ms) / 1000;
      let target = prop(id, P.TARGET_SPEED);
      const min = prop(id, P.MIN_SPEED);
      const animated = (engine.animation?.state?.get(id)?.slots.length || 0) > 0;
      if (Math.abs(target) < min && animated && cur !== 0) target = target < 0 || (target === 0 && cur < 0) ? -min : min;
      let v = target / S;
      const maxSpeed = prop(id, P.MAX_SPEED);
      const drain = (/** @type {number} */ k) => (maxSpeed ? Math.trunc((prop(id, P.DRAIN) * Math.abs(target) * k) / (maxSpeed * 10)) : 0);
      if (Math.abs(v - cur) >= 0.0001) {
        let shown = target;
        if (v <= cur) {
          if (step <= cur - v) shown = ftol((v = cur - step) * S);
        } else if (step <= v - cur) shown = ftol((v = cur + step) * S);
        setProp(id, P.SPEED, shown);
        if (FLYING.has(prop(id, P.CLASS))) {
          setVelForward(o, v);
          m.xz = false;
        } else {
          setVelXZ(o, v);
          o.pos[1] = 0;
          o.last[1] = 0;
          m.xz = true;
        }
        o.speed = v;
        syncRate(id);
        return -drain(7);
      }
      setProp(id, P.SPEED, target);
      setVelForward(o, v);
      o.speed = v;
      m.xz = false;
      syncRate(id);
      return -drain(5);
    }),

    // --- steering -------------------------------------------------------
    // MoveToPursue(obj, target, mode, heightProp, ms): head for the target;
    // with SetGroundFlag on, aim half the target's height property above it.
    MoveToPursue: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {any} */ mode, /** @type {any} */ heightProp, /** @type {number} */ ms) => {
      const h = engine.world?.groundFlag ? prop(t.id, heightProp) / 1000 : 0;
      dirty(o);
      return ftol(towards(o, t, mode, ms / 1000, h) * 100);
    }),
    MoveToEvade: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {any} */ mode, /** @type {number} */ ms) => (dirty(o), ftol(away(o, t, mode, ms / 1000) * 100))),
    // MoveToFollow / MoveInCircle(obj, target, radius, mode): yaw only.
    MoveToFollow: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ r, /** @type {number} */ mode) => (dirty(o), mode === 2 ? ftol(follow(o, t, r / S) * 100) : 0)),
    MoveInCircle: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ r, /** @type {number} */ mode) => (dirty(o), mode === 2 ? ftol(circle(o, t, r / S) * 100) : 0)),
    // MoveToParallel(obj, target, mode, ms): turn to fly the target's way.
    MoveToParallel: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {number} */ mode, /** @type {number} */ ms) => {
      const d = t.basis.at.slice();
      let r = 0;
      if (mode === 1) {
        d[0] = 0;
        r = pitchToward(o, d, ms / 1000);
      } else if (mode === 2) {
        d[1] = 0;
        r = yawToward(o, d);
      }
      dirty(o);
      return ftol(r * 100);
    }),
    // MoveToTrueLead(obj, speed, target, mode, ms): steer for the point
    // where the object, at `speed`, meets the moving target.
    MoveToTrueLead(id, speed, target, mode, ms) {
      const o = obj(id), t = obj(target);
      if (!o || !t) return 0;
      const d = leadDirection(o.pos, speed / 100, t.pos, t.vel);
      dirty(o);
      return ftol(steer(o, d, mode, ms / 1000) * 100);
    },
    MoveToFlock: () => 0, // empty in RENDER.R32
    ObjectDeviate: () => 0, // empty in RENDER.R32

    // SetTargetAxis(obj, dir, axis, ms): ramp the pitch (axis 1) or yaw
    // (axis 2) rate towards dir × the maximum, braking 4× as hard; dir 0
    // brakes to a stop. Does nothing while a yaw target is pending.
    SetTargetAxis: withObj((/** @type {any} */ o, /** @type {number} */ dir, /** @type {number} */ axis, /** @type {number} */ ms) => {
      const m = motionOf(o);
      if (m.targetYaw !== 0 && dir === 0) return 0;
      const key = axis === 1 ? "pitch" : axis === 2 ? "yaw" : null;
      if (!key) return 0;
      o.spin[key] = rampRate(o.spin[key], dir, m.maxAngAccel[key], m.maxAngVel[key], ms);
      return 0;
    }),
    // SetTargetAxisAngle(obj, angle, axis): only the yaw (axis 2) has one.
    SetTargetAxisAngle: withObj((/** @type {any} */ o, /** @type {number} */ a, /** @type {number} */ axis) => {
      if (axis === 2) motionOf(o).targetYaw = a / 100;
      return 0;
    }),
    // SetTargetTwist(obj, dir, ms): the same ramp for the twist rate, while
    // no twist angle is pending. Returns this step's twist ×100.
    SetTargetTwist: withObj((/** @type {any} */ o, /** @type {number} */ dir, /** @type {number} */ ms) => {
      const m = motionOf(o);
      if (m.twistLeft !== 0 || (m.twistRate === 0 && dir === 0)) return 0;
      m.twistRate = rampRate(m.twistRate, dir, m.maxAngAccel.yaw, m.maxAngVel.yaw, ms);
      return ftol(m.twistRate * (ms / 1000) * 100);
    }),
    // SetTargetTwistAngle(obj, angle, prop): twist still to go = angle −
    // property `prop` (the current twist). Returns it ×100.
    SetTargetTwistAngle: withObj((/** @type {any} */ o, /** @type {number} */ a, /** @type {any} */ p) => {
      const m = motionOf(o);
      m.twistLeft = a / 100 - prop(o.id, p) / 100;
      return ftol(m.twistLeft * 100);
    }),
    // StepTwist(obj, ms, twistProp, limitProp): one step of the pending
    // twist, kept within ±limit (unless the limit is 180° or more). Returns
    // the step ×100 for the script to add to its twist property.
    StepTwist: withObj((/** @type {any} */ o, /** @type {number} */ ms, /** @type {any} */ pTwist, /** @type {any} */ pLimit) => {
      const m = motionOf(o);
      if (m.twistLeft === 0) return 0;
      const cur = prop(o.id, pTwist) / 100;
      const lim = prop(o.id, pLimit) / 100;
      const rate = { v: m.twistRate };
      let step = approachAngle(m.twistLeft, 1, m.maxAngAccel.yaw, rate, ms / 1000, m.maxAngVel.yaw);
      m.twistRate = rate.v;
      if (lim < 180) {
        if (cur > 0 && cur + step > lim) {
          step = lim - cur;
          m.twistRate = 0;
        } else if (cur < 0 && -cur - step > lim) {
          step = -(lim + cur);
          m.twistRate = 0;
        }
      }
      m.twistLeft -= step;
      const settled =
        step === 0 && m.twistRate === 0
          ? Math.abs(m.twistLeft) < 10
          : Math.abs(m.twistLeft) < 1 && Math.abs(step) <= 0.5;
      if (settled) {
        m.twistRate = 0;
        m.twistLeft = 0;
      }
      return ftol(step * 100);
    }),

    // --- orientation and position ---------------------------------------
    PointAt: withTwo((/** @type {any} */ o, /** @type {any} */ t, /** @type {any} */ heightProp) => {
      const d = sub(t.pos, o.pos);
      if (engine.world?.groundFlag) d[1] += prop(t.id, heightProp) / 2000;
      lookAlong(o, d);
      return 1;
    }),
    PointAtXZ: withTwo((/** @type {any} */ o, /** @type {any} */ t) => {
      lookAlong(o, [t.pos[0] - o.pos[0], 0, t.pos[2] - o.pos[2]]);
      return 1;
    }),
    // SetObjectDirection(obj, x, y, z): at = (x, y, z) / 100 as given (not
    // normalised); right = up × at with the world up, up = at × right.
    SetObjectDirection: withObj((/** @type {any} */ o, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
      const at = [x / S, y / S, z / S];
      const right = cross([0, 1, 0], at);
      const up = cross(at, right);
      o.basis = { right, up, at };
      dirty(o);
      return 1;
    }),
    ObjectDistance: withTwo((/** @type {any} */ o, /** @type {any} */ t) => ftol(len(sub(t.pos, o.pos)) * S)),
    // ObjectMoveForwardUp(obj, forward, up): step along `at`, then up.
    ObjectMoveForwardUp: withObj((/** @type {any} */ o, /** @type {number} */ fwd, /** @type {number} */ up) => {
      const at = norm(o.basis.at);
      const p = [o.pos[0] + at[0] * (fwd / 100), o.pos[1] + at[1] * (fwd / 100) + up / 100, o.pos[2] + at[2] * (fwd / 100)];
      if (o.setPosition) o.setPosition(p);
      else {
        o.pos = p;
        o.last = p.slice();
      }
      return 1;
    }),
    UpdateOrient: withObj((/** @type {any} */ o, /** @type {number} */ ms) => {
      dirty(o);
      spinStep(o, ms / 1000);
      return 1;
    }),
    UpdatePos: withObj((/** @type {any} */ o, /** @type {number} */ ms) => {
      if (o.speed !== 0) dirty(o);
      o.move(ms / 1000);
      return 1;
    }),
    DotProduct: dotProduct(false),
    DotProduct2D: dotProduct(true),
    // SphericalToRectangular(r, a, b, which): r·sinb·cosa (0), r·cosb (1),
    // r·sinb·sina (2). Angles are tenths of a degree.
    SphericalToRectangular(r, a, b, which) {
      const ra = a / 572.9578, rb = b / 572.9578;
      r /= 100;
      const v = which === 0 ? Math.sin(rb) * Math.cos(ra) : which === 1 ? Math.cos(rb) : Math.sin(rb) * Math.sin(ra);
      return ftol(v * r * 100);
    },
    // Srand(seed): seeds the C library's rand and RTLIB32's random numbers.
    // The browser's Random builtin uses Math.random, so there is nothing
    // to seed.
    Srand() {
      return 1;
    },
  };
}

// SetTargetAxis / SetTargetTwist (0x10016dd9, 0x1001714a): ramp a rate
// towards dir × maxVel by accel per second (×4 when braking, a 1/100 nudge
// from rest); dir 0 brakes towards 0.
/**
 * @param {number} rate
 * @param {number} dir
 * @param {number} accel
 * @param {number} maxVel
 * @param {number} ms
 */
export function rampRate(rate, dir, accel, maxVel, ms) {
  const dt = ms / 1000;
  const brake = accel * 4;
  if (dir < 0) {
    const step = rate > 0 ? dt * brake : rate === 0 ? accel * 0.01 : dt * accel;
    return Math.max(dir * maxVel, rate - step);
  }
  if (dir > 0) {
    const step = rate < 0 ? dt * brake : rate === 0 ? accel * 0.01 : dt * accel;
    return Math.min(dir * maxVel, rate + step);
  }
  const step = dt * brake;
  return rate >= 0 ? Math.max(0, rate - step) : Math.min(0, rate + step);
}
