// Mission state, read from the game's own globals, plus helpers that end a
// mission through the game's own scripts. G-Nome's enemy AI and mission
// goals are script code (docs/missions.md); this file only reports on them
// and gives developers a way to reach the end screens quickly.
//
//   engine.mission.status()   who is alive, what the goal hooks are, outcome
//   engine.mission.win()      run the "objectives complete" script (2245)
//   engine.mission.lose()     destroy the player's unit (script 2242)
//   engine.mission.destroyEnemies()  destroy every hostile unit, one by one
/** @import { Engine } from "../engine.js" */


// Globals (see docs/missions.md).
const G = {
  PLAYER: 973, // the unit the player controls
  UNITS: 1816, // list of up to 150 combat units (ListCreate)
  ENDING: 1826, // the unit whose end-of-mission fly-by is running, else 0
  ENDED: 1818, // 1 once script 2243 has ended the mission (2516 clears it)
  OUTCOME: 1827, // 1 lost, 2 won, 3 failed or aborted (8317 starts it at 3)
  RESULT: 1828, // 1 objectives done (win pending), -1 failed
  KILLED: 985, // hook: script_G985(unit) when any unit is destroyed
  BOARDED: 984, // hook: script_G984(unit, pilot) when a unit changes hands
  SPOTTED: 988, // hook: script_G988(target, unit) when a guard picks a target
};
const NO_HOOK = new Set([0, 12, 14, 15, 16, 17, 18]); // script 13's empty defaults
/** @type {Record<number, string>} */
const OUTCOMES = { 0: "playing", 1: "lost", 2: "won", 3: "failed" };
const MAX_UNITS = 150;

// Unit properties the AI scripts use.
export const PROP = {
  CLASS: 0, // catalog class (table 5843 col 3); 100+ vehicles, 200+ structures
  SIGHT: 40, // how far the unit looks for targets
  TASK: 60, // index of the current row in the task table (-1 none)
  PILOT: 77, // the pilot inside; 0 = empty, -1 = AI crew
  IFF: 113, // side code; units with different codes fight (script 2080)
  SIDE: 115, // 2 for the enemy side in the campaign
};

export class Mission {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
  }

  get vm() {
    return this.engine.vm;
  }

  /**
   * @param {number} id
   * @param {number} p
   */
  prop(id, p) {
    return this.engine.render3d?.objects?.getProperty(id, p) ?? 0;
  }

  // The ids in the unit list (G1816), skipping empty slots.
  units() {
    const list = this.vm.getGlobal(G.UNITS);
    const get = this.engine.plugins?.find((/** @type {any} */ p) => p.name === "render")?.externs?.ListGetElem;
    if (!list || !get) return [];
    const out = [];
    for (let i = 0; i < MAX_UNITS; i++) {
      const id = get(list, i);
      if (id && this.engine.world?.get(id)) out.push(id);
    }
    return out;
  }

  // script_2080(a, b): 1 when a and b are on different sides.
  /**
   * @param {any} a
   * @param {any} b
   */
  hostile(a, b) {
    return !!this.engine.callScript(2080, [a, b]);
  }

  // Units that would fight the player and still have a crew (the test the
  // AI's target scan, script 2337, uses).
  enemies() {
    const player = this.vm.getGlobal(G.PLAYER);
    if (!player) return [];
    return this.units().filter((id) => id !== player && this.prop(id, PROP.PILOT) && this.hostile(player, id));
  }

  status() {
    const vm = this.vm;
    const hook = (/** @type {number} */ g) => {
      const s = vm.getGlobal(g);
      return NO_HOOK.has(s) ? 0 : s;
    };
    const tasks = this.engine.plugins?.find((/** @type {any} */ p) => p.name === "render")?.externs;
    const task = (/** @type {number} */ id) => {
      const row = this.prop(id, PROP.TASK);
      return row >= 0 && tasks?.getTaskField ? tasks.getTaskField(id, row, 0) : 0;
    };
    return {
      player: vm.getGlobal(G.PLAYER),
      // G1827 keeps the last outcome after the debrief (G1818 does not).
      outcome: vm.getGlobal(G.ENDED) || !this.engine.world?.shown ? OUTCOMES[vm.getGlobal(G.OUTCOME)] ?? vm.getGlobal(G.OUTCOME) : "playing",
      ending: vm.getGlobal(G.ENDING) !== 0,
      result: vm.getGlobal(G.RESULT),
      hooks: { killed: hook(G.KILLED), boarded: hook(G.BOARDED), spotted: hook(G.SPOTTED) },
      enemies: this.enemies().map((id) => ({ id, class: this.prop(id, PROP.CLASS), task: task(id) })),
    };
  }

  // Script 2242 is how the game destroys a unit: the player's own unit ends
  // the mission (2243(1)), anything else goes through the death handler
  // 2278, which runs the mission's G985 hook.
  /**
   * @param {number} id
   */
  destroy(id) {
    if (!id || !this.engine.world?.get(id)) return 0;
    return this.engine.callScript(2242, [id]);
  }

  destroyEnemies() {
    let n = 0;
    for (const id of this.enemies()) {
      if (this.vm.getGlobal(G.ENDING)) break; // the mission has already ended
      this.destroy(id);
      n++;
    }
    return n;
  }

  // Script 2245: what the mission scripts run once their goals are met (for
  // example mission 1's G985 hook after G2432 kills). It starts the fly-by
  // (2243(2)) and then the debrief.
  win() {
    if (!this.vm.getGlobal(G.PLAYER) || this.vm.getGlobal(G.ENDING)) return 0;
    this.engine.callScript(2245, []);
    return 1;
  }

  lose() {
    return this.destroy(this.vm.getGlobal(G.PLAYER));
  }
}
