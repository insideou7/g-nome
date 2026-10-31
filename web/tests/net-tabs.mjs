// Two players in headless Chromium: one hosts a network game, the other
// joins it, both through the real NETWORK menus. Needs the game in
// game/g-nome/G-NOME and Playwright:
//   NODE_PATH=$(npm root -g) node web/tests/net-tabs.mjs [out-prefix] [tabs|webrtc]
// "tabs" (default) uses the BroadcastChannel provider, "webrtc" the relay
// server and WebRTC. Saves screenshots of both pages at each step.
import { createRequire } from "node:module";
import { startNetServer } from "../tools/net-server.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

const out = process.argv[2] || "/tmp/net";
const mode = process.argv[3] || "tabs";
const port = 8643;
const server = startNetServer(port, { quiet: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
// One context: BroadcastChannel only reaches pages of the same profile.
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
const url = `http://localhost:${port}/web/index.html?game=/game/g-nome/G-NOME/`;

async function open(name) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`${name} pageerror:`, e.message));
  await page.goto(url);
  return { name, page };
}
const log = async (p) => (await p.page.locator("#log").textContent()).split("\n");
async function click(p, x, y) {
  const box = await p.page.locator("#screen").boundingBox();
  await p.page.mouse.move(box.x + (x * box.width) / 640, box.y + (y * box.height) / 480);
  await p.page.waitForTimeout(200);
  await p.page.mouse.down();
  await p.page.mouse.up();
  await p.page.waitForTimeout(400);
}
async function type(p, text) {
  await p.page.focus("#screen");
  for (const c of text) await p.page.keyboard.press(c);
  await p.page.keyboard.press("Enter");
  await p.page.waitForTimeout(500);
}
async function shot(p, step) {
  await p.page.locator("#screen").screenshot({ path: `${out}-${step}-${p.name}.png` });
}
async function waitLog(p, re, ms = 15000) {
  for (let t = 0; t < ms; t += 250) {
    if ((await log(p)).some((l) => re.test(l))) return true;
    await p.page.waitForTimeout(250);
  }
  throw new Error(`${p.name}: no log line like ${re}\n${(await log(p)).slice(-15).join("\n")}`);
}

const provider = mode === "webrtc" ? 1 : 0; // row in SELECT A PROVIDER
const host = await open("host");
const guest = await open("guest");
for (const p of [host, guest]) {
  await waitLog(p, /smacker: play dream/);
  await p.page.focus("#screen");
  await p.page.keyboard.press("Escape");
}
await host.page.waitForTimeout(3000);
// NETWORK > HOST > provider; game name; player name
await click(host, 240, 455);
await click(host, 41, 163);
await shot(host, "1-providers");
await click(host, 323, 145 + 21 * provider);
await waitLog(host, /netgn: using/);
await type(host, "ARENA");
await type(host, "ANN");
await shot(host, "2-settings");
// pick the first map; the right column then offers START
await click(host, 230, 75);
await click(host, 599, 165); // DONE
await waitLog(host, /created session "ARENA"/);
await host.page.waitForTimeout(1000);
await shot(host, "3-lobby");
// NETWORK > JOIN > provider; the session list fills within a few seconds
await click(guest, 240, 455);
await click(guest, 41, 207);
await click(guest, 323, 145 + 21 * provider);
await waitLog(guest, /netgn: using/);
await guest.page.waitForTimeout(3500);
await shot(guest, "4-sessions");
await click(guest, 393, 131); // the first game
await guest.page.waitForTimeout(1000);
await shot(guest, "5-joining");
await type(guest, "BOB");
await waitLog(guest, /joined session "ARENA"/);
await guest.page.waitForTimeout(3000);
await shot(guest, "6-lobby");
await shot(host, "6-lobby");
// chat from the guest: click the chat line, type, Enter
await click(guest, 340, 242);
await type(guest, "HI");
await host.page.waitForTimeout(1500);
await shot(host, "7-chat");
// both players: STATUS WAIT -> READY, then the host launches
for (const p of [guest, host]) await click(p, 497, 47);
await host.page.waitForTimeout(500);
await shot(host, "8-status");
await shot(guest, "8-status");
await click(host, 601, 165); // LAUNCH
for (const t of [3, 10, 20]) {
  await host.page.waitForTimeout(t === 3 ? 3000 : 8000);
  await shot(host, `9-launch${t}`);
  await shot(guest, `9-launch${t}`);
}

// In the battle: count the game messages each side sends and receives.
const traffic = (p) =>
  p.page.evaluate(async () => {
    const net = engine.plugins.find((x) => x.dp);
    const dp = net.dp;
    const sent = {}, got = {};
    const count = (o, k) => (o[k] = (o[k] || 0) + 1);
    const snd = dp.send.bind(dp), recv = dp.receive.bind(dp);
    dp.send = (f, t, b) => (count(sent, b[0]), snd(f, t, b));
    dp.receive = () => {
      const m = recv();
      if (m && m.bytes) count(got, m.bytes[0]);
      return m;
    };
    await new Promise((r) => setTimeout(r, 6000));
    Object.assign(dp, { send: snd, receive: recv });
    return { players: dp.players.size, sent, got, direct: net.bus.directLinks?.() ?? null };
  });
const [ht, gt] = await Promise.all([traffic(host), traffic(guest)]);
console.log("host", JSON.stringify(ht));
console.log("guest", JSON.stringify(gt));
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const fail = [];
if (ht.players !== 2 || gt.players !== 2) fail.push("both sides should see 2 players");
if (!total(gt.got)) fail.push("the guest received no game messages from the host");
if (!total(ht.got)) fail.push("the host received no game messages from the guest");
if (mode === "webrtc" && !(ht.direct && gt.direct)) fail.push("no WebRTC data channel opened");
await browser.close();
server.close();
if (fail.length) {
  console.log("FAIL:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log(`ok: hosted, joined, chatted, launched and exchanged game messages (${mode})`);
