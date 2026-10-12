/**
 * The creator's launch, start to finish, as this browser runs it (PQ v2,
 * on-chain metadata; SDK04_READY.txt section 2):
 *
 *   1. create the launch                 the wallet signs create_launch
 *   2. fund a temporary fee account      the wallet sends it a small amount
 *   3. store the token details on Solana publish_metadata, from that account
 *      and the custom launch rules      publish_rules, bound by step 4 (the
 *                                       attestation's message v3 signs their hash)
 *   4. sign with the quantum key         attest_launch, from that account (the
 *                                        leaf is reserved in this browser's
 *                                        ledger before the signature exists)
 *   5. open at the signed time           launch, from that account, sent by this
 *                                        app at the opening if the tab is open
 *                                        (anyone may send it inside the window)
 *   6. switch on the Autopilot           (launches that have one) init_autopilot,
 *                                        publish_graph, pq_authorize signed by the
 *                                        quantum key, activate and apply_pending,
 *                                        all from that account; a first autopilot
 *                                        has no waiting period
 *   7. return the leftover SOL           the temporary account back to the wallet
 *
 * Every step is decided from the chain, not from memory: each tick reads the
 * launch, its attestation, its record and the temporary account's balance,
 * and does the one thing that comes next. What only this browser knows is
 * kept durably in IndexedDB (`LaunchProgress`): the plan (seed, parameters,
 * the record's exact bytes), the window it signed, and the temporary
 * account's secret key, which only ever holds the small fee amount and is
 * wiped once the account is swept. A reload resumes from there; the leaf
 * ledger makes a resumed signature the same leaf and the same bytes.
 *
 * Rules kept here, from the SDK and the review:
 *   - nothing is signed or sent unless the endpoint serves this build's
 *     cluster (lib/clusterGate.ts), and every automatic transaction is
 *     simulated first;
 *   - the quantum key signs only after the launch and the record are final
 *     (the SDK refuses otherwise; this module waits and tries again);
 *   - a signature whose landing only burned its leaf is shown as such, with
 *     the SDK's reasons, and a new one is made only when the person asks; the
 *     SDK refuses a third after two burn-only landings (`AttestRetryLimitError`);
 *   - a landing that did not happen is sent again with the SAME signature
 *     (the SDK resends after ConstraintSeeds itself; this module rebuilds
 *     with the same inputs, which gives the same leaf and bytes);
 *   - a window must still have at least 60 s left when the attestation lands
 *     (audit round 3 F1): the opening is picked with a margin, and moved
 *     before the first signature if the picked time came too close;
 *   - when the window passes without the launch opening, the creator picks
 *     a new time and the quantum key signs it at the next leaf, which
 *     replaces the expired attestation (the published details are reused);
 *   - SDK 0.9.0 (audit 4): every quantum signature runs under this
 *     browser's cross-tab signing lock (navigator.locks) and, where the build
 *     lists a second RPC, checks the network's clock against it too. The
 *     SDK's refusals stop the flow in plain words, before anything is
 *     reserved or signed: a key used on another device (`UnknownLeavesError`:
 *     import that device's records; see components/KeyUsedElsewhere), a clock
 *     that disagrees with the network (`ClockSkewError`), and three earlier
 *     signatures that never landed (`SignatureCapError`: one more only after
 *     the person confirms it).
 */
import { Keypair, PublicKey, type Connection, type Transaction } from "@solana/web3.js";

import { errorMessage, formatTimestamp, toHex } from "./format";
import { openExistingDb } from "./legacyDb";
import { activationPayload, AUTH_KIND, graphHashOf, graphVerifies, rulesHashOf } from "./programmable";
import { signRefusalOf, utcText } from "./signErrors";
import {
  AttestPayerFundingError,
  autopilotAddress,
  autopilotTreasuryAddress,
  AttestRetryLimitError,
  ClusterMismatchError,
  PendingAttestationError,
  planLaunch,
  PublishPayerFundingError,
  replanLaunchWindow,
  validateLaunchWindow,
  type AttestationOutcome,
  type AttestLaunchReady,
  type BurnReason,
  type Cluster,
  type LaunchFlowStatus,
  type LaunchParams,
  type LaunchPlan,
  type LeafLedger,
  type LedgerLock,
  type PqIdentity,
  type TokenMetaInput,
} from "./noised";
import type * as Phx from "./noised";

// ---------------------------------------------------------------- numbers ---

/** Length of every window this app signs: the longest allowed (1 hour), so anyone has the most time to open it. */
export const WINDOW_SECS = 3_600n;
/** Seconds between the quantum key's signature and an "as soon as it's ready" opening (time for it to land and for this tab to be ready to open). */
export const OPEN_LEAD_SECS = 90n;
/** Kept on the temporary account on top of what the steps cost: estimate error and a new opening time's fee. Comes back in step 6. */
export const FUNDING_MARGIN_LAMPORTS = 2_000_000n;
/** Automatic tries of a step that failed before the person is asked. */
const MAX_AUTO_RESENDS = 3;
/** Inside its window the opening is tried for longer (every 3 s for about a minute): the cluster's clock may lag by a few seconds. */
const MAX_OPEN_TRIES = 20;

// ------------------------------------------------------------- progress ---

/** The record's exact bytes, hex (the hash the identity signs covers exactly these). */
export interface StoredRecord {
  name: string;
  symbol: string;
  flags: number;
  uri: string;
  doc: string;
}

/** One landing of a signature that did not count (it only used up one of the key's one-time signatures). */
export interface StoredBurn {
  leaf: number;
  reasons: BurnReason[];
  detail: string;
  /** The window that message signed (a new signature always signs another message). */
  window: { notBefore: string; notAfter: string };
  at: number;
}

/**
 * What this browser keeps about a launch it is running (IndexedDB, one record per launch). Everything else is read
 * from the chain on every step.
 */
export interface LaunchProgress {
  v: 1;
  /** `${cluster}:${launch}`. */
  id: string;
  cluster: Cluster;
  launch: string;
  creator: string;
  /** The token's name and symbol, for lists (the record holds the signed bytes). */
  name: string;
  symbol: string;
  /** The quantum key's identity index and its LMS public key (public; the identity id is `params.pqIdentity`). */
  identityIndex: number;
  lmsPublicKey: string;
  launchSeed: string;
  /** The launch parameters, serialized (bigint as decimal strings, keys as base58, bytes as hex). */
  params: string;
  record: StoredRecord;
  /**
   * The custom launch rules (PXR1 bytes, hex), or absent / null for none. Published before the quantum key signs, and
   * bound by its signature (attestation v3): the launch then opens only with exactly these rules.
   */
  rules?: string | null;
  /**
   * The Autopilot to switch on right after the launch opens (PXG1 bytes, hex), or absent / null for none. Its first
   * activation needs no waiting period: the quantum key signs it, and it starts a minute or two later.
   */
  autopilot?: string | null;
  /** The start time the quantum key signs for the Autopilot (unix seconds), kept so a resumed signature is the same one. */
  autopilotAt?: string | null;
  /** The Autopilot is switched on (or scheduled and applied), or can no longer be set up from here. */
  autopilotDone?: boolean;
  /** The opening the creator asked for: as soon as it is signed, or a unix second. */
  opensAt: "asap" | string;
  /** The window of the last message the quantum key signed (null before the first signature). */
  window: { notBefore: string; notAfter: string } | null;
  /** The temporary fee account: its address, and its 64-byte secret key (hex) until it is swept. */
  payer: string;
  payerSecret: string | null;
  /** Signatures shown in the tracker. */
  sent: { create: string | null; fund: string[]; publish: string | null; rules?: string | null; attest: string | null; open: string | null; autopilot?: string[]; sweep: string | null };
  burns: StoredBurn[];
  /** The mint, once the launch is open (by this app or anyone else). */
  mint: string | null;
  /** Lamports returned to the creator's wallet. */
  returned: string | null;
  /** The person asked to go on: wallet steps may open the review dialog (cleared when they cancel one). */
  go: boolean;
  /** A new opening time is wanted (the window passed: audit round 3 F1). */
  newTime: boolean;
  /** The person allowed one more signature after a burn-only landing. */
  signAgain: boolean;
  /**
   * The person confirmed ONE more quantum signature although three earlier ones of this launch never landed (SDK 0.9.0
   * `SignatureCapError`: `acknowledgeExtraSignatures`). Cleared as soon as that signature exists.
   */
  extraSignature?: boolean;
  /** Nothing more to do (opened and swept, or given up and swept). */
  done: boolean;
  /** The person stopped this launch (its temporary account is swept). */
  abandoned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LaunchProgressStore {
  get(id: string): Promise<LaunchProgress | null>;
  put(p: LaunchProgress): Promise<void>;
  list(): Promise<LaunchProgress[]>;
}

/** Thrown when this browser cannot keep a launch's progress (no IndexedDB): nothing is started, nothing is funded. */
export class LaunchStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchStorageError";
  }
}

/** IndexedDB database of the launches this browser runs (separate from the key records: it holds the temporary accounts' keys). */
export const LAUNCH_DB = "noised-launches";
/**
 * The same database under the project's earlier name (the rename to Noised). Each time the store opens, every launch
 * kept there that this database does not hold is copied in (never overwriting, never deleting): a launch's progress
 * holds its temporary account's key, which may hold SOL.
 */
export const LEGACY_LAUNCH_DB = "phalanx-launches";
const FLOWS = "flows";

