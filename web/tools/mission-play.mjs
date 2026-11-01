let __seed = Number(process.env.SEED || 1); Math.random = () => ((__seed = (__seed * 1103515245 + 12345) >>> 0) / 4294967296);
// Exploration tool for campaign missions: start mission N headless and run
// steps, logging mission script calls (8700-9299), objectives (8318), wins
// and losses. Usage: node web/tools/mission-play.mjs N step...
// Steps (60 ticks apart): goto:REF[,dx,dz] walkto:REF[,ticks] eject kill:REF
//   wait:T key:VK click:X,Y iff:N call:S(args) info:REF,... set:REF,prop,val
//   sprites sprite:ID rects binds:ACTION,... keys win
// REF = G73[1], G381 or a number. Env: SEED (random seed), Q=1 (quiet: no
// mission script log), W=ids (extra scripts to log), STACK=1 (show the
// running script stack), SPY=sprite (log moves of that sprite).
// The campaign bot (web/tests/campaign-bot.mjs) holds the solutions found.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { Engine } = await import("../src/engine.js");
const dir = process.env.GAME || "game/g-nome/G-NOME";
const names = new Map(readdirSync(dir).map((n) => [n.toUpperCase(), n]));
const files = { read: async (n) => new Uint8Array(readFileSync(join(dir, names.get(n.toUpperCase())))), has: (n) => names.has(n.toUpperCase()) };
const N = Number(process.argv[2]);
const acts = process.argv.slice(3);
const logs = [];
const engine = new Engine(files, { log: (m) => logs.push(m) });
await engine.init(); engine.boot();
const vm = engine.vm;
if (process.env.SPY) { const sp = engine.sprites.get(Number(process.env.SPY)); let x = sp.x; Object.defineProperty(sp, "x", { get: () => x, set: (v) => { if (v !== x) console.log("  SPY x", x, "->", v, "scriptstack", globalThis.STK?.join(">"), new Error().stack.split("\n").slice(2, 6).join(" | ")); x = v; } }); const oc = vm.callScript.bind(vm); } const m = engine.mission;
const P = (id, p) => engine.render3d.objects.getProperty(id, p);
const ref = (s) => { const r = /^G(\d+)(?:\[(\d+)\])?$/.exec(s); return r ? vm.getGlobal(Number(r[1]) + Number(r[2] || 0)) : Number(s); };
let tick = 0;
const watch = new Set((process.env.W||"").split(",").map(Number).concat([1778, 1780, 8318, 2245, 2246, 2247, 2248, 2243, 2240, 2241, 2249, 2130]));
const oCall = vm.callScript.bind(vm);
globalThis.STK = []; const oRun = vm.runScript.bind(vm); vm.runScript = (s) => { STK.push(s); try { return oRun(s); } finally { STK.pop(); } };
vm.callScript = (s, n, a) => { if (watch.has(s) || (s >= 8700 && s < 9300 && tick > 61 && !process.env.Q)) console.log(`  t${tick} script_${s}(${[...a].join(",")})` + (process.env.STACK ? "  <" + STK.join(">") : "")); return oCall(s, n, a); };
const step = async (t) => { for (let i = 0; i < t; i++, tick++) { engine.tick(1000 / 30); await new Promise((r) => setImmediate(r)); } };
await step(60);
for (const g of [2118, 2119]) vm.setGlobal(g, N); vm.setGlobal(982, 0); engine.run(8317);
await step(60);
const pos = (id) => engine.world.get(id)?.pos;
const show = () => { const s = m.status(); console.log(`  [t${tick}] player ${s.player} outcome ${s.outcome} result ${s.result} enemies ${s.enemies.length} G2119 ${vm.getGlobal(2119)}`); };
show();
for (const a of acts) {
  const [k, v] = a.split(/:(.*)/);
  const pl = vm.getGlobal(973);
  console.log(`> ${a}`);
  try {
    if (k === "eject") vm.callValue ? engine.callScript(1943, []) : 0;
    else if (k === "goto") { const [r, dx = 0, dz = 0] = v.split(","); const id = ref(r); const p = pos(id); const o = engine.world.get(pl); console.log(`  ${id} at ${p?.map(Math.round)} class ${P(id,0)}`); o.setPosition([p[0] + Number(dx), o.pos[1], p[2] + Number(dz)]); o.tickPos = o.pos.slice(); }
    else if (k === "walkto") { const [r, T = 300] = v.split(","); const id = ref(r); engine.input.keyDown(0x6b);
      for (let i = 0; i < Number(T); i++) { const me = engine.world.get(vm.getGlobal(973)); const p = pos(id); if (!me || !p) break;
        const dx = p[0] - me.pos[0], dz = p[2] - me.pos[2], d = Math.hypot(dx, dz); if (d < 0.3) break;
        me.basis = { at: [dx / d, 0, dz / d], up: [0, 1, 0], right: [-dz / d, 0, dx / d] }; me.tickBasis = me.basis;
        if (i % 3 == 0) engine.input.keyDown(0x6b, false, false, true); if (i % 30 == 0) console.log("   at", me.pos.map((q) => q.toFixed(1)).join(",")); await step(1); if (i % 60 == 0) 0; }
      engine.input.keyUp(0x6b); for (let i = 0; i < 20; i++) engine.input.keyDown(0x6d); engine.input.keyUp(0x6d);
      console.log(`  now ${vm.getGlobal(973)} at ${pos(vm.getGlobal(973))?.map(Math.round)}`); }
    else if (k === "sprite") { for (const sid of v.split(",").map(Number)) { const sp = engine.sprites.get?.(sid) ?? [...engine.sprites.visibleSorted()].find((q) => q.id === sid); console.log("  sprite", sid, sp ? JSON.stringify({ x: sp.x, y: sp.y, level: sp.level, cel: sp.cel, cels: sp.cels?.length, visible: sp.visible, hidden: sp.hidden, bounds: engine.sprites.bounds(sp) }) : "none"); } }
    else if (k === "sprites") { for (const sp of engine.sprites.visibleSorted()) { const b = engine.sprites.bounds(sp); console.log(`  spr ${sp.id} lvl ${sp.level} cel ${sp.cel}/${sp.cels.length} ${b.left},${b.top}..${b.right},${b.bottom}`); } }
    else if (k === "texts") { console.log("  texts", JSON.stringify(engine.texts?.list ? [...engine.texts.list.values()].filter((t) => t.visible).map((t) => t.text) : null)); }
    else if (k === "iff") { // dial the IFF code (octal digits) with U I O P
      const want = Number(v); const keys = [85, 73, 79, 80];
      for (let d = 0; d < 4; d++) { const sh = 9 - 3 * d; for (let n = 0; n < 8; n++) { const cur = P(vm.getGlobal(973), 113); if (((cur >> sh) & 7) === ((want >> sh) & 7)) break; engine.input.keyDown(keys[d]); await step(1); engine.input.keyUp(keys[d]); await step(1); } }
      console.log("  iff now", P(vm.getGlobal(973), 113)); }
    else if (k === "set") { const [r, prop, val] = v.split(","); engine.render3d.objects.setProperty(ref(r), Number(prop), ref(val)); }
    else if (k === "binds") { const c = engine.world.controls; const mp = c.map; console.log("  map", JSON.stringify({ actions: mp?.actions, events: mp?.events, column: mp?.column, mask: mp?.mask }));
      for (const ev of mp?.events || []) for (const r of c.rows(ev)) if (v.split(",").map(Number).includes(r[0])) console.log("   bind", ev, r.join(" ")); }
    else if (k === "keys") { for (const [vk, r] of engine.input.keys) console.log(`  key ${vk.toString(16)} ${JSON.stringify(r)}`); }
    else if (k === "key") { const vk = Number(v); engine.input.keyDown(vk); await step(2); engine.input.keyUp(vk); }
    else if (k === "rects") { console.log("  click", JSON.stringify(engine.clickRects)); }
    else if (k === "click") { const [x, y] = v.split(",").map(Number); engine.mouseMove(x, y); engine.mouseDown(x, y); await step(2); engine.mouseUp?.(x, y); }
    else if (k === "board") engine.callScript(2240, [ref(v), pl, 0]);
    else if (k === "kill") m.destroy(ref(v));
    else if (k === "wait") { await step(Number(v)); show(); continue; }
    else if (k === "win") m.win();
    else if (k === "info") { for (const r of v.split(",")) { const id = ref(r); console.log("  radius", engine.world.radiusOf(id), "speed", engine.world.get(id)?.speed); console.log(`  ${r} = ${id} class ${P(id,0)} side ${P(id,113)} p54 ${P(id,54)} p115 ${P(id,115)} pilot ${P(id,77)} p2 ${P(id,2)} pos ${pos(id)?.map(Math.round)}`); } }
    else if (k === "call") { const r = /(\d+)\((.*)\)/.exec(v); console.log("  ->", engine.callScript(Number(r[1]), r[2] ? r[2].split(",").map(ref) : [])); }
  } catch (e) { console.log("  ERR", e.message); }
  await step(60); show();
}
console.log("unknown", [...vm.unknown]); console.log(logs.filter((l) => !/^run pending|smacker|G-Nome:/.test(l)).slice(0, 20).join("\n"));
