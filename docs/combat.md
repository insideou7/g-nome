# Weapons, projectiles and damage

How G-Nome fires weapons, flies shots, applies hits and blows units apart,
from the mission scripts in `G-NOME.BIN` and the Ghidra decompile of
`RENDER.R32` (addresses are virtual addresses, image base `0x10000000`; see
[battlefield.md](battlefield.md) for how to reproduce the decompile). The
browser engine's version is in [`web/src/combat/`](../web/src/combat).

The rules (ammunition, charge, shields, part health, who gets the kill) are
all script code. `RENDER.R32` only runs the per-tick loops and the geometry,
and calls back into scripts for every decision.

## Firing

Fire actions 29-32 in table 2544 are held keys (`1`-`4` in the default map),
polled every tick by script 1974 with `CheckActionState`, which calls
`script_1675(player, group, target, 1)`. Script 1682 makes the shot:

1. Reads the weapon from the unit's copy of its weapon table (property 66,
   count in 67): column 1 the row of table 1281, 2 enabled, 3 ammunition,
   4 the mount, 5 charge still missing.
2. Table 1281 (32 x 25) is the weapon catalog: column 0 the weapon kind
   (7 is the guided missile the camera rides), 1 the type (1 = energy), 5
   speed, 6 damage, 7 full charge, 9 the script that spawns the shot
   (1691-1707, one per projectile model), 10 gravity, 13 range, 15-19 the
   shot's damage properties, 24 the network id.
3. Energy weapons fire with whatever charge they have once it is over 30%,
   with damage, range and life scaled by it, so holding the key gives a
   stream of weak shots and tapping gives full ones.
4. The spawn script copies an `OPRT` (1245-1278: update every 30 ms with
   script 1734, models linked by level of detail through 2143/2144), and
   `OrientModels(unit, shot, clump, dx, dy, dz, 0)` puts it on the mount
   clump from table property 89. Then `SetVelocityForward`, gravity, and the
   properties below.

Shot properties: 42 owner, 44 life in ms, 45 homing target, 46 damage, 50-54
damage modifiers, 58 the row of table 1281, 59 the sound.

## The callback table

Scripts pass `&G1861[0]`, filled by the mission setup:

| Slot | Script | Called by | Arguments |
| --- | --- | --- | --- |
| 0 | 2228 | `Projectile_Update` | hit(shot, target, hotspot, ms), returns 1 when it handled the hit |
| 1 | 1689 | `Projectile_Update` | destroy(shot, how): 0 out of life, -1 hit the ground |
| 2 | 1683 | `Projectile_Update` | the shot's weapon kind (column 0 of table 1281) |
| 3 | 1681 | `Decrement_Recharge_Timers` | recharge(unit, weapon, ms, power), 1 while charging |
| 4 | 2055 | `Decrement_Recharge_Timers` | drain energy(unit, -amount) |
| 5 | 2058 | `Decrement_Recharge_Timers` | overheat(unit, 1) |
| 6 | 430 | `Process_Sector_Collisions` | the list of objects in the unit's sector |

The plugin calls them with `RtRunMsg` and a "call script" record (statement
1) built on its stack with 0 caller locals, and uses the script's return
value.

## Natives

