# 3D animation, objects, motion, tasks, lists, files and hotspots

How G-Nome animates its 3D models, and the other `RENDER.R32` data the
mission scripts use. Everything here was read from the Ghidra decompile of
`RENDER.R32` (addresses are in the 0x10000000 image) and checked against the
game's data and scripts.

Code:

- `tools/gnome3d.py`: Python decoders for models, FRME and OB3D/OPRT, plus
  OBJ and glTF export (used by `tools/gnome_extract.py`).
- `web/src/anim/`: the browser engine's decoders (`formats.js`) and the
  externs: animation (`animation.js`), motion and steering (`motion.js`),
  tasks (`tasks.js`), lists (`lists.js`), files (`files.js`) and hotspots
  (`hotspots.js`).
- `web/tests/anim-check.mjs`: decodes every FRME and object and runs a real
  unit's animation set through idle, walk and stop.
- `web/tests/motion-check.mjs`: speed, turning, steering and the task list
  on stand-in objects (no game files needed).

Conventions: matrices are RenderWare's, 4x4 for row vectors (`v' = v * M`)
with the translation in the last row. Scripts pass numbers as integers;
`Init3D` sets a scale of 100 (plugin context `+0xB4`), so 100 script units
are one world unit, and speeds compared in scripts are `|speed| * 100`.

## Clump tags (model op `0x2D`)

The u32 after a model's `MODL`/`MPRT` tag is the number of tagged parts.
Op `0x2D` (RWX `Tag`) gives the clump it appears in a part number from 1 to
that count; the root clump is untagged. The model loader (`0x100043f0`) looks
up every tag with RenderWare after building the clump, and every per-part
extern (`RotateSubClump`, `AmputateClump`, `SetClumpHints`, FRME frames, ...)
uses those numbers. All 801 models have exactly tags 1..count (or none).

A transform op before a `clumpbegin` is that clump's joint transform
relative to its parent. A model's own transforms are its bind pose.

## FRME (type 4): animation clips

```
char[4] "FRME"
u32     parts     = the model's tagged part count
u32     frames
u32     0
frames x parts x { f32 rotation[3][3]; f32 translation[3]; }   48 bytes
```

Frame `f`, part `k` (0-based) is the joint transform of the clump tagged
`k + 1`. Showing a frame (`0x10006085`) turns each 3x4 into a 4x4 and
**replaces** that clump's joint matrix; untagged clumps keep theirs.

332 clips (one entry is empty). Resource 4733 says 71 frames but holds 70.
Some matrices carry a uniform scale (the hip part of the walkers).

### Rest poses and the "spread apart" models

Some models' own transforms are wrong. Models 2585 and 2587, for example,
have their legs and body far apart in the file, and 2643's body floats 9
units above its legs. The game never shows the bind pose: it installs an
animation at once, and the clips hold the assembled pose. The extractor
therefore poses OBJ and glTF output in the model's **rest clip**: its first
one-frame FRME (the scripts' animation type 11, "idle"), else frame 0 of its
first clip.

### Which FRMEs belong to which model

Nothing in the data links them; scripts name FRME ids in `addAnimation`. But
each game object's resources are stored together: models (one per level of
detail or colour), their textures, the FRMEs, then the OB3D/OPRT. The
extractor assigns each FRME to the models of its group with the same part
count. That covers all 332 clips (127 models get animations), and agrees
with the scripts: for example the unit set up with `addAnimation(..., 2598,
2605, 2612, ...)` uses models 2583 (20 parts), 2589 (18) and 2595 (15), and
2598, 2605 and 2612 have 20, 18 and 15 parts.

## OB3D (type 9) and OPRT (type 10): object definitions

An object is a copy (`CopyResource`) of an OB3D or OPRT resource, which
`RENDER.R32` expands when it loads (`0x100043f0`) into a `0xEC`-byte header
followed by 16-byte slots.

```
char[4] "OB3D" or "OPRT"
u32     slots       number of 16-byte slots to allocate
records, each a u32 kind then:
  1  u32 ms, u32 script                   timer: run `script` every `ms`
  2  f32 min, f32 max, u32 type, u32 id   level-of-detail band: from min to
                                          max distance, show model `id`
                                          (type 7) or run script `id` (19)
  6  u32 ms, u32 script                   the update: run `script` every
                                          `ms` (30, 32, 96 or 1000)
  8  u32 model                            a fixed model, linked once
  7  u32 words, u32 n, i32 props[n]       the property list; ends the record list
