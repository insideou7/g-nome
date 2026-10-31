// Keyboard and mouse: key bindings set by statement 0x6b, click handling.

export class Input {
  constructor(engine) {
    this.engine = engine;
    this.keys = new Map(); // key code -> {down, shift, ctrl, shiftCtrl, up, disabled}
  }
  bindKey(key, script, f) {
    const set = (k) => {
      const r = this.keys.get(k) || {};
      if (f.clear) r.disabled = false;
      else if (f.disable) r.disabled = true;
      else {
        const slot = f.shift && f.ctrl ? "shiftCtrl" : f.shift ? "shift" : f.ctrl ? "ctrl" : f.up ? "up" : "down";
        r[slot] = script;
        r.disabled = false;
      }
      this.keys.set(k, r);
    };
    if (key === 0) for (let k = 0; k < 256; k++) set(k);
    else if (key < 256) set(key);
  }
  // Windows virtual-key code.
  keyDown(vk, shift = false, ctrl = false) {
    this.engine.world?.controls.keyDown(vk);
    const r = this.keys.get(vk);
    if (!r || r.disabled) return false;
    const s = shift && ctrl ? r.shiftCtrl : shift ? r.shift : ctrl ? r.ctrl : r.down;
    if (s) this.engine.runLater(s, [vk]);
    return !!s;
  }
  keyUp(vk) {
    this.engine.world?.controls.keyUp(vk);
    const r = this.keys.get(vk);
    if (r && !r.disabled && r.up) this.engine.runLater(r.up, [vk]);
  }
}

// DOM KeyboardEvent.key/code -> Windows virtual-key code.
export function vkFromEvent(e) {
  const k = e.key;
  const map = { Escape: 0x1b, Enter: 0x0d, " ": 0x20, Tab: 0x09, Backspace: 0x08, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Shift: 0x10, Control: 0x11, Alt: 0x12 };
  if (map[k] !== undefined) return map[k];
  if (/^F\d+$/.test(k)) return 0x6f + Number(k.slice(1));
  if (k.length === 1) {
    const c = k.toUpperCase().charCodeAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c;
  }
  return 0;
}
