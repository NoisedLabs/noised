/**
 * The background light renderer: one fixed WebGL canvas behind the whole app (GLASS_V51 section 1: 2-3 very soft
 * white / gray light pools on graphite, peak opacity <= 8%, slowly drifting; white pools on Paper).
 *
 *   const aurora = createAurora(canvas, { onReady });   // null when WebGL is unavailable (the CSS fallback stays)
 *   aurora.setStill(true);                               // reduced motion / animations off: one still frame
 *   aurora.destroy();
 *
 * Cost control: the canvas is drawn at a third of the viewport's CSS size (never more than 640 x 400 pixels,
 * whatever the device pixel ratio), at most 30 times a second (the drift is 40-80 s slow, so 30 fps reads exactly
 * like 60), and not at all while the tab is hidden. Colours come from CSS variables (--aurora-*), re-read on
 * every palette / theme change.
 * v6 (PIXEL_V6): --aurora-dither (1 = ordered-dither the light into square pixels, 0 = smooth) and
 * --aurora-levels (steps per pool). When dithering, one canvas pixel covers exactly --aurora-pixel CSS px (an integer,
 * default 3; larger on very wide screens) and the canvas is shown pixelated (aurora.css [data-dither]).
 */
import { PALETTE_EVENT } from "../../app/settings";
import { AURORA_FRAG, AURORA_VERT } from "./shader";

export interface AuroraRenderer {
  setStill(still: boolean): void;
  destroy(): void;
}

interface Palette {
  bg: [number, number, number];
  c: [number, number, number][];
  alpha: [number, number, number, number];
  vignette: number;
  dither: number;
  levels: number;
  pixel: number;
}

const FRAME_MS = 1000 / 30;
const MAX_W = 640;
const MAX_H = 400;
const SCALE = 1 / 3;
/** Start the clock part-way through the loops: the first frame is already a balanced composition. */
const T0 = 14;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** "#rrggbb" / "#rgb" / "rgb(r g b)" / "rgb(r, g, b)" -> 0..1 floats; anything else -> the fallback. */
function parseColor(text: string, fallback: [number, number, number]): [number, number, number] {
  const v = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [Number.parseInt(h.slice(0, 2), 16) / 255, Number.parseInt(h.slice(2, 4), 16) / 255, Number.parseInt(h.slice(4, 6), 16) / 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (rgb?.[1] && rgb[2] && rgb[3]) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  return fallback;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string): string => cs.getPropertyValue(name);
  const alpha = get("--aurora-alpha")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const vignette = Number.parseFloat(get("--aurora-vignette"));
  const dither = Number.parseFloat(get("--aurora-dither"));
  const levels = Number.parseFloat(get("--aurora-levels"));
  const pixel = Number.parseFloat(get("--aurora-pixel"));
  return {
    bg: parseColor(get("--aurora-bg"), [0.027, 0.027, 0.027]),
    c: [
      parseColor(get("--aurora-1"), [1, 1, 1]),
      parseColor(get("--aurora-2"), [0.85, 0.85, 0.85]),
      parseColor(get("--aurora-3"), [0.95, 0.95, 0.95]),
      parseColor(get("--aurora-4"), [0.75, 0.75, 0.75]),
    ],
    alpha: [alpha[0] ?? 0.075, alpha[1] ?? 0.05, alpha[2] ?? 0.06, alpha[3] ?? 0],
    vignette: Number.isFinite(vignette) ? vignette : 0.5,
    dither: Number.isFinite(dither) ? dither : 0,
    levels: Number.isFinite(levels) && levels >= 1 ? levels : 5,
    pixel: Number.isFinite(pixel) && pixel >= 1 ? Math.round(pixel) : 3,
  };
}

