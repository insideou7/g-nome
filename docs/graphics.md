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
| 2D | Sharp pixels (default), Smooth, Scale2x | How the 8-bit layer (menus, cockpit, HUD) is enlarged when Resolution is above 1x. Scale2x (AdvanceMAME2x/EPX) rounds staircase diagonals while keeping hard pixel-art edges, then smooths to the final size. |

**Fullscreen** puts the screen (and the DEBUG panel) fullscreen; with
Resolution on Match screen it renders at the monitor's resolution.

## Code

- `web/src/graphics.js`: settings, `resolveScale`, the JS `scale2x` on palette
  indices, `bleedEdges`. Tests: `web/tests/unit/graphics.test.mjs`.
- `web/src/display.js`: `configure(scale, sprites)`; `present()` composes the
  3D underlay (at its own `underlay.scale`) and the enlarged sprite layer.
  `image` stays 640x480, so headless tests see the same pixels as before.
- `web/src/scale2x-gl.js`: Scale2x as a WebGL2 shader (a 1280x960
  `putImageData` per frame costs more than the filter). Not used on a
  software GL (SwiftShader), where the JS filter is faster.
- `web/src/render3d/webgl.js`: `configure({scale, msaa, textures})`, the MSAA
  framebuffer (`msTarget`, resolved with `blitFramebuffer` inside the clip
  scissor), and `filtering()`. The shader samples with `textureGrad` on the
  unwrapped UVs so mipmaps don't seam where `fract()` wraps; single-frame
  textures use `REPEAT` so bilinear wraps too.

## Not done

- Unit previews (LAB, briefing, cockpit own-unit view) are software-rendered
  into 8-bit sprites (`RenderToBitmap`), so they only get the 2D filter.
- Widescreen: the scripts lay out the cockpit and HUD for 4:3.
- Movies (Smacker) go through the 2D layer like everything else.
