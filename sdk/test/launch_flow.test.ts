/**
 * The PQ v2 launch flow (`src/launch/flow.ts`) end to end on a mocked
 * cluster: the creator's wSOL PQ vault as fee recipient, the plan (with the
 * token's metadata record), create_launch, the throwaway payer's funding for
 * the record and the attestation, publish_metadata and the wait until the
 * record is final, the identity's attestation (both landed by models of the
 * program, `attest_world.ts`), the sweep of what is left, the wait for the
 * window on the cluster clock, the permissionless launch, and the status
 * reader through commit, execute and claim. Every refusal the flow adds is
 * checked on its own.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { BorshReader } from "../src/codec/borsh.js";
import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { PROGRAM_IDS, WSOL_MINT } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { deserializeLaunchParams } from "../src/launch/builders.js";
import {
  buildPlannedAttestTx,
  buildPlannedCreateLaunchTx,
  buildPlannedLaunchTx,
  buildPlannedPublishTx,
  getLaunchFlowStatus,
  planLaunch,
  prepareFeeVault,
  preparePqVault,
  replanLaunchWindow,
  vaultFeeRecipients,
  waitForLaunchWindow,
  type LaunchPlan,
  type PlanLaunchInput,
} from "../src/launch/flow.js";
import { launchParamsHash } from "../src/launch/hash.js";
import { clusterUnixTime } from "../src/launch/window.js";
import { buildMetadataDoc } from "../src/metadata/doc.js";
import {
  buildFundThrowawayPayerTx,
  buildSweepPayerTx,
  PublishPayerFundingError,
  sendPublishMetadataTx,
  throwawayPayerFunding,
  waitForTokenMeta,
  type PublishMetadataReady,
  type ThrowawayPayerFundingOptions,
} from "../src/metadata/publish.js";
import { attestationAddress, commitAddress, protocolAddress, tokenMetaAddress } from "../src/pda.js";
import { sendAttestLaunchTx, type AttestLaunchReady } from "../src/pq/attest.js";
import { deriveIdentity, parseAttestationMessage, type PqIdentity } from "../src/pq/identity.js";
import { createMemoryLeafLedger } from "../src/pq/leafLedger.js";
import { ClusterMismatchError, GENESIS_HASHES } from "../src/rpc/cluster.js";
import { AttestConnection, attestationAccountBytes, emulatedMetadataHash, emulatedTokenMetaBytes, emulateLaunchpad } from "./attest_world.js";
import { key, mintBytes, readJson, SPL } from "./helpers.js";
import { accountBytes } from "./world.js";

const NOW = 1_800_000_000n;
const MASTER = fromHex(readJson<{ derivation: { master: string } }>("./vectors/lms.json").derivation.master);
const CREATOR = key("flow/creator");
const KEEPER = key("flow/keeper");
const DOC = buildMetadataDoc({ name: "Flow Token", symbol: "FLOW", description: "A token of the flow test.", links: { website: "https://flow.example" } });
/** The token's record: no uri mode (the mint's uri stays empty), the document above. */
const META = { name: "Flow Token", symbol: "FLOW", doc: DOC };
const META_HASH = emulatedMetadataHash(utf8(META.name), utf8(META.symbol), 0, new Uint8Array(0), DOC);

let identity: PqIdentity;

beforeAll(async () => {
  identity = await deriveIdentity(MASTER, "localnet", 0);
});

