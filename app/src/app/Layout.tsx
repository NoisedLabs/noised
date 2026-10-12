/**
 * App shell (SIMPLE_V4 spec sections 1-2): a calm background, the floating pill navbar (logo, five links, sound,
 * theme, Connect), a small mode pill under it ("Demo mode — no real funds" in demo builds), the live-mode network
 * banner, the mobile menu sheet, the command palette (Ctrl/⌘ K or "/", no chip), toasts and a simple footer.
 * v6 (PIXEL_V6): pixel type in the chrome, a quick pixel-dissolve page transition, the pixel-shield loading state,
 * magnetic pixel buttons, a pixel brand mark and a pixel wordmark in the footer.
 */
import { Menu, Moon, OctagonX, Sun, TriangleAlert, Volume2, VolumeX, X, ArrowUpRight } from "lucide-react";
import { m } from "motion/react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { AmbientMotionProvider, useAmbientMotion } from "../components/AmbientMotion";
import { CommandPalette, openCommandPalette } from "../components/CommandPalette";
import { Toaster } from "../components/ui";
import { Aurora } from "../fx/aurora/Aurora";
import { spring } from "../fx/motion";
import { DotSpinner } from "../fx/noise/DotSpinner";
import { useNoiseReveal } from "../fx/noise/reveal";
import { noiseWipe } from "../fx/noise/wipe";
import { installMagnetic } from "../fx/pixel/magnetic";
import { sfx, useSound } from "../fx/sfx";
import { ADAPTER_MODE, CLUSTERS, PROGRAMMABLE_AVAILABLE } from "../lib/noised";
import { missingNoisedPrograms, useNetwork } from "./network";
import { NAV, TAGLINE } from "./brand";
import { APP_VERSION, CLUSTER, PALETTE_META, useSettings } from "./settings";
import { WalletButton } from "./wallet";

const MOCK = ADAPTER_MODE === "mock";

export function Layout(): ReactNode {
  return (
    <AmbientMotionProvider>
      <LayoutSurface />
    </AmbientMotionProvider>
  );
}

function LayoutSurface(): ReactNode {
  const location = useLocation();
  const home = location.pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => installMagnetic(), []);

  return (
    <>
      <Aurora />
      <div className="phx-shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <NavBar menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} />
        <main id="main" className="phx-main" data-home={home ? "true" : "false"} tabIndex={-1}>
          {/* A quick resolve from noise on every route change; lazy pages show the dot ring while they load. */}
          <RouteFrame key={location.pathname}>
            <Suspense fallback={<RouteLoading />}>
              {home ? (
                <Outlet />
              ) : (
                <div className="phx-page">
                  <Outlet />
                </div>
              )}
            </Suspense>
          </RouteFrame>
        </main>
        <Footer />
        <Toaster />
      </div>
      <MobileSheet open={menuOpen} onClose={() => setMenuOpen(false)} />
      <CommandPalette />
    </>
  );
}

/** The page wrapper: resolves in from noise (soft dots that grow until they merge, ~0.45 s). */
function RouteFrame({ children }: { children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useNoiseReveal(ref, { immediate: true, duration: 460 });
  return (
    <div ref={ref} className="phx-route">
      {children}
    </div>
  );
}

function RouteLoading(): ReactNode {
  return (
    <div className="phx-route-loading">
      <DotSpinner size={48} label="Loading page" />
    </div>
  );
}

// ================================================================ brand ===

/** The 3 x 3 pixel mark (square pixels, white fading to silver; ink to graphite on Paper) + "NOISED". */
function Brand({ onClick }: { onClick?: () => void }): ReactNode {
  return (
    <NavLink to="/" end className="phx-brand" aria-label="Noised home" onClick={onClick}>
      <BrandMark />
      <span className="phx-word" aria-hidden="true">
        NOISED
      </span>
    </NavLink>
  );
}

const MARK_DOTS = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ r, c })));

function BrandMark(): ReactNode {
  return (
    <svg className="phx-mark" viewBox="0 0 20 20" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {MARK_DOTS.map(({ r, c }) => (
        <rect key={`${r}${c}`} x={c * 7} y={r * 7} width={6} height={6} className={`phx-mark-d${r + c}`} />
      ))}
    </svg>
  );
}

