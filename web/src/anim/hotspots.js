// RENDER.R32's hotspot table (0x1002223c-0x10024eaa): collision volumes for
// buildings and other static objects. This holds the table and the simple
// accessors; the collision tests (CollideHotSpot, DeflectHotspot,
// FastmovingHotspotCollide, CheckPositionCollision, ObjectPositionCollision)
// belong with the battlefield's motion code and read `hotspots.table`.
// Record layout: docs/formats/animation.md.
import { SCRIPT_SCALE } from "./animation.js";

const ROUND_TYPE = 0x10; // a cylinder: radius in the id field, no footprint

// AllocHotspots zeroes every slot (0x10022030).
const blank = () => ({
  id: 0,
  pos: [0, 0, 0],
  height: 0,
  flags: 0,
  type: 0,
  params: [0, 0, 0, 0],
  dir: null,
  poseObj: 0,
  footprint: null,
});

export class Hotspots {
  constructor(engine) {
    this.engine = engine;
    this.table = []; // AllocHotspots(n) slots
    this.count = 0; // hotspots added since the last clear
  }

  get(n) {
    return n >= 1 && n <= this.table.length ? this.table[n - 1] : null;
  }

  externs() {
    const scale = SCRIPT_SCALE;
    return {
      AllocHotspots: (n) => {
        if (n < 1) return 0;
        this.table = Array.from({ length: n }, blank);
        this.count = 0;
        return 1;
      },
      DestroyAllHotspots: () => {
        this.table = [];
        this.count = 0;
        return 1;
      },
      ClearAllHotspots: () => {
        this.count = 0;
        return 1;
      },
      GetNumHotSpots: () => this.count,
      // AddHotSpot(model, x, y, z, height, flags, type, dx, dy, dz, p0, p1,
      // p2, p3, poseObj) 0x1002232a. The original also copies the footprint:
      // the vertices of the model's first clump (posed like poseObj when
      // given), moved to x/y/z, with each edge flagged by whether it lies on
      // the 12-unit grid. `footprint` is left to the collision code.
      AddHotSpot: (model, x, y, z, height, flags, type, dx, dy, dz, p0, p1, p2, p3, poseObj) => {
        if (this.count >= this.table.length) return 0;
        this.table[this.count++] = {
          id: model, // +0x00 (radius for type 0x10)
          pos: [x / scale, y / scale, z / scale], // +0x04
          height: height / scale, // +0x10
          flags, // +0x14
          type, // +0x18
          params: [p0, p1, p2, p3], // +0x1C..+0x28
          dir: type === 4 ? [dx / scale, dy / scale, dz / scale] : null, // +0x38, normalised in the original
          poseObj,
          footprint: null, // +0x2C vertices, +0x30 edge flags, +0x34 count
        };
        // The footprint is posed as poseObj is now (battlefield/collision.js).
        this.engine.collision?.footprint(this.table[this.count - 1]);
        return this.count;
      },
      GetHotSpotFlags: (n) => this.get(n)?.flags ?? 0,
      SetHotSpotFlags: (n, v) => (this.get(n) ? ((this.get(n).flags = v), 1) : 0),
      ClearHotSpotFlag: (n, v) => (this.get(n) ? ((this.get(n).flags &= ~v), 1) : 0),
      GetHotSpotHeight: (n) => (this.get(n) ? Math.trunc(this.get(n).height * scale) : 0),
      SetHotSpotHeight: (n, v) => (this.get(n) ? ((this.get(n).height = v / scale), 1) : 0),
      GetHotSpotType: (n) => this.get(n)?.type ?? -1,
      SetHotSpotType: (n, v) => (this.get(n) ? ((this.get(n).type = v), 1) : 0),
      SetHotSpotRadius: (n, v) => (this.get(n)?.type === ROUND_TYPE ? ((this.get(n).id = v), 1) : 0),
      SetHotSpotXYZ: (n, x, y, z) => {
        const h = this.get(n);
        if (h?.type !== ROUND_TYPE) return 0;
        h.pos = [x / scale, y / scale, z / scale];
        return 1;
      },
    };
  }
}
