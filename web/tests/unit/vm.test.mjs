// Unit tests for the script VM (src/vm.js): expressions, statements, calls
// and memory. Scripts are assembled by hand, so no game files are needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, ScriptError, LOCAL_BASE, EXTERN_BASE } from "../../src/vm.js";

// ---------------------------------------------------------------- assembler

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// Expression ops (EvalExpr 0x10003330).
const E = {
  lit: (v) => [0x01, ...u32(v)],
  get: (id) => [0x02, ...u32(id)],
  addr: (id) => [0x04, ...u32(id)],
  index: [0x03],
  deref: [0x05],
  store: [0x08],
  call: (argc) => [0x0d, ...u32(0), ...u32(argc)],
  callScript: (nlocals, argc) => [0x0e, ...u32(nlocals), ...u32(argc)],
  neg: [0x0f], not: [0x10], inv: [0x11],
  add: [0x12], sub: [0x13], mul: [0x14], div: [0x15], mod: [0x16],
  eq: [0x17], le: [0x18], lt: [0x19], ge: [0x1a], gt: [0x1b], ne: [0x1c],
  and: [0x1d], or: [0x1e], band: [0x1f], bor: [0x20], xor: [0x21],
  preInc: [0x22], postInc: [0x23], preDec: [0x24], postDec: [0x25],
  shl: [0x29], shr: [0x2a],
  end: [0x00],
};
const expr = (...parts) => [...parts.flat(), 0x00];

// Statements. Each returns its bytes.
const S = {
  // 0xaf: evaluate, then move on by the record length.
  eval: (...parts) => {
    const e = expr(...parts);
    return [...u16(0xaf), ...u32(6 + e.length), ...e];
  },
  // 0xa1: set the return value and stop.
  ret: (...parts) => [...u16(0xa1), ...u32(0), ...expr(...parts)],
  end: () => [...u16(0xa2)],
  goto: (delta) => [...u16(0x68), ...u32(delta)],
  // 0x5b: if expr then +thenDelta else +elseDelta.
  if: (elseDelta, thenDelta, ...parts) => [...u16(0x5b), ...u32(elseDelta), ...u32(thenDelta), ...expr(...parts)],
  // 0x5a: compare a and b with `op`; skip the record when true, else jump.
  cmpSkip: (elseDelta, a, b, op, aVar = 0, bVar = 0) => [...u16(0x5a), ...u32(elseDelta), ...u32(a), ...u32(b), op, aVar, bVar, 0],
  // 0x01: call a script with literal args.
  call: (script, nlocals, args) => [...u16(0x01), ...u32(script), 0, 0, nlocals, args.length, ...args.flatMap(u32)],
  // 0xda: switch on a variable; cases are [value, delta] pairs.
  switchVar: (varId, defDelta, cases) => {
    const head = 0x10;
    return [
      ...u16(0xda), ...u32(varId), ...u32(head), ...u32(defDelta), cases.length, 1,
      ...cases.flatMap(([v, d]) => [...u16(0), ...u32(v), ...u32(d), 0, 0]),
    ];
  },
};

// A stand-in for BinFile with only scripts (type 19) in it.
function fakeBin(scripts, varInit = []) {
  return {
    varInit,
    type: (id) => (scripts.has(id) ? 19 : 0),
    resident: (id) => Uint8Array.from(scripts.get(id)),
    externLabel: (i) => `TEST.extern_${i}`,
  };
}
function vmWith(scripts, opts) {
  const map = new Map(Object.entries(scripts).map(([k, v]) => [Number(k), v.flat()]));
  return new VM(fakeBin(map), opts);
}
// Evaluate one expression in a fresh VM and return G0.
function evalTo(...parts) {
  const vm = vmWith({ 1: [S.eval(E.addr(0), ...parts, E.store), S.end()] });
  vm.runScript(1);
  return vm.getGlobal(0);
}

// ---------------------------------------------------------------- tests

test("globals start from the .BIN's initial values", () => {
  const vm = new VM(fakeBin(new Map(), [[5, 42], [7, -1]]));
  assert.equal(vm.getGlobal(5), 42);
  assert.equal(vm.getGlobal(7), -1);
  assert.equal(vm.getGlobal(6), 0);
});

