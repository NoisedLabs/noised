/** Launch display components: phase data, the verification badge, the home page's launch cards and their status chips. */
import { useConnection } from "@solana/wallet-adapter-react";
import { ArrowUpRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { useAsync, useNow } from "../app/hooks";
import { qslCached, verifyCached } from "../app/verification";
import { launchBrandFlag } from "../lib/brandGuard";
import { qslBadgeView } from "../lib/qsl";
import { formatSol, formatSolExact } from "../lib/amounts";
import { expectedBatchFill, type CheckStatus, type LaunchAccount, type LaunchPhase, type VerificationReport } from "../lib/noised";
import { TokenIcon } from "./Identicon";
import { QslChip } from "./qsl/QslBadge";
import { demoTokenIcon } from "./tokenArt";
import { useTokenMeta } from "./tokenMeta";
import type { Tone } from "./ui";

import "./landing/tokens.css";
import "./landing/board.css";

type TagTone = "signal" | "amber" | "phosphor" | "violet" | "ice" | "danger" | "dim";

export const PHASE_INFO: Record<LaunchPhase, { label: string; tag: string; tone: Tone; pill: TagTone; description: string }> = {
  configured: { label: "Not launched", tag: "COMING SOON", tone: "neutral", pill: "dim", description: "Set up, but the creator has not launched it yet." },
  commit: { label: "Batch open", tag: "OPEN NOW", tone: "accent", pill: "signal", description: "The opening batch is open: join now, and everyone in the batch gets the same price." },
  execute: { label: "Starting soon", tag: "STARTING", tone: "accent", pill: "signal", description: "The batch has closed. Anyone can start it now: it buys for everyone at once." },
  guarded: { label: "Early limits", tag: "EARLY LIMITS", tone: "info", pill: "amber", description: "Trading is open, with early limits so no single wallet can grab too much. Selling is never blocked." },
  open: { label: "Open trading", tag: "TRADING", tone: "ok", pill: "ice", description: "Anyone can buy and sell, with no limits." },
  graduated: { label: "Graduated", tag: "GRADUATED", tone: "neutral", pill: "violet", description: "It reached its goal: its liquidity moved to a bigger pool." },
};

/** A neutral glass chip in sentence case; only its small dot carries the status colour (tokens.css .ld-tag). */
function Tag({ tone, title, pulse = false, children }: { tone: TagTone; title?: string; pulse?: boolean; children: ReactNode }): ReactNode {
  return (
    <span className="ld-tag" data-tone={tone} title={title}>
      <i className="ld-dot" data-pulse={pulse ? "" : undefined} aria-hidden="true" />
      {children}
    </span>
  );
}

/** The live verification result in plain words: a small dot (green / amber / red) and the outcome. */
export function VerifyBadge({ status, loading = false }: { status: CheckStatus | null; loading?: boolean }): ReactNode {
  if (loading && status === null) {
    return (
      <Tag tone="dim" title="Re-checking this mint against live chain state" pulse>
        Verifying
      </Tag>
    );
  }
  if (status === "pass") {
    return (
      <Tag tone="phosphor" title="Every live check passed">
        Verified
      </Tag>
    );
  }
  if (status === "warn") {
    return (
      <Tag tone="amber" title="Verified, with warnings about third parties">
        Verified, with warnings
      </Tag>
    );
  }
  if (status === "fail") {
    return (
      <Tag tone="danger" title="A check failed">
        Failed verification
      </Tag>
    );
  }
  return <Tag tone="dim">Not verified</Tag>;
}

/**
 * A post-quantum origin check of the verification report (protocol v2: the
 * launch's LMS attestation): an id segment starting with "pq" or "attest"
 * ("pq.attestation", "certificate.pqAttested"), or a label that names it.
 */
export function isPqCheck(c: { id: string; label: string }): boolean {
  return /(^|\.)(pq|attest)/i.test(c.id) || /post-quantum|\bpq\b|\blms\b|attestation/i.test(c.label);
}

/** The launch's post-quantum origin from its report; null until a v2 verifier reports one (the board shows "—"). */
export function pqOrigin(report: VerificationReport | undefined): { status: CheckStatus; detail: string; leaf: string | null } | null {
  const checks = report?.checks.filter(isPqCheck) ?? [];
  const c = checks.find((x) => x.status === "fail") ?? checks.find((x) => x.status === "warn") ?? checks[0];
  if (!c) return null;
  const leaf = checks.map((x) => /\bleaf\D{0,3}(\d{1,4})/i.exec(`${x.label} ${x.detail}`)?.[1]).find((x) => x !== undefined) ?? null;
  return { status: c.status, detail: c.detail, leaf };
}

export const PQ_PENDING = "No post-quantum attestation is readable for this launch yet. Launches created with protocol v2 show their LMS identity and leaf here, verified on-chain.";

function ratioPercent(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 10_000n) / whole) / 100;
}

