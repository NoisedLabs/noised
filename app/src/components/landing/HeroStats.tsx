/**
 * The hero's three live numbers (v5): Launches · Raised in batches ·
 * Verified, on three glass tiles, in the display face's tabular figures that
 * count up, one short caption each. Every number is read from chain state
 * (the simulated chain in the demo build); nothing here is decorative data.
 * Each tile is marked `data-pane`: the hero's wall draws liquid glass under it,
 * and carries a small icon of dots that coalesces out of noise (noise/stats.ts).
 *
 * Before the first launch on mainnet the three numbers would all be zero, so the
 * tiles say where Noised stands instead: launches open soon, the vault and the
 * Shield are live, and all five programs are verified builds (StartStats).
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLaunchesState, type LaunchesState } from "../../app/network";
import { VERIFIED_PROGRAMS } from "../../app/opensource";
import { verifyCached } from "../../app/verification";
import { usePrefersReducedMotion } from "../../fx/motion";
import { unixSecs } from "../../lib/format";
import { batchOutcome, expectedBatchFill, launchPhase, type LaunchAccount } from "../../lib/noised";
import { useAmbientMotion } from "../AmbientMotion";
import { usePhaseNow } from "./phaseClock";
import { NoiseArt, type NoiseScene } from "../../fx/noise";
import { launchesIcon, raisedIcon, verifiedIcon } from "./noise/stats";

/** One scene per tile, made once (a scene is a description; each canvas keeps its own state). */
const ICONS = { launches: launchesIcon(), raised: raisedIcon(), verified: verifiedIcon() } as const;

/** The facts StartStats shows hold on mainnet (where the verified builds run and the Shield is deployed). */
const ON_MAINNET = __NOISED_CLUSTER__ === "mainnet";

/** At most this many tokens are verified for the stat (the board verifies the same ones; results are cached). */
const VERIFY_LIMIT = 48;
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface HeroStatsProps {
  launches: readonly LaunchAccount[] | undefined;
  error?: string | null;
}

