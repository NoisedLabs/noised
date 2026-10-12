/**
 * MOCK programmable launches (PROGRAMMABLE_V1 §2-§4) on the simulated chain:
 * published rule sets (`publish_rules`), the rules an attestation binds
 * (attestation v3), autopilot accounts and their treasuries, published
 * graphs, quantum authorizations (`pq_authorize`), activation with the 72 h
 * update timelock, freeze, operator revocation and `run` with keeper tips.
 *
 * It is never more permissive than the programs (review U5, U7, U9, U10, U13,
 * U16). Every decision follows programs/noised-autopilot (logic.rs,
 * governance.rs, run.rs, reference.rs, price.rs) in its order:
 *   - rule sets and graphs are verified with the SDK's verifiers (byte-exact
 *     with the Rust crate); the hook enforces only the rule set the
 *     attestation binds, and `launch` refuses while that set is missing;
 *   - `pq_authorize` accepts only the launch's own quantum identity: the LMS
 *     signature over the 140-byte message is verified for real, and its
 *     one-time key is spent in the identity's shared leaf bitmap;
 *   - authorizations are used at most once and in order (`check_fresh`: by
 *     slot, then address); a replacement waits until 72 hours after both the
 *     authorization and the activation landed (`check_activation`);
 *   - `run`: an operator-controlled step needs the operator as a separate
 *     signer and an amount; a keeper may pick a smaller buyback down to 1% of
 *     the pool's SOL; the reference price starts at the launch's migration
 *     price and moves only as the program's observations allow (the SDK's
 *     exact mirror); a buyback refuses when the pool returns less than the
 *     minimum the bound and the premium price (SwapShortfall); a payout pays
 *     the floor of each share and the dust stays in the treasury.
 *
 * SDK 0.9.0 (audit 4), as the programs now decide:
 *   - removing the operator signs payload v3: it names the activation in
 *     force (`active_auth`, set by `apply_pending`);
 *   - a keeper's partial buyback spends part of a step's run (`partial_spent`
 *     per node): the step stays due for the rest, must leave at least the
 *     keeper floor of it (RemainderTooSmall, 6041) and earns its share of a
 *     tip; a burn's tip values its tokens at the burn price (nothing before
 *     graduation, then the lower of the reference and the lowest observed);
 *   - a payout pays only recipients that have a wSOL account (the others are
 *     skipped and their share stays in the treasury) and refuses when none
 *     can receive (NoRecipientAccount, 6042); nobody pays to create theirs;
 *   - the quantum signature of an authorization runs the SDK's guards
 *     (mock/guard.ts): the clock for a time it signs, a freeze at most 24
 *     hours long, the cap on signatures that never landed, the signing lock,
 *     and the leaf choice that refuses a key used elsewhere.
 *
 * Demo limits: the demo's keeper checks graduated pools' prices every five
 * minutes (anyone may call `update_price`) and applies a due scheduled change
 * (anyone may call `apply_pending`).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  afterObservation,
  AUTOPILOT,
  autopilotErrorCode,
  burnPrice,
  checkActivation,
  checkApply,
  checkFresh,
  compileGraph,
  compileRules,
  decompileGraph,
  evaluateRuleSet,
  graphHash,
  lowestObserved,
  makeNode,
  newAutopilotState,
  nodeStatus,
  observePrice,
  planMaxTip,
  planPartial,
  planRun as sdkPlanRun,
  planSpent,
  planValue,
  recordRunRaw,
  rulesHash,
  storePriceState,
  takeTipRaw,
  verifyGraph,
  verifyGraphBytes,
  verifyRules,
  verifyRulesBytes,
  type AutopilotEnv,
  type AutopilotErrorName,
  type AutopilotState,
  type Graph,
  type NodeRuntime,
  type ObsBucket,
  type PriceState,
  type RawNodeState,
  type RuleSet,
  type RunPlan,
} from "@noisedlabs/sdk/programmable";
import {
  authorizationAddress,
  autopilotAddress as sdkAutopilotAddress,
  autopilotTreasuryAddress,
  explainProgramError,
  graphRecordAddress,
  identityAddressFromId,
  FREEZE_MAX_VALID_SECS,
  KNOWN_ACCOUNTS,
  leafLedger,
  lms,
  MAX_UNLANDED_SIGNATURES,
  PQ_IDENTITY,
  pqIdentity,
  PROGRAM_IDS,
  SignatureCapError,
  WSOL_MINT,
  type GraphRecipientsCheck,
  type LeafLedger,
  type PqIdentity,
  type RunCosts,
} from "@noisedlabs/sdk";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection, type Keypair, type Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";

import type { AuthorizationInfo, AutopilotInfo, AutopilotRun, AutopilotSetupCost, DueStep, LaunchRulesInfo, ProgrammableBackend, RulesRecord, SignGuardOptions } from "../backend/programmable";
import { activationPayload, authMessage, AUTH_KIND, expectedRunTip, freezePayload, revokePayload } from "../programmable";
import { bytesEqual, toHex, utf8 } from "./bytes";
import { chain } from "./chain";
import { demoRuleSet } from "./demoRules";
import { countsAsUnlanded, mockCheckClockSkew, withSigningLock } from "./guard";
import { installAttestationRules, installCustomRules, installFeeSink, runtime } from "./common";
import { budgetedTx } from "./ix";
import { demoKey } from "./keys";
import { applySwap, currentFeeBps, simulateSwap, sqrtPriceQ64 } from "./market";
import { tokenRecipientCheck } from "./recipients";
import { LAMPORTS_PER_SIGNATURE, register, send, type SimFailure } from "./sim";
import { addTokens, deserialize, latency, mockEvents, nowSecs, persist, serialize, tokenAccountExists, type MockLaunch, type MockState } from "./store";

// ------------------------------------------------------------ program ids ---

/** The autopilot program (PROGRAM_IDS.autopilot): the simulated chain derives the same addresses as the SDK. */
export const AUTOPILOT_PROGRAM = PROGRAM_IDS.autopilot;

const seed = (s: string): Uint8Array => utf8(s);
const pda = (seeds: Uint8Array[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

export const autopilotAddress = (launch: PublicKey): PublicKey => sdkAutopilotAddress(launch);
export const treasuryAddress = (launch: PublicKey): PublicKey => autopilotTreasuryAddress(launch);
const graphAddress = (launch: PublicKey, hash: Uint8Array): PublicKey => graphRecordAddress(launch, hash);
const rulesAddress = (launch: PublicKey, hash: Uint8Array): PublicKey => pda([seed("rules"), launch.toBytes(), hash], PROGRAM_IDS.launchpad);
export const authAddress = (launch: PublicKey, kind: number, payload: Uint8Array): PublicKey => authorizationAddress(launch, kind, payload);

/** Anchor-style instruction data: sha256("global:<name>")[0..8] || args. */
function ixData(name: string, args: Uint8Array = new Uint8Array(0)): Buffer {
  const d = sha256(utf8(`global:${name}`)).subarray(0, 8);
  const out = new Uint8Array(8 + args.length);
  out.set(d, 0);
  out.set(args, 8);
  return Buffer.from(out);
}

const u16le = (v: number): Uint8Array => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);

function i64le(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const ZERO32 = new Uint8Array(32);
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

// ------------------------------------------------------------------ state ---

/** The latest authorization used of one kind (governance.rs `AuthMark`): ordered by slot, then address. */
interface AuthMark {
  slot: number;
  key: string;
}

interface MockAutopilot {
  launch: PublicKey;
  graphHash: Uint8Array | null;
  /** A queued graph, with the authorization that activated it (`auth`: it becomes `activeAuth` when applied). */
  pending: { graphHash: Uint8Array; activateAt: number; authorizedAt: number; operator: string | null; auth?: string } | null;
  frozen: boolean;
  operator: string | null;
  /**
   * The authorization that activated the running graph (state.rs `active_auth`, audit 4 A4-S; set by apply_pending).
   * Absent in demo state saved before SDK 0.9.0: the last activation used (`authMarks[0]`) is then the one in force.
   */
  activeAuth?: string | null;
  /** What keepers' partial buybacks moved of each node's open run (state.rs `partial_spent`, audit 4 A4-2; absent: all 0). */
  partialSpent?: bigint[];
  /** activate, freeze, revoke (state.rs `auth_marks`). */
  authMarks: [AuthMark, AuthMark, AuthMark];
  nodes: NodeRuntime[];
  /** Run counter of the keeper model (AFTER triggers compare sequence numbers). */
  seq: number;
  /** The reference price: seeded with the launch's migration price, then moved by observations only. */
  refSqrtPrice: bigint;
  refUpdatedAt: number;
  observations: ObsBucket[];
  refAllowance: bigint;
  refAllowanceAt: number;
  /** When the demo's keeper last checked the pool price (every 5 minutes, after graduation). */
  watchedAt: number;
  tipsInEpoch: bigint;
  tipEpochStart: number;
  treasurySol: bigint;
  treasuryTokens: bigint;
  totalBurned: bigint;
  totalBoughtWithSol: bigint;
  totalPaid: bigint;
  totalTips: bigint;
}

interface MockAuth {
  kind: number;
  payloadHash: Uint8Array;
  unixTime: number;
  slot: number;
  address: string;
}

interface ProgState {
  version: 2;
  /** The core demo chain this state belongs to (a reset of it re-seeds this state too). */
  seededFor: string;
  /** Published rule sets by `${launch}:${hashHex}`. */
  rules: Record<string, { bytes: Uint8Array; hash: Uint8Array; publishedAt: number }>;
  /** rules_hash bound by each launch's landed attestation (v3; zero: no custom rules). */
  attestedRules: Record<string, Uint8Array>;
  /** The rules hash each signed attestation message binds, by message hash (the v3 message's rules_hash field). */
  boundByMessage: Record<string, { launch: string; rulesHash: Uint8Array }>;
  autopilots: Record<string, MockAutopilot>;
  /** Published graphs by `${launch}:${hashHex}`. */
  graphs: Record<string, Uint8Array>;
  /** pq_authorize records by `${launch}:${kind}:${payloadHex}`. */
  auths: Record<string, MockAuth>;
  runs: Record<string, AutopilotRun[]>;
  /**
   * wSOL `distribute` paid to a launch's Autopilot treasury before its autopilot account existed (lamports, by launch):
   * the treasury's wSOL account holds it, and the autopilot spends it once created.
   */
  treasuryCredits?: Record<string, bigint>;
}

const STORAGE_KEY = "noised.demo-chain.programmable.v2";
let current: ProgState | null = null;

function emptyState(seededFor: string): ProgState {
  return { version: 2, seededFor, rules: {}, attestedRules: {}, boundByMessage: {}, autopilots: {}, graphs: {}, auths: {}, runs: {} };
}

const chainId = (s: MockState): string => `${s.seededAt}`;

function load(): ProgState {
  const s = chain();
  if (current && current.seededFor === chainId(s)) return current;
  try {
    const text = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    if (text !== null) {
      const parsed = deserialize<ProgState>(text);
      if (parsed.version === 2 && parsed.seededFor === chainId(s)) {
        current = parsed;
        return current;
      }
    }
  } catch {
    // Corrupt or blocked storage: re-seed below.
  }
  current = seedProgrammable(s);
  save();
  return current;
}

function save(): void {
  if (!current) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, serialize(current));
  } catch {
    // Storage blocked or full: the demo still works in memory.
  }
}

