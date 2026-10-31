// Open the engine in headless Chromium, let it run, save screenshots.
// Usage: node web/tools/shot.mjs <seconds> <out-prefix> [?query] [second:Key | second:click@x,y ...]
// A ?query argument is added to the page URL, e.g. ?mission=1.
// Serves the repo root on :8642; game files are read from game/g-nome/G-NOME.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright"); // ESM import misses global installs

const root = resolve(new URL("../..", import.meta.url).pathname);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const data = await readFile(join(root, p));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(8642);

const secs = Number(process.argv[2] || 5);
const out = process.argv[3] || "shot";
const query = process.argv.slice(4).find((s) => s.startsWith("?")) || "";
const keys = process.argv.slice(4).filter((s) => !s.startsWith("?")).map((s) => { const [t, k] = s.split(":"); return [Number(t), k]; });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
page.on("console", (m) => console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:8642/web/index.html?game=/game/g-nome/G-NOME/" + query.replace("?", "&"));
for (let t = 1; t <= secs; t++) {
  await page.waitForTimeout(1000);
  for (const [at, k] of keys) {
    if (at !== t) continue;
    if (k.startsWith("click@")) {
      // click@x,y in game pixels (640x480)
      const [x, y] = k.slice(6).split(",").map(Number);
      const box = await page.locator("#screen").boundingBox();
      await page.mouse.move(box.x + (x * box.width) / 640, box.y + (y * box.height) / 480);
      await page.waitForTimeout(300);
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await page.focus("#screen");
      await page.keyboard.press(k);
    }
  }
  if (t === secs || t % 5 === 0) await page.locator("#screen").screenshot({ path: `${out}-${t}s.png` });
}
console.log("cursor:", (await page.evaluate(() => document.getElementById("screen").style.cursor)).slice(0, 60));
console.log((await page.locator("#log").textContent()).split("\n").slice(-25).join("\n"));
await browser.close();
server.close();
