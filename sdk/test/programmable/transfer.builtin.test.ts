/**
 * simulateTransfer with the launch's built-in Launch Guard: the hook's
 * decision function (programs/noised-hook src/rules.rs `evaluate`) ported
 * case for case, then the custom rules, which run last and can only refuse
 * more.
 *
 * The hook's test policy: launch at 1_000, snipe shield until 1_030, guard
 * until 4_600, max_buy 2_000, max_wallet 10_000, p2p locked. Here times are
 * relative to the launch (0, 30, 3_600) and the caps come from bps of a
 * 10,000,000-unit supply (2 bps = 2_000, 10 bps = 10_000), as the launchpad
 * computes them (cap_from_bps).
 *
 * `hookModel` below is rules.rs `built_ins` and `creator_rules` line for
 * line, on the TransferView each SDK kind stands for; a seeded property
 * checks simulateTransfer against it, MutableOwner (review 4 R6) and the
 * vault / shield skip of the creator rules (review 4 R1) included.
 */
import { describe, expect, it } from "vitest";
import { PROGRAM_IDS } from "../../src/constants.js";
import {
  type BuiltinGuard,
  NOISED_SHIELD_PROGRAM,
  NOISED_VAULT_PROGRAM,
  ProgError,
  parseRules,
  RULES_SKIPPED_PROGRAMS,
  simulateTransfer,
  type HookRefusal,
  type TransferInput,
  type TransferKind,
  type TransferVerdict,
} from "../../src/programmable/index.js";
import { ka, Rng } from "./helpers.js";

/** programs/noised-hook src/lib.rs VAULT_PROGRAM_ID / SHIELD_PROGRAM_ID. */
const VAULT = "7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb";
const SHIELD = "BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9";
const ROUTER = ka(0x5a);

const SUPPLY = 10_000_000n;
const POLICY: BuiltinGuard = { snipeShieldSecs: 30, maxBuyBps: 2, maxWalletBps: 10, p2pLocked: true };
const GUARD = 3_600;

const t = (kind: TransferKind, at: number, amount: bigint, after: bigint, extra: Partial<TransferInput> = {}): TransferInput => ({
  kind,
  at,
  amount,
  receiverBalance: after - amount,
  supply: SUPPLY,
  tokenDecimals: 0,
  guardSecs: GUARD,
  builtin: POLICY,
  ...extra,
});
const decide = (x: TransferInput, rules: Parameters<typeof simulateTransfer>[0] = null) => simulateTransfer(rules, x);
const refusal = (x: TransferInput): string | undefined => decide(x).refusal;

