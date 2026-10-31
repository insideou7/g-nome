#!/usr/bin/env python3
"""Disassemble the script bytecode in a 7th Level Runtime Player .BIN file.

Format notes are in docs/rtlib32-engine.md. Everything here was read out of
RTLIB32.DLL (G-Nome build, Feb 1997) with REA + Ghidra.

Usage:
  python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --summary
  python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --script 1
  python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --all > scripts.txt
  python3 -I tools/r32script.py game/g-nome/G-NOME/G-NOME.BIN --externs
"""
import argparse
import struct
import sys
from collections import Counter

# ---------------------------------------------------------------- container

HEADER_KEYS = 0x138      # 14 x {u32 offset, u32 size} "key resources"
NUM_KEYS = 14
KEY_INDEX = 0            # resource table, 10-byte entries
KEY_SCRIPT_BUF = 5       # resident resources (types 13..22) live here
KEY_PLUGINS = 10         # NUL-separated plugin names -> "%s.r32"
KEY_EXTERN_NAMES = 11    # NUL-separated exported function names
KEY_EXTERN_PLUGIN = 12   # u32 plugin index per extern name

TYPE_SCRIPT = 0x13
EXTERN_BASE = 0xFA       # call ids >= 0xFA are plugin externs
LOCAL_BASE = 0x13FE      # variable ids >= this are frame locals


