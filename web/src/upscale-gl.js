// GPU upscalers for the display's sprite layer (menus, cockpit, HUD):
//   scale2x  Scale2x/EPX to twice the size (graphics.js has it in JS too)
//   xbr      xBR level 2 (Hyllian's edge-directed pixel-art scaler, the
//            family xBRZ comes from) straight to any output size: edges
//            at 30, 45 and 60 degrees become smooth lines, flat areas and
//            hard pixel-art details stay crisp.
// Uploading a 640x480 picture and enlarging it here is much cheaper than
// putting a big one through the 2D canvas every frame.

const VS = `#version 300 es
void main() {
  vec2 c = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3))[gl_VertexID];
  gl_Position = vec4(c, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSize; // source width, height
uniform vec2 uOut;   // output width, height
out vec4 outColor;
vec4 at(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), uSize - 1), 0); }
// Output pixel centre in source pixels, y down.
vec2 srcPos() { return vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y) * vec2(uSize) / uOut; }
`;

const SCALE2X = HEAD + `
void main() {
  vec2 sp = srcPos();
  ivec2 s = ivec2(floor(sp));
  bvec2 hi = greaterThanEqual(fract(sp), vec2(0.5));
  vec4 p = at(s);
  vec4 a = at(s + ivec2(0, -1)), d = at(s + ivec2(0, 1));
  vec4 c = at(s + ivec2(-1, 0)), b = at(s + ivec2(1, 0));
  vec4 r = p;
  if (a != d && c != b) {
    if (!hi.x && !hi.y) r = c == a ? a : p;
    else if (hi.x && !hi.y) r = a == b ? b : p;
    else if (!hi.x && hi.y) r = d == c ? c : p;
    else r = b == d ? d : p;
  }
  outColor = r;
}`;

// xBR level 2. Each source pixel E looks at its 5x5 neighbourhood (corners
// cut) and, for each of its four corners, decides whether an edge runs
// across that corner and at which slope; output pixels past the edge line
// take the colour across the edge. Written for the bottom-right corner in
// a rotated frame (R maps local right/down to source axes).
const XBR = HEAD + `
uniform float uDelta; // half width of the anti-aliased edge, in source pixels
// Colour distance in YUV, alpha counts too (see-through vs drawn).
float df(vec4 a, vec4 b) {
  vec3 d = a.rgb - b.rgb;
  float y = dot(d, vec3(0.299, 0.587, 0.114));
  float u = dot(d, vec3(-0.169, -0.331, 0.5));
  float v = dot(d, vec3(0.5, -0.419, -0.081));
  return 48.0 * abs(y) + 7.0 * abs(u) + 6.0 * abs(v) + 48.0 * abs(a.a - b.a);
}
bool neq(vec4 a, vec4 b) { return df(a, b) > 0.02; }
ivec2 ip;
mat2 R;
vec4 n(int x, int y) { return at(ip + ivec2(R * vec2(x, y))); }
// Weight (0..1) and colour for the corner at local +x +y; fp is the output
// pixel's position in E in the same local frame, 0..1.
float corner(vec2 fp, out vec4 col) {
  vec4 E = n(0, 0), F = n(1, 0), H = n(0, 1), I = n(1, 1);
  vec4 B = n(0, -1), C = n(1, -1), D = n(-1, 0), G = n(-1, 1);
  vec4 F4 = n(2, 0), I4 = n(2, 1), H5 = n(0, 2), I5 = n(1, 2);
  col = df(E, F) <= df(E, H) ? F : H;
  if (!(neq(E, F) && neq(E, H))) return 0.0;
  float wd1 = df(E, C) + df(E, G) + df(I, H5) + df(I, F4) + 4.0 * df(H, F);
  float wd2 = df(H, D) + df(H, I5) + df(F, I4) + df(F, B) + 4.0 * df(E, I);
  if (!(wd1 < wd2)) return 0.0;
  // Shallow (along F-G) and steep (along H-C) edges.
  bool shallow = 2.0 * df(F, G) <= df(H, C) && neq(E, G) && neq(D, G);
  bool steep = df(F, G) >= 2.0 * df(H, C) && neq(E, C) && neq(B, C);
  float w = smoothstep(1.5 - uDelta, 1.5 + uDelta, fp.x + fp.y);
  if (shallow) w = max(w, smoothstep(1.0 - uDelta, 1.0 + uDelta, 0.5 * fp.x + fp.y));
  if (steep) w = max(w, smoothstep(1.0 - uDelta, 1.0 + uDelta, fp.x + 0.5 * fp.y));
  return w;
}
void main() {
  vec2 sp = srcPos();
  ip = ivec2(floor(sp));
  vec2 f = fract(sp);
  vec4 E = at(ip);
  vec4 res = E;
  float best = 0.0;
  // The four corners: bottom-right, bottom-left, top-left, top-right.
  for (int k = 0; k < 4; k++) {
    vec2 ax = k == 0 ? vec2(1, 0) : k == 1 ? vec2(0, 1) : k == 2 ? vec2(-1, 0) : vec2(0, -1);
    R = mat2(ax, vec2(-ax.y, ax.x)); // local x -> ax, local y -> ax turned 90 degrees
    // f in the local frame (0..1 from the far corner to this one).
    vec2 c = f - 0.5;
    vec2 fp = vec2(dot(c, ax), dot(c, vec2(-ax.y, ax.x))) + 0.5;
    vec4 col;
    float w = corner(fp, col);
    if (w > best) { best = w; res = mix(E, col, w); }
  }
  outColor = res;
}`;

