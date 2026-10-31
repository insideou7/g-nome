// The battlefield world: which objects are in the 3D scene, where they are,
// how they move each tick, and the camera. This is the part of RENDER.R32
// around its object array (DAT_10040264) and its frame loop (FUN_10029856).
//
// Simulation runs on a fixed tick (TICK_MS). Each tick runs the objects'
// update scripts with that tick's elapsed milliseconds, as RENDER.R32 does
// once per frame. Drawing happens at the display rate and blends each
// object between its pose at the start and end of the current tick.
//
// Object records (properties, models) belong to web/src/render3d/objects.js;
// this file only keeps transforms and motion state, keyed by the same id.
import { BattleCamera, project, screenToGround } from "./camera.js";
import { identityBasis, copyBasis, lerp, lerpBasis, rotate, add, scale, headingOf } from "./math.js";
import { BattleView } from "./view.js";

export const UNIT = 100; // script units per RenderWare unit (Init3D: 100.0f)
export const TICK_MS = 1000 / 30;
const MAX_STEP_MS = 250; // FUN_10028fb2 clamps an update's elapsed time to 0.25 s
const MAX_TICKS_PER_FRAME = 8; // don't spiral after a stall

// RENDER.R32's 3D state (DAT_1003cf40).
export const STATE = { OFF: 0, RUNNING: 1, PAUSED: 4, REDRAW: 5, SUSPENDED: 6, STOPPED: -1 };

export class WorldObject {
  constructor(id) {
    this.id = id;
    this.pos = [0, 0, 0]; // +0x0c
    this.last = [0, 0, 0]; // +0x24, position before the last move (RevertPosition)
    this.vel = [0, 0, 0]; // +0x18
    this.gravity = 0; // +0x7c, added to vel[1] per second
    this.speed = 0; // +0x80, forward speed used by UpdateTimeStep
    this.basis = identityBasis(); // +0x3c right, +0x48 up, +0x30 at
    this.spin = { pitch: 0, yaw: 0, roll: 0 }; // +0x60, +0x64, +0x68, degrees per second
    this.level = 0; // +0x88, draw order (SetLevel): lower draws first
    this.updateScript = 0; // +0xf0 (SetUpdateScript)
    this.updateInterval = 0; // ms between updates (behaviour type 6 at +0xf4)
    this.lastUpdate = 0; // +0xf8
    this.visible = true;
    this.moved = true; // +0x54 bit 3
    // Pose at the start of the current tick, for drawing between ticks.
    this.tickPos = this.pos.slice();
    this.tickBasis = copyBasis(this.basis);
  }

  setPosition(p) {
    this.pos = p.slice();
    this.last = p.slice();
    this.moved = true;
  }

  // FUN_100050d0: rotate about the object's own axes as they were before
  // the call: pitch about right, then yaw about up, then roll about at.
  // Degrees, right-hand rule.
  turn(yaw, pitch = 0, roll = 0) {
    const b = this.basis;
    this.rotateBy([
      [b.right.slice(), pitch],
      [b.up.slice(), yaw],
      [b.at.slice(), roll],
    ]);
  }

  // FUN_1000533a ("Absolute" externs): the same about the world axes X, Y, Z.
  turnWorld(yaw, pitch = 0, roll = 0) {
    this.rotateBy([
      [[1, 0, 0], pitch],
      [[0, 1, 0], yaw],
      [[0, 0, 1], roll],
    ]);
  }

  rotateBy(steps) {
    steps = steps.filter((s) => s[1]);
    if (!steps.length) return;
    const r = (v) => steps.reduce((v, [axis, deg]) => rotate(v, axis, deg), v);
    const b = this.basis;
    this.basis = { right: r(b.right), up: r(b.up), at: r(b.at) };
    this.moved = true;
  }

  // FUN_1001a754: move by velocity (gravity bends vel[1]); remembers the old
  // position in `last`.
  move(dt) {
    this.last = this.pos.slice();
    this.vel[1] += this.gravity * dt;
    this.pos = add(this.pos, scale(this.vel, dt));
    this.moved = true;
  }

  // FUN_1001a290: spin at the angular velocities.
  spinFor(dt) {
    this.turn(this.spin.yaw * dt, this.spin.pitch * dt, this.spin.roll * dt);
  }

  heading() {
    return headingOf(this.basis.at);
  }
}

export class World {
  constructor(engine) {
    this.engine = engine;
    this.state = STATE.OFF;
    this.objects = new Map(); // id -> WorldObject, in AddObject order
    this.capacity = 0; // AllocObjects
    this.camera = new BattleCamera();
    this.time = 0; // simulation clock, ms
    this.acc = 0; // ms not yet simulated
    this.alpha = 0; // how far drawing is into the current tick, 0..1
    this.groundFlag = 0; // SetGroundFlag (DAT_1003cfc0)
    this.onlyMoved = 0; // Init3D's last argument: redraw only when the camera object moved
    this.view = new BattleView(this);
    this.tickListeners = new Set();
  }

