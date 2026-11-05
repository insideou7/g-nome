// UpdateTimeStep (RENDER.R32 0x10011ec1) banks its unused time in an object
// property, which the scripts also read and write (script 1728 passes 41;
// the unit set-up scripts 2041 and 2043 start it at 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { battlefieldExterns } from "../../src/battlefield/externs.js";
import { WorldObject } from "../../src/battlefield/world.js";

// frameTerm stands in for the animation code (UpdateFrameTerm): 0 = no
// frame change yet, else the ms to move for.
function setup(/** @type {(id: number, ms: number) => number} */ frameTerm) {
  const props = new Map();
  const engine = /** @type {any} */ ({
    render3d: {
      objects: {
        getProperty: (/** @type {number} */ id, /** @type {number} */ n) => props.get(`${id}:${n}`) ?? 0,
        setProperty: (/** @type {number} */ id, /** @type {number} */ n, /** @type {number} */ v) => props.set(`${id}:${n}`, v),
      },
    },
    animation: { timeStep: frameTerm, syncRate() {} },
  });
  const ext = battlefieldExterns(engine);
  const o = new WorldObject(7);
  engine.world.objects.set(7, o);
  return { ext, props, o };
}

test("UpdateTimeStep banks the time in the object property", () => {
  const { ext, props, o } = setup(() => 0);
  o.speed = 1;
  props.set("7:41", 1);
  assert.equal(ext.UpdateTimeStep(7, 33, 41), 0);
  assert.equal(props.get("7:41"), 34, "old property + ms");
});

test("UpdateTimeStep moves for the banked time and clears the property", () => {
  const { ext, props, o } = setup((_id, ms) => ms);
  o.speed = 2;
  props.set("7:41", 67);
  assert.equal(ext.UpdateTimeStep(7, 33, 41), 100);
  assert.ok(Math.abs(o.pos[2] - 0.2) < 1e-9, "2 units/s for 0.1 s along at");
  assert.equal(props.get("7:41"), 0);
});
