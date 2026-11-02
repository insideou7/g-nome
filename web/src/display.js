// The 640x480 8-bit screen. Everything draws palette indices into `pixels`;
// present() converts to RGBA for a canvas (or nothing, headless).
// The canvas itself can be bigger (graphics.js): `scale` times 640x480, with
// the 3D underlay rendered at that size and the sprite layer enlarged with
// the `sprites` filter. `image` always stays 640x480.
import { scale2x } from "./graphics.js";
import { Scale2xGL } from "./scale2x-gl.js";

export const WIDTH = 640;
export const HEIGHT = 480;

export class Display {
  /** @param {HTMLCanvasElement | null} [canvas] */
  constructor(canvas = null) {
    this.pixels = new Uint8Array(WIDTH * HEIGHT);
    this.palette = new Uint8Array(768);
    this.fade = 1; // 0..1 brightness of colours 10-245, for palette fades
    this.frozen = null; // {pixels, palette} shown instead while fading out
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    // Headless (no canvas): only .data is used.
    /** @type {ImageData} */
    this.image = this.ctx ? this.ctx.createImageData(WIDTH, HEIGHT) : /** @type {any} */ ({ data: new Uint8ClampedArray(WIDTH * HEIGHT * 4) });
    this.dirty = true;
    // 3D view drawn under the sprites: {canvas, x, y}. Where it is set,
    // colour 0 (transparent in every bitmap) shows the 3D view instead.
    /** @type {any} */
    this.underlay = null;
    this.layer = null; // offscreen canvas for the sprite layer
    /** @type {any} */
    this.overlay = null; // (ctx, brightness 0..1) => void, after each frame
    // Screen shake offsets still to show, one per presented frame (shake()).
    /** @type {[number, number][]} */
    this.shakes = [];
    this.scale = 1; // canvas pixels per game pixel (graphics.js)
    /** @type {"sharp" | "smooth" | "scale2x"} */
    this.sprites = "sharp";
    /** @type {Uint8Array | null} */ this.big = null; // Scale2x indices
    /** @type {ImageData | null} */ this.bigImage = null;
    /** @type {Uint32Array | undefined} */ this.pal32;
    /** @type {Scale2xGL | null | undefined} */ this.gpu = undefined; // GPU Scale2x, made on first use
  }
  // Resize the canvas to `scale` x 640x480 and pick the sprite filter.
  /**
   * @param {number} scale
   * @param {"sharp" | "smooth" | "scale2x"} sprites
   */
  configure(scale, sprites) {
    this.scale = scale;
    this.sprites = sprites;
    if (this.canvas && (this.canvas.width !== WIDTH * scale || this.canvas.height !== HEIGHT * scale)) {
      this.canvas.width = WIDTH * scale;
      this.canvas.height = HEIGHT * scale;
    }
    if (this.canvas) this.canvas.style.imageRendering = scale === 1 && sprites === "sharp" ? "pixelated" : "auto";
    this.dirty = true;
  }
  // SpriteScreenShake (RTLIB32 0x10038355, builtin 0xC8): the original
  // scrolls the stage with ScrollDC by (dx, dy), then by (-2dx, -2dy), then
  // by (dx, dy) back home, and repaints the edge strips the scrolls laid
  // bare. The three scrolls happen in one call, so the eye catches the
  // picture at +d and then at -d. Here each of those is one frame: the
  // finished frame is copied over itself shifted, leaving the uncovered
  // edge strips as they were, like ScrollDC does.
  /**
   * @param {number} dx
   * @param {number} dy
   */
  shake(dx, dy) {
    if (!dx && !dy) return;
    this.shakes.push([dx, dy], [-dx, -dy]);
    this.dirty = true;
  }
  /**
   * @param {any} rgb768
   */
  setPalette(rgb768, first = 0, count = 256) {
    this.palette.set(rgb768.subarray(first * 3, (first + count) * 3), first * 3);
    this.dirty = true;
  }
  /**
   * @param {number} color
   */
  clear(color) {
    this.pixels.fill(color);
    this.dirty = true;
  }
  freeze() {
    this.frozen = { pixels: this.pixels.slice(), palette: this.palette.slice() };
    this.dirty = true;
  }
  unfreeze() {
    this.frozen = null;
    this.dirty = true;
  }
  // Composite hook: the engine redraws background + sprites before present.
  present() {
    if (!this.dirty) return;
    this.dirty = false;
    const shake = this.shakes.shift();
    if (shake) this.dirty = true; // the next frame draws unshifted (or the next offset)
    const src = this.frozen || this;
    const px = src.pixels, pal = src.palette.slice();
    for (let c = 30; c < 246 * 3; c++) pal[c] = pal[c] * this.fade;
    const d = this.image.data;
    const under = !this.frozen && this.underlay;
    for (let i = 0, o = 0; i < px.length; i++, o += 4) {
      const c = px[i] * 3;
      d[o] = pal[c];
      d[o + 1] = pal[c + 1];
      d[o + 2] = pal[c + 2];
      d[o + 3] = under && px[i] === 0 ? 0 : 255;
    }
    if (!this.ctx) return;
    const ctx = this.ctx, s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    /** @type {ImageData | OffscreenCanvas} */
    let layer = this.image;
    if (this.sprites === "scale2x" && s > 1) {
      if (this.gpu === undefined) {
        try {
          this.gpu = new Scale2xGL(WIDTH, HEIGHT);
        } catch {
          this.gpu = null;
        }
      }
      if (this.gpu) layer = this.gpu.run(this.image);
      else {
        // No WebGL2: the same filter in JS on the palette indices.
        this.big = scale2x(px, WIDTH, HEIGHT, this.big ?? undefined);
        if (!this.bigImage) this.bigImage = ctx.createImageData(WIDTH * 2, HEIGHT * 2);
        // One 32-bit write per pixel through a palette of RGBA words.
        const pal32 = (this.pal32 ??= new Uint32Array(256)), bytes = new Uint8Array(pal32.buffer);
        for (let i = 0; i < 256; i++) {
          bytes[i * 4] = pal[i * 3];
          bytes[i * 4 + 1] = pal[i * 3 + 1];
          bytes[i * 4 + 2] = pal[i * 3 + 2];
          bytes[i * 4 + 3] = 255;
        }
        if (under) pal32[0] = 0;
        const b = this.big, out = new Uint32Array(this.bigImage.data.buffer);
        for (let i = 0; i < b.length; i++) out[i] = pal32[b[i]];
        layer = this.bigImage;
      }
    }
    if (!under && s === 1 && layer instanceof ImageData) ctx.putImageData(layer, 0, 0);
    else {
      /** @type {CanvasImageSource} */
      let sprites = /** @type {any} */ (layer);
      if (layer instanceof ImageData) {
        if (!this.layer || this.layer.width !== layer.width) {
          this.layer = new OffscreenCanvas(layer.width, layer.height);
          this.layerCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (this.layer.getContext("2d"));
        }
        /** @type {OffscreenCanvasRenderingContext2D} */ (this.layerCtx).putImageData(layer, 0, 0);
        sprites = this.layer;
      }
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, WIDTH * s, HEIGHT * s);
      if (under) {
        // The renderer draws at its own scale (under.scale); place it in
        // game pixels.
        const us = under.scale || 1, c = under.canvas;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(c, (under.x || 0) * s, (under.y || 0) * s, (c.width / us) * s, (c.height / us) * s);
      }
      ctx.imageSmoothingEnabled = this.sprites !== "sharp";
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sprites, 0, 0, WIDTH * s, HEIGHT * s);
    }
    if (shake) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(ctx.canvas, shake[0] * s, shake[1] * s);
    }
    ctx.setTransform(s, 0, 0, s, 0, 0);
    // Browser-port additions drawn on top in true colour (volume-panel.js).
    this.overlay?.(ctx, this.frozen ? 0 : this.fade);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
