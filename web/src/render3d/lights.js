// RENDER.R32's light externs (0x10001fe0..0x1000253f). Each one makes or
// changes a RenderWare 2.0 light in the battlefield scene (DAT_1003cf38[9]);
// the preview scene RenderToBitmap draws in never gets lights. Scripts
// address lights by slot number in a table AllocLights sizes.
//
// No G-Nome script calls these, so the original's scenes have no lights and
// models show their surface ambient alone (see materialLight in scene.js).
// They are here so a script that does call them is drawn as RenderWare would.
//
// Script values: colours 0..255, brightness and cone angle in hundredths,
// positions and vectors in script units (/ 100 = RenderWare units, the
// SetScaleFactor default). As with the other externs the first argument of
// the C function (the runtime's context) is not passed.
/** @import { Engine } from "../engine.js" */


export class Lights {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    /** @type {(Record<string, any> | null)[]} */
    this.slots = [];
    this.scale = 100;
  }

  // The scene.lights list of the battlefield scene.
  list() {
    return /** @type {Record<string, any>[]} */ (this.slots.filter(Boolean));
  }

  /**
   * @param {number} i
   */
  get(i) {
    return this.slots[i] ?? null;
  }

  // RwCreateLight(type, 0, 0, 0, 1.0) then RwAddLightToScene: a white light
  // that is on. The zero vector is refused, so the light keeps its frame's
  // +Z (directional) or the -Y RwCreateLight gives cones (30 degree cone).
  // Returns the slot, or -1 when the table is full (FUN_100020aa).
  /**
   * @param {string} type
   */
  add(type) {
    const i = this.slots.findIndex((l) => !l);
    if (i < 0) return -1;
    this.slots[i] = {
      type,
      color: [1, 1, 1],
      direction: type === "conical" ? [0, -1, 0] : [0, 0, 1],
      position: [0, 0, 0],
      coneAngle: Math.PI / 6,
      on: true,
    };
    return i;
  }

  // RwTransformLight(light, clump LTM translated by the offset, replace):
  // the light moves to that point and its vector turns with the clump. The
  // original takes the LTM of the model's own clump, which is where the
  // object showing that model last drew it.
  /**
   * @param {number} i
   * @param {number} model
   * @param {number} clump
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  attach(i, model, clump, x, y, z) {
    const l = this.get(i);
    const world = this.engine.world;
    const r3d = this.engine.render3d;
    if (!l || !world || !r3d) return;
    for (const id of world.objects.keys()) {
      if (r3d.objectModel(id)?.id !== model) continue;
      const p = world.pose(id, clump, 1);
      if (!p) return;
      const { right: r, up: u, at: a } = p.basis;
      const off = [x / this.scale, y / this.scale, z / this.scale];
      l.position = [0, 1, 2].map((k) => p.pos[k] + r[k] * off[0] + u[k] * off[1] + a[k] * off[2]);
      const d = l.direction;
      l.direction = [0, 1, 2].map((k) => r[k] * d[0] + u[k] * d[1] + a[k] * d[2]);
      return;
    }
  }

  /** @returns {Externs} */
  externs() {
    const self = this;
    const clamp01 = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
    const set = (/** @type {number} */ i, /** @type {any} */ f) => {
      const l = self.get(i);
      if (l) f(l);
      return 0;
    };
    return {
      // 0x10001fe0: a new, empty table of n slots. Lights made before stay in
      // the RenderWare scene but can no longer be reached; they are dropped
      // here.
      AllocLights(n) {
        self.slots = new Array(Math.max(0, n | 0)).fill(null);
        return 0;
      },
      LightAddPoint: () => self.add("point"), // 0x1000204b
      LightAddDirectional: () => self.add("directional"), // 0x10002123
      LightAddConical: () => self.add("conical"), // 0x10002182
      // 0x100021e1 (light, model, clump, x, y, z)
      LightAttachToClump(i, model, clump, x, y, z) {
        self.attach(i, model, clump, x, y, z);
        return 0;
      },
      // 0x10002331: RwSetLightBrightness sets a grey colour.
      LightSetBrightness: (i, v) => set(i, (/** @type {any} */ l) => (l.color = new Array(3).fill(clamp01(v / 100)))),
      // 0x1000237d
      LightSetColor: (i, r, g, b) => set(i, (/** @type {any} */ l) => (l.color = [r, g, b].map((c) => clamp01(c / 255)))),
      // 0x100023f5: degrees in hundredths. Only cones take it.
      LightSetConeAngle: (i, v) => set(i, (/** @type {any} */ l) => { if (l.type === "conical") l.coneAngle = (v / 100) * Math.PI / 180; }),
      // 0x10002441
      LightSetPosition: (i, x, y, z) => set(i, (/** @type {any} */ l) => (l.position = [x, y, z].map((c) => c / self.scale))),
      // 0x100024c8: 0 off, 1 on (RenderWare's rwOFF 1 and rwON 2); other
      // values do nothing.
      LightSetState: (i, on) => set(i, (/** @type {any} */ l) => { if (on === 0 || on === 1) l.on = on === 1; }),
      // 0x1000253f: the way the light shines. RenderWare refuses a zero vector.
      LightSetVector: (i, x, y, z) => set(i, (/** @type {any} */ l) => { if (x || y || z) l.direction = [x, y, z].map((c) => c / self.scale); }),
    };
  }
}
