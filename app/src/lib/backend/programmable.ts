/**
 * Chain access for programmable launches (PROGRAMMABLE_V1 §2-§4): launch
 * rules (PXR1, bound into the attestation v3) and Autopilot graphs (PXG1,
 * run by the autopilot program). The byte formats, hashes, verifiers and
 * simulators are pure SDK code (lib/programmable.ts); this is only what
 * reads or writes the chain.
 *
 * The simulated chain implements it in lib/mock/programmable.ts (demo
 * builds); live builds use the SDK 0.7.0 builders against the P1c programs
 * (./programmableLive.ts).
 */
import type { GraphRecipientsCheck, LeafLedger, LedgerLock, PqIdentity, RunCosts } from "@noisedlabs/sdk";
import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export type { GraphRecipientsCheck, RunCosts };

/**
 * What a quantum signature of an Autopilot change passes the SDK besides what it signs (SDK 0.9.0, audit 4): the
 * browser's cross-tab signing lock, a second RPC for the clock check, and the person's confirmation of one more
 * signature after three of this launch and kind that never landed (`SignatureCapError`).
 */
export interface SignGuardOptions {
  acknowledgeExtraSignatures?: boolean;
  signingLock?: LedgerLock;
  secondConnection?: Connection;
}

/**
 * What switching on a launch's first Autopilot costs, step by step (lamports: rent of the accounts each step creates
 * plus its network fee). The launch flow funds it from the temporary account in its one funding step.
 */
export interface AutopilotSetupCost {
  /** `init_autopilot` (and binding the mint where that is a separate step). */
  init: bigint;
  /** `publish_graph`: the graph record. */
  publish: bigint;
  /** `pq_authorize`: the authorization record holding the quantum signature. */
  authorize: bigint;
  /** `activate` and `apply_pending`. */
  activate: bigint;
}

/** A published rule set (`["rules", launch, rules_hash]`). */
export interface RulesRecord {
  address: PublicKey;
  hash: Uint8Array;
  bytes: Uint8Array;
  publishedAt: number;
}

/** The launch's custom rules: what its attestation binds, and that record. */
export interface LaunchRulesInfo {
  /** rules_hash in the attestation (v3): all zero = no custom rules; null = not attested yet. */
  attestedHash: Uint8Array | null;
  /** The published record of exactly the attested hash (never another one: review U7); null when none. */
  record: RulesRecord | null;
  /** True when a rule set is attested and its record exists and verifies: the hook enforces exactly these bytes. */
  bound: boolean;
  /** Guard length of the launch (rules end at most this long after open), seconds. */
  guardSecs: number;
  /** Unix time the launch opened (rule windows count from it); null before launch. */
  openedAt: number | null;
}

export interface AutopilotNodeState {
  /** Unix time of the last successful run (0 = never). */
  lastRun: number;
  runsInEpoch: number;
  spentInEpoch: bigint;
  epochStart: number;
}

/** The `["autopilot", launch]` account and its treasury, as the app shows them. */
export interface AutopilotInfo {
  address: PublicKey;
  launch: PublicKey;
  mint: PublicKey | null;
  /** The treasury authority PDA `["treasury", launch]` (a fee recipient: `distribute` pays its wSOL account). */
  treasury: PublicKey;
  /** Active graph (null = none yet). */
  graphHash: Uint8Array | null;
  /** A queued graph: takes effect at `activateAt` (anyone may apply it then), with the operator it gets. */
  pending: { graphHash: Uint8Array; activateAt: number; authorizedAt: number; operator: PublicKey | null } | null;
  frozen: boolean;
  /** The graph's operator key while it is not revoked. */
  operator: PublicKey | null;
  /**
   * The authorization that activated the running graph (`Autopilot.active_auth`, audit 4 A4-S); null while none is
   * active. A removal of the operator names it (`revokePayload` v3).
   */
  activeAuth: PublicKey | null;
  nodes: AutopilotNodeState[];
  /** Reference price (sqrt price Q64): seeded with the launch's migration price, then moved by observations of the pool. */
  refSqrtPrice: bigint;
  refUpdatedAt: number;
  tipsInEpoch: bigint;
  tipEpochStart: number;
  /** Treasury balances: wSOL (lamports) and the launched token (base units). */
  treasurySol: bigint;
  treasuryTokens: bigint;
  /** Totals since the autopilot was created. */
  totalBurned: bigint;
  totalBoughtWithSol: bigint;
  totalPaid: bigint;
  totalTips: bigint;
  graduated: boolean;
  /** Current pool sqrt price (Q64), 0 before trading; and the pool's SOL (0 before graduation). */
  spotSqrtPrice: bigint;
  poolSol: bigint;
  /** The pool's trading fee now (bps), what a buyback pays. */
  poolFeeBps: number;
  decimals: number;
}

