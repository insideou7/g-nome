// Smacker (.SMK) video and audio decoder.
//
// G-Nome's cutscenes are SMK2 files: 320x200, 8-bit palette video with one
// 16-bit stereo 22,050 Hz audio track compressed with Smacker's Huffman DPCM.
// Written from the public format description (multimedia.cx wiki, and the
// layout used by libsmacker and FFmpeg). tests/smacker-check.mjs compares the
// output with FFmpeg frame by frame.

const SMK_NODE = 0x80000000;

const BLOCK_RUNS = (() => {
  const r = [];
  for (let i = 1; i <= 59; i++) r.push(i);
  return r.concat([128, 256, 512, 1024, 2048]);
})();

// 6-bit palette component to 8 bits (Smacker's own table, not a plain
// i * 255 / 63).
const PAL6 = Array.from({ length: 64 }, (_, i) => i * 4 + (i >> 4));

// Little-endian bit reader: the first bit read is bit 0 of the first byte.
class BitReader {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = start * 8;
    this.end = end * 8;
  }
  bit() {
    if (this.pos >= this.end) throw new Error("smacker: bitstream overrun");
    const v = (this.b[this.pos >> 3] >> (this.pos & 7)) & 1;
    this.pos++;
    return v;
  }
  /**
   * @param {number} n
   */
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v >>> 0;
  }
}

// Small 8-bit Huffman tree: a presence bit, then a tree where 1 = node
// (left child is bit 0) and 0 = leaf with an 8-bit value, then a 0 bit.
// An absent tree always decodes to 0 without reading anything.
/**
 * @param {BitReader} br
 */
function readTree8(br) {
  if (!br.bit()) return null;
  /** @returns {any} a leaf byte or a [zero, one] pair */
  const build = () => {
    if (!br.bit()) return br.bits(8);
    const zero = build();
    const one = build();
    return [zero, one];
  };
  const t = build();
  br.bit(); // end marker
  return t;
}

/**
 * @param {BitReader} br
 * @param {any} t
 */
function get8(br, t) {
  if (t === null) return 0;
  while (typeof t !== "number") t = t[br.bit()];
  return t;
}

// The "big" 16-bit trees used by the video planes. Stored as a flat table so
// the three most-recently-used escape slots can be updated in place.
class BigTree {
  /**
   * @param {BitReader} br
   */
  constructor(br) {
    this.values = [];
    this.last = [-1, -1, -1];
    if (!br.bit()) {
      this.values = [0];
      this.last = [0, 0, 0];
      this.empty = true;
      return;
    }
    const lo = readTree8(br);
    const hi = readTree8(br);
    const esc = [br.bits(16), br.bits(16), br.bits(16)];
    /** @returns {any} */
    const decode = () => {
      if (!br.bit()) {
        let v = get8(br, lo) | (get8(br, hi) << 8);
        const idx = this.values.length;
        for (let k = 0; k < 3; k++) {
          if (v === esc[k]) {
            this.last[k] = idx;
            v = 0;
            break;
          }
        }
        this.values.push(v);
        return 1;
      }
      const t = this.values.length;
      this.values.push(0);
      const r = decode();
      this.values[t] = (SMK_NODE | r) >>> 0;
      const r2 = decode();
      return r + 1 + r2;
    };
    decode();
    br.bit(); // end marker
    for (let k = 0; k < 3; k++) {
      if (this.last[k] === -1) {
        this.last[k] = this.values.length;
        this.values.push(0);
      }
    }
  }
  reset() {
    const v = this.values, l = this.last;
    v[l[0]] = v[l[1]] = v[l[2]] = 0;
  }
  /**
   * @param {BitReader} br
   */
  get(br) {
    if (this.empty) return 0;
    const v = this.values;
    let i = 0;
    while (v[i] & SMK_NODE) {
      if (br.bit()) i += v[i] & 0x7fffffff;
      i++;
    }
    const val = v[i];
    const l = this.last;
    if (val !== v[l[0]]) {
      v[l[2]] = v[l[1]];
      v[l[1]] = v[l[0]];
      v[l[0]] = val;
    }
    return val;
  }
}