// ------------------------------------------------- home board (plain words) ---

type StatusTone = "signal" | "amber" | "ice" | "violet" | "dim";

/** A launch's status in plain words: the chip on the home board. */
export const PHASE_STATUS: Record<LaunchPhase, { text: string; tone: StatusTone; pulse: boolean; hint: string }> = {
  commit: { text: "Open now", tone: "signal", pulse: true, hint: "The opening batch is open. Everyone who joins it pays the same price." },
  execute: { text: "Starting", tone: "signal", pulse: false, hint: "The opening batch has closed. Trading starts in a few minutes." },
  guarded: { text: "Early limits", tone: "amber", pulse: false, hint: "Trading is open, with early limits so no single wallet can grab too much. Selling is never blocked." },
  open: { text: "Trading", tone: "ice", pulse: false, hint: "Anyone can buy and sell." },
  graduated: { text: "Graduated", tone: "violet", pulse: false, hint: "It reached its goal. Its liquidity moved to a bigger pool." },
  configured: { text: "Coming soon", tone: "dim", pulse: false, hint: "Set up, but not launched yet." },
};

export function StatusChip({ phase }: { phase: LaunchPhase }): ReactNode {
  const s = PHASE_STATUS[phase];
  return (
    <span className="hm-chip" data-tone={s.tone} title={s.hint}>
      <i className="ld-dot" data-pulse={s.pulse ? "" : undefined} aria-hidden="true" />
      {s.text}
    </span>
  );
}

/**
 * SOL a launch has raised: what its opening batch takes while the batch is open, the SOL in its
 * curve once trading starts (at least the goal once it graduated). Null before it launches.
 */
export function raisedLamports(launch: LaunchAccount, phase: LaunchPhase): bigint | null {
  if (phase === "configured") return null;
  if (phase === "commit" || phase === "execute") {
    try {
      return expectedBatchFill(launch).fill;
    } catch {
      return launch.totalCommitted;
    }
  }
  const inCurve = launch.market?.quoteReserve ?? 0n;
  if (phase === "graduated" && inCurve < launch.migrationQuoteThreshold) return launch.migrationQuoteThreshold;
  return inCurve;
}

/** Progress toward graduation, 0..100. */
export function graduationPercent(launch: LaunchAccount, phase: LaunchPhase): number {
  if (phase === "graduated") return 100;
  const raised = raisedLamports(launch, phase);
  return raised === null ? 0 : Math.min(100, ratioPercent(raised, launch.migrationQuoteThreshold));
}

/** Segments in a launch card's progress bar (a pixel bar: whole segments light up). */
const SEGMENTS = 20;

/** "12:19" (or "1:02:05") until `end` (unix seconds, cluster time); ticks once a second in its own leaf. */
function CountdownText({ end }: { end: bigint }): ReactNode {
  const now = useNow();
  const left = Math.max(0, Number(end) - now);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const text = h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  return (
    <span className="hm-lc-clock" aria-label={h > 0 ? `${h} hours ${m} minutes` : `${m} minutes ${sec} seconds`}>
      {[...text].map((ch, i) => (
        <i key={i} data-sep={ch === ":" ? "" : undefined}>
          {ch}
        </i>
      ))}
    </span>
  );
}

