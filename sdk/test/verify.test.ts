/**
 * verifyLaunch against mocked chain state (test/world.ts): a coherent,
 * PQ-attested launch (test/verifyFixtures.ts: the lms.json identity signs
 * the world launch), then every failure mode the verifier must catch, one
 * mutation at a time.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, u64le, utf8 } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PROGRAM_IDS, TRUST_ANCHORS, WSOL_MINT } from "../src/constants.js";
import {
  associatedTokenAddress,
  attestationAddress,
  certificateAddress,
  dammV2PoolAddress,
  dammV2PositionAddress,
  dammV2PositionNftAccountAddress,
  extraAccountMetaListAddress,
  hookPolicyAddress,
  identityAddressFromId,
  programDataAddress,
} from "../src/pda.js";
import type { VerificationReport } from "../src/types.js";
import { expectedMetaListData, verifyLaunch, type VerifyOptions } from "../src/verify/verifyLaunch.js";
import { ext, key, mintBytes, T22, tokenAccountBytes, upgradeableProgram } from "./helpers.js";
import { emulatedTokenMetaBytes } from "./attest_world.js";
import { ICON_PNG, LMS, pristinePoolFees, recordAddress, recordHash, vectorIdentity, withPq, worldMessage, type PqWorld, type WorldRecord } from "./verifyFixtures.js";
import { accountBytes, clock, metaListBytes, SUPPLY, THRESHOLD, world as unattestedWorld, zeroed, type World } from "./world.js";

/** The verifier's world: attested by the vector identity, batch executed (it ended the snipe shield). */
function world(): PqWorld {
  return withPq(unattestedWorld());
}

beforeAll(() => {
  vectorIdentity(); // LMS key generation, once
}, 120_000);

/** Verify `w` (nothing is ever fetched: the metadata is on-chain). */
async function verify(w: World, opts: VerifyOptions = {}): Promise<VerificationReport> {
  w.build();
  return verifyLaunch(w.conn.asConnection(), w.mint, opts);
}

function detail(r: VerificationReport, id: string): string {
  return r.checks.find((c) => c.id === id)?.detail ?? "missing";
}

/** The batch has not executed (yet): nothing was bought and the snipe shield still ends as scheduled. */
function pending(w: World): void {
  Object.assign(w.launchState, { executed: false, quoteSpent: 0n, tokensOut: 0n });
  w.policy["snipeShieldEndTs"] = w.cert["snipeShieldEndTs"];
}

function status(r: VerificationReport, id: string): string | undefined {
  return r.checks.find((c) => c.id === id)?.status;
}

/** The check `id` must have `want`; with "fail" the report overall fails too. */
async function expectCheck(w: World, id: string, want: "fail" | "warn" | "pass"): Promise<VerificationReport> {
  const r = await verify(w);
  expect(status(r, id), `${id}: ${r.checks.find((c) => c.id === id)?.detail ?? "missing"}`).toBe(want);
  if (want === "fail") expect(r.overall).toBe("fail");
  return r;
}

describe("verifyLaunch: a correct launch", () => {
  it("passes every check with all twelve certificate flags re-verified live", async () => {
    const r = await verify(world());
    const failing = r.checks.filter((c) => c.status !== "pass");
    expect(failing).toEqual([]);
    expect(r.overall).toBe("pass");
    expect(r.phase).toBe("guarded");
    expect(r.certificate?.checks).toBe(4095); // twelve flags, PQ_ATTESTED and METADATA_ONCHAIN included; no rules, so no RULES_BOUND
    expect(r.certificate?.version).toBe(4);
    for (const id of [
      "certificate.exists",
      "certificate.checks",
      "pq.origin",
      "metadata.onchain",
      "metadata.match",
      "metadata.icon",
      "launch.account",
      "launch.policy",
      "batch.cap",
      "batch.accounting",
      "mint.program",
      "mint.mintAuthority",
      "mint.freezeAuthority",
      "mint.extensions",
      "mint.metadataPointer",
      "mint.metadata",
      "mint.supply",
      "mint.transferHook",
      "dbc.config",
      "dbc.lpLocked",
      "dbc.noMigrationFee",
      "dbc.noCreatorAllocation",
      "dbc.quoteWsol",
      "dbc.fees",
      "dbc.pool",
      "hook.policy",
      "hook.metaList",
      "launch.rules",
      "launch.phase",
      "program.launchpad",
      "program.hook",
      "meteora.dbc",
      "meteora.dammV2",
      "token2022.upgrade",
    ]) {
      expect(status(r, id), id).toBe("pass");
    }
  });

  it("lists the trusted parties with live upgrade authorities, deploy slots and operators", async () => {
    const r = await verify(world());
    const meteora = r.trustedParties.find((t) => t.kind === "upgrade-multisig" && t.address?.equals(TRUST_ANCHORS.meteoraMultisig));
    expect(meteora?.note).toContain(TRUST_ANCHORS.meteoraUpgradeAuthority.toBase58());
    expect(meteora?.note).toContain(`last deploy slot ${TRUST_ANCHORS.dbcLastDeploySlot}`);
    expect(meteora?.note).toContain(`last deploy slot ${TRUST_ANCHORS.dammV2LastDeploySlot}`);
    const t22 = r.trustedParties.find((t) => t.address?.equals(TRUST_ANCHORS.token2022Multisig));
    expect(t22?.note).toContain(TRUST_ANCHORS.token2022UpgradeAuthority.toBase58());
    const ops = r.trustedParties.filter((t) => t.kind === "operator" && t.address !== null);
    expect(ops.map((o) => o.address!.toBase58()).sort()).toEqual([key("op/a").toBase58(), key("op/b").toBase58()].sort());
    expect(ops.find((o) => o.address!.equals(key("op/a")))?.note).toContain("SetPoolStatus");
    expect(r.trustedParties.filter((t) => t.kind === "admin").length).toBe(2);
    expect(r.trustedParties.some((t) => t.kind === "validators")).toBe(true);
    expect(r.trustedParties.some((t) => t.kind === "infrastructure")).toBe(true);
    expect(r.trustedParties.filter((t) => t.kind === "upgrade-authority").every((t) => t.address === null)).toBe(true);
  });

  it("reports the phase from the cluster clock", async () => {
    const w = world();
    const at = async (t: number): Promise<string | null> => {
      w.conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(t) });
      return (await verify(w)).phase;
    };
    const ts = w.launchState as { launchTs: bigint; commitEndTs: bigint; executeEndTs: bigint; guardEndTs: bigint };
    expect(await at(Number(ts.launchTs))).toBe("commit");
    // An executed batch ends the execution phase (and the snipe shield) at once.
    expect(await at(Number(ts.commitEndTs))).toBe("guarded");
    pending(w);
    w.build();
    expect(await at(Number(ts.commitEndTs))).toBe("execute");
    expect(await at(Number(ts.executeEndTs))).toBe("guarded");
    expect(await at(Number(ts.guardEndTs))).toBe("open");
  });

  it("an RPC clock that is not plausible unix seconds is reported as the RPC's fault; the report still comes back (review finding)", async () => {
    // Regression: a Clock sysvar >= 10^11 made the whole verifyLaunch throw "nowSecs looks like milliseconds",
    // blaming the caller, who passed no nowSecs.
    const w = world();
    const ts = w.launchState as { launchTs: bigint };
    const setClock = (t: bigint): void => {
      w.conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(Number(t)) });
    };
    setClock(ts.launchTs * 1000n);
    const r = await verify(w);
    const c = r.checks.find((x) => x.id === "rpc.clock");
    expect([c?.status, r.overall]).toEqual(["warn", "warn"]);
    expect(c?.detail).toMatch(/not plausible unix seconds: this RPC is broken or dishonest\. This report used this device's clock/);
    expect(r.phase).not.toBeNull();
    setClock(ts.launchTs);
    const ok = await verify(w);
    expect([ok.checks.some((x) => x.id === "rpc.clock"), ok.overall, ok.phase]).toEqual([false, "pass", "commit"]);
  });

  it("a gPA failure does not hide anything: the operator entry says so", async () => {
    const w = world();
    w.conn.programAccountsError = new Error("gPA disabled");
    const r = await verify(w);
    expect(r.overall).toBe("pass");
    expect(r.trustedParties.find((t) => t.kind === "operator" && t.address === null && t.note.includes("Could not list"))).toBeDefined();
  });
});

