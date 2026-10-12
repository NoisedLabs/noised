/**
 * The autopilot's graph changes (`src/autopilot/governance.ts`): `activate`,
 * `freeze` and `revoke_operator`, each used with a launchpad `Authorization`
 * (`pq_authorize`). Account order and flags from the IDL; every refusal the
 * program would make, by its error name (InvalidAuthorization,
 * StaleAuthorization, Frozen, ActivationInPast, TimelockTooShort,
 * NoActiveGraph, FreezeExpired, NoOperator) in the program's order; a first
 * graph may start at once, a replacement 72 hours after both now and the
 * authorization's landing; a freeze (payload v2, review 4, R5) only up to and
 * including the `notAfter` it signed; legacy sizes and the measured compute
 * limits; the plain-English message of FreezeExpired (6040).
 */
import { PublicKey, type Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { PQ_IDENTITY, PROGRAM_IDS, KNOWN_ACCOUNTS } from "../src/constants.js";
import { IDLS } from "../src/idl/index.js";
import { authorizationAddress, autopilotAddress, autopilotPdas, graphRecordAddress } from "../src/pda.js";
import { AUTOPILOT_COMPUTE_UNITS, legacySize } from "../src/autopilot/builders.js";
import {
  activateInstruction,
  buildActivateTx,
  buildFreezeTx,
  buildRevokeOperatorTx,
  planRevokeOperator,
  freezeInstruction,
  revokeOperatorInstruction,
  type FreezeTxOptions,
} from "../src/autopilot/governance.js";
import {
  activationPayload,
  autopilotErrorCode,
  autopilotErrorName,
  checkFreezeWindow,
  FREEZE_DEFAULT_VALID_SECS,
  freezePayload,
  revokePayload,
} from "../src/programmable/autopilot/logic.js";
import { explainProgramError, explainTransactionError, PLAIN_ERROR_MESSAGES, plainErrorMessage } from "../src/rpc/errors.js";
import { burn, compileGraph, every, graph, graphHash } from "../src/index.js";
import { key } from "./helpers.js";
import { accountBytes, clock, NOW, world, type World } from "./world.js";

const AP = PROGRAM_IDS.autopilot;
const OPERATOR = key("gov/operator");
const PAYER = key("gov/payer");
const zero32 = new Uint8Array(32);
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = new PublicKey("Sysvar1111111111111111111111111111111111111");
const TIMELOCK = 259_200n;

const G1 = compileGraph(graph({ operator: OPERATOR }).node("burn", every("1d"), null, burn(1_000)).node("op", every("1d"), null, burn(100), { operatorGated: true }).build());
const G2 = compileGraph(graph().node("burn", every("2d"), null, burn(500)).build());
const H1 = graphHash(G1);
const H2 = graphHash(G2);

interface GovWorld {
  w: World;
  ap: PublicKey;
  value: Record<string, unknown>;
  put(): void;
  setClock(unix: bigint): void;
  /** Write an Authorization (as pq_authorize would) for this launch. */
  authorize(kind: number, payloadHash: Uint8Array, o?: { slot?: bigint; unixTime?: bigint; pqIdentity?: Uint8Array; empty?: boolean }): PublicKey;
}

/** A live launch (test/world.ts) with an autopilot (`G1` active, its operator set unless `active: false`) and both graphs published. */
function govWorld(o: { active?: boolean } = {}): GovWorld {
  const w = world();
  const launch = w.launch;
  const p = autopilotPdas(launch, w.mint);
  const active = o.active ?? true;
  const value: Record<string, unknown> = {
    version: 1,
    bump: 255,
    treasuryBump: 254,
    launch,
    mint: w.mint,
    dammPool: PublicKey.default,
    activeGraph: active ? H1 : zero32,
    pendingGraph: zero32,
    pendingActivateAt: 0n,
    pendingOperator: PublicKey.default,
    activatedAt: active ? BigInt(NOW - 86_400) : 0n,
    frozen: false,
    operator: active ? OPERATOR : PublicKey.default,
    authMarks: [0, 1, 2].map(() => ({ slot: 0n, key: PublicKey.default })),
    seq: 0n,
    refSqrtPrice: 1n << 59n,
    refUpdatedAt: 0n,
    refAllowance: 0n,
    refAllowanceAt: 0n,
    observations: [0, 1].map(() => ({ index: 0n, firstAt: 0n, min: 0n, max: 0n })),
    tipEpochStart: 0n,
    tipsInEpoch: 0n,
    nodes: Array.from({ length: 16 }, () => ({ lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n })),
  };
  for (const [hash, bytes] of [
    [H1, G1],
    [H2, G2],
  ] as const) {
    w.conn.set(graphRecordAddress(launch, hash), { owner: AP, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch, graphHash: hash, bytes }) });
  }
  const pqIdentity = w.launchState["pqIdentity"] as Uint8Array;
  const t: GovWorld = {
    w,
    ap: p.autopilot,
    value,
    put() {
      w.conn.set(p.autopilot, { owner: AP, data: accountBytes("autopilot", "Autopilot", value) });
    },
    setClock(unix) {
      w.conn.set(SYSVAR_CLOCK, { owner: SYSVAR_OWNER, data: clock(Number(unix)) });
    },
    authorize(kind, payloadHash, a = {}) {
      const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("auth"), launch.toBytes(), Uint8Array.of(kind), payloadHash], PROGRAM_IDS.launchpad);
      const empty = a.empty === true;
      const data = accountBytes("launchpad", "Authorization", {
        version: empty ? 0 : 1,
        bump: empty ? 0 : bump,
        launch: empty ? PublicKey.default : launch,
        pqIdentity: empty ? zero32 : (a.pqIdentity ?? pqIdentity),
        kind: empty ? 0 : kind,
        payloadHash: empty ? zero32 : payloadHash,
        messageHash: new Uint8Array(32).fill(9),
        unixTime: empty ? 0n : (a.unixTime ?? BigInt(NOW)),
        slot: empty ? 0n : (a.slot ?? 400_000_000n),
        leaf: empty ? 0 : 7,
        signature: empty ? new Uint8Array(0) : new Uint8Array(PQ_IDENTITY.SIGNATURE_LEN),
      });
      const padded = new Uint8Array(2_669);
      padded.set(data);
      w.conn.set(address, { owner: PROGRAM_IDS.launchpad, data: padded });
      return address;
    },
  };
  t.put();
  return t;
}

