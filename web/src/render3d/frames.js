// FRME (type 4) poses. Layout, from RENDER.R32 FUN_10006085:
//   "FRME", u32 clumps, u32 frames, u32 0,
//   then frames x clumps x 12 floats: a 4x3 matrix for row vectors,
//   translation in the last row.
// Applying frame f replaces the local matrix of the clump tagged i + 1 with
// matrix i. Clumps the model does not have are skipped.

export function frameCount(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(8, true);
}

// Returns a pose: an array indexed by clump index, holding a local matrix
// (Float32Array(16)) for each clump the frame moves.
export function poseFromFrame(model, bytes, frame) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(4, true), frames = dv.getUint32(8, true);
  const pose = [];
  if (!frames) return pose;
  const f = Math.max(0, Math.min(frames - 1, frame | 0));
  for (let i = 0; i < n; i++) {
    const ci = model.tagged[i + 1];
    if (ci === undefined) continue;
    const m = new Float32Array(16);
    const base = 16 + (f * n + i) * 48;
    if (base + 48 > bytes.length) break;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 3; c++) m[r * 4 + c] = dv.getFloat32(base + (r * 3 + c) * 4, true);
    m[15] = 1;
    pose[ci] = m;
  }
  return pose;
}
