// Type 12 sounds: a 32-byte header, then PCM or 7th Level ADPCM (IMA ADPCM
// with no block headers, low nibble first; stereo: left = low nibble).
// Ported from tools/gnome_extract.py; see docs/formats/g-nome-bin.md.

const STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const ADJUST = [-1, -1, -1, -1, 2, 4, 6, 8];

// Returns {channels, rate, priority, samples: Int16Array (interleaved)}.
// priority (header +8) is DSPlayWave's default voice priority; 0 in every
// G-NOME sound.
/**
 * @param {any} bytes
 */
export function decodeSound(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = dv.getUint32(0, true);
  const compressed = dv.getUint16(6, true);
  const channels = dv.getUint16(18, true);
  const rate = dv.getUint32(20, true);
  const bits = dv.getUint16(30, true);
  const priority = dv.getUint16(8, true);
  const body = bytes.subarray(32, 32 + size);
  if (compressed === 1) return { channels, rate, priority, samples: adpcm(body, channels) };
  if (bits === 16) {
    const n = body.length >> 1;
    const s = new Int16Array(n);
    const bdv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    for (let i = 0; i < n; i++) s[i] = bdv.getInt16(2 * i, true);
    return { channels, rate, priority, samples: s };
  }
  const s = new Int16Array(body.length);
  for (let i = 0; i < body.length; i++) s[i] = (body[i] - 128) << 8;
  return { channels, rate, priority, samples: s };
}

/**
 * @param {any} body
 * @param {number} channels
 */
function adpcm(body, channels) {
  const out = new Int16Array(body.length * 2);
  const sample = [0, 0], index = [0, 0];
  const step = (/** @type {number} */ ch, /** @type {number} */ nib) => {
    const st = STEPS[index[ch]];
    let d = st >> 3;
    if (nib & 4) d += st;
    if (nib & 2) d += st >> 1;
    if (nib & 1) d += st >> 2;
    let s = nib & 8 ? sample[ch] - d : sample[ch] + d;
    s = s < -32768 ? -32768 : s > 32767 ? 32767 : s;
    sample[ch] = s;
    const i = index[ch] + ADJUST[nib & 7];
    index[ch] = i < 0 ? 0 : i > 88 ? 88 : i;
    return s;
  };
  const right = channels === 2 ? 1 : 0;
  for (let i = 0, o = 0; i < body.length; i++) {
    const b = body[i];
    out[o++] = step(0, b & 0xf);
    out[o++] = step(right, b >> 4);
  }
  return out;
}
