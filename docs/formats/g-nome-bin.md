# G-NOME.BIN and the G-NOME.### packs

`G-NOME.BIN` is the game's master file. Its header points at a resource
table, a palette, string tables and the compiled script. Every resource
lives in one of 80 pack files, `G-NOME.000` to `G-NOME.099` (numbers 009,
030-034, 062-070 and 083-087 are not used).

`tools/gnome_extract.py` implements everything below. All values are
little-endian.

## Header

| Offset | Contents |
| --- | --- |
| `0x000` | `"7L"` magic |
| `0x004` | `"32"` |
| `0x007` | length-prefixed title, `"G-Nome"` |
| `0x138` | u32 offset, u32 size of the resource table (`0x1A8`, `0x170C0`) |
| `0x150` | offset, size: 86 `{u32 id, i32 value}` pairs |
| `0x158` | offset, size: NUL-separated strings (`domintro.smk`, UI text, ...) |
| `0x160` | offset, size: compiled script, about 1 MB |
| `0x168` | offset, size: palette, 236 entries (see below) |
| `0x188` | offset, size: plugin names (`render`, `netgn`, `smacker`) |
| `0x190` | offset, size: plugin function names (`AddGround`, `AddObject`, ...) |
| `0x198` | offset, size: zero padding to the end of the file |

The section names are guesses from their contents. The extractor saves each
one to `bin-sections/<name>.bin`.

## Resource table

9,440 entries of 10 bytes:

```
u16 flags   pack number << 8 | type
u32 offset  into G-NOME.<pack as %03d>
u32 size
```

Types 13 to 21 do not live in the packs at all: their offsets point into
the script buffer (see the table). Types 1 to 12 are all in bounds and
cover each pack exactly, with no gaps and no overlaps. (Read as pack
offsets, types 13-21 seemed to sit inside sounds, so they were once taken
for sound slices.)