function parseProgress(v: unknown): LaunchProgress | null {
  if (typeof v !== "string") return null;
  try {
    const p = JSON.parse(v) as Partial<LaunchProgress>;
    if (p.v !== 1 || typeof p.id !== "string" || typeof p.launch !== "string" || typeof p.params !== "string" || typeof p.record !== "object" || p.record === null) return null;
    return p as LaunchProgress;
  } catch {
    return null;
  }
}

/** The progress store on IndexedDB (strict durability: the temporary account's key is on disk before it is funded). */
export function idbLaunchStore(factory: IDBFactory): LaunchProgressStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(LAUNCH_DB, 1);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(FLOWS)) r.result.createObjectStore(FLOWS);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
      r.onblocked = () => reject(new Error("IndexedDB is blocked by another tab running an older version of this app: close it and reload."));
    })
      .then(async (d) => {
        await copyLegacyLaunches(factory, d);
        return d;
      })
      .catch((e: unknown) => {
        opened = null;
        throw e;
      }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const t = mode === "readwrite" ? d.transaction(FLOWS, mode, { durability: "strict" }) : d.transaction(FLOWS, mode);
      let result: T;
      const r = fn(t.objectStore(FLOWS));
      r.onsuccess = () => {
        result = r.result;
      };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error ?? r.error ?? new Error("IndexedDB transaction failed"));
      t.onabort = () => reject(t.error ?? r.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    get: async (id) => parseProgress(await tx<unknown>("readonly", (s) => s.get(id))),
    put: async (p) => {
      await tx("readwrite", (s) => s.put(JSON.stringify(p), p.id));
    },
    list: async () => (await tx<unknown[]>("readonly", (s) => s.getAll())).map(parseProgress).filter((p): p is LaunchProgress => p !== null),
  };
}

/** Copy every launch of `LEGACY_LAUNCH_DB` (if this browser has it) that `d` does not hold. Returns how many. */
export async function copyLegacyLaunches(factory: IDBFactory, d: IDBDatabase): Promise<number> {
  const legacy = await openExistingDb(factory, LEGACY_LAUNCH_DB, [FLOWS]);
  if (legacy === null) return 0;
  const run = <T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = mode === "readwrite" ? db.transaction(FLOWS, mode, { durability: "strict" }) : db.transaction(FLOWS, mode);
      let result: T;
      const r = fn(t.objectStore(FLOWS));
      r.onsuccess = () => {
        result = r.result;
      };
      r.onerror = (ev) => {
        // The launch is already here: kept as it is.
        if (r.error?.name === "ConstraintError") {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };
      t.oncomplete = () => resolve(result);
      t.onabort = () => reject(t.error ?? r.error ?? new Error("IndexedDB transaction aborted"));
    });
  let copied = 0;
  try {
    for (const key of await run<IDBValidKey[]>(legacy, "readonly", (s) => s.getAllKeys())) {
      const value = await run<unknown>(legacy, "readonly", (s) => s.get(key));
      if (value === undefined) continue;
      // Undefined when the key exists (the refused add's ConstraintError is prevented): that launch is kept as it is.
      const added: IDBValidKey | undefined = await run<IDBValidKey>(d, "readwrite", (s) => s.add(value, key));
      if (added !== undefined) copied++;
    }
  } finally {
    legacy.close();
  }
  return copied;
}

/** A store in memory (tests). */
export function memoryLaunchStore(): LaunchProgressStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: async (id) => parseProgress(raw.get(id)),
    put: async (p) => void raw.set(p.id, JSON.stringify(p)),
    list: async () => [...raw.values()].map(parseProgress).filter((p): p is LaunchProgress => p !== null),
  };
}

// --------------------------------------------------------- serialization ---

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("not hex");
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

/** Launch parameters as JSON: bigints as `{ "$n": "…" }`, keys as `{ "$k": base58 }`, bytes as `{ "$b": hex }`. */
export function encodeParams(p: LaunchParams): string {
  return JSON.stringify(p, function (this: Record<string, unknown>, key: string, v: unknown) {
    const raw = this[key];
    if (typeof raw === "bigint") return { $n: raw.toString() };
    if (raw instanceof PublicKey) return { $k: raw.toBase58() };
    if (raw instanceof Uint8Array) return { $b: toHex(raw) };
    return v;
  });
}

export function decodeParams(text: string): LaunchParams {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (Object.keys(o).length === 1) {
        if (typeof o.$n === "string") return BigInt(o.$n);
        if (typeof o.$k === "string") return new PublicKey(o.$k);
        if (typeof o.$b === "string") return fromHex(o.$b);
      }
    }
    return v;
  }) as LaunchParams;
}

function storedRecord(r: { name: Uint8Array; symbol: Uint8Array; flags: number; uri: Uint8Array; doc: Uint8Array }): StoredRecord {
  return { name: toHex(r.name), symbol: toHex(r.symbol), flags: r.flags, uri: toHex(r.uri), doc: toHex(r.doc) };
}

/** The record's bytes as `planLaunch` takes them. */
export function recordOf(p: Pick<LaunchProgress, "record">): TokenMetaInput {
  return { name: fromHex(p.record.name), symbol: fromHex(p.record.symbol), flags: p.record.flags, uri: fromHex(p.record.uri), doc: fromHex(p.record.doc) };
}

/** The plan of a stored launch with the window `[notBefore, notBefore + WINDOW_SECS]` (pure; checks it is the same launch). */
export function planOf(p: LaunchProgress, notBefore: bigint, notAfter: bigint = notBefore + WINDOW_SECS): LaunchPlan {
  const { recipients, pqIdentity, ...params } = decodeParams(p.params);
  const plan = planLaunch({
    creator: new PublicKey(p.creator),
    identity: pqIdentity,
    params,
    recipients,
    metadata: recordOf(p),
    // Attestation v3: the quantum key signs the creator rules' hash with the launch (none: the zero hash).
    rules: rulesOf(p)?.bytes ?? null,
    opensAt: notBefore,
    windowSecs: notAfter - notBefore,
    launchSeed: fromHex(p.launchSeed),
  });
  if (plan.launch.toBase58() !== p.launch) throw new Error("the stored plan gives another launch address");
  return plan;
}

export function payerOf(p: Pick<LaunchProgress, "payerSecret">): Keypair | null {
  return p.payerSecret === null ? null : Keypair.fromSecretKey(fromHex(p.payerSecret));
}

/**
 * The window to sign now: as soon as possible (`OPEN_LEAD_SECS` from now) or the picked time, one hour long, never
 * opening so soon that less than the SDK's landing margin plus 60 s would be left (then it moves to as soon as
 * possible, and `moved` says so).
 */
export function chooseWindow(nowSecs: bigint, opensAt: "asap" | bigint): { notBefore: bigint; notAfter: bigint; moved: boolean } {
  const soonest = nowSecs + OPEN_LEAD_SECS;
  if (opensAt === "asap" || opensAt < soonest) return { notBefore: soonest, notAfter: soonest + WINDOW_SECS, moved: opensAt !== "asap" };
  return { notBefore: opensAt, notAfter: opensAt + WINDOW_SECS, moved: false };
}

/** Whether a window can still be signed at `nowSecs` (the SDK's own check with its landing margin). */
export function windowSignable(nowSecs: bigint, w: { notBefore: bigint; notAfter: bigint }): boolean {
  return validateLaunchWindow(w.notBefore, w.notAfter, { nowSecs }).ok;
}

// --------------------------------------------------------------- the env ---

/** A transaction the wallet signs, shown in the app's review dialog first. */
export interface WalletStep {
  title: string;
  summary: string[];
  build: () => Promise<Transaction>;
}

export type WalletOutcome = { status: "confirmed"; signature: string } | { status: "cancelled" } | { status: "failed"; error: string };

/** The adapter functions the flow uses (the app passes lib/noised; tests pass the simulated chain's). */
export type FlowBackend = Pick<
  typeof Phx,
  | "buildFundThrowawayPayerTx"
  | "buildLaunchTx"
  | "buildPlannedAttestTx"
  | "buildPlannedCreateLaunchTx"
  | "buildPlannedPublishTx"
  | "buildSweepPayerTx"
  | "confirmAttestation"
  | "getLaunchFlowStatus"
  | "landOrBurnPending"
  | "getSolBalance"
  | "launchPayerLamports"
  | "rentExemptLamports"
  | "sendAndConfirm"
  | "sendAttestLaunchTx"
  | "sendPublishMetadataTx"
  | "simulateAndExplain"
  | "throwawayPayerFunding"
  | "programmable"
>;

/** Seconds between the quantum key's Autopilot signature and its start (a first autopilot may start at once: this is only room to land). */
export const AUTOPILOT_LEAD_SECS = 120n;