export function HeroStats({ launches, error = null }: HeroStatsProps): ReactNode {
  // Phases only change at boundaries: no per-second re-render of the stats row.
  const now = usePhaseNow(launches);
  const loaded = launches !== undefined;
  const summary = useMemo(() => {
    let raised = 0n;
    let openNow = 0;
    let trading = 0;
    for (const l of launches ?? []) {
      const phase = launchPhase(l, unixSecs(now));
      if (phase === "commit") openNow++;
      if (phase === "open" || phase === "guarded") trading++;
      raised += raisedBy(l, now);
    }
    return { total: launches?.length ?? 0, raised, openNow, trading };
  }, [launches, now]);
  const verified = useVerified(launches);
  const launchesState = useLaunchesState();
  // No launch yet on mainnet: three facts instead of three zeros.
  if (ON_MAINNET && loaded && !error && summary.total === 0) return <StartStats state={launchesState} />;

  const launchesCaption = !loaded
    ? "Loading…"
    : summary.openNow > 0
      ? `${summary.openNow} open right now`
      : summary.trading > 0
        ? `${summary.trading} trading now`
        : summary.total > 0
          ? "None open right now"
          : "The first one starts soon";
  const verifiedCaption = !verified
    ? loaded
      ? "Checking…"
      : "Loading…"
    : verified.of === 0
      ? "Nothing live to check yet"
      : verified.ok === verified.of
        ? "Every live token checks out"
        : `${verified.of - verified.ok} failed a check`;

  return (
    <div className="hx-stats" data-state={error ? "error" : loaded ? "ready" : "loading"}>
      <dl className="hx-stats-grid" aria-label="Live numbers">
        <Stat label="Launches" caption={launchesCaption} art={ICONS.launches}>
          {loaded ? <CountUp value={summary.total} /> : null}
        </Stat>
        <Stat label="Raised in batches" unit="SOL" caption="Same price for everyone" art={ICONS.raised}>
          {loaded ? <CountUp value={Number(summary.raised) / LAMPORTS_PER_SOL} decimals={1} /> : null}
        </Stat>
        <Stat label="Verified" caption={verifiedCaption} art={ICONS.verified}>
          {verified ? (
            // The final numbers at once (a count-up would show "0 / 6" next to "Every live token checks out").
            <>
              <span className="sr-only">{verified.ok}</span>
              <span className="hx-roll" aria-hidden="true">
                {verified.ok}
              </span>
              <span className="hx-stat-of">/</span>
              <span className="sr-only">{verified.of}</span>
              <span className="hx-roll" aria-hidden="true">
                {verified.of}
              </span>
            </>
          ) : null}
        </Stat>
      </dl>
      {error ? (
        <p className="hx-stats-error" role="status">
          Live numbers are unavailable right now. The launches below have the details.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The tiles before the first launch: launches open soon (or the first one could be yours, once they are open), the
 * vault and the Shield are live, and all five programs are verified builds (the same code as the public source).
 */
export function StartStats({ state }: { state: LaunchesState }): ReactNode {
  const open = state === "open";
  const count = VERIFIED_PROGRAMS.length;
  return (
    <div className="hx-stats" data-state="ready" data-start="">
      <dl className="hx-stats-grid" aria-label="Noised today">
        <Stat label="Launches" caption={open ? "The first one could be yours" : "Opening on Solana shortly"} art={ICONS.launches}>
          {open ? <CountUp value={0} /> : <span className="hx-roll hx-stat-word">Soon</span>}
        </Stat>
        <Stat label="Vault & Shield" caption="Ready for your coins today" art={ICONS.raised}>
          <span className="hx-roll hx-stat-word">Live</span>
        </Stat>
        <Stat label="Verified builds" caption="Same code as on GitHub" art={ICONS.verified}>
          <span className="sr-only">
            {count} of {count}
          </span>
          <span className="hx-roll" aria-hidden="true">
            {count}
          </span>
          <span className="hx-stat-of" aria-hidden="true">
            /
          </span>
          <span className="hx-roll" aria-hidden="true">
            {count}
          </span>
        </Stat>
      </dl>
    </div>
  );
}

/** SOL that went into a launch's opening batch: spent when it ran, committed while open, nothing if it expired. */
function raisedBy(l: LaunchAccount, now: number): bigint {
  if (l.status === "configured") return 0n;
  const outcome = batchOutcome(l, unixSecs(now));
  if (outcome === "expired" || outcome === "empty") return 0n;
  try {
    return expectedBatchFill(l).fill;
  } catch {
    return 0n;
  }
}

function Stat({ label, unit, caption, art, children }: { label: string; unit?: string; caption: string; art: NoiseScene; children: ReactNode }): ReactNode {
  const ready = children !== null;
  return (
    <div className="hx-stat hx-glass" data-pane="" data-pane-tint="0.45" data-pane-frost="0.8">
      <span className="hx-stat-art" aria-hidden="true">
        <NoiseArt scene={art} />
      </span>
      <dt className="hx-stat-label">
        {label}
        {unit ? <span className="sr-only"> ({unit})</span> : null}
      </dt>
      <dd className="hx-stat-value">
        {ready ? (
          <>
            {children}
            {unit ? (
              <span className="hx-stat-unit" aria-hidden="true">
                {unit}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="hx-stat-wait" aria-hidden="true">
              --
            </span>
            <span className="sr-only">loading</span>
          </>
        )}
      </dd>
      <dd className="hx-stat-caption">{caption}</dd>
    </div>
  );
}

function format(value: number, decimals: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Counts up to the value (from 0, then from the last value shown). Reduced motion or motion off: the value. */
function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }): ReactNode {
  const ambient = useAmbientMotion();
  const reducedOs = usePrefersReducedMotion();
  const still = ambient.still || reducedOs;
  const [shown, setShown] = useState(() => (still ? value : 0));
  const from = useRef(still ? value : 0);
  useEffect(() => {
    if (still) {
      from.current = value;
      setShown(value);
      return;
    }
    const a = from.current;
    if (a === value) return;
    const start = performance.now();
    const duration = 1200;
    let raf = 0;
    const step = (t: number): void => {
      const k = Math.min(1, (t - start) / duration);
      const v = a + (value - a) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(k < 1 ? v : value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, still]);
  return (
    <>
      <span className="sr-only">{format(value, decimals)}</span>
      <span className="hx-roll" aria-hidden="true">
        {format(shown, decimals)}
      </span>
    </>
  );
}

/** Live launches whose verification report did not fail, out of the live launches. Null until the reports are in. */
function useVerified(launches: readonly LaunchAccount[] | undefined): { ok: number; of: number } | null {
  const { connection } = useConnection();
  const [result, setResult] = useState<{ ok: number; of: number } | null>(null);
  const key = useMemo(
    () =>
      (launches ?? [])
        .filter((l) => l.status === "live")
        .slice(0, VERIFY_LIMIT)
        .map((l) => l.baseMint.toBase58())
        .join(","),
    [launches],
  );
  useEffect(() => {
    if (launches === undefined) return;
    const mints = launches.filter((l) => l.status === "live").slice(0, VERIFY_LIMIT);
    let cancelled = false;
    void Promise.allSettled(mints.map((l) => verifyCached(connection, l.baseMint))).then((results) => {
      if (cancelled) return;
      let ok = 0;
      for (const r of results) {
        if (r.status === "fulfilled" && (r.value.overall === "pass" || r.value.overall === "warn")) ok++;
      }
      setResult({ ok, of: mints.length });
    });
    return () => {
      cancelled = true;
    };
    // `key` identifies the mint list; `launches` itself is a fresh array on every reload.
  }, [connection, key, launches === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  return result;
}
