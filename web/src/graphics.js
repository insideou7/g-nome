// Browser-port graphics options: none of these exist in the original, which
// drew everything at 640x480 with RenderWare's software renderer. The
// defaults keep that look; the page's Graphics row (main.js) changes them.
//
//   scale     the screen canvas is 640x480 times this (1-4), or "auto" to
//             match the pixels the canvas covers on the page. The 3D view
//             renders at that size; the 8-bit sprite layer is enlarged.
//   msaa      multisample antialiasing of the 3D view: 0 (off), 2, 4 or 8.
//             4 is what the browser gave the 3D view before this option.
//   textures  3D texture filtering: "nearest" (original), "linear", or
//             "mipmap" (trilinear, plus anisotropic where the GPU has it).
//   sprites   how the 2D layer (menus, HUD, cockpit) is enlarged: "sharp"
//             (whole pixels), "smooth" (bilinear), "scale2x" (the
//             Scale2x/EPX pixel-art filter, then smooth to the final size)
//             or "xbr" (xBR level 2 straight to the final size; GPU only,
//             Scale2x without hardware WebGL2). See upscale-gl.js.

const KEY = "g-nome.graphics";

/** @typedef {{ scale: number | "auto", msaa: number, textures: "nearest" | "linear" | "mipmap", sprites: "sharp" | "smooth" | "scale2x" | "xbr" }} GraphicsSettings */

/** @type {GraphicsSettings} */
export const DEFAULTS = Object.freeze({ scale: 1, msaa: 4, textures: "nearest", sprites: "sharp" });

// Choices for each setting, as [value, label], in menu order.
export const CHOICES = {
  scale: [[1, "Original 640x480"], [2, "2x (1280x960)"], [3, "3x (1920x1440)"], [4, "4x (2560x1920)"], ["auto", "Match screen"]],
  msaa: [[0, "Off"], [2, "2x"], [4, "4x"], [8, "8x"]],
  textures: [["nearest", "Sharp (original)"], ["linear", "Smooth"], ["mipmap", "Smooth + mipmaps"]],
  sprites: [["sharp", "Sharp pixels"], ["smooth", "Smooth"], ["scale2x", "Scale2x"], ["xbr", "xBR"]],
};

/**
 * Settings from localStorage, with anything missing or unknown at its default.
 * @param {any} [raw]
 * @returns {GraphicsSettings}
 */
export function loadGraphics(raw) {
  if (raw === undefined) {
    try {
      raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    } catch {
      raw = null;
    }
  }
  /** @type {any} */
  const out = { ...DEFAULTS };
  for (const k of /** @type {(keyof GraphicsSettings)[]} */ (Object.keys(DEFAULTS))) {
    const v = raw?.[k];
    if (CHOICES[k].some(([c]) => c === v)) out[k] = v;
  }
  return out;
}

/**
 * @param {GraphicsSettings} s
 */
export function saveGraphics(s) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {}
}

/**
 * The canvas scale for a setting: "auto" rounds the canvas's device pixels
 * per game pixel up, so the browser only ever shrinks the picture.
 * @param {number | "auto"} scale
 * @param {number} cssWidth  canvas width on the page, CSS pixels
 * @param {number} dpr       window.devicePixelRatio
 */
export function resolveScale(scale, cssWidth, dpr) {
  if (scale !== "auto") return scale;
  return Math.max(1, Math.min(4, Math.ceil((cssWidth * dpr) / 640 - 0.05)));
}

/**
 * Scale2x (AdvanceMAME2x / EPX) on 8-bit palette indices: each pixel P
 * becomes 2x2, and a corner takes the colour of the two neighbours it
 * touches when they match each other and not the opposite pair. Keeps
 * hard pixel-art edges but rounds off staircase diagonals.
 * @param {Uint8Array} src
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} [dst]  output, twice as wide and tall
 */
export function scale2x(src, w, h, dst = new Uint8Array(w * h * 4)) {
  const w2 = w * 2;
  for (let y = 0; y < h; y++) {
    const row = y * w, up = y > 0 ? row - w : row, down = y < h - 1 ? row + w : row;
    let o = y * 2 * w2;
    for (let x = 0; x < w; x++, o += 2) {
      const p = src[row + x];
      const a = src[up + x], d = src[down + x];
      const c = src[row + (x > 0 ? x - 1 : x)], b = src[row + (x < w - 1 ? x + 1 : x)];
      if (a !== d && c !== b) {
        dst[o] = c === a ? a : p;
        dst[o + 1] = a === b ? b : p;
        dst[o + w2] = d === c ? c : p;
        dst[o + w2 + 1] = b === d ? d : p;
      } else {
        dst[o] = dst[o + 1] = dst[o + w2] = dst[o + w2 + 1] = p;
      }
    }
  }
  return dst;
}

/**
 * Fill the colour of fully transparent texels from their opaque neighbours,
 * so bilinear filtering and mipmaps don't pull black fringes into the edges
 * of see-through textures (trees, fences). Alpha stays 0. Returns a copy.
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 */
export function bleedEdges(rgba, w, h) {
  const out = new Uint8ClampedArray(rgba);
  let todo = [];
  for (let i = 0; i < w * h; i++) if (!out[i * 4 + 3]) todo.push(i);
  const done = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) done[i] = out[i * 4 + 3] ? 1 : 0;
  // A few rings outward are enough for the filter footprint.
  for (let pass = 0; pass < 4 && todo.length; pass++) {
    const next = [], filled = [];
    for (const i of todo) {
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (!dx && !dy)) continue;
          const j = yy * w + xx;
          if (!done[j]) continue;
          r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; n++;
        }
      }
      if (n) filled.push(i, r / n, g / n, b / n);
      else next.push(i);
    }
    for (let k = 0; k < filled.length; k += 4) {
      const i = filled[k];
      out[i * 4] = filled[k + 1]; out[i * 4 + 1] = filled[k + 2]; out[i * 4 + 2] = filled[k + 3];
      done[i] = 1;
    }
    todo = next;
  }
  return out;
}
