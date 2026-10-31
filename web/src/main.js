// Browser shell: pick the game folder, start the engine, feed it input.
import { Engine, Ini } from "./engine.js";
import { Display } from "./display.js";
import { Audio } from "./audio.js";
import { vkFromEvent } from "./input.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(m) {
  logEl.textContent += m + "\n";
  if (logEl.textContent.length > 200000) logEl.textContent = logEl.textContent.slice(-100000);
  logEl.scrollTop = logEl.scrollHeight;
}

function loadIni() {
  try {
    return JSON.parse(localStorage.getItem("g-nome.ini") || "{}");
  } catch {
    return {};
  }
}

$("pick").addEventListener("change", (ev) => {
  const byName = new Map();
  for (const f of ev.target.files) byName.set(f.name.toUpperCase(), f);
  if (!byName.has("G-NOME.BIN")) return log("No G-NOME.BIN in that folder.");
  start({
    has: (n) => byName.has(n.toUpperCase()),
    read: async (n) => {
      const f = byName.get(n.toUpperCase());
      if (!f) throw new Error(`missing ${n}`);
      return new Uint8Array(await f.arrayBuffer());
    },
  });
});

// Development: ?game=<url of a folder with the game files> loads over HTTP.
const gameUrl = new URLSearchParams(location.search).get("game");
if (gameUrl) {
  const base = gameUrl.replace(/\/?$/, "/");
  start({
    has: () => true,
    read: async (n) => {
      for (const name of [n.toUpperCase(), n, n.toLowerCase()]) {
        const r = await fetch(base + name);
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
      }
      throw new Error(`missing ${n}`);
    },
  });
}

async function start(files) {
  const display = new Display($("screen"));
  const audio = new Audio();
  const ini = new Ini(loadIni());
  ini.onChange = (d) => {
    try {
      localStorage.setItem("g-nome.ini", JSON.stringify(d));
    } catch {}
  };
  const engine = new Engine(files, { log, display, audio, ini, trace: $("trace").checked });
  log("loading game files...");
  await engine.init();
  engine.boot();
  window.engine = engine; // for poking at it from the console
  $("skip").disabled = false;
  $("skip").onclick = () => engine.input.keyDown(0x1b);
  const canvas = $("screen");
  canvas.focus();
  canvas.addEventListener("keydown", (e) => {
    audio.resume();
    const vk = vkFromEvent(e);
    if (vk && engine.input.keyDown(vk, e.shiftKey, e.ctrlKey)) e.preventDefault();
  });
  canvas.addEventListener("keyup", (e) => engine.input.keyUp(vkFromEvent(e)));
  canvas.addEventListener("pointerdown", () => audio.resume());
  let last = performance.now();
  const frame = (t) => {
    engine.tick(Math.min(100, t - last));
    last = t;
    if (!engine.quit) requestAnimationFrame(frame);
    else log("game quit");
  };
  requestAnimationFrame(frame);
}
