// Handlers for fixed-size statements, as reversed from RTLIB32.DLL.
// Each takes (vm, bytes, dataview, pos) and returns 0 to stop the script.
// Operands are usually a u32 plus an "is a variable" flag byte.

const u32 = (dv, p) => dv.getUint32(p, true);
const i32 = (dv, p) => dv.getInt32(p, true);

export const STATEMENTS = {
  // 0x02: no-op
  0x02() {},
  // 0x6b: bind a key to a script (0x1000b38c). +2 key (0 = all keys),
  // +6 script, +0xc shift, +0xd ctrl, +0xe clear, +0xf disable, +0x10 on key up.
  0x6b(vm, b, dv, p) {
    vm.engine.input.bindKey(u32(dv, p + 2), u32(dv, p + 6), {
      shift: b[p + 0xc], ctrl: b[p + 0xd], clear: b[p + 0xe], disable: b[p + 0xf], up: b[p + 0x10],
    });
  },
  // 0x9c / 0xe4: read / write an INI value (0x100197fb). +2 variable,
  // +6 key string, +10 section string (0 = the game's section), +0xe flag,
  // +0xf 0 = integer, 1 = string. 0x9c reads into the variable.
  0x9c(vm, b, dv, p) {
    const e = vm.engine;
    const key = e.getString(u32(dv, p + 6));
    const section = u32(dv, p + 10) ? e.getString(u32(dv, p + 10)) : e.bin.title;
    const v = e.ini.get(section, key);
    if (v === undefined) return;
    if (b[p + 0xf]) e.setString(u32(dv, p + 2), v);
    else vm.setVar(u32(dv, p + 2), parseInt(v, 10) || 0);
  },
  0xe4(vm, b, dv, p) {
    const e = vm.engine;
    const key = e.getString(u32(dv, p + 6));
    const section = u32(dv, p + 10) ? e.getString(u32(dv, p + 10)) : e.bin.title;
    const v = b[p + 0xf] ? e.getString(u32(dv, p + 2)) : String(vm.getVar(u32(dv, p + 2)));
    e.ini.set(section, key, v);
  },
  // 0xb4: set the palette from a type 17 resource (0x10001b2e)
  0xb4(vm, b, dv, p) {
    vm.engine.setPaletteResource(vm.resolve(u32(dv, p + 2), b[p + 6]));
  },
  // 0xc0: string slot = format(src, args) (0x100186e8). +2 dest string id,
  // +6 format string id, +10 arg count, then 6-byte args at +0xe:
  // {u32 value, u8 is_number, u8 is_var}.
  0xc0(vm, b, dv, p) {
    const e = vm.engine;
    const fmt = e.getString(u32(dv, p + 6));
    const n = u32(dv, p + 10);
    if (!n) return void e.setString(u32(dv, p + 2), fmt);
    const args = [];
    for (let i = 0; i < n; i++) {
      const a = p + 0xe + 6 * i;
      const v = vm.resolve(u32(dv, a), b[a + 5]);
      args.push(b[a + 4] ? v : e.getString(v) ?? "<NULL>");
    }
    e.setString(u32(dv, p + 2), sprintf(fmt, args));
  },
  // 0x1b: set the cursor/input mode (0x100226c8)
  0x1b(vm, b) {
    vm.engine.cursorMode = b[2];
  },
  // 0x39: quit, or switch to the scene named by 0x3a
  0x39(vm) {
    vm.engine.post(0x10);
    return 0;
  },
  // 0x3c / 0x3d: fade the palette in / out over n% speed (0x1000c4d0)
  0x3c(vm, b, dv, p) {
    vm.engine.fade?.(true, i32(dv, p + 2));
  },
  0x3d(vm, b, dv, p) {
    vm.engine.fade?.(false, i32(dv, p + 2));
  },
  // 0x74: queue a script to run from the message loop (0x1001593b)
  0x74(vm, b, dv, p) {
    vm.engine.pendingScript = vm.resolve(u32(dv, p + 2), b[p + 6]);
    vm.engine.post(0x4c8);
  },
  // 0x75 / 0xdf: load / unload a resource (0x1001599b). Everything is in
  // memory already, so only remember it.
  0x75(vm, b, dv, p) {
    vm.engine.loaded.add(vm.resolve(u32(dv, p + 2), b[p + 6]));
  },
  0xdf(vm, b, dv, p) {
    vm.engine.loaded.delete(vm.resolve(u32(dv, p + 2), b[p + 6]));
  },
  // 0xa4: set the background (0x10001039). +2 mode: 0 bitmap resource at +6,
  // 1 solid colour index at +0x10, 2 none, 3 resource of type 22.
  0xa4(vm, b, dv, p) {
    const mode = u32(dv, p + 2);
    const a = vm.resolve(u32(dv, p + 6), b[p + 0x16]);
    const c = vm.resolve(u32(dv, p + 10), b[p + 0x17]);
    vm.engine.setBackground?.(mode, a, c, b[p + 0x10]);
  },
};

// Enough of wvsprintf for the game's format strings.
export function sprintf(fmt, args) {
  let i = 0;
  return fmt.replace(/%(-?)(0?)(\d*)([dius%xX])/g, (m, left, zero, width, c) => {
    if (c === "%") return "%";
    let v = args[i++];
    if (c === "x" || c === "X") v = (v >>> 0).toString(16);
    else if (c === "u") v = String(v >>> 0);
    else if (c !== "s") v = String(v | 0);
    if (c === "X") v = v.toUpperCase();
    const w = Number(width || 0);
    return left ? v.padEnd(w) : v.padStart(w, zero ? "0" : " ");
  });
}
