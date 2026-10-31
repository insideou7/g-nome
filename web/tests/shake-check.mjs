// Checks screen shake (builtin 0xC8 ScreenShake, Display.shake).
// Usage: node web/tests/shake-check.mjs [game/g-nome/G-NOME]
// Without a game folder only the Display part runs: a shake shows the frame
// shifted by +d, then by -d, then unshifted. With one it starts campaign
// mission 19 headless, where enemy rockets hit the player in the first
// 3000 ticks, and checks the hit script shakes the screen (-3,-3), (8,8).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Display } from "../src/display.js";

// A canvas stand-in that records what present() draws.
const draws = [];
const ctx = {
  canvas: {},
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => draws.push("put"),
  drawImage: (src, x, y) => draws.push(src === ctx.canvas ? `self ${x},${y}` : "image"),
  fillRect: () => {},
};
const d = new Display(/** @type {any} */ ({ getContext: () => ctx }));
d.present();
d.shake(0, 0);
assert.equal(d.shakes.length, 0, "a zero shake does nothing");
d.shake(-3, -3);
d.shake(8, 8);
const frames = [];
for (let i = 0; i < 6; i++) {
  draws.length = 0;
  d.present();
  frames.push(draws.join("; "));
}
assert.deepEqual(frames, ["put; self -3,-3", "put; self 3,3", "put; self 8,8", "put; self -8,-8", "put", ""]);
console.log("ok  Display.shake: +d, -d, then home, one frame each");

const dir = process.argv[2];
if (dir && existsSync(dir)) {
  const { Player } = await import("./player.mjs");
  const p = await Player.start(dir);
  const e = p.engine;
  const calls = [];
  const shake = p.display.shake.bind(p.display);
  p.display.shake = (dx, dy) => {
    calls.push([dx, dy, p.ticks]);
    shake(dx, dy);
  };
  await p.wait(60);
  for (const g of [2118, 2119]) e.vm.setGlobal(g, 19);
  e.vm.setGlobal(982, 0);
  e.run(8317);
  while (p.ticks < 3000 && calls.length < 4 && !e.quit) await p.wait(1);
  assert.ok(calls.length >= 2, `mission 19 shakes the screen when the player is hit (${calls.length} calls)`);
  for (let i = 0; i + 1 < calls.length; i += 2) {
    assert.deepEqual(calls[i].slice(0, 2), [-3, -3], "first shake of a hit");
    assert.deepEqual(calls[i + 1].slice(0, 2), [8, 8], "second shake of a hit");
  }
  assert.ok(![...e.vm.unknown.keys()].some((k) => k.includes("0xc8")), "0xC8 is implemented");
  await p.wait(10);
  assert.equal(p.display.shakes.length, 0, "the shake is over a few frames later");
  assert.deepEqual(p.errors, [], "no engine errors");
  console.log(`ok  mission 19: first hit shakes at tick ${calls[0][2]}, ${calls.length} calls`);
}
