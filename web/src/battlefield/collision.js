// RENDER.R32's collision externs: unit-against-unit checks, the hotspot
// tests for buildings and other static objects, deflection, and clump hit
// tests. Addresses are the RENDER.R32 functions each one follows (see the
// "Collisions" section of docs/battlefield.md).
//
// Positions are in RenderWare units (script units / 100). The hotspot table
// itself (AddHotSpot and the accessors) lives in web/src/anim/hotspots.js;
// this file computes footprints and runs the tests.
//
// engine.collision is the API other code (projectiles, AI) can call:
//   hitAt(id, x, y, z, radius)  first object whose sphere meets the point
//   segment(id, from, to)       first object a moving point passes through
//   clumpHit(mover, target)     CollisionClump: tagged clump of `target` hit
//                               by `mover` between its last and current
//                               position, -1 if none
import { UNIT } from "./world.js";
import { clumpMatrices, modelOps } from "../render3d/model.js";
import { identity, transformPoint } from "../render3d/math.js";
import { modelMatrix, sub, dot, normalize, length } from "./math.js";
/** @import { Engine } from "../engine.js" */

const ROUND = 0x10; // hotspot type: a cylinder, radius in the id field
const OUTSIDE = 8; // hotspot type: the object must stay inside the footprint
const GRID = 12; // footprints snap to a 12-unit grid (1200 script units)
const EDGE_ON_GRID = 0x10; // footprint edge flag: the edge lies on a grid line

// Script message type 1 (RtRunMsg): call a script with arguments and use
// its return value. The engine runs it at once, below the caller's frame.
/**
 * @param {Engine} engine
 * @param {any} script
 * @param {any} args
 */
function callValue(engine, script, args) {
  if (!script) return 0;
  try {
    return engine.vm.callValue(script, args);
  } catch (e) {
    engine.log(`script ${script} failed: ${e.message}`);
    return 0;
  }
}

const sign = (/** @type {number} */ x) => (x < 0 ? -1 : 1); // FUN_10018f95
const len2 = (/** @type {number} */ x, /** @type {number} */ z) => x * x + z * z;

// FUN_1001d780: is (x, z) inside the polygon (even-odd rule)?
/**
 * @param {any} pts
 * @param {number} x
 * @param {number} z
 */
export function insidePolygon(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const zi = pts[i][2], zj = pts[j][2];
    if ((zi <= z && z < zj) || (zj <= z && z < zi)) {
      if (x < ((z - zi) * (pts[j][0] - pts[i][0])) / (zj - zi) + pts[i][0]) inside = !inside;
    }
  }
  return inside;
}

// FUN_10018a72: where segment (x1,z1)-(x2,z2) crosses segment (x3,z3)-(x4,z4).
// Returns [x, z], or null. The original adds a 0.01 tolerance at the ends.
/**
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @param {number} x3
 * @param {number} z3
 * @param {number} x4
 * @param {number} z4
 */
export function segmentsCross(x1, z1, x2, z2, x3, z3, x4, z4) {
  const ax = x2 - x1, bx = x3 - x4;
  const [lo1, hi1] = ax < 0 ? [x2, x1] : [x1, x2];
  if (bx >= 0 ? hi1 < x4 || x3 < lo1 : hi1 < x3 || x4 < lo1) return null;
  const az = z2 - z1, bz = z3 - z4;
  const [lo2, hi2] = az < 0 ? [z2, z1] : [z1, z2];
  if (bz >= 0 ? hi2 < z4 || z3 < lo2 : hi2 < z3 || z4 < lo2) return null;
  const num = (x1 - x3) * bz - (z1 - z3) * bx;
  const den = az * bx - bz * ax;
  const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= 0.01;
  if (den >= 0) {
    if (num < 0.01) return null;
    if (!near(num, den) && den < num) return null;
  } else {
    if (num > 0.01) return null;
    if (!near(num, den) && num < den) return null;
  }
  const num2 = (z1 - z3) * ax - (x1 - x3) * az;
  if (den >= 0) {
    if (num2 < 0.01) return null;
    if (!near(num2, den) && num2 > den) return null;
  } else {
    if (num2 > 0.01) return null;
    if (!near(num2, den) && den > num2) return null;
  }
  if (den === 0) return null; // parallel: the original returns 2, never used
  return [(num * ax) / den + x1, (num * az) / den + z1];
}

