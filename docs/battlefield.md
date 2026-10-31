# The battlefield: terrain, missions, camera and frame loop

How G-Nome builds and runs a mission's 3D world, from the mission scripts in
`G-NOME.BIN` and from `RENDER.R32` (decompiled with REA 6.8.0 and Ghidra
12.1.4; addresses are virtual addresses, image base `0x10000000`). The
browser engine's version lives in [`web/src/battlefield/`](../web/src/battlefield).

To reproduce the decompile:

```bash
bash scripts/install-ghidra.sh
GHIDRA_INSTALL_DIR=/opt/ghidra npx -y rea-agents@6.8.0 decompile-all \
  game/g-nome/G-NOME/RENDER.R32 --output re-output/render --provider ghidra
```

`RENDER.R32` loads `RWL20.DLL` (RenderWare 2.0) with `GetProcAddress` at
`0x10025193`, so its calls into RenderWare go through 526 function pointers.
Mapping those pointers to names (`DAT_100417cc` is `RwSetCameraLookAt` and so
on) makes the decompile readable.

## Units and conventions

| What | Script value | Inside RENDER.R32 |
| --- | --- | --- |
| Position | integer | divided by 100.0 (`Init3D` stores 100.0f at state `+0xb4`) |
| Angle | hundredths of a degree | degrees, `/ 100.0` |
| Time | milliseconds | seconds, `/ 1000.0` |
| Colour | 0-255 | `/ 255.0` |

RenderWare's world is right-handed with Y up. An unrotated camera looks along
+Z; its "look right" vector is -X, so world +X is drawn on the left. A yaw of
+90 degrees (9000) turns +Z towards +X. Script screen coordinates are
relative to the centre of the 640x480 view.

