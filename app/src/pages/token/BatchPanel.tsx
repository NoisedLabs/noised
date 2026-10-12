/**
 * Fair-open batch: commit during the window, execute it (manually or armed at
 * commit end), claim afterwards. The total cap never refuses a commit: the
 * batch swap spends min(total committed, cap) and every commit gets the same
 * share of it (`expectedBatchFill`), the rest refunded at claim.
 *
 * Presented as the token page's glass action panel: tabs Commit / Claim /
 * Trade. Every tab stays mounted while hidden, so an armed auto-execute or a
 * half-typed amount survives a tab switch.
 *
 * A commit can send its share of tokens straight into the committer's
 * quantum vault (the payout owners are fixed by the first commit), held to
 * the per-wallet cap together with every other commit naming that vault.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Alert, Button, Countdown, Field } from "../../components/ui";
import { formatSol, formatSolExact, formatUnits, SOL_DECIMALS, tryParseUnits } from "../../lib/amounts";
import { attemptOf, crankNext } from "../../lib/crank";
import { formatDuration, formatTimestamp, percent, shortKey, unixSecs } from "../../lib/format";
import {
  batchOutcome,
  batchShare,
  buildClaimTx,
  buildCommitTx,
  buildExecuteBatchTx,
  expectedBatchFill,
  fetchCommit,
  fetchPayoutVault,
  getSolBalance,
  type BatchFill,
  type CommitAccount,
  type LaunchAccount,
  type LaunchPhase,
} from "../../lib/noised";
import { claimRefundNote, closesWsolAccount, commitWsolNote } from "../../lib/wsol";
import { AmountInput, Comment, DotBar, Metric, NoteBox, Reason, tabPanel, Tabs, type TabItem } from "../inner/kit";
import { fraction } from "./TokenParts";
import { useVaultTarget, VaultChoice } from "./VaultTarget";

/** Lamports kept back for fees and the commit account's rent when filling "max". */
const COMMIT_RESERVE = 10_000_000n;

