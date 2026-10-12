/**
 * The PQ v2 launch flow, end to end, for integrators. Every step is a
 * builder (it reads the chain and returns a transaction; it never sends),
 * and `getLaunchFlowStatus` tells which step a launch is at.
 *
 * ```text
 * 0. prepareFeeVault                    the creator's wSOL PQ vault (fees are paid into it); open it if needed
 *    buildMetadataDoc / encodeIndexedPng the token's document: description, a small PNG icon, links
 * 1. planLaunch                         pure: parameters, the metadata record, window, PDAs, the message the identity signs
 * 2. buildPlannedCreateLaunchTx         create_launch (the creator's wallet signs; legacy)
 *    ... wait until create_launch is FINALIZED (the identity signs only a finalized launch)
 * 3. buildFundThrowawayPayerTx          fund a throwaway fee payer for the records and the attestation (the wallet signs; legacy)
 *    buildPlannedPublishTx              publish_metadata: the record, from the throwaway payer (v1)
 *    sendPublishMetadataTx, then waitForTokenMeta   ... until the record is FINALIZED
 *    buildPlannedPublishRulesTx         publish_rules: the creator rules, if any, from the throwaway payer (v1)
 *    sendPublishRulesTx, then waitForLaunchRules    ... until the rules record is FINALIZED
 *    buildPlannedAttestTx               the identity signs; a v1 transaction from the throwaway payer
 *    sendAttestLaunchTx                 send, then confirmAttestation: attested / burned / pending
 *    buildSweepPayerTx                  return what is left on the throwaway payer to the creator
 * 4. waitForLaunchWindow               until the cluster clock reaches not_before
 * 5. buildPlannedLaunchTx               launch: ANYONE may send it inside the window (legacy),
 *    or buildPlannedLaunchCommitBundle  [launch, commit] as one v1 transaction (keepers)
 * 6. buildCommitTx                      commit; tokenOwner / refundOwner may be PQ vaults (preparePqVault)
 * 7. buildExecuteBatchTx                execute_batch (a permissionless keeper, with a priority fee)
 * 8. buildClaimTx                       claim: pays the payout owners the first commit fixed (anyone may send it)
 * ```
 *
 * Rules worth stating to users:
 *
 * - The creator's PQ identity, not the wallet, decides that a launch goes
 *   live: `launch` requires the identity's attestation, which binds the
 *   configuration (`params_hash`), the token's on-chain metadata record
 *   (name, symbol, description, icon, links) and the launch window. The
 *   mint gets the record's name and symbol and, by default, an empty uri:
 *   wallets show the name and symbol; the icon and description show in
 *   Noised (and any reader of the record). Do not offer `INLINE_URI` until
 *   the wallet/indexer matrix of METADATA_ONCHAIN.md §2.4 passes; an
 *   external uri is a creator opt-in whose content can change.
 * - Inside the window ANYONE may send `launch`, and the first transaction
 *   to land wins: a keeper should send it at `not_before` with a priority
 *   fee. If nobody launches before `not_after`, the window passed: the
 *   identity signs a new opening time (`replanLaunchWindow`, then
 *   `buildPlannedAttestTx` at its next leaf), which replaces the unused
 *   attestation (audit round 3 F1); the published record is reused, or a
 *   new one is published first. A live launch's attestation never changes.
 *   An earlier signature of the launch that was sent but never landed can
 *   take the slot first if its own window has not ended (review info #2):
 *   `buildAttestLaunchTx` refuses a new window until it is landed
 *   (`landOrBurnPending`) or has ended, and the best moment to retire such
 *   signatures is while the current window holds the slot (they then only
 *   burn their leaf). `getLaunchFlowStatus` with `pending` lists them.
 * - Times are unix SECONDS (a classic mistake is `Date.now()`
 *   milliseconds), and the cluster clock decides, not the local one.
 * - There is no separate `claim_to`: `claim` pays the commit's payout
 *   owners, which its FIRST commit fixes. To receive the tokens (or the wSOL
 *   refund) in a PQ vault, open the vault (`preparePqVault` with the base
 *   mint once the launch is live, or wSOL) and commit with `tokenOwner`
 *   (`refundOwner`) set to it; `claim` then pays the vault's own token
 *   accounts. Every commit naming one vault is held to one wallet's batch
 *   cap together.
 * - Fee recipients are paid at ATA(wallet, wSOL), so a wSOL PQ vault is a
 *   valid recipient; `planLaunch` makes it the default (`feeVault`).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, type Connection, type Keypair, type Transaction } from "@solana/web3.js";

import { bytesEqual, isAllZero, randomBytes } from "../codec/bytes.js";
import { METADATA, POLICY, PROGRAM_IDS, WSOL_MINT, type Cluster } from "../constants.js";
import { buildPublishMetadataTx, type PublishMetadataTx, type PublishTxOptions } from "../metadata/publish.js";
import { fetchTokenMeta, metadataHashV2, tokenMetaRecord, tokenUri, validateTokenMeta, type TokenMetaAccount, type TokenMetaRecord } from "../metadata/record.js";
import { associatedTokenAddress, launchPdas, launchRulesAddress, tokenMetaAddress, vaultAddress, type LaunchPdas } from "../pda.js";
import { rulesHash as rulesHashOf } from "../programmable/hash.js";
import { verifyRules } from "../programmable/rules/codec.js";
import { explainRules } from "../programmable/rules/explain.js";
import { buildAttestLaunchTx, findPendingAttestations, type AttestLaunchTx, type AttestTxOptions, type LaunchWindow, type PendingAttestation } from "../pq/attest.js";
import { attestationMessage, type PqIdentity } from "../pq/identity.js";
import { checkMaster, deriveVaultKey } from "../pq/keys.js";
import type { LeafLedger } from "../pq/leafLedger.js";
import type { LedgerLock } from "../pq/ledgerLock.js";
import type { LmotsPublicKey } from "../pq/lmots.js";
import { buildOpenVaultTx } from "../pq/vault.js";
import { assertCluster } from "../rpc/cluster.js";
import type { ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccount } from "../rpc/fetch.js";
import type { AttestationAccount, CommitAccount, FeeRecipient, LaunchAccount, LaunchMetadata, LaunchParams, LaunchPhase, PresetName } from "../types.js";
import { fetchAttestation, fetchCommit, fetchLaunch, fetchLaunchRules } from "./accounts.js";
import { buildCreateLaunchTx, buildLaunchCommitBundleV1, buildLaunchTx, type LaunchCommitBundleOptions, type LaunchTxOptions } from "./builders.js";
import { launchParamsHash } from "./hash.js";
import { validateLaunchParams } from "./policy.js";
import { buildPublishRulesV1Tx, type PublishRulesV1Tx } from "./rules.js";
import { checkNowSecs, clusterUnixTime, inLaunchWindow, plausibleUnixSecs, unixToIso, validateLaunchWindow } from "./window.js";
import { batchOutcome, launchPhase, PRESETS } from "./presets.js";
import { isPqVaultOf } from "./recipients.js";

// ------------------------------------------------------------- PQ vaults ---

/** A PQ vault a phrase controls, and whether it is open. */
export interface PqVaultTarget {
  /** The vault address `["vault", mint, key_id(genesis key)]`: the owner to name (fee recipient, token or refund owner). */
  readonly vault: PublicKey;
  readonly mint: PublicKey;
  /** The phrase's vault account number. */
  readonly account: number;
  readonly genesisKeyId: Uint8Array;
  /** The vault's own token account, ATA(vault, mint): where payouts named to the vault land. */
  readonly tokenAccount: PublicKey;
  /** The vault exists (opened, version 4, this mint). */
  readonly opened: boolean;
  /** `open_vault` to sign and send first (null when already open). */
  readonly openTx: Transaction | null;
}

