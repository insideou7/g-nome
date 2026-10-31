// RENDER.R32's file externs (0x1000f230-0x1000f8ef), which wrap the Win32
// mmio API. Scripts use them for TRIVIA.IDX/.DAT and LABTEXT.DAT (read
// only), and for SGNOME<n>.SAV saves and GKEY<n>.MAP key maps (read and
// write). Spec: docs/formats/animation.md.
//
// Externs run synchronously, so the data files are loaded before the game
// starts (preload). Written files are kept in localStorage.

export const STORE = "g-nome.file.";
// Every file G-Nome's scripts open (names built with "GKEY%d.map" and
// "SGNOME%d.SAV" included).
const KNOWN = [
  "TRIVIA.IDX",
  "TRIVIA.DAT",
  "LABTEXT.DAT",
  ...[0, 1, 2, 3].map((i) => `GKEY${i}.MAP`),
  ...Array.from({ length: 20 }, (_, i) => `SGNOME${i}.SAV`),
];

// FileOpen flags
const F_READ = 1;
const F_WRITE = 2;
const F_CREATE_NEW = 0x10; // fail if the file exists
const F_CREATE = 0x20 | 0x100; // create or truncate
const F_MUST_EXIST = 0x40;
const F_EXISTS = 0x200; // only test whether the file exists

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class ScriptFiles {
  constructor(engine, storage = globalThis.localStorage) {
    this.engine = engine;
    this.storage = storage;
    this.data = new Map(); // upper-case name -> Uint8Array
    this.handles = new Map(); // handle -> { name, pos, bytes, dirty }
    this.nextHandle = 1;
  }

  // Load the game's small data files and any saved copies.
  async preload(files, names = KNOWN) {
    for (const name of names) {
      if (files.has && !files.has(name)) continue;
      try {
        this.data.set(name.toUpperCase(), await files.read(name));
      } catch {
        /* missing on this copy of the game */
      }
    }
    try {
      for (let i = 0; i < (this.storage?.length ?? 0); i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(STORE)) this.data.set(key.slice(STORE.length), fromBase64(this.storage.getItem(key) ?? ""));
      }
    } catch {
      /* storage blocked: saves last for this session only */
    }
  }

  save(name, bytes) {
    this.data.set(name, bytes);
    try {
      this.storage?.setItem(STORE + name, toBase64(bytes));
    } catch {
      /* storage full or blocked */
    }
  }

  open(nameId, flags) {
    const raw = this.engine.getString(nameId);
    if (!raw) return 0;
    const name = raw.replace(/^.*[\\/]/, "").toUpperCase();
    const exists = this.data.has(name);
    if (flags & F_EXISTS) return exists ? 1 : 0;
    if (flags & F_CREATE_NEW && exists) return 0;
    if (flags & F_MUST_EXIST && !exists) return 0;
    let bytes;
    if (flags & (F_CREATE | F_CREATE_NEW)) bytes = new Uint8Array(0);
    else if (exists) bytes = this.data.get(name);
    else return 0;
    const h = this.nextHandle++;
    this.handles.set(h, {
      name,
      pos: 0,
      bytes,
      dirty: !!(flags & (F_CREATE | F_CREATE_NEW)),
      write: !!(flags & F_WRITE),
    });
    return h;
  }

  close(h) {
    const f = this.handles.get(h);
    if (f?.dirty) this.save(f.name, f.bytes);
    this.handles.delete(h);
    return 0;
  }

  readBytes(f, n) {
    const out = f.bytes.subarray(f.pos, Math.min(f.bytes.length, f.pos + n));
    f.pos += out.length;
    return out;
  }

  writeBytes(f, b) {
    const end = f.pos + b.length;
    if (end > f.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(f.bytes);
      f.bytes = grown;
    }
    f.bytes.set(b, f.pos);
    f.pos = end;
    f.dirty = true;
  }

  // FileGetC / FileGetS / FileGetL: n items of `size` bytes into the int
  // array at addr. Returns how many were read.
  getItems(h, addr, n, size) {
    const f = this.handles.get(h);
    if (!f) return 0;
    const vm = this.engine.vm;
    let i = 0;
    for (; i < n; i++) {
      const b = this.readBytes(f, size);
      if (b.length < size) break;
      const v = size === 1 ? b[0] : size === 2 ? b[0] | (b[1] << 8) : b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
      vm.store(addr + 4 * i, v);
    }
    return i;
  }

  putItems(h, addr, n, size) {
    const f = this.handles.get(h);
    if (!f) return 0;
    const vm = this.engine.vm;
    for (let i = 0; i < n; i++) {
      const v = vm.load(addr + 4 * i);
      this.writeBytes(f, Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255).subarray(0, size));
    }
    return n;
  }

  // FileRead(h, string slot, n): up to 255 bytes into a string variable.
  read(h, strId, n) {
    const f = this.handles.get(h);
    if (!f) return 0;
    const b = this.readBytes(f, Math.min(n, 255));
    let s = "";
    for (const c of b) s += String.fromCharCode(c);
    this.engine.setString(strId, s.split("\0")[0]);
    return b.length;
  }

  write(h, strId, n) {
    const f = this.handles.get(h);
    if (!f) return 0;
    const s = (this.engine.getString(strId) ?? "").padEnd(Math.min(n, 255), "\0").slice(0, Math.min(n, 255));
    this.writeBytes(
      f,
      Uint8Array.from(s, (c) => c.charCodeAt(0) & 255),
    );
    return s.length;
  }

  // FileSeek(h, offset, origin 0 set / 1 current / 2 end); returns the new position
  seek(h, offset, origin) {
    const f = this.handles.get(h);
    if (!f) return -1;
    const base = origin === 1 ? f.pos : origin === 2 ? f.bytes.length : 0;
    f.pos = Math.max(0, base + offset);
    return f.pos;
  }

  externs() {
    return {
      FileOpen: (name, flags) => this.open(name, flags),
      FileClose: (h) => this.close(h),
      FileGetC: (h, addr, n) => this.getItems(h, addr, n, 1),
      FileGetS: (h, addr, n) => this.getItems(h, addr, n, 2),
      FileGetL: (h, addr, n) => this.getItems(h, addr, n, 4),
      FilePutC: (h, addr, n) => this.putItems(h, addr, n, 1),
      FilePutS: (h, addr, n) => this.putItems(h, addr, n, 2),
      FilePutL: (h, addr, n) => this.putItems(h, addr, n, 4),
      FileRead: (h, str, n) => this.read(h, str, n),
      FileWrite: (h, str, n) => this.write(h, str, n),
      FileSeek: (h, offset, origin) => this.seek(h, offset, origin),
      FileLength: (h) => this.handles.get(h)?.bytes.length ?? 0,
    };
  }
}
