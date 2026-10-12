/**
 * MOCK `verifyLaunch`: the same report the SDK builds, computed from the
 * simulated chain. The SDK never trusts the certificate alone (SPEC §1.5): it
 * re-reads the mint, the DBC config, the hook policy and, after migration,
 * the DAMM v2 position, and lists the third parties that are still trusted.
 */
import {
  attestationAddress,
  certificateAddress,
  CERTIFICATE_ALL_CHECKS,
  CERTIFICATE_CHECKS,
  CERTIFICATE_RULES_BOUND,
  certificateChecksComplete,
  decodeTokenMeta,
  expectedBatchFill,
  extraAccountMetaListAddress,
  hookPolicyAddress,
  identityAddressFromId,
  KNOWN_ACCOUNTS,
  launchPdasFromLaunch,
  launchPhase,
  METADATA,
  MIGRATION_FEE_TIERS_BPS,
  parseMetadataDoc,
  POLICY,
  PROGRAM_IDS,
  tokenMetaAddress,
  TRUST_ANCHORS,
  TRUSTED_PARTIES,
  WSOL_MINT,
  type CheckStatus,
  type ParsedMetadataDoc,
  type PqOrigin,
  type TokenMetaAccount,
  type VerificationCheck,
  type VerificationReport,
  type VerifiedMetadata,
} from "@noisedlabs/sdk";
import type { Connection, PublicKey } from "@solana/web3.js";

import { CERTIFICATE_CHECK_LABELS, certificateCheckCount, countWord } from "../display";
import { bytesEqual, toHex } from "./bytes";
import { chain } from "./chain";
import { attestedRulesOf, isZeroHash } from "./rules";
import { liveLaunchByMint, toLaunchAccount } from "./common";
import { mockMint } from "./mints";
import { latency, nowSecs, tokenBalance } from "./store";

const iso = (ts: bigint): string => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
const whole = (raw: bigint, decimals: number): string => (raw / 10n ** BigInt(decimals)).toLocaleString("en-US");
const sol = (lamports: bigint): string => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
/** `verifyLaunch` warns when the batch may buy less than this share of the migration threshold (SDK `BATCH_CAP_WARN_BPS`). */
const BATCH_CAP_WARN_BPS = 1_000;

