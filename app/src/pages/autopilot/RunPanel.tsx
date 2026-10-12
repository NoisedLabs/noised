/**
 * "Run now" and the run history. Anyone can run a step that is due: the
 * program checks it is due, its condition, its budget and its limits, then
 * pays the caller a small tip from the treasury. That is what keeps an
 * autopilot going without its creator. A step the operator controls runs
 * only with the operator's signature and the amount it chooses (review U13):
 * the operator picks it here, up to the most the step may move now.
 *
 * SDK 0.9.0 (audit 4): each due step says what running it costs (the network
 * fee, and the caller's own wSOL account for the tip the first time) and the
 * tip it should earn; a keeper's partial buyback and payees skipped for having
 * no wSOL account are said plainly, here and in the history.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useState, type ReactNode } from "react";

import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Button } from "../../components/ui";
import { formatSol } from "../../lib/amounts";
import { relativeTime, shortKey } from "../../lib/format";
import { buildRunStepTx, type AutopilotInfo, type AutopilotRun, type DueStep, type LaunchAccount, type RunCosts } from "../../lib/noised";
import type { Graph } from "../../lib/programmable";
import { StopSlider } from "../create/SimpleControls";
import { Chip, Comment, EmptyState, Panel } from "../inner/kit";
import { NodeGlyph } from "./GraphCanvas";

const GLYPH = { buyback: "buyback", burn: "burn", pay: "pay" } as const;

function compactTokens(raw: bigint, decimals: number): string {
  const v = Number(raw) / 10 ** decimals;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function runSentence(r: AutopilotRun, decimals: number): string {
  if (r.action === "buyback") {
    return `${r.partial === true ? "Partial buyback: bought back" : "Bought back"} with ${formatSol(r.solIn, 4)} and burned ${compactTokens(r.burned, decimals)} tokens`;
  }
  if (r.action === "burn") return `Burned ${compactTokens(r.burned, decimals)} tokens from the treasury`;
  const skipped = r.skippedRecipients ?? 0;
  return `Paid ${formatSol(r.solIn, 4)} to the recipients${skipped > 0 ? ` · ${skipped} recipient${skipped === 1 ? "" : "s"} skipped (no wSOL account)` : ""}`;
}

/** "about 0.000005 SOL in network fees" plus the first-time wSOL account, in plain words. */
export function costText(c: RunCosts): string {
  const fee = c.signatureFeeLamports + c.priorityFeeLamports;
  const base = `${formatSol(fee, 6)} network fee`;
  return c.rentLamports > 0n ? `${base} + ${formatSol(c.rentLamports, 4)} for your wSOL account that receives the tip (yours to keep)` : base;
}

/** The share of the most a step may move that the operator picks (stops). */
export const OPERATOR_SHARES = [10, 25, 50, 75, 100] as const;

/** The amount for a share of `max` (at least 1 unit, at most `max`). */
export function operatorAmount(max: bigint, pct: number): bigint {
  const a = (max * BigInt(pct)) / 100n;
  return a < 1n ? 1n : a > max ? max : a;
}

