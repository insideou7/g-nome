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


if __name__ == "__main__":
    unittest.main()
