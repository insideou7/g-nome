// Software rasterizer. Used for the small unit previews (RenderToBitmap),
// in Node (headless tests) and wherever WebGL is missing. RenderWare 2 was
// itself a software renderer, so this also matches the original's look:
// flat shading, perspective-correct textures, a z-buffer.
import { mul } from "./math.js";
import { clumpMatrices } from "./model.js";
import { activeLights, addLights, materialLight, rgb01 } from "./scene.js";

// Front faces wind this way in screen space (+1 or -1). Checked by eye on
// the unit models: with the other sign the mechs render inside out.
export const FRONT = 1;

// Back-face culling is off: RenderWare drew G-Nome's ground tiles, which
// face away by this rule when seen from above, so the original evidently
// did not cull them. With the z-buffer, closed models look the same either
// way. Lighting uses |N.L| for that reason.
export const CULL = false;

export class SoftTarget {
  /**
   * @param {number} width
   * @param {number} height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.rgba = new Uint8ClampedArray(width * height * 4);
    this.depth = new Float32Array(width * height);
  }
  /**
   * @param {number[]} bg
   */
  clear(bg) {
    this.depth.fill(Infinity);
    if (bg) {
      for (let i = 0; i < this.rgba.length; i += 4) {
        this.rgba[i] = bg[0] * 255; this.rgba[i + 1] = bg[1] * 255; this.rgba[i + 2] = bg[2] * 255; this.rgba[i + 3] = 255;
      }
    } else this.rgba.fill(0);
  }
}

// Draw `scene` seen from `camera` into `target` (a SoftTarget).
// textureOf(material, node) returns a Texture or null; rgbOf(texture) gives
// its RGBA texels (the renderer caches them per palette).
/**
 * @param {any} scene
 * @param {any} camera
 * @param {any} target
 * @param {{ textureOf: (material: any, node: any) => any, rgbaOf: (texture: any) => Uint8Array }} fns
 */
export function renderSoft(scene, camera, target, { textureOf, rgbaOf }) {
  target.clear(rgb01(camera.background));
  const fog = camera.fogRange();
  const W = target.width, H = target.height;
  const view = camera.view();
  const [vw, vh] = camera.viewwindow;
  const near = camera.near;
  const lights = activeLights(scene);

  const cam = new Float32Array(8 * 6); // clip buffers: x y z u v per vertex
  for (const node of scene.ordered()) {
    const useDepth = node.depth !== false;
    const model = node.model;
    const worlds = clumpMatrices(model, node.matrix, node.pose, node.instance?.joints);
    model.clumps.forEach((/** @type {any} */ clump, /** @type {number} */ ci) => {
      if (node.clumpHidden[ci]) return;
      const w = worlds[ci];
      const mv = mul(w, view);
      const { positions: P, normals: N, uvs: UV } = clump.mesh;
      const clumpAlpha = node.clumpOpacity[ci] ?? 1;
      const twoSided = !!node.doubleSided[ci];
      for (const g of clump.mesh.groups) {
        const mat = g.material;
        const tex = textureOf(mat, node);
        const texel = tex ? rgbaOf(tex) : null;
        const alpha = (mat.opacity ?? 1) * clumpAlpha;
        if (alpha <= 0.01) continue;
        const { unlit, ka, kd, ks } = materialLight(mat, !!tex);
        for (let t = g.start; t < g.start + g.count; t += 3) {
          // Flat lighting from the face normal in world space.
          const nx0 = N[t * 3], ny0 = N[t * 3 + 1], nz0 = N[t * 3 + 2];
          let nx = nx0 * w[0] + ny0 * w[4] + nz0 * w[8];
          let ny = nx0 * w[1] + ny0 * w[5] + nz0 * w[9];
          let nz = nx0 * w[2] + ny0 * w[6] + nz0 * w[10];
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
          const light = [ka, ka, ka];
          if (unlit) light.fill(1);
          else if (lights.length) {
            // Point and cone lights reach the face at its first vertex.
            const x = P[t * 3], y = P[t * 3 + 1], z = P[t * 3 + 2];
            const p = [x * w[0] + y * w[4] + z * w[8] + w[12], x * w[1] + y * w[5] + z * w[9] + w[13], x * w[2] + y * w[6] + z * w[10] + w[14]];
            addLights(light, lights, [nx, ny, nz], p, kd, ks, !CULL || twoSided);
          }
          for (let i = 0; i < 3; i++) light[i] = Math.min(1, light[i]);
          // To camera space.
          let n = 0;
          for (let j = 0; j < 3; j++) {
            const v = t + j;
            const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            cam[n * 5] = x * mv[0] + y * mv[4] + z * mv[8] + mv[12];
            cam[n * 5 + 1] = x * mv[1] + y * mv[5] + z * mv[9] + mv[13];
            cam[n * 5 + 2] = x * mv[2] + y * mv[6] + z * mv[10] + mv[14];
            cam[n * 5 + 3] = UV[v * 2];
            cam[n * 5 + 4] = UV[v * 2 + 1];
            n++;
          }
          const poly = clipNear(cam, near);
          if (poly.length < 3) continue;
          // Project: RenderWare's camera +X is screen left.
          const s = poly.map((p) => {
            const iz = 1 / p[2];
            return [W / 2 * (1 - p[0] * iz / vw), H / 2 * (1 - p[1] * iz / vh), iz, p[3] * iz, p[4] * iz, p[2]];
          });
          // Back-face test on the first three projected vertices.
          const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
          if (CULL && !twoSided && area * FRONT <= 0) continue;
          const col = mat.color || [1, 1, 1];
          for (let k2 = 1; k2 + 1 < s.length; k2++)
            raster(target, s[0], s[k2], s[k2 + 1], light, texel ? null : col, tex, texel, node.textureFrame, alpha, fog, useDepth);
        }
      }
    });
  }
  return target;
}

