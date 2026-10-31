#!/usr/bin/env python3
"""Extract every resource listed in G-NOME.BIN.

G-NOME.BIN is the game's master index. Its resource table holds 9,440
entries, each pointing at a byte range in one of the G-NOME.### pack files.
This tool copies every entry out as a raw file and converts the formats we
understand:

  * sounds (type 12) -> .wav, decoding 7th Level ADPCM
  * RLE bitmaps (type 1) and RLE textures (type 2) -> .png
  * the other sections of G-NOME.BIN (string tables, palette, script) -> raw

It also writes manifest.csv, one row per resource. The format notes are in
docs/formats/g-nome-bin.md.

Usage (from the repo root, after unzipping the game into game/):
    python tools/gnome_extract.py
    python tools/gnome_extract.py --raw-only
    python tools/gnome_extract.py --list | head
    python tools/gnome_extract.py --game path/to/G-NOME --out somewhere/

By default the game is looked for under the repo's game/ folder (any
subfolder holding G-NOME.BIN) and output goes to the repo's extracted/
folder. Both are git-ignored.

Only the standard library is used.
"""
import argparse
import csv
import struct
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# G-NOME.BIN layout
# ---------------------------------------------------------------------------

BIN_MAGIC = b"7L"
RES_TABLE_PTR = 0x138       # u32 offset, u32 size of the resource table
ENTRY = struct.Struct("<HII")  # flags (pack << 8 | type), offset, size

# Other (offset, size) pairs in the BIN header, found by inspection. Names are
# descriptive guesses from their contents.
BIN_SECTIONS = {
    0x150: "id-value-pairs",
    0x158: "strings",
    0x160: "script",
    0x168: "palette",
    0x188: "plugin-names",
    0x190: "function-names",
    0x198: "zero-pad",
}

TYPE_NAMES = {
    1: "bitmap",
    2: "texture",
    4: "frme",
    7: "modl",
    8: "mprt",
    9: "ob3d",
    10: "oprt",
    11: "type11",
    12: "sound",
    # 13-21 are slices of sounds: a header piece plus ADPCM data pieces that
    # the game streams. All but 44 of them sit inside a type 12 sound.
    **{t: f"sound-part{t}" for t in range(13, 22)},
}

RAW_EXT = {1: "bmp7", 2: "tex7", 4: "frme", 7: "modl", 8: "mprt", 9: "ob3d",
           10: "oprt", 12: "7la"}


@dataclass
class Entry:
    index: int
    pack: int
    type: int
    offset: int
    size: int

    @property
    def type_name(self) -> str:
        return TYPE_NAMES.get(self.type, f"type{self.type}")

    @property
    def pack_name(self) -> str:
        return f"G-NOME.{self.pack:03d}"


def read_index(bin_data: bytes) -> list:
    if bin_data[:2] != BIN_MAGIC:
        raise ValueError("not a 7th Level .BIN file (no 7L magic)")
    table_off, table_size = struct.unpack_from("<II", bin_data, RES_TABLE_PTR)
    if table_size % ENTRY.size:
        raise ValueError(f"resource table size {table_size} is not a multiple of 10")
    entries = []
    for i in range(table_size // ENTRY.size):
        flags, off, size = ENTRY.unpack_from(bin_data, table_off + i * ENTRY.size)
        entries.append(Entry(i, flags >> 8, flags & 0xFF, off, size))
    return entries


def bin_sections(bin_data: bytes) -> dict:
    out = {}
    for ptr, name in BIN_SECTIONS.items():
        off, size = struct.unpack_from("<II", bin_data, ptr)
        if size and off + size <= len(bin_data):
            out[name] = bin_data[off:off + size]
    return out


# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

# Windows reserves palette slots 0-9 and 246-255 for system colours, so the
# game's palette (a section of G-NOME.BIN) holds the 236 colours for slots
# 10-245 as R, G, B, flags quads.
WIN_STATIC_LOW = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0),
                  (0, 0, 128), (128, 0, 128), (0, 128, 128), (192, 192, 192),
                  (192, 220, 192), (166, 202, 240)]
