// 4x4 matrices as Float32Array(16), RenderWare style: row vectors
// (v' = v * M), translation in the last row (elements 12, 13, 14).
// Angles are in degrees unless a name says otherwise.

export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// a * b (apply a first, then b).
export function mul(a, b, out = new Float32Array(16)) {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
  out.set(r);
  return out;
}

export function translation(x, y, z) {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x, y = x, z = x) {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

const RAD = Math.PI / 180;

// Rotation about one axis, for row vectors.
export function rotX(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD), m = identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}
export function rotY(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD), m = identity();
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}
export function rotZ(deg) {
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD), m = identity();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

// Object placement: scale, roll (Z), pitch (X), yaw (Y), then translate.
export function compose({ position = [0, 0, 0], yaw = 0, pitch = 0, roll = 0, scale = 1 } = {}) {
  const s = Array.isArray(scale) ? scaling(...scale) : scaling(scale);
  let m = mul(s, rotZ(roll));
  m = mul(m, rotX(pitch));
  m = mul(m, rotY(yaw));
  m[12] += position[0];
  m[13] += position[1];
  m[14] += position[2];
  return m;
}

// Inverse of a rigid transform (rotation + translation, any uniform scale).
export function invert(m) {
  const inv = new Float32Array(16);
  const a = m;
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity();
  det = 1 / det;
  inv[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  inv[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  inv[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  inv[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  inv[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  inv[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  inv[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  inv[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  inv[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  inv[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  inv[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  inv[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  inv[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  inv[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  inv[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  inv[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return inv;
}

export function transformPoint(m, x, y, z, out, o = 0) {
  out[o] = x * m[0] + y * m[4] + z * m[8] + m[12];
  out[o + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
  out[o + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
  return out;
}

export function transformDir(m, x, y, z, out, o = 0) {
  out[o] = x * m[0] + y * m[4] + z * m[8];
  out[o + 1] = x * m[1] + y * m[5] + z * m[9];
  out[o + 2] = x * m[2] + y * m[6] + z * m[10];
  return out;
}
