// The panel the DEBUG button opens, drawn as HTML over the OPTIONS screen's
// big black window, plus the FPS counter. Browser only; the actions live in
// debug.js.

import { CHEATS, DEV_KEYS } from "./debug.js";

const CSS = `
.dbg { position: absolute; left: 18.5%; top: 6%; width: 65%; height: 78%; background: #000; color: #0f0;
  font: 13px Arial, sans-serif; overflow: auto; padding: 10px 14px; box-sizing: border-box; display: none; }
.dbg.open { display: block; }
.dbg h2 { font-size: 18px; font-weight: normal; text-align: center; margin: 0 0 8px; }
.dbg h3 { font-size: 13px; color: #0c0; margin: 12px 0 4px; border-bottom: 1px solid #0a0; padding-bottom: 2px; }
.dbg button, .dbg select { background: #000; color: #0f0; border: 1px solid #0a0; font: inherit; padding: 2px 6px; cursor: pointer; }
.dbg button:hover { background: #030; }
.dbg button.on { background: #0a0; color: #000; }
.dbg .close { position: absolute; right: 8px; top: 6px; }
.dbg .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
.dbg table { border-collapse: collapse; width: 100%; }
.dbg td { padding: 2px 4px; vertical-align: top; }
.dbg td:first-child { white-space: nowrap; }
.dbg .keys { color: #ff0; white-space: nowrap; }
.dbg .note { color: #090; font-size: 12px; margin: 4px 0; }
.dbg .status { color: #ff0; min-height: 1.2em; }
.dbg-fps { position: absolute; left: 4px; top: 4px; color: #0f0; background: rgba(0,0,0,.6); font: 12px ui-monospace, monospace;
  padding: 1px 4px; pointer-events: none; display: none; }
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

export class DebugPanel {
  // stage: the element around the canvas (position: relative)
  constructor(engine, stage, canvas) {
    this.engine = engine;
    this.canvas = canvas;
    this.debug = engine.debug;
    stage.append(el("style", {}, CSS));
    this.fps = el("div", { class: "dbg-fps" });
    this.root = el("div", { class: "dbg" });
    stage.append(this.fps, this.root);
    this.showFps = load("g-nome.debug.fps", false);
    this.frames = [];
    this.fps.style.display = this.showFps ? "block" : "none";
    this.debug.vehicle = load("g-nome.debug.vehicle", -1);
    this.debug.onOpen = () => this.open();
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      e.stopPropagation();
    });
  }

  // Called every animation frame with the frame's time.
  frame(t) {
    if (this.root.classList.contains("open") && !this.debug.shown) this.close();
    if (!this.showFps) return;
    this.frames.push(t);
    while (this.frames.length && t - this.frames[0] > 1000) this.frames.shift();
    if (t - (this.lastFps || 0) > 250) {
      this.lastFps = t;
      const n = this.frames.length;
      const ms = n > 1 ? (this.frames[n - 1] - this.frames[0]) / (n - 1) : 0;
      this.fps.textContent = `${n} fps  ${ms.toFixed(1)} ms`;
    }
  }

  close() {
    this.root.classList.remove("open");
    this.canvas.focus();
  }

  async open() {
    const d = this.debug;
    const status = el("div", { class: "status" });
    const say = (m) => (status.textContent = m);

    // Level select
    const mission = el("select", {});
    for (const m of d.missions()) mission.append(el("option", { value: m.n }, `Mission ${m.n}`));
    mission.value = String(load("g-nome.debug.mission", 1));
    const vehicle = el("select", {}, el("option", { value: -1 }, "The mission's own"));
    for (const v of await d.vehicles()) vehicle.append(el("option", { value: v.row }, v.name));
    vehicle.value = String(d.vehicle);
    vehicle.addEventListener("change", () => {
      d.vehicle = Number(vehicle.value);
      save("g-nome.debug.vehicle", d.vehicle);
    });
    const start = el("button", {
      onclick: () => {
        save("g-nome.debug.mission", Number(mission.value));
        this.close();
        d.startMission(Number(mission.value), Number(vehicle.value));
      },
    }, "Start mission");

    // Display
    const fps = el("button", {
      class: this.showFps ? "on" : "",
      onclick: () => {
        this.showFps = !this.showFps;
        save("g-nome.debug.fps", this.showFps);
        fps.className = this.showFps ? "on" : "";
        fps.textContent = this.showFps ? "Show FPS: on" : "Show FPS: off";
        this.fps.style.display = this.showFps ? "block" : "none";
      },
    }, this.showFps ? "Show FPS: on" : "Show FPS: off");

    // Cheats
    const used = (this.used ||= new Set());
    const cheats = el("table");
    for (const c of CHEATS) {
      const b = el("button", {
        class: used.has(c.code) ? "on" : "",
        onclick: () => {
          d.cheat(c.code);
          used.add(c.code);
          b.className = "on";
          say(`"${c.code}" entered.${c.keys ? ` In a mission, press ${c.keys}.` : ""}`);
          if (c.leaves) this.close();
        },
      }, c.code);
      cheats.append(el("tr", {}, el("td", {}, b), el("td", {}, c.effect), el("td", { class: "keys" }, c.keys)));
    }
    const dev = el("button", {
      class: used.has("dev") ? "on" : "",
      onclick: () => {
        d.devKeys();
        used.add("dev");
        dev.className = "on";
        say("Developer keys on.");
      },
    }, "Enable developer keys");
    const devTable = el("table");
    for (const k of DEV_KEYS) devTable.append(el("tr", {}, el("td", { class: "keys" }, k.keys), el("td", {}, k.effect)));

    this.root.replaceChildren(
      el("button", { class: "close", onclick: () => this.close() }, "X"),
      el("h2", {}, "Debug"),
      status,
      el("h3", {}, "Level select"),
      el("div", { class: "row" }, mission, vehicle, start),
      el("div", { class: "note" }, "The vehicle choice also sticks for later starts from here. Personnel are on foot."),
      el("h3", {}, "Display"),
      el("div", { class: "row" }, fps),
      el("h3", {}, "Game cheats"),
      el("div", { class: "note" }, "The game's own codes (Shift+F1 on the main menu in the original). They last until you reload."),
      cheats,
      el("h3", {}, "Developer keys"),
      el("div", { class: "row" }, dev),
      devTable,
    );
    this.root.classList.add("open");
  }
}
