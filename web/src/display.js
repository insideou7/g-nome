// The 640x480 8-bit screen. Everything draws palette indices into `pixels`;
// present() converts to RGBA for a canvas (or nothing, headless).

export const WIDTH = 640;
export const HEIGHT = 480;

export class Display {
  constructor(canvas = null) {
    this.pixels = new Uint8Array(WIDTH * HEIGHT);
    this.palette = new Uint8Array(768);
    this.fade = 1; // 0..1 brightness, for palette fades
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
  // Composite hook: the engine redraws background + sprites before present.
  present() {
    if (!this.dirty) return;
    this.dirty = false;
    const d = this.image.data, px = this.pixels, pal = this.palette, f = this.fade;
    for (let i = 0, o = 0; i < px.length; i++, o += 4) {
      const c = px[i] * 3;
      d[o] = pal[c] * f;
      d[o + 1] = pal[c + 1] * f;
      d[o + 2] = pal[c + 2] * f;
      d[o + 3] = 255;
    }
    if (this.ctx) this.ctx.putImageData(this.image, 0, 0);
  }
}
