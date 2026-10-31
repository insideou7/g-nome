// Where the browser shell gets the game files from. The player supplies their
// own copy: a folder (the CD, the install or just the G-NOME folder), or a
// .zip of one. Files are read locally and never uploaded.
//
// Every source becomes a list of entries { path, size, read() }. The game
// folder is the one that holds G-NOME.BIN; the engine sees only the files in
// it, by upper-case name. (The CD also carries demos of other 7th Level
// games, with their own RTLIB32.DLL and SMACKER.R32, so a flat name lookup
// across the whole tree would mix them up.)

const MARKER = "G-NOME.BIN";

export class NoGameError extends Error {
  constructor() {
    super(`${MARKER} not found. Pick the game CD, the G-NOME folder, or a .zip of either.`);
  }
}

// entries: [{ path: "a/b/FILE.EXT", size, read: async () => Uint8Array }]
export function gameFolder(entries) {
  let best = null;
  for (const e of entries) {
    const parts = e.path.split("/");
    if (parts[parts.length - 1].toUpperCase() !== MARKER) continue;
    const dir = parts.slice(0, -1).join("/").toUpperCase();
    // shallowest wins; a folder named G-NOME wins a tie
    const score = parts.length * 2 - (/(^|\/)G-NOME$/.test(dir) ? 1 : 0);
    if (!best || score < best.score) best = { dir, score };
  }
  if (!best) throw new NoGameError();
  const byName = new Map();
  for (const e of entries) {
    const i = e.path.lastIndexOf("/");
    if (e.path.slice(0, Math.max(i, 0)).toUpperCase() !== best.dir) continue;
    byName.set(e.path.slice(i + 1).toUpperCase(), e);
  }
  return {
    dir: best.dir,
    names: [...byName.keys()],
    has: (n) => byName.has(n.toUpperCase()),
    read: async (n) => {
      const e = byName.get(n.toUpperCase());
      if (!e) throw new Error(`missing ${n}`);
      return e.read();
    },
  };
}

const fileEntry = (path, file) => ({
  path,
  size: file.size,
  read: async () => new Uint8Array(await file.arrayBuffer()),
});

// <input type=file webkitdirectory> or a multi-file pick
export function fromFileList(files) {
  return gameFolder([...files].map((f) => fileEntry(f.webkitRelativePath || f.name, f)));
}

// File System Access API directory handle (Chromium). Can be remembered.
export async function fromDirectoryHandle(dir) {
  const entries = [];
  async function walk(h, prefix, depth) {
    for await (const child of h.values()) {
      const path = prefix + child.name;
      if (child.kind === "file") {
        entries.push({ path, size: 0, read: async () => new Uint8Array(await (await child.getFile()).arrayBuffer()) });
      } else if (depth < 4) {
        await walk(child, path + "/", depth + 1);
      }
    }
  }
  await walk(dir, "", 0);
  return gameFolder(entries);
}

// A dropped folder in browsers without getAsFileSystemHandle
export async function fromDroppedEntry(root) {
  const entries = [];
  const file = (e) => new Promise((ok, fail) => e.file(ok, fail));
  const list = (dir) =>
    new Promise((ok, fail) => {
      const reader = dir.createReader();
      const all = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) return ok(all);
          all.push(...batch);
          next();
        }, fail);
      next();
    });
  async function walk(e, depth) {
    if (e.isFile) entries.push(fileEntry(e.fullPath.replace(/^\//, ""), await file(e)));
    else if (depth < 5) for (const c of await list(e)) await walk(c, depth + 1);
  }
  await walk(root, 0);
  return gameFolder(entries);
}

// A .zip read in place: only the central directory is parsed up front, and
// each file is inflated when the engine asks for it.
export async function fromZip(blob) {
  return gameFolder(await zipEntries(blob));
}

export async function zipEntries(blob) {
  const bytes = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  // End of central directory: last 22 bytes plus up to 64 KB of comment.
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await bytes(tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const tv = new DataView(tail.buffer, tail.byteOffset);
  let count = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // Zip64: the locator sits just before the EOCD record.
    const loc = eocd - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new Error("unsupported zip");
    const rec = Number(tv.getBigUint64(loc + 8, true));
    const z = new DataView((await bytes(rec, rec + 56)).buffer);
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error("unsupported zip");
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  const cd = await bytes(cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset);
  const utf8 = new TextDecoder();
  const latin1 = new TextDecoder("latin1");
  const entries = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip directory");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    let csize = v.getUint32(p + 20, true);
    let size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    let local = v.getUint32(p + 42, true);
    const raw = cd.subarray(p + 46, p + 46 + nlen);
    const path = (flags & 0x800 ? utf8 : latin1).decode(raw).replace(/\\/g, "/");
    // Zip64 extra field holds whichever sizes overflowed, in this order.
    for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end; ) {
      const id = v.getUint16(x, true);
      const len = v.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) (size = Number(v.getBigUint64(q, true))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(v.getBigUint64(q, true))), (q += 8);
        if (local === 0xffffffff) local = Number(v.getBigUint64(q, true));
      }
      x += 4 + len;
    }
    p += 46 + nlen + xlen + clen;
    if (path.endsWith("/")) continue;
    entries.push({
      path,
      size,
      read: async () => {
        if (flags & 1) throw new Error(`${path} is encrypted`);
        const h = new DataView((await bytes(local, local + 30)).buffer);
        const start = local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        const data = blob.slice(start, start + csize);
        if (method === 0) return new Uint8Array(await data.arrayBuffer());
        if (method !== 8) throw new Error(`${path}: unsupported zip compression ${method}`);
        const out = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(out).arrayBuffer());
      },
    });
  }
  return entries;
}

// Remember a directory handle between visits (Chromium only). IndexedDB can
// store handles; localStorage cannot.
const DB = "g-nome";
function db() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
export async function rememberFolder(handle) {
  try {
    const d = await db();
    d.transaction("handles", "readwrite").objectStore("handles").put(handle, "game");
  } catch {
    /* private window or storage blocked */
  }
}
export async function rememberedFolder() {
  try {
    const d = await db();
    return await new Promise((ok) => {
      const r = d.transaction("handles").objectStore("handles").get("game");
      r.onsuccess = () => ok(r.result || null);
      r.onerror = () => ok(null);
    });
  } catch {
    return null;
  }
}
export async function forgetFolder() {
  try {
    const d = await db();
    d.transaction("handles", "readwrite").objectStore("handles").delete("game");
  } catch {}
}