const conn = (t: GovWorld) => t.w.conn.asConnection();
const apIx = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(AP))!;
const limitOf = (tx: Transaction): number => {
  const ix = tx.instructions.find((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget) && i.data[0] === 2)!;
  return ix.data.readUInt32LE(1);
};
const flags = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) => ix.keys.map((k) => [k.isSigner, k.isWritable]);
const idlFlags = (name: string) => IDLS.autopilot.instructions.find((i) => i.name === name)!.accounts.map((a) => [a.signer === true, a.writable === true]);
const disc = (name: string): number[] => IDLS.autopilot.instructions.find((i) => i.name === name)!.discriminator;

describe("governance instructions (pure): the IDL's accounts, order and flags", () => {
  const launch = key("gov/launch");
  const auth = key("gov/auth");

  it("activate: [autopilot (w), launch, graph, authorization], data = discriminator || i64le activate_at", () => {
    const ix = activateInstruction(launch, H1, auth, 1_800_000_123n);
    expect(ix.programId.equals(AP)).toBe(true);
    expect(IDLS.autopilot.instructions.find((i) => i.name === "activate")!.accounts.map((a) => a.name)).toEqual(["autopilot", "launch", "graph", "authorization"]);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([autopilotAddress(launch), launch, graphRecordAddress(launch, H1), auth].map((k) => k.toBase58()));
    expect(flags(ix)).toEqual(idlFlags("activate"));
    expect(flags(ix)).toEqual([
      [false, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect([...ix.data.subarray(0, 8)]).toEqual(disc("activate"));
    expect(ix.data.subarray(8).readBigInt64LE(0)).toBe(1_800_000_123n);
    expect(ix.data).toHaveLength(16);
  });

  it("freeze and revoke_operator: [autopilot (w), launch, authorization]; freeze data = discriminator || i64le not_after, revoke_operator no arguments", () => {
    for (const [name, ix] of [
      ["freeze", freezeInstruction(launch, auth, 1_800_003_600n)],
      ["revoke_operator", revokeOperatorInstruction(launch, auth)],
    ] as const) {
      expect(IDLS.autopilot.instructions.find((i) => i.name === name)!.accounts.map((a) => a.name)).toEqual(["autopilot", "launch", "authorization"]);
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([autopilotAddress(launch), launch, auth].map((k) => k.toBase58()));
      expect(flags(ix)).toEqual(idlFlags(name));
      expect(flags(ix)).toEqual([
        [false, true],
        [false, false],
        [false, false],
      ]);
      expect([...ix.data.subarray(0, 8)]).toEqual(disc(name));
    }
    // Review 4, R5: freeze(not_after: i64).
    expect(IDLS.autopilot.instructions.find((i) => i.name === "freeze")!.args).toEqual([{ name: "not_after", type: "i64" }]);
    const ix = freezeInstruction(launch, auth, 1_800_003_600n);
    expect(ix.data).toHaveLength(16);
    expect(ix.data.subarray(8).readBigInt64LE(0)).toBe(1_800_003_600n);
    expect(freezeInstruction(launch, auth, -1n).data.subarray(8).readBigInt64LE(0)).toBe(-1n);
    expect(revokeOperatorInstruction(launch, auth).data).toHaveLength(8);
    expect(() => freezeInstruction(launch, auth, 1_800_003_600 as unknown as bigint)).toThrow(TypeError);
    expect(() => freezeInstruction(launch, auth, 1n << 63n)).toThrow(RangeError);
  });
});

describe("checkFreezeWindow (logic::check_freeze_window)", () => {
  it("allowed up to and including not_after, FreezeExpired one second later", () => {
    expect(checkFreezeWindow(100n, 100n)).toBeNull();
    expect(checkFreezeWindow(99n, 100n)).toBeNull();
    expect(checkFreezeWindow(101n, 100n)).toBe("FreezeExpired");
    expect(checkFreezeWindow(-(1n << 63n), (1n << 63n) - 1n)).toBeNull();
    expect(checkFreezeWindow((1n << 63n) - 1n, -(1n << 63n))).toBe("FreezeExpired");
    expect(checkFreezeWindow(5, 4)).toBe("FreezeExpired");
    expect(autopilotErrorCode("FreezeExpired")).toBe(6040);
    expect(autopilotErrorName(6040)).toBe("FreezeExpired");
    expect(FREEZE_DEFAULT_VALID_SECS).toBe(3_600n);
  });

  it("6040 FreezeExpired: the IDL's error, explained in plain English", () => {
    const e = explainProgramError(AP.toBase58(), 6040);
    expect(e).toEqual({
      program: "noised_autopilot",
      name: "FreezeExpired",
      message: "The freeze authorization is past its not_after",
      plain: "This freeze approval has expired (it was signed to be used only until a set time). Sign a new freeze.",
    });
    expect(plainErrorMessage(AP, 6040)).toBe(e!.plain);
    expect(PLAIN_ERROR_MESSAGES[AP.toBase58()]![6040]).toBe(e!.plain);
    expect(explainTransactionError({ InstructionError: [1, { Custom: 6040 }] }, [`Program ${AP.toBase58()} failed: custom program error: 0x1798`]).errorCode).toEqual({
      program: "noised_autopilot",
      code: 6040,
      name: "FreezeExpired",
    });
  });
});

describe("buildActivateTx", () => {
  it("a first graph (none active or queued) may start at once; one second in the past is ActivationInPast", async () => {
    const t = govWorld({ active: false });
    const now = BigInt(NOW);
    const payload = activationPayload(t.ap, H2, now);
    const address = t.authorize(1, payload);
    const tx = await buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: now });
    const ix = apIx(tx);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([t.ap, t.w.launch, graphRecordAddress(t.w.launch, H2), address].map((k) => k.toBase58()));
    expect(address.equals(authorizationAddress(t.w.launch, 1, payload))).toBe(true);
    expect(limitOf(tx)).toBe(AUTOPILOT_COMPUTE_UNITS.activate);
    expect(AUTOPILOT_COMPUTE_UNITS.activate).toBe(40_000);
    expect(tx.feePayer!.equals(PAYER)).toBe(true);
    expect(legacySize(tx)).toBeLessThanOrEqual(1_232);
    expect(legacySize(tx)).toBe(357); // the LiteSVM measurement (activate: 15,162 CU, 357 bytes)
    // A landing margin judges the time rules later than the clock.
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: now, landingMarginSecs: 30n })).rejects.toThrow(/ActivationInPast/);
    const past = now - 1n;
    t.authorize(1, activationPayload(t.ap, H2, past));
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: past })).rejects.toThrow(/has already passed.*ActivationInPast/);
  });

  it("a replacement: 72 hours after both now and the authorization's landing, else TimelockTooShort", async () => {
    const t = govWorld();
    const now = BigInt(NOW);
    const ok = now + TIMELOCK;
    t.authorize(1, activationPayload(t.ap, H2, ok));
    expect(limitOf(await buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: ok }))).toBe(40_000);
    const early = ok - 1n;
    t.authorize(1, activationPayload(t.ap, H2, early));
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: early })).rejects.toThrow(/TimelockTooShort/);
    // The authorization landed later than now: the 72 hours count from its landing.
    const fromAuth = now + 100n + TIMELOCK;
    t.authorize(1, activationPayload(t.ap, H2, fromAuth - 1n), { unixTime: now + 100n });
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: fromAuth - 1n })).rejects.toThrow(/TimelockTooShort/);
    t.authorize(1, activationPayload(t.ap, H2, fromAuth), { unixTime: now + 100n });
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: fromAuth })).resolves.toBeDefined();
    // A queued graph (nothing active) is a replacement too.
    t.value["activeGraph"] = zero32;
    t.value["pendingGraph"] = H1;
    t.value["pendingActivateAt"] = now + 10n;
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: early })).rejects.toThrow(/TimelockTooShort/);
  });

  it("InvalidAuthorization: none written, only a burned leaf there, or signed by another identity", async () => {
    const t = govWorld();
    const at = BigInt(NOW) + TIMELOCK;
    const payload = activationPayload(t.ap, H2, at);
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/no authorization .*buildPqAuthorizeTx, kind 1.*InvalidAuthorization/);
    t.authorize(1, payload, { empty: true });
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/only burned its leaf.*InvalidAuthorization/);
    t.authorize(1, payload, { pqIdentity: new Uint8Array(32).fill(5) });
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/not signed by the identity this launch names.*InvalidAuthorization/);
    // An authorization of another time does not authorize this one.
    t.authorize(1, activationPayload(t.ap, H2, at + 1n));
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at + 2n })).rejects.toThrow(/InvalidAuthorization/);
  });

  it("StaleAuthorization: already used, or older than the latest activation or revocation used (slot, then address)", async () => {
    const t = govWorld();
    const at = BigInt(NOW) + TIMELOCK;
    const address = t.authorize(1, activationPayload(t.ap, H2, at), { slot: 500n });
    const marks = t.value["authMarks"] as { slot: bigint; key: PublicKey }[];
    // Used already: the mark is this authorization.
    marks[0] = { slot: 500n, key: address };
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/StaleAuthorization/);
    // An older activation used: fresh.
    marks[0] = { slot: 499n, key: address };
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).resolves.toBeDefined();
    // A revocation used at a later slot voids it.
    marks[2] = { slot: 501n, key: key("gov/revoke") };
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/StaleAuthorization/);
    // Same slot: the address decides.
    marks[2] = { slot: 500n, key: new PublicKey(new Uint8Array(32)) };
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).resolves.toBeDefined();
    marks[2] = { slot: 500n, key: new PublicKey(new Uint8Array(32).fill(255)) };
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/StaleAuthorization/);
  });

  it("Frozen; no autopilot; a graph that is not published", async () => {
    const t = govWorld();
    const at = BigInt(NOW) + TIMELOCK;
    t.authorize(1, activationPayload(t.ap, H2, at));
    t.value["frozen"] = true;
    t.put();
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/frozen forever.*Frozen/);
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: new Uint8Array(32).fill(1), activateAt: at })).rejects.toThrow(/not published.*AccountNotInitialized/);
    t.w.conn.delete(t.ap);
    await expect(buildActivateTx(conn(t), PAYER, t.w.launch, { graphHash: H2, activateAt: at })).rejects.toThrow(/no autopilot.*AccountNotInitialized/);
    expect(autopilotErrorCode("TimelockTooShort")).toBe(6014);
  });
});

