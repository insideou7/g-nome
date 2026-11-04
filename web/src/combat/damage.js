// Damage to models: blowing a model apart into flying pieces, cutting a
// part off, swapping in a damaged part, and the default health of a part.
// Written from the Ghidra decompile of RENDER.R32 (addresses in the
// comments). Spec: docs/combat.md.
//
// RENDER.R32 does this with RenderWare clump surgery (RwRemoveChildFromClump
// and a new object whose model is the removed clump). Here a model is the
// renderer core's {clumps, roots, tagged, count}; an instance that is
// changed gets its own copy of that record (the meshes stay shared), and a
// piece gets a new model record whose root is the removed clump.
import { identity } from "../render3d/math.js";
import { clumpMatrices } from "../render3d/model.js";
import { ModelInstance } from "../render3d/externs.js";
import { PROPS } from "../render3d/objects.js";
import { modelMatrix, normalize, sub, add, scale } from "../battlefield/math.js";
import { UNIT } from "./host.js";

const PIECE_RADIUS = 0.05; // 0x3d4ccccd

// The C runtime's rand() (MSVC: seed * 214013 + 2531011, bits 16-30), so
// explosions scatter the way the original's do for a given seed. Srand
// seeds the C runtime too, but the motion code keeps that seed to itself, so
// this keeps its own.
let seed = 1;
export function crand() {
  seed = (Math.imul(seed, 214013) + 2531011) | 0;
  return (seed >>> 16) & 0x7fff;
}
/** Reseed crand (srand), so runs in one process start alike. @param {number} s */
export function csrand(s) {
  seed = s | 0;
}

// Give an instance its own model record, so cutting it doesn't change other
// copies of the same model.
/**
 * @param {any} inst
 */
function own(inst) {
  if (!inst.ownModel) {
    const m = inst.model;
    inst.model = { ...m, clumps: m.clumps.map((/** @type {any} */ c) => ({ ...c, children: c.children.slice() })), roots: m.roots.slice(), tagged: m.tagged.slice() };
    inst.ownModel = true;
  }
  return inst.model;
}

// Clump i and everything under it, parents first (RwForAllClumpsInHierarchy
// order).
/**
 * @param {any} model
 * @param {number} i
 */
function subtree(model, i) {
  /** @type {any} */
  const out = [];
  const visit = (/** @type {number} */ k) => {
    out.push(k);
    for (const c of model.clumps[k].children) visit(c);
  };
  visit(i);
  return out;
}

// RwRemoveChildFromClump plus FUN_100073fe: take clump i (and its children)
// out of the instance's model and forget their tags.
/**
 * @param {any} inst
 * @param {number} i
 */
function detach(inst, i) {
  const m = own(inst);
  const c = m.clumps[i];
  if (c.parent >= 0) {
    const p = m.clumps[c.parent];
    m.clumps[c.parent] = { ...p, children: p.children.filter((/** @type {number} */ k) => k !== i) };
  }
  m.roots = m.roots.filter((/** @type {number} */ k) => k !== i);
  const gone = subtree(m, i);
  m.tagged = m.tagged.map((/** @type {any} */ k) => (gone.includes(k) ? undefined : k));
  // The renderers draw every clump of a model, so hide the ones that left.
  for (const k of gone) inst.clumpHidden[k] = true;
}

// A model record for a removed clump: the clump becomes the root, placed by
// the object that carries it (local = identity), its children keep the pose
// they had, and its clumps are numbered 1.. in hierarchy order (the
// original fills the new model's clump table that way). `alone`: the clump
// without its children. The record holds only these clumps (the renderers
// draw every clump of a model).
/**
 * @param {any} inst
 * @param {number} i
 * @param {boolean} alone
 */
