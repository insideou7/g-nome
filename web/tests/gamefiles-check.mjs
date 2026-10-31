// Check the game-file loaders: folder choice and the .zip reader.
// Usage: node web/tests/gamefiles-check.mjs [game.zip]
// Without a zip it checks folder choice and a zip built here in memory.
import { openAsBlob } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { gameFolder, fromZip, zipEntries, NoGameError } from "../src/gamefiles.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const entry = (path, text = path) => ({ path, size: text.length, read: async () => new TextEncoder().encode(text) });

// The CD has other games' RTLIB32.DLL; only the G-NOME folder's must be used.
const cd = gameFolder([
  entry("CD/DOMINION/RTLIB32.DLL", "wrong"),
  entry("CD/DOMINION/DOMINION.BIN"),
  entry("CD/G-NOME/RTLIB32.DLL", "right"),
  entry("CD/G-NOME/g-nome.bin"),
  entry("CD/G-NOME/SUB/G-NOME.000"),
]);
check(cd.dir === "CD/G-NOME", "picks the folder that holds G-NOME.BIN");
check(new TextDecoder().decode(await cd.read("rtlib32.dll")) === "right", "reads that folder's files, any case");
check(!cd.has("G-NOME.000"), "ignores files in subfolders");
check(gameFolder([entry("G-NOME.BIN")]).has("g-nome.bin"), "works when the folder itself is picked");
try {
  gameFolder([entry("a/b.txt")]);
  check(false, "reports a missing G-NOME.BIN");
} catch (e) {
  check(e instanceof NoGameError, "reports a missing G-NOME.BIN");
}

// A small zip, stored and deflated entries
function zip(files) {
  const enc = new TextEncoder();
  const parts = [], cdir = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const n = enc.encode(name), raw = enc.encode(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(8, deflate ? 8 : 0, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, raw.length, true);
    h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, deflate ? 8 : 0, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), n, data);
    cdir.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + data.length;
  }
  const size = cdir.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, off, true);
  return new Blob([...parts, ...cdir, new Uint8Array(e.buffer)]);
}
const small = await fromZip(zip([["game/G-NOME/G-NOME.BIN", "bin", false], ["game/G-NOME/README.TXT", "hello ".repeat(100), true]]));
check(new TextDecoder().decode(await small.read("G-NOME.BIN")) === "bin", "zip: stored entry");
check(new TextDecoder().decode(await small.read("readme.txt")) === "hello ".repeat(100), "zip: deflated entry");

// The real game zip, when given
const path = process.argv.slice(2).find((a) => /\.zip$/i.test(a));
if (path) {
  const blob = await openAsBlob(path);
  const entries = await zipEntries(blob);
  const files = await fromZip(blob);
  check(entries.length > 100, `zip: ${entries.length} entries`);
  const bin = await files.read("G-NOME.BIN");
  const size = entries.find((e) => /(^|\/)G-NOME\/G-NOME\.BIN$/i.test(e.path)).size;
  check(bin.length === size, `zip: ${files.dir}/G-NOME.BIN inflates to ${bin.length} bytes`);
  const t = performance.now();
  let total = 0;
  for (const n of files.names.filter((n) => /^G-NOME\.\d{3}$/.test(n))) total += (await files.read(n)).length;
  check(total > 50e6, `zip: all packs, ${(total / 1e6).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}
if (failed) process.exit(1);