test("arithmetic is 32-bit signed integer", () => {
  assert.equal(evalTo(E.lit(3), E.lit(4), E.mul, E.lit(5), E.add), 17);
  assert.equal(evalTo(E.lit(10), E.lit(3), E.sub), 7);
  assert.equal(evalTo(E.lit(-7), E.lit(2), E.div), -3, "division truncates towards zero");
  assert.equal(evalTo(E.lit(-7), E.lit(2), E.mod), -1);
  assert.equal(evalTo(E.lit(0x7fffffff), E.lit(1), E.add), -0x80000000, "addition wraps");
  assert.equal(evalTo(E.lit(0x10000), E.lit(0x10000), E.mul), 0, "multiplication wraps");
  assert.equal(evalTo(E.lit(5), E.neg), -5);
});

test("comparisons and logic give 0 or 1", () => {
  assert.equal(evalTo(E.lit(2), E.lit(2), E.eq), 1);
  assert.equal(evalTo(E.lit(2), E.lit(3), E.ne), 1);
  assert.equal(evalTo(E.lit(2), E.lit(3), E.lt), 1);
  assert.equal(evalTo(E.lit(3), E.lit(3), E.le), 1);
  assert.equal(evalTo(E.lit(2), E.lit(3), E.gt), 0);
  assert.equal(evalTo(E.lit(3), E.lit(3), E.ge), 1);
  assert.equal(evalTo(E.lit(5), E.lit(0), E.and), 0);
  assert.equal(evalTo(E.lit(5), E.lit(0), E.or), 1);
  assert.equal(evalTo(E.lit(0), E.not), 1);
  assert.equal(evalTo(E.lit(9), E.not), 0);
});

test("bit operations", () => {
  assert.equal(evalTo(E.lit(0b1100), E.lit(0b1010), E.band), 0b1000);
  assert.equal(evalTo(E.lit(0b1100), E.lit(0b1010), E.bor), 0b1110);
  assert.equal(evalTo(E.lit(0b1100), E.lit(0b1010), E.xor), 0b0110);
  assert.equal(evalTo(E.lit(0), E.inv), -1);
  assert.equal(evalTo(E.lit(1), E.lit(33), E.shl), 2, "shift counts are taken mod 32");
  assert.equal(evalTo(E.lit(-8), E.lit(1), E.shr), -4, "right shift keeps the sign");
});

test("dividing by zero is a script error", () => {
  assert.throws(() => evalTo(E.lit(1), E.lit(0), E.div), ScriptError);
  assert.throws(() => evalTo(E.lit(1), E.lit(0), E.mod), ScriptError);
});

test("increment and decrement, before and after", () => {
  const vm = vmWith({
    1: [
      S.eval(E.addr(1), E.lit(10), E.store),
      S.eval(E.addr(2), E.addr(1), E.postInc, E.store), // G2 = G1++
      S.eval(E.addr(3), E.addr(1), E.preInc, E.store), // G3 = ++G1
      S.eval(E.addr(4), E.addr(1), E.postDec, E.store), // G4 = G1--
      S.eval(E.addr(5), E.addr(1), E.preDec, E.store), // G5 = --G1
      S.end(),
    ],
  });
  vm.runScript(1);
  assert.deepEqual([1, 2, 3, 4, 5].map((g) => vm.getGlobal(g)), [10, 10, 12, 12, 10]);
});

test("pointers: address of, dereference and indexing", () => {
  const vm = vmWith({
    1: [
      S.eval(E.addr(11), E.lit(7), E.store), // G11 = 7
      S.eval(E.addr(12), E.lit(8), E.store), // G12 = 8
      S.eval(E.addr(1), E.addr(10), E.lit(2), E.index, E.store), // G1 = (&G10)[2]
      S.eval(E.addr(2), E.addr(11), E.deref, E.store), // G2 = *&G11
      S.end(),
    ],
  });
  vm.runScript(1);
  assert.equal(vm.getGlobal(1), 8);
  assert.equal(vm.getGlobal(2), 7);
});