/** "65.12%" from basis points. */
const pctOfBps = (bps: number): string => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** The fill of the batch as it stands (and of `mine`, the connected wallet's commit), or null if it cannot be computed. */
function fillOf(launch: LaunchAccount, extra: bigint, mine: bigint): BatchFill | null {
  try {
    return expectedBatchFill(launch, extra, mine);
  } catch {
    return null;
  }
}

/** Why committing early, late, or from several wallets changes nothing. */
const ORDER_NOTE =
  "Commit order does not matter: the batch buys in one swap after the window closes, and every commit, first or last, gets the same price and the same fill. Committing early, splitting across wallets or bundling a commit with the launch gives no advantage.";

type ActionTab = "commit" | "claim" | "trade";

const STATUS_WORD = { executed: "Done", expired: "Expired", empty: "Empty", pending: "Waiting to start" } as const;

export function BatchPanel({ launch, phase, now, symbol, trade }: { launch: LaunchAccount; phase: LaunchPhase; now: number; symbol: string; trade: ReactNode }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const commit = useAsync(() => (me ? fetchCommit(connection, launch.publicKey, me) : Promise.resolve(null)), [connection, launch.publicKey.toBase58(), me?.toBase58()]);
  const outcome = batchOutcome(launch, unixSecs(now));
  const mine = commit.data?.amount ?? 0n;
  const share = launch.executed && mine > 0n ? batchShare(mine, launch.totalCommitted, launch.quoteSpent, launch.tokensOut) : null;
  const fill = fillOf(launch, 0n, mine);

  // Presentation: which tab shows first follows the launch's stage until the user works in the panel.
  const batchOpen = phase === "commit" || phase === "execute";
  const claimsOpen = launch.executed || outcome === "expired";
  const claimable = claimsOpen && me !== null && mine > 0n && commit.data?.claimed !== true;
  const preferred: ActionTab = batchOpen ? "commit" : claimable ? "claim" : "trade";
  const stage = batchOpen ? "batch" : claimsOpen ? "after" : "other";
  const [picked, setPicked] = useState<ActionTab | null>(null);
  const [pickedIn, setPickedIn] = useState(stage);
  if (pickedIn !== stage) {
    setPickedIn(stage);
    setPicked(null);
  }
  const tab = picked ?? preferred;
  const items: TabItem<ActionTab>[] = [
    { value: "commit", label: "Commit", badge: batchOpen ? <i className="pg-live-dot" aria-label="open now" /> : undefined },
    { value: "claim", label: "Claim", badge: claimable ? <span aria-label="1 claim waiting">1</span> : undefined },
    { value: "trade", label: "Trade" },
  ];
  const cap = launch.batchTotalCap;
  const scale = launch.totalCommitted > cap ? launch.totalCommitted : cap;

  return (
    <section
      className="tk-action glass pg-glass"
      aria-label="Commit, claim and trade"
      // Once the user works in a tab, it stays put (it no longer follows the launch's state, e.g. after a claim).
      onPointerDownCapture={() => {
        if (picked === null) setPicked(tab);
      }}
      onClickCapture={() => {
        if (picked === null) setPicked(tab);
      }}
      onKeyDownCapture={() => {
        if (picked === null) setPicked(tab);
      }}
    >
      <Tabs items={items} value={tab} onChange={setPicked} label="Launch actions" idBase="act" className="tk-action-tabs" />

      <div {...tabPanel("act", "commit", tab)}>
        <header className="tk-act-head">
          <h2 className="tk-act-title">The opening batch</h2>
          <p className="tk-act-sub">Everyone in the batch pays the same price, in one swap.</p>
        </header>

        <div className="tk-metrics">
          <Metric label="In the batch" value={formatSol(launch.totalCommitted, 2)} hint={`the batch spends at most ${formatSolExact(launch.batchTotalCap)}`} />
          <Metric
            label={launch.executed ? "Used of each share" : "Used of each share"}
            value={fill === null ? "—" : pctOfBps(fill.fillBps)}
            hint={fill === null ? undefined : fill.oversubscribed ? "more came in than it buys with: the rest comes back" : launch.executed ? "of everyone's SOL" : "of everyone's SOL, at most"}
          />
          <Metric
            label="Your commit"
            value={me ? formatSol(mine, 4) : "—"}
            hint={me ? (commit.data?.claimed ? "claimed" : launch.batchWalletCap === 0n ? "no limit per wallet" : `up to ${formatSolExact(launch.batchWalletCap)} per wallet`) : "connect a wallet"}
          />
          <Metric
            label={phase === "commit" ? "Closes in" : "Status"}
            value={phase === "commit" ? (Number(launch.commitEndTs) - now > 0 ? formatDuration(Number(launch.commitEndTs) - now) : "now") : STATUS_WORD[outcome]}
            tone={phase === "commit" ? "signal" : undefined}
          />
        </div>

        <div className="tk-gauge">
          <div className="tk-gauge-top">
            <span>In the batch vs what it buys with</span>
            <span className="pg-num">
              {formatSol(launch.totalCommitted, 2)} / {formatSolExact(cap)}
            </span>
          </div>
          <DotBar
            value={fraction(launch.totalCommitted < cap ? launch.totalCommitted : cap, scale)}
            max={1}
            over={fraction(launch.totalCommitted > cap ? launch.totalCommitted - cap : 0n, scale)}
            label="SOL in the batch against what it buys with"
          />
          <div className="tk-gauge-legend" aria-hidden="true">
            <span data-k="spent">buys tokens</span>
            {launch.totalCommitted > cap ? <span data-k="over">comes back to you</span> : <span data-k="room">room left</span>}
          </div>
        </div>

        <div className="tk-act-stack">
          {phase === "commit" ? <CommitForm launch={launch} mine={mine} commit={commit.data ?? null} symbol={symbol} /> : null}
          {/* The permissionless crank sits right under the form, above the explanations. */}
          {(phase === "commit" || phase === "execute") && !launch.executed ? <ExecuteCrank launch={launch} phase={phase} now={now} /> : null}
          {!batchOpen ? <Comment>The commit window closed {formatTimestamp(launch.commitEndTs)}. Results and claims are under Claim.</Comment> : null}
          {!me && phase !== "commit" ? <p className="pg-note ip-need-wallet">Connect a wallet to commit or claim.</p> : null}
        </div>

        <div className="tk-act-notes">
          <h3 className="tk-act-notes-k">How the batch works</h3>
          <Comment>
            Everyone who joins during the window buys together, in one go, at one price. Everyone gets the same share of the batch for what they put
            in; if more SOL comes in than the batch buys with, the extra SOL comes back to you.
          </Comment>
          {!launch.executed && outcome === "pending" && fill !== null ? <PendingFill launch={launch} fill={fill} mine={mine} /> : batchOpen ? <Comment>{ORDER_NOTE}</Comment> : null}
        </div>
      </div>

      <div {...tabPanel("act", "claim", tab)}>
        <header className="tk-act-head">
          <h2 className="tk-act-title">Claim</h2>
          <p className="tk-act-sub">Collect your tokens and any SOL that was not used. Each share is collected once.</p>
        </header>
        <div className="tk-act-stack">
          {launch.executed ? (
            <NoteBox tone="ok" title="The batch has run">
              <p>
                {formatUnits(launch.tokensOut, launch.tokenDecimal, 0)} {symbol} bought for {formatSol(launch.quoteSpent, 4)} of {formatSol(launch.totalCommitted, 4)} committed,
                in one swap
                {launch.totalCommitted > launch.quoteSpent
                  ? `: ${fill === null ? "" : `${pctOfBps(fill.fillBps)} of everyone's SOL was used, and `}${formatSol(launch.totalCommitted - launch.quoteSpent, 4)} unused comes back when you claim`
                  : ""}
                . Average price {launch.tokensOut > 0n ? `${formatSol((launch.quoteSpent * 10n ** BigInt(launch.tokenDecimal)) / launch.tokensOut, 9)} per ${symbol}` : "n/a"}, the same for every
                commit.
              </p>
            </NoteBox>
          ) : null}
          {outcome === "expired" ? (
            <Alert tone="warn" title="The batch expired">
              Nobody started the batch before {formatTimestamp(launch.executeEndTs)}. Everyone gets all their SOL back by claiming.
            </Alert>
          ) : null}

          {(launch.executed || outcome === "expired") && me ? (
            <>
              {mine > 0n && !commit.data?.claimed ? (
                <div className="tk-claim">
                  <div className="tk-claim-main">
                    <p className="tk-claim-k">Your claim</p>
                    <p className="tk-claim-v pg-num">
                      {share
                        ? `${formatUnits(share.tokens, launch.tokenDecimal)} ${symbol}${share.refund > 0n ? ` + ${formatSol(share.refund, 6)} refund` : ""}`
                        : `${formatSol(mine, 4)} refund (full)`}
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => {
                      const refund = share ? share.refund : mine;
                      const toVault = commit.data !== undefined && commit.data !== null && !commit.data.tokenOwner.equals(me);
                      const lines = (refundLine: string | null): string[] => [
                        share
                          ? toVault && commit.data
                            ? `Pays ${formatUnits(share.tokens, launch.tokenDecimal)} ${symbol} into your quantum vault ${shortKey(commit.data.tokenOwner)} (chosen at your first commit).`
                            : `Pays ${formatUnits(share.tokens, launch.tokenDecimal)} ${symbol} to your token account (created if needed).`
                          : "The batch expired without executing: your whole commit comes back.",
                        ...(refundLine === null ? [] : [refundLine]),
                        "Each commit can be claimed once.",
                      ];
                      void run({
                        title: `Claim your ${symbol} batch ${share ? "tokens" : "refund"}`,
                        summary: lines(null),
                        build: async () => {
                          const tx = await buildClaimTx(connection, me, launch.publicKey, me);
                          // How the refund arrives is read from the built transaction: it unwraps only a wSOL account it creates.
                          const refundLine = refund > 0n ? claimRefundNote(formatSol(refund, share ? 6 : 4), closesWsolAccount(tx, me)) : "Nothing was left unspent, so there is no SOL refund.";
                          return { tx, summary: lines(refundLine) };
                        },
                      }).then(() => commit.reload());
                    }}
                  >
                    Claim
                  </Button>
                </div>
              ) : null}
              {commit.data && !commit.data.claimed && !commit.data.tokenOwner.equals(me) ? (
                <p className="pg-note">Your tokens go straight into your quantum vault {shortKey(commit.data.tokenOwner)}.</p>
              ) : null}
              {commit.data?.claimed ? <Alert tone="ok" title="You already claimed this batch." /> : null}
              <ClaimForOthers launch={launch} symbol={symbol} />
            </>
          ) : null}
          {!claimsOpen ? (
            <Comment>
              Claims open once the batch executes. If nobody executes it by {formatTimestamp(launch.executeEndTs)}, every commit is refunded in full by
              claiming.
            </Comment>
          ) : null}
          {!me ? <p className="pg-note ip-need-wallet">Connect a wallet to commit or claim.</p> : null}
        </div>
      </div>

      <div {...tabPanel("act", "trade", tab)}>{trade}</div>
    </section>
  );
}

