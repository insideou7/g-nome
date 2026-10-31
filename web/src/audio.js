// WebAudio output: a queue of PCM chunks played back to back (movie sound),
// plus one-shot sounds.

export class Audio {
  constructor() {
    this.ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    this.next = 0;
    this.sources = new Set();
  }
  now() {
    return this.ctx.currentTime;
  }
  resume() {
    if (this.ctx.state !== "running") this.ctx.resume();
  }
  // Interleaved Int16 samples.
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
    src.connect(this.ctx.destination);
    const t = Math.max(this.next, this.ctx.currentTime + 0.05);
    src.start(t);
    this.next = t + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }
  // One-shot or looping sound effect / music. Returns a handle.
  play(snd, { loop = false, volume = 1 } = {}) {
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
    src.connect(gain).connect(this.ctx.destination);
    src.start();
    return src;
  }
  stopSound(src) {
    try {
      src?.stop();
    } catch {}
  }
  stop() {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.next = 0;
  }
}