/** `preparePqVault` arguments. */
export interface PreparePqVaultArgs {
  /** The 64-byte BIP-39 seed of the 24-word PQ phrase (a private copy is used and wiped). */
  readonly master: Uint8Array;
  /** The cluster the keys are derived for: checked against the endpoint's genesis hash. */
  readonly cluster: Cluster;
  readonly mint: PublicKey;
  /** Pays for `open_vault` when the vault is not open yet. */
  readonly payer: PublicKey;
  /** The phrase's vault account number (default 0). */
  readonly account?: number | undefined;
  readonly allowLocalnet?: boolean | undefined;
}

/**
 * Vault `account` of a phrase for `mint`: its address, and the `open_vault`
 * transaction when it is not open yet (only an opened vault can receive:
 * create_launch and commit refuse an unopened one, whose address nobody can
 * sign for). Refuses an endpoint of another cluster (the keys are per
 * cluster). No PQ signature is made here.
 */
export async function preparePqVault(conn: Connection, args: PreparePqVaultArgs): Promise<PqVaultTarget> {
  if (!(args.mint instanceof PublicKey) || !(args.payer instanceof PublicKey)) throw new TypeError("mint and payer must be PublicKeys");
  checkMaster(args.master);
  const account = args.account ?? 0;
  await assertCluster(conn, args.cluster, { allowLocalnet: args.allowLocalnet });
  const master = Uint8Array.from(args.master);
  let genesis: { pk: LmotsPublicKey; keyId: Uint8Array };
  try {
    const key = deriveVaultKey(master, args.cluster, args.mint, account, 0);
    key.skSeed.fill(0);
    genesis = { pk: key.pk, keyId: key.keyId };
  } finally {
    master.fill(0);
  }
  const genesisKeyId = genesis.keyId;
  const vault = vaultAddress(args.mint, genesisKeyId);
  const [vaultAcc, mintAcc] = await Promise.all([getAccount(conn, vault), getAccount(conn, args.mint)]);
  if (mintAcc === null) throw new Error(`mint ${args.mint.toBase58()} does not exist`);
  const opened = isPqVaultOf(vaultAcc, args.mint);
  if (!opened && vaultAcc !== null && vaultAcc.owner.equals(PROGRAM_IDS.vault) && vaultAcc.data.length > 0) {
    throw new Error(`the account at vault ${vault.toBase58()} is not a version-4 vault of this mint`);
  }
  return {
    vault,
    mint: args.mint,
    account,
    genesisKeyId,
    tokenAccount: associatedTokenAddress(vault, args.mint, mintAcc.owner),
    opened,
    openTx: opened ? null : await buildOpenVaultTx(conn, args.payer, args.mint, genesis.pk),
  };
}

