// Unit tests for the 2D collision geometry in src/battlefield/collision.js:
// point in polygon, segment crossing and hotspot footprints. Points are
// [x, y, z]; only x and z count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { insidePolygon, segmentsCross, buildFootprint } from "../../src/battlefield/collision.js";
import { basisFromAngles } from "../../src/battlefield/math.js";

const square = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
// An L shape: the square minus its top-right quarter.
const ell = [[0, 0, 0], [10, 0, 0], [10, 0, 5], [5, 0, 5], [5, 0, 10], [0, 0, 10]];

test("insidePolygon: inside, outside and the concave notch", () => {
  assert.equal(insidePolygon(square, 5, 5), true);
  assert.equal(insidePolygon(square, 11, 5), false);
  assert.equal(insidePolygon(square, -1, 5), false);
  assert.equal(insidePolygon(ell, 2, 8), true);
  assert.equal(insidePolygon(ell, 8, 2), true);
  assert.equal(insidePolygon(ell, 8, 8), false, "in the notch");
});

test("insidePolygon: either winding works", () => {
  const cw = square.slice().reverse();
  assert.equal(insidePolygon(cw, 5, 5), true);
  assert.equal(insidePolygon(cw, 15, 5), false);
});

test("segmentsCross: where two segments cross", () => {
  const p = segmentsCross(0, 0, 10, 10, 0, 10, 10, 0);
  assert.ok(p, "an X crosses");
  assert.ok(Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1] - 5) < 1e-9, p.join());
  const q = segmentsCross(0, 0, 10, 0, 3, -5, 3, 5);
  assert.deepEqual(q.map((v) => +v.toFixed(9)), [3, 0]);
});

test("segmentsCross: misses, parallels and segments that stop short", () => {
  assert.equal(segmentsCross(0, 0, 10, 0, 0, 1, 10, 1), null, "parallel");
  assert.equal(segmentsCross(0, 0, 10, 0, 20, -5, 20, 5), null, "past the end");
  assert.equal(segmentsCross(0, 0, 4, 4, 0, 10, 10, 0), null, "stops before the crossing");
});

test("buildFootprint: moved to the hotspot and turned by the basis", () => {
  const verts = [[1, 0, 1], [3, 0, 1], [3, 0, 2]];
  const plain = buildFootprint(verts, [100, 0, 50], null);
  assert.deepEqual(plain.pts, [[101, 0, 51], [103, 0, 51], [103, 0, 52]]);
  const turned = buildFootprint([[0, 0, 1]], [0, 0, 0], basisFromAngles(90));
  assert.ok(Math.abs(turned.pts[0][0] - 1) < 1e-9 && Math.abs(turned.pts[0][2]) < 1e-9, turned.pts[0].join());
});

test("buildFootprint: edges on the 12-unit grid are flagged, not pushed", () => {
  const cell = [[0, 0, 0], [12, 0, 0], [12, 0, 12], [0, 0, 12]];
  const fp = buildFootprint(cell, [24, 0, -12], null);
  assert.deepEqual(fp.flags, [0x10, 0x10, 0x10, 0x10]);
  assert.deepEqual(fp.pts, [[24, 0, -12], [36, 0, -12], [36, 0, 0], [24, 0, 0]]);
});

test("buildFootprint: off-grid shapes are left alone", () => {
  const fp = buildFootprint([[1, 0, 1], [5, 0, 1], [5, 0, 5], [1, 0, 5]], [0, 0, 0], null);
  assert.deepEqual(fp.flags, [0, 0, 0, 0]);
  assert.deepEqual(fp.pts, [[1, 0, 1], [5, 0, 1], [5, 0, 5], [1, 0, 5]]);
});

test("buildFootprint: a corner on the grid pushes its edges 0.2 outwards", () => {
  // A diamond whose left corner sits on the grid line x = 12.
  const fp = buildFootprint([[12, 0, 5], [15, 0, 2], [18, 0, 5], [15, 0, 8]], [0, 0, 0], null);
  assert.ok(fp.pts[0][0] < 12, `left corner moved out to ${fp.pts[0][0]}`);
  assert.deepEqual(fp.pts[2], [18, 0, 5], "the off-grid corner stays");
});
