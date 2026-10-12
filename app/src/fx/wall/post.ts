/**
 * Post-processing for the shield wall (WebGL 1 compatible, RGBA8 targets):
 *
 *   points -> scene (full size)
 *   scene  -> quarter (4-tap box) -> blur H/V      soft bloom, small radius
 *   quarter -> eighth (4-tap box) -> blur H/V      wide bloom + frosted glass
 *   composite -> canvas: scene + bloom (optionally ordered-dithered: the soft
 *     glow turns into 4x4 Bayer pixel light that matches the pixel type, while
 *     the sharp dots stay crisp), and inside every glass shape a pane of
 *     liquid glass: the wall behind it frosted (eighth level), a lens bevel at
 *     the rim that refracts the sharp wall with a faint chromatic split, a
 *     tint that keeps text on it legible, and a specular rim lit from above
 *     plus a glint that follows the pointer.
 *
 * Glass shapes are rounded rectangles in CSS px of the canvas (up to
 * MAX_GLASS). The output stays valid premultiplied alpha (rgb <= a), so it
 * composites the same in every browser compositor.
 * `init` returns false when the framebuffers cannot be created; the renderer
 * then draws straight to the canvas (no bloom, CSS glass).
 */
type GL = WebGLRenderingContext | WebGL2RenderingContext;

export const MAX_GLASS = 8;

const QUAD_VS = `
attribute vec2 aQuad;
varying vec2 vUv;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}
`;

/** 4 bilinear taps = a 4x4 box (or 2x2 at half scale); the first level also keeps only the brighter light. */
const DOWN_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0));
  c += texture2D(uTex, vUv + uTexel * vec2(1.0, -1.0));
  c += texture2D(uTex, vUv + uTexel * vec2(-1.0, 1.0));
  c += texture2D(uTex, vUv + uTexel * vec2(1.0, 1.0));
  c *= 0.25;
  if (uKnee > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    float k = smoothstep(uKnee * 0.5, uKnee * 1.5, l);
    c *= mix(0.22, 1.0, k);
  }
  gl_FragColor = c;
}
`;

/** 9-tap Gaussian in 5 bilinear taps along uDir. */
const BLUR_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.2270270270;
  c += texture2D(uTex, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = c;
}
`;

