/**
 * Palette access for art that paints outside CSS (canvas 2D, WebGL, SVG built in JS). UI v3 palettes are CSS
 * variable sets on <html> (styles.css); this module reads the BASE tokens from the computed style and tells you
 * when they change (navbar chip, command palette `theme …`, light/dark toggle).
 *
 *   const p = readPalette();              // { name: "graphite", primary: "#ffffff", ... } (strings, CSS syntax)
 *   const [r, g, b, a] = rgba(p.primary); // 0..1 floats for WebGL uniforms
 *   const off = onPaletteChange((p) => repaint(p));   // returns an unsubscribe
 *   const p = usePalette();               // React hook (re-renders on change)
 *
 * Derived tokens (--signal-soft, --signal-glow, ...) are color-mix() expressions: canvas cannot parse those
 * reliably, so only base colors are exposed here. Build your own alphas with rgba().
 */
import { useEffect, useState } from "react";

import { currentPalette, PALETTE_EVENT, type Palette } from "../app/settings";

export interface PaletteColors {
  name: Palette;
  dark: boolean;
  bg: string;
  bgDeep: string;
  panel: string;
  panel2: string;
  panel3: string;
  /** rgb(… / alpha) hairlines. */
  line: string;
  lineStrong: string;
  text: string;
  muted: string;
  dim: string;
  /** The palette's primary (Graphite white, Paper black). */
  primary: string;
  primaryHi: string;
  /** Silver gradient end (Graphite #9a9a9a, Paper #5c5c5c). */
  primary2: string;
  onPrimary: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
}

const TOKENS: Record<Exclude<keyof PaletteColors, "name" | "dark">, string> = {
  bg: "--bg",
  bgDeep: "--bg-deep",
  panel: "--panel",
  panel2: "--panel-2",
  panel3: "--panel-3",
  line: "--line",
  lineStrong: "--line-strong",
  text: "--text",
  muted: "--text-muted",
  dim: "--text-dim",
  primary: "--signal",
  primaryHi: "--signal-hi",
  primary2: "--primary-2",
  onPrimary: "--on-signal",
  ok: "--phosphor",
  warn: "--amber",
  danger: "--danger",
  info: "--violet",
};

/** Graphite fallbacks (SSR / tests without CSS). */
const FALLBACK: Omit<PaletteColors, "name" | "dark"> = {
  bg: "#070707",
  bgDeep: "#030303",
  panel: "#0e0e0e",
  panel2: "#141414",
  panel3: "#1b1b1b",
  line: "rgb(255 255 255 / 0.1)",
  lineStrong: "rgb(255 255 255 / 0.16)",
  text: "#f5f5f5",
  muted: "#a3a3a3",
  dim: "#8a8a8a",
  primary: "#ffffff",
  primaryHi: "#ffffff",
  primary2: "#9a9a9a",
  onPrimary: "#0a0a0a",
  ok: "#55d383",
  warn: "#e9c226",
  danger: "#ee7b7b",
  info: "#c8c8c8",
};

/** Read the painted palette's base colors from <html>. */
export function readPalette(): PaletteColors {
  const name = currentPalette();
  const dark = name !== "paper";
  if (typeof document === "undefined") return { name, dark, ...FALLBACK };
  const cs = getComputedStyle(document.documentElement);
  const out = { name, dark } as PaletteColors;
  for (const key of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
    const v = cs.getPropertyValue(TOKENS[key]).trim();
    out[key] = v === "" ? FALLBACK[key] : v;
  }
  return out;
}

let probe: HTMLElement | null = null;

/** Any CSS color string -> [r, g, b, a] in 0..1 (hex and rgb() parsed directly; anything else via a probe). */
export function rgba(color: string): [number, number, number, number] {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)?.[1];
  if (hex) {
    const h = hex.length <= 4 ? [...hex].map((x) => x + x).join("") : hex;
    const n = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(c);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] === "%" ? 100 : 1);
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, a];
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(c);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), srgb[4] === undefined ? 1 : Number(srgb[4])];
  if (typeof document === "undefined") return [1, 1, 1, 1];
  // Resolve through the CSS engine (color-mix, named colors, …).
  if (!probe) {
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.hidden = true;
    document.body.append(probe);
  }
  probe.style.color = "";
  probe.style.color = c;
  const resolved = getComputedStyle(probe).color;
  return resolved && resolved !== c ? rgba(resolved) : [1, 1, 1, 1];
}

/** "#rrggbb" + alpha -> "rgb(r g b / a)" (canvas fillStyle friendly). */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b, a] = rgba(color);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${+(a * alpha).toFixed(3)})`;
}

/** Call `cb` with the new colors after every palette / theme switch. Returns an unsubscribe. */
export function onPaletteChange(cb: (p: PaletteColors) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  // The event fires right after the attributes change; styles resolve on read.
  const h = (): void => cb(readPalette());
  window.addEventListener(PALETTE_EVENT, h);
  return () => window.removeEventListener(PALETTE_EVENT, h);
}

/** React: the painted palette's colors (re-renders on switch). */
export function usePalette(): PaletteColors {
  const [p, setP] = useState<PaletteColors>(() => readPalette());
  useEffect(() => {
    setP(readPalette());
    return onPaletteChange(setP);
  }, []);
  return p;
}
