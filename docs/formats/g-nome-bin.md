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

Every entry is in bounds and together they cover each pack with no gaps.
Ranges do overlap, because a sound (type 12) and its slices (types 13-21)
are both listed.

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
| 13-21 | 4,447 | Slices of sounds (a 38 byte header slice, then data slices). All but 44 sit inside a type 12 range; `manifest.csv` names the parent. | raw |

## Palette

Windows keeps palette slots 0-9 and 246-255 for its own colours, so the game
stores the 236 colours for slots 10-245. Each is 4 bytes: R, G, B, flags.
The palette section of `G-NOME.BIN` is one of these. The extractor renders
every bitmap with it and the standard Windows system colours for the reserved
slots. Colours check out by eye on UI art, photos and textures.

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

- The int settings in models, and what the OB3D record kinds 1, 6 and 8 mean
  (see [animation.md](animation.md)).
- Whether some scenes swap in another palette.