function CommitForm({ launch, mine, commit, symbol }: { launch: LaunchAccount; mine: bigint; commit: CommitAccount | null; symbol: string }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const [text, setText] = useState("");
  const balance = useAsync(() => (me ? getSolBalance(connection, me) : Promise.resolve(null)), [connection, me?.toBase58()]);
  const amount = tryParseUnits(text, SOL_DECIMALS);
  // Where the tokens go: the first commit fixes it (the committer, or an opened PQ vault of the base mint).
  const target = useVaultTarget(launch.baseMint);
  const fixedTo = commit !== null && me !== null ? commit.tokenOwner : null;
  const [toVaultChoice, setToVaultChoice] = useState(false);
  const toVault = fixedTo !== null && me !== null ? !fixedTo.equals(me) : toVaultChoice;
  const vault = fixedTo !== null && me !== null && !fixedTo.equals(me) ? fixedTo : target.vault;
  // Everything committed for one vault is held to the per-wallet cap together (PayoutVault).
  const vaultTotal = useAsync(
    () => (toVault && vault !== null ? fetchPayoutVault(connection, launch.publicKey, vault) : Promise.resolve(null)),
    [connection, launch.publicKey.toBase58(), toVault, vault?.toBase58()],
  );
  const vaultRoom = !toVault || launch.batchWalletCap === 0n || vaultTotal.data === undefined ? null : launch.batchWalletCap - (vaultTotal.data?.committed ?? 0n);
  // Only the per-wallet cap refuses a commit; the total cap only scales every commit's fill.
  const walletRoom = launch.batchWalletCap === 0n ? null : launch.batchWalletCap - mine;
  const vaultReady = !toVault || (vault !== null && (fixedTo !== null || target.opened === true));

  let error: string | null = null;
  if (text.trim() !== "" && amount === null) error = "Enter an amount of SOL like 1.5 (at most 9 decimals).";
  else if (amount !== null && amount === 0n) error = "Commit more than 0 SOL.";
  else if (amount !== null && walletRoom !== null && amount > walletRoom) error = `The per-wallet cap leaves room for ${formatSolExact(walletRoom < 0n ? 0n : walletRoom)}.`;
  else if (amount !== null && vaultRoom !== null && amount > vaultRoom) error = `Your vault can take ${formatSolExact(vaultRoom < 0n ? 0n : vaultRoom)} more in this batch (the per-wallet cap counts everything sent to one vault).`;
  else if (amount !== null && balance.data !== undefined && balance.data !== null && amount + COMMIT_RESERVE > balance.data) {
    error = `Your balance is ${formatSol(balance.data, 4)}; keep about 0.01 SOL for fees and rent.`;
  }
  const after = amount !== null && amount > 0n && error === null ? fillOf(launch, amount, mine) : null;
  const tokenShare = after !== null ? Number(after.commit.amount) / Number(after.totalCommitted) : null;

  return (
    <form
      className="pg-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!me || amount === null || amount === 0n || error) return;
        const f = fillOf(launch, amount, mine);
        const summary = [
          `Wraps ${formatSol(amount, 4)} into wSOL and moves it into the batch escrow owned by the launch's batch PDA.`,
          f === null
            ? "When the commit window closes, anyone can execute the batch: one swap buys for everyone at the same price."
            : f.oversubscribed
              ? `The batch would then hold ${formatSol(f.totalCommitted, 4)} for a cap of ${formatSolExact(f.cap)}: about ${pctOfBps(f.fillBps)} of every commit is spent (yours: about ${formatSol(f.commit.spent, 4)}) and the rest refunded at claim. Later commits lower everyone's fill equally.`
              : `When the commit window closes, anyone can execute the batch: one swap buys for everyone at the same price with up to ${formatSol(f.fill, 4)} (everything committed, up to the cap).`,
          "If nobody executes it in time, you can claim a full refund.",
          ...(toVault && vault !== null ? [`Your share of ${symbol} will be paid into your quantum vault ${shortKey(vault)} when you claim; only your quantum key can move it out.`] : []),
        ];
        const tokenOwner = toVault && vault !== null ? vault : undefined;
        void run({
          title: `Commit ${formatSol(amount, 4)} to the ${symbol} batch`,
          summary,
          build: async () => {
            const tx = await buildCommitTx(connection, me, launch.publicKey, amount, tokenOwner === undefined ? {} : { tokenOwner });
            // What happens to the wSOL account is read from the built transaction: it closes only one it creates.
            return { tx, summary: [...summary, commitWsolNote(closesWsolAccount(tx, me))] };
          },
        }).then((o) => {
          if (o.status === "confirmed") setText("");
        });
      }}
    >
      <Field
        label="Amount to commit (SOL)"
        error={error}
        help={
          <>
            {balance.data !== undefined && balance.data !== null ? `Balance ${formatSol(balance.data, 4)}. ` : ""}
            {walletRoom !== null ? `Per-wallet room ${formatSolExact(walletRoom < 0n ? 0n : walletRoom)}. ` : "No per-wallet cap. "}
            {vaultRoom !== null ? `Your vault's room ${formatSolExact(vaultRoom < 0n ? 0n : vaultRoom)}. ` : ""}
            If more comes in than the batch buys with, everyone gets the same share and the extra SOL comes back.
          </>
        }
      >
        {(ids) => (
          <AmountInput
            id={ids.input}
            value={text}
            onChange={setText}
            unit="SOL"
            invalid={ids.invalid}
            describedBy={ids.describedBy}
            disabled={!me}
            maxDisabled={!me || balance.data === undefined || balance.data === null}
            onMax={() => {
              const bal = balance.data ?? 0n;
              const max = walletRoom === null || bal - COMMIT_RESERVE < walletRoom ? bal - COMMIT_RESERVE : walletRoom;
              setText(max > 0n ? formatUnits(max, SOL_DECIMALS).replaceAll(",", "") : "0");
            }}
          />
        )}
      </Field>
      {after !== null ? (
        <NoteBox title={`If you commit ${formatSol(after.commit.amount - mine, 4)} now`} tone="signal" live>
          <p>
            The batch would hold {formatSol(after.totalCommitted, 4)} for a cap of {formatSolExact(after.cap)}:{" "}
            {after.oversubscribed
              ? `about ${pctOfBps(after.fillBps)} of everyone's SOL is used. Of your ${formatSol(after.commit.amount, 4)} in total, about ${formatSol(after.commit.spent, 4)} buys tokens and at least ${formatSol(after.commit.refund, 4)} comes back when you claim.`
              : `all of it is spent, ${formatSol(after.commit.amount, 4)} of it yours (unless the swap completes the curve first; any unspent SOL is refunded at claim).`}{" "}
            {tokenShare !== null ? `You would get about ${percent(tokenShare)} of the batch's tokens. ` : ""}Anyone joining later lowers everyone's share equally.
          </p>
        </NoteBox>
      ) : null}
      <VaultChoice
        mint={launch.baseMint}
        symbol={symbol}
        target={target}
        checked={toVault}
        onChange={setToVaultChoice}
        fixed={fixedTo !== null}
        label={fixedTo !== null ? (toVault ? "My tokens go to my quantum vault (fixed by my first commit)" : "My tokens go to my wallet (fixed by my first commit)") : "Send my tokens to my quantum vault"}
      />
      {/* Why the primary is unavailable, right above it (the navbar's Connect glows while this shows). */}
      {!me ? <Reason id="commit-reason">Connect a wallet to commit</Reason> : null}
      <Button
        type="submit"
        variant="primary"
        className="pg-wide"
        disabled={!me || amount === null || amount === 0n || error !== null || !vaultReady}
        aria-describedby={!me ? "commit-reason" : undefined}
      >
        Review commit
      </Button>
    </form>
  );
}