describe("verifyLaunch: every failure mode", () => {
  it("nowSecs is bigint unix seconds, as everywhere else (a number or milliseconds is refused before any read)", async () => {
    const w = world();
    const reads = w.conn.calls.length;
    await expect(verifyLaunch(w.conn.asConnection(), w.mint, { nowSecs: 1_700_000_000 as unknown as bigint })).rejects.toThrow(TypeError);
    await expect(verifyLaunch(w.conn.asConnection(), w.mint, { nowSecs: 1_700_000_000_000n })).rejects.toThrow(/milliseconds/);
    expect(w.conn.calls.length).toBe(reads);
  });

  it("a mint without a certificate is not a Noised launch", async () => {
    const w = world();
    w.conn.delete(certificateAddress(w.mint));
    const r = await verifyLaunch(w.conn.asConnection(), w.mint);
    expect(r.overall).toBe("fail");
    expect(r.certificate).toBeNull();
    expect(status(r, "certificate.exists")).toBe("fail");
    // Lamports sent to the certificate address do not make it a certificate.
    w.conn.set(certificateAddress(w.mint), { owner: KNOWN_ACCOUNTS.system, data: new Uint8Array(0) });
    expect(status(await verifyLaunch(w.conn.asConnection(), w.mint), "certificate.exists")).toBe("fail");
  });

  it("certificate fields", async () => {
    let w = world();
    w.cert["checks"] = 1022;
    await expectCheck(w, "certificate.checks", "fail");
    w = world();
    w.cert["checks"] = 1023; // every pre-PQ flag, PQ_ATTESTED missing
    await expectCheck(w, "certificate.checks", "fail");
    w = world();
    w.cert["checks"] = 2047; // every PQ v2 flag, METADATA_ONCHAIN missing
    await expectCheck(w, "certificate.checks", "fail");
    w = world();
    w.cert["policyVersion"] = 1; // pre-PQ rules
    await expectCheck(w, "certificate.account", "fail");
    w = world();
    w.cert["policyVersion"] = 2; // PQ v2 rules, before the on-chain metadata
    expect(detail(await expectCheck(w, "certificate.account", "fail"), "certificate.account")).toMatch(/policy version 2, expected 3/);
    // Another version is not a certificate this verifier can read (the decoder refuses it).
    w = world();
    w.cert["version"] = 2;
    expect(detail(await expectCheck(w, "certificate.exists", "fail"), "certificate.exists")).toMatch(/cannot be decoded: certificate has version 2 and 519 bytes/);
    w = world();
    w.cert["bump"] = (w.cert["bump"] as number) - 1;
    await expectCheck(w, "certificate.account", "fail");
  });

  it("launch account vs certificate", async () => {
    let w = world();
    w.conn.delete(w.launch);
    w.build = (() => {
      const b = w.build;
      return () => {
        b();
        w.conn.delete(w.launch);
      };
    })();
    await expectCheck(w, "launch.account", "fail");
    for (const [field, value] of [
      ["paramsHash", new Uint8Array(32).fill(9)],
      ["launchAuthority", key("evil")],
      ["platformFeeBps", 999],
      ["guardEndTs", 1n],
      ["status", { kind: "Configured" }],
    ] as const) {
      w = world();
      w.launchState[field] = value;
      await expectCheck(w, "launch.account", "fail");
    }
  });

  it("stored parameters outside the policy and batch accounting", async () => {
    let w = world();
    w.launchState["platformFeeBps"] = 5_001;
    w.cert["platformFeeBps"] = 5_001;
    await expectCheck(w, "launch.policy", "fail");
    w = world();
    w.launchState["maxWalletBps"] = 200; // cap no longer equals supply x bps
    await expectCheck(w, "launch.policy", "fail");
    w = world();
    w.launchState["tokensClaimed"] = (w.launchState["tokensOut"] as bigint) + 1n;
    await expectCheck(w, "batch.accounting", "fail");
    w = world();
    w.launchState["quoteRefunded"] = 200_000_000n;
    await expectCheck(w, "batch.accounting", "fail");
  });

  it("an oversubscribed batch is legal (filled pro rata); spending above the cap is not", async () => {
    let w = world();
    Object.assign(w.launchState, { batchTotalCap: 10_000_000_000n, totalCommitted: 40_000_000_000n, quoteSpent: 10_000_000_000n });
    let r = await expectCheck(w, "batch.accounting", "pass");
    expect(r.checks.find((c) => c.id === "batch.accounting")?.detail).toMatch(/25% of each commit spent/);
    w = world();
    Object.assign(w.launchState, { batchTotalCap: 10_000_000_000n, totalCommitted: 40_000_000_000n, quoteSpent: 10_000_000_001n });
    await expectCheck(w, "batch.accounting", "fail");
    // Pending and oversubscribed: the expected fill is reported.
    w = world();
    pending(w);
    Object.assign(w.launchState, { batchTotalCap: 10_000_000_000n, totalCommitted: 40_000_000_000n });
    w.conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(Number(w.launchState["launchTs"]) + 1) });
    r = await expectCheck(w, "batch.accounting", "pass");
    expect(r.checks.find((c) => c.id === "batch.accounting")?.detail).toMatch(/oversubscribed.*at most 25% of each commit/);
  });

  it("a pending batch must still be the pool's first trade", async () => {
    let w = world();
    pending(w);
    w.conn.set(new PublicKey("SysvarC1ock11111111111111111111111111111111"), { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(Number(w.launchState["commitEndTs"]) + 1) });
    await expectCheck(w, "batch.firstSwap", "pass");
    (w.poolState["poolState"] as Record<string, unknown>)["hasSwap"] = 1;
    const r = await expectCheck(w, "batch.firstSwap", "warn");
    expect(r.checks.find((c) => c.id === "batch.firstSwap")?.detail).toMatch(/PoolAlreadyTraded/);
    // Once executed the program guaranteed it; the check is not reported.
    w = world();
    expect((await verify(w)).checks.some((c) => c.id === "batch.firstSwap")).toBe(false);
  });

  it("the batch cap is reported as a share of the migration threshold; below 10% breaks the policy floor", async () => {
    let w = world();
    let r = await expectCheck(w, "batch.cap", "pass");
    expect(detail(r, "batch.cap")).toMatch(/at most 85 SOL, 100% of the 85 SOL migration threshold; each wallet commits at most 5 SOL, so filling the batch takes at least 17 wallets/);
    w = world();
    w.launchState["batchTotalCap"] = 8_000_000_000n; // 9.41%: below threshold / 10, which create_launch refuses (policy v2)
    w.launchState["totalCommitted"] = 8_000_000_000n;
    w.launchState["quoteSpent"] = 7_900_000_000n;
    r = await expectCheck(w, "batch.cap", "warn");
    expect(status(r, "launch.policy")).toBe("fail");
    expect(detail(r, "launch.policy")).toMatch(/batch cap outside threshold\/10..=threshold/);
    expect(detail(r, "batch.cap")).toMatch(/8 SOL, 9.41% .*below 10%/);
    w = world();
    w.launchState["batchTotalCap"] = 8_500_000_000n; // exactly 10%
    w.launchState["totalCommitted"] = 8_500_000_000n;
    w.launchState["quoteSpent"] = 8_000_000_000n;
    await expectCheck(w, "batch.cap", "pass");
    await expectCheck(w, "launch.policy", "pass");
    // The floor is threshold / 10 in integer division: a cap at it is no warning even when its share rounds down to 9.99%.
    w = world();
    Object.assign(w.launchState, { migrationQuoteThreshold: 85_000_000_009n, batchTotalCap: 8_500_000_000n, totalCommitted: 8_500_000_000n, quoteSpent: 8_000_000_000n });
    r = await expectCheck(w, "batch.cap", "pass");
    expect(detail(r, "batch.cap")).toMatch(/9.99% of the 85.000000009 SOL/);
    expect(status(r, "launch.policy")).toBe("pass");
    w.launchState["batchTotalCap"] = 8_499_999_999n;
    await expectCheck(w, "batch.cap", "warn");
  });

  it("the per-wallet cap counts: a tiny one empties the fair open while the total cap looks fine (audit round 2)", async () => {
    // The audit's PoC: total cap = threshold, wallet cap 1,000 lamports. Below the program's floor (cap / 200).
    let w = world();
    Object.assign(w.launchState, { batchWalletCap: 1_000n, totalCommitted: 3_000n, quoteSpent: 3_000n });
    let r = await expectCheck(w, "batch.cap", "warn");
    expect(detail(r, "batch.cap")).toMatch(/needs 85000000 wallets to fill the batch/);
    expect(status(r, "launch.policy")).toBe("fail");
    expect(detail(r, "launch.policy")).toMatch(/per-wallet batch cap below 1\/200 of the batch cap/);
    // At the program's floor (85 SOL / 200 = 0.425 SOL): legal, but 200 wallets to fill it: a warning.
    w = world();
    w.launchState["batchWalletCap"] = 425_000_000n;
    r = await expectCheck(w, "batch.cap", "warn");
    expect(r.overall).toBe("warn");
    expect(status(r, "launch.policy")).toBe("pass");
    expect(detail(r, "batch.cap")).toMatch(/needs 200 wallets .*more than 100/);
    w = world();
    w.launchState["batchWalletCap"] = 424_999_999n; // one lamport under the floor
    await expectCheck(w, "launch.policy", "fail");
    // 1% of the cap: exactly 100 wallets fill it.
    w = world();
    w.launchState["batchWalletCap"] = 850_000_000n;
    r = await expectCheck(w, "batch.cap", "pass");
    expect(detail(r, "batch.cap")).toMatch(/at least 100 wallets/);
    w = world();
    w.launchState["batchWalletCap"] = 849_999_999n; // 101 wallets
    await expectCheck(w, "batch.cap", "warn");
    w = world();
    w.launchState["batchWalletCap"] = 0n;
    r = await expectCheck(w, "batch.cap", "pass");
    expect(detail(r, "batch.cap")).toMatch(/no per-wallet cap/);
  });

  it("mint authorities", async () => {
    let w = world();
    w.mintOpts.mintAuthority = key("minter");
    await expectCheck(w, "mint.mintAuthority", "fail");
    w = world();
    w.mintOpts.freezeAuthority = key("freezer");
    await expectCheck(w, "mint.freezeAuthority", "fail");
  });

  it("extension set (via getExtensionTypes and the strict parser)", async () => {
    let w = world();
    w.mintOpts.extensions.push(ext.permanentDelegate(key("delegate")));
    await expectCheck(w, "mint.extensions", "fail");
    w = world();
    w.mintOpts.extensions.push(ext.transferFeeConfig(null, null, 0));
    await expectCheck(w, "mint.extensions", "fail");
    w = world();
    w.mintOpts.extensions = w.mintOpts.extensions.filter((e) => e.type !== 14);
    const r = await expectCheck(w, "mint.extensions", "fail");
    expect(status(r, "mint.transferHook")).toBe("fail");
    w = world();
    w.mintOpts.extensions.push(ext.raw(28, new Uint8Array(32)));
    await expectCheck(w, "mint.program", "fail");
    w = world();
    w.mintOpts.owner = KNOWN_ACCOUNTS.splToken;
    await expectCheck(w, "mint.program", "fail");
  });

  it("zero padding after the extensions is accepted (Token-2022 pads mints off the multisig size)", async () => {
    const w = world();
    const b = w.build;
    w.build = () => {
      b();
      const acc = w.conn.get(w.mint)!;
      w.conn.set(w.mint, { owner: acc.owner, data: concatBytes([acc.data, new Uint8Array(2)]) });
    };
    await expectCheck(w, "mint.extensions", "pass");
  });

  it("metadata and pointer authorities", async () => {
    let w = world();
    w.mintOpts.extensions[0] = ext.metadataPointer(key("pointer"), w.mint);
    await expectCheck(w, "mint.metadataPointer", "fail");
    w = world();
    w.mintOpts.extensions[0] = ext.metadataPointer(null, key("elsewhere"));
    await expectCheck(w, "mint.metadataPointer", "fail");
    w = world();
    w.mintOpts.extensions[2] = ext.tokenMetadata({ updateAuthority: key("updater"), mint: w.mint, name: "x", symbol: "y", uri: "" });
    await expectCheck(w, "mint.metadata", "fail");
    w = world();
    w.mintOpts.extensions[2] = ext.tokenMetadata({ updateAuthority: null, mint: key("other"), name: "x", symbol: "y", uri: "" });
    await expectCheck(w, "mint.metadata", "fail");
  });

  it("transfer hook program and authority while the curve runs", async () => {
    let w = world();
    w.mintOpts.extensions[1] = ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, key("evil-hook"));
    await expectCheck(w, "mint.transferHook", "fail");
    w = world();
    w.mintOpts.extensions[1] = ext.transferHook(key("evil-authority"), PROGRAM_IDS.hook);
    await expectCheck(w, "mint.transferHook", "fail");
    w = world();
    w.mintOpts.extensions[1] = ext.transferHook(null, null);
    await expectCheck(w, "mint.transferHook", "fail");
  });

  it("supply and decimals", async () => {
    let w = world();
    w.mintOpts.supply = SUPPLY + 1n;
    await expectCheck(w, "mint.supply", "fail");
    w = world();
    w.mintOpts.decimals = 9;
    await expectCheck(w, "mint.supply", "fail");
    w = world();
    w.mintOpts.supply = SUPPLY - 5n; // burns are fine
    await expectCheck(w, "mint.supply", "pass");
  });

  it("DBC config fixed values (SPEC §1.2)", async () => {
    const cases: [string, (c: Record<string, unknown>, w: World) => void][] = [
      ["dbc.config", (c) => (c["tokenUpdateAuthority"] = 3)],
      ["dbc.config", (c) => (c["tokenType"] = 0)],
      ["dbc.config", (c) => (c["migrationOption"] = 0)],
      ["dbc.config", (c) => (c["collectFeeMode"] = 1)],
      ["dbc.config", (c) => (c["activationType"] = 0)],
      ["dbc.config", (c) => (c["creatorTradingFeePercentage"] = 50)],
      ["dbc.config", (c) => (c["fixedTokenSupplyFlag"] = 1)],
      ["dbc.config", (c) => (c["poolCreationFee"] = 1n)],
      ["dbc.config", (c) => (c["enableFirstSwapWithMinFee"] = 1)],
      ["dbc.config", (c) => (c["feeClaimer"] = key("evil"))],
      ["dbc.config", (c) => (c["leftoverReceiver"] = key("evil"))],
      ["dbc.config", (c) => (c["migrationQuoteThreshold"] = 1n)],
      ["dbc.config", (_c, w) => (w.config.transferHookProgram = key("evil-hook"))],
      ["dbc.lpLocked", (c) => (c["partnerPermanentLockedLiquidityPercentage"] = 90)],
      ["dbc.lpLocked", (c) => (c["creatorLiquidityPercentage"] = 10)],
      ["dbc.lpLocked", (c) => ((c["partnerLiquidityVestingInfo"] as Record<string, unknown>)["isInitialized"] = 1)],
      ["dbc.noMigrationFee", (c) => (c["migrationFeePercentage"] = 10)],
      ["dbc.noMigrationFee", (c) => (c["creatorMigrationFeePercentage"] = 10)],
      ["dbc.noCreatorAllocation", (c) => ((c["lockedVestingConfig"] as Record<string, unknown>)["cliffUnlockAmount"] = 1n)],
      ["dbc.quoteWsol", (c) => (c["quoteMint"] = key("usdc"))],
      ["dbc.fees", (c) => ((c["poolFees"] as { baseFee: Record<string, unknown> }).baseFee["cliffFeeNumerator"] = 100_000_001n)],
      [
        "dbc.fees",
        (c) => {
          const bf = (c["poolFees"] as { baseFee: Record<string, unknown> }).baseFee;
          Object.assign(bf, { cliffFeeNumerator: 500_000_000n, firstFactor: 1000, secondFactor: 1n, thirdFactor: 400_000n });
        },
      ],
      ["dbc.fees", (c) => ((c["poolFees"] as { baseFee: Record<string, unknown> }).baseFee["baseFeeMode"] = 2)],
    ];
    for (const [id, mutate] of cases) {
      const w = world();
      mutate(w.config.config, w);
      await expectCheck(w, id, "fail");
    }
  });

  it("DBC pool", async () => {
    let w = world();
    (w.poolState["poolState"] as Record<string, unknown>)["creator"] = key("evil");
    await expectCheck(w, "dbc.pool", "fail");
    w = world();
    (w.poolState["poolState"] as Record<string, unknown>)["baseVault"] = key("vault");
    await expectCheck(w, "dbc.pool", "fail");
    w = world();
    const b = w.build;
    w.build = () => {
      b();
      w.conn.set(w.pool, { owner: KNOWN_ACCOUNTS.system, data: new Uint8Array(0) });
    };
    await expectCheck(w, "dbc.pool", "fail");
  });

  it("hook policy and meta list", async () => {
    let w = world();
    w.policy["maxWallet"] = 1n;
    await expectCheck(w, "hook.policy", "fail");
    w = world();
    (w.policy["exempt"] as PublicKey[])[2] = key("friend");
    await expectCheck(w, "hook.policy", "fail");
    w = world();
    w.policy["snipeShieldEndTs"] = (w.policy["launchTs"] as bigint) + 4_000n;
    await expectCheck(w, "hook.policy", "fail");
    w = world();
    const b = w.build;
    w.build = () => {
      b();
      w.conn.delete(hookPolicyAddress(w.mint));
    };
    await expectCheck(w, "hook.policy", "fail");
    w = world();
    const meta = metaListBytes();
    meta[26] = 2; // AccountKey index 2 (destination) instead of the mint
    w.conn.set(extraAccountMetaListAddress(w.mint), { owner: PROGRAM_IDS.hook, data: meta });
    await expectCheck(w, "hook.metaList", "fail");
    // The pre-audit list (policy PDA only) and a list naming another fixed account both fail.
    w = world();
    const old = metaListBytes().slice(0, 51);
    new DataView(old.buffer).setUint32(8, 39, true);
    new DataView(old.buffer).setUint32(12, 1, true);
    w.conn.set(extraAccountMetaListAddress(w.mint), { owner: PROGRAM_IDS.hook, data: old });
    await expectCheck(w, "hook.metaList", "fail");
    w = world();
    const swapped = metaListBytes();
    swapped.set(new PublicKey("SysvarC1ock11111111111111111111111111111111").toBytes(), 52);
    w.conn.set(extraAccountMetaListAddress(w.mint), { owner: PROGRAM_IDS.hook, data: swapped });
    await expectCheck(w, "hook.metaList", "fail");
  });

  it("snipe shield end: earlier only through the executed batch (end_snipe_shield), nothing else", async () => {
    const ends = (w: World) => w.launchState as { commitEndTs: bigint; executeEndTs: bigint };
    // Executed batch: any end the batch could have set, [commit_end_ts, execute_end_ts), passes and is reported.
    let w = world();
    let r = await expectCheck(w, "hook.policy", "pass");
    expect(detail(r, "hook.policy")).toMatch(/execute_batch ended the snipe shield at .*\(scheduled /);
    for (const at of [ends(w).commitEndTs, ends(w).executeEndTs - 1n]) {
      w = world();
      w.policy["snipeShieldEndTs"] = at;
      await expectCheck(w, "hook.policy", "pass");
    }
    // ... but not before the commit window closed, nor a batch that left the shield running.
    w = world();
    w.policy["snipeShieldEndTs"] = ends(w).commitEndTs - 1n;
    r = await expectCheck(w, "hook.policy", "fail");
    expect(detail(r, "hook.policy")).toMatch(/outside the execution window/);
    w = world();
    w.policy["snipeShieldEndTs"] = w.cert["snipeShieldEndTs"];
    r = await expectCheck(w, "hook.policy", "fail");
    expect(detail(r, "hook.policy")).toMatch(/batch executed but the snipe shield still ends at its scheduled time/);
    // No batch yet: exactly the scheduled end; earlier (nobody may end it) or later fails.
    w = world();
    pending(w);
    r = await expectCheck(w, "hook.policy", "pass");
    expect(detail(r, "hook.policy")).toMatch(/^No buys before /);
    w = world();
    pending(w);
    w.policy["snipeShieldEndTs"] = ends(w).commitEndTs + 42n;
    r = await expectCheck(w, "hook.policy", "fail");
    expect(detail(r, "hook.policy")).toMatch(/ends early although the batch has not executed/);
    w = world();
    w.policy["snipeShieldEndTs"] = (w.cert["snipeShieldEndTs"] as bigint) + 1n;
    r = await expectCheck(w, "hook.policy", "fail");
    expect(detail(r, "hook.policy")).toMatch(/later than the certificate's scheduled end/);
    // The certificate keeps the scheduled end even after the batch: it must still equal the execution window's end.
    w = world();
    w.cert["snipeShieldEndTs"] = w.policy["snipeShieldEndTs"];
    await expectCheck(w, "launch.account", "fail");
  });

  it("the expected meta list: 86 bytes, the policy PDA then the instructions sysvar", () => {
    const d = expectedMetaListData();
    expect(d.length).toBe(86);
    expect(toHex(d)).toBe(toHex(metaListBytes()));
    expect(new PublicKey(d.subarray(52, 84)).equals(KNOWN_ACCOUNTS.sysvarInstructions)).toBe(true);
  });

  it("upgradeable or changed programs are warnings, not silent", async () => {
    let w = world();
    upgradeableProgram(w.conn, PROGRAM_IDS.launchpad, programDataAddress(PROGRAM_IDS.launchpad), 300n, key("deployer"));
    let r = await expectCheck(w, "program.launchpad", "warn");
    expect(r.overall).toBe("warn");
    expect(r.trustedParties.find((t) => t.name.includes("launchpad"))?.address?.equals(key("deployer"))).toBe(true);
    w = world();
    upgradeableProgram(w.conn, PROGRAM_IDS.dbc, programDataAddress(PROGRAM_IDS.dbc), TRUST_ANCHORS.dbcLastDeploySlot + 1n, TRUST_ANCHORS.meteoraUpgradeAuthority);
    r = await expectCheck(w, "meteora.dbc", "warn");
    expect(r.checks.find((c) => c.id === "meteora.dbc")?.detail).toContain("the code changed");
    w = world();
    upgradeableProgram(w.conn, PROGRAM_IDS.dammV2, programDataAddress(PROGRAM_IDS.dammV2), TRUST_ANCHORS.dammV2LastDeploySlot, key("new-authority"));
    await expectCheck(w, "meteora.dammV2", "warn");
    w = world();
    upgradeableProgram(w.conn, KNOWN_ACCOUNTS.token2022, programDataAddress(KNOWN_ACCOUNTS.token2022), 1n, key("other"));
    await expectCheck(w, "token2022.upgrade", "warn");
  });
});

