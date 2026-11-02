// Scale2x on the GPU for the display's sprite layer (graphics.js has the
// same filter in JS, for tests and browsers without WebGL2). Uploading a
// 640x480 picture and enlarging it here is much cheaper than putting a
// 1280x960 one through the 2D canvas every frame.

const VS = `#version 300 es
void main() {
  vec2 c = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3))[gl_VertexID];
  gl_Position = vec4(c, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSize; // source width, height
out vec4 outColor;
vec4 at(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), uSize - 1), 0); }
void main() {
  // Output row 0 is the top (texture row 0 = first image row).
  ivec2 o = ivec2(int(gl_FragCoord.x), uSize.y * 2 - 1 - int(gl_FragCoord.y));
  ivec2 s = o / 2, q = o - s * 2;
  vec4 p = at(s);
  vec4 a = at(s + ivec2(0, -1)), d = at(s + ivec2(0, 1));
  vec4 c = at(s + ivec2(-1, 0)), b = at(s + ivec2(1, 0));
  vec4 r = p;
  if (a != d && c != b) {
    if (q == ivec2(0, 0)) r = c == a ? a : p;
    else if (q == ivec2(1, 0)) r = a == b ? b : p;
    else if (q == ivec2(0, 1)) r = d == c ? c : p;
    else r = b == d ? d : p;
  }
  outColor = r;
}`;

export class Scale2xGL {
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
    // A software GL (SwiftShader) runs this shader slower than the JS filter.
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!allowSoftware && info && /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)))) throw new Error("software webgl");
    this.gl = gl;
    const p = /** @type {WebGLProgram} */ (gl.createProgram());
    for (const [type, src] of /** @type {[number, string][]} */ ([[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]])) {
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
    gl.uniform2i(gl.getUniformLocation(p, "uSize"), w, h);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, w * 2, h * 2);
  }

  // Enlarge a w x h ImageData; returns the 2w x 2h canvas.
  /**
   * @param {ImageData} image
   */
  run(image) {
    const gl = this.gl;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }
}
