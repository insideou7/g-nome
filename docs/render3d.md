# 3D renderer core (`web/src/render3d/`)

The browser engine's replacement for what `RENDER.R32` did with RenderWare
2.0: load models, textures and animation poses, keep the script-visible 3D
objects and their properties, and draw scenes. The battlefield view and the
animation code build on this API.

Everything here was written from the Ghidra decompile of `RENDER.R32`
(regenerate it with REA, see below). Function addresses are given so the
behaviour can be checked against the original.

## Files

| File | What it does |
| --- | --- |
| `model.js` | MODL/MPRT parser: clump tree, per-clump meshes, tags, bounds |
| `textures.js` | type 2 texture lists and type 1 bitmaps as textures, multi-frame textures |
| `frames.js` | FRME poses |
| `objects.js` | OB3D/OPRT object records and their properties |
| `scene.js` | `Scene`, `SceneNode`, `Camera`, `meshModel` |
| `soft.js` | software rasterizer (previews, Node, no-WebGL fallback) |
| `webgl.js` | WebGL2 backend |
| `renderer.js` | `Renderer`: caches, palette handling, `render`, `renderPreview` |
| `externs.js` | the `render.*` externs built on all of the above; `engine.render3d` |
| `math.js` | 4x4 matrices |

## Conventions

- RenderWare matrices: row vectors (`v' = v * M`), translation in elements
  12-14. That is the same memory layout as a column-major OpenGL matrix.
- Y is up. A camera looks along its own +Z, and its +X is screen **left**
  (`right = at x up = -X`), as in RenderWare.
- Angles are degrees in this API. Scripts pass hundredths of a degree
  (`18000` = 180), and sizes in thousandths of a unit; externs convert.
- 1 RenderWare unit = 1 model unit. Units are about 0.5 units tall. The
  battlefield thread found 1 unit = 100 script position units.
- Colours are 0..1; camera and light colours also accept 0..255.
- No back-face culling (`CULL` in `soft.js`): ground tile MPRT 2398 faces
  away from a camera above it by the winding the mechs use (clockwise on
  screen, `FRONT`), yet the game shows it. Closed models look the same with
  the z-buffer, and lighting uses |N.L|.
- Model op `0x32` is RWX TextureModes (1 lit, 2 foreshorten, 4 filter). A
  texture without the lit bit draws at full brightness; ground tiles use 2.
