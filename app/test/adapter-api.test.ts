/**
 * The adapter (src/lib/noised.ts) exposes the API of docs/SPEC.md §4.1 as
 * implemented by @noisedlabs/sdk:
 *   - every SPEC name exists and can be called with the SPEC signature (the
 *     SDK may add optional parameters and extra result fields, never remove
 *     or change one); the expectTypeOf assertions are checked by `tsc -b`;
 *   - pure functions and constants ARE the SDK's (same objects);
 *   - in a default build the chain functions ARE the live backend's, which
 *     passes the SDK's own builders and reads straight through.
 */
import * as sdk from "@noisedlabs/sdk";
import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, expectTypeOf, it } from "vitest";

import { backend as live } from "../src/lib/backend/live";
import { backend as mock } from "../src/lib/backend/mock";
import type { ChainBackend } from "../src/lib/backend/types";
import * as phx from "../src/lib/noised";

type Phase = "configured" | "commit" | "execute" | "guarded" | "open" | "graduated";

describe("SPEC §4.1 constants", () => {
  it("exports PROGRAM_IDS, WSOL_MINT and CLUSTERS", () => {
    expectTypeOf(phx.PROGRAM_IDS).toEqualTypeOf<{
      readonly launchpad: PublicKey;
      readonly hook: PublicKey;
      readonly vault: PublicKey;
      readonly shield: PublicKey;
      readonly dbc: PublicKey;
      readonly dammV2: PublicKey;
      readonly autopilot: PublicKey;
    }>();
    expectTypeOf(phx.WSOL_MINT).toEqualTypeOf<PublicKey>();
    expectTypeOf<keyof typeof phx.CLUSTERS>().toEqualTypeOf<phx.Cluster>();
    expectTypeOf<phx.Cluster>().toEqualTypeOf<"mainnet" | "devnet" | "localnet">();
    expect(Object.keys(phx.PROGRAM_IDS).sort()).toEqual(["autopilot", "dammV2", "dbc", "hook", "launchpad", "shield", "vault"]);
    // SDK 0.6.0: the autopilot program (programs/noised-autopilot declare_id!).
    expect(phx.PROGRAM_IDS.autopilot.toBase58()).toBe("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx");
    expect(phx.PROGRAM_IDS.launchpad.toBase58()).toBe("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc");
    expect(phx.PROGRAM_IDS.vault.toBase58()).toBe("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");
    expect(phx.CLUSTERS.mainnet.id).toBe(0);
    expect(phx.CLUSTERS.devnet.id).toBe(1);
    expect(phx.CLUSTERS.localnet.id).toBe(2);
  });
});