| Extern | Address | What it does |
| --- | --- | --- |
| `Decrement_Recharge_Timers(unit, ms, cb)` | `0x100286ab` | counts property 118 down; runs cb[3] for every weapon with half the power (property 98); for vehicles (class >= 100) drains half the power with cb[4] while something recharges, and while charge (97) is below 94 runs the overheat timer (112, `-= ms x power / 1000`, cb[5] and reset to 2000 when it runs out) and drains a quarter |
| `Projectile_Update(shot, ms, guided, &fade, list, player, cb)` | `0x10028170` | see below |
| `StopProjectileObject(shot, target, hotspot)` | `0x10023f7f` | puts the shot back on the surface it hit, in x/z: on the target's radius along the line back to where it came from, or where that line crosses a footprint hotspot's edges |
| `CollisionClump(shot, target)` | `0x10010dbc` | the first tagged clump whose bounding box the shot's last move (`+0x24` to `+0x0c`) crosses, -1 for none; an untagged model is one box and reports 0, which script 2228 treats as a miss |
| `ExplodeModel(obj, gravity, speed, script)` | `0x10012142` | every clump below the root becomes its own object (see below) |
| `AmputateClump(obj, model, clump)` | `0x10007152` | cuts a clump with its children off into a new still object and returns its id; the scripts then explode and delete it |
| `QueryClumpList(model, clump)` | `0x1000853e` | a list of the tags in a clump's hierarchy (for clump 0, without the untagged root) |
| `ReplaceClump(model, source, clump)` | `0x10009091` | swaps a part for the same part of another model (damaged parts), keeping its joint and children |
| `DefaultClumpHealths(model, clump)` | `0x100089ca` | `max(1, trunc((dx dy dz)^0.3333 x 390))` of the clump's bounding box |
| `SetAnimatedTexture(obj, clump, frames)` | `0x10009962` | marks the object's texture as animated with `frames` frames (`+0x94`, flag `0x20`) |
| `UpdateAnimTex(obj)` / `UpdateAnimTexCycle(obj)` | `0x1000a64a` / `0x1000a789` | shows frame `+0xBC` and steps it; the first returns 1 once past the last frame (fireballs then delete themselves), the second wraps (flames, smoke) |
| `SetTextureFrame(obj, f)`, `GetTextureNumFrames(obj)` | `0x1000a2c9`, `0x1001278e` | set the frame counter, read the count |
| `ObjectPlayWave(obj, wave, loop, a, priority, remember)` | `0x100140ad` | `DSPlayWave` with volume `10000 - 3500 x distance / far` and pan `1000 x dir . camera right`; a priority of 10 drops by one at volumes 8000, 7000, 4000 and 1000 |
| `MakeSpriteExtern`, `MakeSpriteDraw`, `DamageRect` | `0x10012ffe`, `0x10012fa0`, `0x10011acb` | HUD sprites drawn over the 3D view, and dirty rectangles; nothing to do in the browser |

### Projectile_Update

Script 1734, every 30 ms for every shot:

1. Out of life (property 44 < 1): cb[1](shot, 0) and stop.
2. If this is the guided shot the player steers (G1780), `SetTargetAxis`
   from the turn (37) and pitch (38) properties.
3. `UpdateCollideCheck(shot, list, 2 x ms, owner)`: the nearest unit in
   G1814 within reach; cb[0](shot, unit, 0, ms) and stop if it returns 1.
4. `UpdatePosOrient`, then `Process_Sector_Collisions(shot, &hotspot,
   &object, 1, cb)` for buildings. The nearer of the two hits wins; an
   object with a model is hit as an object (hotspot 0). cb[0] again.
5. Not handled: below the ground gives cb[1](shot, -1); otherwise class 304
   (flamer) cycles its texture, life drops by `ms`, a homing shot (property
   45) pursues its target with `MoveToPursue` (unless it is the player's
   guided missile), and velocity = `at x speed`.

### Hits

Script 2228 handles a hit: with a hotspot it asks script 2238 by hotspot
type; against a unit it calls `CollisionClump` to find the part, then
`StopProjectileObject`, and `script_1709(target, part, shot)` applies the
damage (shields in property 19 first, then the part's health in the table
in property 85), and 1689 destroys the shot with its impact effect. When a
unit dies (2278, 2300) `ExplodeModel(unit, -77, 50, 1731)` throws its parts.

### ExplodeModel

`FUN_10005b20` / `FUN_100056bd`: for every clump with a parent (each one on
its own, since `RwForAllClumpsInHierarchy` reaches the children after their
parent has been detached), a new object (`RtDynamicResource`) with:

- position and axes from the clump's world matrix,
- velocity = the object's + `normalise(clump origin - root origin) x
  rand/32768 x speed/100`,
- each angular rate = the object's + `(rand - 0x4000) x speed/100 / 128`
  degrees per second,
- gravity / 100, radius 0.05, behaviour 6 with the object's update interval
  and `script` (1731 and 1732 fly the piece, add smoke, and delete it when
  it reaches the ground).

The object keeps its root clump and stops: gravity, speed, FRME and stride 0.

## Also found

- Builtin `0x0B` `GetAngle(x1, y1, x2, y2)` (`0x1000487a`): `trunc(atan2(x2 -
  x1, y2 - y1) x 1800 / 3.14159)`, plus 3600 when negative. The cockpit
  compass uses it once a target is locked.
- The cockpit's hit marker moves with sprite queue record 2 (a motion path),
  which the sprite system does not run yet.