function cluster(): AttestConnection {
  const conn = new AttestConnection();
  conn.setClock(NOW);
  conn.set(protocolAddress(), { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Protocol", { version: 1, bump: 255, treasury: key("flow/treasury"), platformFeeBps: 1_000 }) });
  conn.set(WSOL_MINT, { owner: SPL, data: mintBytes({ decimals: 9 }) });
  conn.land = (w) => emulateLaunchpad(conn, w);
  return conn;
}

/** What `open_vault` leaves: a v4 vault of `mint`. */
function openVault(conn: AttestConnection, vault: PublicKey, mint: PublicKey): void {
  const codec = idlCodecs().vault;
  const data = concatBytes([codec.accountDiscriminator("Vault"), Uint8Array.of(4, 255), mint.toBytes()]);
  conn.set(vault, { owner: PROGRAM_IDS.vault, data: concatBytes([data, new Uint8Array(codec.accountSize("Vault") - data.length)]) });
}

function launchState(plan: LaunchPlan, over: Record<string, unknown> = {}): Record<string, unknown> {
  const p = plan.params;
  const recipients = [...p.recipients];
  while (recipients.length < 4) recipients.push({ wallet: PublicKey.default, bps: 0 });
  return {
    version: 2,
    bump: 255,
    authorityBump: 254,
    batchBump: 253,
    configBump: 252,
    status: { kind: "Configured" },
    launchSeed: plan.launchSeed,
    creator: plan.creator,
    dbcConfig: plan.pdas.dbcConfig,
    launchAuthority: plan.pdas.launchAuthority,
    batchAuthority: plan.pdas.batchAuthority,
    baseMint: PublicKey.default,
    pool: PublicKey.default,
    treasury: key("flow/treasury"),
    platformFeeBps: 1_000,
    recipients,
    recipientCount: p.recipients.length,
    tokenDecimal: p.tokenDecimal,
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    migrationFeeOption: p.migrationFeeOption,
    openDelaySecs: p.openDelaySecs,
    guardSecs: p.guardSecs,
    maxWalletBps: p.maxWalletBps,
    maxBuyBps: p.maxBuyBps,
    p2pLocked: p.p2pLocked,
    batchWalletCap: p.batchWalletCap,
    batchTotalCap: p.batchTotalCap,
    paramsHash: plan.paramsHash,
    launchTs: 0n,
    commitEndTs: 0n,
    executeEndTs: 0n,
    guardEndTs: 0n,
    totalCommitted: 0n,
    executed: false,
    quoteSpent: 0n,
    tokensOut: 0n,
    tokensClaimed: 0n,
    quoteRefunded: 0n,
    pqIdentity: plan.pqIdentity,
    ...over,
  };
}

function setLaunch(conn: AttestConnection, plan: LaunchPlan, over: Record<string, unknown> = {}): void {
  conn.set(plan.launch, { owner: PROGRAM_IDS.launchpad, data: accountBytes("launchpad", "Launch", launchState(plan, over)) });
}

function planInput(over: Partial<PlanLaunchInput> = {}): PlanLaunchInput {
  return { creator: CREATOR, identity, preset: "fair", feeVault: key("flow/fee-vault"), metadata: META, opensAt: NOW + 600n, nowSecs: NOW, ...over };
}

/** The plan's record, as publish_metadata leaves it. */
function publishRecord(conn: AttestConnection, plan: LaunchPlan): void {
  conn.set(plan.tokenMeta, { owner: PROGRAM_IDS.launchpad, data: emulatedTokenMetaBytes(plan.launch, utf8(META.name), utf8(META.symbol), 0, new Uint8Array(0), DOC) });
}

describe("PQ vaults for the flow", () => {
  it("prepareFeeVault: the phrase's wSOL vault, with open_vault until it is open", async () => {
    const conn = cluster();
    const c = conn.asConnection();
    const target = await prepareFeeVault(c, { master: MASTER, cluster: "localnet", payer: CREATOR, allowLocalnet: true });
    expect(target.mint.equals(WSOL_MINT)).toBe(true);
    expect(target.account).toBe(0);
    expect(target.opened).toBe(false);
    expect(target.openTx).not.toBeNull();
    const open = target.openTx!.instructions.find((ix) => ix.programId.equals(PROGRAM_IDS.vault))!;
    expect(open.keys.some((k) => k.pubkey.equals(target.vault))).toBe(true);
    expect(target.openTx!.feePayer!.equals(CREATOR)).toBe(true);
    openVault(conn, target.vault, WSOL_MINT);
    const again = await prepareFeeVault(c, { master: MASTER, cluster: "localnet", payer: CREATOR, allowLocalnet: true });
    expect([again.opened, again.openTx, again.vault.toBase58()]).toEqual([true, null, target.vault.toBase58()]);
    // Another account number is another vault; another cluster's keys are refused.
    const other = await preparePqVault(c, { master: MASTER, cluster: "localnet", mint: WSOL_MINT, payer: CREATOR, account: 1, allowLocalnet: true });
    expect(other.vault.equals(target.vault)).toBe(false);
    conn.genesisHash = GENESIS_HASHES.devnet;
    await expect(prepareFeeVault(c, { master: MASTER, cluster: "localnet", payer: CREATOR, allowLocalnet: true })).rejects.toBeInstanceOf(ClusterMismatchError);
    await expect(prepareFeeVault(c, { master: new Uint8Array(64), cluster: "devnet", payer: CREATOR })).rejects.toThrow(/all-zero/);
  });

  it("vaultFeeRecipients: all creator fees to the vault", () => {
    const vault = key("flow/vault");
    expect(vaultFeeRecipients(vault)).toEqual([{ wallet: vault, bps: 10_000 }]);
  });
});

describe("planLaunch", () => {
  it("fixes parameters, the vault as fee recipient, the metadata record, its hash and address, the window, and the exact 221-byte message the identity signs", () => {
    const vault = key("flow/fee-vault");
    const plan = planLaunch(planInput({ feeVault: vault }));
    expect(plan.params.recipients).toEqual([{ wallet: vault, bps: 10_000 }]);
    expect(toHex(plan.params.pqIdentity)).toBe(toHex(identity.identityId));
    expect(toHex(plan.paramsHash)).toBe(toHex(launchParamsHash(plan.params)));
    expect(plan.window).toEqual({ notBefore: NOW + 600n, notAfter: NOW + 4_200n });
    expect(plan.pdas.launch.equals(plan.launch)).toBe(true);
    expect(plan.warnings).toEqual([]);
    const f = parseAttestationMessage(plan.message);
    expect(f.launch.equals(plan.launch) && f.creator.equals(CREATOR) && f.programId.equals(PROGRAM_IDS.launchpad)).toBe(true);
    expect(toHex(f.paramsHash)).toBe(toHex(plan.paramsHash));
    expect(toHex(f.metadataHash)).toBe(toHex(META_HASH));
    expect(toHex(plan.metadataHash)).toBe(toHex(META_HASH));
    expect(plan.message).toHaveLength(221);
    // No creator rules in this plan: the zero rules hash, no record.
    expect([toHex(plan.rulesHash), plan.rules, plan.rulesRecord, plan.rulesExplanation]).toEqual(["00".repeat(32), null, null, []]);
    expect(toHex(f.rulesHash)).toBe("00".repeat(32));
    expect(plan.tokenMeta.equals(tokenMetaAddress(plan.launch, META_HASH))).toBe(true);
    expect(plan.tokenUri).toBe("");
    expect([toHex(plan.metadata.name), toHex(plan.metadata.symbol), plan.metadata.flags, plan.metadata.uri.length, toHex(plan.metadata.doc)]).toEqual([toHex(utf8("Flow Token")), toHex(utf8("FLOW")), 0, 0, toHex(DOC)]);
    expect([f.notBefore, f.notAfter]).toEqual([NOW + 600n, NOW + 4_200n]);
    expect(toHex(plan.messageHash)).toBe(toHex(sha256(plan.message)));
    // The preset itself is not modified.
    const again = planLaunch(planInput({ feeVault: vault, launchSeed: plan.launchSeed }));
    expect(toHex(again.paramsHash)).toBe(toHex(plan.paramsHash));
    expect(planLaunch(planInput({ windowSecs: 60n })).window.notAfter).toBe(NOW + 660n);
  });

  it("explicit recipients win over the vault default; an inline or external uri is warned about", () => {
    const a = key("flow/a");
    const plan = planLaunch(planInput({ recipients: [{ wallet: a, bps: 10_000 }] }));
    expect(plan.params.recipients).toEqual([{ wallet: a, bps: 10_000 }]);
    expect(plan.warnings).toEqual(["feeVault is not among the fee recipients"]);
    const inline = planLaunch(planInput({ metadata: { ...META, flags: 1 } }));
    expect(inline.warnings.join(" ")).toMatch(/INLINE_URI .*do not offer it until wallets and indexers/);
    expect(inline.tokenUri).toMatch(/^data:application\/json;base64,/);
    const external = planLaunch(planInput({ metadata: { ...META, flags: 2, uri: "https://flow.example/meta.json" } }));
    expect(external.warnings.join(" ")).toMatch(/external uri .*can change/);
    expect(external.tokenUri).toBe("https://flow.example/meta.json");
    // The record's hash covers the flags and the uri: three records, three messages.
    expect(new Set([plan, inline, external].map((x) => toHex(x.metadataHash))).size).toBe(3);
  });

  it("refuses what the program would refuse or burn, with every problem listed", () => {
    expect(() => planLaunch(planInput({ feeVault: undefined }))).toThrow(/feeVault/);
    expect(() => planLaunch(planInput({ opensAt: NOW * 1000n, nowSecs: undefined }))).toThrow(/notBefore: looks like milliseconds/);
    expect(() => planLaunch(planInput({ opensAt: (1n << 63n) - 10n, windowSecs: 60n, nowSecs: undefined }))).toThrow(/notAfter: out of i64 range/);
    expect(() => planLaunch(planInput({ windowSecs: 3_601n }))).toThrow(/must last/);
    expect(() => planLaunch(planInput({ windowSecs: 59n }))).toThrow(/must last/);
    expect(() => planLaunch(planInput({ nowSecs: NOW + 5_000n }))).toThrow(/ends before/);
    expect(() => planLaunch(planInput({ nowSecs: Number(NOW) as unknown as bigint }))).toThrow(TypeError);
    expect(() => planLaunch(planInput({ opensAt: NOW + 604_801n }))).toThrow(/7 days/);
    expect(() => planLaunch(planInput({ metadata: { ...META, name: "€".repeat(11) } }))).toThrow(/name: must be .*33/);
    expect(() => planLaunch(planInput({ metadata: { ...META, flags: 3 } }))).toThrow(/flags: must be 0, 1 .* or 2/);
    expect(() => planLaunch(planInput({ metadata: { ...META, uri: "https://flow.example" } }))).toThrow(/uri: must be empty unless the external-uri flag is set/);
    expect(() => planLaunch(planInput({ metadata: { ...META, doc: "x".repeat(3_073) } }))).toThrow(/doc: must be at most 3072 bytes/);
    expect(() => planLaunch(planInput({ metadata: null as never }))).toThrow(/metadata must be the token's record/);
    expect(() => planLaunch(planInput({ identity: new Uint8Array(32) }))).toThrow(/identity/);
    expect(() => planLaunch(planInput({ preset: "nope" as never, params: undefined }))).toThrow(/unknown preset/);
    expect(() => planLaunch(planInput({ recipients: [{ wallet: key("x"), bps: 9_000 }] }))).toThrow(/10,000/);
  });
});

describe("the flow, end to end on a mocked cluster", () => {
  it("vault → plan → create → fund → publish → (final) → attest → sweep → wait → launch → commit → execute → claim", async () => {
    const conn = cluster();
    const c = conn.asConnection();
    const ledger = createMemoryLeafLedger();

    // 0. The fee vault, opened.
    const fee = await prepareFeeVault(c, { master: MASTER, cluster: "localnet", payer: CREATOR, allowLocalnet: true });
    openVault(conn, fee.vault, WSOL_MINT);

    // 1. Plan.
    const plan = planLaunch(planInput({ feeVault: fee.vault }));
    expect((await getLaunchFlowStatus(c, plan.launch)).step).toBe("create");

    // 2. create_launch carries exactly the plan's parameters.
    const created = await buildPlannedCreateLaunchTx(c, plan);
    expect(created.launch.equals(plan.launch)).toBe(true);
    const ix = created.tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.launchpad))!;
    expect(toHex(ix.data.subarray(8, 40))).toBe(toHex(plan.launchSeed));
    expect(toHex(launchParamsHash(deserializeLaunchParams(ix.data.subarray(40))))).toBe(toHex(plan.paramsHash));
    setLaunch(conn, plan);
    let s = await getLaunchFlowStatus(c, plan.launch);
    expect([s.step, s.attestationState, s.canLaunchNow, s.metadataPublished]).toEqual(["attest", "none", false, null]);
    s = await getLaunchFlowStatus(c, plan.launch, { expectedMetadataHash: plan.metadataHash });
    expect([s.step, s.metadataPublished, s.tokenMeta]).toEqual(["publish", false, null]);

    // 3. One funding for the record and the attestation (rents read from the cluster), plus a margin to sweep back.
    const payer = Keypair.generate();
    const funding = await buildFundThrowawayPayerTx(c, CREATOR, payer.publicKey, { metadata: plan.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey });
    const rent = (n: number): bigint => BigInt((128 + n) * 6_960);
    expect(funding.funding).toEqual({
      lamports: funding.lamports,
      tokenMetaRent: rent(91 + 10 + 4 + DOC.length),
      identityRent: rent(196),
      attestationRent: rent(2_708),
      publishFee: 5_000n,
      rulesRent: 0n,
      publishRulesFee: 0n,
      attestFee: 5_000n,
      rentFloor: 0n,
    });
    expect(funding.lamports).toBe(rent(91 + 14 + DOC.length) + rent(196) + rent(2_708) + 10_000n);
    const margin = 1_000_000_000n;
    conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(funding.lamports + margin) });

    // publish_metadata from the throwaway payer; the identity refuses to sign until the record is final.
    const pub = (await buildPlannedPublishTx(c, plan, payer)) as PublishMetadataReady;
    expect(pub.status).toBe("ready");
    expect(pub.tokenMeta.equals(plan.tokenMeta)).toBe(true);
    conn.hiddenAtFinalized.add(plan.tokenMeta.toBase58());
    const record = await sendPublishMetadataTx(c, pub);
    expect(record.publicKey.equals(plan.tokenMeta)).toBe(true);
    expect(toHex(record.doc)).toBe(toHex(DOC));
    s = await getLaunchFlowStatus(c, plan.launch, { expectedMetadataHash: plan.metadataHash });
    expect([s.step, s.metadataPublished]).toEqual(["attest", true]);
    await expect(buildPlannedAttestTx(c, plan, { identity, ledger, allowLocalnet: true, payer })).rejects.toThrow(/not finalized yet/);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    const waited = await waitForTokenMeta(c, plan.launch, plan.metadataHash, {
      pollIntervalMs: 2_000,
      sleep: async () => {
        conn.hiddenAtFinalized.delete(plan.tokenMeta.toBase58()); // ~13 s later the record is final
      },
    });
    expect(waited.publicKey.equals(plan.tokenMeta)).toBe(true);
    // Publishing is idempotent: the record is there, nothing to send.
    expect((await buildPlannedPublishTx(c, plan, payer)).status).toBe("already-published");

    // Attest, confirm.
    const built = (await buildPlannedAttestTx(c, plan, { identity, ledger, allowLocalnet: true, payer })) as AttestLaunchReady;
    expect(built.status).toBe("ready");
    expect(toHex(built.message)).toBe(toHex(plan.message));
    expect(built.tokenMeta.equals(plan.tokenMeta)).toBe(true);
    expect(built.fundingLamports).toBe(rent(196) + rent(2_708) + 5_000n);
    const outcome = await sendAttestLaunchTx(c, built, { ledger });
    expect(outcome.status).toBe("attested");
    expect((await ledger.get(identity.identityId, built.leaf))?.status).toBe("landed");

    // What is left goes back to the creator: exactly the margin, less the sweep's own fee.
    expect(BigInt(conn.get(payer.publicKey)!.lamports!)).toBe(margin);
    const sweep = await buildSweepPayerTx(c, payer, CREATOR);
    expect(sweep?.lamports).toBe(margin - 5_000n);
    expect(sweep?.tx.feePayer?.equals(payer.publicKey)).toBe(true);
    expect(sweep?.tx.verifySignatures()).toBe(true);
    conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 5_000 });
    expect(await buildSweepPayerTx(c, payer, CREATOR)).toBeNull();
    await expect(buildSweepPayerTx(c, payer, payer.publicKey)).rejects.toThrow(/creator's wallet/);

    // 4. Attested, before the window: wait for the cluster clock.
    s = await getLaunchFlowStatus(c, plan.launch, { expectedMessageHash: plan.messageHash });
    expect([s.step, s.attestationState, s.attestedMessageMatches, s.secondsUntilWindowOpens, s.canLaunchNow]).toEqual(["wait-for-window", "attested", true, 600n, false]);
    expect(s.window).toEqual(plan.window);
    await expect(buildPlannedLaunchTx(c, plan, KEEPER, Keypair.generate())).rejects.toThrow(/NotLaunchWindow/);
    const sleeps: number[] = [];
    const ready = await waitForLaunchWindow(c, plan.launch, {
      pollIntervalMs: 120_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        conn.setClock(conn.clockNow() + BigInt(ms / 1_000));
      },
    });
    expect([ready.step, ready.canLaunchNow, ready.secondsUntilWindowOpens]).toEqual(["launch", true, 0n]);
    expect(sleeps).toEqual([120_000, 120_000, 120_000, 120_000, 120_000]);
    expect(conn.clockNow()).toBe(plan.window.notBefore);

    // 5. Anyone launches inside the window: no arguments, the attested record, then the rules account (none: the program id) last.
    const mint = Keypair.generate();
    const { tx } = await buildPlannedLaunchTx(c, plan, KEEPER, mint);
    const launchIx = tx.instructions.find((i) => i.programId.equals(PROGRAM_IDS.launchpad))!;
    expect(launchIx.keys[0]!.pubkey.equals(KEEPER)).toBe(true);
    expect(launchIx.keys.some((k) => k.pubkey.equals(attestationAddress(plan.launch)))).toBe(true);
    expect(launchIx.keys.at(-2)!.pubkey.equals(plan.tokenMeta)).toBe(true);
    expect(launchIx.keys.at(-1)!.pubkey.equals(PROGRAM_IDS.launchpad)).toBe(true);
    expect(new BorshReader(launchIx.data.subarray(8)).remaining).toBe(0);

    // 6-8. Live: commit, execute, claim, as the status reader tells them.
    const T = plan.window.notBefore + 10n;
    const live = { status: { kind: "Live" }, baseMint: mint.publicKey, launchTs: T, commitEndTs: T + 300n, executeEndTs: T + 900n, guardEndTs: T + 21_600n };
    setLaunch(conn, plan, { ...live, totalCommitted: 5_000_000_000n });
    const at = async (t: bigint, owner?: PublicKey) => getLaunchFlowStatus(c, plan.launch, { nowSecs: t, ...(owner === undefined ? {} : { owner }) });
    // One type for now: a number is refused before anything is read.
    const reads = conn.calls.length;
    await expect(getLaunchFlowStatus(c, plan.launch, { nowSecs: Number(T) as unknown as bigint })).rejects.toThrow(TypeError);
    expect(conn.calls.length).toBe(reads);
    // An RPC whose clock is not plausible unix seconds is named as the problem (review finding: it used to blame the
    // caller with "nowSecs looks like milliseconds", although the caller passed no nowSecs).
    const clockNow = conn.clockNow();
    conn.setClock(T * 1000n);
    await expect(getLaunchFlowStatus(c, plan.launch)).rejects.toThrow(/cluster clock \(Clock sysvar\) your RPC returned reads \d+, which is not plausible unix seconds/);
    await expect(clusterUnixTime(c)).rejects.toThrow(/your RPC returned/);
    conn.setClock(clockNow);
    expect(await clusterUnixTime(c)).toBe(clockNow);
    expect([(await at(T + 10n)).step, (await at(T + 10n)).phase]).toEqual(["commit", "commit"]);
    expect([(await at(T + 400n)).step, (await at(T + 400n)).batch]).toEqual(["execute", "pending"]);
    setLaunch(conn, plan, { ...live, totalCommitted: 5_000_000_000n, executed: true, quoteSpent: 5_000_000_000n, tokensOut: 1_000n });
    expect([(await at(T + 400n)).step, (await at(T + 400n)).phase, (await at(T + 400n)).batch]).toEqual(["claim", "guarded", "executed"]);
    const owner = key("flow/committer");
    expect((await at(T + 400n, owner)).step).toBe("trading");
    const commit = (claimed: boolean) =>
      conn.set(commitAddress(plan.launch, owner), {
        owner: PROGRAM_IDS.launchpad,
        data: accountBytes("launchpad", "Commit", { version: 1, bump: 255, launch: plan.launch, owner, amount: 5_000_000_000n, claimed, tokenOwner: owner, refundOwner: owner }),
      });
    commit(false);
    const mine = await at(T + 400n, owner);
    expect([mine.step, mine.commit?.amount]).toEqual(["claim", 5_000_000_000n]);
    commit(true);
    expect((await at(T + 400n, owner)).step).toBe("trading");
  });
});

