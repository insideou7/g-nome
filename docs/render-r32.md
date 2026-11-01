# RENDER.R32: every export and its browser version

`RENDER.R32` is G-NOME's main plugin: the RenderWare 2.0 battlefield, the
DirectSound wave player, input (action keys, mouse, joystick, Pause),
files, lists, tasks, animation, hotspots, combat and the radar. This page
lists all 260 exports, what each does, how often the scripts call it, and
where `web/` implements it. Details live in the topic docs linked from each
section. `node web/tests/render-coverage-check.mjs` keeps this page and the
code in step (see [Checking it](#checking-it)).

Counts come from `tools/r32script.py --all` over `G-NOME.BIN` and the
decompile in `re-output/render` (see [render3d.md](render3d.md#regenerating-the-decompile)).

## Summary

| | Exports |
| --- | --- |
| In RENDER.R32's export table | 260 |
| Named in G-NOME.BIN's extern table (plugin 0) | 245 |
| Called by at least one script | 168 |
| Implemented in `web/` | 229 |
| Called by scripts but not implemented | 0 |
| Not implemented, never called | 31 (listed [below](#not-implemented)) |

Every extern a script calls has a browser version. The ones that do
nothing in the browser do nothing on purpose: see [Deliberate
no-ops](#deliberate-no-ops).

## Internals

The decompile has 692 functions. 431 are reached from the exports, the DLL
entry point and RtLibInit's hooks. 219 more are import thunks and the MSVC
C runtime. That leaves 42:

- `0x1000bee1`-`0x1000c3b3` (10 functions): the animation trigger
  conditions, called through the table at `0x10037974`
  ([animation.md](formats/animation.md#trigger-conditions)).
- `0x100025d0` -> `0x100025e5`: a static initialiser (C runtime `__xc`
  table at `0x10037004`) that fills the RWX model-op table
  ([render3d.md](render3d.md#material-and-clump-settings)).
- 30 functions nothing reachable references (no call from live code, no
  pointer anywhere in the image): dead code left in this build. Among them a `WM_PAINT` handler
  (`0x10001555`), 2D ground-grid helpers next to AddGround
  (`0x10018600`-`0x1001a5d4`, `0x1001cdc1`-`0x1001dae3`), a one-model
  render (`0x10006c76`), the default-path logger (`0x1000fbf5`) and hotspot
  flag setters (`0x10024939`, `0x100249a4`).

`RtLibInit(rt, info)` (`0x10001a86`) loads `RWL20.DLL` (`0x10025193`),
registers the model load/copy/free procs with RTLIB32 (`0x1000486c`,
`0x100048a7`, `0x10004a13`), subclasses the game window with
`0x1000dc7a` and fills four hooks of the plugin info block
([rtlib32-engine.md](rtlib32-engine.md)):

| Hook | Function | What it does | Browser |
| --- | --- | --- | --- |
| `+0x0C` frame | `0x10029856` | the battlefield frame: fixed ticks, update scripts, render | `RenderPlugin.service` -> `World.advance` |
| `+0x10` audio | `0x10021003` | every 20 ms: refill streamed voices; a voice that has played to its end posts its done script | `Waves.service` (`web/src/waves.js`) |
| `+0x14` activate | `0x10001750` | window to the background: battlefield state 6 (suspended) unless SetBackProcess(1); back: old state | `World.activate`, from `visibilitychange` in `main.js` |
| `+0x20` palette | `0x1000167c` | new palette: rebuild the RenderWare palette | palettes are read per world (`battlefield.md`) |

The window procedure `0x1000dc7a` handles, before RTLIB32 sees them: the
Pause key (runs the SetPauseScript script), a pending CaptureKey (hands
the key, with Shift/Ctrl/mouse/joystick as device 0-6, to the script),
mouse buttons as keys while MouseOnOff(1), joystick buttons, and the
action-key tables of MapActionKeys. Browser: `web/src/input.js` and
`web/src/battlefield/controls.js`; joysticks are gamepads
(`web/src/battlefield/joystick.js`, see "Joysticks" in `battlefield.md`).

`RtLibFree` (`0x10001ba2`) undoes the window subclass, pauses audio,
unloads every model and object and closes RenderWare. The browser has
nothing to free.

## Gaps fixed by this audit

- **Sound "done" scripts.** DSPlayWave's 5th argument is a script posted
  with `(id, 0)` when a sound that does not loop has played to its end. It
  was ignored, so the campaign briefing (script 7274) stopped after its
  first spoken line and chained mission messages (2365/2366) never went on.
- **Five voices.** The original has five DirectSound buffers. A new sound
  takes a free one, else steals the voice of lowest priority (6th argument)
  if that is not above its own; otherwise it is not played.
- **Volume and pan in decibels.** Volume is `SetVolume(v - 10000)`, in
  hundredths of a dB: ObjectPlayWave's 6500 for a far explosion is -35 dB,
  not 65 %. Pan attenuates the other side by `|pan| / 100` dB.
- **DSPauseAudio.** 1 stops every voice and keeps its place, 0 plays them
  on. The in-mission menu (1887), Pause (2262, 8395) and quitting (1953) use
  it; sounds kept playing under those screens before.
- **Pause key.** SetPauseScript's script runs when Pause is pressed: 2262
  pauses and resumes a mission, 8395 the menus. It did nothing before.
- **Background suspend.** Hiding the page suspends the battlefield unless
  the scripts asked for SetBackProcess(1).
- **Joysticks.** EnableJoystick, CheckActionState's devices 3 and 6,
  RangeJoystickAxis and the button/hat poll (`0x1000c460`) read the first
  two gamepads through the Gamepad API (`battlefield/joystick.js`).

Tested by `node web/tests/waves-check.mjs`.

## Still open

- **Streaming detail.** The original streams ADPCM sounds through a 4 KB
  ring buffer; the browser decodes them whole. Same sound, not the same
  timing to the millisecond.
- **SetObjPerspective / SetClumpHints / ObjectSortFlag** change RenderWare
  rendering modes (perspective-correct texturing, clump hints, sort order)
  that have no visible counterpart in the browser renderers. They are kept
  as state where something reads it.

## Deliberate no-ops

| Extern | Why nothing to do |
| --- | --- |
| `DSInitWavePlay` | WebAudio starts on the first click |
| `MakeSpriteExtern`, `MakeSpriteDraw` | RTLIB32 left these sprites for RENDER.R32 to draw over the 3D frame; the browser composes every sprite over the 3D view anyway |
| `DamageRect` | dirty rectangles; the browser redraws the whole view |
| `MoveToFlock`, `ObjectDeviate`, `animationSetupProps` | empty in RENDER.R32 (return 0) |
| `AddStars` | empty in this build |
| `SetObjPerspective` | perspective-correct texturing is always on |

## The exports

Columns: **Calls** = call sites in G-NOME.BIN's scripts ("—" = not even in
its extern table). **Web** = where the browser version is. Arguments are as
the scripts pass them (the original also gets RTLIB32's context first).
Angles are hundredths of a degree and distances thousandths unless noted.

### Setup, state and frame

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `Init3D(x, y, w, h, redrawOnMove, ?)` | `0x100077f6` | 1 | `battlefield/externs.js` | create the 3D view, camera and scene |
| `AllocObjects(n)` | `0x10010762` | 1 | `battlefield/externs.js` | size of the object table |
| `FreeAllObjects(script)` | `0x100121fc` | 1 | `battlefield/externs.js` | run script(id) for every object, then empty the scene |
| `Pause3D(hide)` | `0x100296b9` | 12 | `battlefield/externs.js` | stop the clock; hide also takes the view off the screen |
| `Resume3D()` | `0x100297b0` | 5 | `battlefield/externs.js` | run again; the view becomes the sprites' background |
| `FullRedraw()` | `0x100297fb` | 4 | `battlefield/externs.js` | redraw the whole view next frame |
| `SetBackProcess(on)` | `0x1002970f` | 5 | `battlefield/externs.js` | keep running in the background (no suspend) |
| `UpdateLOD(id)` | `0x10029743` | 2 | `battlefield/collision.js` | pick the level of detail again |
| `GetFrameRate(n)` | `0x1001234b` | 7 | `battlefield/collision.js` | frame counters; 3 = clock mod 10000 |
| `Srand(seed)` | `0x10017766` | 3 | `anim/motion.js` | seed the C library's rand |
| `RtLibInit`, `RtLibFree` | `0x10001a86`, `0x10001ba2` | — | — | plugin load/unload, see [Internals](#internals) |

### Objects in the scene ([battlefield.md](battlefield.md#objects-in-the-world))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `AddObject(id, ?, x, y, z)` | `0x100100f0` | 13 | `battlefield/externs.js` | put an OB3D/OPRT copy in the scene (level of detail picked here) |
| `SetPosition(id, x, y, z)` | `0x10016c76` | 16 | `battlefield/externs.js` | place it |
| `GetObjectPosition(id, &x, &y, &z)` | `0x10012484` | 25 | `battlefield/externs.js` | read its position into variables |
| `RevertPosition(id)` | `0x100162fe` | 5 | `battlefield/externs.js` | back to the x/z before the last move |
| `ObjectMoveUp(id, dy)` | `0x10018581` | 0 | `battlefield/externs.js` | move along world y |
| `ObjectMoveForwardUp(obj, forward, up)` | `0x1001849d` | 0 | `anim/motion.js` | step along its forward axis, then up |
| `SetPositionInFront(id, distance)` | `0x1000a1f2` | 0 | `battlefield/externs.js` | put it ahead of the camera |
| `ObjectYaw(id, a)`, `ObjectPitch(id, a)` | `0x100143af`, `0x10013ec6` | 4, 1 | `battlefield/externs.js` | turn about its own axes |
| `ObjectYawAbsolute(id, a)`, `ObjectPitchAbsolute(id, a)` | `0x1001442f`, `0x10013f46` | 0 | `battlefield/externs.js` | turn about the world axes |
| `SetObjectDirAbs(id, roll, pitch, yaw)` | `0x10016a6c` | 0 | `battlefield/externs.js` | reset the orientation, then turn |
| `SetObjectDirection(obj, x, y, z)` | `0x100168dc` | 0 | `anim/motion.js` | forward vector as given |
| `IncrementObjectYaw`, `IncrementObjectPitch`, `IncrementObjectRoll(id, a)` | `0x100129be`, `0x100128be`, `0x1001293e` | 0 | `battlefield/externs.js` | add to the angular velocity |
| `GetObjectHeading(id)` | `0x1001252c` | 1 | `battlefield/externs.js` | heading from +Z |
| `SetGravity(id, g)` | `0x1001662f` | 5 | `battlefield/externs.js` | per-object gravity |
| `SetRadius(id, r)`, `GetRadius(id)` | `0x10016d31`, `0x100126b1` | 15, 12 | `battlefield/externs.js` | collision radius (+0x58) |
| `SetLevel(id, level)` | `0x100166c5` | 19 | `battlefield/externs.js` | draw order (ground -100) |
| `SetUpdateScript(id, script)`, `GetUpdateScript(id)` | `0x100174b3`, `0x100127ee` | 126, 8 | `battlefield/externs.js` | the script run every tick for the object |
| `UpdatePosOrient(id, ms)` | `0x1001821f` | 26 | `battlefield/externs.js` | move by velocity and gravity, spin |
| `UpdatePos(obj, ms)`, `UpdateOrient(obj, ms)` | `0x1001817e`, `0x100180fe` | 1, 0 | `anim/motion.js` | the two halves of that |
| `UpdateTimeStep(id, ms, slot)` | `0x10011ec1` | 1 | `battlefield/externs.js` | move for the time banked in a timer |
| `UpdateGroundCheck(id)` | `0x10017fbb` | 3 | `battlefield/externs.js` | 1 while above the ground |
| `UpdateGroundHeight(id)` | `0x1001804c` | 0 | `battlefield/externs.js` | follow the ground (flat in G-NOME) |
| `SetGroundFlag(v)` | `0x1001669c` | 1 | `battlefield/externs.js` | ground-follow switch |
| `ObjectSetScene(id, own)` | `0x10014272` | 17 | `battlefield/collision.js` | main scene or flag 0x80 (own scene) |
| `ObjectSortFlag(id, mode)` | `0x10008ab1` | 3 | `battlefield/collision.js` | draw-order flags 0x200 / 0xa00 |
| `ObjectSetState(obj, on)` | `0x10014335` | 50 | `render3d/externs.js` | shown or hidden (flag 0x100) |
| `ObjectDistance(a, b)` | `0x10013fd8` | 51 | `anim/motion.js` | distance between objects |
| `XZToScreen(id, &x, &y, clump, slot)` | `0x1000946e` | 2 | `battlefield/externs.js` | screen point of an object; -1/0/1 left/on/right |
| `ScreenToXZ(x, y, which)` | `0x1001643d` | 0 | `battlefield/externs.js` | ground point under a pixel |

### Camera and view ([battlefield.md](battlefield.md#camera))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `SetCamera(x, y, z, atX, atY, atZ)` | `0x10009a8e` | 2 | `battlefield/externs.js` | place and aim |
| `AttachCamera(id, clump, dx, dy, dz)` | `0x1000748b` | 11 | `battlefield/externs.js` | ride on an object's clump |
| `SetCameraPitch(a)`, `SetCameraYaw(a)` | `0x10009f15`, `0x10009fed` | 8, 5 | `battlefield/externs.js` | turn |
| `GetCameraPitch()`, `GetCameraYaw()` | `0x10012267`, `0x10012316` | 2, 0 | `battlefield/externs.js` | read |
| `GetCameraPos(&x, &y, &z)` | `0x1001229c` | 1 | `battlefield/externs.js` | position into variables |
| `SetCameraClipping(near, far)` | `0x10009e99` | 4 | `battlefield/externs.js` | clip planes (draw distance) |
| `SetCameraViewwindow(w, h)` | `0x10009f73` | 0 | `battlefield/externs.js` | field of view |
| `ViewportCrop(l, t, r, b)` | `0x1000a8c2` | 40 | `battlefield/externs.js` | cockpit margins |
| `SetBackgroundColor(r, g, b)` | `0x10009a20` | 4 | `battlefield/externs.js` | clear colour |
| `SetCameraBackdrop(bitmap, scroll)` | `0x10009c68` | 1 | `battlefield/externs.js` | sky panorama |
| `SetFogDepthColor(depth, r, g, b)` | `0x1000a108` | 2 | `battlefield/externs.js` | depth cueing |
| `AddStars()` | `0x10007142` | 0 | `battlefield/externs.js` | empty in this build |

### Models, textures and previews ([render3d.md](render3d.md#externs-implemented))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `GetProperty(obj, p)`, `SetProperty(obj, p, v)` | `0x1001271e`, `0x10016c09` | 1336, 1962 | `render3d/externs.js` | object properties |
| `LinkModel(obj, model)` | `0x10012af7` | 68 | `render3d/externs.js` | the model copy an object draws |
| `GetNumClumps(model)` | `0x100123de` | 4 | `render3d/externs.js` | tagged clumps |
| `SetModelDimensions(model, frme, obj, &x, &y, &z)` | `0x100087ab` | 73 | `render3d/externs.js` | bounds into properties, radius |
| `SetObjOpacity(model, clump, percent)` | `0x1000a4e5` | 2 | `render3d/externs.js` | clump opacity |
| `SetObjDoubleface(model, clump, on)` | `0x1000a439` | 6 | `render3d/externs.js` | double-sided polygons |
| `SetObjPerspective(model, clump, on)` | `0x1000a381` | 9 | `render3d/externs.js` | texture mode lit (+ perspective when on); always on here |
| `SetClumpHints(model, clump, h)` | `0x1000a04b` | 29 | `render3d/externs.js` | RenderWare hints, stored |
| `SetModelTexture(model, bitmap)` | `0x1000a592` | 6 | `render3d/externs.js` | a bitmap on every polygon |
| `SetAnimatedTexture(obj, clump, frames)` | `0x10009962` | 3 | `combat/effects.js` | multi-frame texture on a clump |
| `SetTextureFrame(obj, f)` | `0x1000a2c9` | 4 | `combat/effects.js` | frame counter |
| `GetTextureNumFrames(obj)` | `0x1001278e` | 0 | `combat/effects.js` | frames in the texture |
| `UpdateAnimTex(obj)`, `UpdateAnimTexCycle(obj)` | `0x1000a64a`, `0x1000a789` | 1, 2 | `combat/effects.js` | next frame, once or looping |
| `RenderToBitmap(model, frme, frame, texFrame, x, y, z, sprite, angle)` | `0x10008b3a` | 4 | `render3d/externs.js` | the briefing/LAB unit preview |
| `FreeAllTextures()` | `0x100121d5` | 5 | `render3d/externs.js` | drop textures and restart RenderWare |
| `OrientModels(src, dst, clump, dx, dy, dz, upright)` | `0x10007ccd` | 8 | `battlefield/aim.js` | copy axes from one object (or clump) to another |
| `RotateSubClump(id, clump, z, x, y)` | `0x10016374` | 7 | `battlefield/aim.js` | turret joint rotation |
| `MoveSubClumpToFace(id, clump, target, tclump, mode, ms, ...)` | `0x100137d7` | 3 | `battlefield/aim.js` | turn a turret towards a target |

### Lights (`web/src/render3d/lights.js`)

No script calls these; the original scenes have no lights.

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `AllocLights(n)` | `0x10001fe0` | 0 | `render3d/lights.js` | new light table |
| `LightAddPoint`, `LightAddDirectional`, `LightAddConical` | `0x1000204b`, `0x10002123`, `0x10002182` | 0 | `render3d/lights.js` | create a light |
| `LightAttachToClump(i, model, clump, x, y, z)` | `0x100021e1` | 0 | `render3d/lights.js` | ride on a clump |
| `LightSetBrightness`, `LightSetColor`, `LightSetConeAngle`, `LightSetPosition`, `LightSetState`, `LightSetVector` | `0x10002331`-`0x1000253f` | 0 | `render3d/lights.js` | light settings |

### Animation ([animation.md](formats/animation.md#the-animation-system))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `createAnimationList(id, n)` | `0x1000aadc` | 2 | `anim/animation.js` | n animation slots |
| `removeAnimations(id)` | `0x1000ab87` | 1 | `anim/animation.js` | drop them |
| `addAnimation(id, slot, type, f0, f1, f2, stride, next, rev, script)` | `0x1000ae57` | 120 | `anim/animation.js` | define a slot |
| `addTrigger(id, frme, cond, target, immediate)` | `0x1000b961` | 124 | `anim/animation.js` | switch slots on a condition |
| `installAnimation(id, slot)` | `0x1000b338` | 0 | `anim/animation.js` | start a slot |
| `installAnimationType(id, type)` | `0x1000b573` | 24 | `anim/animation.js` | start the slot of a type |
| `findAnimationType(id, type)` | `0x1000b0f7` | 0 | `anim/animation.js` | slot of a type |
| `getCurrentAnimationType(id)` | `0x1000b5c7` | 9 | `anim/animation.js` | type playing |
| `doAnimationUpdate(id, status)` | `0x1000b75a` | 0 | `anim/animation.js` | one step |
| `setLOD(id, lod)` | `0x1000b193` | 10 | `anim/animation.js` | animation level of detail |
| `animationSetupProps()` | `0x1000aac0` | 1 | `anim/animation.js` | empty (returns 0) |
| `SetAnimation(id, frme, stride)` | `0x10016538` | 0 | `anim/animation.js` | play one FRME |
| `SetObjectFramerate(id, n)` | `0x10016b8f` | 2 | `anim/animation.js` | frames per second |
| `SetObjectMotion(obj, stride)` | `0x10016b20` | 0 | `anim/motion.js` | distance per frame |
| `AnimateFrame(id, frme, frame)` | `0x100105ec` | 5 | `anim/animation.js` | pose an object |
| `AnimateModelFrame(model, frme, frame)` | `0x100106bb` | 8 | `anim/animation.js` | pose a model copy |
| `UpdateFrameTerm(id, ms)`, `UpdateFrameCycle(id, ms)` | `0x10017d88`, `0x10017b20` | 0 | `anim/animation.js` | advance once or looping |
| `GetNumFrames(frme)` | `0x10012431` | 0 | `anim/animation.js` | frames in a clip |

### Motion and steering ([animation.md](formats/animation.md#motion))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `SetVelocityForward(obj, v)`, `GetVelocityForward(obj)` | `0x10017516`, `0x1001284e` | 8, 0 | `anim/motion.js` | speed along forward |
| `SetVelocityXZ(obj, v)` | `0x100175dc` | 0 | `anim/motion.js` | speed in the ground plane |
| `SetMaxAccel(obj, v)` | `0x1001671e` | 24 | `anim/motion.js` | acceleration limit |
| `SetMaxAngularAccel`, `SetMaxAngularVelocity(obj, roll, pitch, yaw)` | `0x10016835`, `0x1001678e` | 40, 42 | `anim/motion.js` | turn limits |
| `ApproachTargetSpeed(obj, ms)` | `0x1000ba71` | 1 | `anim/motion.js` | accelerate to the target speed; returns the drain |
| `MoveToPursue(obj, target, mode, heightProp, ms)` | `0x100133c2` | 1 | `anim/motion.js` | steer at a target |
| `MoveToEvade` | `0x10013575` | 1 | `anim/motion.js` | steer away |
| `MoveToFollow`, `MoveInCircle(obj, target, radius, mode)` | `0x10013179`, `0x10013054` | 1, 8 | `anim/motion.js` | follow / circle (yaw only) |
| `MoveToParallel(obj, target, mode, ms)` | `0x1001328c` | 1 | `anim/motion.js` | fly the target's way |
| `MoveToTrueLead(obj, speed, target, mode, ms)` | `0x1001368c` | 1 | `anim/motion.js` | intercept point |
| `MoveToFlock()` | `0x10013167` | 1 | `anim/motion.js` | empty (returns 0) |
| `ObjectDeviate()` | `0x10013fc6` | 0 | `anim/motion.js` | empty (returns 0) |
| `SetTargetAxis(obj, dir, axis, ms)`, `SetTargetAxisAngle(obj, angle, axis)` | `0x10016dd9`, `0x100170de` | 3, 4 | `anim/motion.js` | pitch/yaw rate ramps |
| `SetTargetTwist(obj, dir, ms)`, `SetTargetTwistAngle(obj, angle, prop)` | `0x1001714a`, `0x10017408` | 1, 6 | `anim/motion.js` | twist rate and pending angle |
| `StepTwist(obj, ms, twistProp, limitProp)` | `0x100177a4` | 2 | `anim/motion.js` | one twist step (rate fix in PR #60) |
| `PointAt(obj, target)`, `PointAtXZ` | `0x100144af`, `0x100146b7` | 2, 1 | `anim/motion.js` | face a target |
| `DotProduct`, `DotProduct2D` | `0x10011b21`, `0x10011cea` | 7, 2 | `anim/motion.js` | facing tests |
| `SphericalToRectangular(r, a, b, which)` | `0x1001766d` | 3 | `anim/motion.js` | one coordinate |

### Tasks ([animation.md](formats/animation.md#tasks), [missions.md](missions.md#tasks))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `setTaskProps(list, current)` | `0x1001ac50` | 1 | `anim/tasks.js` | which properties hold the task table |
| `getTaskField(obj, r, c)`, `setTaskField(obj, r, c, v)` | `0x1001ac70`, `0x1001ad57` | 64, 17 | `anim/tasks.js` | read/write a cell |
| `clearTask(obj, r)`, `clearTaskList(obj)` | `0x1001aec9`, `0x1001afd0` | 2, 11 | `anim/tasks.js` | empty rows |
| `doNextTask(obj)` | `0x1001b0e9` | 1 | `anim/tasks.js` | go to the chained task |
| `setCurrentTask`, `setNextTask`, `insertTask(obj, task, priority, target, ...)` | `0x1001b24f`, `0x1001b426`, `0x1001b625` | 38, 7, 69 | `anim/tasks.js` | add tasks |
| `TaskSetHighestIndex(obj)` | `0x1001b98c` | 1 | `anim/tasks.js` | highest priority becomes current |
| `completeTask(obj, r)` | `0x1001bb74` | 32 | `anim/tasks.js` | finish a task |
| `changeTaskPriority(obj, r, delta)` | `0x1001bc47` | 0 | `anim/tasks.js` | adjust priority |
| `existsGoal(obj, task, target)`, `activateGoal(obj, r, p)` | `0x1001bd54`, `0x1001bf97` | 15, 11 | `anim/tasks.js` | find / reactivate |
| `equalizeGoalPriorities(obj, p)` | `0x1001c162` | 0 | `anim/tasks.js` | one priority for all |
| `getHighestPriority`, `getLowestPriority(obj)` | `0x1001c2aa`, `0x1001c37e` | 11, 0 | `anim/tasks.js` | extremes |

### Lists ([animation.md](formats/animation.md#lists))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `ListCreate(n)`, `ListDestroy(id)` | `0x10012c08`, `0x10012ca3` | 106, 302 | `anim/lists.js` | make / free |
| `ListLength`, `ListGetElem`, `ListSetElem` | `0x10012dfa`, `0x10012d66`, `0x10012e29` | 4, 70, 51 | `anim/lists.js` | access |
| `ListElemPosition(id, v)` | `0x10012ce6` | 21 | `anim/lists.js` | index of v |
| `ListAdd(list, v, limit)`, `ListRemove(list, v, limit)` | `0x10012e60`, `0x10012f0f` | 13, 0 | `anim/lists.js` | add / remove (the original's remove ignores v) |
| `ListIterate(list, script)` | `0x10012d9a` | 3 | `anim/lists.js` | queue script(element) per slot |

### Files ([animation.md](formats/animation.md#files))

Files are kept in `localStorage` (`anim/files.js`).

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `FileOpen(name, flags)`, `FileClose(h)` | `0x1000f3d0`, `0x1000f230` | 10, 14 | `anim/files.js` | open / close |
| `FileGetC`, `FileGetS`, `FileGetL(h, addr, n)` | `0x1000f256`, `0x1000f351`, `0x1000f324` | 4, 0, 7 | `anim/files.js` | read bytes / shorts / longs into variables |
| `FilePutC`, `FilePutS`, `FilePutL(h, addr, n)` | `0x1000f549`, `0x1000f693`, `0x1000f666` | 0, 0, 5 | `anim/files.js` | write them |
| `FileRead`, `FileWrite(h, str, n)` | `0x1000f6c0`, `0x1000f731` | 4, 0 | `anim/files.js` | strings |
| `FileSeek(h, offset, origin)`, `FileLength(h)` | `0x1000f8ef`, `0x1000f37e` | 5, 0 | `anim/files.js` | position, size |

### Collisions and hotspots ([battlefield.md](battlefield.md#collisions))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `AllocHotspots(n)`, `DestroyAllHotspots()`, `ClearAllHotspots()` | `0x1002223c`, `0x1002485f`, `0x10023795` | 2, 2, 0 | `anim/hotspots.js` | hotspot table |
| `AddHotSpot(model, x, y, z, height, flags, type, ...)` | `0x1002232a` | 2 | `anim/hotspots.js` | add one, with its footprint |
| `GetNumHotSpots()` | `0x10024b12` | 0 | `anim/hotspots.js` | count |
| `GetHotSpotFlags`, `SetHotSpotFlags`, `ClearHotSpotFlag`, `GetHotSpotHeight`, `SetHotSpotHeight`, `GetHotSpotType`, `SetHotSpotType`, `SetHotSpotRadius`, `SetHotSpotXYZ` | `0x10024a0e`-`0x10024eaa` | 0-6 | `anim/hotspots.js` | fields |
| `SetCallbackID(n, script)`, `SetCallbackParm(n, k, v)`, `GetCallbackParm(n, k)` | `0x10024b27`, `0x10024b74`, `0x10024c4d` | 0, 0, 7 | `battlefield/collision.js` | a hotspot's callback |
| `UpdateCollideCheck(id, list, extra, ignore)` | `0x100182d0` | 1 | `battlefield/collision.js` | object-object test for a unit |
| `Process_Sector_Collisions(id, pHotspot, pObject, fast, scripts)` | `0x100289d0` | 1 | `battlefield/collision.js` | the per-tick collision pass |
| `ObjectPositionCollision(n, id)`, `CheckPositionCollision(n, x, z)` | `0x1002338f`, `0x1002325c` | 1, 0 | `battlefield/collision.js` | inside hotspot n? |
| `FastmovingHotspotCollide(id, other, n)` | `0x1002447f` | 0 | `battlefield/collision.js` | swept test |
| `DeflectObject`, `DeflectHotspot` | `0x10023dac`, `0x1002421e` | 1, 2 | `battlefield/collision.js` | slide off |
| `ClumpToClump(a, b, tol)` | `0x100107cc` | 2 | `battlefield/collision.js` | clump boxes touch |
| `CollisionClump(proj, target)` | `0x10010dbc` | 1 | `combat/damage.js` | which part a shot passed through |

### Combat ([combat.md](combat.md))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `Decrement_Recharge_Timers(obj, ms, callbacks)` | `0x100286ab` | 1 | `combat/projectiles.js` | weapon recovery |
| `Projectile_Update(proj, ms, guided, &fade, list, player, callbacks)` | `0x10028170` | 1 | `combat/projectiles.js` | a shot's tick |
| `StopProjectileObject(proj, target, hotspot)` | `0x10023f7f` | 4 | `combat/projectiles.js` | put a shot on the surface it hit |
| `ExplodeModel(obj, gravity, speed, script)` | `0x10012142` | 4 | `combat/damage.js` | fling the parts |
| `AmputateClump(obj, model, clump)` | `0x10007152` | 1 | `combat/damage.js` | cut a part off |
| `QueryClumpList(model, clump)` | `0x1000853e` | 2 | `combat/damage.js` | tags under a clump |
| `ReplaceClump(model, source, clump)` | `0x10009091` | 1 | `combat/damage.js` | damaged mesh |
| `DefaultClumpHealths(model, clump)` | `0x100089ca` | 1 | `combat/damage.js` | health from size |
| `ObjectPlayWave(obj, wave, loop, done, priority, remember)` | `0x100140ad` | 10 | `combat/effects.js` | sound at an object (distance volume, pan) |
| `DamageRect(obj)` | `0x10011acb` | 0 | `combat/effects.js` | no-op |

### Radar and sprites ([battlefield.md](battlefield.md#radar))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `RadarClear(sprite)` | `0x10014866` | 1 | `battlefield/radar.js` | black radar |
| `RadarDraw(unit, sprite, list, range, ...)` | `0x10014c8e` | 1 | `battlefield/radar.js` | blips, sweep, waypoint |
| `MakeSpriteExtern(sprite, on)`, `MakeSpriteDraw(sprite)` | `0x10012ffe`, `0x10012fa0` | 15, 1 | `combat/effects.js` | no-ops |

### Sound (`web/src/waves.js`)

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `DSInitWavePlay()`, `DSDeInitWavePlay()` | `0x1001f2a3`, `0x1001f3fe` | 2, 1 | `plugins/render.js` | DirectSound up / down |
| `DSLoadWave(id)`, `DSUnloadWave(id)` | `0x1001f4ee`, `0x1001fb4e` | 11, 36 | `plugins/render.js` | decode / stop and drop (0 = all) |
| `DSPlayWave(id, volume, pan, loop, done, priority, _)` | `0x1001fd0c` | 49 | `waves.js` | play in one of 5 voices; done script at the end |
| `DSStopWave(id)` | `0x10020746` | 26 | `waves.js` | stop (0 = all); no done script |
| `DSPauseAudio(on)` | `0x10020d85` | 8 | `waves.js` | pause / resume every voice |
| `DSSetVolume(id, v)`, `DSSetPan(id, p)` | `0x10020bbb`, `0x10020cf0` | 0 | `waves.js` | change a playing voice |
| `DSGetVolume`, `DSGetPan`, `DSGetDSObj`, `DSSetFormatPrimary` | `0x10020b1b`, `0x10020c55`, `0x1001fb29`, `0x100209f3` | 0 | — | not implemented |

### Input ([battlefield.md](battlefield.md#controls))

| Extern | Address | Calls | Web | What it does |
| --- | --- | --- | --- | --- |
| `MapActionKeys(actions, press1, press2, column, mask)` | `0x1000d6e7` | 2 | `battlefield/externs.js` | key tables the window procedure runs scripts from |
| `CheckActionState(actions, held, action, column, mask)` | `0x1000c631` | 33 | `battlefield/externs.js` | is an action held? |
| `MouseOnOff(on)` | `0x1000dbac` | 17 | `battlefield/externs.js` | mouse buttons as keys |
| `CaptureKey(script)` | `0x1000db64` | 1 | `plugins/render.js` | next key to a script (INTERFACE screen) |
| `SetPauseScript(script)` | `0x1000db88` | 14 | `plugins/render.js` | script for the Pause key |
| `EnableJoystick(on, ?)` | `0x1000d80b` | 15 | `battlefield/externs.js` | joystick on/off; gamepads (`battlefield/joystick.js`) |
| `RangeJoystickAxis(binds, action, min, max, ?)` | `0x1000d184` | 1 | `battlefield/externs.js` | bound axis scaled to min..max; -1 without joystick |

## Not implemented

None of these is called by any G-NOME script.

| Extern | Address | What it does |
| --- | --- | --- |
| `AddGround(model, x, y, z)`, `RemoveGround()` | `0x100193a0`, `0x10019491` | height-field ground from a model, with a grid for height lookups; G-NOME's ground is flat tiles |
| `BFDrawText(sprite, x, y, colour, flags, string)`, `BFDrawTextShadow` | `0x1000e470`, `0x1000e95a` | text into a sprite's bitmap |
| `BFClearRect(sprite, colour, x1, y1, x2, y2)`, `BFRepaintRect(l, t, r, b)` | `0x1000f08a`, `0x1000f1d9` | fill / repaint a rectangle |
| `CollideHotSpot(n, obj)` | `0x10023803` | one object against one hotspot |
| `CollisionBounce(a, b)` | `0x10010d0f` | bounce two objects apart (flag 8) |
| `GetClumpDirection(model, clump, row, column)` | `0x1000772e` | one element of a clump's matrix |
| `PickObject(x, y)` | `0x1000a9e5` | object under a pixel (`RwPickScene`) |
| `SetScaleFactor(v)` | `0x10016da8` | stores a scale nothing reads |
| `TurnOffTextures()` | `0x10017b06` | clears a flag nothing reads |
| `DSGetVolume(id)`, `DSGetPan(id)` | `0x10020b1b`, `0x10020c55` | read a voice back |
| `DSGetDSObj()`, `DSSetFormatPrimary(ch, rate, bits)` | `0x1001fb29`, `0x100209f3` | the DirectSound object; primary buffer format |
| `FileReadLine`, `FileWriteLine` | `0x1000f7a2`, `0x1000f86d` | text lines |
| `FileFindFirst`, `FileFindNext`, `FileFindClose` | `0x1000f97c`-`0x1000fbba` | directory listing |
| `FileSetDataPath`, `FileSetDataPathRel`, `FileDataOpen`, `FileGetTempDir` | `0x1000fc6a`-`0x10010033` | data folder |
| `FileDirCreate`, `FileDirCreateRel`, `FileDirRemove`, `FileDirRemoveRel` | `0x1000fe91`-`0x1000ffc0` | folders |
| `RtLibInit`, `RtLibFree` | `0x10001a86`, `0x10001ba2` | called by RTLIB32, see [Internals](#internals) |

## Checking it

```bash
node web/tests/render-coverage-check.mjs   # this page vs RENDER.R32 and web/
node web/tests/waves-check.mjs             # wave player, briefing, Pause
```

The coverage check reads RENDER.R32's export table and G-NOME.BIN's
extern names, and fails if an export is missing from this page or a
script-called extern has no browser version.