WIN_STATIC_HIGH = [(255, 251, 240), (160, 160, 164), (128, 128, 128),
                   (255, 0, 0), (0, 255, 0), (255, 255, 0), (0, 0, 255),
                   (255, 0, 255), (0, 255, 255), (255, 255, 255)]


def palette_from_236(data: bytes) -> list:
    if len(data) != 236 * 4:
        raise ValueError(f"expected a 944 byte palette, got {len(data)}")
    middle = [tuple(data[i:i + 3]) for i in range(0, len(data), 4)]
    return WIN_STATIC_LOW + middle + WIN_STATIC_HIGH


# ---------------------------------------------------------------------------
# Bitmaps
# ---------------------------------------------------------------------------

BITMAP_HDR = struct.Struct("<IIIiiI")  # width, height, flags, x, y, resource id
FLAG_RLE = 0x80


@dataclass
class Bitmap:
    width: int
    height: int
    flags: int
    x: int
    y: int
    res_id: int
    body: bytes  # everything after the 24 byte header


def parse_bitmap(data: bytes) -> Bitmap:
    w, h, flags, x, y, rid = BITMAP_HDR.unpack_from(data, 0)
    return Bitmap(w, h, flags, x, y, rid, data[BITMAP_HDR.size:])


def texture_bitmap(data: bytes):
    """A type 2 texture is u32 kind, u32 size, u32 path length, the original
    .BMP path, then (for kind 61) a bitmap. Returns (path, bitmap or None)."""
    if len(data) < 12:
        return "", None
    kind, _size, path_len = struct.unpack_from("<III", data, 0)
    if 12 + path_len > len(data):
        return "", None
    path = data[12:12 + path_len].split(b"\0")[0].decode("latin-1")
    if kind != 61:
        return path, None
    return path, parse_bitmap(data[12 + path_len:])


def decode_rle(bm: Bitmap) -> bytearray:
    """Decode an RLE bitmap (flags & 0x80) into width*height palette indices.

    After the header comes one u16 per row: that row's offset from the start
    of the offset table. Each row is a list of ops ending in 0x00:
      0x01-0x7F n, v  run of n pixels of colour v
      0x80-0xFE c     (0xFF - c) literal pixels follow
      0xFF n          n literal pixels follow
    Index 0 is transparent.
    """
    w, h, body = bm.width, bm.height, bm.body
    rows = struct.unpack_from(f"<{h}H", body, 0)
    out = bytearray(w * h)
    for r, start in enumerate(rows):
        p, x, base = start, 0, r * w
        while True:
            c = body[p]
            p += 1
            if c == 0:
                break
            if c < 0x80:
                out[base + x:base + x + c] = bytes([body[p]]) * c
                p += 1
                x += c
            else:
                n = body[p] if c == 0xFF else 0xFF - c
                if c == 0xFF:
                    p += 1
                out[base + x:base + x + n] = body[p:p + n]
                p += n
                x += n
        if x != w:
            raise ValueError(f"row {r} decoded to {x} pixels, expected {w}")
    return out


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, w: int, h: int, pixels: bytes, palette: list,
              transparent_zero: bool = True) -> None:
    """Write an 8-bit paletted PNG."""
    raw = b"".join(b"\0" + bytes(pixels[y * w:(y + 1) * w]) for y in range(h))
    plte = b"".join(bytes(c) for c in palette)
    parts = [b"\x89PNG\r\n\x1a\n",
             _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0)),
             _png_chunk(b"PLTE", plte)]
    if transparent_zero:
        parts.append(_png_chunk(b"tRNS", b"\0"))
    parts += [_png_chunk(b"IDAT", zlib.compress(raw, 9)), _png_chunk(b"IEND", b"")]
    path.write_bytes(b"".join(parts))


# ---------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------

# A type 12 sound is a 32 byte header and then the sample data:
#   u32 data size, u16 ?, u16 compressed (1 = ADPCM), u32 ?, u32 resource id,
#   then a WAVEFORMATEX (format tag, channels, rate, byte rate, align, bits)
#   describing the decoded PCM.
SOUND_HDR = struct.Struct("<IHHIIHHIIHH")