The first argument of every exported function is the runtime context; the
script's arguments start at the second, so `AttachCamera(ctx, id, clump, dx,
dy, dz)` is `render.AttachCamera(id, clump, dx, dy, dz)` in a script.

## Terrain

G-Nome has no height map. `AddGround` and `RemoveGround` exist in
`RENDER.R32` but no script calls them, `UpdateGroundHeight` only follows a
height function when a ground was added (state `+0x88`), and so the ground
is the plane y = 0.

The visible ground is a grid of flat tiles. Each environment has four tile
objects (type 10 `OPRT` resources), placed in a 2x2 repeating pattern on a
600-unit grid by one script per environment:

| Environment | Tiles (OPRT) | Grid script | Textures |
| --- | --- | --- | --- |
| 0 desert | 2414-2417 | 2418 | `dgrd*.BMP` |
| 1 ice | 2435-2438 | 2439 | `igrd*.BMP` |
| 2 green | 2456-2459 | 2460 | `ggrd*.BMP` |
| 3 dark (moon) | 2477-2480 | 2481 | `mgrd*.BMP` |

An `OPRT` ends with the ids of its model parts, for example 2414 ends with
`7, 6, 3, 260, 2398, 2400`: MPRT 2398 and 2400, each a 6x6 textured quad at
y = 0 (scale 100 gives the 600-unit cell). The grid script runs
`script_2039(1, tile, x, z, 0, 0, 260)` for every cell between the mission's
corners and gives each tile `SetLevel(-100)` so it draws first.

`script_2515(x1, x0, z1, z0)` sets the corners (globals 1833-1836); every
mission's start script calls it first, for example mission 1 (script 8744)
uses `script_2515(10200, -9150, 3000, -10200)`.

## Environments: table 2512

`script_2514(row)` sets up the sky and the ground. Table 2512 has 16 rows of
8 columns:

| Col | Meaning |
| --- | --- |
| 0 | backdrop bitmap (1328x383 panorama), `SetCameraBackdrop(bitmap, 1)` |
| 1 | a second resource next to it (not used by 2514) |
| 2 | fog depth |
| 3-5 | fog colour |
| 6 | environment 0-3: picks the background colour and the ground grid script |
| 7 | script run by `script_2513` (`script_23(TableGet(2512, row, 7))`) |

Background colours: desert 222,198,148; ice 248,255,249; green 43,105,17;
dark 60,66,56. The fog (`SetFogDepthColor` -> `RwSetSceneDepthCueDistance`)
is 2000 for desert and ice, 3000 for green and 5 for the moon. With the far
clip at 3000-7000 (`script_2529`, by detail level), the depth reads as the
distance before the far plane over which objects fade, so the moon has none.
That reading is inferred from the values, not from RenderWare's source.

## Missions

Campaign missions are rows of table 6984 (34 x 6): column 0 is the mission
number, 1 a per-mission state table, 2 and 5 briefing resources, 3 the start
script and 4 a briefing list. The briefing's start button runs script 8317,
which finds the row whose column 0 equals global 2119 (2118 for the
training branch, global 982) and calls `script_1()` and then the start script.

A start script (8744 for mission 1) calls `script_2515` for the corners, sets
up the environment, and then `script_2523(env, table, ...)` places the
mission's objects from a type 11 table. Each row of that table:

| Col | Meaning |
| --- | --- |
| 0 | catalog row in table 5843 |
| 1 | filled in at run time with the object's id |
| 2, 3 | x, z |
| 4 | 1 = put at height global 1846 |
| 5 | yaw (hundredths of a degree) |
| 6 | 1 = skip |

Table 5843 (197 x 5) is the object catalog: column 0 the resource to copy
(type 9 `OB3D`), 1 an init script, 2 the kind (1 scenery, 2 building, 3
unit; picks `script_2040`, `2041` or `2043`), 3 a class code and 4 a type
index. Classes 250 are road pieces (placed on a 1200 grid with 90 degree
yaws; `SetModelTexture` picks the environment's road texture 2482-2485),
251 gets `SetLevel(-50)` and 570 `SetLevel(-25)`.

`script_2040` and friends do the placement:

```
obj = CopyResource(res)
SetProperty(obj, 0, class)
AddObject(obj, 0, x, height, z)
SetGravity(obj, 0)
ObjectYaw(obj, yaw)
UpdatePosOrient(obj, 1)
```

The mission's starting camera comes from `script_2528`:
`SetCamera(x, 0, z, 0, 0, 100)`, then `AttachCamera` to the player's unit
(global 973).

## Objects in the world

`AllocObjects(n)` (`0x10010762`) allocates an array of n object pointers
(`DAT_10040264`); `AddObject` (`0x100100f0`) puts an object in it. The
fields the world code uses:

| Offset | Meaning |
| --- | --- |
| `+0x04` | resource id |
| `+0x0c` | position |
| `+0x18` | velocity |
| `+0x24` | position before the last move (`RevertPosition` restores x and z) |
| `+0x30`, `+0x3c`, `+0x48` | at, right and up vectors (matrix rows 2, 0, 1) |
| `+0x58` | radius |
| `+0x60`, `+0x64`, `+0x68` | pitch, yaw and roll speed, degrees per second |
| `+0x7c` | gravity, added to velocity y per second |
| `+0x80` | forward speed (`UpdateTimeStep` sets velocity = at x speed) |
| `+0x84` | ground height under the object |
| `+0x88` | level (`SetLevel`), the first draw-order key |
| `+0x8c` | squared distance to the camera, the second key |
| `+0x98` | model (clumps) |
| `+0xe4`, `+0xec` | behaviour count and 16-byte behaviour records (timers, LOD) |
| `+0xf0` | update script (`SetUpdateScript`) |
| `+0xf8` | time of the last update |

Rotations (`FUN_100050d0`) turn the three vectors about the object's own
right (pitch), up (yaw) and at (roll) axes, in that order and about the axes
as they were before the call. The `...Absolute` externs (`FUN_1000533a`) do
the same about the world X, Y and Z axes. `IncrementObjectYaw` adds to the
yaw speed rather than turning.

`UpdatePosOrient(id, ms)` moves by velocity (gravity first) and spins by the
angular speeds. `UpdateGroundCheck(id)` is 1 while `radius + ground - y <= 0`.

## Frame loop

`FUN_10029856` runs once per frame while the 3D state (`DAT_1003cf40`) is
not 0. States: 1 run (set by `Init3D` and `Resume3D`), 2-3 inside a frame, 4
paused (`Pause3D`), 5 full redraw (`FullRedraw`), 6 suspended, -1 shut down.

1. If an object carries the camera, run its update first.
2. For every other object whose behaviour 0 is an update (type 6) and whose
   interval has passed, run its update script. `FUN_10028fb2` passes
   `(id, ms)` with ms = time since its last update, at most 250.
3. Draw (`FUN_10006446`): insertion-sort the objects by level, then by
   distance, far first, and render each clump in that order. Level -100 is
   the ground, so it is always painted first.

The browser engine keeps the order but runs step 1-2 on a fixed 30 Hz tick
(each update gets 33 or 34 ms) and draws at the display's rate, blending each
object's position and orientation between the last two ticks.

## Camera

| Extern | Address | What it does |
| --- | --- | --- |
| `SetCamera(x, y, z, ax, ay, az)` | `0x10009a8e` | camera at (x, y, z), looking along (ax, ay, az); up = right x at |
| `AttachCamera(id, clump, dx, dy, dz)` | `0x1000748b` | ride on clump `clump` of object `id`, offset in the clump's frame |
| `SetCameraPitch(a)`, `SetCameraYaw(a)` | `0x10009f15`, `0x10009fed` | extra tilt and pan, applied every frame after the clump matrix (`FUN_10006198`: pan, then tilt) |
| `SetCameraClipping(near, far)` | `0x10009e99` | near and far planes; the scripts use 10 and 3000, 5000 or 7000 by detail level |
| `SetCameraViewwindow(w, h)` | `0x10009f73` | half extents of the view at distance 1, `/ 100`; `Init3D` sets 0.61 x 0.457 |
| `ViewportCrop(l, t, r, b)` | `0x1000a8c2` | margins around the 3D view |
| `SetBackgroundColor(r, g, b)` | `0x10009a20` | clear colour |
| `SetFogDepthColor(d, r, g, b)` | `0x1000a108` | depth cue distance and colour; d <= 0 turns it off |
| `SetCameraBackdrop(bitmap, 1)` | `0x10009c68` | panorama behind the scene |
| `ScreenToXZ(x, y, which)` | `0x1001643d` | intersects the pixel's ray with y = 0; returns x (which = 0) or z |
| `XZToScreen(id, &x, &y, clump, slot)` | `0x1000946e` | screen position of an object; returns -1 or 1 when it is off the left or right edge |

The backdrop scrolls with the camera (`FUN_10005bd1`): with `a` the angle of
the horizontal look direction from +Z (0 to 2 pi), the image is offset by
`-2 * width * a / 2 pi`, so the 1328-pixel panorama covers half a turn and
repeats. Its bottom edge is the horizon, at `at.y * 2.25 * h/2 + h/2`.

## Controls

`RENDER.R32` subclasses the game window (`0x1000dc7a`) and turns presses
into action scripts; `CheckActionState` (`0x1000c631`) polls held actions.

| Table | Contents |
| --- | --- |
| 2544 | actions (98 x 17): col 0 the script run on a press (with the action number as its argument), col 1 flag bits matched against the caller's mask, cols 2-5 whether the action is allowed in control mode 0-3 (scripts pass `mode + 2`, global 1854) |
| 2546 | held bindings: rows `{action, device, key}`, ended by action -1 |
| 2545, 2547 | press bindings, same layout (`MapActionKeys(2544, 2545, 2547, column, mask)`) |
| 2550-2553 | the key-map presets; `script_2554` splits the chosen one into 2545 and 2546 |

OPTIONS > INTERFACE edits the key map (table 6323, rows of `{action, ?,
device, key} x 3`, one per Mapping column). Clicking a cell (scripts
6365/6369/6370 -> 6350) finds the row from the mouse position in globals
5005/5006 (RTLIB keeps the last mouse position there, relative to the
screen centre), shows the prompt sprite 6400 (sprite message 2: draw cels
0 and 1 together) and calls `render.CaptureKey(6366)`. RENDER.R32's window
procedure then sends the next key press to that script as `(device, key)`
(device 1 with Ctrl held, 2 with Shift, else 0; 4 for a mouse button while
`MouseOnOff(1)`), and a non-zero return ends the capture. Script 6344 names
the key. Use/Save (6341) copies the map to the current one (G1856), writes
`GKEY<G2100>.MAP` (script 2556) and splits it into 2545 and 2546
(`script_2554`); the boot reads the file back. The browser keeps written
files in localStorage (`web/src/anim/files.js`). While capturing, mouse
moves reach the script as `(0, 0)`; after Clear or Cancel it returns 1 to
the next one, which ends the capture.

The port outlines conflicting cells in red (`web/src/key-conflicts.js`):
the same input (devices 0 and 5 count as one; joysticks are left out) on two
actions that share a control mode in table 2544 columns 2-5. The default map
has none: Space is on actions 9 and 42, but no mode allows action 42.

Devices: 0 the key alone, 1 Ctrl+key, 2 Shift+key, 5 the key without
modifiers, 4 a mouse button (1 left, 2 right, 3 middle; only while
`MouseOnOff(1)`), 3 and 6 joystick axes and buttons. `CheckActionState`
returns 1 when a binding is held, 0 when the action is bound but not held,
and -1 when it is not bound or not allowed in this mode. In the default map
actions 0 and 1 (turn) are the left and right arrows, 7 and 8 the up and
down arrows; Space presses action 9.

In the default map the throttle is action 2 and 3: numpad `+` and `-`, or
Ctrl+Up and Ctrl+Down. Up and Down (actions 7 and 8) tilt the gun, Left and
Right (0 and 1) turn, `,` and `.` (5 and 6) twist the torso. The browser
engine maps numpad and punctuation keys by `KeyboardEvent.code`.

## Level of detail when an object is added

`AddObject` (`0x100100f0`) chooses the level of detail at once, not on the
next frame: every behaviour record of kind 4 or 5 whose range holds the
object's x/z distance to the camera over the far plane is applied, from the
last record to the first. Kind 5 runs its script with the object id, so a
unit's LOD script (2145 and friends: copy the model into property 79, link
it) has run before the rest of its setup. Later per-frame changes
(`FUN_10029059`) only run for objects with an update record.
`UpdateLOD(id)` (`0x10029743`) forgets the current choice and picks again.
`ObjectSetScene(id, 0)` puts the model in the RenderWare scene, any other
value takes it out (object flag `0x80`; the draw loop skips such objects).

## Collisions

The browser engine's version is
[`web/src/battlefield/collision.js`](../web/src/battlefield/collision.js),
exposed to other modules as `engine.collision`.

A unit's update script (1723 -> 1728) moves it with `UpdateTimeStep`, then:

1. `UpdateCollideCheck(id, list, extra, ignore)` (`0x100182d0`) returns the
   nearest object in the list (global 1814) whose octagonal x/z distance
   (`dx + dz - min(dx, dz) / 2`, `FUN_1001ab5c`) is under both radii plus
   `extra / 100`. Scripts 2229 (class < 100, people) and 2239 (100-199,
   vehicles) then use `ClumpToClump` and `DotProduct2D` to decide whether
   it is a hatch to climb into, a bump (`RevertPosition`, back off) or a
   unit to run over.
2. Otherwise script 437 calls `Process_Sector_Collisions(id, &hotspot,
   &object, fast, &G1861[0])` (`0x100289d0`). It skips movers of class
   200-270, runs `G1861[6]` (script 430) to get the list for the mover's
   map cell (table 427: 26 x 26 cells of 1200 units, 25 object ids each, -1
   ends a list, -2 is a free slot), and tests the hotspots in each listed
   object's property 16 with `ObjectPositionCollision` (or
   `FastmovingHotspotCollide` when `fast`, for projectiles). The first hit
   is returned with its hotspot and object; class 500 objects are triggers:
   their property 2 script runs with `(mover, object, hotspot)` and they are
   never returned. Objects below class 240 with property 133 set are
   skipped.

Calls from inside a plugin to a script (`RtRunMsg` with a type 1 message)
run at once and return the script's value; the browser engine's
`vm.callValue` does the same with the frame below the caller's locals.

### Hotspots

`AddHotSpot` (`0x1002232a`) stores four callback values (`+0x1C`..`+0x28`).
`GetCallbackParm(n, k)` / `SetCallbackParm(n, k, v)` read and write values
1-3, `SetCallbackID` value 0. Scripts 438 and 439 put the owning object in
value 1 and a kind in value 2; script 2231 switches on the kind (16 and 7:
solid, `DeflectHotspot`; 3, 8, 11, 15: other handlers).

Flags: 1 enabled, 2 solid with the mover's radius, 4 run the callback in
`CollideHotSpot`. `ObjectPositionCollision(n, id)` (`0x1002338f`) returns
1 when the object's position is inside and 2 when only its radius reaches
in (flag 2), after a height test (0 <= y <= height, unless height is 0):

| Type | Shape |
| --- | --- |
| `0x10` | circle, radius in the model field (script units) |
| 8 | footprint the object must stay inside (1 when outside) |
| other | footprint polygon; with flag 2 the point `radius` ahead along `at` (behind when reversing) counts as 2 |

The footprint is the vertex list of the hotspot model's root clump
(`RwGetClumpVertex`, in order), turned by the pose object's root clump
matrix without its translation and moved to the hotspot. Vertices whose x
or z lies on the 12-unit grid (within 0.04) push the edges that meet there
out by 0.2 so neighbouring footprints overlap, and an edge along a grid line
is flagged `0x10`; deflection ignores flagged edges. The inside test
(`FUN_1001d780`) is the even-odd ray test in x/z.

### Deflection

`DeflectObject(id, other, limit, both)` (`0x10023dac`) and round
`DeflectHotspot`s compare the mover against a circle around `other` of its
radius (plus the mover's when `both`). Outside it: 1. Inside: with `d` the
unit vector from the circle's centre to the mover and `f = -(at . d) x
10000`, a mover heading away (forward with `f < 0`, reversing with `f > 0`)
gets 1; `|f| < limit` pushes it out to the circle and returns 1; anything
more head-on returns 0 and the script undoes the move.

A footprint `DeflectHotspot` (`FUN_1001e608`) finds the edge the step from
the last position crossed (`FUN_10018a72`, with 0.01 tolerance). With `e`
the unit vector along the edge and `n = (e.z, -e.x)`, the sine `s = n .
step` refuses the move when `s <= -limit / 10000`, accepts it when `s > 0`
and otherwise slides the mover along the edge by the step's projection, plus
1/100 along `n`. Without a crossing a mover found inside is put back on the
nearest edge along its step (extended 8 units) or across its right vector
(`FUN_1001e95e`).

### Clumps

`ClumpToClump(a, b, tolerance)` (`0x100107cc`) walks the tagged clumps of
both models (the root when none are tagged) and returns the first clump of
`b` within `tolerance / 100` of a clump origin of `a` whose world bounding
boxes overlap on every axis; -1 if none. `CollisionClump(mover, target)`
does the same for the mover's last step against the target's clump boxes
(projectile hits).

### Radius

Object `+0x58` is the radius `SetModelDimensions` (half the larger of the
posed model's x and z size), `SetRadius` and `GetRadius` share. In mission 1
the player starts on foot as a pilot with radius 0.039 (3.9 script units);
cliffs and buildings use footprints instead.
