// Plays campaign missions to a win with a scripted bot, to check that each
// mission's goals can be met in the browser engine: boarding and ejecting,
// trigger zones, control panels, the IFF dial, radio replies, kills.
//
// Usage: node web/tests/campaign-bot.mjs [game/g-nome/G-NOME] [--missions 2,5-7] [--verbose]
//
// The bot is not a player: it teleports near each goal (goto) and then
// drives the last stretch with the throttle (walkto), so collisions and
// hotspots still decide whether a unit boards or a trigger fires. Where the
// way itself is the test (mission 8's canyon gates), drive finds a path
// round the solid hotspots and drives all of it. Kills go
// through the game's own destroy script (engine.mission.destroy). Math.random
// is seeded so a run always takes the same path.
//
// Step syntax, run in order with 60 ticks (2 s) after each:
//   goto:REF[,dx,dz]    put the player's unit next to REF (offset in world units)
//   walkto:REF[,ticks]  face REF and drive at it until the player reaches it
//   drive:REF[,ticks]   drive to REF on a path round the solid hotspots
//   eject               leave the current vehicle or building (script 1943)
//   kill:REF            destroy REF (script 2242)
//   wait:T              let T more ticks run
//   key:VK              press and release a key (virtual-key code)
//   click:X,Y           click at screen pixels
//   iff:N               dial the IFF code N with U, I, O and P (one octal digit each)
//   call:S(ARGS)        run script S with REF arguments
// REF is a global (G381), an array element (G73[0]) or a number.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { insidePolygon } from "../src/battlefield/collision.js";

// Mission goals and how the bot meets them (briefing text in quotes).
const SOLUTIONS = {
  // 1-2 Drawbridge: "Commandeer Darken vehicle", "Lower bridge and cross
  // River Angada". The bridge control (G373) shows a panel; clicking it
  // lowers the bridge (G349), then the far bank (trigger G359) and three
  // kills finish it.
  2: ["goto:G73[0],0,1", "walkto:G73[0],300", "goto:G373,-4,0", "eject", "walkto:G373,600",
    "click:184,146", "wait:100", "eject", "goto:G359,0,8", "walkto:G359,400",
    "kill:G173[3]", "kill:G173[4]", "kill:G173[5]"],
  // 1-3 Convoy: "Enter Darken HQ at Chansk". Board the motor pool (G407)
  // for the IFF code, take a Union HAWC, dial the Darken IFF, start the
  // convoy (trigger G625[0]) and catch up with it. Six seconds later the
  // convoy calls and the radio menu opens by itself (script 366) for five
  // seconds: F9 answers (message 6, hook G1221 = 8790), which unlocks the
  // HQ (G397). Pressing F1 then would close the menu instead. Getting out
  // after that turns every enemy hostile (hook G983 = 8792), so leave the
  // HAWC just west of the HQ and run in before its guns get you.
  3: ["goto:G407,0,6", "walkto:G407,400", "eject", "goto:G13[0],0,2", "walkto:G13[0],300",
    "call:409(G973,2408)", "goto:G625[0],0,3", "walkto:G625[0],200", "goto:G73[0],5,0", "wait:200",
    "key:120", "goto:G397,-3,0", "eject", "walkto:G397,600"],
  // 1-4 LATLON: enter the array (G381) on foot, wait for the radio, leave
  // and destroy it.
  4: ["goto:G381,-8,0", "eject", "walkto:G381,600", "wait:200", "eject", "kill:G381"],
  // 1-5 Rescue!: "Set IFF to 0024", defeat the security tower (G419),
  // reach Kylie (trigger G625[0]).
  5: ["iff:20", "kill:G419", "goto:G625[0],0,6", "walkto:G625[0],300"],
  // 2-1 Dropship Rendezvous: take a HAWC, meet the Union HAWCs (trigger
  // G625[3]), clear the landing site and reach waypoint 2 (G625[2]).
  6: ["walkto:G13[0],400", "goto:G625[3],0,5", "walkto:G625[3],200", "wait:200",
    "kill:G713", "kill:G263[0]", "kill:G419", "wait:400", "goto:G625[2],0,5", "walkto:G625[2],300"],
  // 2-2 River Race: occupy the Meson tower (G263[0]), then destroy the
  // LATLON array (G381).
  7: ["goto:G263[0],0,-4", "eject", "walkto:G263[0],400", "eject", "kill:G381"],
  // 2-3 Canyon Maze: "you'll meet [them] at the exit of the gorge". Gates
  // (class 237) close the canyon; destroying their control tower (class
  // 223) switches them off (2101 -> 2279 drops the barrier hotspot). Tower
  // G420 opens the west gates (G427[0..2]); the trigger past them (G625[1])
  // springs the ambush; tower G419 opens the south gates (G427[3..5]) to
  // the exit (trigger G625[2], script 8919 wins). The wingman (G13[1])
  // guards the start until ordered on the radio: guard and follow tie at
  // priority 1 and TaskSetHighestIndex keeps the current task, as RENDER.R32
  // does. It must live (8920: its pilot G2 dying fails the mission).
  8: ["kill:G420", "drive:G625[1]", "kill:G419", "drive:G625[2]"],
};

