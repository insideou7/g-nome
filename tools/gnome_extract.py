#!/usr/bin/env python3
"""Extract every resource listed in G-NOME.BIN.

G-NOME.BIN is the game's master index. Its resource table holds 9,440
entries, each pointing at a byte range in one of the G-NOME.### pack files.
This tool copies every entry out as a raw file and converts the formats we
understand:

  * sounds (type 12) -> .wav, decoding 7th Level ADPCM
  * bitmaps (type 1) and textures (type 2) -> .png
  * 3D models (types 7 and 8) -> .obj + .mtl, textured with those PNGs
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


TEXTURE_KIND = 61


def texture_records(data: bytes) -> list:
    """A type 2 resource is a list of textures, each one:
        u32 kind (61), u32 size of the rest of the record,
        u32 path length, the original .BMP path, then a bitmap.
    Returns [(path, Bitmap)], or [] for the 34 resources in another format."""
    out, p = [], 0
    while p + 12 <= len(data):
        kind, size, path_len = struct.unpack_from("<III", data, p)
        end = p + 4 + size
        if kind != TEXTURE_KIND or end > len(data) or 12 + path_len > 4 + size:
            return []
        path = data[p + 12:p + 12 + path_len].split(b"\0")[0].decode("latin-1")
        out.append((path, parse_bitmap(data[p + 12 + path_len:end])))
        p = end
    return out if p == len(data) else []


def bmp_name(path: str) -> str:
    """\\7thlevel\\...\\FOO.BMP -> FOO.BMP"""
    return path.replace("\\", "/").split("/")[-1]


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


def _lzw_chunk(data: bytes, bits: int) -> bytearray:
    """Decode one LZW chunk: fixed-width codes, MSB first, codes 0-255 are
    bytes, new strings start at 256, the all-ones code ends the chunk. There
    is no reset code; the table just stops growing when full."""
    end = (1 << bits) - 1
    prefix, suffix = [0] * end, bytearray(end)
    out = bytearray()
    pos = acc = nacc = 0

    def code() -> int:
        nonlocal pos, acc, nacc
        while nacc < bits:
            acc = (acc << 8) | data[pos]
            pos += 1
            nacc += 8
        nacc -= bits
        c = (acc >> nacc) & end
        acc &= (1 << nacc) - 1
        return c

    def string(c: int) -> bytes:
        s = bytearray()
        while c > 0xFF:
            s.append(suffix[c])
            c = prefix[c]
        s.append(c)
        s.reverse()
        return bytes(s)

    old = code()
    if old == end:
        return out
    out.append(old)
    nxt = 256
    while True:
        c = code()
        if c == end:
            return out
        if c < nxt:
            s = string(c)
        else:  # the code being defined right now
            s = string(old)
            s += s[:1]
        out += s
        if nxt < end:
            prefix[nxt], suffix[nxt] = old, s[0]
            nxt += 1
        old = c


LZW_BITS = {0x4000: 10, 0x6000: 11, 0x8000: 12}


def decompress_packed(body: bytes) -> bytearray:
    """Decode RTLIB32's DecompressBitmapData stream.

    A list of blocks, each with a u16 header: the top 3 bits are the method,
    the low 13 bits the block's byte size. 0x0000 stores bytes as is, 0x4000,
    0x6000 and 0x8000 hold LZW chunks (u16 size + data each) with 10, 11 and
    12 bit codes, and 0xE000 ends the stream.
    """
    out = bytearray()
    p = 0
    while True:
        (head,) = struct.unpack_from("<H", body, p)
        p += 2
        method, size = head & 0xE000, head & 0x1FFF
        if method == 0xE000:
            return out
        block = body[p:p + size]
        p += size
        if method == 0:
            out += block
            continue
        if method not in LZW_BITS:
            raise ValueError(f"unknown packing method {method:#x}")
        q = 0
        while q < len(block):
            (n,) = struct.unpack_from("<H", block, q)
            out += _lzw_chunk(block[q + 2:q + 2 + n], LZW_BITS[method])
            q += 2 + n


def bitmap_pixels(bm: Bitmap) -> bytes:
    """width*height palette indices for either bitmap encoding."""
    if bm.flags & FLAG_RLE:
        return bytes(decode_rle(bm))
    # Packed bitmaps are DIB-style rows padded to 4 bytes, top row first.
    raw = decompress_packed(bm.body)
    stride = (bm.width + 3) & ~3
    if len(raw) < stride * bm.height:
        raise ValueError(f"packed bitmap decoded to {len(raw)} bytes, "
                         f"expected {stride * bm.height}")
    return b"".join(raw[r * stride:r * stride + bm.width] for r in range(bm.height))


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
# 3D models (types 7 MODL and 8 MPRT)
# ---------------------------------------------------------------------------

# After the 4 byte tag and a u32, a model is a stream of u32 opcodes, each
# followed by fixed arguments. It mirrors RenderWare's RWX script commands.
# Argument kinds: f float, i int, P count-prefixed int list, s texture path
# (only present when the preceding int is not 0; NUL-terminated, padded to 4).
MODEL_OPS = {
    0x1A: ("modelbegin", ""), 0x1B: ("modelend", ""),
    0x06: ("clumpbegin", ""), 0x07: ("clumpend", ""),
    0x35: ("transformbegin", ""), 0x36: ("transformend", ""),
    0x34: ("transform", "f" * 16),
    0x3B: ("vertex", "fff"), 0x3C: ("vertexext", "fff"),
    0x12: ("uv", "ff"), 0x14: ("vertexend", ""),
    0x39: ("triangle", "iii"), 0x23: ("quad", "iiii"), 0x1D: ("polygon", "P"),
    0x2C: ("color", "fff"), 0x08: ("surface", "fff"), 0x1C: ("opacity", "f"),
    0x2E: ("texture", "is"),
    # Int settings whose meaning is not known yet.
    0x04: ("op04", "i"), 0x0D: ("op0d", "i"), 0x0F: ("op0f", "i"),
    0x16: ("op16", "i"), 0x19: ("op19", "i"), 0x2D: ("op2d", "i"),
    0x32: ("op32", "i"),
}


def model_ops(data: bytes) -> list:
    """Split a MODL/MPRT resource into (name, args) tuples."""
    p, ops = 8, []
    while p < len(data):
        (op,) = struct.unpack_from("<I", data, p)
        p += 4
        if op not in MODEL_OPS:
            raise ValueError(f"unknown model opcode {op:#x} at {p - 4:#x}")
        name, kinds = MODEL_OPS[op]
        args = []
        for k in kinds:
            if k == "f":
                args.append(struct.unpack_from("<f", data, p)[0])
                p += 4
            elif k == "i":
                args.append(struct.unpack_from("<i", data, p)[0])
                p += 4
            elif k == "P":
                (n,) = struct.unpack_from("<I", data, p)
                args.append(list(struct.unpack_from(f"<{n}I", data, p + 4)))
                p += 4 + 4 * n
            elif k == "s" and args[-1]:
                z = data.index(b"\0", p)
                args.append(data[p:z].decode("latin-1"))
                p = (z + 4) & ~3
        ops.append((name, args))
    if p != len(data):
        raise ValueError("model stream overruns the resource")
    return ops


def _matmul(a: list, b: list) -> list:
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def model_to_obj(data: bytes, name: str, texture_pngs: dict) -> tuple:
    """Convert a model to Wavefront OBJ and MTL text.

    Each clump has its own 1-based vertex list. A transform (a 4x4 matrix
    for row vectors, translation in the last row) applies to the clumps
    that follow it, inside the parent clump's space. texture_pngs maps an
    upper-case .BMP file name to a PNG path for the material file.
    """
    obj = [f"# {name}, converted by tools/gnome_extract.py", f"mtllib {name}.mtl"]
    mtl = [f"# materials for {name}"]
    materials = {}
    color, opacity, texture = (0.8, 0.8, 0.8), 1.0, ""
    current_mtl = None
    ctm, ctm_stack = IDENTITY, []
    world, world_stack = IDENTITY, []
    verts, vert_stack = [], []
    nv = nvt = 0
    clump_no = 0
    pending = None  # [x, y, z, uv or None] until the vertex is complete

    def flush_vertex():
        nonlocal pending, nv, nvt
        if pending is None:
            return
        x, y, z, uv = pending
        m = _matmul(ctm, world)
        wx = x * m[0] + y * m[4] + z * m[8] + m[12]
        wy = x * m[1] + y * m[5] + z * m[9] + m[13]
        wz = x * m[2] + y * m[6] + z * m[10] + m[14]
        obj.append(f"v {wx:.6f} {wy:.6f} {wz:.6f}")
        nv += 1
        vt = None
        if uv is not None:
            obj.append(f"vt {uv[0]:.6f} {1 - uv[1]:.6f}")
            nvt += 1
            vt = nvt
        verts.append((nv, vt))
        pending = None

    def use_material():
        nonlocal current_mtl
        key = (color, opacity, texture)
        if key not in materials:
            mname = f"mat{len(materials)}"
            materials[key] = mname
            mtl.extend([f"newmtl {mname}", "Kd %.4f %.4f %.4f" % color,
                        f"d {opacity:.4f}"])
            if texture:
                png = texture_pngs.get(texture.upper())
                mtl.append(f"map_Kd {png}" if png else f"# texture {texture} not found")
        if materials[key] != current_mtl:
            current_mtl = materials[key]
            obj.append(f"usemtl {current_mtl}")

    def face(idx: list):
        flush_vertex()
        use_material()
        refs = []
        for i in idx:
            if not 1 <= i <= len(verts):
                raise ValueError(f"face uses vertex {i} of {len(verts)}")
            v, vt = verts[i - 1]
            refs.append(f"{v}/{vt}" if vt else str(v))
        obj.append("f " + " ".join(refs))

    for op, args in model_ops(data):
        if op in ("vertex", "vertexext"):
            flush_vertex()
            pending = [*args, None]
        elif op == "uv" and pending is not None:
            pending[3] = args
        elif op == "vertexend":
            flush_vertex()
        elif op == "triangle" or op == "quad":
            face(args)
        elif op == "polygon":
            face(args[0])
        elif op == "clumpbegin":
            flush_vertex()
            world_stack.append(world)
            vert_stack.append(verts)
            world, ctm, verts = _matmul(ctm, world), IDENTITY, []
            clump_no += 1
            obj.append(f"o clump{clump_no}")
        elif op == "clumpend":
            flush_vertex()
            world, verts = world_stack.pop(), vert_stack.pop()
        elif op == "transformbegin":
            ctm_stack.append(ctm)
        elif op == "transformend":
            ctm = ctm_stack.pop()
        elif op == "transform":
            ctm = list(args)
        elif op == "color":
            color = tuple(round(c, 4) for c in args)
        elif op == "opacity":
            opacity = round(args[0], 4)
        elif op == "texture":
            texture = bmp_name(args[1]) if args[0] else ""
    flush_vertex()
    return "\n".join(obj) + "\n", "\n".join(mtl) + "\n"


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


def texture_png_name(e: Entry, path: str) -> str:
    stem = bmp_name(path).rsplit(".", 1)[0] or "unnamed"
    return f"{e.index:04d}-{stem}.png"


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

    # Models name their textures by the original .BMP file name, and the
    # type 2 textures carry that name, so map one to the other's PNG.
    texture_pngs = {}
    for e in entries:
        if e.type == 2 and e.size:
            try:
                records = texture_records(packs.read(e))
            except (OSError, ValueError, struct.error):
                continue
            for path, _bm in records:
                name = bmp_name(path)
                texture_pngs.setdefault(name.upper(),
                                        f"../png/texture/{texture_png_name(e, path)}")

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
            if e.type == 1 and data:
                bm = parse_bitmap(data)
                row.update(width=bm.width, height=bm.height, x=bm.x, y=bm.y,
                           flags=hex(bm.flags))
                if not raw_only:
                    rel = Path("png") / "bitmap" / f"{e.index:04d}.png"
                    (out / rel).parent.mkdir(parents=True, exist_ok=True)
                    write_png(out / rel, bm.width, bm.height, bitmap_pixels(bm), palette)
                    row["converted"] = rel.as_posix()
            elif e.type == 2 and data:
                records = texture_records(data)
                if not records:
                    row["note"] = "not a texture list; kept raw"
                row["source_path"] = ";".join(path for path, _ in records)
                if records:
                    bm = records[0][1]
                    row.update(width=bm.width, height=bm.height, flags=hex(bm.flags))
                done = []
                for path, bm in records if not raw_only else []:
                    rel = Path("png") / "texture" / texture_png_name(e, path)
                    (out / rel).parent.mkdir(parents=True, exist_ok=True)
                    write_png(out / rel, bm.width, bm.height, bitmap_pixels(bm), palette)
                    done.append(rel.as_posix())
                row["converted"] = ";".join(done)
            elif e.type in (7, 8) and not raw_only:
                name = f"{e.index:04d}"
                obj, mtl = model_to_obj(data, name, texture_pngs)
                rel = Path("obj") / f"{name}.obj"
                (out / rel).parent.mkdir(parents=True, exist_ok=True)
                (out / rel).write_text(obj)
                (out / rel).with_suffix(".mtl").write_text(mtl)
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
                    help="only copy raw resources, skip WAV/PNG/OBJ conversion")
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
