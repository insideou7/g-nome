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
| 1 | 1,240 | Bitmap (sprites, UI, portraits, maps) | `.png` for RLE bitmaps |
| 2 | 835 | Texture: original `.BMP` path plus a bitmap. 211 are empty. | `.png` for RLE textures |
| 4 | 333 | `FRME` chunk, animation frames | raw |
| 7 | 647 | `MODL` chunk, 3D model | raw |
| 8 | 154 | `MPRT` chunk, model part | raw |
| 9 | 426 | `OB3D` chunk, 3D object definition | raw |
| 10 | 57 | `OPRT` chunk, object part | raw |
| 11 | 709 | Unknown structured records | raw |
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
u32 flags     0x80 = RLE (1,168 bitmaps); 0 = another packed format (72)
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

Flag 0 bitmaps (including the 640x480 screens) use a bit-level compression
that is not decoded yet; the extractor keeps them raw.

## Textures (type 2)

```
u32 kind       61 for the 590 textures that wrap a bitmap
u32 size       payload size
u32 path_len
char path[path_len]   e.g. \7thlevel\gnome\src\data\bitmaps\mesoonbl.BMP
```

For kind 61 a type 1 bitmap follows the path. 559 of these are RLE and 31
use the flag 0 format. Many textures stack two colour variants (a red team
and a green team version) in one tall image. The 34 textures with other kind
values are kept raw.

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

## Still unknown

- The flag 0 bitmap compression (103 bitmaps and textures).
- Type 11 records, and the `FRME`, `MODL`, `MPRT`, `OB3D` and `OPRT` chunk
  layouts. These are probably RenderWare-related data read by `RENDER.R32`.
- Whether some scenes swap in another palette.
- The script section, which `RTLIB32.DLL` runs.