// ------------------------------------------------------------ graduation ---

function graduate(w: World, migrated: boolean): void {
  const ps = w.poolState["poolState"] as Record<string, unknown>;
  ps["quoteReserve"] = THRESHOLD;
  ps["migrationProgress"] = migrated ? 3 : 1;
  ps["isMigrated"] = migrated ? 1 : 0;
  w.mintOpts.extensions[1] = ext.transferHook(null, null);
}

interface Lp {
  nftMint: PublicKey;
  position: PublicKey;
  pool: PublicKey;
  poolState: Record<string, unknown>;
  positionState: Record<string, unknown>;
}

function addLp(w: World, o: { canonical?: boolean; permanent?: bigint; unlocked?: bigint; vested?: bigint; label?: string } = {}): Lp {
  const label = o.label ?? "nft";
  const nftMint = key(`verify/${label}`);
  const pool = o.canonical === false ? key("verify/other-pool") : dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
  const poolState = zeroed("dammV2", "Pool");
  Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, creator: KNOWN_ACCOUNTS.dbcPoolAuthority, poolStatus: 0, liquidity: 10n ** 20n, sqrtPrice: 1n << 64n, feeVersion: 1 });
  // What DBC's migration through the canonical config of option 2 (1%) writes: the tier plus its default dynamic fee.
  pristinePoolFees(poolState["poolFees"] as Record<string, unknown>, 2, 1n << 64n);
  const positionState = zeroed("dammV2", "Position");
  Object.assign(positionState, { pool, nftMint, permanentLockedLiquidity: o.permanent ?? 10n ** 20n, unlockedLiquidity: o.unlocked ?? 0n, vestedLiquidity: o.vested ?? 0n });
  const position = dammV2PositionAddress(nftMint);
  const lp: Lp = { nftMint, position, pool, poolState, positionState };
  const b = w.build;
  w.build = () => {
    b();
    w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", lp.poolState) });
    w.conn.set(position, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Position", lp.positionState) });
    w.conn.set(dammV2PositionNftAccountAddress(nftMint), { owner: T22, data: tokenAccountBytes({ mint: nftMint, owner: w.launchAuthority, amount: 1n, token2022: true }) });
  };
  return lp;
}

