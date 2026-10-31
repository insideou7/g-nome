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
import { identityBasis, copyBasis, lerp, lerpBasis, rotate, add, scale, headingOf, normalize, modelMatrix } from "./math.js";
import { clumpMatrices } from "../render3d/model.js";
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
    this.shown = false; // the 3D view is the screen's background (Resume3D)
    this.origin = [0, 0];
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

  // A level-of-detail record of kind 4 points the object at a model
  // resource directly (+0x98), without a copy.
  setModel(id, model) {
    const rec = this.engine.render3d?.objects?.get(id);
    if (!rec) return;
    rec.model = model;
    rec.flags |= 8;
    if (model) this.engine.render3d.instance(model);
  }

  // The object's radius (+0x58) in world units. SetModelDimensions keeps it
  // in the render3d record, SetRadius in both.
  radiusOf(id) {
    const rec = this.engine.render3d?.objects?.get(id);
    return rec?.radius || this.objects.get(id)?.radius || 0;
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
    o.lastUpdate = Math.round(this.time);
    this.loadBehaviours(o);
    this.firstLevelOfDetail(o);
    return o;
  }

  // AddObject (0x100100f0) picks the level of detail at once, so a unit's
  // model (and the properties its LOD script sets, such as 79) exist before
  // the rest of its setup script runs. Every matching range is applied,
  // from the last record to the first; the distance is to the camera,
  // over the far plane.
  firstLevelOfDetail(o) {
    const list = o.behaviours;
    if (!list?.length) return;
    const cam = this.cameraPose(1).pos;
    const d = Math.hypot(o.pos[0] - cam[0], o.pos[1] - cam[1], o.pos[2] - cam[2]) / this.camera.far;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if ((b.kind === 4 || b.kind === 5) && b.min <= d && d <= b.max) {
        if (b.kind === 4) this.setModel(o.id, b.value);
        else this.engine.callScript(b.value, [o.id]);
        o.lod = i;
      }
    }
  }

  // The object's behaviour records (OB3D/OPRT entries, +0xec): record 0 of
  // kind 6 is the update (interval, script); kind 1 is a timer script;
  // kinds 4 and 5 are level-of-detail ranges (a model, or a script that
  // links one) chosen by distance in FUN_10029059.
  loadBehaviours(o) {
    const rec = this.engine.render3d?.objects?.get(o.id);
    const entries = rec?.entries || [];
    o.behaviours = entries.map((e) => ({ ...e, last: Math.round(this.time) }));
    const first = o.behaviours[0];
    o.hasUpdate = first?.kind === 6;
    if (o.hasUpdate) {
      o.updateInterval = first.a || 0;
      if (first.script && !o.updateScript) o.updateScript = first.script;
    }
    o.lod = 0; // index of the level of detail in use (+0xe0)
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

  // One simulation step (FUN_10029856): snapshot poses, then run the
  // updates. When the camera rides on an object, every object with an
  // update record is stepped whenever that object is (Init3D's "only when
  // moved" flag is 0 in G-Nome); otherwise objects keep their own interval.
  tick() {
    for (const o of this.objects.values()) {
      o.tickPos = o.pos.slice();
      o.tickBasis = copyBasis(o.basis);
    }
    this.time += TICK_MS;
    const now = Math.round(this.time);
    const camObj = this.camera.attach && this.objects.get(this.camera.attach.id);
    let all = false;
    if (camObj?.hasUpdate && this.due(camObj, now)) {
      this.update(camObj, now);
      this.levelOfDetail(camObj, now);
      all = !this.onlyMoved || camObj.moved;
      camObj.moved = false;
    }
    for (const o of [...this.objects.values()]) {
      if (o === camObj || !o.hasUpdate || !this.objects.has(o.id)) continue;
      if (!(all || (camObj ? this.onlyMoved && this.due(o, now) : this.due(o, now)))) continue;
      this.update(o, now);
      if (this.state === STATE.OFF) return;
      if (this.objects.has(o.id)) this.levelOfDetail(o, now);
    }
    for (const fn of this.tickListeners) fn(TICK_MS);
    if (this.state === STATE.REDRAW) this.state = STATE.RUNNING;
  }

  due(o, now) {
    return now - o.lastUpdate >= o.updateInterval;
  }

  // FUN_10028fb2: run the update script with the time since the last one.
  update(o, now) {
    const dt = Math.min(MAX_STEP_MS, now - o.lastUpdate);
    o.lastUpdate = now;
    if (o.updateScript) this.engine.callScript(o.updateScript, [o.id, dt]);
  }

  // FUN_10029059: timers (kind 1) and level of detail (kinds 4, 5). The
  // distance is an octagonal approximation in x/z divided by the far plane.
  levelOfDetail(o, now) {
    const list = o.behaviours;
    if (!list || list.length < 2) return;
    const cam = this.cameraPose(1).pos;
    let dx = Math.abs(o.pos[0] - cam[0]), dz = Math.abs(o.pos[2] - cam[2]);
    const d = (dx + dz - Math.min(dx, dz) / 2) / this.camera.far;
    const cur = o.lod && list[o.lod];
    let chosen = !!(cur && cur.min <= d && d <= cur.max);
    for (let i = list.length - 1; i > 0; i--) {
      const b = list[i];
      if (b.kind === 1) {
        if (now - b.last > b.a) {
          b.last = now;
          if (b.b) this.engine.callScript(b.b, [o.id]);
        }
      } else if ((b.kind === 4 || b.kind === 5) && !chosen && b.min <= d && d <= b.max) {
        if (b.kind === 4) this.setModel(o.id, b.value);
        else this.engine.callScript(b.value, [o.id, this.engine.render3d?.objects?.get(o.id)?.model || 0]);
        o.lod = i;
        chosen = true;
      }
    }
  }

  // Interpolated pose of an object for drawing. With `clump` > 0 it is the
  // pose of that tagged clump of the object's model (RwGetClumpLTM), e.g. the
  // cockpit the camera sits in.
  pose(id, clump = 0, t = this.alpha) {
    const o = this.objects.get(id);
    if (!o) return null;
    const pos = lerp(o.tickPos, o.pos, t);
    const basis = t >= 1 ? copyBasis(o.basis) : lerpBasis(o.tickBasis, o.basis, t);
    if (!clump) return { pos, basis };
    const inst = this.engine.render3d?.objectModel?.(id);
    const i = inst ? inst.clump(clump) : -1;
    if (i < 0) return { pos, basis };
    const m = clumpMatrices(inst.model, modelMatrix(basis, pos), inst.pose, inst.joints)[i];
    return {
      pos: [m[12], m[13], m[14]],
      basis: { right: normalize([m[0], m[1], m[2]]), up: normalize([m[4], m[5], m[6]]), at: normalize([m[8], m[9], m[10]]) },
    };
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
