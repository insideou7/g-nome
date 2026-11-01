// MODL (type 7) and MPRT (type 8) models: RenderWare 2.0 RWX commands as a
// binary u32 opcode stream. Ported from tools/gnome_extract.py; the opcode
// table is in docs/formats/g-nome-bin.md.
//
// A model becomes a tree of clumps. Each clump has its own local matrix
// (relative to its parent clump) and a mesh in its own space, so the
// animation code can pose clumps without touching the vertices.
import { identity, mul, transformPoint } from "./math.js";

// Argument kinds: f float, i int, P count-prefixed int list, s texture path
// (only present when the int before it is not 0; NUL-terminated, padded to 4).
/** @type {Record<number, string[]>} */
const OPS = {
  0x1a: ["modelbegin", ""], 0x1b: ["modelend", ""],
  0x06: ["clumpbegin", ""], 0x07: ["clumpend", ""],
  0x35: ["transformbegin", ""], 0x36: ["transformend", ""],
  0x34: ["transform", "ffffffffffffffff"],
  0x3b: ["vertex", "fff"], 0x3c: ["vertexext", "fff"],
  0x12: ["uv", "ff"], 0x14: ["vertexend", ""],
  0x39: ["triangle", "iii"], 0x23: ["quad", "iiii"], 0x1d: ["polygon", "P"],
  // Op n calls entry n - 1 of RENDER.R32's RWX table (FUN_100025e5, run by
  // FUN_10003432): 0x08 is RwSetSurfaceColor, 0x2C RwSetSurface (ambient,
  // diffuse, specular).
  0x08: ["color", "fff"], 0x2c: ["surface", "fff"], 0x1c: ["opacity", "f"],
  0x2e: ["texture", "is"],
  // Int settings (values from RWL20.DLL, see docs/render3d.md):
  // RwSetAxisAlignment (0x04) of the current clump: 1 none, 2 ZOrientX,
  // 3 ZOrientY, 4 XYZ (faces the camera; the 29 explosion, shot and smoke
  // sprites). RwSetHints (0x0F) of the current clump: 1 container, 2 HS,
  // 4 editable; they only pick the polygon order, which the z-buffer makes
  // moot. Material settings: RwSetSurfaceGeometrySampling (0x0D: 1 point
  // cloud, 2 wireframe, 4 solid; every model uses 4),
  // RwSetSurfaceLightSampling (0x16: 1 facet, 2 vertex) and
  // RwSetSurfaceMaterialModes (0x19: 8 = double, drawn from both sides).
  0x04: ["axisalignment", "i"], 0x0d: ["geometrysampling", "i"], 0x0f: ["hints", "i"],
  0x16: ["lightsampling", "i"], 0x19: ["materialmodes", "i"],
  // RWX TextureModes: 1 lit, 2 foreshorten (perspective), 4 filter. Without
  // the lit bit a texture draws at full brightness (ground tiles use 2).
  0x32: ["texturemodes", "i"],
  // Clump tag. RENDER.R32 finds clump i of a model as the clump tagged i + 1
  // (RwFindTaggedClump); the u32 after the "MODL" tag is the number of them.
  0x2d: ["tag", "i"],
};

/**
 * @param {Uint8Array} bytes
 */
export function modelOps(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {[string, any[]][]} */
  const ops = [];
  let p = 8;
  while (p < bytes.length) {
    const code = dv.getUint32(p, true);
    p += 4;
    const def = OPS[code];
    if (!def) throw new Error(`unknown model opcode 0x${code.toString(16)} at 0x${(p - 4).toString(16)}`);
    /** @type {any[]} */
    const args = [];
    for (const k of def[1]) {
      if (k === "f") { args.push(dv.getFloat32(p, true)); p += 4; }
      else if (k === "i") { args.push(dv.getInt32(p, true)); p += 4; }
      else if (k === "P") {
        const n = dv.getUint32(p, true);
        const list = [];
        for (let i = 0; i < n; i++) list.push(dv.getUint32(p + 4 + 4 * i, true));
        args.push(list);
        p += 4 + 4 * n;
      } else if (k === "s" && args[args.length - 1]) {
        let z = p;
        while (bytes[z]) z++;
        args.push(String.fromCharCode(...bytes.subarray(p, z)));
        p = (z + 4) & ~3;
      }
    }
    ops.push([def[0], args]);
  }
  if (p !== bytes.length) throw new Error("model stream overruns the resource");
  return ops;
}

// "\7thlevel\gnome\src\data\bitmaps\mesoonbl.BMP" -> "MESOONBL.BMP"
/**
 * @param {string} path
 */