describe("built-in guard: the hook's evaluate, case for case", () => {
  it("sells are never blocked (property)", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 3_000; i++) {
      const v = decide(t("sell", rng.range(0, 10_000), BigInt(rng.range(0, 1_000_000_000)), BigInt(rng.range(0, 1_000_000_000)) + 1_000_000_000n));
      expect(v.allowed).toBe(true);
      expect(v.stage).toBe("sell");
    }
  });

  it("everything is allowed after the guard (property)", () => {
    const rng = new Rng(11);
    const kinds: TransferKind[] = ["buy", "sell", "p2p", "batch", "protocol"];
    for (let i = 0; i < 3_000; i++) {
      const amount = BigInt(rng.range(0, 1_000_000));
      expect(decide(t(rng.pick(kinds), GUARD + rng.range(0, 1_000_000), amount, amount + BigInt(rng.range(0, 9_000_000)))).allowed).toBe(true);
    }
  });

  it("zero amounts and exempt (batch / protocol) transfers pass after the shield", () => {
    expect(decide(t("buy", 1_000, 0n, SUPPLY)).allowed).toBe(true);
    expect(decide(t("p2p", 1, 0n, SUPPLY)).allowed).toBe(true);
    expect(decide(t("protocol", 1, 5_000n, 50_000n)).stage).toBe("exempt");
    expect(decide(t("protocol", 1_000, 5_000n, 50_000n)).allowed).toBe(true);
  });

  it("only the batch buys during the shield, whatever the amount (zero included)", () => {
    const rng = new Rng(13);
    for (let i = 0; i < 2_000; i++) {
      const at = rng.range(0, 29);
      const amount = BigInt(rng.range(0, 999_999));
      expect(refusal(t("buy", at, amount, amount))).toBe("SnipeShield");
      expect(decide(t("batch", at, amount, amount)).allowed).toBe(true);
    }
  });

  it("zero-amount buys wait for the shield", () => {
    expect(refusal(t("buy", 1, 0n, 0n))).toBe("SnipeShield");
    expect(decide(t("batch", 1, 0n, 0n)).allowed).toBe(true);
    expect(decide(t("buy", 30, 0n, 0n)).allowed).toBe(true);
  });

  it("the shield blocks only buys, until exactly its end", () => {
    expect(refusal(t("buy", 0, 1n, 1n))).toBe("SnipeShield");
    expect(refusal(t("buy", 29, 1n, 1n))).toBe("SnipeShield");
    expect(decide(t("buy", 30, 1n, 1n)).allowed).toBe(true);
    expect(decide(t("batch", 29, 1n, 1n)).allowed).toBe(true);
    expect(refusal(t("p2p", 29, 1n, 1n))).toBe("TransfersLocked"); // not the shield
  });

  it("caps apply during the guard: max buy per transfer, max wallet after the transfer", () => {
    expect(decide(t("buy", 1_000, 2_000n, 2_000n)).allowed).toBe(true);
    expect(refusal(t("buy", 1_000, 2_001n, 2_001n))).toBe("MaxBuy");
    expect(decide(t("buy", 1_000, 1_000n, 10_000n)).allowed).toBe(true);
    expect(refusal(t("buy", 1_000, 1_000n, 10_001n))).toBe("MaxWallet");
    // max buy is checked before max wallet
    expect(refusal(t("buy", 1_000, 2_001n, 20_000n))).toBe("MaxBuy");
  });

  it("the p2p lock blocks wallet transfers but not buys", () => {
    expect(refusal(t("p2p", 1_000, 10n, 10n))).toBe("TransfersLocked");
    expect(decide(t("p2p", 1_000, 10n, 10n, { builtin: { ...POLICY, p2pLocked: false } })).allowed).toBe(true);
    expect(decide(t("buy", 1_000, 10n, 10n)).allowed).toBe(true);
    // without the lock, the caps still apply to wallet-to-wallet transfers
    expect(refusal(t("p2p", 1_000, 2_001n, 2_001n, { builtin: { ...POLICY, p2pLocked: false } }))).toBe("MaxBuy");
  });

  it("disabled caps do not restrict", () => {
    const off = { ...POLICY, maxBuyBps: 0, maxWalletBps: 0 };
    expect(decide(t("buy", 1_000, SUPPLY, SUPPLY * 2n, { builtin: off })).allowed).toBe(true);
  });

  it("caps are floor(supply * bps / 10000), like the launchpad's cap_from_bps", () => {
    const odd = { supply: 9_999n }; // 9_999 * 2 / 10_000 = 1.9998 -> 1
    expect(decide(t("buy", 1_000, 1n, 1n, { ...odd, builtin: { maxBuyBps: 2 } })).allowed).toBe(true);
    expect(refusal(t("buy", 1_000, 2n, 2n, { ...odd, builtin: { maxBuyBps: 2 } }))).toBe("MaxBuy");
    // a non-zero share that rounds to zero is refused, as launch() refuses it
    expect(() => decide(t("buy", 1_000, 1n, 1n, { supply: 4_999n, builtin: { maxBuyBps: 2 } }))).toThrow(ProgError);
    for (const bps of [-1, 1.5, 10_001]) {
      expect(() => decide(t("buy", 1_000, 1n, 1n, { builtin: { maxWalletBps: bps } }))).toThrow(ProgError);
    }
  });

  it("without `builtin` only the custom rules are tried (v1.2 behaviour)", () => {
    const x = { ...t("buy", 1, 999_999n, 999_999n) };
    delete x.builtin;
    expect(decide(x).allowed).toBe(true);
    expect(decide(x).refusal).toBeUndefined();
  });
});

