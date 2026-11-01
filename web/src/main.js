// Browser shell: pick the game folder, start the engine, feed it input.
import { Engine, Ini } from "./engine.js";
import { Display } from "./display.js";
import { Audio } from "./audio.js";
import { vkFromEvent } from "./input.js";
import { DebugPanel } from "./debug-panel.js";
import { exportSaves, importSaves, scriptFilesOf } from "./saves.js";
import { fromDirectoryHandle, fromDroppedEntry, fromFileList, fromZip, rememberFolder, rememberedFolder, forgetFolder } from "./gamefiles.js";

/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const logEl = $("log");
/**
 * @param {string} m
 */
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

// Status line above the game screen
/**
 * @param {string} msg
 */
function status(msg, error = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", error);
}

// One INI for every run of the engine (and for save export/import before
// the game is loaded).
const ini = new Ini(loadIni());
ini.onChange = (/** @type {object} */ d) => {
  try {
    localStorage.setItem("g-nome.ini", JSON.stringify(d));
  } catch {}
};
/** @type {Engine | null} */
let running = null;

// Saved games live in this browser's storage; export them to a file so they
// survive clearing it, and import them back (src/saves.js).
$("export-saves").onclick = () => {
  const data = exportSaves(localStorage, ini);
  if (!data.saves.length) return status("No saved games to export yet (GAME > SAVE in the game makes one).");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = "g-nome-saves.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`Exported ${data.saves.length} saved game${data.saves.length === 1 ? "" : "s"}.`);
};
$("import-saves").onchange = async (/** @type {any} */ e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const n = importSaves(await file.text(), { storage: localStorage, ini, files: scriptFilesOf(running) });
    status(`Imported ${n} saved game${n === 1 ? "" : "s"}; they are on GAME > LOAD.`);
  } catch (err) {
    status(`Could not import ${file.name}: ${err.message}`, true);
  }
};

let started = false;
// Open a source of game files (see gamefiles.js) and start the engine.
/**
 * @param {any} load
 */
async function open(load) {
  if (started) return;
  let files;
  try {
    status("Looking for G-NOME.BIN...");
    files = await load();
  } catch (err) {
    status(err.message, true);
    return;
  }
  started = true;
  $("picker").classList.add("hidden");
  log(`game folder: ${files.dir || "(top level)"}`);
  // Count the big reads so a slow load shows progress.
  const total = files.names.filter((/** @type {string} */ n) => /^G-NOME\.\d{3}$/.test(n)).length;
  let done = 0;
  const read = files.read;
  files.read = async (/** @type {string} */ n) => {
    const r = await read(n);
    if (/^G-NOME\.\d{3}$/.test(n.toUpperCase())) status(`Loading game data ${++done}${total ? ` / ${total}` : ""}`);
    return r;
  };
  try {
    await start(files);
    status("");
  } catch (err) {
    status(`Could not start: ${err.message}`, true);
    log(err.stack || String(err));
  }
}

// Choose game folder: the File System Access API where there is one (it can
// be remembered for the next visit), otherwise a directory <input>.
$("pick-folder").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) return $("pick-dir").click();
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "g-nome", mode: "read" });
  } catch {
    return; // cancelled
  }
  open(async () => {
    const files = await fromDirectoryHandle(handle);
    await rememberFolder(handle);
    return files;
  });
});
// (Each input is cleared so picking the same thing again after an error
// still fires a change.)
$("pick-dir").addEventListener("change", (/** @type {any} */ ev) => {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const list = [...(input.files ?? [])];
  input.value = "";
  open(async () => fromFileList(list));
});
$("pick-zip").addEventListener("change", (/** @type {any} */ ev) => {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const f = input.files?.[0];
  input.value = "";
  if (f) open(() => fromZip(f));
});

