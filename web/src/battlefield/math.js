// Small vector helpers for the battlefield. Vectors are plain [x, y, z]
// arrays in RenderWare units (script units / 100).

export const DEG = Math.PI / 180;

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a) {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : [0, 0, 0];
}
export function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Rotate v about the unit axis by `deg` degrees, right-hand rule (as
// RwRotateMatrix does in RenderWare's right-handed space).
export function rotate(v, axis, deg) {
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

// An orientation is three orthonormal basis vectors, like RENDER.R32's
// object struct: right (+0x3c), up (+0x48) and at (+0x30, the forward
// direction). These are the rows of a RenderWare matrix, so the identity is
// right = +X, up = +Y, at = +Z. (RenderWare's camera looks along +Z with +X
// on the left of the screen: the world is right-handed.)
export function identityBasis() {
  return { right: [1, 0, 0], up: [0, 1, 0], at: [0, 0, 1] };
}

export function copyBasis(b) {
  return { right: b.right.slice(), up: b.up.slice(), at: b.at.slice() };
}

// Rebuild an orthonormal basis from a forward and an approximate up vector.
export function basisFromAt(at, upHint = [0, 1, 0]) {
  at = normalize(at);
  let right = cross(upHint, at);
  if (length(right) < 1e-6) right = cross([0, 0, 1], at);
  right = normalize(right);
  // right = up x at, so up = at x right
  const up = cross(at, right);
  return { right, up, at };
}

// Blend two orientations (for drawing between ticks) and re-orthonormalize.
export function lerpBasis(a, b, t) {
  return basisFromAt(lerp(a.at, b.at, t), lerp(a.up, b.up, t));
}

// Heading in hundredths of a degree, as the scripts use it: 0 faces +Z and
// 9000 faces +X (a positive yaw turns +Z towards +X).
export function headingOf(at) {
  let h = Math.atan2(at[0], at[2]) / DEG;
  if (h < 0) h += 360;
  return Math.round(h * 100);
}

// Basis for an absolute heading/pitch (degrees). Pitch > 0 looks down, which
// is what RwTiltCamera does with a positive angle in G-Nome's scripts.
export function basisFromAngles(yawDeg, pitchDeg = 0) {
  let b = identityBasis();
  if (yawDeg) b = { right: rotate(b.right, [0, 1, 0], yawDeg), up: b.up, at: rotate(b.at, [0, 1, 0], yawDeg) };
  if (pitchDeg) b = { right: b.right, up: rotate(b.up, b.right, pitchDeg), at: rotate(b.at, b.right, pitchDeg) };
  return b;
}

// 4x4 column-major matrix (WebGL layout) that places a basis at a position.
// RenderWare matrices are row-vector (row 0 = right, 1 = up, 2 = at, 3 =
// position); written column-major this is the same matrix.
export function modelMatrix(basis, pos, s = 1) {
  const { right: r, up: u, at: a } = basis;
  return new Float32Array([r[0] * s, r[1] * s, r[2] * s, 0, u[0] * s, u[1] * s, u[2] * s, 0, a[0] * s, a[1] * s, a[2] * s, 0, pos[0], pos[1], pos[2], 1]);
}
