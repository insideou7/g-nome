// The 3D renderer core: what RENDER.R32 did with RenderWare 2.0. Owns the
// model and texture caches and draws scenes with a backend:
//   - "webgl": WebGL2 into an offscreen canvas (browser battlefield view)
//   - "soft":  the software rasterizer (unit previews, Node, no WebGL)
// API overview: docs/render3d.md.
import { parseModel } from "./model.js";
import { TextureStore } from "./textures.js";
import { Scene, Camera, meshModel } from "./scene.js";
import { renderSoft, SoftTarget } from "./soft.js";
import { WebGLBackend } from "./webgl.js";
import { poseFromFrame } from "./frames.js";
import { rotY, translation, mul, identity } from "./math.js";
import { modelBounds } from "./model.js";

export class Renderer {
  constructor(engine, { webgl = true } = {}) {
    this.engine = engine;
    this.textures = new TextureStore(engine);
    this.models = new Map(); // source resource id -> parsed model
    this.texels = new Map(); // texture -> {key, rgba}
    this.lut = null; // RGB555 -> palette index
    this.lutKey = "";
    this.gl = null;
    if (webgl && typeof document !== "undefined") {
      try {
        this.gl = new WebGLBackend(this);
      } catch (e) {
        engine.log?.(`render3d: WebGL unavailable (${e.message}); using the software renderer`);
      }
    }
  }

  // --- resources -------------------------------------------------------

  // Parsed MODL/MPRT for a resource id (copies resolve to their source).
  // Models are shared; per-instance state (pose, opacity, texture frame)
  // lives on the scene node.
  loadModel(id) {
    const e = this.engine;
    const src = e.dynamic?.get(id) ?? id;
    let m = this.models.get(src);
    if (!m) {
      const t = e.bin.type(src);
      if (t !== 7 && t !== 8) return null;
      m = parseModel(e.res(src));
      m.id = src;
      this.models.set(src, m);
    }
    return m;
  }

  // A model built from raw arrays; see meshModel in scene.js.
  createMesh(spec) {
    return meshModel(spec);
  }

  frame(model, frmeId, index) {
    if (!frmeId) return null;
    const e = this.engine;
    const src = e.dynamic?.get(frmeId) ?? frmeId;
    if (e.bin.type(src) !== 4) return null;
    return poseFromFrame(model, e.res(src), index);
  }

  createScene() {
    return new Scene();
  }
  createCamera() {
    return new Camera();
  }

  // --- textures and palette -------------------------------------------

  textureOf(material, node) {
    if (node && node.textureOverride) return node.textureOverride;
    const t = material.texture;
    if (!t) return null;
    if (typeof t === "object") return t;
    return this.textures.named(t, node?.model?.id ? node.model.id + 1 : 0);
  }

  paletteKey() {
    const p = this.engine.palette;
    let h = 0;
    for (let i = 0; i < p.length; i++) h = (h * 31 + p[i]) | 0;
    return String(h);
  }

  // RGBA texels of a texture under the current palette (index 0 clear).
  rgbaOf(tex) {
    const key = this.paletteKey();
    let c = this.texels.get(tex);
    if (c && c.key === key && c.version === tex.version) return c.rgba;
    const pal = this.engine.palette, px = tex.pixels;
    const rgba = new Uint8ClampedArray(px.length * 4);
    for (let i = 0; i < px.length; i++) {
      const v = px[i];
      if (!v) continue;
      rgba[i * 4] = pal[v * 3]; rgba[i * 4 + 1] = pal[v * 3 + 1]; rgba[i * 4 + 2] = pal[v * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    c = { key, version: tex.version, rgba };
    this.texels.set(tex, c);
    return rgba;
  }

  // Nearest palette entry (game colours 10..245) for each RGB555 value.
  quantizer() {
    const key = this.paletteKey();
    if (this.lut && this.lutKey === key) return this.lut;
    const pal = this.engine.palette;
    const lut = new Uint8Array(32768);
    for (let c = 0; c < 32768; c++) {
      const r = ((c >> 10) & 31) * 8 + 4, g = ((c >> 5) & 31) * 8 + 4, b = (c & 31) * 8 + 4;
      let best = 10, bd = Infinity;
      for (let i = 10; i < 246; i++) {
        const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bd) { bd = d; best = i; }
      }
      lut[c] = best;
    }
    this.lut = lut;
    this.lutKey = key;
    return lut;
  }

  // RGBA -> palette indices; pixels with alpha 0 become 0 (transparent).
  toIndexed(rgba, out = new Uint8Array(rgba.length / 4)) {
    const lut = this.quantizer();
    for (let i = 0, o = 0; o < out.length; i += 4, o++) {
      out[o] = rgba[i + 3] ? lut[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)] : 0;
    }
    return out;
  }