export interface FlowEnv {
  readonly conn: Connection;
  readonly cluster: Cluster;
  readonly store: LaunchProgressStore;
  readonly backend: FlowBackend;
  /** The connected wallet (null: none). */
  readonly wallet: () => PublicKey | null;
  /** Review and approve a wallet transaction (the app's dialog). Called only after the person asked to go on. */
  readonly walletTx: (step: WalletStep) => Promise<WalletOutcome>;
  /**
   * The quantum key's launch identity, this browser's leaf ledger and its cross-tab lock, which every quantum signature
   * runs under (`signingLock`; throws when locked or without the key records).
   */
  readonly signer: (index: number) => Promise<{ identity: PqIdentity; leaves: LeafLedger; lock?: LedgerLock }>;
  /** A second, independent RPC of this build (null: it lists one): the network's clock must agree there too. */
  readonly secondConnection?: () => Connection | null;
  readonly keyUnlocked: () => boolean;
  /** The cluster's unix seconds. */
  readonly now: () => Promise<bigint>;
  /** Why nothing may be signed or sent on this connection now (lib/clusterGate.ts), or null. */
  readonly clusterRefusal: () => Promise<string | null>;
  /** Run `fn` holding this launch's lock across tabs (navigator.locks), so two tabs never send its steps at once. */
  readonly lock: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

// ------------------------------------------------------------------ view ---

/** The steps the tracker shows (six, and "autopilot" before the last one for a launch that switches one on). */
export type FlowStage = "create" | "fund" | "publish" | "sign" | "open" | "autopilot" | "return" | "done";

export const STAGES: readonly FlowStage[] = ["create", "fund", "publish", "sign", "open", "return"];

/** The steps of a launch with an Autopilot. */
export const STAGES_WITH_AUTOPILOT: readonly FlowStage[] = ["create", "fund", "publish", "sign", "open", "autopilot", "return"];

/** The steps a launch shows. */
export const stagesOf = (v: { autopilot: boolean }): readonly FlowStage[] => (v.autopilot ? STAGES_WITH_AUTOPILOT : STAGES);

/** What the flow needs from the person before it can go on (null: nothing, it goes on by itself). */
export type FlowNeed =
  | { kind: "go"; stage: "create" | "fund"; lamports: bigint | null }
  | { kind: "wallet"; message: string }
  | { kind: "key"; message: string }
  | { kind: "new-time"; closedAt: bigint }
  | { kind: "sign-again"; burn: StoredBurn }
  | { kind: "retry"; message: string }
  | { kind: "stopped"; message: string }
  /** The quantum key was used on another device or app (`UnknownLeavesError`): nothing was signed. */
  | { kind: "key-used-elsewhere"; count: number; identityIdHex: string; message: string }
  /** Three earlier signatures of this launch never landed (`SignatureCapError`): one more only if the person confirms. */
  | { kind: "signature-cap"; count: number; message: string };

export interface FlowView {
  id: string;
  launch: PublicKey;
  name: string;
  symbol: string;
  stage: FlowStage;
  /** Working on the stage now. */
  busy: boolean;
  /** What is going on, in plain words. */
  activity: string;
  need: FlowNeed | null;
  /** The signed window (null until the quantum key signed). */
  window: { notBefore: bigint; notAfter: bigint } | null;
  /** What step 2 sends to the temporary account, once known. */
  fundLamports: bigint | null;
  burns: StoredBurn[];
  mint: PublicKey | null;
  returned: bigint | null;
  /** A note to show once, e.g. the opening moved. */
  note: string | null;
  /** The launch switches on an Autopilot after it opens. */
  autopilot: boolean;
  /** When that Autopilot starts (unix seconds), once its quantum signature has a time. */
  autopilotAt: bigint | null;
  done: boolean;
  abandoned: boolean;
}

// ---------------------------------------------------------------- engine ---

type Next = { kind: "again"; ms: number } | { kind: "idle" };

const now = (): number => Date.now();

/**
 * The SDK's refusals and failures on this flow's path, in plain words (the SDK's own sentence follows in brackets
 * for anyone who needs it). Anything else is shown as it is.
 */
const PLAIN: readonly [RegExp, string][] = [
  [/created by \S+, not by this wallet/, "This launch was created by another wallet. Nothing was signed."],
  [/names another post-quantum identity/, "This launch names another quantum key. Nothing was signed."],
  [/params_hash differs/, "The launch's rules on Solana are not the ones you reviewed, so your quantum key did not sign. Nothing was signed."],
  [/already attested by another message/, "This launch already has a signed opening time that has not passed. Open it in that hour."],
  [/only burn a leaf with this window/, "That opening time can no longer be signed. Pick a new one."],
  [/no metadata record is published/, "Your token's details are not on Solana yet. They are stored first."],
  [/every leaf of this identity is used/, "Your quantum key has used all its one-time signatures for launches."],
  [/^refusing to publish: /, "Your token's details cannot be stored on Solana as they are."],
  [/^publish_metadata did not land/, "Storing your token's details did not go through. It is tried again."],
  [/^the attestation did not land/, "Your quantum signature did not reach Solana yet."],
  [/the throwaway payer (holds|would keep)/, "The temporary fee account does not hold the right amount for this step."],
];

/** When the last earlier, unlanded signature of a launch can no longer land (the end of its window, unix seconds). */
export function pendingUntil(e: PendingAttestationError): bigint {
  return e.pending.reduce((m, x) => (x.window.notAfter > m ? x.window.notAfter : m), 0n);
}

/** What the tracker says while an earlier signature could still land. */
export function pendingActivity(until: bigint): string {
  return `An earlier signature for this launch has not landed yet and could still open it until ${formatTimestamp(until)} (${utcText(until)}). Your quantum key signs the new time after that.`;
}

/** Plain words for an error the steps threw. */
export function plainError(e: unknown): string {
  const refusal = signRefusalOf(e);
  if (refusal !== null) return refusal.message;
  if (e instanceof PendingAttestationError) return pendingActivity(pendingUntil(e));
  if (e instanceof ClusterMismatchError) {
    return `This app signs for ${e.expected}, but the network connection is ${e.actual ?? "another network"}. Nothing was signed.`;
  }
  if (e instanceof AttestRetryLimitError) {
    return `Stopped after ${e.landings.length} signatures that did not count, to save your key's one-time signatures. ${e.landings.map((l) => l.detail).join("; ")}.`;
  }
  const m = errorMessage(e);
  const known = PLAIN.find(([re]) => re.test(m));
  return known === undefined ? m : `${known[1]} (${m})`;
}

/** "the window could not be used (...)" etc.: the SDK's reasons, in plain words for the tracker. */
export function burnReasonText(r: BurnReason): string {
  switch (r) {
    case "wrong-identity":
      return "it was signed by another quantum key than the one this launch names";
    case "record-missing":
      return "the token details were not stored on Solana yet when it arrived";
    case "invalid-window":
      return "less than a minute of its opening time was left when it arrived";
    case "already-attested":
      return "the launch already had a signed opening time that had not passed";
    case "rules-missing":
      return "the launch rules it signed were not stored on Solana yet when it arrived";
  }
}

/**
 * One launch's runner: ticks until it needs the person or is done. Ticks never overlap, and each one re-reads the
 * stored progress inside the launch's cross-tab lock before acting.
 */
export class LaunchRunner {
  private progress: LaunchProgress;
  private view: FlowView;
  private running = false;
  private rerun = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resends = 0;
  private stopped = false;
  private readonly listeners = new Set<() => void>();
  private readonly env: () => FlowEnv | null;

  constructor(env: () => FlowEnv | null, initial: LaunchProgress) {
    this.env = env;
    this.progress = initial;
    this.view = baseView(initial);
  }

  get id(): string {
    return this.progress.id;
  }

  snapshot(): FlowView {
    return this.view;
  }

  current(): LaunchProgress {
    return this.progress;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private publish(patch: Partial<FlowView>): void {
    this.view = { ...this.view, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Stop ticking (the page unloads, or tests). */
  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Tick now (or right after the running tick). Resolves when the ticks stop: the flow waits for the person, for a time, or is done. */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.rerun = true;
      return this.idle ?? Promise.resolve();
    }
    this.idle = this.loop();
    return this.idle;
  }

  private idle: Promise<void> | null = null;

  /** Whether a tick is scheduled (the flow waits for a time). */
  scheduled(): boolean {
    return this.timer !== null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.idle = this.loop();
    }, ms);
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let next: Next = { kind: "idle" };
    try {
      do {
        this.rerun = false;
        next = await this.tickLocked();
      } while ((this.rerun || (next.kind === "again" && next.ms === 0)) && !this.stopped);
    } finally {
      this.running = false;
    }
    if (next.kind === "again") this.schedule(next.ms);
  }

  /** Change the stored progress (read again first: another tab may have changed it), then tick. */
  async update(change: (p: LaunchProgress) => void): Promise<void> {
    const env = this.env();
    const fresh = env === null ? this.progress : ((await env.store.get(this.progress.id)) ?? this.progress);
    const next: LaunchProgress = structuredClone(fresh);
    change(next);
    next.updatedAt = now();
    if (env !== null) await env.store.put(next);
    this.progress = next;
    this.publish(baseView(next, this.view));
    await this.kick();
  }

  private async save(p: LaunchProgress): Promise<void> {
    p.updatedAt = now();
    const env = this.env();
    if (env !== null) await env.store.put(p);
    this.progress = p;
  }

  private async tickLocked(): Promise<Next> {
    const env = this.env();
    if (env === null) return { kind: "idle" };
    try {
      return await env.lock(`noised-launch-flow:${this.progress.id}`, async () => {
        const stored = await env.store.get(this.progress.id);
        if (stored !== null) this.progress = stored;
        return this.tick(env, structuredClone(this.progress));
      });
    } catch (e) {
      this.publish({ busy: false, need: { kind: "retry", message: plainError(e) }, activity: "Stopped by a problem" });
      return { kind: "idle" };
    }
  }

