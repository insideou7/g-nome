// Weapons: recharge timers, putting a shot at its weapon mount, the
// projectile update, and stopping a projectile on what it hit. Written from
// the Ghidra decompile of RENDER.R32 (addresses in the comments). Spec:
// docs/combat.md.
//
// The game's scripts own the rules (damage, ammunition, energy); these
// natives only drive the per-tick loop and call back into scripts through a
// table of script ids the scripts pass as &G1861[0]:
//   [0] 2228 hit(proj, target, hotspot, ms)   returns 1 when handled
//   [1] 1689 destroy(proj, how)               how: 0 timed out, -1 hit ground
//   [2] 1683 weapon kind(proj)                (column 0 of table 1281)
//   [3] 1681 recharge(obj, weapon, ms, power) returns 1 while recharging
//   [4] 2055 drain energy(obj, -amount)
//   [5] 2058 overheat(obj, 1)
//   [6] 430  sector list(obj)                 used by Process_Sector_Collisions
import { normalize, scale } from "../battlefield/math.js";
import { UNIT } from "./host.js";

// Object properties (obj + 0xEC + 16 * slot + 4n).
export const P = {
  CLASS: 0,
  PITCH_CMD: 27, // a guided shot adds its pitch steps here
  TURN_AXIS: 37, // player steering of a guided shot: yaw (37), pitch (38)
  PITCH_AXIS: 38,
  MODEL: 39,
  OWNER: 42,
  LIFE: 44, // ms left
  HOMING: 45, // target a homing shot pursues
  WEAPONS: 66, // the object's copy of its weapon table
  WEAPON_COUNT: 67,
  CHARGE_LEFT: 94,
  CHARGE: 97,
  POWER: 98,
  OVERHEAT_TIMER: 112,
  RECOVERY: 118, // ms; counts down
};

const FLAMER = 304; // class whose texture cycles while it flies
const GUIDED = 7; // weapon kind the player steers (camera rides it)

/**
 * @param {any} host
 * @returns {Externs}
 */