const dir = process.argv.slice(2).find((a) => !a.startsWith("--") && !/^[\d,-]+$/.test(a)) || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`campaign bot: no game files in ${dir}, skipped`);
  process.exit(0);
}
const verbose = process.argv.includes("--verbose");
const mi = process.argv.indexOf("--missions");
/** @param {string} s */
const parseList = (s) => s.split(",").flatMap((p) => {
  const [a, b = a] = p.split("-").map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
});
const missions = mi > 0 ? parseList(process.argv[mi + 1]) : Object.keys(SOLUTIONS).filter((k) => /^\d+$/.test(k)).map(Number);

const { Engine } = await import("../src/engine.js");
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (/** @type {string} */ n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
  has: (/** @type {string} */ n) => names.has(n.toUpperCase()),
};

const VK_THROTTLE_UP = 0x6b, VK_THROTTLE_DOWN = 0x6d;
const TILE = 6; // ground tiles (level -100) sit on a 6-unit grid
const TRIGGER = 500; // class of trigger zones: their hotspots never block

// Waypoints (x, z) from `from` to `to` on a 1-unit grid: cells on a ground
// tile and outside every solid hotspot still in its object's hotspot list
// (property 16; scripts 434/435 take a gate's barrier out of it), found
// breadth first. Null when there is no way.
/**
 * @param {any} engine
 * @param {number[]} from
 * @param {number[]} to
 */
