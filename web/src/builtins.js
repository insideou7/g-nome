// RTLIB32's own functions, callable from expressions with ids below 0xFA.
// The original is a 247-case switch at 0x10003fad. Each entry is
// fn(vm, args) -> int. Only the 18 ids G-Nome's scripts use matter.

// Type 11 resources are integer tables: a 60-byte header (u32 data pointer,
// u32 data bytes, ?, u32 resource id, u32 number of dimensions, u32 stride
// per dimension, ...) and then int32 data. Element = data[sum(stride*idx)].
export function table(vm, id) {
  const e = vm.engine;
  let t = e.tables.get(id);
  if (!t) {
    if (e.bin.type(id) !== 11 && !e.dynamic.has(id)) return null;
    const raw = e.res(id);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const ndims = dv.getUint32(16, true);
    const strides = [];
    for (let i = 0; i < ndims; i++) strides.push(dv.getUint32(20 + 4 * i, true));
    const header = new Int32Array(15);
    for (let i = 0; i < 15; i++) header[i] = dv.getInt32(4 * i, true);
    const data = new Int32Array((raw.length - 60) >> 2);
    for (let i = 0; i < data.length; i++) data[i] = dv.getInt32(60 + 4 * i, true);
    t = { header, strides, data };
    e.tables.set(id, t);
  }
  return t;
}

function tableIndex(t, idx) {
  if (idx.length !== t.strides.length) return -1;
  let o = 0;
  for (let i = 0; i < idx.length; i++) o += t.strides[i] * idx[i];
  return o >= 0 && o < t.data.length ? o : -1;
}

export const BUILTINS = {
  // 0x19: copy a resource (ResCopyResource); returns the new id
  0x19(vm, [id]) {
    return vm.engine.copyResource(id);
  },
  // 0x22: delete a copy made by CopyResource (0x100109f1); 1 on success
  0x22(vm, [id]) {
    const e = vm.engine;
    if (!e.dynamic.has(id)) return 0;
    e.dynamic.delete(id);
    if (e.sprites.list.delete(id)) e.dirty = true;
    for (const p of e.plugins) p.onDeleteCopy?.(id);
    return 1;
  },
  // 0x44: table header field 10 + k (dimension sizes)
  0x44(vm, [id, k]) {
    const t = table(vm, id);
    return t ? t.header[10 + k] ?? 0 : 0;
  },
  // 0x52: table[i, j, ...]
  0x52(vm, [id, ...idx]) {
    const t = table(vm, id);
    if (!t) return 0;
    const o = tableIndex(t, idx);
    return o < 0 ? 0 : t.data[o];
  },
  // 0x99: random integer in [a, b]
  0x99(vm, [a, b]) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  },
  // 0xc1: table[i, j, ...] = value; returns 1 on success
  0xc1(vm, [id, value, ...idx]) {
    const t = table(vm, id);
    if (!t) return 0;
    const o = tableIndex(t, idx);
    if (o < 0) return 0;
    t.data[o] = value;
    return 1;
  },
  // 0xe1: is this sprite (type 20) visible
  0xe1(vm, [id]) {
    const s = vm.engine.sprites.list.get(id);
    return s && s.visible ? 1 : 0;
  },
  // 0xe2: sets a runtime byte flag (+0x94dd); its use is unknown
  0xe2(vm, [v]) {
    vm.engine.flag94dd = v & 0xff;
    return v;
  },
  // 0xe8: copy pack file n from the CD to the hard disk (0x1004776f).
  // Nothing to do: every pack is already in memory.
  0xe8() {
    return 0;
  },
  // 0xce: send a message to a sprite (type 20): sprite, message, args...
  0xce(vm, [id, ...msg]) {
    return vm.engine.sprites.send(id, msg);
  },
};

export const BUILTIN_NAMES = {
  0x19: "CopyResource",
  0x22: "DeleteCopy",
  0x44: "TableDim",
  0x52: "TableGet",
  0x99: "Random",
  0xc1: "TableSet",
  0xce: "SpriteMsg",
  0xe1: "SpriteIsVisible",
  0xe2: "SetFlag94dd",
  0xe8: "CachePack",
};