export function projectileExterns(host) {
  const prop = (/** @type {number} */ id, /** @type {number} */ n) => host.prop(id, n);
  const cb = (/** @type {number} */ table, /** @type {number} */ n) => host.word(table, n);

  // FUN_1001ab5c and UpdateCollideCheck (0x100182d0), used only until the
  // battlefield's collision code provides UpdateCollideCheck: the nearest
  // object in `list` whose octagonal x/z distance is under the two radii
  // plus `ahead` (script units).
  const collideCheck = (/** @type {number} */ id, /** @type {number} */ list, /** @type {number} */ ahead, /** @type {any} */ ignore) => {
    const o = host.obj(id);
    const ids = list ? listItems(host, list) : [];
    let best = 64000, hit = 0;
    for (const t of ids) {
      if (!t || t === id || t === ignore) continue;
      const q = host.obj(t);
      if (!q) continue;
      const dx = Math.abs(o.pos[0] - q.pos[0]), dz = Math.abs(o.pos[2] - q.pos[2]);
      const d = dx + dz - Math.min(dx, dz) / 2;
      if (d < host.radius(t) + host.radius(id) + ahead / UNIT && d && d < best) {
        best = d;
        hit = t;
      }
    }
    return hit;
  };

  return {
    // Decrement_Recharge_Timers(obj, ms, callbacks) 0x100286ab: once per
    // tick for every unit. Counts the recovery timer down, lets each weapon
    // recharge (script [3], fed half the power), and for vehicles (class
    // >= 100) drains energy and runs the overheat timer while a weapon is
    // short of charge.
    Decrement_Recharge_Timers(id, ms, table) {
      if (!host.obj(id) && !host.r3d?.objects.get(id)) return 0;
      let t = prop(id, P.RECOVERY);
      if (t) host.setProp(id, P.RECOVERY, Math.max(0, t - ms));
      if (!prop(id, P.WEAPONS)) return 0;
      let power = prop(id, P.POWER);
      let charging = 0;
      for (let i = 0; i < prop(id, P.WEAPON_COUNT); i++) charging |= host.run(cb(table, 3), id, i, ms, (power / 2) | 0);
      if (prop(id, P.CLASS) < 100) return 0;
      if (charging) {
        power = (power / 2) | 0;
        host.run(cb(table, 4), id, -power);
      }
      if (prop(id, P.CHARGE) < prop(id, P.CHARGE_LEFT)) {
        const left = prop(id, P.OVERHEAT_TIMER) - Math.trunc((ms * power) / 1000);
        if (left < 0) {
          host.run(cb(table, 5), id, 1);
          host.setProp(id, P.OVERHEAT_TIMER, 2000);
        } else host.setProp(id, P.OVERHEAT_TIMER, left);
        power = (power / 2) | 0;
        host.run(cb(table, 4), id, -power);
      }
      return 0;
    },

    // Projectile_Update(proj, ms, guided, &fade, list, player, callbacks)
    // 0x10028170: a shot's update script (1734). `guided` is the shot the
    // player is steering (G1780), `list` the units it can hit (G1814).
    Projectile_Update(id, ms, guided, _fadePtr, list, player, table) {
      const o = host.obj(id);
      if (!o) return 0;
      const life = prop(id, P.LIFE);
      const homing = prop(id, P.HOMING);
      const owner = prop(id, P.OWNER);
      if (life < 1) {
        host.run(cb(table, 1), id, 0);
        return 0;
      }
      // The player steers a guided shot with the turn and pitch keys. (The
      // original also fades the screen in here when &fade is set and the
      // variable before it is 0, which never holds.)
      if (guided === id) {
        const axis = host.extern("SetTargetAxis");
        axis?.(id, prop(guided, P.TURN_AXIS), 2, ms);
        axis?.(id, prop(guided, P.PITCH_AXIS), 1, ms);
      }
      // A unit within reach of this tick's flight (looking ahead 2 ms per ms).
      const check = host.extern("UpdateCollideCheck");
      let hit = check ? check(id, list, ms * 2, owner) : collideCheck(id, list, ms * 2, owner);
      if (hit && host.run(cb(table, 0), id, hit, 0, ms)) return 0;
      if (!host.obj(id)) return 0;
      (host.extern("UpdatePosOrient") || (() => o.move(ms / 1000)))(id, ms);
      // Buildings and other hotspots in the shot's sector.
      let hotspot = 0;
      const sector = host.extern("Process_Sector_Collisions");
      if (sector) {
        // Two out-parameters (hotspot, object): words above the top of the
        // VM's stack, which no script frame reaches.
        const vm = host.vm;
        const cell = (vm.mem.length - 4) * 4;
        vm.store(cell, 0);
        vm.store(cell + 4, 0);
        const found = sector(id, cell, cell + 4, 1, table);
        if (found) {
          const spot = vm.load(cell), other = vm.load(cell + 4);
          const dist = host.extern("ObjectDistance");
          if (hit && dist && dist(id, hit) < dist(id, other)) {
            // the unit is nearer: keep it
          } else {
            hit = other;
            hotspot = spot;
            const clumps = host.extern("GetNumClumps");
            if (clumps && clumps(prop(hit, P.MODEL)) > 0) hotspot = 0;
          }
        }
      }
      let handled = 0;
      if (hit) handled = host.run(cb(table, 0), id, hit, hotspot, ms);
      if (hit && handled) return 0;
      if (!host.obj(id)) return 0;
      const ground = host.extern("UpdateGroundCheck");
      if (ground && !ground(id)) {
        host.run(cb(table, 1), id, -1);
        return 0;
      }
      if (prop(id, P.CLASS) === FLAMER) host.extern("UpdateAnimTexCycle")?.(id);
      host.setProp(id, P.LIFE, life - ms);
      if (homing) {
        let kind = 0;
        if (player === owner) kind = host.run(cb(table, 2), id);
        if (player !== owner || kind !== GUIDED) {
          const pursue = host.extern("MoveToPursue");
          if (pursue) {
            host.setProp(id, P.PITCH_CMD, prop(id, P.PITCH_CMD) + pursue(id, homing, 1, 0x38, ms));
            pursue(id, homing, 2, 0x38, ms);
          }
        }
      }
      // FUN_1001a6c5: fly along `at`, in 3D (clear flag 0x10).
      o.vel = scale(o.basis.at, o.speed);
      if (o.motion) o.motion.xz = false;
      return 0;
    },

    // StopProjectileObject(proj, target, hotspot) 0x10023f7f: move a shot
    // back onto the surface it hit, in x/z. Round targets (hotspot 0 or a
    // type 0x10 hotspot) use the target's radius along the line back to
    // where the shot came from; footprints use the crossing of that line
    // with the footprint's edges.
    StopProjectileObject(id, target, spot) {
      const o = host.obj(id), t = host.obj(target);
      if (!o || !t) return 0;
      const h = spot ? host.engine.hotspots?.get(spot) : null;
      if (!spot || h?.type === 0x10) {
        const d = normalize([o.last[0] - t.pos[0], 0, o.last[2] - t.pos[2]]);
        const r = host.radius(target);
        o.pos[0] = t.pos[0] + d[0] * r;
        o.pos[2] = t.pos[2] + d[2] * r;
      } else if (h?.footprint?.length) {
        const p = crossing(h.footprint, o.pos, o.last);
        if (p) {
          o.pos[0] = p[0];
          o.pos[2] = p[1];
        }
      }
      o.moved = true;
      return 0;
    },
  };
}

// The elements of a script list (ListCreate id).
/**
 * @param {any} host
 * @param {any} list
 */
export function listItems(host, list) {
  const len = host.extern("ListLength"), get = host.extern("ListGetElem");
  const n = len(list);
  const out = [];
  for (let i = 0; i < n; i++) out.push(get(list, i));
  return out;
}

// FUN_1001e3b9: where the segment a -> b crosses the polygon's edges in x/z
// (the crossing nearest b, where the shot came from), or null.
/**
 * @param {any} verts
 * @param {number[]} a
 * @param {number[]} b
 */
function crossing(verts, a, b) {
  let best = null, bestT = -1;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i], q = verts[(i + 1) % verts.length];
    const r = [b[0] - a[0], b[2] - a[2]], s = [q[0] - p[0], q[2] - p[2]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (!den) continue;
    const w = [p[0] - a[0], p[2] - a[2]];
    const t = (w[0] * s[1] - w[1] * s[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t > bestT) {
      bestT = t;
      best = [a[0] + r[0] * t, a[2] + r[1] * t];
    }
  }
  return best;
}
