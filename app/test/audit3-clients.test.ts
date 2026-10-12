/**
 * Client sides of audit round 3 (F1, F2) in the app, ahead of the program
 * fixes they mirror:
 *   - F1: an attestation whose window passed unused no longer blocks the
 *     launch: the creator signs a new opening time (the token page says
 *     so), which may take the slot only then;
 *   - F2: while the guard is on, the Launch Guard refuses a transfer that is
 *     not a sell into a token account whose owner can be reassigned
 *     (HookError 6010 MutableOwner): the simulated chain refuses it like the
 *     hook, every failure that carries 6010 is explained in plain words
 *     although the bundled SDK's IDL does not name it yet, and the app tells
 *     such an account apart before it builds a release_to.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { explainFailure, ownerIsMutable } from "../src/lib/backend/live";
import { attestationSlotFree, windowState } from "../src/lib/launchWindow";
import { errorCode } from "../src/lib/mock/common";
import { seedState } from "../src/lib/mock/fixtures";
import { hookEvaluate, type TransferView } from "../src/lib/mock/market";
import { KNOWN_ACCOUNTS, launchPdasFromLaunch, PROGRAM_IDS } from "../src/lib/noised";
import { explainAnyProgramError, MUTABLE_OWNER } from "../src/lib/programErrors";

describe("F1: a window that passed unused", () => {
  const a = { attested: true, notBefore: 1_000n, notAfter: 4_600n };

  it("is shown as passed, and the creator can sign a new opening time", () => {
    expect(windowState(null, 0n)).toEqual({ kind: "unsigned" });
    expect(windowState({ ...a, attested: false }, 2_000n)).toEqual({ kind: "burned" });
    expect(windowState(a, 999n)).toEqual({ kind: "soon", opensAt: 1_000n, closesAt: 4_600n });
    expect(windowState(a, 4_600n)).toEqual({ kind: "open", closesAt: 4_600n });
    expect(windowState(a, 4_601n)).toEqual({ kind: "missed", closedAt: 4_600n });
    const page = readFileSync(new URL("../src/pages/token/TokenPage.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/The opening time passed/);
    expect(page).toMatch(/can sign a new opening time/);
    expect(page).not.toMatch(/can no longer go live with this signature/);
  });

  it("frees the attestation slot only once the window passed, and never on a live launch", () => {
    expect(attestationSlotFree(null, "configured", 0n)).toBe(true);
    expect(attestationSlotFree({ ...a, attested: false }, "configured", 0n)).toBe(true);
    expect(attestationSlotFree(a, "configured", 4_600n)).toBe(false);
    expect(attestationSlotFree(a, "configured", 4_601n)).toBe(true);
    expect(attestationSlotFree(a, "live", 9_999n)).toBe(false);
  });
});

describe("F2: receiving accounts whose owner can change, while the guard is on", () => {
  const s = seedState();
  const l = Object.values(s.launches).find((x) => x.certificate !== null && !x.curveComplete && x.state.guardEndTs > 0n);
  if (l === undefined || l.certificate === null) throw new Error("no guarded fixture launch");
  const during = Number(l.certificate.snipeShieldEndTs > l.state.launchTs ? l.certificate.snipeShieldEndTs : l.state.launchTs) + 1;
  const after = Number(l.state.guardEndTs);
  const wallet = Keypair.generate().publicKey;
  const base: TransferView = { amount: 1n, isBuy: false, isSell: false, sourceOwner: Keypair.generate().publicKey, destinationOwner: wallet, destinationBalanceAfter: 1n };
  const mutable = { ...base, destinationImmutableOwner: false };

  it("refuses a transfer, a buy and a payout from the batch escrow into such an account (MutableOwner)", () => {
    expect(during).toBeLessThan(after);
    expect(hookEvaluate(l, during, mutable)).toBe("MutableOwner");
    expect(hookEvaluate(l, during, { ...mutable, isBuy: true, sourceOwner: KNOWN_ACCOUNTS.dbcPoolAuthority })).toBe("MutableOwner");
    expect(hookEvaluate(l, during, { ...mutable, sourceOwner: launchPdasFromLaunch(l.address).batchAuthority })).toBe("MutableOwner");
  });

  it("never refuses a sell, a transfer into the protocol's own accounts, nothing moving, or anything after the guard", () => {
    expect(hookEvaluate(l, during, { ...mutable, isSell: true })).toBeNull();
    expect(hookEvaluate(l, during, { ...mutable, destinationOwner: launchPdasFromLaunch(l.address).batchAuthority })).toBeNull();
    expect(hookEvaluate(l, during, { ...mutable, amount: 0n })).toBeNull();
    expect(hookEvaluate(l, after, mutable)).toBeNull();
    // An account with an immutable owner (every associated token account) is judged by the other rules only.
    expect(hookEvaluate(l, during, { ...base, sourceOwner: launchPdasFromLaunch(l.address).batchAuthority })).toBeNull();
  });

  it("is HookError 6010, explained in plain words by both backends although the SDK's IDL does not name it yet", () => {
    expect(errorCode("hook", "MutableOwner")).toBe(6010);
    expect(explainAnyProgramError(PROGRAM_IDS.hook.toBase58(), 6010)).toEqual({ program: "noised_hook", name: "MutableOwner", message: MUTABLE_OWNER.message });
    // Not another program's 6010.
    expect(explainAnyProgramError(PROGRAM_IDS.vault.toBase58(), 6010)).toBeNull();
    const logs = [
      `Program ${PROGRAM_IDS.hook.toBase58()} failed: custom program error: 0x${(6010).toString(16)}`,
      `Program ${KNOWN_ACCOUNTS.token2022.toBase58()} failed: custom program error: 0x${(6010).toString(16)}`,
    ];
    const x = explainFailure("Transaction simulation failed", logs);
    expect(x.errorCode).toEqual({ program: "noised_hook", code: 6010, name: "MutableOwner" });
    expect(x.error).toBe(`noised_hook: ${MUTABLE_OWNER.message} (MutableOwner, 6010)`);
  });

  it("tells a token account whose owner can change from one whose owner cannot", () => {
    const account = (extensions: [number, number][]): Uint8Array => {
      const tlv = extensions.flatMap(([type, len]) => [type & 0xff, type >> 8, len & 0xff, len >> 8, ...new Array<number>(len).fill(0)]);
      return Uint8Array.from([...new Array<number>(165).fill(0), 2, ...tlv]);
    };
    const T22 = KNOWN_ACCOUNTS.token2022;
    expect(ownerIsMutable(KNOWN_ACCOUNTS.splToken, new Uint8Array(165))).toBe(true);
    expect(ownerIsMutable(T22, new Uint8Array(165))).toBe(true);
    // An associated token account of a hooked Token-2022 mint: TransferHookAccount (14) and ImmutableOwner (7).
    expect(ownerIsMutable(T22, account([[14, 1], [7, 0]]))).toBe(false);
    expect(ownerIsMutable(T22, account([[7, 0]]))).toBe(false);
    expect(ownerIsMutable(T22, account([[14, 1]]))).toBe(true);
    expect(ownerIsMutable(new PublicKey(PROGRAM_IDS.vault), new Uint8Array(165))).toBeNull();
    expect(ownerIsMutable(T22, Uint8Array.from([...new Array<number>(165).fill(0), 1]))).toBeNull();
  });
});
