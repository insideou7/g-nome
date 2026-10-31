// Checks for the battlefield world and camera (web/src/battlefield/).
// Usage: node web/tests/battlefield-check.mjs [game/g-nome/G-NOME]
// Without a game folder only the maths runs; with one it also starts the
// first campaign mission headless and checks what the scripts built.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WorldObject, World, TICK_MS } from "../src/battlefield/world.js";
import { BattleCamera, project, screenToGround, backdropPlacement } from "../src/battlefield/camera.js";
import { headingOf } from "../src/battlefield/math.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// Yaw follows the right-hand rule about +Y: 90 degrees turns +Z into +X.
{
  const o = new WorldObject(1);
  o.turn(90);
  near(o.basis.at[0], 1);
  near(o.basis.at[2], 0);
  assert.equal(o.heading(), 9000);
  o.turn(0, 30); // pitch about the object's right axis; at goes down
  assert.ok(o.basis.at[1] < 0);
  assert.equal(headingOf([0, 0, -1]), 18000);
}

// Camera: unrotated camera looks down +Z with +X on the left of the screen.
{
  const cam = new BattleCamera();
  cam.place([0, 1, 0], [0, 0, 1]);
  const pose = cam.pose(() => null);
  near(pose.right[0], -1);
  const vp = cam.viewport();
  const left = project(pose, cam.viewwindow, vp, [1, 1, 5]);
  assert.ok(left.x < 0, "+X should be on the left");
  const centre = project(pose, cam.viewwindow, vp, [0, 1, 5]);
  near(centre.x, 0);
  near(centre.y, 0);
  // Ray through a pixel hits the ground where projecting it lands.
  const g = screenToGround(pose, cam.viewwindow, vp, 50, 120);
  near(g[1], 0);
  const back = project(pose, cam.viewwindow, vp, g);
  near(back.x, 50, 1e-3);
  near(back.y, 120, 1e-3);
  // Backdrop: looking down +Z puts the panorama's left edge at x = 0 and its
  // bottom on the horizon at the middle of the view.
  const bd = backdropPlacement(pose, 1328, 383, vp);
  assert.equal(bd.x, 0);
  assert.equal(bd.horizon, 240);
  // Attached camera follows the object, offset in the object's frame.
  const o = new WorldObject(7);
  o.setPosition([10, 0, 10]);
  o.turn(90);
  cam.attachTo(7, 0, [0, 0.5, -1]);
  const p = cam.pose(() => ({ pos: o.pos, basis: o.basis }));
  near(p.pos[0], 9);
  near(p.pos[1], 0.5);
  near(p.at[0], 1);
}

// Fixed tick and interpolation: an update script moving 1 unit per tick is
// drawn halfway between ticks.
{
  const calls = [];
  const engine = { callScript: (s, a) => calls.push([s, ...a]) };
  const w = new World(engine);
  w.init(0, 0, 640, 480, 0);
  const o = w.add(5, 0, 0, 0);
  o.updateScript = 99;
  o.hasUpdate = true; // an update record (kind 6), interval 0
  w.onTick(() => {
    o.pos = [o.pos[0] + 1, 0, 0];
  });
  w.advance(TICK_MS * 2.5);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 99);
  assert.equal(calls[0][1], 5);
  assert.ok(calls[0][2] === 33 || calls[0][2] === 34, `dt ${calls[0][2]}`);
  near(w.alpha, 0.5, 1e-9);
  near(w.pose(5).pos[0], 1.5);
  w.state = 4; // paused: no more ticks, draw the latest pose
  w.advance(1000);
  assert.equal(calls.length, 2);
  near(w.pose(5).pos[0], 2);
}

console.log("battlefield maths: ok");

const dir = process.argv[2];
if (dir && existsSync(join(dir, "G-NOME.BIN"))) {
  const { Engine } = await import("../src/engine.js");
  const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  const files = {
    read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
    has: (n) => names.has(n.toUpperCase()),
  };
  const engine = new Engine(files, { log: () => {} });
  await engine.init();
  engine.boot();
  for (let i = 0; i < 30; i++) {
    engine.tick(33);
    await new Promise((r) => setImmediate(r));
  }
  // What the briefing's start button does (script 8317): mission 1 of the
  // campaign table 6984.
  engine.vm.setGlobal(2118, 1);
  engine.vm.setGlobal(2119, 1);
  engine.vm.setGlobal(982, 0);
  engine.run(8317);
  for (let i = 0; i < 30; i++) engine.tick(33);
  const w = engine.world;
  const ground = [...w.objects.values()].filter((o) => o.level === -100);
  assert.equal(ground.length, 748, "ground tiles");
  // a 600-unit grid starting at the mission's corner (script 2515)
  const mod = (v) => Math.round(((v * 100) % 600) + 600) % 600;
  for (const o of ground) {
    assert.equal(mod(o.pos[0]), mod(ground[0].pos[0]));
    assert.equal(mod(o.pos[2]), mod(ground[0].pos[2]));
    near(o.pos[1], 0);
  }
  assert.ok(w.camera.attach, "camera rides on the player's unit");
  assert.deepEqual(w.camera.background, [222, 198, 148]);
  assert.equal(w.camera.backdrop.bitmap, 2486);
  assert.deepEqual(w.camera.fog, { depth: 20, color: [212, 185, 136] });
  console.log(`mission 1: ${w.objects.size} objects, ${ground.length} ground tiles: ok`);
}
