/**
 * The autopilot's graph changes (programs/noised-autopilot
 * src/instructions/governance.rs): `activate` (queue a published graph),
 * `freeze` (make the active graph permanent) and `revoke_operator` (remove the
 * active graph's operator). Each needs an `Authorization` the launchpad wrote
 * after verifying, on-chain, an LMS signature by the launch's post-quantum
 * identity over the exact change (`../pq/authorize.ts`, `buildPqAuthorizeTx`
 * with `activationPayload` / `freezePayload` / `revokePayload`); no Ed25519
 * key can change anything. Anyone may send them: the authorization
 * authorizes, the fee payer only pays.
 *
 * The program's rules, which every builder checks first on live accounts
 * (the cluster clock for time) and refuses with the program's error name:
 *
 * - the authorization is the launchpad's, at `["auth", launch, [kind],
 *   payloadHash]`, written (version 1) for this launch by the launch's
 *   identity (`InvalidAuthorization` otherwise);
 * - it is used once, never after a newer one it could undo, ordered by
 *   `(slot, address)` (`checkFresh`: `StaleAuthorization`);
 * - `activate`: never once frozen; a first graph (none active or queued) at
 *   `activateAt >= now`; a replacement at least 72 hours after both now and
 *   the authorization's landing (`Frozen`, `ActivationInPast`,
 *   `TimelockTooShort`; `checkActivation`); the queued graph takes effect
 *   with `apply_pending` at or after `activateAt`;
 * - `freeze(not_after)`: not frozen yet, a graph active (`Frozen`,
 *   `NoActiveGraph`), then no later than the `notAfter` its authorization
 *   signed, that second included (`FreezeExpired`; `checkFreezeWindow`;
 *   review 4, R5), then the authorization over `freezePayload(autopilot,
 *   activeGraph, notAfter)`. A freeze that was landed and then withheld is
 *   usable only until the time its signer chose;
 * - `revoke_operator`: an operator to remove (`NoOperator`); allowed on a
 *   frozen graph; the authorization (payload v3, audit 4, A4-3) names the
 *   authorization that activated the running graph (`Autopilot.active_auth`),
 *   so it is bound to that one activation.
 *
 * Builders return unsigned legacy transactions with measured, tight compute
 * limits (`AUTOPILOT_COMPUTE_UNITS`: activate, freeze, revokeOperator).
 */
import { Transaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { bytesEqual, I64_MAX, I64_MIN } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { AUTHORIZATION, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { fetchAuthorization, fetchLaunch } from "../launch/accounts.js";
import { clusterUnixTime } from "../launch/window.js";
import { authorizationAddress, autopilotAddress, graphRecordAddress } from "../pda.js";
import { activationPayload, checkActivation, checkFreezeWindow, checkFresh, freezePayload, revokePayload, type AuthMark } from "../programmable/autopilot/logic.js";
import { computeBudgetInstructions, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import type { AuthorizationAccount, LaunchAccount } from "../types.js";
import { fetchAutopilot, fetchGraph, type AutopilotAccount } from "./accounts.js";
import { AUTOPILOT_COMPUTE_UNITS, legacySize } from "./builders.js";

/** Legacy transaction size limit (bytes). */
const LEGACY_LIMIT = 1_232;

const codec = (): ReturnType<typeof idlCodecs>["autopilot"] => idlCodecs().autopilot;

const refuse = (error: string, why: string): Error => new Error(`refusing to build: ${why} (the program would fail with ${error})`);

function checkHash(name: string, h: unknown): asserts h is Uint8Array {
  if (!(h instanceof Uint8Array) || h.length !== 32) throw new TypeError(`${name} must be 32 bytes`);
}

/** Throws unless `t` is bigint unix seconds in the i64 range. Internal. */
export function checkUnixSecs(name: string, t: unknown): asserts t is bigint {
  if (typeof t !== "bigint") throw new TypeError(`${name} must be bigint unix seconds`);
  if (t < I64_MIN || t > I64_MAX) throw new RangeError(`${name} must fit an i64`);
}

/** "2026-01-01T01:00:00Z (unix 1767229200)"; times outside years 1970-9999 stay numeric. Internal. */
export function unixTimeText(t: bigint): string {
  if (t < 0n || t > 253_402_300_799n) return `unix ${t}`;
  return `${new Date(Number(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")} (unix ${t})`;
}

// ------------------------------------------------------------ instructions ---

/** `activate(activate_at)`: accounts `[autopilot (writable), launch, graph, authorization]` (the IDL's order). Pure. */
export function activateInstruction(launch: PublicKey, graphHash: Uint8Array, authorization: PublicKey, activateAt: bigint): TransactionInstruction {
  checkHash("graphHash", graphHash);
  if (typeof activateAt !== "bigint") throw new TypeError("activateAt must be bigint unix seconds");
  return buildInstruction(
    codec(),
    PROGRAM_IDS.autopilot,
    "activate",
    { autopilot: autopilotAddress(launch), launch, graph: graphRecordAddress(launch, graphHash), authorization },
    { activateAt },
  );
}

/**
 * `freeze(not_after)`: accounts `[autopilot (writable), launch, authorization]`
 * (the IDL's order), data = discriminator || i64le not_after (the `notAfter`
 * the authorization signed). Pure.
 */
export function freezeInstruction(launch: PublicKey, authorization: PublicKey, notAfter: bigint): TransactionInstruction {
  checkUnixSecs("notAfter", notAfter);
  return buildInstruction(codec(), PROGRAM_IDS.autopilot, "freeze", { autopilot: autopilotAddress(launch), launch, authorization }, { notAfter });
}

/** `revoke_operator`: accounts `[autopilot (writable), launch, authorization]`. Pure. */
export function revokeOperatorInstruction(launch: PublicKey, authorization: PublicKey): TransactionInstruction {
  return buildInstruction(codec(), PROGRAM_IDS.autopilot, "revoke_operator", { autopilot: autopilotAddress(launch), launch, authorization });
}

// ------------------------------------------------------------ shared checks ---

async function finish(conn: Connection, feePayer: PublicKey, ix: TransactionInstruction, units: number, opts: ComputeBudgetOptions): Promise<Transaction> {
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(opts, units));
  tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  const size = legacySize(tx);
  if (size > LEGACY_LIMIT) throw new Error(`the transaction would be ${size} bytes, over the ${LEGACY_LIMIT}-byte legacy limit`);
  return tx;
}

async function autopilotOf(conn: Connection, launch: PublicKey): Promise<AutopilotAccount> {
  const a = await fetchAutopilot(conn, launch);
  if (a === null) throw refuse("AccountNotInitialized", "this launch has no autopilot yet (buildInitAutopilotTx)");
  return a;
}

const KIND_TEXT: Readonly<Record<number, string>> = {
  1: "activation of this graph at this time",
  2: "freeze of the active graph until this time",
  3: "removal of the active graph's operator (for its current activation)",
};

/**
 * The program's `use_authorization`, before anything is sent: the launch
 * (`NotALaunch`), the authorization written for it by its identity at the
 * address of `kind` and `payloadHash` (`InvalidAuthorization`), and newer
 * than the latest used of the kinds it could undo (`StaleAuthorization`).
 */
async function usableAuthorization(conn: Connection, launch: PublicKey, a: AutopilotAccount, kind: 1 | 2 | 3, payloadHash: Uint8Array): Promise<{ launch: LaunchAccount; auth: AuthorizationAccount }> {
  const l = await fetchLaunch(conn, launch);
  if (l === null) throw refuse("NotALaunch", `launch ${launch.toBase58()} does not exist`);
  const address = authorizationAddress(launch, kind, payloadHash);
  const auth = await fetchAuthorization(conn, launch, kind, payloadHash);
  if (auth === null || !auth.authorized) {
    throw refuse(
      "InvalidAuthorization",
      `no authorization of the ${KIND_TEXT[kind]} is written at ${address.toBase58()}${auth === null ? "" : " (a signature landed there but only burned its leaf)"}: sign it first with the launch's identity (buildPqAuthorizeTx, kind ${kind})`,
    );
  }
  if (!bytesEqual(auth.pqIdentity, l.pqIdentity)) throw refuse("InvalidAuthorization", "the authorization was not signed by the identity this launch names");
  const marks = a.authMarks.map((m) => ({ slot: m.slot, key: m.key.toBytes() })) as unknown as readonly [AuthMark, AuthMark, AuthMark];
  if (marks.length !== 3) throw new Error("the autopilot account holds an unexpected number of authorization marks");
  const stale = checkFresh({ slot: auth.slot, key: address.toBytes() }, marks, kind);
  if (stale !== null) {
    throw refuse(
      stale,
      kind === AUTHORIZATION.KINDS.GRAPH_ACTIVATE
        ? "this activation was already used, or a newer activation or operator removal was used since it was signed: sign a new one"
        : kind === AUTHORIZATION.KINDS.GRAPH_FREEZE
          ? "this freeze was already used, or a newer activation was used since it was signed: sign a new one"
          : "this operator removal was already used, or a newer one was: sign a new one (planRevokeOperator)",
    );
  }
  return { launch: l, auth };
}

// ------------------------------------------------------------ builders ---

/** `buildActivateTx` options. */
export interface ActivateTxOptions extends ComputeBudgetOptions {
  /** The published graph to queue (`graphHash(bytes)`). */
  graphHash: Uint8Array;
  /** When it may take effect (unix seconds): exactly the time the authorization signed. */
  activateAt: bigint;
  /** Judge the time rules this many seconds after the cluster clock (default 0: the clock as read). */
  landingMarginSecs?: bigint | undefined;
}

/**
 * `activate(activate_at)`: queue the published graph `graphHash` to take
 * effect at `activateAt`, with the authorization the launch's identity signed
 * over `activationPayload(autopilot, graphHash, activateAt)` (kind 1). Reads
 * the autopilot, the graph record, the launch and the authorization, and
 * refuses what the program would refuse, in its order: the authorization
 * (`InvalidAuthorization`, `StaleAuthorization`), then the time rules on the
 * cluster clock (`Frozen`, `ActivationInPast`, `TimelockTooShort`). After
 * `activateAt`, anyone sends `apply_pending` (`buildApplyPendingTx`).
 */
export async function buildActivateTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ActivateTxOptions): Promise<Transaction> {
  checkHash("graphHash", opts.graphHash);
  if (typeof opts.activateAt !== "bigint") throw new TypeError("activateAt must be bigint unix seconds");
  const margin = opts.landingMarginSecs ?? 0n;
  if (typeof margin !== "bigint" || margin < 0n) throw new RangeError("landingMarginSecs must be a non-negative bigint");
  const a = await autopilotOf(conn, launch);
  const graph = await fetchGraph(conn, launch, opts.graphHash);
  if (graph === null) throw refuse("AccountNotInitialized", "this graph is not published for this launch (buildPublishGraphTx first)");
  const payload = activationPayload(a.publicKey, opts.graphHash, opts.activateAt);
  const { auth } = await usableAuthorization(conn, launch, a, 1, payload);
  const now = (await clusterUnixTime(conn)) + margin;
  const timing = checkActivation({ activeGraph: a.activeGraph, pendingGraph: a.pendingGraph, frozen: a.frozen, now, activateAt: opts.activateAt, authUnixTime: auth.unixTime });
  if (timing !== null) {
    const why: Record<string, string> = {
      Frozen: "the autopilot is frozen forever: no graph can be queued",
      ActivationInPast: `the start time ${opts.activateAt} has already passed (cluster time ${now}): sign an activation with a later time`,
      TimelockTooShort: `a replacement graph may start no earlier than 72 hours after both now and the authorization's landing (${
        (now > auth.unixTime ? now : auth.unixTime) + 259_200n
      }); this one starts at ${opts.activateAt}: sign an activation with a later time`,
      MathOverflow: "the time is out of range",
    };
    throw refuse(timing, why[timing] ?? timing);
  }
  const ix = activateInstruction(launch, opts.graphHash, authorizationAddress(launch, 1, payload), opts.activateAt);
  return finish(conn, payer, ix, AUTOPILOT_COMPUTE_UNITS.activate, opts);
}

/** `buildFreezeTx` options. */
export interface FreezeTxOptions extends ComputeBudgetOptions {
  /** The last second the freeze may be used (unix seconds, inclusive): exactly the `notAfter` the authorization signed (`freezePayload`). */
  notAfter: bigint;
  /** Judge the expiry this many seconds after the cluster clock (default 0: the clock as read). */
  landingMarginSecs?: bigint | undefined;
}

/**
 * `freeze(not_after)`: make the active graph permanent (a queued update is
 * cancelled), with the authorization the launch's identity signed over
 * `freezePayload(autopilot, activeGraph, notAfter)` (kind 2). Refuses what
 * the program would refuse, in its order: `Frozen`, `NoActiveGraph`, then
 * `FreezeExpired` (the cluster clock plus `landingMarginSecs` is past
 * `notAfter`: the approval expired, sign a new one), then
 * `InvalidAuthorization` / `StaleAuthorization`.
 */
export async function buildFreezeTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: FreezeTxOptions): Promise<Transaction> {
  if (opts === null || typeof opts !== "object") throw new TypeError("pass { notAfter }: the notAfter the freeze authorization signed");
  checkUnixSecs("notAfter", opts.notAfter);
  const margin = opts.landingMarginSecs ?? 0n;
  if (typeof margin !== "bigint" || margin < 0n) throw new RangeError("landingMarginSecs must be a non-negative bigint");
  const a = await autopilotOf(conn, launch);
  if (a.frozen) throw refuse("Frozen", "the graph is already frozen forever");
  if (!a.hasActiveGraph) throw refuse("NoActiveGraph", "no graph is active: there is nothing to freeze");
  const now = (await clusterUnixTime(conn)) + margin;
  if (checkFreezeWindow(now, opts.notAfter) !== null) {
    throw refuse(
      "FreezeExpired",
      `the freeze approval expired at ${unixTimeText(opts.notAfter)} (cluster time ${now - margin}${margin === 0n ? "" : `, plus ${margin} s to land`}): sign a new one`,
    );
  }
  const payload = freezePayload(a.publicKey, a.activeGraph, opts.notAfter);
  await usableAuthorization(conn, launch, a, 2, payload);
  return finish(conn, payer, freezeInstruction(launch, authorizationAddress(launch, 2, payload), opts.notAfter), AUTOPILOT_COMPUTE_UNITS.freeze, opts);
}