export function bmpName(path) {
  return (path.split(/[\\/]/).pop() ?? "").toUpperCase();
}

// Parse a model into {clumps: [{index, parent, tag, local, mesh}], roots,
// tagged} where tagged[t] is the index of the clump tagged t.
// mesh: {positions, normals, uvs (Float32Array, 3/3/2 per vertex, three
// vertices per triangle), groups: [{start, count, material}]}.
// material: {color [r,g,b] 0..1, ambient, diffuse, specular, opacity,
// texture: upper-case BMP name or "", textureModes?, lightSampling (1 facet,
// 2 vertex), materialModes (8 = double-sided)}. A clump also has
// axisAlignment (AXIS_XYZ: turned to face the camera, see alignClumps) and
// hints.
/**
 * @param {any} bytes
 */
export function parseModel(bytes) {
  /** @type {any} */
  const clumps = [];
  const stack = [];
  /** @type {any} */
  let clump = null;
  let ctm = identity();
  const ctmStack = [];
  /** @type {{ color: number[], ambient: number, diffuse: number, specular: number, opacity: number, texture: string, textureModes?: number, lightSampling: number, geometrySampling: number, materialModes: number }} */
  let mat = { color: [0.8, 0.8, 0.8], ambient: 0.3, diffuse: 0.7, specular: 0, opacity: 1, texture: "", lightSampling: 1, geometrySampling: 4, materialModes: 0 };
  /** @type {any} */
  let pending = null;

  const begin = (/** @type {number} */ parent) => {
    const c = { index: clumps.length, parent, tag: 0, axisAlignment: 1, hints: 0, local: ctm, verts: [], tris: [], children: [] };
    clumps.push(c);
    if (parent >= 0) clumps[parent].children.push(c.index);
    return c;
  };
  const flush = () => {
    if (!pending || !clump) { pending = null; return; }
    const p = transformPoint(ctm, pending[0], pending[1], pending[2], [0, 0, 0]);
    clump.verts.push({ p, uv: pending[3] });
    pending = null;
  };
  const face = (/** @type {any} */ idx) => {
    flush();
    if (!clump) clump = begin(-1);
    for (const i of idx) if (i < 1 || i > clump.verts.length) throw new Error(`face uses vertex ${i} of ${clump.verts.length}`);
    for (let k = 1; k + 1 < idx.length; k++) clump.tris.push([idx[0] - 1, idx[k] - 1, idx[k + 1] - 1, mat]);
  };

  for (const [op, a] of modelOps(bytes)) {
    switch (op) {
      case "vertex": case "vertexext": flush(); pending = [a[0], a[1], a[2], null]; break;
      case "uv": if (pending) pending[3] = a; break;
      case "vertexend": flush(); break;
      case "triangle": case "quad": face(a); break;
      case "polygon": face(a[0]); break;
      case "clumpbegin":
        flush();
        stack.push([clump, ctm, mat]);
        clump = begin(clump ? clump.index : -1);
        ctm = identity();
        break;
      case "clumpend":
        flush();
        [clump, ctm, mat] = /** @type {any[]} */ (stack.pop());
        break;
      case "transformbegin": ctmStack.push(ctm); break;
      case "transformend": ctm = ctmStack.pop() || identity(); break;
      case "transform": ctm = Float32Array.from(a); break;
      case "color": mat = { ...mat, color: a.slice() }; break;
      case "surface": mat = { ...mat, ambient: a[0], diffuse: a[1], specular: a[2] }; break;
      case "opacity": mat = { ...mat, opacity: a[0] }; break;
      case "tag": if (clump) clump.tag = a[0]; break;
      case "texturemodes": mat = { ...mat, textureModes: a[0] }; break;
      case "texture": mat = { ...mat, texture: a[0] ? bmpName(a[1]) : "" }; break;
      case "lightsampling": mat = { ...mat, lightSampling: a[0] }; break;
      case "geometrysampling": mat = { ...mat, geometrySampling: a[0] }; break;
      case "materialmodes": mat = { ...mat, materialModes: a[0] }; break;
      case "axisalignment": if (clump) clump.axisAlignment = a[0]; break;
      case "hints": if (clump) clump.hints = a[0]; break;
    }
  }
  flush();
  for (const c of clumps) {
    c.mesh = buildMesh(c.verts, c.tris);
    delete c.verts;
    delete c.tris;
  }
  const tagged = [];
  for (const c of clumps) if (c.tag) tagged[c.tag] = c.index;
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  return { clumps, roots: clumps.filter((/** @type {any} */ c) => c.parent < 0).map((/** @type {any} */ c) => c.index), tagged, count };
}

