// Unit tests for the shot hit test (CollisionClump's box test in
// src/combat/damage.js) and aim assist (src/combat/aim-assist.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shotHitsBox, segmentHitsBox, clumpHealth } from "../../src/combat/damage.js";
import { assistDirection, ASSIST_DEGREES } from "../../src/combat/aim-assist.js";

const box = { lo: [0, 0, 0], hi: [1, 1, 1] };

test("shotHitsBox: through, inside, beside and short of the box", () => {
  assert.equal(shotHitsBox([-1, 0.5, 0.5], [2, 0.5, 0.5], box), true, "straight through");
  assert.equal(shotHitsBox([0.4, 0.5, 0.5], [0.6, 0.5, 0.5], box), true, "both ends inside");
  assert.equal(shotHitsBox([-1, 0.5, 1.2], [2, 0.5, 1.2], box), false, "beside");
  assert.equal(shotHitsBox([-1, 0.5, 0.5], [-0.5, 0.5, 0.5], box), false, "short of it");
  assert.equal(shotHitsBox([2, 0.5, 0.5], [-1, 0.5, 0.5], box), true, "the other way");
  assert.equal(shotHitsBox([-1, -1, -1], [2, 2, 2], box), true, "diagonal through the corners");
  assert.equal(shotHitsBox([-1, 0.5, 2], [2, 0.5, -1.2], box), true, "slanted in x/z");
  assert.equal(shotHitsBox([-1, 0.5, 2.5], [2, 0.5, 0.5], box), false, "slanted past the corner");
});

test("shotHitsBox agrees with an exact segment test on clear cases", () => {
  let seed = 7;
  const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 4 - 1.5;
  let differ = 0;
  for (let i = 0; i < 2000; i++) {
    const a = [r(), r(), r()], b = [r(), r(), r()];
    if (shotHitsBox(a, b, box) !== segmentHitsBox(a, b, box)) differ++;
  }
  // The original's test only looks at 2D projections, so it is a little
  // looser; it must not be far off.
  assert.ok(differ < 100, `${differ} of 2000 differ`);
});

test("assistDirection: the part on the view line, a near miss, and off the crosshair", () => {
  const at = [1, 0, 0], view = [0, 0.08, 0];
  // A soldier 3 units ahead: head and body. The gun is 0.03 to the side.
  const head = { lo: [2.99, 0.065, -0.012], hi: [3.01, 0.095, 0.012] };
  const body = { lo: [2.98, 0.02, -0.02], hi: [3.02, 0.07, 0.02] };
  const d = assistDirection([0, 0.08, 0.03], view, at, [body, head], 0.06);
  assert.ok(d);
  const z = 0.03 + (d[2] * 3) / d[0], y = 0.08 + (d[1] * 3) / d[0];
  assert.ok(Math.abs(z) < 1e-9 && Math.abs(y - 0.08) < 1e-9, "turns onto the head, which the view line is on");
  // The view line just above the soldier: the nearest part, the head.
  const d2 = assistDirection([0, 0.12, 0.03], [0, 0.12, 0], at, [body, head], 0.06);
  assert.ok(d2 && Math.abs(0.12 + (d2[1] * 3) / d2[0] - 0.08) < 1e-9);
  // Far off the line, or behind: leave the shot alone.
  const aside = { lo: [2.9, 0, 1.9], hi: [3.1, 0.1, 2.1] };
  assert.equal(assistDirection([0, 0.08, 0.03], view, at, [aside], 0.06), null);
  const behind = { lo: [-3.1, 0, -0.1], hi: [-2.9, 0.1, 0.1] };
  assert.equal(assistDirection([0, 0.08, 0.03], view, at, [behind], 0.06), null);
  // Within ASSIST_DEGREES at range.
  const off = 30 * Math.tan(((ASSIST_DEGREES - 0.5) * Math.PI) / 180);
  const far = { lo: [29.9, 0.03, off - 0.05], hi: [30.1, 0.13, off + 0.05] };
  assert.ok(assistDirection([0, 0.08, 0.03], view, at, [far], 0.06));
});

test("clumpHealth: the box under the clump's world matrix (RwGetClumpBBox)", () => {
  // A 1 x 1 x 1 cube of vertices.
  const positions = [];
  for (let k = 0; k < 8; k++) positions.push(k & 1, (k >> 1) & 1, (k >> 2) & 1);
  const c = { mesh: { positions } };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
  assert.equal(clumpHealth(c, I), 390, "unit cube");
  const s = 0.2;
  const small = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
  assert.equal(clumpHealth(c, small), 78, "a parent scaled to a fifth: a fifth of the health");
  const r = Math.SQRT1_2;
  const turned = [r, 0, -r, 0, 0, 1, 0, 0, r, 0, r, 0, 0, 0, 0, 1];
  assert.equal(clumpHealth(c, turned), 491, "turned 45 degrees: the box grows to sqrt 2 in x and z");
  assert.equal(clumpHealth({ mesh: { positions: [] } }, I), 1, "no vertices: 1");
});