/** `preparePqVault` for wSOL: the vault creator fees (and wSOL refunds) are paid into. */
export async function prepareFeeVault(conn: Connection, args: Omit<PreparePqVaultArgs, "mint">): Promise<PqVaultTarget> {
  return preparePqVault(conn, { ...args, mint: WSOL_MINT });
}

/** All creator fees to one wSOL PQ vault: `[{ wallet: vault, bps: 10,000 }]`. */
export function vaultFeeRecipients(vault: PublicKey): FeeRecipient[] {
  if (!(vault instanceof PublicKey)) throw new TypeError("vault must be a PublicKey");
  return [{ wallet: vault, bps: POLICY.BPS_DENOMINATOR }];
}

// ------------------------------------------------------------------ plan ---

/** `planLaunch` input. */
export interface PlanLaunchInput {
  /** The wallet that signs create_launch. */
  readonly creator: PublicKey;
  /** The identity that will attest (`deriveIdentity`), or its 32-byte id: it becomes `params.pqIdentity`. */
  readonly identity: Pick<PqIdentity, "identityId"> | Uint8Array;
  /** A preset (default `fair`), unless `params` is given. */
  readonly preset?: PresetName | undefined;
  /** Every creator choice but the recipients and the identity (overrides `preset`). */
  readonly params?: Omit<LaunchParams, "recipients" | "pqIdentity"> | undefined;
  /** Fee recipients; default: everything to `feeVault`. */
  readonly recipients?: readonly FeeRecipient[] | undefined;
  /** The creator's wSOL PQ vault (`prepareFeeVault`): the default fee recipient. */
  readonly feeVault?: PublicKey | undefined;
  /** The token's metadata record: name, symbol, the document (`buildMetadataDoc`), flags (default 0: the mint's uri stays empty) and an external uri. */
  readonly metadata: LaunchMetadata;
  /**
   * Optional creator launch rules (PXR1 bytes, `compileRules`): verified
   * for the launch's guard (`verifyRules`), published on-chain
   * (`buildPlannedPublishRulesTx`) and signed by the attestation; `launch`
   * installs exactly them in the hook policy. Omit for none.
   */
  readonly rules?: Uint8Array | null | undefined;
  /** When the launch window opens, unix SECONDS. */
  readonly opensAt: bigint;
  /** Window length in seconds, 60..=3,600 (default 3,600). */
  readonly windowSecs?: bigint | undefined;
  /** 32 bytes (default random). */
  readonly launchSeed?: Uint8Array | undefined;
  /** Bigint unix seconds to check the window against (e.g. `clusterUnixTime`); omitted: its length and units only. */
  readonly nowSecs?: bigint | undefined;
}

/** Everything the flow's steps need, fixed up front (keep it: the launch step needs the exact metadata). */
export interface LaunchPlan {
  readonly creator: PublicKey;
  readonly launchSeed: Uint8Array;
  readonly launch: PublicKey;
  readonly pdas: LaunchPdas;
  /** The complete parameters (`pqIdentity` and `recipients` included). */
  readonly params: LaunchParams;
  /** `launchParamsHash(params)`: what the identity checks on-chain before it signs. */
  readonly paramsHash: Uint8Array;
  /** The metadata record's exact bytes (publish them unchanged). */
  readonly metadata: TokenMetaRecord;
  /** `metadataHashV2(metadata)`: what the identity signs. */
  readonly metadataHash: Uint8Array;
  /** The record's address, `["metadata", launch, metadataHash]`. */
  readonly tokenMeta: PublicKey;
  /** The uri `launch` will give the mint (empty by default). */
  readonly tokenUri: string;
  /** The creator rules' PXR1 bytes (null: none). */
  readonly rules: Uint8Array | null;
  /** `rulesHash(rules)` (all zero: none): what the identity signs. */
  readonly rulesHash: Uint8Array;
  /** The rules record's address, `["rules", launch, rulesHash]` (null: none). */
  readonly rulesRecord: PublicKey | null;
  /** Plain-English lines for the rules (`explainRules`; empty without rules). */
  readonly rulesExplanation: string[];
  readonly window: LaunchWindow;
  /** The window as absolute UTC dates (`unixToIso`): show these, not only "in N hours" (audit 4, ID-F5). */
  readonly windowIso: { readonly notBefore: string; readonly notAfter: string };
  readonly pqIdentity: Uint8Array;
  /** The 221-byte message (v3) the identity will sign, and its SHA-256 (what the attestation must hold). */
  readonly message: Uint8Array;
  readonly messageHash: Uint8Array;
  readonly warnings: string[];
}

/**
 * Fix a launch before anything is signed: parameters (a preset or explicit,
 * validated exactly like the program), fee recipients (default: all to the
 * creator's wSOL PQ vault), the metadata record (validated exactly like
 * `publish_metadata`), the window `[opensAt, opensAt + windowSecs]` and the
 * launch seed; derives the PDAs, `params_hash`, the record's hash and
 * address and the exact message the identity will sign. Pure. Throws with
 * every problem listed.
 */
