// Checks docs/render-r32.md against RENDER.R32 and the browser engine:
// every export of RENDER.R32 is on the page, every extern a G-NOME script
// calls has a browser version, and the page's summary counts are right.
// Usage: node web/tests/render-coverage-check.mjs [game/g-nome/G-NOME]
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disassemble } from "../src/disasm.js";
import { Player } from "./player.mjs";

const dir = process.argv[2] || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "RENDER.R32"))) {
  console.log(`render-coverage-check: no RENDER.R32 in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}

// PE export names.
function exportNames(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const pe = dv.getUint32(0x3c, true);
  const nsec = dv.getUint16(pe + 6, true), opt = pe + 24, optSize = dv.getUint16(pe + 20, true);
  const secs = [];
  for (let i = 0; i < nsec; i++) {
    const s = opt + optSize + 40 * i;
    secs.push({ va: dv.getUint32(s + 12, true), size: dv.getUint32(s + 16, true), raw: dv.getUint32(s + 20, true) });
  }
  const off = (rva) => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + x.size);
    return rva - s.va + s.raw;
  };
  const exp = off(dv.getUint32(opt + 96, true));
  const n = dv.getUint32(exp + 24, true), names = off(dv.getUint32(exp + 32, true));
  const out = [];
  for (let i = 0; i < n; i++) {
    let p = off(dv.getUint32(names + 4 * i, true)), s = "";
    while (b[p]) s += String.fromCharCode(b[p++]);
    out.push(s);
  }
  return out;
}

const exports = exportNames(new Uint8Array(readFileSync(join(dir, "RENDER.R32"))));
assert.equal(exports.length, 260);
const doc = readFileSync(new URL("../../docs/render-r32.md", import.meta.url), "utf8");
const missing = exports.filter((n) => !new RegExp(`\\b${n}\\b`).test(doc));
assert.deepEqual(missing, [], "exports missing from docs/render-r32.md");

const p = await Player.start(dir, { display: false });
const { bin } = p.engine;
const ext = p.engine.plugins.find((x) => x.name === "render").externs;
const implemented = exports.filter((n) => typeof ext[n] === "function");
const notExported = Object.keys(ext).filter((n) => !exports.includes(n));
assert.deepEqual(notExported, [], "browser externs RENDER.R32 does not export");

// Extern call sites in every script.
const calls = new Map();
for (let id = 0; id < bin.count; id++) {
  if (bin.type(id) !== 19) continue;
  for (const line of disassemble(bin, id)) for (const m of line.matchAll(/\brender\.(\w+)\(/g)) calls.set(m[1], (calls.get(m[1]) || 0) + 1);
}
const called = [...calls.keys()];
const notImplemented = called.filter((n) => typeof ext[n] !== "function");
assert.deepEqual(notImplemented, [], "externs the scripts call with no browser version");

const named = bin.externNames.filter((_, i) => bin.plugins[bin.externPlugin[i]] === "render").length;
const row = (label) => Number(doc.match(new RegExp(`\\| ${label} \\| (\\d+)`))?.[1]);
assert.equal(row("In RENDER.R32's export table"), exports.length);
assert.equal(row("Named in G-NOME.BIN's extern table \\(plugin 0\\)"), named);
assert.equal(row("Called by at least one script"), called.length);
assert.equal(row("Implemented in `web/`"), implemented.length);
assert.equal(row("Not implemented, never called"), exports.length - implemented.length);
console.log(`render-coverage-check: ${exports.length} exports documented, ${called.length} called, ${implemented.length} implemented`);
process.exit(0);
