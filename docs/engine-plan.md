# Browser engine: scope and plan

Goal: play G-Nome in a web browser from the original game files, the way
ScummVM plays other old games. The player supplies their own copy; the engine
never ships or commits game data.

The engine lives in [`web/`](../web). It is plain JavaScript modules with no
build step and no dependencies.

## Why a reimplementation works here

G-NOME.EXE is a stub. All game logic is bytecode in `G-NOME.BIN`, run by 7th
Level's "Runtime Player" (`RTLIB32.DLL`). The DLL adds native functions in
three plugins (`RENDER.R32`, `NETGN.R32`, `SMACKER.R32`). So the engine has
to provide:

1. the **script VM** (statements and expressions, see
   [rtlib32-engine.md](rtlib32-engine.md)),
2. the Runtime Player's **services**: resources, the 2D sprite system,
   palettes and fades, sounds, keyboard and mouse bindings, click regions,
   INI settings, save files,
3. the **plugin functions** the scripts call: 306 externs, most of them in
   `RENDER.R32` (the 3D battlefield on RenderWare 2.0).

Everything else (menus, mission logic, AI, briefings) then comes from the
game's own scripts.

## Architecture

```
web/index.html, src/main.js   browser shell: game picker, canvas, keys, audio
src/gamefiles.js              game files from a folder, a dropped folder or a .zip
src/engine.js                 message loop, strings, palette, background, INI
src/vm.js                     script VM (flat memory, frames, expressions)
src/stmt-impl.js              fixed-size statement handlers
src/builtins.js               RTLIB32 builtins (ids < 0xFA)
src/names.js                  names of every builtin and statement (shared
                              with tools/r32script.py, docs/rtlib32-names.md)
src/sprites.js                sprite system (type 20 resources + messages)
src/plugins/smacker.js        SMACKER.R32 (cutscenes)
src/plugins/render.js         RENDER.R32: sound, plus the 3D externs below
src/battlefield/              world, camera, fixed-tick loop, mission view, controls
src/render3d/                 models, textures, objects, WebGL renderer
src/plugins/netgn.js          NETGN.R32 stub (no network providers)
src/smacker.js                .SMK video/audio decoder
src/binfile.js                G-NOME.BIN and pack access
src/pe.js                     cursors from RTLIB32.DLL
src/disasm.js                 linear script disassembler
tools/run-headless.mjs        run the engine in Node and list what is missing
tools/disasm.mjs              disassemble scripts
tools/shot.mjs                run it in headless Chromium and take screenshots
tests/smacker-check.mjs       compare the SMK decoder with FFmpeg
```

Design choices:

- **Same structure as the original.** Scripts run synchronously; anything
  that waits (movies, fades, sprite animation, sounds) is driven by the
  message loop and reports back by queueing a script, as RTLIB32 does with
  `RtRunMsg` and window messages. This keeps the scripts' own control flow.
- **Flat VM memory.** Scripts take addresses (`&G5`, `G13[i]`), so variables
  live in one `Int32Array` and pointers are byte offsets into it.
- **Resources in memory.** All packs (75 MB) load at start, so resource
  access is synchronous like the original. Movies stream on demand.
- **Discover by running.** `run-headless.mjs` boots the real scripts and
  prints every unimplemented statement, builtin and extern in the order the
  game hits them. That list is the to-do list.
- **Checked against references.** The Smacker decoder matches FFmpeg pixel
  for pixel and sample for sample on all of G-Nome's movies.

## Milestones

1. **Intro and menus** (in progress)
   - [x] VM, statements, expressions, script calls, switch tables
   - [x] boot path: script 0, startup, global initial values (key 3 of the
     .BIN turned out to be `{variable, value}` pairs)
   - [x] Smacker plugin and decoder; the opening movie (`DREAM.SMK`) plays,
     Esc and Space skip it, and the scripts then move on to the main menu
   - [x] sprite system, first pass: type 20 definitions, immediate
     messages 1/8/12/18, type 18 queues (cel animation, waits, moves,
     embedded statements), draw order by level
   - [x] bitmaps: RLE and packed (packed rows are stored bottom row first)
   - [x] click and hover regions (statements 0x10, 0x0e), sprite bounds
     (0x3f), timers (0xc4, 0x6d), type 14 statement lists (0xd9)
   - [x] menu sounds and music (`render.DSPlayWave` and friends)
   - [x] type 21 text objects (status line) drawn with a canvas font
   - [x] main menu, GAME submenu, credits movie
   - [x] all five submenus; OPTIONS screens (key mapping, difficulty,
     sound, detail); NETWORK reports no providers (`netgn` stub)
   - [x] NEW GAME: campaign briefing (map, objectives), training and
     mission lists. The unit preview beside the map needs
     `render.RenderToBitmap`, so it waits for milestone 3
   - [x] variable arithmetic (statement 0xa9), sprite loops and mirroring
     (queue records 6 and 7, message 7)
   - [x] palette fades over `speed` frames (colours 10-245, as RTLIB32
     does in 256-colour mode)
   - [x] mouse cursors from `RTLIB32.DLL`'s resources (statement 0x1b)
   - [x] every RTLIB32 statement and builtin the menus, LAB and mission 1
     run (sprite position/level 0x4d, 0x71, 0xb8; CD track 0x8e/0xd2 are
     remembered only, since CD audio is not in the game files)
   - [x] load screen (lists saves; saving needs a mission in progress)
   - [ ] remaining sprite messages (motion paths, speed)

   3D work (milestones 2-3) is split across separate project threads:
   unit previews / renderer core, the battlefield, and 3D animation data
   and object properties.
2. **Briefings and non-3D screens**: mission select, briefings, unit
   loadout. Mostly more of the same 2D services.
3. **3D battlefield**: reimplement the `RENDER.R32` externs on WebGL. Needs
   the model formats (PR #6 converts models to OBJ), terrain, cameras,
   object properties and the AI hooks. This is the largest part.
   - [x] renderer core: models, textures, objects (`src/render3d/`,
     [render3d.md](render3d.md))
   - [x] world, cameras, ground tiles, fixed-tick update loop with
     interpolation, controls (`src/battlefield/`,
     [battlefield.md](battlefield.md)); `?mission=N` starts a mission
   - [ ] movement, tasks and animation (`src/anim/`), collisions,
     hotspots, weapons
4. **Saves and settings**: `SGNOME*.SAV`, INI values (now kept in
   `localStorage`).
5. Networking (`NETGN.R32`, DirectPlay) is out of scope; the scripts already
   handle "network play not available".

## Status of the boot path

The game boots like this (script ids are resource ids):

| Script | What it does |
| --- | --- |
| 0 | clear the background to colour 181, queue script 2564 |
| 2564 | read INI settings, `render.Init3D`, allocate objects, reset globals, then 2565 |
| 5997 | read key bindings from the INI, then script 10 |
| 10, 7 | play `dream.smk` (string `0x8018`); Esc / Space run script 8 |
| 8, 9 | stop the movie, load palette 2510, fade in, run script 11 |
| 11, 5998 / 6005 | build the main menu from table 8611 (sprites, click regions, sounds) |
| 8344 etc. | main menu buttons; submenus come from tables like 8613 |

Coordinates in scripts are relative to the screen centre (320, 240), and
a bitmap is drawn centred on its sprite's position plus its own x/y offset.

## Running it

See [web/README.md](../web/README.md). The engine is published as a static
site by `.github/workflows/pages.yml`; players pick their own game folder
or .zip and nothing of the game is hosted.
