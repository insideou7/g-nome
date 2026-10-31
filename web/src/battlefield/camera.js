// The battlefield camera: RENDER.R32 keeps one RenderWare camera that is
// either placed in the world (SetCamera) or rides on an object's clump
// (AttachCamera). Script values are divided by 100 (positions) or are in
// hundredths of a degree (angles). See docs/battlefield.md.
import { add, scale, dot, cross, normalize, rotate, basisFromAt, sub } from "./math.js";

export class BattleCamera {
  constructor() {
    this.width = 640; // render size from Init3D
    this.height = 480;
    // RwSetCameraViewwindow: half extents of the view at distance 1. Init3D
    // sets 0.61 x 0.457 (about 63 x 49 degrees).
    this.viewwindow = [0.61, 0.457];
    this.near = 0.1;
    this.far = 30;
    // How much further than the scripts' far plane to draw (and to keep
    // the near levels of detail). 1 is the original; more keeps the ground
    // tiles and distant objects on screen further out. See drawFar.
    this.viewDistance = 1;
    this.background = [0, 0, 0];
    this.fog = null; // {depth, color: [r, g, b] 0..255}
    this.backdrop = null; // {bitmap: resource id, mode}
    this.crop = [0, 0, 0, 0]; // ViewportCrop: left, top, right, bottom margins
    this.pitch = 0; // SetCameraPitch / SetCameraYaw, degrees
    this.yaw = 0;
    this.attach = null; // {id, clump, offset: [x, y, z]}
    this.pos = [0, 0, 0];
    this.basis = basisFromAt([0, 0, 1]);
  }

  // SetCamera(x, y, z, ax, ay, az): position and look-at direction; up is
  // recomputed from the camera's right vector (RwCrossProduct(right, at)).
  /**
   * @param {number[]} pos
   * @param {number[]} at
   */
  place(pos, at) {
    this.attach = null;
    this.pos = pos;
    this.basis = basisFromAt(at, this.basis.up);
  }

  // The far plane used for drawing and for level-of-detail distances. The
  // scripts' own value (SetCameraClipping) stays in `far` for everything
  // else, such as sound volume by distance.
  get drawFar() {
    return this.far * this.viewDistance;
  }

  /**
   * @param {number} id
   * @param {number} clump
   * @param {number[]} offset
   */
  attachTo(id, clump, offset) {
    this.attach = { id, clump, offset };
  }

  // Camera position and orientation for a frame. `objectPose(id, clump)`
  // returns {pos, basis} of the object (interpolated when drawing).
  // Per-frame order is FUN_10006198: clump matrix, translate by the offset
  // in clump space, pan by yaw, then tilt by pitch.
  /**
   * @param {any} objectPose
   */
  pose(objectPose) {
    let pos = this.pos, basis = this.basis;
    if (this.attach) {
      const o = objectPose(this.attach.id, this.attach.clump);
      if (o) {
        const [dx, dy, dz] = this.attach.offset;
        const b = o.basis;
        pos = add(o.pos, add(add(scale(b.right, dx), scale(b.up, dy)), scale(b.at, dz)));
        basis = o.basis;
      }
    }
    let { at, up, right } = view(basis);
    // RwPanCamera turns about the camera's up vector, RwTiltCamera about its
    // right vector (which is -X for an unrotated camera).
    if (this.yaw) {
      at = rotate(at, up, this.yaw);
      right = normalize(cross(at, up));
    }
    if (this.pitch) {
      at = rotate(at, right, this.pitch);
      up = rotate(up, right, this.pitch);
    }
    return { pos, at, up, right };
  }

  // Viewport inside the 640x480 render target after ViewportCrop.
  viewport() {
    const [l, t, r, b] = this.crop;
    return { x: l, y: t, w: this.width - l - r, h: this.height - t - b };
  }

  // The whole render target. ViewportCrop (0x1000a8c2) shrinks the
  // viewwindow with the viewport (same pixels per unit) and sets
  // RwSetCameraViewOffset so the centre of projection stays at the centre
  // of the screen: the crop only clips the full-screen projection. So the
  // 3D view is drawn, projected and placed as if uncropped, and clipped to
  // viewport(). The cockpit crosshair at 320, 240 depends on it.
  screen() {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }
}

// RenderWare camera vectors from an object-style basis. The camera's "look
// right" is at x up, which for an unrotated camera (at = +Z) is -X: points
// with +X are drawn on the left.
/**
 * @param {any} basis
 */
function view(basis) {
  const at = normalize(basis.at);
  const up = normalize(basis.up);
  return { at, up, right: normalize(cross(at, up)) };
}

// Project a world point for a camera pose. Returns screen pixels relative to
// the viewport centre (the scripts' convention) and the depth along `at`.
/**
 * @param {any} pose
 * @param {number[]} vw
 * @param {any} vp
 * @param {number[]} p
 */
export function project(pose, vw, vp, p) {
  const d = sub(p, pose.pos);
  const z = dot(d, pose.at);
  if (z <= 1e-6) return { x: 0, y: 0, z, behind: true };
  const x = (dot(d, pose.right) / z / vw[0]) * (vp.w / 2);
  const y = -(dot(d, pose.up) / z / vw[1]) * (vp.h / 2);
  return { x, y, z, behind: false };
}

// The ray through a pixel (relative to the viewport centre), and where it
// meets the ground plane y = 0 (ScreenToXZ intersects with y = 0).
/**
 * @param {any} pose
 * @param {number[]} vw
 * @param {any} vp
 * @param {number} sx
 * @param {number} sy
 */
export function screenToGround(pose, vw, vp, sx, sy) {
  const dir = normalize(add(pose.at, add(scale(pose.right, (sx / (vp.w / 2)) * vw[0]), scale(pose.up, (-sy / (vp.h / 2)) * vw[1]))));
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = -pose.pos[1] / dir[1];
  if (t < 0) return null;
  return add(pose.pos, scale(dir, t));
}

// Horizontal scroll and horizon line of the panoramic backdrop, from
// FUN_10005bd1: the bitmap covers half a turn (2 x width per 360 degrees)
// and its bottom edge sits at the horizon, which moves 2.25 x half the view
// height per unit of at.y.
/**
 * @param {any} pose
 * @param {number} bitmapW
 * @param {number} bitmapH
 * @param {any} vp
 */
export function backdropPlacement(pose, bitmapW, bitmapH, vp) {
  const flat = normalize([pose.at[0], 0, pose.at[2]]);
  let a = Math.acos(Math.max(-1, Math.min(1, flat[2])));
  if (flat[0] < 0) a = 2 * Math.PI - a;
  const x = -Math.trunc((bitmapW * 2 * a) / (2 * Math.PI)) + 0;
  const horizon = Math.trunc(pose.at[1] * 2.25 * (vp.h >> 1) + (vp.h >> 1));
  return { x, y: horizon - bitmapH, horizon };
}

