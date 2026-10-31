// The Runtime Player script VM (RTLIB32.DLL), reimplemented.
//
// docs/rtlib32-engine.md describes the bytecode. Addresses in comments are
// the original functions in the G-Nome build of RTLIB32.DLL.
//
// Memory model: the original scripts use real pointers (&G5, &L1, G13[i]),
// so the VM keeps every variable in one flat Int32Array and hands out byte
// addresses into it. Globals start at GLOBAL_BASE. Script frames grow down
// from the top: local k of the current frame is at fp - 4 * k.

import { BUILTIN_NAMES } from "./names.js";

export const LOCAL_BASE = 0x13fe; // variable ids >= this are frame locals
export const EXTERN_BASE = 0xfa; // call ids >= this are plugin externs
const MEM_WORDS = 1 << 20; // 4 MB
const GLOBAL_BASE = 0x1000; // byte address of G0
const STACK_TOP = (MEM_WORDS - 16) * 4;
const HEAP_BASE = GLOBAL_BASE + 4 * LOCAL_BASE + 0x1000;
const MAX_DEPTH = 30;

export class ScriptError extends Error {}

export class VM {
  constructor(bin, opts = {}) {
    this.bin = bin;
    this.mem = new Int32Array(MEM_WORDS);
    this.u8 = new Uint8Array(this.mem.buffer);
    this.stack = new Int32Array(4096);
    this.sp = 0;
    this.fp = STACK_TOP;
    this.depth = 0;
    this.retval = 0; // rt+0x3e1f
    this.abort = 0; // rt+0x3ccf: non-zero stops every running script
    this.current = 0; // rt+0x3e2b: id of the running script
    this.heap = HEAP_BASE;
    this.builtins = new Map(); // id -> fn(vm, args) -> int
    this.externs = []; // index -> fn(vm, args) -> int
    this.statements = new Map(); // op -> fn(vm, buf, pos, dv) -> {len, ok}
    this.log = opts.log || (() => {});
    this.trace = opts.trace || null; // fn(scriptId, pos, op)
    this.unknown = new Map(); // "kind:id" -> count, for reporting
    this.scriptCache = new Map();
    this.steps = 0;
    this.maxSteps = opts.maxSteps || 2e6; // per top-level run
    for (const [id, v] of bin.varInit) this.setGlobal(id, v);
  }

  // ------------------------------------------------------------ memory

  addrOf(id) {
    return id < LOCAL_BASE ? GLOBAL_BASE + 4 * id : this.fp - 4 * (id - LOCAL_BASE);
  }
  load(addr) {
    if (addr & 3 || addr <= 0 || addr >= MEM_WORDS * 4) throw new ScriptError(`bad load from ${addr}`);
    return this.mem[addr >> 2];
  }
  store(addr, v) {
    if (addr & 3 || addr <= 0 || addr >= MEM_WORDS * 4) throw new ScriptError(`bad store to ${addr}`);
    this.mem[addr >> 2] = v;
  }
  getVar(id) {
    return this.mem[this.addrOf(id) >> 2];
  }
  setVar(id, v) {
    this.mem[this.addrOf(id) >> 2] = v;
  }
  getGlobal(id) {
    return this.mem[(GLOBAL_BASE >> 2) + id];
  }
  setGlobal(id, v) {
    this.mem[(GLOBAL_BASE >> 2) + id] = v;
  }
  // Statement operands are a u32 plus an "is a variable" flag (0x10014e00).
  resolve(v, isVar) {
    return isVar ? this.getVar(v >>> 0) : v;
  }
  // Allocate zeroed bytes on the VM heap; returns a byte address.
  alloc(bytes) {
    const a = this.heap;
    this.heap += (bytes + 7) & ~7;
    if (this.heap >= STACK_TOP - 0x40000) throw new ScriptError("VM heap exhausted");
    return a;
  }
  // Copy bytes into VM memory (for pointers that natively pointed at data).
  allocBytes(bytes) {
    const a = this.alloc(bytes.length + 1);
    this.u8.set(bytes, a);
    return a;
  }
  cstring(addr) {
    let s = "";
    for (let i = addr; this.u8[i]; i++) s += String.fromCharCode(this.u8[i]);
    return s;
  }