function pieceModel(inst, i, alone) {
  const m = inst.model;
  const order = alone ? [i] : subtree(m, i);
  const index = new Map(order.map((/** @type {any} */ k, /** @type {any} */ n) => [k, n]));
  const clumps = order.map((/** @type {number} */ k, /** @type {any} */ n) => {
    const c = m.clumps[k];
    return {
      ...c,
      index: n,
      parent: k === i ? -1 : index.get(c.parent),
      local: k === i ? identity() : (inst.pose && inst.pose[k]) || c.local,
      children: alone ? [] : c.children.map((/** @type {number} */ x) => index.get(x)),
    };
  });
  /** @type {number[]} */
  const tagged = [];
  order.forEach((/** @type {any} */ _, /** @type {number} */ n) => (tagged[n + 1] = n));
  return { ...m, clumps, roots: [0], tagged, count: order.length };
}

// The world matrix of every clump of an object's model.
/**
 * @param {any} o
 * @param {any} inst
 */
function worldClumps(o, inst) {
  return clumpMatrices(inst.model, modelMatrix(o.basis, o.pos), inst.pose);
}

// RwGetClumpBBox (RWL20.DLL 0x10008270 -> 0x10008110): RenderWare keeps a
// clump's own bounding box (children not included) as 8 hidden corner
// vertices in front of its real ones, and returns the min and max of those
// 8 corners moved into world space. A clump without vertices of its own
// (8 or fewer) gets a point box at its origin.
/**
 * @param {any} c
 * @param {number[]} m
 */
function worldBox(c, m) {
  const p = c.mesh?.positions;
  if (!p || !p.length) return { lo: [m[12], m[13], m[14]], hi: [m[12], m[13], m[14]] };
  const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < p.length; n += 3) {
    for (let j = 0; j < 3; j++) {
      if (p[n + j] < a[j]) a[j] = p[n + j];
      if (p[n + j] > b[j]) b[j] = p[n + j];
    }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? b[0] : a[0], y = k & 2 ? b[1] : a[1], z = k & 4 ? b[2] : a[2];
    for (let j = 0; j < 3; j++) {
      const v = x * m[j] + y * m[4 + j] + z * m[8 + j] + m[12 + j];
      if (v < lo[j]) lo[j] = v;
      if (v > hi[j]) hi[j] = v;
    }
  }
  return { lo, hi };
}

// DefaultClumpHealths' formula: max(1, trunc((dx dy dz)^0.3333 x 390)) of
// the clump's box under its local-to-world matrix `m` (RwGetClumpBBox).
/**
 * @param {any} c
 * @param {number[]} m
 */
export function clumpHealth(c, m) {
  const { lo, hi } = worldBox(c, m);
  const v = Math.pow((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]), 0.3333) * 390;
  return v >= 1 ? Math.trunc(v) : 1;
}

// The world boxes of an object's parts, as CollisionClump tests them (its
// tagged clumps, or the root of an untagged model). For aim assist.
/**
 * @param {any} o
 * @param {any} inst
 */
export function partBoxes(o, inst) {
  const m = inst?.model;
  if (!o || !m) return [];
  const ms = worldClumps(o, inst);
  const parts = m.count > 0 ? Array.from({ length: m.count }, (_, k) => m.tagged[k + 1]) : [m.roots[0]];
  const out = [];
  for (const i of parts) {
    const c = i === undefined || i < 0 ? null : m.clumps[i];
    if (c?.mesh?.positions?.length) out.push(worldBox(c, ms[i]));
  }
  return out;
}

// Slab test: does the segment a -> b touch the box?
/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {{ lo: number[], hi: number[] }} box
 */
