# g-nome

Reverse engineering an abandonware game.

## Tooling

This repo uses **REA (Reverse Engineer Anything)**, an MCP server plus skill
that lets the agent decompile and inspect binaries. The server is registered in
`.mcp.json` and the skill in `.claude/settings.json`, both pinned to REA 6.8.0.
Setup, the Ghidra backend and troubleshooting are in
[docs/reverse-engineering-setup.md](docs/reverse-engineering-setup.md).

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
- [docs/formats/animation.md](docs/formats/animation.md): FRME animation
  clips, OB3D/OPRT objects and RENDER.R32's animation, list, file and
  hotspot externs. `tools/gnome3d.py` exports models to glTF with their
  animations.
- [docs/engine-plan.md](docs/engine-plan.md): the browser engine in `web/`
  (scope, architecture, milestones, status).
