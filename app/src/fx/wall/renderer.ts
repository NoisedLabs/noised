/**
 * Raw WebGL renderer for the shield wall: one static vertex buffer, one
 * program, gl.POINTS. `create` returns null when WebGL is unavailable; the
 * caller then shows the static fallback.
 *
 * Shaders compile in the background where the browser supports
 * KHR_parallel_shader_compile: `state` stays "pending" (render is a no-op)
 * until `poll()` sees the program linked, so the main thread never blocks on
 * the driver's compiler (a 200 ms+ freeze on some GPUs, seconds in software).
 * Without the extension it links synchronously.
 */
import type { WallGeometry } from "./geometry";
import type { Mat4 } from "./math";
import { PostFx, type PostParams } from "./post";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders";

type GL = WebGLRenderingContext | WebGL2RenderingContext;
export type Rgb = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

export interface WallFrame {
  mvp: Mat4;
  focal: number;
  time: number;
  intro: number;
  cursor: readonly [number, number, number];
  shift: readonly [number, number];
  mask: Vec4;
  /** Per event: impact xyz + fire time (w < 0 = unused). */
  evA: Float32Array;
  /** Per event: origin xyz + flight time. */
  evB: Float32Array;
  /** Per event: quantum (0/1), user (0/1), seed, unused. */
  evC: Float32Array;
  ink: Rgb;
  ice: Rgb;
  deep: Rgb;
  shot: Rgb;
  hot: Rgb;
  quant: Rgb;
  /** alpha gain, size gain, calm floor behind the headline, glow gain. */
  look: Vec4;
  /** cols, rows, shield radius, curvature. */
  grid: Vec4;
  fog: readonly [number, number];
  keyDir: Rgb;
  rimDir: Rgb;
  camPos: Rgb;
  /** Light pool: centre x, y (CSS px), radius px, floor (alpha outside the pool). */
  spot: Vec4;
  /** Light band: centre x (lattice units), half-width, strength. */
  scan: Rgb;
  /** Dust: bottom y and height of the drift range (lattice units), alpha. */
  dust: Rgb;
  /** Focus distance, depth of field (clip w), max blur (CSS px), fog tint. */
  focus: Vec4;
  /** Top fade from/to, bottom fade from/to (CSS px). */
  fade: Vec4;
  light: boolean;
}

const UNIFORMS = [
  "uMVP",
  "uSize",
  "uDpr",
  "uFocal",
  "uTime",
  "uIntro",
  "uCursor",
  "uShift",
  "uMask",
  "uEvA",
  "uEvB",
  "uEvC",
  "uInk",
  "uIce",
  "uDeep",
  "uShot",
  "uHot",
  "uQuant",
  "uLook",
  "uGrid",
  "uFog",
  "uKeyDir",
  "uRimDir",
  "uCamPos",
  "uSpot",
  "uScan",
  "uDust",
  "uFocus",
  "uFade",
  "uTheme",
] as const;
type UniformName = (typeof UNIFORMS)[number];
const ARRAYS: ReadonlySet<string> = new Set(["uEvA", "uEvB", "uEvC"]);

