// Parse every model (MODL type 7, MPRT type 8) and look for untextured
// polygons that would draw black: a material with no texture whose colour is
// 0 0 0 or whose surface has no ambient and no diffuse light, and which is
// not invisible (opacity 0). The 15 models with an untextured colour 0 0 0
// material (2813, 2815, 3033, 3035, 3072-3084, 3350, 3352, 3619, 3621) use
// it only on one tagged marker clump with opacity 0, which neither backend
// draws, so the expected result is none.
// It also checks that the 29 camera-facing sprites (axis alignment 4, such
// as explosion 1796) turn to face a camera seen from the side.
// Usage: node web/tests/models-check.mjs game/g-nome/G-NOME
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BinFile } from "../src/binfile.js";
import { parseModel, clumpMatrices } from "../src/render3d/model.js";
import { identity, rotY } from "../src/render3d/math.js";

const dir = process.argv[2] || "game/g-nome/G-NOME";
const bin = new BinFile(new Uint8Array(readFileSync(join(dir, "G-NOME.BIN"))), null);
const packs = new Map();
let models = 0, failed = 0, hidden = 0, facing = 0, badFacing = 0;
const camera = rotY(90); // looking along world +X
const black = [];
for (let id = 0; id < bin.count; id++) {
  const t = bin.type(id);
  if (t !== 7 && t !== 8) continue;
  const n = bin.pack(id);
  if (!packs.has(n)) packs.set(n, new Uint8Array(readFileSync(join(dir, `G-NOME.${String(n).padStart(3, "0")}`))));
  const bytes = packs.get(n).subarray(bin.offsets[id], bin.offsets[id] + bin.sizes[id]);
  let m;
  try {
    m = parseModel(bytes);
  } catch (e) {
    if (failed++ < 5) console.log(`model ${id}: ${e.message}`);
    continue;
  }
  models++;
  m.clumps.forEach((c, i) => {
    if (c.align !== 4) return;
    facing++;
    // A sprite's quad lies in its x/y plane: its z row must become the
    // camera's view direction (row 2 of the camera matrix).
    const w = clumpMatrices(m, identity(), null, null, camera)[i];
    if (Math.abs(w[8] - camera[8]) + Math.abs(w[9] - camera[9]) + Math.abs(w[10] - camera[10]) > 1e-5) badFacing++;
  });
  let dark = false, darkHidden = false;
  for (const c of m.clumps) {
    for (const g of c.mesh.groups) {
      const x = g.material;
      if (x.texture) continue;
      const noLight = (x.ambient ?? 0.3) + (x.diffuse ?? 0.7) <= 0 || x.color.every((v) => v <= 0);
      if (!noLight) continue;
      // Same cut-off as soft.js and webgl.js.
      if ((x.opacity ?? 1) <= 0.01) darkHidden = true;
      else dark = true;
    }
  }
  if (dark) black.push(id);
  else if (darkHidden) hidden++;
}
console.log(`${models} models parsed, ${failed} failed`);
console.log(`${hidden} models have untextured unlit polygons, all with opacity 0 (not drawn)`);
console.log(`${facing} clumps face the camera (axis alignment 4), ${badFacing} wrong`);
console.log(`${black.length} models have visible untextured polygons that draw black${black.length ? ": " + black.join(", ") : ""}`);
process.exit(failed || black.length || badFacing || facing !== 29 ? 1 : 0);
