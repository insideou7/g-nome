// The cockpit radar: RENDER.R32's RadarClear (0x10014866) and RadarDraw
// (0x10014c8e). See docs/battlefield.md, "Radar".
//
// Script 985 runs them every tick for the radar sprite of a cockpit (row
// type 21 of the cockpit's table, found by script 982):
//   RadarClear(sprite)
//   RadarDraw(unit, sprite, list, range, 101, 113, 77, target, 10,
//             class >= 200, property 24, waypoint)
//   MakeSpriteDraw(sprite)
// The original paints straight into the DirectDraw frame over the sprite's
// bounds; here the sprite carries an 8-bit buffer of its bounds (`radar`)
// that Sprites.draw shows under the sprite's own cels.

const ftol = Math.trunc; // __ftol truncates
const DEG = 57.29578;

// The colours, as Windows COLORREFs (0x00BBGGRR), matched to the nearest
// palette entry 10-245 (FUN_10014bb7) when the radar is cleared.
const COLOURS = {
  ally: 0x00ff00, // state +0xc8: the player's side
  enemy: 0x0000ff, // +0xcc: any other side
  empty: 0xffff00, // +0xd0: no pilot (property 77 is 0): cyan
  ring: 0x00ffff, // +0xd4: the ring around the target: yellow
  neutral: 0xffffff, // +0xd8: side 0, and the waypoint
  clear: 0x000000, // +0xdc: background
  grid: 0x808080, // +0xe0: view cone and range marks
};

// FUN_10014bb7: the palette entry 10-245 with the smallest sum of channel
// differences; the first one wins a tie.
export function nearestColour(palette, rgb) {
  const r = rgb & 0xff, g = (rgb >> 8) & 0xff, b = (rgb >> 16) & 0xff;
  let best = 0xff, dist = 1000;
  for (let i = 10; i < 0xf6; i++) {
    const d = Math.abs(palette[i * 3] - r) + Math.abs(palette[i * 3 + 1] - g) + Math.abs(palette[i * 3 + 2] - b);
    if (d < dist) {
      best = i;
      dist = d;
    }
  }
  return best;
}

// FUN_10024f90 draws lines with Abrash's run-length slices; a midpoint
// line from the upper end gives the same pixels for the radar's lines.
function line(buf, x0, y0, x1, y1, c) {
  if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  const dx = Math.abs(x1 - x0), dy = y1 - y0, sx = x1 < x0 ? -1 : 1;
  let err = dx - dy;
  for (;;) {
    buf.set(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += 1;
    }
  }
}

// Pixel patterns around (x, y) by radar symbol (property 101): 0 a hollow
// 3x3 square, 1 a dot, 2 a plus, 3 a cross; 4 (the target) a dot in a ring.
// 5 is not drawn.
const SHAPES = {
  0: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
  1: [[0, 0]],
  2: [[-1, 0], [0, -1], [0, 0], [0, 1], [1, 0]],
  3: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
};
// The waypoint: rows above and below, three pixels each.
const WAYPOINT = [[-1, -1], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 1]];