| Type | Count | What it is | Extractor output |
| --- | --- | --- | --- |
| 1 | 1,240 | Bitmap (sprites, UI, portraits, screens, maps) | `.png` |
| 2 | 835 | List of textures, each with its original `.BMP` path. 211 are empty. | one `.png` per texture |
| 4 | 333 | `FRME` animation clip ([animation.md](animation.md)) | glTF animations |
| 7 | 647 | `MODL` chunk, 3D model | `.obj` + `.mtl`, `.gltf` |
| 8 | 154 | `MPRT` chunk, model part (same format as `MODL`) | `.obj` + `.mtl`, `.gltf` |
| 9 | 426 | `OB3D` object definition ([animation.md](animation.md)) | raw; properties in `manifest.csv` |
| 10 | 57 | `OPRT` object part, same format as `OB3D` | raw; properties in `manifest.csv` |
| 11 | 709 | Integer table read by the scripts (see [Tables](#tables-type-11)) | raw |
| 12 | 592 | Sound | `.wav` |
| 13-21 | 4,447 | Runtime resources in the script buffer (key 5, [rtlib32-engine.md](../rtlib32-engine.md)): their offsets are relative to it, not to a pack. 13 (17): a 14 byte `{u16 1, u32, u32 0, u32}` record named by sprite queue record 23, a cel drawn by a plugin callback; 14 (82): statement lists; 15 (290): bitmap references; 16 (66): sprite lists; 17 (14): palettes (below); 18 (95): sprite queues; 19 (2,342): scripts; 20 (913): sprites; 21 (628): text objects. | raw, from the script buffer |

## Palette

Windows keeps palette slots 0-9 and 246-255 for its own colours, so the game
stores the 236 colours for slots 10-245. Each is 4 bytes: R, G, B, flags.
The palette section of `G-NOME.BIN` is one of these, and so are the 14
type 17 resources (2487-2509 odd ids, 2510 and 2511), which live in the
script buffer.
Statement `0xB4` (`set_palette`) loads one.

### Which scenes swap palettes

The menus, LAB and briefings load palette 2510, which is the same as the
header palette. Palette 2511 is the same again and nothing uses it. Each
mission world loads its own palette instead: script 2514 reads row `n` of
table 2512 (one row per world, 16 rows) and calls `set_palette` with its
column 1.

| Column | Meaning |
| --- | --- |
| 0 | sky backdrop bitmap (`SetCameraBackdrop`), 1328 x 383 |
| 1 | palette (always the backdrop's id + 1) |
| 2 | fog depth |
| 3-5 | fog colour r, g, b |
| 6 | terrain type: 0 desert, 1 ice, 2 grass, 3 the dark rocky world |
| 7 | the world's setup script |

The 12 world palettes match the header in slots 10-185. Slots 186-215 are
the terrain colours, the same for the three palettes of each terrain type.
Slots 216-245 are the sky colours, different in every palette (for the
desert: blue sky, grey sky, sunset). So every ground tile, tree and
building texture that uses slots 186-215 looks like noise in the menu
palette; its name starts with the terrain type's letter (`D`, `I`, `G`,
`M`). Each terrain type also sets its own background colour in script 2514.

The extractor renders every bitmap with the header palette and the
standard Windows system colours for the reserved slots, except that a
world's sky backdrop uses the palette after it, and a texture whose name
starts with `D`, `I`, `G` or `M` and that uses the terrain slots uses the
first palette of that terrain type (2487, 2493, 2499 or 2505). The browser
engine needs no special case: it keeps the current palette and redraws
textures when it changes.

## Bitmaps (type 1)

```
u32 width
u32 height
u32 flags     0x80 = RLE (1,168 bitmaps); 0 = LZW packed (72)
i32 x, y      hotspot / draw offset
u32 id        the resource's own index
```

For RLE bitmaps, `height` u16 row offsets follow the header, each counted
from the start of that offset table. Rows are listed top to bottom, but their
data is stored bottom row first. A row is a list of ops ending in `0x00`:

| Op | Meaning |
| --- | --- |
| `0x01`-`0x7F` n, then v | run of n pixels of colour v |
| `0x80`-`0xFE` c | `0xFF - c` literal pixels follow |
| `0xFF` n | n literal pixels follow |

Colour 0 is transparent. Every RLE row in the game decodes to exactly
`width` pixels.

### Packed bitmaps (flags 0)

The 640x480 screens and other flag 0 bitmaps use RTLIB32's
`DecompressBitmapData`. The output is `width x height` palette indices in
rows padded to a multiple of 4 bytes, bottom row first like a Windows DIB
(the main menu backdrop, resource 8400, has its button labels upside down
otherwise).

The stream is a list of blocks, each starting with a u16:

| Top 3 bits | Low 13 bits | Block |
| --- | --- | --- |
| `0x0000` | size | stored bytes |
| `0x4000`, `0x6000`, `0x8000` | size | LZW chunks with 10, 11 or 12 bit codes |
| `0xE000` | | end of stream |

An LZW block holds chunks of `u16 size` plus data. Each chunk starts with a
fresh dictionary. Codes are fixed-width and read most significant bit first.
Codes 0-255 are bytes and new strings are numbered from 256. The all-ones
code (1023, 2047 or 4095) ends the chunk. There is no reset code: once the
table is full it stops growing. Found by disassembling `DecompressBitmapData`
(`0x10033DA5`) and its LZW routine (`0x100356C0`) in `RTLIB32.DLL`.

## Textures (type 2)

A texture resource is a list of records, back to back:

```
u32 kind       61
u32 size       bytes in the rest of the record
u32 path_len
char path[path_len]   e.g. \7thlevel\gnome\src\data\bitmaps\mesoonbl.BMP
bitmap         a type 1 bitmap, to the end of the record
```

590 resources hold 2,108 textures (1,215 RLE and 893 packed). They are
saved as `png/texture/<index>-<BMP name>.png`. Many textures stack two colour
variants (a red team and a green team version) in one tall image. The 34
type 2 resources that do not start with kind 61 are something else and are
kept raw.

## Models (types 7 and 8)

`MODL` and `MPRT` resources use the same format: the 4 byte tag, a u32
(the number of tagged parts), then
a stream of u32 opcodes with fixed arguments. The opcodes mirror RenderWare
2.0's RWX script commands, which `RWL20.DLL` also parses as text.

| Op | Args | Meaning |
| --- | --- | --- |
| `0x1A` / `0x1B` | | model begin / end |
| `0x06` / `0x07` | | clump begin / end |
| `0x35` / `0x36` | | transform begin / end (push / pop) |
| `0x34` | 16 floats | transform: 4x4 matrix for row vectors, translation in the last row |
| `0x3B` | x, y, z | vertex |
| `0x3C` | x, y, z | vertex with extras, then `0x12` u, v and `0x14` end |
| `0x39` | 3 ints | triangle (1-based vertex indices within the clump) |
| `0x23` | 4 ints | quad |
| `0x1D` | n, n ints | polygon |
| `0x08` | r, g, b | colour (RwSetSurfaceColor) |
| `0x2C` | 3 floats | surface: ambient, diffuse, specular (RwSetSurface) |
| `0x1C` | float | opacity |
| `0x2E` | int, path | texture. The path is only there when the int is not 0. It is NUL-terminated and padded to 4 bytes. |
| `0x2D` | int | tag: the clump's part number, used by FRME animations |
| `0x04` | int | RwSetAxisAlignment (4 = XYZ, faces the camera) |
| `0x0D` | int | RwSetSurfaceGeometrySampling (4 = solid) |
| `0x0F` | int | RwSetHints (bits 1 container, 2 HS, 4 editable) |
| `0x16` | int | RwSetSurfaceLightSampling (1 facet, 2 vertex) |
| `0x19` | int | RwSetSurfaceMaterialModes (8 = double-sided) |
| `0x32` | int | RwSetSurfaceTextureModes (1 lit, 2 foreshorten, 4 filter) |

The int values are RenderWare 2.0's (what the browser engine does with
each is in [render3d.md](../render3d.md)); they come from the RWX text
parser in `RWL20.DLL`, which maps each keyword to the constant it passes (for example
`solid` pushes 4 before calling `RwSetSurfaceGeometrySampling`, and the
hints are a table at `0x100510d8`). In the 801 models:

| Op | Values used |
| --- | --- |
| `0x04` | 4 (xyz) in 29 models: the explosion, shot, hit, smoke and fire sprites (1246-1876, 2532, 2535). Each is one textured square that RenderWare turns to face the camera. |
| `0x0D` | always 4 (solid) |
| `0x0F` | 0 (2,531 times), 6 = hs + editable (181, the animated units), 2 = hs (3) |
| `0x16` | 1 facet (5,110), 2 vertex (6, in 3852 and 5895) |
| `0x19` | 8 (double-sided), 304 times in 266 models; the rest have no double materials |
| `0x32` | 2 foreshorten (231, ground and walls), 0 (34, the sprites: not lit) |

Op `n` calls entry `n - 1` of RENDER.R32's table of RWX functions
(`FUN_100025e5`, replayed by `FUN_10003432`). The colour and surface ops were
swapped in this table until 2026-10-31: most models have colour 0.2 grey (or
black under a texture) and surface 0.74 0.2 0.2.

Every one of the 801 models parses to its exact end with this table. Each
clump has its own vertex list. A transform applies to the clump that follows
it, inside its parent clump's space. The extractor writes `obj/<index>.obj`
and `.mtl` files whose materials point at the matching texture PNGs (every
texture a model names is found). OBJ `v` is `1 - v`.

Most models (the mechs, buildings and vehicles) assemble correctly in their
own transforms. A few have parts spread apart; the game always poses them
with an `FRME` clip, so the extractor poses every model in its rest clip and
also writes a `.gltf` with all its clips. See [animation.md](animation.md).

## Sounds (type 12)

A 32 byte header, then the samples:

```
u32 data size     (= resource size - 32)
u16 ?
u16 compressed    1 = 7th Level ADPCM, 0 = plain PCM
u32 ?
u32 id
WAVEFORMATEX      format 1, channels, rate, byte rate, align, bits
```

The `WAVEFORMATEX` describes the decoded PCM. Most sounds are 16-bit mono at
22,050 or 11,025 Hz; two are stereo.

7th Level ADPCM is IMA ADPCM with no block headers: the predictor and step
index both start at 0 and are never reset, the low nibble is decoded first,
and stereo puts the left channel in the low nibble and the right in the high
nibble. The format was first documented by
[stascorp/7thLevelFile](https://github.com/stascorp/7thLevelFile); the
extractor's decoder is written from the standard IMA tables. All 592 sounds
decode to about 45 minutes of audio with no DC drift.

## Tables (type 11)

The scripts' data tables: menu layouts, unit and mission settings, key
bindings and the like. RTLIB32's builtins `TableGet`, `TableSet`,
`TableDim` and `TableNumDims` read them
([rtlib32-names.md](../rtlib32-names.md)); the browser engine's reader is
`table()` in `web/src/builtins.js`.

```
u32 pointer          left over from the authoring tool; ignored
u32 data bytes       resource size - 60
u32 0
u32 resource id      the table's own id
u32 dimensions       n: 1 (142 tables), 2 (527) or 3 (40)
u32 stride[5]        per dimension, in elements (first n used; last is 1)
u32 size[5]          per dimension, from offset 0x28 (first n used)
i32 data[]           size[0] x size[1] x ... elements, after the 60-byte header
```

Element `[i, j, ...]` is `data[stride[0]*i + stride[1]*j + ...]`. All 709
tables check out this way.

## Still unknown

Nothing in the resource formats. Some header words (the `u16` and `u32`
fields marked `?` in the sound header) are still unnamed.
