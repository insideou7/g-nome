# Cheats and debug tools

G-Nome has fifteen cheat codes and a set of hidden Ctrl-key actions, all in
the scripts of `G-NOME.BIN`. The browser engine's DEBUG button (first slot on
the right of the OPTIONS screen, `web/src/debug.js`) runs them through the
game's own scripts.

## Entering a code

On the main menu, Shift+F1 runs script 5995 (bound by script 5998:
`key_bind 0x70 -> 5995, shift`), which opens a text box writing string slot 7.
Script 5996 compares slot 7 with fifteen constant strings, all anagrams of
team members' names from the credits.

| Code | What script 5996 does | Effect |
| --- | --- | --- |
| Range Goes Gory | G2428 = 23, G2073 \|= 1, G2076 = 1, G2077 = 1, mask \|= 32764 | every Ctrl-key cheat, all missions, two extras |
| Redtop Trod | G2428 = 23, G2073 \|= 1 | all 23 campaign missions in the mission list |
| Had A Nude On | mask \|= 4096 | Ctrl+I: invulnerable (property 140) |
| Horny Elk Leer | mask \|= 512 | Ctrl+P: repair (properties 114 and 40 = 20000) |
| Brass Clue | mask \|= 1024 | Ctrl+X: refill ammunition (script 1671) |
| Oh No! Less Japan | mask \|= 2048 | Ctrl+Z: give weapon 32 (`script_1659(G973, 32)`) |
| Rotted Drop | mask \|= 8192 | Ctrl+F: destroy the current target (`script_2078`) |
| Half Libel | mask \|= 16384 | Ctrl+B: teleport 5 m above the current target |
| A Mere Fart | mask \|= 8 | enables action 84, which has no default key |
| Chaste Coed | G1845 = 3, G2141 = 22, `script_2369()` | wins the campaign: the ending movie `G-NOME.SMK` |
| Dunk It Here | `script_305()` | stops the CD music, plays the sound list in table 304 |
| Swiss Throat | G2076 = 1 | the Citadel (script 5070) gets another inside view; Tab flips through 23 pictures |
| Mother Mourn Us | G2077 = 1 | changes the player's setup in mission 5 (scripts 8822, 8823) |
| O'Sarge | G2075 = 1 | mission 31 uses table 9283 instead of 9282 |
| A Scramble On | `SetFlag94dd(1)` | RTLIB32 flag `+0x94dd` (an Escape-key path) |

Every code that works ends with `script_8351()`, a confirmation sound.

## The action mask

"mask" is global 1857. `script_2561(bits)` ORs bits into it and calls
`MapActionKeys(2544, 2545, 2547, mode + 2, G1857)`. An action of table 2544
fires only when its column 1 shares a bit with the mask, so the cheat bits
unlock actions 84-95, whose Ctrl+key bindings are in table 2547 (device 1 is
Ctrl, 2 is Shift). Multiplayer games save the mask and reset it to 1
(`script_2562`).

Two actions need bit 2, which no code sets. They look like developer keys,
and the DEBUG panel can turn them on (`script_2561(2)`):

| Keys | Action | Script |
| --- | --- | --- |
| Shift+R | 97 | 1935: toggles the frame rate display (scripts 552-554, `GetFrameRate`) |
| Ctrl+C | 96 | 1945: toggles a state on the player's unit (scripts 1226-1228) |

## Starting a mission in another vehicle

The DEBUG panel's level select starts campaign mission N the way the
briefing does (globals 2118 and 2119 = N, global 982 = 0, script 8317). With
a vehicle chosen, it then places a unit from the object catalog (table 5843)
six metres ahead of the player, as `script_2523` places a mission's units
(`script_2039`, the catalog's init script, `script_428`, `script_2286`,
`script_1736` to keep the update script in property 65), and gives it the
player's side (property 113).

- A vehicle (class 100-230) is entered with `script_2240(pilot, vehicle, 1)`,
  the game's "climb into an empty vehicle" path, after setting property 77
  to 0 (placement leaves -1, which reads as locked). When the player starts
  in a vehicle, its pilot (property 78) climbs over and the old vehicle is
  removed.
- Personnel switch with `script_2088(unit)`, and the old unit is removed.

The names come from the LAB: table 8115 row 0 (vehicles) and row 2
(personnel) hold one table per side, whose rows are a catalog row and an
offset of a length-prefixed name in `LABTEXT.DAT`.

## Unused weapons

"Unused weapons: on" in the level select adds the two weapons that nothing in
the game hands out (kinds 12 and 27 of table 1281, see
[unused-content.md](unused-content.md)) after the mission starts
(`Debug.giveWeapons`). Each goes on the first mount (0-3) with no weapon
(`script_1665(unit, mount) == -1`) through `script_1656(unit, kind,
ammunition, mount)`, as the units' setup scripts do; with every mount taken
the last one is swapped with `script_1658`, like a pickup. Keys 1-4 fire
mounts 0-3. Ammunition is a pickup's (`column 23 x 1.5`, script 1659),
except that energy weapons get 2000 like in the setup scripts: kind 27's
column 23 is 0, and script 1682 does not fire a weapon with no ammunition
left, so a pickup of kind 27 would never have fired either.