export async function verifyLaunch(_conn: Connection, mint: PublicKey): Promise<VerificationReport> {
  // Several independent reads (certificate, launch, mint, config, policy, programs).
  await latency("read");
  await latency("read");
  const s = chain();
  const now = nowSecs();
  const trustedParties = TRUSTED_PARTIES.map((p) => ({ ...p }));
  const l = liveLaunchByMint(s, mint);
  const m = mockMint(s, mint);
  if (!l || !l.certificate || !m) {
    return {
      mint,
      overall: "fail",
      phase: null,
      checks: [
        {
          id: "certificate.exists",
          label: "Noised launch certificate",
          status: "fail",
          detail: `No certificate account at ${certificateAddress(mint).toBase58()}. This mint was not launched by Noised, so none of Noised's guarantees apply to it.${m ? "" : " The mint account does not exist on this cluster."}`,
        },
      ],
      trustedParties,
      certificate: null,
      pqOrigin: null,
      metadata: null,
      rules: null,
    };
  }

  const cert = l.certificate;
  const st = l.state;
  const attestation = s.attestations[l.address.toBase58()];
  // The metadata record the certificate names (the SDK reads it at `certificate.metadata` and decodes it strictly).
  const recordData = s.tokenMetas[cert.metadata.toBase58()];
  let record: TokenMetaAccount | null = null;
  try {
    record = recordData === undefined ? null : decodeTokenMeta(cert.metadata, recordData);
  } catch {
    record = null;
  }
  const pdas = launchPdasFromLaunch(l.address);
  const checks: VerificationCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string): void => {
    checks.push({ id, label, status, detail });
  };
  const ext = <T extends (typeof m.extensions)[number]["type"]>(type: T): Extract<(typeof m.extensions)[number], { type: T }> | undefined =>
    m.extensions.find((e) => e.type === type) as Extract<(typeof m.extensions)[number], { type: T }> | undefined;

  add(
    "certificate.exists",
    "Launch certificate",
    "pass",
    `Certificate ${cert.publicKey.toBase58()} was written by the launchpad at ${iso(cert.launchedAt)}. Certificates are never modified or closed.`,
  );
  const linked = cert.launch.equals(l.address) && st.baseMint.equals(mint) && cert.pool.equals(st.pool) && cert.dbcConfig.equals(st.dbcConfig);
  add(
    "certificate.launch",
    "Certificate, launch and pool belong together",
    linked ? "pass" : "fail",
    linked
      ? `Launch ${l.address.toBase58()} (status live) records this mint, pool ${st.pool.toBase58()} and DBC config ${st.dbcConfig.toBase58()}.`
      : "The certificate does not match the Launch account.",
  );
  add(
    "certificate.policy",
    `Safety policy version ${POLICY.SAFETY_POLICY_VERSION}`,
    cert.policyVersion === POLICY.SAFETY_POLICY_VERSION ? "pass" : "warn",
    `policy_version = ${cert.policyVersion}.`,
  );
  add(
    "certificate.params",
    "Parameters hash matches the launch",
    bytesEqual(cert.paramsHash, st.paramsHash) ? "pass" : "fail",
    `params_hash ${toHex(cert.paramsHash).slice(0, 16)}… (sha256 of the borsh-encoded LaunchParams) equals the Launch account's.`,
  );

  // Every certificate flag, re-checked against live state.
  const hook = ext("TransferHook");
  const graduated = l.curveComplete;
  const pointer = ext("MetadataPointer");
  const metadata = ext("TokenMetadata");
  const extTypes = m.extensions.map((e) => e.type).sort();
  const exact = JSON.stringify(extTypes) === JSON.stringify(["MetadataPointer", "TokenMetadata", "TransferHook"]);
  const live: Record<number, { ok: boolean; detail: string }> = {
    1: { ok: m.mintAuthority === null, detail: "Re-read now: the mint has no mint authority, so the supply can never grow." },
    2: { ok: m.freezeAuthority === null, detail: "Re-read now: the mint has no freeze authority, so no holder can be frozen." },
    4: { ok: metadata !== undefined && metadata.updateAuthority === null, detail: "Re-read now: TokenMetadata update authority is None." },
    8: {
      ok: pointer !== undefined && pointer.authority === null && pointer.address.equals(mint),
      detail: "Re-read now: MetadataPointer authority is None and it points at the mint itself.",
    },
    16: { ok: exact, detail: `Re-read now: extensions are ${extTypes.join(", ")}. No permanent delegate, transfer fee, pause, default state or close authority.` },
    32: {
      ok: hook !== undefined && (graduated ? hook.programId === null && hook.authority === null : hook.programId?.equals(PROGRAM_IDS.hook) === true),
      detail: graduated
        ? "DBC revoked the hook (program and authority None) when the curve completed: the token is now a plain Token-2022 token."
        : `Hook program ${PROGRAM_IDS.hook.toBase58()}; hook authority ${KNOWN_ACCOUNTS.dbcPoolAuthority.toBase58()} (DBC pool authority, which only ever revokes it, at curve completion).`,
    },
    64: {
      ok: true,
      detail: `DBC config ${st.dbcConfig.toBase58()}: partner permanently locked liquidity 100%, every other LP share 0%, no LP vesting.${l.migrated ? " The DAMM v2 position is 100% permanently locked (checked below)." : ""}`,
    },
    128: { ok: true, detail: "DBC config migration fee {fee_percentage: 0, creator_fee_percentage: 0}: the whole raise goes into the pool." },
    256: { ok: true, detail: "DBC config: locked vesting all zero, creator trading fee 0%, first swap with minimum fee disabled." },
    512: { ok: true, detail: `DBC config quote mint ${WSOL_MINT.toBase58()} (no mint or freeze authority).` },
    [CERTIFICATE_CHECKS.PQ_ATTESTED]: {
      ok: attestation !== undefined && attestation.attested && bytesEqual(attestation.pqIdentity, cert.pqIdentity),
      detail: `The launch's post-quantum identity attested it before it went live (leaf ${cert.pqLeaf}, slot ${cert.attestedSlot}); re-verified below.`,
    },
    [CERTIFICATE_CHECKS.METADATA_ONCHAIN]: {
      ok: record !== null && record.launch.equals(l.address),
      detail: `The launch took the token's name and symbol from its on-chain metadata record ${cert.metadata.toBase58()}; re-checked below.`,
    },
  };
  for (const c of CERTIFICATE_CHECK_LABELS) {
    const flag = (cert.checks & c.bit) !== 0;
    const v = live[c.bit] ?? { ok: false, detail: "Unknown check." };
    add(`certificate.bit${c.bit}`, c.label, flag && v.ok ? "pass" : "fail", flag ? v.detail : `Flag ${c.bit} is missing from the certificate (checks = ${cert.checks}).`);
  }
  // The twelve required bits only (`certificateChecksComplete`: `(checks & 4095) === 4095`): a certificate with launch
  // rules also carries the informational RULES_BOUND (8,191), the same report the SDK gives (verifyLaunch).
  const complete = certificateChecksComplete(cert.checks);
  const bound = (cert.checks & CERTIFICATE_RULES_BOUND) !== 0 ? ` It also records RULES_BOUND (${CERTIFICATE_RULES_BOUND}): the program found the creator's signed launch rules in the Launch Guard.` : "";
  add(
    "certificate.checks",
    `All ${countWord(certificateCheckCount())} launch-time checks recorded`,
    complete ? "pass" : "fail",
    complete
      ? `checks = ${cert.checks}: the program verified every flag at launch, the post-quantum attestation and the on-chain metadata included.${bound} Each one is re-checked live below.`
      : `checks = ${cert.checks}: not every required check is recorded; every launch records all twelve (${CERTIFICATE_ALL_CHECKS}).`,
  );

  // The post-quantum origin (the SDK's `pq.origin`). The simulated chain stores the real 189-byte message but runs no
  // LMS verification: a signature it accepted is reported as verified.
  let pqOrigin: PqOrigin | null = null;
  // Attestation v3 / certificate v4: the creator rules the identity signed, read from their record.
  const signedRules = attestedRulesOf(l.address, cert.rulesHash, l.state.guardSecs, l.state.tokenDecimal);
  const pqLabel = "Post-quantum origin: the creator's identity signed this launch (re-verified)";
  if (attestation !== undefined && attestation.attested && bytesEqual(attestation.pqIdentity, cert.pqIdentity) && attestation.leaf === cert.pqLeaf) {
    pqOrigin = {
      attestation: attestationAddress(l.address),
      identity: identityAddressFromId(cert.pqIdentity),
      identityId: Uint8Array.from(cert.pqIdentity),
      lmsPublicKey: null,
      leaf: attestation.leaf,
      attestationSlot: attestation.slot,
      messageHash: Uint8Array.from(attestation.messageHash),
      window: { notBefore: attestation.notBefore, notAfter: attestation.notAfter },
      metadataHash: Uint8Array.from(attestation.metadataHash),
      tokenMeta: tokenMetaAddress(l.address, attestation.metadataHash),
      rules: signedRules.rules,
      signatureValid: true,
      verified: true,
    };
    add(
      "pq.origin",
      pqLabel,
      "pass",
      `Post-quantum identity ${toHex(cert.pqIdentity)} signed this launch, its parameters, its creator and its on-chain metadata record (name, symbol, description, icon) with one-time leaf ${attestation.leaf} (attestation ${pqOrigin.attestation.toBase58()}, slot ${attestation.slot}). It allowed the launch only between ${iso(attestation.notBefore)} and ${iso(attestation.notAfter)}; it launched at ${iso(cert.launchedAt)} (simulated chain).`,
    );
  } else {
    add("pq.origin", pqLabel, "fail", "Not PQ-attested: no attestation of this launch by the identity its certificate names.");
  }

  // The on-chain metadata (the SDK's `metadata.onchain`, `metadata.match` and `metadata.icon`, same order and words).
  let document: ParsedMetadataDoc | null = null;
  const metadataProblems: string[] = [];
  {
    const problems: string[] = [];
    if ((cert.checks & CERTIFICATE_CHECKS.METADATA_ONCHAIN) === 0) problems.push("the certificate does not record the metadata check (METADATA_ONCHAIN)");
    if (record === null) problems.push(`no valid metadata record at ${cert.metadata.toBase58()}, the address the certificate names`);
    else {
      if (pqOrigin === null || !record.publicKey.equals(pqOrigin.tokenMeta)) problems.push("the certificate's record is not the one the attestation signed");
      if (!record.launch.equals(cert.launch)) problems.push("the record belongs to another launch");
    }
    metadataProblems.push(...problems);
    const label = "Metadata stored on-chain";
    if (problems.length > 0 || record === null) add("metadata.onchain", label, "fail", problems.join("; "));
    else {
      const where = `Name, symbol and document are stored in ${record.publicKey.toBase58()}, at the address of their own hash, which the creator's post-quantum identity signed; the record can never change.`;
      if (record.flags === METADATA.FLAG_EXTERNAL_URI) {
        add("metadata.onchain", label, "warn", `${where} The mint's link also points to ${record.uri}, a page the creator chose: what it serves can change and is not checked here.`);
      } else {
        add("metadata.onchain", label, "pass", record.flags === METADATA.FLAG_INLINE_URI ? `${where} The mint's link carries the same document inline.` : `${where} The mint's link is empty: nothing is loaded from elsewhere.`);
      }
    }
  }
  if (record !== null) {
    try {
      document = parseMetadataDoc(record.doc, { name: record.record.name, symbol: record.record.symbol });
    } catch {
      document = null;
    }
    const problems: string[] = [];
    if (l.meta === null) problems.push("the mint's metadata is unreadable");
    else {
      if (l.meta.name !== record.name) problems.push("the mint's name is not the record's");
      if (l.meta.symbol !== record.symbol) problems.push("the mint's symbol is not the record's");
      if (l.meta.uri !== record.tokenUri) problems.push("the mint's link is not the one derived from the record");
    }
    if (document !== null) {
      if (document.name !== null && document.name !== record.name) problems.push(`the document's name "${document.name}" is not the record's`);
      if (document.symbol !== null && document.symbol !== record.symbol) problems.push(`the document's symbol "${document.symbol}" is not the record's`);
    }
    metadataProblems.push(...problems);
    add(
      "metadata.match",
      "Name and symbol match the record",
      problems.length === 0 ? "pass" : "fail",
      problems.length === 0 ? `The token is "${record.name}" (${record.symbol}) in the mint, in the record and in its document.` : problems.join("; "),
    );
    const d = document;
    const iconLabel = "Icon is an inline PNG";
    if (d === null) add("metadata.icon", iconLabel, "warn", "The record's document could not be read.");
    else if (d.empty) add("metadata.icon", iconLabel, "pass", "The record has no document: no icon or description, and nothing is loaded from elsewhere.");
    else if (!d.ok) add("metadata.icon", iconLabel, "warn", `The record's document is not shown: ${d.problems.join("; ")}.`);
    else if (d.icon === null) add("metadata.icon", iconLabel, "pass", "No icon: the record's document has none, and nothing is loaded from elsewhere.");
    else add("metadata.icon", iconLabel, "pass", `The icon is a ${d.icon.width}x${d.icon.height} PNG stored inside the record (${d.icon.png.length} bytes); it is never loaded from a link.`);
  }
  const verifiedMetadata: VerifiedMetadata = {
    address: cert.metadata,
    record,
    document,
    verified: record !== null && pqOrigin !== null && metadataProblems.length === 0,
  };

  add(
    "dbc.config",
    "DBC config holds the fixed safe values",
    "pass",
    `Quote wSOL, Token-2022 base, immutable token metadata (update authority option 1), migration to DAMM v2, quote-only fee collection, timestamp activation, dynamic supply, no pool-creation fee, fee claimer and leftover receiver = launch authority ${pdas.launchAuthority.toBase58()}.`,
  );

  if (!graduated) {
    const caps = [
      cert.maxWallet === 0n ? "max wallet off" : `max wallet ${whole(cert.maxWallet, st.tokenDecimal)} tokens`,
      cert.maxBuy === 0n ? "max buy off" : `max buy ${whole(cert.maxBuy, st.tokenDecimal)} tokens`,
      cert.p2pLocked ? "wallet-to-wallet transfers paused" : "wallet-to-wallet transfers allowed",
    ].join(", ");
    add(
      "hook.policy",
      "Launch Guard policy matches the certificate",
      "pass",
      `Policy ${hookPolicyAddress(mint).toBase58()}: no buys before ${iso(cert.snipeShieldEndTs)} except the batch buy inside the launchpad's execute_batch; until ${iso(cert.guardEndTs)}: ${caps}. Only the batch and launch authorities are exempt from the caps (never from the snipe shield); sells are never blocked.`,
    );
    add(
      "hook.metaList",
      "Hook account list is the canonical one",
      "pass",
      `Meta list ${extraAccountMetaListAddress(mint).toBase58()}: Token-2022 passes exactly two extra accounts to the hook, the mint's policy PDA and the instructions sysvar (read to recognize the batch buy).`,
    );
  }

  add(
    "fees.routing",
    "Fee routing is fixed",
    "pass",
    `${st.recipientCount} recipient(s) and a ${st.platformFeeBps / 100}% platform share, identical in the certificate and the Launch account. No instruction can change them.`,
  );

  const threshold = st.migrationQuoteThreshold;
  const capBps = threshold === 0n ? 0 : Number((st.batchTotalCap * BigInt(POLICY.BPS_DENOMINATOR)) / threshold);
  const capWhat = `The batch buys at most ${sol(st.batchTotalCap)}, ${capBps / 100}% of the ${sol(threshold)} migration threshold`;
  add(
    "batch.cap",
    "Fair-open batch cap",
    capBps < BATCH_CAP_WARN_BPS ? "warn" : "pass",
    capBps < BATCH_CAP_WARN_BPS
      ? `${capWhat}: below ${BATCH_CAP_WARN_BPS / 100}%, most of the curve is left to buyers after the batch. Commits above the cap are filled pro rata and the rest refunded.`
      : `${capWhat}; commits above the cap are filled pro rata and the rest refunded at claim.`,
  );

  const spendable = st.totalCommitted < st.batchTotalCap ? st.totalCommitted : st.batchTotalCap;
  const tokensOk = st.tokensClaimed <= st.tokensOut;
  const unspent = st.executed ? st.totalCommitted - st.quoteSpent : st.totalCommitted;
  const quoteOk = st.quoteRefunded <= unspent && st.quoteSpent <= spendable;
  const escrowOk = tokenBalance(s, pdas.batchAuthority, mint) >= st.tokensOut - st.tokensClaimed;
  const fill = expectedBatchFill(st);
  const share = `${fill.fillBps / 100}% of each commit`;
  add(
    "batch.accounting",
    "Fair-open batch accounting",
    tokensOk && quoteOk && escrowOk ? "pass" : "fail",
    st.executed
      ? `The batch bought ${whole(st.tokensOut, st.tokenDecimal)} tokens for ${sol(st.quoteSpent)} of ${sol(st.totalCommitted)} committed in one swap (${share} spent, the rest refunded at claim); ${whole(st.tokensClaimed, st.tokenDecimal)} tokens claimed so far. Payouts stay within what the escrow holds.`
      : BigInt(now) >= st.executeEndTs && st.totalCommitted > 0n
        ? `Nobody executed the batch in its window: every commit (${sol(st.totalCommitted)} in total) is refundable in full.`
        : fill.oversubscribed
          ? `Batch pending and oversubscribed: ${sol(st.totalCommitted)} committed for a cap of ${sol(st.batchTotalCap)}; at most ${share} will be spent, the rest refunded at claim.`
          : `Batch pending: ${sol(st.totalCommitted)} committed (cap ${sol(st.batchTotalCap)}).`,
  );
  if (!st.executed && !graduated) {
    add(
      "batch.firstSwap",
      "The fair-open batch is still the pool's first trade",
      l.hasSwap ? "warn" : "pass",
      !l.hasSwap
        ? "Nobody has traded on the pool yet: the batch buys at the opening price."
        : BigInt(now) < st.executeEndTs
          ? "The pool was traded before the batch, which the Launch Guard should have prevented: execute_batch now fails (PoolAlreadyTraded) and every commit is refunded in full after the execution window."
          : "The pool was traded and the batch did not execute: every commit is refundable in full.",
    );
  }

  if (graduated && !l.migrated) {
    add("damm.migration", "Graduation pending", "pass", "The curve completed. Anyone can now call DBC's permissionless migration to DAMM v2.");
  }
  if (l.migrated && l.dammPool) {
    add(
      "damm.lock",
      "Graduated liquidity is permanently locked",
      "pass",
      `DAMM v2 pool ${l.dammPool.toBase58()}: the LP position is owned by the launch authority PDA and 100% of it is permanently locked. Nobody can withdraw it.`,
    );
    add(
      "damm.status",
      "DAMM v2 pool is enabled",
      l.dammStatus === "enabled" ? "pass" : "warn",
      l.dammStatus === "enabled"
        ? "Trading is enabled."
        : "A DAMM v2 operator disabled this pool: swaps stopped, and the locked liquidity can never be withdrawn by anyone.",
    );
    const tier = MIGRATION_FEE_TIERS_BPS[st.migrationFeeOption] ?? l.dammTierBps;
    add(
      "damm.fee",
      "Pool fee is the tier chosen at launch",
      l.dammFeeBps === tier ? "pass" : "warn",
      l.dammFeeBps === tier
        ? `${tier / 100}% fee tier, as chosen at launch.`
        : `The pool charges ${l.dammFeeBps / 100}% but the launch chose the ${tier / 100}% tier: a DAMM v2 operator raised it. DAMM v2 allows this (up to 10%). See "Who you still trust".`,
    );
  }

  add(
    "meteora.programs",
    "Meteora programs are the reviewed deployments",
    "pass",
    `DBC last deployed at slot ${TRUST_ANCHORS.dbcLastDeploySlot.toLocaleString("en-US")} and DAMM v2 at slot ${TRUST_ANCHORS.dammV2LastDeploySlot.toLocaleString("en-US")} (the reviewed deployments; simulated chain). Both stay upgradeable by Meteora's multisig ${TRUST_ANCHORS.meteoraMultisig.toBase58()}.`,
  );

  const overall: CheckStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return {
    mint,
    overall,
    phase: launchPhase(toLaunchAccount(l), BigInt(now)),
    checks,
    trustedParties,
    certificate: { ...cert, recipients: cert.recipients.map((r) => ({ ...r })) },
    pqOrigin,
    metadata: verifiedMetadata,
    // The hook holds exactly the attested rules (the simulated chain enforces the bound set, nothing else).
    rules: { ...signedRules.rules, boundInPolicy: true, verified: isZeroHash(cert.rulesHash) || signedRules.record !== null },
  };
}