function findPath(engine, from, to) {
  const prop = (/** @type {number} */ id, /** @type {number} */ p) => engine.render3d.objects.getProperty(id, p);
  const objs = [...engine.world.objects.values()];
  const tiles = new Set();
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of objs) {
    if (o.level !== -100) continue;
    tiles.add(`${Math.round(o.pos[0] / TILE)},${Math.round(o.pos[2] / TILE)}`);
    x0 = Math.min(x0, o.pos[0] - TILE); x1 = Math.max(x1, o.pos[0] + TILE);
    z0 = Math.min(z0, o.pos[2] - TILE); z1 = Math.max(z1, o.pos[2] + TILE);
  }
  const solid = [];
  for (const o of objs) {
    if (prop(o.id, 0) === TRIGGER) continue;
    for (const n of engine.renderLists?.get(prop(o.id, 16)) || []) {
      const h = engine.hotspots.get(n);
      if (h && h.flags & 1) solid.push(h);
    }
  }
  const blocked = (/** @type {number} */ x, /** @type {number} */ z) =>
    !tiles.has(`${Math.round(x / TILE)},${Math.round(z / TILE)}`) ||
    solid.some((h) => {
      if (h.type === 0x10) return Math.hypot(h.pos[0] - x, h.pos[2] - z) <= h.id / 100;
      const fp = engine.collision.footprint(h);
      if (!fp.pts.length) return false;
      return insidePolygon(fp.pts, x, z) !== (h.type === 8);
    });
  x0 = Math.floor(x0); z0 = Math.floor(z0);
  const w = Math.ceil(x1) - x0 + 1, hgt = Math.ceil(z1) - z0 + 1;
  const cell = (/** @type {number[]} */ p) => Math.round(p[2] - z0) * w + Math.round(p[0] - x0);
  const start = cell(from), goal = cell(to);
  const prev = new Int32Array(w * hgt).fill(-1);
  prev[start] = start;
  const queue = [start];
  for (let k = 0; k < queue.length && prev[goal] < 0; k++) {
    const c = queue[k], cx = c % w, cz = (c - cx) / w;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = cx + dx, z = cz + dz, n = z * w + x;
      if (x < 0 || z < 0 || x >= w || z >= hgt || prev[n] >= 0) continue;
      if (n !== goal && blocked(x + x0, z + z0)) continue;
      prev[n] = c;
      queue.push(n);
    }
  }
  if (prev[goal] < 0) return null;
  const out = [];
  for (let c = goal; c !== start; c = prev[c]) out.push([(c % w) + x0, Math.floor(c / w) + z0]);
  return out.reverse().filter((_, i, a) => i % 4 === 3 || i === a.length - 1);
}
const IFF_KEYS = [0x55, 0x49, 0x4f, 0x50]; // U I O P: actions 55-58, scripts 1994-1997

