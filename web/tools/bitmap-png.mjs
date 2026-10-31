// Write bitmap resources as PNGs with the game palette.
// Usage: node web/tools/bitmap-png.mjs game/g-nome/G-NOME out-dir id [id...]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { BinFile, palette256 } from "../src/binfile.js";
import { decodeBitmap } from "../src/bitmap.js";

const [dir, out, ...ids] = process.argv.slice(2);
const bin = new BinFile(new Uint8Array(readFileSync(join(dir, "G-NOME.BIN"))), null);
const pal = palette256(bin.palette);
const chunk = (tag, data) => {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(tag, 4, "latin1");
  data.copy(b, 8);
  b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag, "latin1"), data])), 8 + data.length);
  return b;
};
for (const a of ids) {
  const id = Number(a);
  const p = readFileSync(join(dir, `G-NOME.${String(bin.pack(id)).padStart(3, "0")}`));
  const bm = decodeBitmap(new Uint8Array(p.buffer, p.byteOffset + bin.offsets[id], bin.sizes[id]));
  const raw = Buffer.alloc((bm.width + 1) * bm.height);
  for (let y = 0; y < bm.height; y++) Buffer.from(bm.pixels.subarray(y * bm.width, (y + 1) * bm.width)).copy(raw, y * (bm.width + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bm.width, 0);
  ihdr.writeUInt32BE(bm.height, 4);
  ihdr[8] = 8; ihdr[9] = 3;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", Buffer.from(pal)), chunk("tRNS", Buffer.from([0])), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(join(out, `${id}.png`), png);
}
