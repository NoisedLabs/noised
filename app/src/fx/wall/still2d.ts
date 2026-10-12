/**
 * The shield wall as one still frame on a 2D canvas: the fallback when WebGL
 * is unavailable. Same geometry, same camera and the same light as the WebGL
 * still frame (minus the effects), drawn once per resize or theme change.
 * Dots are batched by colour and brightness bucket: a few dozen fills, not
 * one per dot.
 */
import { baseShiftY, framingFor, wallCamera, type Framing } from "./engine";
import { defaultWall } from "./geometry";
import { transform } from "./math";

const BUCKETS = 14;

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface StillOptions {
  /** CSS px of the canvas. */
  width: number;
  height: number;
  dpr: number;
  /** Dot colours (CSS colour strings): base ink and the ice accent. */
  ink: string;
  ice: string;
  light: boolean;
  /** The headline block in canvas CSS px (dots are calmer behind it), if any. */
  calm?: DOMRect | null;
  /** The navbar's bottom edge in canvas CSS px (the wall fades in below it). */
  topInset?: number;
  framing?: Partial<Framing>;
}

/** Draws the wall; false when the canvas has no 2D context. */
export function drawStillWall(canvas: HTMLCanvasElement, o: StillOptions): boolean {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return false;
  const w = Math.max(1, o.width);
  const h = Math.max(1, o.height);
  canvas.width = Math.round(w * o.dpr);
  canvas.height = Math.round(h * o.dpr);
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const f = framingFor(w, h, o.framing);
  const cam = wallCamera(f, w, h);
  const shiftX = f.shiftX;
  const shiftY = baseShiftY(f, w, h);
  const geometry = defaultWall();
  const R = geometry.spec.radius;
  const data = geometry.data;
  const wide = f.centerYW !== undefined;
  const spot = [f.spot[0] * w, wide ? f.spot[1] * w : f.spot[1] * h, f.spot[2] * (wide ? w : Math.max(w, h)), f.spot[3]] as const;
  // Light directions in wall space (the WebGL still frame's swing).
  const toLocal = (x: number, y: number, z: number): [number, number, number] => {
    if (!cam.invModel) return [x, y, z];
    const d = transform(cam.invModel, x, y, z, 0);
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  const key = toLocal(-0.56, 0.76, 0.56);
  const top = o.topInset ?? 0;
  const tilt = -0.24;

  // Two colour families x BUCKETS brightness levels, each one path.
  const paths: Path2D[][] = [Array.from({ length: BUCKETS }, () => new Path2D()), Array.from({ length: BUCKETS }, () => new Path2D())];
  for (let i = 0; i < geometry.wallCount; i++) {
    const b = i * 12;
    const px0 = data[b]!;
    const py0 = data[b + 1]!;
    const occ = data[b + 3]!;
    const cxs = data[b + 4]!;
    const cys = data[b + 5]!;
    const col = data[b + 6]!;
    const row = data[b + 7]!;
    const rnd = data[b + 10]!;
    const flag = data[b + 11]!;
    const ux = px0 - cxs;
    const uy = py0 - cys;
    const rr = (ux * ux + uy * uy) / (R * R);
    const h2 = hash(row + 3.1, col + 1.7);
    const t2 = tilt + (h2 - 0.5) * 0.1;
    const c2 = Math.cos(t2);
    const s2 = Math.sin(t2);
    // Dome point and normal, tilted about x.
    const lz = 3.2 * (1 - rr);
    const y1 = c2 * uy - s2 * lz;
    const z1 = s2 * uy + c2 * lz;
    let nx = (6.4 * ux) / (R * R);
    let ny = (6.4 * uy) / (R * R);
    let nz = 1;
    const ny1 = c2 * ny - s2 * nz;
    const nz1 = s2 * ny + c2 * nz;
    ny = ny1;
    nz = nz1;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const x = cxs + ux;
    const y = cys + y1;
    const z = row * 0.9 + z1 - f.curve * x * x;

    const c = transform(cam.mvp, x, y, z, 1);
    if (c[3] < 1) continue;
    const sx = ((c[0] / c[3] + shiftX + 1) / 2) * w;
    const sy = ((1 - (c[1] / c[3] + shiftY)) / 2) * h;
    if (sx < -4 || sy < -4 || sx > w + 4 || sy > h + 4) continue;

    const diff = Math.max(0, nx * key[0] + ny * key[1] + nz * key[2]);
    const isRim = flag === 1 ? 1 : 0;
    const isBoss = flag === 2 ? 1 : 0;
    const isRing = flag === 3 ? 1 : 0;
    const face = 1 - Math.max(isRim, isBoss);
    const under = Math.min(1, Math.max(0, -ny * 2.6 - 0.12));
    const rimL = under * under * 0.8;
    let I = 0.03 + 0.4 * diff * diff;
    I += isRim * (0.32 + 0.6 * diff) + isBoss * (0.38 + 0.5 * diff) + isRing * 0.08 * diff + rimL * 0.42;
    I *= 1 - 0.85 * occ * face;
    I *= 0.8 + 0.4 * rnd;
    const fog = 1 - smooth(f.fogNear, f.fogFar, c[3]);
    const dx = sx - spot[0];
    const dy = sy - spot[1];
    let a = I * fog * (spot[3] + (1 - spot[3]) * Math.exp(-(dx * dx + dy * dy) / (spot[2] * spot[2])));
    if (o.calm) {
      const qx = (sx - (o.calm.left + o.calm.width / 2)) / (o.calm.width * 0.525);
      const qy = (sy - (o.calm.top + o.calm.height / 2)) / (o.calm.height * 0.525);
      a *= 0.16 + 0.84 * smooth(0.6, 1.2, Math.hypot(qx, qy));
    }
    a *= smooth(Math.max(0, top - 24), top + 90, sy) * (1 - smooth(h * 0.8, h * 0.995, sy));
    a *= f.alpha * (o.light ? 1.15 : 1);
    if (a < 0.01) continue;
    const size = (0.66 + isRim * 0.46 + isBoss * 0.62) * 0.42 * (cam.focal / c[3]);
    const d = Math.max(0.8, size);
    const level = Math.min(BUCKETS - 1, Math.floor(Math.min(1, a) * BUCKETS));
    const fam = rimL > 0.35 ? 1 : 0;
    paths[fam]![level]!.rect(sx - d / 2, sy - d / 2, d, d);
  }
  ctx.globalCompositeOperation = o.light ? "source-over" : "lighter";
  for (let fam = 0; fam < 2; fam++) {
    ctx.fillStyle = fam === 1 ? o.ice : o.ink;
    for (let level = 0; level < BUCKETS; level++) {
      ctx.globalAlpha = (level + 0.5) / BUCKETS;
      ctx.fill(paths[fam]![level]!);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return true;
}
