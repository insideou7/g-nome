// Debug tools: a DEBUG button in the first empty slot on the right of the
// OPTIONS screen, and the cheats and shortcuts behind it. Everything here is
// engine-side; it runs the game's own scripts and never changes game files.
//
// The game's cheats (script 5996): Shift+F1 on the main menu opens a text
// box (script 5995) and script 5996 compares what was typed with fifteen
// anagrams of the team's names (credits strings 0x8410-0x84c7). Most of them
// OR a bit into global 1857 with script_2561(bit). That global is the mask
// that MapActionKeys / CheckActionState match against column 1 of the action
// table 2544, so each bit enables a hidden action whose Ctrl+key binding is
// in table 2547. Actions 96 and 97 need bit 2, which no code sets: they are
// developer keys (Ctrl+C, Shift+R).

import { ORIGIN_X, ORIGIN_Y } from "./sprites.js";
import { table, BUILTINS } from "./builtins.js";
/** @import { Engine } from "./engine.js" */

export const CHEATS = [
  { code: "Range Goes Gory", effect: "Most of the below at once: every Ctrl-key cheat, all missions, and the Swiss Throat and Mother Mourn Us extras", keys: "" },
  { code: "Redtop Trod", effect: "Unlock all 23 campaign missions in the mission list", keys: "" },
  { code: "Had A Nude On", effect: "Invulnerability (sets property 140, which the damage scripts skip)", keys: "Ctrl+I" },
  { code: "Horny Elk Leer", effect: "Repair: shields and energy back to full", keys: "Ctrl+P" },
  { code: "Brass Clue", effect: "Refill ammunition", keys: "Ctrl+X" },
  { code: "Oh No! Less Japan", effect: "Give your vehicle weapon 32", keys: "Ctrl+Z" },
  { code: "Rotted Drop", effect: "Destroy the current target", keys: "Ctrl+F" },
  { code: "Half Libel", effect: "Teleport on top of the current target", keys: "Ctrl+B" },
  { code: "A Mere Fart", effect: "Enable action 84 (no default key)", keys: "" },
  { code: "Chaste Coed", effect: "Win the campaign: plays the ending (G-NOME.SMK)", keys: "", leaves: true },
  { code: "Dunk It Here", effect: "Stops the CD music and plays the sound sequence in table 304", keys: "" },
  { code: "Swiss Throat", effect: "The Citadel gets a different inside view, where Tab flips through 23 hidden pictures", keys: "" },
  { code: "Mother Mourn Us", effect: "Changes your unit's setup in mission 5 (scripts 8822, 8823)", keys: "" },
  { code: "O'Sarge", effect: "Uses an alternate table (9283) in mission 31, a bonus mission", keys: "" },
  { code: "A Scramble On", effect: "Turns on RTLIB32's flag 0x94dd (an Escape-key path)", keys: "" },
];

// Weapons in table 1281 that no unit, pickup or cheat ever gets
// (docs/unused-content.md). The kind is column 0.
export const UNUSED_WEAPONS = [
  { kind: 12, name: "red pulse gun, 30 damage, long range" },
  { kind: 27, name: "green energy gun, 10 damage, short range" },
];

// Developer keys (mask bit 2): actions 96 and 97 of table 2544.
export const DEV_KEYS = [
  { keys: "Shift+R", effect: "The game's own frame rate display (scripts 552-554)" },
  { keys: "Ctrl+C", effect: "Toggle a state on your vehicle (scripts 1226-1228)" },
];

const OPTIONS_SCRIPT = 8380; // INTERFACE button's click script: the OPTIONS screen is up
const SLOT = { l: 557, t: 147, r: 640, b: 183 }; // first blue slot on the right, screen pixels