describe("custom rules run after the built-in guard", () => {
  const rules = parseRules("guard 1h\ndecimals 0\nalways: max amount 1500 units when buy code WHALE\n");

  it("a built-in refusal wins; a transfer the built-ins allow can still be refused by a rule", () => {
    expect(simulateTransfer(rules, t("buy", 1_000, 2_001n, 2_001n)).refusal).toBe("MaxBuy");
    const v = simulateTransfer(rules, t("buy", 1_000, 1_600n, 1_600n));
    expect(v.allowed).toBe(false);
    expect(v.refusal).toBe("RuleDenied");
    expect(v.stage).toBe("rules");
    expect(v.codeName).toBe("WHALE");
    expect(simulateTransfer(rules, t("buy", 1_000, 1_500n, 1_500n)).allowed).toBe(true);
  });

  it("property (seeded): rules never allow what the built-ins refuse, never refuse a sell, and end with the guard", () => {
    const rng = new Rng(0x5eed_0004n);
    const sets = [
      null,
      rules,
      parseRules("guard 1h\ndecimals 0\nfirst 10m: deny when buy and amount > 100 units\nalways: max balance 0.05% when p2p\n"),
      parseRules("guard 1h\nalways: deny\n"),
    ];
    const kinds: TransferKind[] = ["buy", "sell", "p2p", "batch", "protocol"];
    for (let i = 0; i < 4_000; i++) {
      const amount = BigInt(rng.range(0, 30_000));
      const x = t(rng.pick(kinds), rng.range(0, 5_000), amount, amount + BigInt(rng.range(0, 20_000)), {
        builtin: { snipeShieldSecs: rng.range(0, 60), maxBuyBps: rng.pick([0, 1, 2, 5]), maxWalletBps: rng.pick([0, 10, 20]), p2pLocked: rng.coin() },
      });
      const plain = simulateTransfer(null, x);
      const set = rng.pick(sets);
      const v = simulateTransfer(set, x);
      if (!plain.allowed) {
        expect(v.allowed).toBe(false);
        expect(v.refusal).toBe(plain.refusal);
      }
      if (x.kind === "sell" || (x.at as number) >= GUARD) expect(v.allowed).toBe(true);
      if (!v.allowed && plain.allowed) expect(v.refusal).toBe("RuleDenied");
    }
  });
});

// ------------------------------------------------------------------ the hook, ported ---

/** The fields of rules.rs `HookPolicy` that `evaluate` reads (times relative to the launch). */
interface ModelPolicy {
  snipeShieldEnd: number;
  guardEnd: number;
  maxBuy: bigint;
  maxWallet: bigint;
  p2pLocked: boolean;
  hasRules: boolean;
}

/** rules.rs `TransferView`, with the base vault and the exempt owners already compared. */
interface ModelView {
  now: number;
  amount: bigint;
  /** source == base vault */
  isBuy: boolean;
  /** destination == base vault */
  toBaseVault: boolean;
  inBatch: boolean;
  destOwnerExempt: boolean;
  srcOwnerExempt: boolean;
  destImmutableOwner: boolean;
  destBalance: bigint;
  topProgram: string;
}

interface ModelDecision {
  stage: TransferVerdict["stage"];
  refusal?: HookRefusal;
}

/** rules.rs `built_ins`, then `creator_rules` up to the rule set itself ("rules": the set decides). */
function hookModel(p: ModelPolicy, v: ModelView): ModelDecision {
  const allow = (stage: ModelDecision["stage"]): ModelDecision => ({ stage });
  const deny = (stage: ModelDecision["stage"], refusal: HookRefusal): ModelDecision => ({ stage, refusal });
  if (v.toBaseVault && !v.isBuy) return allow("sell");
  if (v.now >= p.guardEnd) return allow("guardOver");
  if (v.isBuy && v.now < p.snipeShieldEnd && !v.inBatch) return deny("shield", "SnipeShield");
  if (v.amount === 0n) return allow("zero");
  if (v.destOwnerExempt) return allow("exempt");
  if (!v.destImmutableOwner) return deny("mutableOwner", "MutableOwner");
  if (v.srcOwnerExempt) return allow("exempt");
  if (!v.isBuy && p.p2pLocked) return deny("p2pLocked", "TransfersLocked");
  if (p.maxBuy !== 0n && v.amount > p.maxBuy) return deny("maxBuy", "MaxBuy");
  if (p.maxWallet !== 0n && v.destBalance > p.maxWallet) return deny("maxWallet", "MaxWallet");
  // creator_rules
  if (!p.hasRules) return allow("rules");
  if (v.topProgram === VAULT || v.topProgram === SHIELD) return allow("holderExit");
  return allow("rules");
}