// Continue with the folder picked last time (Chromium keeps the handle, but
// asks again for permission to read it).
rememberedFolder().then((handle) => {
  if (!handle || started) return;
  const b = $("resume");
  b.textContent = `Continue with "${handle.name}"`;
  b.classList.remove("hidden");
  b.addEventListener("click", async () => {
    try {
      if ((await handle.requestPermission({ mode: "read" })) !== "granted") return status("Permission to read the folder was refused.", true);
    } catch (err) {
      await forgetFolder();
      b.classList.add("hidden");
      return status("That folder is no longer available; choose it again.", true);
    }
    open(() => fromDirectoryHandle(handle));
  });
});

// Drop a folder or a .zip anywhere on the page.
const picker = $("picker");
document.addEventListener("dragover", (e) => {
  if (started) return;
  e.preventDefault();
  picker.classList.add("over");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) picker.classList.remove("over");
});
document.addEventListener("drop", async (e) => {
  if (started) return;
  e.preventDefault();
  picker.classList.remove("over");
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === "file");
  if (!item) return;
  // Both calls must happen before the first await, while the drop is live.
  const handleP = item.getAsFileSystemHandle?.();
  const entry = item.webkitGetAsEntry?.();
  const file = item.getAsFile();
  const handle = await handleP?.catch(() => null);
  if (handle?.kind === "directory") {
    return open(async () => {
      const files = await fromDirectoryHandle(handle);
      await rememberFolder(handle);
      return files;
    });
  }
  if (entry?.isDirectory) return open(() => fromDroppedEntry(entry));
  if (file && /\.zip$/i.test(file.name)) return open(() => fromZip(file));
  status("Drop the game folder or a .zip of it.", true);
});

// Development: ?game=<url of a folder with the game files> loads over HTTP.
const gameUrl = new URLSearchParams(location.search).get("game");
if (gameUrl) {
  const base = gameUrl.replace(/\/?$/, "/");
  // ?game=<url of a .zip> reads the zip over HTTP
  if (/\.zip$/i.test(gameUrl)) {
    open(async () => fromZip(await (await fetch(gameUrl)).blob()));
  } else {
    open(async () => ({
      dir: base,
      names: [],
      has: () => true,
      read: async (/** @type {string} */ n) => {
        for (const name of [n.toUpperCase(), n, n.toLowerCase()]) {
          const r = await fetch(base + name);
          if (r.ok) return new Uint8Array(await r.arrayBuffer());
        }
        throw new Error(`missing ${n}`);
      },
    }));
  }
}

// Every file is read once and kept, so a restart doesn't read them again.
/**
 * @param {any} files
 */
function cachedFiles(files) {
  const cache = new Map();
  return {
    ...files,
    read: (/** @type {string} */ n) => {
      const k = n.toUpperCase();
      if (!cache.has(k)) cache.set(k, files.read(n).catch((/** @type {any} */ e) => (cache.delete(k), Promise.reject(e))));
      return cache.get(k);
    },
  };
}

/**
 * @param {any} rawFiles
 */
