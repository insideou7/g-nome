// Aim checks for every unit the player can drive (the debug panel's list):
// where the cockpit crosshair sits, where shots fly, and lock-on.
// Usage: node web/tests/aim-check.mjs [game/g-nome/G-NOME] [--verbose]
//
// For each vehicle and soldier it checks that
//   - the crosshair (sprite 562) is where the cockpit's HUD table puts it
//     (property 93, row kind 4, through scripts 1220 and 576), and that this
//     is within 12 pixels of the screen centre, the 3D view's centre of
//     projection (ViewportCrop keeps it there; see BattleCamera.screen);
//   - a shot fired straight ahead flies towards the screen centre (its
//     direction projects there), so far targets under the crosshair are hit;
//   - picking the mission 1 walker as the target (script 1230) acquires and
//     then locks it (G975, G974), and the crosshair shows the lock bracket.
// The crosshair sitting low in short cockpit windows is the original's:
// the scripts place it at the screen centre, not the window's.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { table } from "../src/builtins.js";
import { project } from "../src/battlefield/camera.js";
import { basisFromAt, add, scale, sub, normalize } from "../src/battlefield/math.js";

const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "game/g-nome/G-NOME";
const verbose = process.argv.includes("--verbose");
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`aim-check: no G-NOME.BIN in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}

const CROSSHAIR = 562;
const SHOT_UPDATE = 1734; // update script of every shot
const { Engine } = await import("../src/engine.js");
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (n) => names.has(n.toUpperCase()),
};
const e = new Engine(files, { log: () => {} });
await e.init();
e.boot();
const tick = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    e.tick(1000 / 30);
    await new Promise((r) => setImmediate(r));
  }
};
// Skip to mission 1, as combat-check does.
await tick(60);
for (const g of [2118, 2119]) e.vm.setGlobal(g, 1);
e.vm.setGlobal(982, 0);
e.run(8317);
await tick(240);
const w = e.world;
assert.ok(w?.shown, "mission 1 is running");
const prop = (id, p) => e.debug.prop(id, p);
const near = (o) => Math.hypot(o.pos[0] + 49.88, o.pos[2] + 12.38) < 1;
const walker = [...w.objects.values()].find((o) => near(o) && prop(o.id, 0) === 141)?.id;
assert.ok(walker, "found the mission 1 walker");

const failures = [];
const check = (ok, what) => ok || failures.push(what);
const units = [{ row: -1, name: "mission 1 soldier" }, ...(await e.debug.vehicles())];
for (const u of units) {
  if (u.row >= 0) {
    e.debug.swapVehicle(u.row);
    await tick(15);
  }
  const me = e.vm.getGlobal(973);
  const label = `${u.name} (class ${prop(me, 0)})`;

  // The crosshair against the HUD table.
  const hud = table(e.vm, prop(me, 93))?.data || [];
  let want = null;
  for (let i = 0; i < hud.length; i += 8) if (hud[i] === 4) want = [hud[i + 1] - 320, hud[i + 2] - 240];
  const s = e.sprites.list.get(CROSSHAIR);
  check(want && s?.visible && s.x === want[0] && s.y === want[1], `${label}: crosshair at its HUD position ${want}, drawn at ${s?.x},${s?.y}`);
  check(want && Math.abs(want[0]) <= 12 && Math.abs(want[1]) <= 12, `${label}: crosshair ${want} near the screen centre`);

  // Fire weapon 1 straight ahead on open ground and follow the shots.
  const o = w.get(me);
  o.setPosition([-30, 0, 40]);
  o.basis = basisFromAt([0, 0, 1]);
  e.vm.setGlobal(974, 0);
  e.vm.setGlobal(975, 0);
  await tick(5);
  const before = new Set(w.objects.keys());
  e.input.keyDown(49);
  await tick(2);
  e.input.keyUp(49);
  const paths = new Map();
  for (let k = 0; k < 12; k++) {
    await tick();
    for (const [id, ob] of w.objects) {
      if (before.has(id) || ob.updateScript !== SHOT_UPDATE) continue;
      if (!paths.has(id)) paths.set(id, []);
      paths.get(id).push([...ob.pos]);
    }
  }
  const pose = w.cameraPose(1);
  const aims = [...paths.values()].filter((p) => p.length >= 3).map((p) => {
    const dir = normalize(sub(p[p.length - 1], p[0]));
    return project(pose, w.camera.viewwindow, w.camera.screen(), add(pose.pos, scale(dir, 1e4)));
  });
  check(aims.length > 0, `${label}: weapon 1 fires`);
  for (const a of aims) check(Math.hypot(a.x, a.y) <= 8, `${label}: a shot flies towards ${a.x.toFixed(0)},${a.y.toFixed(0)}, not the screen centre`);
  await tick(30); // let the shots expire

  // Lock on to the walker from 8 units away.
  o.setPosition([-49.96, 0, -4]);
  o.basis = basisFromAt([0, 0, -1]);
  await tick(3);
  e.run(1230);
  let acquired = false, locked = -1;
  for (let i = 0; i < 120 && locked < 0; i++) {
    await tick();
    if (e.vm.getGlobal(975) === walker) acquired = true;
    if (e.vm.getGlobal(974) === walker) locked = i;
  }
  await tick(2);
  check(acquired && locked >= 0, `${label}: acquires and locks the walker (acquired ${acquired}, locked after ${locked} ticks)`);
  check(String(s?.layers) === "3,4", `${label}: the crosshair shows the lock bracket (layers ${s?.layers})`);
  if (verbose) console.log(`${label}: crosshair ${want}, shots ${aims.map((a) => `${a.x.toFixed(0)},${a.y.toFixed(0)}`).join(" ")}, locked after ${locked} ticks`);
}

if (failures.length) {
  console.log(failures.join("\n"));
  console.log(`aim checks: ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`aim checks passed for ${units.length} units`);
process.exit(0);
