// Aim assist check on mission 2's first guards (Pinky found them hard to
// kill). The player, a soldier on foot, stands 3 units from guard G173[1]
// facing its middle and taps fire once a second. A soldier's bolt leaves
// ~0.03 units to the side of the view line and the guard is ~0.05 wide, so
// without aim assist (the original's straight shots) nearly every shot
// passes beside it; with aim assist on, the shots hit and the guard dies.
// Usage: node web/tests/aim-assist-check.mjs [game/g-nome/G-NOME]
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine.js";

const dir = process.argv[2] || "game/g-nome/G-NOME";
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (n) => names.has(n.toUpperCase()),
};

async function duel(assist) {
  let seed = 1;
  const random = Math.random;
  Math.random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  try {
    const e = new Engine(files, { log: () => {} });
    await e.init();
    e.boot();
    e.debug.aimAssist = assist;
    const vm = e.vm, w = e.world;
    const tick = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        e.tick(1000 / 30);
        await new Promise((r) => setImmediate(r));
      }
    };
    // Skip the opening movie, then start mission 2 on easy.
    for (let i = 0; i < 60 && !e.plugins.some((p) => p.ownsScreen); i++) await tick();
    e.input.keyDown(0x1b);
    e.input.keyUp(0x1b);
    for (let i = 0; i < 150 && !e.clickRects.some((r) => !r.off && r.script === 8344); i++) await tick();
    await tick(30);
    vm.setGlobal(2114, 0);
    for (const g of [2118, 2119]) vm.setGlobal(g, 2);
    vm.setGlobal(982, 0);
    e.run(8317);
    await tick(60);
    const me = vm.getGlobal(973), guard = vm.getGlobal(174);
    assert.ok(w.get(me) && w.get(guard), "mission 2: the player and guard G173[1]");
    let hits = 0;
    const call = vm.callScript.bind(vm);
    vm.callScript = (s, n, a) => {
      if (s === 1709 && a[0] === guard) hits++;
      return call(s, n, a);
    };
    const o = w.get(me), t = w.get(guard);
    o.setPosition([t.pos[0] - 3, o.pos[1], t.pos[2]]);
    o.tickPos = o.pos.slice();
    let shots = 0, dead = 0;
    for (let i = 0; i < 600 && !dead; i++) {
      const a = w.get(me), b = w.get(guard);
      if (!b) dead = i || 1;
      if (!a || !b) break;
      const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2], d = Math.hypot(dx, dz);
      a.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
      a.tickBasis = a.basis;
      if (i % 30 === 0) {
        e.input.keyDown(0x31);
        shots++;
      } else if (i % 30 === 2) e.input.keyUp(0x31);
      await tick();
    }
    return { hits, shots, dead };
  } finally {
    Math.random = random;
  }
}

const off = await duel(false);
console.log(`aim assist off: ${off.hits} hits from ${off.shots} shots${off.dead ? ", guard killed" : ""}`);
assert.ok(off.hits <= off.shots / 3, "without aim assist most shots pass beside the guard, as in the original");
const on = await duel(true);
console.log(`aim assist on: ${on.hits} hits from ${on.shots} shots${on.dead ? ", guard killed" : ""}`);
assert.ok(on.dead, "with aim assist the guard dies");
assert.ok(on.hits >= on.shots - 2, "with aim assist the shots hit");
console.log("aim assist checks passed");
