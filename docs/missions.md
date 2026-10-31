# Enemy AI and mission goals

How G-Nome's units pick targets and fight, and how a mission is won or lost.
Almost all of it is script code in `G-NOME.BIN`; `RENDER.R32` supplies the
task list, steering and aiming externs the scripts call. Script numbers are
resource ids (`node web/tools/disasm.mjs game/g-nome/G-NOME/G-NOME.BIN <id>`),
`Gn` is a global, `pN` an object property (`GetProperty(obj, N)`), and
addresses are `RENDER.R32` or `RTLIB32.DLL` virtual addresses (REA 6.8.0 with
Ghidra 12.1.4; see [battlefield.md](battlefield.md) for the decompile).

In the browser engine nothing here is special-cased: the scripts run as they
are, on top of the task externs (`web/src/anim/tasks.js`), the motion externs
(`web/src/anim/motion.js`) and the aiming externs
(`web/src/battlefield/aim.js`). `web/src/battlefield/mission.js` only reports
on the state and offers shortcuts to the end screens for testing.

## The unit update

Every unit's OB3D gives it update script 1723, run by the frame loop with
`(id, ms)`:

| Step | Script | What it does |
| --- | --- | --- |
| player | 1727 | the player's own unit runs the controls instead |
| p133 set | (end) | the unit is switched off (`script_2133(unit, 0)`) |
| AI | 419 | target scan and task timers, below (only the host in network play) |
| move | 2065 | `ApproachTargetSpeed`, then 2055 |
| weapons | 1680 | `Decrement_Recharge_Timers` |
| step | 1728 | `UpdateTimeStep`, collisions, then 2077 turns the turret and gun (`RotateSubClump`) |
| timer | 2272 | counts p116 down; at 0, script 2274 |

Script 419 keeps two timers:

- **p124, the scan timer.** When it runs out the unit looks for something to
  do: 2351 for pilots (class 24 and below), 2339 for vehicles. It restarts at
  p18 x 10 ms, at most 6 s.
- **p19, the task timer.** When it runs out, 417 makes the highest-priority
  task current (`TaskSetHighestIndex`) and runs its task script with the
  unit's id; 403 then handles messages from other units. It restarts at p18
  ms, which each task script sets to its own pace (2000 on guard, 300 when
  attacking).

## Tasks

Each unit has a task table (a copy of table 411, 10 rows of 9 ints; layout in
[formats/animation.md](formats/animation.md)). Column 0 is the script that runs
the task, column 3 its target, column 8 its priority; p60 is the current row.
Tasks seen in the campaign:

| Task | Meaning |
| --- | --- |
| 2024 | guard: look for targets within column 4 (3000 = 30 world units) of the unit, else stand (2007) |
| 2016 | go to / attack a target, up to the range in column 4 |
| 2017 | attack run with one of four patterns (column 5) |
| 2019 | attack: chase and fire at the target in column 3 |
| 2025, 2027 | escort and pursuit variants; they give up when the target is gone (class 270) |

Missions give units their first task when they place them; in mission 1 all
units start on guard (2024) with radius 3000.

## Finding a target

`script_2337(unit, centre, &dist)` walks the unit list G1816 (a `ListCreate`
of 150, filled by 2085 and emptied by 2086) and returns the nearest unit that
is hostile and has a pilot (p77), within the unit's sight p40 (17000 for
mission 1's enemies) of `centre`.

`script_2080(a, b)` decides hostility: two vehicles are enemies when their
side codes p113 differ (script 407/409 writes them, as `team * 10 + n`, and
re-rolls them over time; units on one side always share a code). A pilot
(class below 100) is an enemy when its p54 differs from the other unit's
team (`script_2081(a, 54)`).

The guard task (2015) attacks only inside its own radius: a target within
both p40 and the task's column 4 gets a 2019 task chained after the guard
(`setNextTask`), and the mission's **spotted** hook G988 runs with
`(target, unit)`. So mission 1's guards wait until the player is within 30
world units, then attack. A unit that leaves the mission area (2359, the
corners G1833-G1836) drops its tasks and heads back.

