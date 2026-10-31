# 3D animation, objects, lists, files and hotspots

How G-Nome animates its 3D models, and the other `RENDER.R32` data the
mission scripts use. Everything here was read from the Ghidra decompile of
`RENDER.R32` (addresses are in the 0x10000000 image) and checked against the
game's data and scripts.

Code:

- `tools/gnome3d.py`: Python decoders for models, FRME and OB3D/OPRT, plus
  OBJ and glTF export (used by `tools/gnome_extract.py`).
- `web/src/anim/`: the browser engine's decoders (`formats.js`) and the
  externs: animation (`animation.js`), lists (`lists.js`), files
  (`files.js`) and hotspots (`hotspots.js`).
- `web/tests/anim-check.mjs`: decodes every FRME and object and runs a real
  unit's animation set through idle, walk and stop.

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
  1  i32 a, i32 b
  2  f32 min, f32 max, u32 type, u32 id   level-of-detail band: from min to
                                          max distance, show model `id`
                                          (type 7) or run script `id` (19)
  6  i32 a, u32 script                    a is 30, 32, 96 or 1000
  8  i32 a
  7  u32 words, u32 n, i32 props[n]       the property list; ends the record list
```

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
| `+0x10` | float written by trigger conditions 8 and 9 (unknown, maybe a bob height) |
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
| 8 | never; sets object `+0x10` to `0.018757 * k` with `k` = frame + 1 moving forwards, 17 - frame backwards, 0 stopped |
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
`web/src/anim/hotspots.js`; computing footprints and the collision tests
(`CollideHotSpot`, `DeflectHotspot`, `FastmovingHotspotCollide`,
`CheckPositionCollision`, `ObjectPositionCollision`) are left to the
battlefield's motion code.

## glTF export

`tools/gnome_extract.py` writes `gltf/<index>.gltf` next to each OBJ: one
node per clump with its joint transform (in the rest pose), meshes per clump
and material, the textures as `../png/texture/*.png`, and one animation per
FRME the model owns, named `frme<id>`. Clips get a 15 fps timeline with
linear interpolation; the game itself advances frames by distance or by a
script-set rate and shows whole frames. Coordinates are left as RenderWare's.
All 801 files pass the Khronos glTF validator.
