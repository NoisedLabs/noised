import { useConnection } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useEffect, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

import { useAsync, useNow } from "../../app/hooks";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { TokenIcon } from "../../components/Identicon";
import { guardRules, PHASE_INFO } from "../../components/launch";
import { LaunchTracker, useLaunchFlows } from "../../components/launchTracker";
import { demoTokenIcon } from "../../components/tokenArt";
import { TokenAbout, useTokenMeta, verifiedTokenMeta } from "../../components/tokenMeta";
import { setStripContext } from "../../fx/stripContext";
import { Address, Alert, Button } from "../../components/ui";
import { When } from "../../components/When";
import { DotSpinner } from "../../fx/noise";
import { formatSolExact } from "../../lib/amounts";
import { describeSeconds, formatClock, shortKey, unixSecs } from "../../lib/format";
import {
  buildLaunchTx,
  checkQsl1,
  fetchAttestation,
  fetchLaunch,
  fetchLaunchByMint,
  getMintInfo,
  launchPhase,
  MIGRATION_FEE_TIERS_BPS,
  verifyAttestation,
  verifyLaunch,
  type LaunchAccount,
} from "../../lib/noised";
import { windowState, type WindowState } from "../../lib/launchWindow";
import { ownTitle } from "../../app/titles";
import { QslBadge } from "../../components/qsl/QslBadge";
import { ProgrammableNotice, QslReport, scrollToId } from "../verify/QslReport";
import "../verify/verify.css";
import { Comment, Crumbs, PageHead, Panel, Readout, Reason, Row, Tiles, Metric, useStickyFit } from "../inner/kit";
import { TokenCoin } from "../inner/art";
import { CertificateReadout, TrustFold, TrustList, VerificationReadout } from "../inner/readouts";
import { BatchPanel } from "./BatchPanel";
import { FeesPanel } from "./FeesPanel";
import { AutopilotCard, LaunchRulesCard } from "./ProgrammableCards";
import { AccountsFold, CurvePanel, LifecyclePanel, PHASE_TONE, PhaseChip, phaseEnd, PqStatusPanel, TokenHeader } from "./TokenParts";
import { TradePanel } from "./TradePanel";
import "./token.css";

/** Loading state of the page. */
function Loading({ label }: { label: string }): ReactNode {
  return (
    <div className="pg pg-loading">
      <DotSpinner size={48} decorative />
      <p className="pg-wait" role="status">
        {label}…
      </p>
    </div>
  );
}

export function TokenPage(): ReactNode {
  const { address = "" } = useParams();
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(address);
  } catch {
    key = null;
  }
  if (!key) {
    return (
      <div className="pg">
        <Crumbs here="Invalid address" />
        <Alert tone="fail" title="Not a valid address">
          <code className="pg-break">{address}</code> is not a Solana address.
        </Alert>
      </div>
    );
  }
  return <TokenResolver key={key.toBase58()} address={key} />;
}

