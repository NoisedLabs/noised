/**
 * The simulated chain's launch flow (src/lib/mock/launchFlow.ts) against the
 * SDK's (the live backend passes the SDK's straight through):
 *   - every refusal, warning and status sentence is the SDK's own, word for
 *     word (checked against the SDK's built code), so the demo says what the
 *     live app will;
 *   - the transactions are the SDK's bytes: the publish and attest sizes are
 *     the SDK's formulas, the record written is `tokenMetaAccountData`, the
 *     attestation holds the real 189-byte message and an LMS signature that
 *     verifies at its leaf;
 *   - the throwaway payer's funding is the SDK's arithmetic (the SDK's own
 *     function on a connection that serves the same rent);
 *   - the program's rules: a record only while the launch is configured, an
 *     attestation only with the record, a window with at least 60 s left at
 *     landing and a free slot (audit round 3 F1), every landing burns its leaf.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as sdk from "@noisedlabs/sdk";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from "vitest";

import { backend as live, LAUNCH_ACCOUNTS_RENT_BYTES } from "../src/lib/backend/live";
import { backend as mock } from "../src/lib/backend/mock";
import { seedState } from "../src/lib/mock/fixtures";
import { identityBitmapForTests, mockRent } from "../src/lib/mock/launchFlow";
import { replaceStateForTests, solBalance, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");

// ------------------------------------------------------------ the words ---

function sdkCode(): string {
  const dist = fileURLToPath(new URL("../node_modules/@noisedlabs/sdk/dist", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith(".js") ? [p] : [];
    });
  return walk(dist)
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

/** A literal with its `${...}` holes made uniform, so the mock's and the SDK's expressions may differ. */
const holes = (t: string): string => t.replace(/\$\{[^}]*\}/g, "${}");

/** The sentences the mock module throws, pushes as warnings or returns as summaries and reasons. */
function mockSentences(): string[] {
  const src = readFileSync(new URL("../src/lib/mock/launchFlow.ts", import.meta.url), "utf8");
  const out: string[] = [];
  const lit = String.raw`([\x60"])((?:\\.|(?!\1)[\s\S])*?)\1`;
  for (const re of [
    new RegExp(String.raw`throw new (?:Error|TypeError|RangeError|PublishPayerFundingError|AttestPayerFundingError|ClusterMismatchError)\(\s*` + lit, "g"),
    new RegExp(String.raw`warnings\.push\(\s*` + lit, "g"),
    new RegExp(String.raw`done\(\s*"[a-z-]+",\s*` + lit, "g"),
    new RegExp(String.raw`\? "the launch is not attested[^"]*"`, "g"),
  ]) {
    for (const m of src.matchAll(re)) out.push(m[2] ?? m[0]);
  }
  // The reasons a landing only burned its leaf, and the summaries of a burn.
  const reasons = /const REASON_TEXT[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
  for (const m of reasons.matchAll(/:\s*"([^"]+)"/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/\? `(leaf \$\{leaf\} is used on-chain[^`]*)`/g)) out.push(m[1] ?? "");
  for (const m of src.matchAll(/: `(leaf \$\{leaf\} was burned without attesting[^`]*)`/g)) out.push(m[1] ?? "");
  return out.filter((t) => t.length >= 25);
}

describe("the simulated launch flow says what the SDK says", () => {
  const code = holes(sdkCode());
  const sentences = mockSentences();

  it("finds the sentences to compare", () => {
    expect(sentences.length).toBeGreaterThan(45);
  });

  for (const t of sentences) {
    it(`"${t.slice(0, 70)}…" is the SDK's`, () => {
      expect(code.includes(holes(t)), t).toBe(true);
    });
  }
});

// -------------------------------------------------------- bytes and rules ---

let identity: sdk.PqIdentity;
beforeAll(async () => {
  identity = await sdk.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 0);
}, 60_000);

let creator: PublicKey;
let ledger: sdk.LeafLedger;
const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  replaceStateForTests(seedState());
  creator = Keypair.generate().publicKey;
  phx.fundDemoWallet(creator);
  ledger = sdk.leafLedger.createMemoryLeafLedger();
});
afterEach(() => vi.useRealTimers());

async function land(tx: sdk.AnyTransaction): Promise<void> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(sim.error ?? "?");
  await phx.sendAndConfirm(conn, tx);
}

const METADATA = { name: "Parity", symbol: "PAR", doc: sdk.buildMetadataDoc({ name: "Parity", symbol: "PAR", description: "Same bytes as the SDK." }) };

