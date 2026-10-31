// RENDER.R32's weapon and damage externs (docs/combat.md): projectiles and
// recharge (projectiles.js), blowing models apart (damage.js), animated
// textures, object sounds and HUD sprite hooks (effects.js).
import { CombatHost } from "./host.js";
import { projectileExterns } from "./projectiles.js";
import { damageExterns } from "./damage.js";
import { effectExterns } from "./effects.js";

export function combatExterns(engine) {
  const host = new CombatHost(engine);
  return { ...projectileExterns(host), ...damageExterns(host), ...effectExterns(host) };
}