/** The address may be a mint (live launch) or a Launch account (configured, not launched yet). */
function TokenResolver({ address }: { address: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const resolved = useAsync(async () => {
    const byMint = await fetchLaunchByMint(connection, address);
    if (byMint) return { kind: "live" as const, launch: byMint };
    // A mint without a certificate is not a Noised launch (and is not a Launch account either).
    if ((await getMintInfo(connection, address)) !== null) return { kind: "unknown" as const };
    const byLaunch = await fetchLaunch(connection, address);
    if (byLaunch) return byLaunch.status === "live" ? { kind: "redirect" as const, launch: byLaunch } : { kind: "configured" as const, launch: byLaunch };
    return { kind: "unknown" as const };
  }, [connection, address.toBase58()]);

  if (resolved.error) {
    return (
      <div className="pg">
        <Crumbs here={shortKey(address, 4)} />
        <Alert tone="fail" title="Could not load this address">
          {resolved.error}
        </Alert>
      </div>
    );
  }
  if (!resolved.data) return <Loading label="Reading the launch" />;
  const r = resolved.data;
  if (r.kind === "live") return <LiveToken launch={r.launch} />;
  if (r.kind === "redirect") return <LiveToken launch={r.launch} />;
  if (r.kind === "configured") return <ConfiguredLaunch launch={r.launch} onLaunched={resolved.reload} />;
  return <UnknownMint mint={address} />;
}

function LiveToken({ launch }: { launch: LaunchAccount }): ReactNode {
  const { connection } = useConnection();
  const now = useNow();
  const mint = launch.baseMint;
  const live = useAsync(() => fetchLaunchByMint(connection, mint), [connection, mint.toBase58()]);
  // A full verification costs a dozen RPC reads: it runs on load and on demand, not on every refresh.
  const report = useAsync(() => verifyLaunch(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  // Its QSL-1 verdict (the badge by its name and the report below): checked on load and on demand.
  const qsl = useAsync(() => checkQsl1(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  // The token's own details, from the on-chain record its certificate names.
  const meta = useTokenMeta({ mint });
  // This browser's launch of it, while its last step (the leftover SOL) is still going.
  const flow = useLaunchFlows().find((f) => f.launch.equals(launch.publicKey) && !f.done) ?? null;
  const l = live.data ?? launch;
  const phase = launchPhase(l, unixSecs(now));
  const m = l.market;
  const symbol = m?.symbol ?? "TOKEN";
  const checks = report.data ? { passed: report.data.checks.filter((c) => c.status === "pass").length, total: report.data.checks.length } : null;
  const aside = useStickyFit<HTMLElement>();

  // The pill under the navbar shows this page's context: "AEGS · Batch open · closes in 11m 43s".
  const end = phaseEnd(l, phase);
  useEffect(() => {
    const tone = PHASE_TONE[phase];
    setStripContext({
      symbol,
      phase: PHASE_INFO[phase].label,
      endsAt: end === null ? null : Number(end),
      endsLabel: phase === "commit" ? "closes in" : phase === "execute" ? "execute window" : "guard ends in",
      tone: tone === "danger" ? "signal" : tone,
    });
  }, [symbol, phase, end]);
  useEffect(() => () => setStripContext(null), []);
  useEffect(() => {
    document.title = ownTitle(m?.name ? `${m.name} (${symbol})` : symbol);
  }, [m?.name, symbol]);

  return (
    <div className="pg tkp">
      <Crumbs here={symbol} />
      <TokenHeader
        launch={l}
        phase={phase}
        now={now}
        name={m?.name ?? "Unnamed"}
        symbol={symbol}
        verification={report.data?.overall ?? null}
        verifying={report.loading}
        checks={checks}
        image={meta?.icon?.dataUri ?? null}
        badge={
          <QslBadge
            verdict={qsl.data}
            loading={qsl.loading}
            error={qsl.error}
            onSeeAll={() => scrollToId("qsl", "qsl-all")}
            onReadRules={() => scrollToId("qsl-rules")}
          />
        }
      />
      {/* QSL-1 revision 0.4: rules or automation the creator added, with every warning, before anything else. */}
      <ProgrammableNotice verdict={qsl.data} onRead={() => scrollToId("qsl-rules")} />

      <div className="tk-grid">
        <aside className="tk-aside" aria-label="Actions" ref={aside}>
          <BatchPanel launch={l} phase={phase} now={now} symbol={symbol} trade={<TradePanel launch={l} phase={phase} now={now} symbol={symbol} />} />
        </aside>
        <div className="tk-main">
          {flow !== null ? <LaunchTracker view={flow} compact /> : null}
          {meta !== null && (meta.description !== null || meta.links.length > 0) ? (
            <Panel title={`About ${symbol}`} description="From its creator, stored on Solana with the token and signed by their quantum key. Links are shown as text: check the address before you visit one.">
              <TokenAbout meta={meta} />
            </Panel>
          ) : null}
          <CurvePanel launch={l} phase={phase} now={now} symbol={symbol} />
          <QslReport verdict={qsl.data} loading={qsl.loading} error={qsl.error} onRefresh={qsl.reload} compact />
          <LifecyclePanel launch={l} phase={phase} now={now} />
          {/* PROGRAMMABLE_V1 §6: the launch's extra rules and its Autopilot, in plain English with their checks. */}
          <LaunchRulesCard launch={l} now={now} />
          <AutopilotCard launch={l} />
          <PqStatusPanel report={report.data} />
          <VerificationReadout report={report.data} loading={report.loading} error={report.error} onRefresh={report.reload} />
          <CertificateReadout certificate={report.data ? report.data.certificate : undefined} />
          <TrustFold parties={report.data?.trustedParties} />
          <AccountsFold launch={l} />
          <FeesPanel launch={l} symbol={symbol} />
        </div>
      </div>
    </div>
  );
}

/**
 * A launch that is set up but not open yet. Its token's details (name, symbol, icon, description, links) are the
 * record its creator's quantum key signed: shown only when that signature re-verifies from the chain. Before its
 * window: "Waiting for its quantum signature" or "Opens in mm:ss"; inside it, anyone can open it; after it, its
 * creator picks a new time (audit round 3 F1). When this browser runs the launch, its tracker shows here too.
 */
function ConfiguredLaunch({ launch, onLaunched }: { launch: LaunchAccount; onLaunched: () => void }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const navigate = useNavigate();
  const now = useNow();
  const flows = useLaunchFlows();
  const mine = flows.find((f) => f.launch.equals(launch.publicKey)) ?? null;
  const attestation = useAsync(() => fetchAttestation(connection, launch.publicKey), [connection, launch.publicKey.toBase58()]);
  const verified = useAsync(() => verifyAttestation(connection, launch.publicKey), [connection, launch.publicKey.toBase58()]);
  const meta = verified.data === undefined ? null : verifiedTokenMeta(verified.data);
  const a = attestation.data ?? null;
  const state = attestation.data === undefined ? null : windowState(a, unixSecs(now));
  const ok = state?.kind === "open";
  const symbol = meta?.symbol ?? null;
  // Its own icon first; the demo's hand-made art only in demo builds (null in live ones); else its pixel coin.
  const demoIcon = meta === null || meta.icon !== null ? null : demoTokenIcon(meta.symbol);

  return (
    <div className="pg tkp-pre">
      <Crumbs here={symbol ?? "Not launched yet"} />
      <PageHead
        eyebrow="Not launched yet"
        title={meta === null ? "Ready to launch" : `${meta.name} (${meta.symbol})`}
        lede="Its rules are recorded on Solana and its creator's quantum key signs when it opens. Nothing can be traded yet: opening it creates the token and its pool, and starts the opening batch."
      />
      {meta !== null ? (
        <section className="tkp-pre-id glass" aria-label="The token">
          {meta.icon !== null ? (
            <span className="tk-coin tk-icon px-icon-tile px-corners px-frame" aria-hidden="true">
              <TokenIcon address={launch.publicKey} image={meta.icon.dataUri} size={96} className="tk-icon-art" />
            </span>
          ) : demoIcon !== null ? (
            <span className="tk-coin tk-icon px-icon-tile px-corners px-frame" aria-hidden="true">
              <TokenIcon address={launch.publicKey} icon={demoIcon} size={96} className="tk-icon-art" />
            </span>
          ) : (
            <TokenCoin address={launch.publicKey} className="tk-coin" />
          )}
          <div className="tkp-pre-text">
            <p className="tkp-pre-signed">Signed by its creator&apos;s quantum key · stored on Solana</p>
            <TokenAbout meta={meta} />
          </div>
        </section>
      ) : null}
      <Tiles label="Launch summary">
        <Metric label="Status" value={<PhaseChip phase="configured" />} />
        <Metric label="Graduates at" value={formatSolExact(launch.migrationQuoteThreshold)} />
        <Metric label="Batch window" value={describeSeconds(launch.openDelaySecs)} />
        <Metric label="Guard" value={describeSeconds(launch.guardSecs)} />
      </Tiles>
      {mine !== null ? <LaunchTracker view={mine} /> : null}
      <div className="pg-cols">
        <Panel title="Fixed rules" description="Recorded when the launch was created. Opening it creates the pool, the token, the guard rules and the certificate in one go.">
          <Readout label="Fixed rules">
            <Row k="Launch">
              <Address value={launch.publicKey} explorer />
            </Row>
            <Row k="Creator">
              <Address value={launch.creator} explorer />
            </Row>
            <Row k="Graduates at">{formatSolExact(launch.migrationQuoteThreshold)}</Row>
            <Row k="Fee after graduation">{(MIGRATION_FEE_TIERS_BPS[launch.migrationFeeOption] ?? 0) / 100}%</Row>
            <Row k="Batch window">{describeSeconds(launch.openDelaySecs)}</Row>
            <Row k="Guard" wide>
              {describeSeconds(launch.guardSecs)}: {guardRules(launch)}
            </Row>
            <Row k="Batch caps" wide>
              {launch.batchWalletCap === 0n ? "no per-wallet cap" : `${formatSolExact(launch.batchWalletCap)} per wallet`}; the batch buys with up to {formatSolExact(launch.batchTotalCap)} (above that, everyone gets the same share and the extra comes back)
            </Row>
          </Readout>
        </Panel>
        <Panel title="Open the launch" description="Anyone can open it during the hour its creator signed for. The first one to go through wins; it then starts the batch." tone={state?.kind === "open" ? "signal" : undefined}>
          {attestation.error ? <Alert tone="fail">Could not read the creator&apos;s signature: {attestation.error}</Alert> : null}
          {state === null && !attestation.error ? <p className="pg-wait">Reading the creator&apos;s signature…</p> : null}
          {state !== null ? <OpeningStatus state={state} now={now} mine={mine !== null} /> : null}
          {state?.kind === "open" ? (
            <div className="pg-stack">
              <p className="pg-text">
                Open until <When t={state.closesAt} />. Anyone can open it now: the token gets the name, symbol and icon its creator signed, stored on Solana. You pay only the fees and the new accounts&apos; rent.
              </p>
              <div className="pg-btns">
                <Button
                  variant="primary"
                  disabled={!ok || !owner.publicKey}
                  onClick={() => {
                    const me = owner.publicKey;
                    if (!me || !ok) return;
                    const mint = Keypair.generate();
                    void run({
                      title: symbol === null ? "Open the launch" : `Open the ${symbol} launch`,
                      summary: [
                        `Creates the ${symbol ?? "token's"} mint (a fresh key made in this browser) and its Meteora pool on the launch's fixed settings.`,
                        "Checks the creator's quantum signature and its time, gives the token the name and symbol stored on Solana, then writes the Launch Guard rules and the launch certificate.",
                        "Starts the opening batch right away. Anyone may send this during the window: the first one to land wins.",
                      ],
                      build: async () => (await buildLaunchTx(connection, me, launch.publicKey, mint)).tx,
                      extraSigners: [mint],
                      signerLabels: [{ key: mint.publicKey, label: "New token mint (made in this browser)" }],
                    }).then((o) => {
                      if (o.status === "confirmed") {
                        onLaunched();
                        void navigate(`/token/${mint.publicKey.toBase58()}`);
                      }
                    });
                  }}
                >
                  Open the launch
                </Button>
              </div>
              {!owner.publicKey ? <Reason>Connect a wallet to open it</Reason> : null}
            </div>
          ) : null}
        </Panel>
      </div>
      <LaunchRulesCard launch={launch} now={now} />
    </div>
  );
}

/**
 * Where a configured launch stands against its signed window, in plain words: waiting for its quantum signature,
 * "Opens in mm:ss", or "The opening time passed — pick a new one" (audit round 3 F1: its creator signs a new time).
 * Inside the window the page offers "Open the launch" itself.
 */
export function OpeningStatus({ state, now, mine }: { state: WindowState; now: number; mine: boolean }): ReactNode {
  if (state.kind === "unsigned") {
    return (
      <Alert tone="info" title="Waiting for its quantum signature">
        Its creator&apos;s quantum key has not signed it yet. Once it signs, anyone can open it during the hour it names.
      </Alert>
    );
  }
  if (state.kind === "burned") {
    return (
      <Alert tone="info" title="Waiting for its quantum signature">
        The last signature did not count (it only used up one of the creator&apos;s one-time signatures). The creator signs again.
      </Alert>
    );
  }
  if (state.kind === "soon") {
    return (
      <div className="tkp-pre-soon">
        <p className="tkp-pre-count" role="timer" aria-live="off">
          Opens in {formatClock(Number(state.opensAt) - now)}
        </p>
        <p className="pg-text">
          Anyone can open it from <When t={state.opensAt} /> until <When t={state.closesAt} />. The first one to go through wins.
        </p>
      </div>
    );
  }
  if (state.kind === "missed") {
    return (
      <Alert tone="warn" title="The opening time passed — pick a new one">
        Nobody opened it before <When t={state.closedAt} />.{" "}
        {mine ? "Pick a new time in your launch's steps above: your quantum key signs it." : "Its creator can sign a new opening time with their quantum key; then anyone can open it again."}
      </Alert>
    );
  }
  return null;
}

function UnknownMint({ mint }: { mint: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const report = useAsync(() => verifyLaunch(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  // "Not QSL-1" (Appendix A.1), from the same standard check as every other token.
  const qsl = useAsync(() => checkQsl1(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  return (
    <div className="pg">
      <Crumbs here="Verify" />
      <PageHead
        eyebrow="Verify"
        title="Not a Noised launch"
        lede={
          <>
            <code className="pg-break">{mint.toBase58()}</code> has no Noised launch certificate. The checks below show what was looked at.
          </>
        }
      >
        <QslBadge verdict={qsl.data} loading={qsl.loading} error={qsl.error} />
      </PageHead>
      <div className="pg-cols">
        <VerificationReadout report={report.data} loading={report.loading} error={report.error} onRefresh={report.reload} />
        <Panel title="Who you still trust">
          <TrustList parties={report.data?.trustedParties} />
        </Panel>
      </div>
      <Comment>A mint without a certificate was never launched by the Noised launchpad; its guarantees are whatever its own authorities allow.</Comment>
    </div>
  );
}