- Model op `0x08` is the surface colour and `0x2C` the surface (ambient,
  diffuse, specular); they were read the other way round before
  2026-10-31. Most models have colour 0.2 grey (black under textures) and
  surface 0.74 0.2 0.2. A texture with no TextureModes op is lit
  (RwCreateMaterial's default is 1).
- Lighting is RWL20.DLL's (`FUN_1000c4b0`, `FUN_1000c730`), in
  `materialLight` / `addLights` (`scene.js`): RenderWare 2.0 has no ambient
  light, so a lit polygon gets its surface ambient as white light, plus per
  light `colour * (diffuse * N.L + specular * (N.L)^16 if N.L > 0.7)`,
  clamped to 1. Textures take the light; the colour is only used without a
  texture. Point and cone lights stop at their radius; the original's
  distance falloff past an inner radius (light fields 0x68-0x70) is not
  copied.
- No G-Nome script calls a `Light*` extern, so in the original the
  battlefield and preview scenes have no lights at all and every model shows
  its ambient alone (0.74 for most). The far ground tiles (MPRT 2400, 2404,
  ...) are lit and come out at 70%, the near ones (TextureModes 2) at full
  brightness.
- Lights: the `Light*` externs and `AllocLights` are in
  `render3d/lights.js` (`engine.render3d.lights`); the battlefield view
  copies them into its scene each frame.
- 15 models (2813, 2815, 3033, 3035, 3072-3084, 3350, 3352, 3619, 3621)
  have an untextured material with colour (op `0x08`) 0 0 0. Each uses it only on
  one tagged clump (tag 17, 18 or 24) holding one or 16 triangles, most of
  them zero-area, with opacity 0: marker points, not visible parts. Neither
  backend draws a polygon with opacity 0.01 or less, so they do not draw
  black. `web/tests/models-check.mjs` checks this for all 801 models.
- `ObjectSetState(obj, 1)` (flag `0x100`) hides the object: the ground
  tiles' last level of detail (script 2140) and the unit the camera rides
  in (script 2171) use it.
- The battlefield draws `viewDistance` (default 3, `?view=1` for the
  original) times the scripts' far plane, and picks levels of detail
  against that distance, so the ground reaches the horizon.

## Using it

`engine.render3d` (created by `RenderPlugin`):

```js
const r3d = engine.render3d;
const scene = r3d.createScene();
const node = scene.add(r3d.objectModel(objId)); // or r3d.renderer.loadModel(resId)
node.setTransform({ matrix, visible: true, level: 0, depth: true, distance: d2 });
// or node.setTransform({ position: [x, y, z], yaw, pitch, roll, scale })
node.pose = r3d.renderer.frame(node.model, frmeId, frameIndex); // FRME pose
const cam = r3d.createCamera();
Object.assign(cam, { position, at, up, viewwindow: [0.61, 0.457], near, far,
  fog: { depth, color: [r, g, b] }, background: [r, g, b],
  backdrop: { image, x, y, wrap: true } });
const canvas = r3d.render(scene, cam, { x, y, w, h, canvasWidth: 640, canvasHeight: 480 });
node.remove();
```

- `objectModel(id)`: the `ModelInstance` an object draws (its `LinkModel`
  model, else property 39), or null. Instances hold per-copy state that
  scene nodes share: `pose`, `clumpOpacity[]`, `clumpHidden[]`,
  `doubleSided[]`, `textureOverride`, `textureFrame`. `inst.clump(k)` maps
  a script clump number to an index in `model.clumps`.
- `renderer.createMesh({positions, uvs, normals, indices, groups})` builds a
  model from raw arrays (each group: `{start, count, material: {texture,
  color, opacity}}`).
- Draw order follows `FUN_10006446`: level ascending, then distance
  descending. Nodes with `depth: false` (ground layers, decals) draw without
  depth test or depth write so coplanar layers stack.
- `scene.lights`: `[{type: "directional" | "point" | "conical", color,
  direction, position, radius, coneAngle, on}]`. Empty means no lights, as
  in the original: models show their surface ambient.
- `render(..., {backend: "soft"})` returns a `SoftTarget` `{width, height,
  rgba}` instead of a canvas. `renderer.toIndexed(rgba)` maps RGBA to the
  game palette (colours 10-245; alpha 0 becomes colour 0, transparent).
- `bitmapImage(resId)`: a type 1 bitmap as `ImageData` in the current palette.

## Formats

### Models (MODL type 7, MPRT type 8)

The opcode table is in [formats/g-nome-bin.md](formats/g-nome-bin.md). Two
additions from the decompile:

- Op `0x2D` is the clump **tag**. `RENDER.R32` keeps clump `i` of a model as
  `RwFindTaggedClump(root, i + 1)`, and the u32 after the `MODL` tag is the
  number of tagged clumps (`FUN_100043f0`). Scripts number clumps the same
  way: 0 is the root, k is the clump tagged k.
- Textures: before parsing a model, `RENDER.R32` registers the textures in
  the type 2 resource right after it (resource id + 1, `FUN_10003f0b`). The
  same `.BMP` name can mean different pictures in different resources (each
  level of detail has its own smaller copies), so look there first.

### Multi-frame textures

A texture taller than it is wide holds square frames stacked top to bottom.
G-Nome uses them for team colours (red on top, green below).
`RenderToBitmap` and `SetTextureFrame` choose the frame
(`RwSetTextureFrame`).

### FRME (type 4)

```
"FRME", u32 clumps, u32 frames, u32 0
frames x clumps x 12 floats   4x3 matrix, row vectors, translation last
```

Applying frame `f` replaces the local matrix of the clump tagged `i + 1` with
matrix `i` (`FUN_10006085`).

### Objects (OB3D type 9, OPRT type 10)

`FUN_100043f0` expands an OB3D when it loads. After `"OB3D"` and a u32
count come records:

| Record | Fields | Kept as |
| --- | --- | --- |
| 1 | ms, script | entry kind 1: a timer script |
| 2 | min, max (floats), resource type, resource id | entry kind 4 when the type is 7 (a model), 5 when it is 19 (a script). Distance ranges: levels of detail |
| 6 | ms, script | entry kind 6: the update script and its interval (first in every object) |
| 8 | model | entry kind 8: a fixed model linked once |
| 7 | x, n, values[n] | the property list; always last |

`GetProperty(obj, p)` (`0x1001271e`) reads `values[p]`, zero past the end;
`SetProperty` writes it. An OPRT copy is loaded as an OB3D (the copy proc
swaps the tag). Properties seen so far:

| Property | Meaning |
| --- | --- |
| 0 | object class (100 units, 520, 304 ground parts, 236, ...) |
| 1 | model resource; for units 1-7 are the model variants |
| 39 | the object's model copy (`CopyResource` of property 1, then `LinkModel`) |
| 55, 56, 57 | model size x, y, z in thousandths (`SetModelDimensions`) |
| 79, 99 | model and FRME used for the in-mission `RenderToBitmap` |

## Externs implemented

| Extern | Address | Notes |
| --- | --- | --- |
| `GetProperty`, `SetProperty` | `0x1001271e`, `0x10016c09` | |
| `LinkModel(obj, model)` | `0x10012af7` | sets flag 8 |
| `ObjectSetState(obj, on)` | `0x10014335` | flag `0x100` |
| `GetNumClumps(model)` | `0x100123de` | tagged clumps |
| `SetModelDimensions(model, frme, obj, px, py, pz)` | `0x100087ab` | bounds x 1000 into properties; radius = max(x, z) / 2 |
| `SetObjOpacity(obj, clump, percent)` | `0x1000a4e5` | |
| `SetObjDoubleface(obj, clump, on)` | `0x1000a439` | |
| `SetObjPerspective`, `SetClumpHints` | `0x1000a381`, `0x1000a04b` | rendering hints, no visible effect here |
| `SetModelTexture(model, bitmap)` | `0x1000a592` | type 1 bitmap on every polygon |
| `RenderToBitmap(model, frme, frame, texFrame, x, y, z, sprite, angle)` | `0x10008b3a` | see below |
| `FreeAllTextures()` | `0x100121d5` | see below |

### RenderToBitmap

Draws one model into the bitmap of a sprite's current cel. The unit preview
in the campaign briefing (script 7280) calls it every tick with the angle
going up by 2 degrees and the FRME frame stepping, and swaps between two
sprites.

- Camera: viewwindow 0.1 wide, height from the bitmap's aspect ratio;
  background colour 0, which is transparent in the sprite.
- The model sits at the origin, posed by the FRME frame and rotated about Y.
- The camera is at height `y / 2` and backs off until
  `sqrt(x^2 + z^2) * 1.05` by `y * 1.05` fits, then turns 180 degrees to
  face the model.
- The original draws into the cel's DIB, which is stored bottom row first,
  and the scripts then mirror the sprite vertically (sprite message 7, 0, 1).
  The extern writes rows bottom up to match.

## File externs

The LAB screens read their text from `LABTEXT.DAT` through RENDER.R32's
file externs. Those now live in `web/src/anim/files.js` (from the animation
work, with saves kept in localStorage).

### FreeAllTextures and UncachePack

The scripts call `render.FreeAllTextures()` when they leave a LAB screen
and at the end of a mission. If any texture is loaded, the original destroys
every texture in its name table (`0x1000439d`) and then restarts RenderWare
(`0x10027f48`): `RtUnload` of every resource of type 7, 8, 9 and 10, so
every model, model copy and OB3D/OPRT object is read again from its
resource on next use, then `RwClose`, a fresh `RWL20.DLL` and `RwOpen`, and
a new camera. The browser does the same to its caches
(`Renderer.freeTextures`, `models`, `instances`, `objects.records`) and
deletes its WebGL textures.

RTLIB32's builtin `0xF2` UncachePack(pack) deletes the hard-disk copy of a
pack that `0xE8` CachePack made (script 22 swaps the next mission's packs in
this way, so missions 2 and 19 reach it). The browser keeps every pack in
memory (resources are read synchronously), so `Engine.uncachePack` drops
what was decoded from that pack instead: bitmaps, sounds not playing,
animation clips, models and textures.

## Handedness (no mirroring)

The camera draws its +X on the left of the screen, as RenderWare does
(`soft.js`, `webgl.js`; `scene.js` builds camera X as `-right`, where
`right = at x up`). Checked on 2026-10-31 that nothing comes out mirrored:

- Steering: in mission 1, holding Right (the scripts' turn action) turns
  the view to the right on screen. With a mirrored projection it would turn
  left. The walkthrough checks this.
- Radar: RadarDraw's decompiled formula puts an object along the unit's
  `right` row on the left of the radar, which is where the 3D view draws it.
- Model data: none of the 3,950 `transform` ops in the 801 models has a
  negative determinant, so no part is stored mirrored. Of 75,605 FRME
  matrices, only frames 16-23 of 4595 and 4597 and frames 18-21 of 4855 and
  4858 have one. Those are tiny squash scales (|det| under 0.12) in the
  animations themselves, and the original plays them the same way.
- The WebGL and software backends draw the same picture (`render3d.html`).

Textures cannot settle it: the crates (3822, 3826) show their texture the
right way round on two sides and mirrored on the other two, whichever way
the screen is flipped.

## Checking it

- `node web/tests/models-check.mjs game/g-nome/G-NOME` parses all 801
  models and fails if one has a visible untextured polygon that would draw
  black.
- `node web/tests/free-check.mjs game/g-nome/G-NOME` checks
  FreeAllTextures and UncachePack, then plays missions 1, 19 and 1 again
  and fails if mission 1 holds more models, objects or textures the second
  time.
- `web/tests/render3d.html?game=/game/g-nome/G-NOME/&models=2583&frame=2597`
  shows WebGL and software renderings side by side. Serve the repo root.
- `NODE_PATH=$(npm root -g) node web/tools/shot.mjs 16 /tmp/brief 3:Escape
  6:click@163,455 8:click@42,165 10:click@600,165` opens GAME > NEW >
  CAMPAIGN; the briefing's unit preview turns on the right.
- `... shot.mjs 14 /tmp/lab 3:Escape 6:click@322,455 8:click@42,165` opens
  LAB > VEHICLES (y 210, 255, 292 for the other three).

## Regenerating the decompile

```bash
bash scripts/install-ghidra.sh
GHIDRA_INSTALL_DIR=/opt/ghidra npx -y rea-agents@6.8.0 decompile-all \
  game/g-nome/G-NOME/RENDER.R32 --output re-output/render --provider ghidra
python3 scripts/rw-import-names.py re-output/render   # -> re-output/render/named
```

`RENDER.R32` loads `RWL20.DLL` with `GetProcAddress` (`FUN_10025193`);
the script swaps those pointers for RenderWare names.

## Not done yet

- Material settings ops `0x04` (AxisAlignment), `0x0D` (GeometrySampling),
  `0x0F` (Hints), `0x16` (LightSampling: lighting is per face either way),
  `0x19` (MaterialModes) are read but not used.
- Ground textures look like noise in the menu palette; the mission palette
  presumably fixes them.
