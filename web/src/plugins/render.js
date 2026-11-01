// RENDER.R32: the 3D battlefield (RenderWare 2.0), plus DirectSound audio,
// input options and hotspots. docs/render-r32.md lists every export and
// where the browser engine implements it.
import { decodeSound } from "../sound.js";
import { Waves } from "../waves.js";
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
/** @import { Engine } from "../engine.js" */

export class RenderPlugin {
  /**
   * @param {Engine} engine
   */
  constructor(engine) {
    this.engine = engine;
    this.name = "render";
    this.cache = new Map();
    this.waves = new Waves(engine, (id) => this.sound(id));
    const self = this;
    const ok = () => 1;
    this.anim = engine.animation = new AnimationSystem(engine);
    this.files = new ScriptFiles(engine, engine.storage ?? globalThis.localStorage);
    this.hotspots = engine.hotspots = new Hotspots(engine);
    /** @type {Externs} */
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
      // Sound: the five-voice wave player in ../waves.js. Scripts name a
      // sound by its resource id.
      DSInitWavePlay: ok,
      DSDeInitWavePlay() {
        self.waves.stop(0);
        return 1;
      },
      // DSLoadWave(id) 0x1001f4ee: decode it; its 1-based slot in the
      // original's table (any non-zero value), 0 if it is not a sound.
      DSLoadWave(id) {
        return self.sound(id) ? id : 0;
      },
      // DSUnloadWave(id) 0x1001fb4e: stop it and drop it; 0 = every sound.
      DSUnloadWave(id) {
        self.waves.stop(id);
        if (id) self.cache.delete(id);
        else self.cache.clear();
        return 1;
      },
      // DSPlayWave(id, volume, pan, loop, done script, priority, _) 0x1001fd0c
      DSPlayWave(id, volume, pan, loop, done, priority) {
        return self.waves.play(id, volume, pan, loop, done, priority);
      },
      // DSStopWave(id) 0x10020746; 0 = every voice.
      DSStopWave(id) {
        return self.waves.stop(id);
      },
      // DSPauseAudio(on) 0x10020d85: 1 pauses every voice, 0 resumes.
      DSPauseAudio(on) {
        return self.waves.pause(on);
      },
      // DSSetVolume(id, v) 0x10020bbb, DSSetPan(id, p) 0x10020cf0 (no script
      // calls them): change a playing voice.
      DSSetVolume(id, v) {
        return self.waves.set(id, { volume: v });
      },
      DSSetPan(id, p) {
        return self.waves.set(id, { pan: p });
      },
      // SetPauseScript(script) 0x1000db88: the window procedure runs it at
      // once when Pause is pressed (VK 0x13, 0x1000dc7a). input.js does that.
      SetPauseScript(script) {
        engine.input.pauseScript = script;
        return 1;
      },
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
  /**
   * @param {number} ms
   */
  service(ms) {
    const e = this.engine, w = e.world;
    this.waves.service();
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
  /**
   * @param {number} id
   */
  onDeleteCopy(id) {
    this.engine.world?.remove(id);
  }

  /**
   * @param {number} id
   */
  sound(id) {
    let s = this.cache.get(id);
    if (!s && this.engine.bin.type(id) === 12) {
      s = decodeSound(this.engine.res(id));
      this.cache.set(id, s);
    }
    return s;
  }

  // Resource ids of the sounds in a voice (UncachePack keeps those).
  get playing() {
    return { has: (/** @type {number} */ id) => this.waves.has(id) };
  }
}