// Every landed transaction and every demo step changes the core chain: keep this state with it.
mockEvents.addEventListener("change", save);

/** Only for tests: start from a fresh seed of the current chain. */
export function resetProgrammableForTests(): void {
  current = null;
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/** Only for tests: put SOL / tokens in a launch's treasury (on chain, fees reach it through `distribute`). */
export function fundTreasuryForTests(launch: PublicKey, sol: bigint, tokens: bigint): void {
  const ap = load().autopilots[launch.toBase58()];
  if (!ap) throw new Error("no autopilot");
  ap.treasurySol += sol;
  ap.treasuryTokens += tokens;
}

/**
 * Only for tests: the autopilot's reference price, its observations and rise allowance (as a scenario needs them);
 * `watch: false` stops the demo keeper from checking the price.
 */
export function setPriceStateForTests(launch: PublicKey, refSqrtPriceQ64: bigint, opts: { observations?: ObsBucket[]; watch?: boolean; at?: number } = {}): void {
  const ap = load().autopilots[launch.toBase58()];
  if (!ap) throw new Error("no autopilot");
  ap.refSqrtPrice = refSqrtPriceQ64;
  ap.observations = (opts.observations ?? []).map((b) => ({ ...b }));
  ap.refAllowance = 0n;
  ap.refAllowanceAt = opts.at ?? nowSecs();
  ap.refUpdatedAt = opts.at ?? nowSecs();
  ap.watchedAt = opts.watch === false ? Number.MAX_SAFE_INTEGER : (opts.at ?? nowSecs()) - ((opts.at ?? nowSecs()) % 300);
}

/** Only for tests: a snapshot of an autopilot's governance state. */
export function governanceForTests(launch: PublicKey): { authMarks: AuthMark[]; pending: MockAutopilot["pending"]; operator: string | null; frozen: boolean } | null {
  const ap = load().autopilots[launch.toBase58()];
  return ap ? { authMarks: ap.authMarks.map((m) => ({ ...m })), pending: ap.pending === null ? null : { ...ap.pending }, operator: ap.operator, frozen: ap.frozen } : null;
}

const key = (launch: PublicKey | string, hash: Uint8Array): string => `${typeof launch === "string" ? launch : launch.toBase58()}:${toHex(hash)}`;
const authKey = (launch: PublicKey, kind: number, payload: Uint8Array): string => `${launch.toBase58()}:${kind}:${toHex(payload)}`;

function launchOf(s: MockState, launch: PublicKey): MockLaunch {
  const l = s.launches[launch.toBase58()];
  if (!l) throw new Error(`launch ${launch.toBase58()} does not exist`);
  return l;
}

/** Autopilot refusals, in the program's words (error names are the program's, error.rs). */
/** An autopilot refusal: the program's error (its IDL names and explains it), as the program would return it. */
const apFail = (name: AutopilotErrorName): SimFailure => ({ kind: "program", program: AUTOPILOT_PROGRAM, code: autopilotErrorCode(name) });
const lpFail = (name: string, why: string): SimFailure => runtime(`Noised launchpad: ${name}. ${why}`);

/** The thrown form of a refusal at build time (the same words the chain would log). */
function refusal(f: SimFailure): Error {
  if (f.kind === "runtime") return new Error(f.message);
  const e = explainProgramError(f.program.toBase58(), f.code);
  return new Error(e === null ? `refused (custom error ${f.code})` : `Noised Autopilot: ${e.name}. ${e.message}`);
}

// --------------------------------------------------------- reference seed ---

/**
 * The launch's migration price (sqrt Q64): where its curve ends and its locked pool opens, out of anyone's reach (the
 * program reads it from the DBC config). The simulated market is a constant-product curve, so it is the price at which
 * the curve holds the migration threshold.
 */
export function migrationSqrtPrice(l: MockLaunch): bigint {
  const x = Number(l.virtualQuote + l.quoteReserve);
  const y = Number(l.baseReserve);
  if (!(x > 0) || !(y > 0)) return 0n;
  const k = x * y;
  const xm = Number(l.virtualQuote + l.state.migrationQuoteThreshold);
  const price = (xm * xm) / k;
  if (!(price > 0) || !Number.isFinite(price)) return 0n;
  return BigInt(Math.round(Math.sqrt(price) * 2 ** 32)) * (1n << 32n);
}

// ---------------------------------------------------------------- keepers ---

/** The demo's keeper applies a scheduled change once its time has come (apply_pending is permissionless). */
function advanceAutopilots(p: ProgState, now: number): boolean {
  let changed = false;
  for (const ap of Object.values(p.autopilots)) {
    if (ap.pending !== null && !ap.frozen && now >= ap.pending.activateAt + 20) {
      applyPending(p, ap);
      changed = true;
    }
  }
  return changed;
}

/** apply_pending (governance.rs): the queued graph becomes the active one, with fresh node states and its queued operator. */
function applyPending(p: ProgState, ap: MockAutopilot): void {
  if (ap.pending === null) return;
  const bytes = p.graphs[key(ap.launch, ap.pending.graphHash)];
  ap.graphHash = ap.pending.graphHash;
  ap.operator = ap.pending.operator;
  // The activation in force: a removal of the operator names it (revoke payload v3).
  ap.activeAuth = ap.pending.auth ?? ap.authMarks[0].key;
  ap.pending = null;
  ap.nodes = bytes ? freshNodes(decompileGraph(bytes), ap.refSqrtPrice) : [];
  ap.partialSpent = [];
}

/** The authorization that activated the running graph (null: none is running). */
function activeAuthOf(ap: MockAutopilot): PublicKey | null {
  if (ap.graphHash === null) return null;
  const k = ap.activeAuth ?? ap.authMarks[0].key;
  return k === null || k === PublicKey.default.toBase58() ? null : new PublicKey(k);
}

function prog(): ProgState {
  const p = load();
  if (advanceAutopilots(p, nowSecs())) {
    save();
    persist();
  }
  return p;
}

// ---------------------------------------------------------- custom rules ---

// Fees `distribute` pays to a launch's own Autopilot treasury reach what its autopilot spends (its wSOL account).
installFeeSink((_st, launch, wallet, lamports) => {
  if (!wallet.equals(treasuryAddress(new PublicKey(launch)))) return false;
  const p = load();
  const ap = p.autopilots[launch];
  if (ap) ap.treasurySol += lamports;
  else (p.treasuryCredits ??= {})[launch] = (p.treasuryCredits[launch] ?? 0n) + lamports;
  return true;
});

/** The hook's custom-rules step on the simulated chain: the attested, published rules, evaluated LAST. */
installCustomRules((l, now, t) => {
  const p = load();
  const bound = p.attestedRules[l.address.toBase58()];
  if (!bound || isZero(bound)) return null;
  const rec = p.rules[key(l.address, bound)];
  if (!rec) return null;
  const raw = verifyRulesBytes(rec.bytes, { guardSecs: l.state.guardSecs });
  const out = evaluateRuleSet(raw, {
    nowRel: now - Number(l.state.launchTs),
    isBuy: t.isBuy,
    // Neither side is the pool (exempt protocol accounts never reach the rules).
    isP2p: !t.isBuy && !t.isSell,
    amount: t.amount,
    destBalanceAfter: t.destinationBalanceAfter,
    supply: l.initialSupply,
    destOwner: (t.destinationOwner ?? PublicKey.default).toBase58(),
    srcOwner: (t.sourceOwner ?? PublicKey.default).toBase58(),
    topProgram: (t.topProgram ?? PublicKey.default).toBase58(),
    txIxCount: t.txIxCount ?? 1,
  });
  return out.ok ? null : { rule: out.index, code: out.code };
});

// Attestation v3: the rules hash a signed message binds; the attestation attests only when that set is published, and
// `launch` refuses while it is missing (review U7).
/** The rules hash an attestation binds: its v3 message's own, else (older demo flows) the one recorded for its message hash. */
function boundRules(p: ProgState, launch: string, messageHash: Uint8Array, rulesHash: Uint8Array): Uint8Array {
  if (!isZero(rulesHash)) return Uint8Array.from(rulesHash);
  const b = p.boundByMessage[toHex(messageHash)];
  return b !== undefined && b.launch === launch ? Uint8Array.from(b.rulesHash) : new Uint8Array(32);
}

installAttestationRules({
  attestOk: (_st, launch, messageHash, rulesHash) => {
    const p = load();
    const bound = boundRules(p, launch, messageHash, rulesHash);
    return isZero(bound) || p.rules[key(launch, bound)] !== undefined;
  },
  onAttested: (_st, launch, messageHash, rulesHash) => {
    const p = load();
    p.attestedRules[launch] = boundRules(p, launch, messageHash, rulesHash);
  },
  rulesRecord: (launch, rulesHash) => {
    const rec = load().rules[key(launch, rulesHash)];
    return rec === undefined ? null : Uint8Array.from(rec.bytes);
  },
  launchCheck: (_st, launch) => {
    const p = load();
    const bound = p.attestedRules[launch];
    if (bound === undefined || isZero(bound)) return null;
    return p.rules[key(launch, bound)] === undefined ? lpFail("RulesNotPublished", "The launch rules the creator's quantum key signed are not published, so the launch can't open.") : null;
  },
});

// ------------------------------------------------------------------ reads ---

function recordOf(launch: PublicKey, rec: { bytes: Uint8Array; hash: Uint8Array; publishedAt: number }): RulesRecord {
  return { address: rulesAddress(launch, rec.hash), hash: rec.hash, bytes: Uint8Array.from(rec.bytes), publishedAt: rec.publishedAt };
}

async function fetchLaunchRules(_conn: Connection, launch: PublicKey): Promise<LaunchRulesInfo> {
  await latency("read");
  const s = chain();
  const p = prog();
  const l = launchOf(s, launch);
  const a = s.attestations[launch.toBase58()];
  const attested = p.attestedRules[launch.toBase58()] ?? (a?.attested === true ? new Uint8Array(32) : null);
  // Only the record of exactly the attested hash: never another published set (publish_rules is permissionless).
  const rec = attested !== null && !isZero(attested) ? p.rules[key(launch, attested)] : undefined;
  return {
    attestedHash: attested === null ? null : Uint8Array.from(attested),
    record: rec ? recordOf(launch, rec) : null,
    bound: rec !== undefined && verifyRules(rec.bytes, { guardSecs: l.state.guardSecs }).ok,
    guardSecs: l.state.guardSecs,
    openedAt: l.state.status === "live" ? Number(l.state.launchTs) : null,
  };
}

async function fetchRulesRecord(_conn: Connection, launch: PublicKey, hash: Uint8Array): Promise<RulesRecord | null> {
  await latency("read");
  const rec = prog().rules[key(launch, hash)];
  return rec ? recordOf(launch, rec) : null;
}

/** Size of a rule set's record: discriminator, version, bump, launch, hash and the bytes (borsh Vec). */
const rulesRecordSize = (len: number): number => 8 + 1 + 1 + 32 + 32 + 4 + len;
const rentOf = (size: number): bigint => BigInt(128 + size) * 6_960n;

function infoOf(s: MockState, ap: MockAutopilot): AutopilotInfo {
  const l = s.launches[ap.launch.toBase58()];
  return {
    address: autopilotAddress(ap.launch),
    launch: ap.launch,
    mint: l && l.state.status === "live" ? l.state.baseMint : null,
    treasury: treasuryAddress(ap.launch),
    graphHash: ap.graphHash,
    pending: ap.pending === null ? null : { graphHash: ap.pending.graphHash, activateAt: ap.pending.activateAt, authorizedAt: ap.pending.authorizedAt, operator: ap.pending.operator === null ? null : new PublicKey(ap.pending.operator) },
    frozen: ap.frozen,
    operator: ap.operator === null ? null : new PublicKey(ap.operator),
    activeAuth: activeAuthOf(ap),
    nodes: ap.nodes.map((n) => ({ lastRun: n.lastRun, runsInEpoch: n.runsInEpoch, spentInEpoch: n.spentInEpoch, epochStart: n.epochStart })),
    refSqrtPrice: ap.refSqrtPrice,
    refUpdatedAt: ap.refUpdatedAt,
    tipsInEpoch: ap.tipsInEpoch,
    tipEpochStart: ap.tipEpochStart,
    treasurySol: ap.treasurySol,
    treasuryTokens: ap.treasuryTokens,
    totalBurned: ap.totalBurned,
    totalBoughtWithSol: ap.totalBoughtWithSol,
    totalPaid: ap.totalPaid,
    totalTips: ap.totalTips,
    graduated: l?.migrated === true,
    spotSqrtPrice: l ? sqrtPriceQ64(l) : 0n,
    poolSol: l?.migrated === true ? l.quoteReserve : 0n,
    poolFeeBps: l ? currentFeeBps(l) : 100,
    decimals: l?.state.tokenDecimal ?? 6,
  };
}

async function fetchAutopilot(_conn: Connection, launch: PublicKey): Promise<AutopilotInfo | null> {
  await latency("read");
  const s = chain();
  const ap = prog().autopilots[launch.toBase58()];
  if (!ap) return null;
  watchPrice(s, ap, nowSecs());
  return infoOf(s, ap);
}

async function fetchMigrationPrice(_conn: Connection, launch: PublicKey): Promise<bigint | null> {
  await latency("read");
  const l = chain().launches[launch.toBase58()];
  const p = l ? migrationSqrtPrice(l) : 0n;
  return p > 0n ? p : null;
}

async function fetchGraphBytes(_conn: Connection, launch: PublicKey, hash: Uint8Array): Promise<Uint8Array | null> {
  await latency("read");
  const b = prog().graphs[key(launch, hash)];
  return b ? Uint8Array.from(b) : null;
}

async function listAutopilotRuns(_conn: Connection, launch: PublicKey): Promise<AutopilotRun[]> {
  await latency("read");
  return [...(prog().runs[launch.toBase58()] ?? [])].sort((a, b) => b.unixTime - a.unixTime);
}

async function fetchAuthorization(_conn: Connection, launch: PublicKey, kind: number, payloadHash: Uint8Array): Promise<AuthorizationInfo | null> {
  await latency("read");
  const a = prog().auths[authKey(launch, kind, payloadHash)];
  return a ? { address: new PublicKey(a.address), kind: a.kind, payloadHash: a.payloadHash, unixTime: a.unixTime, slot: a.slot } : null;
}

async function fetchIdentityLeaves(_conn: Connection, pqId: Uint8Array): Promise<Uint8Array> {
  await latency("read");
  const used = chain().identities[identityAddressFromId(pqId).toBase58()]?.used;
  return used ? Uint8Array.from(used) : new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN);
}

