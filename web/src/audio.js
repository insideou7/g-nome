// WebAudio output: a queue of PCM chunks played back to back (movie sound),
// one-shot sounds, and CD music. Everything goes through one of two volume
// buses, matching the game's two sound options: "music" (CD audio) and
// "effects" (SFX/Dialogue, which also carries movie sound).

export class Audio {
  constructor() {
    this.ctx = new (globalThis.AudioContext || /** @type {any} */ (globalThis).webkitAudioContext)();
    this.next = 0;
    this.sources = new Set();
    /** @type {Record<string, GainNode>} */
    this.buses = {};
    for (const name of ["music", "effects"]) {
      const g = this.ctx.createGain();
      g.connect(this.ctx.destination);
      this.buses[name] = g;
    }
    this.music = null;
    this.musicToken = 0;
  }
  now() {
    return this.ctx.currentTime;
  }
  resume() {
    if (this.ctx.state !== "running") this.ctx.resume();
  }
  // volume 0..1. Squared so the slider feels even to the ear.
  /**
   * @param {string} bus
   * @param {number} volume
   */
  setVolume(bus, volume) {
    const g = this.buses[bus];
    if (g) g.gain.value = Math.max(0, Math.min(1, volume)) ** 2;
  }
  // Interleaved Int16 samples.
  /**
   * @param {any} samples
   * @param {number} channels
   * @param {number} rate
   */
  queue(samples, channels, rate) {
    const frames = samples.length / channels;
    if (!frames) return;
    const buf = this.ctx.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = samples[i * channels + c] / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses.effects);
    const t = Math.max(this.next, this.ctx.currentTime + 0.05);
    src.start(t);
    this.next = t + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }
  // One-shot or looping sound effect. Returns a handle.
  /**
   * @param {any} snd
   */
  play(snd, { loop = false, volume = 1, pan = 0 } = {}) {
    const frames = snd.samples.length / snd.channels;
    if (!frames) return null;
    const buf = this.ctx.createBuffer(snd.channels, frames, snd.rate);
    for (let c = 0; c < snd.channels; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = snd.samples[i * snd.channels + c] / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    let out = src.connect(gain);
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      out = out.connect(p);
    }
    out.connect(this.buses.effects);
    src.start();
    return src;
  }
  /**
   * @param {AudioBufferSourceNode | null} src
   */
  stopSound(src) {
    try {
      src?.stop();
    } catch {}
  }
  // CD music: an encoded audio file (OGG, MP3, WAV, FLAC...) the browser
  // decodes. Replaces any track already playing.
  /**
   * @param {any} bytes
   */
  async playMusic(bytes) {
    this.stopMusic();
    const token = this.musicToken;
    const buf = await this.ctx.decodeAudioData(bytes.slice().buffer);
    if (token !== this.musicToken) return null; // stopped or replaced meanwhile
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses.music);
    src.start();
    this.music = src;
    return src;
  }
  stopMusic() {
    this.musicToken++;
    this.stopSound(this.music);
    this.music = null;
  }
  // Stops movie sound (not effects or music).
  stop() {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.next = 0;
  }
}
