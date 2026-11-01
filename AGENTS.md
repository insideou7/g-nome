# g-nome

Reverse engineering an abandonware game.

## Tooling

This repo uses **REA (Reverse Engineer Anything)**, an MCP server plus skill
that lets the agent decompile and inspect binaries. The server is registered in
`.mcp.json` and the skill in `.claude/settings.json`, both pinned to REA 6.8.0.
Setup, the Ghidra backend and troubleshooting are in
[docs/reverse-engineering-setup.md](docs/reverse-engineering-setup.md).

Project skills live in `.claude/skills/` (see its README), including the
`caveman` terse-reply skill: `/caveman` on, `stop caveman` off.

## Working rules

- Put the game files in `game/` (git-ignored). Never commit the original
  binaries or assets.
- Commit findings, notes, file-format specs and reimplementation code instead.
- Before native analysis, have the agent call REA's `binary_session` with `{}`
  and check `result.tool_availability` to see which engines are ready.

## Findings

- [docs/rtlib32-engine.md](docs/rtlib32-engine.md): how RTLIB32.DLL loads the
  `.R32` plugins and runs the script bytecode in `G-NOME.BIN`.
- `tools/r32script.py`: script disassembler for `.BIN` files.
- [docs/rtlib32-names.md](docs/rtlib32-names.md): names, arguments and record
  layouts of all 181 RTLIB32 builtins and 90 statements. The source is
  `web/src/names.js`, shared by the web engine and the disassembler; edit it
  there and regenerate the doc with `python3 -I tools/r32script.py --names-md`.
- [docs/formats/animation.md](docs/formats/animation.md): FRME animation
  clips, OB3D/OPRT objects and RENDER.R32's animation, motion, steering,
  task, list, file and hotspot externs. `tools/gnome3d.py` exports models to glTF with their
  animations.
- [docs/missions.md](docs/missions.md): enemy AI (unit update, tasks,
  targeting, aiming) and mission goals (hooks, win/lose, debrief). In the
  engine: `web/src/battlefield/aim.js`, `mission.js` (`engine.mission`).
- [docs/render-r32.md](docs/render-r32.md): all 260 RENDER.R32 exports
  (address, script calls, browser file), its internals and hooks, what is
  not implemented. The wave player is `web/src/waves.js`. Check with
  `web/tests/render-coverage-check.mjs` and `web/tests/waves-check.mjs`.
- Joysticks: gamepads stand in for RENDER.R32's two WinMM joysticks
  (`web/src/battlefield/joystick.js`); the original's rules are in the
  Joysticks section of [docs/battlefield.md](docs/battlefield.md).
- [docs/combat.md](docs/combat.md): weapons, projectiles, hits and
  explosions (RENDER.R32's combat natives and the scripts' callbacks).
- [docs/engine-plan.md](docs/engine-plan.md): the browser engine in `web/`
  (scope, architecture, milestones, status). It is published to GitHub
  Pages by `.github/workflows/pages.yml` (code only; players load their
  own game folder or .zip through `web/src/gamefiles.js`).
- [docs/netgn.md](docs/netgn.md): NETGN.R32 (DirectPlay 3): lobby externs,
  the in-game message kinds and their byte layouts, and the browser version
  (`web/src/plugins/netgn.js`, `web/src/net/`, `web/tools/net-server.mjs`).
  Test with `web/tests/netgn-check.mjs` and `web/tests/net-tabs.mjs`.
- Unit tests: `cd web && npm test` (Node's test runner over
  `web/tests/unit/*.test.mjs`: script VM, motion, math, file parsers,
  collision geometry, saves; no game files, under a second; CI runs it on
  PRs). Add a test there when you change pure engine code.
- Type checking: `cd web && npm ci && npm run typecheck` (TypeScript over the
  JSDoc-annotated JavaScript, no build step; CI runs it on PRs). See the
  Type checking section of [web/README.md](web/README.md).
- `web/tests/walkthrough.mjs`: automated play-through of the menus, LAB and
  mission 1 on the game files. Run it after engine changes; add a check
  when you fix a bug a player would see.
- `web/tests/missions-smoke.mjs`: smoke test for all 22 campaign missions
  (start, 50 s unattended with the player invulnerable, force a win, check
  the next briefing). About 4 minutes; `--missions 2,5-7` for a subset.
- [docs/unused-content.md](docs/unused-content.md): content the original
  never uses (weapons 12 and 27, catalog rows no mission places) and how
  pause works. The DEBUG panel can give the player the two weapons.
- [docs/cheats.md](docs/cheats.md): the 15 cheat codes, the hidden Ctrl-key
  actions they unlock, and the DEBUG button on the OPTIONS screen
  (`web/src/debug.js`).