export function segmentHitsBox(a, b, { lo, hi }) {
  let t0 = 0, t1 = 1;
  for (let j = 0; j < 3; j++) {
    const d = b[j] - a[j];
    if (Math.abs(d) < 1e-9) {
      if (a[j] < lo[j] || a[j] > hi[j]) return false;
      continue;
    }
    let u = (lo[j] - a[j]) / d, v = (hi[j] - a[j]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}

// CollisionClump's own test (0x10010dbc) of a shot's last move, from `a`
// (where it was, +0x24) to `b` (where it is, +0x0c), against a box. Per
// axis the move is either inside the box's range or crosses one of its
// faces. Two axes inside is a hit; otherwise the move's 2D projections
// onto the planes of the crossing axes must meet the box's, using the
// slopes the original works out (10000 for a vertical one). This is a bit
// looser than an exact segment test.
/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {{ lo: number[], hi: number[] }} box
 */
export function shotHitsBox(a, b, { lo, hi }) {
  const [ax, ay, az] = a, [bx, by, bz] = b;
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  let yx, zx, xy, zy, yz, xz;
  if (bx - ax === 0) yx = zx = 10000;
  else {
    yx = (by - ay) / (bx - ax);
    zx = (bz - az) / (bx - ax);
  }
  if (by - ay === 0) zy = xy = 10000;
  else {
    xy = yx === 10000 ? 0 : 1 / yx;
    zy = (bz - az) / (by - ay);
  }
  if (zx === 0) xz = yz = 10000;
  else {
    yz = zy === 10000 ? 0 : 1 / zy;
    xz = zx === 10000 ? 0 : 1 / zx;
  }
  // Per axis: crosses a face (c), or both ends inside the range (i).
  const axis = (/** @type {number} */ s, /** @type {number} */ e, /** @type {number} */ min, /** @type {number} */ max) => {
    const endBelowMax = e < max, minAtStart = min <= s, endBelowMin = e < min, maxAtStart = max <= s;
    const c = (!endBelowMin && !minAtStart) || (!maxAtStart && !endBelowMax) || (maxAtStart && endBelowMax) || (endBelowMin && minAtStart);
    const i = !maxAtStart && !endBelowMin && minAtStart && endBelowMax;
    return [c ? 1 : 0, i ? 1 : 0];
  };
  const [cx, ix] = axis(ax, bx, x0, x1), [cy, iy] = axis(ay, by, y0, y1), [cz, iz] = axis(az, bz, z0, z1);
  const inside = ix + iy + iz;
  if (cx + cy + cz + inside <= 2) return false;
  if (inside > 1) return true;
  const within = (/** @type {number} */ v, /** @type {number} */ min, /** @type {number} */ max) => min <= v && v <= max;
  const xyPlane = () => within((y1 - ay) * xy + ax, x0, x1) || within((y0 - ay) * xy + ax, x0, x1) || within((x1 - ax) * yx + ay, y0, y1) || within((x0 - ax) * yx + ay, y0, y1);
  const yzPlane = () => within((z1 - az) * yz + ay, y0, y1) || within((z0 - az) * yz + ay, y0, y1) || within((y1 - ay) * zy + az, z0, z1) || within((y0 - ay) * zy + az, z0, z1);
  const xzPlane = () => within((x1 - ax) * zx + az, z0, z1) || within((x0 - ax) * zx + az, z0, z1) || within((z1 - az) * xz + ax, x0, x1) || within((z0 - az) * xz + ax, x0, x1);
  if (inside === 1) {
    if (cx && cy) return xyPlane(); // z inside
    if (cy && cz) return yzPlane(); // x inside
    return xzPlane(); // y inside
  }
  return xyPlane() && yzPlane() && xzPlane();
}

const rows = (/** @type {any} */ m) => ({ right: [m[0], m[1], m[2]], up: [m[4], m[5], m[6]], at: [m[8], m[9], m[10]] });

/**
 * @param {any} host
 * @returns {Externs}
 */
export function damageExterns(host) {
  const engine = host.engine;

  // A new object (FUN_100295c6 slot + RtDynamicResource) carrying clump i of
  // `inst`, at that clump's place in the world. Updates every `interval` ms
  // with `script` (behaviour 6), as a copy of `parentId`.
  const spawnPiece = (/** @type {number} */ parentId, /** @type {any} */ inst, /** @type {number} */ i, /** @type {number[]} */ m, /** @type {any} */ interval, /** @type {number} */ script, alone = false) => {
    const r3d = host.r3d, world = host.world;
    const id = engine.copyResource(parentId);
    const modelId = engine.copyResource(inst.id);
    const piece = new ModelInstance(modelId, pieceModel(inst, i, alone));
    piece.textureFrame = inst.textureFrame;
    piece.textureOverride = inst.textureOverride;
    r3d.instances.set(modelId, piece);
    r3d.objects.records.set(id, {
      id, source: engine.dynamic.get(id), tag: 0, flags: 2, state: 0, model: modelId, radius: PIECE_RADIUS,
      entries: [{ kind: 6, a: interval, script }],
      props: new Int32Array(PROPS),
      transform: { pos: [0, 0, 0], prevPos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0 },
    });
    const o = world.add(id, m[12] * UNIT, m[13] * UNIT, m[14] * UNIT);
    o.basis = rows(m);
    o.tickBasis = rows(m);
    o.radius = PIECE_RADIUS;
    detach(inst, i);
    return o;
  };

  return {
    // ExplodeModel(obj, gravity, speed, script) 0x10012142 / FUN_10005b20 /
    // FUN_100056bd: every clump below the root flies off as its own object,
    // with the object's velocity plus up to `speed` / 100 away from the
    // model's root, its spin plus up to +-128 x speed / 100 degrees per
    // second, gravity / 100, and `script` as its update. The object keeps
    // the root clump and stops: no gravity, speed or animation.
    ExplodeModel(id, gravity, speed, script) {
      const o = host.obj(id), inst = host.model(id);
      if (!o || !inst) return 0;
      const sp = speed / UNIT, g = gravity / UNIT;
      const ms = worldClumps(o, inst);
      const root = inst.model.roots[0];
      const rootAt = root !== undefined ? [ms[root][12], ms[root][13], ms[root][14]] : o.pos;
      for (const r of inst.model.roots.slice()) {
        for (const i of subtree(inst.model, r)) {
          if (i === r) continue;
          const m = ms[i];
          // RwForAllClumpsInHierarchy reaches the children after their
          // parent has gone, so every clump flies on its own.
          const p = spawnPiece(id, inst, i, m, o.updateInterval, script, true);
          p.gravity = g;
          const dir = normalize(sub([m[12], m[13], m[14]], rootAt));
          p.vel = add(o.vel, scale(dir, (crand() / 32768) * sp));
          p.spin = {
            roll: ((crand() - 0x4000) * sp) / 128 + o.spin.roll,
            pitch: ((crand() - 0x4000) * sp) / 128 + o.spin.pitch,
            yaw: ((crand() - 0x4000) * sp) / 128 + o.spin.yaw,
          };
        }
      }
      o.gravity = 0;
      o.radius = PIECE_RADIUS;
      o.speed = 0;
      if (o.motion) o.motion.xz = false;
      const a = engine.animation?.state.get(id);
      if (a) {
        a.frmeId = 0;
        a.stride = 0;
      }
      return 0;
    },

    // AmputateClump(obj, model, clump) 0x10007152: cut clump `clump` (with
    // its children) off the model copy `model` into a new, still object;
    // returns its id (scripts then explode and delete it).
    AmputateClump(id, model, k) {
      const o = host.obj(id), inst = host.r3d?.instance(model);
      if (!k || !o || !inst) return id;
      const i = inst.clump(k);
      if (i < 0) return id;
      const m = clumpMatrices(inst.model, modelMatrix(o.basis, o.pos), inst.pose)[i];
      const p = spawnPiece(id, inst, i, m, o.updateInterval, 0);
      return p.id;
    },

    // QueryClumpList(model, clump) 0x1000853e: a new list of the tags of
    // the clump and every clump under it (0 for untagged ones). For clump 0,
    // the tags under the root without the root, or 0 when there are none.
    QueryClumpList(model, k) {
      const inst = host.r3d?.instance(model);
      if (!inst) return 0;
      const m = inst.model;
      const i = k ? inst.clump(k) : m.roots[0];
      if (i === undefined || i < 0) return 0;
      let tags = subtree(m, i).map((/** @type {number} */ c) => m.clumps[c].tag | 0);
      if (!k) {
        if (tags.length === 1) return 0;
        tags = tags.filter((/** @type {any} */ t) => t);
      }
      const list = host.extern("ListCreate")(tags.length);
      const set = host.extern("ListSetElem");
      tags.forEach((/** @type {any} */ t, /** @type {any} */ n) => set(list, n, t));
      return list;
    },

    // ReplaceClump(model, source, clump) 0x10009091: show a damaged part.
    // Clump `clump` of `model` gets the mesh of the same clump of `source`
    // and keeps its own joint transform and children; clump 0 replaces the
    // whole model with a copy of `source`'s, keeping the root's transform.
    ReplaceClump(model, source, k) {
      const inst = host.r3d?.instance(model), src = host.r3d?.instance(source);
      if (!inst || !src) return 0;
      if (!k) {
        const old = inst.model, s = src.model;
        const root = s.roots[0];
        inst.model = { ...s, clumps: s.clumps.map((/** @type {any} */ c) => ({ ...c, children: c.children.slice() })), roots: s.roots.slice(), tagged: s.tagged.slice() };
        if (root !== undefined && old.roots[0] !== undefined) inst.model.clumps[root].local = old.clumps[old.roots[0]].local;
        inst.ownModel = true;
        return 0;
      }
      const i = inst.clump(k), si = src.clump(k);
      if (i < 0 || si < 0) return 0;
      const m = own(inst);
      m.clumps[i] = { ...m.clumps[i], mesh: src.model.clumps[si].mesh };
      return 0;
    },

    // CollisionClump(proj, target) 0x10010dbc: which part of the target the
    // shot's last move (last position -> position) passed through: the
    // number of the first tagged clump whose bounding box the segment
    // crosses, -1 for none. A model without tags is tested as one box and
    // reports 0, which the hit script treats as a miss.
    CollisionClump(id, target) {
      const o = host.obj(id), t = host.obj(target), inst = host.model(target);
      if (!o || !t || !inst) return 0;
      const m = inst.model;
      const ms = worldClumps(t, inst);
      const tagged = m.count > 0;
      const parts = tagged ? Array.from({ length: m.count }, (_, k) => m.tagged[k + 1]) : [m.roots[0]];
      for (let k = 0; k < parts.length; k++) {
        const i = parts[k];
        if (i === undefined || i < 0) continue;
        const box = worldBox(m.clumps[i], ms[i]);
        if (box && shotHitsBox(o.last, o.pos, box)) return tagged ? k + 1 : 0;
      }
      return -1;
    },

    // DefaultClumpHealths(model, clump) 0x100089ca: a part's starting
    // health from the size of its bounding box: max(1, (dx dy dz)^0.3333 x
    // 390). The box comes from RwGetClumpBBox (RWL20.DLL 0x10008270), the
    // same call CollisionClump uses: the clump's own box moved through its
    // local-to-world matrix (the clump at +0, which RwGetClumpLTM also
    // returns), not RwGetClumpLocalBBox. So the scale and turn of every
    // parent clump count, and the turn of the object carrying the model
    // (script 2286 runs after the unit is placed). Walker parts, which sit
    // under scaled-down clumps, get about a fifth of their local-space
    // health this way.
    DefaultClumpHealths(model, k) {
      const inst = host.r3d?.instance(model);
      if (!inst) return 1;
      const i = k ? inst.clump(k) : inst.model.roots[0];
      const c = i >= 0 ? inst.model.clumps[i] : null;
      if (!c?.mesh?.positions?.length) return 1;
      let o = null;
      for (const [id, r] of host.r3d.objects.records) {
        if (r.model === model || r.props?.[39] === model || r.props?.[79] === model) o = host.obj(id);
        if (o) break;
      }
      const ms = clumpMatrices(inst.model, o ? modelMatrix(o.basis, o.pos) : identity(), inst.pose);
      return clumpHealth(c, ms[i]);
    },
  };
}
