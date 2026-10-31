// Check sprite motion: paths (messages and queue records 5, 9, 10), speed
// (17), motion (15), cel ranges (16) and keep-time (13) in web/src/sprites.js,
// on a stand-in engine with made-up resources. Needs no game files: no
// G-NOME script or queue uses these. Usage: node web/tests/sprite-motion-check.mjs
import { Sprites, linePoint, curvePoint } from "../src/sprites.js";

let failed = 0;
const check = (ok, what, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Resources: 100 = sprite with cels 1..4 (type 1), queues get ids from 200.
const res = new Map(), types = new Map();
for (let c = 1; c <= 4; c++) types.set(c, 1);
const sprite = new Uint8Array(0x26 + 4 * 4);
const sdv = new DataView(sprite.buffer);
sdv.setUint32(8, 4, true);
for (let i = 0; i < 4; i++) sdv.setUint32(0x26 + 4 * i, i + 1, true);
types.set(100, 20);
res.set(100, sprite);

// A queue from records: [type, size, (dv) => fill].
let nextQueue = 200;
function queue(...records) {
  const size = records.reduce((n, r) => n + r[1], 0);
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  let p = 0;
  for (const [type, n, fill] of records) {
    dv.setUint16(p, type, true);
    fill?.(dv, p);
    p += n;
  }
  const id = nextQueue++;
  types.set(id, 18);
  res.set(id, b);
  return id;
}

const vars = new Map();
const engine = {
  time: 0, dirty: false, dynamic: new Map(), unknown: [],
  bin: { type: (id) => types.get(id) ?? 0, resident: (id) => res.get(id) },
  vm: {
    depth: 0, getVar: (v) => vars.get(v) ?? 0, setGlobal() {},
    noteUnknown: (kind, t) => engine.unknown.push(`${kind}:${t}`),
  },
  log: (m) => console.log("  log:", m), post() {},
};
const sprites = new Sprites(/** @type {any} */ (engine));
const s = sprites.get(100);
const tick = (ms) => {
  engine.time += ms;
  sprites.tick(ms);
};
const pos = () => [s.x, s.y];
const reset = () => {
  sprites.setQueue(100, 0, false);
  Object.assign(s, { x: 0, y: 0, cel: 0, speed: 0, moveAt: 0, celAt: 0, delay: 0, keepTime: false, range: null, path: null });
};

// The point helpers against hand-computed values.
check(same(linePoint(1, 4, 0, 0, 10, -10), [3, -3]), "line point 1/4 of (10, -10) rounds half away from zero", linePoint(1, 4, 0, 0, 10, -10));
check(same(linePoint(4, 4, 5, 5, 15, -5), [15, -5]), "line point n/n is the end");
check(same(curvePoint(2, 4, 0, 0, 50, 100, 100, 0), [50, 100]), "curve passes through its middle point halfway", curvePoint(2, 4, 0, 0, 50, 100, 100, 0));
check(same(curvePoint(4, 4, 0, 0, 50, 100, 100, 0), [100, 0]), "curve ends at its last point");
check(same(curvePoint(1, 4, 0, 0, 50, 100, 100, 0), [25, 75]), "curve quarter point", curvePoint(1, 4, 0, 0, 50, 100, 100, 0));

// Message 9: line to (40, 20) in 4 steps, one step per tick at speed 0.
reset();
sprites.send(100, [9, 40, 20, 4, 0, 0]);
check(same(pos(), [10, 5]), "message 9 takes its first step at once", pos());
const seen = [];
for (let i = 0; i < 4; i++) {
  tick(10);
  seen.push(pos());
}
check(same(seen, [[20, 10], [30, 15], [40, 20], [40, 20]]), "line steps once per service and stops at the end", seen);
check(s.path === null, "line path is finished");

// Speed: message 17 sets the move interval.
reset();
sprites.send(100, [17, 100]);
sprites.send(100, [9, 30, 0, 3, 0, 1]); // relative
check(same(pos(), [0, 0]), "with speed 100 the first step waits for the clock", pos());
tick(50);
check(same(pos(), [0, 0]), "no step before 100 ms", pos());
tick(50);
check(same(pos(), [10, 0]), "a step after 100 ms", pos());
tick(100);
tick(100);
check(same(pos(), [30, 0]) && s.path === null, "relative line ends at start + (30, 0)", pos());

// Steps given in pixels: 25 pixels at 10 a step = 3 steps.
reset();
sprites.send(100, [9, 25, 0, 10, 1, 0]);
tick(1);
tick(1);
check(same(pos(), [25, 0]) && s.path === null, "message 9 in pixels per step: 3 steps", pos());

// Message 5: curve through (50, 100) to (100, 0) in 4 steps.
reset();
sprites.send(100, [5, 50, 100, 100, 0, 4, 0]);
const curve = [pos()];
for (let i = 0; i < 3; i++) {
  tick(1);
  curve.push(pos());
}
check(same(curve, [[25, 75], [50, 100], [75, 75], [100, 0]]), "curve steps", curve);

// Message 10: a step move, absolute and relative.
reset();
sprites.send(100, [10, 7, 9, 0]);
check(same(pos(), [7, 9]) && s.path === null, "message 10 moves to x, y", pos());
sprites.send(100, [10, 1, -1, 1]);
check(same(pos(), [8, 8]), "message 10 relative moves by x, y", pos());

// Cel range (16) and motion (15): cels cycle while the sprite moves.
reset();
sprites.send(100, [16, 1, 1, 3]);
check(s.cel === 1, "message 16 shows the current cel", s.cel);
sprites.send(100, [15, 20]);
sprites.send(100, [17, 10]);
sprites.send(100, [9, 100, 0, 10, 0, 0]);
const cels = [];
for (let i = 0; i < 8; i++) {
  tick(10);
  cels.push(s.cel);
}
check(same(cels, [1, 2, 2, 3, 3, 1, 1, 2]), "cels 1..3 cycle every 20 ms while moving", cels);

// Queue records: speed 17, line 9, curve 5, step 10, then the queue ends.
reset();
const q = queue(
  [17, 0xc, (dv, p) => dv.setInt32(p + 2, 50, true)],
  [9, 0x2c, (dv, p) => {
    dv.setInt32(p + 2, 2, true); // steps
    dv.setInt32(p + 0xc, 20, true);
    dv.setInt32(p + 0x10, 0, true);
  }],
  [10, 0xe, (dv, p) => {
    dv.setUint8(p + 2, 1); // relative
    dv.setInt32(p + 6, 0, true);
    dv.setInt32(p + 0xa, 5, true);
  }],
  [5, 0x3c, (dv, p) => {
    dv.setInt32(p + 2, 2, true);
    dv.setUint8(p + 6, 1); // relative
    dv.setInt32(p + 0xc, 10, true);
    dv.setInt32(p + 0x10, 10, true);
    dv.setInt32(p + 0x14, 20, true);
    dv.setInt32(p + 0x18, 0, true);
  }],
);
sprites.setQueue(100, q, false);
const trail = [pos()];
for (let i = 0; i < 6; i++) {
  tick(50);
  trail.push(pos());
}
check(same(trail, [[0, 0], [10, 0], [20, 0], [20, 5], [30, 15], [40, 5], [40, 5]]), "queue: line, step, then relative curve, one step per 50 ms", trail);
check(s.queue === null, "queue finished");

// A variable in a record: the line's end x comes from variable 7.
reset();
vars.set(7, 12);
const qv = queue([9, 0x2c, (dv, p) => {
  dv.setInt32(p + 2, 1, true);
  dv.setInt32(p + 0xc, 7, true);
  dv.setUint8(p + 8, 1); // +0xc is a variable
}]);
sprites.setQueue(100, qv, false);
check(same(pos(), [12, 0]), "record 9 reads its end point from a variable", pos());

// Keep-time (13): the clock advances from the last deadline, so a late
// service catches up a step instead of starting the interval again.
reset();
sprites.send(100, [13, 1]);
sprites.send(100, [17, 10]);
sprites.send(100, [9, 100, 0, 10, 0, 0]);
tick(15); // deadline 10: step; next deadline 20 (kept), not 25
tick(5);
check(same(pos(), [20, 0]), "keep-time: steps stay on the 10 ms grid", pos());

// Message 14 is known now.
sprites.send(100, [14, 0]);
sprites.send(100, [14, 1]);
check(engine.unknown.length === 0, "no unknown sprite messages", engine.unknown);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