/** The fill as the pending batch stands, and the connected wallet's expected spend and refund. */
function PendingFill({ launch, fill, mine }: { launch: LaunchAccount; fill: BatchFill; mine: bigint }): ReactNode {
  return (
    <NoteBox tone={fill.oversubscribed ? "warn" : undefined} title={fill.oversubscribed ? "More came in than the batch buys with" : "How much is used"}>
      <p>
        The batch buys with {formatSol(fill.fill, 4)} of the {formatSol(launch.totalCommitted, 4)} in it.{" "}
        {fill.oversubscribed
          ? `Everyone gets the same share: about ${pctOfBps(fill.fillBps)} of everyone's SOL is used, and the extra comes back when you claim.`
          : "All of it is used so far."}
        {mine > 0n
          ? ` Your ${formatSol(mine, 4)}: about ${formatSol(fill.commit.spent, 4)} used${fill.commit.refund > 0n ? `, at least ${formatSol(fill.commit.refund, 4)} back to you` : ""} (anyone joining later can lower it further).`
          : ""}
      </p>
      <p>{ORDER_NOTE}</p>
    </NoteBox>
  );
}

/**
 * The permissionless `execute_batch` crank, with an option to fire it
 * automatically at commit end. Armed, it keeps trying (lib/crank.ts): an
 * attempt that fails for a passing reason (the window edge, a busy RPC) is
 * retried with a growing pause until the batch executes or the window
 * closes; one that can never succeed stops it and says why.
 */
