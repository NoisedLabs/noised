/**
 * Review 4 (R1) on the simulated chain: the hook skips the creator's launch rules when the transaction's current
 * top-level instruction is the Noised vault's or the Noised shield's (holders' quantum custody and privacy exits);
 * the built-in checks (MutableOwner, the pause, the caps) still apply to those moves. AEGS's demo rules refuse buys
 * that do not go through Meteora or Jupiter for its first minutes of trading.
 */
import { HOOK_ERRORS, PROGRAM_IDS } from "@noisedlabs/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";

import "../src/lib/backend/mock";
import { guard } from "../src/lib/mock/common";
import { seedState } from "../src/lib/mock/fixtures";
import { resetProgrammableForTests } from "../src/lib/mock/programmable";
import { replaceStateForTests, state, type MockLaunch } from "../src/lib/mock/store";
import type { TransferView } from "../src/lib/mock/market";

beforeEach(() => {
  replaceStateForTests(seedState());
  resetProgrammableForTests();
});

function aegis(): MockLaunch {
  const l = Object.values(state().launches).find((x) => x.meta?.symbol === "AEGS");
  if (!l) throw new Error("no AEGS fixture");
  return l;
}

/** A moment inside AEGS's rule window, after its snipe shield (so a buy reaches the rules). */
function inWindow(l: MockLaunch): number {
  if (l.certificate === null) throw new Error("not launched");
  return Number(l.certificate.snipeShieldEndTs) + 30;
}

function buy(l: MockLaunch, topProgram: PublicKey, extra: Partial<TransferView> = {}): TransferView {
  const amount = l.initialSupply / 100_000n;
  return { amount, isBuy: true, isSell: false, sourceOwner: Keypair.generate().publicKey, destinationOwner: Keypair.generate().publicKey, destinationBalanceAfter: amount, topProgram, txIxCount: 3, ...extra };
}

describe("launch rules never meet the vault or the shield (review 4, R1)", () => {
  it("a buy through another app is refused by AEGS's rules", () => {
    const l = aegis();
    const g = guard(l, inWindow(l), buy(l, Keypair.generate().publicKey), []);
    expect(g).toMatchObject({ kind: "program", program: PROGRAM_IDS.hook, code: HOOK_ERRORS.RuleDenied });
  });

  it("the same move made by the vault or the shield skips the rules", () => {
    const l = aegis();
    expect(guard(l, inWindow(l), buy(l, PROGRAM_IDS.vault), [])).toBeNull();
    expect(guard(l, inWindow(l), buy(l, PROGRAM_IDS.shield), [])).toBeNull();
  });

  it("the built-in checks still apply to them: an account whose owner can change is refused (MutableOwner)", () => {
    const l = aegis();
    expect(guard(l, inWindow(l), buy(l, PROGRAM_IDS.vault, { destinationImmutableOwner: false }), [])).toMatchObject({ code: HOOK_ERRORS.MutableOwner });
    expect(guard(l, inWindow(l), buy(l, PROGRAM_IDS.shield, { amount: l.maxBuy + 1n, destinationBalanceAfter: l.maxBuy + 1n }), [])).toMatchObject({ code: HOOK_ERRORS.MaxBuy });
  });
});