/**
 * One launch on the home page, as a glass card: the token's own icon (a smooth logo, or pixel art at 2x, on a dark
 * tile; a pixel coin carrying its identicon when it has none) that spins on hover, plain status, and one honest
 * number with a pixel bar. While the opening batch is open the card shows what is in the batch and when it closes
 * (the same numbers as the token page); after that, SOL raised and progress toward its goal. The name link covers
 * the whole card, so each card is one tab stop.
 */
export function LaunchCard({ launch, phase, index = 0 }: { launch: LaunchAccount; phase: LaunchPhase; index?: number }): ReactNode {
  const { connection } = useConnection();
  const live = launch.status === "live";
  // Only a failed check is shown here (the token page has the full report); results are cached and shared.
  const verification = useAsync(() => verifyCached(connection, launch.baseMint), [connection, launch.baseMint.toBase58(), live], { enabled: live, watchChain: false });
  // Its QSL-1 badge (Appendix A: on lists a candidate shows only off mainnet, a token that is not QSL-1 shows nothing).
  const qsl = useAsync(() => qslCached(connection, launch.baseMint), [connection, launch.baseMint.toBase58(), live], { enabled: live, watchChain: false });
  const qslView = qsl.data ? qslBadgeView(qsl.data, "card") : null;
  const market = launch.market;
  // The token's own details from its on-chain record (through its certificate, or its verified attestation before launch).
  const meta = useTokenMeta(live ? { mint: launch.baseMint } : { launch: launch.publicKey });
  const name = market?.name ?? meta?.name ?? "New launch";
  const symbol = market?.symbol ?? meta?.symbol ?? null;
  // The list already leaves out hidden launches; one whose record shows a reserved name only now (before launch) goes too.
  const hidden = launchBrandFlag(launch, meta) !== null;
  const address = live ? launch.baseMint : launch.publicKey;
  const image = meta?.icon?.dataUri ?? null;
  // Its own icon first; the demo's hand-made art only in demo builds (null in live ones); else its pixel coin.
  const icon = image === null ? demoTokenIcon(symbol ?? undefined) : null;
  const own = image !== null || icon !== null;
  const batch = (phase === "commit" || phase === "execute") && !launch.executed;
  const cap = launch.batchTotalCap > 0n ? launch.batchTotalCap : 1n;
  const raised = batch ? launch.totalCommitted : raisedLamports(launch, phase);
  // The bar: the batch against its cap while it is open (full once it is oversubscribed), else progress to the goal.
  const pct = batch ? Math.min(100, ratioPercent(launch.totalCommitted, cap)) : graduationPercent(launch, phase);
  const failed = verification.data?.overall === "fail";
  // Whole segments that are lit; a partly reached segment glows dimmer.
  const exact = (Math.max(0, Math.min(100, pct)) / 100) * SEGMENTS;
  const full = Math.floor(exact);
  const part = exact - full;
  const barLabel = batch
    ? `${name}: ${formatSol(launch.totalCommitted, 2)} in the opening batch, which buys with up to ${formatSolExact(launch.batchTotalCap)}`
    : `${name}: progress toward its goal`;
  if (hidden) return null;
  return (
    <li className="glass glass-hover hm-lc" data-phase={phase} data-failed={failed ? "" : undefined} style={{ ["--i" as string]: index } as CSSProperties}>
      <span className="hm-lc-shimmer" aria-hidden="true" />
      <div className="hm-lc-head">
        <span className={`hm-lc-avatar${own ? " px-icon-tile px-corners px-frame" : ""}`} data-own={own ? "" : undefined} aria-hidden="true">
          <TokenIcon address={address} icon={icon} image={image} size={own ? 64 : 60} voxel />
        </span>
        <div className="hm-lc-id">
          <h3 className="hm-lc-name">
            <Link to={`/token/${address.toBase58()}`} className="hm-lc-link">
              {name}
              <span className="sr-only">
                {symbol !== null ? ` (${symbol})` : ""}, {PHASE_STATUS[phase].text}
                {failed ? ", failed a safety check" : ""}
                {qslView !== null && !failed ? `, ${qslView.label}` : ""}
              </span>
            </Link>
            <ArrowUpRight className="hm-lc-arrow" aria-hidden="true" />
          </h3>
          <span className="hm-lc-sub" aria-hidden="true">
            <span className="hm-lc-sym">{symbol ?? "Not launched"}</span>
            {failed ? (
              <span className="hm-chip" data-tone="danger" title="At least one safety check failed. Open the token to see which.">
                <i className="ld-dot" aria-hidden="true" />
                Failed a check
              </span>
            ) : (
              <StatusChip phase={phase} />
            )}
            {qslView !== null && !failed ? <QslChip view={qslView} /> : null}
          </span>
        </div>
      </div>
      <div className="hm-lc-figs">
        <div className="hm-lc-fig">
          <span className="hm-lc-k">{batch ? "In the batch" : "Raised"}</span>
          <span className="hm-lc-v">
            {raised === null ? (
              "—"
            ) : (
              <>
                {formatSol(raised, 2).replace(/ SOL$/, "")}
                <small>SOL</small>
              </>
            )}
          </span>
        </div>
        <div className="hm-lc-fig" data-end="">
          {phase === "commit" && !launch.executed ? (
            <>
              <span className="hm-lc-k">Closes in</span>
              <span className="hm-lc-v">
                <CountdownText end={launch.commitEndTs} />
              </span>
            </>
          ) : batch ? (
            <>
              <span className="hm-lc-k">Trading</span>
              <span className="hm-lc-v">Soon</span>
            </>
          ) : (
            <>
              <span className="hm-lc-k">Progress</span>
              <span className="hm-lc-v" aria-hidden="true">
                {pct.toFixed(0)}
                <small>%</small>
              </span>
            </>
          )}
        </div>
      </div>
      <span className="hm-lc-track" role="progressbar" aria-label={barLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} data-on={i < full ? "" : i === full && part > 0.08 ? "part" : undefined} style={{ ["--s" as string]: i } as CSSProperties} />
        ))}
      </span>
      {batch ? (
        <span className="hm-lc-note" aria-hidden="true">
          Buys with up to {formatSolExact(launch.batchTotalCap)} · same price for all
        </span>
      ) : null}
    </li>
  );
}

