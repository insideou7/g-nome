// RENDER.R32's file externs (FileOpen 0x1000f3d0 and friends): Win32 mmio
// calls on files next to the game. The LAB reads LABTEXT.DAT with them and
// the network chat reads TRIVIA.IDX/.DAT. Saves also go through them.
//
// Reads must be synchronous like the original, so the game's data files are
// loaded at startup. Written files stay in memory for the session (saving
// them for good belongs with the save-game work).

// Data files the scripts open, read at startup when present.
export const DATA_FILES = ["LABTEXT.DAT", "TRIVIA.IDX", "TRIVIA.DAT"];

// FileOpen flags (from the decompile): 1 read, 2 write (both: read/write),
// 0x10 create (fail if it exists), 0x20 / 0x100 create or truncate,
// 0x40 open only if it exists, 0x80 read only, 0x200 just test existence.
export function installFileExterns(plugin) {
  const engine = plugin.engine;
  const files = new Map(); // upper-case name -> Uint8Array
  const handles = new Map(); // handle -> {name, data, pos, write}
  let next = 1;
  for (const name of DATA_FILES) {
    if (engine.files?.has?.(name) === false) continue;
    engine.files?.read(name).then((d) => files.set(name, d), () => {});
  }
  const h = (id) => handles.get(id);
  const vm = () => engine.vm;
  // Read `count` items of `size` bytes into consecutive script variables.
  const getN = (id, addr, count, size) => {
    const f = h(id);
    if (!f) return 0;
    let n = 0;
    for (; n < count && f.pos + size <= f.data.length; n++) {
      let v = 0;
      for (let k = size - 1; k >= 0; k--) v = (v << 8) | f.data[f.pos + k];
      f.pos += size;
      vm().store(addr + 4 * n, v | 0);
    }
    return n;
  };
  const putN = (id, addr, count, size) => {
    const f = h(id);
    if (!f || !f.write) return 0;
    for (let n = 0; n < count; n++) {
      const v = vm().load(addr + 4 * n);
      grow(f, f.pos + size);
      for (let k = 0; k < size; k++) f.data[f.pos + k] = (v >> (8 * k)) & 0xff;
      f.pos += size;
    }
    files.set(f.name, f.data.subarray(0, f.length));
    return count;
  };
  const grow = (f, end) => {
    if (end > f.data.length) {
      const d = new Uint8Array(Math.max(end, f.data.length * 2, 256));
      d.set(f.data);
      f.data = d;
    }
    f.length = Math.max(f.length, end);
  };

  Object.assign(plugin.externs, {
    FileOpen(nameId, flags) {
      const name = (engine.getString(nameId) || "").toUpperCase();
      if (!name) return 0;
      const exists = files.has(name);
      if (flags & 0x200) return exists ? 1 : 0;
      if ((flags & 0x10) && exists) return 0;
      const create = flags & (0x10 | 0x20 | 0x100);
      if (!exists && !create) return 0;
      const write = !!(flags & 2);
      let data = exists && !(flags & 0x20 || flags & 0x100) ? files.get(name) : new Uint8Array(0);
      if (write) data = Uint8Array.from(data);
      if (create && !exists) files.set(name, data);
      const id = next++;
      handles.set(id, { name, data, pos: 0, write, length: data.length });
      return id;
    },
    FileClose(id) {
      handles.delete(id);
      return 0;
    },
    // whence 0 start, 1 current, 2 end; returns the new position
    FileSeek(id, off, whence) {
      const f = h(id);
      if (!f) return -1;
      f.pos = Math.max(0, (whence === 1 ? f.pos : whence === 2 ? f.length : 0) + off);
      return f.pos;
    },
    FileLength(id) {
      return h(id)?.length ?? 0;
    },
    FileGetC: (id, addr, n) => getN(id, addr, n, 1),
    FileGetS: (id, addr, n) => getN(id, addr, n, 2),
    FileGetL: (id, addr, n) => getN(id, addr, n, 4),
    FilePutC: (id, addr, n) => putN(id, addr, n, 1),
    FilePutS: (id, addr, n) => putN(id, addr, n, 2),
    FilePutL: (id, addr, n) => putN(id, addr, n, 4),
    // Read up to 255 bytes into a string slot.
    FileRead(id, slot, n) {
      const f = h(id);
      if (!f) return 0;
      const len = Math.max(0, Math.min(n, 255, f.length - f.pos));
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(f.data[f.pos + i]);
      f.pos += len;
      engine.setString(slot, s.split("\0")[0]);
      return len;
    },
    FileWrite(id, slot, n) {
      const f = h(id);
      if (!f || !f.write) return 0;
      const s = engine.getString(slot) || "";
      const len = Math.min(n, 255);
      grow(f, f.pos + len);
      for (let i = 0; i < len; i++) f.data[f.pos + i] = i < s.length ? s.charCodeAt(i) : 0;
      f.pos += len;
      files.set(f.name, f.data.subarray(0, f.length));
      return len;
    },
  });
  return files;
}