describe("verifyLaunch after graduation", () => {
  it("curve complete, not migrated: hook must be revoked; migration pending", async () => {
    const w = world();
    graduate(w, false);
    const r = await verify(w);
    expect(r.phase).toBe("graduated");
    expect(status(r, "mint.transferHook")).toBe("pass");
    expect(status(r, "damm.migration")).toBe("pass");
    expect(r.overall).toBe("pass");
    const w2 = world();
    graduate(w2, false);
    w2.mintOpts.extensions[1] = ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook);
    await expectCheck(w2, "mint.transferHook", "fail");
  });

  it("migrated: LP permanently locked, held by the launch authority, canonical enabled pool at the chosen fee", async () => {
    const w = world();
    graduate(w, true);
    addLp(w);
    const r = await verify(w);
    for (const id of ["mint.transferHook", "damm.lpLocked", "damm.pool", "damm.status", "damm.fee"]) expect(status(r, id), id).toBe("pass");
    expect(r.overall).toBe("pass");
    expect(r.checks.find((c) => c.id === "damm.lpLocked")?.detail).toContain("permanently locked");
  });

  it("a pool exactly as the migration made it verifies clean: its default dynamic fee is not an operator change (audit round 2)", async () => {
    let w = world();
    graduate(w, true);
    let lp = addLp(w);
    // Trading moved the dynamic fee's runtime state; its parameters are the config's.
    Object.assign((lp.poolState["poolFees"] as { dynamicFee: object }).dynamicFee, { volatilityAccumulator: 14_460_000n, volatilityReference: 7_230_000n, lastUpdateTimestamp: 1_800_000_000n });
    let r = await expectCheck(w, "damm.fee", "pass");
    expect(r.overall).toBe("pass");
    expect(detail(r, "damm.fee")).toMatch(/1% base fee, as chosen at launch, plus a dynamic fee of up to 0.1998916% .*at most 1.1998916% per trade/);
    // Operator changes are still caught: the dynamic fee disabled, re-parameterized, or the base fee raised.
    for (const change of [
      (pf: { dynamicFee: Record<string, unknown> }) => (pf.dynamicFee["initialized"] = 0),
      (pf: { dynamicFee: Record<string, unknown> }) => (pf.dynamicFee["variableFeeControl"] = 5_739),
      (pf: { dynamicFee: Record<string, unknown>; baseFee: { baseFeeInfo: { data: Uint8Array } } }) => (pf.baseFee.baseFeeInfo.data = concatBytes([u64le(100_000_000n), new Uint8Array(24)])),
    ]) {
      w = world();
      graduate(w, true);
      lp = addLp(w);
      change(lp.poolState["poolFees"] as { dynamicFee: Record<string, unknown>; baseFee: { baseFeeInfo: { data: Uint8Array } } });
      r = await expectCheck(w, "damm.fee", "warn");
      expect(detail(r, "damm.fee")).toMatch(/not what DBC's migration set for the 1% tier .*a DAMM v2 operator changed it/);
    }
    expect(detail(r, "damm.fee")).toMatch(/It now charges 10% plus a dynamic fee of up to 0.1998916% .*at most 10.1998916% per trade/);
  });

  it("migrated failure modes", async () => {
    let w = world();
    graduate(w, true);
    await expectCheck(w, "damm.lpLocked", "fail"); // no position at all

    w = world();
    graduate(w, true);
    addLp(w, { permanent: 0n, unlocked: 10n ** 18n });
    await expectCheck(w, "damm.lpLocked", "fail");

    w = world();
    graduate(w, true);
    addLp(w, { vested: 5n });
    await expectCheck(w, "damm.lpLocked", "fail");

    w = world();
    graduate(w, true);
    let lp = addLp(w);
    lp.poolState["creator"] = key("squatter");
    await expectCheck(w, "damm.lpLocked", "fail"); // not a DBC-migrated pool

    w = world();
    graduate(w, true);
    lp = addLp(w);
    lp.poolState["poolStatus"] = 1;
    await expectCheck(w, "damm.status", "warn");

    w = world();
    graduate(w, true);
    lp = addLp(w);
    (lp.poolState["poolFees"] as { baseFee: { baseFeeInfo: { data: Uint8Array } } }).baseFee.baseFeeInfo.data = concatBytes([u64le(100_000_000n), new Uint8Array(24)]);
    await expectCheck(w, "damm.fee", "warn");

    w = world();
    graduate(w, true);
    lp = addLp(w);
    lp.poolState["feeVersion"] = 1;
    (lp.poolState["poolFees"] as { dynamicFee: Record<string, unknown> }).dynamicFee["initialized"] = 0; // the pre-audit fixture: no dynamic fee
    await expectCheck(w, "damm.fee", "warn");

    w = world();
    graduate(w, true);
    addLp(w, { canonical: false });
    await expectCheck(w, "damm.pool", "warn");

    w = world();
    graduate(w, true);
    w.mintOpts.extensions[1] = ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook);
    addLp(w);
    await expectCheck(w, "mint.transferHook", "fail");
  });

  it("a decoy pool cannot add locked liquidity: the canonical pool decides", async () => {
    const w = world();
    graduate(w, true);
    addLp(w, { permanent: 0n, unlocked: 10n ** 18n }); // real pool: nothing locked
    const decoy = addLp(w, { label: "decoy", canonical: false }); // spoofed-creator pool, locked
    expect(decoy.poolState["creator"]).toEqual(KNOWN_ACCOUNTS.dbcPoolAuthority);
    await expectCheck(w, "damm.lpLocked", "fail");
  });

  it("an extra unlocked position held by the launch authority is reported, not hidden", async () => {
    const w = world();
    graduate(w, true);
    addLp(w);
    addLp(w, { label: "second", permanent: 0n, unlocked: 1_000n });
    const r = await verify(w);
    expect(status(r, "damm.lpLocked")).toBe("pass");
    expect(r.checks.find((c) => c.id === "damm.lpLocked")?.detail).toContain("unlocked but held by the launch authority PDA");
  });
});

