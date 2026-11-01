// Unit tests for the engine side of the cheats (src/debug.js): the Ctrl+I
// invulnerability flag (property 140) follows the player between a pilot
// and the vehicle they board or leave, and nothing else gets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Debug } from "../../src/debug.js";

const PLAYER = 973, ENDED = 1818, INVULNERABLE = 140, PILOT = 78;

// Just enough of an engine: globals and unit properties.
function fakeEngine() {
  const globals = new Map();
  const props = new Map();
  const key = (/** @type {number} */ id, /** @type {number} */ p) => `${id}:${p}`;
  return {
    world: {},
    vm: { getGlobal: (/** @type {number} */ g) => globals.get(g) || 0, setGlobal: (/** @type {number} */ g, /** @type {number} */ v) => globals.set(g, v) },
    render3d: {
      objects: {
        getProperty: (/** @type {number} */ id, /** @type {number} */ p) => props.get(key(id, p)) || 0,
        setProperty: (/** @type {number} */ id, /** @type {number} */ p, /** @type {number} */ v) => props.set(key(id, p), v),
      },
    },
  };
}

test("invulnerability moves to the pilot on eject and back on boarding", () => {
  const e = fakeEngine(), d = new Debug(/** @type {any} */ (e)), o = e.render3d.objects;
  const HAWC = 100, PILOT_ID = 200;
  o.setProperty(HAWC, PILOT, PILOT_ID);
  e.vm.setGlobal(PLAYER, HAWC);
  d.followInvulnerable();
  o.setProperty(HAWC, INVULNERABLE, 1); // Ctrl+I in the HAWC
  d.followInvulnerable();

  // eject (script 2241): the HAWC no longer names its pilot
  o.setProperty(HAWC, PILOT, 0);
  e.vm.setGlobal(PLAYER, PILOT_ID);
  d.followInvulnerable();
  assert.equal(o.getProperty(PILOT_ID, INVULNERABLE), 1, "pilot protected");
  assert.equal(o.getProperty(HAWC, INVULNERABLE), 0, "empty HAWC not protected");

  // board another vehicle (script 2240)
  const OTHER = 300;
  o.setProperty(OTHER, PILOT, PILOT_ID);
  e.vm.setGlobal(PLAYER, OTHER);
  d.followInvulnerable();
  assert.equal(o.getProperty(OTHER, INVULNERABLE), 1, "new vehicle protected");
  assert.equal(o.getProperty(PILOT_ID, INVULNERABLE), 0, "pilot inside not protected");
});

test("a new mission's unit does not inherit invulnerability", () => {
  const e = fakeEngine(), d = new Debug(/** @type {any} */ (e)), o = e.render3d.objects;
  e.vm.setGlobal(PLAYER, 100);
  o.setProperty(100, INVULNERABLE, 1);
  d.followInvulnerable();
  e.vm.setGlobal(PLAYER, 500); // next mission's player, unrelated to 100
  d.followInvulnerable();
  assert.equal(o.getProperty(500, INVULNERABLE), 0);

  // and nothing moves while the mission is over
  e.vm.setGlobal(PLAYER, 100);
  d.followInvulnerable();
  e.vm.setGlobal(ENDED, 1);
  o.setProperty(600, PILOT, 100);
  e.vm.setGlobal(PLAYER, 600);
  d.followInvulnerable();
  assert.equal(o.getProperty(600, INVULNERABLE), 0);
});
