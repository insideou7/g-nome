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
//   - the same after pitching with the Up arrow ("Pitch Down") and the Down
//     arrow ("Pitch Up"): the view and the guns tilt the same way;
//   - from 4 units away, with the view pitched onto the mission 1 walker's
//     body, a shot hits it, unless the unit's guns sit wider apart than the
//     walker (shots fly parallel from the muzzles, as in the original);
//   - picking the mission 1 walker as the target (script 1230) acquires and
//     then locks it (G975, G974), and the crosshair shows the lock bracket.
// The crosshair sitting low in short cockpit windows is the original's:
// the scripts place it at the screen centre, not the window's.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { table } from "../src/builtins.js";
import { project } from "../src/battlefield/camera.js";
import { basisFromAt, add, scale, sub, normalize, dot } from "../src/battlefield/math.js";

const dir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "game/g-nome/G-NOME";
const verbose = process.argv.includes("--verbose");
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`aim-check: no G-NOME.BIN in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}

const CROSSHAIR = 562;
const SHOT_UPDATE = 1734; // update script of every shot
const WALKER_HALF_WIDTH = 0.15; // the mission 1 walker's body, x/z
const { Engine } = await import("../src/engine.js");
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (n) => names.has(n.toUpperCase()),
};
const e = new Engine(files, { log: () => {} });
await e.init();
let hits = 0; // script 1709: a shot damages a unit
const runScript = e.vm.runScript.bind(e.vm);
e.vm.runScript = (id) => {
  if (id === 1709) hits++;
  return runScript(id);
};
e.boot();
// The guns' pitch, hundredths of a degree, positive down (property 27),
// applied to the gun clumps and the camera as the pitch keys do.
// Wait (up to 10 s) until weapon 1 has recharged: column 5 of the unit's
// weapon table (property 66) counts down to 0 (script 1682 checks it).
const recharged = async (id) => {
  for (let i = 0; i < 300; i++) {
    const t = table(e.vm, e.debug.prop(id, 66));
    if (!t || !t.data[5]) return;
    await tick();
  }
};
const setPitch = (id, a) => {
  e.callScript(2076, [id, a]);
  e.callScript(2077, [id]);
};
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

  // Fire weapon 1 on open ground, level and pitched both ways, and follow
  // the shots.
  const o = w.get(me);
  const aimed = [];
  let spread = 0; // widest muzzle offset to the side of the camera
  for (const key of [0, 38, 40]) {
    o.setPosition([-30, 0, 40]);
    o.basis = basisFromAt([0, 0, 1]);
    setPitch(me, 0);
    e.vm.setGlobal(974, 0);
    e.vm.setGlobal(975, 0);
    await tick(5);
    if (key) {
      e.input.keyDown(key);
      await tick(6);
      e.input.keyUp(key);
      await tick(2);
    }
    // Each shot's position and direction when first seen (pitched down,
    // the shots soon hit the ground).
    await recharged(me);
    const before = new Set(w.objects.keys());
    const shots = new Map();
    for (let k = 0; k < 4; k++) {
      if (k === 0) e.input.keyDown(49);
      if (k === 2) e.input.keyUp(49);
      await tick();
      for (const [id, ob] of w.objects) {
        if (before.has(id) || ob.updateScript !== SHOT_UPDATE || shots.has(id)) continue;
        shots.set(id, { pos: [...ob.pos], dir: normalize(ob.basis.at) });
      }
    }
    const pose = w.cameraPose(1);
    const how = ["level", "after Up (pitch down)", "after Down (pitch up)"][[0, 38, 40].indexOf(key)];
    const pitch = prop(me, 27);
    if (key) check(key === 38 ? pitch > 0 : pitch < 0, `${label}: ${how} the guns' pitch (property 27) is ${pitch}`);
    const aims = [...shots.values()].map((p) => {
      if (!key) spread = Math.max(spread, Math.abs(dot(sub(p.pos, pose.pos), pose.right)));
      return project(pose, w.camera.viewwindow, w.camera.screen(), add(pose.pos, scale(p.dir, 1e4)));
    });
    check(aims.length > 0, `${label}: weapon 1 fires ${how}`);
    for (const a of aims) check(Math.hypot(a.x, a.y) <= 12, `${label}: ${how}, a shot flies towards ${a.x.toFixed(0)},${a.y.toFixed(0)}, not the screen centre`);
    aimed.push(`${how} ${aims.map((a) => `${a.x.toFixed(0)},${a.y.toFixed(0)}`).join(" ")}`);
    await tick(30); // let the shots expire
  }
  setPitch(me, 0);

  // Up close: 4 units from the walker, pitch the view onto its body (script
  // 2076 sets property 27, 2077 turns the guns and the camera) and fire.
  const tp = w.get(walker).pos;
  o.setPosition([tp[0], 0, tp[2] + 4]);
  o.basis = basisFromAt([0, 0, -1]);
  await tick(3);
  // line the camera (not the unit's centre) up with the walker
  const side = w.cameraPose(1).pos[0] - tp[0];
  o.setPosition([tp[0] - side, 0, tp[2] + 4]);
  await tick(2);
  const body = [tp[0], 0.33, tp[2]];
  const cam = w.cameraPose(1).pos;
  setPitch(me, Math.round((Math.atan2(cam[1] - body[1], Math.hypot(cam[0] - body[0], cam[2] - body[2])) * 18000) / Math.PI));
  await tick(2);
  const onScreen = project(w.cameraPose(1), w.camera.viewwindow, w.camera.screen(), body);
  check(Math.abs(onScreen.x) <= 12 && Math.abs(onScreen.y) <= 12, `${label}: pitched onto the walker's body, it shows at ${onScreen.x.toFixed(0)},${onScreen.y.toFixed(0)}, not the screen centre`);
  await recharged(me);
  hits = 0;
  e.input.keyDown(49);
  await tick(2);
  e.input.keyUp(49);
  await tick(25);
  const wide = spread > WALKER_HALF_WIDTH;
  if (!wide) check(hits > 0, `${label}: shots at the walker's body from 4 units miss`);
  setPitch(me, 0);
  await tick(2);

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
  if (verbose) console.log(`${label}: crosshair ${want}, shots ${aimed.join(", ")}; from 4 units ${hits} hits${wide ? ` (guns ${spread.toFixed(2)} to the side, wider than the walker)` : ""}; locked after ${locked} ticks`);
}

if (failures.length) {
  console.log(failures.join("\n"));
  console.log(`aim checks: ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`aim checks passed for ${units.length} units`);
process.exit(0);