function ExecuteCrank({ launch, phase, now }: { launch: LaunchAccount; phase: LaunchPhase; now: number }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run, busy } = useTx();
  const me = owner.publicKey;
  const [armed, setArmed] = useState(false);
  const fired = useRef(false);
  // Armed retries: when the next attempt may start (cluster seconds), and how many ran.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const attempts = useRef(0);
  // The cluster clock as of the last render: an attempt's outcome arrives later, and its retry is timed on the same clock it is compared with.
  const clock = useRef(now);
  useEffect(() => {
    clock.current = now;
  }, [now]);
  const [stopped, setStopped] = useState<string | null>(null);
  const windowOpen = phase === "execute";
  const empty = launch.totalCommitted === 0n;

  const execute = (auto: boolean): Promise<void> | void => {
    if (!me) return;
    return run({
      title: "Execute the batch",
      summary: [
        launch.totalCommitted > launch.batchTotalCap
          ? `One Meteora DBC swap buys with the cap, ${formatSolExact(launch.batchTotalCap)} of the ${formatSol(launch.totalCommitted, 4)} committed (partial fill allowed at the graduation price); the rest is refunded pro rata at claim.`
          : `One Meteora DBC swap buys with all ${formatSol(launch.totalCommitted, 4)} committed (partial fill allowed at the graduation price).`,
        "The tokens stay in the batch escrow; every participant claims their pro-rata share.",
        "Permissionless: you pay only the network fee (and the escrow token account's rent if it does not exist yet).",
      ],
      build: () => buildExecuteBatchTx(connection, me, launch.publicKey),
      autoConfirm: auto,
    }).then((o) => {
      if (!auto) return;
      attempts.current += 1;
      const next = crankNext(attemptOf(o), attempts.current, clock.current, launch.executeEndTs);
      if (next.action === "retry") {
        setRetryAt(next.retryAt);
        fired.current = false;
      } else {
        setArmed(false);
        setRetryAt(null);
        if (next.action === "stop") setStopped(next.reason);
      }
    });
  };

  useEffect(() => {
    if (!armed || fired.current || busy || launch.executed) return;
    if (retryAt !== null && now < retryAt) return;
    if (now >= Number(launch.commitEndTs) && now < Number(launch.executeEndTs)) {
      fired.current = true;
      setStopped(null);
      void execute(true);
    } else if (now >= Number(launch.executeEndTs)) {
      setArmed(false);
      setStopped("The window to start the batch has closed.");
    }
    // `execute` is a fresh closure every render; firing depends only on time, the armed flag and the retry pause.
  }, [armed, now, busy, retryAt, launch.executed, launch.commitEndTs, launch.executeEndTs]);

  return (
    <div className="tk-crank" data-armed={armed ? "true" : undefined}>
      <p className="tk-crank-title">
        <span>Start the batch</span>
        <span className="tk-crank-tag">anyone can</span>
      </p>
      {empty ? <p className="tk-crank-text">Nothing has been committed yet.</p> : null}
      {!me && phase === "execute" ? <Reason>Connect a wallet to start it</Reason> : null}
      <div className="pg-btns">
        <Button variant={windowOpen ? "primary" : "secondary"} disabled={!me || !windowOpen || empty} onClick={() => void execute(false)}>
          Start the batch now
        </Button>
        {phase === "commit" ? (
          <Button
            variant={armed ? "primary" : "secondary"}
            aria-pressed={armed}
            disabled={!me || empty}
            onClick={() => {
              setArmed((a) => !a);
              attempts.current = 0;
              fired.current = false;
              setRetryAt(null);
              setStopped(null);
            }}
          >
            {/* One wrapping text run: as separate flex items the label, "(", the countdown and ")" broke into columns on phones. */}
            <span className="tk-btn-run">
              {armed ? "Will start it for you: click to cancel" : "Start it for me when the window closes"} (<Countdown to={launch.commitEndTs} />)
            </span>
          </Button>
        ) : null}
      </div>
      {armed ? (
        <p className="tk-crank-armed" role="status">
          {retryAt !== null && now < retryAt
            ? `It did not go through yet: trying again in ${retryAt - now}s.`
            : `Keep this page open. When the window closes, it prepares the batch and checks it first; if the check passes it is sent${owner.source === "wallet" ? " after your wallet approves it" : ""}. If it does not go through, it tries again.`}
        </p>
      ) : null}
      {stopped !== null && !launch.executed ? (
        <p className="tk-crank-armed" role="status">
          Stopped trying: {stopped}
        </p>
      ) : null}
      <p className="tk-crank-text">
        Anyone can start the batch from {formatTimestamp(launch.commitEndTs)} to {formatTimestamp(launch.executeEndTs)}. Until then every other buy is
        refused, so nobody can trade ahead of the batch.
      </p>
    </div>
  );
}

