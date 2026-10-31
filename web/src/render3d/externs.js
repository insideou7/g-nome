// RENDER.R32 externs for objects, models and model previews. Each one is
// written from the Ghidra decompile of RENDER.R32 (address in the comment).
// Scripts call fn(args...) and get an int back; floats are passed as ints
// (thousandths, or hundredths of a degree for angles).
//
// Clump numbers in scripts: 0 is the model's root clump, k > 0 is the clump
// tagged k (model op 0x2D).
import { Renderer } from "./renderer.js";
import { Objects } from "./objects.js";
import { modelBounds } from "./model.js";
import { Lights } from "./lights.js";

// Per-copy model state. RENDER.R32 gives every CopyResource of a model its
// own RenderWare clump, so opacity, double-siding and texture swaps are per
// copy. SceneNodes built from an instance share these arrays.
export class ModelInstance {
  constructor(id, model) {
    this.id = id;
    this.model = model;
    this.pose = null;
    this.clumpOpacity = [];
    this.clumpHidden = [];
    this.doubleSided = [];
    this.hints = [];
    this.textureOverride = null;
    this.textureFrame = 0;
  }
  // Script clump number -> index into model.clumps (-1 if none).
  clump(k) {
    if (!k) return this.model.roots[0] ?? -1;
    return this.model.tagged[k] ?? -1;
  }
}

