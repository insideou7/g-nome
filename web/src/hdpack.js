// HD packs: AI-upscaled replacements for the game's pictures, made from the
// player's own files by tools/hdpack.py (docs/graphics.md). A pack is a zip
// of WebP images plus manifest.json, keyed by imageKey() of the picture as
// the engine shows it (RGBA under the current palette), so one bitmap can
// have a version per world palette.
//
// The 3D renderer swaps HD textures in (render3d/webgl.js); the display
// draws HD 2D art over the enlarged sprite layer where those bitmaps are
// still visible (display.js).
import { zipEntries } from "./gamefiles.js";

/**
 * 16 hex digits for a w x h RGBA picture whose see-through pixels are all
 * zero. Sum over pixels of word_i * k(i), wrapping at 32 bits, twice with
 * different constants (tools/hdpack.py image_key computes the same).
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number} w
 * @param {number} h
 */
export function imageKey(rgba, w, h) {
  const n = w * h;
  const words = rgba.byteOffset % 4 === 0 ? new Uint32Array(rgba.buffer, rgba.byteOffset, n) : new Uint32Array(rgba.slice(0, n * 4).buffer);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const v = words[i];
    if (!v) continue;
    const k = i + 1;
    a = (a + Math.imul(v, Math.imul(k, 0x9e3779b1) ^ 0x85ebca77)) | 0;
    b = (b + Math.imul(v, Math.imul(k, 0x85ebca77) ^ 0xc2b2ae3d)) | 0;
  }
  a ^= Math.imul(w, 0x27d4eb2d) ^ h;
  b ^= Math.imul(h, 0x165667b1) ^ w;
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

let packs = 0;

export class HdPack {
  /**
   * @param {Map<string, { read: () => Promise<Uint8Array> }>} files
   * @param {any} manifest
   */
  constructor(files, manifest) {
    this.files = files;
    this.manifest = manifest;
    /** @type {Map<string, ImageBitmap | null>} key -> decoded image (null while decoding or failed) */
    this.images = new Map();
    this.version = 0; // bumped when an image finishes decoding
    this.id = String(++packs); // tells packs apart in cache keys
    /** @type {(() => void) | null} */
    this.onReady = null;
  }

  /**
   * @param {Blob} blob  the pack's zip
   */
  static async fromZip(blob) {
    const entries = await zipEntries(blob);
    const files = new Map(entries.map((/** @type {any} */ e) => [e.path, e]));
    const m = files.get("manifest.json");
    if (!m) throw new Error("not an HD pack (no manifest.json)");
    const manifest = JSON.parse(new TextDecoder().decode(await m.read()));
    if (manifest.version !== 1 || !manifest.images) throw new Error("unknown HD pack version");
    return new HdPack(files, manifest);
  }

  get size() {
    return Object.keys(this.manifest.images).length;
  }

  /**
   * @param {string} key
   */
  has(key) {
    return key in this.manifest.images;
  }

  // The HD image for a key once decoded; starts decoding on first ask.
  /**
   * @param {string} key
   * @returns {ImageBitmap | null}
   */
  get(key) {
    const hit = this.images.get(key);
    if (hit !== undefined) return hit;
    const info = this.manifest.images[key];
    if (!info) return null;
    this.images.set(key, null);
    const f = this.files.get(info.file);
    f?.read()
      .then((bytes) => createImageBitmap(new Blob([/** @type {any} */ (bytes)], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" }))
      .then((img) => {
        this.images.set(key, img);
        this.version++;
        this.onReady?.();
      })
      .catch(() => {});
    return null;
  }
}
