// Boot the engine in Node without a display and report what the scripts hit.
// Usage: node web/tools/run-headless.mjs game/g-nome/G-NOME [--trace] [--ticks N]
//   [--mission N] [--world] [--sprites] [--regions] [--click t:x,y] [--key t:vk]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../src/engine.js";

const dir = process.argv[2] || "game/g-nome/G-NOME";
const trace = process.argv.includes("--trace");
const ti = process.argv.indexOf("--ticks");
const ticks = ti > 0 ? Number(process.argv[ti + 1]) : 200;
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = {
  read: async (name) => {
    const real = names.get(name.toUpperCase());
    if (!real) throw new Error(`missing game file ${name}`);
    return new Uint8Array(readFileSync(join(dir, real)));
  },
  has: (name) => names.has(name.toUpperCase()),
};
const engine = new Engine(files, { log: (m) => console.log(m), trace });
await engine.init();
engine.boot();
// --mission N starts campaign mission N (row of table 6984) at tick 60, the
// way the briefing's start button does (script 8317).
const mi = process.argv.indexOf("--mission");
const mission = mi > 0 ? Number(process.argv[mi + 1]) : 0;
// --click tick:x,y (repeatable) clicks in screen pixels; --key tick:vk
const events = [];
process.argv.forEach((a, i) => {
  if (a === "--click" || a === "--key") events.push([a, process.argv[i + 1]]);
});
for (let i = 0; i < ticks && !engine.quit; i++) {
  if (mission && i === 60) {
    console.log(`-- start mission ${mission}`);
    for (const g of [2118, 2119]) engine.vm.setGlobal(g, mission);
    engine.vm.setGlobal(982, 0);
    engine.run(8317);
  }
  for (const [kind, v] of events) {
    const [t, rest] = v.split(":");
    if (Number(t) !== i) continue;
    if (kind === "--key") engine.input.keyDown(Number(rest));
    else {
      const [x, y] = rest.split(",").map(Number);
      engine.mouseMove(x, y);
      engine.mouseDown(x, y);
      console.log(`-- click ${x},${y}`);
    }
  }
  engine.tick(1000 / 30);
  await new Promise((r) => setImmediate(r)); // let file reads finish
}
console.log("\nunimplemented (count):");
for (const [k, n] of [...engine.vm.unknown].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
if (process.argv.includes("--world") && engine.world) {
  const w = engine.world;
  const levels = new Map();
  for (const o of w.objects.values()) levels.set(o.level, (levels.get(o.level) || 0) + 1);
  console.log(`\nworld: state ${w.state}, ${w.objects.size} objects, levels ${JSON.stringify([...levels])}`);
  const c = w.camera;
  console.log(`camera: ${JSON.stringify({ attach: c.attach, near: c.near, far: c.far, fog: c.fog, background: c.background, backdrop: c.backdrop })}`);
  console.log(`camera pose: ${JSON.stringify(w.cameraPose(1))}`);
}
if (process.argv.includes("--sprites")) {
  console.log("\nvisible sprites:");
  for (const s of engine.sprites.visibleSorted()) {
    const r = engine.sprites.bounds(s);
    console.log(`  ${s.id} lvl ${s.level} at ${s.x},${s.y} cel ${s.cel}/${s.cels.length} (${s.cels[s.cel]}) bounds ${r.left},${r.top}..${r.right},${r.bottom}${s.queue ? " queue@" + s.queue.pos : ""}`);
  }
}
if (process.argv.includes("--regions")) {
  console.log("click rects:", JSON.stringify(engine.clickRects));
  console.log("hover rects:", JSON.stringify(engine.hoverRects));
}
