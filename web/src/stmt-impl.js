// Handlers for fixed-size statements, as reversed from RTLIB32.DLL.
// Each takes (vm, bytes, dataview, pos) and returns 0 to stop the script.
// Operands are usually a u32 plus an "is a variable" flag byte.

const u32 = (dv, p) => dv.getUint32(p, true);
const i32 = (dv, p) => dv.getInt32(p, true);

// Four rectangle coordinates at p, with "is a variable" bits in `mask`,
// normalised so left <= right and top <= bottom (0x10014fe3).
function rect(vm, dv, p, mask) {
  const v = [0, 1, 2, 3].map((i) => vm.resolve(u32(dv, p + 4 * i), mask & (1 << i)) | 0);
  return { l: Math.min(v[0], v[2]), t: Math.min(v[1], v[3]), r: Math.max(v[0], v[2]), b: Math.max(v[1], v[3]) };
}

export const STATEMENTS = {
  // 0x0e: hover region (0x10014f69 -> 0x1000b9d8). +2 rect (variable
  // bits at +0x2c), +0x12 enter script, +0x16 its arg, +0x1a leave script,
  // +0x1e its arg (variable flags at +0x28..+0x2b), +0x22 sprite (the region
  // is that sprite's shape), +0x26 remove all. No enter script removes it.
  0x0e(vm, b, dv, p) {
    const e = vm.engine;
    if (b[p + 0x26]) {
      e.hoverRects = [];
      e.hover = -1;
      return;
    }
    const r = rect(vm, dv, p + 2, b[p + 0x2c]);
    const sprite = u32(dv, p + 0x22);
    const i = e.hoverRects.findIndex((h) => (sprite ? h.sprite === sprite : h.l === r.l && h.t === r.t && h.r === r.r && h.b === r.b));
    const enter = vm.resolve(u32(dv, p + 0x12), b[p + 0x28]);
    if (!enter) {
      if (i >= 0) e.hoverRects.splice(i, 1);
      if (e.hover >= e.hoverRects.length) e.hover = -1;
      return;
    }
    const h = {
      ...r, sprite, enter,
      enterArg: vm.resolve(i32(dv, p + 0x16), b[p + 0x29]),
      leave: vm.resolve(u32(dv, p + 0x1a), b[p + 0x2a]),
      leaveArg: vm.resolve(i32(dv, p + 0x1e), b[p + 0x2b]),
    };
    if (i >= 0) e.hoverRects[i] = h;
    else e.hoverRects.push(h);
  },
  // 0x10: click handler (0x100150c7 -> 0x1000a5f0). +2 sprite (0 = the
  // rectangle at +0xe, variable bits at +0x24), +6 script (0 removes),
  // +10 arg (variable flags +0x21..+0x23), +0x1e global switch,
  // +0x1f / +0x20 enable / disable.
  0x10(vm, b, dv, p) {
    const e = vm.engine;
    const sprite = vm.resolve(u32(dv, p + 2), b[p + 0x21]);
    const script = vm.resolve(u32(dv, p + 6), b[p + 0x22]);
    const arg = vm.resolve(i32(dv, p + 10), b[p + 0x23]);
    // Global form (0x1000a7ea / 0x1000a704): applies to every click region
    // and every sprite's click handler. +0x20 turns them all off, +0x1f
    // back on; with neither, every handler gets the script at +6, and
    // script 0 removes all regions and clears the sprite handlers. The
    // EXIT (Y/N) prompt (script 8312) uses it to make itself modal.
    if (b[p + 0x1e]) {
      const off = b[p + 0x20] ? true : b[p + 0x1f] ? false : null;
      if (off !== null) {
        for (const r of e.clickRects) r.off = off;
        for (const sp of e.sprites.list.values()) sp.clickOff = off;
      } else if (!script) {
        e.clickRects.length = 0;
        for (const sp of e.sprites.list.values()) sp.click = null;
      } else {
        for (const r of e.clickRects) r.script = script;
        // The original sets it on every sprite; only sprites that already
        // take clicks are retargeted here, so others stay click-through.
        for (const sp of e.sprites.list.values()) if (sp.click) sp.click.script = script;
      }
      return;
    }
    if (sprite) {
      const s = e.sprites.get(sprite);
      if (!s) return;
      if (b[p + 0x20]) s.clickOff = true;
      else if (b[p + 0x1f]) s.clickOff = false;
      else s.click = script ? { script, arg } : null;
      return;
    }
    const r = rect(vm, dv, p + 0xe, b[p + 0x24]);
    const i = e.clickRects.findIndex((c) => c.l === r.l && c.t === r.t && c.r === r.r && c.b === r.b);
    if (b[p + 0x20] || b[p + 0x1f]) {
      if (i >= 0) e.clickRects[i].off = !!b[p + 0x20];
      return;
    }
    if (!script) {
      if (i >= 0) e.clickRects.splice(i, 1);
      return;
    }
    const c = { ...r, script, arg, off: false };
    if (i >= 0) e.clickRects[i] = c;
    else e.clickRects.push(c);
  },
  // 0x3f: read a sprite's bounds into four variables (0x10017749).
  // +2 sprite (flag +6), +8/+0xc/+0x10/+0x14 variables left/top/right/bottom.
  0x3f(vm, b, dv, p) {
    const s = vm.engine.sprites.get(vm.resolve(u32(dv, p + 2), b[p + 6]));
    if (!s) return;
    const r = vm.engine.sprites.bounds(s);
    vm.setVar(u32(dv, p + 8), r.left);
    vm.setVar(u32(dv, p + 0xc), r.top);
    vm.setVar(u32(dv, p + 0x10), r.right);
    vm.setVar(u32(dv, p + 0x14), r.bottom);
  },
  // 0x4d: sprite position into two variables (0x100154f0 -> 0x10017bb6).
  // +2 sprite (flag +6), +8 / +0xc variables x / y.
  0x4d(vm, b, dv, p) {
    const s = vm.engine.sprites.get(vm.resolve(u32(dv, p + 2), b[p + 6]));
    vm.setVar(u32(dv, p + 8), s ? s.x : 0);
    vm.setVar(u32(dv, p + 0xc), s ? s.y : 0);
  },
  // 0x71: drawing level of a sprite (0x100158e7 -> 0x100181b4).
  // +2 sprite, +6 level, variable flags +10, +11.
  0x71(vm, b, dv, p) {
    const s = vm.engine.sprites.get(vm.resolve(u32(dv, p + 2), b[p + 10]));
    if (!s) return;
    s.level = vm.resolve(u32(dv, p + 6), b[p + 11]) | 0;
    vm.engine.dirty = true;
  },
  // 0xb8: move a sprite (0x10016021 -> 0x1001866a). +2 sprite, +6 x,
  // +10 y, variable flags +0xe, +0xf, +0x10. 0 if the sprite is missing.
  0xb8(vm, b, dv, p) {
    const s = vm.engine.sprites.get(vm.resolve(u32(dv, p + 2), b[p + 0xe]));
    if (!s) return 0;
    s.x = vm.resolve(i32(dv, p + 6), b[p + 0xf]) | 0;
    s.y = vm.resolve(i32(dv, p + 10), b[p + 0x10]) | 0;
    vm.engine.dirty = true;
  },
  // 0x8e / 0xd2: play / stop a CD audio track (AudioPlayCDTrack,
  // AudioStopCD). The music is red book audio on the CD; it plays only if
  // the player supplies ripped tracks (music.js).
  0x8e(vm, b, dv, p) {
    vm.engine.music.play(b[p + 2]);
  },
  0xd2(vm) {
    vm.engine.music.stop();
  },
  // 0x6d: stop timer +2 (+6 set: stop all) (0x10021894).
  0x6d(vm, b, dv, p) {
    const t = vm.engine.timers;
    if (b[p + 6]) t.clear();
    else t.delete(i32(dv, p + 2));
  },
  // 0xc4: start timer +2: run script +6 (flag +0xf) after +10 ms (flags
  // +0xe and +0x10), again every period if +0x11 (0x100161cf, 0x100219bc).
  0xc4(vm, b, dv, p) {
    const e = vm.engine;
    const script = vm.resolve(u32(dv, p + 6), b[p + 0xf]);
    const ms = b[p + 0xe] ? vm.resolve(i32(dv, p + 10), b[p + 0x10]) : i32(dv, p + 10);
    e.timers.set(i32(dv, p + 2), { script, ms, due: e.time + ms, repeat: !!b[p + 0x11] });
  },
  // 0xd9: run statement number var(+10) of the type 14 list +2
  // (0x1001918d). Past the end: run script +6 if +0xe. +0xf: advance the
  // variable, wrapping to 0.
  0xd9(vm, b, dv, p) {
    const e = vm.engine;
    const list = vm.resolve(u32(dv, p + 2), 0);
    const stmts = e.statementList(list);
    if (!stmts.length) return 0;
    const v = u32(dv, p + 10);
    const n = vm.getVar(v) >>> 0;
    let ok = 1;
    if (n < stmts.length) ok = e.runStatement(stmts[n]);
    else if (b[p + 0xe]) ok = vm.runScript(u32(dv, p + 6));
    if (b[p + 0xf]) vm.setVar(v, n + 1 >= stmts.length ? 0 : n + 1);
    return ok;
  },
  // 0xb9: give sprite +2 the queue +6 (flags +0xb, +0xc), hide first if
  // +10 (0x10015ef7 -> 0x10018f65).
  0xb9(vm, b, dv, p) {
    const sprite = vm.resolve(u32(dv, p + 2), b[p + 0xb]);
    const queue = vm.resolve(u32(dv, p + 6), b[p + 0xc]);
    vm.engine.sprites.setQueue(sprite, queue, b[p + 10]);
  },
  // 0x02: no-op
  0x02() {},
  // 0xa9: arithmetic on a variable (0x10015e8e -> 0x10018949). +2 variable,
  // +6 count (up to 3), then 8-byte terms from +10: u32 value, u8 op
  // (0 set, 1 add, 2 sub, 3 mul, 4 rounded div, 5 or, 6 and, 7 mod),
  // u8 ?, u8 negate, u8 value is a variable.
  0xa9(vm, b, dv, p) {
    const id = u32(dv, p + 2);
    let v = vm.getVar(id) | 0;
    const n = Math.min(u32(dv, p + 6), 3);
    for (let i = 0; i < n; i++) {
      const q = p + 10 + 8 * i;
      let x = vm.resolve(u32(dv, q), b[q + 7]) | 0;
      if (b[q + 6]) x = -x | 0;
      switch (b[q + 4]) {
        case 0: v = x; break;
        case 1: v = (v + x) | 0; break;
        case 2: v = (v - x) | 0; break;
        case 3: v = Math.imul(v, x); break;
        case 4: v = x ? Math.trunc((v + Math.trunc(Math.abs(x) / 2)) / x) | 0 : 0; break;
        case 5: v |= x; break;
        case 6: v &= x; break;
        case 7: v = x ? v % x | 0 : 0; break;
        default: v = 0;
      }
    }
    vm.setVar(id, v);
  },
  // 0x6b: bind a key to a script (0x1000b38c). +2 key (0 = all keys),
  // +6 script, +0xc shift, +0xd ctrl, +0xe enable, +0xf disable, +0x10 on key up.
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
  // 0xc2: set the text of a type 21 resource +2 (flag +0xe) to string +10,
  // formatted with the number +6 (flag +0xf) if +0x10 (0x1002104e).
  0xc2(vm, b, dv, p) {
    const e = vm.engine;
    const id = vm.resolve(u32(dv, p + 2), b[p + 0xe]);
    const arg = vm.resolve(i32(dv, p + 6), b[p + 0xf]);
    const fmt = e.getString(u32(dv, p + 10));
    if (fmt === undefined) return 0;
    return e.texts.setText(id, b[p + 0x10] ? sprintf(fmt, [arg]) : fmt) ? 1 : 0;
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
  0x1b(vm, b, dv, p) {
    vm.engine.setCursor(b[p + 2]);
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
  // Unloading a sprite (type 20) or a sprite list (type 16, u32 sprite ids)
  // destroys those sprites, which is how a screen's cleanup script (7270
  // for the campaign briefing) takes its sprites down.
  0xdf(vm, b, dv, p) {
    const e = vm.engine;
    const id = vm.resolve(u32(dv, p + 2), b[p + 6]);
    e.loaded.delete(id);
    const src = e.dynamic.get(id) ?? id;
    const t = src >= 0 && src < e.bin.count ? e.bin.type(src) : -1;
    let ids = [];
    if (t === 20) ids = [id];
    else if (t === 16) {
      const r = e.res(src);
      const d = new DataView(r.buffer, r.byteOffset, r.byteLength);
      for (let i = 0; i + 4 <= r.length; i += 4) ids.push(d.getUint32(i, true));
    }
    for (const s of ids) if (e.sprites.list.delete(s)) e.dirty = true;
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
