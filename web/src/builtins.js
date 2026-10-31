// RTLIB32's own functions, callable from expressions with ids below 0xFA.
// The original is a 247-case switch at 0x10003fad. Each entry is
// fn(vm, args) -> int. G-Nome's scripts use 17 of the ids; names and
// arguments for all of them are in names.js.
/** @import { VM } from "./vm.js" */


// Type 11 resources are integer tables: a 60-byte header (u32 data pointer,
// u32 data bytes, ?, u32 resource id, u32 number of dimensions, u32 stride
// per dimension, ...) and then int32 data. Element = data[sum(stride*idx)].
/**
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @param {boolean} nocase
 */
function strcmp(a, b, nocase) {
  if (a === undefined || b === undefined) return 0;
  if (nocase) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {VM} vm
 * @param {number} id
 */
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

/**
 * @param {any} t
 * @param {any} idx
 */
function tableIndex(t, idx) {
  if (idx.length !== t.strides.length) return -1;
  let o = 0;
  for (let i = 0; i < idx.length; i++) o += t.strides[i] * idx[i];
  return o >= 0 && o < t.data.length ? o : -1;
}

/** @type {Record<number, Builtin>} */
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
  // 0xf2: drop a pack copied by CachePack (the campaign swaps pack sets
  // this way after a mission). See Engine.uncachePack.
  0xf2(vm, [n]) {
    vm.engine.uncachePack(n | 0);
    return 0;
  },
  // 0x03: absolute value (0x10004164)
  0x03(vm, [x]) {
    return Math.abs(x | 0) | 0;
  },
  // 0x0b: GetAngle(x1, y1, x2, y2) (0x1000487a -> 0x1002b1e4): the angle
  // from point 1 to point 2 in tenths of a degree, 0 along +y and 900 along
  // +x: trunc(atan2(dx, dy) x 1800 / 3.14159), plus 3600 when negative.
  0x0b(vm, [x1, y1, x2, y2]) {
    const a = Math.trunc(Math.atan2((x2 | 0) - (x1 | 0), (y2 | 0) - (y1 | 0)) * 572.9746936176986);
    return a < 0 ? a + 3600 : a;
  },
  // 0xd5 / 0xd6: lstrcmp / lstrcmpi of two strings (0x10004340, 0x100042b5).
  // A missing string returns nothing, which leaves 0.
  0xd5(vm, [a, b]) {
    return strcmp(vm.engine.getString(a), vm.engine.getString(b), false);
  },
  0xd6(vm, [a, b]) {
    return strcmp(vm.engine.getString(a), vm.engine.getString(b), true);
  },
  // 0xd7: string length (0x100043cb)
  0xd7(vm, [id]) {
    return vm.engine.getString(id)?.length ?? 0;
  },
  // 0x76 / 0x77: max / min (0x10005aae, 0x10005a3a)
  0x76(vm, [a, b]) {
    return Math.max(a | 0, b | 0);
  },
  0x77(vm, [a, b]) {
    return Math.min(a | 0, b | 0);
  },
  // 0xe7: the sprite engine's sync flag (SpriteSetSync, 0x100094e0). It
  // ties sprite updates to the frame clock in the original; the browser
  // always draws whole frames, so only remember it.
  0xe7(vm, [on]) {
    vm.engine.spriteSync = on & 0xff;
    return on;
  },
  // 0xc8: ScreenShake(dx, dy) (0x10005004 -> SpriteScreenShake): jolt the
  // stage by (dx, dy) and back (Display.shake). Script 1709 calls it twice,
  // (-3, -3) then (8, 8), when the player is hit by weapon kind 301 or 302.
  0xc8(vm, [dx, dy]) {
    vm.engine.display?.shake(dx | 0, dy | 0);
    return 0;
  },
  // 0xce: send a message to a sprite (type 20): sprite, message, args...
  0xce(vm, [id, ...msg]) {
    return vm.engine.sprites.send(id, msg);
  },
};

// Names for every builtin id live in names.js.
export { BUILTIN_NAMES } from "./names.js";
