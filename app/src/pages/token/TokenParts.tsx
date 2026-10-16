/**
 * Presentation of the token page (v5 glass): the identity header with its
 * glass stat tiles, the price curve (./CurveChart), the timeline, the
 * quantum-safety checks and the program accounts. Everything here only
 * displays launch state.
 */
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { TokenIcon } from "../../components/Identicon";
import { guardRules, PHASE_INFO } from "../../components/launch";
import { demoTokenIcon } from "../../components/tokenArt";
import { Address } from "../../components/ui";
import { formatSol, formatSolExact, formatUnits } from "../../lib/amounts";
import { formatDuration, formatTimestamp, toHex, unixSecs } from "../../lib/format";
import { shortId } from "../../lib/pqKey";
import {
  batchOutcome,
  certificateAddress,
  hookPolicyAddress,
  launchPdasFromLaunch,
  priceFromSqrtPrice,
  type CheckStatus,
  type LaunchAccount,
  type LaunchPhase,
  type VerificationReport,
} from "../../lib/noised";
import { TokenCoin } from "../inner/art";
import { BlurWords, CheckLine, Checks, Chip, Details, DotBar, Fold, Metric, Panel, Readout, Row, Tiles, type KitTone } from "../inner/kit";
import { VerifyChip } from "../inner/readouts";
import { CurveChart } from "./CurveChart";

// ------------------------------------------------------------- helpers ---

export const PHASE_TONE: Record<LaunchPhase, KitTone> = {
  configured: "muted",
  commit: "signal",
  execute: "signal",
  guarded: "warn",
  open: "ok",
  graduated: "violet",
};

/** The phase as a status pill, with its description as its title. */
export function PhaseChip({ phase }: { phase: LaunchPhase }): ReactNode {
  const p = PHASE_INFO[phase];
  return (
    <Chip tone={PHASE_TONE[phase]} pulse={phase === "commit" || phase === "execute"} title={p.description}>
      {p.label}
    </Chip>
  );
}

/** Part/whole as a 0..1 fraction (bigint-safe). */
export function fraction(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * 1_000_000n) / whole) / 1_000_000;
}

/** A price in SOL with zero-run compression for tiny prices: 0.0₇280 (display only). */
const ZERO_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export function PriceText({ value }: { value: number | null }): ReactNode {
  if (value === null || !Number.isFinite(value) || value <= 0) return <>—</>;
  if (value >= 1) return <>{value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}</>;
  if (value >= 0.001) return <>{value.toLocaleString("en-US", { maximumFractionDigits: 6 })}</>;
  // 0.000000028 -> exponent -8 -> seven zeros after the point -> "0.0₇28".
  const e = Math.floor(Math.log10(value));
  let zeros = -e - 1;
  let sig = Math.round((value / 10 ** e) * 100);
  if (sig >= 1000) {
    sig = 100;
    zeros -= 1;
  }
  const digits = String(sig).replace(/0+$/, "") || "0";
  // A plain reading for the tooltip and screen readers: "0.0000000 28 SOL, seven zeros after the point".
  const plain = `0.${"0".repeat(zeros)} ${digits} SOL, ${ZERO_WORDS[zeros] ?? String(zeros)} zeros after the point`;
  return (
    <span title={plain}>
      <span aria-hidden="true">
        0.0<sub className="pg-sub">{zeros}</sub>
        {digits}
      </span>
      <span className="sr-only">{plain}</span>
    </span>
  );
}