describe("buildFreezeTx", () => {
  /** A freeze usable for an hour from the world's clock. */
  const NOT_AFTER = BigInt(NOW) + 3_600n;

  it("built with the authorization over freezePayload(autopilot, active graph, notAfter), passing notAfter", async () => {
    const t = govWorld();
    const address = t.authorize(2, freezePayload(t.ap, H1, NOT_AFTER));
    const tx = await buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER });
    expect(apIx(tx).keys.map((k) => k.pubkey.toBase58())).toEqual([t.ap, t.w.launch, address].map((k) => k.toBase58()));
    expect(address.equals(authorizationAddress(t.w.launch, 2, freezePayload(t.ap, H1, NOT_AFTER)))).toBe(true);
    expect([...apIx(tx).data.subarray(0, 8)]).toEqual(disc("freeze"));
    expect(apIx(tx).data.readBigInt64LE(8)).toBe(NOT_AFTER);
    expect(limitOf(tx)).toBe(AUTOPILOT_COMPUTE_UNITS.freeze);
    expect(tx.feePayer!.equals(PAYER)).toBe(true);
    // 316 bytes measured on LiteSVM before review 4 R5, plus the 8-byte not_after argument.
    expect(legacySize(tx)).toBe(324);
  });

  it("notAfter is required, bigint i64 unix seconds; the landing margin a non-negative bigint", async () => {
    const t = govWorld();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, undefined as unknown as FreezeTxOptions)).rejects.toThrow(/notAfter/);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, {} as FreezeTxOptions)).rejects.toThrow(TypeError);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: Number(NOT_AFTER) as unknown as bigint })).rejects.toThrow(/notAfter must be bigint unix seconds/);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: 1n << 63n })).rejects.toThrow(RangeError);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER, landingMarginSecs: -1n })).rejects.toThrow(/landingMarginSecs/);
  });

  it("FreezeExpired on the cluster clock: allowed at not_after, refused one second later; a landing margin judges it later", async () => {
    const t = govWorld();
    t.authorize(2, freezePayload(t.ap, H1, NOT_AFTER));
    t.setClock(NOT_AFTER);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).resolves.toBeDefined();
    t.setClock(NOT_AFTER + 1n);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(
      /refusing to build: the freeze approval expired at 2027-01-15T09:00:00Z \(unix 1800003600\) \(cluster time 1800003601\): sign a new one \(the program would fail with FreezeExpired\)/,
    );
    t.setClock(NOT_AFTER - 10n);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER, landingMarginSecs: 10n })).resolves.toBeDefined();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER, landingMarginSecs: 11n })).rejects.toThrow(/cluster time 1800003590, plus 11 s to land.*FreezeExpired/);
  });

  it("the program's order: Frozen, then NoActiveGraph, then FreezeExpired, then the authorization", async () => {
    // Expired and unauthorized: FreezeExpired comes first.
    const t = govWorld();
    t.setClock(NOT_AFTER + 1n);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/FreezeExpired/);
    // Expired and frozen: Frozen.
    t.value["frozen"] = true;
    t.put();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/already frozen forever.*Frozen\)$/);
    // Expired, nothing active: NoActiveGraph.
    const none = govWorld({ active: false });
    none.setClock(NOT_AFTER + 1n);
    await expect(buildFreezeTx(conn(none), PAYER, none.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/NoActiveGraph/);
    // Frozen and nothing active: Frozen.
    none.value["frozen"] = true;
    none.put();
    await expect(buildFreezeTx(conn(none), PAYER, none.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/Frozen\)$/);
    // In time: the authorization decides.
    const ok = govWorld();
    await expect(buildFreezeTx(conn(ok), PAYER, ok.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/no authorization of the freeze of the active graph until this time.*kind 2.*InvalidAuthorization/);
  });

  it("InvalidAuthorization (a freeze of another graph, or until another time), StaleAuthorization (older than the latest activation)", async () => {
    const t = govWorld();
    t.authorize(2, freezePayload(t.ap, H2, NOT_AFTER));
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/InvalidAuthorization/);
    // Signed until another time: not this freeze (and the other time is not accepted for it).
    t.authorize(2, freezePayload(t.ap, H1, NOT_AFTER + 1n));
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/InvalidAuthorization/);
    t.authorize(2, freezePayload(t.ap, H1, NOT_AFTER), { slot: 100n });
    const marks = t.value["authMarks"] as { slot: bigint; key: PublicKey }[];
    marks[0] = { slot: 101n, key: key("gov/activation") };
    t.put();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/StaleAuthorization/);
    marks[0] = { slot: 99n, key: key("gov/activation") };
    t.put();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).resolves.toBeDefined();
    // A freeze already used (its mark is this authorization) is stale too.
    marks[1] = { slot: 100n, key: authorizationAddress(t.w.launch, 2, freezePayload(t.ap, H1, NOT_AFTER)) };
    t.put();
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/StaleAuthorization/);
    t.w.conn.delete(t.ap);
    await expect(buildFreezeTx(conn(t), PAYER, t.w.launch, { notAfter: NOT_AFTER })).rejects.toThrow(/no autopilot.*AccountNotInitialized/);
  });
});