## Aiming and firing

Every task step calls `script_2006(unit, target, ...)`, which measures the
distance (p108) and the angle to the target (p107, `DotProduct` x 10000) and
then aims with 2012/2013:

- `MoveSubClumpToFace(unit, p22, target, 0, 2, ms, 56, 105, 0)` swings the
  turret (clump tag p22) one acceleration-limited step towards the target in
  the ground plane and writes cos(angle) x 10000 to p105.
- `MoveSubClumpToFace(unit, gun, target, 0, 1, ms, 56, 106, 111)` does the
  same for the gun's pitch (p106; the pitch rate lives in p111).
- 2072 and 2077 clamp the turret angle p24 to p20 and apply it with
  `RotateSubClump(unit, p22, 0, p27, p24)`; guns (p29, p31) get the pitch.

The fire decision reads p105/p106: units with no turret (p22 = 0) aim with
the whole hull (p105 = p107). Firing itself (projectiles, damage) is the
weapons code.

## Mission scripts

A campaign mission is a row of table 6984; its start script (8744 for
mission 1) places the objects and then runs a setup script (8737) that:

- picks the player's unit G973 and the mission's key units (G1, G13, G33,
  G625 from the object table 8743),
- switches off units that are not in play at the chosen difficulty G2114
  (`script_2133(unit, 0)`), and sets the goal: G2432 kills (2, 3 or 4),
- sets the mission's hooks:

| Global | Default | Called as | Called from | When |
| --- | --- | --- | --- | --- |
| G983 | 12 | `(unit, pilot)` | 2199, 2241 | a pilot gets out (eject) |
| G984 | 14 | `(unit, pilot)` | 2240 | a unit changes hands (a pilot boards it) |
| G985 | 15 | `(unit)` | 2278 | any unit is destroyed |
| G986 | 16 | `(other, unit)` | 2229, 2233, 2234, 2239 | a unit bumps into another (the collision scripts) |
| G987 | 17 | | | (set per mission; caller not found yet) |
| G988 | 18 | `(target, unit)` | 2015 | a guard picks a target |
| G989, G990 | 0 | `(unit)` | 582 | the player keeps a unit in the sights long enough to select it (G989), or loses it (G990) |
| G991 | 0 | `(unit, old task, new task)` | 421 | a unit moves on from a task |
| G992 | 0 | `(unit, side)` | 407, 409, 1936 | a unit's side code changes |
| G993 | 0 | `(unit, pilot)` | 2223 | a unit takes a pilot aboard (the pilot leaves the map) |
| G994 | 0 | `(unit)` | 5948, 5949 | a destroyed unit is replaced at a spawn point |
| G995 | 0 | `(unit, on)` | 4398, 4399 | a unit's 15-frame animation (FRME 4388) reaches its end or its start |
| G1221 | 0 | `(unit, sender)` | 403 | message type 6 from another unit |

Scripts 12 to 18 are empty, so a hook left at its default does nothing.
Mission 1 uses G985 = 8740: every enemy destroyed adds one to G707, and at
G2432 it marks the mission won (`script_8318(1, 2)`) and runs 2245. Its G984
(8739) and G988 (8738) only cue music (`script_314`).

## Winning and losing

| Script | Meaning |
| --- | --- |
| 2242 `(unit)` | destroy a unit: the player's own unit ends the mission (`2243(1)`, or `2243(2)` if it was already won), anything else goes to the death handler 2278 |
| 2278 `(unit)` | death handler: class-specific clean-up, the G985 hook, the explosion (`ExplodeModel`) |
| 2245 | objectives complete: `2243(2)` |
| 2246 `(?, row)` | objectives complete after a delay (`script_8318(row, 2)` first) |
| 2247 | objective failed: `2243(3)` |
| 2248 | `2243(4)` (recorded as 3) |

