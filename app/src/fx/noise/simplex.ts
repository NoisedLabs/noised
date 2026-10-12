/**
 * 3D simplex noise (after Stefan Gustavson's public-domain reference) and a 2D curl field built from it. The third
 * axis is time, so `curl2(x, y, t)` is a smoothly evolving, divergence-free flow: neighbouring dots swirl together
 * like static on a quiet screen instead of jittering independently.
 *
 *   const n = simplex(seed);
 *   n.noise3(x, y, t);          // -1..1
 *   n.curl2(x, y, t, out);      // out[0], out[1]: the flow at (x, y) at time t (roughly -1..1)
 */
import { rng } from "./rng";

const F3 = 1 / 3;
const G3 = 1 / 6;

/** The 12 edge midpoints of a cube (Gustavson's gradient set). */
const GRAD3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);

export interface Simplex {
  /** Noise at (x, y, z), in -1..1. */
  noise3(x: number, y: number, z: number): number;
  /** The curl of the noise potential at (x, y) at time t, written to out[0..1]. */
  curl2(x: number, y: number, t: number, out: Float32Array | number[]): void;
}

export function simplex(seed = 1): Simplex {
  const rand = rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]!;
    permMod12[i] = perm[i]! % 12;
  }

  const noise3 = (xin: number, yin: number, zin: number): number => {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    // The simplex corner order (no allocation: this runs thousands of times a frame).
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    let i2 = 0;
    let j2 = 0;
    let k2 = 0;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        i2 = 1;
        j2 = 1;
      } else if (x0 >= z0) {
        i1 = 1;
        i2 = 1;
        k2 = 1;
      } else {
        k1 = 1;
        i2 = 1;
        k2 = 1;
      }
    } else if (y0 < z0) {
      k1 = 1;
      j2 = 1;
      k2 = 1;
    } else if (x0 < z0) {
      j1 = 1;
      j2 = 1;
      k2 = 1;
    } else {
      j1 = 1;
      i2 = 1;
      j2 = 1;
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]!]!]! * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g]! * x0 + GRAD3[g + 1]! * y0 + GRAD3[g + 2]! * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]! * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g]! * x1 + GRAD3[g + 1]! * y1 + GRAD3[g + 2]! * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]! * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g]! * x2 + GRAD3[g + 1]! * y2 + GRAD3[g + 2]! * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]! * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g]! * x3 + GRAD3[g + 1]! * y3 + GRAD3[g + 2]! * z3);
    }
    return 32 * n;
  };

  const E = 0.08;
  const curl2 = (x: number, y: number, t: number, out: Float32Array | number[]): void => {
    // v = (dpsi/dy, -dpsi/dx): a divergence-free flow (no sinks, no sources), by central differences.
    const dy = noise3(x, y + E, t) - noise3(x, y - E, t);
    const dx = noise3(x + E, y, t) - noise3(x - E, y, t);
    out[0] = dy / (2 * E) / 4;
    out[1] = -dx / (2 * E) / 4;
  };

  return { noise3, curl2 };
}