export interface AutopilotRun {
  txSignature: string;
  unixTime: number;
  node: number;
  /** "buyback" | "burn" | "pay". */
  action: "buyback" | "burn" | "pay";
  /** SOL spent (buyback, pay) in lamports. */
  solIn: bigint;
  /** Tokens burned (buyback, burn), base units. */
  burned: bigint;
  tip: bigint;
  keeper: PublicKey;
  /** The operator chose the amount (an operator-gated step). */
  byOperator: boolean;
  /** A keeper's partial buyback (audit 4, A4-2): it spent part of the step's run, and the step stays due for the rest. */
  partial?: boolean;
  /** Recipients of a payout skipped because they had no wSOL account (their share stayed in the treasury; audit 4, M4). */
  skippedRecipients?: number;
}

/** A step that can run now, with what it would do, what running it costs and the tip for running it. */
export interface DueStep {
  node: number;
  /** Plain words: "Buy back with up to 0.5 SOL and burn what it buys". */
  what: string;
  /**
   * Lamports paid to whoever runs it, as the program's tip rules give it on the state read now (an estimate: a burn is
   * valued at the lower of the reference and the lowest observed price, a partial buyback earns its share, a payout's
   * skipped recipients do not count; 0 when this tip epoch's cap is used up).
   */
  tip: bigint;
  /**
   * What running it costs whoever runs it (the network fee for each signer and the rent of their own wSOL account for
   * the tip when they have none yet: SDK `RunCosts`); null when it can't be told before a wallet is known.
   */
  costs: RunCosts | null;
  /** A keeper's partial buyback (the pool fills only part of it now): the step stays due for the rest. */
  partial: boolean;
  /** A payout's recipients that have no wSOL account yet: skipped, their share stays in the treasury. */
  skippedRecipients: number;
  /** Only the graph's operator may run it, and it must choose the amount (review U13). */
  operatorOnly: boolean;
  /** The amounts a run may move now: lamports, or raw tokens for a burn. */
  minAmount: bigint;
  maxAmount: bigint;
  unit: "lamports" | "tokens";
}

/** One `pq_authorize` record (`["auth", launch, kind, payload_hash]`). */
export interface AuthorizationInfo {
  address: PublicKey;
  kind: number;
  payloadHash: Uint8Array;
  unixTime: number;
  slot: number;
}

