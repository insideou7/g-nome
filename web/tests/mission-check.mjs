// Checks for the enemy AI and the mission goals (docs/missions.md).
// Usage: node web/tests/mission-check.mjs [game/g-nome/G-NOME]
// Without a game folder only the aiming maths runs; with one it plays
// campaign mission 1 headless: a guard spots the player and turns its gun
// on them, destroying the enemies wins, losing the player's unit loses.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aimExterns } from "../src/battlefield/aim.js";
import { WorldObject } from "../src/battlefield/world.js";
import { motionOf } from "../src/anim/motion.js";
import { clumpMatrices } from "../src/render3d/model.js";
import { identity } from "../src/render3d/math.js";

// MoveSubClumpToFace on a bare object: yaw towards a target on its right.
{
  const objs = new Map();
  const props = new Map();
  const fake = {
    world: { get: (id) => objs.get(id), pose: () => null, groundFlag: 0 },
    render3d: {
      objects: {
        getProperty: (id, p) => props.get(`${id}:${p}`) ?? 0,
        setProperty: (id, p, v) => props.set(`${id}:${p}`, v),
      },
      objectModel: () => null,
    },
  };
  const ext = aimExterns(fake);
  const me = new WorldObject(1), it = new WorldObject(2);
  me.basis = { right: [-1, 0, 0], up: [0, 1, 0], at: [0, 0, 1] }; // right is -X in RenderWare
  it.setPosition([-10, 0, 10]); // 45 degrees to the right
  objs.set(1, me).set(2, it);
  const m = motionOf(me);
  m.maxAngAccel.yaw = 90;
  m.maxAngVel.yaw = 45;
  m.twistRate = 30; // already turning right
  const step = ext.MoveSubClumpToFace(1, 0, 2, 0, 2, 100, 56, 105, 0);
  assert.ok(step > 0, `step ${step} should turn right`);
  assert.equal(props.get("1:105"), Math.trunc(Math.cos(Math.PI / 4) * 10000));
  // pitch with the target behind: -10000, no turn
  it.setPosition([0, 5, -10]);
  assert.equal(ext.MoveSubClumpToFace(1, 0, 2, 0, 1, 100, 56, 106, 111), 0);
  assert.equal(props.get("1:106"), -10000);
}

// A joint matrix turns a clump about its own origin, before its local matrix.
{
  const local = identity();
  local[12] = 5; // the clump sits 5 units along +X
  const model = { clumps: [{ local, children: [] }], roots: [0] };
  const joint = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]); // 90 degrees about Y
  const [m] = clumpMatrices(model, identity(), null, [joint]);
  assert.deepEqual([m[12], m[13], m[14]], [5, 0, 0], "the origin stays put");
  assert.deepEqual([m[8], m[9], m[10]], [1, 0, 0], "+Z turns to +X");
}
console.log("aiming maths: ok");

const dir = process.argv[2];
if (dir && existsSync(join(dir, "G-NOME.BIN"))) {
  const { Engine } = await import("../src/engine.js");
  const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  const files = {
    read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
    has: (n) => names.has(n.toUpperCase()),
  };
  // Boot, start campaign mission 1 the way the briefing does (script 8317),
  // and run `ticks` frames, calling step(tick) before each.
  const play = async (ticks, step) => {
    const engine = new Engine(files, { log: () => {} });
    await engine.init();
    engine.boot();
    for (let i = 0; i < ticks; i++) {
      if (i === 60) {
        for (const g of [2118, 2119]) engine.vm.setGlobal(g, 1);
        engine.vm.setGlobal(982, 0);
        engine.run(8317);
      }
      if (i > 60) step?.(engine, i);
      engine.tick(1000 / 30);
      await new Promise((r) => setImmediate(r));
    }
    return engine;
  };

  // A guard spots the player within its 30-unit guard radius, attacks
  // (task 2019) and lines its gun up (cos x 10000 in property 105).
  let guard = 0;
  const e1 = await play(500, (engine, i) => {
    if (i !== 100) return;
    const s = engine.mission.status();
    assert.equal(s.hooks.killed, 8740, "mission 1 counts kills in script 8740");
    assert.equal(s.enemies.length, 2, "two active enemies on the easiest setting");
    assert.ok(s.enemies.every((u) => u.task === 2024), "they start on guard (task 2024)");
    guard = s.enemies[0].id;
    const g = engine.world.get(guard), p = engine.world.get(s.player);
    p.setPosition([g.pos[0] - 12, p.pos[1], g.pos[2]]);
    p.tickPos = p.pos.slice();
  });
  const ob = e1.render3d.objects;
  const enemy = e1.mission.status().enemies.find((u) => u.id === guard);
  assert.equal(enemy.task, 2019, "the guard attacks");
  assert.ok(ob.getProperty(guard, 105) > 9000, `gun lined up (cos ${ob.getProperty(guard, 105)})`);
  assert.ok(e1.render3d.objectModel(guard).joints?.some(Boolean), "turret joints turned");
  assert.ok(!e1.vm.unknown.has("extern:render.MoveSubClumpToFace") && !e1.vm.unknown.has("extern:render.RotateSubClump"));
  console.log("mission 1 guard attacks and aims: ok");

  // Destroying the enemies meets mission 1's goal: the fly-by and the
  // doors run, and the game moves on to mission 2's briefing.
  const e2 = await play(400, (engine, i) => {
    if (i === 100) assert.equal(engine.mission.destroyEnemies(), 2);
  });
  assert.equal(e2.mission.status().outcome, "won");
  assert.equal(e2.vm.getGlobal(1845), 3, "debrief in 'won' mode");
  assert.equal(e2.vm.getGlobal(2119), 2, "the campaign moved on to mission 2");
  assert.ok(!e2.world.shown, "the 3D view is put away");
  console.log("mission 1 win: ok");

  // Losing the player's unit fails the mission and comes back to its briefing.
  const e3 = await play(400, (engine, i) => {
    if (i === 100) engine.mission.lose();
  });
  assert.equal(e3.mission.status().outcome, "lost");
  assert.equal(e3.vm.getGlobal(1845), 2, "debrief in 'lost' mode");
  assert.equal(e3.vm.getGlobal(2119), 1, "mission 1 again");
  assert.equal(e3.vm.getGlobal(2152), 1, "briefing in retry mode");
  console.log("mission 1 lose: ok");
}
