# G-Nome browser engine

A work-in-progress reimplementation of 7th Level's Runtime Player that runs
G-Nome from the original game files. Plan and status:
[docs/engine-plan.md](../docs/engine-plan.md).

You need your own copy of the game. Nothing here contains game data.

## Play

Serve the repo root with any static web server, open `web/index.html`, and
load your copy of the game. Files are read in the browser and never
uploaded. Any of these works:

- **Choose game folder**: the CD, the install folder, or the `G-NOME`
  folder itself. The engine uses the folder that holds `G-NOME.BIN` and
  ignores the rest (the CD's demos of other 7th Level games have their own
  `RTLIB32.DLL`). In Chrome and Edge the folder is remembered, so the next
  visit shows **Continue with "..."**; the browser asks again for permission
  to read it.
- **Open a .zip** of any of those folders. The zip is read in place: each
  file is inflated when the engine needs it.
- Drag the folder or the .zip onto the page.

The loaders are in `src/gamefiles.js`; `node web/tests/gamefiles-check.mjs
[game.zip]` checks them.

## Hosting

`.github/workflows/pages.yml` publishes `web/index.html` and `web/src/` to
GitHub Pages on every push to `main` that touches them. The published site
is only the engine's code; the workflow fails if anything that looks like
game data ends up in it. To turn it on, set **Settings > Pages > Source** to
**GitHub Actions** (Pages on a private repo needs a paid plan). The site is
plain static files, so any static host works: publish `web/index.html` and
`web/src/` together.

```bash
python3 -m http.server 8000
# open http://localhost:8000/web/
```

Today it boots the game's scripts, plays the opening movie (Esc or Space
skips it) and runs the main menu with its music, sounds and status text.
All submenus, the options screens, the credits and the first campaign
briefing work. Anything that draws 3D (the LAB, unit previews, missions)
needs the RENDER.R32 reimplementation, which is the next big piece.

### Music and volume

G-Nome's music is CD audio (tracks 2-20 on the game CD), which a browser
can't read from a disc. If you have ripped the tracks, put them in the game
folder or in a `MUSIC` folder inside it, named like `TRACK02.OGG`,
`Track 02.mp3` or `02.wav` (OGG, MP3, WAV, FLAC, Opus or M4A), and they play
when the game asks for them. Like the original, the menus have no music; the
missions do.

OPTIONS > SOUND keeps the game's own On/Off switches for CD Music and
SFX/Dialogue, and adds a volume slider for each (movie sound follows the
SFX/Dialogue slider). The levels are saved in the browser.

During development you can skip the folder picker:
`http://localhost:8000/web/?game=/game/g-nome/G-NOME/` reads the files over
HTTP from the repo's git-ignored `game/` folder; `?game=<url>.zip` reads a
zip.

To jump straight into a campaign mission, add `&mission=N` (N is the
mission number, 1-22): `web/?game=/game/g-nome/G-NOME/&mission=1`. In a
mission numpad `+` and `-` (or Ctrl+Up and Ctrl+Down) set the speed, Left
and Right turn, Up and Down tilt the gun, and you bump into units, trees and
cliffs.

## Debug menu

OPTIONS has a DEBUG button in the first empty slot on the right. It opens a
panel with a level select (any campaign mission, in any vehicle or as any
soldier), a frame rate counter, and the game's own cheat codes. See
[docs/cheats.md](../docs/cheats.md).

## Developer tools

```bash
# Run headless and list every unimplemented statement / builtin / extern
node web/tools/run-headless.mjs game/g-nome/G-NOME --ticks 2200
# ...in mission 1, with a summary of the 3D world and camera
node web/tools/run-headless.mjs game/g-nome/G-NOME --ticks 300 --mission 1 --world

# Automated play-through: menus, options, network, LAB, EXIT prompt,
# campaign briefing and mission 1 (about 15 s; exits 1 on a failure)
node web/tests/walkthrough.mjs game/g-nome/G-NOME
# ...one section, with a PNG of each screen it visits
node web/tests/walkthrough.mjs game/g-nome/G-NOME --only lab --shots /tmp/walk

# Battlefield checks (maths; plus mission 1 when given the game folder)
node web/tests/battlefield-check.mjs game/g-nome/G-NOME

# Enemy AI and mission goals: a guard attacks, winning and losing mission 1
node web/tests/mission-check.mjs game/g-nome/G-NOME

# Disassemble scripts (linear, includes else branches and switch cases)
node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN 7 9 11
node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN all > re-output/scripts.txt

# Screenshots from headless Chromium: 15 seconds, press Escape at 12 s
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 15 /tmp/boot 12:Escape
# ...of mission 1
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 12 /tmp/m1 '?mission=1' 2:Escape 3:Escape 4:Escape
# ...holding keys: walk forward for 2 seconds, extra screenshot at 8 s
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 12 /tmp/m1 '?mission=1' 2:Escape 3:Escape 4:Escape 5:down:NumpadAdd 7:up:NumpadAdd 8:shot

# Collision maths, plus walking into a cliff in mission 1
node web/tests/collision-check.mjs game/g-nome/G-NOME

# ...and win it at 12 s (eval@ runs JavaScript in the page; see docs/missions.md)
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 30 /tmp/win '?mission=1' 2:Escape 3:Escape 4:Escape '12:eval@engine.mission.destroyEnemies()'

# Check the FRME/OB3D decoders and the animation system on a real unit
node web/tests/anim-check.mjs game/g-nome/G-NOME
node web/tests/motion-check.mjs

# Check the OPTIONS > SOUND volume sliders and CD track file names
node web/tests/sound-options-check.mjs game/g-nome/G-NOME

# Weapons: fire at the walker in mission 1 until it blows up
node web/tests/combat-check.mjs game/g-nome/G-NOME

# Check the Smacker decoder against FFmpeg
node web/tests/smacker-check.mjs game/g-nome/G-NOME/G-NOME.SMK
```

`web/tests/player.mjs` is the headless player the walkthrough uses: it boots
the engine in Node, clicks and presses keys at screen coordinates, and reads
back click regions, visible text, sprites and the screen (with the 3D view).
New tests can drive the game the same way.