```

Each record becomes one 16-byte slot `{u32 kind, u32 +4, u32 +8, u32
+0xC}` at object `+0xEC + 16 * i`:

| Record | Slot kind | `+4` | `+8` | `+0xC` |
| --- | --- | --- | --- | --- |
| 1 | 1 | script | interval, ms | time it last ran |
| 2 | 4 (model) or 5 (script) | id | min distance | max distance |
| 6 | 6 | script | interval, ms | time it last ran |
| 8 | 8 | model | 0 | `0x7CF08021` (1e37, "no limit") |

- **Kind 6, the update.** Every object in the data starts with one, and
  only slot 0 counts. The frame loop (`FUN_10029856`) runs the object's
  update (`FUN_10028fb2`) once `+0xC + interval` has passed: it runs
  `script` (or the one `SetUpdateScript` set at `+0xF0`) with the object id
  and the time since the last update. 234 objects use 30 ms (every frame),
  213 use 1000 ms (scenery such as trees and buildings), 31 use 32 ms and 5
  use 96 ms. When the camera rides an object, every object is updated with
  it.
- **Kind 1, a timer.** After the update, `FUN_10029059` walks slots n-1 to
  1 and runs a kind 1 slot's script (with the object id) when its interval
  has passed. No object in the data has one.
- **Kinds 4 and 5, levels of detail.** In the same walk, the first band
  (from the last slot down) whose range holds the camera distance links its
  model or runs its script, unless the current band still fits. The
  distance is `(dx + dz - min(dx, dz) / 2) / far plane`.
- **Kind 8, a fixed model.** `AddObject` (`0x100100f0`) links it when the
  object is placed, like a band that always fits; it is never checked
  again. No object in the data has one.

`AddObject` stamps the current time into kinds 1 and 6 and picks the first
level of detail straight away. The browser engine does the same in
`web/src/battlefield/world.js` (`loadBehaviours`, `firstLevelOfDetail`,
`tick`, `levelOfDetail`).

The property list starts at the slot after the last record, so `words` is 4
x the slots left. `GetProperty(obj, n)` is word `n` of it (object `+0xEC +
16 * slot + 4n`); properties not in the file are 0. In 2618, the property
list is `100, 2583, 2585, 2587, 2589, 2591, 2593, 2595, 7, 11`: property 0
is the class or strength, 1-7 are the unit's seven models, and 8 is its
number of animations (scripts pass it to `createAnimationList`).

All 426 OB3D and 57 OPRT resources parse this way. The extractor puts the
property list in `manifest.csv`'s note column.

### Object fields used by animation

| Offset | Field |
| --- | --- |
| `+0x04` | the object's resource id |
| `+0x10` | position y; trigger conditions 8 and 9 write it (a walking bob) |
| `+0x54` | flags; `\|= 8` marks the pose dirty |
| `+0x80` | forward speed, world units per second |
| `+0x98` | linked model (`LinkModel`) |
| `+0x9C` | FRME being played |
| `+0xA0`, `+0xA4` | animation slots (0x60 bytes each), slot count |
| `+0xA8` | current slot, 1-based (0 = none) |
| `+0xAC` | pending slot chosen by a deferred trigger |
| `+0xB0` | level of detail, 0-2 |
| `+0xB4` | frame rate, frames per second |
| `+0xB8` | stride: world units per frame (0 = fixed rate) |
| `+0xBC` | current frame, a float |
| `+0xE4` | slot where the properties start |

## The animation system

### Animation slots

`createAnimationList(obj, n)` allocates `n` slots.
`addAnimation(obj, slot, type, frme0, frme1, frme2, stride, next, reverse,
endScript)` fills slot `slot` (0-based):

| Offset | Field |
| --- | --- |
| `+0x00` | type: a number the scripts choose (1 start walking, 2 walk, 4 stop, 11 idle, ...) |
| `+0x04` | stride / 1000 |
| `+0x08` | `next`: FRME (level 0) of the slot to play when this clip ends; 0 loops, < 0 holds |
| `+0x0C` | `reverse`: FRME of the slot whose frames play backwards while the speed is negative |
| `+0x10` | `endScript`: queued with the object id when the clip ends |
| `+0x14` | trigger count (at most 4) |
| `+0x18` | 4 triggers of `{u32 immediate, u32 condition, u32 target slot (1-based)}` |
| `+0x54` | `frme0, frme1, frme2`: the clip for each level of detail |

Slots are found by their level 0 FRME (`0x1000b05a`) or by type
(`findAnimationType`, 1-based result).

`addTrigger(obj, frme, condition, targetFrme, immediate)` adds a trigger to
the slot of `frme`.

### Installing a slot

`installAnimation(obj, slot)` (`0x1000b338`, 1-based slot):

1. Pick the slot's FRME for the current level of detail. If the speed is
   negative and the slot has a `reverse`, use the reverse slot's FRME instead
   and start on its last frame; otherwise start on frame 0.
2. Set the stride from the slot, clear the pending slot, make it current and
   show the frame.

`installAnimationType(obj, type)` installs the first slot of that type.
`setLOD(obj, lod)` swaps the current clip for the same slot's FRME at
another level of detail, keeping the frame.

### Advancing

`UpdateTimeStep` (`0x10011ec1`, the battlefield's per-tick update) keeps
the milliseconds since the frame last changed in an object property, adds
the tick, and for an object with animation slots calls:

1. `UpdateFrameTerm(obj, ms)` (`0x10017d88`): `rate * ms / 1000` frames are
   due. If the shown frame (the frame rounded half away from zero) would not
   change, return 0. Otherwise add the **whole** number of frames that
   changed, show it, and return `ms`; if it ran off either end of the clip,
   do not show it and return `-ms`.
2. `doAnimationUpdate(obj, result)` (`0x1000b75a`):
   - Check the current slot's triggers in order. The first whose condition
     holds either installs its target now (immediate) and stops here, or
     records it as pending.
   - If the clip ended (`result < 0`): take the pending slot, else the
     slot's `next`. Queue `endScript(obj)`. Install the slot if there is
     one; with `next` 0, wrap the frame into the clip and show it; with
     `next` < 0 do nothing.

When the result is not 0, `UpdateTimeStep` moves the object by the
accumulated time, resets the accumulator, and if the stride is not 0 sets
`rate = speed / stride`. So walking clips advance by distance, which keeps
feet planted. `SetObjectFramerate(obj, n)` sets `rate = n / 100` for clips
with no stride.

With no clip or a zero rate, `UpdateFrameTerm` returns an uninitialised
local. The browser engine returns `-ms` there, which makes a stopped unit
finish its walk clip at once and move on to the stop and idle clips its
triggers queued, as the game appears to.

### Trigger conditions

The table at `0x10037970`. `v = |speed| * 100`; properties 12, 15 and 33 are
set by the unit scripts.

| # | True when |
| --- | --- |
| 1 | property 12 is 0 and `v <= property 33 + 2` (stopped) |
| 2 | speed is not 0 |
| 3 | `v > 0` |
| 4 | `0 < v <= property 15` (walking) |
| 5 | `v > property 15` (running) |
| 6 | speed > 0 |
| 7 | speed < 0 |
| 8 | never; sets the object's height (`+0x10`, position y) to `0.018757 * k` with `k` = frame + 1 moving forwards, 17 - frame backwards, 0 stopped |
| 9 | never; the same with the directions swapped |
| 10 | property 12 and the speed have opposite signs |

A typical walker (the unit with FRMEs 2597-2617): idle (type 11) has
trigger 2 → start walking, immediately. Start walking's `next` is the walk
loop, whose triggers queue running (5), stopping (1) or restarting (10, 3).
The stop clip's `next` is idle, and its end script is 1721.

### Other animation externs

| Extern | Address | Does |
| --- | --- | --- |
| `SetAnimation(obj, frme, stride)` | `0x10016538` | play one FRME directly; `rate = speed / (stride / 1000)` |
| `AnimateFrame(obj, frme, frame)` | `0x100105ec` | set the frame and show it |
| `AnimateModelFrame(model, frme, frame)` | `0x100106bb` | pose a model copy (the briefing's unit preview) |
| `UpdateFrameCycle(obj, ms)` | `0x10017b20` | like `UpdateFrameTerm` but wraps around |
| `GetNumFrames(frme)` | `0x10012431` | the FRME's frame count |
| `getCurrentAnimationType(obj)` | `0x1000b5c7` | the current slot's type, 0 if none |
| `removeAnimations(obj)` | `0x1000ab87` | free the slots |
| `animationSetupProps()` | `0x1000aac0` | nothing |

## Motion

The velocity, steering and movement externs (`web/src/anim/motion.js`).
They act on the battlefield's world object; the struct fields are:

| Offset | Field |
| --- | --- |
| `+0x0C` | position (x, y, z) |
| `+0x18` | velocity, world units per second |
| `+0x24` | position before the last move |
| `+0x30`, `+0x3C`, `+0x48` | `at`, `right`, `up` (rows of the matrix) |
| `+0x54` | flags: `8` dirty, `0x10` velocity kept in the ground plane |
| `+0x60`, `+0x64`, `+0x68` | pitch, yaw and roll rates, degrees per second |
| `+0x6C` | twist rate (a turret), degrees per second |
| `+0x70` | twist still to go, degrees |
| `+0x74` | yaw still to go, degrees (worked off by the spin step) |
| `+0x78` | cosine of the angle to the target when `+0x74` was set |
| `+0x7C` | gravity |
| `+0x80` | forward speed |
| `+0xC0` | maximum acceleration |
| `+0xC4`, `+0xC8`, `+0xCC` | maximum angular acceleration: pitch, yaw, roll |
| `+0xD0`, `+0xD4`, `+0xD8` | maximum angular velocity: pitch, yaw, roll |

`FUN_100050d0(obj, roll, pitch, yaw)` turns about the object's own axes:
pitch about `right`, then yaw about `up`, then roll about `at` (degrees,
RenderWare's right-hand rotation).

### The spin step

`FUN_1001a290(obj, dt)`, used by `UpdateOrient`, `UpdatePosOrient` and
`UpdateTimeStep`: while a yaw target (`+0x74`) is pending, take one step of
the controller below on the yaw rate and subtract it from the target; when
the step passes the target, or the target is under 0.5° with a step of at
most 0.1°, clear both the target and the yaw rate. Then turn by
`rate * dt` on all three axes.

The controller `FUN_1001c460(angle, brake, accel, &rate, dt, maxVel)`
returns the angle to turn this step:

- From rest it turns `accel·dt²` (and sets the rate to `±accel·dt` when the
  angle is more than twice that), or nothing for a tiny angle.
- With `brake` set (the target is ahead: cosine > 0) and the stopping
  distance `(r² + 2·accel·dt·r) / (4·accel)` of the next rate `r` beyond
  the angle, it slows by `2·accel·dt` without reversing.
- Otherwise it speeds up by `accel·dt` towards the angle (`2·accel·dt` when
  turning back), clamped to `±maxVel`.

### Steering

Each steering extern takes a mode: 1 = pitch, 2 = yaw. Yaw mode only sets
the target (`FUN_1001c7df`): `+0x74 = ±acos(at·d)` in the ground plane,
positive when the direction `d` is on the `right` side, and returns 0.
Pitch mode (`FUN_1001c926`) turns at once: when `d` is ahead in x/z, the
angle between the two elevations (positive towards `up`) goes through the
controller with the pitch rate negated (positive pitch looks down) and the
step is returned; when it is behind, the pitch rate is zeroed. The externs
return the step ×100.

| Extern | Address | Does |
| --- | --- | --- |
| `MoveToPursue(obj, target, mode, heightProp, ms)` | `0x100133c2` | steer at the target; with `SetGroundFlag` on, aim `property / 2000` above it |
| `MoveToEvade(obj, target, mode, ms)` | `0x10013575` | steer directly away |
| `MoveToFollow(obj, target, radius, mode)` | `0x10013179` | yaw only: blend the direction to the target with its perpendicular on the target's side, weight `radius / distance` (x+z distance); inside the radius, head out. Behind the target the radius is scaled by `d · target.right` |
| `MoveInCircle(obj, target, radius, mode)` | `0x10013054` | the same, with the perpendicular chosen by the object's own `right`: circles the target |
| `MoveToParallel(obj, target, mode, ms)` | `0x1001328c` | turn to the target's heading (pitch: its `at` with x = 0) |
| `MoveToTrueLead(obj, speed, target, mode, ms)` | `0x1001368c` | steer for the meeting point: bisection on `t` in [0, 10] s of `\|target + vel·t - pos\| - speed·t` (`FUN_1001d51a`); (0, 0, 1) when there is none |
| `MoveToFlock`, `ObjectDeviate` | `0x10013167`, `0x10013fc6` | empty, return 0 |
| `SetTargetAxis(obj, dir, axis, ms)` | `0x10016dd9` | ramp the pitch (1) or yaw (2) rate towards `dir · maxVel` by `accel · dt` (4× when braking, `accel / 100` from rest); dir 0 brakes to 0. Skipped while a yaw target is pending, unless dir ≠ 0 |
| `SetTargetAxisAngle(obj, angle, axis)` | `0x100170de` | axis 2 only: `+0x74 = angle / 100` |
| `SetTargetTwist(obj, dir, ms)` | `0x1001714a` | the same ramp on the twist rate (yaw limits), while no twist angle is pending; returns `rate · dt · 100` |
| `SetTargetTwistAngle(obj, angle, prop)` | `0x10017408` | `+0x70 = (angle - property prop) / 100`; returns it ×100 |
| `StepTwist(obj, ms, twistProp, limitProp)` | `0x100177a4` | one controller step of the pending twist, kept within ±limit when the limit is under 180°; returns the step ×100 (the script adds it to its twist property) |
| `UpdateOrient(obj, ms)` | `0x100180fe` | the spin step |
| `UpdatePos(obj, ms)` | `0x1001817e` | `vel.y += gravity·dt`, `pos += vel·dt` (`FUN_1001a754`) |

### Speed

| Extern | Address | Does |
| --- | --- | --- |
| `SetVelocityForward(obj, v)` | `0x10017516` | `speed = v / 100`, `vel = at · speed`, clear flag `0x10`, `rate = speed / stride` |
| `SetVelocityXZ(obj, v)` | `0x100175dc` | the same along `at` flattened and normalised; sets flag `0x10` |
| `GetVelocityForward(obj)` | `0x1001284e` | `speed · 100` |
| `SetMaxAccel(obj, a)` | `0x1001671e` | `+0xC0 = a / 100` |
| `SetMaxAngularAccel(obj, roll, pitch, yaw)` | `0x10016835` | the three limits / 100 |
| `SetMaxAngularVelocity(obj, roll, pitch, yaw)` | `0x1001678e` | the same for the rates |
| `SetObjectMotion(obj, stride)` | `0x10016b20` | `+0xB8 = stride / 1000` |
| `ApproachTargetSpeed(obj, ms)` | `0x1000ba71` | see below |

`ApproachTargetSpeed` moves the speed towards property 12 by at most
`maxAccel · ms / 1000`. An animated object that is moving never goes below
property 33 in size (so walkers don't creep). Property 34 gets the new speed
×100. Objects of class 181 or 182 (property 0: flyers) keep their velocity
along `at`; the rest move in the ground plane with y pinned to 0. The
frame rate is resynced. It returns minus a cost the scripts subtract from
an energy property: `property 95 · |target| · 7 / (property 35 · 10)` while
changing speed, `· 5` at the target speed.

### Orientation and position

| Extern | Address | Does |
| --- | --- | --- |
| `PointAt(obj, target, heightProp)` | `0x100144af` | `at` towards the target (plus `property / 2000` in y with the ground flag), `right = (at.z, 0, -at.x)`, `up = at × right`. The original leaves `right` and `up` unnormalised; the browser engine normalises them |
| `PointAtXZ(obj, target)` | `0x100146b7` | the same in the ground plane |
| `SetObjectDirection(obj, x, y, z)` | `0x100168dc` | `at = (x, y, z) / 100`, `right = (0, 1, 0) × at`, `up = at × right` |
| `ObjectDistance(obj, other)` | `0x10013fd8` | distance ×100 |
| `ObjectMoveForwardUp(obj, forward, up)` | `0x1001849d` | `pos += normalise(at) · forward / 100 + (0, up / 100, 0)`, and `last = pos` |
| `DotProduct(obj, clump, target, tclump)` | `0x10011b21` | `normalise(at) · normalise(target - pos)` ×10000; a clump number uses that clump's direction or origin |
| `DotProduct2D(...)` | `0x10011cea` | the same in the ground plane |
| `SphericalToRectangular(r, a, b, which)` | `0x1001766d` | `r·sin b·cos a` (0), `r·cos b` (1), `r·sin b·sin a` (2); angles in tenths of a degree |
| `Srand(seed)` | `0x10017766` | seeds the C runtime's `rand` and RTLIB32's generator |

## Tasks

A unit's AI keeps a prioritised task list (`web/src/anim/tasks.js`,
`0x1001ac50`-`0x1001c37e`). `setTaskProps(listProp, currentProp)` names two
object properties: the first holds a copy of a type 11 table (script 412
copies table 411: 10 rows of 9 ints), the second the current row.

| Column | Field |
| --- | --- |
| 0 | task: the script that runs it |
| 1 | active |
| 2, 4, 5, 6 | parameters (`a`, `b`, `c`, `d`) |
| 3 | target (an object id) |
| 7 | next row, -1 = none |
| 8 | priority |

| Extern | Does |
| --- | --- |
| `insertTask(obj, task, priority, target, b, c, d, a, next)` | fill the first inactive row; returns it or -1 |
| `setCurrentTask(...)` | overwrite the current row |
| `setNextTask(...)` | insert, and chain it as the current row's `next` |
| `doNextTask(obj)` | move to the current row's `next` (when active and set); returns the old row's target |
| `TaskSetHighestIndex(obj)` | make the active row with the highest priority current (ties keep the current one); returns the old row's target if it changed, else 0 |
| `completeTask(obj, row)` | mark inactive |
| `clearTask(obj, row)`, `clearTaskList(obj)` | zero rows (next = -1) |
| `getTaskField(obj, row, col)`, `setTaskField(obj, row, col, v)` | access a cell |
| `changeTaskPriority(obj, row, delta)` | add to the priority, not below 0 |
| `existsGoal(obj, task, target)` | the row with this task and target, active or not, or -1 |
| `activateGoal(obj, row, p)` | activate; priority -4 lowest, -3 highest, -2 highest + 1, -1 leave it, other values keep the row's own |
| `equalizeGoalPriorities(obj, p)` | every row gets `p` (-3 highest, -4 lowest) |
| `getHighestPriority(obj)`, `getLowestPriority(obj)` | over active rows |

## Lists

`ListCreate(n)` (`0x10012c08`) makes an array of `n` zeros and returns a
1-based id; ids are reused after `ListDestroy`. `ListGetElem`, `ListSetElem`
and `ListLength` do what they say. `ListElemPosition(list, v)` is the
0-based index of `v`, or -1 (also for `v` = 0). `ListAdd(list, v, limit)`
puts `v` in the first empty slot among the first `limit` (0 = all) and
returns 1; it returns 0 if it finds `v` before an empty slot, or nothing is
free.
`ListRemove(list, v, limit)` ignores `v` and clears the first non-empty slot
(a bug in the original; no script calls it). `ListIterate(list, script)`
queues `script(element)` for every slot.

## Files

The `File*` externs wrap the Win32 `mmio` API. Scripts open `TRIVIA.IDX`,
`TRIVIA.DAT` and `LABTEXT.DAT` to read, and `GKEY<n>.MAP` and
`SGNOME<n>.SAV` (names built with statement `0xC0`) to read and write.

`FileOpen(name string, flags)`: 1 read, 2 write, 3 both; `0x10` create, but
fail if it exists; `0x20` or `0x100` create or truncate; `0x40` fail unless
it exists; `0x200` only test existence (returns 1 or 0). Returns a handle or 0.
`FileGetC/S/L(h, &array, n)` read `n` items of 1, 2 or 4 bytes into
consecutive variables and return the count; `FilePutC/S/L` write them.
`FileRead(h, string, n)` and `FileWrite(h, string, n)` move up to 255 bytes
between the file and a string variable. `FileSeek(h, offset, origin)` uses
`SEEK_SET`/`CUR`/`END` = 0/1/2. The browser engine loads these files at
start and keeps written ones in `localStorage`.

A save (script 6291) is little-endian 32-bit words: the next campaign
mission (G2119), then for each row of table 6984 whose key is under 30, the
key and column 0 of that row's table. Loading (6292) reads 23 rows and
gives up if a key does not match. The slot's name is not in the file but
in the INI, `[GnomeGames] savegame_<n>`.

## Hotspots

Collision volumes, mostly for buildings. `AllocHotspots(n)` (`0x1002223c`)
makes `n` zeroed records of 0x44 bytes; `AddHotSpot` fills the next one;
`ClearAllHotspots` empties the table; `DestroyAllHotspots` frees it.
Accessors take a 1-based hotspot number.

| Offset | Field |
| --- | --- |
| `+0x00` | model resource whose first clump is the footprint; the radius for type `0x10` |
| `+0x04` | x, y, z (script units / 100) |
| `+0x10` | height |
| `+0x14` | flags |
| `+0x18` | type; `0x10` = round, 4 = has a direction vector |
| `+0x1C` | four script values |
| `+0x2C` | footprint vertices (x, y, z), offset by the position |
| `+0x30` | one flag word per footprint edge: 1/2/4/8 for ends that sit on the 12-unit grid in x or z, `0x10` for an edge along a grid line |
| `+0x34` | footprint vertex count |
| `+0x38` | direction (type 4), normalised |

`AddHotSpot(model, x, y, z, height, flags, type, dx, dy, dz, a, b, c, d,
poseObj)` poses the footprint model like `poseObj`'s model when that is not
0. The browser engine keeps the table and accessors in
`web/src/anim/hotspots.js`; footprints and the collision tests are in
`web/src/battlefield/collision.js` (see "Collisions" in
[battlefield.md](../battlefield.md)).

## glTF export

`tools/gnome_extract.py` writes `gltf/<index>.gltf` next to each OBJ: one
node per clump with its joint transform (in the rest pose), meshes per clump
and material, the textures as `../png/texture/*.png`, and one animation per
FRME the model owns, named `frme<id>`. Clips get a 15 fps timeline with
linear interpolation; the game itself advances frames by distance or by a
script-set rate and shows whole frames. Coordinates are left as RenderWare's.
All 801 files pass the Khronos glTF validator.
