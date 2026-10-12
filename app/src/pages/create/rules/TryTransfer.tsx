/**
 * "Try a transfer": pick a transfer (what, when, how much) with a few sliders
 * and see whether the launch would allow it and, if not, what stops it. The
 * verdict is the SDK's own evaluator (`simulateTransfer` with the launch's
 * built-in guard), the hook's decision step for step: sells, the end of the
 * early limits, the snipe shield (batch window + execution grace), a
 * receiving account whose owner could change (MutableOwner), the
 * wallet-to-wallet pause, the biggest buy, the biggest wallet, then the
 * custom rules last, which a move made by a holder's quantum vault or the
 * Shield skips (review 4 R1; review U17: no copy of the hook here).
 */
import { useMemo, useState, type ReactNode } from "react";

import {
  explainOneRule,
  KNOWN_APPS,
  ORDINARY_BUY_INSTRUCTIONS,
  NOISED_SHIELD_PROGRAM,
  NOISED_VAULT_PROGRAM,
  ruleCodeSentence,
  ruleKeyList,
  shortAddr,
  tryRulesTransfer,
  type GuardFacts,
  type RuleSet,
  type TransferVerdict,
} from "../../../lib/programmable";
import { plainDuration } from "../simple";
import { ChoiceChips, StopSlider } from "../SimpleControls";
import { Panel } from "../../inner/kit";

type Kind = "buy" | "sell" | "p2p";

export interface TryInput {
  kind: Kind;
  /** Seconds after launch. */
  atSecs: number;
  /** Share of supply, bps. */
  amountBps: number;
  /** What the receiver holds before, bps of supply. */
  holdsBps: number;
  /** Top-level instructions in the transaction. */
  instructions: number;
  /** Receiving wallet ("" = someone not on any list). */
  to: string;
  /** Program the buy goes through. */
  program: string;
  /** Who sends a wallet-to-wallet transfer: the holder's wallet, their quantum vault, or the Shield. */
  via?: Via | undefined;
  /** The receiving token account's owner can never change (every normal token account); false: it could. */
  toImmutableOwner?: boolean | undefined;
}

/** Who moves the tokens in a wallet-to-wallet transfer (the vault and the Shield skip the creator's rules). */
export type Via = "wallet" | "vault" | "shield";
/** Token-2022: a plain transfer between wallets has it as the transaction's top-level program. */
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const VIA_PROGRAM: Record<Via, string> = { wallet: TOKEN_2022, vault: NOISED_VAULT_PROGRAM, shield: NOISED_SHIELD_PROGRAM };

export interface CheckStep {
  label: string;
  outcome: "pass" | "block" | "allow" | "skip";
}

export interface TryResult {
  allowed: boolean;
  title: string;
  why: string;
  steps: CheckStep[];
}

/**
 * The hook's order (the SDK's stages: sell, guard over, snipe shield, zero, exempt, MutableOwner, the pause, the caps,
 * then the rules, or "holderExit" when the vault or the Shield moves the tokens), with each step's words.
 */
const ORDER: { stage: TransferVerdict["stage"]; label: (k: Kind, decides: boolean, allowed: boolean) => string; applies: (k: Kind) => boolean }[] = [
  { stage: "sell", label: (k) => (k === "sell" ? "A sell always goes through" : "Not a sell"), applies: () => true },
  { stage: "guardOver", label: (_k, d) => (d ? "The early limits have ended" : "The early limits are on"), applies: () => true },
  { stage: "shield", label: (_k, d, ok) => (d && !ok ? "Trading has not opened yet" : "Trading has opened"), applies: (k) => k === "buy" },
  { stage: "zero", label: () => "Moves nothing", applies: () => false },
  { stage: "exempt", label: () => "A launch transfer (always allowed)", applies: () => false },
  {
    stage: "mutableOwner",
    label: (_k, d, ok) => (d && !ok ? "The receiving account's owner could be changed" : "The receiving account is a normal one"),
    applies: (k) => k !== "sell",
  },
  { stage: "p2pLocked", label: (_k, d, ok) => (d && !ok ? "Wallet-to-wallet transfers are paused" : "Wallet-to-wallet transfers allowed"), applies: (k) => k === "p2p" },
  { stage: "maxBuy", label: (_k, d, ok) => (d && !ok ? "Over the biggest single transfer" : "Within the biggest single transfer"), applies: () => true },
  { stage: "maxWallet", label: (_k, d, ok) => (d && !ok ? "Over the biggest wallet" : "Within the biggest wallet"), applies: () => true },
  // Shown only when it decides: the vault or the Shield moved the tokens, so the rules after it are not reached.
  { stage: "holderExit", label: () => "Sent by a quantum vault or the Shield: launch rules don't apply", applies: () => false },
  { stage: "rules", label: () => "Your launch rules", applies: () => true },
];

