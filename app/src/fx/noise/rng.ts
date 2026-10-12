/**
 * Seeded randomness for the noise engine: every point set, scatter and jitter is a pure function of a seed, so a
 * scene looks the same on every load (and the tests can pin it).
 *
 *   const rand = rng(42);
 *   rand();                 // 0..1, the same sequence for the same seed
 *   seedOf("why-shield");   // a stable 32-bit seed from a string
 */

/** mulberry32: a small, fast, well-mixed 32-bit generator. Returns numbers in [0, 1). */
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

/** FNV-1a: a stable 32-bit seed from a string. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fisher-Yates on an index array, driven by `rand` (deterministic). */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}
