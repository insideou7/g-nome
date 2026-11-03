// Graphics options (src/graphics.js): settings parsing, auto scale, the
// Scale2x filter and the texture edge bleed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, loadGraphics, resolveScale, scale2x, bleedEdges } from "../../src/graphics.js";

test("loadGraphics keeps known values and defaults the rest", () => {
  assert.deepEqual(loadGraphics(null), DEFAULTS);
  assert.deepEqual(loadGraphics({ scale: 3, msaa: 7, textures: "mipmap", sprites: "bogus" }), { ...DEFAULTS, scale: 3, textures: "mipmap" });
  assert.equal(loadGraphics({ scale: "auto" }).scale, "auto");
});

test("defaults are the original look, plus the browser's old 4x MSAA", () => {
  assert.deepEqual(DEFAULTS, { scale: 1, msaa: 4, textures: "nearest", sprites: "sharp" });
});

test("auto scale rounds device pixels per game pixel up, 1 to 4", () => {
  assert.equal(resolveScale(2, 9999, 1), 2);
  assert.equal(resolveScale("auto", 640, 1), 1);
  assert.equal(resolveScale("auto", 960, 1), 2);
  assert.equal(resolveScale("auto", 960, 2), 3);
  assert.equal(resolveScale("auto", 1440, 1), 3);
  assert.equal(resolveScale("auto", 5000, 2), 4);
  assert.equal(resolveScale("auto", 0, 1), 1);
});

test("scale2x doubles flat areas and rounds a diagonal step", () => {
  // 1 1
  // 1 2  -> the corner of the 2 next to both 1s becomes 1
  const out = scale2x(new Uint8Array([1, 1, 1, 2]), 2, 2);
  assert.deepEqual([...out], [
    1, 1, 1, 1,
    1, 1, 1, 1,
    1, 1, 1, 2,
    1, 1, 2, 2,
  ]);
  // A single pixel stays a 2x2 block (no matching neighbour pairs).
  const dot = scale2x(new Uint8Array([0, 0, 0, 0, 5, 0, 0, 0, 0]), 3, 3);
  assert.deepEqual([dot[2 * 6 + 2], dot[2 * 6 + 3], dot[3 * 6 + 2], dot[3 * 6 + 3]], [5, 5, 5, 5]);
  assert.equal(dot.reduce((a, b) => a + b, 0), 20);
});

test("bleedEdges colours transparent texels from neighbours, alpha stays 0", () => {
  // 3x1: red opaque, clear, clear
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = bleedEdges(rgba, 3, 1);
  assert.deepEqual([...out], [255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0]);
  assert.equal(rgba[4], 0, "input untouched");
});

test("imageKey matches tools/hdpack.py image_key", async () => {
  const { imageKey } = await import("../../src/hdpack.js");
  // 3x2: red, clear, (10,20,30) / (1,2,3), (200,100,50), clear
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 10, 20, 30, 255, 1, 2, 3, 255, 200, 100, 50, 255, 0, 0, 0, 0]);
  assert.equal(imageKey(rgba, 3, 2), "c86b59e0d263d596");
});