export class SmackerFile {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const sig = String.fromCharCode(b[0], b[1], b[2], b[3]);
    if (sig !== "SMK2" && sig !== "SMK4") throw new Error("not a Smacker file");
    this.bytes = b;
    this.version = sig === "SMK4" ? 4 : 2;
    this.width = dv.getUint32(4, true);
    this.height = dv.getUint32(8, true);
    this.frameCount = dv.getUint32(12, true);
    const rate = dv.getInt32(16, true);
    // Milliseconds per frame. Negative values are in 1/100 ms.
    this.frameMs = rate > 0 ? rate : rate < 0 ? -rate / 100 : 100;
    this.flags = dv.getUint32(20, true);
    const ring = this.flags & 1 ? 1 : 0;
    this.yScale = this.flags & 6 ? 2 : 1;
    this.audio = [];
    for (let i = 0; i < 7; i++) {
      const r = dv.getUint32(0x48 + 4 * i, true);
      if (r & 0x40000000) {
        this.audio.push({
          track: i,
          packed: !!(r & 0x80000000),
          bits: r & 0x20000000 ? 16 : 8,
          channels: r & 0x10000000 ? 2 : 1,
          rate: r & 0xffffff,
        });
      }
    }
    const treesSize = dv.getUint32(0x34, true);
    const n = this.frameCount + ring;
    let p = 0x68;
    this.frameSizes = [];
    this.keyframe = [];
    for (let i = 0; i < n; i++, p += 4) {
      const s = dv.getUint32(p, true);
      this.frameSizes.push(s & ~3);
      this.keyframe.push(!!(s & 1));
    }
    this.frameTypes = b.subarray(p, p + n);
    p += n;
    const br = new BitReader(b, p, p + treesSize);
    this.mmap = new BigTree(br);
    this.mclr = new BigTree(br);
    this.full = new BigTree(br);
    this.type = new BigTree(br);
    p += treesSize;
    this.frameOffsets = [];
    for (let i = 0; i < n; i++) {
      this.frameOffsets.push(p);
      p += this.frameSizes[i];
    }
    this.pixels = new Uint8Array(this.width * this.height);
    this.palette = new Uint8Array(768); // RGB
    this.next = 0;
  }

  // Decode the next frame. Returns { index, pixels, palette, paletteChanged,
  // audio: [{track, samples: Int16Array (interleaved), channels, rate}] }.
  // `pixels` and `palette` are reused between calls.
  decodeFrame() {
    if (this.next >= this.frameCount) return null;
    const i = this.next++;
    const b = this.bytes;
    let p = this.frameOffsets[i];
    const end = p + this.frameSizes[i];
    const ftype = this.frameTypes[i];
    let paletteChanged = false;
    if (ftype & 1) {
      const len = b[p] * 4;
      this.decodePalette(p + 1, p + len);
      p += len;
      paletteChanged = true;
    }
    const audio = [];
    for (let t = 0; t < 7; t++) {
      if (!(ftype & (2 << t))) continue;
      const len = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
      const info = this.audio.find((a) => a.track === t);
      if (info && len > 4) {
        const samples = info.packed
          ? decodeAudio(b, p + 4, p + len)
          : rawAudio(b, p + 4, p + len, info.bits);
        if (samples) audio.push({ track: t, samples, channels: info.channels, rate: info.rate });
      }
      p += len;
    }
    this.decodeVideo(p, end);
    return { index: i, pixels: this.pixels, palette: this.palette, paletteChanged, audio };
  }

  rewind() {
    this.next = 0;
  }

  /**
   * @param {number} p
   * @param {number} end
   */
  decodePalette(p, end) {
    const b = this.bytes;
    const old = this.palette.slice();
    const pal = this.palette;
    let sz = 0;
    while (sz < 256 && p < end) {
      const t = b[p++];
      if (t & 0x80) {
        sz += (t & 0x7f) + 1; // keep these entries
      } else if (t & 0x40) {
        const off = b[p++];
        let j = (t & 0x3f) + 1;
        let src = off;
        while (j-- && sz < 256) {
          pal[sz * 3] = old[src * 3];
          pal[sz * 3 + 1] = old[src * 3 + 1];
          pal[sz * 3 + 2] = old[src * 3 + 2];
          sz++;
          src++;
        }
      } else {
        pal[sz * 3] = PAL6[t & 0x3f];
        pal[sz * 3 + 1] = PAL6[b[p++] & 0x3f];
        pal[sz * 3 + 2] = PAL6[b[p++] & 0x3f];
        sz++;
      }
    }
  }

  /**
   * @param {number | undefined} start
   * @param {number} end
   */
  decodeVideo(start, end) {
    const br = new BitReader(this.bytes, start, end);
    const { mmap, mclr, full, type } = this;
    mmap.reset();
    mclr.reset();
    full.reset();
    type.reset();
    const w = this.width;
    const bw = w >> 2;
    const blocks = bw * (this.height >> 2);
    const out = this.pixels;
    let blk = 0;
    while (blk < blocks) {
      const t = type.get(br);
      let run = BLOCK_RUNS[(t >> 2) & 0x3f];
      switch (t & 3) {
        case 0: // two-colour block with a 16-bit mask
          while (run-- && blk < blocks) {
            const clr = mclr.get(br);
            let map = mmap.get(br);
            const hi = clr >> 8, lo = clr & 0xff;
            let o = ((blk / bw) | 0) * 4 * w + (blk % bw) * 4;
            for (let y = 0; y < 4; y++, o += w) {
              for (let x = 0; x < 4; x++, map >>= 1) out[o + x] = map & 1 ? hi : lo;
            }
            blk++;
          }
          break;
        case 1: {
          // full block
          let mode = 0;
          if (this.version === 4) {
            if (br.bit()) mode = 1;
            else if (br.bit()) mode = 2;
          }
          while (run-- && blk < blocks) {
            let o = ((blk / bw) | 0) * 4 * w + (blk % bw) * 4;
            if (mode === 0) {
              for (let y = 0; y < 4; y++, o += w) {
                let pix = full.get(br);
                out[o + 2] = pix & 0xff;
                out[o + 3] = pix >> 8;
                pix = full.get(br);
                out[o] = pix & 0xff;
                out[o + 1] = pix >> 8;
              }
            } else if (mode === 1) {
              // double: each 2x2 cell one colour
              for (let y = 0; y < 2; y++) {
                const pix = full.get(br);
                const a = pix & 0xff, c = pix >> 8;
                for (let r = 0; r < 2; r++, o += w) {
                  out[o] = out[o + 1] = a;
                  out[o + 2] = out[o + 3] = c;
                }
              }
            } else {
              // half: rows doubled
              for (let y = 0; y < 2; y++) {
                const p1 = full.get(br);
                const p2 = full.get(br);
                for (let r = 0; r < 2; r++, o += w) {
                  out[o] = p2 & 0xff;
                  out[o + 1] = p2 >> 8;
                  out[o + 2] = p1 & 0xff;
                  out[o + 3] = p1 >> 8;
                }
              }
            }
            blk++;
          }
          break;
        }
        case 2: // skip: keep the previous frame
          blk += Math.min(run, blocks - blk);
          break;
        case 3: {
          // solid fill
          const col = t >> 8;
          while (run-- && blk < blocks) {
            let o = ((blk / bw) | 0) * 4 * w + (blk % bw) * 4;
            for (let y = 0; y < 4; y++, o += w) out.fill(col, o, o + 4);
            blk++;
          }
          break;
        }
      }
    }
  }
}