/** @param {number} n */
async function play(n) {
  let seed = 1;
  const random = Math.random;
  Math.random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  try {
    const engine = new Engine(files, { log: () => {} });
    await engine.init();
    engine.boot();
    const vm = engine.vm;
    const prop = (/** @type {number} */ id, /** @type {number} */ p) => engine.render3d.objects.getProperty(id, p);
    const ref = (/** @type {string} */ s) => {
      const r = /^G(\d+)(?:\[(\d+)\])?$/.exec(s);
      return r ? vm.getGlobal(Number(r[1]) + Number(r[2] || 0)) : Number(s);
    };
    const player = () => vm.getGlobal(973);
    const obj = (/** @type {number} */ id) => engine.world.get(id);
    const step = async (/** @type {number} */ ticks) => {
      for (let i = 0; i < ticks; i++) {
        engine.tick(1000 / 30);
        await new Promise((r) => setImmediate(r));
      }
    };
    // Start the mission the way the briefing's launch button does (8317).
    await step(60);
    for (const g of [2118, 2119]) vm.setGlobal(g, n);
    vm.setGlobal(982, 0);
    engine.run(8317);
    await step(60);
    assert.ok(player(), `mission ${n}: no player unit`);

    for (const s of SOLUTIONS[n]) {
      const [k, v = ""] = s.split(/:(.*)/);
      if (verbose) console.log(`  m${n} ${s}`);
      if (k === "goto") {
        const [r, dx = "0", dz = "0"] = v.split(",");
        const target = obj(ref(r)), me = obj(player());
        assert.ok(target && me, `mission ${n}: ${s}: no such unit`);
        me.setPosition([target.pos[0] + Number(dx), me.pos[1], target.pos[2] + Number(dz)]);
        me.tickPos = me.pos.slice();
      } else if (k === "walkto") {
        const [r, ticks = "300"] = v.split(",");
        const id = ref(r);
        for (let i = 0; i < Number(ticks) && player() !== id; i++) {
          const me = obj(player()), target = obj(id);
          if (!me || !target) break;
          const dx = target.pos[0] - me.pos[0], dz = target.pos[2] - me.pos[2], d = Math.hypot(dx, dz);
          if (d < 0.3) break;
          me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
          me.tickBasis = me.basis;
          if (i % 3 === 0) engine.input.keyDown(VK_THROTTLE_UP, false, false, i > 0);
          await step(1);
        }
        engine.input.keyUp(VK_THROTTLE_UP);
        for (let i = 0; i < 20; i++) engine.input.keyDown(VK_THROTTLE_DOWN, false, false, i > 0);
        engine.input.keyUp(VK_THROTTLE_DOWN);
        if (verbose) console.log(`    now ${player()} at ${obj(player())?.pos.map(Math.round)}`);
      } else if (k === "drive") {
        const [r, ticks = "20000"] = v.split(",");
        const id = ref(r);
        const way = findPath(engine, obj(player()).pos, obj(id).pos);
        assert.ok(way, `mission ${n}: ${s}: no way through`);
        let i = 0;
        for (const [x, z] of way) {
          for (; i < Number(ticks) && engine.mission.status().outcome === "playing"; i++) {
            const me = obj(player());
            if (!me) break;
            const dx = x - me.pos[0], dz = z - me.pos[2], d = Math.hypot(dx, dz);
            if (d < 2) break;
            me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] };
            me.tickBasis = me.basis;
            if (i % 3 === 0) engine.input.keyDown(VK_THROTTLE_UP, false, false, i > 0);
            await step(1);
          }
        }
        engine.input.keyUp(VK_THROTTLE_UP);
        for (let j = 0; j < 20; j++) engine.input.keyDown(VK_THROTTLE_DOWN, false, false, j > 0);
        engine.input.keyUp(VK_THROTTLE_DOWN);
        if (verbose) console.log(`    now ${player()} at ${obj(player())?.pos.map(Math.round)} after ${i} ticks`);
      } else if (k === "eject") engine.callScript(1943, []);
      else if (k === "kill") engine.mission.destroy(ref(v));
      else if (k === "wait") await step(Number(v));
      else if (k === "key") {
        engine.input.keyDown(Number(v));
        await step(2);
        engine.input.keyUp(Number(v));
      } else if (k === "click") {
        const [x, y] = v.split(",").map(Number);
        engine.mouseMove(x, y);
        engine.mouseDown(x, y);
        await step(2);
      } else if (k === "iff") {
        const want = Number(v);
        for (let d = 0; d < 4; d++) {
          const shift = 9 - 3 * d;
          for (let i = 0; i < 8 && ((prop(player(), 113) >> shift) & 7) !== ((want >> shift) & 7); i++) {
            engine.input.keyDown(IFF_KEYS[d]);
            await step(1);
            engine.input.keyUp(IFF_KEYS[d]);
            await step(1);
          }
        }
        assert.equal(prop(player(), 113), want, `mission ${n}: IFF dial`);
      } else if (k === "call") {
        const [, id, args] = /** @type {RegExpExecArray} */ (/(\d+)\((.*)\)/.exec(v));
        vm.callValue(Number(id), args ? args.split(",").map(ref) : []);
      } else throw new Error(`unknown step ${s}`);
      await step(60);
    }
    // The win runs the fly-by (2243) and then the debrief; give it time.
    for (let i = 0; i < 40 && engine.mission.status().outcome === "playing"; i++) await step(30);
    const outcome = engine.mission.status().outcome;
    assert.equal(outcome, "won", `mission ${n} ended ${outcome}`);
    assert.equal(engine.vm.unknown.size, 0, `mission ${n}: unimplemented ${[...engine.vm.unknown.keys()]}`);
  } finally {
    Math.random = random;
  }
}

let failed = 0;
for (const n of missions) {
  if (!SOLUTIONS[n]) {
    console.log(`mission ${n}: no solution yet`);
    continue;
  }
  try {
    await play(n);
    console.log(`mission ${n}: won`);
  } catch (e) {
    failed++;
    console.log(`mission ${n}: FAILED ${/** @type {Error} */ (e).message}`);
  }
}
if (failed) process.exit(1);