/** The current DBC price in SOL per whole token, if the pool state is known. */
export function spotPrice(launch: LaunchAccount): number | null {
  const m = launch.market;
  if (!m || m.sqrtPrice <= 0n) return null;
  const p = priceFromSqrtPrice(m.sqrtPrice, launch.tokenDecimal);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** The boundary the current phase ends at (null when it has none). */
export function phaseEnd(launch: LaunchAccount, phase: LaunchPhase): bigint | null {
  if (phase === "commit") return launch.commitEndTs;
  if (phase === "execute") return launch.executeEndTs;
  if (phase === "guarded") return launch.guardEndTs;
  return null;
}

const pctText = (v: number): string => (v * 100).toLocaleString("en-US", { maximumFractionDigits: 1 });

// ----------------------------------------------------------------- header ---

/** Identity (mark, name, symbol, status, verification, mint) and four glass tiles. */
export function TokenHeader({
  launch,
  phase,
  now,
  name,
  symbol,
  verification,
  verifying,
  checks,
  image = null,
  badge = null,
}: {
  launch: LaunchAccount;
  phase: LaunchPhase;
  now: number;
  name: string;
  symbol: string;
  verification: CheckStatus | null;
  verifying: boolean;
  checks: { passed: number; total: number } | null;
  /** The token's own icon from its on-chain record (a data: URI; null: none). */
  image?: string | null;
  /** The QSL-1 badge (components/qsl), next to the status chips. */
  badge?: ReactNode;
}): ReactNode {
  const m = launch.market;
  const end = phaseEnd(launch, phase);
  const graduated = phase === "graduated";
  const progress = graduated ? 1 : m ? fraction(m.quoteReserve, launch.migrationQuoteThreshold) : 0;
  const price = spotPrice(launch);
  const stageLabel = phase === "commit" ? "Batch closes in" : phase === "execute" ? "Batch window ends in" : phase === "guarded" ? "Early limits end in" : "Stage";
  // Its own icon first; the demo's hand-made art only in demo builds; else its pixel coin.
  const icon = image === null ? demoTokenIcon(symbol) : null;
  const batchOpen = (phase === "commit" || phase === "execute") && !launch.executed;
  const batchFill = launch.batchTotalCap > 0n ? Math.min(1, fraction(launch.totalCommitted, launch.batchTotalCap)) : 0;
  return (
    <header className="tk-head">
      <div className="tk-id">
        {image !== null || icon ? (
          <span className="tk-coin tk-icon px-icon-tile px-corners px-frame" aria-hidden="true">
            <TokenIcon address={launch.baseMint} icon={icon} image={image} size={128} className="tk-icon-art" />
          </span>
        ) : (
          <TokenCoin address={launch.baseMint} className="tk-coin" />
        )}
        <div className="tk-id-main">
          <h1 className="tk-name">
            <span className="tk-name-t">
              <BlurWords>{name}</BlurWords>
            </span>{" "}
            <span className="tk-sym">{symbol}</span>
          </h1>
          <div className="tk-tags">
            <PhaseChip phase={phase} />
            <VerifyChip status={verification} loading={verifying} />
            {badge}
          </div>
          <dl className="tk-meta">
            <div>
              <dt>Token address</dt>
              <dd>
                <Address value={launch.baseMint} explorer />
              </dd>
            </div>
            <div>
              <dt>Launched</dt>
              <dd>{formatTimestamp(launch.launchTs)}</dd>
            </div>
          </dl>
        </div>
      </div>
      <Tiles className="tk-tiles" label="Launch at a glance">
        <Metric
          label={stageLabel}
          value={end !== null ? formatDuration(Number(end) - now) : graduated ? "Graduated" : PHASE_INFO[phase].label}
          hint={end !== null ? `at ${formatTimestamp(end)}` : graduated ? "moved to a bigger pool" : "no limits; it graduates when the curve fills"}
          tone={PHASE_TONE[phase]}
        />
        {batchOpen ? (
          // While the opening batch is open: what is in it (the same number as the home page's card), against what it buys with.
          <Metric label="In the batch" value={formatSol(launch.totalCommitted, 2)} hint={`buys with up to ${formatSolExact(launch.batchTotalCap)}`}>
            <DotBar value={batchFill} max={1} size="sm" label={`${name}: in the opening batch, against what it buys with`} tone="signal" />
          </Metric>
        ) : (
          <Metric label="Raised" value={`${pctText(progress)}%`} hint={`${m ? formatSol(m.quoteReserve, 2) : "—"} of ${formatSolExact(launch.migrationQuoteThreshold)}`}>
            <DotBar value={progress} max={1} size="sm" label={`${name}: raised toward graduation`} tone={graduated ? "violet" : "signal"} />
          </Metric>
        )}
        <Metric label="Price" value={<PriceText value={price} />} unit="SOL" hint={`per ${symbol}`} />
        <Metric
          label="Safety checks"
          value={checks === null ? (verifying ? "··" : "—") : `${checks.passed}/${checks.total}`}
          hint={checks === null ? "checked live on the chain" : checks.passed === checks.total ? "all passed" : `${checks.total - checks.passed} need attention`}
          tone={verification === "pass" ? "ok" : verification === "warn" ? "warn" : verification === "fail" ? "danger" : "muted"}
        />
      </Tiles>
    </header>
  );
}

// ------------------------------------------------------------ curve chart ---

/** The price curve: the chart and its numbers. */
export function CurvePanel({ launch, phase, now, symbol }: { launch: LaunchAccount; phase: LaunchPhase; now: number; symbol: string }): ReactNode {
  const m = launch.market;
  const threshold = launch.migrationQuoteThreshold;
  const reserve = m?.quoteReserve ?? 0n;
  const graduated = phase === "graduated";
  const progress = graduated ? 1 : fraction(reserve, threshold);
  const outcome = batchOutcome(launch, unixSecs(now));
  const batchSpend = !launch.executed && outcome === "pending" ? (launch.totalCommitted < launch.batchTotalCap ? launch.totalCommitted : launch.batchTotalCap) : 0n;
  const pending = fraction(batchSpend, threshold);
  const price = spotPrice(launch);
  const caption = graduated
    ? `The curve is complete: its liquidity moved to a bigger pool${m?.migrated ? "" : " (moving now)"}.`
    : `${formatSol(reserve, 2)} of ${formatSolExact(threshold)} raised (${pctText(progress)}%)${pending > 0 ? `; the batch will spend up to ${formatSol(batchSpend, 2)} in one swap` : ""}.`;
  return (
    <Panel
      title="Price curve"
      description="The price rises as SOL comes in. When the curve fills, the token graduates: its liquidity moves to a bigger pool."
      status={<span className="tk-status-num pg-num">{(progress * 100).toFixed(1)}%</span>}
      className="tk-curve"
    >
      <CurveChart progress={progress} pending={pending} tone={graduated ? "violet" : "signal"} caption={caption} threshold={threshold} />
      <Readout className="pg-well" label="Curve facts">
        <Row k="Raised">{m ? formatSol(reserve, 4) : "—"}</Row>
        <Row k="Graduates at">{formatSolExact(threshold)}</Row>
        <Row k={`Price (SOL per ${symbol})`}>
          <PriceText value={price} />
        </Row>
        {pending > 0 ? (
          <Row k="Batch, waiting" tone="signal">
            up to {formatSol(batchSpend, 4)}
          </Row>
        ) : null}
        {m ? (
          <Row k="Supply">
            {formatUnits(m.supply, launch.tokenDecimal, 0)} of {formatUnits(m.initialSupply, launch.tokenDecimal, 0)} minted at launch
          </Row>
        ) : null}
      </Readout>
      <p className="pg-hint">The line shows the shape of the curve; the position, price and amounts are live.</p>
    </Panel>
  );
}

// -------------------------------------------------------------- lifecycle ---

type StepState = "done" | "current" | "upcoming" | "skipped";

/** The timeline: Batch → Execute → Guard → Open → Graduate, the current stage lit, then the schedule. */
export function LifecyclePanel({ launch, phase, now }: { launch: LaunchAccount; phase: LaunchPhase; now: number }): ReactNode {
  if (phase === "configured") {
    return (
      <Panel title="Timeline">
        <p className="pg-text">The timeline starts when the creator launches the pool: the batch opens at that moment.</p>
      </Panel>
    );
  }
  const order: LaunchPhase[] = ["commit", "execute", "guarded", "open", "graduated"];
  const current = order.indexOf(phase);
  const outcome = batchOutcome(launch, unixSecs(now));
  const guardOver = BigInt(now) >= launch.guardEndTs;
  const steps: { phase: LaunchPhase; short: string; title: string; when: string; detail: string; boundary: bigint | null; starts: bigint | null }[] = [
    {
      phase: "commit",
      short: "Batch",
      title: "Fair-open batch",
      when: `${formatTimestamp(launch.launchTs)} → ${formatTimestamp(launch.commitEndTs)}`,
      detail: "Anyone commits SOL to the batch. Nobody can buy from the pool, not even the creator.",
      boundary: launch.commitEndTs,
      starts: launch.launchTs,
    },
    {
      phase: "execute",
      short: "Start",
      title: "The batch buys",
      when: `${formatTimestamp(launch.commitEndTs)} → ${formatTimestamp(launch.executeEndTs)}`,
      detail:
        outcome === "executed"
          ? "Done: one swap bought for the whole batch at one price."
          : outcome === "expired"
            ? "Nobody executed the batch in its window: every commit is refunded in full."
            : outcome === "empty"
              ? "Nobody joined: there was no batch to start."
              : "Anyone can start the batch. Other buys stay blocked until this window ends.",
      boundary: launch.executeEndTs,
      starts: launch.commitEndTs,
    },
    {
      phase: "guarded",
      short: "Limits",
      title: "Early limits",
      when: `${formatTimestamp(launch.executeEndTs)} → ${formatTimestamp(launch.guardEndTs)}`,
      detail: guardRules(launch),
      boundary: launch.guardEndTs,
      starts: launch.executeEndTs,
    },
    {
      phase: "open",
      short: "Open",
      title: "Open trading",
      when: `from ${formatTimestamp(launch.guardEndTs)}`,
      detail: "No limits: every transfer is allowed until the token graduates.",
      boundary: null,
      starts: launch.guardEndTs,
    },
    {
      phase: "graduated",
      short: "Graduate",
      title: "Graduation",
      when: launch.market?.migrated ? "moved to a bigger pool" : launch.market?.curveComplete ? "curve complete, moving now" : "when the curve fills",
      detail: "Its liquidity moves to a bigger pool.",
      boundary: null,
      starts: null,
    },
  ];
  const stateOf = (i: number, p: LaunchPhase): StepState => {
    if (p === "open" && phase === "graduated" && !guardOver) return "skipped";
    return i < current ? "done" : i === current ? "current" : "upcoming";
  };
  const stateWord = (s: (typeof steps)[number], st: StepState): string => {
    if (st === "done") return "done";
    if (st === "skipped") return "skipped";
    if (st === "current") return s.boundary !== null ? `ends in ${formatDuration(Number(s.boundary) - now)}` : "now";
    if (s.starts !== null) return `in ${formatDuration(Number(s.starts) - now)}`;
    return `at ${formatSolExact(launch.migrationQuoteThreshold)}`;
  };
  const now_ = steps[current];
  return (
    <Panel title="Timeline" status={<PhaseChip phase={phase} />} className="tk-life">
      <ol className="tk-pipe" aria-label="Launch timeline" style={{ "--n": current } as CSSProperties}>
        {steps.map((s, i) => {
          const st = stateOf(i, s.phase);
          return (
            <li key={s.phase} className="tk-pipe-step" data-state={st} aria-current={st === "current" ? "step" : undefined} style={{ "--i": i } as CSSProperties}>
              <span className="tk-pipe-node" aria-hidden="true">
                {st === "done" ? "✓" : st === "skipped" ? "×" : ""}
              </span>
              <span className="tk-pipe-name">{s.short}</span>
              <span className="tk-pipe-when">{stateWord(s, st)}</span>
            </li>
          );
        })}
      </ol>
      {now_ !== undefined ? (
        <div className="tk-now">
          <p className="tk-now-k">Now: {now_.title}</p>
          <p className="tk-now-t">{now_.detail}</p>
        </div>
      ) : null}
      <Details summary="Full schedule">
        <ol className="tk-sched" aria-label="Schedule">
          {steps.map((s) => {
            const st = stateOf(steps.indexOf(s), s.phase);
            return (
              <li key={s.phase} className="tk-sched-row" data-state={st}>
                <span className="tk-sched-dot" aria-hidden="true" />
                <div className="tk-sched-main">
                  <p className="tk-sched-title">
                    <span>{s.title}</span>
                    {st === "current" ? <Chip tone="signal">now</Chip> : null}
                    {st === "skipped" ? <Chip tone="muted">skipped</Chip> : null}
                  </p>
                  <p className="tk-sched-when">{s.when}</p>
                  <p className="tk-sched-detail">{s.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </Details>
    </Panel>
  );
}

// ------------------------------------------------------------- pq status ---

/** The worst status among the report's checks with these ids ("none" when none of them ran). */
function worst(report: VerificationReport | undefined, ids: readonly string[]): "pass" | "warn" | "fail" | "none" {
  const found = report?.checks.filter((c) => ids.includes(c.id)) ?? [];
  if (found.length === 0) return "none";
  if (found.some((c) => c.status === "fail")) return "fail";
  if (found.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

/**
 * Quantum safety: what a quantum attacker could still reach on this launch,
 * from the live checks (nothing to steal: no authorities, no key on the
 * liquidity, no admin) to what stays classical (a wallet balance, the rails
 * underneath). Honest by design.
 */
export function PqStatusPanel({ report }: { report: VerificationReport | undefined }): ReactNode {
  const authorities = worst(report, ["mint.mintAuthority", "certificate.bit1", "mint.freezeAuthority", "certificate.bit2", "mint.metadata", "certificate.bit4"]);
  const liquidity = worst(report, ["dbc.lpLocked", "certificate.bit64", "damm.lpLocked", "damm.lock"]);
  const roles = worst(report, ["certificate.exists", "certificate.account", "launch.account"]);
  const pending = report === undefined;
  // The creator's quantum signature, re-verified by the verifier here: shown as proof only when it verified.
  const origin = report?.pqOrigin !== null && report?.pqOrigin !== undefined && report.pqOrigin.verified ? report.pqOrigin : null;
  const originFailed = report?.checks.some((c) => c.id === "pq.origin" && c.status === "fail") === true;
  return (
    <Panel
      title="Quantum safety"
      description="A quantum computer could break ordinary wallet keys. It cannot steal a key that does not exist. Read from the live checks below."
      className="tk-pq"
    >
      <Checks label="Quantum safety">
        <CheckLine i={0} status={pending ? "none" : authorities} detail="Nobody can mint more, freeze tokens or change the name: those powers are switched off for good (checked live).">
          No authority to steal
        </CheckLine>
        <CheckLine i={1} status={pending ? "none" : liquidity} detail="The pool and its locked liquidity belong to program addresses, which have no private key.">
          No key holds the liquidity
        </CheckLine>
        <CheckLine i={2} status={pending ? "none" : roles} detail="Every launch role is a program address, and the launchpad has no admin, pause or withdraw switch.">
          No admin key
        </CheckLine>
        <CheckLine
          i={3}
          status={pending ? "none" : origin !== null ? "pass" : originFailed ? "fail" : "none"}
          detail={
            origin !== null
              ? `Signed by the creator's quantum key (key ID ${shortId(toHex(origin.identityId))}) before it went live, and checked again here. Its one-time signature can be used once only, ever.`
              : originFailed
                ? "No valid quantum signature by the creator was found for this launch."
                : "Checking the creator's quantum signature."
          }
        >
          {origin !== null ? "Signed by the creator's quantum key" : originFailed ? "Creator's quantum signature: missing" : "Creator's quantum signature"}
        </CheckLine>
        <CheckLine
          i={4}
          status="warn"
          detail={
            <>
              Tokens in an ordinary wallet sit behind a key a large quantum computer could break. The vault opens only with a one-time post-quantum key.{" "}
              <Link to="/vault" className="link">
                Open the vault
              </Link>
            </>
          }
        >
          Your balance, in a wallet
        </CheckLine>
        <CheckLine
          i={5}
          status="warn"
          detail={
            <>
              Solana itself, Token-2022 and Meteora's programs are still secured by classical keys and multisigs.{" "}
              <Link to="/security" className="link">
                Who you still trust
              </Link>
            </>
          }
        >
          The rails underneath
        </CheckLine>
      </Checks>
    </Panel>
  );
}

// --------------------------------------------------------------- accounts ---

/** The launch's program accounts. */
export function AccountsFold({ launch }: { launch: LaunchAccount }): ReactNode {
  const pdas = launchPdasFromLaunch(launch.publicKey);
  const mint = launch.baseMint;
  const m = launch.market;
  return (
    <Fold label="Program accounts" status={`${m?.dammPool ? 8 : 7} accounts`} id="accounts">
      <Readout label="Program accounts">
        <Row k="Launch">
          <Address value={launch.publicKey} explorer />
        </Row>
        <Row k="Launch authority">
          <Address value={pdas.launchAuthority} explorer />
        </Row>
        <Row k="Batch authority">
          <Address value={pdas.batchAuthority} explorer />
        </Row>
        <Row k="DBC config">
          <Address value={launch.dbcConfig} explorer />
        </Row>
        <Row k="DBC pool">
          <Address value={launch.pool} explorer />
        </Row>
        {m?.dammPool ? (
          <Row k="DAMM v2 pool">
            <Address value={m.dammPool} explorer />
          </Row>
        ) : null}
        <Row k="Certificate">
          <Address value={certificateAddress(mint)} explorer />
        </Row>
        <Row k="Hook policy">
          <Address value={hookPolicyAddress(mint)} explorer />
        </Row>
      </Readout>
    </Fold>
  );
}