class BinFile:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        if self.data[:2] != b"7L":
            raise ValueError("not a 7th Level .BIN (no '7L' magic)")
        self.keys = [struct.unpack_from("<II", self.data, HEADER_KEYS + 8 * i)
                     for i in range(NUM_KEYS)]
        off, size = self.keys[KEY_INDEX]
        self.entries = [struct.unpack_from("<HII", self.data, off + 10 * i)
                        for i in range(size // 10)]
        self.plugins = self._strings(KEY_PLUGINS)
        self.extern_names = self._strings(KEY_EXTERN_NAMES)
        off, size = self.keys[KEY_EXTERN_PLUGIN]
        self.extern_plugin = list(struct.unpack_from("<%dI" % (size // 4), self.data, off))

    def key(self, k):
        off, size = self.keys[k]
        return self.data[off:off + size]

    def _strings(self, k):
        raw = self.key(k)
        return [s.decode("latin-1") for s in raw.split(b"\0")[:-1]] if raw else []

    def rtype(self, rid):
        return self.entries[rid][0] & 0xFF

    def resident(self, rid):
        """Bytes of a resident resource (types 13..22), from the script buffer."""
        flags, off, size = self.entries[rid]
        base = self.keys[KEY_SCRIPT_BUF][0]
        return self.data[base + off:base + off + size]

    def extern_label(self, call_id):
        i = call_id - EXTERN_BASE
        if 0 <= i < len(self.extern_names):
            p = self.extern_plugin[i]
            plug = self.plugins[p] if p < len(self.plugins) else "?"
            return "%s.%s" % (plug, self.extern_names[i])
        return "extern_%d" % i


# ---------------------------------------------------------------- expressions
# One-byte opcodes, stack based. Read from FUN_10003330.

BINOPS = {
    0x12: "+", 0x13: "-", 0x14: "*", 0x15: "/", 0x16: "%",
    0x17: "==", 0x18: "<=", 0x19: "<", 0x1A: ">=", 0x1B: ">", 0x1C: "!=",
    0x1D: "&&", 0x1E: "||", 0x1F: "&", 0x20: "|", 0x21: "^",
    0x29: "<<", 0x2A: ">>",
}
UNOPS = {0x0F: "-", 0x10: "!", 0x11: "~"}


def var_name(v):
    return "L%d" % (v - LOCAL_BASE) if v >= LOCAL_BASE else "G%d" % v


class ExprError(Exception):
    pass


def decode_expr(bf, buf, pos):
    """Decode one expression. Returns (text, end_pos)."""
    st = []

    def pop():
        if not st:
            raise ExprError("stack underflow at %#x" % pos)
        return st.pop()

    while True:
        if pos >= len(buf):
            raise ExprError("expression runs off the end")
        op = buf[pos]
        pos += 1
        if op == 0x00:
            break
        if op == 0x01:
            st.append(str(struct.unpack_from("<i", buf, pos)[0])); pos += 4
        elif op == 0x02:
            st.append(var_name(struct.unpack_from("<I", buf, pos)[0])); pos += 4
        elif op == 0x04:
            st.append("&" + var_name(struct.unpack_from("<I", buf, pos)[0])); pos += 4
        elif op == 0x03:
            i = pop(); a = pop(); st.append("%s[%s]" % (a, i))
        elif op == 0x05:
            st.append("*(%s)" % pop())
        elif op == 0x06:
            i = pop(); a = pop(); st.append("&%s[%s]" % (a.lstrip("&"), i))
        elif op == 0x08:
            v = pop(); a = pop(); st.append("%s = %s" % (a.lstrip("&"), v))
        elif op == 0x0D:
            _unk, argc = struct.unpack_from("<II", buf, pos); pos += 8
            args = [pop() for _ in range(argc)][::-1]
            fid = pop()
            try:
                n = int(fid)
                name = bf.extern_label(n) if n >= EXTERN_BASE else "builtin_%#x" % n
            except ValueError:
                name = "call[%s]" % fid
            st.append("%s(%s)" % (name, ", ".join(args)))
        elif op == 0x0E:
            nlocals, argc = struct.unpack_from("<II", buf, pos); pos += 8
            args = [pop() for _ in range(argc)][::-1]
            sid = pop()
            st.append("script_%s(%s)" % (sid, ", ".join(args)))
        elif op in UNOPS:
            st.append("%s(%s)" % (UNOPS[op], pop()))
        elif op in BINOPS:
            b = pop(); a = pop(); st.append("(%s %s %s)" % (a, BINOPS[op], b))
        elif op in (0x22, 0x24):
            st.append("%s%s" % ("++" if op == 0x22 else "--", pop().lstrip("&")))
        elif op in (0x23, 0x25):
            st.append("%s%s" % (pop().lstrip("&"), "++" if op == 0x23 else "--"))
        elif op in (0x26, 0x27):
            # Short circuit: on true (0x26) or false (0x27), push the result
            # and skip forward by the u32 operand.
            skip = struct.unpack_from("<I", buf, pos)[0]; pos += 4
            st.append("%s %s" % (pop(), "||" if op == 0x26 else "&&"))
            _ = skip
        elif op == 0x28:
            st.append("*(%s)" % st[-1])
        else:
            raise ExprError("unknown expr op %#x" % op)
    # Short-circuit operands leave "a ||" fragments; join them up.
    text = " ".join(st)
    return text, pos


# ---------------------------------------------------------------- statements
# u16 opcode, then a fixed-size record. Sizes from FUN_1001f1f7.

FIXED = {
    0x02: 2, 0x04: 8, 0x0B: 0x1A, 0x0D: 8, 0x0E: 0x2E, 0x10: 0x26, 0x11: 0x14,
    0x14: 8, 0x17: 0x20, 0x1A: 0xC, 0xCA: 0xC, 0x1B: 4, 0x1C: 0xC, 0x1E: 0xC,
    0x23: 6, 0x2B: 0x12, 0x2C: 0x16, 0x36: 0x14, 0x39: 2, 0x3A: 0x12,
    0x3C: 6, 0x3D: 6, 0x3E: 6, 0x3F: 0x18, 0x40: 0x28, 0x42: 0x12, 0x48: 0x32,
    0x4D: 0x10, 0x53: 0x12, 0x59: 0x1A, 0x5A: 0x12, 0x5C: 0xC, 0x5E: 0x1C,
    0x60: 0x10, 0x61: 0xC, 0x63: 0x14, 0x65: 0xC, 0x6A: 0xC, 0x6B: 0x12,
    0x6D: 8, 0x71: 0xC, 0x72: 6, 0x74: 8, 0x75: 8, 0xDF: 8, 0x78: 8, 0x7A: 4,
    0x7C: 0x12, 0x8A: 8, 0x8E: 4, 0x8F: 0x10, 0x91: 0x26, 0x95: 0x12,
    0x99: 0x10, 0x9A: 0x1E, 0x9C: 0x10, 0xE4: 0x10, 0xA3: 2, 0xA4: 0x1E,
    0xA7: 0x1E, 0xA9: 0x22, 0xB3: 0x12, 0xB4: 8, 0xB7: 0xC, 0xB8: 0x12,
    0xB9: 0xE, 0xC0: 0x32, 0xC2: 0x12, 0xC3: 0xC, 0xC4: 0x12, 0xC6: 9,
    0xD2: 4, 0xD3: 8, 0xD4: 0xC, 0xD5: 0xE, 0xD6: 0xE, 0xD9: 0x12, 0xDE: 0x12,
    0xE0: 0x2E, 0xE1: 0xC, 0xE6: 0x12,
}

# Names for the statements whose meaning is clear from the handler.
NAMES = {
    0x01: "spawn", 0x39: "quit", 0x3A: "set_quit_scene", 0x3E: "trace",
    0x59: "if_cmp_call", 0x5A: "if_cmp_goto", 0x5B: "if", 0x5C: "if_loaded_call",
    0x68: "goto", 0x72: "set_flag_3cf7", 0x7A: "audio_mute", 0xA1: "return",
    0xA2: "end", 0xAF: "expr", 0xC6: "key_event", 0xDA: "switch_var",
    0xDB: "switch", 0xE3: "if",
}


def s32(b, o):
    return struct.unpack_from("<i", b, o)[0]


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def decode_stmt(bf, buf, pos):
    """Returns (length, text). Raises on anything unknown."""
    op = struct.unpack_from("<H", buf, pos)[0]
    name = NAMES.get(op, "op_%02x" % op)
    if op in FIXED:
        n = FIXED[op]
        return n, "%-14s %s" % (name, buf[pos + 2:pos + n].hex(" "))
    if op == 0x01:
        n = buf[pos + 9] * 4 + 10
        return n, "%-14s %s" % (name, buf[pos + 2:pos + n].hex(" "))
    if op in (0x5B, 0xE3):
        f, t = s32(buf, pos + 2), s32(buf, pos + 6)
        e, end = decode_expr(bf, buf, pos + 10)
        return t, "%-14s %s  else->%+d" % (name, e, f)
    if op == 0x68:
        return s32(buf, pos + 2), "%-14s %+d" % (name, s32(buf, pos + 2))
    if op == 0xAF:
        n = u32(buf, pos + 2)
        e, _ = decode_expr(bf, buf, pos + 6)
        return n, "%-14s %s" % (name, e)
    if op == 0xA1:
        n = u32(buf, pos + 2)
        e, _ = decode_expr(bf, buf, pos + 6)
        return n, "%-14s %s" % (name, e)
    if op == 0xA2:
        return 2, name
    if op in (0xDA, 0xDB):
        tab, dflt, ncase = u32(buf, pos + 6), s32(buf, pos + 10), buf[pos + 14]
        if op == 0xDB:
            subj, _ = decode_expr(bf, buf, pos + 0x10)
        else:
            subj = var_name(u32(buf, pos + 2)) if buf[pos + 15] else str(u32(buf, pos + 2))
        cases = []
        for i in range(ncase):
            c = pos + tab + 12 * i
            val = u32(buf, c + 2)
            val = var_name(val) if buf[c + 10] else str(s32(buf, c + 2))
            cases.append("%s:%+d" % (val, s32(buf, c + 6)))
        return tab + 12 * ncase, "%-14s %s {%s} default:%+d" % (
            name, subj, ", ".join(cases), dflt)
    raise ExprError("unknown statement op %#x" % op)


def disassemble(bf, buf):
    pos, out = 0, []
    while pos < len(buf):
        n, text = decode_stmt(bf, buf, pos)
        out.append((pos, text))
        if n <= 0:
            # goto with a back/zero jump: fall through to the next record
            n = 6
        pos += n
    return out


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("bin")
    ap.add_argument("--script", type=int, action="append", help="resource id")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--externs", action="store_true")
    a = ap.parse_args()
    bf = BinFile(a.bin)

    if a.externs:
        for i, nm in enumerate(bf.extern_names):
            print("%#05x  %-8s %s" % (EXTERN_BASE + i, bf.plugins[bf.extern_plugin[i]], nm))
        return

    scripts = [i for i in range(len(bf.entries)) if bf.rtype(i) == TYPE_SCRIPT]
    if a.summary:
        ops, bad, ok = Counter(), [], 0
        for rid in scripts:
            buf = bf.resident(rid)
            try:
                pos = 0
                while pos < len(buf):
                    op = struct.unpack_from("<H", buf, pos)[0]
                    n, _ = decode_stmt(bf, buf, pos)
                    ops[op] += 1
                    pos += n if n > 0 else 6
                ok += pos == len(buf)
                if pos != len(buf):
                    bad.append((rid, "overran by %d" % (pos - len(buf))))
            except (ExprError, struct.error, IndexError) as e:
                bad.append((rid, str(e)))
        print("plugins:", ", ".join(p + ".r32" for p in bf.plugins))
        print("externs: %d" % len(bf.extern_names))
        print("scripts: %d, parsed exactly to their size: %d" % (len(scripts), ok))
        for rid, why in bad[:20]:
            print("  script %d: %s" % (rid, why))
        print("statement opcodes used:")
        for op, n in sorted(ops.items()):
            print("  %#04x %-14s %6d" % (op, NAMES.get(op, ""), n))
        return

    for rid in (scripts if a.all else (a.script or [])):
        print("; script %d (%d bytes)" % (rid, len(bf.resident(rid))))
        try:
            for pos, text in disassemble(bf, bf.resident(rid)):
                print("  %04x  %s" % (pos, text))
        except (ExprError, struct.error, IndexError) as e:
            print("  !! %s" % e)
        print()


if __name__ == "__main__":
    sys.exit(main())