// A 7x11 face like the menu buttons' (2-pixel strokes).
/** @type {Record<string, string[]>} */
const GLYPHS = {
  D: ["######.", "#######", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", "######."],
  E: ["#######", "#######", "##.....", "##.....", "##.....", "######.", "######.", "##.....", "##.....", "#######", "#######"],
  B: ["######.", "#######", "##...##", "##...##", "##..##.", "######.", "#######", "##...##", "##...##", "#######", "######."],
  U: ["##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "##...##", "#######", ".#####."],
  G: [".######", "#######", "##.....", "##.....", "##.....", "##..###", "##..###", "##...##", "##...##", "#######", ".######"],
};

// Campaign mission N starts the way the briefing's start button does
// (script 8317 finds the row of table 6984 whose column 0 is global 2119).
/**
 * @param {Engine} engine
 * @param {any} n
 */
export function startMission(engine, n) {
  // the real path goes through the briefing, which has already put the menu
  // away; hide whatever is still up
  for (const sp of engine.sprites.list.values()) sp.visible = false;
  engine.clickRects = [];
  engine.hoverRects = [];
  engine.hover = -1;
  for (const g of [2118, 2119]) engine.vm.setGlobal(g, n);
  engine.vm.setGlobal(982, 0);
  engine.run(8317);
}

export class Debug {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.hot = false;
    /** @type {any} */
    this.onOpen = null; // set by the browser shell: opens the panel
    this.colors = null;
    this.vehicle = -1; // catalog row (table 5843) to start missions in, -1 = the mission's own
    this.extraWeapons = false; // give the player the unused weapons on a start from here
  }

  // Is the OPTIONS screen up?
  get shown() {
    const e = this.engine;
    return e.clickRects.some((/** @type {any} */ r) => r.script === OPTIONS_SCRIPT && !r.off) && !e.world?.shown && !e.plugins.some((/** @type {any} */ p) => p.ownsScreen);
  }

  /**
   * @param {number} cx
   * @param {number} cy
   */
  hit(cx, cy) {
    return this.shown && cx >= SLOT.l && cx < SLOT.r && cy >= SLOT.t && cy < SLOT.b;
  }

  /**
   * @param {number} cx
   * @param {number} cy
   */
  mouseMove(cx, cy) {
    const hot = this.hit(cx, cy);
    if (hot !== this.hot) {
      this.hot = hot;
      this.engine.dirty = true;
    }
  }

  // true when the click was ours
  /**
   * @param {number} cx
   * @param {number} cy
   */
  mouseDown(cx, cy) {
    if (!this.hit(cx, cy)) return false;
    this.onOpen?.();
    return true;
  }

  // Palette indices nearest to the button colours, found once.
  palette() {
    if (this.colors) return this.colors;
    const pal = this.engine.palette;
    const near = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => {
      let best = 1, bd = Infinity;
      for (let i = 1; i < 256; i++) {
        const d = (pal[i * 3] - r) ** 2 + (pal[i * 3 + 1] - g) ** 2 + (pal[i * 3 + 2] - b) ** 2;
        if (d < bd) [bd, best] = [d, i];
      }
      return best;
    };
    const isBlue = (/** @type {number} */ i) => pal[i * 3 + 2] > pal[i * 3] + 40 && pal[i * 3 + 2] > pal[i * 3 + 1] + 30;
    this.colors = { black: near(0, 0, 0), dark: near(0, 74, 0), mid: near(0, 152, 0), shade: near(0, 197, 0), bright: near(0, 255, 0), isBlue };
    return this.colors;
  }

  // Draw the button over the blue slot: black screen, green DEBUG.
  /**
   * @param {number[]} pixels
   */
  draw(pixels) {
    if (!this.shown) return;
    const c = this.palette();
    const W = 640;
    let minX = W, maxX = 0, minY = 480, maxY = 0;
    for (let y = SLOT.t; y < SLOT.b; y++) {
      for (let x = SLOT.l; x < SLOT.r; x++) {
        const o = y * W + x;
        if (!c.isBlue(pixels[o])) continue;
        pixels[o] = this.hot ? c.dark : c.black;
        minX = Math.min(minX, x), maxX = Math.max(maxX, x);
        minY = Math.min(minY, y), maxY = Math.max(maxY, y);
      }
    }
    if (minX > maxX) return; // the slot is not there
    const word = "DEBUG", gw = 7, gap = 2, gh = 11;
    const tw = word.length * gw + (word.length - 1) * gap;
    const x0 = Math.round((minX + maxX + 1 - tw) / 2), y0 = Math.round((minY + maxY + 1 - gh) / 2);
    const on = (/** @type {number} */ x, /** @type {number} */ y) => {
      const ch = Math.floor(x / (gw + gap)), gx = x % (gw + gap);
      if (x < 0 || y < 0 || y >= gh || ch >= word.length || gx >= gw) return false;
      return GLYPHS[word[ch]][y][gx] === "#";
    };
    for (let y = -1; y <= gh; y++) {
      for (let x = -1; x <= tw; x++) {
        const o = (y0 + y) * W + x0 + x;
        if (on(x, y)) pixels[o] = on(x + 1, y) && on(x, y + 1) ? c.bright : c.shade;
        else if (on(x - 1, y) || on(x, y - 1) || on(x + 1, y) || on(x, y + 1)) pixels[o] = this.hot ? c.mid : c.dark;
      }
    }
  }

  // --- the actions behind the panel ---

  // Type a cheat code into the game's own check (script 5996 reads string 7).
  /**
   * @param {string} code
   */
  cheat(code) {
    const e = this.engine;
    const before = e.vm.getGlobal(1857);
    e.setString(7, code);
    e.run(5996);
    return { mask: e.vm.getGlobal(1857), before };
  }

  // The developer keys: mask bit 2, through the game's script_2561.
  devKeys() {
    this.engine.callScript(2561, [2]);
  }

  // Campaign missions, from table 6984: [{n, script}]
  missions() {
    const t = table(this.engine.vm, 6984);
    const out = [];
    for (let r = 0; r * 6 < t.data.length; r++) {
      const n = t.data[r * 6], script = t.data[r * 6 + 3];
      if (n >= 1 && n <= 22 && script) out.push({ n, script });
    }
    return out;
  }

  // Vehicles and personnel the player can drive, named from the LAB:
  // table 8115 row 0 (vehicles) and 2 (personnel) list one table per side;
  // their rows are {catalog row, ?, ?, ?, LABTEXT.DAT offset, lines}.
  async vehicles() {
    if (this.vehicleList) return this.vehicleList;
    const e = this.engine;
    let lab = null;
    try {
      lab = await e.files.read("LABTEXT.DAT");
    } catch {}
    const name = (/** @type {number} */ o) => {
      if (!lab || o < 0 || o >= lab.length) return "";
      let s = "";
      for (let i = 1; i <= lab[o] && lab[o + i]; i++) s += String.fromCharCode(lab[o + i]);
      return s.trim();
    };
    const pages = table(e.vm, 8115);
    const list = [];
    for (const page of [0, 2]) {
      for (let side = 0; side < 4; side++) {
        const t = table(e.vm, pages.data[page * 4 + side]);
        if (!t) continue;
        for (let r = 0; r * 6 < t.data.length; r++) {
          const row = t.data[r * 6];
          list.push({ row, name: name(t.data[r * 6 + 4]) || `Catalog row ${row}` });
        }
      }
    }
    this.vehicleList = list;
    return list;
  }

  // Start campaign mission n, then put the player in catalog row `vehicle`.
  /**
   * @param {number} n
   */
  startMission(n, vehicle = this.vehicle, extraWeapons = this.extraWeapons) {
    startMission(this.engine, n);
    if (vehicle >= 0) this.swapVehicle(vehicle);
    if (extraWeapons) this.giveWeapons(UNUSED_WEAPONS.map((w) => w.kind));
  }

  // Add weapons (column 0 of table 1281) to the player's unit, each on the
  // first free mount, the way a unit's setup script does:
  // script_1656(unit, kind, ammunition, mount). With every mount taken the
  // last one is swapped (script_1658), like a pickup (script 1659).
  // Returns the mounts used, -1 where the weapon did not fit.
  /**
   * @param {number[]} kinds
   */
  giveWeapons(kinds) {
    const e = this.engine, vm = e.vm;
    const unit = vm.getGlobal(973);
    if (!unit) return [];
    const mounts = this.prop(unit, 102);
    const out = [];
    for (const kind of kinds) {
      let row = -1;
      for (let r = 0; r < 32; r++) if (BUILTINS[0x52](vm, [1281, r, 0]) === kind) row = r;
      // a pickup's ammunition (script 1659); energy weapons (type 1) get
      // 2000 shots as in the setup scripts, since script 1682 will not fire
      // with none left and their column 23 is 0
      const energy = row >= 0 && BUILTINS[0x52](vm, [1281, row, 1]) === 1;
      const ammo = row < 0 ? 0 : energy ? 2000 : Math.trunc((BUILTINS[0x52](vm, [1281, row, 23]) * 15) / 10);
      let mount = -1;
      for (let m = 0; m < Math.min(mounts, 4) && mount < 0; m++) {
        e.callScript(1665, [unit, m]);
        if (vm.retval === -1) mount = m;
      }
      if (mount >= 0) {
        e.callScript(1656, [unit, kind, ammo, mount]);
      } else if (mounts > 0) {
        mount = Math.min(mounts, 4) - 1;
        e.callScript(1658, [unit, mount, kind, ammo]);
      }
      out.push(mount);
    }
    e.log(`debug: weapons ${kinds.join(", ")} on mounts ${out.join(", ")}`);
    return out;
  }

  // A unit's property, through RENDER.R32's externs.
  /**
   * @param {number} id
   * @param {number} p
   * @param {number} [v]
   */
  prop(id, p, v) {
    const r = this.engine.plugins.find((/** @type {any} */ x) => x.name === "render");
    if (v === undefined) return r.externs.GetProperty.call(r, id, p);
    r.externs.SetProperty.call(r, id, p, v);
  }

  // Put a new unit from catalog row `row` next to the player's and move the
  // player into it the way the game does:
  // - a vehicle (class 100-230): script_2240(pilot, vehicle, 1), the
  //   "climb into an empty vehicle" path, which ends in script_2088;
  // - on foot: script_2088(unit) switches control, and the old unit leaves.
  /**
   * @param {number} row
   */
  swapVehicle(row) {
    const e = this.engine, vm = e.vm;
    const player = vm.getGlobal(973);
    const world = e.world, o = world?.objects.get(player);
    if (!player || !world || !o) return e.log("debug: no player unit to swap");
    const cat = table(vm, 5843);
    const [res, init, kind, cls] = cat.data.slice(row * 5, row * 5 + 4);
    const yaw = o.heading(); // hundredths of a degree
    const rad = (yaw / 18000) * Math.PI;
    // a little ahead of the player so the two don't overlap
    const x = Math.round(o.pos[0] * 100 + Math.sin(rad) * 600), z = Math.round(o.pos[2] * 100 + Math.cos(rad) * 600);
    // script 2523's placement of one row
    e.callScript(2039, [kind, res, x, z, yaw, 1, cls]);
    const id = vm.retval;
    if (!id) return e.log(`debug: could not create catalog row ${row}`);
    if (init) e.callScript(init, [id]);
    e.callScript(428, [id, cls]);
    e.callScript(2286, [id, 100, 100]);
    // keep its update script in property 65, as the placement code does
    // (script_1736): script_2088 reinstalls it from there
    e.callScript(1736, [id, world.objects.get(id)?.updateScript || 0]);
    this.prop(id, 113, this.prop(player, 113)); // same side (IFF)
    if (cls >= 100 && cls < 231) {
      // the pilot: the player on foot, or whoever drives the player's vehicle
      let pilot = player;
      if (this.prop(player, 0) >= 100) {
        pilot = this.prop(player, 78);
        if (!pilot) return e.log("debug: the player's vehicle has no pilot to move");
        vm.setGlobal(973, pilot); // so 2240 treats the pilot as the player
      }
      this.prop(id, 77, 0); // empty and unlocked (2043 leaves -1)
      e.callScript(2240, [pilot, id, 1]);
      if (pilot !== player) world.remove(player);
    } else {
      e.callScript(2088, [id]);
      world.remove(player);
    }
    e.log(`debug: now in catalog row ${row} (object ${vm.getGlobal(973)})`);
  }
}