/** The active graph of an autopilot (null when none, or its bytes are missing). */
function activeGraph(p: ProgState, ap: MockAutopilot): Graph | null {
  if (ap.graphHash === null) return null;
  const b = p.graphs[key(ap.launch, ap.graphHash)];
  return b ? decompileGraph(b) : null;
}

/** The SDK's keeper model of an autopilot (a copy), with the stored operator. */
function stateOf(ap: MockAutopilot): AutopilotState {
  return {
    nodes: ap.nodes.map((n) => ({ ...n })),
    seq: ap.seq,
    refSqrtPriceQ64: ap.refSqrtPrice,
    tipsInEpoch: ap.tipsInEpoch,
    tipEpochStart: ap.tipEpochStart,
    observations: ap.observations.map((b) => ({ ...b })),
    refAllowance: ap.refAllowance,
    refAllowanceAt: ap.refAllowanceAt,
    refUpdatedAt: ap.refUpdatedAt,
    operator: ap.operator,
    partialSpent: ap.nodes.map((_, i) => ap.partialSpent?.[i] ?? 0n),
  };
}

/** Writes the reference price, its allowance and the observations of `st` back. */
function storePrice(ap: MockAutopilot, st: AutopilotState): void {
  ap.refSqrtPrice = st.refSqrtPriceQ64;
  ap.refUpdatedAt = st.refUpdatedAt ?? ap.refUpdatedAt;
  ap.observations = (st.observations ?? []).map((b) => ({ ...b }));
  ap.refAllowance = st.refAllowance ?? 0n;
  ap.refAllowanceAt = st.refAllowanceAt ?? 0;
}

/** Node states as the program stores them (exact integers). */
const rawOf = (n: NodeRuntime): RawNodeState => ({ lastRun: BigInt(n.lastRun), lastSeq: BigInt(n.lastSeq), epochStart: BigInt(n.epochStart), runsInEpoch: n.runsInEpoch, spentInEpoch: n.spentInEpoch });
const runtimeOf = (n: RawNodeState): NodeRuntime => ({ lastRun: Number(n.lastRun), lastSeq: Number(n.lastSeq), epochStart: Number(n.epochStart), runsInEpoch: n.runsInEpoch, spentInEpoch: n.spentInEpoch });

/** Fresh node states for a graph (`apply_pending`), from the SDK's model. */
const freshNodes = (g: Graph, ref: bigint): NodeRuntime[] => newAutopilotState(g, ref > 0n ? ref : 1n << 64n).nodes;

/** The demo's keeper checks a graduated pool's price every 5 minutes (`update_price`, permissionless and free). */
const WATCH_SECS = 300;
function watchPrice(s: MockState, ap: MockAutopilot, now: number): void {
  const l = s.launches[ap.launch.toBase58()];
  if (!l || l.migrated !== true) return;
  const spot = sqrtPriceQ64(l);
  const st = stateOf(ap);
  const mark = now - (now % WATCH_SECS);
  let changed = false;
  for (let t = Math.max(ap.watchedAt + WATCH_SECS, mark - 2 * WATCH_SECS); t <= mark; t += WATCH_SECS) {
    observePrice(st, t, spot);
    ap.watchedAt = t;
    changed = true;
  }
  if (changed) storePrice(ap, st);
}

function keeperView(s: MockState, ap: MockAutopilot, now: number): { env: AutopilotEnv; state: AutopilotState } {
  watchPrice(s, ap, now);
  const l = s.launches[ap.launch.toBase58()];
  const graduated = l?.migrated === true;
  return {
    env: {
      now,
      treasurySol: ap.treasurySol,
      treasuryTokens: ap.treasuryTokens,
      graduated,
      spotSqrtPriceQ64: l ? sqrtPriceQ64(l) : 0n,
      ...(graduated && l ? { poolSol: l.quoteReserve, poolFeeBps: currentFeeBps(l) } : {}),
    },
    state: stateOf(ap),
  };
}