test("loads and stores outside memory or unaligned are errors", () => {
  const vm = vmWith({});
  assert.throws(() => vm.load(0), ScriptError);
  assert.throws(() => vm.load(6), ScriptError);
  assert.throws(() => vm.store(-4, 1), ScriptError);
  const a = vm.addrOf(3);
  vm.store(a, 99);
  assert.equal(vm.load(a), 99);
  assert.equal(vm.getGlobal(3), 99);
});

test("if takes the then or the else branch", () => {
  // if (G0) G1 = 1 else G1 = 2
  const then = S.eval(E.addr(1), E.lit(1), E.store);
  const els = S.eval(E.addr(1), E.lit(2), E.store);
  const head = S.if(0, 0, E.get(0)).length;
  const gotoEnd = S.goto(0).length;
  const prog = (g0) => {
    const ifStmt = S.if(head + then.length + gotoEnd, head, E.get(0));
    const vm = vmWith({ 1: [ifStmt, then, S.goto(gotoEnd + els.length), els, S.end()] });
    vm.setGlobal(0, g0);
    vm.runScript(1);
    return vm.getGlobal(1);
  };
  assert.equal(prog(1), 1);
  assert.equal(prog(0), 2);
});

test("compare-and-skip statement (0x5a) ops", () => {
  // G1 = 1 when `a op b` holds, else jump over the store.
  const run = (a, b, op) => {
    const store = S.eval(E.addr(1), E.lit(1), E.store);
    const head = S.cmpSkip(0, a, b, op).length;
    const vm = vmWith({ 1: [S.cmpSkip(head + store.length, a, b, op), store, S.end()] });
    vm.runScript(1);
    return vm.getGlobal(1);
  };
  assert.equal(run(4, 4, 0x01), 1, "==");
  assert.equal(run(5, 4, 0x02), 1, ">");
  assert.equal(run(3, 4, 0x04), 1, "<");
  assert.equal(run(3, 4, 0x02), 0, "> false");
  assert.equal(run(4, 4, 0x02), 0, "> is strict");
  assert.equal(run(4, 4, 0x04), 0, "< is strict");
  assert.equal(run(6, 3, 0x10), 1, "& non-zero");
  assert.equal(run(4, 2, 0x20), 0, "% zero");
  assert.equal(run(4, 4, 0x81), 0, "0x80 negates");
  assert.equal(run(0, 0, 0x00), 0, "no op bits: a != 0");
});

test("compare-and-skip reads variables when flagged", () => {
  const store = S.eval(E.addr(1), E.lit(1), E.store);
  const head = S.cmpSkip(0, 0, 0, 0).length;
  const vm = vmWith({ 1: [S.cmpSkip(head + store.length, 20, 21, 0x01, 1, 1), store, S.end()] });
  vm.setGlobal(20, 5);
  vm.setGlobal(21, 5);
  vm.runScript(1);
  assert.equal(vm.getGlobal(1), 1);
});

test("switch jumps to the matching case or the default", () => {
  const run = (subject) => {
    const a = S.ret(E.lit(100));
    const b = S.ret(E.lit(200));
    const d = S.ret(E.lit(-1));
    // Jump deltas count from the start of the switch record.
    const offA = S.switchVar(0, 0, [[0, 0], [0, 0]]).length, offB = offA + a.length, offD = offB + b.length;
    const prog = S.switchVar(0, offD, [[10, offA], [20, offB]]);
    const vm = vmWith({ 1: [prog, a, b, d] });
    vm.setGlobal(0, subject);
    vm.runScript(1);
    return vm.retval;
  };
  assert.equal(run(10), 100);
  assert.equal(run(20), 200);
  assert.equal(run(30), -1);
});

test("calling a script passes arguments in locals and returns a value", () => {
  const vm = vmWith({
    // script 2: return L0 * 10 + L1
    2: [S.ret(E.get(LOCAL_BASE), E.lit(10), E.mul, E.get(LOCAL_BASE + 1), E.add)],
    // script 1: L0 = 5; G0 = script2(3, 4); G1 = L0 (unchanged by the call)
    1: [
      S.eval(E.addr(LOCAL_BASE), E.lit(5), E.store),
      S.eval(E.addr(0), E.lit(2), E.lit(3), E.lit(4), E.callScript(1, 2), E.store),
      S.eval(E.addr(1), E.get(LOCAL_BASE), E.store),
      S.end(),
    ],
  });
  vm.callScript(1, 0, []);
  assert.equal(vm.getGlobal(0), 34);
  assert.equal(vm.getGlobal(1), 5, "the caller's local survives the call");
  assert.equal(vm.depth, 0);
});

