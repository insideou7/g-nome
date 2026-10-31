// RENDER.R32's model animation system, reimplemented from the decompiled
// plugin (addresses below). Spec: docs/formats/animation.md.
//
// An object plays FRME animations on its model. Scripts give each object a
// list of animation slots (createAnimationList + addAnimation), triggers that
// switch slots when the object's speed changes (addTrigger), and install one
// (installAnimationType). Each 30 Hz tick, UpdateTimeStep advances the frame
// by the distance the object moved (frames per second = speed / stride) or
// by a fixed rate, and when a clip runs off its end, moves on to the next
// slot, runs the slot's end script, or loops.
//
// The engine owns objects elsewhere: the renderer core (engine.render3d,
// web/src/render3d) keeps properties and models, the battlefield
// (engine.world) keeps motion. This module reaches them through a small host
// interface, which tests can replace:
//   host.speed(id)                forward speed in world units/s (+0x80)
//   host.prop(id, n)              GetProperty(id, n)
//   host.hasModel(id)             whether a model is linked (+0x98)
//   host.applyFrame(id, frme, f)  pose the object's model with frame f
//   host.poseModel(model, frme, f)  the same for a model copy id
//   host.setBob(id, v)            trigger conditions 8 and 9 write a float
//                                 at object +0x10 (meaning unknown)
import { Frme } from "./formats.js";

// Pose a render3d ModelInstance: its pose is an array indexed by clump
// index; frame part k moves the clump tagged k + 1.
export function setPose(inst, frme, f) {
  if (!inst || !frme.frames) return;
  f = Math.max(0, Math.min(frme.frames - 1, f | 0));
  const pose = [];
  for (let k = 1; k <= frme.parts; k++) {
    const ci = inst.model.tagged[k];
    if (ci !== undefined) pose[ci] = frme.matrix(f, k);
  }
  inst.pose = pose;
}

// World units per script unit: Init3D sets 100.0 at plugin context +0xB4.
export const SCRIPT_SCALE = 100;

// __ftol(x +/- 0.5): round half away from zero.
const rnd = (x) => (x < 0 ? Math.ceil(x - 0.5) : Math.floor(x + 0.5));
const ftol = (x) => Math.trunc(x);

export class AnimationSystem {
  constructor(engine, host = {}) {
    this.engine = engine;
    this.frmes = new Map(); // resource id -> Frme
    this.state = new Map(); // object id -> per-object animation state
    this.host = {
      speed: (id) => engine.world?.get?.(id)?.speed ?? 0,
      prop: (id, n) => engine.render3d?.objects.getProperty(id, n) ?? 0,
      hasModel: (id) => !!engine.render3d?.objectModel(id),
      applyFrame: (id, frme, f) => setPose(engine.render3d?.objectModel(id), frme, f),
      poseModel: (model, frme, f) => setPose(engine.render3d?.instance(model), frme, f),
      setBob: () => {},
      ...host,
    };
  }

  frme(id) {
    if (!id) return null;
    let f = this.frmes.get(id);
    if (!f) {
      f = new Frme(this.engine.res(id));
      this.frmes.set(id, f);
    }
    return f;
  }

  // Object fields +0x9C..+0xBC and +0xA0..+0xB0.
  obj(id) {
    let s = this.state.get(id);
    if (!s) {
      s = {
        slots: [], // +0xA0 / +0xA4: animation records
        current: 0, // +0xA8: 1-based slot playing, 0 = none
        pending: 0, // +0xAC: slot a deferred trigger chose
        lod: 0, // +0xB0: level of detail 0-2
        frmeId: 0, // +0x9C: FRME being played
        frame: 0, // +0xBC: current frame (float)
        rate: 0, // +0xB4: frames per second
        stride: 0, // +0xB8: world units per frame, 0 = fixed rate
      };
      this.state.set(id, s);
    }
    return s;
  }

  apply(id, s) {
    const f = this.frme(s.frmeId);
    if (f && this.host.hasModel(id)) this.host.applyFrame(id, f, ftol(rnd(s.frame)));
  }

