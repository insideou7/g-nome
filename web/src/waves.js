// RENDER.R32's DirectSound wave player (DSPlayWave and friends,
// 0x1001ed30-0x10021003). Scripts name a sound by its type 12 resource id.
//
// - Five voices (one DirectSound buffer each). A new sound takes a free
//   voice, else the voice with the lowest priority, if that is not above
//   the new sound's; otherwise it is not played. A sound already playing
//   is rewound and restarted in its voice.
// - Volume is DirectSound's: hundredths of a decibel, 10000 = full
//   (SetVolume(volume - 10000)); above 10000 DirectSound refuses it and the
//   buffer keeps its volume. Pan is DirectSound's too: -10000..10000, the
//   other side attenuated by |pan| / 100 dB.
// - When a sound that does not loop has played to the end, its "done"
//   script is posted with (id, 0) and the voice is freed (0x10021003 ->
//   0x1001f1ed). Stopping a sound does not run it. The briefing narration
//   (script 7274) and the mission messages chain lines this way.
// - DSPauseAudio(1) stops every voice and remembers where it was;
//   DSPauseAudio(0) plays every voice again from the remembered place.
//
// Time is the engine's clock (engine.time), so the done scripts run the same
// with or without WebAudio (headless tests).

const VOICES = 5;
const FULL = 10000;

/** @param {number} v DirectSound volume, 10000 = 0 dB */
export function dsGain(v) {
  return 10 ** ((Math.min(FULL, v) - FULL) / 2000);
}

/** @param {number} pan DirectSound pan, -10000..10000 @returns {[number, number]} left, right gains */
export function dsPanGains(pan) {
  const att = 10 ** (-Math.min(FULL, Math.abs(pan)) / 2000);
  return pan > 0 ? [att, 1] : pan < 0 ? [1, att] : [1, 1];
}

/**
 * @typedef {{ id: number, snd: any, priority: number, loop: boolean,
 *   done: number, volume: number, pan: number, ms: number,
 *   pos: number, start: number, paused: boolean, src: any }} Voice
 */

export class Waves {
  /**
   * @param {any} engine
   * @param {(id: number) => any} sound decoded type 12 resource, or undefined
   */
  constructor(engine, sound) {
    this.engine = engine;
    this.sound = sound;
    /** @type {(Voice | null)[]} */
    this.voices = new Array(VOICES).fill(null);
  }

  now() {
    return this.engine.time || 0;
  }

  /** @param {number} id */
  voiceOf(id) {
    return this.voices.findIndex((v) => v && v.id === id);
  }

  /** @param {number} id */
  has(id) {
    return this.voiceOf(id) >= 0;
  }

  // DSPlayWave(id, volume, pan, loop, done, priority, _) 0x1001fd0c.
  // 1 if it plays, 0 if the sound is missing or every voice outranks it.
  /**
   * @param {number} id
   * @param {number} volume
   * @param {number} pan
   * @param {number} loop
   * @param {number} done
   * @param {number} priority
   */
  play(id, volume = FULL, pan = 0, loop = 0, done = 0, priority = 0) {
    const snd = this.sound(id);
    if (!snd) return 0;
    priority = priority || snd.priority || 0;
    let slot = this.voiceOf(id);
    let old = slot >= 0 ? this.voices[slot] : null;
    if (old) this.silence(old);
    else {
      slot = this.allocate(priority);
      if (slot < 0) return 0;
      const stolen = this.voices[slot];
      if (stolen) this.silence(stolen);
      old = null;
    }
    const frames = snd.samples.length / (snd.channels || 1);
    /** @type {Voice} */
    const v = {
      id, snd, priority, loop: !!loop, done: done | 0,
      // A refused volume or pan leaves the buffer's own (0 dB, centre for a
      // new buffer, the last one for a restarted one).
      volume: volume > FULL ? old?.volume ?? FULL : volume,
      pan: Math.abs(pan) > FULL ? old?.pan ?? 0 : pan,
      ms: (frames / (snd.rate || 22050)) * 1000,
      pos: 0, start: this.now(), paused: false, src: null,
    };
    this.voices[slot] = v;
    this.startAudio(v, 0);
    return 1;
  }

  // 0x1001ed30: the first free voice, else the last one with the lowest
  // priority not above the new sound's; -1 if none.
  /** @param {number} priority */
  allocate(priority) {
    let best = -1, p = priority;
    for (let i = 0; i < VOICES; i++) {
      const v = this.voices[i];
      if (!v) return i;
      if (v.priority <= p) {
        p = v.priority;
        best = i;
      }
    }
    return best;
  }

  // DSStopWave(id) 0x10020746; 0 stops every voice. No done script.
  /** @param {number} id */
  stop(id) {
    if (!id) {
      for (let i = 0; i < VOICES; i++) this.free(i);
      return 1;
    }
    const i = this.voiceOf(id);
    if (i < 0) return 0;
    this.free(i);
    return 1;
  }

  // DSSetVolume / DSSetPan on a playing voice; 0 if it is not playing or
  // DirectSound would refuse the value.
  /** @param {number} id @param {{ volume?: number, pan?: number }} change */
  set(id, change) {
    const v = this.voices[this.voiceOf(id)];
    if (!v) return 0;
    if (change.volume !== undefined) {
      if (change.volume > FULL) return 0;
      v.volume = change.volume;
    }
    if (change.pan !== undefined) {
      if (Math.abs(change.pan) > FULL) return 0;
      v.pan = change.pan;
    }
    if (v.src) {
      const at = v.pos + this.now() - v.start;
      this.silence(v);
      this.startAudio(v, at);
    }
    return 1;
  }

  // DSPauseAudio(on) 0x10020d85.
  /** @param {number} on */
  pause(on) {
    const now = this.now();
    for (const v of this.voices) {
      if (!v) continue;
      if (on) {
        if (!v.paused) v.pos += now - v.start;
        v.paused = true;
        this.silence(v);
      } else {
        v.paused = false;
        v.start = now;
        this.silence(v);
        this.startAudio(v, v.pos);
      }
    }
    return 1;
  }

  // Every tick (the original polls every 20 ms): a voice that does not loop
  // and has played to its end posts its done script and is freed.
  service() {
    const now = this.now();
    for (let i = 0; i < VOICES; i++) {
      const v = this.voices[i];
      if (!v || v.paused || v.loop) continue;
      if (v.pos + now - v.start < v.ms) continue;
      if (v.done) this.engine.runLater(v.done, [v.id, 0]);
      if (this.voices[i] === v) this.free(i);
    }
  }

  /** @param {number} i */
  free(i) {
    const v = this.voices[i];
    if (v) this.silence(v);
    this.voices[i] = null;
  }

  /** @param {Voice} v */
  silence(v) {
    if (v.src) this.engine.audio?.stopSound(v.src);
    v.src = null;
  }

  // Start WebAudio for a voice `at` ms in.
  /** @param {Voice} v @param {number} at */
  startAudio(v, at) {
    const audio = this.engine.audio;
    if (!audio) return;
    const offset = v.loop && v.ms > 0 ? (at % v.ms) / 1000 : at / 1000;
    if (!v.loop && at >= v.ms) return;
    v.src = audio.play(v.snd, { loop: v.loop, volume: dsGain(v.volume), gains: dsPanGains(v.pan), offset });
  }
}