  // Init3D(x, y, w, h, ?, onlyMoved)
  init(x, y, w, h, onlyMoved) {
    this.camera.width = w || 640;
    this.camera.height = h || 480;
    this.origin = [x, y];
    this.onlyMoved = onlyMoved;
    this.state = STATE.RUNNING;
  }

  get(id) {
    return this.objects.get(id) || null;
  }

  // AddObject(id, ?, x, y, z): put an object into the scene at a position.
  add(id, x, y, z) {
    let o = this.objects.get(id);
    if (!o) {
      o = new WorldObject(id);
      this.objects.set(id, o);
    }
    o.setPosition([x / UNIT, y / UNIT, z / UNIT]);
    o.tickPos = o.pos.slice();
    o.lastUpdate = this.time;
    return o;
  }

  remove(id) {
    const o = this.objects.get(id);
    if (!o) return;
    this.view.drop(o);
    this.objects.delete(id);
    if (this.camera.attach?.id === id) this.camera.attach = null;
  }

  clear() {
    for (const o of this.objects.values()) this.view.drop(o);
    this.objects.clear();
    this.camera.attach = null;
  }

  // Called by other modules (motion, AI) that change transforms: they run
  // inside update scripts, so changes land in the current tick.
  onTick(fn) {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  // Advance the simulation by real elapsed time; called every display frame.
  advance(ms) {
    if (this.state === STATE.OFF || this.state === STATE.STOPPED) return;
    if (this.state === STATE.PAUSED || this.state === STATE.SUSPENDED) {
      this.alpha = 1;
      return;
    }
    this.acc += Math.min(ms, MAX_TICKS_PER_FRAME * TICK_MS);
    let n = 0;
    while (this.acc >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
      this.acc -= TICK_MS;
      this.tick();
      n++;
      if (this.state !== STATE.RUNNING && this.state !== STATE.REDRAW) break;
    }
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }

  // One simulation step: snapshot poses, then run due update scripts. The
  // camera's object goes first, as in FUN_10029856.
  tick() {
    for (const o of this.objects.values()) {
      o.tickPos = o.pos.slice();
      o.tickBasis = copyBasis(o.basis);
    }
    this.time += TICK_MS;
    const now = Math.round(this.time);
    const camId = this.camera.attach?.id;
    if (camId) this.update(this.objects.get(camId), now);
    for (const o of [...this.objects.values()]) {
      if (o.id !== camId) this.update(o, now);
      if (this.state === STATE.OFF) return;
    }
    for (const fn of this.tickListeners) fn(TICK_MS);
    if (this.state === STATE.REDRAW) this.state = STATE.RUNNING;
  }

  update(o, now) {
    if (!o || !o.updateScript || !this.objects.has(o.id)) return;
    if (now - o.lastUpdate < o.updateInterval) return;
    const dt = Math.min(MAX_STEP_MS, now - o.lastUpdate);
    o.lastUpdate = now;
    this.engine.callScript(o.updateScript, [o.id, dt]);
  }

  // Interpolated pose of an object for drawing. `clump` selects a sub-clump
  // (turret etc.); the model code can refine that through objectClumpPose.
  pose(id, clump = 0, t = this.alpha) {
    const o = this.objects.get(id);
    if (!o) return null;
    let pos = lerp(o.tickPos, o.pos, t), basis = t >= 1 ? copyBasis(o.basis) : lerpBasis(o.tickBasis, o.basis, t);
    const sub = clump && this.engine.objects?.clumpOffset?.(id, clump);
    if (sub) pos = add(pos, add(add(scale(basis.right, sub[0]), scale(basis.up, sub[1])), scale(basis.at, sub[2])));
    return { pos, basis };
  }

  cameraPose(t = this.alpha) {
    return this.camera.pose((id, clump) => this.pose(id, clump, t));
  }

  // XZToScreen: where an object appears, relative to the viewport centre.
  toScreen(id) {
    const p = this.pose(id, 0, 1);
    if (!p) return null;
    const cam = this.camera;
    return project(this.cameraPose(1), cam.viewwindow, cam.viewport(), p.pos);
  }

  // ScreenToXZ: the ground point under a viewport pixel (centre-relative).
  fromScreen(sx, sy) {
    const cam = this.camera;
    return screenToGround(this.cameraPose(1), cam.viewwindow, cam.viewport(), sx, sy);
  }

}
