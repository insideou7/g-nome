// WebGL2 backend: same scene model and conventions as soft.js, drawn into
// an offscreen canvas the battlefield view composites under the 2D sprites.
import { mul } from "./math.js";
import { clumpMatrices } from "./model.js";
import { activeLights, materialLight, rgb01, SPECULAR_MIN } from "./scene.js";

// Lights the shader takes; more are dropped.
const MAX_LIGHTS = 8;
import { FRONT, CULL } from "./soft.js";

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
uniform mat4 uWorld, uView;
uniform vec4 uProj; // 1/vw, 1/vh, near, far
out vec3 vNormal, vWorld;
out vec2 vUV;
out float vDepth;
void main() {
  vec4 w = uWorld * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vec4 c = uView * w;
  vNormal = mat3(uWorld) * aNormal;
  vUV = aUV;
  vDepth = c.z;
  float n = uProj.z, f = uProj.w;
  // RenderWare cameras look along +Z with +X on the left of the screen.
  gl_Position = vec4(-c.x * uProj.x, c.y * uProj.y, c.z * (f + n) / (f - n) - 2.0 * f * n / (f - n), c.z);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal, vWorld;
in vec2 vUV;
in float vDepth;
uniform sampler2D uTex;
uniform bool uTextured, uTwoSided, uUnlit;
uniform vec3 uColor;
uniform vec3 uK; // ambient, diffuse, specular (see materialLight)
// Lights as activeLights gives them: type 1 directional, 2 point, 3 conical.
uniform int uLights, uLType[${MAX_LIGHTS}];
uniform vec3 uLColor[${MAX_LIGHTS}], uLDir[${MAX_LIGHTS}], uLPos[${MAX_LIGHTS}];
uniform vec2 uLParam[${MAX_LIGHTS}]; // radius, cos(cone angle)
uniform vec2 uFrame; // frame, frames
uniform float uAlpha;
uniform vec4 uFog; // start, end, enabled
uniform vec3 uFogColor;
out vec4 outColor;
void main() {
  vec3 base = uColor;
  if (uTextured) {
    vec2 uv = fract(vUV);
    uv.y = (uFrame.x + uv.y) / uFrame.y;
    vec4 t = texture(uTex, uv);
    if (t.a < 0.5) discard; // colour 0 is see-through
    base = t.rgb;
  }
  vec3 n = normalize(vNormal);
  vec3 light = vec3(uK.x);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLights) break;
    float d;
    if (uLType[i] == 1) d = dot(n, uLDir[i]);
    else {
      vec3 v = uLPos[i] - vWorld;
      float dist = length(v);
      if (dist <= 0.0 || dist >= uLParam[i].x) continue;
      if (uLType[i] == 3 && -dot(v, uLDir[i]) / dist < uLParam[i].y) continue;
      d = dot(n, v) / dist;
    }
    if (uTwoSided) d = abs(d);
    if (d <= 0.0) continue;
    light += (uK.y * d + (d > ${SPECULAR_MIN} ? uK.z * pow(d, 16.0) : 0.0)) * uLColor[i];
  }
  light = min(light, vec3(1.0));
  if (uUnlit) light = vec3(1.0);
  vec3 c = base * light;
  if (uFog.z > 0.0) c = mix(c, uFogColor, clamp((vDepth - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0));
  outColor = vec4(c, uAlpha);
}`;

const BD_VS = `#version 300 es
out vec2 vPix;
uniform vec3 uWrap; // wrap, viewport w, h
void main() {
  vec2 c = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1))[gl_VertexID];
  vPix = vec2(c.x, 1.0 - c.y) * uWrap.yz; // viewport pixels, y down
  gl_Position = vec4(c * 2.0 - 1.0, 0.0, 1.0);
}`;

const BD_FS = `#version 300 es
precision highp float;
in vec2 vPix;
uniform sampler2D uTex;
uniform vec4 uRect; // x, y, image w, h
uniform vec3 uWrap;
out vec4 outColor;
void main() {
  vec2 p = (vPix - uRect.xy) / uRect.zw;
  if (p.y < 0.0 || p.y >= 1.0 || (uWrap.x == 0.0 && (p.x < 0.0 || p.x >= 1.0))) discard;
  outColor = texture(uTex, vec2(fract(p.x), p.y));
}`;

export class WebGLBackend {
  // Backdrop pass state, created with bdProg on first use (backdrop()).
  /** @type {Record<string, WebGLUniformLocation | null>} */ bdU;
  /** @type {WeakMap<object, WebGLTexture>} */ bdTex;
  /** @type {WebGLVertexArrayObject} */ bdVao;

  /**
   * @param {any} renderer
   */
  constructor(renderer, canvas = null) {
    this.renderer = renderer;
    this.canvas = canvas || document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("no webgl2 context");
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    /** @type {Record<string, WebGLUniformLocation | null>} */
    this.u = {};
    for (const n of ["uWorld", "uView", "uProj", "uTex", "uTextured", "uTwoSided", "uUnlit", "uColor", "uK", "uLights", "uLType", "uLColor", "uLDir", "uLPos", "uLParam", "uFrame", "uAlpha", "uFog", "uFogColor"])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.meshes = new WeakMap(); // clump mesh -> VAO
    this.textures = new WeakMap(); // texture -> {tex, key}
    this.glTextures = new Set(); // every WebGLTexture made by texture()
  }

  /**
   * @param {any} mesh
   */
  vao(mesh) {
    let v = this.meshes.get(mesh);
    if (v) return v;
    const gl = this.gl;
    v = gl.createVertexArray();
    gl.bindVertexArray(v);
    [[mesh.positions, 3], [mesh.normals, 3], [mesh.uvs, 2]].forEach(([data, size], loc) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    });
    gl.bindVertexArray(null);
    this.meshes.set(mesh, v);
    return v;
  }

  /**
   * @param {any} tex
   */
  texture(tex) {
    const gl = this.gl;
    const key = this.renderer.paletteKey() + ":" + tex.version;
    let t = this.textures.get(tex);
    if (t && t.key === key) return t.tex;
    if (!t) {
      t = { tex: gl.createTexture(), key: "" };
      this.glTextures.add(t.tex);
      this.textures.set(tex, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    const rgba = this.renderer.rgbaOf(tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height * tex.frames, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.key = key;
    return t.tex;
  }

  // Delete every model texture (FreeAllTextures). Backdrops are kept.
  freeTextures() {
    for (const t of this.glTextures) this.gl.deleteTexture(t);
    this.glTextures.clear();
    this.textures = new WeakMap();
  }

  // Draw into the viewport {x, y, width, height} of a canvas `cw` x `ch`
  // (default: just the viewport), clipped to vp.clip {x, y, width, height}
  // when given. Returns the canvas.
  /**
   * @param {any} scene
   * @param {any} camera
   * @param {any} vp
   */
  render(scene, camera, vp) {
    const gl = this.gl, u = this.u;
    const cw = vp.canvasWidth || vp.x + vp.width || vp.width, ch = vp.canvasHeight || vp.y + vp.height || vp.height;
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    const x = vp.x || 0, y = ch - (vp.y || 0) - vp.height; // GL origin is bottom left
    gl.viewport(x, y, vp.width, vp.height);
    gl.enable(gl.SCISSOR_TEST);
    // vp.clip: draw only this part of the viewport (same coordinates).
    const c = vp.clip || { x: vp.x || 0, y: vp.y || 0, width: vp.width, height: vp.height };
    gl.scissor(c.x, ch - c.y - c.height, c.width, c.height);
    const bg = rgb01(camera.background);
    gl.clearColor(bg ? bg[0] : 0, bg ? bg[1] : 0, bg ? bg[2] : 0, bg ? 1 : 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (camera.backdrop) this.backdrop(camera.backdrop, vp);
    gl.frontFace(FRONT > 0 ? gl.CW : gl.CCW);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(u.uView, false, camera.view());
    gl.uniform4f(u.uProj, 1 / camera.viewwindow[0], 1 / camera.viewwindow[1], camera.near, camera.far);
    const lights = activeLights(scene).slice(0, MAX_LIGHTS);
    gl.uniform1i(u.uLights, lights.length);
    if (lights.length) {
      gl.uniform1iv(u.uLType, lights.map((l) => l.type));
      gl.uniform3fv(u.uLColor, lights.flatMap((l) => l.color));
      gl.uniform3fv(u.uLDir, lights.flatMap((l) => l.dir));
      gl.uniform3fv(u.uLPos, lights.flatMap((l) => l.pos));
      gl.uniform2fv(u.uLParam, lights.flatMap((l) => [Math.min(l.radius, 1e30), l.cosCone]));
    }
    const fog = camera.fogRange();
    gl.uniform4f(u.uFog, fog ? fog.start : 0, fog ? fog.end : 1, fog ? 1 : 0, 0);
    if (fog) gl.uniform3fv(u.uFogColor, fog.color);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    // Nodes in draw order; see-through polygons go after all opaque ones.
    /** @type {any} */
    const late = [];
    const draw = (/** @type {any} */ node, /** @type {any} */ clump, /** @type {number} */ ci, /** @type {any} */ g, /** @type {Float32Array} */ world, /** @type {number} */ alpha) => {
      const noDepth = node.depth === false;
      if (noDepth) gl.disable(gl.DEPTH_TEST);
      else gl.enable(gl.DEPTH_TEST);
      gl.depthMask(!noDepth && alpha >= 0.99);
      const two = !!node.doubleSided[ci];
      if (two || !CULL) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      gl.uniformMatrix4fv(u.uWorld, false, world);
      const m = g.material;
      const tex = this.renderer.textureOf(m, node);
      const ml = materialLight(m, !!tex);
      gl.uniform3f(u.uK, ml.ka, ml.kd, ml.ks);
      gl.uniform3fv(u.uColor, m.color || [1, 1, 1]);
      gl.uniform1i(u.uTwoSided, two || !CULL ? 1 : 0);
      gl.uniform1f(u.uAlpha, alpha);
      gl.uniform1i(u.uTextured, tex ? 1 : 0);
      gl.uniform1i(u.uUnlit, ml.unlit ? 1 : 0);
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture(tex));
        gl.uniform2f(u.uFrame, Math.min(node.textureFrame | 0, tex.frames - 1), tex.frames);
      }
      gl.bindVertexArray(this.vao(clump.mesh));
      gl.drawArrays(gl.TRIANGLES, g.start, g.count);
    };
    for (const node of scene.ordered()) {
      const worlds = clumpMatrices(node.model, node.matrix, node.pose, node.instance?.joints);
      node.model.clumps.forEach((/** @type {any} */ clump, /** @type {number} */ ci) => {
        if (node.clumpHidden[ci] || !clump.mesh.count) return;
        for (const g of clump.mesh.groups) {
          const alpha = (g.material.opacity ?? 1) * (node.clumpOpacity[ci] ?? 1);
          if (alpha <= 0.01) continue;
          if (alpha < 0.99) late.push([node, clump, ci, g, worlds[ci], alpha]);
          else draw(node, clump, ci, g, worlds[ci], alpha);
        }
      });
    }
    if (late.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const [node, clump, ci, g, world, alpha] of late) draw(node, clump, ci, g, world, alpha);
      gl.disable(gl.BLEND);
    }
    gl.depthMask(true);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  // Screen-space backdrop: image at (x, y) in viewport pixels, repeated
  // horizontally when wrap is set. Drawn with a 2D canvas pass into a
  // texture once per image, then as a full-viewport quad.
  /**
   * @param {any} bd
   * @param {any} vp
   */
  backdrop(bd, vp) {
    const gl = this.gl;
    if (!this.bdProg) {
      this.bdProg = program(gl, BD_VS, BD_FS);
      this.bdU = { uTex: gl.getUniformLocation(this.bdProg, "uTex"), uRect: gl.getUniformLocation(this.bdProg, "uRect"), uWrap: gl.getUniformLocation(this.bdProg, "uWrap") };
      this.bdTex = new WeakMap();
      this.bdVao = gl.createVertexArray();
    }
    let t = this.bdTex.get(bd.image);
    if (!t) {
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bd.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.bdTex.set(bd.image, t);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.bdProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(this.bdU.uTex, 0);
    // Viewport pixel -> image pixel: (px - x) / image size.
    gl.uniform4f(this.bdU.uRect, bd.x || 0, bd.y || 0, bd.image.width, bd.image.height);
    gl.uniform3f(this.bdU.uWrap, bd.wrap ? 1 : 0, vp.width, vp.height);
    gl.bindVertexArray(this.bdVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  // RGBA pixels of the last frame, top row first.
  readPixels() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vs
 * @param {string} fs
 */
function program(gl, vs, fs) {
  const p = gl.createProgram();
  /** @type {[number, string][]} */
  const stages = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]];
  for (const [type, src] of stages) {
    const s = /** @type {WebGLShader} */ (gl.createShader(type));
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "");
  return p;
}