function actionWords(g: Graph, index: number, amount: bigint, decimals: number): string {
  const a = g.nodes[index]?.action;
  if (!a) return "Run this step";
  const sol = (v: bigint): string => `${(Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
  const tok = (v: bigint): string => `${(Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens`;
  if (a.kind === "buybackBurn") return `Buy back with up to ${sol(amount)} and burn what it buys`;
  if (a.kind === "burn") return `Burn up to ${tok(amount)} from the treasury`;
  return `Pay up to ${sol(amount)} to the recipients`;
}

/** Lamports per signature, and the rent of a wSOL token account (165 bytes) on the simulated chain. */
const TOKEN_ACCOUNT_RENT = (): bigint => rentOf(165);

/** Whether each of a graph's payees has a wSOL account to receive its share (the program skips the others: audit 4, M4). */
function payeesReceive(s: MockState, g: Graph): boolean[] {
  return g.recipients.map((r) => tokenAccountExists(s, new PublicKey(r.address), WSOL_MINT));
}

/** What a run costs `caller` on the simulated chain: the fee for each signer and its own wSOL account for the tip when missing. */
function runCosts(s: MockState, caller: PublicKey, operatorOnly: boolean): RunCosts {
  const fee = LAMPORTS_PER_SIGNATURE * (operatorOnly ? 2n : 1n);
  const rent = tokenAccountExists(s, caller, WSOL_MINT) ? 0n : TOKEN_ACCOUNT_RENT();
  return { signatureFeeLamports: fee, priorityFeeLamports: 0n, rentLamports: rent, totalLamports: fee + rent };
}

async function findDueSteps(_conn: Connection, launch: PublicKey, caller?: PublicKey | null): Promise<DueStep[]> {
  await latency("read");
  const s = chain();
  const p = prog();
  const ap = p.autopilots[launch.toBase58()];
  if (!ap) return [];
  const g = activeGraph(p, ap);
  if (!g) return [];
  const now = nowSecs();
  if (ap.pending !== null && now >= ap.pending.activateAt) return [];
  const { env, state } = keeperView(s, ap, now);
  const decimals = s.launches[launch.toBase58()]?.state.tokenDecimal ?? 6;
  const out: DueStep[] = [];
  g.nodes.forEach((n, i) => {
    const st = nodeStatus(g, state, env, i);
    if (!st.due) return;
    if (st.operatorOnly && ap.operator === null) return;
    // A buyback the pool can't fill at its price bound (its fee and depth eat the premium) is not offered: running it
    // would always fail with SwapShortfall (review U5).
    if (n.action.kind === "buybackBurn" && !buybackWouldFill(s, p, launch, i, st.operatorOnly ? ap.operator : null, st.operatorOnly ? st.maxAmount : undefined, now)) return;
    const receive = payeesReceive(s, g);
    // A payout nobody can receive is refused (NoRecipientAccount): not offered.
    if (n.action.kind === "distributeSol" && g.recipients.length > 0 && !receive.some(Boolean)) return;
    const partial = n.action.kind === "buybackBurn" && st.partial;
    const amount = partial ? st.amount : st.maxAmount;
    const tip = expectedRunTip({
      graph: g,
      node: i,
      amount,
      partial,
      skipped: receive.map((r) => !r),
      graduated: env.graduated,
      reference: state.refSqrtPriceQ64,
      observations: state.observations ?? [],
      now,
      tipEpochStart: ap.tipEpochStart,
      tipsInEpoch: ap.tipsInEpoch,
      treasurySol: ap.treasurySol,
    });
    out.push({
      node: i,
      what: actionWords(g, i, st.maxAmount, decimals),
      tip,
      costs: caller === undefined || caller === null ? null : runCosts(s, caller, st.operatorOnly),
      partial,
      skippedRecipients: n.action.kind === "distributeSol" ? receive.filter((r) => !r).length : 0,
      operatorOnly: st.operatorOnly,
      minAmount: st.operatorOnly ? 1n : st.minAmount,
      maxAmount: st.maxAmount,
      unit: n.action.kind === "burn" ? "tokens" : "lamports",
    });
  });
  return out;
}

// --------------------------------------------------------------- builders ---

/** A transaction with one instruction of `program` (the demo encodes the arguments the program reads). */
function oneIx(payer: PublicKey, program: PublicKey, name: string, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], args?: Uint8Array) {
  return budgetedTx(payer, [new TransactionInstruction({ programId: program, keys, data: ixData(name, args) })], 200_000);
}

const W = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const R = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

async function buildPublishRulesTx(_conn: Connection, payer: PublicKey, launch: PublicKey, bytes: Uint8Array) {
  await latency("build");
  const s = chain();
  const l = launchOf(s, launch);
  if (l.state.status !== "configured") throw new Error("WrongLaunchState: rules can only be published before the launch opens.");
  const v = verifyRules(bytes, { guardSecs: l.state.guardSecs });
  if (!v.ok) throw new Error(`InvalidRules: ${v.message}`);
  const hash = rulesHash(bytes);
  const address = rulesAddress(launch, hash);
  const copy = Uint8Array.from(bytes);
  const tx = oneIx(payer, PROGRAM_IDS.launchpad, "publish_rules", [W(payer, true), R(launch), W(address), R(SystemProgram.programId)], cat(u16le(bytes.length), copy));
  const exists = load().rules[key(launch, hash)] !== undefined;
  register(tx, {
    label: "PublishRules",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 38_000 + bytes.length * 20,
    payer,
    rent: exists ? 0n : rentOf(rulesRecordSize(bytes.length)),
    solOut: 0n,
    check: (st) => {
      const cur = st.launches[launch.toBase58()];
      if (!cur || cur.state.status !== "configured") return lpFail("WrongLaunchState", "Rules can only be published before the launch opens.");
      const again = verifyRules(copy, { guardSecs: cur.state.guardSecs });
      return again.ok ? null : lpFail("InvalidRules", again.message);
    },
    apply: (_st, now) => {
      // Content-addressed and idempotent: publishing the same bytes again changes nothing.
      load().rules[key(launch, hash)] ??= { bytes: copy, hash, publishedAt: now };
    },
    logs: () => [`RulesPublished { launch: ${launch.toBase58()}, rules_hash: ${toHex(hash)}, size: ${bytes.length} }`],
  });
  return { tx, address, hash };
}

async function rulesRecordRent(_conn: Connection, size: number): Promise<bigint> {
  return rentOf(rulesRecordSize(size));
}

/** The v3 message's rules_hash field: recorded with the message's hash before the attestation is sent. */
function bindRulesToAttestation(launch: PublicKey, messageHash: Uint8Array, hash: Uint8Array): void {
  if (messageHash.length !== 32 || hash.length !== 32) throw new Error("hashes must be 32 bytes");
  const p = load();
  p.boundByMessage[toHex(messageHash)] = { launch: launch.toBase58(), rulesHash: Uint8Array.from(hash) };
  save();
}

function newAutopilot(launch: PublicKey, now: number, refSqrtPrice: bigint): MockAutopilot {
  return {
    launch,
    graphHash: null,
    pending: null,
    frozen: false,
    operator: null,
    activeAuth: null,
    partialSpent: [],
    authMarks: [
      { slot: 0, key: PublicKey.default.toBase58() },
      { slot: 0, key: PublicKey.default.toBase58() },
      { slot: 0, key: PublicKey.default.toBase58() },
    ],
    nodes: [],
    seq: 0,
    refSqrtPrice,
    refUpdatedAt: 0,
    observations: [],
    refAllowance: 0n,
    refAllowanceAt: 0,
    watchedAt: 0,
    tipsInEpoch: 0n,
    tipEpochStart: now - (now % AUTOPILOT.TIP_EPOCH_SECS),
    treasurySol: 0n,
    treasuryTokens: 0n,
    totalBurned: 0n,
    totalBoughtWithSol: 0n,
    totalPaid: 0n,
    totalTips: 0n,
  };
}

async function buildInitAutopilotTx(_conn: Connection, payer: PublicKey, launch: PublicKey) {
  await latency("build");
  const s = chain();
  launchOf(s, launch);
  if (prog().autopilots[launch.toBase58()]) throw new Error("this launch already has an autopilot");
  const address = autopilotAddress(launch);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "init_autopilot", [W(payer, true), R(launch), W(address), R(treasuryAddress(launch)), R(SystemProgram.programId)]);
  register(tx, {
    label: "InitAutopilot",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 24_000,
    payer,
    rent: INIT_AUTOPILOT_RENT,
    solOut: 0n,
    check: () => (load().autopilots[launch.toBase58()] ? runtime(`Allocate: account ${address.toBase58()} already in use`) : null),
    apply: (st, now) => {
      const l = st.launches[launch.toBase58()];
      // The reference starts at the launch's migration price, read from its DBC config (init_autopilot.rs).
      const p = load();
      const ap = newAutopilot(launch, now, l ? migrationSqrtPrice(l) : 0n);
      // Fees already paid to the treasury's wSOL account are the autopilot's from the start.
      ap.treasurySol = p.treasuryCredits?.[launch.toBase58()] ?? 0n;
      if (p.treasuryCredits) delete p.treasuryCredits[launch.toBase58()];
      p.autopilots[launch.toBase58()] = ap;
    },
    logs: () => [`AutopilotInitialized { launch: ${launch.toBase58()}, treasury: ${treasuryAddress(launch).toBase58()} }`],
  });
  return { tx, address };
}

async function buildPublishGraphTx(_conn: Connection, payer: PublicKey, launch: PublicKey, bytes: Uint8Array) {
  await latency("build");
  launchOf(chain(), launch);
  const v = verifyGraph(bytes);
  if (!v.ok) throw new Error(`InvalidGraph: ${v.message}`);
  const hash = graphHash(bytes);
  const address = graphAddress(launch, hash);
  const copy = Uint8Array.from(bytes);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "publish_graph", [W(payer, true), R(launch), W(address), R(SystemProgram.programId)], cat(u16le(bytes.length), copy));
  register(tx, {
    label: "PublishGraph",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 52_000,
    payer,
    rent: rentOf(8 + 1 + 1 + 32 + 32 + 4 + bytes.length),
    solOut: 0n,
    check: () => (verifyGraph(copy).ok ? null : apFail("InvalidGraph")),
    apply: () => {
      load().graphs[key(launch, hash)] ??= copy;
    },
    logs: () => [`GraphPublished { launch: ${launch.toBase58()}, graph_hash: ${toHex(hash)}, size: ${bytes.length} }`],
  });
  return { tx, hash, address };
}

/**
 * `pq_authorize`: only the launch's own quantum identity, a valid LMS signature over the exact 140-byte message
 * ("PHX-AUTH-V1" || launchpad || launch || creator || kind || payload_hash) at an unused one-time key, which it spends
 * in the identity's shared leaf bitmap (review U16).
 */
async function buildPqAuthorizeTx(_conn: Connection, payer: PublicKey, launch: PublicKey, args: { kind: number; payloadHash: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array }) {
  await latency("build");
  const s = chain();
  const l = launchOf(s, launch);
  if (![AUTH_KIND.GRAPH_ACTIVATE, AUTH_KIND.GRAPH_FREEZE, AUTH_KIND.OPERATOR_REVOKE].includes(args.kind as 1 | 2 | 3)) throw new Error(`unknown authorization kind ${args.kind}`);
  if (args.payloadHash.length !== 32) throw new Error("payload hash must be 32 bytes");
  if (args.lmsPublicKey.length !== PQ_IDENTITY.PUBLIC_KEY_LEN) throw new Error(`the quantum public key must be ${PQ_IDENTITY.PUBLIC_KEY_LEN} bytes`);
  if (args.signature.length !== PQ_IDENTITY.SIGNATURE_LEN) throw new Error(`the quantum signature must be ${PQ_IDENTITY.SIGNATURE_LEN} bytes`);
  const kind = args.kind as 1 | 2 | 3;
  const payload = Uint8Array.from(args.payloadHash);
  const lmsPublicKey = Uint8Array.from(args.lmsPublicKey);
  const signature = Uint8Array.from(args.signature);
  const address = authAddress(launch, kind, payload);
  const message = authMessage({ program: PROGRAM_IDS.launchpad, launch, creator: l.state.creator, kind, payloadHash: payload }).bytes;
  const id = pqIdentity.identityId(lmsPublicKey);
  const identityKey = identityAddressFromId(id).toBase58();
  const problem = (st: MockState): SimFailure | null => {
    const cur = st.launches[launch.toBase58()];
    if (!cur) return lpFail("NotALaunch", "No such launch.");
    if (!bytesEqual(id, cur.state.pqIdentity)) return lpFail("WrongIdentity", "Only this launch's own quantum key can authorize changes to its autopilot.");
    const q = lms.lmsVerify(lmsPublicKey, message, signature);
    if (q === null || q !== args.leaf) return lpFail("InvalidPqSignature", "The quantum signature does not verify for this exact change.");
    if (pqIdentity.leafUsed(st.identities[identityKey]?.used ?? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN), q)) return lpFail("PqLeafUsed", "This one-time key was already used.");
    if (load().auths[authKey(launch, kind, payload)]) return runtime(`Allocate: account ${address.toBase58()} already in use`);
    return null;
  };
  const early = problem(s);
  if (early !== null) throw refusal(early);
  const tx = oneIx(payer, PROGRAM_IDS.launchpad, "pq_authorize", [W(payer, true), R(launch), W(address), W(identityAddressFromId(id)), R(SystemProgram.programId)], cat(Uint8Array.of(kind), payload, u16le(args.leaf), sha256(signature)));
  register(tx, {
    label: "PqAuthorize",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 168_000,
    payer,
    rent: rentOf(2_669),
    solOut: 0n,
    check: (st) => problem(st),
    apply: (st, now) => {
      const used = Uint8Array.from(st.identities[identityKey]?.used ?? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN));
      pqIdentity.markLeafUsed(used, args.leaf);
      st.identities[identityKey] = { publicKey: lmsPublicKey, used };
      // The Clock's unix time and slot when it landed: they drive the timelock and the order authorizations are used in.
      load().auths[authKey(launch, kind, payload)] = { kind, payloadHash: payload, unixTime: now, slot: st.slot + 1, address: address.toBase58() };
    },
    logs: () => [`PqAuthorized { launch: ${launch.toBase58()}, kind: ${kind}, payload_hash: ${toHex(payload)}, leaf: ${args.leaf} }`],
  });
  return { tx, address };
}

/** An authorization's place in the program's order: (slot, address). */
const markOf = (a: { slot: number; key: string }): { slot: bigint; key: Uint8Array } => ({ slot: BigInt(a.slot), key: new PublicKey(a.key).toBytes() });
const marksOf = (ap: MockAutopilot): [{ slot: bigint; key: Uint8Array }, { slot: bigint; key: Uint8Array }, { slot: bigint; key: Uint8Array }] => [
  markOf(ap.authMarks[0]),
  markOf(ap.authMarks[1]),
  markOf(ap.authMarks[2]),
];

/**
 * governance.rs `use_authorization`: the record exists for this exact payload, then the program's `check_fresh`
 * (the SDK's exact port: used once, never after a newer one of a kind it could undo).
 */
function useAuthorization(p: ProgState, ap: MockAutopilot, launch: PublicKey, kind: 1 | 2 | 3, payload: Uint8Array): { auth: MockAuth } | { fail: SimFailure } {
  const auth = p.auths[authKey(launch, kind, payload)];
  if (!auth) return { fail: apFail("InvalidAuthorization") };
  const stale = checkFresh(markOf({ slot: auth.slot, key: auth.address }), marksOf(ap), kind);
  return stale !== null ? { fail: apFail(stale) } : { auth };
}

const markIndex = (kind: 1 | 2 | 3): 0 | 1 | 2 => (kind === 1 ? 0 : kind === 2 ? 1 : 2);

/** Why `activate` refuses now (governance.rs `handle_activate`: the authorization, then the program's `check_activation`), or the authorization it uses. */
function activationCheck(p: ProgState, launch: PublicKey, hash: Uint8Array, activateAt: number, now: number): { auth: MockAuth } | { fail: SimFailure } {
  const ap = p.autopilots[launch.toBase58()];
  if (!ap) return { fail: runtime("AnchorError caused by account: autopilot. Error Code: AccountNotInitialized. This launch has no autopilot yet.") };
  if (!p.graphs[key(launch, hash)]) return { fail: runtime("AnchorError caused by account: graph. Error Code: AccountNotInitialized. Publish the graph first.") };
  const used = useAuthorization(p, ap, launch, 1, activationPayload(autopilotAddress(launch), hash, activateAt).hash);
  if ("fail" in used) return used;
  const problem = checkActivation({ activeGraph: ap.graphHash, pendingGraph: ap.pending?.graphHash ?? null, frozen: ap.frozen, now, activateAt, authUnixTime: used.auth.unixTime });
  return problem !== null ? { fail: apFail(problem) } : used;
}

async function buildActivateGraphTx(_conn: Connection, payer: PublicKey, launch: PublicKey, hash: Uint8Array, activateAt: number) {
  await latency("build");
  const ap = autopilotAddress(launch);
  const payload = activationPayload(ap, hash, activateAt).hash;
  const first = activationCheck(prog(), launch, hash, activateAt, nowSecs());
  if ("fail" in first) throw refusal(first.fail);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "activate", [W(ap), R(launch), R(graphAddress(launch, hash)), R(authAddress(launch, 1, payload))], i64le(activateAt));
  register(tx, {
    label: "Activate",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 31_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (_st, now) => {
      const r = activationCheck(load(), launch, hash, activateAt, now);
      return "fail" in r ? r.fail : null;
    },
    apply: (_st, now) => {
      const p = load();
      const cur = p.autopilots[launch.toBase58()];
      const r = activationCheck(p, launch, hash, activateAt, now);
      if (!cur || "fail" in r) return;
      cur.authMarks[markIndex(1)] = { slot: r.auth.slot, key: r.auth.address };
      const bytes = p.graphs[key(launch, hash)];
      // A later activation replaces a queued one; the graph's own operator is queued with it.
      cur.pending = { graphHash: Uint8Array.from(hash), activateAt, authorizedAt: r.auth.unixTime, operator: bytes ? decompileGraph(bytes).operator : null, auth: r.auth.address };
    },
    logs: () => [`GraphQueued { autopilot: ${ap.toBase58()}, graph_hash: ${toHex(hash)}, activate_at: ${activateAt} }`],
  });
  return { tx };
}

async function buildApplyPendingTx(_conn: Connection, payer: PublicKey, launch: PublicKey) {
  await latency("build");
  // The program's check_apply (an account constraint first: something must be queued).
  const problem = (now: number): SimFailure | null => {
    const ap = load().autopilots[launch.toBase58()];
    if (!ap || ap.pending === null) return apFail("NoPendingUpdate");
    const e = checkApply(ap.pending.graphHash, ap.pending.activateAt, ap.frozen, now);
    return e === null ? null : apFail(e);
  };
  const early = problem(nowSecs());
  if (early !== null) throw refusal(early);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "apply_pending", [W(autopilotAddress(launch))]);
  register(tx, {
    label: "ApplyPending",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 18_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (_st, now) => problem(now),
    apply: () => {
      const pp = load();
      const ap = pp.autopilots[launch.toBase58()];
      if (ap) applyPending(pp, ap);
    },
  });
  return { tx };
}

/**
 * Why `freeze(not_after)` refuses at `now` (governance.rs `handle_freeze`, in order: Frozen, NoActiveGraph, the
 * approval's window, FreezeExpired after `not_after`, then the authorization of payload v2), or the authorization it uses.
 */
function freezeCheck(p: ProgState, launch: PublicKey, notAfter: number, now: number): { auth: MockAuth } | { fail: SimFailure } {
  const ap = p.autopilots[launch.toBase58()];
  if (!ap) return { fail: runtime("AnchorError caused by account: autopilot. Error Code: AccountNotInitialized.") };
  if (ap.frozen) return { fail: apFail("Frozen") };
  if (ap.graphHash === null) return { fail: apFail("NoActiveGraph") };
  if (now > notAfter) return { fail: apFail("FreezeExpired") };
  return useAuthorization(p, ap, launch, 2, freezePayload(autopilotAddress(launch), ap.graphHash, notAfter).hash);
}

async function buildFreezeGraphTx(_conn: Connection, payer: PublicKey, launch: PublicKey, notAfter: number) {
  await latency("build");
  const p = prog();
  const first = freezeCheck(p, launch, notAfter, nowSecs());
  if ("fail" in first) throw refusal(first.fail);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "freeze", [W(autopilotAddress(launch)), R(launch), R(new PublicKey(first.auth.address))], i64le(notAfter));
  register(tx, {
    label: "Freeze",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 16_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: (_st, now) => {
      const r = freezeCheck(load(), launch, notAfter, now);
      return "fail" in r ? r.fail : null;
    },
    apply: (_st, now) => {
      const pp = load();
      const ap = pp.autopilots[launch.toBase58()];
      const r = freezeCheck(pp, launch, notAfter, now);
      if (!ap || "fail" in r) return;
      ap.authMarks[markIndex(2)] = { slot: r.auth.slot, key: r.auth.address };
      ap.frozen = true;
      // A frozen graph is permanent: a scheduled change is cancelled.
      ap.pending = null;
    },
    logs: () => [`GraphFrozen { launch: ${launch.toBase58()}, not_after: ${notAfter} }`],
  });
  return { tx };
}

/** Why `revoke_operator` refuses now (governance.rs `handle_revoke_operator`), or the authorization it uses. Allowed when frozen. */
function revokeCheck(p: ProgState, launch: PublicKey): { auth: MockAuth; operator: string } | { fail: SimFailure } {
  const ap = p.autopilots[launch.toBase58()];
  if (!ap) return { fail: runtime("AnchorError caused by account: autopilot. Error Code: AccountNotInitialized.") };
  if (ap.operator === null) return { fail: apFail("NoOperator") };
  // Payload v3 (audit 4, A4-3): it names the activation in force, so a removal never carries over to a later activation.
  const used = useAuthorization(p, ap, launch, 3, revokePayload(autopilotAddress(launch), ap.graphHash ?? ZERO32, new PublicKey(ap.operator), activeAuthOf(ap) ?? PublicKey.default).hash);
  return "fail" in used ? used : { auth: used.auth, operator: ap.operator };
}

async function buildRevokeOperatorTx(_conn: Connection, payer: PublicKey, launch: PublicKey) {
  await latency("build");
  const first = revokeCheck(prog(), launch);
  if ("fail" in first) throw refusal(first.fail);
  const tx = oneIx(payer, AUTOPILOT_PROGRAM, "revoke_operator", [W(autopilotAddress(launch)), R(launch), R(new PublicKey(first.auth.address))]);
  register(tx, {
    label: "RevokeOperator",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 14_000,
    payer,
    rent: 0n,
    solOut: 0n,
    check: () => {
      const r = revokeCheck(load(), launch);
      return "fail" in r ? r.fail : null;
    },
    apply: () => {
      const pp = load();
      const ap = pp.autopilots[launch.toBase58()];
      const r = revokeCheck(pp, launch);
      if (!ap || "fail" in r) return;
      ap.authMarks[markIndex(3)] = { slot: r.auth.slot, key: r.auth.address };
      ap.operator = null;
      // A queued graph naming the same operator does not get it either.
      if (ap.pending !== null && ap.pending.operator === r.operator) ap.pending.operator = null;
    },
    logs: () => [`OperatorRevoked { launch: ${launch.toBase58()} }`],
  });
  return { tx };
}

// --------------------------------------------------------------------- run ---

/**
 * run.rs `handle_run`: a due scheduled change first (PendingUpdateDue), the active graph, then this run's observation
 * of the pool (once graduated) and the program's own `plan_run` (the SDK's exact port, replayed against vectors the
 * program wrote): the step exists; an operator step is signed by the operator; it is due and its condition holds on the
 * reference; a buyback only after graduation, with a usable observation window, within the premium; the amount; the
 * minimum out. Returns the plan with the price state it runs at.
 */
function planRun(
  s: MockState,
  p: ProgState,
  launch: PublicKey,
  node: number,
  operatorSigner: PublicKey | null,
  amount: bigint | undefined,
  now: number,
): { fail: SimFailure } | { plan: RunPlan; graph: Graph; price: PriceState; byOperator: boolean; receive: boolean[] } {
  const ap = p.autopilots[launch.toBase58()];
  if (!ap) return { fail: runtime("AnchorError caused by account: autopilot. Error Code: AccountNotInitialized.") };
  if (ap.pending !== null && now >= ap.pending.activateAt) return { fail: apFail("PendingUpdateDue") };
  const bytes = ap.graphHash === null ? undefined : p.graphs[key(ap.launch, ap.graphHash)];
  if (bytes === undefined) return { fail: apFail("NoActiveGraph") };
  const g = decompileGraph(bytes);
  const l = s.launches[launch.toBase58()];
  const graduated = l?.migrated === true;
  const spot = graduated && l ? sqrtPriceQ64(l) : null;
  watchPrice(s, ap, now);
  const after = afterObservation(stateOf(ap), now, spot ?? 0n, graduated);
  const r = sdkPlanRun({
    graph: verifyGraphBytes(bytes),
    node,
    now: BigInt(now),
    states: ap.nodes.map(rawOf),
    operator: ap.operator === null ? new Uint8Array(32) : new PublicKey(ap.operator).toBytes(),
    operatorSigner: operatorSigner === null ? null : operatorSigner.toBytes(),
    amount: amount ?? null,
    treasurySol: ap.treasurySol,
    treasuryToken: ap.treasuryTokens,
    graduated,
    spot,
    reference: after.price.reference,
    seen: after.window,
    poolQuote: graduated && l ? l.quoteReserve : null,
    // Audit 4, A4-2: what partial buybacks moved of this node's open run.
    partialSpent: ap.partialSpent?.[node] ?? 0n,
  });
  if (!r.ok) return { fail: apFail(r.error) };
  // Audit 4, M4: a payout pays only recipients with a wSOL account, and refuses when none can receive.
  const receive = payeesReceive(s, g);
  if (r.value.kind === "distribute" && g.recipients.length > 0 && !receive.some(Boolean)) return { fail: apFail("NoRecipientAccount") };
  return { plan: r.value, graph: g, price: after.price, byOperator: g.nodes[node]?.operatorGated === true, receive };
}

/** Whether a buyback planned now would get at least its minimum out from the pool (the program's swap check). */
function buybackWouldFill(s: MockState, p: ProgState, launch: PublicKey, node: number, operator: string | null, amount: bigint | undefined, now: number): boolean {
  const r = planRun(s, p, launch, node, operator === null ? null : new PublicKey(operator), amount, now);
  if ("fail" in r || r.plan.kind !== "buyback") return false;
  const l = s.launches[launch.toBase58()];
  if (!l) return false;
  const res = simulateSwap(l, "buy", r.plan.amountIn);
  return res.amountInUsed === r.plan.amountIn && res.amountOut >= r.plan.minOut;
}

async function buildRunStepTx(_conn: Connection, caller: PublicKey, launch: PublicKey, node: number, opts: { amount?: bigint; operator?: PublicKey } = {}) {
  await latency("build");
  const operator = opts.operator ?? null;
  const first = planRun(chain(), prog(), launch, node, operator, opts.amount, nowSecs());
  if ("fail" in first) throw refusal(first.fail);
  const costs = runCosts(chain(), caller, first.byOperator);
  const skippedRecipients = first.plan.kind === "distribute" ? first.graph.recipients.filter((_, i) => first.receive[i] !== true).map((r) => new PublicKey(r.address)) : [];
  const keys = [W(caller, true), W(autopilotAddress(launch)), R(treasuryAddress(launch)), R(PROGRAM_IDS.dammV2), R(PROGRAM_IDS.launchpad)];
  if (operator !== null && !operator.equals(caller)) keys.push(R(operator, true));
  const tx = oneIx(caller, AUTOPILOT_PROGRAM, "run", keys, cat(Uint8Array.of(node), Uint8Array.of(opts.amount === undefined ? 0 : 1), u64le(opts.amount ?? 0n)));
  let used: { spent: bigint; tip: bigint; burned: bigint; kind: AutopilotRun["action"]; byOperator: boolean; partial: boolean; skipped: number } | null = null;
  // The swap must take exactly the amount in and return at least the minimum out (run.rs `buyback`).
  const swapShortfall = (l: MockLaunch, plan: RunPlan): SimFailure | null => {
    if (plan.kind !== "buyback") return null;
    const res = simulateSwap(l, "buy", plan.amountIn);
    return res.amountInUsed !== plan.amountIn || res.amountOut < plan.minOut ? apFail("SwapShortfall") : null;
  };
  register(tx, {
    label: "Run",
    program: AUTOPILOT_PROGRAM,
    computeUnits: 96_000,
    payer: caller,
    // Only the caller's own wSOL account for the tip is created (never a recipient's: audit 4, M4).
    rent: costs.rentLamports,
    solOut: 0n,
    check: (st, now) => {
      const r = planRun(st, load(), launch, node, operator, opts.amount, now);
      if ("fail" in r) return r.fail;
      const l = st.launches[launch.toBase58()];
      return l ? swapShortfall(l, r.plan) : null;
    },
    apply: (st, now) => {
      const pp = load();
      const r = planRun(st, pp, launch, node, operator, opts.amount, now);
      const cur = pp.autopilots[launch.toBase58()];
      const l = st.launches[launch.toBase58()];
      if ("fail" in r || !cur || !l) return;
      let burned = 0n;
      let kept = 0n;
      let kind: AutopilotRun["action"] = "burn";
      if (r.plan.kind === "buyback") {
        // Swap into the locked pool and burn everything received, in the same step: nothing reaches any wallet.
        const res = simulateSwap(l, "buy", r.plan.amountIn);
        applySwap(l, "buy", res);
        cur.treasurySol -= res.amountInUsed;
        cur.totalBoughtWithSol += res.amountInUsed;
        burned = res.amountOut;
        kind = "buyback";
      } else if (r.plan.kind === "burn") {
        cur.treasuryTokens -= r.plan.amount;
        burned = r.plan.amount;
      } else {
        kind = "pay";
        // The floor of each share, to the recipients that have a wSOL account; a skipped recipient's share and the
        // rounding dust stay in the treasury (audit 4, M4). The budget counts the whole sum due.
        const plan = r.plan;
        let paid = 0n;
        r.graph.recipients.forEach((rc, i) => {
          const share = plan.shares[i] ?? 0n;
          if (share > 0n && r.receive[i] === true) {
            addTokens(st, new PublicKey(rc.address), WSOL_MINT, share);
            paid += share;
          } else if (share > 0n) kept += share;
        });
        cur.treasurySol -= paid;
        cur.totalPaid += paid;
      }
      cur.totalBurned += burned;
      // The caller's own wSOL account for the tip, created (and paid for) when it had none: never a recipient's.
      if (costs.rentLamports > 0n) addTokens(st, caller, WSOL_MINT, 0n);
      // The program's bookkeeping: this run's price state, the node's counters (record_run: a partial buyback only adds
      // to the node's open run), then the tip (take_tip) from what the action left, a share of what it moved (a burn at
      // the burn price, a payout less what it kept), at most a partial buyback's share.
      const spent = planSpent(r.plan);
      const n = r.graph.nodes[node];
      const partial = planPartial(r.plan);
      const rec = recordRunRaw(rawOf(cur.nodes[node] ?? { lastRun: 0, lastSeq: 0, epochStart: 0, runsInEpoch: 0, spentInEpoch: 0n }), BigInt(cur.seq), n?.epochSecs ?? 86_400, BigInt(now), spent, {
        partial,
        partialSpent: cur.partialSpent?.[node] ?? 0n,
      });
      if (!rec.ok) return;
      while (cur.nodes.length <= node) cur.nodes.push({ lastRun: 0, lastSeq: 0, epochStart: 0, runsInEpoch: 0, spentInEpoch: 0n });
      cur.nodes[node] = runtimeOf(rec.value.node);
      cur.seq = Number(rec.value.seq);
      const ps = cur.nodes.map((_, i) => cur.partialSpent?.[i] ?? 0n);
      ps[node] = rec.value.partialSpent;
      cur.partialSpent = ps;
      const st2 = stateOf(cur);
      storePriceState(st2, r.price);
      storePrice(cur, st2);
      const price = burnPrice(l.migrated === true, r.price.reference, lowestObserved(r.price.observations, now));
      const t = takeTipRaw({ epochStart: BigInt(cur.tipEpochStart), inEpoch: cur.tipsInEpoch }, BigInt(now), cur.treasurySol, planValue(r.plan, price, kept), planMaxTip(r.plan, actionMax(n)));
      cur.tipEpochStart = Number(t.counters.epochStart);
      cur.tipsInEpoch = t.counters.inEpoch;
      if (t.tip > 0n) {
        cur.treasurySol -= t.tip;
        cur.totalTips += t.tip;
        addTokens(st, caller, WSOL_MINT, t.tip);
      }
      used = { spent, tip: t.tip, burned, kind, byOperator: r.byOperator, partial, skipped: r.plan.kind === "distribute" ? r.receive.filter((x, i) => !x && (r.graph.recipients[i] !== undefined)).length : 0 };
    },
    landed: (_st, outcome) => {
      if (outcome.failed || used === null) return;
      const pp = load();
      const list = pp.runs[launch.toBase58()] ?? [];
      list.push({
        txSignature: outcome.txSignature,
        unixTime: nowSecs(),
        node,
        action: used.kind,
        solIn: used.kind === "burn" ? 0n : used.spent,
        burned: used.burned,
        tip: used.tip,
        keeper: caller,
        byOperator: used.byOperator,
        partial: used.partial,
        skippedRecipients: used.skipped,
      });
      pp.runs[launch.toBase58()] = list;
      save();
    },
    logs: () =>
      used === null ? [] : [`NodeRan { node: ${node}, spent: ${used.spent}, burned: ${used.burned}, tip: ${used.tip}, partial: ${used.partial}, skipped_recipients: ${used.skipped} }`],
  });
  return { tx, costs, skippedRecipients };
}

/** A node's per-run maximum (`p1`: the most one run may move). */
function actionMax(n: Graph["nodes"][number] | undefined): bigint {
  if (n === undefined) return 1n;
  const a = n.action;
  return a.kind === "buybackBurn" ? a.maxInLamports : a.kind === "burn" ? a.maxTokens : a.maxLamports;
}

// -------------------------------------------------------------------- seed ---

const DAY = 86_400;
const SOL = 1_000_000_000n;

function demoRun(p: ProgState, launch: PublicKey, run: Omit<AutopilotRun, "txSignature" | "keeper"> & { keeper?: string }): void {
  const list = p.runs[launch.toBase58()] ?? [];
  // demo derivation tag, kept from the original name (simulated run signatures)
  const sig = toHex(sha256(utf8(`phalanx-demo/run/${launch.toBase58()}/${run.unixTime}/${run.node}`)));
  list.push({ ...run, txSignature: `demo${sig.slice(0, 60)}`, keeper: demoKey(run.keeper ?? "keeper-1") });
  p.runs[launch.toBase58()] = list;
}

function publishGraph(p: ProgState, launch: PublicKey, g: Graph): Uint8Array {
  const bytes = compileGraph(g);
  const hash = graphHash(bytes);
  p.graphs[key(launch, hash)] = bytes;
  return hash;
}

function seedRules(p: ProgState, l: MockLaunch, set: RuleSet, publishedAt: number): void {
  const bytes = compileRules(set);
  const hash = rulesHash(bytes);
  p.rules[key(l.address, hash)] = { bytes, hash, publishedAt };
  p.attestedRules[l.address.toBase58()] = hash;
}

/** A seeded authorization (the creator's quantum key signed it before the demo started), marked used. */
function seedAuth(p: ProgState, ap: MockAutopilot, launch: PublicKey, kind: 1 | 2 | 3, payload: Uint8Array, unixTime: number, slot: number): void {
  const address = authAddress(launch, kind, payload).toBase58();
  p.auths[authKey(launch, kind, payload)] = { kind, payloadHash: payload, unixTime, slot, address };
  ap.authMarks[markIndex(kind)] = { slot, key: address };
}

/** Attaches demo rules and autopilots to the seeded launches (by symbol), so every state shows up somewhere. */
function seedProgrammable(s: MockState): ProgState {
  const p = emptyState(chainId(s));
  const now = Math.floor(Date.now() / 1000);
  const bySymbol = (sym: string): MockLaunch | undefined => Object.values(s.launches).find((l) => l.meta?.symbol === sym);
  const dec = (l: MockLaunch): number => l.state.tokenDecimal;

  // AEGS: anti-bot rules for the first 15 minutes of trading and small buys at first; LNTN: a whale cap for its (now
  // finished) guard. Both bound by their attestations (./demoRules.ts: the certificates record them, RULES_BOUND).
  for (const [symbol, publishedAt] of [
    ["AEGS", now - 250],
    ["LNTN", now - 31 * 3600],
  ] as const) {
    const l = bySymbol(symbol);
    const set = l ? demoRuleSet(symbol, l.state) : null;
    if (l && set) seedRules(p, l, set, publishedAt);
  }

  // MRDN (graduated): a running daily buyback-and-burn with four days of history.
  const mrdn = bySymbol("MRDN");
  if (mrdn) {
    const g: Graph = {
      operator: null,
      recipients: [],
      tokenDecimals: dec(mrdn),
      nodes: [
        makeNode("buyback", { kind: "every", secs: DAY }, { op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: SOL } }, { kind: "buybackBurn", maxInLamports: SOL / 2n, maxPremiumBps: 300 }, { epoch: "1d" }, dec(mrdn)),
      ],
    };
    const hash = publishGraph(p, mrdn.address, g);
    // The reference followed the pool since graduation: it sits at the pool's price now.
    const ap = newAutopilot(mrdn.address, now - 4 * DAY - 3600, sqrtPriceQ64(mrdn));
    ap.graphHash = hash;
    ap.nodes = freshNodes(g, ap.refSqrtPrice);
    ap.seq = 4;
    ap.treasurySol = 3_240_000_000n;
    seedAuth(p, ap, mrdn.address, 1, activationPayload(autopilotAddress(mrdn.address), hash, now - 4 * DAY - 3000).hash, now - 4 * DAY - 3300, 1_000);
    ap.activeAuth = ap.authMarks[0].key;
    for (let d = 4; d >= 1; d--) {
      const t = now - d * DAY - 1800;
      const burned = BigInt(Math.round(2_400_000 + d * 87_000)) * 10n ** BigInt(dec(mrdn));
      demoRun(p, mrdn.address, { unixTime: t, node: 0, action: "buyback", solIn: SOL / 2n, burned, tip: AUTOPILOT.TIP_LAMPORTS, byOperator: false, keeper: `keeper-${(d % 3) + 1}` });
      ap.totalBurned += burned;
      ap.totalBoughtWithSol += SOL / 2n;
      ap.totalTips += AUTOPILOT.TIP_LAMPORTS;
    }
    const rt = ap.nodes[0];
    if (rt) {
      rt.lastRun = now - DAY - 1800;
      rt.lastSeq = 4;
      rt.epochStart = rt.lastRun - (rt.lastRun % DAY);
      rt.runsInEpoch = 1;
      rt.spentInEpoch = SOL / 2n;
    }
    p.autopilots[mrdn.address.toBase58()] = ap;
  }

  // CNDR (graduated): revenue share to its two fee recipients, frozen forever.
  const cndr = bySymbol("CNDR");
  if (cndr) {
    const rs = cndr.state.recipients.slice(0, cndr.state.recipientCount);
    const g: Graph = {
      operator: null,
      recipients: rs.map((r) => ({ address: r.wallet.toBase58(), bps: r.bps })),
      tokenDecimals: dec(cndr),
      nodes: [makeNode("share", { kind: "every", secs: 7 * DAY }, { op: "treasurySolGte", lamports: SOL / 5n }, { kind: "distributeSol", maxLamports: SOL }, { epoch: "7d" }, dec(cndr))],
    };
    const hash = publishGraph(p, cndr.address, g);
    const ap = newAutopilot(cndr.address, now - 8 * DAY, sqrtPriceQ64(cndr));
    ap.graphHash = hash;
    ap.frozen = true;
    ap.nodes = freshNodes(g, ap.refSqrtPrice);
    ap.treasurySol = 640_000_000n;
    seedAuth(p, ap, cndr.address, 1, activationPayload(autopilotAddress(cndr.address), hash, now - 8 * DAY + 900).hash, now - 8 * DAY + 60, 2_000);
    ap.activeAuth = ap.authMarks[0].key;
    // Its fee recipients opened their wSOL accounts when the launch first paid them fees: the payout can reach them.
    for (const r of rs) addTokens(s, r.wallet, WSOL_MINT, 0n);
    // Freeze payload v2: approved for one hour, and used within it.
    seedAuth(p, ap, cndr.address, 2, freezePayload(autopilotAddress(cndr.address), hash, now - 6 * DAY + 3_600).hash, now - 6 * DAY, 3_000);
    const rt = ap.nodes[0];
    ap.seq = 1;
    if (rt) {
      rt.lastRun = now - 2 * DAY;
      rt.lastSeq = 1;
      rt.epochStart = rt.lastRun - (rt.lastRun % (7 * DAY));
      rt.runsInEpoch = 1;
      rt.spentInEpoch = SOL;
    }
    demoRun(p, cndr.address, { unixTime: now - 2 * DAY, node: 0, action: "pay", solIn: SOL, burned: 0n, tip: AUTOPILOT.TIP_LAMPORTS, byOperator: false, keeper: "keeper-2" });
    ap.totalPaid = SOL;
    ap.totalTips = AUTOPILOT.TIP_LAMPORTS;
    p.autopilots[cndr.address.toBase58()] = ap;
  }

  // BSTN (still on its curve): burn the treasury's tokens at graduation, with a signed change waiting out its 72 h.
  const bstn = bySymbol("BSTN");
  if (bstn) {
    const g: Graph = {
      operator: null,
      recipients: [],
      tokenDecimals: dec(bstn),
      nodes: [makeNode("burn", { kind: "graduated" }, null, { kind: "burn", maxTokens: 50_000_000n * 10n ** BigInt(dec(bstn)) }, {}, dec(bstn))],
    };
    const hash = publishGraph(p, bstn.address, g);
    const next: Graph = {
      ...g,
      nodes: [...g.nodes, makeNode("buyback", { kind: "every", secs: DAY }, { op: "graduated" }, { kind: "buybackBurn", maxInLamports: SOL / 4n, maxPremiumBps: 300 }, { epoch: "1d" }, dec(bstn))],
    };
    const nextHash = publishGraph(p, bstn.address, next);
    const ap = newAutopilot(bstn.address, now - 2 * DAY, migrationSqrtPrice(bstn));
    ap.graphHash = hash;
    ap.nodes = freshNodes(g, ap.refSqrtPrice);
    ap.treasuryTokens = 12_500_000n * 10n ** BigInt(dec(bstn));
    ap.treasurySol = 410_000_000n;
    seedAuth(p, ap, bstn.address, 1, activationPayload(autopilotAddress(bstn.address), hash, now - 2 * DAY + 900).hash, now - 2 * DAY + 60, 4_000);
    ap.activeAuth = ap.authMarks[0].key;
    const signedAt = now - 20 * 3600;
    const activateAt = signedAt + AUTOPILOT.UPDATE_TIMELOCK_SECS + 3_600;
    seedAuth(p, ap, bstn.address, 1, activationPayload(autopilotAddress(bstn.address), nextHash, activateAt).hash, signedAt, 5_000);
    ap.pending = { graphHash: nextHash, activateAt, authorizedAt: signedAt, operator: null, auth: ap.authMarks[0].key };
    p.autopilots[bstn.address.toBase58()] = ap;
  }
  return p;
}

/** Rent the demo's `init_autopilot` charges (the autopilot account and its treasury's token accounts). */
const INIT_AUTOPILOT_RENT = 3_480_000n;

/** The demo binds the mint as the launch opens (the autopilot reads it from the launch): never a separate step. */
async function buildBindMintTx(): Promise<null> {
  return null;
}

/** What switching on a first autopilot costs on the simulated chain: the rents its builders charge, plus each fee. */
async function autopilotSetupCost(_conn: Connection, graphBytes: number): Promise<AutopilotSetupCost> {
  const fee = LAMPORTS_PER_SIGNATURE;
  return {
    init: INIT_AUTOPILOT_RENT + fee,
    publish: rentOf(8 + 1 + 1 + 32 + 32 + 4 + graphBytes) + fee,
    authorize: rentOf(2_669) + fee,
    activate: 2n * fee,
  };
}

/**
 * `pq_authorize` paid and signed by a keypair (the launch flow's temporary account): the identity signs the exact
 * 140-byte message at its next one-time key through the ledger, then the demo's legacy transaction, signed.
 */
async function prepareAuthorizeFromPayer(
  conn: Connection,
  payer: Keypair,
  launch: PublicKey,
  args: { kind: number; payloadHash: Uint8Array; creator: PublicKey; identity: PqIdentity; ledger: LeafLedger; freezeNotAfter?: number } & SignGuardOptions,
): Promise<{ tx: Transaction; send: () => Promise<string> } | null> {
  if (prog().auths[authKey(launch, args.kind, args.payloadHash)]) return null;
  const s = await signAuthorization(conn, launch, args);
  const { tx } = await buildPqAuthorizeTx(conn, payer.publicKey, launch, { kind: args.kind, payloadHash: args.payloadHash, lmsPublicKey: s.lmsPublicKey, leaf: s.leaf, signature: s.signature });
  tx.sign(payer);
  return { tx, send: () => send(tx) };
}

/** The 140-byte PHX-AUTH-V1 message's kind and payload (null: not an authorization message of `launch`). */
function authMessageFields(message: Uint8Array, launch: PublicKey): { kind: number; payloadHash: Uint8Array } | null {
  if (message.length !== 140 || new TextDecoder().decode(message.subarray(0, 11)) !== "PHX-AUTH-V1") return null;
  if (!bytesEqual(message.subarray(43, 75), launch.toBytes())) return null;
  return { kind: message[107] ?? 0, payloadHash: message.subarray(108, 140) };
}

/**
 * The quantum signature of an authorization on the simulated chain, with the SDK's `buildPqAuthorizeTx` guards in its
 * order (SDK 0.9.0, audit 4): this launch's own identity; the clock for a time it signs (kinds 1 and 2); a freeze at most
 * 24 hours past this device's clock and with room to land; then, under the launch's signing lock, this launch's earlier
 * approvals reconciled with the chain, the cap on those of this kind that never landed (`SignatureCapError`), and the
 * leaf (`signAtNextLeaf`: `UnknownLeavesError` before anything is reserved).
 */
async function signAuthorization(
  conn: Connection,
  launch: PublicKey,
  args: { kind: number; payloadHash: Uint8Array; creator: PublicKey; identity: PqIdentity; ledger: LeafLedger; freezeNotAfter?: number } & SignGuardOptions,
): Promise<{ message: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array }> {
  const kind = args.kind as 1 | 2 | 3;
  if (![1, 2, 3].includes(kind)) throw new Error(`unknown authorization kind ${args.kind}`);
  const l = launchOf(chain(), launch);
  if (!l.state.creator.equals(args.creator)) throw new Error(`refusing to sign: the launch was created by ${l.state.creator.toBase58()}, not by this wallet (${args.creator.toBase58()})`);
  if (!bytesEqual(l.state.pqIdentity, args.identity.identityId)) throw new Error("refusing to sign: the launch names another post-quantum identity (this signature would only burn a leaf)");
  // A time it signs (an activation time, a freeze expiry): the network's clock must agree with this device's.
  const clock = kind === 3 ? null : mockCheckClockSkew({});
  if (kind === 2) {
    if (args.freezeNotAfter === undefined) throw new TypeError("refusing to sign: a freeze (kind 2) needs freezeNotAfter, the last time it may be used (the notAfter of its freezePayload)");
    const notAfter = BigInt(args.freezeNotAfter);
    if (clock !== null && notAfter > clock.localSecs + FREEZE_MAX_VALID_SECS) {
      throw new Error("A freeze approval can be used for at most 24 hours. Nothing was signed: pick a shorter time and sign again.");
    }
    // Like the SDK: a freeze approval that could not land before its last second is never signed (no one-time key spent).
    if (clock !== null && clock.clusterSecs + 60n > notAfter) {
      throw new Error("This freeze approval has expired. Nothing was signed: start again to sign a new freeze.");
    }
  }
  const message = authMessage({ program: PROGRAM_IDS.launchpad, launch, creator: args.creator, kind, payloadHash: args.payloadHash }).bytes;
  const ledger = args.ledger;
  const id = args.identity.identityId;
  return withSigningLock(launch, args.signingLock, async () => {
    const used = await fetchIdentityLeaves(conn, id);
    const mh = toHex(sha256(message));
    const p = prog();
    // This launch's approvals the ledger holds: those whose authorization record holds them landed with success.
    const approvals: { kind: number; record: Awaited<ReturnType<LeafLedger["list"]>>[number] }[] = [];
    for (const r of await ledger.list(id)) {
      if (r.signature === null || r.message === null) continue;
      const f = authMessageFields(fromHexBytes(r.message), launch);
      if (f === null) continue;
      let record = r;
      if (r.status !== "landed" && r.status !== "burned" && pqIdentity.leafUsed(used, r.leaf) && p.auths[authKey(launch, f.kind, f.payloadHash)] !== undefined) {
        await ledger.markLanded(id, r.leaf, { attested: true });
        record = (await ledger.get(id, r.leaf)) ?? r;
      }
      approvals.push({ kind: f.kind, record });
    }
    const mine = await ledger.findByMessage(id, sha256(message));
    const rebuild = mine !== null && mine.signature !== null && leafLedger.holdsMessageLeaf(mine);
    if (!rebuild) {
      const unlanded = approvals.filter((a) => a.record.messageHash !== mh && a.kind === kind && countsAsUnlanded(a.record));
      if (unlanded.length >= MAX_UNLANDED_SIGNATURES && args.acknowledgeExtraSignatures !== true) {
        throw new SignatureCapError(launch, kind, unlanded.map((a) => a.record.leaf), MAX_UNLANDED_SIGNATURES);
      }
    }
    const s = await leafLedger.signAtNextLeaf(ledger, args.identity.keyPair, message, used, { launch });
    return { message, lmsPublicKey: args.identity.publicKey, leaf: s.leaf, signature: s.signature };
  });
}

const fromHexBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

/**
 * MOCK `checkGraphRecipients` (SDK 0.9.0, audit 4 C1): each payee checked like a fee recipient on the simulated chain,
 * and those without a wSOL account yet (skipped, their share kept until they open one).
 */
async function checkGraphRecipients(_conn: Connection, recipients: readonly PublicKey[]): Promise<GraphRecipientsCheck> {
  await latency("read");
  for (const r of recipients) if (!(r instanceof PublicKey)) throw new TypeError("every graph recipient must be a PublicKey");
  const s = chain();
  const refusals: string[] = [];
  const warnings: string[] = [];
  const withoutAccount: PublicKey[] = [];
  recipients.forEach((r, i) => {
    const label = `recipients[${i}] (${r.toBase58()})`;
    const c = tokenRecipientCheck(s, r, WSOL_MINT, KNOWN_ACCOUNTS.splToken);
    for (const reason of c.refusals) refusals.push(`${label}: ${reason}`);
    for (const w of c.warnings) warnings.push(`${label}: ${w}`);
    if (c.ok && !tokenAccountExists(s, r, WSOL_MINT)) {
      withoutAccount.push(r);
      warnings.push(`${label}: has no wSOL account yet: until it creates one, the autopilot skips it and its share stays in the treasury (keepers never pay to create it)`);
    }
  });
  return { ok: refusals.length === 0, refusals, warnings, withoutAccount };
}

export const programmableMock: ProgrammableBackend = {
  available: true,
  walletAuthorize: true,
  buildBindMintTx,
  autopilotSetupCost,
  prepareAuthorizeFromPayer,
  signAuthorization,
  checkGraphRecipients,
  fetchLaunchRules,
  fetchRulesRecord,
  buildPublishRulesTx,
  rulesRecordRent,
  bindRulesToAttestation,
  fetchAutopilot,
  fetchMigrationPrice,
  fetchGraphBytes,
  listAutopilotRuns,
  findDueSteps,
  fetchAuthorization,
  fetchIdentityLeaves,
  buildInitAutopilotTx,
  buildPublishGraphTx,
  buildPqAuthorizeTx,
  buildActivateGraphTx,
  buildApplyPendingTx,
  buildFreezeGraphTx,
  buildRevokeOperatorTx,
  buildRunStepTx,
};
