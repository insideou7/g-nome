# G-NOME

Reverse engineering **G-Nome**, a 3D mech action game released by 7th Level
in 1997 for Windows 95. The game is abandonware. This repo holds what we have
learned about it: file format specs, notes on the engine, and tools that read
the game's data. It does not contain the game itself.

## Running the game
https://insideou7.github.io/g-nome/

Open the page and load your copy of the game: the game folder, or a .zip
of it. The files are read in your browser and never uploaded.

The whole game is playable: the menus, the LAB, all 22 campaign missions
through to the ending, saves and network play. Gamepads work as joysticks
(turn the joystick on in OPTIONS > INTERFACE). OPTIONS also has an added
DEBUG button with a level select, the original's cheat codes and the two
weapons the game never hands out.

## Getting the game files

The tools and the browser engine need the original game files, which this
repo does not include. One source is the Internet Archive:
<https://archive.org/details/g-nome-dos>.

Put your copy of the game in `game/` at the repo root. Any layout works, for
example `game/g-nome/G-NOME/G-NOME.BIN`, since the tools search `game/` for
`G-NOME.BIN`.

`game/` is git-ignored. **Never commit the original game binaries or assets,
or anything extracted from them.** Commit notes, specs and code instead.

## What is in the repo

| Path | What it is |
| --- | --- |
| [docs/formats/g-nome-bin.md](docs/formats/g-nome-bin.md) | `G-NOME.BIN` and the `G-NOME.###` packs: resource table, palette, bitmaps, textures, sounds, 3D models |
| [docs/formats/animation.md](docs/formats/animation.md) | FRME animation clips, OB3D/OPRT objects, and `RENDER.R32`'s animation, motion, task and hotspot externs |
| [docs/rtlib32-engine.md](docs/rtlib32-engine.md) | How `RTLIB32.DLL` loads the `.R32` plugins and runs the script bytecode in `G-NOME.BIN` |
| [docs/rtlib32-names.md](docs/rtlib32-names.md) | Names, arguments and record layouts of all RTLIB32 builtins and statements |
| [docs/render3d.md](docs/render3d.md), [docs/battlefield.md](docs/battlefield.md) | The 3D renderer, lighting, terrain, camera and mission world |
| [docs/missions.md](docs/missions.md), [docs/combat.md](docs/combat.md) | Enemy AI, mission goals, weapons, projectiles and explosions |
| [docs/netgn.md](docs/netgn.md) | `NETGN.R32` multiplayer (DirectPlay 3) and its browser version |
| [docs/render-r32.md](docs/render-r32.md) | All 260 `RENDER.R32` exports: what each does and where the browser version is |
| [docs/cheats.md](docs/cheats.md) | The cheat codes and the hidden debug actions |
| [docs/unused-content.md](docs/unused-content.md) | Content the game never uses (two weapons, unplaced catalog objects) |
| [docs/engine-plan.md](docs/engine-plan.md) | The browser engine: scope, architecture and status |
| [docs/reverse-engineering-setup.md](docs/reverse-engineering-setup.md) | Full setup for REA, Ghidra and the Python helpers |
| `web/` | The browser engine, which runs the game from your own files ([web/README.md](web/README.md)) |
| `tools/gnome_extract.py` | Extracts every resource and converts sounds, images and models |
| `tools/gnome3d.py` | Decodes models, FRME animations and OB3D/OPRT objects; exports OBJ and glTF |
| `tools/r32script.py` | Disassembles the game's script bytecode |
| `tools/inventory.py` | Prints a quick inventory of a game folder (file types, PE imports and exports) |
| `scripts/install-ghidra.sh` | Installs a pinned, checksum-verified Ghidra to `/opt/ghidra` |
| `tests/` | Tests for the extractor |

### How the game is built, in short

`G-NOME.EXE` is a small stub that starts `RTLIB32.DLL`, 7th Level's "Runtime
Player" script engine. The engine opens `G-NOME.BIN`, loads the plugin DLLs
`RENDER.R32` (3D and AI on RenderWare 2.0), `NETGN.R32` (DirectPlay) and
`SMACKER.R32` (video), and runs script 0. `G-NOME.BIN` indexes 9,440
resources stored across 80 pack files, `G-NOME.000` to `G-NOME.099`.

## Extracting the assets

The extractor needs only Python 3.8 or newer, no packages. From the repo root:

```sh
python tools/gnome_extract.py
```

The output goes to `extracted/` (also git-ignored):

- `wav/`: sounds, decoded from 7th Level ADPCM
- `png/`: bitmaps and textures
- `obj/`: 3D models with `.mtl` materials, which open in Blender or any 3D viewer
- `gltf/`: the same models as glTF, with their FRME animations
- `raw/`: every resource exactly as stored, for further reverse engineering
- `bin-sections/`: the other sections of `G-NOME.BIN` (strings, palette, script)
- `manifest.csv`: one row per resource

Useful options: `--game` and `--out` pick other folders, `--raw-only` skips
conversion, and `--list` prints the resource table. Run the tests with
`python -m unittest discover tests`.

Every resource type in the packs is decoded. The animation and object formats
(`FRME`, `OB3D`, `OPRT`) are in
[docs/formats/animation.md](docs/formats/animation.md); type 11 resources are
the scripts' integer tables (see `web/src/builtins.js`).

## Playing in the browser

`web/` is a reimplementation of the game's engine that runs in a browser from
your own copy of the game. It is published at
<https://insideou7.github.io/g-nome/>: pick your game folder or a .zip of it,
and the files are read locally, never uploaded. The menus, the LAB, all 22
campaign missions, saves, multiplayer and gamepads work. To run it yourself,
or to run its tests (`cd web && npm test` for the unit tests, plus a
walkthrough, a campaign bot and a smoke test that need the game files), see
[web/README.md](web/README.md).

## Reading the scripts

`tools/r32script.py` disassembles the script bytecode in `G-NOME.BIN`. The
format is described in [docs/rtlib32-engine.md](docs/rtlib32-engine.md).

```sh
python tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --summary
python tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --script 1
python tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --externs
python tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --all > scripts.txt
```

## Reverse engineering setup

Native code (`RTLIB32.DLL`, the `.R32` plugins, the RenderWare DLLs) is
analysed with **REA (Reverse Engineer Anything)**, an MCP server and skill for
Claude Code, backed by Ghidra.

- REA is already registered: `.mcp.json` starts the server and
  `.claude/settings.json` enables the skill, both pinned to REA 6.8.0. It needs
  Node.js 22.23.4+ (or 24.22.1+).
- Install Ghidra with `bash scripts/install-ghidra.sh` (Linux; it needs Java
  21 and network access to github.com release downloads). On other systems,
  download Ghidra 12.1.4 yourself and set `GHIDRA_INSTALL_DIR`.
- To check what is ready, ask Claude to call REA's `binary_session` with `{}`
  and look at `result.tool_availability`.
- REA also works from the command line, for example:

  ```sh
  GHIDRA_INSTALL_DIR=/opt/ghidra npx -y rea-agents@6.8.0 decompile-all \
    game/g-nome/G-NOME/RTLIB32.DLL --output re-output/rtlib32 --provider ghidra
  ```

The optional Python helpers (`pefile`, `capstone`) are in `requirements.txt`.
Details, including setup for Claude Code on the web, are in
[docs/reverse-engineering-setup.md](docs/reverse-engineering-setup.md).

## Scope

This project is about preservation and understanding how the game works. It
does not cover copy-protection bypass or redistributing the game.