// The vertex list of a model's root clump, as RwGetClumpVertex returns it
// (the RWX transform in effect when each vertex was declared applied).
/**
 * @param {Uint8Array} bytes
 */
export function rootClumpVertices(bytes) {
  const verts = [];
  let depth = 0;
  let ctm = identity();
  const stack = [];
  for (const [op, a] of modelOps(bytes)) {
    if (op === "clumpbegin") {
      if (++depth === 1) ctm = identity();
      stack.push(ctm);
    } else if (op === "clumpend") {
      ctm = stack.pop() || identity();
      if (--depth === 0) break;
    } else if (depth === 1) {
      if (op === "transform") ctm = Float32Array.from(a);
      else if (op === "vertex" || op === "vertexext") verts.push(transformPoint(ctm, a[0], a[1], a[2], [0, 0, 0]));
    }
  }
  return verts;
}

// AddHotSpot's footprint (0x1002232a): the root clump's vertices, turned
// like `poseObj` when given, moved to the hotspot. Vertices on the 12-unit
// grid push their edges 0.2 outwards so neighbouring footprints overlap;
// an edge along a grid line is flagged and the deflection tests skip it.
/**
 * @param {any} verts
 * @param {number[]} pos
 * @param {any} basis
 */
export function buildFootprint(verts, pos, basis) {
  const pts = verts.map((/** @type {any} */ v) => {
    let [x, y, z] = v;
    if (basis) {
      const m = modelMatrix(basis, [0, 0, 0]);
      [x, y, z] = transformPoint(m, x, y, z, [0, 0, 0]);
    }
    return [x + pos[0], y + pos[1], z + pos[2]];
  });
  const n = pts.length;
  const onGrid = (/** @type {number} */ v) => {
    const g = Math.abs(v / GRID);
    return Math.abs(g - Math.trunc(g)) < 0.04;
  };
  const flags = new Array(n).fill(0);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[j], b = pts[i];
    const ax = onGrid(a[0]), az = onGrid(a[2]), bx = onGrid(b[0]), bz = onGrid(b[2]);
    if ((ax && bx && Math.abs(a[0] - b[0]) < 0.04) || (az && bz && Math.abs(a[2] - b[2]) < 0.04)) {
      flags[i] = EDGE_ON_GRID;
      continue;
    }
    flags[i] = (ax ? 1 : 0) | (bx ? 2 : 0) | (az ? 4 : 0) | (bz ? 8 : 0);
  }
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[j], b = pts[i], f = flags[i];
    const [ax, , az] = a, [bx, , bz] = b;
    if (f & 1) a[0] += sign(ax - bx) * 0.2;
    if (f & 2) b[0] += sign(bx - ax) * 0.2;
    if (f & 4) a[2] += sign(az - bz) * 0.2;
    if (f & 8) b[2] += sign(bz - az) * 0.2;
    flags[i] = f & EDGE_ON_GRID;
  }
  return { pts, flags };
}

