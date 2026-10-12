/**
 * What the noise effects watch, shared by all of them: whether motion is allowed (the OS "reduce motion" setting or
 * the visitor's motion switch, html[data-motion="still"]), theme switches (html[data-theme] / [data-palette]) and
 * whether an element is on screen. One MutationObserver and one IntersectionObserver serve the whole page.
 */
import { rgba } from "../palette";

/** Motion is off right now: reduced motion, or the visitor paused ambient motion. */
export function motionStill(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.motion === "still") return true;
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

type Listener = () => void;
const motionListeners = new Set<Listener>();
const themeListeners = new Set<Listener>();
let mo: MutationObserver | null = null;
let mq: MediaQueryList | null = null;

function ensureRootObserver(): void {
  if (mo || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  mo = new MutationObserver((records) => {
    let motion = false;
    let theme = false;
    for (const r of records) {
      if (r.attributeName === "data-motion") motion = true;
      else theme = true;
    }
    if (theme) for (const cb of [...themeListeners]) cb();
    if (motion) for (const cb of [...motionListeners]) cb();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion", "data-theme", "data-palette"] });
  try {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", () => {
      for (const cb of [...motionListeners]) cb();
    });
  } catch {
    mq = null;
  }
}

/** Calls `cb` when motion is switched on or off. Returns an unsubscribe. */
export function onMotionChange(cb: Listener): () => void {
  ensureRootObserver();
  motionListeners.add(cb);
  return () => motionListeners.delete(cb);
}

/** Calls `cb` after a theme / palette switch. Returns an unsubscribe. */
export function onThemeChange(cb: Listener): () => void {
  ensureRootObserver();
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

const visibility = new Map<Element, (on: boolean) => void>();
let io: IntersectionObserver | null = null;

/** Calls `cb(true | false)` as `el` enters or leaves the screen (with an 80px margin). Returns an unsubscribe. */
export function observeOnScreen(el: Element, cb: (on: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => undefined;
  }
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) visibility.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: "80px 0px" },
  );
  visibility.set(el, cb);
  io.observe(el);
  return () => {
    visibility.delete(el);
    io?.unobserve(el);
  };
}

/** Device pixel ratio, capped at 1.5 (dots stay crisp; the canvas never grows past 2.25x its CSS area). */
export function cappedDpr(): number {
  return Math.min(1.5, typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1);
}

/** The ink an effect paints with: its own --nz-ink, else the theme's text colour. As 0..255 r, g, b. */
export function readInk(el: Element): [number, number, number] {
  const cs = getComputedStyle(el);
  const raw = cs.getPropertyValue("--nz-ink").trim() || cs.getPropertyValue("--text").trim();
  const light = document.documentElement.dataset.theme === "light";
  if (!raw) return light ? [10, 10, 10] : [245, 245, 245];
  const [r, g, b] = rgba(raw);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** True when the light (Paper) theme is on. */
export function lightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
}
