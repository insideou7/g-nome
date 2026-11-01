// An automated play-through of the menus, the LAB and campaign mission 1,
// headless in Node. It clicks and types like a player and checks what each
// screen shows, so regressions turn up here before anyone sees them in the
// browser.
//
// Usage: node web/tests/walkthrough.mjs game/g-nome/G-NOME [--shots dir]
//   [--only name,...] [--verbose]
//   --shots   save a PNG of each screen the walk visits
//   --only    run only these sections (boot, menus, options, controls,
//             network, game, lab, exit, mission1, saves)
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
import { Player, VK, MemoryStorage } from "./player.mjs";
import { Ini } from "../src/engine.js";
import { exportSaves, importSaves } from "../src/saves.js";
import { basisFromAt } from "../src/battlefield/math.js";
import { table } from "../src/builtins.js";

// Not implemented yet, and reached by this walk. Remove an entry when it is
// done; the run says when one is no longer hit.
const KNOWN_GAPS = new Set([
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
// OPTIONS > INTERFACE: the centre of the cell for binding row r (0 = Fire
// Weapon 1), mapping column c (0..2); the prompt's buttons under the list.
const CELL = (r, c) => [304 + 77 * c, 122 + 21 * r];
const ROW = { FIRE1: 0, FIRE2: 1, TURN_RIGHT: 5 };
const PROMPT = { CLEAR: [372, 385], USE: [424, 385], CANCEL: [476, 385] };
const USE_SAVE = [424, 78];
const PROMPT_SPRITE = 6400;
const CROSSHAIR = 562; // cockpit crosshair sprite (scripts 575-577)
const KEY_MAP = 6323; // the bindings on screen: rows of {action, ?, device, key} x 3
const HELD_BINDINGS = 2546; // what missions read: {action, device, key} rows
const VK_CTRL = 0x11;
const VK_D = 0x44, VK_G = 0x47, VK_W = 0x57; // D and G are free in the default map
const LAB_PREVIEW = [150, 60, 330, 330]; // the turning model on LAB screens
const BRIEF_MAP = [130, 40, 330, 240];
const BRIEF_PREVIEW = [340, 40, 510, 240];
const VIEWPORT = [60, 90, 570, 265]; // the 3D view through the cockpit
const RADAR = [230, 370, 410, 455]; // inside the HAWC cockpit's radar oval
const SAVE_SLOT = 6287; // a row on the LOAD and SAVE lists (script 6287)
const CAMPAIGN = 2119, CURRENT_MISSION = 2141; // next campaign mission, the one briefed
const PROGRESS = 6984; // what a save holds: rows of {key, table}, the tables' first columns
// The values script 6291 writes to a save, as text: for each row of
// table 6984 with a key under 30, the key and column 0 of its table.
const progress = (p) => {
  const vm = p.engine.vm;
  const get = (id, i, j) => {
    const t = table(vm, id);
    return t.data[t.strides[0] * i + t.strides[1] * j];
  };
  const out = [];
  for (let i = 0; i < table(vm, PROGRESS).header[10] && get(PROGRESS, i, 0) < 30; i++) {
    const sub = get(PROGRESS, i, 1);
    out.push(`${get(PROGRESS, i, 0)}:${Array.from({ length: table(vm, sub).header[10] }, (_, j) => get(sub, j, 0)).join(",")}`);
  }
  return out.join(" ");
};

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

// INTERFACE cell (row, column) as [device, key].
const binding = (p, r, c) => {
  const t = table(p.engine.vm, KEY_MAP);
  return [t.data[r * 8 + 2 + 2 * c], t.data[r * 8 + 3 + 2 * c]];
};
// The {action, device, key} rows of a binding table, as "a/d/k" strings.
const bindRows = (p, id) => {
  const t = table(p.engine.vm, id), out = [];
  for (let o = 0; o + 2 < t.data.length && t.data[o] !== -1; o += 3) out.push(`${t.data[o]}/${t.data[o + 1]}/${t.data[o + 2]}`);
  return out;
};

// GAME, NEW, CAMPAIGN, past the briefing, LAUNCH; waits for the battlefield.
async function launchMission1(p) {
  await press(p, MAIN.GAME);
  await press(p, LEFT[0]);
  await press(p, RIGHT[0], 60);
  p.key(VK.ENTER);
  await p.waitFor(() => p.hasRect(8360), "LAUNCH", 60);
  p.click(...RIGHT[0]);
  return p.waitFor(() => p.engine.world?.shown, "the battlefield", 300);
}

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

  // Rebind keys on OPTIONS > INTERFACE, save them, find them again after a
  // restart and drive with them in mission 1.
  async controls(p) {
    await toMainMenu(p);
    await press(p, MAIN.OPTIONS);
    await press(p, LEFT[0], 60);
    check(p.engine.keyConflicts.shown && p.engine.keyConflicts.cells.length === 0, "the default keys have no conflicts", JSON.stringify(p.engine.keyConflicts.cells));
    await press(p, CELL(ROW.FIRE1, 0), 10);
    check(!!p.sprite(PROMPT_SPRITE) && !!p.engine.input.captureScript, "clicking a binding asks for a key");
    p.shot("prompt");
    p.key(VK_G);
    await p.wait(10);
    check(same(binding(p, ROW.FIRE1, 0), [0, VK_G]), "a key press rebinds Fire Weapon 1 to G", `${binding(p, ROW.FIRE1, 0)}`);
    check(p.texts().includes("G") && !p.sprite(PROMPT_SPRITE) && !p.engine.input.captureScript, "the cell shows G and the prompt closes");
    await press(p, CELL(ROW.FIRE1, 1), 10);
    await press(p, PROMPT.CLEAR, 10);
    check(same(binding(p, ROW.FIRE1, 1), [0, 0]), "Clear empties a binding", `${binding(p, ROW.FIRE1, 1)}`);
    const before = binding(p, ROW.FIRE2, 0);
    await press(p, CELL(ROW.FIRE2, 0), 10);
    await press(p, PROMPT.CANCEL, 10);
    p.key(VK_W);
    await p.wait(10);
    check(same(binding(p, ROW.FIRE2, 0), before) && !p.engine.input.captureScript, "Cancel keeps the old binding");
    // G on Fire Weapon 2 as well: both cells are marked, and Clear fixes it.
    await press(p, CELL(ROW.FIRE2, 2), 10);
    p.key(VK_G);
    await p.wait(10);
    const marked = p.engine.keyConflicts.visibleCells().map((c) => `${c.row}.${c.col}`).sort();
    check(same(marked, [`${ROW.FIRE1}.0`, `${ROW.FIRE2}.2`]), "a key used twice marks both cells", marked.join(" "));
    p.shot("conflict");
    await press(p, CELL(ROW.FIRE2, 2), 10);
    await press(p, PROMPT.CLEAR, 10);
    check(p.engine.keyConflicts.cells.length === 0, "clearing one of them removes the marks");
    await press(p, CELL(ROW.TURN_RIGHT, 0), 10);
    p.key(VK_D);
    await p.wait(10);
    // Ctrl on its own (a port addition: the original skips Shift and Ctrl).
    await press(p, CELL(ROW.FIRE2, 2), 10);
    p.engine.input.keyDown(VK_CTRL, false, true);
    await p.wait(2);
    p.engine.input.keyUp(VK_CTRL);
    await p.wait(10);
    check(same(binding(p, ROW.FIRE2, 2), [0, VK_CTRL]) && p.texts().includes("CTRL") && !p.engine.input.captureScript, "Ctrl pressed alone binds Ctrl", `${binding(p, ROW.FIRE2, 2)}`);
    await press(p, CELL(ROW.FIRE2, 1), 10);
    p.engine.input.keyDown(VK_CTRL, false, true);
    p.engine.input.keyDown(VK.UP, false, true);
    p.engine.input.keyUp(VK.UP);
    p.engine.input.keyUp(VK_CTRL);
    await p.wait(10);
    check(same(binding(p, ROW.FIRE2, 1), [1, VK.UP]), "Ctrl+Up still binds Ctrl+Up", `${binding(p, ROW.FIRE2, 1)}`);
    await press(p, USE_SAVE, 30);
    const held = bindRows(p, HELD_BINDINGS);
    check(held.includes(`29/0/${VK_G}`) && held.includes(`1/0/${VK_D}`) && !held.includes("1/5/39"), "Use/Save hands the new keys to the game", held.slice(0, 12).join(" "));
    check(p.storage.getItem("g-nome.file.GKEY0.MAP") !== null, "Use/Save keeps the key map in browser storage");
    finish(p);

    const p2 = await Player.start(dir, { verbose, ini: p.ini, storage: p.storage });
    p2.shot = p.shot;
    await toMainMenu(p2);
    check(bindRows(p2, HELD_BINDINGS).includes(`1/0/${VK_D}`), "the saved keys come back after a restart");
    const t = await launchMission1(p2);
    check(t < 150, "mission 1 starts with the new keys", `${t} ticks`);
    await p2.wait(60);
    const w = p2.engine.world;
    const turned = async (vk) => {
      const a = w.cameraPose(1).at;
      await p2.holdKey(vk, 30);
      await p2.wait(2);
      const b = w.cameraPose(1).at;
      return Math.hypot(b[0] - a[0], b[2] - a[2]) > 0.1;
    };
    check(!(await turned(VK.RIGHT)), "Right no longer turns the unit");
    check(await turned(VK_D), "D turns the unit right");
    // Fire Weapon 2 (action 30) is on Ctrl alone now
    const vm = p2.engine.vm;
    const fire2 = () => w.controls.check(2544, HELD_BINDINGS, 30, vm.getGlobal(1854) + 2, vm.getGlobal(1857));
    const idle = fire2();
    p2.engine.input.keyDown(VK_CTRL, false, true);
    const heldNow = fire2();
    p2.engine.input.keyUp(VK_CTRL);
    check(idle === 0 && heldNow === 1, "holding Ctrl fires weapon 2", `${idle} -> ${heldNow}`);
    finish(p2);
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
    // The far ground tiles once drew lit with Surface 0 0 0, which left a
    // black band (about 900 pixels) between the ground and the backdrop.
    check(view.area - view.lit < 100, "no black band at the horizon", `${view.area - view.lit} black pixels`);
    check(p.region(0, 300, 640, 480).colours > 50, "the cockpit is drawn over it");
    check(p.texts().length > 0, "the HUD shows its readouts", JSON.stringify(p.texts()));
    p.shot("battlefield");
    const at0 = w.cameraPose(1).at;
    const view0 = w.view.camera?.view(); // the renderer's world-to-camera matrix
    await p.holdKey(VK.RIGHT, 30);
    await p.wait(2);
    const at1 = w.cameraPose(1).at;
    check(Math.hypot(at1[0] - at0[0], at1[2] - at0[2]) > 0.1, "holding Right turns the unit");
    // Where the new forward direction was in the old view: the renderer draws
    // camera +X on the left (as RenderWare does), so a turn to the right has
    // x < 0. A mirrored 3D view would turn left when Right is held.
    const x = view0 ? at1[0] * view0[0] + at1[1] * view0[4] + at1[2] * view0[8] : NaN;
    check(x < -0.1, "Right turns the 3D view to the right (the view is not mirrored)", x.toFixed(2));
    p.shot("turned");
    await p.wait(150);
    check(w.shown && !p.engine.quit, "five more seconds run without leaving the mission");
    // Pause (VK 0x13) runs the pause script RENDER.R32 was given
    // (SetPauseScript 2262): TimersPause, SpritePause and Pause3D hold the
    // game until Pause is pressed again, and the timers then run on from
    // where they were.
    const e = p.engine;
    const due = () => [...e.timers.values()].map((t) => t.due - e.time);
    p.key(0x13);
    await p.wait(2);
    const left = due();
    check(e.vm.getGlobal(979) === 1 && e.timersPaused && w.state === 4, "Pause pauses the mission", `G979 ${e.vm.getGlobal(979)}, world state ${w.state}`);
    check([...e.sprites.list.values()].some((s) => s.pausedAt !== undefined), "Pause pauses the sprites");
    await p.wait(60); // 2000 ms
    check(left.length > 0 && due().every((d, i) => Math.abs(d + 2000 - left[i]) < 1), "the game's timers wait while paused", `${left} -> ${due()}`);
    p.key(0x13);
    await p.wait(2);
    check(e.vm.getGlobal(979) === 0 && !e.timersPaused && w.state !== 4, "Pause again resumes the mission");
    // two ticks after pausing and two after resuming: the same time left
    check(due().every((d, i) => Math.abs(d - left[i]) < 1), "the timers run on from where they stopped", `${left} -> ${due()}`);
    // Up close a unit switches to its near model, which ObjectSetScene puts
    // in a scene of its own (flag 0x80); it must still be drawn.
    const r3d = p.engine.render3d;
    const mech = [...w.objects.values()].find((o) => r3d.objects.getProperty(o.id, 0) === 141 && Math.hypot(o.pos[0] + 49.88, o.pos[2] + 12.38) < 2);
    const me = w.get(p.engine.vm.getGlobal(973));
    me.setPosition([mech.pos[0], 0, mech.pos[2] + 4]);
    me.basis = basisFromAt([0, 0, -1]);
    await p.wait(10);
    check((r3d.objects.get(mech.id).flags & 0x80) !== 0, "a unit 4 units away uses its near model", `lod ${mech.lod}`);
    check(w.view.handles.get(mech.id)?.visible === true, "a unit up close is still drawn");
    p.shot("near-unit");
    // Pick the nearest unit as the target (script 1230 fills G1811, as the
    // target key does), then face it: script 582 locks on and script 575
    // gives the crosshair (sprite 562) queue 564 while acquiring and 565
    // once locked. Both show two cels at once with a type 2 queue record
    // (the bracket and the range readout).
    p.engine.run(1230);
    const xhair = () => p.engine.sprites.list.get(CROSSHAIR);
    const states = new Set();
    const lock = await p.waitFor(() => {
      states.add(String(xhair()?.layers));
      return p.engine.vm.getGlobal(974);
    }, "a target lock", 120);
    await p.wait(2);
    check(states.has("1,2"), "the crosshair shows the acquiring bracket", [...states].join(" "));
    check(String(xhair()?.layers) === "3,4" && xhair().visible, "a locked target turns the crosshair into the lock bracket", `${lock} ticks, layers ${xhair()?.layers}`);
    // Sprite 571 marks the target's feet on screen (XZToScreen, script 579).
    const mark = p.engine.sprites.list.get(571);
    check(!!mark?.visible && Math.abs(mark.x) < 40 && mark.y > 0, "the target marker sits under the target", `${mark?.x}, ${mark?.y}`);
    p.shot("locked");
    // In a vehicle the camera sits inside the player's own model; the LOD
    // script hides it with ObjectSetState (flag 0x100).
    p.engine.debug.swapVehicle(0); // Union Sentry HAWC
    await p.wait(10);
    const own = p.engine.vm.getGlobal(973);
    check(r3d.objects.getProperty(own, 0) >= 100, "the debug panel puts the player in a HAWC", `class ${r3d.objects.getProperty(own, 0)}`);
    check(w.view.handles.get(own)?.visible === false, "the player's own vehicle is not drawn over the view");
    // The radar (RadarClear/RadarDraw): a grey view cone and range marks
    // from the centre (320, 412), where the player's unit is marked. (The
    // empty mech the walk parked on the same spot is drawn over it in cyan.)
    const radar = p.region(...RADAR);
    check(radar.colours >= 3 && radar.lit > 150, "the radar draws its view cone and units", JSON.stringify(radar));
    const scr = p.screen();
    const px = (x, y) => [...scr.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 3)];
    const coloured = (c) => Math.max(...c) - Math.min(...c) > 100; // not black, grey or white
    const marked = [[319, 412], [320, 411], [320, 412], [320, 413], [321, 412]].filter(([x, y]) => coloured(px(x, y)));
    check(marked.length >= 3, "the radar marks the player's unit at its centre", `${marked.length} pixels`);
    p.shot("in-hawc");
    // The debug panel's "Unused weapons": kinds 12 and 27 of table 1281,
    // which no unit or pickup gets, go on free mounts and fire.
    const mounts = e.debug.giveWeapons([12, 27]);
    check(mounts.every((m) => m >= 0), "the unused weapons fit on free mounts", String(mounts));
    const shots = new Map();
    const runScript = e.vm.runScript.bind(e.vm);
    e.vm.runScript = (id) => {
      shots.set(id, (shots.get(id) || 0) + 1);
      return runScript(id);
    };
    for (const [m, spawn] of mounts.map((m, i) => [m, [1697, 1691][i]])) {
      for (let k = 0; k < 3; k++) {
        await p.holdKey(49 + m, 2); // keys 1-4 fire mounts 0-3
        await p.wait(40);
      }
      check(shots.get(spawn) > 0, `weapon kind ${m === mounts[0] ? 12 : 27} fires (spawn script ${spawn})`, `${shots.get(spawn) || 0} shots`);
    }
    e.vm.runScript = runScript;
    finish(p);
  },

  // Win mission 1, save on GAME > SAVE, export and import the save, then
  // restart, load it and play mission 2. G-NOME saves the campaign between
  // missions (scripts 6290/6291: G2119 and table 6984), not a mission in
  // progress: SAVE is offered once a campaign mission is briefed.
  async saves(p) {
    await toMainMenu(p);
    await launchMission1(p);
    await p.wait(60);
    p.engine.mission.destroyEnemies();
    await p.waitFor(() => !p.engine.world?.shown, "the end of mission 1", 600);
    await p.waitFor(() => hasText(p, "1-2: Drawbridge"), "mission 2's briefing", 400);
    await fadedIn(p, "mission 2's briefing");
    const vm = p.engine.vm;
    check(vm.getGlobal(CAMPAIGN) === 2 && vm.getGlobal(CURRENT_MISSION) === 2, "winning mission 1 moves the campaign on to mission 2");
    const saved = progress(p);
    await press(p, MAIN.GAME);
    await press(p, LEFT[2], 60);
    const slots = p.rects().filter((r) => r.script === SAVE_SLOT);
    check(hasText(p, "Save the Current Game") && slots.length === 8, "SAVE lists eight slots", `${slots.length}`);
    p.shot("save");
    await press(p, [slots[0].l + 20, slots[0].t + 8], 10);
    check(!!p.engine.input.edit, "clicking a slot asks for a name");
    p.type("WALKTHROUGH\r");
    await p.wait(60);
    check(p.storage.getItem("g-nome.file.SGNOME0.SAV") !== null, "Enter writes SGNOME0.SAV to browser storage");
    check(p.ini.get("GnomeGames", "savegame_0") === "WALKTHROUGH", "the save's name goes to the INI");
    check(hasText(p, "1-2: Drawbridge"), "the game goes back to mission 2's briefing");
    finish(p);

    // Export, then import into an empty browser.
    const exported = JSON.parse(JSON.stringify(exportSaves(p.storage, p.ini)));
    check(exported.saves.length === 1 && exported.saves[0].name === "WALKTHROUGH", "Export saves writes the save and its name");
    const storage = new MemoryStorage(), ini = new Ini();
    check(importSaves(exported, { storage, ini }) === 1, "Import saves reads it back");
    let bad = "";
    try {
      importSaves({ format: "something else" }, { storage, ini });
    } catch (e) {
      bad = e.message;
    }
    check(!!bad, "Import saves turns down a file that is not a save export");

    const p2 = await Player.start(dir, { verbose, ini, storage });
    p2.shot = p.shot;
    await toMainMenu(p2);
    await press(p2, MAIN.GAME);
    await press(p2, LEFT[1], 60);
    check(hasText(p2, "WALKTHROUGH"), "LOAD lists the imported save by name", JSON.stringify(p2.texts()));
    p2.shot("load");
    const row = p2.rects().filter((r) => r.script === SAVE_SLOT)[0];
    await press(p2, [row.l + 20, row.t + 8], 60);
    await p2.waitFor(() => hasText(p2, "1-2: Drawbridge"), "mission 2's briefing after LOAD", 200);
    const vm2 = p2.engine.vm;
    check(vm2.getGlobal(CAMPAIGN) === 2 && vm2.getGlobal(CURRENT_MISSION) === 2, "loading it briefs mission 2", `${vm2.getGlobal(CAMPAIGN)}/${vm2.getGlobal(CURRENT_MISSION)}`);
    check(progress(p2) === saved, "the campaign's tables come back as they were saved", `${saved.slice(0, 80)} / ${progress(p2).slice(0, 80)}`);
    p2.key(VK.ENTER);
    await p2.waitFor(() => p2.hasRect(8360), "LAUNCH", 60);
    p2.click(...RIGHT[0]);
    await p2.waitFor(() => p2.engine.world?.shown, "mission 2's battlefield", 300);
    await p2.wait(60);
    check(p2.engine.world.shown && vm2.getGlobal(CURRENT_MISSION) === 2, "LAUNCH plays mission 2 from the loaded save");
    const view = p2.region(...VIEWPORT);
    check(view.colours > 30 && view.lit > view.area * 0.9, "mission 2 draws its 3D view", JSON.stringify(view));
    p2.shot("mission2");
    finish(p2);
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
