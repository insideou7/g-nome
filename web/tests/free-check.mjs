// Checks UncachePack (builtin 0xf2) and render.FreeAllTextures: they drop
// what was decoded (models, textures, bitmaps, sounds, animation clips) and
// a model drawn again afterwards looks the same as before. Then missions
// 1, 19 and 1 again, to see the caches do not grow between missions.
// Usage: node web/tests/free-check.mjs [game/g-nome/G-NOME]
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Player } from "./player.mjs";

const dir = process.argv[2] || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`free-check: no G-NOME.BIN in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}
const p = await Player.start(dir);
const e = p.engine;
const { bin } = e;
const r3d = e.render3d;
const r = r3d.renderer;
const render = e.plugins.find((x) => x.name === "render");
const ext = render.externs;

// The first textured model in a pack other than 0 and 1, which UncachePack
// can be asked to drop (the scripts only drop packs 2..99).
let id = 0;
for (let i = 0; i < bin.count && !id; i++) {
  const t = bin.type(i);
  if ((t !== 7 && t !== 8) || bin.pack(i) < 2) continue;
  const m = r.loadModel(i);
  if (m?.clumps.some((c) => c.mesh.groups.some((g) => g.material.texture))) id = i;
}
assert.ok(id, "a textured model outside packs 0 and 1");
const pack = bin.pack(id);
const model = r.loadModel(id);

const firstOf = (type, inPack) => {
  for (let i = 0; i < bin.count; i++) if (bin.type(i) === type && inPack(bin.pack(i))) return i;
  return 0;
};
function draw() {
  const out = r.renderPreview(model, { width: 96, height: 72 });
  return Buffer.from(out.rgba).toString("base64");
}
const before = draw();
assert.ok(r.textures.byName.size > 0, "drawing the model decoded its textures");

// FreeAllTextures: every texture goes, and like the original's RenderWare
// restart every model and object too. A model kept by the caller still
// draws the same.
r3d.instance(id);
r3d.objects.get(firstOf(9, () => true));
assert.equal(ext.FreeAllTextures(), 0);
assert.equal(r.textures.byName.size + r.textures.byRes.size, 0, "textures freed");
assert.equal(r.models.size + r3d.instances.size + r3d.objects.records.size, 0, "models and objects freed");
assert.equal(draw(), before, "same picture after FreeAllTextures");

// UncachePack: decode a model, a bitmap, a sound and a clip from that pack
// and one from pack 0, then drop the pack.
const bmp = firstOf(1, (n) => n === pack), bmp0 = firstOf(1, (n) => n === 0);
const wav = firstOf(12, (n) => n === pack);
const frme = firstOf(4, (n) => n === pack);
if (bmp) e.sprites.bitmap(bmp);
e.sprites.bitmap(bmp0);
if (wav) render.sound(wav);
if (frme) e.animation.frme(frme);
draw();
const copy = e.copyResource(id); // copies count as their source's pack
r.loadModel(copy);
e.vm.builtins.get(0xf2)(e.vm, [pack]);
assert.ok(!r.models.has(id), "model dropped");
assert.ok(![...r.textures.byName.keys()].some((k) => k.startsWith(`${id + 1}:`)), "its textures dropped");
if (bmp) assert.ok(!e.sprites.bitmaps.has(bmp), "bitmap dropped");
assert.ok(e.sprites.bitmaps.has(bmp0), "pack 0 bitmap kept");
if (wav) assert.ok(!render.cache.has(wav), "sound dropped");
if (frme) assert.ok(!e.animation.frmes.has(frme), "clip dropped");
// Loaded again on demand.
const again = r.loadModel(id);
assert.ok(again && again !== model, "model parsed again");
assert.equal(Buffer.from(r.renderPreview(again, { width: 96, height: 72 }).rgba).toString("base64"), before, "same picture after UncachePack");
assert.deepEqual(p.errors, []);

// Missions 1, 19 and 1 again: winning each drops the mission's packs
// (UncachePack), so the caches do not grow from one mission to the next.
let uncached = 0;
const f2 = e.vm.builtins.get(0xf2);
e.vm.builtins.set(0xf2, (vm, a) => (uncached++, f2(vm, a)));
const sizes = () => [r.models.size, r3d.instances.size, r3d.objects.records.size, r.textures.byName.size].join("/");
const seen = [];
await p.wait(60); // past the opening movie
for (const m of [1, 19, 1]) {
  e.debug.startMission(m, -1);
  await p.waitFor(() => e.world?.shown, `mission ${m}`, 300);
  await p.wait(60);
  seen.push(sizes());
  e.mission.destroyEnemies();
  await p.waitFor(() => !e.world?.shown, `the end of mission ${m}`, 900);
  await p.wait(30);
}
assert.ok(uncached > 0, "winning a mission runs UncachePack");
assert.equal(seen[2], seen[0], `mission 1 holds as much the second time (models/instances/objects/textures ${seen.join(" ")})`);
assert.deepEqual(p.errors, []);
assert.ok(![...e.vm.unknown.keys()].some((k) => /0xf2|FreeAllTextures/.test(k)));
console.log(`free-check: missions 1, 19, 1: ${uncached} packs dropped, caches ${seen.join(" -> ")}`);
console.log(`free-check: ok (model ${id} in pack ${pack}${bmp ? `, bitmap ${bmp}` : ""}${wav ? `, sound ${wav}` : ""}${frme ? `, clip ${frme}` : ""})`);
