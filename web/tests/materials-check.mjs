// Checks for the RenderWare 2.0 material and clump settings the model
// streams carry (render3d/model.js, soft.js): AxisAlignment (op 0x04),
// MaterialModes double (0x19) with back-face culling, and LightSampling
// vertex (0x16).
// Usage: node web/tests/materials-check.mjs [game/g-nome/G-NOME]
// With a game folder it also checks the real models that use them.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseModel, modelOps, alignClumps, clumpMatrices, AXIS_XYZ } from "../src/render3d/model.js";
import { Scene, Camera } from "../src/render3d/scene.js";
import { renderSoft, SoftTarget } from "../src/render3d/soft.js";
import { compose } from "../src/render3d/math.js";

const near = (/** @type {number} */ a, /** @type {number} */ b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// A model stream: "MODL", clump count, then ops as [code, ...args] with
// ints and floats told apart by Number.isInteger (floats are given as
// non-integers or as {f: value}).
/**
 * @param {any[][]} ops
 */
function stream(ops) {
  const words = [0x4c444f4d, 0];
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  for (const [code, ...args] of ops) {
    words.push(code);
    for (const a of args) {
      if (typeof a === "object") { f32[0] = a.f; words.push(u32[0]); }
      else words.push(a | 0);
    }
  }
  return new Uint8Array(new Uint32Array(words).buffer);
}
const F = (/** @type {number} */ v) => ({ f: v });
const vertex = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => [0x3b, F(x), F(y), F(z)];

// One quad in the z = 0 plane whose normal (B - A) x (C - A) is +Z, with
// the given material and clump settings.
/**
 * @param {any[][]} settings
 */
function quad(settings) {
  return parseModel(stream([
    [0x1a], [0x06], ...settings,
    vertex(-1, -1, 0), vertex(1, -1, 0), vertex(1, 1, 0), vertex(-1, 1, 0),
    [0x14], [0x23, 1, 2, 3, 4], [0x07], [0x1b],
  ]));
}

// Pixels drawn for `model` seen from `pos` looking at the origin.
/**
 * @param {any} model
 * @param {number[]} pos
 */
function covered(model, pos, setup = (/** @type {any} */ _n) => {}) {
  const scene = new Scene();
  const node = scene.add(model, {});
  setup(node);
  const cam = new Camera();
  cam.position = pos;
  const l = Math.hypot(pos[0], pos[1], pos[2]);
  cam.at = pos.map((v) => -v / l);
  cam.up = Math.abs(cam.at[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const t = renderSoft(scene, cam, new SoftTarget(32, 32), { textureOf: () => null, rgbaOf: () => new Uint8Array(0) });
  let n = 0;
  for (let i = 3; i < t.rgba.length; i += 4) if (t.rgba[i]) n++;
  return n;
}

// The ops parse into named settings.
{
  const names = modelOps(stream([[0x04, 4], [0x0d, 4], [0x0f, 6], [0x16, 2], [0x19, 8]])).map((o) => o[0]);
  assert.deepEqual(names, ["axisalignment", "geometrysampling", "hints", "lightsampling", "materialmodes"]);
  const m = quad([[0x0f, 2], [0x04, 4], [0x16, 2], [0x19, 8]]);
  assert.equal(m.clumps[0].axisAlignment, AXIS_XYZ);
  assert.equal(m.clumps[0].hints, 2);
  const mat = m.clumps[0].mesh.groups[0].material;
  assert.equal(mat.lightSampling, 2);
  assert.equal(mat.materialModes, 8);
  // Defaults: facet lighting, solid, single-sided.
  const d = quad([]).clumps[0].mesh.groups[0].material;
  assert.deepEqual([d.lightSampling, d.geometrySampling, d.materialModes], [1, 4, 0]);
}

// Back faces are skipped unless the material is double or the clump was
// made double-sided (SetObjDoubleface).
{
  const single = quad([]);
  assert.ok(covered(single, [0, 0, 3]) > 100, "the front face draws");
  assert.equal(covered(single, [0, 0, -3]), 0, "the back face is culled");
  assert.ok(covered(quad([[0x19, 8]]), [0, 0, -3]) > 100, "a double material draws from behind");
  assert.ok(covered(single, [0, 0, -3], (n) => { n.doubleSided[0] = true; }) > 100, "SetObjDoubleface draws from behind");
}

// AxisAlignment XYZ turns the clump to face the camera wherever the model
// points: X to screen right, Y to the camera's up, Z back at the camera,
// keeping the X and Y lengths and the position.
{
  const sprite = quad([[0x04, 4]]);
  const plain = quad([]);
  const turned = (/** @type {any} */ n) => { n.matrix = compose({ position: [0, 0, 0], yaw: 90, pitch: 0, roll: 0 }); };
  assert.equal(covered(plain, [0, 0, 3], turned), 0, "a plain quad turned 90 degrees is edge-on");
  const seen = covered(sprite, [0, 0, 3], turned);
  assert.ok(seen > 100, "the aligned quad still faces the camera");
  assert.equal(covered(sprite, [0, 0, -3]), seen, "from behind too, without a double material");

  const cam = new Camera();
  cam.position = [1, 2, 3];
  cam.at = [0, -0.6, -0.8];
  cam.up = [0, 0.8, -0.6];
  const c = cam.cameraToWorld();
  const world = compose({ position: [5, 6, 7], yaw: 30, pitch: 10, roll: 0 });
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) world[i * 4 + j] *= [2, 3, 4][i];
  const [w] = alignClumps(sprite, clumpMatrices(sprite, world), c);
  for (let j = 0; j < 3; j++) {
    near(w[j], -c[j] * 2);
    near(w[4 + j], c[4 + j] * 3);
    near(w[8 + j], -c[8 + j]);
    near(w[12 + j], world[12 + j]);
  }
  // Clumps without it keep their matrix.
  const [p] = alignClumps(plain, clumpMatrices(plain, world), c);
  assert.deepEqual([...p], [...world]);
}

// LightSampling vertex: each vertex normal is the mean of the faces around
// it; facet keeps the face normal.
{
  // Two triangles folded along the x = 0 edge, like a roof.
  const roof = (/** @type {number} */ ls) => parseModel(stream([
    [0x1a], [0x06], [0x16, ls],
    vertex(-1, 0, -1), vertex(0, 1, -1), vertex(0, 1, 1), vertex(-1, 0, 1), vertex(1, 0, 1), vertex(1, 0, -1),
    [0x14], [0x39, 1, 2, 3], [0x39, 3, 2, 6], [0x39, 5, 3, 6], [0x07], [0x1b],
  ])).clumps[0].mesh;
  const facet = roof(1), smooth = roof(2);
  // Vertex 2 (0, 1, -1) is shared by the two sides: its smoothed normal
  // is their bisector, along Y.
  const ny = (/** @type {any} */ m, /** @type {number} */ v) => [m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]];
  const a = ny(facet, 1), b = ny(smooth, 1);
  near(Math.abs(a[0]), Math.SQRT1_2);
  near(Math.abs(b[1]), 1);
  near(b[0], 0);
  near(Math.hypot(b[0], b[1], b[2]), 1);
}
console.log("materials-check: ok");

// Real models: the settings the 801 models use.
const dir = process.argv[2] || "game/g-nome/G-NOME";
if (existsSync(join(dir, "G-NOME.BIN"))) {
  const { BinFile } = await import("../src/binfile.js");
  const bin = new BinFile(readFileSync(join(dir, "G-NOME.BIN")), async (n) => readFileSync(join(dir, `G-NOME.${String(n).padStart(3, "0")}`)));
  const aligned = [], sampling = new Set(), double = [], smooth = [];
  for (let id = 0; id < bin.count; id++) {
    const t = bin.type(id);
    if (t !== 7 && t !== 8) continue;
    const m = parseModel(await bin.load(id));
    if (m.clumps.some((/** @type {any} */ c) => c.axisAlignment === AXIS_XYZ)) aligned.push(id);
    const mats = m.clumps.flatMap((/** @type {any} */ c) => c.mesh.groups.map((/** @type {any} */ g) => g.material));
    for (const x of mats) sampling.add(x.geometrySampling);
    if (mats.some((/** @type {any} */ x) => x.materialModes & 8)) double.push(id);
    if (mats.some((/** @type {any} */ x) => x.lightSampling === 2)) smooth.push(id);
  }
  // The explosion, shot and smoke sprites: 1246-1255, 1796-1876, 2532, 2535.
  assert.equal(aligned.length, 29, `aligned: ${aligned}`);
  assert.ok(aligned.includes(1796) && aligned.includes(1246) && aligned.includes(2535));
  assert.deepEqual([...sampling], [4], "every material is solid");
  assert.deepEqual(smooth, [3852, 5895]);
  assert.ok(double.length > 200, `${double.length} models have a double material`);

  // Ground tile 2398 is single-sided and faces up: seen from above, not
  // from below.
  const tile = parseModel(await bin.load(2398));
  assert.ok(covered(tile, [0.5, 6, 0.5]) > 500, "the ground tile draws from above");
  assert.equal(covered(tile, [0.5, -6, 0.5]), 0, "and not from below");
  // Explosion 1796 faces the camera when its object is turned edge-on.
  const boom = parseModel(await bin.load(1796));
  assert.ok(covered(boom, [0, 0, 0.5], (n) => { n.matrix = compose({ position: [0, 0, 0], yaw: 90, pitch: 0, roll: 0 }); }) > 300, "explosion 1796 faces the camera");
  console.log(`materials-check: ok (with game files: ${aligned.length} camera-facing sprites, ${double.length} models with double materials)`);
}
