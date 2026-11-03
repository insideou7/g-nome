// Aim assist (not in the original). G-Nome's shots fly straight along the
// unit's heading from the gun mounts, which sit to the side of the view
// line the crosshair marks, so a shot can pass beside a small target the
// crosshair is on: a soldier on foot is about 0.05 units wide, and a
// soldier's bolt leaves ~0.03 to the side. With aim assist on, a straight
// shot of the player's turns towards the part of the locked or selected
// target that the crosshair is on (or, when the crosshair is just beside
// it, the nearest part). Off, shots fly as in the original.
import { segmentHitsBox } from "./damage.js";

// How far beside the target the crosshair may be, in degrees, or within the
// target's own radius, and still count as "on" it.
export const ASSIST_DEGREES = 2.5;

/**
 * The direction a shot at `from` should take to hit the part of a target
 * the crosshair is on, or null to leave it alone. `view` is where the view
 * line starts (the unit's middle at the shot's height) and `at` its
 * direction (the shot's heading, a unit vector). `parts` are the target's
 * part boxes in world space.
 * @param {number[]} from
 * @param {number[]} view
 * @param {number[]} at
 * @param {{ lo: number[], hi: number[] }[]} parts
 * @param {number} radius
 * @returns {number[] | null}
 */
export function assistDirection(from, view, at, parts, radius) {
  const tan = Math.tan((ASSIST_DEGREES * Math.PI) / 180);
  let best = null, bestScore = Infinity;
  for (const p of parts) {
    const c = [(p.lo[0] + p.hi[0]) / 2, (p.lo[1] + p.hi[1]) / 2, (p.lo[2] + p.hi[2]) / 2];
    const d = [c[0] - view[0], c[1] - view[1], c[2] - view[2]];
    const along = d[0] * at[0] + d[1] * at[1] + d[2] * at[2];
    if (along <= 0) continue;
    const far = along * 2 + 1;
    const end = [view[0] + at[0] * far, view[1] + at[1] * far, view[2] + at[2] * far];
    // A part on the view line wins (the nearest one); else the part nearest
    // the line, if close enough.
    const off = Math.sqrt(Math.max(0, d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along));
    const score = segmentHitsBox(view, end, p) ? along - 1e6 : off > Math.max(radius, along * tan) ? Infinity : off;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  const d = [best[0] - from[0], best[1] - from[1], best[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-6) || d[0] * at[0] + d[1] * at[1] + d[2] * at[2] <= 0) return null;
  return [d[0] / len, d[1] / len, d[2] / len];
}
