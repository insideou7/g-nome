// Compare web/src/smacker.js with FFmpeg on a real .SMK file.
// Usage: node web/tests/smacker-check.mjs game/g-nome/G-NOME/G-NOME.SMK [frames]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { SmackerFile } from "../src/smacker.js";

const path = process.argv[2];
const limit = Number(process.argv[3] || 1e9);
const smk = new SmackerFile(readFileSync(path));
const n = Math.min(limit, smk.frameCount);
const { width: w, height: h } = smk;
console.log(`${path}: ${w}x${h}, ${smk.frameCount} frames, ${smk.frameMs} ms/frame, audio`, smk.audio);

const ref = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-frames:v", String(n),
  "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 30 });
const refAudio = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "s16le", "-"], { maxBuffer: 1 << 30 });

let bad = 0;
const samples = [];
for (let f = 0; f < n; f++) {
  const fr = smk.decodeFrame();
  for (const a of fr.audio) samples.push(a.samples);
  let diff = 0;
  for (let i = 0; i < w * h; i++) {
    const c = fr.pixels[i] * 3, o = (f * w * h + i) * 3;
    if (fr.palette[c] !== ref[o] || fr.palette[c + 1] !== ref[o + 1] || fr.palette[c + 2] !== ref[o + 2]) diff++;
  }
  if (diff) { bad++; if (bad < 5) console.log(`frame ${f}: ${diff} pixels differ`); }
}
console.log(`video: ${n - bad}/${n} frames match FFmpeg`);
const total = samples.reduce((s, a) => s + a.length, 0);
const ours = new Int16Array(total);
let o = 0; for (const a of samples) { ours.set(a, o); o += a.length; }
const theirs = new Int16Array(refAudio.buffer, refAudio.byteOffset, refAudio.byteLength >> 1);
let adiff = 0; const m = Math.min(ours.length, theirs.length);
for (let i = 0; i < m; i++) if (ours[i] !== theirs[i]) adiff++;
console.log(`audio: ours ${ours.length} samples, ffmpeg ${theirs.length}, ${adiff} differ in the first ${m}`);
process.exit(bad || (limit >= smk.frameCount && adiff) ? 1 : 0);
