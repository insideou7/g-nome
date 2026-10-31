// Boot the engine in Node without a display and report what the scripts hit.
// Usage: node web/tools/run-headless.mjs game/g-nome/G-NOME [--trace] [--ticks N]
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
for (let i = 0; i < ticks && !engine.quit; i++) {
  engine.tick(1000 / 30);
  await new Promise((r) => setImmediate(r)); // let file reads finish
}
console.log("\nunimplemented (count):");
for (const [k, n] of [...engine.vm.unknown].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
