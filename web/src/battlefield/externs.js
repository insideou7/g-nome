// RENDER.R32 externs for the battlefield world, camera and view. Each one
// notes the RENDER.R32 function it follows (addresses in docs/battlefield.md).
// Script units: positions / 100 = RenderWare units, angles in hundredths of
// a degree, times in milliseconds.
import { World, STATE, UNIT } from "./world.js";
import { headingOf, normalize, scale, add } from "./math.js";
import { Controls } from "./controls.js";
import { Mission } from "./mission.js";

export function battlefieldExterns(engine) {
  const world = new World(engine);
  engine.world = world;
  engine.mission = new Mission(engine);
  const controls = (world.controls = new Controls(engine));
  const vm = () => engine.vm;
  const obj = (id) => world.get(id);
  // FUN_1001a290. The motion code (web/src/anim/motion.js) sets
  // engine.spinStep to its version, which first works a pending yaw target
  // with the acceleration-limited controller; without it, spin at the rates.
  const spin = (o, dt) => (engine.spinStep ? engine.spinStep(o, dt) : o.spinFor(dt));
  const out = (addr, v) => {
    if (addr) vm().store(addr, Math.trunc(v));
  };

  return {
    // --- setup and state ---------------------------------------------------
    // Init3D(x, y, w, h, redrawOnlyWhenCameraObjectMoves, ?)
    Init3D(x, y, w, h, onlyMoved) {
      world.init(x, y, w, h, onlyMoved);
      return 1;
    },
    // AllocObjects(n): size of the object array
    AllocObjects(n) {
      world.capacity = n;
      world.clear();
      return 1;
    },
    // FreeAllObjects(script): run script(id) for every object, then empty
    FreeAllObjects(script) {
      const ids = [...world.objects.keys()];
      if (script) for (const id of ids) engine.callScript(script, [id]);
      world.clear();
      return 1;
    },
    // Pause3D(hide): stop the clock; hide != 0 also takes the 3D view off
    // the screen (RtSetComposeBackground(0))
    Pause3D(hide) {
      if (world.state !== STATE.OFF) world.state = STATE.PAUSED;
      if (hide) world.shown = false;
      return 1;
    },
    // Resume3D: run again and make the 3D view the sprites' background
    Resume3D() {
      if (world.state !== STATE.OFF) {
        world.state = STATE.RUNNING;
        world.shown = true;
      }
      return 1;
    },
    FullRedraw() {
      if (![STATE.PAUSED, STATE.STOPPED, STATE.SUSPENDED].includes(world.state)) world.state = STATE.REDRAW;
      return 1;
    },
    // SetBackProcess(on): keep running while the window is in the background
    SetBackProcess() {
      return 1;
    },

    // --- objects in the scene ----------------------------------------------
    // AddObject(id, ?, x, y, z)
    AddObject(id, _, x, y, z) {
      world.add(id, x, y, z);
      return 1;
    },
    SetPosition(id, x, y, z) {
      obj(id)?.setPosition([x / UNIT, y / UNIT, z / UNIT]);
      return 1;
    },
    // GetObjectPosition(id, &x, &y, &z)
    GetObjectPosition(id, px, py, pz) {
      const o = obj(id);
      if (!o) return 0;
      out(px, o.pos[0] * UNIT);
      out(py, o.pos[1] * UNIT);
      out(pz, o.pos[2] * UNIT);
      return 1;
    },
    // RevertPosition: back to the position before the last move (x and z)
    RevertPosition(id) {
      const o = obj(id);
      if (o) {
        o.pos[0] = o.last[0];
        o.pos[2] = o.last[2];
        o.moved = true;
      }
      return 1;
    },
    ObjectMoveUp(id, dy) {
      const o = obj(id);
      if (o) o.pos[1] += dy / UNIT;
      return 1;
    },
    // SetPositionInFront(id, distance): put the object ahead of the camera
    SetPositionInFront(id, dist) {
      const o = obj(id);
      if (o) {
        const p = world.cameraPose(1);
        o.setPosition(add(p.pos, scale(p.at, dist / UNIT)));
      }
      return 1;
    },
    // ObjectYaw / ObjectPitch: turn about the object's own axes
    ObjectYaw(id, a) {
      obj(id)?.turn(a / 100);
      return 1;
    },
    ObjectPitch(id, a) {
      obj(id)?.turn(0, a / 100);
      return 1;
    },
    // ...Absolute: turn about the world axes
    ObjectYawAbsolute(id, a) {
      obj(id)?.turnWorld(a / 100);
      return 1;
    },
    ObjectPitchAbsolute(id, a) {
      obj(id)?.turnWorld(0, a / 100);
      return 1;
    },
    // SetObjectDirAbs(id, roll, pitch, yaw): reset, then turn
    SetObjectDirAbs(id, roll, pitch, yaw) {
      const o = obj(id);
      if (o) {
        o.basis = { right: [1, 0, 0], up: [0, 1, 0], at: [0, 0, 1] };
        o.turn(yaw / 100, pitch / 100, roll / 100);
      }
      return 1;
    },
    // IncrementObjectYaw/Pitch/Roll: add to the angular velocity
    IncrementObjectYaw(id, a) {
      const o = obj(id);
      if (o) o.spin.yaw += a / 100;
      return 1;
    },
    IncrementObjectPitch(id, a) {
      const o = obj(id);
      if (o) o.spin.pitch += a / 100;
      return 1;
    },
    IncrementObjectRoll(id, a) {
      const o = obj(id);
      if (o) o.spin.roll += a / 100;
      return 1;
    },
    // GetObjectHeading: signed angle of the forward vector from +Z, degrees x 100
    GetObjectHeading(id) {
      const o = obj(id);
      if (!o) return 0;
      const h = headingOf(normalize(o.basis.at));
      return h > 18000 ? h - 36000 : h;
    },
    SetGravity(id, g) {
      const o = obj(id);
      if (o) o.gravity = g / UNIT;
      return 1;
    },
    // The radius (+0x58) is shared with SetModelDimensions, which keeps it
    // in the render3d object record.
    SetRadius(id, r) {
      const o = obj(id);
      if (o) o.radius = r / UNIT;
      const rec = engine.render3d?.objects?.get(id);
      if (rec) rec.radius = r / UNIT;
      return 1;
    },
    GetRadius(id) {
      return Math.trunc(world.radiusOf(id) * UNIT);
    },
    // SetLevel(id, level): draw order; ground tiles use -100
    SetLevel(id, level) {
      const o = obj(id);
      if (o) o.level = level;
      return 1;
    },
    SetUpdateScript(id, script) {
      const o = obj(id);
      if (o) o.updateScript = script;
      return 1;
    },
    GetUpdateScript(id) {
      return obj(id)?.updateScript || 0;
    },
    // UpdatePosOrient(id, ms): move by velocity and gravity, spin
    UpdatePosOrient(id, ms) {
      const o = obj(id);
      if (!o) return 0;
      o.move(ms / 1000);
      spin(o, ms / 1000);
      return 1;
    },
    // UpdateTimeStep(id, ms, slot) (0x10011ec1): move forward at the
    // object's speed for the time banked in timer `slot` plus `ms`. For an
    // animated object the animation code decides first (UpdateFrameTerm +
    // doAnimationUpdate): 0 means no frame change yet, so only spin and keep
    // banking time; otherwise move for |result| ms and resync the clip rate.
    UpdateTimeStep(id, ms, slot) {
      const o = obj(id);
      if (!o) return 0;
      o.timers ??= [];
      let t = (o.timers[slot] || 0) + ms;
      const anim = engine.animation;
      if (anim?.timeStep) t = anim.timeStep(id, t) ?? t;
      if (t === 0) {
        spin(o, ms / 1000);
        o.timers[slot] = o.speed ? (o.timers[slot] || 0) + ms : 0;
      } else {
        o.vel = scale(o.basis.at, o.speed);
        anim?.syncRate?.(id);
        o.move(Math.abs(t) / 1000);
        spin(o, ms / 1000);
        o.timers[slot] = 0;
      }
      return t;
    },
    // UpdateGroundCheck(id): 1 while the object is above the ground
    UpdateGroundCheck(id) {
      const o = obj(id);
      if (!o) return 0;
      return world.radiusOf(id) + (o.groundY || 0) - o.pos[1] <= 0 ? 1 : 0;
    },
    // UpdateGroundHeight(id): follow the ground under the object. G-Nome's
    // ground is flat (no AddGround calls), so its height is 0.
    UpdateGroundHeight(id) {
      const o = obj(id);
      if (o) {
        const g = 0;
        o.pos[1] += g - (o.groundY || 0);
        o.groundY = g;
      }
      return 1;
    },
    SetGroundFlag(v) {
      world.groundFlag = v;
      return 1;
    },

    // --- controls ---------------------------------------------------------
    // MapActionKeys(actions, pressTable1, pressTable2, column, mask); a 0
    // action table turns press handling off
    MapActionKeys(actions, ev1, ev2, column, mask) {
      controls.map = actions ? { actions, events: [ev1, ev2], column, mask } : null;
      return 1;
    },
    // CheckActionState(actions, heldTable, action, column, mask)
    CheckActionState(actions, binds, action, column, mask) {
      return controls.check(actions, binds, action, column, mask);
    },
    MouseOnOff(on) {
      controls.mouse = !!on;
      return 1;
    },
    // RangeJoystickAxis(...): no joystick, so the axis rests at 0
    RangeJoystickAxis() {
      return 0;
    },
    EnableJoystick() {
      return 1;
    },

    // --- camera ------------------------------------------------------------
    // SetCamera(x, y, z, atX, atY, atZ)
    SetCamera(x, y, z, ax, ay, az) {
      world.camera.place([x / UNIT, y / UNIT, z / UNIT], normalize([ax, ay, az]));
      return 1;
    },
    // AttachCamera(id, clump, dx, dy, dz): ride on an object's clump
    AttachCamera(id, clump, dx, dy, dz) {
      world.camera.attachTo(id, clump, [dx / UNIT, dy / UNIT, dz / UNIT]);
      return 1;
    },
    SetCameraPitch(a) {
      world.camera.pitch = a / 100;
      return 1;
    },
    SetCameraYaw(a) {
      world.camera.yaw = a / 100;
      return 1;
    },
    GetCameraPitch() {
      return Math.trunc(world.camera.pitch * 100);
    },
    GetCameraYaw() {
      return Math.trunc(world.camera.yaw * 100);
    },
    GetCameraPos(px, py, pz) {
      const p = world.cameraPose(1).pos;
      out(px, p[0] * UNIT);
      out(py, p[1] * UNIT);
      out(pz, p[2] * UNIT);
      return 1;
    },
    // SetCameraClipping(near, far)
    SetCameraClipping(near, far) {
      world.camera.near = near / UNIT;
      world.camera.far = far / UNIT;
      return 1;
    },
    SetCameraViewwindow(w, h) {
      world.camera.viewwindow = [w / 100, h / 100];
      return 1;
    },
    // ViewportCrop(left, top, right, bottom): margins kept for the cockpit
    ViewportCrop(l, t, r, b) {
      world.camera.crop = [l, t, r, b];
      return 1;
    },
    SetBackgroundColor(r, g, b) {
      world.camera.background = [r, g, b];
      return 1;
    },
    // SetFogDepthColor(depth, r, g, b): RenderWare depth cueing towards a
    // colour over the last `depth` units before the far plane; 0 turns it off
    SetFogDepthColor(depth, r, g, b) {
      world.camera.fog = depth > 0 ? { depth: depth / UNIT, color: [r, g, b] } : null;
      return 1;
    },
    // SetCameraBackdrop(bitmap, scroll): panorama behind the scene
    SetCameraBackdrop(bitmap, mode) {
      world.camera.backdrop = bitmap ? { bitmap, mode } : null;
      return 1;
    },
    // AddStars: a no-op in this build of RENDER.R32
    AddStars() {
      return 1;
    },
    // XZToScreen(id, &x, &y, clump, slot): -1 left of the view, 1 right, 0 on it
    XZToScreen(id, px, py) {
      const s = world.toScreen(id);
      if (!s) return 0;
      let x = s.x, y = s.y;
      if (s.behind) x = -Math.sign(x || 1) * 1000;
      out(px, x);
      out(py, y);
      const vp = world.camera.viewport();
      const hw = vp.w / 2, hh = vp.h / 2;
      if (x < -hw + 1) return -1;
      if (x > hw + 1) return 1;
      if (y < -hh + 1 || y > hh + 1) return x < 1 ? -1 : 1;
      return 0;
    },
    // ScreenToXZ(x, y, which): ground point under a screen pixel; which = 0
    // returns x, otherwise z
    ScreenToXZ(sx, sy, which) {
      const vp = world.camera.viewport();
      const g = world.fromScreen(sx - vp.x - vp.w / 2, sy - vp.y - vp.h / 2);
      if (!g) return 0;
      return Math.trunc((which ? g[2] : g[0]) * UNIT);
    },
  };
}
