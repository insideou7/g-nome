// Check OPTIONS > SOUND: the volume sliders and the CD music track lookup.
// Usage: node web/tests/sound-options-check.mjs [game/g-nome/G-NOME]
// Without the game folder only the track-name checks run.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { trackNumber } from "../src/music.js";
import { gameFolder } from "../src/gamefiles.js";
import { Engine, Ini } from "../src/engine.js";

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// Track file names
const names = { "TRACK02.OGG": 2, "TRACK 13.MP3": 13, "G-NOME TRACK 7.FLAC": 7, "05.WAV": 5, "MUSIC/TRACK 20 (G-NOME).OGG": 20, "TRK_01B.WAV": 0, "SQEEL.WAV": 0, "G-NOME.002": 0, "TRACK02.TXT": 0 };
for (const [n, t] of Object.entries(names)) check(trackNumber(n) === t, `track number of ${n} is ${t}`);

const entry = (path) => ({ path, size: 0, read: async () => new Uint8Array() });
const f = gameFolder([entry("CD/G-NOME/G-NOME.BIN"), entry("CD/G-NOME/Music/Track02.ogg"), entry("CD/G-NOME/OTHER/TRACK03.OGG")]);
check(f.has("MUSIC/TRACK02.OGG"), "sees tracks in a MUSIC folder inside the game folder");
check(!f.has("OTHER/TRACK03.OGG") && !f.has("TRACK03.OGG"), "ignores other subfolders");

const dir = process.argv[2] || "game/g-nome/G-NOME";
if (existsSync(join(dir, "G-NOME.BIN"))) {
  const real = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
  const files = {
    names: [...real.keys()],
    read: async (n) => new Uint8Array(readFileSync(join(dir, real.get(n.toUpperCase())))),
    has: (n) => real.has(n.toUpperCase()),
  };
  // A stand-in for audio.js that records what the engine asks for.
  const volumes = {};
  const audio = { setVolume: (bus, v) => (volumes[bus] = v), play: () => null, stopSound() {}, queue() {}, stop() {}, now: () => 0, stopMusic() {}, playMusic: async () => null };
  const ini = new Ini({ browser: { musicvolume: "40" } });
  const e = new Engine(files, { log() {}, audio, ini });
  await e.init();
  check(e.volumes.level("music") === 40 && volumes.music === 0.4, "restores a saved level");
  check(e.volumes.level("effects") === 100 && volumes.effects === 1, "defaults to full volume");
  check(!e.music.available, "notices there are no CD tracks in this folder");
  e.boot();
  let tick = 0;
  const run = async (n) => {
    for (let i = 0; i < n; i++, tick++) {
      e.tick(1000 / 30);
      await new Promise((r) => setImmediate(r));
    }
  };
  const click = (x, y) => {
    e.mouseMove(x, y);
    e.mouseDown(x, y);
    e.mouseUp(x, y);
  };
  await run(60);
  e.input.keyDown(0x1b); // skip the intro
  await run(200);
  check(!e.volumes.shown, "sliders are hidden on the main menu");
  click(398, 455); // OPTIONS
  await run(60);
  check(!e.volumes.shown, "sliders are hidden on OPTIONS > INTERFACE");
  click(41, 250); // SOUND
  await run(30);
  check(e.volumes.shown, "sliders show on OPTIONS > SOUND");
  // Drag the music slider from 0 to the middle.
  const bar = 318 + 16 + 4;
  e.mouseMove(200, bar);
  e.mouseDown(235, bar);
  check(e.volumes.level("music") === 0, "clicking the left end sets 0");
  e.mouseMove(325, bar);
  e.mouseUp(325, bar);
  check(e.volumes.level("music") === 50 && volumes.music === 0.5, "dragging sets the level and the bus volume");
  check(ini.get("browser", "musicvolume") === "50", "the level is saved");
  e.mouseDown(415, 362 + 16 + 4);
  e.mouseUp(415, 362 + 16 + 4);
  check(e.volumes.level("effects") === 100, "SFX/Dialogue slider works");
  // The game's own toggles still work: CD Music Off (click region 6945).
  click(325 + 30, 175);
  await run(5);
  check(e.vm.getGlobal(2115) === 1, "the CD Music Off toggle still works");
  click(325 - 50, 175);
  await run(5);
  check(e.vm.getGlobal(2115) === 0, "the CD Music On toggle still works");
  click(41, 210); // DIFFICULTY
  await run(30);
  check(!e.volumes.shown, "sliders go away on another options page");
} else console.log(`(no game files in ${dir}: skipped the engine checks)`);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