/** @param {any} engine */
export function radarExterns(engine) {
  const props = () => engine.render3d?.objects;
  const prop = (id, p) => props()?.getProperty(id, p) ?? 0;
  const colours = { ally: 0, enemy: 0, empty: 0, ring: 0, neutral: 0, clear: 0, grid: 0 };

  // The sprite's buffer, the size of its current bounds.
  const buffer = (spriteId) => {
    const s = engine.sprites?.get(spriteId);
    if (!s) return null;
    const r = engine.sprites.bounds(s);
    const w = r.right - r.left, h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return null;
    if (!s.radar || s.radar.w !== w || s.radar.h !== h) s.radar = { w, h, pixels: new Uint8Array(w * h) };
    const buf = s.radar;
    buf.set = (x, y, c) => {
      if (x >= 0 && y >= 0 && x < w && y < h) buf.pixels[y * w + x] = c;
    };
    return buf;
  };

  return {
    // RadarClear(sprite): fill the sprite's bounds with black. The colours
    // are matched to the palette here.
    RadarClear(sprite) {
      const pal = engine.display?.palette;
      if (pal) for (const k of Object.keys(COLOURS)) colours[k] = nearestColour(pal, COLOURS[k]);
      const buf = buffer(sprite);
      if (buf) buf.pixels.fill(colours.clear);
      if (engine.display) engine.display.dirty = true;
      return 0;
    },

    // RadarDraw(unit, sprite, list, range, shapeProp, sideProp, pilotProp,
    //   target, clumpProp, turret, twist, waypoint)
    RadarDraw(unit, sprite, list, range, shapeProp, sideProp, pilotProp, target, clumpProp, turret, twist, waypoint) {
      const world = engine.world;
      const me = world?.get(unit);
      const buf = buffer(sprite);
      if (!me || !buf) return 0;
      const { w, h } = buf;
      const scale = range / 100; // world units (state +0xb4 = 100.0)
      // Orientation: the unit's own, or with `turret` set the clump named by
      // property clumpProp (a turret), which also drops the twist.
      let { right, at } = me.basis;
      const clump = prop(unit, clumpProp);
      if (turret) {
        twist = 0;
        if (clump) ({ right, at } = world.pose(unit, clump, 1)?.basis ?? me.basis);
      }
      const norm = (v) => {
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
      };
      right = norm(right);
      at = norm(at);
      const cx = ftol(w / 2), cy = ftol(h / 2);

      // The view cone: two lines 33 degrees either side of the twist
      // (hundredths of a degree), shortened until both ends are above the
      // bottom edge.
      const a1 = (twist / 100 - 33) / DEG, a2 = (twist / 100 + 33) / DEG;
      const aspect = h / w;
      let r = cx + cy - ftol(Math.min(cx, cy) / 2);
      let x1, y1, x2, y2;
      do {
        x1 = cx - ftol(Math.sin(a1) * r);
        y1 = cy - ftol(Math.cos(a1) * r * aspect);
        x2 = cx - ftol(Math.sin(a2) * r);
        y2 = cy - ftol(Math.cos(a2) * r * aspect);
        r--;
      } while (y1 >= h || y2 >= h);
      line(buf, cx, cy, x1, y1, colours.grid);
      line(buf, cx, cy, x2, y2, colours.grid);
      // Range marks every 40 units ahead, while the range reaches them.
      const step = ftol((h * 20) / scale);
      let my = cy;
      for (const d of [40, 80, 120]) {
        if (scale < d) break;
        my -= step;
        line(buf, cx - 2, my, cx + 2, my, colours.grid);
      }

      // Forward is up, the unit's right vector to the left (RenderWare's
      // right points to the left of the view). Units outside the square
      // of side 2 x range are skipped, then anything off the buffer's
      // inner area.
      const mySide = prop(unit, sideProp);
      const place = (pos) => {
        const d = [pos[0] - me.pos[0], pos[1] - me.pos[1], pos[2] - me.pos[2]];
        if (!(Math.abs(d[0]) < scale) || !(Math.abs(d[2]) < scale)) return null;
        const px = ftol(cx + -((right[0] * d[0] + right[1] * d[1] + right[2] * d[2]) / scale) * cx);
        const py = ftol(cy + -((at[0] * d[0] + at[1] * d[1] + at[2] * d[2]) / scale) * cy);
        return px > 0 && px < w - 1 && py > 0 && py < h - 1 ? [px, py] : null;
      };
      const ids = engine.renderLists?.get(list) ?? [];
      for (const id of ids) {
        const o = id ? world.get(id) : null;
        if (!o) continue;
        const p = place(o.pos);
        if (!p) continue;
        const shape = id === target ? 4 : prop(id, shapeProp);
        if (shape === 5) continue;
        const side = prop(id, sideProp);
        const c = !prop(id, pilotProp) ? colours.empty : !side ? colours.neutral : side === mySide ? colours.ally : colours.enemy;
        if (shape === 4) {
          buf.set(p[0], p[1], c);
          for (const [dx, dy] of SHAPES[0]) buf.set(p[0] + dx, p[1] + dy, colours.ring);
          continue;
        }
        for (const [dx, dy] of SHAPES[shape] ?? []) buf.set(p[0] + dx, p[1] + dy, c);
      }
      const wp = waypoint ? world.get(waypoint) : null;
      const p = wp && place(wp.pos);
      if (p) for (const [dx, dy] of WAYPOINT) buf.set(p[0] + dx, p[1] + dy, colours.neutral);
      return 0;
    },
  };
}
