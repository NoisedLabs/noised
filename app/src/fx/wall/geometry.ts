/**
 * Point-cloud geometry for the shield wall (the v2 hero wall, restored for v5).
 *
 * The wall is one triangular dot lattice (spacing 1, columns vertical) cut
 * into overlapping pointy-top hex shields. Every lattice dot belongs to the
 * front-most shield that covers it (upper rows overlap the row below, like
 * scale armour; within a row the right-hand shield overlaps its neighbour),
 * so the union of all shields is exactly the lattice.
 *
 * After the wall come the effect pools: per shot slot a streak (tracer
 * particles), a shower of sparks (a "quantum" shot uses all of them and
 * shatters; an ordinary one only part) and one impact flash; then the dust
 * that drifts in the light in front of the wall. All motion happens in the
 * vertex shader; these buffers are static.
 *
 * Attribute layout (3 x vec4, 12 floats per point):
 *   aPos    wall: lattice x, y, 0, occlusion   fx: random vector xyz, 0
 *           (occlusion: 1 right under the rim of an overlapping shield, 0.5 one dot further, else 0)
 *   aShield wall: shield centre x, y, col, row fx: slot, param, life, seed
 *           dust: speed, size, phase, 0 (aPos = start position)
 *   aInfo   x: ring (0 centre .. 1 rim), y: kind (0 wall, 1 streak, 2 spark, 3 flash, 4 dust),
 *           z: random 0..1, w: flag (0 face, 1 rim, 2 boss, 3 emblem ring)
 */
import { rng } from "./math";

export const KIND_WALL = 0;
export const KIND_STREAK = 1;
export const KIND_SPARK = 2;
export const KIND_FLASH = 3;
export const KIND_DUST = 4;

/** Shots in flight (or still sparking) at once. */
export const MAX_EVENTS = 5;
const STREAK_POINTS = 120;
const SPARK_POINTS = 300;
const DUST_POINTS = 720;

export interface WallSpec {
  /** Hex radius of one shield, in lattice steps. */
  radius: number;
  /** Horizontal centre spacing parameter: neighbours sit 2*m lattice steps apart (overlap when radius > m). */
  m: number;
  /** Extra vertical overlap between rows, in lattice steps. */
  v: number;
  cols: number;
  rows: number;
}

export const DEFAULT_WALL: WallSpec = { radius: 11, m: 10, v: 2, cols: 16, rows: 7 };

export interface Shield {
  x: number;
  y: number;
  col: number;
  row: number;
}

export interface WallGeometry {
  /** 12 floats per point (see the attribute layout above). */
  data: Float32Array;
  count: number;
  wallCount: number;
  shields: Shield[];
  /** Wall-local bounds of the lattice. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  spec: WallSpec;
}

const SQ3_2 = Math.sqrt(3) / 2;

/** Hex distance between two axial offsets of the lattice (neighbours: (±1,0), (0,±1), ±(1,-1)). */
function hexDist(da: number, db: number): number {
  return (Math.abs(da) + Math.abs(db) + Math.abs(da + db)) / 2;
}

/** Axial lattice coordinates to wall-local Cartesian (x right, y up). */
function toXY(a: number, b: number): [number, number] {
  return [b * SQ3_2, a + b / 2];
}

let cached: WallGeometry | null = null;

/** The default wall, built once per page (the geometry is deterministic). */
export function defaultWall(): WallGeometry {
  cached ??= buildWall();
  return cached;
}

export function buildWall(spec: WallSpec = DEFAULT_WALL, seed = 7): WallGeometry {
  const { radius: n, m, v, cols, rows } = spec;
  const random = rng(seed);

  // Shield centres on the lattice: brick pattern, rows pulled together by v.
  // Row-major order, so a larger index is further in front (upper row first,
  // then right-most), which is the overlap order.
  const centres: { a: number; b: number; col: number; row: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const k = col - Math.floor(row / 2);
      // k * (-m, 2m) moves right by m*sqrt(3); row * (m - v, m) moves up-right by half a shield.
      centres.push({ a: -k * m + row * (m - v), b: 2 * k * m + row * m, col, row });
    }
  }