  /** The funding the remaining steps need: what the temporary account must hold, and the least it may hold to go on. */
  private async funding(env: FlowEnv, p: LaunchProgress, status: LaunchFlowStatus, plan: LaunchPlan): Promise<{ full: bigint; least: bigint }> {
    const b = env.backend;
    const [floor, launchCost] = await Promise.all([b.rentExemptLamports(env.conn, 0), b.launchPayerLamports(env.conn, plan.metadata)]);
    // Switching on the Autopilot after the opening is paid from the same account (no extra wallet step).
    const autopilot = await this.autopilotCost(env, p);
    if (status.attestationState === "attested" && status.window !== null && !p.newTime) {
      // Only the opening is left (and the Autopilot after it).
      return { full: launchCost + autopilot + floor + FUNDING_MARGIN_LAMPORTS, least: launchCost + autopilot + floor };
    }
    const t = await b.throwawayPayerFunding(env.conn, {
      ...(status.metadataPublished === true ? {} : { metadata: plan.metadata }),
      launch: plan.launch,
      lmsPublicKey: fromHex(p.lmsPublicKey),
    });
    const rules = await this.rulesCost(env, p);
    return { full: t.lamports + rules + launchCost + autopilot + floor + FUNDING_MARGIN_LAMPORTS, least: t.lamports + rules + launchCost + autopilot + floor };
  }

  /** Everything switching on the Autopilot costs (0 without one, or once it is on). */
  private async autopilotCost(env: FlowEnv, p: LaunchProgress): Promise<bigint> {
    const graph = autopilotOf(p);
    if (graph === null || p.autopilotDone === true) return 0n;
    const c = await env.backend.programmable.autopilotSetupCost(env.conn, graph.bytes.length);
    return c.init + c.publish + c.authorize + c.activate;
  }

  private async tick(env: FlowEnv, p: LaunchProgress): Promise<Next> {
    const b = env.backend;
    const conn = env.conn;
    const launch = new PublicKey(p.launch);
    this.publish(baseView(p, this.view));
    if (p.done) {
      this.publish({ stage: "done", busy: false, need: null, activity: p.abandoned ? "Stopped. The leftover SOL went back to your wallet." : "Done" });
      return { kind: "idle" };
    }
    const nowSecs = await env.now();
    const provisional = p.window === null ? chooseWindow(nowSecs, p.opensAt === "asap" ? "asap" : BigInt(p.opensAt)) : { notBefore: BigInt(p.window.notBefore), notAfter: BigInt(p.window.notAfter) };
    let plan = planOf(p, provisional.notBefore, provisional.notAfter);
    const status = await b.getLaunchFlowStatus(conn, launch, { expectedMetadataHash: plan.metadataHash, expectedMessageHash: plan.messageHash, nowSecs });
    const payer = payerOf(p);

    // ---------------------------------------------------------------- 1. create
    if (status.step === "create") {
      if (p.abandoned) return this.finish(p, "Stopped before the launch was created.");
      if (p.sent.create !== null && now() - p.updatedAt < 60_000) {
        this.publish({ stage: "create", busy: true, need: null, activity: "Waiting for the launch to show up on Solana" });
        return { kind: "again", ms: 3_000 };
      }
      const creator = env.wallet();
      if (creator === null || creator.toBase58() !== p.creator) {
        this.publish({ stage: "create", busy: false, need: { kind: "wallet", message: `Connect the wallet that set up this launch (${shortAddress(p.creator)}) to create it.` } });
        return { kind: "idle" };
      }
      return this.walletStep(env, p, "create", null, async () => (await b.buildPlannedCreateLaunchTx(conn, plan)).tx);
    }
    const account = status.account;
    if (account === null) return { kind: "again", ms: 3_000 };

    // ------------------------------- live: 6. the Autopilot, 7. return SOL
    if (account.status === "live") {
      if (p.mint === null) {
        p.mint = account.baseMint.toBase58();
        await this.save(p);
        this.publish({ mint: account.baseMint });
      }
      const graph = autopilotOf(p);
      if (graph !== null && p.autopilotDone !== true && !p.abandoned) return this.autopilot(env, p, payer, launch, graph, nowSecs);
      return this.sweep(env, p, payer, "Opened. Returning the leftover SOL to your wallet");
    }
    if (p.abandoned) return this.sweep(env, p, payer, "Returning the leftover SOL to your wallet");

    // --------------------------------------------------- configured: attested?
    const attested = status.attestationState === "attested" && status.window !== null ? status.window : null;
    if (attested !== null && (!p.newTime || nowSecs <= attested.notAfter)) {
      if (p.newTime) {
        // The window has not passed after all (another tab or device signed it): nothing to replace.
        p.newTime = false;
        await this.save(p);
      }
      if (p.window === null || BigInt(p.window.notBefore) !== attested.notBefore || BigInt(p.window.notAfter) !== attested.notAfter) {
        p.window = { notBefore: attested.notBefore.toString(), notAfter: attested.notAfter.toString() };
        await this.save(p);
      }
      this.publish({ window: attested });
      if (nowSecs < attested.notBefore) {
        this.publish({ stage: "open", busy: false, need: null, activity: "Signed. Waiting for the opening time" });
        const secs = Number(attested.notBefore - nowSecs);
        return { kind: "again", ms: Math.max(250, Math.min(secs * 1_000, 15_000)) };
      }
      if (nowSecs <= attested.notAfter) return this.open(env, p, payer, plan, status);
    }
    if (attested !== null && nowSecs > attested.notAfter && !p.newTime) {
      // Audit round 3 F1: the window passed unused; the creator picks a new opening time and signs it.
      this.publish({ stage: "sign", busy: false, need: { kind: "new-time", closedAt: attested.notAfter }, activity: "The opening time passed" });
      return { kind: "idle" };
    }

    // ------------------------------------------------- not attested: 2. fund
    if (payer === null) return this.finish(p, "The temporary fee account was already emptied.");
    const need = await this.funding(env, p, status, plan);
    const balance = await b.getSolBalance(conn, payer.publicKey);
    this.publish({ fundLamports: need.full });
    if (balance < need.least) {
      const lamports = need.full - balance;
      return this.walletStep(env, p, "fund", lamports, async () => {
        const from = env.wallet();
        if (from === null) throw new Error("Connect a wallet to fund the temporary fee account.");
        return (await b.buildFundThrowawayPayerTx(conn, from, payer.publicKey, { lamports })).tx;
      });
    }

    // ------------------------------------------------- 3. store the details
    if (status.metadataPublished !== true) return this.publishRecord(env, p, payer, plan);
    // ...and the custom launch rules, which the quantum key's signature binds (attestation v3).
    const rules = rulesOf(p);
    if (rules !== null && (await b.programmable.fetchRulesRecord(conn, launch, rules.hash)) === null) return this.publishRules(env, p, payer, launch, rules.bytes);

    // ---------------------------------------------- 4. sign with the quantum key
    // The window: the one already signed while it can still be used and no new time was asked for (a resend is then
    // the same message: the same leaf and the same bytes), else a fresh one from the requested opening, with a margin,
    // and never the window of a message whose landing did not count (that leaf is spent; a new signature signs anew).
    const resend = p.window !== null && !p.newTime && windowSignable(nowSecs, provisional);
    let note: string | null = null;
    if (!resend) {
      const picked = chooseWindow(nowSecs, p.opensAt === "asap" ? "asap" : BigInt(p.opensAt));
      let window = { notBefore: picked.notBefore, notAfter: picked.notAfter };
      while (p.burns.some((x) => BigInt(x.window.notBefore) === window.notBefore && BigInt(x.window.notAfter) === window.notAfter)) {
        window = { notBefore: window.notBefore + 1n, notAfter: window.notAfter + 1n };
      }
      if (picked.moved) note = "The time you picked was too close, so it opens at the soonest time that leaves room to sign it.";
      plan = replanLaunchWindow(plan, { opensAt: window.notBefore, windowSecs: window.notAfter - window.notBefore, nowSecs });
    }
    return this.sign(env, p, payer, plan, resend, note);
  }

  private async finish(p: LaunchProgress, activity: string): Promise<Next> {
    p.done = true;
    await this.save(p);
    this.publish({ stage: "done", busy: false, need: null, activity, done: true });
    return { kind: "idle" };
  }

  /** A step the wallet signs: only after the person asked to go on (`go`), in the app's review dialog. */
  private async walletStep(env: FlowEnv, p: LaunchProgress, stage: "create" | "fund", lamports: bigint | null, build: () => Promise<Transaction>): Promise<Next> {
    if (stage === "fund" && env.wallet() === null) {
      this.publish({ stage, busy: false, need: { kind: "wallet", message: "Connect a wallet to fund the temporary fee account." } });
      return { kind: "idle" };
    }
    if (!p.go) {
      this.publish({ stage, busy: false, need: { kind: "go", stage, lamports }, activity: stage === "create" ? "Ready to create the launch" : "Ready to fund the temporary fee account" });
      return { kind: "idle" };
    }
    const refusal = await env.clusterRefusal();
    if (refusal !== null) {
      this.publish({ stage, busy: false, need: { kind: "stopped", message: `Refusing to sign or send: ${refusal}` } });
      return { kind: "idle" };
    }
    this.publish({ stage, busy: true, need: null, activity: stage === "create" ? "Waiting for your wallet: create the launch" : "Waiting for your wallet: fund the temporary fee account" });
    let outcome: WalletOutcome;
    try {
      outcome = await env.walletTx({
        title: stage === "create" ? `Create the ${p.symbol} launch (1 of 2)` : `Fund the temporary fee account (2 of 2)`,
        summary:
          stage === "create"
            ? [
                "Records your launch's rules on Solana. The program checks every safety rule again.",
                "Nothing can be traded yet. Your quantum key signs the launch next, and it opens at the time it signs.",
              ]
            : [
                `Sends ${lamportsText(lamports ?? 0n)} to a temporary account this browser made for this launch.`,
                "It pays to store your token's details on Solana, to send your quantum key's signature and to open the launch, so your wallet is not part of those.",
                "What it does not spend comes back to your wallet at the end.",
              ],
        build,
      });
    } catch (e) {
      outcome = { status: "failed", error: plainError(e) };
    }
    if (outcome.status === "confirmed") {
      if (stage === "create") p.sent.create = outcome.signature;
      else p.sent.fund.push(outcome.signature);
      await this.save(p);
      return { kind: "again", ms: 0 };
    }
    p.go = false;
    await this.save(p);
    this.publish({
      busy: false,
      need: outcome.status === "cancelled" ? { kind: "go", stage, lamports } : { kind: "retry", message: outcome.error },
      activity: outcome.status === "cancelled" ? "You closed the review" : "That did not go through",
    });
    return { kind: "idle" };
  }

