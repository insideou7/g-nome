// Smoke test for the 22 campaign missions: each one is started the way the
// briefing's start button does (script 8317), played headless for a while
// with nobody at the controls, then won through the game's own "objectives
// complete" script to check that the next briefing comes up.
//
// Usage: node web/tests/missions-smoke.mjs [game/g-nome/G-NOME]
//   [--missions 1,2,5-7] [--ticks N] [--no-win] [--json file] [--verbose]
//   --missions  which campaign missions to play (default 1-22)
//   --ticks     frames to play each mission for (default 1500, 50 s)
//   --no-win    skip forcing the win
//   --json      also write the per-mission results to this file
//
// A mission fails on:
//   - an engine error in the log (script failure, missing resource) or an
//     exception thrown from a frame
//   - a statement, builtin or extern the engine does not implement, unless
//     it is in KNOWN_GAPS below
//   - no battlefield, no player unit, no ground tiles or no other units
//   - the mission ending on its own while nobody plays (the player's unit
//     is made invulnerable for this, so it means a script ended it)
//   - winning not moving the campaign on to the next mission's briefing
//     (after mission 22, not starting the ending movie)
// It prints one line per mission and a summary, and exits non-zero if any
// mission failed. Missions run one at a time on a fresh engine each.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Player, VK } from "./player.mjs";

// Not implemented yet, and reached by some mission. Remove an entry when it
// is done; the summary says when one is no longer hit.
const KNOWN_GAPS = new Set([]);

const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--verbose" || a === "--no-win") opts[a.slice(2)] = true;
  else if (a.startsWith("--")) opts[a.slice(2)] = process.argv[++i];
  else positional.push(a);
}
const dir = positional[0] || "game/g-nome/G-NOME";
if (!existsSync(join(dir, "G-NOME.BIN"))) {
  console.log(`missions-smoke: no G-NOME.BIN in ${dir}; skipped (needs the game files)`);
  process.exit(0);
}
const COUNT = 22;
const missions = (opts.missions || `1-${COUNT}`).split(",").flatMap((s) => {
  const [a, b = a] = s.split("-").map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
});
const TICKS = Number(opts.ticks || 1500);

// Globals (docs/missions.md, docs/battlefield.md).
const G = { MISSION: 2118, CAMPAIGN: 2119, BRIEFED: 2141, DIFFICULTY: 982, PLAYER: 973 };
const START = 8317; // the briefing's start button
const GROUND = -100;
const INVULNERABLE = 140; // unit property the damage scripts skip // world level of the ground tiles

