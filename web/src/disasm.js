// Linear disassembler for script resources (for traces and debugging).
// Unlike tools/r32script.py it walks every record in order, so else
// branches and switch case bodies are listed too.
import { FIXED, hex } from "./statements.js";
import { LOCAL_BASE, EXTERN_BASE } from "./vm.js";
import { BUILTIN_NAMES, STATEMENT_NAMES } from "./names.js";

const BIN = { 0x12: "+", 0x13: "-", 0x14: "*", 0x15: "/", 0x16: "%", 0x17: "==", 0x18: "<=", 0x19: "<", 0x1a: ">=", 0x1b: ">", 0x1c: "!=", 0x1d: "&&", 0x1e: "||", 0x1f: "&", 0x20: "|", 0x21: "^", 0x29: "<<", 0x2a: ">>" };
const UN = { 0x0f: "-", 0x10: "!", 0x11: "~" };

export const varName = (v) => (v >= LOCAL_BASE ? `L${v - LOCAL_BASE}` : `G${v}`);

export function exprText(bin, b, dv, p, names = BUILTIN_NAMES) {
  const st = [];
  for (;;) {
    const op = b[p++];
    if (op === 0) break;
    if (op === 1) { st.push(String(dv.getInt32(p, true))); p += 4; }
    else if (op === 2) { st.push(varName(dv.getUint32(p, true))); p += 4; }
    else if (op === 4) { st.push("&" + varName(dv.getUint32(p, true))); p += 4; }
    else if (op === 3) { const i = st.pop(), a = st.pop(); st.push(`${a.replace(/^&/, "")}[${i}]`); }
    else if (op === 5) st.push(`*${st.pop()}`);
    else if (op === 6) { const i = st.pop(), a = st.pop(); st.push(`&${a.replace(/^&/, "")}[${i}]`); }
    else if (op === 8) { const v = st.pop(), a = st.pop(); st.push(`${a.replace(/^&/, "")} = ${v}`); }
    else if (op === 0x0d) {
      const argc = dv.getUint32(p + 4, true); p += 8;
      const args = st.splice(st.length - argc, argc);
      const f = Number(st.pop());
      const name = f >= EXTERN_BASE ? bin.externLabel(f - EXTERN_BASE) : names[f] || `b${f.toString(16)}`;
      st.push(`${name}(${args.join(", ")})`);
    } else if (op === 0x0e) {
      const argc = dv.getUint32(p + 4, true); p += 8;
      const args = st.splice(st.length - argc, argc);
      st.push(`script_${st.pop()}(${args.join(", ")})`);
    } else if (UN[op]) st.push(`${UN[op]}(${st.pop()})`);
    else if (BIN[op]) { const r = st.pop(), l = st.pop(); st.push(`(${l} ${BIN[op]} ${r})`); }
    else if (op >= 0x22 && op <= 0x25) { const a = String(st.pop()).replace(/^&/, ""); st.push(op === 0x22 ? `++${a}` : op === 0x23 ? `${a}++` : op === 0x24 ? `--${a}` : `${a}--`); }
    else if (op === 0x26 || op === 0x27) { p += 4; st.push(`${st.pop()} ${op === 0x26 ? "||" : "&&"}`); }
    else if (op === 0x28) st.push(`*${st[st.length - 1]}`);
    else { st.push(`?op${op.toString(16)}`); break; }
  }
  // Short-circuit fragments ("a ||", "b", "||-result") read fine joined.
  return st.join(" ").replace(/ \|\| \((.*)\)$/, " || $1");
}

export function disassemble(bin, id, names = BUILTIN_NAMES) {
  const b = bin.resident(id);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  const tables = [];
  let p = 0;
  while (p < b.length) {
    const t = tables.find(([s]) => s === p);
    if (t) { p = t[1]; continue; }
    const op = dv.getUint16(p, true);
    let len, text;
    const at = (d) => (p + d).toString(16).padStart(4, "0");
    switch (op) {
      case 0x68: len = 6; text = `goto ${at(dv.getInt32(p + 2, true))}`; break;
      case 0x5b: case 0xe3:
        len = dv.getInt32(p + 6, true);
        text = `if ${exprText(bin, b, dv, p + 10, names)} else ${at(dv.getInt32(p + 2, true))}`; break;
      case 0xaf: len = dv.getUint32(p + 2, true); text = exprText(bin, b, dv, p + 6, names); break;
      case 0xa1: len = dv.getUint32(p + 2, true); text = `return ${exprText(bin, b, dv, p + 6, names)}`; break;
      case 0xa2: len = 2; text = "end"; break;
      case 0xda: case 0xdb: {
        const tab = dv.getUint32(p + 6, true), n = b[p + 14];
        const subj = op === 0xdb ? exprText(bin, b, dv, p + 0x10, names) : b[p + 15] ? varName(dv.getUint32(p + 2, true)) : String(dv.getInt32(p + 2, true));
        const cases = [];
        for (let i = 0; i < n; i++) {
          const c = p + tab + 12 * i;
          const v = b[c + 10] ? varName(dv.getUint32(c + 2, true)) : dv.getInt32(c + 2, true);
          cases.push(`${v}:${at(dv.getInt32(c + 6, true))}`);
        }
        tables.push([p + tab, p + tab + 12 * n]);
        text = `switch ${subj} {${cases.join(", ")}} default:${at(dv.getInt32(p + 10, true))}`;
        // The record runs to the end of its expression; case bodies follow.
        if (op === 0xdb) { let q = p + 0x10; len = exprEnd(b, q) - p; } else len = 0x10;
        break;
      }
      case 0x59: len = 0x1a; text = `if_cmp_call ${hex(b, p + 2, p + 0x1a)}`; break;
      case 0x5a: len = 0x12; text = `if_cmp_goto ${hex(b, p + 2, p + 0x12)}`; break;
      case 0x01: {
        len = b[p + 9] * 4 + 10;
        const s = dv.getUint32(p + 2, true), mask = b[p + 7];
        const args = [];
        for (let i = 0; i < b[p + 9]; i++) { const v = dv.getInt32(p + 10 + 4 * i, true); args.push(mask & (1 << i) ? varName(v) : v); }
        text = `call ${b[p + 6] ? varName(s) : "script_" + s}(${args.join(", ")})`; break;
      }
      default:
        len = FIXED[op];
        if (!len) { out.push(`${at(0)}  ?? op ${op.toString(16)}`); return out; }
        text = `${STATEMENT_NAMES[op] || "op_" + op.toString(16)} ${hex(b, p + 2, p + len)}`;
    }
    out.push(`${at(0)}  ${text}`);
    p += len;
  }
  return out;
}

function exprEnd(b, p) {
  for (;;) {
    const op = b[p++];
    if (op === 0) return p;
    if (op === 1 || op === 2 || op === 4 || op === 0x26 || op === 0x27) p += 4;
    else if (op === 0x0d || op === 0x0e) p += 8;
  }
}
