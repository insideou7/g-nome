# G-Nome browser engine

A work-in-progress reimplementation of 7th Level's Runtime Player that runs
G-Nome from the original game files. Plan and status:
[docs/engine-plan.md](../docs/engine-plan.md).

You need your own copy of the game. Nothing here contains game data.

## Play

Serve the repo root with any static web server, open `web/index.html`, and
choose the folder that holds `G-NOME.BIN` (the `G-NOME` folder on the CD).
Files are read in the browser and never uploaded.

```bash
python3 -m http.server 8000
# open http://localhost:8000/web/
```

Today it boots the game's scripts, plays the opening movie (Esc or Space
skips it) and runs the main menu with its music, sounds and status text.
All submenus, the options screens, the credits and the first campaign
briefing work. Anything that draws 3D (the LAB, unit previews, missions)
needs the RENDER.R32 reimplementation, which is the next big piece.

During development you can skip the folder picker:
`http://localhost:8000/web/?game=/game/g-nome/G-NOME/` reads the files over
HTTP from the repo's git-ignored `game/` folder.

## Developer tools

```bash
# Run headless and list every unimplemented statement / builtin / extern
node web/tools/run-headless.mjs game/g-nome/G-NOME --ticks 2200

# Disassemble scripts (linear, includes else branches and switch cases)
node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN 7 9 11
node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN all > re-output/scripts.txt

# Screenshots from headless Chromium: 15 seconds, press Escape at 12 s
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 15 /tmp/boot 12:Escape

# Check the FRME/OB3D decoders and the animation system on a real unit
node web/tests/anim-check.mjs game/g-nome/G-NOME
node web/tests/motion-check.mjs

# Check the Smacker decoder against FFmpeg
node web/tests/smacker-check.mjs game/g-nome/G-NOME/G-NOME.SMK
```
