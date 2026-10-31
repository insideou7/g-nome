// Collision checks: polygon and segment maths, footprints, deflection, and
// (given the game folder) mission 1, where walking into a cliff must stop at
// its footprint.
// Usage: node web/tests/collision-check.mjs [game/g-nome/G-NOME]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { insidePolygon, segmentsCross, buildFootprint, Collision } from "../src/battlefield/collision.js";
import { basisFromAt } from "../src/battlefield/math.js";

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
};
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

const square = [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]];
check("point inside a square", insidePolygon(square, 2, 2));
check("point outside a square", !insidePolygon(square, 5, 2) && !insidePolygon(square, 2, -1));

const p = segmentsCross(0, 0, 0, 2, -1, 1, 1, 1);
check("segments cross at (0, 1)", p && near(p[0], 0) && near(p[1], 1));
check("parallel segments don't cross", segmentsCross(0, 0, 0, 2, 1, 0, 1, 2) === null);
check("short segment stops before the edge", segmentsCross(0, 0, 0, 0.5, -1, 1, 1, 1) === null);

// A 12 x 12 tile on the grid: every edge lies on a grid line, so all are
// flagged and none is used for sliding.
const tile = buildFootprint([[0, 0, 0], [12, 0, 0], [12, 0, 12], [0, 0, 12]], [0, 0, 0]);
check("edges on grid lines are flagged", tile.flags.every((f) => f === 0x10));
// A triangle with one corner on the grid: both edges at that corner push
// it out 0.2 (as the original does, one after the other).
const tri = buildFootprint([[12, 0, 5], [20, 0, 5.5], [16, 0, 9]], [0, 0, 0]);
check("a vertex on the grid is pushed outwards", near(tri.pts[0][0], 11.6));
// Posed footprints turn with the object (yaw 90 degrees: +Z becomes +X).
const turned = buildFootprint([[0, 0, 1]], [10, 0, 0], basisFromAt([1, 0, 0]));
check("footprint follows the pose object's yaw", near(turned.pts[0][0], 11) && near(turned.pts[0][2], 0));

// Deflection around a round obstacle at the origin, reach 1.
const c = new Collision({});
const mover = (pos, at, speed = 1) => ({ pos, last: pos.slice(), basis: basisFromAt(at), speed });
let o = mover([0, 0, 2], [0, 0, -1]);
check("clear of the obstacle: allowed", c.deflectRound(o, [0, 0, 0], 1, 9900) === 1);
o = mover([0, 0, 0.9], [0, 0, -1]);
check("head on: refused", c.deflectRound(o, [0, 0, 0], 1, 9900) === 0);
o = mover([0.5, 0, 0.5], [-1, 0, -0.2]);
const r = c.deflectRound(o, [0, 0, 0], 1, 9900);
check("glancing: slides to the edge", r === 1 && near(Math.hypot(o.pos[0], o.pos[2]), 1));
o = mover([0, 0, 0.9], [0, 0, 1]);
check("moving away: allowed", c.deflectRound(o, [0, 0, 0], 1, 9900) === 1);

const dir = process.argv[2];
if (dir) {
  const { Engine } = await import("../src/engine.js");
  const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  const files = {
    read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))),
    has: (n) => names.has(n.toUpperCase()),
  };
  const e = new Engine(files, { log: () => {} });
  await e.init();
  e.boot();
  const step = async (n) => {
    for (let i = 0; i < n; i++) {
      e.tick(1000 / 30);
      await new Promise((r) => setImmediate(r));
    }
  };
  await step(60);
  for (const g of [2118, 2119]) e.vm.setGlobal(g, 1);
  e.vm.setGlobal(982, 0);
  e.run(8317);
  await step(30);
  const w = e.world, hs = e.hotspots;
  check("mission 1 adds hotspots", hs.count > 50);
  const footprints = hs.table.slice(0, hs.count).filter((h) => h.type === 2);
  check("footprints are built for type 2 hotspots", footprints.length > 0 && footprints.every((h) => h.footprint.pts.length >= 3));
  const player = w.get(e.vm.getGlobal(973));
  check("the player has a radius", w.radiusOf(player.id) > 0);
  // The cliff north-west of the start (object at -54, 6): walk into it.
  const cliff = [...w.objects.values()].find((x) => near(x.pos[0], -54, 0.01) && near(x.pos[2], 6, 0.01));
  const spot = cliff && e.renderLists.get(e.render3d.objects.getProperty(cliff.id, 16))?.[0];
  const fp = spot && hs.get(spot).footprint;
  if (fp) {
    player.basis = basisFromAt([-0.05, 0, 1]);
    e.input.keyDown(0x6b); // numpad +: throttle up
    await step(60);
    e.input.keyUp(0x6b);
    await step(300);
    check("walking into a cliff stops at its footprint", !insidePolygon(fp.pts, player.pos[0], player.pos[2]) && player.pos[2] < 1.5);
  } else check("found the cliff by the start", false);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