/** The TransferView each SDK kind stands for (the batch escrow's owner and the claim source's owner are exempt). */
function viewOf(x: TransferInput, shieldEnd: number): ModelView {
  const now = x.at as number;
  const amount = x.amount as bigint;
  const kind = x.kind;
  return {
    now,
    amount,
    isBuy: kind === "buy" || kind === "batch",
    toBaseVault: kind === "sell",
    // The hook computes in_batch only for buys during the snipe shield.
    inBatch: kind === "batch" && now < shieldEnd,
    destOwnerExempt: kind === "batch",
    srcOwnerExempt: kind === "protocol",
    destImmutableOwner: x.toImmutableOwner ?? true,
    destBalance: (x.receiverBalance as bigint) + amount,
    topProgram: (x.program as string | undefined) ?? "11111111111111111111111111111111",
  };
}

const capOf = (bps: number | undefined): bigint => (bps === undefined || bps === 0 ? 0n : (SUPPLY * BigInt(bps)) / 10_000n);

describe("the receiving account's owner must be fixed during the guard (MutableOwner, review 4 R6)", () => {
  const mutable = { toImmutableOwner: false } as const;

  it("is checked at the hook's place: after sells, the guard's end, the shield, zero amounts and the batch buy", () => {
    // A sell lands in the pool's vault, whatever that account is.
    expect(decide(t("sell", 1_000, 10n, 10n, mutable))).toMatchObject({ allowed: true, stage: "sell" });
    // After the guard nothing is checked.
    expect(decide(t("p2p", GUARD, 10n, 10n, mutable))).toMatchObject({ allowed: true, stage: "guardOver" });
    expect(decide(t("buy", GUARD + 1, 10n, 10n, mutable))).toMatchObject({ allowed: true, stage: "guardOver" });
    // The shield comes first, zero amounts included.
    expect(decide(t("buy", 1, 10n, 10n, mutable))).toMatchObject({ allowed: false, stage: "shield", refusal: "SnipeShield" });
    expect(decide(t("buy", 1, 0n, 0n, mutable))).toMatchObject({ allowed: false, stage: "shield", refusal: "SnipeShield" });
    // Zero amounts move nothing.
    for (const kind of ["buy", "p2p", "protocol", "batch"] as const) {
      expect(decide(t(kind, 1_000, 0n, 0n, mutable)), kind).toMatchObject({ allowed: true, stage: "zero" });
    }
    // The batch buy pays the launch's exempt escrow: allowed before the owner check.
    expect(decide(t("batch", 1, 5_000n, 5_000n, mutable))).toMatchObject({ allowed: true, stage: "exempt" });
    expect(decide(t("batch", 1_000, 5_000n, 5_000n, mutable))).toMatchObject({ allowed: true, stage: "exempt" });
  });

  it("refuses claims, wallet-to-wallet transfers and buys into such an account, before the lock and the caps", () => {
    // Claims out of the launch's exempt accounts too.
    expect(decide(t("protocol", 1_000, 5_000n, 50_000n, mutable))).toMatchObject({ allowed: false, stage: "mutableOwner", refusal: "MutableOwner" });
    expect(decide(t("protocol", 1_000, 5_000n, 50_000n))).toMatchObject({ allowed: true, stage: "exempt" });
    // MutableOwner, not TransfersLocked (the lock is on).
    expect(refusal(t("p2p", 1_000, 10n, 10n, mutable))).toBe("MutableOwner");
    expect(refusal(t("p2p", 1_000, 10n, 10n))).toBe("TransfersLocked");
    // Before max buy and max wallet.
    expect(refusal(t("buy", 1_000, 2_001n, 20_000n, mutable))).toBe("MutableOwner");
    expect(refusal(t("buy", 1_000, 1_000n, 10_001n, mutable))).toBe("MutableOwner");
    expect(refusal(t("buy", 1_000, 10n, 10n, mutable))).toBe("MutableOwner");
    expect(refusal(t("buy", 1_000, 2_001n, 20_000n))).toBe("MaxBuy");
    // And before the custom rules, which never see it.
    const v = simulateTransfer(parseRules("guard 1h\nalways: deny\n"), t("buy", 1_000, 10n, 10n, mutable));
    expect(v).toMatchObject({ allowed: false, stage: "mutableOwner", refusal: "MutableOwner", rule: null });
    expect(v.why).toMatch(/owner could be changed/);
  });

  it("applies with or without the launch's settings (every launch's hook has it); default: a fixed owner", () => {
    const x = { ...t("buy", 1, 999_999n, 999_999n, mutable) };
    delete x.builtin;
    expect(decide(x).refusal).toBe("MutableOwner");
    const y = { ...t("buy", 1, 999_999n, 999_999n) };
    delete y.builtin;
    expect(decide(y)).toMatchObject({ allowed: true, stage: "rules" });
    expect(decide(t("buy", 1_000, 10n, 10n, { toImmutableOwner: true })).allowed).toBe(true);
    for (const bad of ["false", 0, 1]) {
      expect(() => decide(t("buy", 1_000, 10n, 10n, { toImmutableOwner: bad as never }))).toThrow(ProgError);
    }
  });
});