function ClaimForOthers({ launch, symbol }: { launch: LaunchAccount; symbol: string }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const [text, setText] = useState("");
  let target: PublicKey | null = null;
  try {
    target = text.trim() === "" ? null : new PublicKey(text.trim());
  } catch {
    target = null;
  }
  const me = owner.publicKey;
  return (
    <details className="pg-subfold">
      <summary>Claim for another wallet</summary>
      <div className="pg-subfold-body">
        <p className="pg-hint">Anyone may claim for anyone: the tokens and refund can only go to that wallet's own accounts. You pay the network fee and any account rent.</p>
        <div className="tk-inline-form">
          <label htmlFor="claim-other" className="sr-only">
            Wallet to claim for
          </label>
          <input id="claim-other" className="input mono" placeholder="Wallet address" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off" />
          <Button
            size="sm"
            disabled={!me || target === null}
            onClick={() => {
              if (!me || !target) return;
              const who = target;
              void run({
                title: `Claim ${symbol} batch for ${shortKey(who)}`,
                summary: [
                  `Pays ${shortKey(who)}'s batch tokens to its own token account, and any SOL refund as wSOL to its own wSOL account (only that wallet can unwrap it).`,
                  "You pay the network fee and the rent of any account the claim creates.",
                ],
                build: () => buildClaimTx(connection, me, launch.publicKey, who),
              });
            }}
          >
            Review claim
          </Button>
        </div>
      </div>
    </details>
  );
}
