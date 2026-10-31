// Usage: node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN 404 [2564 ...]
import { readFileSync } from "node:fs";
import { BinFile } from "../src/binfile.js";
import { disassemble } from "../src/disasm.js";
import { BUILTIN_NAMES } from "../src/builtins.js";
const bin = new BinFile(new Uint8Array(readFileSync(process.argv[2])), null);
const ids = process.argv.slice(3);
const all = ids[0] === "all" ? [...Array(bin.count).keys()].filter((i) => bin.type(i) === 19) : ids.map(Number);
for (const id of all) {
  console.log(`; script ${id} (${bin.sizes[id]} bytes)`);
  for (const l of disassemble(bin, id, BUILTIN_NAMES)) console.log("  " + l);
  console.log();
}
