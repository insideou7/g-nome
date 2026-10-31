// Volume sliders on OPTIONS > SOUND. The original screen only has On/Off for
// "CD Music" (global 2115, 1 = off) and "SFX/Dialogue" (global 2116, 1 = off)
// and leaves the levels to the Windows mixer, so this panel is the browser
// port's own addition: two sliders under the game's toggles, one per audio
// bus (audio.js). Levels are saved with the INI settings.

const SECTION = "browser";
// While the SOUND page is up, G2056 holds its close script (6948, set by
// script 6942) and sprite 6949 (the page's panel) is shown.
const PAGE_GLOBAL = 2056;
const PAGE_CLOSE_SCRIPT = 6948;
const PAGE_SPRITE = 6949;

// Canvas pixels (640x480). The black panel's middle is x 325; the game's
// SFX/Dialogue On/Off row ends around y 292.
const X0 = 235;
const WIDTH = 180;
const SLIDERS = [
  { bus: "music", key: "musicvolume", label: "Music Volume", y: 318 },
  { bus: "effects", key: "effectsvolume", label: "SFX/Dialogue Volume", y: 362 },
];
const LABEL_H = 16; // label above the bar
const BAR_H = 8;
const GRAB = 8; // extra pixels around a bar that still grab it

export class VolumePanel {
  constructor(engine) {
    this.engine = engine;
    this.drag = null; // slider being dragged
    this.wasShown = false;
    this.levels = {};
    for (const s of SLIDERS) {
      const v = parseInt(engine.ini.get(SECTION, s.key), 10);
      this.levels[s.bus] = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
      engine.audio?.setVolume(s.bus, this.levels[s.bus] / 100);
    }
  }

  get shown() {
    const e = this.engine;
    if (!e.vm || e.fadedOut || e.display?.frozen) return false;
    if (e.plugins?.some((p) => p.ownsScreen)) return false;
    return e.vm.getGlobal(PAGE_GLOBAL) === PAGE_CLOSE_SCRIPT && !!e.sprites.get(PAGE_SPRITE)?.visible;
  }

  // 0..100
  level(bus) {
    return this.levels[bus];
  }
  setLevel(bus, v) {
    const s = SLIDERS.find((x) => x.bus === bus);
    if (!s) return;
    v = Math.round(Math.max(0, Math.min(100, v)));
    if (v === this.levels[bus]) return;
    this.levels[bus] = v;
    this.engine.audio?.setVolume(bus, v / 100);
    this.engine.ini.set(SECTION, s.key, v);
    if (this.engine.display) this.engine.display.dirty = true;
  }

  barTop(s) {
    return s.y + LABEL_H;
  }
  // The slider at canvas pixel (x, y), if any.
  hit(x, y) {
    return SLIDERS.find((s) => x >= X0 - GRAB && x < X0 + WIDTH + GRAB && y >= this.barTop(s) - GRAB && y < this.barTop(s) + BAR_H + GRAB);
  }
  dragTo(x) {
    this.setLevel(this.drag.bus, ((x - X0) * 100) / WIDTH);
  }

  // Mouse handlers: true when the panel took the event.
  mouseDown(x, y) {
    if (!this.shown) return false;
    const s = this.hit(x, y);
    if (!s) return false;
    this.drag = s;
    this.dragTo(x);
    return true;
  }
  mouseMove(x) {
    if (!this.drag) return false;
    if (!this.shown) this.drag = null;
    else this.dragTo(x);
    return true;
  }
  mouseUp() {
    const was = !!this.drag;
    this.drag = null;
    return was;
  }

  // Once a frame: redraw when the page comes or goes.
  update() {
    const shown = this.shown;
    if (shown !== this.wasShown && this.engine.display) this.engine.display.dirty = true;
    this.wasShown = shown;
    if (!shown) this.drag = null;
  }

  // Drawn over the presented frame (Display.overlay), in the colours of the
  // page's headings (cyan) and toggles (green).
  draw(ctx, fade = 1) {
    if (!this.shown) return;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const s of SLIDERS) {
      const v = this.levels[s.bus];
      const top = this.barTop(s);
      ctx.font = "bold 14px Arial, sans-serif";
      ctx.fillStyle = "#7cf8f8";
      ctx.fillText(s.label, X0 + WIDTH / 2, s.y);
      // bar: dark track, filled part, handle
      ctx.fillStyle = "#0c3c0c";
      ctx.fillRect(X0, top, WIDTH, BAR_H);
      ctx.fillStyle = "#18e818";
      ctx.fillRect(X0, top, Math.round((WIDTH * v) / 100), BAR_H);
      ctx.strokeStyle = "#18e818";
      ctx.lineWidth = 1;
      ctx.strokeRect(X0 + 0.5, top + 0.5, WIDTH - 1, BAR_H - 1);
      const hx = X0 + Math.round((WIDTH * v) / 100);
      ctx.fillStyle = "#c8ffc8";
      ctx.fillRect(hx - 2, top - 3, 4, BAR_H + 6);
      ctx.font = "bold 12px Arial, sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = "#18e818";
      ctx.fillText(`${v}%`, X0 + WIDTH + 10, top - 2);
      ctx.textAlign = "center";
      if (s.bus === "music" && !this.engine.music.available) {
        ctx.font = "11px Arial, sans-serif";
        ctx.fillStyle = "#8a8a8a";
        ctx.fillText("No CD music tracks found in the game folder", X0 + WIDTH / 2, top + BAR_H + 4);
      }
    }
    ctx.restore();
  }
}