  noteUnknown(kind, id) {
    const k = `${kind}:${id}`;
    const n = (this.unknown.get(k) || 0) + 1;
    this.unknown.set(k, n);
    if (n === 1) this.log(`unimplemented ${kind} ${id}`);
  }

  // ------------------------------------------------------------ scripts

  scriptBytes(id) {
    let s = this.scriptCache.get(id);
    if (!s) {
      if (this.bin.type(id) !== 19) throw new ScriptError(`resource ${id} is not a script`);
      const b = this.bin.resident(id);
      s = { b, dv: new DataView(b.buffer, b.byteOffset, b.byteLength) };
      this.scriptCache.set(id, s);
    }
    return s;
  }

  // [RunScript] 0x1001fcfe. Returns the status (0 = stop everything).
  runScript(id) {
    if (this.abort) return 0;
    if (this.bin.type(id) !== 19) {
      this.log(`run: resource ${id} is not a script`);
      return 0;
    }
    if (this.depth === 0) this.steps = 0;
    if (this.depth + 1 >= MAX_DEPTH) throw new ScriptError("scripts nested too deep");
    this.depth++;
    const saved = this.current;
    this.current = id;
    try {
      return this.execScript(id);
    } finally {
      this.current = saved;
      this.depth--;
    }
  }

  // [ExecScript] 0x1001fdc6
  execScript(id) {
    const { b, dv } = this.scriptBytes(id);
    let pos = 0;
    let ok = 1;
    while (pos >= 0 && pos < b.length) {
      if (++this.steps > this.maxSteps) throw new ScriptError(`script ${id}+${pos.toString(16)}: step limit hit (endless loop?)`);
      const r = this.execStmt(id, b, dv, pos);
      ok = r.ok;
      if (!ok || r.len === 0) break;
      pos += r.len;
    }
    return ok;
  }

  // [ExecStmt] 0x1001f1f7. Returns {ok, len}: len is how far to move.
  execStmt(id, b, dv, pos) {
    const op = dv.getUint16(pos, true);
    if (this.trace) this.trace(id, pos, op);
    let ok = 1;
    let len;
    switch (op) {
      case 0x68: // goto
        len = dv.getInt32(pos + 2, true);
        break;
      case 0x5b:
      case 0xe3: // if
        len = this.evalExpr(b, dv, pos + 10) ? dv.getInt32(pos + 6, true) : dv.getInt32(pos + 2, true);
        break;
      case 0xaf: // expression
        this.evalExpr(b, dv, pos + 6);
        len = dv.getUint32(pos + 2, true);
        break;
      case 0xa1: // return value
        this.retval = this.evalExpr(b, dv, pos + 6);
        len = 0;
        break;
      case 0xa2: // end
        len = 0;
        break;
      case 0xdb: // switch on an expression
      case 0xda: {
        // switch on a value/variable
        const subject = op === 0xdb ? this.evalExpr(b, dv, pos + 0x10) : this.resolve(dv.getUint32(pos + 2, true), b[pos + 0xf]);
        const tab = pos + dv.getUint32(pos + 6, true);
        const n = b[pos + 0xe];
        len = dv.getInt32(pos + 10, true);
        for (let i = 0; i < n; i++) {
          const c = tab + 12 * i;
          if (this.resolve(dv.getInt32(c + 2, true), b[c + 10]) === subject) {
            len = dv.getInt32(c + 6, true);
            break;
          }
        }
        break;
      }
      case 0x01: {
        // call a script with literal/variable args (0x10015ce6)
        len = b[pos + 9] * 4 + 10;
        const script = this.resolve(dv.getUint32(pos + 2, true), b[pos + 6]);
        const mask = b[pos + 7];
        const nlocals = b[pos + 8];
        const argc = b[pos + 9];
        const args = [];
        for (let i = 0; i < argc; i++) {
          const v = dv.getInt32(pos + 10 + 4 * i, true);
          args.push(mask & (1 << i) ? this.getVar(v >>> 0) : v);
        }
        ok = this.callScript(script, nlocals, args, false);
        break;
      }
      default: {
        const h = this.statements.get(op);
        if (!h) {
          throw new ScriptError(`script ${id}+${pos.toString(16)}: unknown statement ${op.toString(16)}`);
        }
        const r = h(this, b, dv, pos);
        len = r.len;
        if (r.ok === 0) ok = 0;
      }
    }
    if (this.abort) ok = 0;
    return { ok, len };
  }