`script_2243(outcome)` ends the mission. It stores the outcome in G1827 (1
lost, 2 won, 3 failed; script 8317 starts every mission at 3), sets G1818,
and replaces the player's unit with a fly-by camera (`script_1702`: OB3D 1272
placed with `OrientModels` on the player's unit, G1826 = the old unit). A
timer then counts G1823 down; on a loss the old unit blows up when the
count reaches G1824. At 0, 2250 sets the debrief mode G1845 (3 won, 2 lost
or failed) and runs `script_1953(65)`, which puts the 3D view away and
closes the doors (2369: sprites 2391 and 2393, bitmaps 2392 and 2394, moved
by 2376-2386). When they meet, 2371 picks the next screen:

- G1845 = 3: 6008, then 7268: the next mission's briefing (G2119 + 1,
  G2152 = 2).
- G1845 = 2: 6007, then 7267: the same mission's briefing in retry mode
  (G2152 = 1), objectives only, ready to launch again.

The doors' code uses statement 0x5a, a compare-and-skip
(`0x100155ab -> 0x10018078`): `+2` else delta, `+6` a, `+10` b, `+0xe` op
(the same op bits as 0x59: 1 ==, 2 >, 4 <, 8 |, 0x10 &, 0x20 %, 0x80 not),
`+0xf` and `+0x10` "is a variable" flags. True moves on by the record length
(0x12).

## The aiming externs

**`RotateSubClump(id, clump, z, x, y)`** (`0x10016374` -> `FUN_10005580`):
builds a rotation about Z, then X, then Y (hundredths of a degree, each about
the fixed parent axes, `RwRotateMatrix` with combine 3), keeps the
translation of the clump's current joint matrix and sets it with
`RwTransformClumpJoint`. FRME animation sets the clump's own matrix with
`RwTransformClump`, so the two combine; the engine applies the joint before
the clump's local matrix, so a turret turns about its own origin.

**`MoveSubClumpToFace(id, clump, target, targetClump, mode, ms, heightProp,
cosProp, rateProp)`** (`0x100137d7`):

- The aim point is the target's position raised by
  `prop[heightProp] / 2000` world units, or the origin of `targetClump`.
- The part's axes are its clump's (`RwGetClumpLTM`), or the object's when
  `clump` is 0. Mode 2 (yaw) measures the angle between at and the
  direction in the ground plane, signed by the right vector. Mode 1 (pitch)
  measures the angle between the two elevations, signed by the up vector,
  from the clump's own origin; a target behind (at . d < 0 in x/z) writes
  -10000, zeroes the rate and returns 0.
- cos(angle) x 10000 goes to `prop[cosProp]`. The turn is one step of
  `FUN_1001c460` (the acceleration-limited approach also used for yaw
  targets), with the pitch or yaw limits at `+0xc4`/`+0xd0` or
  `+0xc8`/`+0xd4`. The rate is `prop[rateProp] / 100`, or the twist rate at
  `+0x6c` when `rateProp` is 0, and is written back the same way.
- Returns the step in hundredths of a degree, negated for pitch.

**`OrientModels(src, dst, clump, dx, dy, dz, upright)`** (`0x10007ccd`):
copies src's axes (or those of src's clump) to dst and puts dst at src's
position or the clump's origin plus the offset, which is in that frame (in
world axes for a dst without a model placed on src itself). `upright` levels
the axes: up = +Y, right = up x at, at = right x up.

## Testing

```bash
node web/tests/mission-check.mjs game/g-nome/G-NOME
```

plays mission 1 headless: a guard attacks and aims at the player once they
are close, destroying the enemies leads to mission 2's briefing, and losing
the player's unit leads back to mission 1's.

In the browser console (or `shot.mjs`'s `eval@` steps):

```js
engine.mission.status()          // player, enemies and their tasks, hooks, outcome
engine.mission.destroyEnemies()  // destroy every hostile unit through script 2242
engine.mission.win()             // objectives complete (script 2245)
engine.mission.lose()            // destroy the player's unit
```

```bash
NODE_PATH=$(npm root -g) node web/tools/shot.mjs 30 /tmp/win '?mission=1' \
  2:Escape 3:Escape 4:Escape '12:eval@engine.mission.destroyEnemies()'
```