describe("buildRevokeOperatorTx (revocation payload v3, audit 4 A4-3)", () => {
  /** The authorization that activated the running graph, as `apply_pending` records it (`active_auth`). */
  const ACTIVE_AUTH = key("gov/active-auth");

  it("built with the authorization over revokePayload(autopilot, active graph, operator, active_auth); allowed on a frozen graph; planRevokeOperator names the same", async () => {
    const t = govWorld();
    t.value["activeAuth"] = ACTIVE_AUTH;
    t.value["activeActivateAt"] = BigInt(NOW - 86_400);
    const address = t.authorize(3, revokePayload(t.ap, H1, OPERATOR, ACTIVE_AUTH));
    t.value["frozen"] = true;
    t.put();
    const plan = await planRevokeOperator(conn(t), t.w.launch);
    expect([plan.kind, plan.authorization.toBase58(), plan.activeAuth.toBase58(), plan.operator.toBase58()]).toEqual([3, address.toBase58(), ACTIVE_AUTH.toBase58(), OPERATOR.toBase58()]);
    expect(plan.payloadHash).toEqual(revokePayload(t.ap, H1, OPERATOR, ACTIVE_AUTH));
    expect(plan.plain).toMatch(/approve the removal again/);
    const tx = await buildRevokeOperatorTx(conn(t), PAYER, t.w.launch);
    expect(apIx(tx).keys.map((k) => k.pubkey.toBase58())).toEqual([t.ap, t.w.launch, address].map((k) => k.toBase58()));
    expect([...apIx(tx).data]).toEqual(disc("revoke_operator"));
    expect(limitOf(tx)).toBe(AUTOPILOT_COMPUTE_UNITS.revokeOperator);
    expect(legacySize(tx)).toBe(316); // the LiteSVM measurement (316 bytes)
  });

  it("a revocation signed for an earlier activation is dead once another one is applied (the same operator appointed again)", async () => {
    const t = govWorld();
    t.value["activeAuth"] = ACTIVE_AUTH;
    t.put();
    t.authorize(3, revokePayload(t.ap, H1, OPERATOR, ACTIVE_AUTH));
    expect(await buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).toBeDefined();
    // The same graph and operator, activated again: the old revocation names the old activation.
    t.value["activeAuth"] = key("gov/re-activation");
    t.put();
    await expect(buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).rejects.toThrow(/InvalidAuthorization/);
    // A new revocation of this activation works.
    t.authorize(3, revokePayload(t.ap, H1, OPERATOR, key("gov/re-activation")));
    expect(await buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).toBeDefined();
  });

  it("NoOperator; a revocation naming another graph or operator is InvalidAuthorization; a used one is stale", async () => {
    const t = govWorld();
    t.authorize(3, revokePayload(t.ap, H2, OPERATOR, PublicKey.default));
    t.authorize(3, revokePayload(t.ap, H1, key("gov/someone-else"), PublicKey.default));
    await expect(buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).rejects.toThrow(/InvalidAuthorization/);
    await expect(planRevokeOperator(conn(t), t.w.launch)).resolves.toMatchObject({ kind: 3 });
    const address = t.authorize(3, revokePayload(t.ap, H1, OPERATOR, PublicKey.default), { slot: 42n });
    const marks = t.value["authMarks"] as { slot: bigint; key: PublicKey }[];
    marks[2] = { slot: 42n, key: address };
    t.put();
    await expect(buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).rejects.toThrow(/StaleAuthorization/);
    t.value["operator"] = PublicKey.default;
    t.put();
    await expect(buildRevokeOperatorTx(conn(t), PAYER, t.w.launch)).rejects.toThrow(/NoOperator/);
    await expect(planRevokeOperator(conn(t), t.w.launch)).rejects.toThrow(/NoOperator/);
  });
});
