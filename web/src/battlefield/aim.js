// RENDER.R32's turret aiming and attachment externs: RotateSubClump,
// MoveSubClumpToFace and OrientModels. The enemy AI (scripts 2012, 2013,
// 2077) uses them to swing turrets and guns onto a target and to decide
// when it is lined up well enough to fire; the end-of-mission fly-by
// (script 2243) and ejecting pilots use OrientModels.
//
// Script units: positions / 100 = world units, angles in hundredths of a
// degree, times in milliseconds. A "clump" argument is a clump tag (model
// op 0x2D), the index into the clump list at model +0x10.
import { UNIT } from "./world.js";
import { add, sub, scale, dot, cross, normalize } from "./math.js";
import { motionOf, approachAngle } from "../anim/motion.js";
import { mul, rotX, rotY, rotZ } from "../render3d/math.js";
/** @import { Engine } from "../engine.js" */

const DEG = 180 / Math.PI;
const clamp1 = (/** @type {number} */ x) => Math.max(-1, Math.min(1, x));
const ftol = Math.trunc; // __ftol truncates

/**
 * @param {Engine} engine
 * @returns {Externs}
 */
export function aimExterns(engine) {
  const world = () => engine.world;
  const obj = (/** @type {number} */ id) => engine.world?.get(id) || null;
  const props = () => engine.render3d?.objects;
  const getProp = (/** @type {number} */ id, /** @type {number} */ p) => props()?.getProperty(id, p) ?? 0;
  const setProp = (/** @type {number} */ id, /** @type {number} */ p, /** @type {number} */ v) => props()?.setProperty(id, p, v);
  // The ModelInstance and model.clumps index of clump tag k, or null.
  const clumpOf = (/** @type {number} */ id, /** @type {number} */ k) => {
    const inst = engine.render3d?.objectModel?.(id);
    const ci = inst ? inst.clump(k) : -1;
    return ci >= 0 ? { inst, ci } : null;
  };
  // RwGetClumpLTM: position and axes of a clump in the world.
  const ltm = (/** @type {number} */ id, /** @type {number} */ k) => world()?.pose(id, k, 1) ?? null;

  return {
    // RotateSubClump(id, clump, z, x, y) 0x10016374 -> FUN_10005580: set the
    // clump's joint matrix to a rotation about Z, then X, then Y (each
    // about the fixed parent axes), keeping the joint's translation. The
    // joint applies before the clump's own (modelling or FRME) matrix, so
    // the part turns about its own origin: a turret's yaw and its gun's
    // pitch.
    RotateSubClump(id, k, z, x, y) {
      const c = clumpOf(id, k);
      if (!c) return 0;
      const joints = (c.inst.joints ??= []);
      const old = joints[c.ci];
      const m = mul(mul(rotZ(z / 100), rotX(x / 100)), rotY(y / 100));
      if (old) m.set(old.subarray(12, 15), 12);
      joints[c.ci] = m;
      const o = obj(id);
      if (o) o.moved = true; // +0x54 |= 8
      return 0;
    },

    // MoveSubClumpToFace(id, clump, target, targetClump, mode, ms,
    //   heightProp, cosProp, rateProp) 0x100137d7.
    // Turns a part towards a target by one acceleration-limited step:
    //   mode 2: yaw, measured in the ground plane. The step comes back with
    //           the sign of the object's right vector.
    //   mode 1: pitch, the difference between the two elevations; the step
    //           comes back negated. A target behind (at . d < 0 in x/z)
    //           writes -10000 to cosProp, zeroes the rate and returns 0.
    // The aim point is the target's position raised by
    // prop[heightProp] / 2000 world units, or the origin of targetClump.
    // The part's axes are the clump's (its LTM), or the object's when clump
    // is 0. cos(angle) x 10000 goes to prop[cosProp]; the turn rate
    // (degrees/s) lives in prop[rateProp] x 100, or in the object's twist
    // rate (+0x6c) when rateProp is 0. Returns the step in hundredths.
    MoveSubClumpToFace(id, k, target, tk, mode, ms, heightProp, cosProp, rateProp) {
      const o = obj(id), t = obj(target);
      if (!o || !t) return 0;
      const m = motionOf(o);
      const rate = { v: rateProp ? getProp(id, rateProp) / 100 : m.twistRate };
      const dt = ms / 1000;
      let aim;
      if (!tk) aim = [t.pos[0], t.pos[1] + getProp(target, heightProp) / 2000, t.pos[2]];
      else aim = ltm(target, tk)?.pos ?? t.pos;
      let origin = o.pos;
      let d = sub(aim, origin);
      let at, side, accel, maxVel;
      const pitch = mode !== 2;
      if (pitch) {
        accel = m.maxAngAccel.pitch;
        maxVel = m.maxAngVel.pitch;
      } else {
        accel = m.maxAngAccel.yaw;
        maxVel = m.maxAngVel.yaw;
      }
      const p = k ? ltm(id, k) : null;
      if (p) {
        at = p.basis.at;
        side = pitch ? p.basis.up : p.basis.right;
        if (pitch) {
          origin = p.pos;
          d = normalize(sub(aim, origin));
        }
      } else {
        at = o.basis.at;
        side = pitch ? o.basis.up : o.basis.right;
      }
      let a, b; // the two 2D directions whose angle is measured
      if (pitch) {
        if (at[0] * d[0] + at[2] * d[2] < 0) {
          setProp(id, cosProp, -10000);
          if (rateProp) setProp(id, rateProp, 0);
          else m.twistRate = 0;
          return 0;
        }
        a = [d[1], Math.hypot(d[0], d[2])];
        b = [at[1], Math.hypot(at[0], at[2])];
      } else {
        a = [d[0], d[2]];
        b = [at[0], at[2]];
      }
      const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
      const c = la && lb ? clamp1((a[0] / la) * (b[0] / lb) + (a[1] / la) * (b[1] / lb)) : 1;
      const s = pitch ? dot(side, d) : side[0] * d[0] + side[2] * d[2];
      const angle = (s <= 0 ? -1 : 1) * Math.acos(c) * DEG;
      setProp(id, cosProp, ftol(c * 10000));
      let step = approachAngle(angle, c > 0, accel, rate, dt, maxVel);
      if (pitch) {
        if (c <= 0) {
          step = 0;
          rate.v = 0;
        } else step = -step;
      }
      if (rateProp) setProp(id, rateProp, ftol(rate.v * 100));
      else m.twistRate = rate.v;
      return ftol(step * 100);
    },

    // OrientModels(src, dst, clump, dx, dy, dz, upright) 0x10007ccd: give
    // dst src's axes (or those of src's clump) and put it at src's
    // position (or the clump's origin) plus the offset. The offset is in
    // that frame, except for a dst without a model placed on src itself,
    // where it is added in world axes. upright != 0 makes the axes level:
    // up = +Y, right = up x at, at = right x up.
    OrientModels(src, dst, k, dx, dy, dz, upright) {
      const s = obj(src), d = obj(dst);
      if (!s || !d) return 0;
      const off = [dx / UNIT, dy / UNIT, dz / UNIT];
      const p = k ? ltm(src, k) : null;
      let basis = p ? { ...p.basis } : { right: s.basis.right.slice(), up: s.basis.up.slice(), at: s.basis.at.slice() };
      basis = { right: normalize(basis.right), up: normalize(basis.up), at: normalize(basis.at) };
      if (upright) {
        const up = [0, 1, 0];
        const right = normalize(cross(up, basis.at));
        basis = { right, up, at: normalize(cross(right, up)) };
      }
      const origin = p ? p.pos : s.pos;
      const local = p || engine.render3d?.objectModel?.(dst);
      const shift = local ? add(add(scale(basis.right, off[0]), scale(basis.up, off[1])), scale(basis.at, off[2])) : off;
      d.basis = basis;
      d.setPosition(add(origin, shift));
      if (world()?.groundFlag && s.ground !== undefined) d.ground = s.ground; // +0x84
      return 0;
    },
  };
}