export function planLaunch(input: PlanLaunchInput): LaunchPlan {
  if (!(input.creator instanceof PublicKey)) throw new TypeError("creator must be a PublicKey");
  const pqIdentity = Uint8Array.from(input.identity instanceof Uint8Array ? input.identity : input.identity.identityId);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (pqIdentity.length !== 32 || isAllZero(pqIdentity)) errors.push("identity: must be a 32-byte, non-zero identity id");
  const base = input.params ?? PRESETS[input.preset ?? "fair"]?.params;
  if (base === undefined) throw new RangeError(`unknown preset ${String(input.preset)}`);
  let recipients: FeeRecipient[];
  if (input.recipients !== undefined) recipients = input.recipients.map((r) => ({ wallet: r.wallet, bps: r.bps }));
  else if (input.feeVault !== undefined) recipients = vaultFeeRecipients(input.feeVault);
  else throw new Error("recipients: pass fee recipients or feeVault (the creator's wSOL PQ vault, recommended)");
  if (input.feeVault !== undefined && input.recipients !== undefined && !recipients.some((r) => r.wallet.equals(input.feeVault!))) {
    warnings.push("feeVault is not among the fee recipients");
  }
  const launchSeed = Uint8Array.from(input.launchSeed ?? randomBytes(32));
  if (launchSeed.length !== 32) throw new RangeError("launchSeed must be 32 bytes");
  const pdas = launchPdas(input.creator, launchSeed);
  // A copy: presets are frozen and shared, and the caller's object stays theirs.
  const params: LaunchParams = {
    ...base,
    curve: base.curve.map((c) => ({ sqrtPrice: c.sqrtPrice, liquidity: c.liquidity })),
    baseFee: { ...base.baseFee },
    dynamicFee: base.dynamicFee === null ? null : { ...base.dynamicFee },
    recipients,
    pqIdentity,
  };
  const p = validateLaunchParams(params, [pdas.launchAuthority, pdas.batchAuthority]);
  errors.push(...p.errors);
  if (input.metadata === null || typeof input.metadata !== "object") throw new TypeError("metadata must be the token's record ({ name, symbol, doc?, flags?, uri? })");
  const m = validateTokenMeta(input.metadata);
  errors.push(...m.errors);
  const record = m.ok ? tokenMetaRecord(input.metadata) : null;
  if (record !== null && record.flags === METADATA.FLAG_INLINE_URI) {
    warnings.push("INLINE_URI writes the whole document into the mint's uri: do not offer it until wallets and indexers are shown to list such tokens (METADATA_ONCHAIN.md §2.4)");
  }
  if (record !== null && record.flags === METADATA.FLAG_EXTERNAL_URI) warnings.push("an external uri is the creator's own link: what it serves can change; the on-chain record stays the signed metadata");
  let rules: Uint8Array | null = null;
  let rulesExplanation: string[] = [];
  if (input.rules !== undefined && input.rules !== null) {
    if (!(input.rules instanceof Uint8Array)) throw new TypeError("rules must be the PXR1 bytes (compileRules)");
    if (input.rules.length > 0) {
      rules = Uint8Array.from(input.rules);
      const v = verifyRules(rules, { guardSecs: params.guardSecs });
      if (!v.ok) errors.push(`rules: they do not verify for this launch's ${params.guardSecs}-second guard (${v.code}: ${v.message})`);
      else rulesExplanation = explainRules(rules);
    }
  }

  if (typeof input.opensAt !== "bigint") throw new TypeError("opensAt must be bigint unix seconds");
  const windowSecs = input.windowSecs ?? BigInt(POLICY.MAX_LAUNCH_WINDOW_SECS);
  if (typeof windowSecs !== "bigint") throw new TypeError("windowSecs must be a bigint");
  const window: LaunchWindow = { notBefore: input.opensAt, notAfter: input.opensAt + windowSecs };
  // Without a clock: judge the length and the units only (a "now" just before the window never ends it; a window
  // in milliseconds or outside i64 is reported as such, at a plausible "now").
  const clockFree = plausibleUnixSecs(window.notBefore - 1n) ? window.notBefore - 1n : 0n;
  const w = validateLaunchWindow(
    window.notBefore,
    window.notAfter,
    input.nowSecs === undefined ? { nowSecs: clockFree, landingMarginSecs: 0n } : { nowSecs: checkNowSecs(input.nowSecs, "nowSecs") },
  );
  errors.push(...w.errors);
  if (errors.length > 0 || record === null) throw new Error(`invalid launch plan:\n${errors.join("\n")}`);

  const paramsHash = launchParamsHash(params);
  const metadataHash = metadataHashV2(record);
  const rulesHash = rulesHashOf(rules);
  const message = attestationMessage({
    launch: pdas.launch,
    paramsHash,
    creator: input.creator,
    metadataHash,
    rulesHash,
    notBefore: window.notBefore,
    notAfter: window.notAfter,
  });
  return {
    creator: input.creator,
    launchSeed,
    launch: pdas.launch,
    pdas,
    params,
    paramsHash,
    metadata: record,
    metadataHash,
    tokenMeta: tokenMetaAddress(pdas.launch, metadataHash),
    tokenUri: tokenUri(record),
    rules,
    rulesHash,
    rulesRecord: rules === null ? null : launchRulesAddress(pdas.launch, rulesHash),
    rulesExplanation,
    window,
    windowIso: { notBefore: unixToIso(window.notBefore), notAfter: unixToIso(window.notAfter) },
    pqIdentity,
    message,
    messageHash: sha256(message),
    warnings,
  };
}

// ----------------------------------------------------------------- steps ---

