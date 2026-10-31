// Decode every type 1 bitmap; report failures. Usage: node web/tests/bitmaps-check.mjs game/g-nome/G-NOME
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BinFile } from "../src/binfile.js";
import { decodeBitmap } from "../src/bitmap.js";
const dir = process.argv[2];
const bin = new BinFile(new Uint8Array(readFileSync(join(dir, "G-NOME.BIN"))), null);
const packs = new Map();
let ok = 0, bad = 0, packed = 0;
for (let i = 0; i < bin.count; i++) {
  if (bin.type(i) !== 1) continue;
  const n = bin.pack(i);
  if (!packs.has(n)) packs.set(n, new Uint8Array(readFileSync(join(dir, `G-NOME.${String(n).padStart(3, "0")}`))));
  const b = packs.get(n).subarray(bin.offsets[i], bin.offsets[i] + bin.sizes[i]);
  try {
    const bm = decodeBitmap(b);
    if (bm.pixels.length !== bm.width * bm.height) throw new Error("size");
    if (!(new DataView(b.buffer, b.byteOffset).getUint32(8, true) & 0x80)) packed++;
    ok++;
  } catch (e) {
    if (bad++ < 5) console.log(`bitmap ${i}: ${e.message}`);
  }
}
console.log(`${ok} decoded (${packed} packed), ${bad} failed`);
process.exit(bad ? 1 : 0);