/**
 * @param {any} verts
 * @param {any} tris
 */
function buildMesh(verts, tris) {
  // Flat normal of each triangle. RenderWare 2 is left-handed with
  // clockwise front faces, so the winding gives (B - A) x (C - A) pointing
  // out. Vertex normals (LightSampling 2) average the faces around a vertex.
  const faceN = tris.map((/** @type {any} */ [a, b, c]) => {
    const A = verts[a].p, B = verts[b].p, C = verts[c].p;
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  });
  /** @type {number[][] | null} */
  let vertN = null;
  if (tris.some((/** @type {any} */ t) => t[3].lightSampling === 2)) {
    vertN = verts.map(() => [0, 0, 0]);
    tris.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) /** @type {number[][]} */ (vertN)[t[k]][j] += faceN[i][j];
    });
  }
  const unit = (/** @type {number[]} */ n) => {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  // Group triangles by material so each group is one draw.
  const byMat = new Map();
  tris.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
    if (!byMat.has(t[3])) byMat.set(t[3], []);
    byMat.get(t[3]).push(i);
  });
  const n = tris.length * 3;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const groups = [];
  let v = 0;
  for (const [material, list] of byMat) {
    const start = v;
    const smooth = material.lightSampling === 2 ? vertN : null;
    for (const i of list) {
      const flat = unit(faceN[i]);
      for (const k of tris[i].slice(0, 3)) {
        const p = verts[k].p, uv = verts[k].uv;
        positions.set(p, v * 3);
        normals.set(smooth ? unit(smooth[k]) : flat, v * 3);
        if (uv) { uvs[v * 2] = uv[0]; uvs[v * 2 + 1] = uv[1]; }
        v++;
      }
    }
    groups.push({ start, count: v - start, material });
  }
  return { positions, normals, uvs, groups, count: n };
}

// RwSetAxisAlignment value that turns a clump to face the camera.
export const AXIS_XYZ = 4;

// Turn the clumps with AxisAlignment XYZ to face the camera, as RWL20's
// FUN_10029dd0 does before drawing such a clump: its X axis becomes the
// camera's screen right (minus camera X) and Y the camera's up, both keeping
// their length, and Z points back at the camera with length 1. The position
// stays. `worlds` (from clumpMatrices) is changed in place; `cam` is the
// camera-to-world matrix. ZOrientX (2) and ZOrientY (3) are not used by any
// G-Nome model and are left alone.
/**
 * @param {any} model
 * @param {Float32Array[]} worlds
 * @param {ArrayLike<number>} cam
 */
export function alignClumps(model, worlds, cam) {
  model.clumps.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    if (c.axisAlignment !== AXIS_XYZ) return;
    const w = Float32Array.from(worlds[i]);
    const sx = Math.hypot(w[0], w[1], w[2]), sy = Math.hypot(w[4], w[5], w[6]);
    for (let j = 0; j < 3; j++) {
      w[j] = -cam[j] * sx;
      w[4 + j] = cam[4 + j] * sy;
      w[8 + j] = -cam[8 + j];
    }
    worlds[i] = w;
  });
  return worlds;
}

// World matrices for every clump, given the model's placement and optional
// per-clump pose overrides (pose[i] replaces clump i's local matrix) and
// joint matrices (RotateSubClump; joints[i] applies before the local one).
/**
 * @param {any} model
 * @param {Float32Array} world
 */
export function clumpMatrices(model, world, pose = null, joints = null) {
  const out = new Array(model.clumps.length);
  const visit = (/** @type {number} */ i, /** @type {number[] | Float32Array} */ parentM) => {
    const c = model.clumps[i];
    const local = (pose && pose[i]) || c.local;
    out[i] = mul(joints && joints[i] ? mul(joints[i], local) : local, parentM);
    for (const k of c.children) visit(k, out[i]);
  };
  for (const r of model.roots) visit(r, world);
  return out;
}

// Axis-aligned bounds of the posed model in model space.
/**
 * @param {any} [pose]
 * @param {any} model
 */
export function modelBounds(model, pose = null) {
  const ms = clumpMatrices(model, identity(), pose);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  model.clumps.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const pos = c.mesh.positions;
    for (let k = 0; k < pos.length; k += 3) {
      transformPoint(ms[i], pos[k], pos[k + 1], pos[k + 2], p);
      for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], p[j]); max[j] = Math.max(max[j], p[j]); }
    }
  });
  return { min, max };
}
