// Check the animation system against a real unit's animation set, taken from
// the game's own setup script (the addAnimation / addTrigger calls for the
// FRMEs 2597-2617, script lines in `disasm.mjs ... all`). The unit should
// idle, start walking when it moves, loop the walk, and stop and return to
// idle when it halts, with frames advancing by distance (speed / stride).
// Usage: node web/tests/anim-check.mjs game/g-nome/G-NOME
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BinFile } from "../src/binfile.js";
import { AnimationSystem, animationExterns } from "../src/anim/animation.js";
import { Frme, parseObjectDef } from "../src/anim/formats.js";
import { listExterns } from "../src/anim/lists.js";

const dir = process.argv[2] || "game/g-nome/G-NOME";
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const read = (n) => new Uint8Array(readFileSync(join(dir, names.get(n))));
const packs = new Map();
const bin = new BinFile(read("G-NOME.BIN"), (n) => packs.get(n));
const res = (id) => {
  if (bin.isResident(id)) return bin.resident(id);
  const n = bin.pack(id);
  if (!packs.has(n)) packs.set(n, read(`G-NOME.${String(n).padStart(3, "0")}`));
  return packs.get(n).subarray(bin.offsets[id], bin.offsets[id] + bin.sizes[id]);
};

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// Formats: every FRME and OB3D/OPRT decodes.
let frmes = 0;
let objects = 0;
for (let id = 0; id < bin.count; id++) {
  const t = bin.type(id);
  if (t === 4 && bin.sizes[id]) {
    const f = new Frme(res(id));
    if (f.parts && f.frames) frmes++;
  } else if (t === 9 || t === 10) {
    parseObjectDef(res(id));
    objects++;
  }
}
check(frmes === 332, `${frmes} FRME resources decode`);
check(objects === 483, `${objects} OB3D/OPRT resources decode`);
const def = parseObjectDef(res(2618));
check(def.props[8] === 7 && def.props[1] === 2583, "OB3D 2618: property 8 = 7 animations, property 1 = model 2583");

// The animation set of the unit whose models are 2583-2595.
const ran = [];
const engine = { res, runLater: (id, args) => ran.push([id, ...args]) };
let speed = 0;
const shown = [];
const anim = new AnimationSystem(engine, {
  speed: () => speed,
  prop: (id, n) => ({ 12: 0, 15: 300, 33: 0 })[n] ?? 0,
  applyFrame: (id, frme, f) => shown.push(f),
  hasModel: () => true,
});
const x = animationExterns(anim);
const OBJ = 9999;
x.createAnimationList(OBJ, 7);
x.addAnimation(OBJ, 0, 1, 2598, 2605, 2612, 21, 2599, 2600, 0);
x.addAnimation(OBJ, 1, 2, 2599, 2606, 2613, 24, 0, 2599, 0);
x.addAnimation(OBJ, 2, 3, 2601, 2608, 2615, 26, 2602, 0, 0);
x.addAnimation(OBJ, 3, 0, 2602, 2609, 2616, 38, 0, 0, 0);
x.addAnimation(OBJ, 4, 0, 2603, 2610, 2617, 26, 2599, 0, 0);
x.addAnimation(OBJ, 5, 4, 2600, 2607, 2614, 21, 2597, 2598, 1721);
x.addAnimation(OBJ, 6, 11, 2597, 2604, 2611, 8, 0, 0, 0);
x.addTrigger(OBJ, 2599, 5, 2601, 0);
x.addTrigger(OBJ, 2599, 1, 2600, 0);
x.addTrigger(OBJ, 2599, 10, 2599, 0);
x.addTrigger(OBJ, 2599, 3, 2599, 0);
x.addTrigger(OBJ, 2602, 1, 2600, 1);
x.addTrigger(OBJ, 2602, 4, 2603, 0);
x.addTrigger(OBJ, 2600, 1, 2597, 0);
x.addTrigger(OBJ, 2597, 2, 2598, 1);
x.installAnimationType(OBJ, 11);
check(x.getCurrentAnimationType(OBJ) === 11, "starts idle (type 11, FRME 2597)");
check(x.GetNumFrames(2599) === 30, "GetNumFrames(2599) = 30");

// Run the way UpdateTimeStep does: accumulate ms until the frame changes,
// and recompute the rate from the speed after each change.
let acc = 0;
const tick = (ms) => {
  const r = anim.timeStep(OBJ, acc + ms);
  if (r === 0) acc += ms;
  else {
    acc = 0;
    anim.syncRate(OBJ);
  }
};
const types = new Set();
const run = (n) => {
  for (let i = 0; i < n; i++) {
    tick(33);
    types.add(x.getCurrentAnimationType(OBJ));
  }
};

speed = 0.5; // world units per second
anim.syncRate(OBJ);
run(1);
check(x.getCurrentAnimationType(OBJ) === 1, "moving switches at once to start-walking (type 1)");
run(120);
check(types.has(2), "the walk loop (type 2) follows the start clip");
const s = anim.state.get(OBJ);
check(Math.abs(s.rate - 0.5 / 0.024) < 1e-6, `walk rate = speed / stride = ${s.rate.toFixed(2)} frames/s`);
speed = 0;
types.clear();
run(200);
check(types.has(4), "stopping plays the stop clip (type 4)");
check(x.getCurrentAnimationType(OBJ) === 11, "and ends idle again");
check(
  ran.some(([id, obj]) => id === 1721 && obj === OBJ),
  "the stop clip's end script 1721 ran with the object id",
);

// Lists
const l = listExterns({ runLater: () => {} });
const id = l.ListCreate(3);
l.ListAdd(id, 7, 0);
l.ListAdd(id, 9, 0);
check(l.ListElemPosition(id, 9) === 1 && l.ListAdd(id, 7, 0) === 0, "lists add, find and refuse duplicates");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
