// Decoders for the 3D data RENDER.R32 loads: FRME animations (type 4) and
// OB3D / OPRT object definitions (types 9 and 10). The same formats are
// decoded in Python by tools/gnome3d.py. Spec: docs/formats/animation.md.
//
// Matrices are 16 floats, row-major, for row vectors (v' = v * M) with the
// translation in the last row, as in RenderWare. Read column-major, the same
// array is a column-vector matrix (WebGL / glTF order).

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const view = (/** @type {Uint8Array} */ b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tag4 = (/** @type {DataView} */ dv) => String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));

// FRME: "FRME", u32 parts, u32 frames, u32 0, then frames x parts joint
// matrices of 12 floats (3 rotation rows, then the translation row). Frame f,
// part k is the joint transform of the model clump tagged k + 1 (model op
// 0x2D); it replaces that clump's own transform (RENDER.R32 0x10006085).
export class Frme {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes) {
    const dv = view(bytes);
    if (bytes.length < 16 || tag4(dv) !== "FRME") throw new Error("not an FRME resource");
    this.parts = dv.getUint32(4, true);
    // Resource 4733 claims one frame more than it holds; clamp to the data.
    const listed = dv.getUint32(8, true);
    this.frames = this.parts ? Math.min(listed, Math.floor((bytes.length - 16) / (48 * this.parts))) : 0;
    this.data = new Float32Array(this.frames * this.parts * 12);
    for (let i = 0; i < this.data.length; i++) this.data[i] = dv.getFloat32(16 + 4 * i, true);
  }

  // 16-float joint matrix of the clump tagged `tag` (1-based) in frame f.
  /**
   * @param {number} f
   * @param {number} tag
   */
  matrix(f, tag, out = new Float32Array(16)) {
    const s = (f * this.parts + tag - 1) * 12;
    const d = this.data;
    out[0] = d[s];
    out[1] = d[s + 1];
    out[2] = d[s + 2];
    out[3] = 0;
    out[4] = d[s + 3];
    out[5] = d[s + 4];
    out[6] = d[s + 5];
    out[7] = 0;
    out[8] = d[s + 6];
    out[9] = d[s + 7];
    out[10] = d[s + 8];
    out[11] = 0;
    out[12] = d[s + 9];
    out[13] = d[s + 10];
    out[14] = d[s + 11];
    out[15] = 1;
    return out;
  }

  // Map tag -> matrix for frame f (what a renderer applies to the model).
  /**
   * @param {any} f
   */
  pose(f) {
    const out = new Map();
    for (let k = 1; k <= this.parts; k++) out.set(k, this.matrix(f, k));
    return out;
  }
}

// OB3D / OPRT: "OB3D" or "OPRT", u32 slots, then records until a kind 7
// record ends the list (RENDER.R32 loader 0x100043f0):
//   1 {i32 a, i32 b}
//   2 {f32 min, f32 max, u32 resource type, u32 id}  level-of-detail band:
//      type 7 = a model to show, 19 = a script to run, in that distance band
//   6 {i32 a, u32 script}
//   8 {i32 a}
//   7 {u32 property words, u32 n, i32 props[n]}
// GetProperty(obj, n) reads props[n]; properties never set are 0.
/**
 * @param {Uint8Array} bytes
 */
export function parseObjectDef(bytes) {
  const dv = view(bytes);
  const tag = tag4(dv);
  if (tag !== "OB3D" && tag !== "OPRT") throw new Error("not an OB3D/OPRT resource");
  const slots = dv.getUint32(4, true);
  const entries = [];
  let p = 8;
  let props = new Int32Array(0);
  let propWords = 0;
  while (p < bytes.length) {
    const kind = dv.getUint32(p, true);
    if (kind === 1 || kind === 6) {
      entries.push({ kind, a: dv.getInt32(p + 4, true), b: dv.getInt32(p + 8, true) });
      p += 12;
    } else if (kind === 2) {
      entries.push({
        kind,
        min: dv.getFloat32(p + 4, true),
        max: dv.getFloat32(p + 8, true),
        resType: dv.getUint32(p + 12, true),
        id: dv.getUint32(p + 16, true),
      });
      p += 20;
    } else if (kind === 8) {
      entries.push({ kind, a: dv.getInt32(p + 4, true) });
      p += 8;
    } else if (kind === 7) {
      propWords = dv.getUint32(p + 4, true);
      const n = dv.getUint32(p + 8, true);
      props = new Int32Array(Math.max(n, propWords));
      for (let i = 0; i < n; i++) props[i] = dv.getInt32(p + 12 + 4 * i, true);
      p += 12 + 4 * n;
      break;
    } else {
      throw new Error(`unknown object record ${kind} at ${p}`);
    }
  }
  return { tag, slots, entries, props, propWords, propSlot: entries.length };
}
