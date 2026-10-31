// RTLIB32's sprite system (Sprite* exports). Type 20 resources define
// sprites; scripts drive them with messages (builtin 0xce, SpriteSendMessage
// at 0x1003e1dd). Message ids, from the dispatcher:
//   12 move to (x, y [, flag])        18 show cel n (no arg: -1)
// Still to do: the other 16 message types, animation, drawing.

export class Sprites {
  constructor(engine) {
    this.engine = engine;
    this.list = new Map(); // resource id -> sprite
  }
  get(id) {
    let s = this.list.get(id);
    if (!s) {
      s = { id, x: 0, y: 0, cel: -1, visible: false };
      this.list.set(id, s);
    }
    return s;
  }
  send(id, msg) {
    const s = this.get(id);
    const [type, ...a] = msg;
    switch (type) {
      case 12:
        s.x = a[0] | 0;
        s.y = a[1] | 0;
        break;
      case 18:
        s.cel = a.length ? a[0] : -1;
        s.visible = true;
        break;
      default:
        this.engine.vm.noteUnknown("sprite message", type);
    }
    return 1;
  }
}