export function RunPanel({
  launch,
  info,
  graph,
  due,
  runs,
  now,
  onRan,
}: {
  launch: LaunchAccount;
  info: AutopilotInfo | null;
  graph: Graph | null;
  due: readonly DueStep[];
  runs: readonly AutopilotRun[];
  now: number;
  onRan: (node: string | null) => void;
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const decimals = info?.decimals ?? launch.tokenDecimal;
  const idOf = (i: number): string => graph?.nodes[i]?.id ?? `step ${i + 1}`;
  const [shares, setShares] = useState<Record<number, number>>({});
  const amountText = (d: DueStep, v: bigint): string => (d.unit === "tokens" ? `${compactTokens(v, decimals)} tokens` : formatSol(v, 4));

  return (
    <div className="ap-runs">
      <Panel
        title="Run now"
        description="Anyone can run a step that is due and earns a small tip from the treasury for it. The chain checks everything again: if it isn't due, nothing happens."
        status={
          <Chip tone={due.length > 0 ? "ok" : "muted"} pulse={due.length > 0}>
            {due.length > 0 ? `${due.length} due` : "Nothing due"}
          </Chip>
        }
      >
        {info === null || info.graphHash === null ? (
          <p className="ap-muted">This token's autopilot isn't switched on yet.</p>
        ) : due.length === 0 ? (
          <p className="ap-muted">No step is due right now. Steps run on their schedule, and only while their conditions hold and their budget lasts.</p>
        ) : (
          <ul className="ap-due">
            {due.map((d) => {
              const isOperator = d.operatorOnly && me !== null && info.operator !== null && me.equals(info.operator);
              const pct = shares[d.node] ?? 100;
              const si = OPERATOR_SHARES.indexOf(pct as (typeof OPERATOR_SHARES)[number]);
              const amount = d.operatorOnly ? operatorAmount(d.maxAmount, pct) : d.maxAmount;
              return (
                <li key={d.node} className="ap-due-item px-corners px-frame">
                  <span className="ap-node-n">{d.node + 1}</span>
                  <span className="ap-due-main">
                    <span className="ap-due-t">{d.what}</span>
                    <span className="ap-due-s">
                      {idOf(d.node)}
                      {d.operatorOnly ? " · only the operator can run it, and it picks how much" : ""}
                      {d.partial ? " · a partial buyback: the pool fills only part of it now, the rest stays due" : ""}
                      {d.skippedRecipients > 0 ? ` · ${d.skippedRecipients} recipient${d.skippedRecipients === 1 ? "" : "s"} skipped (no wSOL account yet: the share stays in the treasury)` : ""}
                    </span>
                    <span className="ap-due-c" data-testid="run-costs">
                      {d.costs !== null ? `Costs you ${costText(d.costs)}.` : "Connect a wallet to see what running it costs you."}{" "}
                      {d.tip > 0n ? `Whoever runs it earns a tip of about ${formatSol(d.tip, 6)}.` : "No tip left in today's tip budget."}
                    </span>
                    {isOperator ? (
                      <StopSlider
                        label="How much this time"
                        stops={OPERATOR_SHARES.length}
                        index={si < 0 ? OPERATOR_SHARES.length - 1 : si}
                        exact
                        valueText={amountText(d, amount)}
                        stopText={(i) => `${OPERATOR_SHARES[i] ?? 100}% of the most allowed`}
                        onIndex={(i) => setShares((s) => ({ ...s, [d.node]: OPERATOR_SHARES[i] ?? 100 }))}
                        ends={[`${OPERATOR_SHARES[0]}%`, `All ${amountText(d, d.maxAmount)}`]}
                        say={`You run it as the operator, for ${amountText(d, amount)} (at most ${amountText(d, d.maxAmount)} now).`}
                      />
                    ) : null}
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!me || (d.operatorOnly && !isOperator)}
                    onClick={() => {
                      if (!me) return;
                      void run({
                        title: `Run step ${d.node + 1}: ${idOf(d.node)}`,
                        summary: [
                          d.operatorOnly ? `${d.what.replace(/up to [^ ]+ [A-Za-z]+/, `${amountText(d, amount)}`)}.` : `${d.what}.`,
                          d.tip > 0n ? `Pays you a tip of about ${formatSol(d.tip, 6)} (in wrapped SOL) from the treasury.` : "No tip: today's tip budget is used up.",
                          ...(d.costs !== null ? [`It costs you ${costText(d.costs)}.`] : []),
                          ...(d.skippedRecipients > 0 ? [`${d.skippedRecipients} recipient${d.skippedRecipients === 1 ? " has" : "s have"} no wSOL account yet: skipped, the share stays in the treasury. Nobody pays to open theirs.`] : []),
                          "The program checks again that the step is due, its condition, its budget and its limits.",
                        ],
                        build: async () => (await buildRunStepTx(connection, me, launch.publicKey, d.node, d.operatorOnly ? { amount, operator: me } : {})).tx,
                      }).then((o) => {
                        if (o.status === "confirmed") onRan(idOf(d.node));
                      });
                    }}
                  >
                    Run now
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {!me ? <Comment>Connect a wallet to run a step (you pay the network fee and get the tip).</Comment> : null}
      </Panel>

      <Panel title="Run history" description="Every step that ran, who ran it and what it did.">
        {runs.length === 0 ? (
          <EmptyState art={<NodeGlyph kind="unknown" />}>Nothing has run yet.</EmptyState>
        ) : (
          <ol className="ap-history">
            {runs.slice(0, 50).map((r) => (
              <li key={r.txSignature} className="ap-hist">
                <span className="ap-hist-ico" aria-hidden="true">
                  <NodeGlyph kind={GLYPH[r.action]} />
                </span>
                <span className="ap-hist-main">
                  <span className="ap-hist-t">{runSentence(r, decimals)}</span>
                  <span className="ap-hist-s">
                    Step {r.node + 1} ({idOf(r.node)}) · {relativeTime(r.unixTime, now)} · by {r.byOperator ? "the operator" : <Address value={r.keeper} />} · tip {formatSol(r.tip, 6)}
                  </span>
                </span>
                <span className="ap-hist-sig mono" title={r.txSignature}>
                  {shortKey(r.txSignature, 4)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
