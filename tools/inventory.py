#!/usr/bin/env python3
"""Print a quick inventory of a game folder.

For each file: size, a guess at its type from the first bytes, and for
Windows PE files the machine, imports and exports.

Usage: python tools/inventory.py game/G-NOME [--pe-details]
"""
import argparse
import sys
from pathlib import Path

try:
    import pefile
except ImportError:
    pefile = None

MAGICS = [
    (b"MZ", "PE/MZ executable"),
    (b"SMK2", "Smacker video"),
    (b"SMK4", "Smacker video"),
    (b"RIFF", "RIFF (WAV/AVI)"),
    (b"MODL", "MODL chunk (3D model?)"),
    (b"BM", "BMP image"),
    (b"PK\x03\x04", "ZIP"),
]


def guess(head: bytes) -> str:
    if not head:
        return "empty"
    for magic, name in MAGICS:
        if head.startswith(magic):
            return name
    printable = sum(32 <= b < 127 for b in head[:32])
    return f"unknown ({head[:8].hex(' ')}){' text-ish' if printable > 24 else ''}"


def pe_summary(path: Path) -> str:
    pe = pefile.PE(str(path), fast_load=True)
    pe.parse_data_directories(directories=[
        pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
        pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXPORT"],
    ])
    lines = [f"    machine={hex(pe.FILE_HEADER.Machine)} "
             f"image_base={hex(pe.OPTIONAL_HEADER.ImageBase)} "
             f"entry={hex(pe.OPTIONAL_HEADER.AddressOfEntryPoint)}"]
    for imp in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        lines.append(f"    imports {imp.dll.decode(errors='replace')}: {len(imp.imports)} symbols")
    exp = getattr(pe, "DIRECTORY_ENTRY_EXPORT", None)
    if exp:
        lines.append(f"    exports: {len(exp.symbols)} symbols")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    ap.add_argument("--pe-details", action="store_true", help="show PE imports/exports")
    args = ap.parse_args()
    for path in sorted(p for p in args.folder.rglob("*") if p.is_file()):
        with path.open("rb") as f:
            head = f.read(64)
        kind = guess(head)
        print(f"{path.relative_to(args.folder)}\t{path.stat().st_size}\t{kind}")
        if args.pe_details and kind.startswith("PE") and pefile:
            try:
                print(pe_summary(path))
            except pefile.PEFormatError as e:
                print(f"    not a PE: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
