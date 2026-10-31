// An automated play-through of the menus, the LAB and campaign mission 1,
// headless in Node. It clicks and types like a player and checks what each
// screen shows, so regressions turn up here before anyone sees them in the
// browser.
//
// Usage: node web/tests/walkthrough.mjs game/g-nome/G-NOME [--shots dir]
//   [--only name,...] [--verbose]
//   --shots   save a PNG of each screen the walk visits
//   --only    run only these sections (boot, menus, options, network, game,
//             lab, exit, mission1)
//   --verbose print the engine log
// Exits non-zero if a check fails. Each section boots a fresh engine, so a
// failure in one does not hide the others. A full run takes about 15 s.
//
// Every section also fails on:
//   - a script, statement or engine error in the log, or an exception
//   - a statement, builtin or extern the engine does not implement, unless
//     it is in KNOWN_GAPS below (work in progress elsewhere)
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Player, VK } from "./player.mjs";

// Not implemented yet, and reached by this walk. Remove an entry when it is
// done; the run says when one is no longer hit.
const KNOWN_GAPS = new Set([
  "extern:render.FreeAllTextures",
  "extern:render.ObjectSetScene",
  "extern:render.UpdateLOD",
  "extern:render.GetCallbackParm",
  "extern:render.UpdateCollideCheck",
  "extern:render.Process_Sector_Collisions",
  // Sets bit 15 of the sprite's flags (0x1003f25a -> 0x10036e10) and then
  // copies a position from the sprite's +0x1c record. Sent while quitting.
  "sprite message:14",
]);

