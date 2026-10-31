"""Checks the shared RTLIB32 name table (web/src/names.js). No game files needed.

Run with: python -m unittest discover tests
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import r32script as rs  # noqa: E402


class NamesTest(unittest.TestCase):
    def test_every_entry_parses(self):
        # Each "0x..: [" line in names.js must be picked up by the parser,
        # or the disassembler silently loses names.
        text = (ROOT / "web" / "src" / "names.js").read_text(encoding="utf-8")
        lines = [l for l in text.splitlines() if l.lstrip().startswith("0x")]
        self.assertEqual(len(lines), len(rs.BUILTINS) + len(rs.STATEMENTS))

    def test_counts(self):
        # 181 of the 247 builtin slots do something; 90 statement opcodes.
        self.assertEqual(len(rs.BUILTINS), 181)
        self.assertEqual(len(rs.STATEMENTS), 90)
        self.assertTrue(all(2 <= i < rs.EXTERN_BASE for i in rs.BUILTINS))

    def test_names_are_unique(self):
        names = [v[0] for v in rs.BUILTINS.values()]
        self.assertEqual(len(names), len(set(names)))

    def test_every_fixed_statement_is_named(self):
        self.assertEqual(set(rs.FIXED) - set(rs.STATEMENTS), set())

    def test_names_doc_is_current(self):
        doc = (ROOT / "docs" / "rtlib32-names.md").read_text(encoding="utf-8")
        self.assertEqual(doc.rstrip("\n"), rs.names_markdown(),
                         "run: python3 -I tools/r32script.py --names-md > docs/rtlib32-names.md")


if __name__ == "__main__":
    unittest.main()