const COMP_FS = `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uQuarter;
uniform sampler2D uEighth;
uniform vec2 uSize;       // canvas CSS px
uniform vec2 uBloom;      // quarter gain, eighth gain
uniform vec4 uGlass[${MAX_GLASS}];   // x, y, w, h (CSS px, top-left origin)
uniform vec4 uShape[${MAX_GLASS}];   // radius, tint alpha (dark), frost (0..1), strength (0 = off)
uniform vec3 uPointer;    // x, y (CSS px), strength
uniform vec4 uGlassLook;  // bevel width px, refraction px, chroma, white sheen
uniform float uGlassCap;  // max luma (encoded) of a pane away from its rim
uniform float uDither;    // bloom dither cell in CSS px (0 = smooth bloom)
varying vec2 vUv;

float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  vec4 scene = texture2D(uScene, vUv);
  vec4 q = texture2D(uQuarter, vUv);
  vec4 e = texture2D(uEighth, vUv);
  vec3 bloom = q.rgb * uBloom.x + e.rgb * uBloom.y;
  if (uDither > 0.0) {
    // 4x4 Bayer threshold of this dither cell (WebGL 1: built from two 2x2 levels, no bit ops).
    vec2 cell = floor(vec2(vUv.x, 1.0 - vUv.y) * uSize / uDither);
    vec2 c1 = mod(cell, 2.0);
    vec2 c2 = mod(floor(cell * 0.5), 2.0);
    float th = (4.0 * mod(2.0 * c1.x + 3.0 * c1.y, 4.0) + mod(2.0 * c2.x + 3.0 * c2.y, 4.0) + 0.5) / 16.0;
    float bl = max(bloom.r, max(bloom.g, bloom.b));
    float qv = floor(bl * 6.0 + th) / 6.0;
    // Mostly dithered, a little of the smooth glow kept so the faintest light does not crawl as the wall turns.
    bloom = mix(bloom, bloom * (qv / max(bl, 1e-4)), 0.7);
  }
  vec3 rgb = scene.rgb + bloom;
  float a = scene.a;

  // Glass: nearest shape (they do not overlap).
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float best = 1e5;
  vec4 G = vec4(0.0);
  vec4 S = vec4(0.0);
  for (int i = 0; i < ${MAX_GLASS}; i++) {
    vec4 g = uGlass[i];
    vec4 s = uShape[i];
    if (s.w <= 0.0) continue;
    vec2 c = g.xy + g.zw * 0.5;
    float d = sdRound(px - c, g.zw * 0.5, min(s.x, min(g.z, g.w) * 0.5));
    if (d < best) {
      best = d;
      G = g;
      S = s;
    }
  }
  if (best < 0.5) {
    vec2 c = G.xy + G.zw * 0.5;
    float r = min(S.x, min(G.z, G.w) * 0.5);
    // Outward normal of the rounded rectangle (finite differences of the distance).
    vec2 hb = G.zw * 0.5;
    float dx = sdRound(px + vec2(1.0, 0.0) - c, hb, r) - sdRound(px - vec2(1.0, 0.0) - c, hb, r);
    float dy = sdRound(px + vec2(0.0, 1.0) - c, hb, r) - sdRound(px - vec2(0.0, 1.0) - c, hb, r);
    vec2 n = normalize(vec2(dx, dy) + 1e-5);
    float inside = -best;
    float bevelW = uGlassLook.x;
    // Lens bevel: 1 at the rim, 0 once inside by bevelW; curved like the edge of a thick pane.
    float bev = 1.0 - smoothstep(0.0, bevelW, inside);
    float lens = bev * bev;
    // The rim bends the wall behind it inward (a convex edge magnifies toward the centre).
    vec2 off = -n * lens * uGlassLook.y;
    vec2 toUv = vec2(1.0, -1.0) / uSize;
    vec2 uvR = vUv + off * toUv * (1.0 + uGlassLook.z);
    vec2 uvG = vUv + off * toUv;
    vec2 uvB = vUv + off * toUv * (1.0 - uGlassLook.z);
    // The rim lenses the wall (soft level, so single dots do not smear into hairs); inside it is frosted.
    vec3 lensed = vec3(texture2D(uQuarter, uvR).r, texture2D(uQuarter, uvG).g, texture2D(uQuarter, uvB).b) * 1.5
      + vec3(texture2D(uScene, uvR).r, texture2D(uScene, uvG).g, texture2D(uScene, uvB).b) * 0.22;
    vec3 frost = mix(texture2D(uQuarter, uvG).rgb * 1.8, texture2D(uEighth, uvG).rgb * 2.8, S.z);
    // Glass deepens colour a little (like a saturate() backdrop).
    float fl = dot(frost, vec3(0.2126, 0.7152, 0.0722));
    frost = max(mix(vec3(fl), frost, 1.35), 0.0);
    float clear = lens * (1.0 - S.z * 0.4);
    vec3 behind = mix(frost, lensed, clear);
    // Tint: darken what lies behind (incl. the page under the canvas) so text on the glass stays legible.
    float tint = S.y;
    // Light: a white sheen, brighter toward the top; a specular rim lit from above; a glint at the pointer.
    float topLight = 1.0 - smoothstep(0.0, G.w, px.y - G.y);
    float sheen = uGlassLook.w * (0.55 + 0.45 * topLight);
    float rim = (1.0 - smoothstep(0.0, 1.6, inside)) * (0.32 + 0.68 * max(-n.y, 0.0));
    float rimLow = (1.0 - smoothstep(0.0, 1.6, inside)) * max(n.y, 0.0) * 0.18;
    vec2 pd = px - uPointer.xy;
    float glint = exp(-dot(pd, pd) / (180.0 * 180.0)) * uPointer.z * (0.35 * bev + 0.08);
    vec3 light = vec3(sheen + rim * 0.5 + rimLow + glint * 0.6);
    float edgeAA = smoothstep(0.5, -0.5, best) * S.w;
    vec3 glassRgb = behind * (1.0 - tint) + light;
    // Text sits on the pane: away from the rim its brightness is capped (an impact right behind a tile glows
    // through, but never washes out the words on it). uGlassCap: max luma of the pane's own light.
    float paneL = dot(glassRgb, vec3(0.2126, 0.7152, 0.0722));
    float capL = mix(uGlassCap, 1.0, rim);
    glassRgb *= min(1.0, capL / max(paneL, 1e-4));
    float glassA = tint + max(light.r, 0.0);
    rgb = mix(rgb, glassRgb, edgeAA);
    a = mix(a, glassA, edgeAA);
  }
  a = clamp(max(a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}
`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface Prog {
  program: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

export interface GlassShape {
  /** CSS px of the canvas, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  /** Dark tint (0..1): how much of the backdrop is held back behind text. */
  tint: number;
  /** 0: clear lens rim; 1: fully frosted. */
  frost: number;
  /** 0..1 (fade in / out). */
  alpha: number;
}

export interface PostParams {
  bloom: readonly [number, number];
  glass: readonly GlassShape[];
  pointer: readonly [number, number, number];
  /** bevel width px, refraction px, chroma, white sheen. */
  look: readonly [number, number, number, number];
  /** Max luma (sRGB-encoded) of a pane's own light away from its rim: keeps text on it legible. */
  cap: number;
  /** Bloom dither cell in CSS px (PIXEL_V6: ordered dithering that matches the pixel type); 0 or absent = smooth. */
  dither?: number;
  cssW: number;
  cssH: number;
}

function compileProgram(gl: GL, vsSrc: string, fsSrc: string, uniforms: readonly string[]): Prog | null {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aQuad");
  gl.linkProgram(program);
  const ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
  if (!ok) {
    if (!gl.isContextLost()) console.warn("ShieldWall post: program did not link:", gl.getProgramInfoLog(program), gl.getShaderInfoLog(fs));
    gl.deleteProgram(program);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!ok) return null;
  const loc: Record<string, WebGLUniformLocation | null> = {};
  for (const u of uniforms) loc[u] = gl.getUniformLocation(program, u);
  return { program, loc };
}

export class PostFx {
  private readonly gl: GL;
  private quad: WebGLBuffer | null = null;
  private down: Prog | null = null;
  private blur: Prog | null = null;
  private comp: Prog | null = null;
  private scene: Target | null = null;
  private q: [Target, Target] | null = null;
  private e: [Target, Target] | null = null;
  private glassA = new Float32Array(MAX_GLASS * 4);
  private glassB = new Float32Array(MAX_GLASS * 4);
  ok = false;

  constructor(gl: GL) {
    this.gl = gl;
  }

  /** Programs and the quad; the targets come with the first resize. False: post-processing unavailable. */
  init(): boolean {
    const gl = this.gl;
    this.dispose();
    this.down = compileProgram(gl, QUAD_VS, DOWN_FS, ["uTex", "uTexel", "uKnee"]);
    this.blur = compileProgram(gl, QUAD_VS, BLUR_FS, ["uTex", "uDir"]);
    this.comp = compileProgram(gl, QUAD_VS, COMP_FS, ["uScene", "uQuarter", "uEighth", "uSize", "uBloom", "uGlass[0]", "uShape[0]", "uPointer", "uGlassLook", "uGlassCap", "uDither"]);
    this.quad = gl.createBuffer();
    if (!this.down || !this.blur || !this.comp || !this.quad) {
      this.dispose();
      return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.ok = true;
    return true;
  }

  private target(w: number, h: number): Target | null {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }
    return { tex, fbo, w, h };
  }

  private freeTargets(): void {
    const gl = this.gl;
    const all = [this.scene, ...(this.q ?? []), ...(this.e ?? [])];
    for (const t of all) {
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.scene = null;
    this.q = null;
    this.e = null;
  }

  /** (Re)allocate the targets for a drawing buffer of w x h device px. False: unavailable (draw direct). */
  resize(w: number, h: number): boolean {
    if (!this.ok) return false;
    if (this.scene && this.scene.w === w && this.scene.h === h) return true;
    this.freeTargets();
    const qw = Math.max(1, Math.round(w / 4));
    const qh = Math.max(1, Math.round(h / 4));
    const ew = Math.max(1, Math.round(w / 8));
    const eh = Math.max(1, Math.round(h / 8));
    const scene = this.target(w, h);
    const q0 = this.target(qw, qh);
    const q1 = this.target(qw, qh);
    const e0 = this.target(ew, eh);
    const e1 = this.target(ew, eh);
    if (!scene || !q0 || !q1 || !e0 || !e1) {
      this.scene = scene;
      this.q = q0 && q1 ? [q0, q1] : null;
      this.e = e0 && e1 ? [e0, e1] : null;
      this.freeTargets();
      for (const t of [q0, q1, e0, e1]) {
        if (t) {
          this.gl.deleteTexture(t.tex);
          this.gl.deleteFramebuffer(t.fbo);
        }
      }
      this.ok = false;
      return false;
    }
    this.scene = scene;
    this.q = [q0, q1];
    this.e = [e0, e1];
    return true;
  }

  /** Bind the scene target (the points draw into it). */
  begin(): boolean {
    if (!this.ok || !this.scene) return false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.w, this.scene.h);
    return true;
  }

  private pass(p: Prog, src: Target, dst: Target | null, setup: (loc: Prog["loc"]) => void, viewW: number, viewH: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, dst ? dst.w : viewW, dst ? dst.h : viewH);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    setup(p.loc);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Bloom + glass composite onto the canvas (drawing buffer viewW x viewH). */
  end(params: PostParams, viewW: number, viewH: number): void {
    const gl = this.gl;
    const { down, blur, comp, scene, q, e, quad } = this;
    if (!down || !blur || !comp || !scene || !q || !e || !quad) return;
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let i = 1; i < 3; i++) gl.disableVertexAttribArray(i);

    // scene -> quarter (bright-weighted), blur; quarter -> eighth, blur.
    this.pass(down, scene, q[0], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uTexel ?? null, 1 / scene.w, 1 / scene.h);
      gl.uniform1f(l.uKnee ?? null, 0.22);
    }, viewW, viewH);
    this.pass(blur, q[0], q[1], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uDir ?? null, 1 / q[0].w, 0);
    }, viewW, viewH);
    this.pass(blur, q[1], q[0], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uDir ?? null, 0, 1 / q[1].h);
    }, viewW, viewH);
    this.pass(down, q[0], e[0], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uTexel ?? null, 0.5 / q[0].w, 0.5 / q[0].h);
      gl.uniform1f(l.uKnee ?? null, 0);
    }, viewW, viewH);
    this.pass(blur, e[0], e[1], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uDir ?? null, 1.4 / e[0].w, 0);
    }, viewW, viewH);
    this.pass(blur, e[1], e[0], (l) => {
      gl.uniform1i(l.uTex ?? null, 0);
      gl.uniform2f(l.uDir ?? null, 0, 1.4 / e[1].h);
    }, viewW, viewH);

    // Composite.
    const n = Math.min(MAX_GLASS, params.glass.length);
    this.glassA.fill(0);
    this.glassB.fill(0);
    for (let i = 0; i < n; i++) {
      const g = params.glass[i]!;
      this.glassA.set([g.x, g.y, g.w, g.h], i * 4);
      this.glassB.set([g.radius, g.tint, g.frost, Math.max(0.0001, g.alpha)], i * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewW, viewH);
    gl.useProgram(comp.program);
    const l = comp.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, q[0].tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, e[0].tex);
    gl.uniform1i(l.uScene ?? null, 0);
    gl.uniform1i(l.uQuarter ?? null, 1);
    gl.uniform1i(l.uEighth ?? null, 2);
    gl.uniform2f(l.uSize ?? null, params.cssW, params.cssH);
    gl.uniform2f(l.uBloom ?? null, params.bloom[0], params.bloom[1]);
    gl.uniform4fv(l["uGlass[0]"] ?? null, this.glassA);
    gl.uniform4fv(l["uShape[0]"] ?? null, this.glassB);
    gl.uniform3f(l.uPointer ?? null, params.pointer[0], params.pointer[1], params.pointer[2]);
    gl.uniform4f(l.uGlassLook ?? null, params.look[0], params.look[1], params.look[2], params.look[3]);
    gl.uniform1f(l.uGlassCap ?? null, params.cap);
    gl.uniform1f(l.uDither ?? null, params.dither ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      this.freeTargets();
      for (const p of [this.down, this.blur, this.comp]) if (p) gl.deleteProgram(p.program);
      if (this.quad) gl.deleteBuffer(this.quad);
    }
    this.scene = null;
    this.q = null;
    this.e = null;
    this.down = null;
    this.blur = null;
    this.comp = null;
    this.quad = null;
    this.ok = false;
  }
}
