"""Tests for tools/gnome_extract.py that need no game files.

Run with: python -m unittest discover tests
"""
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import gnome_extract as gx  # noqa: E402


class IndexTest(unittest.TestCase):
    def test_reads_entries(self):
        table = struct.pack("<HII", (3 << 8) | 12, 0x10, 0x20)
        table += struct.pack("<HII", (61 << 8) | 1, 0x30, 0x40)
        data = bytearray(0x1A8) + table
        data[0:2] = b"7L"
        struct.pack_into("<II", data, 0x138, 0x1A8, len(table))
        entries = gx.read_index(bytes(data))
        self.assertEqual([(e.pack, e.type, e.offset, e.size) for e in entries],
                         [(3, 12, 0x10, 0x20), (61, 1, 0x30, 0x40)])
        self.assertEqual(entries[1].pack_name, "G-NOME.061")
        self.assertEqual(entries[0].type_name, "sound")

    def test_rejects_other_files(self):
        with self.assertRaises(ValueError):
            gx.read_index(b"MZ" + bytes(0x200))


class RleTest(unittest.TestCase):
    def test_runs_and_literals(self):
        # Two 4-pixel rows. Row data is stored bottom row first.
        row1 = bytes([0x02, 0x05, 0xFE, 0x07, 0xFF, 0x01, 0x08, 0x00])  # 5 5 7 8
        row0 = bytes([0xFC, 1, 2, 3, 0x01, 0x09, 0x00])                 # 1 2 3 9
        table_len = 4
        offsets = struct.pack("<HH", table_len + len(row1), table_len)
        body = offsets + row1 + row0
        bm = gx.Bitmap(4, 2, 0x80, 0, 0, 0, body)
        self.assertEqual(bytes(gx.decode_rle(bm)), bytes([1, 2, 3, 9, 5, 5, 7, 8]))

    def test_bad_row_width(self):
        body = struct.pack("<H", 2) + bytes([0x03, 0x01, 0x00])
        with self.assertRaises(ValueError):
            gx.decode_rle(gx.Bitmap(4, 1, 0x80, 0, 0, 0, body))


class AdpcmTest(unittest.TestCase):
    def test_step_table_matches_7th_level(self):
        # First and last rows of the table in 7th Level's Audio Library.
        self.assertEqual(gx.DIFF[0], [0, 1, 3, 4, 7, 8, 10, 11])
        self.assertEqual(gx.DIFF[88], [4095, 12286, 20478, 28669,
                                       36862, 45053, 53245, 61436])

    def test_decode_mono(self):
        # 0x77: two +7 nibbles. Step index 0 -> +11, index 8 -> +30.
        pcm = gx.decode_adpcm(b"\x77", 1)
        self.assertEqual(struct.unpack("<2h", pcm), (11, 41))

    def test_decode_stereo_and_clamp(self):
        pcm = gx.decode_adpcm(b"\x8f" * 40, 2)
        left = struct.unpack(f"<{len(pcm) // 2}h", pcm)[0::2]
        right = struct.unpack(f"<{len(pcm) // 2}h", pcm)[1::2]
        self.assertTrue(all(b <= a for a, b in zip(left, left[1:])))
        self.assertEqual(min(left), -32768)
        self.assertTrue(all(r <= 0 for r in right))

    def test_wav_header(self):
        hdr = struct.pack("<IHHIIHHIIHH", 2, 0x101, 1, 0, 25, 1, 1, 22050,
                          44100, 2, 16)
        wav = gx.sound_to_wav(hdr + b"\x77\x77")
        self.assertEqual(wav[:4], b"RIFF")
        self.assertEqual(wav[8:16], b"WAVEfmt ")
        rate, = struct.unpack_from("<I", wav, 24)
        self.assertEqual(rate, 22050)
        self.assertEqual(struct.unpack_from("<I", wav, 40)[0], 8)  # 4 samples


class PaletteTest(unittest.TestCase):
    def test_236_colours_fill_slots_10_to_245(self):
        data = b"".join(bytes([i, i, i, 0]) for i in range(236))
        pal = gx.palette_from_236(data)
        self.assertEqual(len(pal), 256)
        self.assertEqual(pal[10], (0, 0, 0))
        self.assertEqual(pal[245], (235, 235, 235))
        self.assertEqual(pal[255], (255, 255, 255))


def pack_codes(codes, bits):
    acc = n = 0
    out = bytearray()
    for c in codes:
        acc = (acc << bits) | c
        n += bits
        while n >= 8:
            n -= 8
            out.append((acc >> n) & 0xFF)
    if n:
        out.append((acc << (8 - n)) & 0xFF)
    return bytes(out)


class PackedBitmapTest(unittest.TestCase):
    def test_lzw_chunk(self):
        # A, B, then code 256 (= "AB"), then 258 (the code being defined, "ABA").
        data = pack_codes([65, 66, 256, 258, 1023], 10)
        self.assertEqual(bytes(gx._lzw_chunk(data, 10)), b"ABABABA")

    def test_stream_and_row_padding(self):
        chunk = pack_codes([1, 2, 3, 2047], 11)
        lzw_block = struct.pack("<H", len(chunk)) + chunk
        stored = bytes([4, 5, 6, 7, 8])
        body = (struct.pack("<H", 0x6000 | len(lzw_block)) + lzw_block
                + struct.pack("<H", len(stored)) + stored + struct.pack("<H", 0xE000))
        self.assertEqual(bytes(gx.decompress_packed(body)), bytes(range(1, 9)))
        # 3x2 image: rows are padded to 4 bytes and stored bottom row first.
        bm = gx.Bitmap(3, 2, 0, 0, 0, 0, body)
        self.assertEqual(gx.bitmap_pixels(bm), bytes([5, 6, 7, 1, 2, 3]))


def op(code, fmt="", *args):
    return struct.pack("<I" + fmt, code, *args)


class ModelTest(unittest.TestCase):
    def model(self):
        ident_moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]
        path = b"\\x\\WALL.BMP\0"
        path += b"\0" * (-len(path) % 4)
        body = op(0x1A) + op(0x06)
        body += op(0x35) + op(0x34, "16f", *ident_moved) + op(0x06)
        for x, y in [(0, 0), (1, 0), (1, 1), (0, 1)]:
            body += op(0x3C, "3f", x, y, 0) + op(0x12, "2f", x, y) + op(0x14)
        body += op(0x2C, "3f", 1, 0, 0) + op(0x2E, "i", 8) + path
        body += op(0x23, "4i", 1, 2, 3, 4)
        body += op(0x07) + op(0x36) + op(0x07) + op(0x1B)
        return b"MODL" + bytes(4) + body

    def test_ops(self):
        names = [n for n, _ in gx.model_ops(self.model())]
        self.assertEqual(names[:5], ["modelbegin", "clumpbegin", "transformbegin",
                                     "transform", "clumpbegin"])
        self.assertIn(("texture", [8, "\\x\\WALL.BMP"]), gx.model_ops(self.model()))

    def test_obj(self):
        obj, mtl = gx.model_to_obj(self.model(), "m", {"WALL.BMP": "wall.png"})
        lines = obj.splitlines()
        self.assertIn("v 10.000000 0.000000 0.000000", lines)
        self.assertIn("vt 1.000000 0.000000", lines)  # v is flipped for OBJ
        self.assertIn("f 1/1 2/2 3/3 4/4", lines)
        self.assertIn("map_Kd wall.png", mtl)
        self.assertIn("Kd 1.0000 0.0000 0.0000", mtl)


if __name__ == "__main__":
    unittest.main()