function plan(opensAt = now() + 120n): sdk.LaunchPlan {
  return sdk.planLaunch({ creator, identity, recipients: [{ wallet: creator, bps: 10_000 }], metadata: METADATA, opensAt });
}

async function created(p = plan()): Promise<sdk.LaunchPlan> {
  await land((await phx.buildPlannedCreateLaunchTx(conn, p)).tx);
  return p;
}

async function funded(payer: Keypair, lamports = 100_000_000n): Promise<void> {
  await land((await phx.buildFundThrowawayPayerTx(conn, creator, payer.publicKey, { lamports })).tx);
}

/** A connection that serves only rent at the simulated chain's rate and no account: enough for the SDK's arithmetic. */
const rentOnly = {
  getMinimumBalanceForRentExemption: async (size: number) => Number(mockRent(size)),
  getAccountInfo: async (): Promise<AccountInfo<Buffer> | null> => null,
  getMultipleAccountsInfo: async (keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> => keys.map(() => null),
} as unknown as Connection;

describe("the simulated launch flow's bytes and rules", () => {
  it("funds the throwaway payer exactly as the SDK computes it", async () => {
    const p = plan();
    for (const opts of [{ metadata: METADATA }, { metadata: METADATA, launch: p.launch, lmsPublicKey: identity.keyPair.publicKey }, {}] as const) {
      expect(await phx.throwawayPayerFunding(conn, opts)).toEqual(await sdk.throwawayPayerFunding(rentOnly, opts));
    }
  });

  it("publishes the SDK's v1 transaction and writes exactly the SDK's record bytes, once, only while configured", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer);
    const built = await phx.buildPlannedPublishTx(conn, p, payer);
    if (built.status !== "ready") throw new Error("not ready");
    expect(built.sizeBytes).toBe(sdk.publishTransactionSize(p.metadata));
    expect(sdk.decodeV1Transaction(built.tx).instructions.at(-1)?.data).toEqual(sdk.publishMetadataData(p.metadata));
    const record = await phx.sendPublishMetadataTx(conn, built);
    expect(state().tokenMetas[p.tokenMeta.toBase58()]).toEqual(sdk.tokenMetaAccountData(p.launch, p.metadata));
    expect(record.publicKey.equals(p.tokenMeta)).toBe(true);
    // Idempotent: a repeat is "already-published".
    expect((await phx.buildPlannedPublishTx(conn, p, payer)).status).toBe("already-published");
    expect(mockRent(sdk.tokenMetaSpace(p.metadata))).toBe(BigInt(128 + sdk.tokenMetaSpace(p.metadata)) * 6_960n);
  });

  it("refuses an underfunded payer before sending, like the SDK", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer, 1_000_000n);
    const built = await phx.buildPlannedPublishTx(conn, p, payer);
    if (built.status !== "ready") throw new Error("not ready");
    await expect(phx.sendPublishMetadataTx(conn, built)).rejects.toBeInstanceOf(sdk.PublishPayerFundingError);
    expect(state().tokenMetas[p.tokenMeta.toBase58()]).toBeUndefined();
  });

  it("signs only a published record, with the SDK's 3,005-byte transaction, and attests with a signature that verifies", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer);
    await expect(phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer })).rejects.toThrow(/^refusing to sign: no metadata record is published at/);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status !== "ready") throw new Error("not ready");
    await phx.sendPublishMetadataTx(conn, pub);
    const built = await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer });
    if (built.status !== "ready") throw new Error("not ready");
    expect(built.sizeBytes).toBe(sdk.attestTransactionSize());
    expect(built.sizeBytes).toBe(3_005);
    expect(built.message).toEqual(p.message);
    expect(sdk.lms.lmsVerify(identity.keyPair.publicKey, p.message, built.lmsSignature)).toBe(built.leaf);
    const outcome = await phx.sendAttestLaunchTx(conn, built, { ledger });
    expect(outcome.status).toBe("attested");
    const a = await phx.fetchAttestation(conn, p.launch);
    expect(a?.messageHash).toEqual(p.messageHash);
    expect(a?.signature).toEqual(built.lmsSignature);
    expect(sdk.pqIdentity.leafUsed(identityBitmapForTests(identity.identityId), built.leaf)).toBe(true);
    expect((await ledger.get(identity.identityId, built.leaf))?.status).toBe("landed");
    // The same message again: nothing to sign.
    expect((await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer })).status).toBe("already-attested");
    // Verified from the chain, with the record it signed.
    const v = await phx.verifyAttestation(conn, p.launch);
    expect(v.verified).toBe(true);
    expect(v.tokenMeta?.publicKey.equals(p.tokenMeta)).toBe(true);
  }, 60_000);

  it("burns the leaf of a landing with less than 60 s of its window left, and reports why (audit round 3 F1)", async () => {
    const p = await created(plan(now() + 120n));
    const payer = Keypair.generate();
    await funded(payer);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status === "ready") await phx.sendPublishMetadataTx(conn, pub);
    const built = await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer });
    if (built.status !== "ready") throw new Error("not ready");
    // It lands 59 s before the end of its window.
    vi.setSystemTime(Number(p.window.notAfter - 59n) * 1_000);
    const outcome = await phx.sendAttestLaunchTx(conn, built, { ledger });
    expect(outcome).toMatchObject({ status: "burned", reasons: ["invalid-window"] });
    const a = await phx.fetchAttestation(conn, p.launch);
    expect(a?.attested).toBe(false);
    expect(a?.version).toBe(0);
    expect(sdk.pqIdentity.leafUsed(identityBitmapForTests(identity.identityId), built.leaf)).toBe(true);
    // At 60 s left the SDK's rule says the window is usable; 59 s, not.
    expect(sdk.launchWindowIsValid(p.window.notAfter - 60n, p.window.notBefore, p.window.notAfter)).toBe(true);
    expect(sdk.launchWindowIsValid(p.window.notAfter - 59n, p.window.notBefore, p.window.notAfter)).toBe(false);
  }, 60_000);

  it("refuses to replace an attestation whose window has not passed, and replaces one that passed unused (audit round 3 F1)", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status === "ready") await phx.sendPublishMetadataTx(conn, pub);
    const first = await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer });
    if (first.status !== "ready") throw new Error("not ready");
    expect((await phx.sendAttestLaunchTx(conn, first, { ledger })).status).toBe("attested");
    const p2 = sdk.replanLaunchWindow(p, { opensAt: p.window.notBefore + 600n, nowSecs: now() });
    await expect(phx.buildPlannedAttestTx(conn, p2, { identity, ledger, payer })).rejects.toThrow(/^refusing to sign: this launch is already attested by another message/);
    // The window passes unused.
    vi.setSystemTime(Number(p.window.notAfter + 1n) * 1_000);
    expect((await phx.getLaunchFlowStatus(conn, p.launch)).summary).toMatch(/^Window passed: sign a new opening time/);
    const p3 = sdk.replanLaunchWindow(p, { opensAt: now() + 120n, nowSecs: now() });
    const second = await phx.buildPlannedAttestTx(conn, p3, { identity, ledger, payer });
    if (second.status !== "ready") throw new Error("not ready");
    expect(second.warnings.some((w) => /replaces that attestation with the new opening time/.test(w))).toBe(true);
    expect(second.leaf).not.toBe(first.leaf);
    expect((await phx.sendAttestLaunchTx(conn, second, { ledger })).status).toBe("attested");
    const a = await phx.fetchAttestation(conn, p.launch);
    // Every field is the new message's.
    expect(a).toMatchObject({ leaf: second.leaf, notBefore: p3.window.notBefore, notAfter: p3.window.notAfter, messageHash: p3.messageHash, signature: second.lmsSignature });
  }, 60_000);

  it("a second signature that lands while another message's window has not passed only burns its leaf", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer, 200_000_000n);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status === "ready") await phx.sendPublishMetadataTx(conn, pub);
    // Both signed before either landed (two tabs, or an old copy): each builder saw a free slot.
    const a = await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer });
    const p2 = sdk.replanLaunchWindow(p, { opensAt: p.window.notBefore + 300n, nowSecs: now() });
    const b = await phx.buildPlannedAttestTx(conn, p2, { identity, ledger, payer });
    if (a.status !== "ready" || b.status !== "ready") throw new Error("not ready");
    expect((await phx.sendAttestLaunchTx(conn, a, { ledger })).status).toBe("attested");
    expect(await phx.sendAttestLaunchTx(conn, b, { ledger })).toMatchObject({ status: "burned", reasons: ["already-attested"] });
    const att = await phx.fetchAttestation(conn, p.launch);
    expect(att?.messageHash).toEqual(p.messageHash);
    expect(sdk.pqIdentity.usedLeaves(identityBitmapForTests(identity.identityId)).sort()).toEqual([a.leaf, b.leaf].sort());
  }, 60_000);

  it("publishes only while the launch is configured (WrongLaunchState)", async () => {
    const p = await created();
    const payer = Keypair.generate();
    await funded(payer);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status === "ready") await phx.sendPublishMetadataTx(conn, pub);
    const built = await phx.buildPlannedAttestTx(conn, p, { identity, ledger, payer });
    if (built.status !== "ready") throw new Error("not ready");
    await phx.sendAttestLaunchTx(conn, built, { ledger });
    vi.setSystemTime(Number(p.window.notBefore) * 1_000);
    await land((await phx.buildLaunchTx(conn, creator, p.launch, Keypair.generate())).tx);
    const other = sdk.planLaunch({ creator, identity, recipients: [{ wallet: creator, bps: 10_000 }], metadata: { name: "Late", symbol: "LATE" }, opensAt: now() + 120n, launchSeed: p.launchSeed });
    await expect(phx.buildPlannedPublishTx(conn, other, payer)).rejects.toThrow(/^refusing to publish: the launch is already live \(WrongLaunchState\)/);
  }, 60_000);

  it("stops signing new leaves for a launch after two burn-only landings (AttestRetryLimitError, with the reasons)", async () => {
    const p = await created(plan(now() + 120n));
    const payer = Keypair.generate();
    await funded(payer, 200_000_000n);
    const pub = await phx.buildPlannedPublishTx(conn, p, payer);
    if (pub.status === "ready") await phx.sendPublishMetadataTx(conn, pub);
    let current = p;
    for (let i = 0; i < 2; i++) {
      const built = await phx.buildPlannedAttestTx(conn, current, { identity, ledger, payer });
      if (built.status !== "ready") throw new Error("not ready");
      vi.setSystemTime(Number(current.window.notAfter - 30n) * 1_000);
      expect((await phx.sendAttestLaunchTx(conn, built, { ledger })).status).toBe("burned");
      current = sdk.replanLaunchWindow(p, { opensAt: now() + 120n, nowSecs: now() });
    }
    const refused = await phx.buildPlannedAttestTx(conn, current, { identity, ledger, payer }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(sdk.AttestRetryLimitError);
    // Afterwards only the window's length can be judged (the landing time is not in the ledger), as in the SDK.
    expect((refused as sdk.AttestRetryLimitError).reasons).toEqual([]);
    expect((refused as sdk.AttestRetryLimitError).landings.map((l) => l.detail)).toEqual([
      expect.stringMatching(/the cause could not be inferred/),
      expect.stringMatching(/the cause could not be inferred/),
    ]);
    expect(sdk.pqIdentity.usedLeaves(identityBitmapForTests(identity.identityId))).toHaveLength(2);
  }, 60_000);

  it("sweeps everything above the fee back to the creator, and nothing when nothing is left", async () => {
    const payer = Keypair.generate();
    await funded(payer, 3_000_000n);
    const before = solBalance(state(), creator);
    const sweep = await phx.buildSweepPayerTx(conn, payer, creator);
    expect(sweep?.lamports).toBe(3_000_000n - 5_000n);
    if (sweep === null) throw new Error("no sweep");
    await land(sweep.tx);
    expect(solBalance(state(), payer.publicKey)).toBe(0n);
    expect(solBalance(state(), creator)).toBe(before + 3_000_000n - 5_000n);
    expect(await phx.buildSweepPayerTx(conn, payer, creator)).toBeNull();
  });
});

