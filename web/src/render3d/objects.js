// 3D objects: OB3D (type 9) and OPRT (type 10) resources and the copies
// scripts make of them with CopyResource. RENDER.R32 expands an OB3D when
// it loads (FUN_100043f0); an OPRT copy is loaded the same way.
//
// File layout: "OB3D", u32 count, then records:
//   1 {a, b}                    -> entry {kind 1, a, b}
//   2 {min, max (floats), t, v} -> entry {kind t == 7 ? 4 : 5, min, max, v}
//   6 {a, script}               -> entry {kind 6, a, script}
//   8 {a}                       -> entry {kind 8, a}
//   7 {x, n, values[n]}         -> the property list; always last
// In memory the properties follow the entries, so GetProperty(obj, p) reads
// values[p] (0 past the end). Entries are probably level-of-detail ranges
// and behaviour scripts; the animation and battlefield code decode them.
//
// Property numbers seen so far (scripts):
//   0 object class, 1 model resource, 39 linked model copy,
//   55/56/57 model size x/y/z in thousandths (SetModelDimensions),
//   79 model used for RenderToBitmap, 99 its FRME pose resource.
/** @import { Engine } from "../engine.js" */


export const PROPS = 512;

export class Objects {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.records = new Map(); // object id (copy id) -> record
  }

  // The record for an object id, created from its resource on first use.
  /**
   * @param {number} id
   */
  get(id) {
    let r = this.records.get(id);
    if (r) return r;
    const e = this.engine;
    const src = e.dynamic?.get(id) ?? id;
    if (!(src >= 0 && src < e.bin.count)) return null;
    const t = e.bin.type(src);
    if (t !== 9 && t !== 10) return null;
    r = parseObject(e.res(src));
    r.id = id;
    r.source = src;
    this.records.set(id, r);
    return r;
  }

  /**
   * @param {number} id
   */
  delete(id) {
    this.records.delete(id);
  }

  /**
   * @param {number} id
   * @param {number} p
   */
  getProperty(id, p) {
    const r = this.get(id);
    return r && p >= 0 && p < PROPS ? r.props[p] : 0;
  }

  /**
   * @param {number} id
   * @param {number} p
   * @param {number} v
   */
  setProperty(id, p, v) {
    const r = this.get(id);
    if (r && p >= 0 && p < PROPS) r.props[p] = v;
  }
}

/**
 * @param {any} bytes
 */
export function parseObject(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u = (/** @type {number} */ i) => (8 + 4 * i + 4 <= bytes.length ? dv.getInt32(8 + 4 * i, true) : 0);
  const f = (/** @type {number} */ i) => (8 + 4 * i + 4 <= bytes.length ? dv.getFloat32(8 + 4 * i, true) : 0);
  const count = dv.getUint32(4, true);
  const entries = [];
  const props = new Int32Array(PROPS);
  let p = 0;
  let tag = 0;
  for (let n = 0; n < count && 8 + 4 * p < bytes.length; n++) {
    const kind = u(p);
    if (kind === 1) { entries.push({ kind: 1, a: u(p + 1), b: u(p + 2) }); p += 3; }
    else if (kind === 2) { entries.push({ kind: u(p + 3) === 7 ? 4 : 5, min: f(p + 1), max: f(p + 2), value: u(p + 4) }); p += 5; }
    else if (kind === 6) { entries.push({ kind: 6, a: u(p + 1), script: u(p + 2) }); p += 3; }
    else if (kind === 8) { entries.push({ kind: 8, a: u(p + 1) }); p += 2; }
    else if (kind === 7) {
      tag = u(p + 1);
      const k = u(p + 2);
      for (let i = 0; i < k && i < PROPS; i++) props[i] = u(p + 3 + i);
      break;
    } else break; // unknown record: stop, as the original's switch would misparse
  }
  return {
    entries, props, tag,
    flags: 0, // +0x54: 8 = model linked, 0x100 = ObjectSetState on
    state: 0,
    model: 0, // linked model copy id (LinkModel)
    radius: 0, // +0x58, metres (SetModelDimensions)
    transform: { pos: [0, 0, 0], prevPos: [0, 0, 0], yaw: 0, pitch: 0, roll: 0 },
  };
}
