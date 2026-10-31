// Draws the world through the shared WebGL renderer (web/src/render3d/,
// from the "renderer core" work). Everything renderer-specific is in this
// file so the world and camera code stay testable headless.
//
// Draw order follows FUN_10006446: objects sorted by level (SetLevel; the
// ground tiles are -100, roads -50, decals -25), and far to near within a
// level. Objects with a negative level are flat ground layers: they are
// drawn first without depth testing so that coplanar layers stack in level
// order instead of z-fighting.
import { modelMatrix, dot, sub } from "./math.js";
import { backdropPlacement } from "./camera.js";

export class BattleView {
  constructor(world) {
    this.world = world;
    this.handles = new Map(); // object id -> scene handle
    this.scene = null;
    this.backdropCache = new Map();
  }

  get r3d() {
    return this.world.engine.render3d || null;
  }

  drop(o) {
    const h = this.handles.get(o.id);
    if (h) h.remove();
    this.handles.delete(o.id);
  }

  // Draw one frame. Returns the renderer's canvas (or null headless).
  frame() {
    const r3d = this.r3d;
    if (!r3d) return null;
    const w = this.world;
    if (!this.scene) this.scene = r3d.createScene();
    const pose = w.cameraPose();
    for (const o of w.objects.values()) {
      let h = this.handles.get(o.id);
      if (!h) {
        const model = r3d.objectModel(o.id);
        if (!model) continue;
        h = this.scene.add(model, {});
        this.handles.set(o.id, h);
      }
      // The instance's model, pose and texture frame change after the node
      // was made (animation, damage, animated textures): follow them.
      const inst = h.instance;
      if (inst) {
        h.model = inst.model;
        h.pose = inst.pose;
        h.textureOverride = inst.textureOverride;
      }
      h.textureFrame = o.textureFrame ?? inst?.textureFrame ?? 0;
      const p = w.pose(o.id);
      const d = sub(p.pos, pose.pos);
      h.setTransform({
        matrix: modelMatrix(p.basis, p.pos),
        visible: o.visible,
        level: o.level,
        depth: o.level >= 0,
        distance: dot(d, d),
      });
    }
    const cam = w.camera;
    const vp = cam.viewport();
    this.camera ??= r3d.createCamera();
    const camera = Object.assign(this.camera, {
      position: pose.pos,
      at: pose.at,
      up: pose.up,
      right: pose.right,
      viewwindow: cam.viewwindow,
      near: cam.near,
      far: cam.far,
      // RwSetSceneDepthCueDistance: the cue runs over the last `depth` units
      // before the far plane (so the moon's depth of 0.05 means no fog).
      // render3d's fog runs linearly from `depth` to the far plane.
      fog: cam.fog && { depth: Math.max(cam.near, cam.far - cam.fog.depth), color: cam.fog.color },
      background: cam.background,
      backdrop: this.backdrop(pose, vp),
    });
    // Render the viewport inside a full-size canvas, so it lines up with
    // the 640x480 screen when drawn at the Init3D origin.
    return r3d.render(this.scene, camera, { ...vp, canvasWidth: cam.width, canvasHeight: cam.height });
  }

  backdrop(pose, vp) {
    const b = this.world.camera.backdrop;
    if (!b) return null;
    let img = this.backdropCache.get(b.bitmap);
    if (!img) {
      img = this.r3d.bitmapImage?.(b.bitmap) || null;
      if (!img) return null;
      this.backdropCache.set(b.bitmap, img);
    }
    const at = backdropPlacement(pose, img.width, img.height, vp);
    return { image: img, x: at.x, y: at.y, wrap: true };
  }
}