/** Step 2: `create_launch` for the plan (the creator's wallet signs). Refuses what the program or a sane payout would refuse. */
export async function buildPlannedCreateLaunchTx(conn: Connection, plan: LaunchPlan, opts: ComputeBudgetOptions = {}): Promise<{ tx: Transaction; launch: PublicKey; warnings: string[] }> {
  const r = await buildCreateLaunchTx(conn, plan.creator, plan.params, { ...opts, launchSeed: plan.launchSeed });
  if (!r.launch.equals(plan.launch)) throw new Error("create_launch derived another launch address than the plan");
  return { tx: r.tx, launch: r.launch, warnings: r.warnings };
}

/** `replanLaunchWindow` input: the new opening time (and the record, to change it). */
export interface ReplanWindowInput {
  /** When the new window opens, unix SECONDS. */
  readonly opensAt: bigint;
  /** Window length in seconds, 60..=3,600 (default 3,600). */
  readonly windowSecs?: bigint | undefined;
  /** Bigint unix seconds to check the window against (`clusterUnixTime`); omitted: its length and units only. */
  readonly nowSecs?: bigint | undefined;
  /** Another metadata record (publish it before attesting); default: the plan's, already published. */
  readonly metadata?: LaunchMetadata | undefined;
}

/**
 * The same launch with a new window (audit round 3 F1): when the attested
 * window passed without a launch (`getLaunchFlowStatus` step
 * `window-missed`), the identity signs this plan's message to replace the
 * unused attestation. Same creator, seed, launch, parameters and (unless
 * `metadata` is given) record; a new window and so a new message, signed at
 * the identity's next leaf (`buildPlannedAttestTx`). Pure.
 */
export function replanLaunchWindow(plan: LaunchPlan, input: ReplanWindowInput): LaunchPlan {
  if (plan === null || typeof plan !== "object" || !(plan.creator instanceof PublicKey)) throw new TypeError("plan must be a LaunchPlan (planLaunch)");
  const { recipients, pqIdentity, ...params } = plan.params;
  const next = planLaunch({
    creator: plan.creator,
    identity: pqIdentity,
    params,
    recipients,
    rules: plan.rules,
    metadata: input.metadata ?? plan.metadata,
    opensAt: input.opensAt,
    windowSecs: input.windowSecs,
    launchSeed: plan.launchSeed,
    nowSecs: input.nowSecs,
  });
  if (!next.launch.equals(plan.launch) || !bytesEqual(next.paramsHash, plan.paramsHash)) throw new Error("the new plan is not the same launch");
  return next;
}

/**
 * Step 3a: `publish_metadata` of the plan's record, from the throwaway
 * payer that will also attest (`already-published` when the record is
 * there). Send with `sendPublishMetadataTx`, then `waitForTokenMeta` until
 * it is finalized before the attestation.
 */
export async function buildPlannedPublishTx(conn: Connection, plan: LaunchPlan, payer: Keypair, opts: PublishTxOptions = {}): Promise<PublishMetadataTx> {
  const built = await buildPublishMetadataTx(conn, { ...opts, launch: plan.launch, payer, metadata: plan.metadata });
  if (!bytesEqual(built.metadataHash, plan.metadataHash)) throw new Error("the record built differs from the plan's");
  return built;
}

/**
 * Step 3a': `publish_rules` of the plan's creator rules (when it has any),
 * from the same throwaway payer, as a v1 transaction (`already-published`
 * when the record is there; null when the plan has no rules). Send with
 * `sendPublishRulesTx`, then `waitForLaunchRules` until it is finalized
 * before the attestation.
 */
export async function buildPlannedPublishRulesTx(conn: Connection, plan: LaunchPlan, payer: Keypair, opts: ComputeBudgetOptions & { loadedAccountsDataSizeLimit?: number } = {}): Promise<PublishRulesV1Tx | null> {
  if (plan.rules === null) return null;
  const built = await buildPublishRulesV1Tx(conn, payer, { ...opts, launch: plan.launch, rules: plan.rules });
  if (!bytesEqual(built.rulesHash, plan.rulesHash)) throw new Error("the rules built differ from the plan's");
  return built;
}

/** `buildPlannedAttestTx` arguments. */
export interface PlannedAttestArgs extends AttestTxOptions {
  readonly identity: PqIdentity;
  readonly ledger: LeafLedger;
  /** The throwaway fee payer (default fresh; pass the same one to rebuild). */
  readonly payer?: Keypair | undefined;
  readonly allowLocalnet?: boolean | undefined;
  readonly landingMarginSecs?: bigint | undefined;
  /** Default `finalized`: the record must be final before the identity signs. */
  readonly metadataCommitment?: "finalized" | "confirmed" | undefined;
  /** Default `finalized`: the rules record (if any) must be final before the identity signs. */
  readonly rulesCommitment?: "finalized" | "confirmed" | undefined;
  /** Default 2 (`buildAttestLaunchTx`). */
  readonly maxBurnOnlyLandings?: number | undefined;
  /** `buildAttestLaunchTx`'s `acknowledgeExtraSignatures` (audit 4, ID-F2). */
  readonly acknowledgeExtraSignatures?: boolean | undefined;
  /** `buildAttestLaunchTx`'s `signingLock` (in a browser `(name, fn) => navigator.locks.request(name, fn)`; audit 4, ID-F4). */
  readonly signingLock?: LedgerLock | undefined;
  /** This device's unix seconds for the clock check (default its clock; audit 4, ID-F1b). */
  readonly localNowSecs?: bigint | undefined;
  /** A second, independent RPC for the clock check. */
  readonly secondConnection?: Connection | undefined;
  /** Most seconds the clocks may differ (default 120). */
  readonly maxClockSkewSecs?: bigint | undefined;
}

