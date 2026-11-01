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
/**
 * @param {any} spec
 */
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
  const groups = (spec.groups || [{ start: 0, count: n, material: {} }]).map((/** @type {any} */ g) => ({
    start: g.start, count: g.count,
    // Built meshes are two-sided (MaterialModes double) unless they say not.
    material: { color: [1, 1, 1], ambient: 1, diffuse: 0, specular: 0, opacity: 1, texture: "", materialModes: 8, ...g.material },
  }));
  const clump = { index: 0, parent: -1, tag: 0, local: identity(), children: [], mesh: { positions, normals, uvs, groups, count: n } };
  return { clumps: [clump], roots: [0], tagged: [], count: 0 };
}

/**
 * @param {ArrayLike<number>} p
 * @param {number[] | Float32Array} out
 */
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
  /**
   * @param {any} scene
   * @param {any} source
   * @param {any} t
   */
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
  /**
   * @param {any} t
   */
  setTransform(t) {
    if (t instanceof Float32Array) this.matrix = t;
    else if (t.matrix) this.matrix = Float32Array.from(t.matrix);
    else if (t.position || t.yaw !== undefined || t.pitch !== undefined || t.roll !== undefined || t.scale !== undefined) this.matrix = compose(t);
    for (const k of ["visible", "level", "depth", "distance"]) if (t[k] !== undefined) /** @type {any} */ (this)[k] = t[k];
    return this;
  }
  remove() {
    this.scene.nodes.delete(this);
  }
}

export class Scene {
  constructor() {
    this.nodes = new Set();
    // Lights (see activeLights): {type: "directional" | "point" |
    // "conical", color: [r, g, b], direction: [x, y, z] (light travels along
    // it), position, radius, coneAngle (radians), on}. RenderWare 2.0 has
    // no ambient light; see materialLight.
    this.lights = [];
  }
  /**
   * @param {any} model
   * @param {any} [t]
   */
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
/**
 * @param {any} c
 */
export function rgb01(c) {
  if (!c) return c;
  return c.some((/** @type {number} */ v) => v > 1) ? c.map((/** @type {number} */ v) => v / 255) : c;
}

// How a material takes light, as RWL20.DLL's lighting (FUN_1000c4b0 /
// FUN_1000c730) does it. RenderWare 2.0 has no ambient light: every lit
// polygon gets its surface's ambient coefficient (model op 0x2C, RwSetSurface)
// as a white light, plus, for each light that is on, the light's colour times
// diffuse * N.L (+ specular * (N.L)^16 when N.L > 0.7). The sum is clamped to
// 1. Textures take the light; the surface colour (op 0x08) only colours
// untextured polygons.
// A texture is unlit (full brightness) when its TextureModes lack the lit
// bit. RwCreateMaterial starts with TextureModes 1 (lit), so a texture with no
// TextureModes op is lit.
/**
 * @param {any} mat
 * @param {boolean} textured
 */
export function materialLight(mat, textured) {
  const unlit = !!textured && !((mat.textureModes ?? 1) & 1);
  return { unlit, ka: mat.ambient ?? 0, kd: mat.diffuse ?? 0, ks: mat.specular ?? 0 };
}

// N.L at or below this gets no specular term (0x3f333333 in RWL20.DLL).
export const SPECULAR_MIN = 0.7;

// Scene lights in the form both backends use. RENDER.R32 only adds lights
// through the Light* externs (render3d/lights.js), and no G-Nome script
// calls them, so in the original every scene has none and models show their
// ambient coefficient alone. Lights that are off are left out.
// Returns [{type: 1 directional | 2 point | 3 conical, color [r,g,b] 0..1,
//   dir [x,y,z] towards the light (directional) or the way the cone points,
//   pos [x,y,z], radius, cosCone}].
/**
 * @param {any} scene
 */
export function activeLights(scene) {
  const out = [];
  for (const l of scene.lights) {
    if (l.on === false) continue;
    const type = l.type === "directional" ? 1 : l.type === "point" ? 2 : l.type === "conical" ? 3 : 0;
    if (!type) continue;
    const d = l.direction || [0, -1, 0], len = Math.hypot(d[0], d[1], d[2]) || 1;
    const dir = type === 1 ? [-d[0] / len, -d[1] / len, -d[2] / len] : [d[0] / len, d[1] / len, d[2] / len];
    out.push({ type, color: rgb01(l.color || [1, 1, 1]), dir, pos: l.position || [0, 0, 0], radius: l.radius ?? Infinity, cosCone: Math.cos(l.coneAngle ?? Math.PI / 6) });
  }
  return out;
}

// Light reaching a point p with unit normal n from the active lights
// (diffuse and specular weights applied), added into `out` (3 floats).
// `twoSided`: light either face (|N.L|), see twoSidedOf in soft.js.
/**
 * @param {number[]} out
 * @param {any} lights
 * @param {number[]} n
 * @param {number[]} p
 * @param {number} kd
 * @param {number} ks
 * @param {boolean} twoSided
 */
export function addLights(out, lights, n, p, kd, ks, twoSided) {
  for (const L of lights) {
    let d;
    if (L.type === 1) d = n[0] * L.dir[0] + n[1] * L.dir[1] + n[2] * L.dir[2];
    else {
      const v = [L.pos[0] - p[0], L.pos[1] - p[1], L.pos[2] - p[2]];
      const dist = Math.hypot(v[0], v[1], v[2]);
      if (!dist || dist >= L.radius) continue;
      if (L.type === 3 && -(v[0] * L.dir[0] + v[1] * L.dir[1] + v[2] * L.dir[2]) / dist < L.cosCone) continue;
      d = (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / dist;
    }
    if (twoSided) d = Math.abs(d);
    if (d <= 0) continue;
    const k = kd * d + (d > SPECULAR_MIN ? ks * d ** 16 : 0);
    for (let i = 0; i < 3; i++) out[i] += k * L.color[i];
  }
  return out;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export class Camera {
  constructor() {
    this.position = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    /** @type {Float32Array | null} */
    this.matrix = null; // camera-to-world; overrides everything below
    // RenderWare look vectors (optional; override yaw/pitch/roll). `right`
    // is at x up, which is -X of the camera: screen right.
    /** @type {any} */
    this.at = null;
    /** @type {any} */
    this.up = null;
    /** @type {number[] | null} */
    this.right = null;
    // Half width and height of the view at distance 1 (RwSetCameraViewwindow).
    this.viewwindow = [0.5, 0.375];
    this.near = 0.05;
    this.far = 1000;
    // {start, end, color} or RenderWare style {depth, color}: linear fog
    // from `depth` to the far plane. Colours 0..1 or 0..255.
    /** @type {any} */
    this.fog = null;
    this.background = null; // [r, g, b], or null for transparent
    // {image (ImageData or canvas), x, y, wrap}: blitted in viewport pixels
    // before the scene, repeated horizontally when wrap is set.
    this.backdrop = null;
  }
  // RwSetCameraViewwindow takes the half width; set the height from the
  // viewport's aspect ratio as RenderToBitmap does.
  /**
   * @param {number} halfWidth
   * @param {number} aspect
   */
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
