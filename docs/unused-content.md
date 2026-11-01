# Unused and unfinished content

Survey of 2026-11-01. How it was checked: every script in G-NOME.BIN disassembled (`web/tools/disasm.mjs ... all`),
weapon table 1281, object catalog 5843, the 33 mission object tables passed to `script_2523`,
the LAB lists (table 8115) and briefing lists (6984 column 1).

## Cut from the original game (data is there, nothing uses it)

### Weapons (table 1281, 32 rows, looked up by kind in column 0)
Weapons reach a unit only through `script_1656(unit, kind, ammo, slot)` with a literal kind,
the pickup script 1659 (kinds 20, 25, 26, 32), the random-loot script 9374 (8, 20, 22, 23, 25)
and the Ctrl+Z cheat (32). Two kinds are never given to anyone:

| Kind | Row | Type | Speed | Damage | Range | Shot | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 13 | 3 | 750 | 30 | 5000 | red pulse (spawn 1697, like kinds 4, 7, 9, 15, 16, 21) | a mid-strength member of that family; kind 9 is the 48-damage one |
| 27 | 29 | 1 (energy) | 1000 | 10 | 1600 | green photon bolt (spawn 1691, like the heavy kinds 22 and 23) | weak, short range, 6000 charge, network id 0 |

Both rows are complete (sounds, hit effects, damage modifiers), so they would work if a
unit were given them: `script_1656(unit, 12, ammo, slot)`.

Also orphaned: shot spawn script 1695 (OPRT 1257, REDLASER texture) and 1706 (a fourth copy of
the 1703-1705 rocket spawner); no weapon row points at them.

### Object catalog rows (table 5843) no mission places
| Row | Class | What (texture prefix) | Seen in |
| --- | --- | --- | --- |
| 112, 132, 144 | 234 | power plant variants (DPWR, MPWR, SPWR); every mission and LAB list uses the HPWR one, row 123 | nowhere |
| 126 | 231 | a class-231 structure | LAB list 8127 only |
| 136 | 229 | SMSN/SAUT structure | LAB 8127 and a briefing; may still be built at run time by a factory (script 4741 spawns by row) |
| 28, 29, 160 | 237 | fence pieces (DFNCPOST/DFNCELEC electric fence) | nowhere |
| 41, 44 | 251 | river/road pieces (DRV/DRE) | nowhere |
| 75, 79, 87 | 252 | DCIT, GCOT, MCOT scenery buildings | nowhere |
| 103, 164, 190 | 253 | rock pieces | nowhere |

All 24 vehicle rows (0-23) are used.

### Engine features the game never calls
Sprite motion paths/speed (queue records 5, 9, 10, 13, 15-17; PR #45), OB3D kinds 1 and 8,
builtins LinePoint 0x73 and CurvePoint 0x1D. Cheat-only: action 84 (no default key),
the Citadel's extra views ("Swiss Throat"), mission 5's alternate setup, mission 31's alternate
table. See docs/cheats.md.

## Pause (was missing in the browser port)

The Pause key and the in-mission H and Escape menus now pause the game as the
original does:

- `SetPauseScript(script)` (RENDER.R32 `0x1000db88`) stores the script at
  `+0x118`; RENDER's window procedure runs it on `WM_KEYDOWN` with
  `VK_PAUSE` (0x13) before the key goes on to RTLIB32. The missions set
  script 2262, which toggles G979 and calls `Pause3D`, `TimersPause`,
  `DSPauseAudio` and `SpritePause(0, on)`, and shows sprite 2260.
- `TimersPause(on)` (RTLIB32 builtin 0x8D, `0x10021e7b`) remembers the time
  (`rt+0xb78`); on resume it adds the paused span to every timer's due time.
- `SpritePause(sprite, on)` (0x8C, `0x10037413`; sprite 0 = all) sets
  sprite flag `0x1000` and on resume moves the sprite's clock (`+0x50`) on by
  the paused span.
- `DSPauseAudio(on)` (`0x10020d85`) and the Pause key itself are RENDER.R32's
  side, in `web/src/waves.js` and `web/src/input.js` (PR #61).
- Scripts 1887 (action 77, key H) and 1888 (action 78, Escape) call
  `TimersPause` and `Pause3D` for the in-mission menus.

`web/tests/walkthrough.mjs` (mission1) presses Pause twice and checks that
the timers wait.

`SetObjPerspective` still returns 0 (not checked further).
