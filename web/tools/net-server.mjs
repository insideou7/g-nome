// Web server for network play: serves the repo (like `python3 -m http.server`)
// and relays messages between players' browsers under /net/.
//
//   node web/tools/net-server.mjs [port]        (default 8000)
//
// Then every player opens http://<this machine>:<port>/web/ and picks
// "Internet (WebRTC)" in NETWORK. The relay only introduces the browsers
// and carries the WebRTC handshake; game traffic then goes browser to
// browser when WebRTC can connect, and through the relay when it can't.
//
// /net/hello            {"netgn": 1}
// /net/events?id=P      server-sent events for peer P: {from, msg} or {left}
// POST /net/send        {from, to, msg}; to null sends to every other peer
//
// The server never looks inside msg. Like the static server it serves the
// whole repo, including the git-ignored game/ folder used by ?game=, so only
// share the port with people you would lend the game to.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve, normalize } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const MAX_BODY = 1 << 20;

export function startNetServer(port = 8000, { quiet = false } = {}) {
  const peers = new Map(); // id -> response stream
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const push = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/net/hello") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ netgn: 1, peers: peers.size }));
    }
    if (url.pathname === "/net/events") {
      const id = url.searchParams.get("id");
      if (!id || peers.has(id)) {
        res.writeHead(400);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": hello\n\n");
      peers.set(id, res);
      log(`net: ${id} connected (${peers.size} peers)`);
      const keepalive = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepalive);
        peers.delete(id);
        log(`net: ${id} left (${peers.size} peers)`);
        for (const other of peers.values()) push(other, { left: id });
      });
      return;
    }
    if (url.pathname === "/net/send" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) break;
      }
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      let m;
      try {
        m = JSON.parse(body);
      } catch {
        return;
      }
      if (!peers.has(m.from)) return;
      // Re-encode only the parts we route on; msg passes through untouched.
      const out = { from: m.from, msg: m.msg };
      if (m.to === null || m.to === undefined) {
        for (const [id, r] of peers) if (id !== m.from) push(r, out);
      } else if (peers.has(m.to)) {
        push(peers.get(m.to), out);
      }
      return;
    }
    // Static files from the repo.
    try {
      let p = normalize(decodeURIComponent(url.pathname));
      if (p.endsWith("/")) p += "index.html";
      const file = join(root, p);
      if (!file.startsWith(root)) throw new Error("outside");
      const data = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8000);
  startNetServer(port);
  console.log(`G-Nome network server on http://localhost:${port}/web/`);
}
