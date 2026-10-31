// RENDER.R32: the 3D battlefield (RenderWare 2.0), plus DirectSound audio,
// input options and hotspots. Only the calls the menus need so far; the 3D
// externs are stubs that log once (see docs/engine-plan.md, milestone 3).
import { decodeSound } from "../sound.js";
import { AnimationSystem, animationExterns } from "../anim/animation.js";
import { listExterns } from "../anim/lists.js";
import { ScriptFiles } from "../anim/files.js";
import { Hotspots } from "../anim/hotspots.js";
import { motionExterns } from "../anim/motion.js";
import { taskExterns } from "../anim/tasks.js";

export class RenderPlugin {
  constructor(engine) {
    this.engine = engine;
    this.name = "render";
    this.playing = new Map(); // sound resource id -> WebAudio source
    this.cache = new Map();
    const self = this;
    const ok = () => 1;
    this.anim = engine.animation = new AnimationSystem(engine);
    this.files = new ScriptFiles(engine);
    this.hotspots = engine.hotspots = new Hotspots(engine);
    this.externs = {
      ...this.hotspots.externs(),
      ...animationExterns(this.anim),
      ...listExterns(engine),
      ...this.files.externs(),
      ...motionExterns(engine),
      ...taskExterns(engine),
      // Sound. Scripts identify a playing sound by its resource id.
      DSInitWavePlay: ok,
      DSDeInitWavePlay() {
        self.stopAll();
        return 1;
      },
      DSLoadWave(id) {
        self.sound(id);
        return id;
      },
      DSUnloadWave(id) {
        if (id) self.stop(id);
        return 1;
      },
      // DSPlayWave(id, volume (10000 = full), pan, loop, ?, ?, ?)
      DSPlayWave(id, volume, pan, loop) {
        return self.play(id, volume, loop);
      },
      DSStopWave(id) {
        if (id) self.stop(id);
        else self.stopAll();
        return 1;
      },
      DSPauseAudio: ok,
      // Input and modes that need no work in a browser.
      MouseOnOff: ok,
      EnableJoystick: ok,
      MapActionKeys: ok,
      SetPauseScript: ok,
      Pause3D: ok,
    };
  }

  // Called by Engine.init before the game starts.
  async preload() {
    await this.files.preload(this.engine.files);
  }

  sound(id) {
    let s = this.cache.get(id);
    if (!s && this.engine.bin.type(id) === 12) {
      s = decodeSound(this.engine.res(id));
      this.cache.set(id, s);
    }
    return s;
  }

  play(id, volume, loop) {
    const e = this.engine;
    const s = this.sound(id);
    if (!s) return 0;
    this.stop(id);
    if (!e.audio) return id;
    const src = e.audio.play(s, { loop: !!loop, volume: Math.min(1, (volume || 10000) / 10000) });
    if (src) {
      this.playing.set(id, src);
      src.addEventListener?.("ended", () => this.playing.get(id) === src && this.playing.delete(id));
    }
    return id;
  }

  stop(id) {
    const src = this.playing.get(id);
    if (src) this.engine.audio?.stopSound(src);
    this.playing.delete(id);
  }

  stopAll() {
    for (const id of [...this.playing.keys()]) this.stop(id);
  }
}
