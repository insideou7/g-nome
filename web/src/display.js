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
    for (let i = 0, o = 0; i < px.length; i++, o += 4) {
      const c = px[i] * 3;
      d[o] = pal[c];
      d[o + 1] = pal[c + 1];
      d[o + 2] = pal[c + 2];
      d[o + 3] = 255;
    }
    if (this.ctx) this.ctx.putImageData(this.image, 0, 0);
  }
}