// ------------------------------------------------- post-quantum origin ---

describe("verifyLaunch: post-quantum origin", () => {
  it("re-verifies the attestation against the identity's key and reports the origin", async () => {
    const w = world();
    const r = await expectCheck(w, "pq.origin", "pass");
    const o = r.pqOrigin!;
    expect(o.verified).toBe(true);
    expect(o.signatureValid).toBe(true);
    expect(toHex(o.identityId)).toBe(LMS.identity.identityId);
    expect(toHex(o.lmsPublicKey!)).toBe(LMS.identity.publicKey);
    expect(o.identity.equals(identityAddressFromId(fromHex(LMS.identity.identityId)))).toBe(true);
    expect(o.attestation.equals(attestationAddress(w.launch))).toBe(true);
    expect(o.leaf).toBe(511);
    expect(o.attestationSlot).toBe(399_999_000n);
    expect(o.window).toEqual({ notBefore: w.pq.notBefore, notAfter: w.pq.notAfter });
    expect(toHex(o.messageHash)).toBe(toHex(sha256(worldMessage(w))));
    expect(worldMessage(w)).toHaveLength(221); // message v3: the rules hash (all zero here) is signed too
    expect(o.rules).toEqual({ hash: "0".repeat(64), address: null, bytes: new Uint8Array(0), explanation: [expect.stringMatching(/^No launch rules/)] });
    expect(detail(r, "pq.origin")).toContain("It signed no launch rules.");
    expect(toHex(o.metadataHash)).toBe(toHex(recordHash(w.pq.record)));
    expect(o.tokenMeta.equals(recordAddress(w.launch, w.pq.record))).toBe(true);
    expect(detail(r, "pq.origin")).toContain(LMS.identity.identityId);
    expect(r.overall).toBe("pass");
  });

  it("no attestation, or the empty one a burn-only landing leaves: not PQ-attested", async () => {
    let w = world();
    w.pq.attestation = "missing";
    let r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/^Not PQ-attested: no attestation account/);
    expect(r.pqOrigin).toBeNull();
    w = world();
    w.pq.attestation = "empty"; // lms.json burnOnly.emptyAttestation, verbatim
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/^Not PQ-attested: the attestation .* is empty \(version 0\)/);
    expect(r.pqOrigin).toBeNull();
  });

  it("the certificate's and the launch's PQ fields must be the attestation's", async () => {
    for (const [field, value] of [
      ["pqIdentity", new Uint8Array(32).fill(3)],
      ["pqLeaf", 510],
      ["attestedSlot", 1n],
    ] as const) {
      const w = world();
      w.cert[field] = value;
      const r = await expectCheck(w, "pq.origin", "fail");
      expect(r.pqOrigin?.verified ?? false, field).toBe(false);
    }
    const w = world();
    w.launchState["pqIdentity"] = new Uint8Array(32).fill(3);
    await expectCheck(w, "pq.origin", "fail");
  });

  it("the signed message is rebuilt from on-chain data: a mint that is not the record, another creator or params_hash fails", async () => {
    let w = world();
    w.pq.mintMetadata = { name: "Verified2", symbol: "VER", uri: "" }; // the mint carries another name than the record the identity signed
    let r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/the mint's name or symbol is not the attested record's/);
    expect(status(r, "metadata.match")).toBe("fail");
    w = world();
    w.pq.mintMetadata = { name: "Verified", symbol: "VER", uri: "https://example.org/w.json" };
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/the mint's uri is not the one derived from the attested record/);
    w = world();
    w.pq.creator = key("someone-else");
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/signature does not verify/);
    w = world();
    w.pq.paramsHash = new Uint8Array(32).fill(5);
    await expectCheck(w, "pq.origin", "fail");
  });

  it("a forged or misplaced signature, or an identity account that does not back it, fails", async () => {
    let w = world();
    w.pq.patch = (rec) => {
      const sig = (rec["signature"] as Uint8Array).slice();
      sig[2_000]! ^= 1;
      rec["signature"] = sig;
    };
    let r = await expectCheck(w, "pq.origin", "fail");
    expect(r.pqOrigin?.signatureValid).toBe(false);
    // A genuine signature made with leaf 512, recorded as leaf 511.
    w = world();
    w.pq.signLeaf = 512;
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/does not verify at leaf 511/);
    // The same signature recorded as leaf 512, with the identity marking it: fine.
    w = world();
    Object.assign(w.pq, { leaf: 512, signLeaf: 512, usedLeaves: [511, 512] });
    w.cert["pqLeaf"] = 512;
    await expectCheck(w, "pq.origin", "pass");
    w = world();
    w.pq.usedLeaves = null;
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/no identity account/);
    w = world();
    w.pq.usedLeaves = [510];
    r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/does not mark leaf 511 as used/);
  });

  it("the launch must have run inside the attested window (inclusive)", async () => {
    let w = world();
    const launchTs = w.launchState["launchTs"] as bigint;
    Object.assign(w.pq, { notBefore: launchTs + 1n, notAfter: launchTs + 3_601n });
    const r = await expectCheck(w, "pq.origin", "fail");
    expect(detail(r, "pq.origin")).toMatch(/outside the attested window/);
    w = world();
    Object.assign(w.pq, { notBefore: launchTs, notAfter: launchTs + 3_600n });
    await expectCheck(w, "pq.origin", "pass");
    w = world();
    Object.assign(w.pq, { notBefore: launchTs - 3_600n, notAfter: launchTs });
    await expectCheck(w, "pq.origin", "pass");
  });

  it("a launch that ran outside its record: the attestation names another record than the certificate", async () => {
    const w = world();
    // A junk record anyone published under the launch, which the certificate names instead.
    const junk: WorldRecord = { ...w.pq.record, doc: new TextEncoder().encode('{"name":"Verified","symbol":"VER","description":"junk"}') };
    w.cert["metadata"] = recordAddress(w.launch, junk);
    const build = w.build;
    w.build = () => {
      build();
      w.conn.set(recordAddress(w.launch, junk), { owner: PROGRAM_IDS.launchpad, data: emulatedTokenMetaBytes(w.launch, junk.name, junk.symbol, junk.flags, junk.uri, junk.doc) });
    };
    const r = await expectCheck(w, "metadata.onchain", "fail");
    expect(status(r, "pq.origin")).toBe("fail");
    expect(detail(r, "pq.origin")).toMatch(/certificate names the metadata record .* not the attested/);
    expect(r.metadata?.verified).toBe(false);
  });

});