export function install3D(plugin) {
  const engine = plugin.engine;
  const renderer = new Renderer(engine);
  // engine.render3d: the API the battlefield and animation code use.
  // See docs/render3d.md.
  const r3d = {
    renderer,
    objects: new Objects(engine),
    // Lights of the battlefield scene (Light* externs, lights.js).
    lights: new Lights(engine),
    instances: new Map(), // model copy id -> ModelInstance
    createScene: () => renderer.createScene(),
    createCamera: () => renderer.createCamera(),
    render: (scene, camera, viewport, opts) => renderer.render(scene, camera, viewport, opts),
    // What an object (OB3D/OPRT copy) draws: the ModelInstance of its
    // linked model (LinkModel, else property 39), or null.
    objectModel(id) {
      const o = this.objects.get(id);
      if (!o) return null;
      const m = o.model || o.props[39];
      return m ? this.instance(m) : null;
    },
    // A type 1 bitmap as ImageData (or {width, height, data} in Node) in the
    // current palette; colour 0 transparent.
    bitmapImage(id) {
      const bm = engine.sprites.bitmap(id);
      const data = new Uint8ClampedArray(bm.width * bm.height * 4);
      const pal = engine.palette;
      for (let i = 0; i < bm.pixels.length; i++) {
        const c = bm.pixels[i];
        if (!c) continue;
        data[i * 4] = pal[c * 3]; data[i * 4 + 1] = pal[c * 3 + 1]; data[i * 4 + 2] = pal[c * 3 + 2]; data[i * 4 + 3] = 255;
      }
      return typeof ImageData !== "undefined" ? new ImageData(data, bm.width, bm.height) : { width: bm.width, height: bm.height, data };
    },
    instance(id) {
      let inst = this.instances.get(id);
      if (!inst) {
        const model = this.renderer.loadModel(id);
        if (!model) return null;
        inst = new ModelInstance(id, model);
        this.instances.set(id, inst);
      }
      return inst;
    },
  };
  engine.render3d = r3d;
  const { objects } = r3d;
  const perClump = (field, conv) => (obj, k, v) => {
    const o = objects.get(obj);
    const inst = o && o.model && r3d.instance(o.model);
    const ci = inst ? inst.clump(k) : -1;
    if (ci >= 0) inst[field][ci] = conv(v);
    return 0;
  };

  Object.assign(plugin.externs, r3d.lights.externs(), {
    // 0x1001271e / 0x10016c09
    GetProperty: (obj, p) => objects.getProperty(obj, p),
    SetProperty(obj, p, v) {
      objects.setProperty(obj, p, v);
      return 0;
    },
    // 0x10012af7: attach a model copy to an object (0 detaches). Returns the
    // id of the model it replaced... in the original, a pointer; scripts
    // ignore it.
    LinkModel(obj, model) {
      const o = objects.get(obj);
      if (!o) return 0;
      o.model = model;
      o.flags |= 8;
      if (model) r3d.instance(model);
      return 0;
    },
    // 0x10014335: flag 0x100 of the object
    ObjectSetState(obj, on) {
      const o = objects.get(obj);
      if (o) o.flags = on ? o.flags | 0x100 : o.flags & ~0x100;
      return 0;
    },
    // 0x100123de
    GetNumClumps(model) {
      const inst = r3d.instance(model);
      return inst ? inst.model.count : 0;
    },
    // 0x100087ab: pose the model (FRME `frame`, frame 0), measure it, store
    // x/y/z in thousandths in the object's properties px/py/pz and the
    // radius max(x, z) / 2 in metres.
    SetModelDimensions(model, frame, obj, px, py, pz) {
      const inst = r3d.instance(model);
      const o = objects.get(obj);
      if (!inst || !o) return 0;
      const pose = frame ? r3d.renderer.frame(inst.model, frame, 0) : null;
      const b = modelBounds(inst.model, pose);
      const dx = Math.trunc((b.max[0] - b.min[0]) * 1000), dy = Math.trunc((b.max[1] - b.min[1]) * 1000), dz = Math.trunc((b.max[2] - b.min[2]) * 1000);
      objects.setProperty(obj, px, dx);
      objects.setProperty(obj, py, dy);
      objects.setProperty(obj, pz, dz);
      o.radius = Math.max(Math.trunc(dz / 2), Math.trunc(dx / 2)) / 1000;
      return 0;
    },
    // 0x1000a4e5: opacity in percent for one clump's polygons
    SetObjOpacity: perClump("clumpOpacity", (v) => v / 100),
    // 0x1000a439: 1 = double-sided
    SetObjDoubleface: perClump("doubleSided", (v) => v === 1),
    // 0x1000a381: perspective-correct texturing on (1) or off. Always on here.
    SetObjPerspective: () => 0,
    // 0x1000a04b: RenderWare clump hints (1 -> 2, 2 -> 6). Rendering hints
    // only; kept for reference.
    SetClumpHints: perClump("hints", (v) => v),
    // 0x1000a592: use a type 1 bitmap as the texture of every polygon
    SetModelTexture(model, bitmap) {
      const inst = r3d.instance(model);
      if (inst && engine.bin.type(engine.dynamic?.get(bitmap) ?? bitmap) === 1) inst.textureOverride = r3d.renderer.textures.resource(bitmap);
      return 0;
    },
    // 0x100121d5 FreeAllTextures(): called when leaving a LAB screen and at
    // the end of a mission. If any texture is loaded it destroys them all
    // (0x1000439d), then restarts RenderWare (0x10027f48): RtUnload of every
    // resource of type 7, 8, 9 and 10 (models and OB3D/OPRT objects), RwClose
    // and RwOpen, and a new camera. So afterwards every model copy and
    // object starts again from its resource, as here. No return value.
    FreeAllTextures() {
      if (!renderer.textures.byName.size && !renderer.textures.byRes.size) return 0;
      renderer.freeTextures();
      renderer.models.clear();
      r3d.instances.clear();
      r3d.objects.records.clear();
      return 0;
    },
    // 0x10008b3a: draw a model into a sprite's bitmap (unit previews).
    // (model, FRME or 0, frame, texture frame, x, y, z in thousandths,
    //  sprite, angle in hundredths of a degree about Y)
    RenderToBitmap(model, frme, frame, texFrame, dx, dy, dz, sprite, angle) {
      const inst = r3d.instance(model);
      const s = engine.sprites.get(sprite);
      if (!inst || !s || !s.cels.length) return 0;
      const bm = engine.sprites.bitmap(s.cels[Math.min(s.cel, s.cels.length - 1)]);
      const { width, height } = bm;
      if (!width || !height) return 0;
      const pose = frme ? r3d.renderer.frame(inst.model, frme, frame) : inst.pose;
      const out = r3d.renderer.renderPreview(inst.model, {
        pose, textureFrame: texFrame, dims: [dx, dy, dz], angle: angle / 100, width, height, instance: inst,
      });
      const idx = r3d.renderer.toIndexed(out.rgba);
      // The original renders into the cel's DIB, which is stored bottom row
      // first, and the scripts then mirror the sprite vertically
      // (SpriteMsg 7, 0, 1). Write rows bottom up to match.
      for (let y = 0; y < height; y++) bm.pixels.set(idx.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
      engine.dirty = true;
      return 0;
    },
  });
  return r3d;
}