  slotOfFrme(s, frmeId) {
    const i = s.slots.findIndex((r) => r && r.frmes[0] === frmeId);
    return i + 1; // 0 if not found (0x1000b05a)
  }

  // FRME of `slot` for the object's LOD; when moving backwards, a slot with a
  // reverse animation plays that animation's frames instead (backwards).
  pickFrme(id, s, slot) {
    const rec = s.slots[slot - 1];
    if (this.host.speed(id) >= 0 || !rec.reverse) return rec.frmes[s.lod];
    const r = s.slots[this.slotOfFrme(s, rec.reverse) - 1];
    return r ? r.frmes[s.lod] : rec.frmes[s.lod];
  }

  // ---------------------------------------------------------------- externs

  // createAnimationList(obj, n) 0x1000aadc
  createList(id, n) {
    const s = this.obj(id);
    s.slots = new Array(Math.max(0, n)).fill(null);
    s.current = 0;
    return 1;
  }

  // removeAnimations(obj) 0x1000ab87
  removeAll(id) {
    const s = this.obj(id);
    s.slots = [];
    s.current = 0;
    s.frmeId = 0;
    return 0;
  }

  // addAnimation(obj, slot, type, frme0, frme1, frme2, stride, next,
  //              reverse, endScript) 0x1000ae57
  add(id, slot, type, f0, f1, f2, stride, next, reverse, endScript) {
    const s = this.obj(id);
    if (slot < 0) return 0;
    s.slots[slot] = {
      type, // +0x00
      stride: stride / 1000, // +0x04: script units -> seconds or world units
      next, // +0x08: FRME of the slot to play after this one; 0 loops
      reverse, // +0x0C: FRME of the slot whose frames play backwards when speed < 0
      endScript, // +0x10: script run (with the object id) when the clip ends
      triggers: [], // +0x14 count, +0x18: up to 4 x {immediate, cond, slot}
      frmes: [f0, f1, f2], // +0x54..+0x5C, one per level of detail
    };
    return 1;
  }

  // addTrigger(obj, frme, cond, targetFrme, immediate) 0x1000b961
  addTrigger(id, frmeId, cond, target, immediate) {
    const s = this.obj(id);
    const slot = this.slotOfFrme(s, frmeId);
    if (!slot) return 0;
    const t = s.slots[slot - 1].triggers;
    if (t.length >= 4) return 0;
    t.push({ immediate, cond, slot: this.slotOfFrme(s, target) });
    return 1;
  }

  // findAnimationType(obj, type) 0x1000b0f7: 1-based slot or 0
  findType(id, type) {
    const s = this.obj(id);
    return s.slots.findIndex((r) => r && r.type === type) + 1;
  }

  // getCurrentAnimationType(obj) 0x1000b5c7
  currentType(id) {
    const s = this.obj(id);
    return s.current ? (s.slots[s.current - 1]?.type ?? 0) : 0;
  }

  // installAnimation(obj, slot) 0x1000b338 (slot is 1-based)
  install(id, slot) {
    const s = this.obj(id);
    const rec = s.slots[slot - 1];
    if (!rec) return 0;
    const backwards = this.host.speed(id) < 0 && rec.reverse;
    s.frmeId = this.pickFrme(id, s, slot);
    const f = this.frme(s.frmeId);
    s.stride = rec.stride;
    s.pending = 0;
    s.frame = backwards && f ? f.frames - 1 : 0;
    s.current = slot;
    this.apply(id, s);
    return 0;
  }

  // installAnimationType(obj, type) 0x1000b573
  installType(id, type) {
    const slot = this.findType(id, type);
    if (slot) this.install(id, slot);
    return slot ? 1 : 0;
  }

  // setLOD(obj, lod) 0x1000b193: same clip and frame, other FRME
  setLOD(id, lod) {
    const s = this.obj(id);
    s.lod = lod;
    if (s.current) {
      s.frmeId = this.pickFrme(id, s, s.current);
      s.stride = s.slots[s.current - 1].stride;
    }
    return 0;
  }