describe("a window that passes without a launch (audit round 3 F1)", () => {
  it("a new opening time replaces the attestation (the record re-used, then a new one); the throwaway payer keeps the rent-exempt floor between publish and attest", async () => {
    const conn = cluster();
    const c = conn.asConnection();
    const ledger = createMemoryLeafLedger();
    const plan = planLaunch(planInput());
    setLaunch(conn, plan);
    publishRecord(conn, plan);
    const fundPayer = async (payer: Keypair, opts: ThrowawayPayerFundingOptions, less = 0n): Promise<bigint> => {
      const f = await throwawayPayerFunding(c, opts);
      conn.set(payer.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(f.lamports - less) });
      return f.lamports;
    };
    const attest = async (p: LaunchPlan, payer: Keypair): Promise<AttestLaunchReady> => {
      const built = await buildPlannedAttestTx(c, p, { identity, ledger, allowLocalnet: true, payer });
      expect(built.status).toBe("ready");
      return built as AttestLaunchReady;
    };

    // The first attestation lands; nobody launches inside its window.
    const p1 = Keypair.generate();
    await fundPayer(p1, { launch: plan.launch, lmsPublicKey: identity.publicKey });
    expect((await sendAttestLaunchTx(c, await attest(plan, p1), { ledger })).status).toBe("attested");
    conn.setClock(plan.window.notAfter + 1n);
    let s = await getLaunchFlowStatus(c, plan.launch, { expectedMessageHash: plan.messageHash });
    expect([s.step, s.canLaunchNow]).toEqual(["window-missed", false]);
    expect(s.summary).toMatch(/^Window passed: sign a new opening time/);

    // A new opening time for the same launch and record: only the attest fee (both accounts exist), nothing to publish.
    const now = await clusterUnixTime(c);
    const plan2 = replanLaunchWindow(plan, { opensAt: now + 600n, nowSecs: now });
    expect([plan2.launch.equals(plan.launch), toHex(plan2.paramsHash), toHex(plan2.metadataHash)]).toEqual([true, toHex(plan.paramsHash), toHex(plan.metadataHash)]);
    expect(plan2.window).toEqual({ notBefore: now + 600n, notAfter: now + 4_200n });
    expect(toHex(plan2.message)).not.toBe(toHex(plan.message));
    const p2 = Keypair.generate();
    expect(await fundPayer(p2, { metadata: plan2.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey })).toBe(5_000n);
    expect((await buildPlannedPublishTx(c, plan2, p2)).status).toBe("already-published");
    const a2 = await attest(plan2, p2);
    expect(a2.warnings.join("\n")).toMatch(/replaces that attestation/);
    expect((await sendAttestLaunchTx(c, a2, { ledger })).status).toBe("attested");
    expect(conn.get(p2.publicKey)?.lamports).toBe(0);
    s = await getLaunchFlowStatus(c, plan.launch, { expectedMessageHash: plan2.messageHash });
    expect([s.step, s.attestedMessageMatches, s.window]).toEqual(["wait-for-window", true, plan2.window]);

    // That window passes too, and the creator changes the description: a new record, published by the next payer.
    conn.setClock(plan2.window.notAfter + 1n);
    const now3 = await clusterUnixTime(c);
    const doc3 = buildMetadataDoc({ name: META.name, symbol: META.symbol, description: "The same token, a new description." });
    const plan3 = replanLaunchWindow(plan2, { opensAt: now3 + 600n, nowSecs: now3, metadata: { ...META, doc: doc3 } });
    expect(toHex(plan3.metadataHash)).not.toBe(toHex(plan.metadataHash));
    const floor = BigInt(128 * 6_960); // the rent-exempt minimum of an empty account at the mocked rent
    const f3 = await throwawayPayerFunding(c, { metadata: plan3.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey });
    expect(f3).toMatchObject({ identityRent: 0n, attestationRent: 0n, publishFee: 5_000n, attestFee: 5_000n, rentFloor: floor });
    expect(f3.lamports).toBe(f3.tokenMetaRent + 10_000n + floor);
    // Without the floor the publish would leave the payer 5,000 lamports, which the runtime refuses: refused before sending.
    const p3 = Keypair.generate();
    await fundPayer(p3, { metadata: plan3.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey }, floor);
    const pub3 = (await buildPlannedPublishTx(c, plan3, p3)) as PublishMetadataReady;
    const sentBefore = conn.sent.length;
    await expect(sendPublishMetadataTx(c, pub3)).rejects.toBeInstanceOf(PublishPayerFundingError);
    expect(conn.sent.length).toBe(sentBefore);
    // With it: published, attested, and the floor goes back to the creator.
    await fundPayer(p3, { metadata: plan3.metadata, launch: plan.launch, lmsPublicKey: identity.publicKey });
    expect((await sendPublishMetadataTx(c, pub3)).publicKey.equals(plan3.tokenMeta)).toBe(true);
    expect(BigInt(conn.get(p3.publicKey)?.lamports ?? 0)).toBe(floor + 5_000n);
    expect((await sendAttestLaunchTx(c, await attest(plan3, p3), { ledger })).status).toBe("attested");
    expect(BigInt(conn.get(p3.publicKey)?.lamports ?? 0)).toBe(floor);
    expect((await buildSweepPayerTx(c, p3, CREATOR))?.lamports).toBe(floor - 5_000n);
    s = await getLaunchFlowStatus(c, plan.launch, { expectedMessageHash: plan3.messageHash });
    expect([s.step, s.attestedMessageMatches, toHex(s.tokenMeta!.metadataHash)]).toEqual(["wait-for-window", true, toHex(plan3.metadataHash)]);
  });

  it("replanLaunchWindow keeps the launch and refuses what planLaunch refuses", () => {
    const plan = planLaunch(planInput());
    expect(() => replanLaunchWindow(plan, { opensAt: NOW + 600n, windowSecs: 59n })).toThrow(/must last/);
    // Opening now is fine (an hour of window); one ending 200 s from now would have less than 60 s left after the 300 s landing margin.
    expect(replanLaunchWindow(plan, { opensAt: NOW, nowSecs: NOW }).window).toEqual({ notBefore: NOW, notAfter: NOW + 3_600n });
    expect(() => replanLaunchWindow(plan, { opensAt: NOW - 3_400n, nowSecs: NOW })).toThrow(/with 60 s of it left/);
    expect(() => replanLaunchWindow({} as LaunchPlan, { opensAt: NOW })).toThrow(TypeError);
    const again = replanLaunchWindow(plan, { opensAt: plan.window.notBefore });
    expect([toHex(again.message), toHex(again.launchSeed)]).toEqual([toHex(plan.message), toHex(plan.launchSeed)]);
  });
});

