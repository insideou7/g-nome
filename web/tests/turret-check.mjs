// Mission 10 (2-5 Citadel Approach) turret check. Pinky could not damage
// the turrets. They do take damage; they are just tough: the base part
// (health and armour 412 each, from DefaultClumpHealths) soaks a machine
// gun bolt's 7 points, and the bolts only fly ~7.5 units. The player's
// missiles (key 1) kill one in about 20 hits from 10 units. This also
// checks the part healths come from the clump's world box (RwGetClumpBBox),
// not its local one.
// Usage: node web/tests/turret-check.mjs [game/g-nome/G-NOME]
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { BUILTINS } from "../src/builtins.js";

const dir = process.argv[2] || "game/g-nome/G-NOME";
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (n) => names.has(n.toUpperCase()),
};

let seed = 1;
Math.random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const e = new Engine(files, { log: () => {} });
await e.init();
e.boot();
const vm = e.vm, w = e.world;
const prop = (id, n) => e.render3d.objects.getProperty(id, n);
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    e.tick(1000 / 30);
    await new Promise((r) => setImmediate(r));
  }
};
// Skip the opening movie, then start mission 10.
for (let i = 0; i < 60 && !e.plugins.some((p) => p.ownsScreen); i++) await tick();
e.input.keyDown(0x1b);
e.input.keyUp(0x1b);
for (let i = 0; i < 150 && !e.clickRects.some((r) => !r.off && r.script === 8344); i++) await tick();
await tick(30);
for (const g of [2118, 2119]) vm.setGlobal(g, 10);
vm.setGlobal(982, 0);
e.run(8317);
await tick(60);

const me = vm.getGlobal(973), turret = vm.getGlobal(265); // G263[2]
assert.ok(w.get(me) && w.get(turret), "mission 10: the player and turret G263[2]");
assert.equal(prop(turret, 0), 221, "G263[2] is a turret (class 221)");
// Part health table (property 85): columns 1 armour, 3 health.
const table = prop(turret, 85);
const health = [1, 2, 3].map((k) => BUILTINS[0x52](vm, [table, k, 3]));
console.log(`turret part healths ${health.join(", ")}`);
assert.deepEqual(health, [98, 147, 412], "part healths from the world boxes (the base was 288 from its local box)");

let hits = 0, destroyed = false;
const call = vm.callScript.bind(vm);
vm.callScript = (s, n, a) => {
  if (s === 1709 && a[0] === turret) hits++;
  if (s === 2278 && a[0] === turret) destroyed = true;
  return call(s, n, a);
};
// 10 units north of it, facing it, invulnerable, tapping key 1 (missiles).
const o = w.get(me), t = w.get(turret);
o.setPosition([t.pos[0], o.pos[1], t.pos[2] + 10]);
o.tickPos = o.pos.slice();
o.basis = { at: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0] };
o.tickBasis = o.basis;
for (let i = 0; i < 1800 && !destroyed; i++) {
  e.render3d.objects.setProperty(me, 140, 1);
  if (i % 30 === 0) e.input.keyDown(0x31);
  else if (i % 30 === 2) e.input.keyUp(0x31);
  await tick();
}
console.log(`turret ${destroyed ? "destroyed" : "still standing"} after ${hits} hits`);
assert.ok(destroyed, "missiles destroy the turret");
assert.equal(prop(turret, 0), 270, "it turns into a wreck (class 270)");
console.log("turret checks passed");
