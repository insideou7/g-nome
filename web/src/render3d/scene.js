// Scene graph and camera, shared by every backend.
//
// Conventions (RenderWare 2.0): row vectors, Y up, a camera looks along its
// own +Z and, as in RenderWare, its +X is screen left. Angles are degrees;
// the scripts pass hundredths of a degree (18000 = 180), so convert at the
// extern boundary.
import { compose, identity, invert } from "./math.js";

// A mesh built from raw arrays (terrain, debug shapes). Wrapped as a model
// with one clump so the backends only deal with models.
// spec: {positions, uvs?, normals?, indices?, groups: [{start, count,
// material}]} where start/count index `indices` (or vertices when there are
// no indices). material: {texture: Texture | BMP name | null,
// color: [r, g, b] (0..1), opacity, ambient, diffuse}.
export function meshModel(spec) {
  const idx = spec.indices;
  const n = idx ? idx.length : spec.positions.length / 3;
  const positions = new Float32Array(n * 3), uvs = new Float32Array(n * 2), normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = idx ? idx[i] : i;
    positions.set(spec.positions.subarray(v * 3, v * 3 + 3), i * 3);
    if (spec.uvs) uvs.set(spec.uvs.subarray(v * 2, v * 2 + 2), i * 2);
    if (spec.normals) normals.set(spec.normals.subarray(v * 3, v * 3 + 3), i * 3);
  }
  if (!spec.normals) flatNormals(positions, normals);
  const groups = (spec.groups || [{ start: 0, count: n, material: {} }]).map((g) => ({
    start: g.start, count: g.count,
    material: { color: [1, 1, 1], ambient: 0.4, diffuse: 0.6, specular: 0, opacity: 1, texture: "", ...g.material },
  }));
  const clump = { index: 0, parent: -1, tag: 0, local: identity(), children: [], mesh: { positions, normals, uvs, groups, count: n } };
  return { clumps: [clump], roots: [0], tagged: [], count: 0 };
}

function flatNormals(p, out) {
  for (let i = 0; i + 8 < p.length; i += 9) {
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const wx = p[i + 6] - p[i], wy = p[i + 7] - p[i + 1], wz = p[i + 8] - p[i + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    for (let k = 0; k < 9; k += 3) { out[i + k] = nx / l; out[i + k + 1] = ny / l; out[i + k + 2] = nz / l; }
  }
}

// One placed model. Fields the battlefield and animation code may change:
//   matrix     world matrix (setTransform builds it)
//   pose       per-clump local matrices replacing the model's (FRME poses)
//   clumpOpacity[i], clumpHidden[i], doubleSided[i]   per clump index
//   textureFrame   frame of multi-frame textures (team colour)
//   textureOverride  Texture used for every polygon (SetModelTexture)
export class SceneNode {
  // `source`: a model (loadModel, createMesh) or a ModelInstance (a model
  // copy used by a script object), whose per-clump state the node shares.
  constructor(scene, source, t) {
    this.scene = scene;
    const inst = source.model ? source : null;
    this.instance = inst;
    this.model = inst ? inst.model : source;
    /** @type {Float32Array} */
    this.matrix = identity();
    this.pose = inst ? inst.pose : null;
    this.clumpOpacity = inst ? inst.clumpOpacity : [];
    this.clumpHidden = inst ? inst.clumpHidden : [];
    this.doubleSided = inst ? inst.doubleSided : [];
    this.textureFrame = inst ? inst.textureFrame : 0;
    this.textureOverride = inst ? inst.textureOverride : null;
    this.visible = true;
    this.level = 0; // draw order: lower levels first
    this.distance = 0; // within a level, farther (larger) first
    this.depth = true; // false: no depth test or write (ground layers)
    if (t) this.setTransform(t);
  }
  // One of:
  //   Float32Array(16)                      world matrix
  //   {matrix, visible, level, depth, distance}   (battlefield view)
  //   {position: [x, y, z], yaw, pitch, roll, scale}
  // The matrix layout is RenderWare's row-vector matrix, which is the same
  // memory as a column-major OpenGL matrix: translation in elements 12-14.
  setTransform(t) {
    if (t instanceof Float32Array) this.matrix = t;
    else if (t.matrix) this.matrix = Float32Array.from(t.matrix);
    else if (t.position || t.yaw !== undefined || t.pitch !== undefined || t.roll !== undefined || t.scale !== undefined) this.matrix = compose(t);
    for (const k of ["visible", "level", "depth", "distance"]) if (t[k] !== undefined) this[k] = t[k];
    return this;
  }
  remove() {
    this.scene.nodes.delete(this);
  }
}

export class Scene {
  constructor() {
    this.nodes = new Set();
    // {type: "ambient" | "directional" | "point", color: [r, g, b],
    //  direction: [x, y, z] (light travels along it), position}
    this.lights = [];
  }
  add(model, t) {
    const n = new SceneNode(this, model, t);
    this.nodes.add(n);
    return n;
  }
  clear() {
    this.nodes.clear();
  }
  // Nodes in RENDER.R32's draw order (FUN_10006446): level ascending, then
  // distance descending.
  ordered() {
    return [...this.nodes].filter((n) => n.visible).sort((a, b) => a.level - b.level || b.distance - a.distance);
  }
}

// Colours may be given as 0..1 or 0..255.
export function rgb01(c) {
  if (!c) return c;
  return c.some((v) => v > 1) ? c.map((v) => v / 255) : c;
}

// Lights used when a scene has none.
export const DEFAULT_LIGHTS = [
  { type: "ambient", color: [0.8, 0.8, 0.8] },
  { type: "directional", color: [1, 1, 1], direction: [0.3, -0.5, -0.8] },
];

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export class Camera {
  constructor() {
    this.position = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.matrix = null; // camera-to-world; overrides everything below
    // RenderWare look vectors (optional; override yaw/pitch/roll). `right`
    // is at x up, which is -X of the camera: screen right.
    this.at = null;
    this.up = null;
    this.right = null;
    // Half width and height of the view at distance 1 (RwSetCameraViewwindow).
    this.viewwindow = [0.5, 0.375];
    this.near = 0.05;
    this.far = 1000;
    // {start, end, color} or RenderWare style {depth, color}: linear fog
    // from `depth` to the far plane. Colours 0..1 or 0..255.
    this.fog = null;
    this.background = null; // [r, g, b], or null for transparent
    // {image (ImageData or canvas), x, y, wrap}: blitted in viewport pixels
    // before the scene, repeated horizontally when wrap is set.
    this.backdrop = null;
  }
  // RwSetCameraViewwindow takes the half width; set the height from the
  // viewport's aspect ratio as RenderToBitmap does.
  setViewwindow(halfWidth, aspect) {
    this.viewwindow = [halfWidth, halfWidth / aspect];
  }
  cameraToWorld() {
    if (this.matrix) return this.matrix;
    if (this.at && this.up) {
      const r = this.right || cross(this.at, this.up);
      const p = this.position;
      // Rows: camera X (= -right), Y (up), Z (at), position.
      return Float32Array.from([-r[0], -r[1], -r[2], 0, ...this.up, 0, ...this.at, 0, p[0], p[1], p[2], 1]);
    }
    return compose({ position: this.position, yaw: this.yaw, pitch: this.pitch, roll: this.roll });
  }
  fogRange() {
    const f = this.fog;
    if (!f) return null;
    return { start: f.start ?? f.depth ?? 0, end: f.end ?? this.far, color: rgb01(f.color) };
  }
  view() {
    return invert(this.cameraToWorld());
  }
}