describe("getLaunchFlowStatus and waitForLaunchWindow at the edges", () => {
  async function attested(): Promise<{ conn: AttestConnection; plan: LaunchPlan }> {
    const conn = cluster();
    const plan = planLaunch(planInput());
    setLaunch(conn, plan);
    publishRecord(conn, plan);
    conn.set(attestationAddress(plan.launch), {
      owner: PROGRAM_IDS.launchpad,
      data: attestationAccountBytes({
        version: 3,
        bump: 255,
        launch: plan.launch,
        pqIdentity: plan.pqIdentity,
        leaf: 7,
        metadataHash: plan.metadataHash,
        messageHash: plan.messageHash,
        slot: 1n,
        notBefore: plan.window.notBefore,
        notAfter: plan.window.notAfter,
        signature: new Uint8Array(2_508),
      }),
    });
    return { conn, plan };
  }

  it("inside the window (inclusive at both ends), then passed: sign a new opening time (audit round 3 F1)", async () => {
    const { conn, plan } = await attested();
    const c = conn.asConnection();
    for (const t of [plan.window.notBefore, plan.window.notAfter]) {
      const s = await getLaunchFlowStatus(c, plan.launch, { nowSecs: t });
      expect([s.step, s.canLaunchNow]).toEqual(["launch", true]);
    }
    const before = await getLaunchFlowStatus(c, plan.launch, { nowSecs: plan.window.notBefore - 1n });
    expect([before.step, before.secondsUntilWindowOpens, before.secondsUntilWindowCloses]).toEqual(["wait-for-window", 1n, 3_601n]);
    const missed = await getLaunchFlowStatus(c, plan.launch, { nowSecs: plan.window.notAfter + 1n });
    expect([missed.step, missed.canLaunchNow]).toEqual(["window-missed", false]);
    expect(missed.summary).toMatch(/^Window passed: sign a new opening time/);
    conn.setClock(plan.window.notAfter + 1n);
    await expect(waitForLaunchWindow(c, plan.launch, { sleep: async () => undefined })).rejects.toThrow(/window-missed/);
    // Another message's attestation is not ours.
    const other = await getLaunchFlowStatus(c, plan.launch, { expectedMessageHash: new Uint8Array(32).fill(3) });
    expect(other.attestedMessageMatches).toBe(false);
    // The attested record is read through the attestation, whatever hash the caller expects.
    const viaAttestation = await getLaunchFlowStatus(c, plan.launch, { expectedMetadataHash: new Uint8Array(32).fill(4) });
    expect([viaAttestation.metadataPublished, viaAttestation.tokenMeta?.publicKey.toBase58()]).toEqual([true, plan.tokenMeta.toBase58()]);
    await expect(getLaunchFlowStatus(c, plan.launch, { expectedMetadataHash: new Uint8Array(31) })).rejects.toThrow(/32 bytes/);
  });

  it("an empty (burn-only) attestation means: attest again; waiting is refused", async () => {
    const conn = cluster();
    const plan = planLaunch(planInput());
    setLaunch(conn, plan);
    conn.set(attestationAddress(plan.launch), {
      owner: PROGRAM_IDS.launchpad,
      data: attestationAccountBytes({
        version: 0,
        bump: 255,
        launch: PublicKey.default,
        pqIdentity: new Uint8Array(32),
        leaf: 0,
        metadataHash: new Uint8Array(32),
        messageHash: new Uint8Array(32),
        slot: 0n,
        notBefore: 0n,
        notAfter: 0n,
        signature: new Uint8Array(0),
      }),
    });
    const s = await getLaunchFlowStatus(conn.asConnection(), plan.launch);
    expect([s.step, s.attestationState, s.window]).toEqual(["attest", "empty", null]);
    expect(s.summary).toMatch(/burned its leaf/);
    await expect(waitForLaunchWindow(conn.asConnection(), plan.launch, { sleep: async () => undefined })).rejects.toThrow(/step "attest"/);
  });

  it("waitForLaunchWindow stops on abort", async () => {
    const { conn, plan } = await attested();
    const ac = new AbortController();
    const p = waitForLaunchWindow(conn.asConnection(), plan.launch, {
      signal: ac.signal,
      sleep: async () => {
        ac.abort(new Error("user left"));
      },
    });
    await expect(p).rejects.toThrow(/user left/);
  });

  it("an empty batch: nothing to execute or claim", async () => {
    const conn = cluster();
    const plan = planLaunch(planInput());
    const T = NOW;
    setLaunch(conn, plan, { status: { kind: "Live" }, launchTs: T, commitEndTs: T + 300n, executeEndTs: T + 900n, guardEndTs: T + 3_600n });
    const c = conn.asConnection();
    expect((await getLaunchFlowStatus(c, plan.launch, { nowSecs: T + 400n })).step).toBe("trading");
    expect((await getLaunchFlowStatus(c, plan.launch, { nowSecs: T + 1_000n })).step).toBe("trading");
    // Expired with commits: claims refund in full.
    setLaunch(conn, plan, { status: { kind: "Live" }, launchTs: T, commitEndTs: T + 300n, executeEndTs: T + 900n, guardEndTs: T + 3_600n, totalCommitted: 1n });
    const s = await getLaunchFlowStatus(c, plan.launch, { nowSecs: T + 1_000n });
    expect([s.step, s.batch]).toEqual(["claim", "expired"]);
    expect(s.summary).toMatch(/refund every commit in full/);
  });
});

