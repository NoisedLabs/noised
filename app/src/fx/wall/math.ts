/**
 * Tiny column-major 4x4 matrix helpers for the point wall (no dependency).
 * Layout matches WebGL's uniformMatrix4fv(transpose = false).
 */
export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a * b (apply b first, then a). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function rotationX(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** m * (x, y, z, w) */
export function transform(m: Mat4, x: number, y: number, z: number, w = 1): [number, number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0) * w,
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0) * w,
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0) * w,
    (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 0) * w,
  ];
}

/** General 4x4 inverse (null when singular). */
export function invert(m: Mat4): Mat4 | null {
  const a = (i: number): number => m[i] ?? 0;
  const inv = new Float32Array(16);
  inv[0] = a(5) * a(10) * a(15) - a(5) * a(11) * a(14) - a(9) * a(6) * a(15) + a(9) * a(7) * a(14) + a(13) * a(6) * a(11) - a(13) * a(7) * a(10);
  inv[4] = -a(4) * a(10) * a(15) + a(4) * a(11) * a(14) + a(8) * a(6) * a(15) - a(8) * a(7) * a(14) - a(12) * a(6) * a(11) + a(12) * a(7) * a(10);
  inv[8] = a(4) * a(9) * a(15) - a(4) * a(11) * a(13) - a(8) * a(5) * a(15) + a(8) * a(7) * a(13) + a(12) * a(5) * a(11) - a(12) * a(7) * a(9);
  inv[12] = -a(4) * a(9) * a(14) + a(4) * a(10) * a(13) + a(8) * a(5) * a(14) - a(8) * a(6) * a(13) - a(12) * a(5) * a(10) + a(12) * a(6) * a(9);
  inv[1] = -a(1) * a(10) * a(15) + a(1) * a(11) * a(14) + a(9) * a(2) * a(15) - a(9) * a(3) * a(14) - a(13) * a(2) * a(11) + a(13) * a(3) * a(10);
  inv[5] = a(0) * a(10) * a(15) - a(0) * a(11) * a(14) - a(8) * a(2) * a(15) + a(8) * a(3) * a(14) + a(12) * a(2) * a(11) - a(12) * a(3) * a(10);
  inv[9] = -a(0) * a(9) * a(15) + a(0) * a(11) * a(13) + a(8) * a(1) * a(15) - a(8) * a(3) * a(13) - a(12) * a(1) * a(11) + a(12) * a(3) * a(9);
  inv[13] = a(0) * a(9) * a(14) - a(0) * a(10) * a(13) - a(8) * a(1) * a(14) + a(8) * a(2) * a(13) + a(12) * a(1) * a(10) - a(12) * a(2) * a(9);
  inv[2] = a(1) * a(6) * a(15) - a(1) * a(7) * a(14) - a(5) * a(2) * a(15) + a(5) * a(3) * a(14) + a(13) * a(2) * a(7) - a(13) * a(3) * a(6);
  inv[6] = -a(0) * a(6) * a(15) + a(0) * a(7) * a(14) + a(4) * a(2) * a(15) - a(4) * a(3) * a(14) - a(12) * a(2) * a(7) + a(12) * a(3) * a(6);
  inv[10] = a(0) * a(5) * a(15) - a(0) * a(7) * a(13) - a(4) * a(1) * a(15) + a(4) * a(3) * a(13) + a(12) * a(1) * a(7) - a(12) * a(3) * a(5);
  inv[14] = -a(0) * a(5) * a(14) + a(0) * a(6) * a(13) + a(4) * a(1) * a(14) - a(4) * a(2) * a(13) - a(12) * a(1) * a(6) + a(12) * a(2) * a(5);
  inv[3] = -a(1) * a(6) * a(11) + a(1) * a(7) * a(10) + a(5) * a(2) * a(11) - a(5) * a(3) * a(10) - a(9) * a(2) * a(7) + a(9) * a(3) * a(6);
  inv[7] = a(0) * a(6) * a(11) - a(0) * a(7) * a(10) - a(4) * a(2) * a(11) + a(4) * a(3) * a(10) + a(8) * a(2) * a(7) - a(8) * a(3) * a(6);
  inv[11] = -a(0) * a(5) * a(11) + a(0) * a(7) * a(9) + a(4) * a(1) * a(11) - a(4) * a(3) * a(9) - a(8) * a(1) * a(7) + a(8) * a(3) * a(5);
  inv[15] = a(0) * a(5) * a(10) - a(0) * a(6) * a(9) - a(4) * a(1) * a(10) + a(4) * a(2) * a(9) + a(8) * a(1) * a(6) - a(8) * a(2) * a(5);
  const det = a(0) * (inv[0] ?? 0) + a(1) * (inv[4] ?? 0) + a(2) * (inv[8] ?? 0) + a(3) * (inv[12] ?? 0);
  if (Math.abs(det) < 1e-12) return null;
  for (let i = 0; i < 16; i++) inv[i] = (inv[i] ?? 0) / det;
  return inv;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Small deterministic PRNG (mulberry32) so the wall is identical on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