export class UpscaleGL {
  /**
   * @param {number} w  source width
   * @param {number} h  source height
   * @param {boolean} [allowSoftware]  also on a software GL (tests)
   */
  constructor(w, h, allowSoftware = false) {
    this.w = w;
    this.h = h;
    this.canvas = new OffscreenCanvas(w * 2, h * 2);
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false });
    if (!gl) throw new Error("no webgl2");
    // A software GL (SwiftShader) runs these slower than the JS Scale2x.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!allowSoftware && info && /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)))) throw new Error("software webgl");
    this.gl = gl;
    /** @type {Record<string, { p: WebGLProgram, out: WebGLUniformLocation | null, delta: WebGLUniformLocation | null }>} */
    this.progs = {};
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindVertexArray(gl.createVertexArray());
  }

  /**
   * @param {"scale2x" | "xbr"} mode
   */
  program(mode) {
    let pr = this.progs[mode];
    if (pr) return pr;
    const gl = this.gl;
    const p = /** @type {WebGLProgram} */ (gl.createProgram());
    for (const [type, src] of /** @type {[number, string][]} */ ([[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, mode === "xbr" ? XBR : SCALE2X]])) {
      const sh = /** @type {WebGLShader} */ (gl.createShader(type));
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "");
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "");
    gl.useProgram(p);
    gl.uniform1i(gl.getUniformLocation(p, "uSrc"), 0);
    gl.uniform2i(gl.getUniformLocation(p, "uSize"), this.w, this.h);
    pr = { p, out: gl.getUniformLocation(p, "uOut"), delta: gl.getUniformLocation(p, "uDelta") };
    this.progs[mode] = pr;
    return pr;
  }

  // Enlarge a w x h ImageData by `scale` (Scale2x always doubles); returns
  // the canvas.
  /**
   * @param {ImageData} image
   * @param {"scale2x" | "xbr"} mode
   * @param {number} scale
   */
  run(image, mode, scale) {
    const gl = this.gl;
    const k = mode === "scale2x" ? 2 : scale;
    const ow = this.w * k, oh = this.h * k;
    if (this.canvas.width !== ow) this.canvas.width = ow;
    if (this.canvas.height !== oh) this.canvas.height = oh;
    const pr = this.program(mode);
    gl.useProgram(pr.p);
    gl.uniform2f(pr.out, ow, oh);
    // About one output pixel of anti-aliasing along xBR's edges.
    if (pr.delta) gl.uniform1f(pr.delta, 0.5 / k);
    gl.viewport(0, 0, ow, oh);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }
}