  /** Simulate an automatic transaction first; refuse to send when the endpoint is not this build's cluster. */
  private async preflight(env: FlowEnv, tx: Transaction | Uint8Array): Promise<string | null> {
    const refusal = await env.clusterRefusal();
    if (refusal !== null) return `Refusing to sign or send: ${refusal}`;
    const sim = await env.backend.simulateAndExplain(env.conn, tx);
    if (!sim.ok) return sim.error ?? "The test run failed.";
    if (sim.unknownPrograms.length > 0) return "This transaction calls a program this app does not recognise.";
    return null;
  }

  private async publishRecord(env: FlowEnv, p: LaunchProgress, payer: Keypair, plan: LaunchPlan): Promise<Next> {
    this.publish({ stage: "publish", busy: true, need: null, activity: "Storing your token's details on Solana" });
    try {
      const built = await env.backend.buildPlannedPublishTx(env.conn, plan, payer);
      if (built.status === "ready") {
        const problem = await this.preflight(env, built.tx);
        if (problem !== null) return this.retryLater(problem);
        await env.backend.sendPublishMetadataTx(env.conn, built);
        p.sent.publish = built.signature;
        await this.save(p);
      }
      this.resends = 0;
      return { kind: "again", ms: 0 };
    } catch (e) {
      if (e instanceof PublishPayerFundingError) return { kind: "again", ms: 0 }; // the funding check runs again
      return this.retryLater(plainError(e));
    }
  }

  /** What publishing the custom rules still costs the temporary account (0 without rules, or once they are published). */
  private async rulesCost(env: FlowEnv, p: LaunchProgress): Promise<bigint> {
    const rules = rulesOf(p);
    if (rules === null) return 0n;
    if ((await env.backend.programmable.fetchRulesRecord(env.conn, new PublicKey(p.launch), rules.hash)) !== null) return 0n;
    return (await env.backend.programmable.rulesRecordRent(env.conn, rules.bytes.length)) + RULES_FEE_LAMPORTS;
  }

  /** publish_rules from the temporary account (permissionless while the launch is configured; content-addressed). */
  private async publishRules(env: FlowEnv, p: LaunchProgress, payer: Keypair, launch: PublicKey, bytes: Uint8Array): Promise<Next> {
    this.publish({ stage: "publish", busy: true, need: null, activity: "Storing your launch rules on Solana" });
    try {
      const { tx } = await env.backend.programmable.buildPublishRulesTx(env.conn, payer.publicKey, launch, bytes);
      const problem = await this.preflight(env, tx);
      if (problem !== null) return this.retryLater(problem);
      tx.sign(payer);
      p.sent.rules = await env.backend.sendAndConfirm(env.conn, tx);
      await this.save(p);
      this.resends = 0;
      return { kind: "again", ms: 0 };
    } catch (e) {
      return this.retryLater(plainError(e));
    }
  }

  private retryLater(message: string, ms = 8_000, max = MAX_AUTO_RESENDS): Next {
    this.resends++;
    if (this.resends > max) {
      this.resends = 0;
      this.publish({ busy: false, need: { kind: "retry", message } });
      return { kind: "idle" };
    }
    this.publish({ busy: true, need: null, activity: `Trying again: ${message}` });
    return { kind: "again", ms };
  }

  private async sign(env: FlowEnv, p: LaunchProgress, payer: Keypair, plan: LaunchPlan, resend: boolean, note: string | null): Promise<Next> {
    const lastBurn = p.burns.at(-1);
    if (lastBurn !== undefined && !p.signAgain && !resend) {
      // A signature landed without counting: a new one spends another one-time signature, so the person decides.
      this.publish({ stage: "sign", busy: false, need: { kind: "sign-again", burn: lastBurn }, activity: "The last signature did not count" });
      return { kind: "idle" };
    }
    if (!env.keyUnlocked()) {
      this.publish({ stage: "sign", busy: false, need: { kind: "key", message: "Unlock your quantum key to sign your launch." }, activity: "Waiting for your quantum key" });
      return { kind: "idle" };
    }
    this.publish({ stage: "sign", busy: true, need: null, activity: "Signing with your quantum key", ...(note === null ? {} : { note }) });
    let signer: { identity: PqIdentity; leaves: LeafLedger; lock?: LedgerLock };
    try {
      signer = await env.signer(p.identityIndex);
    } catch (e) {
      this.publish({ busy: false, need: { kind: "key", message: plainError(e) } });
      return { kind: "idle" };
    }
    if (toHex(signer.identity.identityId) !== toHex(plan.pqIdentity)) {
      this.publish({ busy: false, need: { kind: "key", message: "This launch was set up with another quantum key. Unlock the key you used when you created it." } });
      return { kind: "idle" };
    }
    const refusal = await env.clusterRefusal();
    if (refusal !== null) {
      this.publish({ busy: false, need: { kind: "stopped", message: `Refusing to sign or send: ${refusal}` } });
      return { kind: "idle" };
    }
    let built;
    try {
      built = await env.backend.buildPlannedAttestTx(env.conn, plan, { identity: signer.identity, ledger: signer.leaves, payer, ...guardOptions(env, signer, p) });
    } catch (e) {
      const stop = this.refused(e, "sign");
      if (stop !== null) return stop;
      const m = errorMessage(e);
      if (/not finalized yet/.test(m)) {
        this.publish({ busy: true, activity: "Waiting until Solana has finalized your launch and its details (about 15 seconds)" });
        return { kind: "again", ms: 4_000 };
      }
      if (e instanceof AttestRetryLimitError) {
        this.publish({ busy: false, need: { kind: "stopped", message: plainError(e) }, activity: "Stopped" });
        return { kind: "idle" };
      }
      if (e instanceof PendingAttestationError) {
        // SDK 0.9.0 (audit 4, ID-F4): an earlier signature whose leaf the network shows as used, but whose landing is
        // not confirmed, is confirmed from the accounts (never sent again, never a new signature).
        if (e.pending.length > 0 && e.pending.every((x) => x.leafSetOnChain)) {
          try {
            await env.backend.landOrBurnPending(env.conn, { launch: plan.launch, identity: signer.identity, ledger: signer.leaves, payer });
            return { kind: "again", ms: 2_000 };
          } catch {
            // Not confirmed yet: wait for its window to end, as below.
          }
        }
        // SDK 0.5.0 (review info #2): an earlier signature of this launch was sent but never seen landing, and its window
        // has not ended, so it could still take the attestation slot. Nothing new is signed until that window ends.
        const until = pendingUntil(e);
        const left = until - (await env.now());
        this.publish({ stage: "sign", busy: true, need: null, activity: pendingActivity(until) });
        return { kind: "again", ms: Number(left > 0n ? (left < 30n ? left + 1n : 30n) : 1n) * 1_000 };
      }
      if (/only burn a leaf with this window/.test(m) && resend) {
        // The signed window came too close to be sent again: the next try picks a new one (that message never landed).
        p.window = null;
        await this.save(p);
        return { kind: "again", ms: 0 };
      }
      return this.retryLater(plainError(e));
    }
    // The message is signed (or was before): remember its window, so a resend after a reload is the same signature.
    p.window = { notBefore: built.window.notBefore.toString(), notAfter: built.window.notAfter.toString() };
    p.newTime = false;
    p.signAgain = false;
    p.extraSignature = false;
    await this.save(p);
    this.publish({ window: built.window });
    if (built.status === "already-attested") return { kind: "again", ms: 0 };
    // Attestation v3: this signed message also binds the custom rules' hash (no rules: the zero hash).
    const bound = rulesOf(p);
    if (bound !== null) env.backend.programmable.bindRulesToAttestation(plan.launch, built.messageHash, bound.hash);
    let outcome: AttestationOutcome;
    try {
      if (built.status === "leaf-landed") {
        outcome = await env.backend.confirmAttestation(env.conn, plan.launch, built.messageHash, { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, message: built.message, ledger: signer.leaves });
      } else {
        const problem = await this.preflight(env, built.tx);
        if (problem !== null) return this.retryLater(problem);
        outcome = await env.backend.sendAttestLaunchTx(env.conn, built, { ledger: signer.leaves });
        p.sent.attest = (built satisfies AttestLaunchReady).signature;
        await this.save(p);
      }
    } catch (e) {
      if (e instanceof AttestPayerFundingError) return { kind: "again", ms: 0 }; // the funding check runs again
      // Not landed: the next try rebuilds with the same inputs, which is the same leaf and the same signature.
      return this.retryLater(`${plainError(e)} It will be sent again with the same signature.`, 5_000);
    }
    if (outcome.status === "attested") {
      this.resends = 0;
      return { kind: "again", ms: 0 };
    }
    if (outcome.status === "burned") {
      const leaf = outcome.leaf;
      if (!p.burns.some((x) => x.leaf === leaf)) {
        p.burns.push({ leaf, reasons: outcome.reasons, detail: outcome.detail, window: { notBefore: built.window.notBefore.toString(), notAfter: built.window.notAfter.toString() }, at: now() });
      }
      // That message's leaf is spent: the next signature signs a new message.
      p.window = null;
      await this.save(p);
      return { kind: "again", ms: 0 };
    }
    return this.retryLater(`${outcome.detail}.`, 5_000);
  }