// ------------------------------------------------- on-chain metadata ---

describe("verifyLaunch: the on-chain metadata record", () => {
  const published = (w: PqWorld, r: WorldRecord): Uint8Array => emulatedTokenMetaBytes(w.launch, r.name, r.symbol, r.flags, r.uri, r.doc);

  it("found through the certificate at the address of the signed hash: stored on-chain, name and symbol match, an inline PNG icon; the report carries the record and its document", async () => {
    const w = world();
    const r = await verify(w);
    expect(status(r, "metadata.onchain")).toBe("pass");
    expect(detail(r, "metadata.onchain")).toMatch(/at the address of their own hash, which the creator's post-quantum identity signed.*link is empty: nothing is loaded from elsewhere/);
    expect(status(r, "metadata.match")).toBe("pass");
    expect(detail(r, "metadata.match")).toBe('The token is "Verified" (VER) in the mint, in the record and in its document.');
    expect(status(r, "metadata.icon")).toBe("pass");
    expect(detail(r, "metadata.icon")).toMatch(/a 32x32 PNG stored inside the record \(672 bytes\); it is never loaded from a link/);
    const m = r.metadata!;
    expect(m.verified).toBe(true);
    expect(m.address.equals(recordAddress(w.launch, w.pq.record))).toBe(true);
    expect([m.record?.name, m.record?.symbol, m.record?.flags, m.record?.tokenUri]).toEqual(["Verified", "VER", 0, ""]);
    expect(m.document?.ok).toBe(true);
    expect(m.document?.description).toBe("verifier fixture");
    expect(toHex(m.document!.icon!.png)).toBe(toHex(ICON_PNG));
  });

  it("a missing, foreign-owned or altered record: not stored on-chain, and not PQ-attested", async () => {
    let w = world();
    w.pq.recordAccount = "missing";
    let r = await expectCheck(w, "metadata.onchain", "fail");
    expect(detail(r, "pq.origin")).toMatch(/no metadata record at/);
    expect(r.metadata).toMatchObject({ record: null, document: null, verified: false });
    expect(r.checks.some((c) => c.id === "metadata.icon")).toBe(false);
    w = world();
    w.pq.recordAccount = { owner: key("impostor-program"), data: published(w, w.pq.record) };
    r = await expectCheck(w, "metadata.onchain", "fail");
    expect(detail(r, "pq.origin")).toMatch(/metadata record .* is not owned by the launchpad/);
    // The document altered in place: its hash no longer names the address.
    w = world();
    const bytes = published(w, w.pq.record);
    bytes[bytes.length - 3]! ^= 1;
    w.pq.recordAccount = { owner: PROGRAM_IDS.launchpad, data: bytes };
    r = await expectCheck(w, "metadata.onchain", "fail");
    expect(detail(r, "pq.origin")).toMatch(/metadata record is invalid .*not the hash of its content/);
    expect(r.metadata?.verified).toBe(false);
  });

  it("the certificate must record METADATA_ONCHAIN", async () => {
    const w = world();
    w.cert["checks"] = 4095 & ~2048;
    const r = await expectCheck(w, "metadata.onchain", "fail");
    expect(detail(r, "metadata.onchain")).toMatch(/does not record the metadata check/);
    expect(status(r, "certificate.checks")).toBe("fail");
    expect(r.metadata?.verified).toBe(false);
  });

  it("the uri modes: an external link warns (what it serves can change), an inline uri passes; the mint must hold exactly the derived uri", async () => {
    let w = world();
    w.pq.record = { ...w.pq.record, flags: 2, uri: utf8("https://example.org/v.json") };
    let r = await verify(w);
    expect(status(r, "metadata.onchain")).toBe("warn");
    expect(detail(r, "metadata.onchain")).toMatch(/also points to https:\/\/example\.org\/v\.json, a page the creator chose/);
    expect(status(r, "pq.origin")).toBe("pass");
    expect(status(r, "metadata.match")).toBe("pass");
    expect(r.overall).toBe("warn");
    expect(r.metadata?.verified).toBe(true);
    w = world();
    w.pq.record = { ...w.pq.record, flags: 1 };
    r = await verify(w);
    expect(status(r, "metadata.onchain")).toBe("pass");
    expect(detail(r, "metadata.onchain")).toMatch(/carries the same document inline/);
    expect(r.metadata?.record?.tokenUri).toMatch(/^data:application\/json;base64,eyJuYW1l/);
    expect(r.overall).toBe("pass");
    // The mint's uri is empty although the record asks for the inline one.
    w.pq.mintMetadata = { name: "Verified", symbol: "VER", uri: "" };
    r = await expectCheck(w, "metadata.match", "fail");
    expect(detail(r, "metadata.match")).toMatch(/the mint's link is not the one derived from the record/);
  });

  it("the document is read defensively and never fetched: a remote image, no document, a name that is not the record's", async () => {
    let w = world();
    w.pq.record = { ...w.pq.record, doc: utf8('{"name":"Verified","symbol":"VER","image":"https://evil.example/x.png"}') };
    let r = await verify(w);
    expect(status(r, "metadata.icon")).toBe("warn");
    expect(detail(r, "metadata.icon")).toMatch(/is not shown: image: is not an inline PNG/);
    expect(r.metadata?.document?.icon).toBeNull();
    expect(status(r, "pq.origin")).toBe("pass");
    w = world();
    w.pq.record = { ...w.pq.record, doc: new Uint8Array(0) };
    r = await verify(w);
    expect(status(r, "metadata.icon")).toBe("pass");
    expect(detail(r, "metadata.icon")).toMatch(/has no document/);
    expect(r.metadata?.document?.empty).toBe(true);
    w = world();
    w.pq.record = { ...w.pq.record, doc: utf8('{"name":"Other","symbol":"VER"}') };
    r = await expectCheck(w, "metadata.match", "fail");
    expect(detail(r, "metadata.match")).toMatch(/document's name "Other" is not the record's/);
    expect(r.metadata?.verified).toBe(false);
  });

  it("additional metadata fields on the mint fail the match", async () => {
    const w = world();
    const build = w.build;
    w.build = () => {
      build();
      const m = w.mintOpts.extensions.find((e) => e.type === 19)!;
      const extra = concatBytes([m.data.subarray(0, m.data.length - 4), new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0]), utf8("k"), new Uint8Array([1, 0, 0, 0]), utf8("v")]);
      w.conn.set(w.mint, { owner: w.mintOpts.owner, data: mintBytes({ ...w.mintOpts, extensions: w.mintOpts.extensions.map((e) => (e.type === 19 ? { type: 19, data: extra } : e)) }) });
    };
    const r = await expectCheck(w, "metadata.match", "fail");
    expect(detail(r, "metadata.match")).toMatch(/extra metadata fields/);
    expect(detail(r, "pq.origin")).toMatch(/additional metadata the record does not/);
  });
});

describe("associated token addresses used by the verifier", () => {
  it("are the canonical ones", () => {
    expect(associatedTokenAddress(key(1), key(2)).equals(PublicKey.findProgramAddressSync([key(1).toBytes(), T22.toBytes(), key(2).toBytes()], KNOWN_ACCOUNTS.associatedToken)[0])).toBe(true);
  });
});