// Smacker's packed audio: Huffman-coded deltas of PCM samples.
/**
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} end
 */
function decodeAudio(b, start, end) {
  const unpacked = b[start] | (b[start + 1] << 8) | (b[start + 2] << 16) | (b[start + 3] << 24);
  const br = new BitReader(b, start + 4, end);
  if (!br.bit()) return null;
  const stereo = br.bit();
  const sixteen = br.bit();
  const trees = [];
  for (let i = 0; i < 1 << (sixteen + stereo); i++) trees.push(readTree8(br));
  if (sixteen) {
    const count = unpacked >> 1;
    const out = new Int16Array(count);
    const pred = [0, 0];
    for (let c = stereo; c >= 0; c--) {
      const hi = br.bits(8);
      const lo = br.bits(8);
      pred[c] = (((hi << 8) | lo) << 16) >> 16;
    }
    let n = 0;
    for (let c = 0; c <= stereo; c++) out[n++] = pred[c];
    for (; n < count; n++) {
      const c = n & stereo;
      const lo = get8(br, trees[c * 2]);
      const hi = get8(br, trees[c * 2 + 1]);
      pred[c] = ((pred[c] + (((lo | (hi << 8)) << 16) >> 16)) << 16) >> 16;
      out[n] = pred[c];
    }
    return out;
  }
  const count = unpacked;
  const out = new Int16Array(count);
  const pred = [0, 0];
  for (let c = stereo; c >= 0; c--) pred[c] = br.bits(8);
  let n = 0;
  for (let c = 0; c <= stereo; c++) out[n++] = (pred[c] - 128) << 8;
  for (; n < count; n++) {
    const c = n & stereo;
    pred[c] = (pred[c] + get8(br, trees[c])) & 0xff;
    out[n] = (pred[c] - 128) << 8;
  }
  return out;
}

/**
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} end
 * @param {number} bits
 */
function rawAudio(b, start, end, bits) {
  if (bits === 16) {
    const n = (end - start) >> 1;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = (b[start + 2 * i] | (b[start + 2 * i + 1] << 8)) << 16 >> 16;
    return out;
  }
  const out = new Int16Array(end - start);
  for (let i = 0; i < out.length; i++) out[i] = (b[start + i] - 128) << 8;
  return out;
}