export function createAurora(canvas: HTMLCanvasElement, { onReady }: { onReady?: () => void } = {}): AuroraRenderer | null {
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let u: Record<string, WebGLUniformLocation | null> = {};

  const init = (): boolean => {
    if (!gl) return false;
    const vs = compile(gl, gl.VERTEX_SHADER, AURORA_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, AURORA_FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return false;
    }
    program = prog;
    gl.useProgram(prog);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle that covers the whole viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    u = {};
    for (const name of ["uRes", "uTime", "uPointer", "uScroll", "uBg", "uC0", "uC1", "uC2", "uC3", "uAlpha", "uVignette", "uDither", "uLevels"]) {
      u[name] = gl.getUniformLocation(prog, name);
    }
    return true;
  };

  if (!init()) return null;

  let palette = readPalette();
  let still = false;
  let raf = 0;
  let last = 0;
  let clock = T0;
  let lastNow = 0;
  let lost = false;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  // The scroll position and the viewport size are read in passive scroll / resize listeners, never inside the frame
  // callback (reading layout there forces the browser to finish its style work at once, every frame).
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  let scrollTarget = window.scrollY / Math.max(1, vh);
  let scroll = scrollTarget;
  let first = true;

  const resize = (): void => {
    if (palette.dither >= 0.5) {
      // Dithered: an integer number of CSS px per canvas pixel, so every dither dot is a crisp square.
      const k = Math.max(palette.pixel, Math.ceil(vw / MAX_W), Math.ceil(vh / MAX_H));
      const w = Math.max(16, Math.ceil(vw / k));
      const h = Math.max(16, Math.ceil(vh / k));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const cw = `${w * k}px`;
      const ch = `${h * k}px`;
      if (canvas.style.width !== cw) canvas.style.width = cw;
      if (canvas.style.height !== ch) canvas.style.height = ch;
      canvas.dataset.dither = "true";
      return;
    }
    const w = Math.max(64, Math.min(MAX_W, Math.round(vw * SCALE)));
    const h = Math.max(64, Math.min(MAX_H, Math.round(vh * SCALE)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.removeProperty("width");
    canvas.style.removeProperty("height");
    delete canvas.dataset.dither;
  };

  const draw = (): void => {
    if (!gl || !program || lost) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.uRes ?? null, canvas.width, canvas.height);
    gl.uniform1f(u.uTime ?? null, clock);
    gl.uniform2f(u.uPointer ?? null, pointer.x, pointer.y);
    gl.uniform1f(u.uScroll ?? null, scroll);
    gl.uniform3f(u.uBg ?? null, ...palette.bg);
    gl.uniform3f(u.uC0 ?? null, ...(palette.c[0] ?? [1, 1, 1]));
    gl.uniform3f(u.uC1 ?? null, ...(palette.c[1] ?? [0.85, 0.85, 0.85]));
    gl.uniform3f(u.uC2 ?? null, ...(palette.c[2] ?? [0.95, 0.95, 0.95]));
    gl.uniform3f(u.uC3 ?? null, ...(palette.c[3] ?? [0.75, 0.75, 0.75]));
    gl.uniform4f(u.uAlpha ?? null, ...palette.alpha);
    gl.uniform1f(u.uVignette ?? null, palette.vignette);
    gl.uniform1f(u.uDither ?? null, palette.dither >= 0.5 ? 1 : 0);
    gl.uniform1f(u.uLevels ?? null, palette.levels);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (first) {
      first = false;
      onReady?.();
    }
  };

  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME_MS - 2) return;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    last = now;
    clock += dt;
    // Pointer lean and scroll turn ease in (about half a second to settle).
    const k = 1 - Math.pow(0.04, dt);
    pointer.x += (pointer.tx - pointer.x) * k;
    pointer.y += (pointer.ty - pointer.y) * k;
    scroll += (scrollTarget - scroll) * (1 - Math.pow(0.02, dt));
    draw();
  };

  const start = (): void => {
    if (raf || still || lost || document.hidden) return;
    last = 0;
    lastNow = 0;
    raf = requestAnimationFrame(tick);
  };
  const stop = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onPointer = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    pointer.tx = (e.clientX / Math.max(1, vw)) * 2 - 1;
    pointer.ty = (e.clientY / Math.max(1, vh)) * 2 - 1;
  };
  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  const onPalette = (): void => {
    palette = readPalette();
    if (!raf) draw();
  };
  const onResize = (): void => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    if (!raf) draw();
  };
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    stop();
  };
  const onRestored = (): void => {
    lost = false;
    if (init()) {
      draw();
      start();
    }
  };

  const onScroll = (): void => {
    scrollTarget = window.scrollY / Math.max(1, vh);
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener(PALETTE_EVENT, onPalette);
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  draw();
  start();

  return {
    setStill(next: boolean): void {
      still = next;
      if (still) {
        stop();
        draw();
      } else {
        start();
      }
    },
    destroy(): void {
      stop();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener(PALETTE_EVENT, onPalette);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (gl && program) gl.deleteProgram(program);
      if (gl && buffer) gl.deleteBuffer(buffer);
      program = null;
      buffer = null;
    },
  };
}
