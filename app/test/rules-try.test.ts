/**
 * "Try a transfer" (pages/create/rules/TryTransfer.tsx) runs the SDK's own
 * evaluator with the launch's built-in guard (review U17): the snipe shield
 * lasts the batch window plus the execution grace, the built-in limits come
 * before the custom rules, sells always pass, and the default is an ordinary
 * buy (6 instructions), which no anti-bot rule may refuse.
 */
import { describe, expect, it } from "vitest";

import { ORDINARY_BUY_INSTRUCTIONS, tryRulesTransfer, type GuardFacts, type RuleSet } from "../src/lib/programmable";
import { PRESETS, defaultValues, presetRules, type RulesEnv } from "../src/pages/create/rules/presets";
import { tryMoments, tryTransfer, type TryInput } from "../src/pages/create/rules/TryTransfer";

const env: RulesEnv = { guardSecs: 6 * 3600, openDelaySecs: 300, graceSecs: 600, decimals: 6 };
const guard: GuardFacts = { openDelaySecs: 300, graceSecs: 600, guardSecs: 6 * 3600, maxBuyBps: 100, maxWalletBps: 200, p2pLocked: true, supply: 1_000_000_000_000_000n, decimals: 6 };
const TEAM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const METEORA = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

const buy = (patch: Partial<TryInput> = {}): TryInput => ({ kind: "buy", atSecs: 300 + 600 + 60, amountBps: 10, holdsBps: 0, instructions: ORDINARY_BUY_INSTRUCTIONS, to: "", program: METEORA, ...patch });

function setOf(id: (typeof PRESETS)[number]["id"], wallets: string[] = []): RuleSet {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error("missing");
  const r = presetRules(id, { ...defaultValues(p), wallets }, env);
  if (!r.ok) throw new Error(r.problem);
  return { ...r.set, guardSecs: env.guardSecs, tokenDecimals: env.decimals };
}

describe("try a transfer: the SDK's evaluator, in the hook's order", () => {
  it("a buy just after the batch window but inside the execution grace is still shielded (review U17)", () => {
    const r = tryTransfer(buy({ atSecs: 300 + 30 }), null, guard);
    expect(r.allowed).toBe(false);
    expect(r.title).toMatch(/trading has not opened/);
    // The same verdict the SDK gives with the built-in guard.
    expect(tryRulesTransfer(null, { kind: "buy", at: 330, amount: 1n }, guard).refusal).toBe("SnipeShield");
    expect(tryTransfer(buy({ atSecs: 300 + 600 }), null, guard).allowed).toBe(true);
  });

  it("a sell always passes, whatever the rules say", () => {
    const r = tryTransfer(buy({ kind: "sell", atSecs: 10 }), setOf("anti-bot"), guard);
    expect(r.allowed).toBe(true);
    expect(r.steps[0]).toEqual({ label: "A sell always goes through", outcome: "allow" });
  });

  it("after the early limits every transfer passes", () => {
    const r = tryTransfer(buy({ atSecs: env.guardSecs + 60, amountBps: 500, instructions: 20 }), setOf("anti-bot"), guard);
    expect(r.allowed).toBe(true);
    expect(r.steps.find((s) => s.outcome === "allow")?.label).toBe("The early limits have ended");
  });

  it("the built-in limits come before the custom rules", () => {
    const r = tryTransfer(buy({ amountBps: 200 }), setOf("anti-bot"), guard);
    expect(r.allowed).toBe(false);
    expect(r.title).toMatch(/too big for one transfer/);
    expect(r.steps.at(-1)).toEqual({ label: "Your launch rules", outcome: "skip" });
    const p2p = tryTransfer(buy({ kind: "p2p" }), null, guard);
    expect(p2p.title).toMatch(/wallet-to-wallet is paused/);
  });

  it("the custom rules decide last, and say why in plain words", () => {
    const r = tryTransfer(buy({ instructions: 20 }), setOf("anti-bot"), guard);
    expect(r.allowed).toBe(false);
    expect(r.title).toBe("Blocked by rule 1");
    expect(r.why).toMatch(/^Looks like a bot transaction\. In the first .*more than 12 instructions\.$/);
    expect(r.why).not.toMatch(/\[BOT\]/);
    // The message is said once, not again at the end.
    expect(r.why.split("Looks like a bot transaction").length).toBe(2);
  });

  it("an ordinary buy (the default, 6 instructions) passes every preset", () => {
    for (const p of PRESETS) {
      const set = setOf(p.id, p.wallets === true ? [TEAM] : []);
      expect(tryTransfer(buy(), set, guard).allowed, p.id).toBe(true);
    }
  });

  it("the team preset refuses a buy into a team wallet only", () => {
    const set = setOf("team-cant-buy", [TEAM]);
    expect(tryTransfer(buy({ to: TEAM }), set, guard).allowed).toBe(false);
    expect(tryTransfer(buy({ to: "" }), set, guard).allowed).toBe(true);
  });

  it("a wallet-to-wallet move by the holder's quantum vault or the Shield skips the launch rules; one by a wallet does not (review 4 R1)", () => {
    const set = setOf("no-hopping");
    const open: GuardFacts = { ...guard, p2pLocked: false };
    const p2p = (via: TryInput["via"]): TryInput => buy({ kind: "p2p", via, amountBps: 5 });
    const wallet = tryTransfer(p2p("wallet"), set, open);
    expect(wallet).toMatchObject({ allowed: false, title: "Blocked by rule 1" });
    for (const via of ["vault", "shield"] as const) {
      const r = tryTransfer(p2p(via), set, open);
      expect(r).toMatchObject({ allowed: true, title: "Allowed: launch rules don't apply" });
      expect(r.why).toMatch(/vault or shield/);
      // The built-in checks ran first; the rules were never reached.
      expect(r.steps.at(-1)).toEqual({ label: "Your launch rules", outcome: "skip" });
      expect(r.steps.find((s) => s.label.startsWith("Sent by a quantum vault"))?.outcome).toBe("allow");
    }
    // The built-in pause still applies to the vault and the Shield.
    expect(tryTransfer(p2p("vault"), set, guard)).toMatchObject({ allowed: false, title: "Blocked: wallet-to-wallet is paused" });
  });

  it("a receiving account whose owner could change is refused while the early limits last (MutableOwner), before any rule", () => {
    const r = tryTransfer(buy({ toImmutableOwner: false }), setOf("whale-cap"), guard);
    expect(r).toMatchObject({ allowed: false, title: "Blocked: the receiving account's owner could change" });
    expect(r.steps.find((s) => s.outcome === "block")?.label).toBe("The receiving account's owner could be changed");
    expect(tryTransfer(buy({ toImmutableOwner: false, atSecs: guard.guardSecs + 60 }), null, guard).allowed).toBe(true);
    expect(tryTransfer(buy({ toImmutableOwner: true }), null, guard).allowed).toBe(true);
  });

  it("the moments to try start in the batch and end after the early limits", () => {
    const m = tryMoments(guard);
    expect(m[0]?.text).toBe("During the opening batch");
    expect(m[1]?.at).toBe(300 + 600 + 60);
    expect(m.at(-1)?.at).toBe(guard.guardSecs + 60);
  });
});
