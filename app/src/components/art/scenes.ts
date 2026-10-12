/**
 * The "signal from noise" scenes outside the home page (fx/noise): the inner pages' header art, the token coin, the
 * launch-mode and fee-destination cards, and the small glyphs on step, link and empty-state cards. Each is a few
 * simple vector shapes (art/shapes.ts) that a cloud of drifting dots coalesces into, holds, and releases.
 *
 *   Page art (4:3)   create    a coin turning slowly over a hairline pad
 *                    vault     a vault door: its dial turns, then the bolts slide out
 *                    privacy   a balance that dissolves into noise and comes back as four dots
 *                    security  three programs, checked one by one, then a shield with a check
 *                    verify    a coin with a hairline scan passing over it, then a check
 *   Glyphs (square)  phrase, deposit, key, wrap, hide, unwrap, book, paper, letter, courier, agent
 *   Cards            quick / custom (launch modes), wallet / token / split (fee destinations)
 */
import { circle, ellipse, line, parsePath, rect, roundRect, shape, type NoiseScene, type SceneStep } from "../../fx/noise";
import { privateScene } from "../landing/noise/safe";
import { addCheck, addCoin, addShield, place } from "./shapes";

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (v: number): number => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

// -------------------------------------------------------------- page art ---

const PW = 120;
const PH = 90;
const page = { pad: 0.05 } as const;

function createArt(): NoiseScene {
  const s = shape(PW, PH);
  addCoin(s, 60, 38, 23, { group: 1 });
  const form = 1.7;
  return {
    id: "page-create",
    ...page,
    steps: [
      {
        shape: s.build(),
        form,
        hold: 6,
        release: 1.3,
        rest: 0.6,
        // Once formed, the coin shows its face, then turns once about its vertical axis, unhurried.
        transform: (g, lt) => (g === 1 ? { scaleX: Math.cos(easeInOut((lt - form - 2.2) / 1.8) * Math.PI * 2), cx: 60, cy: 38 } : null),
        accents: (pen, _lt, k) => {
          pen.poly([...ellipse(60, 76, 32, 5).pts], 0.22 * k, true);
          pen.poly([...ellipse(60, 76, 20, 3).pts], 0.14 * k, true);
        },
      },
    ],
  };
}

function vaultArt(): NoiseScene {
  const s = shape(PW, PH);
  s.stroke(roundRect(22, 8, 66, 66, 5), { weight: 1.1 });
  s.stroke(roundRect(28, 14, 54, 54, 3), { weight: 0.4 });
  s.stroke([line(19, 20, 19, 31), line(19, 51, 19, 62)], { weight: 1.2 });
  const cx = 55;
  const cy = 41;
  s.stroke(circle(cx, cy, 16), { weight: 1, group: 1 });
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ticks.push(line(cx + Math.cos(a) * 11.5, cy + Math.sin(a) * 11.5, cx + Math.cos(a) * 14, cy + Math.sin(a) * 14));
  }
  s.stroke(ticks, { weight: 0.9, group: 1 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    s.stroke(line(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3, cx + Math.cos(a) * 9, cy + Math.sin(a) * 9), { weight: 1.2, group: 1 });
  }
  s.stroke([line(88, 22, 97, 22), line(88, 41, 97, 41), line(88, 60, 97, 60)], { weight: 1.6, group: 2 });
  const form = 1.7;
  return {
    id: "page-vault",
    ...page,
    still: { step: 0, at: 4 },
    steps: [
      {
        shape: s.build(),
        form,
        hold: 5.4,
        release: 1.3,
        rest: 0.6,
        transform: (g, lt) => {
          const q = lt - form;
          if (g === 1) return { rotate: ((110 * easeInOut(q / 1.3) - 70 * easeInOut((q - 1.6) / 1) + 25 * easeInOut((q - 2.8) / 0.6)) * Math.PI) / 180, cx, cy };
          // The bolts slide out once the dial has stopped.
          if (g === 2) return { dx: -8 * (1 - easeInOut((q - 3.6) / 0.5)) };
          return null;
        },
      },
    ],
  };
}