describe("moves through the Noised vault or shield skip the creator's rules (review 4 R1)", () => {
  const denyAll = parseRules("guard 1h\nalways: deny code BOT\n");
  const open = { ...POLICY, p2pLocked: false };

  it("the program ids are the hook's (and the SDK's PROGRAM_IDS)", () => {
    expect(NOISED_VAULT_PROGRAM).toBe(VAULT);
    expect(NOISED_SHIELD_PROGRAM).toBe(SHIELD);
    expect([...RULES_SKIPPED_PROGRAMS]).toEqual([VAULT, SHIELD]);
    expect([...RULES_SKIPPED_PROGRAMS]).toEqual([PROGRAM_IDS.vault.toBase58(), PROGRAM_IDS.shield.toBase58()]);
    expect(Object.isFrozen(RULES_SKIPPED_PROGRAMS)).toBe(true);
  });

  it("a rule that would refuse is skipped when the top-level program is the vault or the shield", () => {
    for (const program of [VAULT, SHIELD]) {
      for (const kind of ["buy", "p2p"] as const) {
        const v = simulateTransfer(denyAll, t(kind, 1_000, 10n, 10n, { program, builtin: open }));
        expect(v, `${kind} via ${program}`).toMatchObject({ allowed: true, stage: "holderExit", rule: null });
        expect(v.refusal).toBeUndefined();
        expect(v.why).toMatch(/skip the creator's rules; the built-in launch guard still applies/);
      }
    }
    // Any other program: the rule refuses.
    expect(simulateTransfer(denyAll, t("p2p", 1_000, 10n, 10n, { program: ROUTER, builtin: open }))).toMatchObject({ allowed: false, refusal: "RuleDenied", codeName: "BOT" });
    expect(simulateTransfer(denyAll, t("p2p", 1_000, 10n, 10n, { builtin: open })).refusal).toBe("RuleDenied");
    // A rule naming the vault can never apply.
    const named = parseRules(`guard 1h\nkey vault = ${VAULT}\nalways: deny when program in {vault}\n`);
    expect(simulateTransfer(named, t("buy", 1_000, 10n, 10n, { program: VAULT })).stage).toBe("holderExit");
  });

  it("the built-in guard still refuses: shield, owner check, lock and caps come first", () => {
    for (const program of [VAULT, SHIELD]) {
      expect(refusal(t("buy", 1, 10n, 10n, { program }))).toBe("SnipeShield");
      expect(refusal(t("p2p", 1_000, 10n, 10n, { program, toImmutableOwner: false }))).toBe("MutableOwner");
      expect(refusal(t("p2p", 1_000, 10n, 10n, { program }))).toBe("TransfersLocked");
      expect(refusal(t("buy", 1_000, 2_001n, 2_001n, { program }))).toBe("MaxBuy");
      expect(refusal(t("buy", 1_000, 1_000n, 10_001n, { program }))).toBe("MaxWallet");
      expect(simulateTransfer(denyAll, t("buy", 1_000, 2_001n, 2_001n, { program })).refusal).toBe("MaxBuy");
    }
  });

  it("with no custom rules the hook allows before looking at the program (stage rules)", () => {
    expect(decide(t("buy", 1_000, 10n, 10n, { program: VAULT }))).toMatchObject({ allowed: true, stage: "rules" });
    expect(simulateTransfer({ guardSecs: GUARD, keys: [], rules: [] }, t("buy", 1_000, 10n, 10n, { program: SHIELD })).stage).toBe("rules");
  });
});

describe("simulateTransfer is the hook's evaluate (seeded property against the port)", () => {
  it("same stage and refusal for every kind, owner, program, setting and rule set", () => {
    const rng = new Rng(0x5eed_0006n);
    const sets = [
      null,
      parseRules("guard 1h\nalways: deny\n"),
      parseRules("guard 1h\ndecimals 0\nalways: max amount 1500 units when buy code WHALE\n"),
      parseRules(`guard 1h\nkey router = ${ROUTER}\nalways: deny when not program in {router}\n`),
    ];
    const kinds: TransferKind[] = ["buy", "sell", "p2p", "batch", "protocol"];
    const seen = new Set<string>();
    for (let i = 0; i < 6_000; i++) {
      const amount = rng.oneIn(8) ? 0n : BigInt(rng.range(1, 30_000));
      const builtin: BuiltinGuard = { snipeShieldSecs: rng.range(0, 60), maxBuyBps: rng.pick([0, 1, 2, 5]), maxWalletBps: rng.pick([0, 10, 20]), p2pLocked: rng.coin() };
      const extra: Partial<TransferInput> = { builtin };
      const owner = rng.below(3);
      if (owner < 2) extra.toImmutableOwner = owner === 0;
      const program = rng.pick([undefined, VAULT, SHIELD, ROUTER]);
      if (program !== undefined) extra.program = program;
      const x = t(rng.pick(kinds), rng.range(0, 4_000), amount, amount + BigInt(rng.range(0, 20_000)), extra);
      const set = rng.pick(sets);
      const policy: ModelPolicy = {
        snipeShieldEnd: builtin.snipeShieldSecs!,
        guardEnd: GUARD,
        maxBuy: capOf(builtin.maxBuyBps),
        maxWallet: capOf(builtin.maxWalletBps),
        p2pLocked: builtin.p2pLocked!,
        hasRules: set !== null && set.rules.length > 0,
      };
      const m = hookModel(policy, viewOf(x, policy.snipeShieldEnd));
      const v = simulateTransfer(set, x);
      const label = `${x.kind} at ${String(x.at)} amount ${String(x.amount)} owner ${String(x.toImmutableOwner)} program ${String(x.program)}`;
      expect(v.stage, label).toBe(m.stage);
      seen.add(m.stage);
      if (m.stage === "rules" && policy.hasRules) {
        // The rule set decides: it can only refuse, with RuleDenied.
        if (!v.allowed) expect(v.refusal, label).toBe("RuleDenied");
      } else {
        expect(v.refusal, label).toBe(m.refusal);
        expect(v.allowed, label).toBe(m.refusal === undefined);
      }
    }
    // Every step of the hook was reached.
    expect([...seen].sort()).toEqual(["exempt", "guardOver", "holderExit", "maxBuy", "maxWallet", "mutableOwner", "p2pLocked", "rules", "sell", "shield", "zero"]);
  });
});