  // Push a frame below the caller's `nlocals` locals, put args in L0..,
  // run the script, pop the frame. Returns the status; result in retval.
  callScript(script, nlocals, args) {
    const savedFp = this.fp;
    const newFp = this.fp - 4 * nlocals;
    for (let i = 0; i < args.length; i++) this.mem[(newFp - 4 * i) >> 2] = args[i];
    this.fp = newFp;
    try {
      return this.runScript(script);
    } finally {
      this.fp = savedFp;
    }
  }

  // ------------------------------------------------------------ expressions

  // [EvalExpr] 0x10003330. Returns the first value pushed.
  evalExpr(b, dv, p) {
    const st = this.stack;
    const base = this.sp;
    let sp = base;
    for (;;) {
      const op = b[p++];
      switch (op) {
        case 0x00:
          this.sp = base;
          return st[base];
        case 0x01:
          st[sp++] = dv.getInt32(p, true);
          p += 4;
          break;
        case 0x02:
          st[sp++] = this.mem[this.addrOf(dv.getUint32(p, true)) >> 2];
          p += 4;
          break;
        case 0x04:
          st[sp++] = this.addrOf(dv.getUint32(p, true));
          p += 4;
          break;
        case 0x03: // a[i]
          sp--;
          st[sp - 1] = this.load(st[sp - 1] + st[sp] * 4);
          break;
        case 0x05: // *a
          st[sp - 1] = this.load(st[sp - 1]);
          break;
        case 0x06: // &a[i]
          sp--;
          st[sp - 1] = st[sp - 1] + st[sp] * 4;
          break;
        case 0x08: // *a = b
          sp--;
          this.store(st[sp - 1], st[sp]);
          st[sp - 1] = st[sp];
          break;
        case 0x0d: {
          // call builtin / extern
          const argc = dv.getUint32(p + 4, true);
          p += 8;
          const fid = st[sp - 1 - argc];
          const args = Array.from(st.subarray(sp - argc, sp));
          this.sp = sp; // nested evaluation (callbacks) must not clobber us
          sp -= argc;
          st[sp - 1] = this.callFunction(fid, args) | 0;
          break;
        }
        case 0x0e: {
          // call script
          const nlocals = dv.getUint32(p, true);
          const argc = dv.getUint32(p + 4, true);
          p += 8;
          const args = Array.from(st.subarray(sp - argc, sp));
          sp -= argc;
          const sid = st[sp - 1];
          this.sp = sp;
          const savedRet = this.retval;
          this.retval = 0;
          this.callScript(sid, nlocals, args);
          st[sp - 1] = this.retval;
          this.retval = savedRet;
          break;
        }
        case 0x0f:
          st[sp - 1] = -st[sp - 1];
          break;
        case 0x10:
          st[sp - 1] = st[sp - 1] ? 0 : 1;
          break;
        case 0x11:
          st[sp - 1] = ~st[sp - 1];
          break;
        case 0x12:
          sp--;
          st[sp - 1] = st[sp - 1] + st[sp];
          break;
        case 0x13:
          sp--;
          st[sp - 1] = st[sp - 1] - st[sp];
          break;
        case 0x14:
          sp--;
          st[sp - 1] = Math.imul(st[sp - 1], st[sp]);
          break;
        case 0x15:
          sp--;
          if (!st[sp]) throw new ScriptError("divide by zero");
          st[sp - 1] = (st[sp - 1] / st[sp]) | 0;
          break;
        case 0x16:
          sp--;
          if (!st[sp]) throw new ScriptError("divide by zero");
          st[sp - 1] = st[sp - 1] % st[sp] | 0;
          break;
        case 0x17:
          sp--;
          st[sp - 1] = st[sp - 1] === st[sp] ? 1 : 0;
          break;
        case 0x18:
          sp--;
          st[sp - 1] = st[sp - 1] <= st[sp] ? 1 : 0;
          break;
        case 0x19:
          sp--;
          st[sp - 1] = st[sp - 1] < st[sp] ? 1 : 0;
          break;
        case 0x1a:
          sp--;
          st[sp - 1] = st[sp - 1] >= st[sp] ? 1 : 0;
          break;
        case 0x1b:
          sp--;
          st[sp - 1] = st[sp - 1] > st[sp] ? 1 : 0;
          break;
        case 0x1c:
          sp--;
          st[sp - 1] = st[sp - 1] !== st[sp] ? 1 : 0;
          break;
        case 0x1d:
          sp--;
          st[sp - 1] = st[sp - 1] && st[sp] ? 1 : 0;
          break;
        case 0x1e:
          sp--;
          st[sp - 1] = st[sp - 1] || st[sp] ? 1 : 0;
          break;
        case 0x1f:
          sp--;
          st[sp - 1] &= st[sp];
          break;
        case 0x20:
          sp--;
          st[sp - 1] |= st[sp];
          break;
        case 0x21:
          sp--;
          st[sp - 1] ^= st[sp];
          break;
        case 0x29:
          sp--;
          st[sp - 1] <<= st[sp] & 31;
          break;
        case 0x2a:
          sp--;
          st[sp - 1] >>= st[sp] & 31;
          break;
        case 0x22: {
          // ++a
          const a = st[sp - 1];
          const v = (this.load(a) + 1) | 0;
          this.store(a, v);
          st[sp - 1] = v;
          break;
        }
        case 0x23: {
          // a++
          const a = st[sp - 1];
          const v = this.load(a);
          this.store(a, (v + 1) | 0);
          st[sp - 1] = v;
          break;
        }
        case 0x24: {
          const a = st[sp - 1];
          const v = (this.load(a) - 1) | 0;
          this.store(a, v);
          st[sp - 1] = v;
          break;
        }
        case 0x25: {
          const a = st[sp - 1];
          const v = this.load(a);
          this.store(a, (v - 1) | 0);
          st[sp - 1] = v;
          break;
        }
        case 0x26: // short-circuit ||: if top is true push 1 and skip
          if (st[sp - 1]) {
            const skip = dv.getUint32(p, true);
            st[sp++] = 1;
            p += skip;
          } else p += 4;
          break;
        case 0x27: // short-circuit &&: if top is false push 0 and skip
          if (!st[sp - 1]) {
            const skip = dv.getUint32(p, true);
            st[sp++] = 0;
            p += skip;
          } else p += 4;
          break;
        case 0x28:
          st[sp] = this.load(st[sp - 1]);
          sp++;
          break;
        default:
          throw new ScriptError(`unknown expression op ${op.toString(16)}`);
      }
    }
  }

  callFunction(fid, args) {
    if (fid >= EXTERN_BASE) {
      const i = fid - EXTERN_BASE;
      const f = this.externs[i];
      if (!f) {
        this.noteUnknown("extern", this.bin.externLabel(i));
        return 0;
      }
      return f(this, args);
    }
    const f = this.builtins.get(fid);
    if (!f) {
      this.noteUnknown("builtin", `0x${fid.toString(16)} ${BUILTIN_NAMES[fid] || "?"}`);
      return 0;
    }
    return f(this, args);
  }
}
