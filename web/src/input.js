// Keyboard and mouse: key bindings set by statement 0x6b, click handling.

export class Input {
  constructor(engine) {
    this.engine = engine;
    this.keys = new Map(); // key code -> {down, shift, ctrl, shiftCtrl, up, disabled}
    this.edit = null; // text being typed into (rt+0x3d5b), see startEdit
  }

  // Statement 0x2c. The text shows a "_" caret while it is edited. Enter
  // ends typing, Esc restores the old text; either way the text (without
  // the caret) goes to string `str` and `script(enter ? 1 : 0, 0)` is
  // queued (0x10021310). Backspace removes the last character, Delete
  // clears it all. Key bindings are off meanwhile (0x1000a977).
  startEdit({ text, script, str, max, digits }) {
    if (this.edit) this.endEdit(false);
    if (!text) return;
    const t = this.engine.texts;
    const old = t.get(text)?.text ?? "";
    this.edit = { text, script, str, max, digits, saved: old };
    t.setText(text, old + "_");
  }
  endEdit(cancel) {
    const ed = this.edit;
    const t = this.engine.texts;
    this.edit = null;
    const text = cancel ? ed.saved : (t.get(ed.text)?.text ?? "_").slice(0, -1);
    t.setText(ed.text, text);
    if (ed.str && !(ed.str & 0x8000)) this.engine.setString(ed.str, text);
    if (ed.script) this.engine.runLater(ed.script, [cancel ? 0 : 1, 0]);
  }
  // A typed character (WM_CHAR, 0x10021413): 8 backspace, 13 enter, 27 esc.
  char(c) {
    const ed = this.edit;
    if (!ed) return false;
    const t = this.engine.texts;
    const cur = (t.get(ed.text)?.text ?? "_").slice(0, -1);
    if (c === 0x1b || c === 0x0d) this.endEdit(c === 0x1b);
    else if (c === 8) t.setText(ed.text, cur.slice(0, -1) + "_");
    else if (c >= 0x20 && c < 0x100 && (!ed.digits || (c >= 0x30 && c <= 0x39)) && cur.length < ed.max) {
      t.setText(ed.text, cur + String.fromCharCode(c) + "_");
    }
    return true;
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
    if (this.edit) {
      if (vk === 0x2e) this.engine.texts.setText(this.edit.text, "_");
      return true;
    }
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
// Numpad and punctuation keys go by e.code, so the throttle (numpad + and -)
// and the twist keys (, and .) work whatever the keyboard layout.
const CODE_VK = {
  NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadMultiply: 0x6a, NumpadDivide: 0x6f, NumpadDecimal: 0x6e, NumpadEnter: 0x0d,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
  BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
};

export function vkFromEvent(e) {
  const code = e.code || "";
  if (CODE_VK[code] !== undefined) return CODE_VK[code];
  // Numpad digits: 0x60-0x69 with Num Lock on (key is a digit), else the
  // arrow / navigation key the key stands for.
  if (/^Numpad\d$/.test(code) && /^\d$/.test(e.key)) return 0x60 + Number(code.slice(6));
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
