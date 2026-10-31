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
/** @import { World } from "./world.js" */

export class BattleView {
  /**
   * @param {World} world
   */
  constructor(world) {
    this.world = world;
    this.handles = new Map(); // object id -> scene handle
    this.scene = null;
    this.backdropCache = new Map();
    /** @type {any} */ this.camera; // created on first draw
  }

  get r3d() {
    return this.world.engine.render3d || null;
  }

  /**
   * @param {any} o
   */
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
    // Script-made lights (render3d/lights.js); none in G-Nome's scripts.
    this.scene.lights = r3d.lights?.list() ?? [];
    const pose = w.cameraPose();
    for (const o of w.objects.values()) {
      let h = this.handles.get(o.id);
      // A level-of-detail change can link another model copy (or none).
      const model = r3d.objectModel(o.id);
      if (h && h.instance !== model) {
        this.drop(o);
        h = null;
      }
      if (!h) {
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
      if (!p) continue;
      const d = sub(p.pos, pose.pos);
      h.setTransform({
        matrix: modelMatrix(p.basis, p.pos),
        // FUN_10006446 skips objects with flag 0x100 (ObjectSetState 1: the
        // LOD scripts hide the player's own unit this way) or 0x400. Flag
        // 0x80 (ObjectSetScene) only draws the model in its own scene.
        visible: o.visible && !(r3d.objects.get(o.id)?.flags & 0x500),
        level: o.level,
        depth: o.level >= 0,
        distance: dot(d, d),
      });
    }
    const cam = w.camera;
    const vp = cam.screen();
    this.camera ??= r3d.createCamera();
    const camera = Object.assign(this.camera, {
      position: pose.pos,
      at: pose.at,
      up: pose.up,
      right: pose.right,
      viewwindow: cam.viewwindow,
      near: cam.near,
      far: cam.drawFar,
      // RwSetSceneDepthCueDistance: the cue runs over the last `depth` units
      // before the far plane (so the moon's depth of 0.05 means no fog).
      // render3d's fog runs linearly from `depth` to the far plane. With a
      // longer view distance the cue keeps its share of the distance.
      fog: cam.fog && { depth: Math.max(cam.near, cam.drawFar - cam.fog.depth * cam.viewDistance), color: cam.fog.color },
      background: cam.background,
      backdrop: this.backdrop(pose, vp),
    });
    // Project over the whole 640x480 screen and clip to the cropped
    // viewport (see BattleCamera.screen), in a full-size canvas so it lines
    // up with the screen when drawn at the Init3D origin.
    const clip = cam.viewport();
    return r3d.render(this.scene, camera, { ...vp, clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h }, canvasWidth: cam.width, canvasHeight: cam.height });
  }

  /**
   * @param {any} pose
   * @param {any} vp
   */
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
