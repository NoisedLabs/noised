/**
 * Home hero (v5.1 "graphite glass"; LAYER_V1 positioning): "Quantum security /
 * for Solana." resolving out of noise in front of the monochrome shield wall (a
 * 3D wall of hex shields made of dots that blocks incoming shots), one sentence,
 * two buttons, a field that checks any token by its address, a row of links (the SDK,
 * the MCP server, GitHub, the whitepaper) and three live numbers, each resolving in
 * from noise (fx/noise).
 *
 *   <Hero />                                   // reads the launch list itself
 *   <Hero launches={{ data, error }} />        // or shares the page's fetch
 *
 * The buttons, the field and the stat tiles are liquid glass: the wall draws
 * a refracting, frosted pane under every element marked `data-pane` (WebGL),
 * and the section falls back to CSS backdrop blur (data-glass="css") when it
 * cannot. Clicking the wall fires a shot at it.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { Link, useNavigate } from "react-router";

import { HERO_SUB, HERO_TITLE } from "../../app/brand";
import { useAsync } from "../../app/hooks";
import { launchCtaLabel, useLaunchesState } from "../../app/network";
import { usePrefersReducedMotion } from "../../fx/motion";
import { sfx } from "../../fx/sfx";
import "../../fx/wall/hero.css";
import { ShieldWall, type GlassSource, type ShieldWallHandle } from "../../fx/wall/ShieldWall";
import { useBleed } from "../../fx/wall/useBleed";
import { useHeaderClearance } from "../../fx/wall/useClearance";
import { listLaunches, type LaunchAccount } from "../../lib/noised";
import { useAmbientMotion } from "../AmbientMotion";
import { ResolveText, useNoiseReveal } from "../../fx/noise";
import { HeroLinks } from "./HeroLinks";
import { HeroStats } from "./HeroStats";

export interface HeroLaunches {
  data: readonly LaunchAccount[] | undefined;
  error: string | null;
}

/** Elements the wall draws glass under: a dark tint behind their text, and how frosted they are. */
function paneSources(root: HTMLElement | null): GlassSource[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>("[data-pane]")].map((el) => ({
    el,
    tint: Number(el.dataset.paneTint ?? "0.4"),
    frost: Number(el.dataset.paneFrost ?? "0.85"),
  }));
}