function securityArt(): NoiseScene {
  const rows = shape(PW, PH);
  for (let i = 0; i < 3; i++) {
    rows.stroke(roundRect(20, 14 + i * 22, 80, 15, 3), { weight: 1 });
    rows.stroke(line(27, 21.5 + i * 22, 58 - i * 8, 21.5 + i * 22), { weight: 0.5 });
    rows.stroke(circle(91, 21.5 + i * 22, 3.6, 24), { weight: 1 });
  }
  const sh = shape(PW, PH);
  addShield(sh, 60, 8, 56, 74, { fill: false });
  addCheck(sh, 60, 40, 12, { ring: false });
  return {
    id: "page-security",
    ...page,
    still: { step: 1, at: 1 },
    steps: [
      // Programs checked one by one, top to bottom.
      { shape: rows.build(), form: 1.8, hold: 2.6, release: 1.1, rest: 0.4, order: (p) => clamp01(((p.y - 14) / 66) * 0.85 + p.rand * 0.15) },
      { shape: sh.build(), form: 1.4, hold: 3.6, release: 1.2, rest: 0.5 },
    ],
  };
}

function verifyArt(): NoiseScene {
  const coin = shape(PW, PH);
  addCoin(coin, 60, 44, 26);
  const ok = shape(PW, PH);
  addCheck(ok, 60, 44, 28);
  const form = 1.5;
  const scan: SceneStep = {
    shape: coin.build(),
    form,
    hold: 3.2,
    release: 1.1,
    rest: 0.4,
    // A hairline scan passes over the coin while it holds.
    accents: (pen, lt, k) => {
      const q = (lt - form - 0.2) / 2.4;
      if (q <= 0 || q >= 1) return;
      const x = 28 + easeInOut(q) * 64;
      const fade = Math.sin(q * Math.PI);
      pen.line(x, 10, x, 78, 0.5 * fade * k);
    },
  };
  return { id: "page-verify", ...page, still: { step: 1, at: 1 }, steps: [scan, { shape: ok.build(), form: 1.3, hold: 3.4, release: 1.2, rest: 0.5 }] };
}

const PAGE_SCENES = { create: createArt, vault: vaultArt, privacy: privateScene, security: securityArt, verify: verifyArt, docs: docsShieldArt } as const;
export type PageScene = keyof typeof PAGE_SCENES;

/** One scene per name, made once (scenes hold no per-canvas state). */
const pageCache = new Map<PageScene, NoiseScene>();
export function pageScene(name: PageScene): NoiseScene {
  let s = pageCache.get(name);
  if (!s) {
    s = PAGE_SCENES[name]();
    pageCache.set(name, s);
  }
  return s;
}

/** The docs home banner: a shield, centred, that noise streaks in at and bounces off. */
function docsShieldArt(): NoiseScene {
  const s = shape(160, 100);
  addShield(s, 80, 8, 58, 80);
  return {
    id: "docs-shield",
    pad: 0.08,
    steps: [{ shape: s.build(), form: 1.7, hold: 6, release: 1.3, rest: 0.6, streams: [{ count: 5, heading: 0.05, spread: 0.3, hit: [0], speed: 70, period: 3.1, bounce: 0.42, tail: 10, travel: 70 }] }],
  };
}

// ----------------------------------------------------------- token coin ---

/** A token's coin: its address's 7 x 7 identicon as dots on a coin that turns now and then. */
export function tokenCoinScene(id: string, cells: readonly { x: number; y: number; dim: boolean }[]): NoiseScene {
  const B = 44;
  const s = shape(B, B);
  s.stroke(circle(22, 22, 19.5), { weight: 1.2, group: 1 });
  s.stroke(circle(22, 22, 16.8), { weight: 0.4, group: 1 });
  const bright = cells.filter((c) => !c.dim).map((c) => circle(22 + (c.x - 3) * 3.3, 22 + (c.y - 3) * 3.3, 1.05, 14));
  const dim = cells.filter((c) => c.dim).map((c) => circle(22 + (c.x - 3) * 3.3, 22 + (c.y - 3) * 3.3, 0.8, 12));
  if (bright.length) s.fill(bright, { weight: 5, group: 1 });
  if (dim.length) s.fill(dim, { weight: 2.5, group: 1 });
  const form = 1.5;
  // Mostly face-on (the identicon reads), then one unhurried turn every few seconds.
  const angle = (lt: number): number => {
    const k = (lt - form) % 6;
    if (lt < form || k < 4.4) return 0;
    return easeInOut((k - 4.4) / 1.4) * Math.PI * 2;
  };
  return {
    id: `coin-${id}`,
    spacing: (side) => Math.max(1.8, Math.min(3, side / 44)),
    dot: (side) => (side < 80 ? 0.7 : 0.9),
    ambientGap: 12,
    pad: 0.04,
    steps: [{ shape: s.build(), form, hold: 12.4, release: 1.2, rest: 0.5, transform: (g, lt) => (g === 1 ? { scaleX: Math.cos(angle(lt)), cx: 22, cy: 22 } : null) }],
  };
}