  // SetAnimation(obj, frme, stride) 0x10016538: play one FRME directly
  setAnimation(id, frmeId, stride) {
    const s = this.obj(id);
    s.stride = stride / 1000;
    if (stride) s.rate = this.host.speed(id) / s.stride;
    s.frmeId = frmeId || 0;
    return 0;
  }

  // SetObjectFramerate(obj, n) 0x10016b8f: n / 100 frames per second
  setFramerate(id, n) {
    this.obj(id).rate = n / SCRIPT_SCALE;
    return 0;
  }

  // AnimateFrame(obj, frme, frame) 0x100105ec: show one frame
  animateFrame(id, frmeId, frame) {
    const s = this.obj(id);
    s.frame = frame;
    const f = this.frme(frmeId);
    if (f && this.host.hasModel(id)) this.host.applyFrame(id, f, frame);
    return 1;
  }

  // UpdateFrameTerm(obj, ms) 0x10017d88. Advances by whole frames. Returns 0
  // if the shown frame did not change, -ms if the clip ran off either end
  // (the frame is left outside the clip), else ms.
  //
  // With no clip or a zero rate the original returns an uninitialised local.
  // A stopped unit (rate = speed / stride = 0) must still leave its walk
  // clip for the stop and idle clips its triggers queue, which only happens
  // when the clip "ends", so this returns -ms there. Without a model the
  // original returns ms.
  frameTerm(id, ms) {
    const s = this.obj(id);
    const f = this.frme(s.frmeId);
    if (!this.host.hasModel(id)) return ms | 0;
    if (!f || s.rate === 0) return -ms | 0;
    const dt = ms / 1000;
    const adv = s.rate * dt;
    const delta = rnd(s.frame + adv) - rnd(s.frame);
    if (delta === 0) return 0;
    s.frame += delta;
    const shown = rnd(s.frame);
    if (shown >= f.frames || shown < 0) return ftol(Math.abs(dt) * -1000);
    this.apply(id, s);
    return ftol(Math.abs(dt) * 1000);
  }

  // UpdateFrameCycle(obj, ms) 0x10017b20: like frameTerm but wraps around.
  frameCycle(id, ms) {
    const s = this.obj(id);
    const f = this.frme(s.frmeId);
    if (!f || s.rate === 0 || !this.host.hasModel(id)) return ftol(s.frame);
    const delta = rnd(s.frame + s.rate * (ms / 1000)) - rnd(s.frame);
    if (delta === 0) return 0;
    s.frame += delta;
    this.wrap(s, f);
    this.apply(id, s);
    return ftol(s.frame);
  }

  wrap(s, f) {
    while (rnd(s.frame) >= f.frames) s.frame -= f.frames;
    while (rnd(s.frame) < 0) s.frame += f.frames;
  }

  // doAnimationUpdate(obj, status) 0x1000b75a. status is frameTerm's result.
  update(id, status) {
    const s = this.obj(id);
    if (!s.current) return 0;
    if (this.checkTriggers(id, s)) return 0;
    if (status >= 0) return 0;
    const rec = s.slots[s.current - 1];
    let next = s.pending;
    if (next === 0) {
      next = rec.next;
      if (next > 0) next = this.slotOfFrme(s, next);
    }
    if (rec.endScript) this.engine.runLater?.(rec.endScript, [id]);
    if (next > 0) this.install(id, next);
    else if (next === 0) {
      const f = this.frme(s.frmeId);
      if (f) {
        this.wrap(s, f);
        this.apply(id, s);
      }
    }
    return 0;
  }

  // 0x1000b65d: the first trigger whose condition holds either switches now
  // (immediate) or queues its slot for when the clip ends.
  checkTriggers(id, s) {
    const rec = s.slots[s.current - 1];
    for (const t of rec?.triggers ?? []) {
      if (!t.cond || !(this.condition(id, s, t.cond) > 0)) continue;
      if (!t.immediate) {
        s.pending = t.slot;
        return false;
      }
      if (t.slot) this.install(id, t.slot);
      return true;
    }
    return false;
  }