/**
 * The verdict for one transfer, from the SDK's evaluator, as the panel shows it (pure; test/rules-try.test.ts). Steps
 * before the deciding one passed; the deciding one allowed or blocked it; the rest were not reached.
 */
export function tryTransfer(input: TryInput, set: RuleSet | null, guard: GuardFacts): TryResult {
  const amount = (guard.supply * BigInt(input.amountBps)) / 10_000n;
  const holds = (guard.supply * BigInt(input.holdsBps)) / 10_000n;
  const v = tryRulesTransfer(
    set,
    {
      kind: input.kind,
      at: input.atSecs,
      amount,
      receiverBalance: holds,
      ...(input.to !== "" ? { to: input.to } : {}),
      // A wallet-to-wallet transfer is sent by the holder's wallet, their quantum vault or the Shield.
      program: input.kind === "p2p" ? VIA_PROGRAM[input.via ?? "wallet"] : input.program,
      instructions: input.instructions,
      ...(input.toImmutableOwner === false ? { toImmutableOwner: false } : {}),
    },
    guard,
  );
  const decided = ORDER.findIndex((o) => o.stage === v.stage);
  const steps: CheckStep[] = ORDER.flatMap((o, i): CheckStep[] => {
    if (!o.applies(input.kind) && i !== decided) return [];
    const label = o.label(input.kind, i === decided, v.allowed);
    if (i < decided) return [{ label, outcome: "pass" }];
    if (i === decided) return [{ label, outcome: v.allowed ? (o.stage === "rules" ? "pass" : "allow") : "block" }];
    return [{ label, outcome: "skip" }];
  });
  if (v.allowed) {
    const why = v.stage === "rules" ? (set !== null && set.rules.length > 0 ? "No rule blocks it." : "Nothing blocks it.") : v.why;
    return { allowed: true, title: v.stage === "holderExit" ? "Allowed: launch rules don't apply" : "Allowed", why, steps };
  }
  if (v.stage === "rules" && v.rule !== null && set !== null) {
    // What holders see first, then the rule; the SDK's line ends with that same message, said once here.
    const rule = (explainOneRule(set, v.rule) ?? "").replace(/\s*A refused transfer shows: “[^”]*”\.$/, "");
    return { allowed: false, title: `Blocked by rule ${v.rule + 1}`, why: `${ruleCodeSentence(v.code ?? 0)}. ${rule}`.trim(), steps };
  }
  const titles: Partial<Record<TransferVerdict["stage"], string>> = {
    shield: "Blocked: trading has not opened yet",
    mutableOwner: "Blocked: the receiving account's owner could change",
    p2pLocked: "Blocked: wallet-to-wallet is paused",
    maxBuy: "Blocked: too big for one transfer",
    maxWallet: "Blocked: the wallet would hold too much",
  };
  return { allowed: false, title: titles[v.stage] ?? "Blocked", why: v.why, steps };
}