  private async open(env: FlowEnv, p: LaunchProgress, payer: Keypair | null, plan: LaunchPlan, status: LaunchFlowStatus): Promise<Next> {
    const b = env.backend;
    if (payer === null) {
      this.publish({ stage: "open", busy: false, need: null, activity: "Open now: anyone can open it until the window closes" });
      return { kind: "again", ms: 10_000 };
    }
    const need = await this.funding(env, p, status, plan);
    const balance = await b.getSolBalance(env.conn, payer.publicKey);
    if (balance < need.least) {
      return this.walletStep(env, p, "fund", need.full - balance, async () => {
        const from = env.wallet();
        if (from === null) throw new Error("Connect a wallet to fund the temporary fee account.");
        return (await b.buildFundThrowawayPayerTx(env.conn, from, payer.publicKey, { lamports: need.full - balance })).tx;
      });
    }
    this.publish({ stage: "open", busy: true, need: null, activity: "Opening your launch" });
    const mint = Keypair.generate();
    try {
      const { tx } = await b.buildLaunchTx(env.conn, payer.publicKey, plan.launch, mint);
      // Simulated first, signed only after it passed (the temporary account pays; the fresh mint signs its creation).
      const problem = await this.preflight(env, tx);
      if (problem !== null) return this.retryLater(problem, 3_000, MAX_OPEN_TRIES);
      tx.sign(payer, mint);
      p.sent.open = await b.sendAndConfirm(env.conn, tx);
      p.mint = mint.publicKey.toBase58();
      await this.save(p);
      this.resends = 0;
      return { kind: "again", ms: 0 };
    } catch (e) {
      // Someone else may have opened it first (anyone may): the next tick reads the live launch.
      return this.retryLater(plainError(e), 3_000, MAX_OPEN_TRIES);
    }
  }

  // ------------------------------------------------------------ autopilot ---

  /**
   * Step 6, for a launch that switches on an Autopilot: from the temporary account, create it, store its steps, have
   * the quantum key sign their start (pq_authorize: the launch's own identity, at its next one-time key), queue them
   * (activate) and apply them at their start. A first autopilot has no waiting period (only a change waits 72 hours),
   * so the start is a couple of minutes away: room for the signature to land. Every step is decided from the chain.
   */
  private async autopilot(env: FlowEnv, p: LaunchProgress, payer: Keypair | null, launch: PublicKey, graph: { bytes: Uint8Array; hash: Uint8Array }, nowSecs: bigint): Promise<Next> {
    const b = env.backend;
    const pg = b.programmable;
    const conn = env.conn;
    if (payer === null) return this.autopilotOff(p, "The temporary fee account was already emptied, so the Autopilot was not switched on here. Switch it on from the token's Autopilot page.");
    this.publish({ stage: "autopilot", busy: true, need: null, activity: "Setting up the Autopilot" });
    try {
      const info = await pg.fetchAutopilot(conn, launch);
      const hashHex = toHex(graph.hash);
      if (info !== null && info.graphHash !== null && toHex(info.graphHash) === hashHex) return this.autopilotFinished(p);
      if (info !== null && info.pending !== null && toHex(info.pending.graphHash) === hashHex) {
        // Signed and queued: it starts at its time (anyone may apply it then; this tab does if it is open).
        const at = BigInt(info.pending.activateAt);
        this.publish({ autopilotAt: at });
        if (nowSecs < at) {
          this.publish({ busy: true, activity: `Autopilot signed. It starts at ${formatTimestamp(at)}` });
          return { kind: "again", ms: Math.max(1_000, Math.min(Number(at - nowSecs) * 1_000, 15_000)) };
        }
        return this.autopilotSend(env, p, payer, "Starting the Autopilot", async () => (await pg.buildApplyPendingTx(conn, payer.publicKey, launch)).tx);
      }
      if (info !== null && (info.graphHash !== null || info.pending !== null || info.frozen)) {
        return this.autopilotOff(p, "This token already has other Autopilot steps, so these were not switched on. See its Autopilot page.");
      }
      // What is left to pay, from the temporary account (funded for it in step 2; asked again only if it falls short).
      const need = await this.autopilotRemaining(env, p, launch, graph, info !== null);
      const [floor, balance] = await Promise.all([b.rentExemptLamports(conn, 0), b.getSolBalance(conn, payer.publicKey)]);
      if (balance < need + floor) {
        const lamports = need + floor + FUNDING_MARGIN_LAMPORTS - balance;
        return this.walletStep(env, p, "fund", lamports, async () => {
          const from = env.wallet();
          if (from === null) throw new Error("Connect a wallet to fund the temporary fee account.");
          return (await b.buildFundThrowawayPayerTx(conn, from, payer.publicKey, { lamports })).tx;
        });
      }
      if (info === null) return this.autopilotSend(env, p, payer, "Creating the Autopilot", async () => (await pg.buildInitAutopilotTx(conn, payer.publicKey, launch)).tx);
      const bind = await pg.buildBindMintTx(conn, payer.publicKey, launch);
      if (bind !== null) return this.autopilotSend(env, p, payer, "Linking the Autopilot to the token", async () => bind.tx);
      if ((await pg.fetchGraphBytes(conn, launch, graph.hash)) === null) {
        return this.autopilotSend(env, p, payer, "Storing the Autopilot's steps on Solana", async () => (await pg.buildPublishGraphTx(conn, payer.publicKey, launch, graph.bytes)).tx);
      }
      // The start the quantum key signs, kept on disk first: a resumed signature is then the same message (and the
      // same one-time key). A start too close to land is replaced by a new one (that signature can no longer be used).
      let at = p.autopilotAt === undefined || p.autopilotAt === null ? null : BigInt(p.autopilotAt);
      if (at === null || at < nowSecs + 30n) {
        at = nowSecs + AUTOPILOT_LEAD_SECS;
        p.autopilotAt = at.toString();
        await this.save(p);
      }
      this.publish({ autopilotAt: at });
      const payload = activationPayload(autopilotAddress(launch), graph.hash, Number(at));
      if ((await pg.fetchAuthorization(conn, launch, AUTH_KIND.GRAPH_ACTIVATE, payload.hash)) === null) return this.autopilotSign(env, p, payer, launch, payload.hash);
      const start = at;
      return this.autopilotSend(env, p, payer, "Switching the Autopilot on", async () => (await pg.buildActivateGraphTx(conn, payer.publicKey, launch, graph.hash, Number(start))).tx);
    } catch (e) {
      return this.retryLater(plainError(e));
    }
  }

  /** What the Autopilot's remaining steps cost the temporary account. */
  private async autopilotRemaining(env: FlowEnv, p: LaunchProgress, launch: PublicKey, graph: { bytes: Uint8Array; hash: Uint8Array }, exists: boolean): Promise<bigint> {
    const pg = env.backend.programmable;
    const c = await pg.autopilotSetupCost(env.conn, graph.bytes.length);
    let need = c.activate;
    if (!exists) need += c.init;
    if (!exists || (await pg.fetchGraphBytes(env.conn, launch, graph.hash)) === null) need += c.publish;
    const at = p.autopilotAt === undefined || p.autopilotAt === null ? null : Number(p.autopilotAt);
    const signed = at !== null && (await pg.fetchAuthorization(env.conn, launch, AUTH_KIND.GRAPH_ACTIVATE, activationPayload(autopilotAddress(launch), graph.hash, at).hash)) !== null;
    if (!signed) need += c.authorize;
    return need;
  }

  /** One Autopilot step from the temporary account: simulated first, then signed by it and sent. */
  private async autopilotSend(env: FlowEnv, p: LaunchProgress, payer: Keypair, activity: string, build: () => Promise<Transaction>): Promise<Next> {
    this.publish({ stage: "autopilot", busy: true, need: null, activity });
    const tx = await build();
    const problem = await this.preflight(env, tx);
    if (problem !== null) return this.retryLater(problem);
    tx.sign(payer);
    const signature = await env.backend.sendAndConfirm(env.conn, tx);
    (p.sent.autopilot ??= []).push(signature);
    await this.save(p);
    this.resends = 0;
    return { kind: "again", ms: 0 };
  }