/** Placeholder card while the launches load. */
export function LaunchCardSkeleton(): ReactNode {
  return (
    <li className="glass hm-lc" data-skeleton="" aria-hidden="true">
      <div className="hm-lc-head">
        <span className="hm-skel-dot" />
        <div className="hm-lc-id">
          <span className="hm-skel" data-w="lg" />
          <span className="hm-skel" data-w="sm" />
        </div>
      </div>
      <div className="hm-lc-figs">
        <span className="hm-skel" data-w="md" />
      </div>
      <span className="hm-lc-track">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} />
        ))}
      </span>
    </li>
  );
}

/** The guard rules of a launch in one sentence. */
export function guardRules(launch: Pick<LaunchAccount, "maxWalletBps" | "maxBuyBps" | "p2pLocked">): string {
  const rules = [
    launch.maxWalletBps > 0 ? `Max wallet ${launch.maxWalletBps / 100}% of supply` : null,
    launch.maxBuyBps > 0 ? `max buy ${launch.maxBuyBps / 100}% of supply per transfer` : null,
    launch.p2pLocked ? "wallet-to-wallet transfers paused" : null,
  ].filter((x): x is string => x !== null);
  const head = rules.length === 0 ? "No caps" : rules.join(", ");
  return `${head.charAt(0).toUpperCase()}${head.slice(1)}. Sells are never blocked.`;
}