export class Collision {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.boxes = new Map(); // model id -> per-clump local bounds
    this.captureKey = 0; // CaptureKey's virtual key
  }

  get world() {
    return this.engine.world;
  }
  get hotspots() {
    return this.engine.hotspots;
  }
  /**
   * @param {number} id
   */
  obj(id) {
    return this.world?.get(id) || null;
  }
  /**
   * @param {number} id
   */
  radius(id) {
    return this.world?.radiusOf?.(id) ?? this.obj(id)?.radius ?? 0;
  }
  /**
   * @param {number} id
   * @param {number} n
   */
  prop(id, n) {
    return this.engine.render3d?.objects?.getProperty(id, n) ?? 0;
  }
  /**
   * @param {number} id
   */
  list(id) {
    return this.engine.renderLists?.get(id) || [];
  }

  // Footprint of hotspot `h`, computed when it is added.
  /**
   * @param {any} h
   */
  footprint(h) {
    if (h.type === ROUND || h.footprint !== null) return h.footprint;
    const e = this.engine;
    const src = e.dynamic?.get(h.id) ?? h.id;
    const t = e.bin?.type(src);
    /** @type {number[][]} */
    let verts = [];
    if (t === 7 || t === 8) {
      try {
        verts = rootClumpVertices(e.res(src));
      } catch {
        verts = [];
      }
    }
    const pose = h.poseObj ? this.obj(h.poseObj) : null;
    h.footprint = verts.length ? buildFootprint(verts, h.pos, pose?.basis) : { pts: [], flags: [] };
    return h.footprint;
  }

  // FUN_1001ab5c: octagonal x/z distance between two objects, or 0 when it
  // is not under the sum of their radii plus `extra`.
  /**
   * @param {any} a
   * @param {any} b
   * @param {number} extra
   */
  near(a, b, extra) {
    const dx = Math.abs(a.pos[0] - b.pos[0]), dz = Math.abs(b.pos[2] - a.pos[2]);
    const d = dx + dz - Math.min(dx, dz) / 2;
    return this.radius(a.id) + this.radius(b.id) + extra <= d ? 0 : d;
  }

  // UpdateCollideCheck(id, list, extra, ignore) 0x100182d0: the nearest
  // object in the list closer than both radii plus `extra`, else 0.
  /**
   * @param {number} id
   * @param {number} list
   * @param {number} extra
   * @param {number} ignore
   */
  updateCollideCheck(id, list, extra, ignore) {
    const o = this.obj(id);
    if (!o) return 0;
    let best = 64000, hit = 0;
    for (const other of this.list(list)) {
      if (!other || other === id || other === ignore) continue;
      const t = this.obj(other);
      if (!t) continue;
      const d = this.near(o, t, extra / UNIT);
      if (d !== 0 && d < best) {
        best = d;
        hit = other;
      }
    }
    return hit;
  }

  // ObjectPositionCollision(hotspot, id) 0x1002338f: 0 clear, 1 inside the
  // hotspot, 2 touching it (within the object's radius; flag 2 only).
  /**
   * @param {number} n
   * @param {number} id
   */
  positionCollision(n, id) {
    const h = this.hotspots?.get(n);
    const o = this.obj(id);
    if (!h || !o || !(h.flags & 1)) return 0;
    const [x, y, z] = o.pos;
    if (h.height !== 0 && !(y <= h.height && y >= 0)) return 0;
    const r = this.radius(id);
    if (h.type === ROUND) {
      const d2 = len2(h.pos[0] - x, h.pos[2] - z);
      const hr = h.id / UNIT;
      if (!(h.flags & 2)) return d2 <= hr * hr ? 1 : 0;
      if (d2 <= hr * hr) return 1;
      return d2 <= (r + hr) * (r + hr) ? 2 : 0;
    }
    const fp = this.footprint(h);
    if (!fp.pts.length) return 0;
    if (h.type === OUTSIDE) return insidePolygon(fp.pts, x, z) ? 0 : 1;
    if (!(h.flags & 2)) return insidePolygon(fp.pts, x, z) ? 1 : 0;
    if (insidePolygon(fp.pts, x, z)) return 1;
    const s = o.speed < 0 ? -r : r;
    return insidePolygon(fp.pts, x + o.basis.at[0] * s, z + o.basis.at[2] * s) ? 2 : 0;
  }

  // CheckPositionCollision(hotspot, x, z) 0x1002325c: a script point
  // against a footprint (types 1 and 8 only).
  /**
   * @param {number} n
   * @param {number} sx
   * @param {number} sz
   */
  checkPosition(n, sx, sz) {
    const h = this.hotspots?.get(n);
    if (!h || (h.type !== OUTSIDE && h.type !== 1)) return 0;
    const fp = this.footprint(h);
    const inside = insidePolygon(fp.pts, sx / UNIT, sz / UNIT);
    return h.type === OUTSIDE ? (inside ? 0 : 1) : inside ? 1 : 0;
  }

  // Process_Sector_Collisions(id, &hotspot, &object, fast, scripts)
  // 0x100289d0. scripts[6] is the script that returns the list of objects
  // in the mover's map sector (script 430: table 427, 1200-unit cells).
  // Each listed object's property 16 lists its hotspots. The first hotspot
  // hit is returned (and written out with its object); hotspots of class
  // 500 objects are triggers: they run the object's property 2 script with
  // (mover, object, hotspot) and are never returned.
  /**
   * @param {number} id
   * @param {number} pHotspot
   * @param {number} pObject
   * @param {number} fast
   * @param {number} scripts
   */
  sectorCollisions(id, pHotspot, pObject, fast, scripts) {
    const vm = this.engine.vm;
    const cls = this.prop(id, 0);
    if (cls >= 200 && cls <= 270) return 0;
    const sector = callValue(this.engine, vm.load(scripts + 4 * 6), [id]);
    if (sector === -1) return 0;
    if (pObject) vm.store(pObject, 0);
    if (pHotspot) vm.store(pHotspot, 0);
    if (!sector) return 0;
    let found = false, result = 0;
    const cell = this.list(sector);
    for (let i = 0; i < 25 && i < cell.length; i++) {
      const other = cell[i];
      if (other === -1) break;
      if (other === -2) continue;
      const ocls = this.prop(other, 0);
      const spots = ocls < 240 && this.prop(other, 133) ? 0 : this.prop(other, 16);
      if (!spots) continue;
      for (const n of this.list(spots)) {
        if (!n) continue;
        let r = 0;
        if (!fast) {
          if (!found || ocls === 500) r = this.positionCollision(n, id);
          if (r && ocls === 500) {
            const script = this.prop(other, 2);
            if (script) callValue(this.engine, script, [id, other, n]);
          }
        } else {
          r = this.fastCollide(id, other, n);
        }
        if (!found && r > 0 && ocls !== 500) {
          if (pHotspot) vm.store(pHotspot, n);
          if (pObject) vm.store(pObject, other);
          result = r;
          found = true;
        }
      }
    }
    return result;
  }

  // FastmovingHotspotCollide (0x1002447f) for projectiles: the path from
  // the last position to this one against the hotspot.
  /**
   * @param {number} id
   * @param {number} _other
   * @param {number} n
   */
  fastCollide(id, _other, n) {
    const h = this.hotspots?.get(n);
    const o = this.obj(id);
    if (!h || !o || !(h.flags & 1)) return 0;
    const steps = Math.max(1, Math.ceil(length(sub(o.pos, o.last)) / Math.max(0.1, this.radius(id) || 0.25)));
    const saved = o.pos;
    try {
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        o.pos = [o.last[0] + (saved[0] - o.last[0]) * t, o.last[1] + (saved[1] - o.last[1]) * t, o.last[2] + (saved[2] - o.last[2]) * t];
        const r = this.positionCollision(n, id);
        if (r) return r;
      }
    } finally {
      o.pos = saved;
    }
    return 0;
  }

  // The deflection test both DeflectObject and round hotspots use: push
  // `o` out to `reach` from `c` unless it is heading too squarely into it.
  // Returns 1 when the move may stand (clear, moving away, or slid), 0 when
  // the caller should undo it. `limit` is |cos| × 10000 of the steepest
  // angle that still slides.
  /**
   * @param {any} o
   * @param {number[]} c
   * @param {number} reach
   * @param {number} limit
   */
  deflectRound(o, c, reach, limit) {
    let dx = o.pos[0] - c[0], dz = o.pos[2] - c[2];
    if (reach * reach < len2(dx, dz)) return 1;
    const d = normalize([dx, 0, dz]);
    const facing = Math.trunc((o.basis.at[2] * d[2] + o.basis.at[0] * d[0]) * -10000);
    if ((o.speed < 0 && facing > 0) || (o.speed >= 0 && facing < 0)) return 1;
    if (Math.abs(facing) < limit) {
      o.pos = [c[0] + d[0] * reach, o.pos[1], c[2] + d[2] * reach];
      o.moved = true;
      return 1;
    }
    return 0;
  }

  // DeflectObject(id, other, limit, addOwnRadius) 0x10023dac
  /**
   * @param {number} id
   * @param {number} other
   * @param {number} limit
   * @param {number} both
   */
  deflectObject(id, other, limit, both) {
    const o = this.obj(id), t = this.obj(other);
    if (!o || !t) return 1;
    const reach = this.radius(other) + (both ? this.radius(id) : 0);
    return this.deflectRound(o, t.pos, reach, limit);
  }

  // DeflectHotspot(id, hotspot, other, limit, addOwnRadius) 0x1002421e. A
  // round hotspot uses `other`'s position and radius; a footprint slides
  // the object along the edge it crossed (FUN_1001e608).
  /**
   * @param {number} id
   * @param {number} n
   * @param {number} other
   * @param {number} limit
   * @param {number} both
   */
  deflectHotspot(id, n, other, limit, both) {
    const h = this.hotspots?.get(n);
    const o = this.obj(id);
    if (!h || !o) return 1;
    if (h.type === ROUND) {
      const t = this.obj(other);
      if (!t) return 1;
      return this.deflectRound(o, t.pos, this.radius(other) + (both ? this.radius(id) : 0), limit);
    }
    const fp = this.footprint(h);
    return fp.pts.length ? (this.slide(fp, o, -limit / 10000) ? 1 : 0) : 1;
  }

  // FUN_1001e608: find the footprint edge the last move crossed and slide
  // along it, or refuse when the move meets it more squarely than `limit`
  // (a negative sine). Already inside without crossing: push out
  // (FUN_1001e95e).
  /**
   * @param {any} fp
   * @param {any} o
   * @param {number} limit
   */
  slide(fp, o, limit) {
    const { pts, flags } = fp;
    const [lx, , lz] = o.last;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (flags[i]) continue;
      const a = pts[j], b = pts[i];
      const p = segmentsCross(lx, lz, o.pos[0], o.pos[2], a[0], a[2], b[0], b[2]);
      if (!p) continue;
      const edge = normalize([b[0] - p[0], 0, b[2] - p[1]]);
      const past = [o.pos[0] - p[0], 0, o.pos[2] - p[1]];
      const along = dot(edge, normalize(past)) * length(past);
      const nx = edge[2], nz = -edge[0]; // the edge's normal, (0,1,0) x edge
      const side = nx * normalize(past)[0] + nz * normalize(past)[2];
      if (side <= limit) return false;
      if (side > 0) return true;
      o.pos = [edge[0] * along + p[0] + nx / 100, o.pos[1], edge[2] * along + p[1] + nz / 100];
      o.moved = true;
      return !insidePolygon(pts, o.pos[0], o.pos[2]);
    }
    if (insidePolygon(pts, o.pos[0], o.pos[2])) this.pushOut(fp, o);
    return true;
  }

  // FUN_1001e95e: move the object to the nearest point where a line through
  // it (along its last move, extended 8 units each way, or across its right
  // vector) leaves the footprint.
  /**
   * @param {any} o
   */
  pushOut({ pts, flags }, o) {
    const [px, , pz] = o.pos;
    let best = 50000, to = [o.last[0], o.last[2]];
    const tryLine = (/** @type {number} */ x1, /** @type {number} */ z1, /** @type {number} */ x2, /** @type {number} */ z2) => {
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        if (flags[i]) continue;
        const p = segmentsCross(x1, z1, x2, z2, pts[j][0], pts[j][2], pts[i][0], pts[i][2]);
        if (!p) continue;
        const d = Math.hypot(px - p[0], pz - p[1]);
        if (d < best) {
          best = d;
          to = p;
        }
      }
    };
    const m = normalize([px - o.last[0], 0, pz - o.last[2]]);
    tryLine(o.last[0] - m[0] * 8, o.last[2] - m[2] * 8, px + m[0] * 8, pz + m[2] * 8);
    const r = normalize(o.basis.right);
    tryLine(px + r[0], pz + r[2], px - r[0], pz - r[2]);
    o.pos = [to[0], o.pos[1], to[1]];
    o.moved = true;
  }

  // World-space bounds of every clump of an object's model, by script clump
  // number: index 0 is the root when the model has no tagged clumps, else
  // tagged clumps 1.. (as ClumpToClump and CollisionClump count them).
  /**
   * @param {number} id
   */
  clumpBoxes(id) {
    const r3d = this.engine.render3d;
    const inst = r3d?.objectModel?.(id);
    const o = this.obj(id);
    if (!inst || !o) return null;
    const model = inst.model;
    let local = this.boxes.get(model);
    if (!local) {
      local = model.clumps.map((/** @type {any} */ c) => {
        const p = c.mesh.positions;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < p.length; k += 3) {
          for (let j = 0; j < 3; j++) {
            min[j] = Math.min(min[j], p[k + j]);
            max[j] = Math.max(max[j], p[k + j]);
          }
        }
        return p.length ? { min, max } : null;
      });
      this.boxes.set(model, local);
    }
    const ms = clumpMatrices(model, modelMatrix(o.basis, o.pos), inst.pose);
    const tagged = model.tagged.length > 1;
    const list = tagged ? model.tagged.map((/** @type {any} */ ci, /** @type {any} */ k) => (k ? [k, ci] : null)).filter(Boolean) : [[0, model.roots[0] ?? 0]];
    const out = [];
    const q = [0, 0, 0];
    for (const [k, ci] of list) {
      const b = ci !== undefined && local[ci];
      if (!b) continue;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        transformPoint(ms[ci], c & 1 ? b.max[0] : b.min[0], c & 2 ? b.max[1] : b.min[1], c & 4 ? b.max[2] : b.min[2], q);
        for (let j = 0; j < 3; j++) {
          min[j] = Math.min(min[j], q[j]);
          max[j] = Math.max(max[j], q[j]);
        }
      }
      out.push({ k, min, max, origin: [ms[ci][12], ms[ci][13], ms[ci][14]] });
    }
    return out;
  }

  // ClumpToClump(a, b, tolerance) 0x100107cc: the first clump of b that a
  // clump of a overlaps (its origin within `tolerance` / 100 of the clump
  // and their boxes overlapping on every axis); -1 if none, 0 without
  // models (or b's root clump).
  /**
   * @param {number} a
   * @param {number} b
   * @param {number} tol
   */
  clumpToClump(a, b, tol) {
    const A = this.clumpBoxes(a), B = this.clumpBoxes(b);
    if (!A || !B) return 0;
    const t = tol / 100;
    for (const ca of A) {
      for (const cb of B) {
        if (boxDistance(cb, ca.origin) >= t) continue;
        let axes = 0;
        for (let j = 0; j < 3; j++) if (ca.min[j] <= cb.max[j] && cb.min[j] <= ca.max[j]) axes++;
        if (axes > 2) return cb.k;
      }
    }
    return -1;
  }

  // CollisionClump(mover, target) 0x10010dbc: the first clump of the target
  // whose box the mover's last step (last position to current) passes
  // through; -1 if none, 0 if the target has no model.
  /**
   * @param {any} mover
   * @param {any} target
   */
  clumpHit(mover, target) {
    const o = this.obj(mover);
    const B = this.clumpBoxes(target);
    if (!o || !B) return 0;
    for (const cb of B) if (segmentHitsBox(o.last, o.pos, cb)) return cb.k;
    return -1;
  }

  // For other modules: the first object (other than `id`) whose radius
  // reaches the point (x, y, z in RenderWare units) with `radius` added.
  /**
   * @param {number} id
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  hitAt(id, x, y, z, radius = 0) {
    for (const o of this.world?.objects.values() || []) {
      if (o.id === id || o.level < 0) continue;
      const r = this.radius(o.id) + radius;
      if (r > 0 && len2(o.pos[0] - x, o.pos[2] - z) + (o.pos[1] - y) ** 2 <= r * r) return o.id;
    }
    return 0;
  }

  // The first object a point moving from `from` to `to` passes within its
  // radius of; 0 if none.
  /**
   * @param {number} id
   * @param {number[]} from
   * @param {any} to
   */
  segment(id, from, to) {
    let best = Infinity, hit = 0;
    const d = sub(to, from);
    const l2 = dot(d, d);
    for (const o of this.world?.objects.values() || []) {
      if (o.id === id || o.level < 0) continue;
      const r = this.radius(o.id);
      if (!(r > 0)) continue;
      const t = l2 ? Math.max(0, Math.min(1, dot(sub(o.pos, from), d) / l2)) : 0;
      const c = [from[0] + d[0] * t - o.pos[0], from[1] + d[1] * t - o.pos[1], from[2] + d[2] * t - o.pos[2]];
      if (dot(c, c) <= r * r && t < best) {
        best = t;
        hit = o.id;
      }
    }
    return hit;
  }

  // World position and direction of a clump of an object (k = 0: the root).
  /**
   * @param {number} id
   * @param {any} k
   */
  clumpWorld(id, k) {
    const inst = this.engine.render3d?.objectModel?.(id);
    const o = this.obj(id);
    if (!inst || !o) return null;
    const ci = inst.clump(k);
    if (ci < 0) return null;
    const m = clumpMatrices(inst.model, modelMatrix(o.basis, o.pos), inst.pose)[ci];
    return { pos: [m[12], m[13], m[14]], at: normalize([m[8], m[9], m[10]]) };
  }
}

