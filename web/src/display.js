// The 640x480 8-bit screen. Everything draws palette indices into `pixels`;
// present() converts to RGBA for a canvas (or nothing, headless).
// The canvas itself can be bigger (graphics.js): `scale` times 640x480, with
// the 3D underlay rendered at that size and the sprite layer enlarged with
// the `sprites` filter. `image` always stays 640x480.
import { scale2x } from "./graphics.js";
import { UpscaleGL } from "./upscale-gl.js";
import { imageKey } from "./hdpack.js";

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
    /** @type {"sharp" | "smooth" | "scale2x" | "xbr"} */
    this.sprites = "sharp";
    /** @type {Uint8Array | null} */ this.big = null; // Scale2x indices
    /** @type {ImageData | null} */ this.bigImage = null;
    /** @type {Uint32Array | undefined} */ this.pal32;
    /** @type {UpscaleGL | null | undefined} */ this.gpu = undefined; // GPU upscaler, made on first use
    // HD pack (hdpack.js) for 2D art, and what the last compose drew.
    /** @type {import("./hdpack.js").HdPack | null} */ this.hd = null;
    /** @type {{ owner: Uint16Array, list: any[] } | null} */ this.rec = null;
    /** @type {WeakMap<object, { pal: string, key: string, has: boolean }>} */ this.hdKeys = new WeakMap();
    /** @type {ImageData | undefined} */ this.hdMask;
    /** @type {OffscreenCanvas | undefined} */ this.hdMaskCanvas;
    /** @type {OffscreenCanvas | undefined} */ this.hdTmp;
  }

  // Engine.compose asks before drawing: with HD art in use, blits note
  // which of them drew each pixel (sprites.js blit).
  hdRecord() {
    if (!this.hd || this.scale < 2 || !this.ctx) return (this.rec = null);
    if (!this.rec) this.rec = { owner: new Uint16Array(WIDTH * HEIGHT), list: [] };
    this.rec.owner.fill(0);
    this.rec.list.length = 0;
    return this.rec;
  }

  // The HD image for a decoded bitmap under the current palette, if the
  // pack has one and it is ready.
  /**
   * @param {any} b  {width, height, pixels}
   * @param {Uint8Array} pal
   * @param {string} palKey
   */
  hdImage(b, pal, palKey) {
    const hd = /** @type {import("./hdpack.js").HdPack} */ (this.hd);
    let k = this.hdKeys.get(b);
    if (!k || k.pal !== palKey) {
      const n = b.width * b.height, rgba = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const c = b.pixels[i];
        if (!c) continue;
        rgba[i * 4] = pal[c * 3];
        rgba[i * 4 + 1] = pal[c * 3 + 1];
        rgba[i * 4 + 2] = pal[c * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      const key = imageKey(rgba, b.width, b.height);
      k = { pal: palKey, key, has: hd.has(key) };
      this.hdKeys.set(b, k);
    }
    return k.has ? hd.get(k.key) : null;
  }

  // Draw HD versions of the bitmaps the last compose blitted, over the
  // enlarged frame, only where each one's own pixels still show.
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} s
   */
  drawHd(ctx, s) {
    const rec = this.rec, pal = this.palette;
    if (!rec || !rec.list.length) return;
    let palKey = "";
    for (let i = 30; i < 738; i += 7) palKey += pal[i].toString(36);
    const owner = rec.owner, px = this.pixels;
    rec.list.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
      const img = this.hdImage(e.b, pal, palKey);
      if (!img) return;
      const { width: w, height: h, pixels } = e.b;
      const tag = i + 1;
      // Mask of this blit's pixels that nothing covered since.
      const mask = (this.hdMask ??= new ImageData(WIDTH, HEIGHT));
      const md = new Uint32Array(mask.data.buffer);
      let shown = 0, drawn = 0;
      const x0 = Math.max(0, e.x), y0 = Math.max(0, e.y), x1 = Math.min(WIDTH, e.x + w), y1 = Math.min(HEIGHT, e.y + h);
      if (x1 <= x0 || y1 <= y0) return;
      for (let y = y0; y < y1; y++) {
        const sy = e.flipY ? h - 1 - (y - e.y) : y - e.y;
        for (let x = x0; x < x1; x++) {
          const sx = e.flipX ? w - 1 - (x - e.x) : x - e.x;
          const c = pixels[sy * w + sx];
          if (!c) continue;
          drawn++;
          const o = y * WIDTH + x;
          const ok = owner[o] === tag && px[o] === c;
          if (ok) shown++;
          md[(y - y0) * WIDTH + (x - x0)] = ok ? 0xffffffff : 0;
        }
      }
      if (!shown) return;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const draw = (/** @type {any} */ c) => {
        ctx.translate(e.flipX ? (e.x + w) * s : e.x * s, e.flipY ? (e.y + h) * s : e.y * s);
        ctx.scale(e.flipX ? -1 : 1, e.flipY ? -1 : 1);
        ctx.drawImage(img, 0, 0, w * s, h * s);
      };
      if (shown === drawn) draw(ctx);
      else {
        // Partly covered: cut the HD picture down to the visible pixels.
        const bw = x1 - x0, bh = y1 - y0;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const sx = e.flipX ? w - 1 - (x + x0 - e.x) : x + x0 - e.x, sy = e.flipY ? h - 1 - (y + y0 - e.y) : y + y0 - e.y;
          if (!pixels[sy * w + sx]) md[y * WIDTH + x] = 0;
        }
        const mc = (this.hdMaskCanvas ??= new OffscreenCanvas(WIDTH, HEIGHT));
        /** @type {OffscreenCanvasRenderingContext2D} */ (mc.getContext("2d")).putImageData(mask, 0, 0, 0, 0, bw, bh);
        const tmp = (this.hdTmp ??= new OffscreenCanvas(1, 1));
        if (tmp.width !== WIDTH * s) (tmp.width = WIDTH * s), (tmp.height = HEIGHT * s);
        const tc = /** @type {OffscreenCanvasRenderingContext2D} */ (tmp.getContext("2d"));
        tc.setTransform(1, 0, 0, 1, 0, 0);
        tc.globalCompositeOperation = "copy";
        tc.imageSmoothingEnabled = true;
        tc.save();
        tc.translate(e.flipX ? (e.x + w) * s : e.x * s, e.flipY ? (e.y + h) * s : e.y * s);
        tc.scale(e.flipX ? -1 : 1, e.flipY ? -1 : 1);
        tc.drawImage(img, 0, 0, w * s, h * s);
        tc.restore();
        tc.globalCompositeOperation = "destination-in";
        tc.imageSmoothingEnabled = false;
        tc.drawImage(mc, 0, 0, bw, bh, x0 * s, y0 * s, bw * s, bh * s);
        ctx.drawImage(tmp, x0 * s, y0 * s, bw * s, bh * s, x0 * s, y0 * s, bw * s, bh * s);
      }
      ctx.restore();
    });
  }
  // Resize the canvas to `scale` x 640x480 and pick the sprite filter.
  /**
   * @param {number} scale
   * @param {"sharp" | "smooth" | "scale2x" | "xbr"} sprites
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
    const filter = this.sprites;
    if ((filter === "scale2x" || filter === "xbr") && s > 1) {
      if (this.gpu === undefined) {
        try {
          this.gpu = new UpscaleGL(WIDTH, HEIGHT);
        } catch {
          this.gpu = null;
        }
      }
      if (this.gpu) layer = this.gpu.run(this.image, filter, s);
      else {
        // No (hardware) WebGL2: Scale2x in JS on the palette indices.
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
      // HD art; not while fading or frozen (the pack has full brightness).
      if (this.hd && !this.frozen && this.fade === 1 && s > 1) this.drawHd(/** @type {CanvasRenderingContext2D} */ (ctx), s);
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