/**
 * Step 3b: the identity signs the plan's launch (`buildAttestLaunchTx` with
 * the plan's creator, record hash, window and `params_hash`: a launch
 * holding any other configuration is refused, and so is a record that is not
 * published and final). The message signed is exactly `plan.message`: its
 * hash (`plan.messageHash`, what the user reviewed) is compared with the
 * message built from the chain BEFORE any leaf is reserved (audit 4, ID-F6),
 * so a plan whose fields no longer match what was reviewed signs nothing.
 */
export async function buildPlannedAttestTx(conn: Connection, plan: LaunchPlan, args: PlannedAttestArgs): Promise<AttestLaunchTx> {
  if (!bytesEqual(args.identity.identityId, plan.pqIdentity)) throw new Error("this identity is not the one the plan names");
  if (!(plan.messageHash instanceof Uint8Array) || plan.messageHash.length !== 32) throw new TypeError("plan.messageHash must be the 32-byte hash of the reviewed message");
  const reviewed = Uint8Array.from(plan.messageHash);
  const built = await buildAttestLaunchTx(conn, {
    ...args,
    launch: plan.launch,
    creator: plan.creator,
    metadataHash: plan.metadataHash,
    rulesHash: plan.rulesHash,
    window: { notBefore: plan.window.notBefore, notAfter: plan.window.notAfter },
    expectedParamsHash: plan.paramsHash,
    expectedMessageHash: reviewed,
  });
  if (!bytesEqual(built.messageHash, reviewed)) throw new Error("the message built on-chain data differs from the plan's");
  return built;
}

/** Step 5: `launch` (anyone may pay; the fresh mint keypair signs inside; the metadata comes from the attested record). */
export async function buildPlannedLaunchTx(conn: Connection, plan: LaunchPlan, payer: PublicKey, baseMint: Keypair, opts: LaunchTxOptions = {}): Promise<{ tx: Transaction }> {
  return buildLaunchTx(conn, payer, plan.launch, baseMint, opts);
}

/** Step 5, keepers: `[launch, commit]` as one signed v1 transaction. */
export async function buildPlannedLaunchCommitBundle(
  conn: Connection,
  plan: LaunchPlan,
  payer: Keypair,
  baseMint: Keypair,
  lamports: bigint,
  opts: LaunchCommitBundleOptions = {},
): ReturnType<typeof buildLaunchCommitBundleV1> {
  return buildLaunchCommitBundleV1(conn, payer, plan.launch, baseMint, lamports, opts);
}

// ---------------------------------------------------------------- status ---

/**
 * Where a launch is in the flow (the next action):
 * `create` (no launch account), `publish` (configured, and the record of
 * `expectedMetadataHash`, or the rules record of `expectedRulesHash`, is not
 * published yet), `attest` (configured, no
 * attestation or an empty, burn-only one), `wait-for-window` (attested,
 * before `not_before`),
 * `launch` (inside the window: anyone may launch now), `window-missed` (the
 * window passed unlaunched: the identity signs a new opening time, which
 * replaces the attestation; `replanLaunchWindow`), `commit` (commit window),
 * `execute` (the batch can execute), `claim` (the batch executed or expired:
 * claims are open; with `owner`, only while that owner's commit is
 * unclaimed), `trading` (nothing left in the flow).
 */
export type LaunchFlowStep = "create" | "publish" | "attest" | "wait-for-window" | "launch" | "window-missed" | "commit" | "execute" | "claim" | "trading";

/** `getLaunchFlowStatus` result. */
export interface LaunchFlowStatus {
  readonly launch: PublicKey;
  readonly step: LaunchFlowStep;
  /** One plain-English sentence for the UI. */
  readonly summary: string;
  /** The cluster's unix time (or `nowSecs`). */
  readonly nowSecs: bigint;
  readonly account: LaunchAccount | null;
  readonly attestation: AttestationAccount | null;
  /** `none`: nothing landed; `empty`: a landing only burned its leaf (version 0); `attested`: version 1. */
  readonly attestationState: "none" | "empty" | "attested";
  /** Whether the attestation holds `expectedMessageHash` (null when none was given or nothing is attested). */
  readonly attestedMessageMatches: boolean | null;
  /** The metadata record: the attested one, else the one `expectedMetadataHash` names (null when none is known or published). */
  readonly tokenMeta: TokenMetaAccount | null;
  /** Whether that record is published (null when no record is known: not attested and no `expectedMetadataHash`). */
  readonly metadataPublished: boolean | null;
  /** Whether the rules record of `expectedRulesHash` (or of the attested rules hash) is published (null: no rules known). */
  readonly rulesPublished: boolean | null;
  /** The attested window (null until attested). */
  readonly window: LaunchWindow | null;
  /** The attested window as absolute UTC dates (`unixToIso`; null until attested). */
  readonly windowIso: { readonly notBefore: string; readonly notAfter: string } | null;
  /** `launch` would pass its window check now (attested, configured, inside the window). */
  readonly canLaunchNow: boolean;
  /** Seconds until `not_before` (0 inside or after it; null without a window). */
  readonly secondsUntilWindowOpens: bigint | null;
  /** Seconds until `not_after` (0 after it; null without a window). */
  readonly secondsUntilWindowCloses: bigint | null;
  /** `launchPhase` once live (null before). */
  readonly phase: LaunchPhase | null;
  /** `batchOutcome` once live (null before). */
  readonly batch: "pending" | "executed" | "expired" | "empty" | null;
  /** `owner`'s commit (null without `owner` or when it has none). */
  readonly commit: CommitAccount | null;
  /**
   * Signatures of this launch the ledger holds that were never seen landing
   * and whose window has not ended (`findPendingAttestations`); null without
   * `opts.pending` or once the launch is live.
   */
  readonly pendingSignatures: PendingAttestation[] | null;
  /** Plain-English cautions for the UI (an older signature that can still take the slot, and what to do). */
  readonly warnings: string[];
}