export function Hero({
  launches,
}: {
  /** The page's launch list (shared with the board), so the hero does not fetch it twice. */
  launches?: HeroLaunches;
} = {}): ReactNode {
  const { connection } = useConnection();
  // Shares the page's launch list when given one; otherwise reads it here.
  const own = useAsync(() => listLaunches(connection), [connection], { enabled: launches === undefined });
  const data = launches ? launches.data : own.data;
  const error = launches ? launches.error : own.error;
  const launchesState = useLaunchesState();

  const ambient = useAmbientMotion();
  const reducedOs = usePrefersReducedMotion();
  const still = ambient.still || reducedOs;
  const section = useRef<HTMLElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const wall = useRef<ShieldWallHandle>(null);
  const [glass, setGlass] = useState<"gl" | "css">("css");
  const bleed = useBleed(section);
  // The fixed header can grow (network banner): keep the copy clear of it.
  const clearance = useHeaderClearance();
  const sectionStyle = clearance ? ({ ["--hx-top" as string]: `${clearance}px` } as CSSProperties) : undefined;
  const panes = useCallback(() => paneSources(section.current), []);
  // After the headline: the sentence, the buttons, the field, the links and the numbers resolve in from noise, one after another.
  const sub = useRef<HTMLParagraphElement>(null);
  const ctas = useRef<HTMLDivElement>(null);
  const verify = useRef<HTMLDivElement>(null);
  const links = useRef<HTMLUListElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  useNoiseReveal(sub, { immediate: true, delay: 420, duration: 560, sweep: "right" });
  useNoiseReveal(ctas, { immediate: true, delay: 560, duration: 520, sweep: "right" });
  useNoiseReveal(verify, { immediate: true, delay: 660, duration: 520, sweep: "right" });
  useNoiseReveal(links, { immediate: true, delay: 720, duration: 480, sweep: "right" });
  useNoiseReveal(foot, { immediate: true, delay: 760, duration: 640 });
  const onGlass = useCallback((active: boolean) => setGlass(active ? "gl" : "css"), []);

  /** A click on the open wall (not on a control or the copy) fires a shot at it. */
  const onStageClick = (e: MouseEvent<HTMLElement>): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest("a, button, input, label, form, .hx-copy, .hx-foot")) return;
    if (window.getSelection()?.toString()) return;
    wall.current?.fireAt(e.clientX, e.clientY);
  };

  // The click only adds a decorative shot; every control keeps its own keyboard access.
  return (
    <section ref={section} className="hx" style={sectionStyle} aria-labelledby="hx-title" data-ready="" data-glass={glass} onClick={onStageClick}>
      <div className="hx-stage" style={bleed} aria-hidden="true">
        <ShieldWall
          ref={wall}
          focus={() => copy.current}
          skipIntro
          startDelayMs={still ? 0 : 120}
          glass={panes}
          onGlass={onGlass}
          onImpact={(info) => {
            if (info.user) sfx.play("commit");
          }}
        />
        <div className="hx-scrim" />
      </div>

      <div className="hx-inner">
        <div className="hx-copy" ref={copy}>
          <h1 id="hx-title" className="hx-title">
            <span className="hx-line">
              <ResolveText text={HERO_TITLE[0]} trigger="mount" durationMs={820} delay={80} />
            </span>
            <span className="hx-line hx-line-grad">
              <ResolveText text={HERO_TITLE[1]} trigger="mount" durationMs={880} delay={260} />
            </span>
          </h1>
          <p ref={sub} className="hx-sub">
            {HERO_SUB}
          </p>
          <div ref={ctas} className="hx-ctas">
            <Link to="/create" className="btn btn-primary btn-lg btn-noglyph hx-cta" onClick={() => sfx.play("click")}>
              {launchCtaLabel(launchesState)}
              <span className="btn-arrow" data-dir="right" aria-hidden="true">
                →
              </span>
            </Link>
            <button
              type="button"
              className="btn btn-secondary btn-lg hx-cta hx-cta-glass hx-glass"
              data-pane=""
              data-pane-tint="0.3"
              data-pane-frost="0.9"
              onClick={() => {
                sfx.play("click");
                scrollToHowItWorks(still, section.current);
              }}
            >
              See how it works
            </button>
          </div>
          <VerifyField ref={verify} />
          <HeroLinks ref={links} />
        </div>
        <div ref={foot} className="hx-foot">
          <HeroStats launches={data} error={error} />
        </div>
      </div>
    </section>
  );
}

/** "See how it works": the four steps further down (falls back to the next section). */
function scrollToHowItWorks(still: boolean, hero: HTMLElement | null): void {
  const behavior = still ? "instant" : "smooth";
  const target = document.getElementById("how-it-works") ?? (hero?.nextElementSibling instanceof HTMLElement ? hero.nextElementSibling : null);
  if (!target) {
    window.scrollBy({ top: window.innerHeight * 0.9, behavior });
    return;
  }
  const nav = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-offset")) || 112;
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - nav - 8, behavior });
}

/** "Paste a token address to verify it": opens Verify, which re-checks the token on-chain against QSL-1. */
function VerifyField({ ref }: { ref?: Ref<HTMLDivElement> }): ReactNode {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    try {
      const address = new PublicKey(value.trim());
      setError(null);
      sfx.play("click");
      navigate(`/verify/${address.toBase58()}`);
    } catch {
      sfx.play("error");
      setError("That doesn't look like a token address. Copy it from the token's page or your wallet and try again.");
    }
  };
  return (
    <div ref={ref} className="hx-verify">
      <form className="hx-find hx-glass" role="search" onSubmit={submit} data-invalid={error ? "" : undefined} data-pane="" data-pane-tint="0.42" data-pane-frost="0.9">
        <label htmlFor="hx-verify-input" className="sr-only">
          Paste a token address to verify it
        </label>
        <svg className="hx-find-icon" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <input
          id="hx-verify-input"
          className="hx-find-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="Paste a token address"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? "hx-verify-error" : "hx-verify-hint"}
        />
        <button type="submit" className="hx-find-go" disabled={!value.trim()}>
          Verify
        </button>
      </form>
      {error ? (
        <p id="hx-verify-error" className="hx-find-error" role="alert">
          {error}
        </p>
      ) : (
        <p id="hx-verify-hint" className="sr-only">
          Checks the token on-chain, right now.
        </p>
      )}
    </div>
  );
}