export interface ProgrammableBackend {
  /** False while rules and Autopilot are not live on this build's cluster: nothing may be added. */
  readonly available: boolean;
  /**
   * Whether a wallet can send `pq_authorize` itself (`buildPqAuthorizeTx`, one legacy transaction: the simulated chain).
   * False on a real cluster: the quantum signature needs a v1 transaction from a temporary account
   * (`prepareAuthorizeFromPayer`, funded by the wallet).
   */
  readonly walletAuthorize: boolean;
  /** Rules: the published record of the attested hash, and what the attestation binds. */
  readonly fetchLaunchRules: (conn: Connection, launch: PublicKey) => Promise<LaunchRulesInfo>;
  /** One published rule set by its hash, or null. */
  readonly fetchRulesRecord: (conn: Connection, launch: PublicKey, rulesHash: Uint8Array) => Promise<RulesRecord | null>;
  /** `publish_rules(bytes)`: permissionless while the launch is Configured; content-addressed and idempotent. */
  readonly buildPublishRulesTx: (conn: Connection, payer: PublicKey, launch: PublicKey, bytes: Uint8Array) => Promise<{ tx: Transaction; address: PublicKey; hash: Uint8Array }>;
  /** Rent of a rule set's record (the launch flow funds it). */
  readonly rulesRecordRent: (conn: Connection, size: number) => Promise<bigint>;
  /**
   * Attestation v3: the quantum signature of the launch whose message hash is `messageHash` also signs `rulesHash`
   * (the launch then refuses to open unless that record is published, and the hook enforces it).
   */
  readonly bindRulesToAttestation: (launch: PublicKey, messageHash: Uint8Array, rulesHash: Uint8Array) => void;

  readonly fetchAutopilot: (conn: Connection, launch: PublicKey) => Promise<AutopilotInfo | null>;
  /** The launch's migration price (sqrt Q64): where an autopilot's reference price starts. Null when it can't be read. */
  readonly fetchMigrationPrice: (conn: Connection, launch: PublicKey) => Promise<bigint | null>;
  /** The published graph bytes for a hash (`["graph", launch, graph_hash]`), or null. */
  readonly fetchGraphBytes: (conn: Connection, launch: PublicKey, graphHash: Uint8Array) => Promise<Uint8Array | null>;
  readonly listAutopilotRuns: (conn: Connection, launch: PublicKey) => Promise<AutopilotRun[]>;
  /** The steps that can run now; `caller` (the connected wallet, if any) tells what running each one costs it. */
  readonly findDueSteps: (conn: Connection, launch: PublicKey, caller?: PublicKey | null) => Promise<DueStep[]>;
  readonly fetchAuthorization: (conn: Connection, launch: PublicKey, kind: number, payloadHash: Uint8Array) => Promise<AuthorizationInfo | null>;
  /** The leaf bitmap of a quantum identity (`used`, 128 bytes): one-time keys already spent, shared by launches and authorizations. */
  readonly fetchIdentityLeaves: (conn: Connection, pqIdentity: Uint8Array) => Promise<Uint8Array>;

