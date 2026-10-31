// Textures for 3D models. Models name textures by their original .BMP file
// name; type 2 resources are lists of {61, size, path, bitmap} records that
// carry those names (docs/formats/g-nome-bin.md). Type 1 bitmaps can also be
// used as textures (SetModelTexture).
//
// A texture taller than it is wide holds several square frames stacked top
// to bottom (RenderWare 2 animated textures). G-Nome uses frames for team
// colours: RenderToBitmap picks one with RwSetTextureFrame.
import { decodeBitmap } from "../bitmap.js";
import { bmpName } from "./model.js";
/** @import { Engine } from "../engine.js" */

export class TextureStore {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.index = null; // upper-case BMP name -> {id, offset, length}
    this.byName = new Map(); // name -> Texture
    this.byRes = new Map(); // type 1 resource id -> Texture
  }

  // Scan every type 2 resource once for the names it holds.
  buildIndex() {
    this.index = new Map();
    const { bin } = this.engine;
    for (let id = 0; id < bin.count; id++) {
      if (bin.type(id) !== 2) continue;
      let data;
      try {
        data = this.engine.res(id);
      } catch {
        continue;
      }
      for (const rec of textureRecords(data)) {
        const name = bmpName(rec.path);
        if (!this.index.has(name)) this.index.set(name, { id, offset: rec.offset, length: rec.length });
      }
    }
  }

  // Texture by .BMP name, or null if the game has none by that name.
  // RENDER.R32 loads a model's textures from the type 2 resource right
  // after the model (FUN_10003f0b reads id + 1) before parsing it, so the
  // same name can mean different pictures for different models (each level
  // of detail has its own, smaller copies). Pass that resource as `res` to
  // look there first.
  /**
   * @param {string} name
   */
  named(name, res = 0) {
    if (!name) return null;
    if (res) {
      const t = this.inResource(res, name);
      if (t) return t;
    }
    if (this.byName.has(name)) return this.byName.get(name);
    if (!this.index) this.buildIndex();
    const e = /** @type {Map<string, any>} */ (this.index).get(name);
    let t = null;
    if (e) {
      const data = this.engine.res(e.id);
      t = makeTexture(name, decodeBitmap(data.subarray(e.offset, e.offset + e.length)));
    }
    this.byName.set(name, t);
    return t;
  }

  /**
   * @param {number} res
   * @param {string} name
   */
  inResource(res, name) {
    const key = `${res}:${name}`;
    if (this.byName.has(key)) return this.byName.get(key);
    let t = null;
    const { bin } = this.engine;
    if (res > 0 && res < bin.count && bin.type(res) === 2) {
      const data = this.engine.res(res);
      for (const rec of textureRecords(data)) {
        if (bmpName(rec.path) !== name) continue;
        t = makeTexture(name, decodeBitmap(data.subarray(rec.offset, rec.offset + rec.length)));
        break;
      }
    }
    this.byName.set(key, t);
    return t;
  }

  // FreeAllTextures: forget every decoded texture. Models look theirs up
  // again by name when they are next drawn. The name index stays.
  free() {
    this.byName.clear();
    this.byRes.clear();
  }

  // UncachePack: forget the textures decoded from resources for which
  // inPack(id) is true.
  /** @param {(id: number) => boolean} inPack */
  forgetPack(inPack) {
    for (const id of [...this.byRes.keys()]) if (inPack(id)) this.byRes.delete(id);
    for (const key of [...this.byName.keys()]) {
      const c = key.indexOf(":");
      const id = c > 0 ? Number(key.slice(0, c)) : this.index?.get(key)?.id;
      if (id !== undefined && inPack(id)) this.byName.delete(key);
    }
  }

  // Texture from a type 1 bitmap resource.
  /**
   * @param {number} id
   */
  resource(id) {
    let t = this.byRes.get(id);
    if (!t) {
      t = makeTexture(`#${id}`, decodeBitmap(this.engine.res(id)));
      this.byRes.set(id, t);
    }
    return t;
  }
}

/**
 * @param {string} name
 * @param {any} bm
 */
function makeTexture(name, bm) {
  const { width, height, pixels } = bm;
  const frames = height > width && height % width === 0 ? height / width : 1;
  return { name, width, height: height / frames, frames, pixels, version: 0 };
}

// [{path, offset, length}] for the bitmaps in a type 2 resource. Resources
// that are not texture lists give [].
/**
 * @param {Uint8Array} data
 */
export function textureRecords(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = [];
  let p = 0;
  while (p + 12 <= data.length) {
    const kind = dv.getUint32(p, true), size = dv.getUint32(p + 4, true), plen = dv.getUint32(p + 8, true);
    if (kind !== 61 || 12 + plen > 4 + size || p + 4 + size > data.length) return [];
    let path = "";
    for (let i = 0; i < plen && data[p + 12 + i]; i++) path += String.fromCharCode(data[p + 12 + i]);
    out.push({ path, offset: p + 12 + plen, length: size - 8 - plen });
    p += 4 + size;
  }
  return p === data.length ? out : [];
}
