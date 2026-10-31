#!/usr/bin/env python3
"""Rename RenderWare imports in a REA/Ghidra decompile of RENDER.R32.

RENDER.R32 loads RWL20.DLL with GetProcAddress into DAT_1004xxxx pointers
(FUN_10025193), so the decompile shows calls like (*DAT_100417a4)(). This
reads those assignments and writes a copy of every function with the
RenderWare names (RwScratchMatrix(...)) substituted.

Usage: python3 scripts/rw-import-names.py re-output/render
Output: re-output/render/named/*.c
"""
import glob
import os
import re
import sys

root = sys.argv[1] if len(sys.argv) > 1 else "re-output/render"
loader = os.path.join(root, "functions", "0x10025193.c")
names = dict(re.findall(r"_?(DAT_[0-9a-f]+) = GetProcAddress\([^,]+,s_(\w+?)_[0-9a-f]+\)", open(loader).read()))
out = os.path.join(root, "named")
os.makedirs(out, exist_ok=True)
for path in glob.glob(os.path.join(root, "functions", "*.c")):
    text = open(path).read()
    text = re.sub(r"\(\*_?(DAT_[0-9a-f]+)\)", lambda m: names.get(m.group(1), m.group(0)), text)
    text = re.sub(r"\b_?(DAT_100[34][0-9a-f]+)\b", lambda m: names.get(m.group(1), m.group(0)), text)
    open(os.path.join(out, os.path.basename(path)), "w").write(text)
print(f"{len(names)} RenderWare imports -> {out}")