describe("what opening a launch costs its payer", () => {
  it("live: the mint at the size the record gives it, the other accounts' measured rent and two signatures, rents from the cluster", async () => {
    const asked: number[] = [];
    const rentConn = { getMinimumBalanceForRentExemption: async (size: number) => (asked.push(size), (128 + size) * 5_080) } as unknown as Connection;
    const lamports = await live.launchPayerLamports(rentConn, METADATA);
    expect(asked.sort((a, b) => a - b)).toEqual([LAUNCH_ACCOUNTS_RENT_BYTES - 128, sdk.launchedMintSpace(METADATA)].sort((a, b) => a - b));
    expect(lamports).toBe(BigInt((128 + sdk.launchedMintSpace(METADATA)) * 5_080 + LAUNCH_ACCOUNTS_RENT_BYTES * 5_080 + 10_000));
    // The measured launches (metadata fix stage, LiteSVM): rent(mint) + 2,378 bytes of other accounts' rent.
    expect(LAUNCH_ACCOUNTS_RENT_BYTES).toBeGreaterThanOrEqual(2_378);
  });

  it("mock: what the simulated launch takes from its payer, so a payer funded for it can open it", async () => {
    expect(await phx.launchPayerLamports(conn, METADATA)).toBe(34_820_000n + 10_000n);
  });
});
