// RENDER.R32: the 3D battlefield (RenderWare 2.0), plus DirectSound audio,
// input options and hotspots. Only the calls the menus need so far; the 3D
// externs are stubs that log once (see docs/engine-plan.md, milestone 3).
import { decodeSound } from "../sound.js";
import { battlefieldExterns } from "../battlefield/externs.js";
import { install3D } from "../render3d/externs.js";
import { AnimationSystem, animationExterns } from "../anim/animation.js";
import { listExterns } from "../anim/lists.js";
import { ScriptFiles } from "../anim/files.js";
import { Hotspots } from "../anim/hotspots.js";
import { motionExterns } from "../anim/motion.js";
import { taskExterns } from "../anim/tasks.js";
import { collisionExterns } from "../battlefield/collision.js";
import { aimExterns } from "../battlefield/aim.js";
import { combatExterns } from "../combat/externs.js";
import { radarExterns } from "../battlefield/radar.js";

export class RenderPlugin {
  constructor(engine) {
    this.engine = engine;
    this.name = "render";
    this.playing = new Map(); // sound resource id -> WebAudio source
    this.cache = new Map();
    const self = this;
    const ok = () => 1;
    this.anim = engine.animation = new AnimationSystem(engine);
    this.files = new ScriptFiles(engine, engine.storage ?? globalThis.localStorage);
    this.hotspots = engine.hotspots = new Hotspots(engine);
    this.externs = {
      ...this.hotspots.externs(),
      ...animationExterns(this.anim),
      ...listExterns(engine),
      ...this.files.externs(),
      ...motionExterns(engine),
      ...taskExterns(engine),
      ...collisionExterns(engine),
      ...aimExterns(engine),
      ...combatExterns(engine),
      ...radarExterns(engine),
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
      // DSPlayWave(id, volume (10000 = full), pan (-10000..10000), loop, ?, ?, ?)
      DSPlayWave(id, volume, pan, loop) {
        return self.play(id, volume, loop, pan);
      },
      DSStopWave(id) {
        if (id) self.stop(id);
        else self.stopAll();
        return 1;
      },
      DSPauseAudio: ok,
      // Input and modes that need no work in a browser.
      SetPauseScript: ok,
      // CaptureKey(script): send the next press to script (input.js)
      CaptureKey(script) {
        engine.input.capture(script);
        return 1;
      },
      // World, camera and view: web/src/battlefield/
      ...battlefieldExterns(engine),
    };
    // Objects, models, previews: web/src/render3d (docs/render3d.md).
    this.r3d = install3D(this);
  }

  // Once per display frame: run the battlefield's fixed ticks, then draw
  // the 3D view under the sprites.
  service(ms) {
    const e = this.engine, w = e.world;
    if (!w) return;
    w.advance(ms);
    if (!e.display) return;
    const canvas = w.shown ? w.view.frame() : null;
    e.display.underlay = canvas ? { canvas, x: w.origin[0], y: w.origin[1] } : null;
    if (canvas) {
      e.dirty = true;
      e.display.dirty = true;
    }
  }

  // Called by Engine.init before the game starts.
  async preload() {
    await this.files.preload(this.engine.files);
  }

  // DeleteCopy (builtin 0x22) of an object in the scene removes it.
  onDeleteCopy(id) {
    this.engine.world?.remove(id);
  }

  sound(id) {
    let s = this.cache.get(id);
    if (!s && this.engine.bin.type(id) === 12) {
      s = decodeSound(this.engine.res(id));
      this.cache.set(id, s);
    }
    return s;
  }

  play(id, volume, loop, pan = 0) {
    const e = this.engine;
    const s = this.sound(id);
    if (!s) return 0;
    this.stop(id);
    if (!e.audio) return id;
    const src = e.audio.play(s, { loop: !!loop, volume: Math.min(1, (volume || 10000) / 10000), pan: Math.max(-1, Math.min(1, (pan || 0) / 10000)) });
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