// --------------------------------------------------------------- glyphs ---

const G = 40;
/** Small art: dots a little closer and finer as the box shrinks. */
const small = {
  spacing: (side: number) => Math.max(1.5, Math.min(2.6, side / 27)),
  dot: (side: number) => (side < 48 ? 0.6 : 0.72),
  ambientGap: 8,
  pad: 0.05,
  drift: 0.09,
  maxDots: 420,
} as const;
const glyphTiming = { form: 1.4, hold: 5.6, release: 1, rest: 0.5 } as const;

function one(id: string, build: (s: ReturnType<typeof shape>) => void, extra: Partial<SceneStep> = {}): NoiseScene {
  const s = shape(G, G);
  build(s);
  return { id: `glyph-${id}`, ...small, steps: [{ shape: s.build(), ...glyphTiming, ...extra }] };
}

function boxWithCoin(s: ReturnType<typeof shape>): void {
  s.stroke(roundRect(6, 9, 28, 24, 3), { weight: 1 });
  s.fill(circle(20, 21, 6.5, 30), { weight: 0.9 });
}

function coinOnly(s: ReturnType<typeof shape>): void {
  s.stroke(circle(20, 20, 10), { weight: 1.1 });
  s.stroke(circle(20, 20, 7), { weight: 0.5 });
}