/**
 * @param {any} b
 * @param {number[]} p
 */
function boxDistance(b, p) {
  let s = 0;
  for (let j = 0; j < 3; j++) {
    const d = p[j] < b.min[j] ? b.min[j] - p[j] : p[j] > b.max[j] ? p[j] - b.max[j] : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

// Slab test: does the segment a-b pass through the box?
/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {any} box
 */
function segmentHitsBox(a, b, box) {
  let t0 = 0, t1 = 1;
  for (let j = 0; j < 3; j++) {
    const d = b[j] - a[j];
    if (Math.abs(d) < 1e-9) {
      if (a[j] < box.min[j] || a[j] > box.max[j]) return false;
      continue;
    }
    let u = (box.min[j] - a[j]) / d, v = (box.max[j] - a[j]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * @param {Engine} engine
 * @returns {Externs}
 */
export function collisionExterns(engine) {
  const c = (engine.collision = new Collision(engine));
  if (engine.render3d && !engine.render3d.clumpWorld) engine.render3d.clumpWorld = (/** @type {number} */ id, /** @type {any} */ k) => c.clumpWorld(id, k);
  const hs = (/** @type {number} */ n) => engine.hotspots?.get(n);
  return {
    UpdateCollideCheck: (id, list, extra, ignore) => c.updateCollideCheck(id, list, extra, ignore),
    Process_Sector_Collisions: (id, pHotspot, pObject, fast, scripts) => c.sectorCollisions(id, pHotspot, pObject, fast, scripts),
    ObjectPositionCollision: (n, id) => c.positionCollision(n, id),
    CheckPositionCollision: (n, x, z) => c.checkPosition(n, x, z),
    FastmovingHotspotCollide: (id, other, n) => c.fastCollide(id, other, n),
    DeflectObject: (id, other, limit, both) => c.deflectObject(id, other, limit, both),
    DeflectHotspot: (id, n, other, limit, both) => c.deflectHotspot(id, n, other, limit, both),
    ClumpToClump: (a, b, tol) => c.clumpToClump(a, b, tol),
    // 0x10024b27 / 0x10024b74 / 0x10024c4d: the hotspot's callback script
    // (param 0) and its three values (params 1-3). Script 438 stores the
    // owning object in 1 and its kind in 2.
    SetCallbackID(n, script) {
      const h = hs(n);
      if (!h) return 0;
      h.params[0] = script;
      return 1;
    },
    SetCallbackParm(n, k, v) {
      const h = hs(n);
      if (!h || k < 1 || k > 3) return 0;
      h.params[k] = v;
      return 1;
    },
    GetCallbackParm: (n, k) => (k >= 1 && k <= 3 ? hs(n)?.params[k] ?? 0 : 0),
    // ObjectSetScene(id, own) 0x10014272: 0 puts the object's model in the
    // main scene, anything else sets object flag 0x80, and the draw pass
    // then renders it in a scene of its own. Either way it is drawn.
    ObjectSetScene(id, own) {
      const rec = engine.render3d?.objects?.get(id);
      if (rec) rec.flags = own ? rec.flags | 0x80 : rec.flags & ~0x80;
      return 0;
    },
    // UpdateLOD(id) 0x10029743: forget the current level of detail and pick
    // one again for the current camera distance.
    UpdateLOD(id) {
      const w = engine.world, o = w?.get(id);
      if (w && o) {
        o.lod = 0;
        w.levelOfDetail(o, Math.round(w.time));
      }
      return 0;
    },
    // ObjectSortFlag(id, mode) 0x10008ab1: draw-order flags 0x200 / 0xa00.
    ObjectSortFlag(id, mode) {
      const rec = engine.render3d?.objects?.get(id);
      if (rec) rec.flags = mode === 2 ? rec.flags | 0xa00 : mode === 0 ? rec.flags & ~0xa00 : rec.flags | 0x200;
      return 0;
    },
    // CaptureKey(vk) 0x1000db64: remembered only (the window procedure reads
    // it to hand one key to a script).
    CaptureKey(vk) {
      c.captureKey = vk;
      return 1;
    },
    // GetFrameRate(n) 0x1001234b: 3 is the clock mod 10000; the others are
    // frame counters the original's FPS display reads.
    GetFrameRate(n) {
      const w = engine.world;
      if (n === 3) return Math.round(w?.time ?? 0) % 10000;
      if (n === 0 || n === 2) return 30;
      return 0;
    },
  };
}