/** `getLaunchFlowStatus` options. */
export interface LaunchFlowStatusOptions {
  /** Bigint unix seconds (default: the cluster clock). */
  readonly nowSecs?: bigint | undefined;
  /** SHA-256 of the message this client signed (`plan.messageHash`). */
  readonly expectedMessageHash?: Uint8Array | undefined;
  /** The record this client publishes (`plan.metadataHash`): its absence makes the step `publish`. */
  readonly expectedMetadataHash?: Uint8Array | undefined;
  /** The creator rules this client publishes (`plan.rulesHash`; all zero or omitted: none): a missing record makes the step `publish`. */
  readonly expectedRulesHash?: Uint8Array | undefined;
  /** A committer whose claim decides the `claim` step. */
  readonly owner?: PublicKey | undefined;
  /** The identity's ledger and public key: list the launch's signatures that never landed (`pendingSignatures`). */
  readonly pending?: { readonly ledger: LeafLedger; readonly lmsPublicKey: Uint8Array } | undefined;
}

/** What a window that passed means for older signatures (review info #2), whether or not a ledger was given. */
const OLDER_SIGNATURE_WARNING =
  "An earlier signature for this launch that was sent but never landed can still take its place if its own time window has not ended: land it first (landOrBurnPending) or wait until that window ends.";

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