async function play(n) {
  const r = { mission: n, ok: true, problems: [], unknown: [] };
  const fail = (what) => {
    r.ok = false;
    r.problems.push(what);
  };
  const t0 = Date.now();
  const p = await Player.start(dir, { verbose: !!opts.verbose, display: false });
  const vm = p.engine.vm;
  try {
    // Skip the opening movie and wait for the main menu, as a player would.
    await p.waitFor(() => p.moviePlaying, "the opening movie", 60);
    p.key(VK.ESCAPE);
    await p.waitFor(() => p.hasRect(8344), "the main menu", 150);
    await p.wait(30);
    // Brief mission n and press start, as the briefing does.
    for (const g of [G.MISSION, G.CAMPAIGN, G.BRIEFED]) vm.setGlobal(g, n);
    vm.setGlobal(G.DIFFICULTY, 0);
    p.engine.run(START);
    await p.waitFor(() => p.engine.world?.shown, "the battlefield", 300);
    await p.wait(30);

    const w = p.engine.world;
    const objs = [...w.objects.values()];
    r.objects = objs.length;
    r.ground = objs.filter((o) => o.level === GROUND).length;
    r.player = vm.getGlobal(G.PLAYER);
    r.units = p.engine.mission.units().length;
    r.enemies = p.engine.mission.enemies().length;
    if (!r.player || !w.get(r.player)) fail("no player unit");
    if (!r.ground) fail("no ground tiles");
    if (r.units < 2) fail(`only ${r.units} unit(s) in the unit list`);
    if (!r.enemies) r.notes = "no enemies at the start";

    const start = new Map(p.engine.mission.units().map((id) => [id, w.get(id).pos.slice()]));

    // Nobody plays: the mission should keep running. The player's unit is
    // invulnerable (property 140, the Ctrl+I cheat) so enemies shooting an
    // idle player don't end it.
    const ob = p.engine.render3d.objects;
    for (let t = 0; t < TICKS && !p.engine.quit; t += 30) {
      const me = vm.getGlobal(G.PLAYER);
      if (me) ob.setProperty(me, INVULNERABLE, 1);
      await p.wait(30);
      const s = p.engine.mission.status();
      if (!w.shown || s.outcome !== "playing") {
        fail(`ended on its own after ${t + 30} ticks (${s.outcome})`);
        break;
      }
    }
    r.played = p.ticks;
    // Units that moved more than one world unit (the AI at work); reported,
    // not checked, since some missions open with everyone on guard.
    r.moved = [...start].filter(([id, a]) => {
      const b = w.get(id)?.pos;
      return b && id !== r.player && Math.hypot(b[0] - a[0], b[2] - a[2]) > 1;
    }).length;

    if (!opts["no-win"] && r.ok) {
      if (!p.engine.mission.win()) fail("win() refused (no player or already ending)");
      else {
        await p.waitFor(() => !p.engine.world?.shown || p.engine.quit, "the end of the mission", 900);
        const want = n + 1;
        if (n < COUNT) {
          await p.waitFor(() => vm.getGlobal(G.CAMPAIGN) === want && p.hasRect(8360), `mission ${want}'s briefing`, 600);
          r.next = p.texts().find((s) => /^\d+-\d+:/.test(s)) || "";
          if (!r.next) fail(`no briefing title for mission ${want}`);
        } else {
          // The last mission ends the campaign with the ending movies
          // (news.smk, the intro, credits.smk, wilkins.smk).
          const sm = p.engine.plugins.find((x) => x.name === "smacker");
          await p.waitFor(() => p.moviePlaying, "the ending movie", 600);
          r.next = `ending movie ${sm.movie.name}`;
        }
        r.status = p.engine.mission.status().outcome;
        if (r.status !== "won") fail(`outcome ${r.status} after win()`);
      }
    }
  } catch (e) {
    fail(e.message);
  }
  for (const e of p.errors) fail(e.split("\n")[0]);
  r.unknown = [...p.unknown().keys()];
  const fresh = r.unknown.filter((k) => !KNOWN_GAPS.has(k));
  if (fresh.length) fail(`unimplemented: ${fresh.join(", ")}`);
  r.seconds = (Date.now() - t0) / 1000;
  return r;
}

const results = [];
for (const n of missions) {
  const r = await play(n);
  results.push(r);
  const info = `${r.objects ?? "-"} objects, ${r.ground ?? "-"} ground, ${r.units ?? "-"} units, ${r.enemies ?? "-"} enemies, ${r.moved ?? "-"} moved${r.next ? `, next: ${r.next}` : ""}`;
  console.log(`${r.ok ? "ok  " : "FAIL"} mission ${String(n).padStart(2)}  ${info}  (${r.seconds.toFixed(1)} s)`);
  for (const pr of [...new Set(r.problems)].slice(0, 8)) console.log(`       - ${pr}`);
  if (r.notes) console.log(`       note: ${r.notes}`);
}

const failed = results.filter((r) => !r.ok);
const seen = new Set(results.flatMap((r) => r.unknown));
const stale = [...KNOWN_GAPS].filter((k) => !seen.has(k));
if (stale.length && missions.length === COUNT) console.log(`\nKNOWN_GAPS no longer hit (remove them): ${stale.join(", ")}`);
console.log(`\n${results.length - failed.length}/${results.length} missions ok${failed.length ? `; failed: ${failed.map((r) => r.mission).join(", ")}` : ""}`);
if (opts.json) writeFileSync(opts.json, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