const GLYPHS = {
  phrase: () =>
    one(
      "phrase",
      (s) => {
        s.stroke(roundRect(9, 4, 22, 32, 2.5), { weight: 1 });
        for (const [y, x2] of [[11, 27], [16, 27], [21, 25], [26, 21]] as const) s.stroke(line(13, y, x2, y), { weight: 0.9 });
      },
      // The sheet first, then its lines, one after another (24 words, written down).
      { order: (p) => (p.el === 0 ? p.rand * 0.35 : clamp01(0.35 + ((p.y - 11) / 15) * 0.5 + p.u * 0.15)) },
    ),
  deposit: () =>
    one(
      "deposit",
      (s) => {
        s.stroke(roundRect(5, 8, 30, 27, 3), { weight: 1 });
        s.stroke(roundRect(9, 12, 22, 19, 2), { weight: 0.45 });
        s.stroke(circle(20, 21.5, 5.5, 32), { weight: 1, group: 1 });
        s.stroke(line(20, 21.5, 20, 17), { weight: 1, group: 1 });
        s.stroke(line(15, 4.5, 25, 4.5), { weight: 0.8 });
      },
      { transform: (g, lt) => (g === 1 ? { rotate: ((140 * easeInOut((lt - 1.6) / 1.2) - 80 * easeInOut((lt - 3.1) / 0.9)) * Math.PI) / 180, cx: 20, cy: 21.5 } : null) },
    ),
  key: () =>
    one("key", (s) => {
      s.stroke(circle(12, 20, 6.5, 40), { weight: 1.1 });
      s.fill(circle(12, 20, 2.2, 16), { weight: 1.4 });
      s.stroke(line(18.5, 20, 35, 20), { weight: 1.1 });
      s.stroke([line(29, 20, 29, 25), line(33, 20, 33, 24)], { weight: 1.1 });
    }),
  wrap: (): NoiseScene => {
    const a = shape(G, G);
    coinOnly(a);
    const b = shape(G, G);
    boxWithCoin(b);
    return { id: "glyph-wrap", ...small, still: { step: 1 }, steps: [{ shape: a.build(), form: 1.2, hold: 2.2, release: 0.9, rest: 0.3 }, { shape: b.build(), form: 1.2, hold: 3.2, release: 1, rest: 0.4 }] };
  },
  hide: (): NoiseScene => {
    const eye = shape(G, G);
    eye.stroke("M4 20 Q20 5 36 20 Q20 35 4 20 Z", { weight: 1 });
    eye.fill(circle(20, 20, 4.6, 30), { weight: 1.2 });
    const dots = shape(G, G);
    dots.fill([8, 16, 24, 32].map((x) => circle(x, 20, 2.3, 18)), { weight: 1 });
    return { id: "glyph-hide", ...small, still: { step: 1 }, steps: [{ shape: eye.build(), form: 1.2, hold: 2.4, release: 1, rest: 0.3 }, { shape: dots.build(), form: 1.1, hold: 3, release: 1, rest: 0.4 }] };
  },
  unwrap: (): NoiseScene => {
    const a = shape(G, G);
    boxWithCoin(a);
    const b = shape(G, G);
    coinOnly(b);
    return { id: "glyph-unwrap", ...small, still: { step: 1 }, steps: [{ shape: a.build(), form: 1.2, hold: 2.2, release: 0.9, rest: 0.3 }, { shape: b.build(), form: 1.2, hold: 3.2, release: 1, rest: 0.4 }] };
  },
  book: () =>
    one("book", (s) => {
      s.stroke("M20 10 C15 7 9 7 5 9 V31 C9 29 15 29 20 32 C25 29 31 29 35 31 V9 C31 7 25 7 20 10 Z", { weight: 1 });
      s.stroke(line(20, 10, 20, 31.5), { weight: 0.8 });
      s.stroke([line(8.5, 14, 16.5, 13.5), line(8.5, 18.5, 16.5, 18), line(23.5, 13.5, 31.5, 14), line(23.5, 18, 31.5, 18.5)], { weight: 0.45 });
    }),
  paper: () =>
    one("paper", (s) => {
      s.stroke("M9 4 H25 L31 10 V36 H9 Z", { weight: 1 });
      s.stroke("M25 4 V10 H31", { weight: 0.8 });
      s.stroke([line(13, 16, 27, 16), line(13, 21, 27, 21), line(13, 26, 23, 26)], { weight: 0.6 });
    }),
  letter: () =>
    one("letter", (s) => {
      s.stroke(rect(5, 10, 30, 21), { weight: 1 });
      s.stroke("M5 10 L20 22 L35 10", { weight: 0.9 });
    }),
  courier: () =>
    one(
      "courier",
      (s) => {
        s.stroke(roundRect(5, 14, 18, 16, 1.5), { weight: 1, group: 1 });
        s.stroke(line(14, 14, 14, 30), { weight: 0.6, group: 1 });
        s.stroke("M27 22 H36 M32.5 18.5 L36 22 L32.5 25.5", { weight: 1 });
      },
      // The parcel edges towards the arrow while it holds.
      { transform: (g, lt) => (g === 1 ? { dx: 2.5 * Math.sin(Math.max(0, lt - 1.4) * 1.4) } : null) },
    ),
  agent: () =>
    one(
      "agent",
      (s) => {
        s.stroke(roundRect(11, 12, 18, 15, 4), { weight: 1.1 });
        s.fill([circle(17, 19, 1.7, 14), circle(23, 19, 1.7, 14)], { weight: 2.4, group: 1 });
        s.stroke(line(20, 12, 20, 7.5), { weight: 0.8 });
        s.fill(circle(20, 6.5, 1.3, 12), { weight: 2 });
        s.stroke(line(13, 31, 27, 31), { weight: 0.6 });
      },
      {
        // The eyes look left and right; a dot runs round the fence (the limits the chain enforces).
        transform: (g, lt) => (g === 1 ? { dx: 1.2 * Math.sin(lt * 1.3) } : null),
        accents: (pen, lt, k) => {
          const fence = [...roundRect(3, 3, 34, 34, 3).pts];
          pen.poly(fence, 0.22 * k, true);
          const per = fence.length / 2;
          const i = Math.floor(((lt * 0.25) % 1) * per);
          pen.dot(fence[i * 2] ?? 3, fence[i * 2 + 1] ?? 3, 1.3, 0.8 * k);
        },
      },
    ),
} as const;

export type GlyphName = keyof typeof GLYPHS;

const glyphCache = new Map<GlyphName, NoiseScene>();
export function glyphScene(name: GlyphName): NoiseScene {
  let s = glyphCache.get(name);
  if (!s) {
    s = GLYPHS[name]();
    glyphCache.set(name, s);
  }
  return s;
}

// ---------------------------------------------------------------- cards ---

const MW = 70;
const MH = 50;

