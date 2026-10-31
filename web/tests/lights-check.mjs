// Checks for RenderWare 2.0 lighting (render3d/scene.js) and the Light*
// externs (render3d/lights.js).
// Usage: node web/tests/lights-check.mjs [game/g-nome/G-NOME]
// With a game folder it also checks the model surface ops on real models.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Scene, Camera, meshModel, materialLight, activeLights, addLights } from "../src/render3d/scene.js";
import { renderSoft, SoftTarget } from "../src/render3d/soft.js";
import { Lights } from "../src/render3d/lights.js";

const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// A material's lit level is its ambient coefficient when there are no
// lights; a texture without TextureModes is lit, TextureModes 2 is not.
{
  const m = materialLight({ ambient: 0.74, diffuse: 0.2, specular: 0.2 }, true);
  assert.equal(m.unlit, false);
  near(m.ka, 0.74);
  assert.equal(materialLight({ ambient: 0.7, textureModes: 2 }, true).unlit, true);
  assert.equal(materialLight({ ambient: 0.7, textureModes: 2 }, false).unlit, false);
}

// Directional light straight on: diffuse plus the (N.L)^16 specular term.
{
  const lights = activeLights({ lights: [{ type: "directional", color: [1, 1, 1], direction: [0, 0, -1] }] });
  const out = addLights([0.1, 0.1, 0.1], lights, [0, 0, 1], [0, 0, 0], 0.5, 0.25, false);
  near(out[0], 0.1 + 0.5 + 0.25);
  // From behind: nothing, unless two-sided.
  assert.deepEqual(addLights([0, 0, 0], lights, [0, 0, -1], [0, 0, 0], 0.5, 0, false), [0, 0, 0]);
  near(addLights([0, 0, 0], lights, [0, 0, -1], [0, 0, 0], 0.5, 0, true)[0], 0.5);
  // A light that is off is left out.
  assert.equal(activeLights({ lights: [{ type: "point", color: [1, 1, 1], on: false }] }).length, 0);
}

// Point light: N.L from the light's position, nothing past the radius.
{
  const lights = activeLights({ lights: [{ type: "point", color: [1, 0, 0], position: [0, 0, 2], radius: 3 }] });
  near(addLights([0, 0, 0], lights, [0, 0, 1], [0, 0, 0], 1, 0, false)[0], 1);
  assert.equal(addLights([0, 0, 0], lights, [0, 0, 1], [0, 0, -2], 1, 0, false)[0], 0);
}

// Externs: slots, defaults and script units.
{
  const L = new Lights({});
  const x = L.externs();
  assert.equal(x.LightAddPoint(), -1, "no slots before AllocLights");
  x.AllocLights(2);
  assert.equal(x.LightAddDirectional(), 0);
  assert.equal(x.LightAddPoint(), 1);
  assert.equal(x.LightAddConical(), -1, "table full");
  x.LightSetColor(0, 255, 128, 0);
  near(L.get(0).color[1], 128 / 255);
  x.LightSetBrightness(1, 50);
  assert.deepEqual(L.get(1).color, [0.5, 0.5, 0.5]);
  x.LightSetPosition(1, 100, 200, -300);
  assert.deepEqual(L.get(1).position, [1, 2, -3]);
  x.LightSetVector(0, 0, 0, 0); // refused, as RenderWare does
  assert.deepEqual(L.get(0).direction, [0, 0, 1]);
  x.LightSetState(1, 0);
  assert.equal(L.get(1).on, false);
  x.LightSetState(1, 7); // not 0 or 1: unchanged
  assert.equal(L.get(1).on, false);
  assert.equal(L.list().length, 2);
}

// Software render of a quad facing the camera: ambient alone, then lit.
{
  const quad = meshModel({
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
    indices: [0, 1, 2, 0, 2, 3],
    groups: [{ start: 0, count: 6, material: { color: [1, 1, 1], ambient: 0.5, diffuse: 0.5 } }],
  });
  const scene = new Scene();
  scene.add(quad, { position: [0, 0, 3] });
  const cam = new Camera();
  const centre = () => {
    const t = renderSoft(scene, cam, new SoftTarget(16, 16), { textureOf: () => null, rgbaOf: () => null });
    return t.rgba[(8 * 16 + 8) * 4];
  };
  near(centre(), 0.5 * 255, 2);
  scene.lights = [{ type: "directional", color: [1, 1, 1], direction: [0, 0, 1] }];
  near(centre(), 255, 2);
}

// Real models: op 0x2C is the surface and op 0x08 the colour.
const dir = process.argv[2] || "game/g-nome/G-NOME";
if (existsSync(join(dir, "G-NOME.BIN"))) {
  const { BinFile } = await import("../src/binfile.js");
  const { parseModel } = await import("../src/render3d/model.js");
  const bin = new BinFile(readFileSync(join(dir, "G-NOME.BIN")), async (n) => readFileSync(join(dir, `G-NOME.${String(n).padStart(3, "0")}`)));
  // 2404: a far ground tile (lit), 2398: a near one (TextureModes 2).
  for (const [id, lit] of [[2404, true], [2398, false]]) {
    const m = parseModel(await bin.load(id));
    const mat = m.clumps.flatMap((c) => c.mesh.groups).find((g) => g.material.texture).material;
    near(mat.ambient, 0.7, 0.01);
    assert.deepEqual(mat.color, [0, 0, 0]);
    assert.equal(materialLight(mat, true).unlit, !lit);
  }
  console.log("lights-check: ok (with game files)");
} else console.log("lights-check: ok");