# 7th Level ADPCM is IMA ADPCM with no block headers: predictor and step
# index start at 0, the low nibble comes first, and stereo packs left in the
# low nibble and right in the high nibble. Format identified by Stas'M's
# 7thLevelFile (github.com/stascorp/7thLevelFile); this is an independent
# implementation from the standard IMA tables.
IMA_STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
    45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
    209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
    2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
    8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
    22385, 24623, 27086, 29794, 32767]
IMA_INDEX_ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8]
# DIFF[step_index][nibble & 7]
DIFF = [[(s >> 3) + (s if n & 4 else 0) + (s >> 1 if n & 2 else 0)
         + (s >> 2 if n & 1 else 0) for n in range(8)] for s in IMA_STEPS]


def decode_adpcm(data: bytes, channels: int) -> bytes:
    if channels not in (1, 2):
        raise ValueError(f"unsupported channel count {channels}")
    sample = [0, 0]
    index = [0, 0]
    out = bytearray()
    pack = struct.Struct("<h").pack

    def step(ch: int, nib: int) -> int:
        d = DIFF[index[ch]][nib & 7]
        s = sample[ch] - d if nib & 8 else sample[ch] + d
        s = -32768 if s < -32768 else 32767 if s > 32767 else s
        sample[ch] = s
        i = index[ch] + IMA_INDEX_ADJUST[nib & 7]
        index[ch] = 0 if i < 0 else 88 if i > 88 else i
        return s

    for b in data:
        if channels == 1:
            out += pack(step(0, b & 0xF))
            out += pack(step(0, b >> 4))
        else:
            out += pack(step(0, b & 0xF))
            out += pack(step(1, b >> 4))
    return bytes(out)


def sound_to_wav(data: bytes) -> bytes:
    (size, _u1, compressed, _u2, _rid, fmt, channels, rate, _brate, _align,
     bits) = SOUND_HDR.unpack_from(data, 0)
    body = data[SOUND_HDR.size:SOUND_HDR.size + size]
    if fmt != 1:
        raise ValueError(f"unknown wave format tag {fmt}")
    if compressed == 1:
        pcm, bits = decode_adpcm(body, channels), 16
    elif compressed == 0:
        pcm = body
    else:
        raise ValueError(f"unknown compression {compressed}")
    align = channels * bits // 8
    fmt_chunk = struct.pack("<HHIIHH", 1, channels, rate, rate * align, align, bits)
    return (b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt_chunk) + 8 + len(pcm))
            + b"WAVE" + b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def find_file(folder: Path, name: str) -> Path:
    """Find a file by name, ignoring case (CD copies are often lowercased)."""
    path = folder / name
    if path.exists():
        return path
    for p in folder.iterdir():
        if p.name.upper() == name.upper():
            return p
    raise FileNotFoundError(path)


class Packs:
    def __init__(self, folder: Path):
        self.folder = folder
        self._cache = {}

    def read(self, e: Entry) -> bytes:
        data = self._cache.get(e.pack)
        if data is None:
            path = find_file(self.folder, e.pack_name)
            # Packs are at most ~15 MB, so keeping them all is fine.
            data = self._cache[e.pack] = path.read_bytes()
        if e.offset + e.size > len(data):
            raise ValueError(f"#{e.index} runs past the end of {e.pack_name}")
        return data[e.offset:e.offset + e.size]


def find_parents(entries: list) -> dict:
    """Map each sound slice (types 13-21) to the type 12 sound that holds it."""
    sounds = {}
    for e in entries:
        if e.type == 12:
            sounds.setdefault(e.pack, []).append(e)
    parents = {}
    for e in entries:
        if 13 <= e.type <= 21:
            for s in sounds.get(e.pack, []):
                if s.offset <= e.offset and e.offset + e.size <= s.offset + s.size:
                    parents[e.index] = s.index
                    break
    return parents


