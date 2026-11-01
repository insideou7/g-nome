// Checks RENDER.R32's wave player (web/src/waves.js) and the Pause key:
// - five voices with priority stealing, restart in place, DirectSound
//   volume in hundredths of a dB;
// - a sound that ends posts its "done" script (DSPlayWave's 5th argument),
//   a stopped or paused one does not;
// - on the game files: the campaign briefing's narration (script 7274)
//   goes on to its next line when one ends, and Pause (SetPauseScript,
//   script 2262) pauses and resumes mission 1, sounds included.
// Usage: node web/tests/waves-check.mjs [game/g-nome/G-NOME]
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Waves, dsGain, dsPanGains } from "../src/waves.js";
import { Player, VK } from "./player.mjs";

// --- the player on its own ---------------------------------------------
{
  const posted = [];
  const engine = { time: 0, runLater: (id, args) => posted.push([id, ...args]) };
  // 1 s mono sounds at 1000 Hz
  const snd = { channels: 1, rate: 1000, priority: 0, samples: new Int16Array(1000) };
  const w = new Waves(engine, (id) => (id > 0 && id < 100 ? snd : undefined));
  const ids = () => w.voices.map((v) => v?.id ?? 0);

  assert.equal(w.play(200, 10000), 0, "not a sound");
  for (let i = 1; i <= 5; i++) assert.equal(w.play(i, 10000, 0, 0, 0, 10 + i), 1);
  assert.deepEqual(ids(), [1, 2, 3, 4, 5]);
  assert.equal(w.play(6, 10000, 0, 0, 0, 5), 0, "every voice outranks priority 5");
  assert.equal(w.play(6, 10000, 0, 0, 0, 11), 1, "priority 11 takes the voice of priority 11");
  assert.deepEqual(ids(), [6, 2, 3, 4, 5]);
  assert.equal(w.play(7, 10000, 0, 0, 0, 50), 1);
  assert.deepEqual(ids(), [7, 2, 3, 4, 5], "the lowest priority (6's 11) goes first");
  w.play(3, 10000, 0, 0, 0, 1);
  assert.deepEqual(ids(), [7, 2, 3, 4, 5], "a sound already playing restarts in its voice");
  assert.equal(w.voices[2].priority, 1);
  w.stop(0);
  assert.deepEqual(ids(), [0, 0, 0, 0, 0]);

  // done scripts
  w.play(1, 10000, 0, 0, 900);
  w.play(2, 10000, 0, 1, 901); // loops: never done
  w.play(3, 10000, 0, 0, 902);
  w.stop(3); // stopped: no done script
  engine.time = 600;
  w.service();
  assert.deepEqual(posted, []);
  w.pause(1);
  engine.time = 5000;
  w.service();
  assert.deepEqual(posted, [], "paused sounds do not end");
  w.pause(0);
  engine.time = 5399;
  w.service();
  assert.deepEqual(posted, []);
  engine.time = 5400;
  w.service();
  assert.deepEqual(posted, [[900, 1, 0]], "done script gets (id, 0) once the sound has played 1 s");
  assert.deepEqual(ids(), [0, 2, 0, 0, 0], "and its voice is free");

  assert.equal(dsGain(10000), 1);
  assert.ok(Math.abs(dsGain(6500) - 10 ** (-35 / 20)) < 1e-12, "3500 below full is -35 dB");
  assert.equal(dsGain(15000), 1);
  assert.deepEqual(dsPanGains(0), [1, 1]);
  assert.deepEqual(dsPanGains(-2000), [1, 0.1], "pan -2000: right side 20 dB down");
  console.log("waves-check: voices, priorities, done scripts and pause ok");
}

// --- on the game files --------------------------------------------------
const dir = process.argv[2] || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`waves-check: no G-NOME.BIN in ${dir}; game checks skipped`);
  process.exit(0);
}
const p = await Player.start(dir, { display: false });
const g = (n) => p.engine.vm.getGlobal(n);
const waves = p.engine.plugins.find((x) => x.name === "render").waves;
await p.waitFor(() => p.moviePlaying, "the opening movie", 60);
p.key(VK.ESCAPE);
await p.wait(200);
// GAME, NEW, CAMPAIGN: mission 1's briefing reads its lines (table G2142,
// G2144 of them) one after the other.
for (const [x, y, t] of [[163, 455, 45], [42, 165, 45], [600, 165, 60]]) {
  p.click(x, y);
  await p.wait(t);
}
assert.ok(g(2144) >= 2, `the briefing has ${g(2144)} lines`);
assert.equal(g(2143), 1, "the first line is playing");
await p.waitFor(() => g(2143) === g(2144), "the briefing's last line", 30 * 60);
await p.waitFor(() => !waves.has(g(2149)), "the last line to end", 30 * 60);
console.log(`waves-check: the briefing read all ${g(2144)} lines`);

// LAUNCH mission 1, then Pause twice.
p.key(VK.ENTER);
await p.waitFor(() => p.hasRect(8360), "LAUNCH", 60);
p.click(600, 165);
await p.waitFor(() => p.engine.world?.shown, "the battlefield", 300);
await p.wait(60);
const w = p.engine.world;
assert.equal(p.engine.input.pauseScript, 2262, "the battlefield sets pause script 2262");
assert.equal(g(979), 0);
p.key(0x13);
await p.wait(5);
assert.equal(g(979), 1, "Pause pauses the game (G979)");
assert.ok(waves.voices.every((v) => !v || v.paused), "and every sound");
const paused = w.time;
await p.wait(60);
assert.equal(w.time, paused, "the battlefield clock stops");
p.key(0x13);
await p.wait(60);
assert.equal(g(979), 0, "Pause again resumes");
assert.ok(waves.voices.every((v) => !v || !v.paused), "sounds resume");
assert.ok(w.time > paused + 1000, "and runs again");
assert.deepEqual(p.errors, []);
console.log("waves-check: Pause pauses and resumes mission 1");
process.exit(0);
