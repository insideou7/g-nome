// What the combat externs need from the rest of the engine: the battlefield
// world (transforms), the renderer core (properties, model copies), other
// RENDER.R32 externs, and RTLIB32's RtRunMsg / RtRun for calling back into
// the game's scripts.
import { UNIT } from "../battlefield/world.js";

export { UNIT };

export class CombatHost {
  constructor(engine) {
    this.engine = engine;
  }

  get world() {
    return this.engine.world || null;
  }
  get r3d() {
    return this.engine.render3d || null;
  }
  get vm() {
    return this.engine.vm;
  }

  obj(id) {
    return id ? this.world?.get(id) || null : null;
  }
  prop(id, n) {
    return this.r3d?.objects.getProperty(id, n) ?? 0;
  }
  setProp(id, n, v) {
    this.r3d?.objects.setProperty(id, n, v | 0);
  }
  // The object's radius (+0x58) in world units. SetRadius keeps it on the
  // battlefield object and SetModelDimensions on the renderer's record.
  radius(id) {
    return this.obj(id)?.radius || this.r3d?.objects.get(id)?.radius || 0;
  }
  // The model copy an object draws (LinkModel, else property 39).
  model(id) {
    return this.r3d?.objectModel(id) || null;
  }

  // Another RENDER.R32 extern by name, called the way the VM calls it, or
  // null when nobody has implemented it yet.
  extern(name) {
    const p = this.engine.plugins?.find((q) => q.name === "render");
    const f = p?.externs[name];
    return f ? (...args) => f.apply(p, args) | 0 : null;
  }

  // A word of VM memory, e.g. element n of the callback table the scripts
  // pass as &G1861[0].
  word(addr, n = 0) {
    return addr ? this.vm.load(addr + 4 * n) : 0;
  }

  // RtRunMsg with a "call script" record (statement 1) that RENDER.R32
  // builds on its stack: the script runs at once with `args` as L0.. and a
  // caller frame of 0 locals, and the call returns the script's return
  // value. RtRun(script, a, b) is the same with two arguments.
  run(script, ...args) {
    if (!script) return 0;
    const vm = this.vm;
    if (vm.callValue) return vm.callValue(script, args.map((a) => a | 0)) | 0;
    const saved = vm.retval;
    vm.retval = 0;
    try {
      vm.callScript(script, 0, args.map((a) => a | 0));
    } catch (e) {
      this.engine.log(`script ${script} failed: ${e.message}`);
    }
    const r = vm.retval | 0;
    vm.retval = saved;
    return r;
  }
}