/** A planned operator removal (`planRevokeOperator`): what the launch's identity signs (kind 3). */
export interface RevokeOperatorPlan {
  readonly launch: PublicKey;
  /** `["autopilot", launch]`. */
  readonly autopilot: PublicKey;
  /** The running graph whose operator is removed. */
  readonly graphHash: Uint8Array;
  /** The operator removed. */
  readonly operator: PublicKey;
  /** The authorization that activated the running graph (`Autopilot.active_auth`): the revocation binds this one activation. */
  readonly activeAuth: PublicKey;
  /** `revokePayload(autopilot, graphHash, operator, activeAuth)` (payload v3). */
  readonly payloadHash: Uint8Array;
  readonly kind: 3;
  /** Where the approval will be written: `["auth", launch, [3], payloadHash]`. */
  readonly authorization: PublicKey;
  /** One plain-English line for the UI. */
  readonly plain: string;
}

/**
 * Plan removing the running graph's operator: the payload (v3, audit 4,
 * A4-3) names the running graph, the operator and the authorization that
 * activated the graph (`Autopilot.active_auth`), read from the account. The
 * approval works only for this activation: once another activation is
 * applied it is dead (`StaleAuthorization` / `InvalidAuthorization`), and a
 * new one must be signed. Refuses a launch without an autopilot and a graph
 * without an operator (`NoOperator`). Sign it with `buildPqAuthorizeTx`
 * (kind 3, `payloadHash`), then send `buildRevokeOperatorTx`.
 */
