// Effects: animated textures (shots, fireballs, smoke), sounds placed on
// objects, and the HUD sprite hooks. Written from the Ghidra decompile of
// RENDER.R32 (addresses in the comments). Spec: docs/combat.md.
import { normalize, sub, dot } from "../battlefield/math.js";

export function effectExterns(host) {
  const engine = host.engine;
  // Frame counter shared with the FRME animation (object +0xBC), and the
  // texture's frame count (+0x94) and "animated texture" flag (+0x54 & 0x20).
  const anim = (id) => engine.animation?.obj(id) || (host.obj(id) ? (host.obj(id).anim ??= { frame: 0 }) : null);
  const tex = (id) => host.obj(id) && (host.obj(id).texAnim ??= { frames: 0, on: false });
  // RwSetTextureFrame on the object's texture: the battlefield view draws
  // the object's model with this frame.
  const show = (id, f) => {
    const o = host.obj(id);
    if (o) {
      o.textureFrame = f;
      o.moved = true;
    }
  };

  return {
    // SetAnimatedTexture(obj, clump, frames) 0x10009962
    SetAnimatedTexture(id, _clump, frames) {
      const t = tex(id);
      if (t) {
        t.frames = frames;
        t.on = true;
      }
      return 0;
    },
    // SetTextureFrame(obj, f) 0x1000a2c9: sets the frame counter; the
    // texture changes on the next UpdateAnimTex.
    SetTextureFrame(id, f) {
      const a = anim(id);
      if (a) a.frame = f;
      return 0;
    },
    // GetTextureNumFrames(obj) 0x1001278e
    GetTextureNumFrames: (id) => tex(id)?.frames ?? 0,
    // UpdateAnimTex(obj) 0x1000a64a: show the next frame; 1 once past the
    // last one (the scripts then delete the effect).
    UpdateAnimTex(id) {
      const t = tex(id), a = anim(id);
      if (!t?.on || !a || !host.model(id)) return 0;
      if (Math.trunc(a.frame) >= t.frames) return 0;
      show(id, Math.trunc(a.frame));
      a.frame += 1;
      return t.frames <= Math.trunc(a.frame) ? 1 : 0;
    },
    // UpdateAnimTexCycle(obj) 0x1000a789: the same, looping.
    UpdateAnimTexCycle(id) {
      const t = tex(id), a = anim(id);
      if (!t?.on || !a || !host.model(id)) return 0;
      show(id, Math.trunc(a.frame));
      a.frame += 1;
      while (t.frames > 0 && Math.trunc(a.frame) >= t.frames) a.frame -= t.frames;
      return 0;
    },

    // ObjectPlayWave(obj, wave, loop, a, priority, remember) 0x100140ad:
    // play a sound from an object. Volume falls off with the distance to
    // the camera: 10000 - 3500 x distance / far plane; pan is the direction
    // along the camera's right x 1000. A priority of 10 drops by one at each
    // of 8000, 7000, 4000 and 1000 volume. `remember` keeps the wave on the
    // object (+0xDC).
    ObjectPlayWave(id, wave, loop, a, priority, remember) {
      const o = host.obj(id), w = host.world;
      if (!o || !w) return 0;
      o.wave = 0;
      const cam = w.cameraPose(1);
      const d = sub(o.pos, cam.pos);
      const volume = 10000 - Math.trunc((Math.hypot(d[0], d[1], d[2]) / (w.camera.far || 1)) * 3500);
      if (volume <= 0) return 0;
      if (priority === 10) {
        for (const v of [8000, 7000, 4000, 1000]) if (volume < v) priority--;
      }
      const pan = Math.trunc(dot(normalize(d), cam.right) * 1000);
      host.extern("DSPlayWave")?.(wave, volume, pan, loop, a, priority, 1);
      if (remember) o.wave = wave;
      return 0;
    },

    // MakeSpriteExtern(sprite, on) 0x10012ffe (SpriteSetExternalDraw) and
    // MakeSpriteDraw(sprite) 0x10012fa0 (SpriteShowOpaque): RTLIB32 leaves
    // these sprites (radar, target markers) for RENDER.R32 to draw over each
    // 3D frame. The browser engine composes every sprite over the 3D view
    // anyway, so there is nothing to do.
    MakeSpriteExtern: () => 0,
    MakeSpriteDraw: () => 0,
    // DamageRect(obj) 0x10011acb: mark the object's screen area for redraw
    // (dirty rectangles). The browser redraws the whole view.
    DamageRect: () => 0,
  };
}