/** Read the launch, its attestation and the cluster clock, and say which step of the flow comes next. */
export async function getLaunchFlowStatus(conn: Connection, launch: PublicKey, opts: LaunchFlowStatusOptions = {}): Promise<LaunchFlowStatus> {
  if (!(launch instanceof PublicKey)) throw new TypeError("launch must be a PublicKey");
  if (opts.nowSecs !== undefined) checkNowSecs(opts.nowSecs);
  const [account, attestation, nowSecs, commit] = await Promise.all([
    fetchLaunch(conn, launch),
    fetchAttestation(conn, launch),
    opts.nowSecs ?? clusterUnixTime(conn),
    opts.owner === undefined ? Promise.resolve(null) : fetchCommit(conn, launch, opts.owner),
  ]);
  const attestationState = attestation === null ? "none" : attestation.attested ? "attested" : "empty";
  const attested = attestation !== null && attestation.attested ? attestation : null;
  if (opts.expectedMetadataHash !== undefined && (!(opts.expectedMetadataHash instanceof Uint8Array) || opts.expectedMetadataHash.length !== 32)) {
    throw new RangeError("expectedMetadataHash must be 32 bytes");
  }
  if (opts.expectedRulesHash !== undefined && (!(opts.expectedRulesHash instanceof Uint8Array) || opts.expectedRulesHash.length !== 32)) {
    throw new RangeError("expectedRulesHash must be 32 bytes");
  }
  const rulesHashKnown = attested?.rulesHash ?? opts.expectedRulesHash ?? null;
  const rulesHash = rulesHashKnown === null || isAllZero(rulesHashKnown) ? null : rulesHashKnown;
  const rulesPublished = rulesHash === null || account === null ? null : (await fetchLaunchRules(conn, launch, rulesHash)) !== null;
  const recordHash = attested?.metadataHash ?? opts.expectedMetadataHash ?? null;
  const tokenMeta = recordHash === null || account === null ? null : await fetchTokenMeta(conn, launch, recordHash);
  const window = attested === null ? null : { notBefore: attested.notBefore, notAfter: attested.notAfter };
  const attestedMessageMatches = opts.expectedMessageHash === undefined || attested === null ? null : bytesEqual(attested.messageHash, opts.expectedMessageHash);
  const base = {
    launch,
    nowSecs,
    account,
    attestation,
    attestationState,
    attestedMessageMatches,
    tokenMeta,
    metadataPublished: recordHash === null || account === null ? null : tokenMeta !== null,
    rulesPublished,
    window,
    windowIso: window === null ? null : { notBefore: unixToIso(window.notBefore), notAfter: unixToIso(window.notAfter) },
    secondsUntilWindowOpens: window === null ? null : max0(window.notBefore - nowSecs),
    secondsUntilWindowCloses: window === null ? null : max0(window.notAfter - nowSecs),
    commit,
  } as const;
  const pendingSignatures =
    opts.pending === undefined || account === null || account.status !== "configured"
      ? null
      : await findPendingAttestations(conn, { launch, lmsPublicKey: opts.pending.lmsPublicKey, ledger: opts.pending.ledger, nowSecs });
  const done = (
    step: LaunchFlowStep,
    summary: string,
    extra: { canLaunchNow?: boolean; phase?: LaunchPhase | null; batch?: LaunchFlowStatus["batch"]; warnings?: string[] } = {},
  ): LaunchFlowStatus => ({
    ...base,
    step,
    summary,
    canLaunchNow: extra.canLaunchNow ?? false,
    phase: extra.phase ?? null,
    batch: extra.batch ?? null,
    pendingSignatures,
    warnings: extra.warnings ?? [],
  });
  const n = pendingSignatures?.length ?? 0;
  const pendingText = `${n} earlier signature${n === 1 ? "" : "s"} for this launch never landed`;

  if (account === null) return done("create", "No launch at this address yet: the creator's wallet signs create_launch.");
  if (account.status === "configured") {
    if (window === null && opts.expectedMetadataHash !== undefined && tokenMeta === null) {
      return done("publish", "Created: publish the token's metadata record (name, symbol, description, icon), wait until it is final, then the identity attests.");
    }
    if (window === null && rulesPublished === false) {
      return done("publish", "Created: publish the launch rules, wait until they are final, then the identity attests.");
    }
    if (window === null) {
      return done(
        "attest",
        attestationState === "empty"
          ? "A signature only burned its leaf without attesting (wrong identity, a metadata record that was not published, or the window): the identity must attest again."
          : "Created: the creator's post-quantum identity must attest it (after its metadata record is published and final) before it can go live.",
        { warnings: n === 0 ? [] : [`${pendingText} and can still land: land them first (landOrBurnPending), or wait until their windows end; a new signature is refused until then.`] },
      );
    }
    // While the attested window has not ended, older signatures can only burn their leaf: the moment to retire them.
    const retire = n === 0 ? [] : [`${pendingText}: retire them now, while they can only burn their leaf (landOrBurnPending with burnOnly).`];
    if (nowSecs < window.notBefore) return done("wait-for-window", `Attested: anyone may launch it from ${window.notBefore} (unix seconds), in ${window.notBefore - nowSecs} s.`, { warnings: retire });
    if (inLaunchWindow(nowSecs, window.notBefore, window.notAfter)) {
      return done("launch", "Inside the launch window: anyone may launch it now; the first launch transaction to land wins.", { canLaunchNow: true, warnings: retire });
    }
    return done("window-missed", "Window passed: sign a new opening time. Nobody launched it in time, so the creator's identity signs a new window (the same token details can be reused).", {
      warnings: n === 0 ? [OLDER_SIGNATURE_WARNING] : [`${pendingText} and can still take its place: land them first (landOrBurnPending), or wait until their windows end.`, OLDER_SIGNATURE_WARNING],
    });
  }

  const phase = launchPhase(account, nowSecs);
  const batch = batchOutcome(account, nowSecs);
  const extra = { phase, batch };
  if (nowSecs < account.commitEndTs) return done("commit", "Live: the fair-open batch takes commits now.", extra);
  if (!account.executed && nowSecs < account.executeEndTs) {
    return account.totalCommitted > 0n
      ? done("execute", "The commit window closed: anyone may execute the batch now (keepers pay a priority fee).", extra)
      : done("trading", "Nobody committed to the batch: there is nothing to execute or claim.", extra);
  }
  if (account.totalCommitted === 0n) return done("trading", "Nobody committed to the batch: there is nothing to claim.", extra);
  if (opts.owner !== undefined) {
    if (commit === null) return done("trading", "This wallet has no commit in the batch.", extra);
    if (commit.claimed) return done("trading", "This commit has been claimed.", extra);
  }
  return done(
    "claim",
    account.executed ? "The batch executed: claims pay each commit's tokens and unspent SOL to its payout owners." : "Nobody executed the batch in time: claims refund every commit in full.",
    extra,
  );
}

/** `waitForLaunchWindow` options. */
export interface WaitForLaunchWindowOptions {
  readonly signal?: AbortSignal | undefined;
  /** Longest pause between two reads of the cluster clock, in ms (default 5,000). */
  readonly pollIntervalMs?: number | undefined;
  /** Sleep function (default `setTimeout`). */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Step 4: resolve once the CLUSTER clock is inside the attested window
 * (step `launch`), polling it. Throws when the launch is at any step other
 * than `wait-for-window` or `launch` (not attested, missed, already live),
 * and when `signal` aborts.
 */
export async function waitForLaunchWindow(conn: Connection, launch: PublicKey, opts: WaitForLaunchWindowOptions = {}): Promise<LaunchFlowStatus> {
  const poll = opts.pollIntervalMs ?? 5_000;
  if (!Number.isFinite(poll) || poll <= 0) throw new RangeError("pollIntervalMs must be positive");
  const sleep = opts.sleep ?? defaultSleep;
  for (;;) {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error("aborted");
    const s = await getLaunchFlowStatus(conn, launch);
    if (s.step === "launch") return s;
    if (s.step !== "wait-for-window") throw new Error(`not waiting for a launch window: the launch is at step "${s.step}" (${s.summary})`);
    const ms = Math.min(poll, Math.max(250, Number(s.secondsUntilWindowOpens ?? 1n) * 1_000));
    await sleep(ms, opts.signal);
  }
}
