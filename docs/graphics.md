# Graphics options

Browser-port extras, in the **Graphics** row above the game screen. The
original drew everything at 640x480 (8-bit sprites, RenderWare 2.0 software
3D); the first choice of each option keeps that look, and **Original look**
puts them all back. Settings stay in `localStorage` (`g-nome.graphics`).

| Option | Choices | What it does |
| --- | --- | --- |
| Resolution | 1x (default), 2x, 3x, 4x, Match screen | The canvas is 640x480 times this. The 3D view renders at that size; the game's own logic still sees 640x480. Match screen rounds the device pixels per game pixel up (so 960 CSS px wide = 2x), and follows window, zoom and fullscreen changes. |
| Antialiasing | Off, 2x, 4x (default), 8x | MSAA on the 3D view, through our own multisampled framebuffer. 4x is what the browser's default WebGL context gave before this option existed; Off is the original's jagged edges. Capped at the GPU's `MAX_SAMPLES`. |
| Textures | Sharp (default), Smooth, Smooth + mipmaps | Nearest, bilinear, or trilinear filtering with 8x anisotropic where available. Applies to model textures and sky backdrops. Smooth modes bleed colour into see-through texels first (`bleedEdges`), so tree and fence edges don't get black fringes. |
| 2D | Sharp pixels (default), Smooth, Scale2x, xBR | How the 8-bit layer (menus, cockpit, HUD) is enlarged when Resolution is above 1x. Scale2x (AdvanceMAME2x/EPX) rounds staircase diagonals while keeping hard pixel-art edges, then smooths to the final size. xBR (Hyllian's level 2, the family xBRZ comes from) finds edges at 30, 45 and 60 degrees and draws them as smooth lines, straight at the final size. |

**AI HD art** (On/Off) and **Load HD pack**: see below.

**Fullscreen** puts the screen (and the DEBUG panel) fullscreen; with
Resolution on Match screen it renders at the monitor's resolution.

## AI HD packs

An HD pack replaces the game's pictures with AI-upscaled ones: every 2D
bitmap (menus, cockpits, HUD art) and every 3D model texture. It is made
from the player's own game files, so like them it is never committed or
published.

Make one (about an hour on 4 CPU cores; 3,954 pictures, 216 MB):

```
pip install numpy pillow onnx onnxruntime
curl -LO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
python3 tools/hdpack.py game/g-nome/G-NOME G-NOME-HD.zip --model realesr-general-x4v3.pth
```

- `tools/sr_onnx.py` turns a Real-ESRGAN `.pth` into ONNX without PyTorch
  (a small unpickler plus the two network shapes, SRVGGNetCompact and
  RRDBNet), and onnxruntime runs it on the CPU. `realesr-general-x4v3` is
  fast and keeps the painted look; `RealESRGAN_x4plus.pth` is sharper and
  about 20 times slower. The anime models flatten the art's dithering
  into cartoon shading.
- Pictures are palette indices and the palette changes per world, so the
  pack is keyed by the RGBA picture as the engine sees it (`image_key` in
  the tool, `imageKey` in `web/src/hdpack.js`, a 64-bit order-sensitive
  sum). Each picture is hashed under the menu palette and every world
  palette; each distinct result is upscaled once.
- See-through pixels get their neighbours' colour before upscaling; alpha
  is resized bicubic. Textures are padded by wrapping, so tiles stay
  seamless. 2D art is stored at 4x, textures at 2x (`--scale-2d`,
  `--scale-3d`), as WebP. The tool resumes from an earlier pack.

Load it with **Load HD pack** (kept in the browser's IndexedDB for next
time), or put `G-NOME-HD.ZIP` in the game folder. **AI HD art** turns it
off and on; **Original look** turns it off.

In the engine:

- 3D: `WebGLBackend.texture()` hashes each texture under the current
  palette and uploads the HD image instead once it has decoded.
- 2D: with a pack and Resolution above 1x, `Engine.compose` has each blit
  record itself and mark the screen pixels it drew (`blit(..., rec)` in
  `sprites.js`). `Display.drawHd` then draws each recorded bitmap's HD image
  over the enlarged frame, cut down to the pixels that still show that
  bitmap (so text, the radar and sprites drawn later stay on top). Not
  during palette fades. Text, the radar and generated pictures have no HD
  version and keep the 2D filter.

## Code

- `web/src/graphics.js`: settings, `resolveScale`, the JS `scale2x` on palette
  indices, `bleedEdges`. Tests: `web/tests/unit/graphics.test.mjs`.
- `web/src/display.js`: `configure(scale, sprites)`; `present()` composes the
  3D underlay (at its own `underlay.scale`) and the enlarged sprite layer.
  `image` stays 640x480, so headless tests see the same pixels as before.
- `web/src/upscale-gl.js`: Scale2x and xBR as WebGL2 shaders (a big
  `putImageData` per frame costs more than the filter). Not used on a
  software GL (SwiftShader); there both fall back to the JS Scale2x.
- `web/src/render3d/webgl.js`: `configure({scale, msaa, textures})`, the MSAA
  framebuffer (`msTarget`, resolved with `blitFramebuffer` inside the clip
  scissor), and `filtering()`. The shader samples with `textureGrad` on the
  unwrapped UVs so mipmaps don't seam where `fract()` wraps; single-frame
  textures use `REPEAT` so bilinear wraps too.

## Not done

- Unit previews (LAB, briefing, cockpit own-unit view) are software-rendered
  into 8-bit sprites (`RenderToBitmap`), so they only get the 2D filter
  (their textures do not use the HD pack).
- Widescreen: the scripts lay out the cockpit and HUD for 4:3.
- Movies (Smacker) go through the 2D layer like everything else.
