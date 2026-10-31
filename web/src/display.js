// The 640x480 8-bit screen. Everything draws palette indices into `pixels`;
// present() converts to RGBA for a canvas (or nothing, headless).

export const WIDTH = 640;
export const HEIGHT = 480;

export class Display {
  constructor(canvas = null) {
    this.pixels = new Uint8Array(WIDTH * HEIGHT);
    this.palette = new Uint8Array(768);
    this.fade = 1; // 0..1 brightness of colours 10-245, for palette fades
    this.frozen = null; // {pixels, palette} shown instead while fading out
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.image = this.ctx ? this.ctx.createImageData(WIDTH, HEIGHT) : { data: new Uint8ClampedArray(WIDTH * HEIGHT * 4) };
    this.dirty = true;
    // 3D view drawn under the sprites: {canvas, x, y}. Where it is set,
    // colour 0 (transparent in every bitmap) shows the 3D view instead.
    this.underlay = null;
    this.layer = null; // offscreen canvas for the sprite layer
    this.overlay = null; // (ctx, brightness 0..1) => void, after each frame
  }
  setPalette(rgb768, first = 0, count = 256) {
    this.palette.set(rgb768.subarray(first * 3, (first + count) * 3), first * 3);
    this.dirty = true;
  }
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
    if (!under) this.ctx.putImageData(this.image, 0, 0);
    else {
      if (!this.layer) {
        this.layer = new OffscreenCanvas(WIDTH, HEIGHT);
        this.layerCtx = this.layer.getContext("2d");
      }
      this.layerCtx.putImageData(this.image, 0, 0);
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, WIDTH, HEIGHT);
      this.ctx.drawImage(under.canvas, under.x || 0, under.y || 0);
      this.ctx.drawImage(this.layer, 0, 0);
    }
    // Browser-port additions drawn on top in true colour (volume-panel.js).
    this.overlay?.(this.ctx, this.frozen ? 0 : this.fade);
  }
}