  // Trigger conditions, the table at 0x10037970. v is the speed in script
  // units; properties 12, 15 and 33 are set by the unit scripts.
  condition(id, s, cond) {
    const speed = this.host.speed(id);
    const v = Math.abs(speed) * SCRIPT_SCALE;
    const prop = (n) => this.host.prop(id, n);
    switch (cond) {
      case 1: // stopped: no turn order (prop 12) and slower than prop 33 + 2
        return prop(12) === 0 && v <= prop(33) + 2 ? 1 : 0;
      case 2:
        return speed !== 0 ? 1 : 0;
      case 3:
        return v > 0 ? 1 : 0;
      case 4: // walking: moving, no faster than prop 15
        return v > 0 && v <= prop(15) ? 1 : 0;
      case 5: // running: faster than prop 15
        return v > prop(15) ? 1 : 0;
      case 6:
        return speed > 0 ? 1 : 0;
      case 7:
        return speed < 0 ? 1 : 0;
      case 8: // never fires; sets +0x10 from the frame (0x1000c30e)
      case 9: {
        const r = rnd(s.frame);
        const fwd = cond === 8 ? speed > 0 : speed < 0;
        const k = speed === 0 ? 0 : fwd ? r + 1 : 17 - r;
        this.host.setBob(id, k * 0.018757);
        return 0;
      }
      case 10: // prop 12 points against the direction of travel
        return (prop(12) < 0 && speed > 0) || (prop(12) > 0 && speed < 0) ? 1 : 0;
      default:
        return 0;
    }
  }

  // What UpdateTimeStep (0x10011ec1) does for an object with an animation
  // list: ms is the time accumulated since the frame last changed. Returns
  // the value UpdateTimeStep continues with (0 = frame unchanged).
  timeStep(id, ms) {
    const s = this.state.get(id);
    if (!s || !s.slots.length) return ms;
    const r = this.frameTerm(id, ms);
    this.update(id, r);
    return r;
  }

  // UpdateTimeStep recomputes the rate from the speed each step when the
  // clip has a stride (+0xB8 != 0).
  syncRate(id) {
    const s = this.state.get(id);
    if (s && s.stride) s.rate = this.host.speed(id) / s.stride;
  }
}

// The animation externs, for RenderPlugin's table. Every one takes the
// object's resource id first, as the scripts pass it.
export function animationExterns(anim) {
  return {
    animationSetupProps: () => 0,
    createAnimationList: (id, n) => anim.createList(id, n),
    removeAnimations: (id) => anim.removeAll(id),
    addAnimation: (id, slot, type, f0, f1, f2, stride, next, rev, script) =>
      anim.add(id, slot, type, f0, f1, f2, stride, next, rev, script),
    addTrigger: (id, frme, cond, target, immediate) => anim.addTrigger(id, frme, cond, target, immediate),
    installAnimation: (id, slot) => anim.install(id, slot),
    installAnimationType: (id, type) => anim.installType(id, type),
    findAnimationType: (id, type) => anim.findType(id, type),
    getCurrentAnimationType: (id) => anim.currentType(id),
    doAnimationUpdate: (id, status) => anim.update(id, status),
    setLOD: (id, lod) => anim.setLOD(id, lod),
    SetAnimation: (id, frme, stride) => anim.setAnimation(id, frme, stride),
    SetObjectFramerate: (id, n) => anim.setFramerate(id, n),
    AnimateFrame: (id, frme, frame) => anim.animateFrame(id, frme, frame),
    // AnimateModelFrame(model, frme, frame) 0x100106bb: pose a model copy
    AnimateModelFrame(model, frme, frame) {
      const f = anim.frme(frme);
      if (f) anim.host.poseModel(model, f, frame);
      return 1;
    },
    UpdateFrameTerm: (id, ms) => anim.frameTerm(id, ms),
    UpdateFrameCycle: (id, ms) => anim.frameCycle(id, ms),
    GetNumFrames: (frme) => anim.frme(frme)?.frames ?? 0,
  };
}
