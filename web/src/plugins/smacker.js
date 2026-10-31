// SMACKER.R32: plays the .SMK cutscenes. Reversed from the G-Nome build;
// the scripts call (arguments after the plugin context the DLL gets):
//   SmackerSetupView(a, b, c, width, e, f)
//   SmackerPlayAnimation(fileStr, dirStr, flags, p5, p6, endScript, endArg, loop)
//   SmackerUnload()          stop now, as if the movie ended
//   SmackerActive(on)        0 also closes the file
// When the last frame plays (and `loop` is 0), or on SmackerUnload, the
// plugin runs `endScript(endArg)` through RtRunMsg.
import { SmackerFile } from "../smacker.js";

export class SmackerPlugin {
  constructor(engine) {
    this.engine = engine;
    this.name = "smacker";
    this.movie = null;
    const self = this;
    this.externs = {
      SmackerSetupView() {
        return 1;
      },
      SmackerSetScreenRes() {
        return 1;
      },
      SmackerPlayAnimation(fileStr, dirStr, flags, p5, p6, endScript, endArg, loop) {
        return self.play(engine.getString(fileStr), endScript, endArg, loop);
      },
      SmackerUnload() {
        if (self.movie) self.finish();
        return 0;
      },
      SmackerActive(on) {
        if (!on && self.movie) self.movie = null;
        return 0;
      },
      SmackerMessageBox(caption, text) {
        engine.log(`message box: ${engine.getString(caption)}: ${engine.getString(text)}`);
        return 0;
      },
    };
  }

  play(name, endScript, endArg, loop) {
    const e = this.engine;
    e.log(`smacker: play ${name} (then script ${endScript}(${endArg}))`);
    if (!e.files.has(name)) {
      e.log(`smacker: ${name} not found`);
      return 0;
    }
    const movie = { name, endScript, endArg, loop, smk: null, clock: 0, shown: -1 };
    this.movie = movie;
    e.files.read(name).then((bytes) => {
      if (this.movie !== movie) return;
      movie.smk = new SmackerFile(bytes);
      movie.audioStart = e.audio?.now();
    }).catch((err) => {
      e.log(`smacker: ${name}: ${err.message}`);
      if (this.movie === movie) this.finish();
    });
    return 1;
  }

  // Called by the engine every tick.
  service(ms) {
    const m = this.movie;
    if (!m || !m.smk) return;
    const smk = m.smk;
    m.clock += ms;
    // Show every frame that is due, decoding skipped ones so the deltas stay
    // correct.
    while (m.shown + 1 < smk.frameCount && (m.shown + 1) * smk.frameMs <= m.clock) {
      const f = smk.decodeFrame();
      m.shown = f.index;
      for (const a of f.audio) this.engine.audio?.queue(a.samples, a.channels, a.rate);
      this.draw(f);
    }
    if (m.shown + 1 >= smk.frameCount && (m.shown + 1) * smk.frameMs <= m.clock) {
      if (m.loop) {
        smk.rewind();
        m.clock = 0;
        m.shown = -1;
      } else this.finish();
    }
  }

  draw(f) {
    const d = this.engine.display;
    if (!d) return;
    const smk = this.movie.smk;
    // 320x200 movies are shown doubled, centred on the 640x480 screen.
    const scale = smk.width <= 320 ? 2 : 1;
    const w = smk.width * scale, h = smk.height * smk.yScale * scale;
    const ox = (640 - w) >> 1, oy = (480 - h) >> 1;
    const ys = smk.yScale * scale;
    for (let y = 0; y < h; y++) {
      const src = ((y / ys) | 0) * smk.width;
      let o = (oy + y) * 640 + ox;
      for (let x = 0; x < w; x++) d.pixels[o++] = f.pixels[src + ((x / scale) | 0)];
    }
    // The movie loads its own palette, which replaces a faded-out one.
    if (f.paletteChanged) d.setPalette(f.palette);
    d.fade = 1;
    d.dirty = true;
  }

  finish() {
    const m = this.movie;
    this.movie = null;
    const e = this.engine;
    e.audio?.stop();
    if (e.display) {
      e.display.clear(0);
      e.display.setPalette(e.palette);
    }
    if (m && m.endScript) e.runLater(m.endScript, [m.endArg]);
  }

  get ownsScreen() {
    return !!this.movie;
  }
}