const AMOUNTS = [5, 10, 25, 50, 100, 200, 500];
const HOLDS = [0, 50, 100, 200];
const STEPS_IN_TX = [4, ORDINARY_BUY_INSTRUCTIONS, 8, 10, 12, 16, 20];
const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** Moments worth trying: inside the batch, minutes into trading, and after the early limits. */
export function tryMoments(g: GuardFacts): { at: number; text: string }[] {
  const open = g.openDelaySecs + g.graceSecs;
  const out: { at: number; text: string }[] = [];
  if (g.openDelaySecs > 0) out.push({ at: Math.floor(g.openDelaySecs / 2), text: "During the opening batch" });
  for (const m of [1, 5, 10, 30, 60, 120, 360, 1440]) {
    const at = open + m * 60;
    if (at < g.guardSecs) out.push({ at, text: `${plainDuration(m * 60)} into trading` });
  }
  out.push({ at: g.guardSecs + 60, text: "After the early limits end" });
  return out;
}

export function TryTransfer({ set, guard, wallets }: { set: RuleSet | null; guard: GuardFacts; wallets: readonly { address: string; name: string }[] }): ReactNode {
  const moments = useMemo(() => tryMoments(guard), [guard]);
  const [input, setInput] = useState<Omit<TryInput, "atSecs"> & { moment: number }>({
    kind: "buy",
    moment: Math.min(1, moments.length - 1),
    amountBps: 25,
    holdsBps: 0,
    instructions: ORDINARY_BUY_INSTRUCTIONS,
    to: "",
    program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    via: "wallet",
    toImmutableOwner: true,
  });
  const set_ = (patch: Partial<typeof input>): void => setInput((v) => ({ ...v, ...patch }));
  const moment = moments[Math.min(input.moment, moments.length - 1)] ?? { at: 0, text: "At launch" };
  const toKnown = input.to === "" || wallets.some((w) => w.address === input.to) ? input.to : "";
  const result = useMemo(() => {
    try {
      return tryTransfer({ ...input, to: toKnown, atSecs: moment.at }, set, guard);
    } catch (e) {
      return { allowed: false, title: "Can't try this yet", why: e instanceof Error ? e.message : String(e), steps: [] } satisfies TryResult;
    }
  }, [input, toKnown, moment.at, set, guard]);
  const ai = AMOUNTS.indexOf(input.amountBps);
  const hi = HOLDS.indexOf(input.holdsBps);
  const si = STEPS_IN_TX.indexOf(input.instructions);

  return (
    <Panel title="Try a transfer" description="Pick a transfer and see what the chain would do with it, step by step. It runs the launch guard's own checks.">
      <div className="rl-try">
        <div className="rl-try-form rl-try-simple">
          <ChoiceChips<Kind>
            label="What happens"
            choices={[
              { id: "buy", text: "Buy" },
              { id: "sell", text: "Sell" },
              { id: "p2p", text: "Wallet to wallet" },
            ]}
            value={input.kind}
            onPick={(kind) => set_({ kind })}
          />
          <StopSlider
            label="When"
            stops={moments.length}
            index={Math.min(input.moment, moments.length - 1)}
            exact
            valueText={moment.text}
            stopText={(i) => moments[i]?.text ?? ""}
            onIndex={(i) => set_({ moment: i })}
            ends={[moments[0]?.text ?? "", moments[moments.length - 1]?.text ?? ""]}
            say={moment.at >= guard.guardSecs ? "The early limits have ended: every transfer goes through." : `${plainDuration(moment.at)} after launch.`}
          />
          {input.kind !== "sell" ? (
            <>
              <StopSlider
                label="How much"
                stops={AMOUNTS.length}
                index={ai < 0 ? 2 : ai}
                exact
                valueText={`${pct(input.amountBps)} of the supply`}
                stopText={(i) => pct(AMOUNTS[i] ?? 25)}
                onIndex={(i) => set_({ amountBps: AMOUNTS[i] ?? 25 })}
                ends={[pct(AMOUNTS[0] ?? 5), pct(AMOUNTS[AMOUNTS.length - 1] ?? 500)]}
                say={`About ${(Number((guard.supply * BigInt(input.amountBps)) / 10_000n) / 10 ** guard.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens.`}
              />
              <StopSlider
                label="The receiver already holds"
                stops={HOLDS.length}
                index={hi < 0 ? 0 : hi}
                exact
                valueText={input.holdsBps === 0 ? "Nothing" : pct(input.holdsBps)}
                stopText={(i) => pct(HOLDS[i] ?? 0)}
                onIndex={(i) => set_({ holdsBps: HOLDS[i] ?? 0 })}
                ends={["Nothing", pct(HOLDS[HOLDS.length - 1] ?? 200)]}
                say={input.holdsBps === 0 ? "A fresh wallet." : `A wallet that already holds ${pct(input.holdsBps)} of the supply.`}
              />
            </>
          ) : null}
          {input.kind === "buy" ? (
            <>
              <StopSlider
                label="Steps in the transaction"
                stops={STEPS_IN_TX.length}
                index={si < 0 ? 1 : si}
                exact
                valueText={`${input.instructions} steps`}
                stopText={(i) => `${STEPS_IN_TX[i] ?? 6} steps`}
                onIndex={(i) => set_({ instructions: STEPS_IN_TX[i] ?? ORDINARY_BUY_INSTRUCTIONS })}
                ends={["Simple", "Bot-style"]}
                say={input.instructions <= 8 ? "An ordinary buy from a wallet or an app uses about 6 steps." : "A busy transaction, the kind bots bundle buys into."}
              />
              <ChoiceChips
                label="Bought through"
                choices={Object.entries(KNOWN_APPS)
                  .map(([address, name]) => ({ id: address, text: name }))
                  .concat([{ id: "11111111111111111111111111111112", text: "Another app" }])}
                value={input.program}
                onPick={(program) => set_({ program })}
              />
            </>
          ) : null}
          {input.kind === "p2p" ? (
            <ChoiceChips<Via>
              label="Sent by"
              choices={[
                { id: "wallet", text: "Their wallet" },
                { id: "vault", text: "Their quantum vault" },
                { id: "shield", text: "The Shield" },
              ]}
              value={input.via ?? "wallet"}
              onPick={(via) => set_({ via })}
            />
          ) : null}
          {input.kind !== "sell" ? (
            <ChoiceChips<"normal" | "mutable">
              label="Receiving account"
              choices={[
                { id: "normal", text: "A normal one" },
                { id: "mutable", text: "Its owner can be changed" },
              ]}
              value={input.toImmutableOwner === false ? "mutable" : "normal"}
              onPick={(k) => set_({ toImmutableOwner: k === "normal" })}
            />
          ) : null}
          {input.kind !== "sell" && wallets.length > 0 ? (
            <ChoiceChips
              label="Goes to"
              choices={[{ id: "", text: "Someone else" }, ...wallets.map((w) => ({ id: w.address, text: w.name }))]}
              value={toKnown}
              onPick={(to) => set_({ to })}
            />
          ) : null}
        </div>

        <div className="rl-verdict px-corners px-frame" data-allowed={result.allowed ? "yes" : "no"} aria-live="polite">
          <p className="rl-verdict-t">
            <span className="rl-verdict-ico" aria-hidden="true">
              {result.allowed ? "✓" : "✕"}
            </span>
            {result.title}
          </p>
          <p className="rl-verdict-why">{result.why}</p>
          {result.steps.length > 0 ? (
            <ol className="rl-steps" aria-label="Checked in this order">
              {result.steps.map((s, i) => (
                <li key={i} data-outcome={s.outcome}>
                  <span className="rl-step-ico" aria-hidden="true">
                    {s.outcome === "block" ? "✕" : s.outcome === "skip" ? "–" : "✓"}
                  </span>
                  <span>
                    {s.label}
                    <span className="sr-only">: {s.outcome === "block" ? "blocks it" : s.outcome === "allow" ? "lets it through" : s.outcome === "skip" ? "not reached" : "passed"}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

/** Names for the wallets a rule set lists (team wallets), for the "Goes to" choice. */
export function walletChoices(set: RuleSet | null): { address: string; name: string }[] {
  if (set === null) return [];
  return ruleKeyList(set)
    .filter((k) => KNOWN_APPS[k.address] === undefined)
    .map((k, i) => ({ address: k.address, name: k.name ?? `Wallet ${i + 1} (${shortAddr(k.address)})` }));
}