export async function planRevokeOperator(conn: Connection, launch: PublicKey): Promise<RevokeOperatorPlan> {
  const a = await autopilotOf(conn, launch);
  if (a.operatorOrNull === null) throw refuse("NoOperator", "the active graph has no operator to remove");
  const payloadHash = revokePayload(a.publicKey, a.activeGraph, a.operatorOrNull, a.activeAuth);
  return {
    launch,
    autopilot: a.publicKey,
    graphHash: Uint8Array.from(a.activeGraph),
    operator: a.operatorOrNull,
    activeAuth: a.activeAuth,
    payloadHash,
    kind: 3,
    authorization: authorizationAddress(launch, 3, payloadHash),
    plain: `Remove the operator ${a.operatorOrNull.toBase58()} from the running plan. This approval only works for the plan as it was switched on now: if a new plan is switched on first, approve the removal again.`,
  };
}

/**
 * `revoke_operator`: remove the active graph's operator (its operator-only
 * steps stop; the same operator is taken from a queued graph), with the
 * authorization over `revokePayload(autopilot, activeGraph, operator,
 * activeAuth)` (kind 3, payload v3: `activeAuth` is `Autopilot.active_auth`,
 * the authorization that activated the running graph). Allowed on a frozen
 * graph. Refuses `NoOperator`, then `InvalidAuthorization` /
 * `StaleAuthorization` (a revocation signed for an earlier activation is
 * dead: plan and sign a new one, `planRevokeOperator`).
 */
export async function buildRevokeOperatorTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const a = await autopilotOf(conn, launch);
  if (a.operatorOrNull === null) throw refuse("NoOperator", "the active graph has no operator to remove");
  const payload = revokePayload(a.publicKey, a.activeGraph, a.operatorOrNull, a.activeAuth);
  await usableAuthorization(conn, launch, a, 3, payload);
  return finish(conn, payer, revokeOperatorInstruction(launch, authorizationAddress(launch, 3, payload)), AUTOPILOT_COMPUTE_UNITS.revokeOperator, opts);
}
