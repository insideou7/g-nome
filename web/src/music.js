// CD music. G-Nome's music is red book audio on the game CD (tracks 2-20,
// statement 0x8e), which a browser can't read off a disc. If the player has
// ripped the tracks, they can put them in the game folder or a MUSIC folder
// inside it, named like TRACK02.OGG, Track 02.mp3 or 02.wav, and they play
// here. Scripts pick and time the tracks themselves (scripts 313-316), and
// skip them while CD Music is off (global 2115), so this only plays and stops.

const EXT = "(?:OGG|MP3|WAV|FLAC|OPUS|M4A)";
// "TRACK02.OGG", "G-NOME TRACK 02.MP3", "02.WAV", "MUSIC/Track 2 (G-Nome).flac"
const TRACK_NAME = new RegExp(`^(?:MUSIC/)?(?:[^/]*TRACK[ _-]*|)0*(\\d{1,2})(?:[^/\\d][^/]*)?\\.${EXT}$`, "i");

export function trackNumber(name) {
  const m = TRACK_NAME.exec(name);
  return m ? Number(m[1]) : 0;
}

export class CdMusic {
  constructor(engine) {
    this.engine = engine;
    this.track = 0; // last track the scripts asked for (0 = stopped)
    this.token = 0;
    this.found = null; // track number -> file name, from the folder listing
  }

  // File names to try for a track.
  candidates(track) {
    const files = this.engine.files;
    if (!this.found) {
      this.found = new Map();
      for (const n of files.names || []) {
        const t = trackNumber(n);
        if (t && !this.found.has(t)) this.found.set(t, n);
      }
    }
    if (this.found.has(track)) return [this.found.get(track)];
    // No listing (development HTTP loader): guess the common names.
    if (files.names?.length) return [];
    const nn = String(track).padStart(2, "0");
    return ["OGG", "MP3", "WAV"].map((x) => `TRACK${nn}.${x}`);
  }

  // false when the folder listing has no track files (unknown: true).
  get available() {
    if (!this.engine.files.names?.length) return true;
    this.candidates(0);
    return this.found.size > 0;
  }

  async play(track) {
    this.stop();
    this.track = track;
    const audio = this.engine.audio;
    if (!audio) return;
    const token = this.token;
    for (const name of this.candidates(track)) {
      let bytes;
      try {
        bytes = await this.engine.files.read(name);
      } catch {
        continue;
      }
      if (token !== this.token) return;
      try {
        await audio.playMusic(bytes);
        this.engine.log(`music: track ${track} (${name})`);
      } catch (err) {
        this.engine.log(`music: can't decode ${name}: ${err.message}`);
      }
      return;
    }
  }

  stop() {
    this.token++;
    this.track = 0;
    this.engine.audio?.stopMusic();
  }
}
