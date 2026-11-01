// Unit tests for the matrix and vector math: src/render3d/math.js
// (RenderWare-style row-vector 4x4 matrices) and src/battlefield/math.js
// (vectors and orientation bases).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../../src/render3d/math.js";
import * as V from "../../src/battlefield/math.js";

// Element-wise equal within eps. The third argument may be a message instead.
const close = (a, b, eps = 1e-5, msg = "") => {
  if (typeof eps === "string") [eps, msg] = [1e-5, eps];
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `${msg} [${i}] ${a[i]} != ${b[i]} in [${Array.from(a).map((v) => +v.toFixed(5))}]`);
};
const point = (m, p) => M.transformPoint(m, p[0], p[1], p[2], [0, 0, 0]);

test("identity leaves points alone; translation moves them", () => {
  close(point(M.identity(), [1, 2, 3]), [1, 2, 3]);
  close(point(M.translation(10, 20, 30), [1, 2, 3]), [11, 22, 33]);
  close(M.transformDir(M.translation(10, 20, 30), 1, 2, 3, [0, 0, 0]), [1, 2, 3], "directions ignore translation");
});

test("rotations follow the right-hand rule", () => {
  close(point(M.rotY(90), [0, 0, 1]), [1, 0, 0], "yaw turns +Z towards +X");
  close(point(M.rotX(90), [0, 1, 0]), [0, 0, 1]);
  close(point(M.rotZ(90), [1, 0, 0]), [0, 1, 0]);
});

test("mul applies the left matrix first", () => {
  const m = M.mul(M.translation(1, 0, 0), M.rotY(90));
  close(point(m, [0, 0, 0]), [0, 0, -1], "moved to +X, then turned");
  const n = M.mul(M.rotY(90), M.translation(1, 0, 0));
  close(point(n, [0, 0, 0]), [1, 0, 0], "turned, then moved");
});

test("mul can write into one of its inputs", () => {
  const a = M.rotY(30);
  const expect = M.mul(a, M.rotY(60));
  M.mul(a, M.rotY(60), a);
  close(a, expect);
});

test("compose: scale, roll, pitch, yaw, then position", () => {
  const m = M.compose({ position: [5, 0, 0], yaw: 90, scale: 2 });
  close(point(m, [0, 0, 1]), [7, 0, 0]);
  const s = M.compose({ scale: [1, 2, 3] });
  close(point(s, [1, 1, 1]), [1, 2, 3]);
});

test("invert undoes a rigid transform", () => {
  const m = M.compose({ position: [3, -4, 5], yaw: 30, pitch: -20, roll: 10, scale: 2 });
  const inv = M.invert(m);
  close(M.mul(m, inv), M.identity(), 1e-5);
  close(point(inv, point(m, [1, 2, 3])), [1, 2, 3], 1e-4);
});

test("invert of a singular matrix is the identity", () => {
  close(M.invert(new Float32Array(16)), M.identity());
});

test("vector basics", () => {
  assert.deepEqual(V.add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(V.sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  assert.deepEqual(V.scale([1, 2, 3], 2), [2, 4, 6]);
  assert.equal(V.dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(V.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(V.length([3, 4, 0]), 5);
  close(V.normalize([0, 3, 4]), [0, 0.6, 0.8]);
  assert.deepEqual(V.lerp([0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15]);
});

test("rotate agrees with the matrix rotations", () => {
  close(V.rotate([0, 0, 1], [0, 1, 0], 90), [1, 0, 0]);
  close(V.rotate([0, 0, 1], [0, 1, 0], 37), point(M.rotY(37), [0, 0, 1]));
  close(V.rotate([0, 1, 0], [1, 0, 0], -25), point(M.rotX(-25), [0, 1, 0]));
});

test("headingOf: hundredths of a degree, 0 at +Z, 9000 at +X", () => {
  assert.equal(V.headingOf([0, 0, 1]), 0);
  assert.equal(V.headingOf([1, 0, 0]), 9000);
  assert.equal(V.headingOf([0, 0, -1]), 18000);
  assert.equal(V.headingOf([-1, 0, 0]), 27000);
});

test("basisFromAngles: yaw then a positive pitch looks down", () => {
  const b = V.basisFromAngles(90);
  close(b.at, [1, 0, 0]);
  close(b.right, [0, 0, -1]);
  assert.equal(V.headingOf(V.basisFromAngles(123.45).at), 12345);
  const down = V.basisFromAngles(0, 30);
  assert.ok(down.at[1] < 0, "pitch > 0 looks down");
  close([V.dot(down.at, down.up), V.dot(down.at, down.right), V.dot(down.up, down.right)], [0, 0, 0]);
});

test("basisFromAt builds an orthonormal basis, even looking straight up", () => {
  for (const at of [[1, 2, 3], [0, 1, 0], [0, -5, 0]]) {
    const b = V.basisFromAt(at);
    close([V.length(b.right), V.length(b.up), V.length(b.at)], [1, 1, 1]);
    close([V.dot(b.at, b.up), V.dot(b.at, b.right), V.dot(b.up, b.right)], [0, 0, 0]);
    close(V.cross(b.up, b.at), b.right, 1e-9);
  }
});

test("lerpBasis halfway between two headings", () => {
  const b = V.lerpBasis(V.basisFromAngles(0), V.basisFromAngles(90), 0.5);
  assert.equal(V.headingOf(b.at), 4500);
});

test("modelMatrix places a basis like the render3d matrices", () => {
  const b = V.basisFromAngles(90);
  const m = V.modelMatrix(b, [1, 2, 3], 2);
  close(point(m, [0, 0, 1]), [3, 2, 3]);
  const c = V.copyBasis(b);
  c.at[0] = 99;
  assert.notEqual(b.at[0], 99, "copyBasis copies the vectors");
});