  /** The quantum key signs the Autopilot's start (pq_authorize, kind 1): the launch's own identity, its next one-time key. */
  private async autopilotSign(env: FlowEnv, p: LaunchProgress, payer: Keypair, launch: PublicKey, payloadHash: Uint8Array): Promise<Next> {
    if (!env.keyUnlocked()) {
      this.publish({ stage: "autopilot", busy: false, need: { kind: "key", message: "Unlock your quantum key to switch the Autopilot on." }, activity: "Waiting for your quantum key" });
      return { kind: "idle" };
    }
    this.publish({ stage: "autopilot", busy: true, need: null, activity: "Signing the Autopilot with your quantum key" });
    let signer: { identity: PqIdentity; leaves: LeafLedger; lock?: LedgerLock };
    try {
      signer = await env.signer(p.identityIndex);
    } catch (e) {
      this.publish({ busy: false, need: { kind: "key", message: plainError(e) } });
      return { kind: "idle" };
    }
    if (toHex(signer.identity.identityId) !== toHex(decodeParams(p.params).pqIdentity)) {
      this.publish({ busy: false, need: { kind: "key", message: "This launch was set up with another quantum key. Unlock the key you used when you created it." } });
      return { kind: "idle" };
    }
    const refusal = await env.clusterRefusal();
    if (refusal !== null) {
      this.publish({ busy: false, need: { kind: "stopped", message: `Refusing to sign or send: ${refusal}` } });
      return { kind: "idle" };
    }
    // The backend signs at the identity's next one-time key through the ledger (a retry is the same signature).
    let prepared: Awaited<ReturnType<FlowBackend["programmable"]["prepareAuthorizeFromPayer"]>>;
    try {
      prepared = await env.backend.programmable.prepareAuthorizeFromPayer(env.conn, payer, launch, {
        kind: AUTH_KIND.GRAPH_ACTIVATE,
        payloadHash,
        creator: new PublicKey(p.creator),
        identity: signer.identity,
        ledger: signer.leaves,
        ...guardOptions(env, signer, p),
      });
    } catch (e) {
      const stop = this.refused(e, "autopilot");
      if (stop !== null) return stop;
      if (/not finali[sz]ed/i.test(errorMessage(e))) {
        this.publish({ busy: true, activity: "Waiting until Solana has finalized your launch (about 15 seconds)" });
        return { kind: "again", ms: 4_000 };
      }
      throw e;
    }
    if (p.extraSignature === true) {
      p.extraSignature = false;
      await this.save(p);
    }
    if (prepared === null) return { kind: "again", ms: 0 };
    const problem = await this.preflight(env, prepared.tx);
    if (problem !== null) return this.retryLater(problem);
    const signature = await prepared.send();
    (p.sent.autopilot ??= []).push(signature);
    await this.save(p);
    this.resends = 0;
    return { kind: "again", ms: 0 };
  }

  /**
   * The SDK's refusals before a quantum signature (SDK 0.9.0): the flow stops and says why in plain words; nothing was
   * reserved or signed. Null: not one of them.
   */
  private refused(e: unknown, stage: "sign" | "autopilot"): Next | null {
    const r = signRefusalOf(e);
    if (r === null) return null;
    if (r.kind === "unknown-leaves") {
      this.publish({ stage, busy: false, need: { kind: "key-used-elsewhere", count: r.count, identityIdHex: r.identityIdHex, message: r.message }, activity: "Your quantum key was used elsewhere" });
    } else if (r.kind === "cap") {
      this.publish({ stage, busy: false, need: { kind: "signature-cap", count: r.count, message: r.message }, activity: "Earlier signatures never landed" });
    } else {
      // A clock the network disagrees with: nothing to confirm, only to fix (the device's clock, or another network connection).
      this.publish({ stage, busy: false, need: { kind: "retry", message: r.message }, activity: "Your clock and the network disagree" });
    }
    return { kind: "idle" };
  }

  private async autopilotFinished(p: LaunchProgress): Promise<Next> {
    p.autopilotDone = true;
    await this.save(p);
    return { kind: "again", ms: 0 };
  }

  /** The Autopilot is left as it is (the launch is open either way); the note says why. */
  private async autopilotOff(p: LaunchProgress, note: string): Promise<Next> {
    p.autopilotDone = true;
    await this.save(p);
    this.publish({ note });
    return { kind: "again", ms: 0 };
  }

  private async sweep(env: FlowEnv, p: LaunchProgress, payer: Keypair | null, activity: string): Promise<Next> {
    if (payer === null) return this.finish(p, p.abandoned ? "Stopped." : "Done");
    this.publish({ stage: "return", busy: true, need: null, activity });
    try {
      // The SDK signs the sweep with the temporary account (the only key it needs) and returns it ready to send.
      const built = await env.backend.buildSweepPayerTx(env.conn, payer, new PublicKey(p.creator));
      if (built !== null) {
        const problem = await this.preflight(env, built.tx);
        if (problem !== null) return this.retryLater(problem);
        p.sent.sweep = await env.backend.sendAndConfirm(env.conn, built.tx);
        p.returned = built.lamports.toString();
      } else p.returned ??= "0";
      // The account is empty: its key is no longer needed anywhere.
      p.payerSecret = null;
      p.done = true;
      await this.save(p);
      this.publish({ ...baseView(p, this.view), stage: "done", busy: false, need: null, activity: p.abandoned ? "Stopped. The leftover SOL went back to your wallet." : "Done" });
      return { kind: "idle" };
    } catch (e) {
      return this.retryLater(plainError(e));
    }
  }
}

const shortAddress = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * What every quantum signature of the flow passes the SDK (0.9.0, audit 4): this browser's cross-tab lock as the
 * launch's signing lock, a second RPC for the clock check where the build has one, and the person's confirmation of one
 * more signature after three that never landed.
 */
function guardOptions(
  env: FlowEnv,
  signer: { lock?: LedgerLock },
  p: Pick<LaunchProgress, "extraSignature">,
): { signingLock?: LedgerLock; secondConnection?: Connection; acknowledgeExtraSignatures?: boolean } {
  const second = env.secondConnection?.() ?? null;
  return {
    ...(signer.lock === undefined ? {} : { signingLock: signer.lock }),
    ...(second === null ? {} : { secondConnection: second }),
    ...(p.extraSignature === true ? { acknowledgeExtraSignatures: true } : {}),
  };
}

/** Lamports for publish_rules' signature (the runtime's fee). */
const RULES_FEE_LAMPORTS = 5_000n;

/** Why a launch with custom rules can't start where they are not live (before anything is created or paid for). */
export const RULES_NOT_LIVE = "Custom launch rules are coming soon on this network. Remove them to launch now, or try them in the demo.";

/** Why a launch with an Autopilot can't start where Autopilot is not live (before anything is created or paid for). */
export const AUTOPILOT_NOT_LIVE = "Autopilot is coming soon on this network. Launch without it now (you can add it later from the token's page), or try it in the demo.";

/** Why a launch that sends fees back into the token can't start where Autopilot is not live (before anything is signed). */
export const FEES_TO_TOKEN_NOT_LIVE = "Sending fees back into the token needs Autopilot, which is coming soon on this network. Pick \"To my wallet\" to launch now, or try it in the demo.";

/** The Autopilot a launch switches on after it opens (verified PXG1 bytes) and its fingerprint, or null for none. */
function autopilotOf(p: LaunchProgress): { bytes: Uint8Array; hash: Uint8Array } | null {
  if (p.autopilot === undefined || p.autopilot === null || p.autopilot === "") return null;
  const bytes = fromHex(p.autopilot);
  return { bytes, hash: graphHashOf(bytes) };
}

/** The custom rules of a launch in progress and their hash, or null for none. */
function rulesOf(p: LaunchProgress): { bytes: Uint8Array; hash: Uint8Array } | null {
  if (p.rules === undefined || p.rules === null || p.rules === "") return null;
  const bytes = fromHex(p.rules);
  return { bytes, hash: rulesHashOf(bytes) };
}