async function start(rawFiles) {
  const files = cachedFiles(rawFiles);
  const display = new Display($("screen"));
  const canvas = $("screen");
  const cursorCss = new Map();
  /** @type {Engine} */
  let engine = /** @type {any} */ (null); // set by boot() before anything uses it
  /** @type {Audio | null} */
  let audio = null;
  /** @type {DebugPanel | null} */
  let panel = null;

  // A fresh engine on the same files and screen. Runs at start, and again
  // whenever the game quits (EXIT > Yes, the end of the campaign): the
  // browser has nowhere to quit to, so the game starts over from the
  // opening movie.
  async function boot() {
    if (audio) audio.ctx.close().catch(() => {}); // stops every sound of the last run
    audio = new Audio();
    display.fade = 1;
    display.unfreeze();
    display.underlay = null;
    display.overlay = null;
    // ?view=N draws the battlefield N times the original distance (1 = as
    // the original game).
    const view = Number(new URLSearchParams(location.search).get("view")) || undefined;
    engine = new Engine(files, { log, display, audio, ini, trace: $("trace").checked, viewDistance: view });
    log("loading game files...");
    await engine.init();
    engine.onCursor = (c) => {
      if (c === null) return void (canvas.style.cursor = "none");
      if (c === "default") return void (canvas.style.cursor = "default");
      if (!cursorCss.has(c)) {
        const cv = document.createElement("canvas");
        cv.width = c.width;
        cv.height = c.height;
        cv.getContext("2d")?.putImageData(new ImageData(c.rgba, c.width, c.height), 0, 0);
        cursorCss.set(c, `url(${cv.toDataURL()}) ${c.hotX} ${c.hotY}, default`);
      }
      canvas.style.cursor = cursorCss.get(c);
    };
    engine.boot();
    window.engine = running = engine; // for poking at it from the console
    if (panel) panel.attach(engine);
    else panel = new DebugPanel(engine, $("stage"), canvas);
  }
  await boot();

  // Development: ?mission=N starts campaign mission N after the boot, the way
  // the briefing's start button does (script 8317).
  const mission = Number(new URLSearchParams(location.search).get("mission"));
  if (mission) {
    engine.input.keyDown(0x1b); // skip the opening movie
    engine.input.keyUp(0x1b);
    setTimeout(() => engine.debug.startMission(mission, -1), 5000);
  }
  $("skip").disabled = false;
  $("skip").onclick = () => engine.input.keyDown(0x1b);
  canvas.focus();
  canvas.addEventListener("keydown", (/** @type {any} */ e) => {
    audio?.resume();
    const vk = vkFromEvent(e);
    if (vk && (engine.input.keyDown(vk, e.shiftKey, e.ctrlKey, e.repeat) || engine.world?.shown)) e.preventDefault();
    // WM_CHAR, for typing into texts (statement 0x2c)
    const ch = /** @type {Record<string, number>} */ ({ Enter: 13, Escape: 27, Backspace: 8 })[e.key] ?? (e.key.length === 1 && !e.ctrlKey ? e.key.charCodeAt(0) : 0);
    if (ch && engine.input.char(ch)) e.preventDefault();
  });
  // The window going to the background (WM_ACTIVATEAPP): RENDER.R32
  // suspends the battlefield unless SetBackProcess(1).
  document.addEventListener("visibilitychange", () => engine.world?.activate(document.visibilityState === "visible"));
  canvas.addEventListener("keyup", (/** @type {any} */ e) => engine.input.keyUp(vkFromEvent(e)));
  /** @returns {[number, number]} */
  const pos = (/** @type {any} */ e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) * 640) / r.width), Math.floor(((e.clientY - r.top) * 480) / r.height)];
  };
  canvas.addEventListener("pointerdown", (/** @type {any} */ e) => {
    audio?.resume();
    canvas.focus();
    canvas.setPointerCapture?.(e.pointerId); // keep slider drags going outside the canvas
    engine.mouseDown(...pos(e), e.button);
  });
  canvas.addEventListener("pointerup", (/** @type {any} */ e) => engine.mouseUp(...pos(e), e.button));
  canvas.addEventListener("pointermove", (/** @type {any} */ e) => engine.mouseMove(...pos(e)));
  let last = performance.now();
  let busy = false; // rebooting after a quit
  const step = async () => {
    if (busy) return;
    const t = performance.now();
    engine.tick(Math.min(100, t - last));
    panel?.frame(t);
    last = t;
    if (engine.quit) {
      busy = true;
      log("game quit: starting over");
      await boot();
      last = performance.now();
      busy = false;
    }
  };
  const frame = async () => {
    if (!document.hidden) await step();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Hidden tabs get no animation frames, and network play needs every
  // player's game to keep running: a worker's timer ticks it meanwhile.
  try {
    const src = URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 50)"], { type: "text/javascript" }));
    new Worker(src).onmessage = () => document.hidden && step();
  } catch {}
}