def extract(game: Path, out: Path, raw_only: bool = False) -> int:
    bin_path = find_file(game, "G-NOME.BIN")
    bin_data = bin_path.read_bytes()
    entries = read_index(bin_data)
    sections = bin_sections(bin_data)
    palette = palette_from_236(sections["palette"])
    parents = find_parents(entries)
    packs = Packs(game)

    out.mkdir(parents=True, exist_ok=True)
    sec_dir = out / "bin-sections"
    sec_dir.mkdir(exist_ok=True)
    for name, data in sections.items():
        (sec_dir / f"{name}.bin").write_bytes(data)

    rows, errors = [], 0
    counts = {}
    for e in entries:
        row = {"index": e.index, "pack": e.pack_name, "offset": e.offset,
               "size": e.size, "type": e.type, "type_name": e.type_name,
               "raw": "", "converted": "", "width": "", "height": "",
               "x": "", "y": "", "flags": "", "source_path": "",
               "parent_sound": parents.get(e.index, ""), "note": ""}
        try:
            data = packs.read(e)
        except (OSError, ValueError) as exc:
            row["note"] = f"read error: {exc}"
            rows.append(row)
            errors += 1
            continue

        ext = RAW_EXT.get(e.type, "dat")
        raw_rel = Path("raw") / e.type_name / f"{e.index:04d}.{ext}"
        (out / raw_rel).parent.mkdir(parents=True, exist_ok=True)
        (out / raw_rel).write_bytes(data)
        row["raw"] = raw_rel.as_posix()
        counts[e.type_name] = counts.get(e.type_name, 0) + 1

        try:
            if e.type in (1, 2) and data:
                bm = None
                if e.type == 1:
                    bm = parse_bitmap(data)
                else:
                    row["source_path"], bm = texture_bitmap(data)
                if bm is not None:
                    row.update(width=bm.width, height=bm.height, x=bm.x, y=bm.y,
                               flags=hex(bm.flags))
                    if not bm.flags & FLAG_RLE:
                        row["note"] = "packed bitmap (flags 0), not decoded yet"
                    elif not raw_only:
                        rel = Path("png") / e.type_name / f"{e.index:04d}.png"
                        (out / rel).parent.mkdir(parents=True, exist_ok=True)
                        write_png(out / rel, bm.width, bm.height, decode_rle(bm), palette)
                        row["converted"] = rel.as_posix()
            elif e.type == 12 and not raw_only:
                rel = Path("wav") / f"{e.index:04d}.wav"
                (out / rel).parent.mkdir(parents=True, exist_ok=True)
                (out / rel).write_bytes(sound_to_wav(data))
                row["converted"] = rel.as_posix()
        except (ValueError, IndexError, struct.error) as exc:
            row["note"] = f"convert error: {exc}"
            errors += 1
        rows.append(row)

    with (out / "manifest.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    converted = sum(1 for r in rows if r["converted"])
    print(f"{len(entries)} resources from {len({e.pack for e in entries})} packs "
          f"-> {out}")
    for name in sorted(counts, key=lambda n: -counts[n]):
        print(f"  {name:14} {counts[name]}")
    print(f"converted {converted}, errors {errors}")
    return 1 if errors else 0


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GAME_ROOT = REPO_ROOT / "game"
DEFAULT_OUT = REPO_ROOT / "extracted"


def find_game_folder(root: Path) -> Path:
    """Return the folder under root that holds G-NOME.BIN (case-insensitive)."""
    hits = sorted(p.parent for p in root.rglob("*")
                  if p.is_file() and p.name.upper() == "G-NOME.BIN")
    if not hits:
        raise FileNotFoundError(
            f"no G-NOME.BIN under {root}. Unzip the game there, or pass --game.")
    return hits[0]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game", type=Path, default=DEFAULT_GAME_ROOT,
                    help="folder holding G-NOME.BIN, or a folder above it "
                         "(default: the repo's game/ folder)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="output folder (default: the repo's extracted/ folder)")
    ap.add_argument("--raw-only", action="store_true",
                    help="only copy raw resources, skip WAV/PNG conversion")
    ap.add_argument("--list", action="store_true",
                    help="print the index as TSV instead of extracting")
    args = ap.parse_args()

    try:
        game = find_game_folder(args.game)
    except FileNotFoundError as exc:
        ap.error(str(exc))
    if args.list:
        entries = read_index(find_file(game, "G-NOME.BIN").read_bytes())
        print("index\tpack\toffset\tsize\ttype")
        for e in entries:
            print(f"{e.index}\t{e.pack_name}\t{e.offset:#x}\t{e.size}\t{e.type_name}")
        return 0
    print(f"reading {game}")
    return extract(game, args.out, args.raw_only)


if __name__ == "__main__":
    sys.exit(main())
