# Game mechanics audit (port vs original)

November 2026. The question: do weapon damage, fire rates, projectile speed,
movement and turning, health and armour, AI and timers in the browser port
behave the way they do in the 1997 game?

## Where the numbers live

Almost every gameplay number is **script data in G-NOME.BIN**, not code:
the weapon catalog (table 1281: kind, damage, range, ammunition, recharge),
the part table (property 85: armour, health), unit speeds and turn limits
(`SetMaxAccel`, `SetMaxAngularVelocity`, properties 12/33/35), enemy fire
odds (script 1677) and mission rules. The port runs that bytecode unchanged
in its VM, so these values are the original's by construction. No file in
`web/src` hard-codes a damage, speed or health value; the natives only read
and write object properties the scripts set.

What the port reimplements is the **natives** that apply those numbers each
tick (RENDER.R32 externs and RTLIB32 builtins). Those are what this audit
checked, against fresh Ghidra decompiles of RENDER.R32 and RTLIB32.DLL.

## Checked and matching

| Mechanic | Original | Port |
| --- | --- | --- |
| Movement and gravity (velocity first gets gravity, then position) | `FUN_1001a754` | `WorldObject.move` |
| Spinning, pending yaw target, settle rule (< 0.5° and step <= 0.1°) | `FUN_1001a290` | `spinStep` |
| Acceleration-limited turning (start, brake, max rate) | `FUN_1001c460` | `approachAngle` |
| Turn and pitch keys (4x braking, 1/100 nudge from rest) | `SetTargetAxis` `0x10016dd9` | `rampRate` |
| Speed changes, min speed while animated, energy drain x7 / x5 | `ApproachTargetSpeed` `0x1000ba71` | `motion.js` |
| Shot flight: life, guided steering, unit hit before move, sector hit after, nearer one wins, ground, homing | `Projectile_Update` `0x10028170` | `projectiles.js` |
| Weapon recharge, half power, energy drain, overheat timer reset to 2000 | `Decrement_Recharge_Timers` `0x100286ab` | `projectiles.js` |
| Unit collision (octagonal x/z distance, radii + look-ahead) | `UpdateCollideCheck` `0x100182d0`, `FUN_1001ab5c` | `collision.js` |
| Ground check (`radius + ground - y <= 0`) | `UpdateGroundCheck` `0x10017fbb` | `externs.js` |
| `Random(a, b)`: `a + rand() % (b - a + 1)`, both ends included | RTLIB32 builtin 0x99 `0x100041a4` | `builtins.js` |
| Script timers: fire when due <= now; repeat from now; pause shifts due times | `0x100219bc`, `0x10021c54`, `0x10021e7b` | `engine.js` |

Earlier threads had already matched part health (`DefaultClumpHealths`,
PR #86), hit boxes (`CollisionClump`, PR #84), object turn limits
(`FUN_1001a850`, PR #69) and turret aiming (`MoveSubClumpToFace`).

## Fixed in this pass

- **`UpdateTimeStep` banked time.** The original banks the time not yet
  moved in the object property the script names (script 1728 passes 41;
  set-up scripts 2041 and 2043 start it at 1). The port kept it in a
  private array, so the scripts' writes to property 41 were ignored. It now
  uses the property. In play the difference is about a millisecond per
  unit, but it is now the same state the scripts see. Test:
  `web/tests/unit/timestep.test.mjs`.
- **`OrientModels` ground height** was copied to a field nothing reads
  (`ground` instead of `groundY`). G-Nome's ground is flat, so nothing
  changed on screen.
- **Update intervals.** An object with an update interval runs when more
  than the interval has passed (`interval + last < now` in `FUN_10029856`);
  the port used `>=`, so with 33 ms ticks a 100 ms interval ran every 3
  ticks instead of 4. `World.due` now uses `>`.
- **Aim assist** (ours) is now off by default, as the original has nothing
  like it. It stays a toggle in the DEBUG panel (Gameplay, "Aim assist").

## Differences left for a decision

1. **Fixed 30 Hz tick** (kept, by choice). The original runs one update per frame with the
   real elapsed time (at least 5 ms, at most 250 ms per update). The port
   steps a fixed 33 ms. Most rules scale with elapsed time, so speeds,
   turns, recharge and timers come out the same. Two things depend on the
   step size: the 1/100 nudge when a turn starts from rest (once per call)
   and the collision look-ahead (2 ms per ms). Both are small at normal
   frame rates.
2. **Frames with no camera object.** With Init3D's flag at 0 (as G-Nome
   sets it), the original runs other objects' updates only in frames where
   the object carrying the camera was updated. With no camera object
   (`SetCamera` only), nothing else updates. The port updates every due
   object in that case. This was not traced to a scene a player would see.
3. **Random sequences.** `Math.random` replaces the C runtime's `rand()`:
   same ranges and odds, different sequences. Explosion scatter already
   uses the MSVC `rand` formula (`damage.js` `crand`).