function lamportsText(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole}${frac === "" ? "" : `.${frac}`} SOL`;
}

function baseView(p: LaunchProgress, prev?: FlowView): FlowView {
  return {
    id: p.id,
    launch: new PublicKey(p.launch),
    name: p.name,
    symbol: p.symbol,
    stage: prev?.stage ?? (p.done ? "done" : "create"),
    busy: prev?.busy ?? false,
    activity: prev?.activity ?? "",
    need: prev?.need ?? null,
    window: p.window === null ? (prev?.window ?? null) : { notBefore: BigInt(p.window.notBefore), notAfter: BigInt(p.window.notAfter) },
    fundLamports: prev?.fundLamports ?? null,
    burns: p.burns,
    mint: p.mint === null ? null : new PublicKey(p.mint),
    returned: p.returned === null ? null : BigInt(p.returned),
    note: prev?.note ?? null,
    autopilot: p.autopilot !== undefined && p.autopilot !== null && p.autopilot !== "",
    autopilotAt: p.autopilotAt !== undefined && p.autopilotAt !== null ? BigInt(p.autopilotAt) : (prev?.autopilotAt ?? null),
    done: p.done,
    abandoned: p.abandoned,
  };
}

// ------------------------------------------------------------- starting ---

/** What the wizard hands over when the person launches. */
export interface NewLaunch {
  cluster: Cluster;
  creator: PublicKey;
  /** The complete parameters (`pqIdentity` and `recipients` included). */
  params: LaunchParams;
  /** The record (name, symbol, document; never a uri mode). */
  metadata: TokenMetaInput;
  identityIndex: number;
  lmsPublicKey: Uint8Array;
  opensAt: "asap" | bigint;
  /** Custom launch rules (verified PXR1 bytes), or null / absent for none. Refused where they are not live yet. */
  rules?: Uint8Array | null | undefined;
  /**
   * An Autopilot to switch on right after the launch opens (PXG1 bytes the SDK verifies), or null / absent for none.
   * Refused where Autopilot is not live yet.
   */
  autopilot?: Uint8Array | null | undefined;
  /** Fresh randomness (tests pass their own). */
  launchSeed?: Uint8Array | undefined;
  payer?: Keypair | undefined;
}

/** The progress record of a new launch (pure; validated by `planLaunch`, which throws with every problem). */
export function newProgress(n: NewLaunch, nowSecs: bigint): LaunchProgress {
  if (n.metadata.flags !== undefined && n.metadata.flags !== 0) throw new Error("this app never sets a uri mode: the mint's uri stays empty");
  if (n.autopilot !== undefined && n.autopilot !== null && n.autopilot.length > 0 && !graphVerifies(n.autopilot)) throw new Error("the Autopilot's steps do not verify");
  const launchSeed = n.launchSeed ?? crypto.getRandomValues(new Uint8Array(32));
  const { recipients, pqIdentity, ...params } = n.params;
  const w = chooseWindow(nowSecs, n.opensAt);
  const rules = n.rules === undefined || n.rules === null || n.rules.length === 0 ? null : n.rules;
  const plan = planLaunch({ creator: n.creator, identity: pqIdentity, params, recipients, metadata: n.metadata, rules, opensAt: w.notBefore, windowSecs: w.notAfter - w.notBefore, launchSeed });
  const payer = n.payer ?? Keypair.generate();
  const text = (b: Uint8Array): string => new TextDecoder().decode(b);
  const t = now();
  return {
    v: 1,
    id: `${n.cluster}:${plan.launch.toBase58()}`,
    cluster: n.cluster,
    launch: plan.launch.toBase58(),
    creator: n.creator.toBase58(),
    name: text(plan.metadata.name),
    symbol: text(plan.metadata.symbol),
    identityIndex: n.identityIndex,
    lmsPublicKey: toHex(n.lmsPublicKey),
    launchSeed: toHex(plan.launchSeed),
    params: encodeParams(plan.params),
    record: storedRecord(plan.metadata),
    rules: n.rules === undefined || n.rules === null || n.rules.length === 0 ? null : toHex(n.rules),
    autopilot: n.autopilot === undefined || n.autopilot === null || n.autopilot.length === 0 ? null : toHex(n.autopilot),
    autopilotAt: null,
    autopilotDone: false,
    opensAt: n.opensAt === "asap" ? "asap" : n.opensAt.toString(),
    window: null,
    payer: payer.publicKey.toBase58(),
    payerSecret: toHex(payer.secretKey),
    sent: { create: null, fund: [], publish: null, rules: null, attest: null, open: null, autopilot: [], sweep: null },
    burns: [],
    mint: null,
    returned: null,
    go: true,
    newTime: false,
    signAgain: false,
    done: false,
    abandoned: false,
    createdAt: t,
    updatedAt: t,
  };
}

// ------------------------------------------------------------- registry ---

const runners = new Map<string, LaunchRunner>();
const registryListeners = new Set<() => void>();
let currentEnv: FlowEnv | null = null;
let views: readonly FlowView[] = [];

function emitRegistry(): void {
  views = [...runners.values()].map((r) => r.snapshot());
  for (const l of [...registryListeners]) l();
}

/** Set (or replace) the environment the runners use: the keeper component calls it with the live connection, wallet and dialog. */
export function configureLaunchFlows(env: FlowEnv | null): void {
  currentEnv = env;
  if (env !== null) for (const r of runners.values()) r.kick();
}

function adopt(p: LaunchProgress): LaunchRunner {
  const existing = runners.get(p.id);
  if (existing) return existing;
  const r = new LaunchRunner(() => currentEnv, p);
  r.subscribe(emitRegistry);
  runners.set(p.id, r);
  emitRegistry();
  return r;
}

/**
 * Start runners for this cluster's unfinished launches in the store (a reload resumes them). The steps that need no
 * one go on by themselves; a wallet step waits until the person asks again (a reload never opens the wallet's review
 * by itself).
 */
export async function resumeLaunchFlows(): Promise<void> {
  const env = currentEnv;
  if (env === null) return;
  const all = await env.store.list();
  for (const p of all) {
    if (p.cluster !== env.cluster) continue;
    if (runners.has(p.id)) {
      void runners.get(p.id)?.kick();
      continue;
    }
    const r = adopt(p);
    if (p.go && !p.done) {
      await r.update((q) => {
        q.go = false;
      });
    } else void r.kick();
  }
}

/** Save a new launch (its temporary account's key is on disk before anything is sent) and start it. */
export async function startLaunchFlow(n: NewLaunch): Promise<string> {
  const env = currentEnv;
  if (env === null) throw new LaunchStorageError("This page cannot run a launch yet: reload it.");
  // Review U8: custom rules only where they are live, refused before anything is created or paid for.
  if (n.rules !== undefined && n.rules !== null && n.rules.length > 0 && !env.backend.programmable.available) {
    throw new Error(RULES_NOT_LIVE);
  }
  if (n.autopilot !== undefined && n.autopilot !== null && n.autopilot.length > 0 && !env.backend.programmable.available) {
    throw new Error(AUTOPILOT_NOT_LIVE);
  }
  const p = newProgress(n, await env.now());
  // Fees routed to the token's own treasury need the autopilot program on this network: refused before anything is signed.
  const treasury = autopilotTreasuryAddress(new PublicKey(p.launch));
  if (!env.backend.programmable.available && n.params.recipients.some((r) => r.wallet.equals(treasury))) throw new Error(FEES_TO_TOKEN_NOT_LIVE);
  if ((await env.store.get(p.id)) !== null) throw new Error("this launch is already in progress");
  await env.store.put(p);
  adopt(p).kick();
  return p.id;
}

export function launchFlowView(id: string): FlowView | null {
  return runners.get(id)?.snapshot() ?? null;
}

/** Every launch this browser runs on this page (for lists). */
export function launchFlowViews(): readonly FlowView[] {
  return views;
}

export function subscribeLaunchFlows(l: () => void): () => void {
  registryListeners.add(l);
  return () => registryListeners.delete(l);
}

/** The runner of a launch address (null: this browser does not run it). */
export function launchFlowFor(launch: PublicKey): FlowView | null {
  for (const r of runners.values()) if (r.snapshot().launch.equals(launch)) return r.snapshot();
  return null;
}

/** What the person can do from the tracker. */
export type FlowAction =
  | { kind: "go" }
  | { kind: "new-time"; opensAt: "asap" | bigint }
  | { kind: "sign-again" }
  /** The person confirmed one more signature after three that never landed (SDK 0.9.0 `SignatureCapError`). */
  | { kind: "sign-extra" }
  | { kind: "retry" }
  | { kind: "return-leftover" }
  | { kind: "kick" };

export async function launchFlowAction(id: string, action: FlowAction): Promise<void> {
  const r = runners.get(id);
  if (!r) throw new Error("no such launch in this browser");
  switch (action.kind) {
    case "go":
    case "retry":
      await r.update((p) => {
        p.go = true;
      });
      return;
    case "new-time":
      await r.update((p) => {
        p.go = true;
        p.newTime = true;
        p.opensAt = action.opensAt === "asap" ? "asap" : action.opensAt.toString();
      });
      return;
    case "sign-again":
      await r.update((p) => {
        p.signAgain = true;
      });
      return;
    case "sign-extra":
      await r.update((p) => {
        p.go = true;
        p.extraSignature = true;
      });
      return;
    case "return-leftover":
      await r.update((p) => {
        p.abandoned = true;
      });
      return;
    case "kick":
      r.kick();
  }
}

/** Only for tests: forget every runner (a fresh page). */
export function resetLaunchFlowsForTests(): void {
  for (const r of runners.values()) r.dispose();
  runners.clear();
  currentEnv = null;
  views = [];
}

/** Only for tests: the runner of a launch. */
export function runnerForTests(id: string): LaunchRunner | null {
  return runners.get(id) ?? null;
}

/** What step 2 sends to the temporary account, item by item (lamports), before anything is started. */
export interface FundingEstimate {
  /** Everything: what the wallet sends in step 2. */
  total: bigint;
  /** The token details' rent on Solana and the fee to store them. */
  details: bigint;
  /** The quantum signature's accounts (rent) and fee. */
  signature: bigint;
  /** What opening the launch costs (its accounts' rent and fees). */
  opening: bigint;
  /** What switching on its Autopilot costs (0 without one): its accounts' rent, the quantum signature's record and fees. */
  autopilot: bigint;
  /** Kept on the account until the end (it must stay rent-exempt), plus a small margin: comes back in step 6. */
  kept: bigint;
}

/**
 * What step 2 will send for a record (shown in the review before anything is started): the record's rent and the
 * publish fee, the identity's and the attestation's rents and the attest fee (both counted: an upper bound), what the
 * opening costs, and what the account keeps (the rent-exempt minimum and a margin). Unspent lamports come back in
 * step 6.
 */
export async function estimateLaunchFunding(
  b: Pick<FlowBackend, "launchPayerLamports" | "rentExemptLamports" | "throwawayPayerFunding" | "programmable">,
  conn: Connection,
  metadata: TokenMetaInput,
  autopilotBytes: number | null = null,
): Promise<FundingEstimate> {
  const [t, opening, floor, ap] = await Promise.all([
    b.throwawayPayerFunding(conn, { metadata }),
    b.launchPayerLamports(conn, metadata),
    b.rentExemptLamports(conn, 0),
    autopilotBytes === null || !b.programmable.available ? Promise.resolve(null) : b.programmable.autopilotSetupCost(conn, autopilotBytes),
  ]);
  const kept = floor + FUNDING_MARGIN_LAMPORTS;
  const autopilot = ap === null ? 0n : ap.init + ap.publish + ap.authorize + ap.activate;
  return {
    total: t.lamports + opening + autopilot + kept,
    details: t.tokenMetaRent + t.publishFee,
    signature: t.identityRent + t.attestationRent + t.attestFee + t.rentFloor,
    opening,
    autopilot,
    kept,
  };
}

/** Tick every runner (the quantum key was unlocked, the wallet changed). */
export function kickLaunchFlows(): void {
  for (const r of runners.values()) void r.kick();
}
