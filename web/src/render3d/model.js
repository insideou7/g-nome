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
const OPS = {
  0x1a: ["modelbegin", ""], 0x1b: ["modelend", ""],
  0x06: ["clumpbegin", ""], 0x07: ["clumpend", ""],
  0x35: ["transformbegin", ""], 0x36: ["transformend", ""],
  0x34: ["transform", "ffffffffffffffff"],
  0x3b: ["vertex", "fff"], 0x3c: ["vertexext", "fff"],
  0x12: ["uv", "ff"], 0x14: ["vertexend", ""],
  0x39: ["triangle", "iii"], 0x23: ["quad", "iiii"], 0x1d: ["polygon", "P"],
  0x2c: ["color", "fff"], 0x08: ["surface", "fff"], 0x1c: ["opacity", "f"],
  0x2e: ["texture", "is"],
  // Int settings not identified yet (probably RWX lightsampling,
  // geometrysampling, texturemodes and friends).
  0x04: ["op04", "i"], 0x0d: ["op0d", "i"], 0x0f: ["op0f", "i"],
  0x16: ["op16", "i"], 0x19: ["op19", "i"],
  // RWX TextureModes: 1 lit, 2 foreshorten (perspective), 4 filter. Without
  // the lit bit a texture draws at full brightness (ground tiles use 2).
  0x32: ["texturemodes", "i"],
  // Clump tag. RENDER.R32 finds clump i of a model as the clump tagged i + 1
  // (RwFindTaggedClump); the u32 after the "MODL" tag is the number of them.
  0x2d: ["tag", "i"],
};

export function modelOps(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ops = [];
  let p = 8;
  while (p < bytes.length) {
    const code = dv.getUint32(p, true);
    p += 4;
    const def = OPS[code];
    if (!def) throw new Error(`unknown model opcode 0x${code.toString(16)} at 0x${(p - 4).toString(16)}`);
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
export function bmpName(path) {
  return path.split(/[\\/]/).pop().toUpperCase();
}

// Parse a model into {clumps: [{index, parent, tag, local, mesh}], roots,
// tagged} where tagged[t] is the index of the clump tagged t.
// mesh: {positions, normals, uvs (Float32Array, 3/3/2 per vertex, three
// vertices per triangle), groups: [{start, count, material}]}.
// material: {color [r,g,b] 0..1, ambient, diffuse, specular, opacity,
// texture: upper-case BMP name or ""}.
export function parseModel(bytes) {
  const clumps = [];
  const stack = [];
  let clump = null;
  let ctm = identity();
  const ctmStack = [];
  let mat = { color: [0.8, 0.8, 0.8], ambient: 0.3, diffuse: 0.7, specular: 0, opacity: 1, texture: "" };
  let pending = null;

  const begin = (parent) => {
    const c = { index: clumps.length, parent, tag: 0, local: ctm, verts: [], tris: [], children: [] };
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
  const face = (idx) => {
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
  return { clumps, roots: clumps.filter((c) => c.parent < 0).map((c) => c.index), tagged, count };
}

function buildMesh(verts, tris) {
  // Group triangles by material so each group is one draw.
  const byMat = new Map();
  for (const t of tris) {
    if (!byMat.has(t[3])) byMat.set(t[3], []);
    byMat.get(t[3]).push(t);
  }
  const n = tris.length * 3;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const groups = [];
  let v = 0;
  for (const [material, list] of byMat) {
    const start = v;
    for (const [a, b, c] of list) {
      const A = verts[a].p, B = verts[b].p, C = verts[c].p;
      // Flat normal. RenderWare 2 is left-handed with clockwise front faces,
      // so the winding gives (B - A) x (C - A) pointing out.
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const k of [a, b, c]) {
        const p = verts[k].p, uv = verts[k].uv;
        positions.set(p, v * 3);
        normals[v * 3] = nx; normals[v * 3 + 1] = ny; normals[v * 3 + 2] = nz;
        if (uv) { uvs[v * 2] = uv[0]; uvs[v * 2 + 1] = uv[1]; }
        v++;
      }
    }
    groups.push({ start, count: v - start, material });
  }
  return { positions, normals, uvs, groups, count: n };
}

// World matrices for every clump, given the model's placement and optional
// per-clump pose overrides (pose[i] replaces clump i's local matrix) and
// joint matrices (RotateSubClump; joints[i] applies before the local one).
export function clumpMatrices(model, world, pose = null, joints = null) {
  const out = new Array(model.clumps.length);
  const visit = (i, parentM) => {
    const c = model.clumps[i];
    const local = (pose && pose[i]) || c.local;
    out[i] = mul(joints && joints[i] ? mul(joints[i], local) : local, parentM);
    for (const k of c.children) visit(k, out[i]);
  };
  for (const r of model.roots) visit(r, world);
  return out;
}

// Axis-aligned bounds of the posed model in model space.
/** @param {any} [pose] */
export function modelBounds(model, pose = null) {
  const ms = clumpMatrices(model, identity(), pose);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = [0, 0, 0];
  model.clumps.forEach((c, i) => {
    const pos = c.mesh.positions;
    for (let k = 0; k < pos.length; k += 3) {
      transformPoint(ms[i], pos[k], pos[k + 1], pos[k + 2], p);
      for (let j = 0; j < 3; j++) { min[j] = Math.min(min[j], p[j]); max[j] = Math.max(max[j], p[j]); }
    }
  });
  return { min, max };
}