  // Owner of every covered lattice dot (index + 1, 0 = empty) on a dense grid:
  // the front-most shield wins.
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (const c of centres) {
    a0 = Math.min(a0, c.a - n - 2);
    a1 = Math.max(a1, c.a + n + 2);
    b0 = Math.min(b0, c.b - n - 2);
    b1 = Math.max(b1, c.b + n + 2);
  }
  const gw = b1 - b0 + 1;
  const owner = new Int32Array((a1 - a0 + 1) * gw);
  const cell = (a: number, b: number): number => (a - a0) * gw + (b - b0);
  centres.forEach((c, i) => {
    for (let da = -n; da <= n; da++) {
      for (let db = -n; db <= n; db++) {
        if (hexDist(da, db) > n) continue;
        const k = cell(c.a + da, c.b + db);
        if ((owner[k] ?? 0) < i + 1) owner[k] = i + 1;
      }
    }
  });

  // Centre the wall on the origin.
  let sx = 0;
  let sy = 0;
  for (const c of centres) {
    const [x, y] = toXY(c.a, c.b);
    sx += x;
    sy += y;
  }
  const ox = sx / centres.length;
  const oy = sy / centres.length;

  const shields: Shield[] = centres.map((c) => {
    const [x, y] = toXY(c.a, c.b);
    return { x: x - ox, y: y - oy, col: c.col, row: c.row };
  });

  // Occlusion: a dot next to a dot of a shield in front sits in that shield's shadow.
  const NEIGHBOURS: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, -1],
    [-1, 1],
  ];
  const shadowed = (a: number, b: number, mine: number, reach: number): boolean => {
    for (const [da, db] of NEIGHBOURS) {
      for (let r = 1; r <= reach; r++) {
        if ((owner[cell(a + da * r, b + db * r)] ?? 0) > mine) return true;
      }
    }
    return false;
  };

  const emblem = Math.round(n * 0.55);
  const wallPoints: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let a = a0; a <= a1; a++) {
    for (let b = b0; b <= b1; b++) {
      const own = owner[cell(a, b)] ?? 0;
      if (own === 0) continue;
      const i = own - 1;
      const c = centres[i];
      const s = shields[i];
      if (!c || !s) continue;
      const [x0, y0] = toXY(a, b);
      const x = x0 - ox;
      const y = y0 - oy;
      const hd = hexDist(a - c.a, b - c.b);
      const flag = hd === n ? 1 : hd <= 1 ? 2 : hd === emblem ? 3 : 0;
      const occlusion = shadowed(a, b, own, 1) ? 1 : shadowed(a, b, own, 2) ? 0.5 : 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      wallPoints.push(x, y, 0, occlusion, s.x, s.y, c.col, c.row, hd / n, KIND_WALL, random(), flag);
    }
  }

  const fxPoints: number[] = [];
  const unit = (): [number, number, number] => {
    // Uniform on the unit sphere.
    const z = random() * 2 - 1;
    const t = random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(t), r * Math.sin(t), z];
  };
  for (let slot = 0; slot < MAX_EVENTS; slot++) {
    for (let i = 0; i < STREAK_POINTS; i++) {
      const [x, y, z] = unit();
      const j = Math.sqrt(random());
      // Dense near the head (s = 0), thinning along the tail.
      const s = Math.pow(i / (STREAK_POINTS - 1), 1.35);
      fxPoints.push(x * j, y * j, z * j, 0, slot, s, 0, random(), 0, KIND_STREAK, random(), 0);
    }
    for (let i = 0; i < SPARK_POINTS; i++) {
      const [x, y, z] = unit();
      const speed = 0.25 + Math.pow(random(), 1.6) * 0.95;
      const life = 0.45 + random() * 1.1;
      fxPoints.push(x, y, z, 0, slot, speed, life, random(), 0, KIND_SPARK, random(), 0);
    }
    fxPoints.push(0, 0, 0, 0, slot, 0, 0, 0, 0, KIND_FLASH, 0, 0);
  }
  // Dust in the light, in front of the wall.
  for (let i = 0; i < DUST_POINTS; i++) {
    const x = (minX + (maxX - minX) * random()) * 0.92;
    const y = minY - 12 + (maxY - minY + 24) * random();
    const z = 4 + Math.pow(random(), 0.7) * 64;
    const speed = 0.4 + random() * 1.5;
    const size = 0.7 + Math.pow(random(), 2) * 1.8;
    fxPoints.push(x, y, z, 0, speed, size, random() * Math.PI * 2, 0, 0, KIND_DUST, random(), 0);
  }

  const data = new Float32Array(wallPoints.length + fxPoints.length);
  data.set(wallPoints, 0);
  data.set(fxPoints, wallPoints.length);
  return {
    data,
    count: data.length / 12,
    wallCount: wallPoints.length / 12,
    shields,
    minX,
    maxX,
    minY,
    maxY,
    spec,
  };
}