  /** Creates the autopilot account (anyone; once per launch). Its reference price starts at the launch's migration price. */
  readonly buildInitAutopilotTx: (conn: Connection, payer: PublicKey, launch: PublicKey) => Promise<{ tx: Transaction; address: PublicKey }>;
  /**
   * `bind_mint` once the launch is live, where the program needs it as its own step (anyone); null when there is
   * nothing to bind (not live yet, already bound, or bound by `init_autopilot`).
   */
  readonly buildBindMintTx: (conn: Connection, payer: PublicKey, launch: PublicKey) => Promise<{ tx: Transaction } | null>;
  /** What switching on a first Autopilot of `graphBytes` bytes costs (the launch flow funds it up front). */
  readonly autopilotSetupCost: (conn: Connection, graphBytes: number) => Promise<AutopilotSetupCost>;
  /**
   * `pq_authorize` paid and signed by `payer` (the launch flow's temporary account): the launch's quantum identity signs
   * the 140-byte message at its next one-time key through `ledger` (the leaf is reserved for the message before the
   * signature exists, so a retry is the same signature). Returns the signed transaction (legacy, or v1 bytes where the
   * quantum signature needs one) to check and its `send`, or null when exactly this authorization is already written.
   */
  readonly prepareAuthorizeFromPayer: (
    conn: Connection,
    payer: Keypair,
    launch: PublicKey,
    /** `freezeNotAfter`: a freeze (kind 2) names the last second it may be used (freeze payload v2); never for other kinds. */
    args: { kind: number; payloadHash: Uint8Array; creator: PublicKey; identity: PqIdentity; ledger: LeafLedger; freezeNotAfter?: number } & SignGuardOptions,
  ) => Promise<{ tx: Transaction | Uint8Array; send: () => Promise<string> } | null>;
  /**
   * Where a wallet sends `pq_authorize` itself (`walletAuthorize`, the simulated chain): the quantum signature of the
   * 140-byte message, with the SDK's refusals first (the clock for a time it signs, a freeze at most 24 hours long, the
   * cap on signatures that never landed, a key used elsewhere), under the launch's signing lock. Elsewhere it throws:
   * use `prepareAuthorizeFromPayer`.
   */
  readonly signAuthorization: (
    conn: Connection,
    launch: PublicKey,
    args: { kind: number; payloadHash: Uint8Array; creator: PublicKey; identity: PqIdentity; ledger: LeafLedger; freezeNotAfter?: number } & SignGuardOptions,
  ) => Promise<{ message: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array }>;
  /**
   * An autopilot's payees, checked like fee recipients (SDK 0.9.0 `checkGraphRecipients`, audit 4 C1): refusals (a
   * payee that could never receive: publishing is blocked), warnings, and those without a wSOL account yet
   * (`withoutAccount`: skipped, their share stays in the treasury until they open one).
   */
  readonly checkGraphRecipients: (conn: Connection, recipients: readonly PublicKey[]) => Promise<GraphRecipientsCheck>;
  /** `publish_graph(bytes)`: permissionless, verified, content-addressed. */
  readonly buildPublishGraphTx: (conn: Connection, payer: PublicKey, launch: PublicKey, bytes: Uint8Array) => Promise<{ tx: Transaction; hash: Uint8Array; address: PublicKey }>;
  /**
   * `pq_authorize`: the launch's quantum identity signs `kind` + `payload_hash` (message "PHX-AUTH-V1", 140 bytes) at
   * one of its one-time keys (`leaf`); only the launch's own identity is accepted.
   */
  readonly buildPqAuthorizeTx: (
    conn: Connection,
    payer: PublicKey,
    launch: PublicKey,
    args: { kind: number; payloadHash: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array },
  ) => Promise<{ tx: Transaction; address: PublicKey }>;
  /** `activate`: needs the kind-1 authorization of this exact graph and time; a replacement waits for the 72 h timelock. */
  readonly buildActivateGraphTx: (conn: Connection, payer: PublicKey, launch: PublicKey, graphHash: Uint8Array, activateAt: number) => Promise<{ tx: Transaction }>;
  /** `apply_pending`: anyone, at or after the pending update's time. */
  readonly buildApplyPendingTx: (conn: Connection, payer: PublicKey, launch: PublicKey) => Promise<{ tx: Transaction }>;
  /**
   * `freeze(not_after)` (authorization kind 2, payload v2): the active graph can never change again. `notAfter` is the
   * last second the creator's freeze approval may be used (FreezeExpired after it).
   */
  readonly buildFreezeGraphTx: (conn: Connection, payer: PublicKey, launch: PublicKey, notAfter: number) => Promise<{ tx: Transaction }>;
  /** `revoke_operator` (authorization kind 3): allowed on a frozen graph too (it only takes a power away). */
  readonly buildRevokeOperatorTx: (conn: Connection, payer: PublicKey, launch: PublicKey) => Promise<{ tx: Transaction }>;
  /**
   * `run(node, amount)`: anyone for a due step and earns the tip; an operator-controlled step needs the operator's
   * signature (`operator`, a separate signer) and an amount; a keeper may give a smaller amount for a buyback only.
   */
  readonly buildRunStepTx: (
    conn: Connection,
    caller: PublicKey,
    launch: PublicKey,
    node: number,
    opts?: { amount?: bigint; operator?: PublicKey },
  ) => Promise<{ tx: Transaction; costs: RunCosts; skippedRecipients: PublicKey[] }>;
}
