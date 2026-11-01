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
//   killpilots:SIDE     destroy every pilot on foot whose side (p115) is SIDE
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
  // 2-4 Egger: "Help Thane steal Merc Patrol HAWC", "Lure Merc HAWC into
  // Thane's EGGER range", "Signal Thane to attack". Three Merc kills
  // (G707) bring Thane (G5, on foot) in at the trigger G625[0]. Shooting
  // range of the patrol HAWC (G33[0]) makes it chase the player; lead it
  // to within 12 world units of Thane (update script 8942), then F1+F9
  // (hook G1221 = 8944) sends him in. His EGGER shot (weapon kind 25,
  // script 1711) throws the crew out, he boards the empty HAWC (hook G984
  // = 8938) and 2246 wins. Stand north of him: scenery south-east of him
  // (9739, class 253) stops shots from that side.
  9: ["kill:G33[1]", "kill:G33[2]", "kill:G33[3]", "goto:G33[0],-15,10", "wait:200",
    "goto:G5,0,10", "wait:300", "key:112", "key:120", "wait:1300"],
  // 2-5 The Citadel Approach: "Rendezvous at base of Mesa Caracon",
  // "Destroy base defenses" (three of the towers G419/G420, the bunkers
  // G263 or the popup cluster G345: hook 8967 counts G707), "Draw sentry
  // vehicles away from elevator" (sentry G33[4] chasing the player into
  // trigger G625[3] runs 8968 -> 8969, which also fires when it is hit,
  // hook G987, or killed: Thane (G5) then walks to the elevator), and
  // "Rendezvous at elevator on Thane's signal" (trigger G625[0], script
  // 8974, on foot: G1 is the player's pilot). Thane's dialogue (table
  // 8960, rows from 5) ends with the win (2245). With only G33[4] gone,
  // something still guarding the way shoots Thane, which fails the
  // mission (8967 -> 2249), so G33[3] goes too.
  10: ["kill:G419", "kill:G420", "kill:G263[2]", "goto:G33[4],0,15", "wait:100",
    "kill:G33[4]", "kill:G33[3]", "wait:2100", "goto:G625[0],0,8", "eject", "walkto:G625[0],400"],
  // 2-6 Battle in the Clouds: "Defend Citadel buildings". The wingmen man
  // the Citadel (G5 the shuttle G417, G2 a Meson tower); the player takes
  // another tower (G263[0]). Waves of craft (G33, class 181) come for the
  // player; 8993 sends in the next one as each dies, and G2471 kills (8 on
  // easy, counting the first from 8992) win through 2246. Losing either
  // wingman, or the shuttle while G5 flies it, fails (8995).
  11: ["goto:G263[0],0,-4", "walkto:G263[0],400", "kill:G33[1]", "kill:G33[2]", "kill:G33[3]",
    "kill:G33[4]", "kill:G33[5]", "kill:G33[6]", "kill:G33[7]"],
  // 3-1 Scorp Crossing: "Pass through Ur-Binshar crossing". The player
  // (G1) and two pilots (G2, G5) start on foot. Walking into trigger G625[9]
  // wakes the Scorp vehicle G53[1] and its three guards (G183, whose guns
  // throw a pilot out of his vehicle). Boarding G53[1] (hook G984 = 9022)
  // calls the two pilots aboard; when both are in (hook G993 = 9029) the
  // player's IFF becomes a Scorp code and the Scorp convoy G53[2..4] sets
  // off (9030). The pilots walk, so that takes about a minute. The convoy
  // meets a Union patrol (G13) and they fight; three dead Union pilots
  // (hook G985 = 9021, G710) send the convoy on to the crossing (9033), so
  // the bot destroys the patrol and the crews that eject. The crossing
  // trigger G625[1] lets the player through only with a convoy vehicle
  // within 7 units (9031); otherwise the guards attack and the mission
  // fails 15 s later (2249). The far side (trigger G625[8] or G625[2],
  // 9032) wins.
  12: ["goto:G625[9],-3,0", "walkto:G625[9],100", "kill:G183[0]", "kill:G183[1]", "kill:G183[2]",
    "goto:G53[1],2,0", "walkto:G53[1],200", "wait:2400",
    "kill:G13[0]", "kill:G13[1]", "kill:G13[2]", "killpilots:0", "wait:2400",
    "goto:G53[2],3,0", "drive:G625[1]", "drive:G625[8]"],
  // 4-1 Captured!: "Rescue Kylle at Scorp Imperial HQ". The HQ (G397)
  // sits in a walled compound whose gates (G427, class 237) belong to the
  // security tower G419 (script 2098); destroying it opens them (2101 ->
  // 2279). The trigger by the HQ (G625[0], script 9156) sends the guards
  // out and sets the eject hook G983 = 9155: the player's pilot (G1)
  // getting out there wins (2246). Losing Kylle (G5) or the HQ fails it.
  // The whole way is driven, with the player's unit vulnerable.
  17: ["kill:G419", "drive:G625[0]", "wait:300", "eject", "wait:200"],
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
const CLEAR = 1; // world units drive keeps from wall edges where it can
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
function findPath(engine, from, to, clear = CLEAR) {
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
  // Keep `clear` units away from wall edges too: a cell just outside a
  // wall lets the unit cut the corner into it and get stuck in a notch
  // (mission 17's rocks). Narrow ways (mission 8's canyon) need clear = 0.
  const prints = new Map(solid.filter((h) => h.type !== 0x10).map((h) => [h, engine.collision.footprint(h)]));
  const nearEdge = (/** @type {any} */ fp, /** @type {number} */ x, /** @type {number} */ z) => {
    const { pts, flags } = fp;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (flags[i]) continue;
      const [ax, , az] = pts[j], [bx, , bz] = pts[i];
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      if (Math.hypot(ax + ex * t - x, az + ez * t - z) < clear) return true;
    }
    return false;
  };
  const blocked = (/** @type {number} */ x, /** @type {number} */ z) =>
    !tiles.has(`${Math.round(x / TILE)},${Math.round(z / TILE)}`) ||
    solid.some((h) => {
      if (h.type === 0x10) return Math.hypot(h.pos[0] - x, h.pos[2] - z) <= h.id / 100;
      const fp = prints.get(h);
      if (!fp.pts.length) return false;
      return insidePolygon(fp.pts, x, z) !== (h.type === 8) || (clear > 0 && nearEdge(fp, x, z));
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
    // Skip the opening movie and wait for the main menu (script 8344's
    // rect), as a player would. Left running, the movie's end script sets
    // G2119 (the campaign mission) to 0 about 70 s in, which breaks every
    // objective lookup (script 8318) in a long mission.
    for (let i = 0; i < 60 && !engine.plugins.some((/** @type {any} */ p) => p.ownsScreen); i++) await step(1);
    engine.input.keyDown(0x1b);
    engine.input.keyUp(0x1b);
    for (let i = 0; i < 150 && !engine.clickRects.some((/** @type {any} */ r) => !r.off && r.script === 8344); i++) await step(1);
    await step(30);
    // Start the mission the way the briefing's launch button does (8317).
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
        const way = findPath(engine, obj(player()).pos, obj(id).pos) || findPath(engine, obj(player()).pos, obj(id).pos, 0);
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
      else if (k === "killpilots") {
        // Pilots on foot (class below 100) of side p115 = v, such as the
        // crews that eject from destroyed vehicles.
        for (const id of engine.mission.units())
          if (prop(id, 0) < 100 && prop(id, 115) === Number(v) && prop(id, 77)) engine.mission.destroy(id);
      }
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