/** Queue a compile without waiting for it (status is read once the program has linked). */
function compile(gl: GL, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

interface PendingProgram {
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
}

export type RendererState = "pending" | "ready" | "failed";

export class WallRenderer {
  readonly gl: GL;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private loc: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private readonly geometry: WallGeometry;
  private pending: PendingProgram | null = null;
  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private post: PostFx | null = null;
  /** False: no bloom and no WebGL glass (framebuffers unavailable, or switched off). */
  postOn = true;
  /** "pending" while the shaders compile in the background; render() draws nothing until "ready". */
  state: RendererState = "pending";

  private constructor(gl: GL, geometry: WallGeometry) {
    this.gl = gl;
    this.geometry = geometry;
  }

  static create(canvas: HTMLCanvasElement, geometry: WallGeometry): WallRenderer | null {
    const attrs: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "default",
      failIfMajorPerformanceCaveat: false,
    };
    let gl: GL | null = null;
    try {
      gl = canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs);
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const r = new WallRenderer(gl, geometry);
    return r.init() ? r : null;
  }

  /** (Re)creates the GPU resources: on first use and after a context restore. False: WebGL cannot draw. */
  init(): boolean {
    const gl = this.gl;
    this.program = null;
    this.pending = null;
    this.state = "pending";
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return this.fail();
    const program = gl.createProgram();
    if (!program) return this.fail();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.bindAttribLocation(program, 1, "aShield");
    gl.bindAttribLocation(program, 2, "aInfo");
    gl.linkProgram(program);
    this.parallel = (gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null) ?? null;
    if (this.parallel) {
      this.pending = { program, vs, fs };
      return true;
    }
    return this.finish({ program, vs, fs });
  }

  /** Advance a background compile: "ready" once the program has linked (and the buffers are up), "failed" if it did not. */
  poll(): RendererState {
    const p = this.pending;
    if (this.state !== "pending" || !p) return this.state;
    if (this.parallel && !this.gl.isContextLost() && !this.gl.getProgramParameter(p.program, this.parallel.COMPLETION_STATUS_KHR)) return "pending";
    this.pending = null;
    this.finish(p);
    return this.state;
  }

  private fail(): false {
    this.state = "failed";
    return false;
  }

  /** Check the link, then look up the uniforms and upload the vertex buffer. */
  private finish({ program, vs, fs }: PendingProgram): boolean {
    const gl = this.gl;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) {
        console.warn("ShieldWall: program did not link:", gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      return this.fail();
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    this.loc = {};
    for (const name of UNIFORMS) {
      this.loc[name] = gl.getUniformLocation(program, ARRAYS.has(name) ? `${name}[0]` : name);
    }
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.geometry.data, gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    // Bloom + glass: optional; without it the points draw straight to the canvas.
    const post = new PostFx(gl);
    this.post = post.init() ? post : null;
    if (this.post) {
      const canvas = gl.canvas as HTMLCanvasElement;
      if (!this.post.resize(canvas.width, canvas.height)) this.post = null;
    }
    this.state = "ready";
    return true;
  }

  /** Whether frames go through the bloom / glass pipeline. */
  get hasPost(): boolean {
    return this.post !== null && this.post.ok && this.postOn;
  }

  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  /** Size the drawing buffer: CSS size times the (capped) device scale. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.dpr = w / this.cssW;
    this.gl.viewport(0, 0, w, h);
    if (this.post && !this.post.resize(w, h)) this.post = null;
  }

  /** Draw one frame; false when nothing was drawn (still compiling, failed, or the context is lost). */
  render(f: WallFrame, post?: Omit<PostParams, "cssW" | "cssH">): boolean {
    const gl = this.gl;
    if (this.state === "pending") this.poll();
    const program = this.program;
    if (!program || gl.isContextLost()) return false;
    const l = this.loc;
    const u = (name: UniformName): WebGLUniformLocation | null => l[name] ?? null;
    gl.useProgram(program);
    gl.uniformMatrix4fv(u("uMVP"), false, f.mvp);
    gl.uniform2f(u("uSize"), this.cssW, this.cssH);
    gl.uniform1f(u("uDpr"), this.dpr);
    gl.uniform1f(u("uFocal"), f.focal);
    gl.uniform1f(u("uTime"), f.time);
    gl.uniform1f(u("uIntro"), f.intro);
    gl.uniform3f(u("uCursor"), f.cursor[0], f.cursor[1], f.cursor[2]);
    gl.uniform2f(u("uShift"), f.shift[0], f.shift[1]);
    gl.uniform4f(u("uMask"), ...f.mask);
    gl.uniform4fv(u("uEvA"), f.evA);
    gl.uniform4fv(u("uEvB"), f.evB);
    gl.uniform4fv(u("uEvC"), f.evC);
    gl.uniform3f(u("uInk"), ...f.ink);
    gl.uniform3f(u("uIce"), ...f.ice);
    gl.uniform3f(u("uDeep"), ...f.deep);
    gl.uniform3f(u("uShot"), ...f.shot);
    gl.uniform3f(u("uHot"), ...f.hot);
    gl.uniform3f(u("uQuant"), ...f.quant);
    gl.uniform4f(u("uLook"), ...f.look);
    gl.uniform4f(u("uGrid"), ...f.grid);
    gl.uniform2f(u("uFog"), f.fog[0], f.fog[1]);
    gl.uniform3f(u("uKeyDir"), ...f.keyDir);
    gl.uniform3f(u("uRimDir"), ...f.rimDir);
    gl.uniform3f(u("uCamPos"), ...f.camPos);
    gl.uniform4f(u("uSpot"), ...f.spot);
    gl.uniform3f(u("uScan"), ...f.scan);
    gl.uniform3f(u("uDust"), ...f.dust);
    gl.uniform4f(u("uFocus"), ...f.focus);
    gl.uniform4f(u("uFade"), ...f.fade);
    gl.uniform1f(u("uTheme"), f.light ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16);
    }
    // Dark: light adds up (glow). Light: premultiplied "over" with dark ink.
    if (f.light) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    const canvas = gl.canvas as HTMLCanvasElement;
    const viaPost = post !== undefined && this.hasPost && this.post!.begin();
    if (!viaPost) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, this.geometry.count);
    if (viaPost) this.post!.end({ ...post, cssW: this.cssW, cssH: this.cssH }, canvas.width, canvas.height);
    return true;
  }

  /** Frees the GPU resources; the context itself goes with the canvas. */
  dispose(): void {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      if (this.pending) {
        gl.deleteShader(this.pending.vs);
        gl.deleteShader(this.pending.fs);
        gl.deleteProgram(this.pending.program);
      }
      if (this.program) gl.deleteProgram(this.program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      this.post?.dispose();
      // The context itself is not force-lost: React StrictMode remounts on the
      // same canvas, and getContext would hand back the lost context.
    }
    this.pending = null;
    this.program = null;
    this.buffer = null;
    this.post = null;
  }
}
