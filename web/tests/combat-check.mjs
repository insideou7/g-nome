// Checks for the weapon and damage externs (web/src/combat/).
// Usage: node web/tests/combat-check.mjs [game/g-nome/G-NOME]
// Without a game folder only the geometry runs; with one it starts mission
// 1 headless, puts the player 8 units from the walker in front of it, taps
// fire (key 1) and checks that shots recharge, hit, and blow the walker apart.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { segmentHitsBox } from "../src/combat/damage.js";

const box = { lo: [0, 0, 0], hi: [1, 1, 1] };
assert.ok(segmentHitsBox([-1, 0.5, 0.5], [2, 0.5, 0.5], box), "through the box");
assert.ok(segmentHitsBox([0.5, 0.5, 0.5], [0.6, 0.5, 0.5], box), "inside the box");
assert.ok(!segmentHitsBox([-1, 2, 0.5], [2, 2, 0.5], box), "above the box");
assert.ok(!segmentHitsBox([-2, 0.5, 0.5], [-1, 0.5, 0.5], box), "short of the box");

const dir = process.argv[2];
if (dir && existsSync(dir)) {
  const { Engine } = await import("../src/engine.js");
  const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  const files = {
    read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
    has: (n) => names.has(n.toUpperCase()),
  };
  const e = new Engine(files, { log: () => {} });
  await e.init();
  const seen = new Map();
  const run = e.vm.runScript.bind(e.vm);
  e.vm.runScript = (id) => {
    seen.set(id, (seen.get(id) || 0) + 1);
    return run(id);
  };
  e.boot();
  const WALKER = 9565; // a class 141 walker 13 units ahead of the player
  let dead = 0;
  for (let i = 0; i < 1600 && !(dead && i > dead + 10); i++) {
    if (i === 60) {
      for (const g of [2118, 2119]) e.vm.setGlobal(g, 1);
      e.vm.setGlobal(982, 0);
      e.run(8317);
    }
    if (i === 290) e.world.get(e.vm.getGlobal(973)).setPosition([-49.96, 0, -4]);
    if (i >= 300 && i % 45 === 0) e.input.keyDown(49);
    if (i >= 300 && i % 45 === 2) e.input.keyUp(49);
    e.tick(1000 / 30);
    await new Promise((r) => setImmediate(r));
    if (i > 300 && !dead && !e.world.get(WALKER)) dead = i;
  }
  const n = (id) => seen.get(id) || 0;
  assert.ok(n(1734) > 0, "shots fly (update script 1734)");
  assert.ok(n(1681) > 0, "weapons recharge (script 1681)");
  assert.ok(n(1709) > 0, "shots damage the walker (script 1709)");
  assert.ok(dead, "the walker is destroyed");
  assert.ok(n(1731) > 0, "its pieces fly (script 1731)");
  const missing = [...e.vm.unknown.keys()].filter((k) => /Projectile|Recharge|Explode|Amputate|CollisionClump|AnimTex/.test(k));
  assert.deepEqual(missing, []);
  console.log(`mission 1: walker destroyed at tick ${dead} after ${n(1709)} hits`);
}
console.log("combat checks passed");