describe("SPEC §4.1 launch", () => {
  it("has the launch types and pure helpers", () => {
    // SDK 0.4.0: the name and symbol live in the token's on-chain metadata record, not in the parameters.
    expectTypeOf<phx.LaunchParamsInput>().toEqualTypeOf<phx.LaunchParams>();
    expectTypeOf(phx.validateTokenMeta).toMatchTypeOf<(m: { name: string; symbol: string }) => { ok: boolean; errors: string[] }>();
    // PQ v2: every launch names the creator's post-quantum identity (32 bytes).
    expectTypeOf<phx.LaunchParams["pqIdentity"]>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<keyof typeof phx.PRESETS>().toEqualTypeOf<"fair" | "community" | "turbo">();
    expectTypeOf(phx.validateLaunchParams).toMatchTypeOf<(p: phx.LaunchParamsInput) => phx.ValidationResult>();
    expectTypeOf<phx.ValidationResult>().toEqualTypeOf<{ ok: boolean; errors: string[] }>();
    expectTypeOf(phx.launchPdas).toEqualTypeOf<(creator: PublicKey, launchSeed: Uint8Array) => phx.LaunchPdas>();
    expectTypeOf(phx.launchPdasFromLaunch).toEqualTypeOf<(launch: PublicKey) => phx.LaunchPdas>();
    // Every "now" is a bigint of unix seconds (a number is refused at run time).
    expectTypeOf(phx.launchPhase).toMatchTypeOf<(launch: phx.LaunchAccount, nowSecs: bigint) => Phase>();
    expect(() => phx.launchPhase({ status: "configured", commitEndTs: 0n, executeEndTs: 0n, guardEndTs: 0n }, 1 as unknown as bigint)).toThrow(TypeError);
    // commit never refuses on the total cap: the expected pro-rata fill is shown instead.
    expectTypeOf(phx.expectedBatchFill).toMatchTypeOf<(launch: phx.LaunchAccount, extraCommit?: bigint, existingCommit?: bigint) => phx.BatchFill>();
    expectTypeOf<phx.BatchFill>().toMatchTypeOf<{ totalCommitted: bigint; cap: bigint; fill: bigint; oversubscribed: boolean; fillBps: number; exact: boolean }>();
  });

  it("has the launch builders and reads", () => {
    expectTypeOf(phx.buildCreateLaunchTx).toMatchTypeOf<
      (conn: Connection, creator: PublicKey, params: phx.LaunchParamsInput) => Promise<{ tx: Transaction; launch: PublicKey; launchSeed: Uint8Array }>
    >();
    // `launch` is permissionless inside the attested window: any payer, no creator signature, and no metadata
    // argument (the mint's name and symbol come from the record the attestation names).
    expectTypeOf(phx.buildLaunchTx).toMatchTypeOf<
      (conn: Connection, payer: PublicKey, launch: PublicKey, baseMint: Keypair, opts?: { nowSecs?: bigint | undefined }) => Promise<{ tx: Transaction }>
    >();
    expectTypeOf(phx.fetchAttestation).toEqualTypeOf<(conn: Connection, launch: PublicKey) => Promise<phx.AttestationAccount | null>>();
    // A commit may pay its tokens (and refund) into PQ vaults; everything committed for one vault is held to the per-wallet cap.
    expectTypeOf(phx.buildCommitTx).toEqualTypeOf<(conn: Connection, owner: PublicKey, launch: PublicKey, lamports: bigint, opts?: phx.CommitOptions) => Promise<Transaction>>();
    expectTypeOf<phx.CommitOptions>().toMatchTypeOf<{ tokenOwner?: PublicKey | undefined; refundOwner?: PublicKey | undefined }>();
    expectTypeOf(phx.fetchPayoutVault).toEqualTypeOf<(conn: Connection, launch: PublicKey, vault: PublicKey) => Promise<phx.PayoutVaultAccount | null>>();
    expectTypeOf(phx.buildExecuteBatchTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, launch: PublicKey, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>>();
    expectTypeOf(phx.buildClaimTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, launch: PublicKey, owner: PublicKey, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>>();
    expectTypeOf(phx.buildClaimFeesTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, launch: PublicKey, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>>();
    // One transaction per LP position with fees.
    expectTypeOf(phx.buildClaimLpFeesTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, launch: PublicKey, opts?: phx.ComputeBudgetOptions) => Promise<Transaction[]>>();
    expectTypeOf(phx.buildDistributeTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, launch: PublicKey, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>>();
    expectTypeOf(phx.fetchLaunch).toEqualTypeOf<(conn: Connection, launch: PublicKey) => Promise<phx.LaunchAccount | null>>();
    expectTypeOf(phx.fetchLaunchByMint).toEqualTypeOf<(conn: Connection, mint: PublicKey) => Promise<phx.LaunchAccount | null>>();
    expectTypeOf(phx.listLaunches).toEqualTypeOf<(conn: Connection) => Promise<phx.LaunchAccount[]>>();
    expectTypeOf(phx.fetchCommit).toEqualTypeOf<(conn: Connection, launch: PublicKey, owner: PublicKey) => Promise<phx.CommitAccount | null>>();
    // A buy can pay straight into a PQ vault (`recipient`); `warnings` are cautions about that recipient.
    expectTypeOf(phx.buildSwapTx).toEqualTypeOf<
      (
        conn: Connection,
        user: PublicKey,
        mint: PublicKey,
        side: phx.SwapSide,
        amountIn: bigint,
        slippageBps: number,
        opts?: phx.SwapOptions,
      ) => Promise<{ tx: Transaction; quote: phx.SwapQuote; warnings: string[] }>
    >();
    expectTypeOf<phx.SwapSide>().toEqualTypeOf<"buy" | "sell">();
  });

  it("LaunchAccount is the decoded Launch plus publicKey and an optional market snapshot", () => {
    expectTypeOf<phx.LaunchAccount>().toMatchTypeOf<phx.LaunchState & { publicKey: PublicKey }>();
    expectTypeOf<phx.LaunchAccount["market"]>().toEqualTypeOf<phx.MarketSnapshot | undefined>();
    expectTypeOf<phx.MarketSnapshot>().toMatchTypeOf<{
      name: string;
      symbol: string;
      uri: string;
      initialSupply: bigint;
      quoteReserve: bigint;
      sqrtPrice: bigint;
      curveComplete: boolean;
      migrated: boolean;
    }>();
    // u64/u128/i64 are bigint; PublicKey from web3.js v1.
    expectTypeOf<phx.LaunchState["totalCommitted"]>().toEqualTypeOf<bigint>();
    expectTypeOf<phx.LaunchState["launchTs"]>().toEqualTypeOf<bigint>();
    expectTypeOf<phx.LaunchParams["sqrtStartPrice"]>().toEqualTypeOf<bigint>();
    expectTypeOf<phx.LaunchState["baseMint"]>().toEqualTypeOf<PublicKey>();
  });
});

describe("SPEC §4.1 verify", () => {
  it("verifyLaunch returns the structured report", () => {
    expectTypeOf(phx.verifyLaunch).toMatchTypeOf<(conn: Connection, mint: PublicKey) => Promise<phx.VerificationReport>>();
    expectTypeOf<phx.VerificationReport["overall"]>().toEqualTypeOf<"pass" | "warn" | "fail">();
    expectTypeOf<phx.VerificationReport["mint"]>().toEqualTypeOf<PublicKey>();
    expectTypeOf<phx.VerificationReport["checks"][number]>().toEqualTypeOf<{ id: string; label: string; status: phx.CheckStatus; detail: string }>();
    expectTypeOf<phx.VerificationReport["trustedParties"][number]>().toMatchTypeOf<{ name: string; address: PublicKey | null; kind: string; note: string }>();
    expectTypeOf<phx.VerificationReport["certificate"]>().toEqualTypeOf<phx.CertificateAccount | null>();
    // The launch's post-quantum origin, re-verified (shown as proof only when `verified`).
    expectTypeOf<phx.VerificationReport["pqOrigin"]>().toEqualTypeOf<phx.PqOrigin | null>();
    // The token's on-chain metadata record and its document (shown only when `verified`).
    expectTypeOf<phx.VerificationReport["metadata"]>().toEqualTypeOf<phx.VerifiedMetadata | null>();
    expectTypeOf<phx.PqOrigin>().toMatchTypeOf<{ metadataHash: Uint8Array; tokenMeta: PublicKey }>();
  });
});

describe("SPEC §4.1 pq (vault v4)", () => {
  it("re-exports lmots and the key, address and message helpers, but no raw one-time signer", () => {
    expect(typeof phx.lmots.verify).toBe("function");
    // A vault key signs only through the backend's prepareWithdrawal, behind the vault-key ledger.
    expect("sign" in phx.lmots).toBe(false);
    expect("signDeterministic" in phx.lmots).toBe(false);
    expect("signWithdrawal" in phx).toBe(false);
    expectTypeOf(phx.generateRecoveryPhrase).toEqualTypeOf<() => string>();
    expectTypeOf(phx.masterFromPhrase).toEqualTypeOf<(phrase: string) => Uint8Array>();
    expectTypeOf(phx.deriveVaultKey).toEqualTypeOf<(master: Uint8Array, cluster: phx.Cluster, mint: PublicKey, account: number, sequence: number) => phx.VaultKeyMaterial>();
    expectTypeOf<phx.VaultKeyMaterial>().toEqualTypeOf<{ skSeed: Uint8Array; pk: phx.LmotsPublicKey; keyId: Uint8Array }>();
    expectTypeOf<phx.LmotsPublicKey>().toEqualTypeOf<{ readonly id: Uint8Array; readonly q: number; readonly k: Uint8Array }>();
    expectTypeOf(phx.vaultAddress).toEqualTypeOf<(mint: PublicKey, genesisKeyId: Uint8Array) => PublicKey>();
    expectTypeOf(phx.payoutAddress).toEqualTypeOf<(vault: PublicKey, sequence: bigint) => PublicKey>();
    expectTypeOf(phx.withdrawMessage).toEqualTypeOf<
      (vault: PublicKey, mint: PublicKey, sequence: bigint, destinationOwner: PublicKey, maxAmount: bigint, nextKeyId: Uint8Array) => Uint8Array
    >();
    expectTypeOf(phx.prepareWithdrawal).toEqualTypeOf<
      (
        conn: Connection,
        master: Uint8Array,
        cluster: phx.Cluster,
        mint: PublicKey,
        account: number,
        request: phx.WithdrawalRequest,
        opts: sdk.PrepareWithdrawalOptions,
      ) => Promise<phx.PreparedWithdrawal>
    >();
    // The recipient confirmation: the check itself and one acknowledgment per kind of caution.
    expectTypeOf<phx.RecipientConfirmation["acknowledged"]>().toEqualTypeOf<{
      readonly recipientWarnings?: boolean | undefined;
      readonly mintWarnings?: boolean | undefined;
      readonly offCurveConfirmation?: boolean | undefined;
    }>();
    expectTypeOf(phx.createVaultKeyLedger).toMatchTypeOf<(store: phx.LeafLedgerStore, opts?: { lock?: phx.LedgerLock | undefined }) => phx.VaultKeyLedger>();
  });

  it("has the vault reads, the recipient check and the pending-withdrawal search", () => {
    expectTypeOf(phx.fetchVault).toEqualTypeOf<(conn: Connection, vault: PublicKey) => Promise<phx.VaultInfo | null>>();
    expectTypeOf<phx.VaultInfo>().toMatchTypeOf<{
      mint: PublicKey;
      genesisKeyId: Uint8Array;
      sequence: bigint;
      keyId: Uint8Array;
      key: phx.LmotsPublicKey;
      reserved: bigint;
      balance: bigint;
      available: bigint;
      tokenAccount: PublicKey;
    }>();
    // Refusals; recipient warnings, token warnings and the off-curve confirmation, each confirmed on its own; the connected wallet is optional.
    expectTypeOf(phx.checkRecipient).toMatchTypeOf<
      (
        conn: Connection,
        destinationOwner: PublicKey,
        mint: PublicKey,
        vault: PublicKey,
        opts?: { wallet?: PublicKey | null },
      ) => Promise<{
        ok: boolean;
        refusals: string[];
        recipientWarnings: string[];
        mintWarnings: string[];
        offCurveConfirmation: string | null;
        destinationOwner: PublicKey;
        mint: PublicKey;
        vault: PublicKey;
        wallet: PublicKey | null;
      }>
    >();
    // An incomplete search is continued (`continueFrom`), never overridden.
    expectTypeOf(phx.findPendingWithdrawal).toMatchTypeOf<(conn: Connection, vault: PublicKey, opts?: phx.PendingWithdrawalSearchOptions) => Promise<phx.PendingWithdrawalSearch>>();
    expectTypeOf<phx.PendingWithdrawalSearch>().toMatchTypeOf<{
      pending: phx.PendingWithdrawal | null;
      all: phx.PendingWithdrawal[];
      complete: boolean;
      incompleteReason: "limit" | "unreadable" | "history" | null;
      continuation: phx.PendingWithdrawalContinuation | null;
      note: string | null;
    }>();
    expectTypeOf<phx.PendingWithdrawalSearchOptions>().toEqualTypeOf<{
      maxTransactions?: number | undefined;
      maxSignaturePages?: number | undefined;
      continueFrom?: phx.PendingWithdrawalContinuation | null | undefined;
    }>();
    expectTypeOf(phx.listPayouts).toEqualTypeOf<(conn: Connection, vault: PublicKey) => Promise<phx.PayoutListing>>();
    expectTypeOf(phx.fetchPayout).toEqualTypeOf<(conn: Connection, vault: PublicKey, sequence: bigint) => Promise<phx.PayoutAccount | null>>();
    expectTypeOf(phx.checkVaultMint).toMatchTypeOf<(conn: Connection, mint: PublicKey) => Promise<{ eligible: boolean; refusals: string[]; warnings: string[] }>>();
    expectTypeOf(phx.scanVaults).toEqualTypeOf<(conn: Connection, master: Uint8Array, cluster: phx.Cluster, mint: PublicKey, maxAccount: number) => Promise<phx.ScannedVault[]>>();
    expectTypeOf<phx.ScannedVault>().toMatchTypeOf<{
      account: number;
      vault: PublicKey;
      genesisKeyId: Uint8Array;
      sequence: bigint;
      balance: bigint;
      reserved: bigint;
      pendingPayouts: phx.PayoutAccount[];
    }>();
  });

  it("has the vault builders: open, deposit, withdraw (v1), release, release_to", () => {
    expectTypeOf(phx.buildOpenVaultTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, mint: PublicKey, pk: phx.LmotsPublicKey) => Promise<Transaction>>();
    expectTypeOf(phx.buildDepositTx).toEqualTypeOf<(conn: Connection, owner: PublicKey, mint: PublicKey, vault: PublicKey, amount: bigint) => Promise<Transaction>>();
    expectTypeOf(phx.buildWithdrawTx).toMatchTypeOf<(conn: Connection, payer: Keypair, args: phx.WithdrawTxArgs) => Promise<{ tx: Uint8Array; payout: PublicKey }>>();
    expectTypeOf<phx.WithdrawTxArgs>().toEqualTypeOf<{
      mint: PublicKey;
      vault: PublicKey;
      sequence: bigint;
      destinationOwner: PublicKey;
      maxAmount: bigint;
      signature: Uint8Array;
      nextKey: phx.LmotsPublicKey;
      nextKeyId: Uint8Array;
      includeRelease?: boolean;
    }>();
    expectTypeOf(phx.buildReleaseTx).toEqualTypeOf<
      (conn: Connection, payer: PublicKey, args: { vault: PublicKey; mint: PublicKey; sequence: bigint }, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>
    >();
    expectTypeOf(phx.buildReleaseToTx).toEqualTypeOf<
      (conn: Connection, recipient: PublicKey, args: { vault: PublicKey; mint: PublicKey; sequence: bigint; destination: PublicKey }, opts?: phx.ComputeBudgetOptions) => Promise<Transaction>
    >();
    // Audit round 3, F3: the next SDK release's `checkFeeRecipients` (without its optional pre-fetched accounts).
    expectTypeOf(phx.checkFeeRecipients).toEqualTypeOf<(conn: Connection, recipients: readonly Pick<phx.FeeRecipient, "wallet">[]) => Promise<phx.FeeRecipientsCheck>>();
  });

  it("buildSweepTx and the v3 successor types are gone", () => {
    expect("buildSweepTx" in phx).toBe(false);
    expect("buildSweepTx" in sdk).toBe(false);
    expect("vaultState" in phx).toBe(false);
  });
});

describe("SPEC §4.1 shield", () => {
  it("has the shield addresses, read and builders", () => {
    expectTypeOf(phx.shieldAddresses).toMatchTypeOf<(baseMint: PublicKey) => phx.ShieldAddresses>();
    expectTypeOf<phx.ShieldAddresses>().toEqualTypeOf<{ shield: PublicKey; authority: PublicKey; zMint: PublicKey; escrow: PublicKey }>();
    expectTypeOf(phx.fetchShield).toEqualTypeOf<(conn: Connection, baseMint: PublicKey) => Promise<phx.ShieldAccount | null>>();
    expectTypeOf(phx.buildCreateShieldTx).toEqualTypeOf<(conn: Connection, payer: PublicKey, baseMint: PublicKey) => Promise<Transaction>>();
    expectTypeOf(phx.buildWrapTx).toEqualTypeOf<(conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint) => Promise<Transaction>>();
    expectTypeOf(phx.buildUnwrapTx).toEqualTypeOf<(conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint) => Promise<Transaction>>();
  });
});

describe("SPEC §4.1 rpc helpers", () => {
  it("simulates and sends legacy transactions and raw v1 bytes", () => {
    expectTypeOf(phx.simulateAndExplain).toMatchTypeOf<(conn: Connection, tx: Transaction | Uint8Array) => Promise<phx.SimulationReport>>();
    expectTypeOf(phx.sendAndConfirm).toMatchTypeOf<(conn: Connection, tx: Transaction | Uint8Array) => Promise<string>>();
    expectTypeOf(phx.getSolBalance).toEqualTypeOf<(conn: Connection, owner: PublicKey) => Promise<bigint>>();
    expectTypeOf(phx.getTokenBalance).toEqualTypeOf<(conn: Connection, owner: PublicKey, mint: PublicKey) => Promise<bigint>>();
  });
});

describe("runtime surface", () => {
  const ARITY: Record<string, number> = {
    validateLaunchParams: 1,
    launchPdas: 2,
    launchPdasFromLaunch: 1,
    buildCreateLaunchTx: 3,
    buildLaunchTx: 4,
    buildCommitTx: 4,
    buildExecuteBatchTx: 3,
    buildClaimTx: 4,
    buildClaimFeesTx: 3,
    buildClaimLpFeesTx: 3,
    buildDistributeTx: 3,
    fetchLaunch: 2,
    fetchLaunchByMint: 2,
    listLaunches: 1,
    fetchCommit: 3,
    launchPhase: 2,
    buildSwapTx: 6,
    checkFeeRecipients: 2,
    // The launch flow (PQ v2, on-chain metadata): the SDK's own functions in a default build.
    planLaunch: 1,
    replanLaunchWindow: 2,
    buildMetadataDoc: 1,
    validateMetadataDoc: 1,
    parseMetadataDoc: 1,
    encodeIndexedPng: 3,
    buildPlannedCreateLaunchTx: 2,
    buildFundThrowawayPayerTx: 3,
    buildPlannedPublishTx: 3,
    sendPublishMetadataTx: 2,
    waitForTokenMeta: 3,
    buildPlannedAttestTx: 3,
    sendAttestLaunchTx: 2,
    confirmAttestation: 3,
    buildSweepPayerTx: 3,
    getLaunchFlowStatus: 2,
    verifyAttestation: 2,
    fetchTokenMetaForLaunch: 2,
    fetchTokenMetaForMint: 2,
    launchPayerLamports: 2,
    verifyLaunch: 2,
    generateRecoveryPhrase: 0,
    masterFromPhrase: 1,
    deriveVaultKey: 5,
    vaultAddress: 2,
    payoutAddress: 2,
    fetchVault: 2,
    withdrawMessage: 6,
    prepareWithdrawal: 7,
    checkRecipient: 4,
    buildOpenVaultTx: 4,
    buildDepositTx: 5,
    buildWithdrawTx: 3,
    buildReleaseTx: 3,
    buildReleaseToTx: 3,
    findPendingWithdrawal: 2,
    checkVaultMint: 2,
    scanVaults: 5,
    shieldAddresses: 1,
    fetchShield: 2,
    buildCreateShieldTx: 3,
    buildWrapTx: 4,
    buildUnwrapTx: 4,
    simulateAndExplain: 2,
    sendAndConfirm: 2,
  };
  for (const [name, arity] of Object.entries(ARITY)) {
    it(`${name} is a function of ${arity} required parameter(s)`, () => {
      const fn = (phx as unknown as Record<string, unknown>)[name];
      expect(typeof fn).toBe("function");
      expect((fn as (...a: unknown[]) => unknown).length).toBe(arity);
    });
  }
  it("exports PRESETS fair, community and turbo", () => {
    expect(Object.keys(phx.PRESETS).sort()).toEqual(["community", "fair", "turbo"]);
  });
});

describe("wiring", () => {
  it("re-exports the SDK's pure functions and constants unchanged", () => {
    const pure = [
      "PROGRAM_IDS",
      "WSOL_MINT",
      "CLUSTERS",
      "PRESETS",
      "validateLaunchParams",
      "launchPdas",
      "launchPdasFromLaunch",
      "launchPhase",
      "lmots",
      "generateRecoveryPhrase",
      "masterFromPhrase",
      "deriveVaultKey",
      "vaultAddress",
      "payoutAddress",
      "keySequence",
      "withdrawMessage",
      "createVaultKeyLedger",
      "exportVaultKeyRecords",
      "importVaultKeyRecords",
      "VaultKeyInUseError",
      "RecipientConfirmationError",
      "ClusterMismatchError",
      "leafLedger",
      "pqIdentity",
      "expectedBatchFill",
      "shieldAddresses",
      "decodeV1Transaction",
      "launchParamsHash",
      "TRUSTED_PARTIES",
      "METADATA",
      "metadataHashV2",
      "tokenMetaAddress",
      "tokenUri",
      "validateTokenMeta",
      "tokenMetaSpace",
      "buildMetadataDoc",
      "encodeIndexedPng",
      "parseMetadataDoc",
      "validateMetadataDoc",
      "planLaunch",
      "replanLaunchWindow",
      "validateLaunchWindow",
      "launchWindowProblems",
      "attestationReplaceable",
      "AttestRetryLimitError",
      "AttestPayerFundingError",
      "PublishPayerFundingError",
      "MAX_BURN_ONLY_LANDINGS",
    ] as const;
    for (const name of pure) expect((phx as Record<string, unknown>)[name], name).toBe((sdk as Record<string, unknown>)[name]);
  });

  it("a default build uses the live backend, which passes the SDK's builders and reads through", () => {
    expect(phx.ADAPTER_MODE).toBe("live");
    expect(phx.buildCommitTx).toBe(live.buildCommitTx);
    const passthrough = [
      "fetchLaunch",
      "fetchLaunchByMint",
      "listLaunches",
      "fetchCommit",
      "fetchAttestation",
      "fetchPayoutVault",
      "buildCreateLaunchTx",
      "buildLaunchTx",
      "buildCommitTx",
      "buildExecuteBatchTx",
      "buildClaimTx",
      "buildClaimFeesTx",
      "buildClaimLpFeesTx",
      "buildDistributeTx",
      "buildSwapTx",
      "verifyLaunch",
      "buildOpenVaultTx",
      "buildDepositTx",
      "buildWithdrawTx",
      "buildWithdrawTxWithFallback",
      "buildReleaseTx",
      "fetchVault",
      "fetchPayout",
      "listPayouts",
      "findPendingWithdrawal",
      "prepareWithdrawal",
      "scanVaults",
      "buildFundFeePayerTx",
      "buildRefundFeePayerTx",
      "fetchShield",
      "buildCreateShieldTx",
      "buildWrapTx",
      "buildUnwrapTx",
      "getSolBalance",
      "getTokenBalance",
      "getTokenSupply",
      "buildPlannedCreateLaunchTx",
      "throwawayPayerFunding",
      "buildFundThrowawayPayerTx",
      "buildPlannedPublishTx",
      "sendPublishMetadataTx",
      "waitForTokenMeta",
      "buildPlannedAttestTx",
      "sendAttestLaunchTx",
      "confirmAttestation",
      "buildSweepPayerTx",
      "getLaunchFlowStatus",
      "verifyAttestation",
      "fetchTokenMetaForLaunch",
      "fetchTokenMetaForMint",
      "rentExemptLamports",
    ] as const;
    for (const name of passthrough) expect(live[name], name).toBe(sdk[name]);
    // Wrapped for presentation and safety only (tested in test/live-backend.test.ts).
    // buildReleaseToTx adds the Launch Guard's immutable-owner refusal (audit round 3, F2; test/audit3-clients.test.ts).
    for (const name of ["simulateAndExplain", "sendAndConfirm", "checkVaultMint", "checkRecipient", "buildReleaseToTx"] as const) expect(live[name], name).not.toBe(sdk[name]);
  });

  it("both backends implement the same members", () => {
    expectTypeOf(live).toEqualTypeOf<ChainBackend>();
    expectTypeOf(mock).toEqualTypeOf<ChainBackend>();
    expect(Object.keys(mock).sort()).toEqual(Object.keys(live).sort());
    expect(mock.mode).toBe("mock");
    expect(live.mode).toBe("live");
  });
});