const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--verbose") opts.verbose = true;
  else if (a.startsWith("--")) opts[a.slice(2)] = process.argv[++i];
  else positional.push(a);
}
const dir = positional[0] || "game/g-nome/G-NOME";
const shotsDir = opts.shots;
const only = opts.only?.split(",");
const verbose = !!opts.verbose;
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`walkthrough: no G-NOME.BIN in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// Screen positions (640x480) of the buttons the walk presses.
const MAIN = { GAME: [163, 455], NETWORK: [240, 455], LAB: [322, 455], OPTIONS: [403, 455], EXIT: [482, 455] };
const LEFT = [[42, 165], [42, 210], [42, 255], [42, 292]]; // submenu slots 1-4
const RIGHT = [[600, 165], [600, 210], [600, 255], [600, 292]];
// The scripts behind them (table 8611 and its submenu tables).
const MAIN_SCRIPTS = [8344, 8346, 8347, 8348, 8349];
const SUBMENUS = {
  GAME: [8357, 8367, 8366, 8389], // NEW, LOAD, SAVE, CREDITS
  NETWORK: [8370, 8371, 8369], // HOST, JOIN, PROTOCOL
  LAB: [8372, 8373, 8374, 8375], // VEHICLES, STRUCTURES, PERSONNEL, WEAPONS
  OPTIONS: [8380, 8381, 8382, 8383], // INTERFACE, DIFFICULTY, SOUND, DETAIL
};
const LAB_PREVIEW = [150, 60, 330, 330]; // the turning model on LAB screens
const BRIEF_MAP = [130, 40, 330, 240];
const BRIEF_PREVIEW = [340, 40, 510, 240];
const VIEWPORT = [60, 90, 570, 265]; // the 3D view through the cockpit

let failures = 0;
let section = "";
const gapsSeen = new Set();

function check(ok, what, detail = "") {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
  return ok;
}

async function start() {
  const p = await Player.start(dir, { verbose });
  p.shot = (name) => shotsDir && p.savePng(join(shotsDir, `${section}-${name}.png`));
  return p;
}

// Boot, skip the opening movie, wait for the main menu.
async function toMainMenu(p) {
  await p.waitFor(() => p.moviePlaying, "the opening movie", 60);
  p.key(VK.ESCAPE);
  await p.waitFor(() => MAIN_SCRIPTS.every((s) => p.hasRect(s)), "the main menu", 150);
  await fadedIn(p);
}

// The palette fade after a movie (out, then in) takes about 100 ticks.
const fadedIn = (p, what = "the menu to fade in") => p.waitFor(() => !p.engine.fades.length && p.region().colours > 100, what, 200);

// Left-column click regions (the submenu buttons), by script.
const leftScripts = (p) => p.rects().filter((r) => r.l < 100 && r.t < 400).map((r) => r.script).sort();
const rightScripts = (p) => p.rects().filter((r) => r.l > 540 && r.t < 400).map((r) => r.script).sort();
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const hasText = (p, t) => p.texts().some((s) => s.includes(t));

async function press(p, [x, y], ticks = 45) {
  p.click(x, y);
  await p.wait(ticks);
}

// Errors and unimplemented operations since the section started.
function finish(p) {
  check(p.errors.length === 0, "no engine errors", p.errors.slice(0, 5).join(" | "));
  const unknown = [...p.unknown().keys()];
  for (const k of unknown) gapsSeen.add(k);
  const fresh = unknown.filter((k) => !KNOWN_GAPS.has(k));
  check(fresh.length === 0, "no unimplemented operations outside KNOWN_GAPS", fresh.join(", "));
}

const SECTIONS = {
  async boot(p) {
    await p.waitFor(() => p.moviePlaying, "the opening movie", 60);
    await p.wait(10);
    check(p.region().colours > 16, "the opening movie draws");
    p.shot("intro");
    p.key(VK.ESCAPE);
    const t = await p.waitFor(() => MAIN_SCRIPTS.every((s) => p.hasRect(s)), "the main menu", 150);
    check(t < 60, "Esc skips the movie to the main menu", `${t} ticks`);
    check(!p.moviePlaying, "the movie stops");
    const f = await fadedIn(p);
    check(f < 120, "the main menu fades in", `${f} ticks`);
    check(p.rects().length === 5, "only the five main buttons take clicks", `${p.rects().length} regions`);
    p.shot("main-menu");
    p.hover(...MAIN.GAME);
    await p.wait(5);
    check(hasText(p, "Start a Game"), "hovering GAME shows its status text", JSON.stringify(p.texts()));
  },

  // Every submenu twice, in an order that goes from four buttons to three:
  // each must offer exactly its own buttons, and the second round must not
  // create more sprites than the first.
  async menus(p) {
    await toMainMenu(p);
    const order = ["GAME", "OPTIONS", "NETWORK", "LAB", "NETWORK", "GAME"];
    let firstRound = 0;
    for (let round = 1; round <= 2; round++) {
      for (const name of order) {
        await press(p, MAIN[name]);
        const want = SUBMENUS[name];
        const got = leftScripts(p);
        check(same(got, want), `round ${round}: ${name} offers its ${want.length} buttons`, `regions ${got}`);
        if (round === 1) p.shot(name.toLowerCase());
      }
      const n = p.engine.sprites.list.size;
      if (round === 1) firstRound = n;
      else check(n <= firstRound, "revisiting the menus creates no new sprites", `${firstRound} -> ${n}`);
    }
    await press(p, MAIN.NETWORK);
    check(p.clickTarget(...LEFT[3]) === 0, "NETWORK's empty fourth slot does nothing", `runs script ${p.clickTarget(...LEFT[3])}`);
    finish(p);
  },

  async options(p) {
    await toMainMenu(p);
    await press(p, MAIN.OPTIONS);
    await press(p, LEFT[0], 60);
    check(hasText(p, "Configure Input Devices") && hasText(p, "Fire Weapon 1"), "INTERFACE lists the key bindings");
    check(p.rects().length > 30, "INTERFACE's binding cells take clicks", `${p.rects().length} regions`);
    p.shot("interface");
    const screens = [
      [1, "DIFFICULTY", [6936, 6937, 6938]],
      [2, "SOUND", [6944, 6945, 6946, 6947]],
      [3, "DETAIL", [6954, 6955, 6956]],
    ];
    for (const [slot, name, scripts] of screens) {
      await press(p, LEFT[slot], 60);
      const missing = scripts.filter((s) => !p.hasRect(s));
      check(missing.length === 0, `${name} shows its controls`, `missing ${missing}`);
      check(!p.hasRect(6365), `${name} has put away INTERFACE's cells`);
      p.shot(name.toLowerCase());
    }
    // Pick a difficulty and turn the volume down; the screens stay up.
    await press(p, [260, 215], 30);
    await press(p, LEFT[2], 60);
    await press(p, [232, 158], 30);
    check(p.hasRect(6944), "SOUND still up after using a control");
    finish(p);
  },

  async network(p) {
    await toMainMenu(p);
    await press(p, MAIN.NETWORK);
    const status = ["Host a New Multi-Player Game", "Join an Existing Game", "Select Network Protocol"];
    for (let i = 0; i < 3; i++) {
      await press(p, LEFT[i], 60);
      check(hasText(p, status[i]), `${status[i]} (no network providers, no crash)`, JSON.stringify(p.texts()));
    }
    check(same(leftScripts(p), SUBMENUS.NETWORK), "NETWORK's buttons are still there");
    finish(p);
  },

  async game(p) {
    await toMainMenu(p);
    await press(p, MAIN.GAME);
    await press(p, LEFT[0]);
    check(same(rightScripts(p), [8363, 8364, 8365]), "NEW offers CAMPAIGN, TRAINING, MISSION", `regions ${rightScripts(p)}`);
    await press(p, RIGHT[1], 60);
    const items = p.sprites().filter((s) => s.click);
    check(items.length >= 3, "TRAINING lists the training missions", `${items.length} clickable items`);
    p.shot("training");
    await press(p, RIGHT[2], 60);
    check(hasText(p, "Select a Mission to Play"), "MISSION shows the mission list");
    check(items.every((s) => !p.sprite(s.id)), "the training list is gone");
    p.shot("mission-list");
    await press(p, LEFT[1], 60);
    check(p.rects().filter((r) => r.script === 6287).length === 8, "LOAD lists eight save slots");
    check(p.hasRect(6295), "LOAD has a scroll bar");
    check(rightScripts(p).length === 0, "LOAD has put away NEW's buttons", `regions ${rightScripts(p)}`);
    p.shot("load");
    await press(p, LEFT[3], 30);
    check(p.moviePlaying, "CREDITS plays the credits movie");
    await p.wait(30);
    p.key(VK.ESCAPE);
    await p.waitFor(() => !p.moviePlaying && MAIN_SCRIPTS.every((s) => p.hasRect(s)), "the menu after the credits", 150);
    await fadedIn(p, "the menu after the credits");
    check(true, "Esc ends the credits and the menu comes back");
    finish(p);
  },

  async lab(p) {
    await toMainMenu(p);
    await press(p, MAIN.LAB);
    const screens = [
      ["VEHICLES", "Review Vehicles", "Darken Sentry HAWC"],
      ["STRUCTURES", "Review Structures", "Meson Tower"],
      ["PERSONNEL", "Review Personnel", "Darken Infantry"],
      ["WEAPONS", "Review Weapons", "AIM9"],
    ];
    for (let i = 0; i < screens.length; i++) {
      const [name, title, first] = screens[i];
      await press(p, LEFT[i], 60);
      check(hasText(p, title) && hasText(p, first), `${name} shows ${first}`, JSON.stringify(p.texts().slice(0, 3)));
      check(same(rightScripts(p), [8376, 8377, 8378, 8379]), `${name} offers the four sides`);
      const a = p.screen();
      check(p.region(...LAB_PREVIEW, a).lit > 1000, `${name} draws the 3D model`, `${p.region(...LAB_PREVIEW, a).lit} lit pixels`);
      p.shot(name.toLowerCase());
      if (i < 3) {
        await p.wait(5);
        check(Player.diff(a, p.screen(), ...LAB_PREVIEW) > 500, `${name}'s model turns`);
      }
    }
    // Next unit on VEHICLES.
    await press(p, LEFT[0], 60);
    const arrows = p.sprites().filter((s) => s.click);
    check(arrows.length === 2, "VEHICLES has the previous and next arrows", `${arrows.length}`);
    await press(p, [280, 361], 30);
    check(hasText(p, "Darken Tactical Defense HAWC"), "the next arrow shows the next vehicle", JSON.stringify(p.texts().slice(0, 2)));
    finish(p);
  },

  // The EXIT prompt is modal: nothing else takes clicks until Y or N.
  async exit(p) {
    await toMainMenu(p);
    await press(p, MAIN.EXIT, 30);
    check(hasText(p, "Exit G-Nome"), "EXIT asks to confirm");
    check(p.rects().length === 0, "nothing else takes clicks while it asks", `${p.rects().length} regions`);
    p.shot("prompt");
    await press(p, MAIN.GAME, 30);
    check(!p.hasRect(SUBMENUS.GAME[0]), "clicking GAME behind the prompt does nothing");
    p.key(VK.N);
    await p.wait(30);
    check(MAIN_SCRIPTS.every((s) => p.hasRect(s)), "N returns to the menu");
    await press(p, MAIN.GAME);
    check(same(leftScripts(p), SUBMENUS.GAME), "GAME works again after N");
    await press(p, MAIN.EXIT, 30);
    p.key(VK.Y);
    await p.wait(90);
    check(p.engine.quit, "Y quits the game");
    finish(p);
  },

  // NEW, CAMPAIGN, the briefing, LAUNCH, then a few seconds of mission 1.
  async mission1(p) {
    await toMainMenu(p);
    await press(p, MAIN.GAME);
    await press(p, LEFT[0]);
    await press(p, RIGHT[0], 60);
    check(hasText(p, "1-1: Renegade Mercs"), "CAMPAIGN briefs mission 1-1", JSON.stringify(p.texts()));
    check(hasText(p, "Head for waypoint one"), "the briefing lists the first objective");
    const map = p.region(...BRIEF_MAP);
    check(map.colours > 10 && map.lit > map.area * 0.9, "the briefing draws the map", JSON.stringify(map));
    const a = p.screen();
    check(p.region(...BRIEF_PREVIEW, a).lit > 1000, "the briefing draws the unit preview");
    await p.wait(5);
    check(Player.diff(a, p.screen(), ...BRIEF_PREVIEW) > 200, "the unit preview turns");
    p.shot("briefing");
    p.key(VK.ENTER);
    await p.waitFor(() => p.hasRect(8360), "LAUNCH", 60);
    check(true, "Enter ends the briefing and offers LAUNCH");
    p.click(...RIGHT[0]);
    const t = await p.waitFor(() => p.engine.world?.shown, "the battlefield", 300);
    check(t < 150, "LAUNCH starts the mission", `${t} ticks`);
    await p.wait(60);
    const w = p.engine.world;
    const ground = [...w.objects.values()].filter((o) => o.level === -100);
    check(ground.length === 748, "mission 1 lays 748 ground tiles", `${ground.length}`);
    check(!!w.camera.attach, "the camera rides on the player's unit");
    const view = p.region(...VIEWPORT);
    check(view.colours > 30 && view.lit > view.area * 0.9, "the 3D view draws sky and ground", JSON.stringify(view));
    check(p.region(0, 300, 640, 480).colours > 50, "the cockpit is drawn over it");
    check(p.texts().length > 0, "the HUD shows its readouts", JSON.stringify(p.texts()));
    p.shot("battlefield");
    const at0 = w.cameraPose(1).at;
    await p.holdKey(VK.RIGHT, 30);
    await p.wait(2);
    const at1 = w.cameraPose(1).at;
    check(Math.hypot(at1[0] - at0[0], at1[2] - at0[2]) > 0.1, "holding Right turns the unit");
    p.shot("turned");
    await p.wait(150);
    check(w.shown && !p.engine.quit, "five more seconds run without leaving the mission");
    finish(p);
  },
};

const t0 = Date.now();
for (const [name, run] of Object.entries(SECTIONS)) {
  if (only && !only.includes(name)) continue;
  section = name;
  console.log(`${name}:`);
  try {
    await run(await start());
  } catch (e) {
    check(false, `${name} ran to the end`, e.stack || String(e));
  }
}
if (!only) {
  const stale = [...KNOWN_GAPS].filter((k) => !gapsSeen.has(k));
  if (stale.length) console.log(`\nKNOWN_GAPS entries no longer hit (remove them): ${stale.join(", ")}`);
}
console.log(`\n${failures ? `${failures} FAILED` : "all passed"} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failures ? 1 : 0);