// Sutherland-Hodgman against z = near. Input: 3 vertices of 5 floats.
/**
 * @param {Float32Array} buf
 * @param {number} near
 */
function clipNear(buf, near) {
  const inp = [0, 1, 2].map((i) => Array.from(buf.subarray(i * 5, i * 5 + 5)));
  if (inp.every((p) => p[2] >= near)) return inp;
  const out = [];
  for (let i = 0; i < inp.length; i++) {
    const a = inp[i], b = inp[(i + 1) % inp.length];
    const ain = a[2] >= near, bin = b[2] >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push(a.map((v, k) => v + (b[k] - v) * t));
    }
  }
  return out;
}

/**
 * @param {any} T
 * @param {number[]} a
 * @param {number[]} b
 * @param {any} c
 * @param {any} light
 * @param {number[]} color
 * @param {any} tex
 * @param {any} texel
 * @param {number} frame
 * @param {number} alpha
 * @param {any} fog
 * @param {boolean} useDepth
 */
function raster(T, a, b, c, light, color, tex, texel, frame, alpha, fog, useDepth) {
  const W = T.width, H = T.height;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  if (minX > maxX || minY > maxY) return;
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (!area) return;
  const ia = 1 / area;
  const rgba = T.rgba, depth = T.depth;
  const tw = tex ? tex.width : 0, th = tex ? tex.height : 0;
  const frameOff = tex ? Math.min(frame | 0, tex.frames - 1) * tw * th : 0;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      let w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) * ia;
      let w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) * ia;
      let w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const iz = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const z = 1 / iz;
      const o = y * W + x;
      if (useDepth && z >= depth[o]) continue;
      let r, g, bl;
      if (texel) {
        let u = (w0 * a[3] + w1 * b[3] + w2 * c[3]) * z;
        let v = (w0 * a[4] + w1 * b[4] + w2 * c[4]) * z;
        u -= Math.floor(u);
        v -= Math.floor(v);
        const ti = (frameOff + Math.min(th - 1, (v * th) | 0) * tw + Math.min(tw - 1, (u * tw) | 0)) * 4;
        if (!texel[ti + 3]) continue; // colour 0 is see-through
        r = texel[ti]; g = texel[ti + 1]; bl = texel[ti + 2];
      } else {
        r = color[0] * 255; g = color[1] * 255; bl = color[2] * 255;
      }
      r *= light[0]; g *= light[1]; bl *= light[2];
      if (fog) {
        const f = Math.max(0, Math.min(1, (z - fog.start) / (fog.end - fog.start)));
        r += (fog.color[0] * 255 - r) * f; g += (fog.color[1] * 255 - g) * f; bl += (fog.color[2] * 255 - bl) * f;
      }
      const q = o * 4;
      if (alpha < 0.99) {
        r = rgba[q] + (r - rgba[q]) * alpha; g = rgba[q + 1] + (g - rgba[q + 1]) * alpha; bl = rgba[q + 2] + (bl - rgba[q + 2]) * alpha;
      } else if (useDepth) depth[o] = z;
      rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = bl; rgba[q + 3] = 255;
    }
  }
}