  // --- drawing ----------------------------------------------------------

  // Draw a scene. viewport: {x, y, w, h} or {x, y, width, height}, in
  // pixels of a canvas of size {canvasWidth, canvasHeight} (default: just
  // big enough), optionally clipped to viewport.clip {x, y, width, height}
  // (WebGL only). Returns the WebGL canvas, or a SoftTarget {width, height,
  // rgba} from the software backend.
  // opts.backend: "webgl" | "soft" (default: webgl when available).
  render(scene, camera, viewport, opts = {}) {
    const width = viewport.width ?? viewport.w, height = viewport.height ?? viewport.h;
    const useGL = (opts.backend || (this.gl ? "webgl" : "soft")) === "webgl" && this.gl;
    if (useGL) return this.gl.render(scene, camera, { ...viewport, width, height });
    const target = opts.target && opts.target.width === width && opts.target.height === height ? opts.target : new SoftTarget(width, height);
    return renderSoft(scene, camera, target, {
      textureOf: (m, n) => this.textureOf(m, n),
      rgbaOf: (t) => this.rgbaOf(t),
    });
  }

  // RENDER.R32 RenderToBitmap (0x10008b3a): a turntable view of one model
  // into a bitmap the size of the sprite's cel. dims are the model's
  // extents in thousandths (SetModelDimensions), angle in degrees.
  //   - camera viewwindow 0.1 wide, aspect from the bitmap
  //   - model at the origin, rotated about Y by the angle
  //   - camera at height dimY/2, backed off until the model fits
  //     (width = sqrt(x^2 + z^2) * 1.05, height = y * 1.05), then turned
  //     180 degrees to face it; background colour 0 (transparent)
  renderPreview(model, { pose = null, textureFrame = 0, dims, angle = 0, width, height, instance = null }) {
    const scene = new Scene();
    const node = scene.add(instance || model);
    node.pose = pose;
    node.textureFrame = textureFrame;
    node.matrix = rotY(angle);
    let [dx, dy, dz] = dims || [0, 0, 0];
    // No size given (the cockpit's own-unit view passes properties 55 and
    // 56, which stay 0 until SetModelDimensions runs): use the model's bounds.
    if (!dims || !(dx > 0 && (dy > 0 || dz > 0))) {
      const b = modelBounds(model, pose);
      dx = (b.max[0] - b.min[0]) * 1000; dy = (b.max[1] - b.min[1]) * 1000; dz = (b.max[2] - b.min[2]) * 1000;
    }
    const across = Math.hypot(dx / 1000, dz / 1000) * 1.05;
    const up = (dy / 1000) * 1.05;
    const vw = 0.1, vh = (height * 0.1) / width;
    const dist = across / up <= width / height ? (up * 0.5) / vh : (across * 0.5) / vw;
    const cam = new Camera();
    cam.viewwindow = [vw, vh];
    cam.near = Math.max(0.001, dist / 100);
    // At (0, up/2, dist) looking back along -Z: yaw 180.
    cam.matrix = mul(rotY(180), translation(0, up / 2, dist));
    return this.render(scene, cam, { width, height }, { backend: "soft" });
  }
}

export { identity };