function quickCard(): NoiseScene {
  const s = shape(MW, MH);
  addCoin(s, 35, 25, 14);
  const form = 1.3;
  return {
    id: "mode-quick",
    ...small,
    maxDots: 700,
    steps: [
      {
        shape: s.build(),
        form,
        hold: 5.4,
        release: 1.1,
        rest: 0.5,
        // One go: the coin forms, then a hairline ring locks round it.
        accents: (pen, lt, k) => {
          const q = easeInOut((lt - form + 0.2) / 0.9);
          if (q > 0) pen.arc(35, 25, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q, 0.3 * k);
        },
      },
    ],
  };
}

function customCard(): NoiseScene {
  const s = shape(MW, MH);
  const nodes: [number, number][] = [
    [5, 6],
    [27, 20],
    [49, 6],
    [49, 34],
  ];
  for (const [x, y] of nodes) {
    s.stroke(roundRect(x, y, 16, 10, 2), { weight: 1 });
    s.stroke(line(x + 3, y + 5, x + 11, y + 5), { weight: 0.5 });
  }
  const edges: [number, number, number, number][] = [
    [21, 11, 27, 25],
    [43, 25, 49, 11],
    [43, 25, 49, 39],
  ];
  return {
    id: "mode-custom",
    ...small,
    maxDots: 700,
    steps: [
      {
        shape: s.build(),
        form: 1.4,
        hold: 5.4,
        release: 1.1,
        rest: 0.5,
        order: (p) => clamp01((p.x / MW) * 0.7 + p.rand * 0.3),
        // The edges as hairlines, a pulse running along each in turn.
        accents: (pen, lt, k) => {
          edges.forEach(([x1, y1, x2, y2], i) => {
            pen.line(x1, y1, x2, y2, 0.35 * k);
            const q = ((lt * 0.6 - i * 0.33) % 1 + 1) % 1;
            pen.dot(x1 + (x2 - x1) * q, y1 + (y2 - y1) * q, 1.4, 0.85 * k * Math.sin(q * Math.PI));
          });
        },
      },
    ],
  };
}

const FLAME = "M20 5 C24 11 30 15 30 23 C30 30 25 34 20 34 C15 34 10 30 10 23 C10 18 14 16 15 11 C17 15 18 16 20 17 C19 13 19 9 20 5 Z";

function walletCard(): NoiseScene {
  const s = shape(G, G);
  s.stroke(roundRect(5, 15, 30, 20, 3), { weight: 1 });
  s.stroke(roundRect(23, 21, 12, 8, 2), { weight: 0.7 });
  s.fill(circle(28, 25, 1.3, 12), { weight: 2 });
  s.stroke(circle(20, 7.5, 4.2, 28), { weight: 1, group: 1 });
  return {
    id: "dest-wallet",
    ...small,
    steps: [
      {
        shape: s.build(),
        ...glyphTiming,
        // The coin settles into the wallet's top edge and lifts again, slowly.
        transform: (g, lt) => (g === 1 ? { dy: 3 * Math.sin(Math.max(0, lt - 1.4) * 1.1) } : null),
      },
    ],
  };
}

function burnCard(): NoiseScene {
  const s = shape(G, G);
  s.stroke(FLAME, { weight: 1 });
  s.stroke(place(parsePath(FLAME), 0.5, 0.5, 10, 16), { weight: 0.5 });
  return { id: "dest-burn", ...small, steps: [{ shape: s.build(), ...glyphTiming, order: (p) => clamp01(((40 - p.y) / 35) * 0.5 + p.rand * 0.5) }] };
}

function splitCard(): NoiseScene {
  const s = shape(G, G);
  s.stroke("M20 3 V14 M20 14 L10 24 M20 14 L30 24", { weight: 1 });
  s.stroke(roundRect(3, 27, 14, 10, 2), { weight: 0.9 });
  s.stroke(place(parsePath(FLAME), 0.42, 0.36, 22.6, 25), { weight: 0.9 });
  return { id: "dest-split", ...small, steps: [{ shape: s.build(), ...glyphTiming, order: (p) => clamp01((p.y / 40) * 0.7 + p.rand * 0.3) }] };
}

const CARDS = { quick: quickCard, custom: customCard, wallet: walletCard, token: burnCard, split: splitCard } as const;
export type CardScene = keyof typeof CARDS;

const cardCache = new Map<CardScene, NoiseScene>();
export function cardScene(name: CardScene): NoiseScene {
  let s = cardCache.get(name);
  if (!s) {
    s = CARDS[name]();
    cardCache.set(name, s);
  }
  return s;
}