describe("the flow's own refusals", () => {
  it("buildPlannedAttestTx: only the plan's identity, and only the plan's configuration on-chain", async () => {
    const conn = cluster();
    const c = conn.asConnection();
    const ledger = createMemoryLeafLedger();
    const plan = planLaunch(planInput());
    const imposter = { ...identity, identityId: new Uint8Array(32).fill(5) } as PqIdentity;
    await expect(buildPlannedAttestTx(c, plan, { identity: imposter, ledger, allowLocalnet: true })).rejects.toThrow(/not the one the plan names/);
    // The creator's wallet (or whoever holds its key) created the launch with other parameters.
    setLaunch(conn, plan, { paramsHash: sha256(utf8("other parameters")) });
    await expect(buildPlannedAttestTx(c, plan, { identity, ledger, allowLocalnet: true })).rejects.toThrow(/params_hash differs/);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    setLaunch(conn, plan);
    // Not before its record is published.
    await expect(buildPlannedAttestTx(c, plan, { identity, ledger, allowLocalnet: true })).rejects.toThrow(/no metadata record is published/);
    publishRecord(conn, plan);
    expect((await buildPlannedAttestTx(c, plan, { identity, ledger, allowLocalnet: true })).status).toBe("ready");
  });

  it("buildPlannedPublishTx: the plan's record, refused once the launch is live", async () => {
    const conn = cluster();
    const c = conn.asConnection();
    const plan = planLaunch(planInput());
    const payer = Keypair.generate();
    await expect(buildPlannedPublishTx(c, plan, payer)).rejects.toThrow(/does not exist/);
    setLaunch(conn, plan);
    const built = await buildPlannedPublishTx(c, plan, payer);
    expect(built.status === "ready" && toHex(built.metadataHash)).toBe(toHex(plan.metadataHash));
    setLaunch(conn, plan, { status: { kind: "Live" } });
    await expect(buildPlannedPublishTx(c, plan, payer)).rejects.toThrow(/WrongLaunchState/);
  });

  it("warns when the creator's wallet pays the attestation (a throwaway payer keeps it out)", async () => {
    const conn = cluster();
    const wallet = Keypair.generate();
    const plan = planLaunch(planInput({ creator: wallet.publicKey }));
    setLaunch(conn, plan);
    publishRecord(conn, plan);
    const paid = await buildPlannedAttestTx(conn.asConnection(), plan, { identity, ledger: createMemoryLeafLedger(), allowLocalnet: true, payer: wallet });
    expect(paid.warnings.join(" ")).toMatch(/creator's wallet pays/);
    const fresh = await buildPlannedAttestTx(conn.asConnection(), plan, { identity, ledger: createMemoryLeafLedger(), allowLocalnet: true });
    expect(fresh.warnings).toEqual([]);
  });

  it("buildPlannedCreateLaunchTx refuses an unopened fee vault (an address nobody can sign for)", async () => {
    const conn = cluster();
    const fee = await prepareFeeVault(conn.asConnection(), { master: MASTER, cluster: "localnet", payer: CREATOR, allowLocalnet: true });
    const plan = planLaunch(planInput({ feeVault: fee.vault }));
    await expect(buildPlannedCreateLaunchTx(conn.asConnection(), plan)).rejects.toThrow(/unopened vault/);
  });
});
