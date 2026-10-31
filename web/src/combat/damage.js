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

// Give an instance its own model record, so cutting it doesn't change other
// copies of the same model.
function own(inst) {
  if (!inst.ownModel) {
    const m = inst.model;
    inst.model = { ...m, clumps: m.clumps.map((c) => ({ ...c, children: c.children.slice() })), roots: m.roots.slice(), tagged: m.tagged.slice() };
    inst.ownModel = true;
  }
  return inst.model;
}

// Clump i and everything under it, parents first (RwForAllClumpsInHierarchy
// order).
function subtree(model, i) {
  const out = [];
  const visit = (k) => {
    out.push(k);
    for (const c of model.clumps[k].children) visit(c);
  };
  visit(i);
  return out;
}

// RwRemoveChildFromClump plus FUN_100073fe: take clump i (and its children)
// out of the instance's model and forget their tags.
function detach(inst, i) {
  const m = own(inst);
  const c = m.clumps[i];
  if (c.parent >= 0) {
    const p = m.clumps[c.parent];
    m.clumps[c.parent] = { ...p, children: p.children.filter((k) => k !== i) };
  }
  m.roots = m.roots.filter((k) => k !== i);
  const gone = subtree(m, i);
  m.tagged = m.tagged.map((k) => (gone.includes(k) ? undefined : k));
  // The renderers draw every clump of a model, so hide the ones that left.
  for (const k of gone) inst.clumpHidden[k] = true;
}

// A model record for a removed clump: the clump becomes the root, placed by
// the object that carries it (local = identity), its children keep the pose
// they had, and its clumps are numbered 1.. in hierarchy order (the
// original fills the new model's clump table that way). `alone`: the clump
// without its children. The record holds only these clumps (the renderers
// draw every clump of a model).
function pieceModel(inst, i, alone) {
  const m = inst.model;
  const order = alone ? [i] : subtree(m, i);
  const index = new Map(order.map((k, n) => [k, n]));
  const clumps = order.map((k, n) => {
    const c = m.clumps[k];
    return {
      ...c,
      index: n,
      parent: k === i ? -1 : index.get(c.parent),
      local: k === i ? identity() : (inst.pose && inst.pose[k]) || c.local,
      children: alone ? [] : c.children.map((x) => index.get(x)),
    };
  });
  const tagged = [];
  order.forEach((_, n) => (tagged[n + 1] = n));
  return { ...m, clumps, roots: [0], tagged, count: order.length };
}

// The world matrix of every clump of an object's model.
function worldClumps(o, inst) {
  return clumpMatrices(inst.model, modelMatrix(o.basis, o.pos), inst.pose);
}

// RwGetClumpBBox: the box around a clump's own vertices, in world space.
function worldBox(c, m) {
  const p = c.mesh?.positions;
  if (!p || !p.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < p.length; n += 3) {
    const x = p[n], y = p[n + 1], z = p[n + 2];
    for (let j = 0; j < 3; j++) {
      const v = x * m[j] + y * m[4 + j] + z * m[8 + j] + m[12 + j];
      if (v < lo[j]) lo[j] = v;
      if (v > hi[j]) hi[j] = v;
    }
  }
  return { lo, hi };
}

// Slab test: does the segment a -> b touch the box?
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

const rows = (m) => ({ right: [m[0], m[1], m[2]], up: [m[4], m[5], m[6]], at: [m[8], m[9], m[10]] });

export function damageExterns(host) {
  const engine = host.engine;

  // A new object (FUN_100295c6 slot + RtDynamicResource) carrying clump i of
  // `inst`, at that clump's place in the world. Updates every `interval` ms
  // with `script` (behaviour 6), as a copy of `parentId`.
  const spawnPiece = (parentId, inst, i, m, interval, script, alone = false) => {
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
      let tags = subtree(m, i).map((c) => m.clumps[c].tag | 0);
      if (!k) {
        if (tags.length === 1) return 0;
        tags = tags.filter((t) => t);
      }
      const list = host.extern("ListCreate")(tags.length);
      const set = host.extern("ListSetElem");
      tags.forEach((t, n) => set(list, n, t));
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
        inst.model = { ...s, clumps: s.clumps.map((c) => ({ ...c, children: c.children.slice() })), roots: s.roots.slice(), tagged: s.tagged.slice() };
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
        if (box && segmentHitsBox(o.last, o.pos, box)) return tagged ? k + 1 : 0;
      }
      return -1;
    },

    // DefaultClumpHealths(model, clump) 0x100089ca: a part's starting
    // health from the size of its bounding box: max(1, (dx dy dz)^0.3333 x
    // 390), box in the clump's own space.
    DefaultClumpHealths(model, k) {
      const inst = host.r3d?.instance(model);
      if (!inst) return 1;
      const i = k ? inst.clump(k) : inst.model.roots[0];
      const c = i >= 0 ? inst.model.clumps[i] : null;
      const p = c?.mesh?.positions;
      if (!p || !p.length) return 1;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let n = 0; n < p.length; n += 3) {
        for (let j = 0; j < 3; j++) {
          lo[j] = Math.min(lo[j], p[n + j]);
          hi[j] = Math.max(hi[j], p[n + j]);
        }
      }
      const v = Math.pow((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]), 0.3333) * 390;
      return v >= 1 ? Math.trunc(v) : 1;
    },
  };
}