// ================================================================ navbar ===

function NavBar({ menuOpen, onMenu }: { menuOpen: boolean; onMenu: () => void }): ReactNode {
  const [scrolled, setScrolled] = useState(false);

  // Read in the passive scroll listener itself (never inside an animation frame, where reading the scroll
  // position forces pending style work); React skips the render when the flag does not change.
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="phx-nav-wrap" data-scrolled={scrolled ? "true" : "false"}>
      <nav className="phx-nav" aria-label="Main">
        <Brand />
        <div className="phx-links">
          {NAV.map((n) => (
            <NavItem key={n.to} to={n.to} label={n.label} hint={n.hint} />
          ))}
        </div>
        <div className="phx-tools">
          <SoundButton />
          <ThemeButton />
          <div className="phx-wallet">
            <WalletButton />
          </div>
          <button type="button" className="phx-icon-btn phx-menu-btn" onClick={onMenu} aria-expanded={menuOpen} aria-haspopup="dialog" aria-label="Open menu">
            <Menu aria-hidden="true" />
          </button>
        </div>
      </nav>
      <ModePill />
      {ADAPTER_MODE === "live" ? <NetworkBanner /> : null}
    </header>
  );
}

function NavItem({ to, label, hint }: { to: string; label: string; hint: string }): ReactNode {
  return (
    <NavLink to={to} end={to === "/"} className="phx-link" title={hint} onClick={() => sfx.play("click")}>
      {({ isActive }: { isActive: boolean }) => (
        <>
          {isActive ? <m.span className="phx-link-active" layoutId="phx-nav-active" transition={spring.smooth} aria-hidden="true" /> : null}
          <span className="phx-link-text">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function SoundButton(): ReactNode {
  const sound = useSound();
  return (
    <button
      type="button"
      className="phx-icon-btn phx-nav-pref"
      onClick={() => sound.toggle()}
      aria-pressed={!sound.muted}
      aria-label="Sound effects"
      title={sound.muted ? "Sound is off" : "Sound is on"}
    >
      {sound.muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
    </button>
  );
}

/** Theme switch with a quick dissolve into noise: the old background breaks up into dots over the new theme. */
function wipeTheme(): void {
  noiseWipe({ color: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#070707" });
}

/** Graphite (dark) <-> Paper (light). */
function ThemeButton(): ReactNode {
  const { theme, setTheme } = useSettings();
  return (
    <button
      type="button"
      className="phx-icon-btn phx-nav-pref"
      onClick={() => {
        wipeTheme();
        setTheme(theme === "dark" ? "light" : "dark");
        sfx.play("toggle");
      }}
      aria-label={theme === "dark" ? "Switch to the light theme (Paper)" : "Switch to the dark theme (Graphite)"}
      title={theme === "dark" ? "Light theme (Paper)" : "Dark theme (Graphite)"}
    >
      {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}

/** "Demo mode — no real funds" (demo builds), or the test network's name (live devnet / localnet). Nothing on mainnet. */
function ModePill(): ReactNode {
  if (!MOCK && CLUSTER === "mainnet") return null;
  return (
    <p className="phx-mode" role="note">
      <span className="phx-mode-dot" aria-hidden="true" />
      {MOCK ? "Demo mode — no real funds" : `${CLUSTERS[CLUSTER].label} — test SOL, no real value`}
    </p>
  );
}

function NetworkBanner(): ReactNode {
  const { cluster, programs } = useNetwork();
  const { endpoint } = useSettings();
  // Inner pages clear the fixed header by its real height while the banner shows (it wraps on phones and grows when
  // its explanation is open): publish the banner's height as --phx-banner-h (terminal.css).
  const measure = useCallback((el: HTMLDivElement | null) => {
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty("--phx-banner-h");
      return;
    }
    const ro = new ResizeObserver(() => root.style.setProperty("--phx-banner-h", `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--phx-banner-h");
    };
  }, []);
  const missing = missingNoisedPrograms(programs);
  let title: string | null = null;
  let detail = "";
  // A wrong network is the one state where nothing can be built: say so in red, announce it, and show why.
  let tone: "fail" | "warn" = "warn";
  if (cluster?.state === "mismatch") {
    title = "Wrong network: transactions are disabled.";
    detail = cluster.detail;
    tone = "fail";
  } else if (cluster?.state === "error") {
    title = `Connection unavailable: ${endpoint.label}.`;
    detail = cluster.detail;
  } else if (missing.length > 0) {
    title = `Programs unavailable on ${CLUSTERS[CLUSTER].label}.`;
    detail = `${missing.map((p) => p.label).join(", ")}. Transactions will not pass simulation. You can still inspect addresses.`;
  }
  return title ? (
    <div ref={measure} className="phx-netbanner" data-tone={tone} role={tone === "fail" ? "alert" : "status"}>
      <details open={tone === "fail"}>
        <summary>
          {tone === "fail" ? <OctagonX aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <span>{title}</span>
          <span className="phx-netbanner-more" aria-hidden="true" />
        </summary>
        <p>{detail}</p>
      </details>
    </div>
  ) : null;
}

// ========================================================= mobile sheet ===

function MobileSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const { theme, setTheme, palette } = useSettings();
  const sound = useSound();
  const { still, reduced, toggle } = useAmbientMotion();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      sfx.play("open");
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="phx-sheet"
      aria-label="Menu"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="phx-sheet-inner">
        <div className="phx-sheet-head">
          <Brand onClick={onClose} />
          <button type="button" className="phx-icon-btn" onClick={onClose} aria-label="Close menu">
            <X aria-hidden="true" />
          </button>
        </div>
        <nav className="phx-sheet-links" aria-label="Mobile navigation">
          {[{ to: "/", label: "Launches" }, ...NAV].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className="phx-sheet-link" onClick={onClose}>
              <span>{n.label}</span>
              <ArrowUpRight aria-hidden="true" />
            </NavLink>
          ))}
        </nav>
        <div className="phx-sheet-tools">
          <button
            type="button"
            onClick={() => {
              onClose();
              openCommandPalette();
            }}
          >
            <span>Search</span>
            <span>Tokens &amp; pages</span>
          </button>
          <button
            type="button"
            onClick={() => {
              wipeTheme();
              setTheme(theme === "dark" ? "light" : "dark");
              sfx.play("toggle");
            }}
            aria-label={`Theme: ${PALETTE_META[palette].label}. Switch to ${theme === "dark" ? "Paper (light)" : "Graphite (dark)"}`}
          >
            <span>Theme</span>
            <span>{PALETTE_META[palette].label}</span>
          </button>
          <button type="button" onClick={() => sound.toggle()} aria-pressed={!sound.muted}>
            <span>Sound</span>
            <span>{sound.muted ? "Off" : "On"}</span>
          </button>
          <button type="button" onClick={toggle} disabled={reduced} aria-pressed={!still}>
            <span>Animations</span>
            <span>{still ? "Off" : "On"}</span>
          </button>
        </div>
        <p className="phx-sheet-foot">
          <span>{MOCK ? "Demo mode — no real funds" : CLUSTERS[CLUSTER].label}</span>
          <span>v{APP_VERSION}</span>
        </p>
      </div>
    </dialog>
  );
}

// =============================================================== footer ===

function Footer(): ReactNode {
  return (
    <footer className="phx-footer">
      <div className="phx-footer-inner">
        <div className="phx-footer-top">
          <div className="phx-footer-brand">
            <Brand />
            <p>{TAGLINE}</p>
          </div>
          <nav className="phx-footer-links" aria-label="Footer">
            <ul>
              <li>
                <NavLink to="/" end>
                  Live launches
                </NavLink>
              </li>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to}>{n.label}</NavLink>
                </li>
              ))}
              <li>
                <NavLink to="/docs/standard/qsl-1">QSL-1 standard</NavLink>
              </li>
              <li>
                <NavLink to="/whitepaper">Whitepaper</NavLink>
              </li>
              <li>
                <NavLink to="/autopilot" title="Automatic buybacks, burns and payouts within fixed limits">
                  Autopilot{PROGRAMMABLE_AVAILABLE ? null : <small className="phx-footer-soon-tag"> coming</small>}
                </NavLink>
              </li>
            </ul>
          </nav>
        </div>
        <div className="phx-footer-colophon">
          <span>No trackers. No third-party scripts.</span>
          <span>
            v{APP_VERSION} · {MOCK ? "Demo" : CLUSTERS[CLUSTER].label}
          </span>
        </div>
      </div>
      <FooterWordmark />
    </footer>
  );
}

/** The wordmark's letters. */
const WORDMARK = "NOISED";

/** 5x7 dot-matrix glyphs (rows top to bottom, 5 bits each). The I has full-width serifs so every letter fills its cell. */
const WORDMARK_GLYPHS: Record<string, readonly number[]> = {
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
};

/** Width of the wordmark in pixels: 5 per letter and a 1-pixel gap between letters. */
const WORDMARK_WIDTH = WORDMARK.length * 6 - 1;

/**
 * The footer's NOISED wordmark: square pixels across the content column. Each pixel is split into 2 x 2
 * sub-pixels. The seven glyph rows stay (almost) whole so every letter keeps its defining strokes (the N its
 * diagonal, the E its middle bar, the S its turns); below them two extra rows of sub-pixels, picked in 4 x 4 Bayer
 * order from the strokes above, dissolve toward the page bottom like a 1-bit print. Only the N is brighter. Static SVG.
 */
function FooterWordmark(): ReactNode {
  const dots = useMemo(() => {
    const out: { x: number; y: number; p: boolean; tw: number }[] = [];
    const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const push = (li: number, gx: number, gy: number): void => {
      // About 1 sub-pixel in 14 twinkles (dims for a moment) on its own slow clock.
      const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
      out.push({ x: gx / 2, y: gy / 2, p: li === 0, tw: h % 14 === 0 ? (h >>> 4) % 8 : -1 });
    };
    [...WORDMARK].forEach((ch, li) => {
      const rows = WORDMARK_GLYPHS[ch] ?? [];
      // Rows 0-6 are the glyph (>= 13/16 coverage); rows 7-8 repeat the last row's strokes as thinning dust.
      for (let r = 0; r < 9; r++) {
        const bits = rows[Math.min(r, rows.length - 1)] ?? 0;
        const keep = r < 5 ? 16 : r === 5 ? 15 : r === 6 ? 13 : r === 7 ? 5 : 2;
        for (let c = 0; c < 5; c++) {
          if (!((bits >> (4 - c)) & 1)) continue;
          for (let sy = 0; sy < 2; sy++)
            for (let sx = 0; sx < 2; sx++) {
              const gx = (li * 6 + c) * 2 + sx;
              const gy = r * 2 + sy;
              if ((bayer4[(gy & 3) * 4 + (gx & 3)] ?? 0) < keep) push(li, gx, gy);
            }
        }
      }
    });
    return out;
  }, []);
  return (
    <div className="phx-footer-wordmark" aria-hidden="true">
      <svg viewBox={`0 0 ${WORDMARK_WIDTH} 8.6`} preserveAspectRatio="xMidYMin meet" shapeRendering="crispEdges" focusable="false">
        <defs>
          <linearGradient id="phx-wm-ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="9">
            <stop offset="0" className="phx-wm-stop-a" />
            <stop offset="0.74" className="phx-wm-stop-m" />
            <stop offset="1" className="phx-wm-stop-b" />
          </linearGradient>
          <linearGradient id="phx-wm-p" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="9">
            <stop offset="0" className="phx-wm-stop-pa" />
            <stop offset="0.74" className="phx-wm-stop-pm" />
            <stop offset="1" className="phx-wm-stop-pb" />
          </linearGradient>
        </defs>
        {dots.map((d) => (
          <rect
            key={`${d.x}-${d.y}`}
            x={d.x}
            y={d.y}
            width={0.46}
            height={0.46}
            fill={d.p ? "url(#phx-wm-p)" : "url(#phx-wm-ink)"}
            className={d.tw >= 0 ? `phx-wm-tw phx-wm-tw${d.tw}` : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
