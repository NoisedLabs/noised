/**
 * App settings: theme + palette (GLASS_V51: two tones only, "graphite" dark and "paper" light) and the RPC
 * endpoint (PIXEL_V6: one type system, no font setting). The endpoint list is fixed at build time (VITE_RPC_URL) because the
 * Content-Security-Policy's connect-src is generated from exactly that list:
 * the page cannot reach any other host, so it cannot offer one.
 *
 * Palettes are CSS variable sets (styles.css). Two html attributes carry the choice:
 *   data-theme   = "dark" | "light"                 (every consumer keys off light/dark)
 *   data-palette = "graphite" | "paper"              (same information, kept for observers that watch it)
 * Every switch re-sets data-theme too (same value or not) so MutationObservers watching data-theme
 * (canvas / WebGL art that reads CSS variables) repaint, and fires a "phx:palette-change" window event.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";

import { readString } from "../lib/storage";
import { useStoredString } from "./hooks";

export type Theme = "dark" | "light";
export type Palette = "graphite" | "paper";
export type DarkPalette = Exclude<Palette, "paper">;

/** Cycle order of the theme command. */
export const PALETTES: readonly Palette[] = ["graphite", "paper"];
export const DARK_PALETTES: readonly DarkPalette[] = ["graphite"];
/** The default palette for anyone who has not picked one. */
export const DEFAULT_PALETTE: DarkPalette = "graphite";

export const PALETTE_META: Record<Palette, { label: string; bg: string; note: string }> = {
  graphite: { label: "Graphite", bg: "#070707", note: "dark · white" },
  paper: { label: "Paper", bg: "#f4f4f2", note: "light · black" },
};

/** Fired on window after every palette / theme change: detail = { palette, theme }. ("phx:palette" opens the command palette.) */
export const PALETTE_EVENT = "phx:palette-change";

const THEME_KEY = "noised.theme";
const PALETTE_KEY = "noised.palette";
const RPC_KEY = "noised.rpc";

export const CLUSTER = __NOISED_CLUSTER__;
export const RPC_ENDPOINTS = __NOISED_RPC_ENDPOINTS__;
export const APP_VERSION = __NOISED_VERSION__;
export const CSP = __NOISED_CSP__;

export function isPalette(v: unknown): v is Palette {
  return typeof v === "string" && (PALETTES as readonly string[]).includes(v);
}

function asDark(_v: string | null): DarkPalette {
  // One dark palette now: any saved value (including the retired CRYO / ACID / UV) maps to Graphite.
  return DEFAULT_PALETTE;
}

/** The palette currently painted on <html> (for code outside React, e.g. canvas renderers). */
export function currentPalette(): Palette {
  const p = typeof document === "undefined" ? null : document.documentElement.dataset.palette;
  return isPalette(p) ? p : DEFAULT_PALETTE;
}

/** html[data-palette] + html[data-theme] + the browser chrome color (<meta name="theme-color">). */
function paintTheme(theme: Theme, dark: DarkPalette): void {
  const root = document.documentElement;
  const palette: Palette = theme === "light" ? "paper" : dark;
  root.dataset.palette = palette;
  // Set after the palette, even when unchanged: observers of data-theme re-read the CSS variables.
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", PALETTE_META[palette].bg);
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: { palette, theme } }));
}

/** Apply the saved theme + palette before React renders (called from main.tsx). PIXEL_V6: one type system, no font
 *  setting (the old html[data-font] sets are gone; never re-add a font switcher). */
export function applyInitialTheme(): void {
  const saved = readString(THEME_KEY);
  // Light ("paper") is the default look; dark ("graphite") is the alternative the visitor can pick.
  paintTheme(saved === "dark" ? "dark" : "light", asDark(readString(PALETTE_KEY)));
}

interface Settings {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** The painted palette ("paper" when the theme is light). */
  palette: Palette;
  /** The dark palette that returns when leaving the light theme. */
  darkPalette: DarkPalette;
  setPalette: (p: Palette) => void;
  /** Graphite <-> Paper. Returns the new palette. */
  cyclePalette: () => Palette;
  endpoint: { label: string; url: string };
  endpointIndex: number;
  setEndpointIndex: (i: number) => void;
}

const SettingsContext = createContext<Settings | null>(null);

/** Cross-fade colors for one beat (styles.css: html[data-theme-switching]); skipped under reduced motion by CSS. */
function crossFade(): void {
  const root = document.documentElement;
  root.dataset.themeSwitching = "true";
  window.setTimeout(() => delete root.dataset.themeSwitching, 420);
}

export function SettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const [themeText, setThemeText] = useStoredString(THEME_KEY, "light");
  const theme: Theme = themeText === "dark" ? "dark" : "light";
  const [paletteText, setPaletteText] = useStoredString(PALETTE_KEY, DEFAULT_PALETTE);
  const darkPalette = asDark(paletteText);
  const palette: Palette = theme === "light" ? "paper" : darkPalette;
  const [indexText, setIndexText] = useStoredString(RPC_KEY, "0");
  const parsed = Number.parseInt(indexText, 10);
  const endpointIndex = Number.isInteger(parsed) && parsed >= 0 && parsed < RPC_ENDPOINTS.length ? parsed : 0;
  const endpoint = RPC_ENDPOINTS[endpointIndex] ?? { label: "none", url: "http://127.0.0.1:8899" };

  useEffect(() => {
    paintTheme(theme, darkPalette);
  }, [theme, darkPalette]);

  const setTheme = useCallback(
    (t: Theme) => {
      crossFade();
      setThemeText(t);
    },
    [setThemeText],
  );
  const setPalette = useCallback(
    (p: Palette) => {
      crossFade();
      if (p === "paper") {
        setThemeText("light");
        return;
      }
      setPaletteText(p);
      setThemeText("dark");
    },
    [setPaletteText, setThemeText],
  );
  const cyclePalette = useCallback((): Palette => {
    const next = PALETTES[(PALETTES.indexOf(palette) + 1) % PALETTES.length] ?? DEFAULT_PALETTE;
    setPalette(next);
    return next;
  }, [palette, setPalette]);
  const setEndpointIndex = useCallback((i: number) => setIndexText(String(i)), [setIndexText]);

  const value = useMemo<Settings>(
    () => ({ theme, setTheme, palette, darkPalette, setPalette, cyclePalette, endpoint, endpointIndex, setEndpointIndex }),
    [theme, setTheme, palette, darkPalette, setPalette, cyclePalette, endpoint, endpointIndex, setEndpointIndex],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Settings {
  const s = useContext(SettingsContext);
  if (!s) throw new Error("useSettings outside SettingsProvider");
  return s;
}