test("statement 0x01 calls a script with literal args", () => {
  const vm = vmWith({
    2: [S.eval(E.addr(0), E.get(LOCAL_BASE), E.get(LOCAL_BASE + 1), E.sub, E.store), S.end()],
    1: [S.call(2, 0, [50, 8]), S.end()],
  });
  vm.runScript(1);
  assert.equal(vm.getGlobal(0), 42);
});

test("callValue runs a script and keeps the caller's return value", () => {
  const vm = vmWith({ 3: [S.ret(E.get(LOCAL_BASE), E.lit(1), E.add)] });
  vm.retval = 77;
  assert.equal(vm.callValue(3, [41]), 42);
  assert.equal(vm.retval, 77);
});

test("builtins and externs are called with their arguments", () => {
  const vm = vmWith({
    1: [
      S.eval(E.addr(0), E.lit(0x30), E.lit(6), E.lit(7), E.call(2), E.store),
      S.eval(E.addr(1), E.lit(EXTERN_BASE + 1), E.lit(9), E.call(1), E.store),
      S.end(),
    ],
  });
  const seen = [];
  vm.builtins.set(0x30, (_vm, args) => (seen.push(args), args[0] * args[1]));
  vm.externs[1] = (_vm, args) => args[0] + 1;
  vm.runScript(1);
  assert.equal(vm.getGlobal(0), 42);
  assert.equal(vm.getGlobal(1), 10);
  assert.deepEqual(seen, [[6, 7]]);
});

test("unknown builtins and externs return 0 and are noted once", () => {
  const logs = [];
  const vm = vmWith(
    {
      1: [
        S.eval(E.addr(0), E.lit(0x31), E.call(0), E.store),
        S.eval(E.addr(0), E.lit(0x31), E.call(0), E.store),
        S.eval(E.addr(1), E.lit(EXTERN_BASE + 3), E.call(0), E.store),
        S.end(),
      ],
    },
    { log: (...a) => logs.push(a.join(" ")) },
  );
  vm.setGlobal(0, 5);
  vm.runScript(1);
  assert.equal(vm.getGlobal(0), 0);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /extern TEST\.extern_3/);
  assert.equal([...vm.unknown.values()].reduce((a, b) => a + b), 3);
});

test("an endless loop hits the step limit", () => {
  const body = S.eval(E.addr(0), E.addr(0), E.preInc, E.store);
  const vm = vmWith({ 1: [body, S.goto(-body.length)] }, { maxSteps: 1000 });
  assert.throws(() => vm.runScript(1), /step limit/);
});

test("unknown statements are script errors; registered ones run", () => {
  const vm = vmWith({ 1: [[...u16(0x77), 0, 0], S.end()] });
  assert.throws(() => vm.runScript(1), /unknown statement 77/);
  vm.depth = 0;
  vm.statements.set(0x77, (v) => (v.setGlobal(9, 1), { len: 4, ok: 1 }));
  vm.runScript(1);
  assert.equal(vm.getGlobal(9), 1);
});

test("running a resource that is not a script does nothing", () => {
  const logs = [];
  const vm = vmWith({}, { log: (m) => logs.push(m) });
  assert.equal(vm.runScript(5), 0);
  assert.match(logs[0], /not a script/);
});

test("abort stops every running script", () => {
  const vm = vmWith({ 1: [S.eval(E.addr(0), E.lit(1), E.store), S.end()] });
  vm.abort = 1;
  assert.equal(vm.runScript(1), 0);
  assert.equal(vm.getGlobal(0), 0);
});

test("alloc hands out 8-byte aligned, zeroed blocks; cstring reads them", () => {
  const vm = vmWith({});
  const a = vm.alloc(3);
  const b = vm.alloc(1);
  assert.equal(b - a, 8);
  const s = vm.allocBytes(new TextEncoder().encode("G-NOME"));
  assert.equal(vm.cstring(s), "G-NOME");
});
