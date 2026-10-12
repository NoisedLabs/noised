/**
 * PQ client, vault v4: recovery phrase, key derivation, the 185-byte
 * message, deterministic signing and its guards, the mint policy of
 * `open_vault`, recipient checks, builders, payouts and the search for an
 * already revealed withdrawal.
 */
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";

import { bytesEqual, concatBytes, toHex, u32le, u64le } from "../src/codec/bytes.js";
import { KNOWN_ACCOUNTS, PROGRAM_IDS, VAULT, WSOL_MINT, type Cluster } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { associatedTokenAddress, extraAccountMetaListAddress, hookPolicyAddress, payoutAddress, vaultAddress } from "../src/pda.js";
import {
  derivationPath,
  deriveVaultKey,
  generateRecoveryPhrase,
  GENESIS_KEY_INDEX,
  isBip39Word,
  keySequence,
  masterFingerprint,
  masterFromPhrase,
  nextKeyIndex,
  normalizePhrase,
  phraseProblems,
} from "../src/pq/keys.js";
import * as lmots from "../src/pq/lmots.js";
import {
  buildDepositTx,
  buildFundFeePayerTx,
  buildOpenVaultTx,
  buildRefundFeePayerTx,
  buildReleaseToTx,
  buildReleaseTx,
  buildWithdrawTx,
  buildWithdrawTxWithFallback,
  checkRecipient,
  checkVaultMint,
  completeVaultKeyRecords,
  decodePayout,
  decodeVault,
  fetchPayout,
  fetchVault,
  findPendingWithdrawal,
  IncompleteSearchError,
  listPayouts,
  parseWithdrawMessage,
  prepareWithdrawal as sdkPrepareWithdrawal,
  randomizer,
  RecipientConfirmationError,
  recordPendingWithdrawal,
  scanVaults,
  signWithdrawal as sdkSignWithdrawal,
  VAULT_COMPUTE_UNITS,
  withdrawMessage,
  WITHDRAW_MESSAGE_FIELDS,
  type PreparedWithdrawal,
  type PrepareWithdrawalOptions,
  type SignWithdrawalOptions,
  type WithdrawalRequest,
} from "../src/pq/vault.js";
import { ClusterMismatchError, GENESIS_HASHES } from "../src/rpc/cluster.js";
import { explainProgramError } from "../src/rpc/errors.js";
import { launchGuardEndTs } from "../src/token/hook.js";
import { parseMint } from "../src/token/mint.js";
import { compileV1Message, decodeV1Transaction, signV1Message } from "../src/tx/v1.js";
import { memoryLeafLedgerStore, type LeafLedgerStore } from "../src/pq/leafLedger.js";
import {
  createMemoryVaultKeyLedger,
  createVaultKeyLedger,
  exportVaultKeyRecords,
  importVaultKeyRecords,
  VAULT_KEY_LEDGER_EXPORT_FORMAT,
  VaultKeyInUseError,
  VaultLedgerError,
  type VaultKeyLedger,
  type VaultKeyRecord,
} from "../src/pq/vaultLedger.js";
import type { PendingWithdrawalContinuation, RecipientCheck, RecipientConfirmation, VaultKeyMaterial, WithdrawTxArgs } from "../src/types.js";
import { ext, key, MockConnection, mintBytes, SPL, T22, tokenAccountBytes, type TlvSpec } from "./helpers.js";
import { accountBytes, clock } from "./world.js";

const PHRASE_0 = "abandon ".repeat(23) + "art";
const master = masterFromPhrase(PHRASE_0);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const b58 = (keys: PublicKey[]): string[] => keys.map((k) => k.toBase58());
/** One durable vault-key ledger for the file's signing calls (each test uses its own vault accounts). */
const LEDGER = createMemoryVaultKeyLedger();
/** The mock RPC serves a local cluster: signing for localnet needs the explicit opt-in. */
const LOCAL = { allowLocalnet: true, ledger: LEDGER } as const;

/**
 * What a UI does before any vault signature: `checkRecipient` for the exact withdrawal, and the user's
 * confirmation of every caution it holds (`RecipientConfirmation`).
 */
async function confirmAll(conn: Connection, destinationOwner: PublicKey, mint: PublicKey, vault: PublicKey, wallet: PublicKey | null = null): Promise<RecipientConfirmation> {
  const recipient = await checkRecipient(conn, destinationOwner, mint, vault, { wallet });
  return { recipient, acknowledged: { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true } };
}

/** A well-formed confirmation of nothing in particular (for calls refused by a local check before the confirmation is matched). */
const NO_CHECK: RecipientConfirmation = {
  recipient: {
    ok: true,
    refusals: [],
    recipientWarnings: [],
    mintWarnings: [],
    offCurveConfirmation: null,
    canonicalAta: null,
    destinationOwner: PublicKey.default,
    mint: PublicKey.default,
    vault: PublicKey.default,
    wallet: null,
  },
  acknowledged: {},
};

type Unconfirmed<T> = Omit<T, "confirm"> & { readonly confirm?: RecipientConfirmation | undefined };

/**
 * `prepareWithdrawal` after the user confirmed everything `checkRecipient` reports for this withdrawal (unless
 * `opts.confirm` is given). `request.wallet` is the connected wallet of that check.
 */
async function prepareWithdrawal(
  conn: Connection,
  m: Uint8Array,
  cluster: Cluster,
  mint: PublicKey,
  account: number,
  request: WithdrawalRequest & { wallet?: PublicKey },
  opts: Unconfirmed<PrepareWithdrawalOptions>,
): Promise<PreparedWithdrawal> {
  const { wallet, ...req } = request;
  const vault = vaultAddress(mint, deriveVaultKey(m, cluster, mint, account, GENESIS_KEY_INDEX).keyId);
  const confirm = opts.confirm ?? (await confirmAll(conn, req.destinationOwner, mint, vault, wallet ?? null));
  return sdkPrepareWithdrawal(conn, m, cluster, mint, account, req, { ...opts, confirm });
}

/** `signWithdrawal` after the user confirmed everything `checkRecipient` reports for `msg`'s recipient (unless `opts.confirm` is given). */
async function signWithdrawal(
  conn: Connection,
  cluster: Cluster,
  key: Pick<VaultKeyMaterial, "skSeed" | "pk">,
  nextKey: lmots.LmotsPublicKey,
  msg: Uint8Array,
  opts: Unconfirmed<SignWithdrawalOptions>,
): Promise<Uint8Array> {
  let confirm = opts.confirm;
  if (confirm === undefined) {
    let m: ReturnType<typeof parseWithdrawMessage> | null = null;
    try {
      m = parseWithdrawMessage(msg);
    } catch {
      m = null; // refused locally by the signer, before the confirmation is matched
    }
    confirm = m === null ? NO_CHECK : await confirmAll(conn, m.destinationOwner, m.mint, m.vault);
  }
  return sdkSignWithdrawal(conn, cluster, key, nextKey, msg, { ...opts, confirm });
}

/** A fresh ledger holding `args`' signature (made by `w`'s key at `args.sequence`), as the signing entry points leave it. */
async function held(w: { keyAt(s: number): VaultKeyMaterial }, args: WithdrawTxArgs, ledger: VaultKeyLedger = createMemoryVaultKeyLedger()): Promise<VaultKeyLedger> {
  const msg = withdrawMessage(args.vault, args.mint, args.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
  const k = w.keyAt(Number(args.sequence));
  const keyId = k.keyId;
  expect(await ledger.reserve(keyId, msg, { vault: args.vault, sequence: args.sequence, key: k.pk })).not.toBe("conflict");
  await ledger.recordSignature(keyId, msg, args.signature, args.nextKey);
  return ledger;
}

function vaultBytes(mint: PublicKey, genesis: VaultKeyMaterial, current: VaultKeyMaterial, sequence: bigint, reserved = 0n): Uint8Array {
  const codec = idlCodecs().vault;
  const [, bump] = PublicKey.findProgramAddressSync([enc("vault"), mint.toBytes(), genesis.keyId], PROGRAM_IDS.vault);
  return concatBytes([
    codec.accountDiscriminator("Vault"),
    codec.encodeType("Vault", {
      version: 4,
      bump,
      mint,
      genesisKeyId: genesis.keyId,
      sequence,
      keyId: current.keyId,
      keyIdent: current.pk.id,
      keyQ: current.pk.q,
      keyK: current.pk.k,
      reserved,
    }),
  ]);
}

function payoutBytes(vault: PublicKey, sequence: bigint, destinationOwner: PublicKey, amount: bigint, rentPayer: PublicKey): Uint8Array {
  const codec = idlCodecs().vault;
  const [, bump] = PublicKey.findProgramAddressSync([enc("payout"), vault.toBytes(), u64le(sequence)], PROGRAM_IDS.vault);
  return concatBytes([codec.accountDiscriminator("Payout"), codec.encodeType("Payout", { version: 1, bump, vault, sequence, destinationOwner, amount, rentPayer })]);
}

const skOf = (k: VaultKeyMaterial): lmots.LmotsPrivateKey => ({ id: k.pk.id, q: k.pk.q, seed: k.skSeed });

/** A generic transfer hook's validation account `["extra-account-metas", mint]` under `hookProgram`. */
const metaListAddress = (mint: PublicKey, hookProgram: PublicKey): PublicKey => PublicKey.findProgramAddressSync([enc("extra-account-metas"), mint.toBytes()], hookProgram)[0];

/** ExtraAccountMetaList bytes (as @solana/spl-token decodes them) with `n` fixed read-only extra accounts. */
function metaListBytes(n: number): Uint8Array {
  const metas = Array.from({ length: n }, (_, i) => concatBytes([Uint8Array.of(0), key(`extra-meta-${i}`).toBytes(), Uint8Array.of(0, 0)]));
  return concatBytes([new Uint8Array(8), u32le(4 + 35 * n), u32le(n), ...metas]);
}

interface VaultWorld {
  conn: MockConnection;
  mint: PublicKey;
  tp: PublicKey;
  genesis: VaultKeyMaterial;
  vault: PublicKey;
  tokenAccount: PublicKey;
  keyAt(sequence: number): VaultKeyMaterial;
  setVault(sequence: bigint, reserved?: bigint): VaultKeyMaterial;
  setBalance(amount: bigint): void;
  setPayout(sequence: bigint, destinationOwner: PublicKey, amount: bigint, rentPayer: PublicKey): PublicKey;
  /** A withdrawal at `sequence` signed by key(sequence), naming key(sequence + 1). */
  signed(sequence: bigint, destinationOwner: PublicKey, maxAmount: bigint): WithdrawTxArgs;
}

/** A vault of account `account` of PHRASE_0 on localnet, opened unless `open` is false. */
function vaultWorld(o: { tokenProgram?: PublicKey; mint?: PublicKey; mintExtensions?: TlvSpec[]; account?: number; open?: boolean } = {}): VaultWorld {
  const conn = new MockConnection();
  const tp = o.tokenProgram ?? SPL;
  const mint = o.mint ?? key(`vw/mint/${tp.toBase58().slice(0, 4)}/${o.account ?? 0}`);
  const account = o.account ?? 0;
  const keyAt = (s: number): VaultKeyMaterial => deriveVaultKey(master, "localnet", mint, account, s);
  const genesis = keyAt(0);
  const vault = vaultAddress(mint, genesis.keyId);
  const tokenAccount = associatedTokenAddress(vault, mint, tp);
  conn.set(mint, { owner: tp, data: tp.equals(SPL) ? mintBytes({ decimals: mint.equals(WSOL_MINT) ? 9 : 6 }) : mintBytes({ decimals: 6, extensions: o.mintExtensions ?? [] }) });
  const w: VaultWorld = {
    conn,
    mint,
    tp,
    genesis,
    vault,
    tokenAccount,
    keyAt,
    setVault(sequence, reserved = 0n) {
      const current = keyAt(Number(sequence));
      conn.set(vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(mint, genesis, current, sequence, reserved) });
      return current;
    },
    setBalance(amount) {
      conn.set(tokenAccount, { owner: tp, data: tokenAccountBytes({ mint, owner: vault, amount, token2022: tp.equals(T22) }) });
    },
    setPayout(sequence, destinationOwner, amount, rentPayer) {
      const address = payoutAddress(vault, sequence);
      conn.set(address, { owner: PROGRAM_IDS.vault, data: payoutBytes(vault, sequence, destinationOwner, amount, rentPayer) });
      return address;
    },
    signed(sequence, destinationOwner, maxAmount) {
      const current = keyAt(Number(sequence));
      const next = keyAt(Number(sequence) + 1);
      const msg = withdrawMessage(vault, mint, sequence, destinationOwner, maxAmount, next.keyId);
      return { mint, vault, sequence, destinationOwner, maxAmount, signature: lmots.signDeterministic(skOf(current), msg), nextKey: next.pk, nextKeyId: next.keyId };
    },
  };
  if (o.open !== false) {
    w.setVault(0n);
    w.setBalance(0n);
  }
  return w;
}

// ------------------------------------------------------------- phrase ---

describe("PQ recovery phrase (separate 24-word BIP-39 phrase)", () => {
  it("generates valid 24-word phrases from the CSPRNG", () => {
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    expect(a.split(" ").length).toBe(24);
    expect(a).not.toBe(b);
    expect(phraseProblems(a)).toEqual([]);
    expect(masterFromPhrase(a).length).toBe(64);
  });

  it("master = BIP-39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt 'mnemonic', no passphrase)", () => {
    const independent = pbkdf2(sha512, enc(PHRASE_0), enc("mnemonic"), { c: 2048, dkLen: 64 });
    expect(toHex(master)).toBe(toHex(independent));
    // The library itself reproduces the published BIP-39 vector (passphrase "TREZOR").
    expect(toHex(mnemonicToSeedSync(PHRASE_0, "TREZOR"))).toBe(
      "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
    );
  });

  it("normalizes input and explains problems without echoing the phrase", () => {
    expect(normalizePhrase(`  ${PHRASE_0.toUpperCase().replace(/ /g, "  \n")} `)).toBe(PHRASE_0);
    expect(toHex(masterFromPhrase(`  ${PHRASE_0.toUpperCase()}  `))).toBe(toHex(master));
    expect(phraseProblems("abandon art")[0]).toMatch(/24 words/);
    expect(phraseProblems(PHRASE_0.replace("art", "zzzz"))[0]).toMatch(/Word 24/);
    expect(phraseProblems(PHRASE_0.replace("art", "zoo"))[0]).toMatch(/checksum/);
    expect(() => masterFromPhrase("abandon")).toThrow(/24 words/);
    expect(isBip39Word("Abandon")).toBe(true);
    expect(isBip39Word("noised")).toBe(false);
    expect(masterFingerprint(master)).toMatch(/^[0-9A-F]{8}$/);
  });
});

// --------------------------------------------------------- derivation ---

describe("LM-OTS key derivation, vault v4 (SPEC §3.10)", () => {
  const mint = key("vault/mint");

  it("path = cluster | mint | u32le(account) | u32le(sequence); SEED and I from domain-separated SHA-256; q = sequence", () => {
    const path = concatBytes([Uint8Array.of(0), mint.toBytes(), u32le(3), u32le(7)]);
    expect(path.length).toBe(41);
    expect(toHex(derivationPath("mainnet", mint, 3, 7))).toBe(toHex(path));
    const k = deriveVaultKey(master, "mainnet", mint, 3, 7);
    expect(toHex(k.skSeed)).toBe(toHex(sha256(concatBytes([enc("phalanx/pq/lmots/seed"), master, path]))));
    expect(toHex(k.pk.id)).toBe(toHex(sha256(concatBytes([enc("phalanx/pq/lmots/id"), master, path])).slice(0, 16)));
    expect(k.pk.q).toBe(7);
    expect(toHex(k.pk.k)).toBe(toHex(lmots.publicKey({ id: k.pk.id, q: 7, seed: k.skSeed }).k));
    expect(toHex(k.keyId)).toBe(toHex(lmots.keyId(k.pk)));
  });

  it("known-answer values from an independent implementation (Python hashlib)", () => {
    // master = BIP-39 seed of "abandon x23 art"; mint = key("vault/mint").
    const genesis = deriveVaultKey(master, "localnet", mint, 0, 0);
    expect(toHex(genesis.skSeed)).toBe("3584620237d08fe4b50f7354363acf5b902fb7af0004f847bef4a4b4ae48ce37");
    expect(toHex(genesis.pk.id)).toBe("7fc80a94bfbefe4f7bf78309e23f0850");
    expect(toHex(genesis.pk.k)).toBe("01449a4fe7cbc98755a4cc672815651462620e7061899f97c458c7419335d1aa");
    expect(toHex(genesis.keyId)).toBe("08780161798480d303148ca14684252734ec919b658924d40f9cf85973cc1168");
    expect(toHex(randomizer(genesis.skSeed, genesis.pk, enc("phalanx/kat")))).toBe("2038b864a9bb447ca55b013c498807c709700bf314f77c270c0a1b73d70f45fa");
    const k = deriveVaultKey(master, "mainnet", mint, 3, 7);
    expect(toHex(k.skSeed)).toBe("6534dd1fccfd1a268c40ed4b8a5a5d103e32a33bab435ee98e97e29c3a84170f");
    expect(toHex(k.pk.id)).toBe("d1633f150d5bf72141df5286bd0b7ee0");
    expect(toHex(k.pk.k)).toBe("f6608c4e766c1ccfda3a1bac35a6b77db53515e133511abe3584797de5a8d1e2");
    expect(toHex(k.keyId)).toBe("5738f21cfdcb973ded16b1ac36347e74a045fc17b461f078f028bd874f37ebf4");
    expect(toHex(randomizer(k.skSeed, k.pk, enc("phalanx/kat")))).toBe("c6ce8f9d149f232ff42d006411e809c041f1ec7a2e6f7b854fd64593d0756b3c");
  });

  it("v4 keys never equal v3 keys (41-byte paths vs v3's 37-byte cluster | mint | u32le(index))", () => {
    for (const index of [0, 1, 7]) {
      const v3Path = concatBytes([Uint8Array.of(2), mint.toBytes(), u32le(index)]);
      const v3Seed = sha256(concatBytes([enc("phalanx/pq/lmots/seed"), master, v3Path]));
      for (const account of [0, 1]) expect(toHex(deriveVaultKey(master, "localnet", mint, account, index).skSeed)).not.toBe(toHex(v3Seed));
    }
  });

  it("every (cluster, mint, account, sequence) gets its own key; bounds", () => {
    const ids = new Set(
      [
        deriveVaultKey(master, "mainnet", mint, 0, 0),
        deriveVaultKey(master, "devnet", mint, 0, 0),
        deriveVaultKey(master, "mainnet", key("other"), 0, 0),
        deriveVaultKey(master, "mainnet", mint, 1, 0),
        deriveVaultKey(master, "mainnet", mint, 0, 1),
        deriveVaultKey(master, "mainnet", mint, 1, 1),
      ].map((k) => toHex(k.keyId)),
    );
    expect(ids.size).toBe(6);
    expect(() => deriveVaultKey(master.slice(1), "mainnet", mint, 0, 0)).toThrow(/64-byte/);
    // A wiped (all-zero) master is no phrase's seed, and every key derived from it is public.
    expect(() => deriveVaultKey(new Uint8Array(64), "mainnet", mint, 0, 0)).toThrow(/all-zero master/);
    expect(() => deriveVaultKey(Uint8Array.from(master).fill(0), "mainnet", mint, 0, 1)).toThrow(/all-zero master/);
    expect(() => deriveVaultKey(master, "mainnet", mint, -1, 0)).toThrow(/account/);
    expect(() => deriveVaultKey(master, "mainnet", mint, 2 ** 32, 0)).toThrow(/account/);
    expect(() => deriveVaultKey(master, "mainnet", mint, 0, 2 ** 32)).toThrow(/sequence/);
    expect(() => deriveVaultKey(master, "mainnet", mint, 0, 1.5)).toThrow(/sequence/);
    expect(keySequence(0n)).toBe(0);
    expect(keySequence(0xffff_ffffn)).toBe(0xffff_ffff);
    expect(() => keySequence(0x1_0000_0000n)).toThrow(/no key/);
    expect(() => keySequence(-1n)).toThrow(/no key/);
  });
});

// ------------------------------------------------------------ message ---

describe("withdraw message (PHX-PQV4, 185 bytes)", () => {
  const mint = key("msg/mint");
  const dest = key("msg/dest");
  const vault = key("msg/vault");
  const nextKeyId = new Uint8Array(32).fill(5);

  it("layout byte for byte, display fields and parse round trip", () => {
    const msg = withdrawMessage(vault, mint, 0x0102n, dest, 0x0a0bn, nextKeyId);
    expect(msg.length).toBe(185);
    expect(toHex(msg)).toBe(
      toHex(
        concatBytes([
          enc("PHX-PQV4"),
          Uint8Array.of(1),
          PROGRAM_IDS.vault.toBytes(),
          vault.toBytes(),
          mint.toBytes(),
          Uint8Array.of(0x02, 0x01, 0, 0, 0, 0, 0, 0),
          dest.toBytes(),
          Uint8Array.of(0x0b, 0x0a, 0, 0, 0, 0, 0, 0),
          nextKeyId,
        ]),
      ),
    );
    // The fields tile the message exactly.
    expect(WITHDRAW_MESSAGE_FIELDS[0]!.start).toBe(0);
    WITHDRAW_MESSAGE_FIELDS.forEach((f, i) => i > 0 && expect(f.start).toBe(WITHDRAW_MESSAGE_FIELDS[i - 1]!.end));
    expect(WITHDRAW_MESSAGE_FIELDS.at(-1)!.end).toBe(185);
    const p = parseWithdrawMessage(msg);
    expect([p.vault.equals(vault), p.mint.equals(mint), p.destinationOwner.equals(dest), p.programId.equals(PROGRAM_IDS.vault)]).toEqual([true, true, true, true]);
    expect([p.sequence, p.maxAmount, toHex(p.nextKeyId)]).toEqual([0x0102n, 0x0a0bn, toHex(nextKeyId)]);
  });

  it("refuses values outside their widths and malformed messages", () => {
    expect(() => withdrawMessage(vault, mint, -1n, dest, 1n, nextKeyId)).toThrow(/sequence/);
    expect(() => withdrawMessage(vault, mint, 1n << 64n, dest, 1n, nextKeyId)).toThrow(/sequence/);
    expect(() => withdrawMessage(vault, mint, 0n, dest, 1n << 64n, nextKeyId)).toThrow(/maxAmount/);
    expect(() => withdrawMessage(vault, mint, 0n, dest, 1n, new Uint8Array(31))).toThrow(/32 bytes/);
    const msg = withdrawMessage(vault, mint, 0n, dest, 1n, nextKeyId);
    expect(() => parseWithdrawMessage(msg.subarray(1))).toThrow(/185/);
    const v3 = Uint8Array.from(msg);
    v3.set(enc("PHX-PQV3"), 0);
    expect(() => parseWithdrawMessage(v3)).toThrow(/PHX-PQV4/);
  });
});

// ------------------------------------------------------------- signing ---

describe("signWithdrawal: cluster-checked, key-index bound, deterministic, self-verified", () => {
  const dest = key("sign/dest");

  it("C is the HMAC randomizer; signing the identical message again returns the identical signature", async () => {
    const w = vaultWorld({ account: 10 });
    w.setVault(4n);
    const c = w.conn.asConnection();
    const k = w.keyAt(4);
    const next = w.keyAt(5);
    const msg = withdrawMessage(w.vault, w.mint, 4n, dest, 99n, next.keyId);
    const a = await signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL);
    expect(a.length).toBe(VAULT.SIGNATURE_LEN);
    expect(lmots.verify(k.pk, msg, a)).toBe(true);
    expect(toHex(a.subarray(0, 32))).toBe(toHex(randomizer(k.skSeed, k.pk, msg)));
    expect(toHex(randomizer(k.skSeed, k.pk, msg))).toBe(toHex(lmots.hmacSha256(k.skSeed, [enc("phalanx/pq/lmots/C"), k.pk.id, Uint8Array.of(0, 0, 0, 4), msg])));
    // A retry is not a second signature.
    expect(toHex(await signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL))).toBe(toHex(a));
    // A different message with the same one-time key is refused.
    const other = withdrawMessage(w.vault, w.mint, 4n, dest, 100n, next.keyId);
    await expect(signWithdrawal(c, "localnet", k, next.pk, other, LOCAL)).rejects.toThrow(/already signed a different withdrawal/);
    // ...and still nothing breaks for the message it did sign.
    expect(toHex(await signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL))).toBe(toHex(a));
  });

  it("local refusals (key-index binding included) come before any RPC and never consume the key", async () => {
    const w = vaultWorld({ account: 11 });
    w.setVault(2n);
    const c = w.conn.asConnection();
    const k = w.keyAt(2);
    const next = w.keyAt(3);
    const vault = w.vault;
    const mint = w.mint;
    const good = withdrawMessage(vault, mint, 2n, dest, 5n, next.keyId);
    const confirm = await confirmAll(c, dest, mint, vault);
    const sign = (key: Pick<VaultKeyMaterial, "skSeed" | "pk">, nextKey: lmots.LmotsPublicKey, msg: Uint8Array): Promise<Uint8Array> => signWithdrawal(c, "localnet", key, nextKey, msg, { ...LOCAL, confirm });
    const calls = w.conn.calls.length;
    await expect(sign({ skSeed: next.skSeed, pk: k.pk }, next.pk, good)).rejects.toThrow(/seed does not match/);
    await expect(sign({ skSeed: k.skSeed.subarray(1), pk: k.pk }, next.pk, good)).rejects.toThrow(/32 bytes/);
    await expect(sign(k, next.pk, withdrawMessage(vault, mint, 3n, dest, 5n, next.keyId))).rejects.toThrow(/sequence 3, but this is the key of sequence 2/);
    await expect(sign(k, k.pk, withdrawMessage(vault, mint, 2n, dest, 5n, k.keyId))).rejects.toThrow(/different key/);
    await expect(sign(k, next.pk, withdrawMessage(vault, mint, 2n, dest, 5n, new Uint8Array(32)))).rejects.toThrow(/empty next key/);
    await expect(sign(k, next.pk, withdrawMessage(vault, mint, 2n, vault, 5n, next.keyId))).rejects.toThrow(/vault itself/);
    await expect(sign(k, next.pk, withdrawMessage(vault, mint, 2n, PublicKey.default, 5n, next.keyId))).rejects.toThrow(/all-zero/);
    // Vault key-index binding: the next key must hash to the signed id and sit at position sequence + 1.
    await expect(sign(k, w.keyAt(4).pk, good)).rejects.toThrow(/does not hash to the message's next key id \(KeyIdMismatch\)/);
    const skipped = w.keyAt(4);
    await expect(sign(k, skipped.pk, withdrawMessage(vault, mint, 2n, dest, 5n, skipped.keyId))).rejects.toThrow(/index q = 4, .*index 3 \(InvalidKeyIndex\)/);
    const forged = { ...next.pk, q: 9 };
    await expect(sign(k, forged, withdrawMessage(vault, mint, 2n, dest, 5n, lmots.keyId(forged)))).rejects.toThrow(/InvalidKeyIndex/);
    const badTag = Uint8Array.from(good);
    badTag[0] = 0x51;
    await expect(sign(k, next.pk, badTag)).rejects.toThrow(/PHX-PQV4/);
    const foreign = Uint8Array.from(good);
    foreign.set(new Uint8Array(32).fill(1), 9);
    await expect(sign(k, next.pk, foreign)).rejects.toThrow(/another program/);
    await expect(sign(k, next.pk, good.subarray(1))).rejects.toThrow(/185/);
    // None of these reached the RPC.
    expect(w.conn.calls.length).toBe(calls);
    // None of the refusals consumed the key.
    expect(lmots.verify(k.pk, good, await sign(k, next.pk, good))).toBe(true);
  });

  it("the last sequence has no next key: refused", async () => {
    const mint = key("sign/last-mint");
    const last = deriveVaultKey(master, "localnet", mint, 0, 0xffff_ffff);
    expect(nextKeyIndex(0xffff_fffen)).toBe(0xffff_ffff);
    expect(nextKeyIndex(0xffff_ffffn)).toBeNull();
    expect(nextKeyIndex(2n ** 64n - 1n)).toBeNull();
    expect(GENESIS_KEY_INDEX).toBe(0);
    const msg = withdrawMessage(key("sign/last-vault"), mint, 0xffff_ffffn, dest, 1n, new Uint8Array(32).fill(7));
    await expect(signWithdrawal(new MockConnection().asConnection(), "localnet", last, last.pk, msg, LOCAL)).rejects.toThrow(/vault's last; no next key/);
  });

  it("refuses unless the endpoint serves the keys' cluster (genesis hash), and unless the vault's current key is this key at this sequence", async () => {
    // Audit round 2: a mislabeled devnet run must not produce mainnet-valid signatures.
    const w = vaultWorld({ account: 12 });
    w.setVault(1n);
    const c = w.conn.asConnection();
    const k = w.keyAt(1);
    const next = w.keyAt(2);
    const msg = withdrawMessage(w.vault, w.mint, 1n, dest, 5n, next.keyId);
    await expect(signWithdrawal(c, "localnet", k, next.pk, msg, { ledger: LEDGER })).rejects.toThrow(/without allowLocalnet/);
    for (const [hash, cluster] of [
      [GENESIS_HASHES.mainnet, "devnet"],
      [GENESIS_HASHES.devnet, "mainnet"],
      [GENESIS_HASHES.mainnet, "localnet"],
      [GENESIS_HASHES.devnet, "localnet"],
      ["4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL", "mainnet"],
    ] as const) {
      w.conn.genesisHash = hash;
      const e = await signWithdrawal(c, cluster, k, next.pk, msg, LOCAL).catch((x: unknown) => x);
      expect(e, `${cluster} on ${hash}`).toBeInstanceOf(ClusterMismatchError);
    }
    w.conn.genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
    // The vault must be at the message's sequence with this key: never a signature by a future or spent key.
    w.setVault(2n);
    await expect(signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL)).rejects.toThrow(/vault is at sequence 2.*already executed/);
    w.setVault(0n);
    await expect(signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL)).rejects.toThrow(/vault is at sequence 0, the message is for sequence 1/);
    w.conn.set(w.vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(w.mint, w.genesis, deriveVaultKey(master, "localnet", w.mint, 99, 1), 1n) });
    await expect(signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL)).rejects.toThrow(/not the vault's current key/);
    w.conn.delete(w.vault);
    await expect(signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL)).rejects.toThrow(/does not exist/);
    // Nothing above consumed the key: the right cluster and vault sign.
    w.setVault(1n);
    expect(lmots.verify(k.pk, msg, await signWithdrawal(c, "localnet", k, next.pk, msg, LOCAL))).toBe(true);
  });
});

// ---------------------------------------------------------- mint policy ---

describe("checkVaultMint mirrors open_vault (token.rs require_supported_mint)", () => {
  const mint = key("policy/mint");
  const check = async (owner: PublicKey, data: Uint8Array | null) => {
    const conn = new MockConnection();
    if (data !== null) conn.set(mint, { owner, data });
    return checkVaultMint(conn.asConnection(), mint);
  };

  it("eligible mints", async () => {
    const spl = await check(SPL, mintBytes({}));
    expect(spl).toMatchObject({ eligible: true, refusals: [], warnings: [] });
    expect(spl.tokenProgram?.equals(SPL)).toBe(true);
    const t22 = await check(T22, mintBytes({ extensions: [ext.metadataPointer(null, mint)] }));
    expect(t22.eligible).toBe(true);
    expect(t22.warnings.some((w) => w.includes("Token-2022 is upgradeable"))).toBe(true);
    const fixedFee = await check(T22, mintBytes({ extensions: [ext.transferFeeConfig(null, null, 50)] }));
    expect(fixedFee.eligible).toBe(true);
    expect(fixedFee.warnings.some((w) => w.includes("50 bps"))).toBe(true);
    // A close authority of None can never be set later: accepted.
    expect((await check(T22, mintBytes({ extensions: [ext.mintCloseAuthority(null)] }))).eligible).toBe(true);
  });

  it("refusals (an Ed25519 key could take or strand vaulted tokens)", async () => {
    expect((await check(T22, mintBytes({ extensions: [ext.nonTransferable()] }))).refusals[0]).toMatch(/NonTransferable/);
    expect((await check(T22, mintBytes({ extensions: [ext.permanentDelegate(key("d"))] }))).refusals[0]).toMatch(/PermanentDelegate/);
    // open_vault refuses the extension even when no delegate is set.
    expect((await check(T22, mintBytes({ extensions: [ext.permanentDelegate(null)] }))).eligible).toBe(false);
    // v4: a close authority could close the mint at zero supply and re-create it with a permanent delegate.
    const closer = await check(T22, mintBytes({ extensions: [ext.mintCloseAuthority(key("closer"))] }));
    expect(closer.eligible).toBe(false);
    expect(closer.refusals[0]).toMatch(/MintCloseAuthority .*re-created .*permanent delegate/);
    expect((await check(T22, mintBytes({ extensions: [{ type: 3, data: new Uint8Array(31) }] }))).refusals[0]).toMatch(/MintCloseAuthority cannot be parsed/);
    expect((await check(T22, mintBytes({ extensions: [ext.transferFeeConfig(key("cfg"), null)] }))).refusals[0]).toMatch(/TransferFeeConfig authority/);
    expect((await check(T22, mintBytes({ extensions: [ext.transferFeeConfig(null, key("w"))] }))).refusals[0]).toMatch(/Withdraw-withheld/);
    expect((await check(T22, mintBytes({ extensions: [ext.raw(28, new Uint8Array(8))] }))).refusals[0]).toMatch(/cannot parse/);
    expect((await check(T22, mintBytes({ initialized: false }))).eligible).toBe(false);
    expect((await check(key("not-a-token-program"), mintBytes({}))).refusals[0]).toMatch(/Not a token mint/);
    expect((await check(T22, null)).refusals[0]).toMatch(/does not exist/);
    expect((await check(T22, mintBytes({ extensions: [{ type: 1, data: new Uint8Array(10) }] }))).refusals[0]).toMatch(/cannot be parsed/);
  });

  it("warnings for powers that can only delay or dilute", async () => {
    const r = await check(
      T22,
      mintBytes({
        mintAuthority: key("minter"),
        freezeAuthority: key("freezer"),
        extensions: [ext.transferHook(key("hook-auth"), key("hook-prog")), ext.pausable(key("pauser"), true), ext.defaultAccountState(2)],
      }),
    );
    expect(r.eligible).toBe(true);
    const all = r.warnings.join("\n");
    for (const s of ["Mint authority", "Freeze authority", "Transfer hook program", "Transfer-hook authority", "Pause authority", "paused right now", "start frozen"]) {
      expect(all).toContain(s);
    }
  });
});

// ----------------------------------------------------------- recipients ---

describe("checkRecipient (the recipient must be a wallet)", () => {
  const mint = key("rc/mint");
  const vault = key("rc/vault");
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey;
  function conn(tp: PublicKey = SPL, mintExtensions: TlvSpec[] = [], freezeAuthority: PublicKey | null = null): MockConnection {
    const c = new MockConnection();
    c.set(mint, { owner: tp, data: tp.equals(SPL) ? mintBytes({ freezeAuthority }) : mintBytes({ freezeAuthority, extensions: mintExtensions }) });
    return c;
  }
  const clean = { ok: true, refusals: [], recipientWarnings: [], mintWarnings: [], offCurveConfirmation: null };

  it("a wallet, funded or not, is fine; release pays its canonical ATA", async () => {
    const c = conn();
    const r = await checkRecipient(c.asConnection(), wallet, mint, vault);
    expect(r).toMatchObject(clean);
    expect(r.canonicalAta?.equals(associatedTokenAddress(wallet, mint, SPL))).toBe(true);
    c.set(wallet, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 5 });
    expect((await checkRecipient(c.asConnection(), wallet, mint, vault)).ok).toBe(true);
    // An existing, healthy canonical ATA is fine too, and so is naming the connected wallet itself.
    c.set(associatedTokenAddress(wallet, mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint, owner: wallet, amount: 3n }) });
    expect(await checkRecipient(c.asConnection(), wallet, mint, vault, { wallet })).toMatchObject(clean);
  });

  it("refuses token accounts, mints, the vault itself, vault-program accounts and the zero address", async () => {
    const c = conn();
    const tokenAccount = key("rc/token-account");
    c.set(tokenAccount, { owner: SPL, data: tokenAccountBytes({ mint, owner: wallet, amount: 1n }) });
    const t22Account = key("rc/t22-account");
    c.set(t22Account, { owner: T22, data: tokenAccountBytes({ mint: key("m2"), owner: wallet, amount: 1n, token2022: true }) });
    const otherMint = key("rc/other-mint");
    c.set(otherMint, { owner: T22, data: mintBytes({ extensions: [] }) });
    const payout = key("rc/payout");
    c.set(payout, { owner: PROGRAM_IDS.vault, data: new Uint8Array(122) });
    const cases: [PublicKey, RegExp][] = [
      [tokenAccount, /token account .*not a wallet/],
      [t22Account, /token account/],
      [otherMint, /is a mint/],
      [mint, /is a mint/],
      [vault, /vault itself/],
      [payout, /Noised vault program/],
      [PublicKey.default, /all-zero/],
    ];
    for (const [who, why] of cases) {
      const r = await checkRecipient(c.asConnection(), who, mint, vault);
      expect(r.ok, who.toBase58()).toBe(false);
      expect(r.refusals.join("\n")).toMatch(why);
      expect(r.offCurveConfirmation).toBeNull();
    }
  });

  it("refuses the vault's own token account and the connected wallet's own token accounts (both token programs), existing or not", async () => {
    const c = conn();
    for (const tp of [SPL, T22]) {
      const vaultAta = associatedTokenAddress(vault, mint, tp);
      expect(await checkRecipient(c.asConnection(), vaultAta, mint, vault)).toMatchObject({
        ok: false,
        refusals: [expect.stringMatching(/this vault's own token account \(its deposit address\)/)],
      });
      const own = associatedTokenAddress(wallet, mint, tp);
      // Not created yet (or closed): an off-curve address without an account, which only the connected wallet tells apart.
      expect((await checkRecipient(c.asConnection(), own, mint, vault)).offCurveConfirmation).not.toBeNull();
      const r = await checkRecipient(c.asConnection(), own, mint, vault, { wallet });
      expect(r).toMatchObject({ ok: false, offCurveConfirmation: null });
      expect(r.refusals).toEqual([expect.stringMatching(new RegExp(`your connected wallet's own token account for this mint.*${wallet.toBase58()}`))]);
    }
    // An existing one: one refusal, the specific one.
    const own = associatedTokenAddress(wallet, mint, SPL);
    c.set(own, { owner: SPL, data: tokenAccountBytes({ mint, owner: wallet, amount: 0n }) });
    expect((await checkRecipient(c.asConnection(), own, mint, vault, { wallet })).refusals).toEqual([expect.stringMatching(/your connected wallet's own token account/)]);
  });

  it("refuses the payout PDAs of this vault: the 1,024 sequences before its own, its own and the 64 after, released or not yet created", async () => {
    // Audit round 2: a released payout PDA has no account any more, and a payout made to it is lost.
    const w = vaultWorld({ account: 7 });
    w.setVault(2_000n);
    const c = w.conn.asConnection();
    for (const s of [2_000n, 2_001n, 2_064n, 1_999n, 1_500n, 976n]) {
      const r = await checkRecipient(c, payoutAddress(w.vault, s), w.mint, w.vault);
      expect(r.ok, String(s)).toBe(false);
      expect(r.refusals).toEqual([expect.stringMatching(new RegExp(`payout address of this vault's withdrawal at sequence ${s} `))]);
      expect(r.offCurveConfirmation).toBeNull();
    }
    // Further away it is not recognised, but it is still an off-curve address without an account.
    for (const s of [975n, 2_065n]) {
      expect(await checkRecipient(c, payoutAddress(w.vault, s), w.mint, w.vault)).toMatchObject({ ok: true, offCurveConfirmation: expect.stringMatching(/lost forever/) });
    }
    // A young vault: every payout PDA since sequence 0.
    w.setVault(100n);
    expect((await checkRecipient(c, payoutAddress(w.vault, 0n), w.mint, w.vault)).ok).toBe(false);
    // An unreleased payout: one refusal.
    const live = w.setPayout(99n, key("rc/x"), 1n, key("rc/rent"));
    expect((await checkRecipient(c, live, w.mint, w.vault)).refusals).toHaveLength(1);
  });

  it("an off-curve recipient without an account needs its own confirmation; an existing one only warns", async () => {
    const c = conn(SPL, [], key("freezer"));
    const pda = PublicKey.findProgramAddressSync([enc("escrow")], key("some-program"))[0];
    const r = await checkRecipient(c.asConnection(), pda, mint, vault);
    expect(r).toMatchObject({ ok: true, refusals: [], recipientWarnings: [] });
    // Accurate text: a program wallet is legitimate, a token-account, vault or payout address is a permanent loss.
    expect(r.offCurveConfirmation).toMatch(
      /off the Ed25519 curve .*has no account on chain.*multisig vault.*associated token account that was closed or not created yet.*vault or a payout.*lost forever/,
    );
    // It is none of the mint's warnings: those are confirmed separately.
    expect(r.mintWarnings.join("\n")).toMatch(/Freeze authority/);
    expect(r.mintWarnings.join("\n")).not.toMatch(/off the Ed25519 curve/);
    // The same address once it exists (a program wallet holding SOL): a recipient warning, no special confirmation.
    c.set(pda, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 1_000_000 });
    const existing = await checkRecipient(c.asConnection(), pda, mint, vault);
    expect(existing.offCurveConfirmation).toBeNull();
    expect(existing.recipientWarnings).toEqual([expect.stringMatching(/off the Ed25519 curve.*release_to/)]);
  });

  it("warns for accounts of other programs and programs (recipient warnings)", async () => {
    const c = conn();
    const owned = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey;
    c.set(owned, { owner: key("other-program"), data: Uint8Array.of(1, 2, 3) });
    expect((await checkRecipient(c.asConnection(), owned, mint, vault)).recipientWarnings.join("\n")).toMatch(/account of program/);
    const program = Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey;
    c.set(program, { owner: KNOWN_ACCOUNTS.bpfLoaderUpgradeable, data: new Uint8Array(36), executable: true });
    expect(await checkRecipient(c.asConnection(), program, mint, vault)).toMatchObject({ ok: true, recipientWarnings: [expect.stringMatching(/is a program/)], mintWarnings: [] });
  });

  it("warns about the canonical ATA (recipient warnings): reassigned, frozen, memo-required, confidential-only", async () => {
    const spl = conn();
    const ata = associatedTokenAddress(wallet, mint, SPL);
    spl.set(ata, { owner: SPL, data: tokenAccountBytes({ mint, owner: key("new-owner"), amount: 0n }) });
    let r = await checkRecipient(spl.asConnection(), wallet, mint, vault);
    expect(r.ok).toBe(true);
    expect(r.recipientWarnings.join("\n")).toMatch(/reassigned/);
    spl.set(ata, { owner: SPL, data: tokenAccountBytes({ mint, owner: wallet, amount: 0n, state: 2 }) });
    r = await checkRecipient(spl.asConnection(), wallet, mint, vault);
    expect(r.recipientWarnings.join("\n")).toMatch(/frozen.*release_to/);
    expect(r.mintWarnings).toEqual([]);

    const t22 = conn(T22);
    const t22Ata = associatedTokenAddress(wallet, mint, T22);
    expect((await checkRecipient(t22.asConnection(), wallet, mint, vault)).canonicalAta?.equals(t22Ata)).toBe(true);
    t22.set(t22Ata, { owner: T22, data: tokenAccountBytes({ mint, owner: wallet, amount: 0n, token2022: true, extensions: [ext.memoTransfer(true)] }) });
    r = await checkRecipient(t22.asConnection(), wallet, mint, vault);
    expect(r.ok).toBe(true);
    expect(r.recipientWarnings.join("\n")).toMatch(/requires incoming memos: fine/);
    t22.set(t22Ata, { owner: T22, data: tokenAccountBytes({ mint, owner: wallet, amount: 0n, token2022: true, extensions: [ext.confidentialAccount(false)] }) });
    expect((await checkRecipient(t22.asConnection(), wallet, mint, vault)).recipientWarnings.join("\n")).toMatch(/non-confidential credits.*release_to/);
    t22.set(t22Ata, { owner: T22, data: tokenAccountBytes({ mint, owner: wallet, amount: 0n, token2022: true, extensions: [ext.confidentialAccount(true)] }) });
    expect((await checkRecipient(t22.asConnection(), wallet, mint, vault)).recipientWarnings).toEqual([]);
  });

  it("mint powers that can delay a payout are mint warnings, never refusals", async () => {
    const c = conn(T22, [ext.transferHook(null, PROGRAM_IDS.hook), ext.pausable(key("pauser"), true), ext.defaultAccountState(2)], key("freezer"));
    const r = await checkRecipient(c.asConnection(), wallet, mint, vault);
    expect(r).toMatchObject({ ok: true, recipientWarnings: [], offCurveConfirmation: null });
    const all = r.mintWarnings.join("\n");
    for (const s of ["Freeze authority", "Pause authority", "paused right now", "Transfer hook program", "start frozen"]) expect(all).toContain(s);
    const missing = new MockConnection();
    expect((await checkRecipient(missing.asConnection(), wallet, mint, vault)).refusals.join()).toMatch(/does not exist/);
    // A frozen vault token account delays every payout (the withdrawal itself still executes): the same for every recipient.
    const frozen = conn();
    frozen.set(associatedTokenAddress(vault, mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint, owner: vault, amount: 5n, state: 2 }) });
    const f = await checkRecipient(frozen.asConnection(), wallet, mint, vault);
    expect(f).toMatchObject({ ok: true, recipientWarnings: [], mintWarnings: [expect.stringMatching(/vault's token account is frozen right now/)] });
  });
});

// ------------------------------------------------------------- builders ---

describe("open_vault and deposits", () => {
  it("open_vault: genesis key only; refuses ineligible mints and open vaults", async () => {
    const w = vaultWorld({ open: false });
    const payer = key("ov/payer");
    const tx = await buildOpenVaultTx(w.conn.asConnection(), payer, w.mint, w.genesis.pk);
    const ix = tx.instructions.at(-1)!;
    expect(b58(ix.keys.map((k) => k.pubkey))).toEqual(b58([payer, w.mint, w.vault, w.tokenAccount, SPL, KNOWN_ACCOUNTS.associatedToken, SystemProgram.programId]));
    expect(toHex(ix.data)).toBe(toHex(idlCodecs().vault.encodeInstruction("open_vault", { keyIdArg: w.genesis.keyId, key: w.genesis.pk })));
    await expect(buildOpenVaultTx(w.conn.asConnection(), payer, w.mint, w.keyAt(1).pk)).rejects.toThrow(/genesis key/);
    w.setVault(0n);
    await expect(buildOpenVaultTx(w.conn.asConnection(), payer, w.mint, w.genesis.pk)).rejects.toThrow(/already open/);
    const bad = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.mintCloseAuthority(key("closer"))], open: false });
    await expect(buildOpenVaultTx(bad.conn.asConnection(), payer, bad.mint, bad.genesis.pk)).rejects.toThrow(/refuse this mint: MintCloseAuthority/);
  });

  it("deposit: into the vault's token account; wSOL by a SOL transfer + SyncNative into that account", async () => {
    const w = vaultWorld();
    const owner = key("dep/owner");
    const tx = await buildDepositTx(w.conn.asConnection(), owner, w.mint, w.vault, 77n);
    expect(tx.instructions.length).toBe(1);
    const transfer = tx.instructions[0]!;
    expect(transfer.programId.equals(SPL)).toBe(true);
    expect(transfer.keys[0]!.pubkey.equals(associatedTokenAddress(owner, w.mint, SPL))).toBe(true);
    expect(transfer.keys[2]!.pubkey.equals(w.tokenAccount)).toBe(true);
    // The vault PDA itself is never a destination.
    expect(tx.instructions.flatMap((i) => i.keys).some((k) => k.pubkey.equals(w.vault))).toBe(false);

    const sol = vaultWorld({ mint: WSOL_MINT });
    const stx = await buildDepositTx(sol.conn.asConnection(), owner, WSOL_MINT, sol.vault, 5n);
    expect(stx.instructions.map((i) => i.programId.toBase58())).toEqual(b58([SystemProgram.programId, SPL]));
    expect(stx.instructions[0]!.keys[1]!.pubkey.equals(sol.tokenAccount)).toBe(true);
    expect(stx.instructions[1]!.keys[0]!.pubkey.equals(sol.tokenAccount)).toBe(true);
    expect(stx.feePayer?.equals(owner)).toBe(true);

    await expect(buildDepositTx(w.conn.asConnection(), owner, w.mint, w.vault, 0n)).rejects.toThrow(/positive/);
    await expect(buildDepositTx(w.conn.asConnection(), owner, key("other-mint"), w.vault, 1n)).rejects.toThrow(/different mint/);
    await expect(buildDepositTx(w.conn.asConnection(), owner, w.mint, key("nope"), 1n)).rejects.toThrow(/does not exist/);
    w.conn.delete(w.tokenAccount);
    await expect(buildDepositTx(w.conn.asConnection(), owner, w.mint, w.vault, 1n)).rejects.toThrow(/token account .* does not exist/);
  });
});

describe("withdraw (v1)", () => {
  const dest = key("wd/dest");

  it("v1 wire bytes: withdraw with the program's account order, payout PDA, config words", async () => {
    const w = vaultWorld();
    w.setVault(3n, 100n);
    w.setBalance(1_000n);
    const args = w.signed(3n, dest, 600n);
    const payer = Keypair.generate();
    const out = await buildWithdrawTx(w.conn.asConnection(), payer, args);
    expect(out.payout.equals(payoutAddress(w.vault, 3n))).toBe(true);
    expect(out.includesRelease).toBe(false);
    expect(out.expectedAmount).toBe(600n);
    const d = decodeV1Transaction(out.tx);
    expect(d.accountKeys[0]!.equals(payer.publicKey)).toBe(true);
    expect(d.header.numRequiredSignatures).toBe(1);
    expect(d.computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.withdraw);
    expect([out.computeUnitLimit, out.priorityFeeLamports, d.priorityFeeLamports]).toEqual([200_000, 0n, null]);
    expect(d.loadedAccountsDataSizeLimit).toBe(4 * 1024 * 1024);
    expect(d.instructions.length).toBe(1);
    const ix = d.instructions[0]!;
    expect(d.accountKeys[ix.programIdIndex]!.equals(PROGRAM_IDS.vault)).toBe(true);
    expect(b58(ix.accounts.map((i) => d.accountKeys[i]!))).toEqual(b58([payer.publicKey, w.mint, w.vault, w.tokenAccount, out.payout, SPL, SystemProgram.programId]));
    // Only the vault and the payout are written (and the fee payer): the token account is read-only.
    const writable = (k: PublicKey): boolean => {
      const i = d.accountKeys.findIndex((x) => x.equals(k));
      const n = d.header.numRequiredSignatures;
      return i < n ? i < n - d.header.numReadonlySigned : i < d.accountKeys.length - d.header.numReadonlyUnsigned;
    };
    expect([writable(w.vault), writable(out.payout), writable(w.tokenAccount), writable(w.mint)]).toEqual([true, true, false, false]);
    expect(ix.data.length).toBe(VAULT.WITHDRAW_IX_DATA_LEN);
    expect(toHex(ix.data)).toBe(
      toHex(idlCodecs().vault.encodeInstruction("withdraw", { args: { signature: args.signature, destinationOwner: dest, maxAmount: 600n, nextKeyId: args.nextKeyId, nextKey: args.nextKey } })),
    );
    expect(out.tx.length).toBeLessThanOrEqual(4096);
    // The reservation is capped by the unreserved balance.
    expect((await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(3n, dest, 5_000n))).expectedAmount).toBe(900n);
  });

  it("refuses before broadcast whatever could not execute", async () => {
    const w = vaultWorld();
    w.setVault(3n);
    const args = w.signed(3n, dest, 600n);
    const payer = Keypair.generate();
    const c = w.conn.asConnection();
    const flipped = Uint8Array.from(args.signature);
    flipped[100] = flipped[100]! ^ 1;
    await expect(buildWithdrawTx(c, payer, { ...args, signature: flipped })).rejects.toThrow(/does not verify/);
    await expect(buildWithdrawTx(c, payer, { ...args, maxAmount: 601n })).rejects.toThrow(/does not verify/);
    await expect(buildWithdrawTx(c, payer, { ...args, destinationOwner: key("someone") })).rejects.toThrow(/does not verify/);
    await expect(buildWithdrawTx(c, payer, { ...args, signature: args.signature.subarray(1) })).rejects.toThrow(/2176 bytes/);
    await expect(buildWithdrawTx(c, payer, { ...args, nextKeyId: new Uint8Array(32) })).rejects.toThrow(/non-zero/);
    await expect(buildWithdrawTx(c, payer, { ...args, nextKey: w.keyAt(9).pk })).rejects.toThrow(/KeyIdMismatch/);
    const current = w.keyAt(3);
    // Key-index binding: the next key must be the key of position sequence + 1 (the current key, position 3, fails it too).
    await expect(buildWithdrawTx(c, payer, { ...args, nextKey: current.pk, nextKeyId: current.keyId })).rejects.toThrow(/index q = 3, .*index 4 \(InvalidKeyIndex\)/);
    await expect(buildWithdrawTx(c, payer, { ...args, nextKey: w.keyAt(5).pk, nextKeyId: w.keyAt(5).keyId })).rejects.toThrow(/InvalidKeyIndex/);
    const fake = { ...w.keyAt(4).pk, q: 3 };
    await expect(buildWithdrawTx(c, payer, { ...args, nextKey: fake, nextKeyId: lmots.keyId(fake) })).rejects.toThrow(/InvalidKeyIndex/);
    // A next key at the right position that equals the vault's current key id cannot happen with real keys; the id check still holds.
    w.conn.set(w.vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(w.mint, w.genesis, w.keyAt(4), 3n) });
    await expect(buildWithdrawTx(c, payer, args)).rejects.toThrow(/InvalidNextKey/);
    w.setVault(3n);
    w.setVault(4n);
    await expect(buildWithdrawTx(c, payer, args)).rejects.toThrow(/already executed/);
    w.setVault(2n);
    await expect(buildWithdrawTx(c, payer, args)).rejects.toThrow(/cannot execute/);
    w.conn.delete(w.vault);
    await expect(buildWithdrawTx(c, payer, args)).rejects.toThrow(/does not exist/);
  });

  it("InvalidKeyIndex (6006, appended by the key-index binding) is explained from the vault IDL", () => {
    expect(explainProgramError(PROGRAM_IDS.vault.toBase58(), 6006)).toEqual({
      program: "noised_vault",
      name: "InvalidKeyIndex",
      message: "Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key",
    });
    // The earlier codes did not move.
    expect(explainProgramError(PROGRAM_IDS.vault.toBase58(), 6005)?.name).toBe("MathOverflow");
  });

  it("withdraw + release in one v1 transaction: memo program, rent back to the fee payer, the recipient's canonical ATA", async () => {
    const w = vaultWorld();
    w.setVault(0n);
    w.setBalance(50n);
    const payer = Keypair.generate();
    const out = await buildWithdrawTx(w.conn.asConnection(), payer, { ...w.signed(0n, dest, 10n), includeRelease: true });
    expect(out.includesRelease).toBe(true);
    const d = decodeV1Transaction(out.tx);
    expect(d.instructions.length).toBe(2);
    const release = d.instructions[1]!;
    expect(toHex(release.data)).toBe(toHex(Uint8Array.from(idlCodecs().vault.instruction("release").discriminator)));
    expect(b58(release.accounts.map((i) => d.accountKeys[i]!))).toEqual(
      b58([
        payer.publicKey,
        w.mint,
        w.vault,
        w.tokenAccount,
        out.payout,
        payer.publicKey,
        dest,
        associatedTokenAddress(dest, w.mint, SPL),
        KNOWN_ACCOUNTS.memo,
        SPL,
        KNOWN_ACCOUNTS.associatedToken,
        SystemProgram.programId,
      ]),
    );
    expect(out.tx.length).toBeLessThanOrEqual(4096);
  });

  it("a Launch Guard mint: release carries the four hook accounts (resolver order)", async () => {
    const w = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)] });
    w.setVault(0n);
    const payer = Keypair.generate();
    const out = await buildWithdrawTx(w.conn.asConnection(), payer, { ...w.signed(0n, dest, 10n), includeRelease: true });
    const d = decodeV1Transaction(out.tx);
    const release = d.instructions[1]!;
    expect(b58(release.accounts.slice(12).map((i) => d.accountKeys[i]!))).toEqual(
      b58([hookPolicyAddress(w.mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook, extraAccountMetaListAddress(w.mint)]),
    );
    expect(out.tx.length).toBeLessThanOrEqual(4096);
  });

  it("buildWithdrawTxWithFallback: the same signature without release when the release fails in simulation", async () => {
    const w = vaultWorld();
    w.setVault(0n);
    const payer = Keypair.generate();
    const args = w.signed(0n, dest, 10n);
    let mode: "release-fails" | "ok" | "withdraw-fails" = "release-fails";
    const simulated: number[] = [];
    w.conn.rpc = (method, params) => {
      expect(method).toBe("simulateTransaction");
      const d = decodeV1Transaction(Uint8Array.from(Buffer.from(params[0] as string, "base64")));
      simulated.push(d.instructions.length);
      const fail = (i: number, code: number) => ({
        result: { context: { slot: 1 }, value: { err: { InstructionError: [i, { Custom: code }] }, logs: [`Program ${PROGRAM_IDS.vault.toBase58()} failed: custom program error: 0x${code.toString(16)}`], unitsConsumed: 1 } },
      });
      if (mode === "withdraw-fails") return fail(0, 6001);
      if (mode === "release-fails" && d.instructions.length === 2) return fail(1, 6004);
      return { result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } };
    };
    const opts = { ledger: await held(w, args) };
    const alone = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect(simulated).toEqual([2, 1]);
    expect(alone.includesRelease).toBe(false);
    expect(alone.releaseError).toMatch(/InvalidDestination/);
    expect(alone.simulation.ok).toBe(true);
    const sigIn = (tx: Uint8Array): string => toHex(idlCodecs().vault.decodeType<{ signature: Uint8Array }>("WithdrawArgs", decodeV1Transaction(tx).instructions[0]!.data.subarray(8)).signature);
    expect(sigIn(alone.tx)).toBe(toHex(args.signature));

    mode = "ok";
    const both = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([both.includesRelease, both.releaseError, both.simulation.ok]).toEqual([true, null, true]);
    expect(sigIn(both.tx)).toBe(toHex(args.signature));

    mode = "withdraw-fails";
    const failing = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([failing.includesRelease, failing.simulation.ok, failing.simulation.failedInstruction]).toEqual([true, false, 0]);
    expect(failing.simulation.errorCode?.name).toBe("InvalidSignature");
  });
  it("buildWithdrawTxWithFallback falls back on ANY failure of the release leg, never on one of the withdraw leg", async () => {
    // Audit round 2: only `InstructionError` at index 1 used to fall back.
    const w = vaultWorld({ account: 60 });
    w.setVault(0n);
    const payer = Keypair.generate();
    const args = w.signed(0n, dest, 10n);
    let combinedErr: unknown = null;
    let aloneErr: unknown = null;
    const simulated: number[] = [];
    w.conn.rpc = (_method, params) => {
      const d = decodeV1Transaction(Uint8Array.from(Buffer.from(params[0] as string, "base64")));
      simulated.push(d.instructions.length);
      const err = d.instructions.length === 2 ? combinedErr : aloneErr;
      return { result: { context: { slot: 1 }, value: { err, logs: [], unitsConsumed: 1 } } };
    };
    const opts = { ledger: await held(w, args) };
    // A transaction-level failure of the pair (no instruction index): the withdrawal alone goes.
    combinedErr = { InsufficientFundsForRent: { account_index: 7 } };
    let r = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([r.includesRelease, r.simulation.ok, simulated]).toEqual([false, true, [2, 1]]);
    expect(r.releaseError).toMatch(/fails as a whole/);
    // The release running out of compute units.
    simulated.length = 0;
    combinedErr = { InstructionError: [1, "ComputationalBudgetExceeded"] };
    r = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([r.includesRelease, r.simulation.ok, r.releaseError?.startsWith("the release fails")]).toEqual([false, true, true]);
    // The withdraw leg fails: no fallback, the pair comes back with its failing simulation.
    simulated.length = 0;
    combinedErr = { InstructionError: [0, { Custom: 6006 }] };
    r = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([r.includesRelease, r.releaseError, r.simulation.ok, r.simulation.failedInstruction, simulated]).toEqual([true, null, false, 0, [2]]);
    // The fallback is simulated too: when the withdrawal alone fails as well, it says so (send nothing).
    combinedErr = { InsufficientFundsForRent: { account_index: 0 } };
    aloneErr = { InsufficientFundsForRent: { account_index: 0 } };
    r = await buildWithdrawTxWithFallback(w.conn.asConnection(), payer, args, opts);
    expect([r.includesRelease, r.simulation.ok]).toEqual([false, false]);
    // A withdraw leg that cannot be built throws as before (never "falls back").
    await expect(buildWithdrawTxWithFallback(w.conn.asConnection(), payer, { ...args, maxAmount: 11n }, opts)).rejects.toThrow(/does not verify/);
  });

  it("buildWithdrawTxWithFallback: a release leg that cannot even be built (a hook's account list, over 4,096 bytes) leaves the withdrawal alone", async () => {
    const hookProgram = key("wd/other-hook-program");
    const broken = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(null, hookProgram)], account: 61 });
    broken.setVault(0n);
    broken.conn.set(metaListAddress(broken.mint, hookProgram), { owner: hookProgram, data: Uint8Array.of(1, 2, 3) });
    broken.conn.rpc = () => ({ result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } });
    const payer = Keypair.generate();
    const args = broken.signed(0n, dest, 10n);
    // The release leg alone throws while resolving the hook's accounts.
    await expect(buildWithdrawTx(broken.conn.asConnection(), payer, { ...args, includeRelease: true })).rejects.toThrow();
    let r = await buildWithdrawTxWithFallback(broken.conn.asConnection(), payer, args, { ledger: await held(broken, args) });
    expect([r.includesRelease, r.simulation.ok]).toEqual([false, true]);
    expect(r.releaseError).toMatch(/could not be built/);

    // 40 extra hook accounts: the pair is over 4,096 bytes.
    const wide = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(null, hookProgram)], account: 62 });
    wide.setVault(0n);
    wide.conn.set(metaListAddress(wide.mint, hookProgram), { owner: hookProgram, data: metaListBytes(40) });
    wide.conn.rpc = broken.conn.rpc;
    const wideArgs = wide.signed(0n, dest, 10n);
    r = await buildWithdrawTxWithFallback(wide.conn.asConnection(), payer, wideArgs, { ledger: await held(wide, wideArgs) });
    expect([r.includesRelease, r.simulation.ok]).toEqual([false, true]);
    expect(r.releaseError).toMatch(/could not be built .*v1: transaction would be \d+ bytes/);
  });

  it("compute budget: a tight default limit, an optional priority fee in the config words, and the size at the largest inputs", async () => {
    const payer = Keypair.generate();
    const spl = vaultWorld({ account: 63 });
    spl.setVault(0n);
    const c = spl.conn.asConnection();
    const args = spl.signed(0n, dest, 10n);
    // The measured defaults (withdraw at the worst digest; release creating the recipient's ATA).
    expect(VAULT_COMPUTE_UNITS).toEqual({ withdraw: 200_000, releaseSplToken: 80_000, releaseToken2022: 130_000, releaseOtherHook: 300_000 });
    // Withdraw alone: 200,000 units; a price becomes ceil(price * limit / 1e6) lamports.
    let out = await buildWithdrawTx(c, payer, args, { computeUnitPrice: 5_000n });
    let d = decodeV1Transaction(out.tx);
    expect([d.computeUnitLimit, d.priorityFeeLamports, out.computeUnitLimit, out.priorityFeeLamports]).toEqual([200_000, 1_000n, 200_000, 1_000n]);
    out = await buildWithdrawTx(c, payer, args, { computeUnitPrice: 5_000n, computeUnitLimit: 123_456 });
    d = decodeV1Transaction(out.tx);
    expect([d.computeUnitLimit, d.priorityFeeLamports]).toEqual([123_456, 618n]);
    // The release adds its own share: SPL Token, Token-2022 or the Launch Guard, any other hook.
    expect((await buildWithdrawTx(c, payer, { ...args, includeRelease: true })).computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.withdraw + VAULT_COMPUTE_UNITS.releaseSplToken);
    const guard = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)], account: 64 });
    guard.setVault(0n);
    const largest = await buildWithdrawTx(guard.conn.asConnection(), payer, { ...guard.signed(0n, dest, 2n ** 64n - 1n), includeRelease: true }, { computeUnitPrice: 2n ** 40n });
    expect(largest.computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.withdraw + VAULT_COMPUTE_UNITS.releaseToken2022);
    // The largest withdrawal (Token-2022, four Launch Guard accounts, release, both limits and a priority fee):
    // the 2,977 bytes measured in LiteSVM plus the 8-byte priority-fee word.
    expect(largest.tx.length).toBe(2_985);
    expect(decodeV1Transaction(largest.tx).priorityFeeLamports).toBe((2n ** 40n * 330_000n + 999_999n) / 1_000_000n);
    const other = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(null, key("wd/hook-x"))], account: 65 });
    other.setVault(0n);
    expect((await buildWithdrawTx(other.conn.asConnection(), payer, { ...other.signed(0n, dest, 1n), includeRelease: true })).computeUnitLimit).toBe(VAULT_COMPUTE_UNITS.withdraw + VAULT_COMPUTE_UNITS.releaseOtherHook);
    // Bad options are refused before anything is read.
    for (const bad of [{ computeUnitLimit: 0 }, { computeUnitLimit: 1_400_001 }, { computeUnitLimit: 1.5 }, { computeUnitPrice: -1n }, { computeUnitPrice: 2n ** 64n }]) {
      await expect(buildWithdrawTx(c, payer, args, bad)).rejects.toThrow(RangeError);
    }
  });
});

describe("release / release_to", () => {
  const dest = key("rel/dest");
  const rentPayer = key("rel/rent-payer");

  it("release: pays the canonical ATA, creating it if missing; refuses missing, released and blocked payouts", async () => {
    const w = vaultWorld();
    w.setVault(4n, 500n);
    w.setBalance(800n);
    const payout = w.setPayout(3n, dest, 500n, rentPayer);
    const payer = key("rel/payer");
    const tx = await buildReleaseTx(w.conn.asConnection(), payer, { vault: w.vault, mint: w.mint, sequence: 3n });
    expect(tx.instructions[0]!.programId.equals(KNOWN_ACCOUNTS.computeBudget)).toBe(true);
    const ix = tx.instructions.at(-1)!;
    expect(b58(ix.keys.map((k) => k.pubkey))).toEqual(
      b58([payer, w.mint, w.vault, w.tokenAccount, payout, rentPayer, dest, associatedTokenAddress(dest, w.mint, SPL), KNOWN_ACCOUNTS.memo, SPL, KNOWN_ACCOUNTS.associatedToken, SystemProgram.programId]),
    );
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],
      [false, false],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(tx.feePayer?.equals(payer)).toBe(true);

    await expect(buildReleaseTx(w.conn.asConnection(), payer, { vault: w.vault, mint: w.mint, sequence: 4n })).rejects.toThrow(/broadcast the withdrawal first/);
    await expect(buildReleaseTx(w.conn.asConnection(), payer, { vault: w.vault, mint: w.mint, sequence: 2n })).rejects.toThrow(/already been released/);
    // A frozen canonical account: the recipient must use release_to.
    w.conn.set(associatedTokenAddress(dest, w.mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: dest, amount: 0n, state: 2 }) });
    await expect(buildReleaseTx(w.conn.asConnection(), payer, { vault: w.vault, mint: w.mint, sequence: 3n })).rejects.toThrow(/frozen.*release_to/);
    // A zero payout moves nothing: the destination is not checked.
    w.setPayout(3n, dest, 0n, rentPayer);
    expect((await buildReleaseTx(w.conn.asConnection(), payer, { vault: w.vault, mint: w.mint, sequence: 3n })).instructions.length).toBe(2);
  });

  it("release of a Launch Guard mint carries the hook accounts", async () => {
    const w = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)] });
    w.setVault(1n, 5n);
    w.setPayout(0n, dest, 5n, rentPayer);
    const tx = await buildReleaseTx(w.conn.asConnection(), key("rel/payer"), { vault: w.vault, mint: w.mint, sequence: 0n });
    expect(b58(tx.instructions.at(-1)!.keys.slice(12).map((k) => k.pubkey))).toEqual(
      b58([hookPolicyAddress(w.mint), KNOWN_ACCOUNTS.sysvarInstructions, PROGRAM_IDS.hook, extraAccountMetaListAddress(w.mint)]),
    );
  });

  it("release_to: signed by the recipient, to any token account of the mint", async () => {
    const w = vaultWorld();
    w.setVault(2n, 40n);
    const payout = w.setPayout(1n, dest, 40n, rentPayer);
    const other = key("rel/other-account");
    w.conn.set(other, { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: key("rel/anyone"), amount: 0n }) });
    const tx = await buildReleaseToTx(w.conn.asConnection(), dest, { vault: w.vault, mint: w.mint, sequence: 1n, destination: other });
    const ix = tx.instructions.at(-1)!;
    expect(b58(ix.keys.map((k) => k.pubkey))).toEqual(b58([dest, w.mint, w.vault, w.tokenAccount, payout, rentPayer, other, KNOWN_ACCOUNTS.memo, SPL]));
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(tx.feePayer?.equals(dest)).toBe(true);
    expect(toHex(ix.data)).toBe(toHex(Uint8Array.from(idlCodecs().vault.instruction("release_to").discriminator)));

    const args = { vault: w.vault, mint: w.mint, sequence: 1n, destination: other };
    await expect(buildReleaseToTx(w.conn.asConnection(), key("rel/intruder"), args)).rejects.toThrow(/only the payout's recipient/);
    await expect(buildReleaseToTx(w.conn.asConnection(), dest, { ...args, destination: key("rel/missing") })).rejects.toThrow(/does not exist/);
    w.conn.set(other, { owner: SPL, data: tokenAccountBytes({ mint: key("rel/other-mint"), owner: dest, amount: 0n }) });
    await expect(buildReleaseToTx(w.conn.asConnection(), dest, args)).rejects.toThrow(/another mint/);
    w.conn.set(other, { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: dest, amount: 0n, state: 2 }) });
    await expect(buildReleaseToTx(w.conn.asConnection(), dest, args)).rejects.toThrow(/frozen/);
  });
  it("release_to while the Launch Guard is on: a destination whose owner can be reassigned is refused (audit round 3 F2, MutableOwner 6010)", async () => {
    const w = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)], account: 69 });
    w.setVault(2n, 40n);
    w.setPayout(1n, dest, 40n, rentPayer);
    const guardEnd = 1_800_000_000n;
    const setClock = (t: bigint): void => {
      w.conn.set(SYSVAR_CLOCK_PUBKEY, { owner: new PublicKey("Sysvar1111111111111111111111111111111111111"), data: clock(Number(t)) });
    };
    w.conn.set(hookPolicyAddress(w.mint), {
      owner: PROGRAM_IDS.hook,
      data: accountBytes("hook", "HookPolicy", {
        version: 2,
        bump: 250,
        mint: w.mint,
        pool: key("rel/pool"),
        baseVault: key("rel/base-vault"),
        launchTs: guardEnd - 3_600n,
        snipeShieldEndTs: guardEnd - 3_000n,
        guardEndTs: guardEnd,
        maxWallet: 0n,
        maxBuy: 0n,
        p2pLocked: false,
        exempt: [PublicKey.default, PublicKey.default, PublicKey.default, PublicKey.default], rules: new Uint8Array(0),
      }),
    });
    const other = key("rel/mutable-owner-account");
    const args = { vault: w.vault, mint: w.mint, sequence: 1n, destination: other };
    const c = w.conn.asConnection();
    // A non-ATA account without ImmutableOwner (its owner can be reassigned): refused during the guard, before anything is signed.
    w.conn.set(other, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: dest, amount: 0n, token2022: true }) });
    setClock(guardEnd - 1n);
    await expect(buildReleaseToTx(c, dest, args)).rejects.toThrow(/owner can be reassigned .*MutableOwner 6010/);
    // With ImmutableOwner (any Token-2022 ATA): released.
    w.conn.set(other, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: dest, amount: 0n, token2022: true, extensions: [ext.immutableOwner()] }) });
    await expect(buildReleaseToTx(c, dest, args)).resolves.toBeDefined();
    // Once the guard ended, the hook allows every transfer.
    w.conn.set(other, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: dest, amount: 0n, token2022: true }) });
    setClock(guardEnd);
    await expect(buildReleaseToTx(c, dest, args)).resolves.toBeDefined();
    // A zero payout moves nothing: not refused.
    setClock(guardEnd - 1n);
    w.setPayout(1n, dest, 0n, rentPayer);
    await expect(buildReleaseToTx(c, dest, args)).resolves.toBeDefined();
    // The hook's error has its message even with a hook IDL older than the program.
    expect(explainProgramError(PROGRAM_IDS.hook.toBase58(), 6010)).toEqual({
      program: "noised_hook",
      name: "MutableOwner",
      message: "Launch guard: the receiving token account must have an immutable owner while the guard is on",
    });
    // The guard's end is read only for Noised's hook: a mint whose active hook is another program, or whose hook was revoked, has no Launch Guard.
    const withHook = (program: PublicKey | null) => parseMint(T22, mintBytes({ mintAuthority: null, extensions: [ext.transferHook(null, program)] }));
    expect(await launchGuardEndTs(c, w.mint, withHook(PROGRAM_IDS.hook))).toBe(guardEnd);
    expect(await launchGuardEndTs(c, w.mint, withHook(key("rel/another-hook")))).toBeNull();
    expect(await launchGuardEndTs(c, w.mint, withHook(null))).toBeNull();
    // A policy at this mint's address that names another mint is refused, never read as this mint's guard.
    const policy = idlCodecs().hook.decodeAccount<Record<string, unknown>>("HookPolicy", w.conn.get(hookPolicyAddress(w.mint))!.data);
    w.conn.set(hookPolicyAddress(w.mint), { owner: PROGRAM_IDS.hook, data: accountBytes("hook", "HookPolicy", { ...policy, mint: key("rel/another-mint") }) });
    await expect(launchGuardEndTs(c, w.mint, withHook(PROGRAM_IDS.hook))).rejects.toThrow(/belongs to another mint/);
  });

  it("release and release_to: SetComputeUnitLimit (tight default per mint), SetComputeUnitPrice when asked, within 1,232 bytes at the largest inputs", async () => {
    const legacySize = (tx: Transaction): number => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    const budget = (tx: Transaction): { limit: number | null; price: bigint | null } => {
      let limit: number | null = null;
      let price: bigint | null = null;
      for (const ix of tx.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget))) {
        if (ix.data[0] === 2) limit = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true);
        if (ix.data[0] === 3) price = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
      }
      return { limit, price };
    };
    // SPL Token: 80,000 units by default, no price.
    const spl = vaultWorld({ account: 66 });
    spl.setVault(1n, 5n);
    spl.setPayout(0n, dest, 5n, rentPayer);
    const args = { vault: spl.vault, mint: spl.mint, sequence: 0n };
    let tx = await buildReleaseTx(spl.conn.asConnection(), key("rel/payer"), args);
    expect(budget(tx)).toEqual({ limit: VAULT_COMPUTE_UNITS.releaseSplToken, price: null });
    expect(tx.instructions.length).toBe(2);
    tx = await buildReleaseTx(spl.conn.asConnection(), key("rel/payer"), args, { computeUnitPrice: 7_000n, computeUnitLimit: 61_000 });
    expect(budget(tx)).toEqual({ limit: 61_000, price: 7_000n });
    expect(tx.instructions.map((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget))).toEqual([true, true, false]);
    await expect(buildReleaseTx(spl.conn.asConnection(), key("rel/payer"), args, { computeUnitLimit: 0 })).rejects.toThrow(RangeError);
    await expect(buildReleaseToTx(spl.conn.asConnection(), dest, { ...args, destination: key("x") }, { computeUnitPrice: -5n })).rejects.toThrow(RangeError);

    // The largest: Token-2022 with the Launch Guard's four accounts, both compute-budget instructions, maximal values.
    const guard = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)], account: 67 });
    guard.setVault(5n, 2n ** 64n - 1n);
    guard.setPayout(2n ** 64n - 3n, dest, 2n ** 64n - 1n, rentPayer);
    const big = { vault: guard.vault, mint: guard.mint, sequence: 2n ** 64n - 3n };
    const opts = { computeUnitPrice: 2n ** 64n - 1n, computeUnitLimit: 1_400_000 };
    const release = await buildReleaseTx(guard.conn.asConnection(), key("rel/payer"), big, opts);
    expect(budget(release)).toEqual({ limit: 1_400_000, price: 2n ** 64n - 1n });
    expect(budget(await buildReleaseTx(guard.conn.asConnection(), key("rel/payer"), big))).toEqual({ limit: VAULT_COMPUTE_UNITS.releaseToken2022, price: null });
    expect(legacySize(release)).toBe(725);
    const other = key("rel/other-t22-account");
    guard.conn.set(other, { owner: T22, data: tokenAccountBytes({ mint: guard.mint, owner: dest, amount: 0n, token2022: true }) });
    const releaseTo = await buildReleaseToTx(guard.conn.asConnection(), dest, { ...big, destination: other }, opts);
    expect(budget(releaseTo)).toEqual({ limit: 1_400_000, price: 2n ** 64n - 1n });
    expect(legacySize(releaseTo)).toBe(626);

    // A generic hook with 40 extra accounts cannot fit a legacy transaction: refused, not returned unsendable.
    const hookProgram = key("rel/other-hook-program");
    const wide = vaultWorld({ tokenProgram: T22, mintExtensions: [ext.transferHook(null, hookProgram)], account: 68 });
    wide.setVault(1n, 5n);
    wide.setPayout(0n, dest, 5n, rentPayer);
    wide.conn.set(metaListAddress(wide.mint, hookProgram), { owner: hookProgram, data: metaListBytes(40) });
    const wideArgs = { vault: wide.vault, mint: wide.mint, sequence: 0n };
    await expect(buildReleaseTx(wide.conn.asConnection(), key("rel/payer"), wideArgs)).rejects.toThrow(/over the 1232-byte legacy limit/);
    wide.conn.set(other, { owner: T22, data: tokenAccountBytes({ mint: wide.mint, owner: dest, amount: 0n, token2022: true }) });
    await expect(buildReleaseToTx(wide.conn.asConnection(), dest, { ...wideArgs, destination: other })).rejects.toThrow(/over the 1232-byte legacy limit/);
    // With a few extra accounts it fits, with the wide limit any other hook gets.
    wide.conn.set(metaListAddress(wide.mint, hookProgram), { owner: hookProgram, data: metaListBytes(3) });
    expect(budget(await buildReleaseTx(wide.conn.asConnection(), key("rel/payer"), wideArgs))).toEqual({ limit: VAULT_COMPUTE_UNITS.releaseOtherHook, price: null });
  });
});

describe("vault state, payouts and scanning", () => {
  it("fetchVault, fetchPayout, decoders and listPayouts (getProgramAccounts, then a probe when the RPC refuses it)", async () => {
    const w = vaultWorld();
    w.setVault(3n, 30n);
    w.setBalance(100n);
    w.setPayout(0n, key("p/a"), 10n, key("p/rent"));
    w.setPayout(2n, key("p/b"), 20n, key("p/rent"));
    const v = await fetchVault(w.conn.asConnection(), w.vault);
    expect(v).toMatchObject({ sequence: 3n, reserved: 30n, balance: 100n, available: 70n, version: 4 });
    expect(v!.tokenAccount.equals(w.tokenAccount) && v!.tokenProgram.equals(SPL) && v!.mint.equals(w.mint)).toBe(true);
    expect(bytesEqual(v!.genesisKeyId, w.genesis.keyId) && bytesEqual(v!.keyId, w.keyAt(3).keyId)).toBe(true);
    expect(await fetchVault(w.conn.asConnection(), key("nope"))).toBeNull();
    expect((await fetchPayout(w.conn.asConnection(), w.vault, 2n))?.amount).toBe(20n);
    expect(await fetchPayout(w.conn.asConnection(), w.vault, 1n)).toBeNull();

    const listed = await listPayouts(w.conn.asConnection(), w.vault);
    expect(listed).toMatchObject({ complete: true, method: "getProgramAccounts", note: null });
    expect(listed.payouts.map((p) => p.sequence)).toEqual([0n, 2n]);
    // A payout the listing misses shows up: the amounts no longer add up to `reserved`.
    const hidden = w.conn.get(payoutAddress(w.vault, 2n))!;
    w.conn.delete(payoutAddress(w.vault, 2n));
    const gap = await listPayouts(w.conn.asConnection(), w.vault);
    expect(gap.complete).toBe(false);
    expect(gap.note).toMatch(/add up to 10 but the vault reserves 30/);
    w.conn.set(payoutAddress(w.vault, 2n), hidden);
    w.conn.programAccountsError = new Error("gPA disabled");
    const probed = await listPayouts(w.conn.asConnection(), w.vault);
    expect(probed).toMatchObject({ complete: true, method: "probe" });
    expect(probed.payouts.map((p) => p.sequence)).toEqual([0n, 2n]);
    expect(probed.note).toMatch(/gPA disabled/);
    // Past the probe window the listing says it may be incomplete.
    w.conn.set(w.vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(w.mint, w.genesis, w.keyAt(1_500), 1_500n, 30n) });
    const far = await listPayouts(w.conn.asConnection(), w.vault);
    expect(far.complete).toBe(false);
    expect(far.note).toMatch(/older payouts were not checked/);

    // Decoders refuse accounts that are not at their own PDA.
    const data = w.conn.get(w.vault)!.data;
    expect(() => decodeVault(key("elsewhere"), data)).toThrow(/not the PDA/);
    expect(() => decodePayout(key("elsewhere"), w.conn.get(payoutAddress(w.vault, 0n))!.data)).toThrow(/not the PDA/);
  });

  it("scanVaults: per account number, address, sequence, balances, payouts and whether this phrase holds the key", async () => {
    const mint = key("scan/mint");
    const conn = new MockConnection();
    conn.set(mint, { owner: SPL, data: mintBytes({}) });
    const keyAt = (account: number, s: number): VaultKeyMaterial => deriveVaultKey(master, "localnet", mint, account, s);
    const vaultOf = (account: number): PublicKey => vaultAddress(mint, keyAt(account, 0).keyId);
    // Account 0: opened, two withdrawals, one payout pending.
    conn.set(vaultOf(0), { owner: PROGRAM_IDS.vault, data: vaultBytes(mint, keyAt(0, 0), keyAt(0, 2), 2n, 5n) });
    conn.set(associatedTokenAddress(vaultOf(0), mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint, owner: vaultOf(0), amount: 25n }) });
    conn.set(payoutAddress(vaultOf(0), 1n), { owner: PROGRAM_IDS.vault, data: payoutBytes(vaultOf(0), 1n, key("scan/dest"), 5n, key("scan/rent")) });
    // Account 1: not opened, but someone already sent tokens to its deposit address.
    conn.set(associatedTokenAddress(vaultOf(1), mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint, owner: vaultOf(1), amount: 7n }) });
    // Account 2: opened, but its current key is not this phrase's key at (2, 1).
    const foreign = deriveVaultKey(masterFromPhrase("legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"), "localnet", mint, 2, 1);
    conn.set(vaultOf(2), { owner: PROGRAM_IDS.vault, data: vaultBytes(mint, keyAt(2, 0), foreign, 1n, 0n) });

    const scan = await scanVaults(conn.asConnection(), master, "localnet", mint, 2);
    expect(scan.map((s) => [s.account, s.opened, s.sequence, s.keyMatches, s.balance, s.reserved, s.available, s.pendingPayouts.length, s.payoutsComplete])).toEqual([
      [0, true, 2n, true, 25n, 5n, 20n, 1, true],
      [1, false, 0n, null, 7n, 0n, 7n, 0, true],
      [2, true, 1n, false, 0n, 0n, 0n, 0, true],
    ]);
    expect(scan[0]!.vault.equals(vaultOf(0)) && bytesEqual(scan[0]!.genesisKeyId, keyAt(0, 0).keyId)).toBe(true);
    expect(scan[0]!.pendingPayouts[0]!.sequence).toBe(1n);
    // A payout missing from the listing shows up as an incomplete reservation.
    conn.delete(payoutAddress(vaultOf(0), 1n));
    expect((await scanVaults(conn.asConnection(), master, "localnet", mint, 0))[0]!.payoutsComplete).toBe(false);
    await expect(scanVaults(conn.asConnection(), master, "localnet", mint, 1_001)).rejects.toThrow(/maxAccount/);
  });
});

// ----------------------------------------------------- pending search ---

/** Legacy transaction wire bytes, unsigned (zero signatures), for the mocked history. */
const legacyWire = (tx: Transaction): Uint8Array => Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

/** A legacy transaction carrying `ixs`, for the mocked history. */
function legacyOf(feePayer: PublicKey, blockhash: string, ixs: TransactionInstruction[]): Uint8Array {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return legacyWire(tx);
}

/** Signed v1 wire bytes carrying `ixs` (a withdrawal does not fit a legacy transaction). */
function v1Of(payer: Keypair, blockhash: string, ixs: TransactionInstruction[]): Uint8Array {
  return signV1Message(compileV1Message(payer.publicKey, ixs, blockhash, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 4 * 1024 * 1024 }), [payer]);
}

const getTransactions = (c: MockConnection): number => c.calls.filter((x) => x === "getTransaction").length;
const listCalls = (c: MockConnection): number => c.calls.filter((x) => x === "getSignaturesForAddress").length;

describe("findPendingWithdrawal (never sign twice)", () => {
  const dest = key("pw/dest");

  /** A legacy transaction that names the vault (e.g. someone sending it lamports); `failed` lands it as a failed one. */
  function noise(w: VaultWorld, payer: Keypair, label: string, failed = false): void {
    const wire = legacyOf(payer.publicKey, w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.vault, lamports: 1 })]);
    w.conn.addTransaction(label, wire, [payer.publicKey, w.vault], failed ? { InstructionError: [0, "Custom"] } : null);
  }

  /**
   * open_vault, four unrelated transactions, then a landed withdrawal at sequence 0: the vault is at
   * sequence 1 with key 1. `slots`: every transaction in its own, increasing slot (as on a real cluster).
   */
  async function history(account: number, slots = false): Promise<{ w: VaultWorld; payer: Keypair; tick: () => void }> {
    const w = vaultWorld({ account, open: false });
    const tick = (): void => {
      if (slots) w.conn.slot++;
    };
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(account));
    const open = await buildOpenVaultTx(w.conn.asConnection(), payer.publicKey, w.mint, w.genesis.pk);
    tick();
    w.conn.addTransaction(`open-${account}`, legacyWire(open), [payer.publicKey, w.mint, w.vault, w.tokenAccount]);
    for (let i = 0; i < 4; i++) {
      tick();
      noise(w, payer, `old-noise-${account}-${i}`);
    }
    w.setVault(0n);
    w.setBalance(1_000n);
    const first = await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(0n, dest, 100n));
    tick();
    w.conn.addTransaction(`withdraw-0-${account}`, first.tx, [payer.publicKey, w.vault, first.payout]);
    w.setVault(1n, 100n);
    return { w, payer, tick };
  }

  /** A failed withdrawal attempt at sequence 1 signed by key 1, naming the vault and the current payout PDA. */
  async function failedAttempt(w: VaultWorld, payer: Keypair, label: string, to: PublicKey, max: bigint): Promise<WithdrawTxArgs> {
    const args = w.signed(1n, to, max);
    const attempt = await buildWithdrawTx(w.conn.asConnection(), payer, args);
    w.conn.addTransaction(label, attempt.tx, [payer.publicKey, w.vault, attempt.payout], { InstructionError: [0, { Custom: 1 }] });
    return args;
  }

  it("finds a failed withdrawal of the current sequence and stops at the transaction that installed the current key", async () => {
    const { w, payer } = await history(31);
    const args = await failedAttempt(w, payer, "withdraw-1-failed", dest, 50n);
    noise(w, payer, "noise");

    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect(r).toMatchObject({ complete: true, incompleteReason: null, continuation: null, note: null });
    expect(r.all.length).toBe(1);
    const p = r.pending!;
    expect([p.txSignature, p.failed, p.sequence, p.maxAmount]).toEqual(["withdraw-1-failed", true, 1n, 50n]);
    expect(p.destinationOwner.equals(dest) && p.mint.equals(w.mint) && p.vault.equals(w.vault)).toBe(true);
    expect(toHex(p.signature)).toBe(toHex(args.signature));
    expect(toHex(p.nextKeyId)).toBe(toHex(args.nextKeyId));
    expect(toHex(p.nextKey!.k)).toBe(toHex(args.nextKey.k));
    expect(p.executable).toBe(true);
    expect(toHex(p.message)).toBe(toHex(withdrawMessage(w.vault, w.mint, 1n, dest, 50n, args.nextKeyId)));
    // Read: the failed attempt, then the installing withdrawal (it also names the previous payout PDA).
    // The noise, the older transactions and open_vault were listed, never read.
    expect(getTransactions(w.conn)).toBe(2);
    expect(r.examined).toBe(2);
    // Re-broadcast: the stored signature rebuilds into a valid transaction.
    expect((await buildWithdrawTx(w.conn.asConnection(), Keypair.generate(), { ...args, signature: p.signature })).payout.equals(payoutAddress(w.vault, 1n))).toBe(true);
  });

  it("nothing pending: complete once the installing transaction is reached; signatures of earlier keys do not count", async () => {
    const { w } = await history(32);
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.pending, r.all.length, r.complete, r.incompleteReason]).toEqual([null, 0, true, null]);
    // At sequence 0 the boundary is open_vault: found among the oldest transactions once the history ends.
    const fresh = vaultWorld({ account: 33, open: false });
    const open = await buildOpenVaultTx(fresh.conn.asConnection(), key("pw/payer"), fresh.mint, fresh.genesis.pk);
    fresh.conn.addTransaction("open", legacyWire(open), [key("pw/payer"), fresh.vault]);
    fresh.setVault(0n);
    expect((await findPendingWithdrawal(fresh.conn.asConnection(), fresh.vault)).complete).toBe(true);
  });

  it("transactions that only name the current payout PDA are never read: 1,000 of them cannot hide a revealed signature", async () => {
    // Review L1: the payout PDA ["payout", vault, u64le(sequence)] is predictable and anyone can spam it.
    const { w, payer, tick } = await history(47, true);
    tick();
    await failedAttempt(w, payer, "withdraw-1-failed", key("pw/victim"), 50n);
    const spammer = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const target = payoutAddress(w.vault, 1n);
    for (let i = 0; i < 1_000; i++) {
      tick();
      const wire = legacyOf(spammer.publicKey, w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: target, lamports: i })]);
      w.conn.addTransaction(`junk-${i}`, wire, [spammer.publicKey, target]);
    }
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.pending?.txSignature, r.complete, r.incompleteReason, r.examined]).toEqual(["withdraw-1-failed", true, null, 2]);
    expect(getTransactions(w.conn)).toBe(2);
    // The same with every transaction in one slot: the payout PDA's list is paged to its end, still nothing of it is read.
    const flat = await history(48);
    await failedAttempt(flat.w, flat.payer, "withdraw-1-failed", key("pw/victim"), 50n);
    const flatTarget = payoutAddress(flat.w.vault, 1n);
    for (let i = 0; i < 1_000; i++) {
      const wire = legacyOf(spammer.publicKey, flat.w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: flatTarget, lamports: i })]);
      flat.w.conn.addTransaction(`junk-${i}`, wire, [spammer.publicKey, flatTarget]);
    }
    const f = await findPendingWithdrawal(flat.w.conn.asConnection(), flat.w.vault);
    expect([f.pending?.txSignature, f.complete, getTransactions(flat.w.conn)]).toEqual(["withdraw-1-failed", true, 2]);
    // So a new request re-broadcasts the revealed one instead of signing a second message with key 1.
    const p = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 47, { destinationOwner: key("pw/new-recipient"), maxAmount: 60n }, LOCAL);
    expect([p.signed, p.pending?.txSignature]).toEqual([null, "withdraw-1-failed"]);
  });

  it("every failed transaction naming the vault is read: a signature passed with another payout account, or to another program, is found", async () => {
    const { w, payer } = await history(49);
    const args = w.signed(1n, dest, 70n);
    const data = idlCodecs().vault.encodeInstruction("withdraw", {
      args: { signature: args.signature, destinationOwner: dest, maxAmount: 70n, nextKeyId: args.nextKeyId, nextKey: args.nextKey },
    });
    const wrongPayout = payoutAddress(w.vault, 7n);
    const accounts = [payer.publicKey, w.mint, w.vault, w.tokenAccount, wrongPayout, SPL, SystemProgram.programId].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i === 0 || i === 2 || i === 4 }));
    // Another payout account: the transaction never names the current payout PDA.
    w.conn.addTransaction("wrong-payout", v1Of(payer, w.conn.blockhash, [new TransactionInstruction({ programId: PROGRAM_IDS.vault, keys: accounts, data: Buffer.from(data) })]), [payer.publicKey, w.vault, wrongPayout], {
      InstructionError: [0, { Custom: 2006 }],
    });
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.pending?.txSignature, r.pending?.maxAmount, r.complete]).toEqual(["wrong-payout", 70n, true]);

    // The same bytes sent to another program.
    const { w: o, payer: op } = await history(50);
    const other = o.signed(1n, dest, 71n);
    const otherData = idlCodecs().vault.encodeInstruction("withdraw", {
      args: { signature: other.signature, destinationOwner: dest, maxAmount: 71n, nextKeyId: other.nextKeyId, nextKey: other.nextKey },
    });
    o.conn.addTransaction("other-program", v1Of(op, o.conn.blockhash, [new TransactionInstruction({ programId: KNOWN_ACCOUNTS.memo, keys: [{ pubkey: o.vault, isSigner: false, isWritable: false }], data: Buffer.from(otherData) })]), [op.publicKey, o.vault], {
      InstructionError: [0, "InvalidInstructionData"],
    });
    r = await findPendingWithdrawal(o.conn.asConnection(), o.vault);
    expect([r.pending?.txSignature, r.pending?.maxAmount, r.complete]).toEqual(["other-program", 71n, true]);
  });

  it("incomplete when the history ends early or a transaction cannot be read; a continuation retries unreadable ones", async () => {
    const w = vaultWorld({ account: 34 });
    w.setVault(1n);
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.pending, r.complete, r.incompleteReason, r.continuation]).toEqual([null, false, "history", null]);
    expect(r.note).toMatch(/history ends before/);

    const { w: h } = await history(35);
    const lost = h.conn.transactions.get("withdraw-0-35")!;
    h.conn.transactions.set("withdraw-0-35", null);
    r = await findPendingWithdrawal(h.conn.asConnection(), h.vault);
    expect([r.complete, r.incompleteReason]).toEqual([false, "unreadable"]);
    expect(r.note).toMatch(/could not decode 1 transaction/);
    expect(r.continuation).not.toBeNull();
    // The RPC returns it again: continuing reads it and nothing else is left.
    h.conn.transactions.set("withdraw-0-35", lost);
    const examined = r.examined;
    r = await findPendingWithdrawal(h.conn.asConnection(), h.vault, { continueFrom: r.continuation });
    expect([r.complete, r.incompleteReason, r.continuation, r.note, r.examined]).toEqual([true, null, null, null, examined + 1]);

    // Bytes that do not decode count the same way.
    const { w: g } = await history(30);
    const raw = g.conn.transactions.get("withdraw-0-30")!;
    g.conn.transactions.set("withdraw-0-30", { ...raw, transaction: [Buffer.from(Uint8Array.of(0x81, 1, 2)).toString("base64"), "base64"] });
    r = await findPendingWithdrawal(g.conn.asConnection(), g.vault);
    expect([r.complete, r.pending, r.incompleteReason]).toEqual([false, null, "unreadable"]);
    await expect(findPendingWithdrawal(g.conn.asConnection(), key("pw/none"))).rejects.toThrow(/does not exist/);
  });

  it("one call reads at most maxTransactions; the search continues where it stopped", async () => {
    const { w, payer } = await history(36);
    noise(w, payer, "failed-noise-1", true);
    noise(w, payer, "failed-noise-2", true);
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 1 });
    expect([r.complete, r.incompleteReason, r.examined]).toEqual([false, "limit", 1]);
    expect(r.note).toMatch(/maxTransactions/);
    expect(r.continuation).toEqual({ vault: w.vault, sequence: 1n, examined: 1 });
    expect(Object.isFrozen(r.continuation)).toBe(true);
    // Each call reads one more: failed-noise-1, then the installing withdrawal.
    const first = r.continuation;
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 1, continueFrom: first });
    expect([r.complete, r.incompleteReason, r.examined]).toEqual([false, "limit", 2]);
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 1, continueFrom: r.continuation });
    expect([r.complete, r.incompleteReason, r.continuation, r.examined]).toEqual([true, null, null, 3]);
    // A continuation can be used again: it restarts from where it was made.
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: first });
    expect([r.complete, r.examined]).toEqual([true, 3]);
    await expect(findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 0 })).rejects.toThrow(/maxTransactions/);
    await expect(findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxSignaturePages: 1 })).rejects.toThrow(/maxSignaturePages/);
  });

  it("a continued search first reads what landed since it stopped", async () => {
    const { w, payer } = await history(46);
    for (let i = 0; i < 3; i++) noise(w, payer, `failed-noise-${i}`, true);
    const stopped = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 1 });
    expect(stopped.incompleteReason).toBe("limit");
    // Meanwhile another device's attempt lands (and fails): it is newer than everything the first call listed.
    await failedAttempt(w, payer, "newer-attempt", key("pw/other-device"), 5n);
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: stopped.continuation });
    expect([r.complete, r.pending?.txSignature, r.all.length]).toEqual([true, "newer-attempt", 1]);
  });

  it("one call reads at most maxSignaturePages pages; continuing pages on", async () => {
    // 1,200 transactions name only the current payout PDA, newer than the vault's own history.
    const { w, payer, tick } = await history(51, true);
    const target = payoutAddress(w.vault, 1n);
    for (let i = 0; i < 1_200; i++) {
      tick();
      const wire = legacyOf(payer.publicKey, w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: target, lamports: i })]);
      w.conn.addTransaction(`junk-${i}`, wire, [payer.publicKey, target]);
    }
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxSignaturePages: 2 });
    expect([r.complete, r.incompleteReason]).toEqual([false, "limit"]);
    let calls = 1;
    while (!r.complete) {
      expect(r.continuation).not.toBeNull();
      const before = listCalls(w.conn);
      r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxSignaturePages: 2, continueFrom: r.continuation });
      expect(listCalls(w.conn) - before).toBeLessThanOrEqual(2);
      expect(++calls).toBeLessThan(10);
    }
    expect([r.pending, r.complete, r.examined, getTransactions(w.conn)]).toEqual([null, true, 1, 1]);
  });

  it("a continuation is opaque, belongs to one vault, and is set aside once the vault moved", async () => {
    const { w, payer } = await history(52);
    noise(w, payer, "failed-noise", true);
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 1 });
    const forged = { vault: w.vault, sequence: 1n, examined: 1 };
    await expect(findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: forged })).rejects.toThrow(/not a continuation/);
    const { w: other } = await history(53);
    await expect(findPendingWithdrawal(other.conn.asConnection(), other.vault, { continueFrom: r.continuation })).rejects.toThrow(/search of vault/);
    // The vault moved on (a withdrawal executed elsewhere): the search starts over for the new key.
    w.setVault(2n, 100n);
    const before = getTransactions(w.conn);
    const moved = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: r.continuation });
    expect(moved.vault.sequence).toBe(2n);
    expect(moved.examined).toBe(getTransactions(w.conn) - before);
  });

  it("the installing transaction must be known to have succeeded and to name the current key; an RPC that ignores `before` cannot loop the search", async () => {
    const { w } = await history(38);
    expect((await findPendingWithdrawal(w.conn.asConnection(), w.vault)).examined).toBe(1);
    // Without a status for the installing withdrawal, the search goes back to open_vault.
    const raw = w.conn.transactions.get("withdraw-0-38")!;
    w.conn.transactions.set("withdraw-0-38", { ...raw, meta: null as unknown as { err: unknown } });
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.examined]).toEqual([true, 2]);
    // Same when the signature list reports it failed.
    w.conn.transactions.set("withdraw-0-38", raw);
    const listed = w.conn.history.get(w.vault.toBase58())!.find((h) => h.signature === "withdraw-0-38")!;
    listed.err = { InstructionError: [0, "X"] };
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.examined]).toEqual([true, 2]);
    listed.err = null;
    // A withdrawal of sequence 0 that did not name the vault's current key did not install it.
    w.conn.set(w.vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(w.mint, w.genesis, deriveVaultKey(master, "localnet", w.mint, 99, 1), 1n, 100n) });
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.examined]).toEqual([true, 2]);

    const loop = vaultWorld({ account: 39 });
    loop.setVault(1n);
    noise(loop, Keypair.fromSeed(new Uint8Array(32).fill(39)), "n1");
    noise(loop, Keypair.fromSeed(new Uint8Array(32).fill(39)), "n2");
    const list = loop.conn.getSignaturesForAddress.bind(loop.conn);
    loop.conn.getSignaturesForAddress = async (address, opts) => list(address, { limit: opts?.limit ?? 1_000 });
    r = await findPendingWithdrawal(loop.conn.asConnection(), loop.vault);
    expect([r.complete, r.examined, r.pending, r.incompleteReason, r.continuation]).toEqual([false, 2, null, "history", null]);
    expect(r.note).toMatch(/repeated a page/);
  });

  it("v0 transactions: accounts loaded from lookup tables are resolved", async () => {
    const w = vaultWorld({ account: 54, open: false });
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(54));
    const open = (await buildOpenVaultTx(w.conn.asConnection(), payer.publicKey, w.mint, w.genesis.pk)).instructions[0]!;
    const table = new AddressLookupTableAccount({
      key: key("pw/lookup-table"),
      state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [w.vault, w.tokenAccount] },
    });
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: w.conn.blockhash, instructions: [open] }).compileToV0Message([table]);
    expect(message.addressTableLookups.length).toBe(1);
    w.conn.addTransaction("open-v0", new VersionedTransaction(message).serialize(), [payer.publicKey, w.vault]);
    w.setVault(0n);
    // Without the loaded addresses the vault account of open_vault is unknown: not the boundary.
    let r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.incompleteReason]).toEqual([false, "history"]);
    const lookup = message.addressTableLookups[0]!;
    const loadedAddresses = {
      writable: lookup.writableIndexes.map((i) => table.state.addresses[i]!.toBase58()),
      readonly: lookup.readonlyIndexes.map((i) => table.state.addresses[i]!.toBase58()),
    };
    expect(loadedAddresses.writable).toContain(w.vault.toBase58());
    const raw = w.conn.transactions.get("open-v0")!;
    w.conn.transactions.set("open-v0", { ...raw, meta: { err: null, loadedAddresses } });
    r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.incompleteReason]).toEqual([true, null]);
  });

  it("a key that signed two different messages: both are reported, newest first", async () => {
    const { w, payer } = await history(37);
    const a = await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(1n, dest, 50n));
    w.conn.addTransaction("first", a.tx, [w.vault, a.payout], { InstructionError: [0, { Custom: 1 }] });
    const b = await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(1n, key("pw/other"), 60n));
    w.conn.addTransaction("second", b.tx, [w.vault, b.payout], { InstructionError: [0, { Custom: 1 }] });
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect(r.all.map((p) => p.txSignature)).toEqual(["second", "first"]);
    expect(r.pending?.maxAmount).toBe(60n);
  });
  /** A failed v1 transaction carrying `withdraw` with these exact fields (no SDK guard), naming the vault and the current payout PDA. */
  function rawAttempt(w: VaultWorld, payer: Keypair, label: string, f: { signature: Uint8Array; destinationOwner: PublicKey; maxAmount: bigint; nextKeyId: Uint8Array; nextKey: lmots.LmotsPublicKey }): void {
    const payout = payoutAddress(w.vault, 1n);
    const data = idlCodecs().vault.encodeInstruction("withdraw", { args: f });
    const accounts = [payer.publicKey, w.mint, w.vault, w.tokenAccount, payout, SPL, SystemProgram.programId].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i === 0 || i === 2 || i === 4 }));
    w.conn.addTransaction(label, v1Of(payer, w.conn.blockhash, [new TransactionInstruction({ programId: PROGRAM_IDS.vault, keys: accounts, data: Buffer.from(data) })]), [payer.publicKey, w.vault, payout], {
      InstructionError: [0, { Custom: 6000 }],
    });
  }

  it("a revealed signature copied next to a junk next key never becomes pending and never hides the genuine one", async () => {
    // Audit round 2: one cheap failed transaction used to make a revealed withdrawal impossible to re-broadcast.
    const { w, payer } = await history(70);
    const genuine = await failedAttempt(w, payer, "genuine", dest, 50n);
    const attacker = Keypair.fromSeed(new Uint8Array(32).fill(170));
    rawAttempt(w, attacker, "junk-copy", { ...genuine, nextKey: w.keyAt(9).pk });
    // Spam that does not even verify is ignored entirely.
    rawAttempt(w, attacker, "forged", { ...genuine, signature: Uint8Array.from(genuine.signature).fill(7, 40, 80) });
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.all.length, r.pending?.txSignature, r.pending?.executable]).toEqual([true, 1, "genuine", true]);
    expect(toHex(lmots.keyId(r.pending!.nextKey!))).toBe(toHex(genuine.nextKeyId));
    // ...and it rebuilds into a valid transaction.
    const p = r.pending!;
    await expect(buildWithdrawTx(w.conn.asConnection(), Keypair.generate(), { ...p, nextKey: p.nextKey! })).resolves.toMatchObject({ includesRelease: false });

    // Only the junk-keyed copy landed (the genuine attempt was dropped): the signature is revealed all the
    // same. It is not pending (it cannot be re-broadcast as found), but it blocks a second signature, and
    // prepareWithdrawal completes it with the phrase's next key.
    const { w: o, payer: op } = await history(71);
    const dropped = o.signed(1n, dest, 40n);
    rawAttempt(o, Keypair.fromSeed(new Uint8Array(32).fill(171)), "junk-only", { ...dropped, nextKey: o.keyAt(5).pk });
    const only = await findPendingWithdrawal(o.conn.asConnection(), o.vault);
    expect([only.complete, only.pending, only.all.length, only.all[0]?.nextKey, only.all[0]?.executable]).toEqual([true, null, 1, null, false]);
    const prepared = await prepareWithdrawal(o.conn.asConnection(), master, "localnet", o.mint, 71, { destinationOwner: key("pw/someone-new"), maxAmount: 1n }, LOCAL);
    expect([prepared.signed, prepared.pending?.txSignature, prepared.pending?.maxAmount, prepared.pending?.executable]).toEqual([null, "junk-only", 40n, true]);
    expect(toHex(lmots.keyId(prepared.pending!.nextKey!))).toBe(toHex(o.keyAt(2).keyId));
    const rebuilt = await buildWithdrawTx(o.conn.asConnection(), op, { ...prepared.pending!, nextKey: prepared.pending!.nextKey! });
    expect(rebuilt.payout.equals(payoutAddress(o.vault, 1n))).toBe(true);
  });

  it("a signature of the current key naming a next key of another index is reported, never pending: the key must not sign again", async () => {
    const { w, payer } = await history(72);
    // Signed without the SDK's guards: key 1 names key 3 (the program wants q = 2).
    const skipped = w.keyAt(3);
    const msg = withdrawMessage(w.vault, w.mint, 1n, dest, 30n, skipped.keyId);
    rawAttempt(w, payer, "wrong-index", { signature: lmots.signDeterministic(skOf(w.keyAt(1)), msg), destinationOwner: dest, maxAmount: 30n, nextKeyId: skipped.keyId, nextKey: skipped.pk });
    const r = await findPendingWithdrawal(w.conn.asConnection(), w.vault);
    expect([r.complete, r.pending, r.all.length, r.all[0]?.executable, r.all[0]?.nextKey?.q]).toEqual([true, null, 1, false, 3]);
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 72, { destinationOwner: key("pw/x"), maxAmount: 1n }, LOCAL)).rejects.toThrow(
      /already signed a withdrawal that cannot execute .*wrong-index.*second one-time signature/,
    );
  });

  it("failed spam that only names the vault (base fee each) is read last: a genuine attempt at this sequence is found first, the spam still in the end (review finding)", async () => {
    const { w, payer } = await history(73);
    await failedAttempt(w, payer, "genuine-73", dest, 50n);
    // Newer than the genuine attempt: 1,200 failing transactions that merely list the vault.
    const spammer = Keypair.fromSeed(new Uint8Array(32).fill(173));
    for (let i = 0; i < 1_200; i++) {
      const wire = legacyOf(spammer.publicKey, w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: w.vault, lamports: i + 1 })]);
      w.conn.addTransaction(`spam-73-${i}`, wire, [spammer.publicKey, w.vault], { InstructionError: [0, { Custom: 1 }] });
    }
    // A small budget is enough to find the genuine attempt (it names the payout PDA): the spam waits.
    const first = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 10 });
    expect([first.pending?.txSignature, first.complete, first.incompleteReason]).toEqual(["genuine-73", false, "limit"]);
    expect(first.note).toMatch(/or failed transactions that name the vault but not that account: anyone can land those for the base fee, and they are read last; a failed attempt at this sequence names the payout account and is read first\./);
    // So prepareWithdrawal re-broadcasts it at once (no 1,200 reads, no continuation), signing nothing.
    const before = getTransactions(w.conn);
    const p = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 73, { destinationOwner: key("pw/spam-new"), maxAmount: 1n }, { ...LOCAL, ledger: createMemoryVaultKeyLedger() });
    expect([p.signed, p.pending?.txSignature]).toEqual([null, "genuine-73"]);
    expect(getTransactions(w.conn) - before).toBeLessThan(20);
    // The deferred spam is still read before the search calls itself complete.
    let search = first;
    for (let calls = 0; !search.complete; calls++) {
      expect(calls).toBeLessThan(5);
      search = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: search.continuation });
    }
    expect(search.examined).toBeGreaterThanOrEqual(1_200);
    expect([search.pending?.txSignature, search.all.length]).toEqual(["genuine-73", 1]);
  });

  it("audit 4, C2: successful spam naming the vault AND this sequence's payout account is read after the genuine failed attempt (PoC inverted)", async () => {
    const { w, payer } = await history(74);
    await failedAttempt(w, payer, "genuine-74", dest, 50n);
    // Newer than the genuine attempt: 1,200 successful 1-lamport transfers to the vault that also list the payout PDA.
    const spammer = Keypair.fromSeed(new Uint8Array(32).fill(174));
    const payoutPda = payoutAddress(w.vault, 1n);
    for (let i = 0; i < 1_200; i++) {
      const ix = SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: w.vault, lamports: i + 1 });
      ix.keys.push({ pubkey: payoutPda, isSigner: false, isWritable: false });
      w.conn.addTransaction(`spam-74-${i}`, legacyOf(spammer.publicKey, w.conn.blockhash, [ix]), [spammer.publicKey, w.vault, payoutPda]); // succeeded
    }
    // A small budget finds the genuine attempt first: a successful transaction cannot have run a withdrawal at this sequence.
    const small = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { maxTransactions: 10 });
    expect([small.pending?.txSignature, small.complete, small.incompleteReason]).toEqual(["genuine-74", false, "limit"]);
    expect(small.note).toMatch(/successful transactions naming this sequence's payout account \(they cannot have run a withdrawal\)/);
    // A second device (fresh ledger) re-broadcasts it at once, signing nothing, without paging through the spam.
    const before = getTransactions(w.conn);
    const p = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 74, { destinationOwner: key("pw/c2-new"), maxAmount: 1n }, { ...LOCAL, ledger: createMemoryVaultKeyLedger() });
    expect([p.signed, p.pending?.txSignature]).toEqual([null, "genuine-74"]);
    expect(getTransactions(w.conn) - before).toBeLessThan(20);
    // The deferred spam is still read before the search calls itself complete, and changes nothing.
    let search = small;
    for (let calls = 0; !search.complete; calls++) {
      expect(calls).toBeLessThan(5);
      search = await findPendingWithdrawal(w.conn.asConnection(), w.vault, { continueFrom: search.continuation });
    }
    expect(search.examined).toBeGreaterThanOrEqual(1_200);
    expect([search.pending?.txSignature, search.all.length]).toEqual(["genuine-74", 1]);
  });
});

// ------------------------------------------------------ prepareWithdrawal ---

describe("prepareWithdrawal (the safe order in one call)", () => {
  const dest = key("pw/dest");

  /** open_vault and the withdrawal of sequence 0: the vault of `account` is at sequence 1, holding 1,000. */
  async function opened(account: number): Promise<{ w: VaultWorld; payer: Keypair }> {
    const w = vaultWorld({ account, open: false });
    const payer = Keypair.fromSeed(new Uint8Array(32).fill(account));
    const open = await buildOpenVaultTx(w.conn.asConnection(), payer.publicKey, w.mint, w.genesis.pk);
    w.conn.addTransaction(`open-${account}`, legacyWire(open), [payer.publicKey, w.mint, w.vault, w.tokenAccount]);
    w.setVault(0n);
    w.setBalance(1_000n);
    const first = await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(0n, dest, 100n));
    w.conn.addTransaction(`withdraw-0-${account}`, first.tx, [payer.publicKey, w.vault, first.payout]);
    w.setVault(1n, 100n);
    return { w, payer };
  }
  const walletOf = (n: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;

  it("signs only after a complete search and an accepted recipient; the result rebuilds into a v1 transaction", async () => {
    const { w } = await opened(40);
    const wallet = walletOf(77);
    const r = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 40, { destinationOwner: wallet, maxAmount: 10n }, LOCAL);
    expect([r.pending, r.search?.complete, r.recipient?.ok]).toEqual([null, true, true]);
    const signed = r.signed!;
    expect(signed.args.sequence).toBe(1n);
    expect(toHex(signed.message)).toBe(toHex(withdrawMessage(w.vault, w.mint, 1n, wallet, 10n, w.keyAt(2).keyId)));
    expect(toHex(signed.args.nextKeyId)).toBe(toHex(w.keyAt(2).keyId));
    expect(lmots.verify(w.keyAt(1).pk, signed.message, signed.args.signature)).toBe(true);
    expect((await buildWithdrawTx(w.conn.asConnection(), Keypair.generate(), signed.args)).expectedAmount).toBe(10n);
    // The same request again: the identical signature (deterministic), not a second one.
    const again = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 40, { destinationOwner: wallet, maxAmount: 10n }, LOCAL);
    expect(toHex(again.signed!.args.signature)).toBe(toHex(signed.args.signature));
    // A different request in this process is refused by the session guard.
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 40, { destinationOwner: wallet, maxAmount: 11n }, LOCAL)).rejects.toThrow(/already signed a different/);
  });

  it("returns the revealed withdrawal instead of signing; refuses a refused recipient and a foreign key", async () => {
    const { w, payer } = await opened(41);
    const revealed = await buildWithdrawTx(w.conn.asConnection(), payer, w.signed(1n, dest, 50n));
    w.conn.addTransaction("revealed", revealed.tx, [w.vault, revealed.payout], { InstructionError: [0, { Custom: 1 }] });
    const r = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 41, { destinationOwner: key("pw/someone-else"), maxAmount: 1n }, LOCAL);
    expect([r.signed, r.pending?.txSignature, r.pending?.maxAmount]).toEqual([null, "revealed", 50n]);

    const { w: t } = await opened(42);
    const tokenAccount = key("pw/token-account");
    t.conn.set(tokenAccount, { owner: SPL, data: tokenAccountBytes({ mint: t.mint, owner: dest, amount: 0n }) });
    await expect(prepareWithdrawal(t.conn.asConnection(), master, "localnet", t.mint, 42, { destinationOwner: tokenAccount, maxAmount: 1n }, LOCAL)).rejects.toThrow(/refusing to sign: .*token account/);

    const foreign = vaultWorld({ account: 44 });
    const other = deriveVaultKey(masterFromPhrase(generateRecoveryPhrase()), "localnet", foreign.mint, 44, 1);
    foreign.conn.set(foreign.vault, { owner: PROGRAM_IDS.vault, data: vaultBytes(foreign.mint, foreign.genesis, other, 1n) });
    await expect(prepareWithdrawal(foreign.conn.asConnection(), master, "localnet", foreign.mint, 44, { destinationOwner: walletOf(78), maxAmount: 1n }, LOCAL)).rejects.toThrow(/does not hold the vault's current key/);
    await expect(prepareWithdrawal(foreign.conn.asConnection(), master, "localnet", foreign.mint, 45, { destinationOwner: walletOf(78), maxAmount: 1n }, LOCAL)).rejects.toThrow(/not open/);
  });

  it("an incomplete search is never overridden: IncompleteSearchError, then continue the search and prepare again", async () => {
    const bare = vaultWorld({ account: 43 });
    bare.setVault(1n);
    const wallet = walletOf(79);
    const e = await prepareWithdrawal(bare.conn.asConnection(), master, "localnet", bare.mint, 43, { destinationOwner: wallet, maxAmount: 1n }, LOCAL).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IncompleteSearchError);
    expect((e as IncompleteSearchError).message).toMatch(/could not rule out .*history ends before.*refusing to sign/);
    expect((e as IncompleteSearchError).search).toMatchObject({ complete: false, incompleteReason: "history", continuation: null });
    // The removed override does nothing.
    const legacy = { ...LOCAL, allowIncompleteSearch: true } as unknown as Parameters<typeof prepareWithdrawal>[6];
    await expect(prepareWithdrawal(bare.conn.asConnection(), master, "localnet", bare.mint, 43, { destinationOwner: wallet, maxAmount: 1n }, legacy)).rejects.toThrow(IncompleteSearchError);

    // A search stopped at its limit is continued, then the withdrawal is signed.
    const { w, payer } = await opened(55);
    for (let i = 0; i < 3; i++) {
      const wire = legacyOf(payer.publicKey, w.conn.blockhash, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.vault, lamports: 1 })]);
      w.conn.addTransaction(`failed-${i}`, wire, [payer.publicKey, w.vault], { InstructionError: [0, "Custom"] });
    }
    let continueFrom: PendingWithdrawalContinuation | null = null;
    let signed: Awaited<ReturnType<typeof prepareWithdrawal>> | null = null;
    for (let calls = 0; signed === null; calls++) {
      expect(calls).toBeLessThan(10);
      try {
        signed = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 55, { destinationOwner: wallet, maxAmount: 1n }, { ...LOCAL, maxTransactions: 2, continueFrom });
      } catch (x) {
        expect(x).toBeInstanceOf(IncompleteSearchError);
        expect((x as IncompleteSearchError).search.incompleteReason).toBe("limit");
        expect((x as IncompleteSearchError).message).toMatch(/continue the search/);
        continueFrom = (x as IncompleteSearchError).search.continuation;
      }
    }
    expect(continueFrom).not.toBeNull();
    expect([signed.search?.complete, signed.search?.examined, signed.signed !== null]).toEqual([true, 4, true]);
  });

  it("an off-curve recipient without an account needs acknowledged.offCurveConfirmation; the connected wallet's own token account is refused", async () => {
    const { w } = await opened(56);
    const c = w.conn.asConnection();
    const pda = PublicKey.findProgramAddressSync([enc("multisig-vault")], key("pw/multisig-program"))[0];
    const check = await checkRecipient(c, pda, w.mint, w.vault);
    const e = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 56, { destinationOwner: pda, maxAmount: 1n }, { ...LOCAL, confirm: { recipient: check, acknowledged: {} } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecipientConfirmationError);
    expect([(e as RecipientConfirmationError).reason, (e as Error).message]).toEqual(["unacknowledged", expect.stringMatching(/not confirmed the recipient check's offCurveConfirmation.*lost forever/)]);
    const wallet = walletOf(80);
    await expect(
      prepareWithdrawal(c, master, "localnet", w.mint, 56, { destinationOwner: associatedTokenAddress(wallet, w.mint, SPL), maxAmount: 1n, wallet }, LOCAL),
    ).rejects.toThrow(/your connected wallet's own token account/);
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 56, { destinationOwner: pda, maxAmount: 1n }, { ...LOCAL, confirm: { recipient: check, acknowledged: { offCurveConfirmation: true } } });
    expect(r.recipient?.offCurveConfirmation).toMatch(/lost forever/);
    expect(r.signed?.args.destinationOwner.equals(pda)).toBe(true);
  });

  it("a master wiped while it runs (a lock) signs nothing: never a withdrawal naming a key of the all-zero master", async () => {
    // Review M2: the next key used to be derived from `master` after the awaits.
    const { w } = await opened(57);
    const mine = Uint8Array.from(master);
    const list = w.conn.getSignaturesForAddress.bind(w.conn);
    w.conn.getSignaturesForAddress = async (address, opts) => {
      mine.fill(0); // the user locks while the history search runs
      return list(address, opts);
    };
    await expect(prepareWithdrawal(w.conn.asConnection(), mine, "localnet", w.mint, 57, { destinationOwner: walletOf(81), maxAmount: 10n }, LOCAL)).rejects.toThrow(/master changed .*nothing was signed/);
    w.conn.getSignaturesForAddress = list;
    // Nothing was signed: key 1 still signs a first (different) message, naming the phrase's key 2.
    const r = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 57, { destinationOwner: walletOf(82), maxAmount: 11n }, LOCAL);
    expect(toHex(r.signed!.args.nextKeyId)).toBe(toHex(w.keyAt(2).keyId));
    // An all-zero master is refused before anything is read.
    const calls = w.conn.calls.length;
    await expect(prepareWithdrawal(w.conn.asConnection(), new Uint8Array(64), "localnet", w.mint, 57, { destinationOwner: walletOf(82), maxAmount: 1n }, LOCAL)).rejects.toThrow(/all-zero master/);
    await expect(scanVaults(w.conn.asConnection(), new Uint8Array(64), "localnet", w.mint, 0)).rejects.toThrow(/all-zero master/);
    expect(w.conn.calls.length).toBe(calls);
  });

  it("refuses when the vault moved during the history search", async () => {
    const { w } = await opened(58);
    const read = w.conn.getAccountInfo.bind(w.conn);
    let reads = 0;
    w.conn.getAccountInfo = async (address) => {
      if (address.equals(w.vault) && ++reads === 2) w.setVault(2n, 100n); // a withdrawal executes elsewhere
      return read(address);
    };
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 58, { destinationOwner: walletOf(83), maxAmount: 1n }, LOCAL)).rejects.toThrow(/vault moved to sequence 2 .*nothing was signed/);
  });
  it("checks the cluster first: keys of one cluster never sign against another (genesis hash), localnet only when opted in", async () => {
    // Audit round 2: a mislabeled devnet run could produce mainnet-valid signatures.
    const { w } = await opened(59);
    const request = { destinationOwner: walletOf(84), maxAmount: 1n };
    const confirm = await confirmAll(w.conn.asConnection(), request.destinationOwner, w.mint, w.vault);
    const before = w.conn.calls.length;
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 59, request, { ledger: LEDGER, confirm })).rejects.toThrow(ClusterMismatchError);
    for (const hash of [GENESIS_HASHES.mainnet, GENESIS_HASHES.devnet]) {
      w.conn.genesisHash = hash;
      await expect(prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 59, request, { ...LOCAL, confirm })).rejects.toThrow(/keys for localnet, but the endpoint serves/);
    }
    w.conn.genesisHash = GENESIS_HASHES.devnet;
    // (Keys of another cluster open another vault: the confirmation names it.)
    const vaultOn = (cluster: Cluster): PublicKey => vaultAddress(w.mint, deriveVaultKey(master, cluster, w.mint, 59, 0).keyId);
    const confirmOn = (cluster: Cluster): RecipientConfirmation => ({ ...confirm, recipient: { ...confirm.recipient, vault: vaultOn(cluster) } });
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "mainnet", w.mint, 59, request, { ledger: LEDGER, confirm: confirmOn("mainnet") })).rejects.toThrow(/keys for mainnet, but the endpoint serves devnet/);
    w.conn.genesisHash = GENESIS_HASHES.mainnet;
    await expect(prepareWithdrawal(w.conn.asConnection(), master, "devnet", w.mint, 59, request, { ledger: LEDGER, confirm: confirmOn("devnet") })).rejects.toThrow(/keys for devnet, but the endpoint serves mainnet/);
    // Refused before anything else was read: only genesis-hash requests.
    expect(w.conn.calls.slice(before).every((c) => c === "getGenesisHash")).toBe(true);
    // The right cluster signs.
    w.conn.genesisHash = "4bSGxgUYZ5dQ7TfcGeWDqrWWzr4pzALeE9NoAsJVnHYL";
    expect((await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 59, request, LOCAL)).signed).not.toBeNull();
  });

  // ---- The durable vault-key ledger (review finding: one key, two messages across sessions / tabs / devices).

  type VaultModule = typeof import("../src/pq/vault.js");
  type LedgerModule = typeof import("../src/pq/vaultLedger.js");
  /** A fresh copy of the vault and ledger modules: another tab (its own in-memory state). */
  async function freshTab(): Promise<{ vault: VaultModule; ledger: LedgerModule }> {
    vi.resetModules();
    return { vault: await import("../src/pq/vault.js"), ledger: await import("../src/pq/vaultLedger.js") };
  }

  it("two sessions sharing one store: the second, different request is refused; the same request gets the identical recorded bytes", async () => {
    const { w } = await opened(90);
    const conn = w.conn.asConnection();
    const store = memoryLeafLedgerStore();
    const wallet = walletOf(90);
    const tabA = await freshTab();
    const tabB = await freshTab();
    expect(tabB.vault).not.toBe(tabA.vault);
    const ledgerA = tabA.ledger.createVaultKeyLedger(store);
    const ledgerB = tabB.ledger.createVaultKeyLedger(store);
    const confirm = await confirmAll(conn, wallet, w.mint, w.vault);
    // Tab A signs "10 to wallet" (and, say, simulates it: revealed, never landed).
    const a = await tabA.vault.prepareWithdrawal(conn, master, "localnet", w.mint, 90, { destinationOwner: wallet, maxAmount: 10n }, { allowLocalnet: true, ledger: ledgerA, confirm });
    expect(a.signed?.reused).toBe(false);
    // Tab B (its own module state) asks for "900 to wallet": nothing landed, but the ledger knows.
    const e = await tabB.vault.prepareWithdrawal(conn, master, "localnet", w.mint, 90, { destinationOwner: wallet, maxAmount: 900n }, { allowLocalnet: true, ledger: ledgerB, confirm }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(tabB.ledger.VaultKeyInUseError);
    expect((e as Error).message).toMatch(/already signed a different withdrawal \(max 10 base units to .*, sequence 1\)/);
    const recorded = (e as VaultKeyInUseError).withdrawal!;
    expect([recorded.maxAmount, toHex(recorded.signature), toHex(recorded.nextKeyId)]).toEqual([10n, toHex(a.signed!.args.signature), toHex(w.keyAt(2).keyId)]);
    // The low-level signer is refused the same way.
    const other = withdrawMessage(w.vault, w.mint, 1n, wallet, 900n, w.keyAt(2).keyId);
    await expect(tabB.vault.signWithdrawal(conn, "localnet", w.keyAt(1), w.keyAt(2).pk, other, { allowLocalnet: true, ledger: ledgerB, confirm })).rejects.toThrow(/already signed a different withdrawal/);
    // The same request in tab B: the identical bytes, read back, without searching the history again.
    const lists = listCalls(w.conn);
    const again = await tabB.vault.prepareWithdrawal(conn, master, "localnet", w.mint, 90, { destinationOwner: wallet, maxAmount: 10n }, { allowLocalnet: true, ledger: ledgerB, confirm });
    expect([again.signed?.reused, again.search, again.pending]).toEqual([true, null, null]);
    expect(toHex(again.signed!.args.signature)).toBe(toHex(a.signed!.args.signature));
    expect(listCalls(w.conn)).toBe(lists);

    // Two tabs at the same moment with two requests: exactly one signs (the store's atomic add decides).
    const { w: race } = await opened(96);
    const shared = memoryLeafLedgerStore();
    const [x, y] = [await freshTab(), await freshTab()];
    const raceConfirm = await confirmAll(race.conn.asConnection(), wallet, race.mint, race.vault);
    const results = await Promise.allSettled([
      x.vault.prepareWithdrawal(race.conn.asConnection(), master, "localnet", race.mint, 96, { destinationOwner: wallet, maxAmount: 1n }, { allowLocalnet: true, ledger: x.ledger.createVaultKeyLedger(shared), confirm: raceConfirm }),
      y.vault.prepareWithdrawal(race.conn.asConnection(), master, "localnet", race.mint, 96, { destinationOwner: wallet, maxAmount: 2n }, { allowLocalnet: true, ledger: y.ledger.createVaultKeyLedger(shared), confirm: raceConfirm }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/VaultKeyInUseError: refusing to sign: this one-time vault key (already signed|is already reserved for) a different withdrawal/);
  });

  it("the key is reserved durably before any signature exists, and the signature is recorded before it is returned", async () => {
    const { w } = await opened(91);
    const events: string[] = [];
    const inner = memoryLeafLedgerStore();
    const store: LeafLedgerStore = {
      get: (k) => inner.get(k),
      keys: (prefix) => inner.keys(prefix),
      add: async (k, v) => {
        events.push(`add ${JSON.parse(v).status}${k.startsWith("phalanx/") ? " (earlier name)" : ""}`);
        return inner.add(k, v);
      },
      put: async (k, v) => {
        events.push(`put ${JSON.parse(v).status}`);
        return inner.put(k, v);
      },
    };
    const ledger = createVaultKeyLedger(store);
    const r = await prepareWithdrawal(w.conn.asConnection(), master, "localnet", w.mint, 91, { destinationOwner: walletOf(91), maxAmount: 5n }, { allowLocalnet: true, ledger });
    events.push("returned");
    // The reservation is claimed under the earlier name first (SDK legacyNamespace.ts), then its own, before signing.
    expect(events).toEqual(["add reserved (earlier name)", "add reserved", "put signed", "returned"]);
    expect(await ledger.get(w.keyAt(1).keyId)).toMatchObject({ status: "signed", origin: "signed", signature: toHex(r.signed!.args.signature), message: toHex(r.signed!.message) });

    // A store that cannot persist the reservation: nothing is signed.
    const { w: w2 } = await opened(92);
    const prepare = (amount: bigint, l: VaultKeyLedger) =>
      prepareWithdrawal(w2.conn.asConnection(), master, "localnet", w2.mint, 92, { destinationOwner: walletOf(92), maxAmount: amount }, { allowLocalnet: true, ledger: l });
    await expect(prepare(7n, createVaultKeyLedger({ ...memoryLeafLedgerStore(), add: () => Promise.reject(new Error("quota exceeded")) }))).rejects.toThrow(/quota/);
    // One that cannot persist the signature: nothing is returned, and the key stays reserved for that request.
    const base = memoryLeafLedgerStore();
    await expect(prepare(7n, createVaultKeyLedger({ ...base, put: () => Promise.reject(new Error("disk full")) }))).rejects.toThrow(/disk full/);
    const healed = createVaultKeyLedger(base);
    const e = await prepare(8n, healed).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VaultKeyInUseError);
    expect((e as Error).message).toMatch(/already reserved for a different withdrawal .*never signed; prepare that same withdrawal/);
    expect((e as VaultKeyInUseError).withdrawal).toBeNull();
    // The reserved request itself finishes.
    const finished = await prepare(7n, healed);
    expect([finished.signed?.reused, finished.signed?.args.maxAmount]).toEqual([false, 7n]);
  });

  it("every signing entry point requires the ledger (no default), before any RPC", async () => {
    const { w } = await opened(94);
    const conn = w.conn.asConnection();
    const request = { destinationOwner: walletOf(94), maxAmount: 1n };
    const msg = withdrawMessage(w.vault, w.mint, 1n, walletOf(94), 1n, w.keyAt(2).keyId);
    const confirm = await confirmAll(conn, walletOf(94), w.mint, w.vault);
    const calls = w.conn.calls.length;
    await expect(sdkPrepareWithdrawal(conn, master, "localnet", w.mint, 94, request, { allowLocalnet: true, confirm } as never)).rejects.toThrow(/needs opts\.ledger/);
    await expect(sdkPrepareWithdrawal(conn, master, "localnet", w.mint, 94, request, undefined as never)).rejects.toThrow(/needs opts\.ledger/);
    await expect(sdkSignWithdrawal(conn, "localnet", w.keyAt(1), w.keyAt(2).pk, msg, { allowLocalnet: true, confirm } as never)).rejects.toThrow(/needs opts\.ledger/);
    await expect(buildWithdrawTxWithFallback(conn, Keypair.generate(), w.signed(1n, walletOf(94), 1n), {} as never)).rejects.toThrow(/needs opts\.ledger/);
    expect(w.conn.calls.length).toBe(calls);
  });

  it("buildWithdrawTxWithFallback simulates (reveals) only a signature the ledger holds for this exact withdrawal", async () => {
    const { w } = await opened(93);
    const conn = w.conn.asConnection();
    const payer = Keypair.generate();
    const simulated: string[] = [];
    w.conn.rpc = (method) => {
      simulated.push(method);
      return { result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } };
    };
    const args = w.signed(1n, walletOf(93), 10n); // made outside any ledger
    await expect(buildWithdrawTxWithFallback(conn, payer, args, { ledger: createMemoryVaultKeyLedger() })).rejects.toThrow(VaultLedgerError);
    await expect(buildWithdrawTxWithFallback(conn, payer, args, { ledger: await held(w, w.signed(1n, walletOf(93), 11n)) })).rejects.toThrow(/refusing to simulate/);
    expect(simulated).toEqual([]);
    const r = await buildWithdrawTxWithFallback(conn, payer, args, { ledger: await held(w, args) });
    expect(r.simulation.ok).toBe(true);
    expect(simulated).toContain("simulateTransaction");
  });

  it("a withdrawal found on chain is recorded in the ledger (so it can be re-broadcast), replacing a reservation that never signed", async () => {
    const { w, payer } = await opened(95);
    const conn = w.conn.asConnection();
    const ledger = createMemoryVaultKeyLedger();
    // This ledger reserved the key for a request it never signed (a crash, a failed write) ...
    const mine = withdrawMessage(w.vault, w.mint, 1n, walletOf(95), 3n, w.keyAt(2).keyId);
    expect(await ledger.reserve(w.keyAt(1).keyId, mine, { vault: w.vault, sequence: 1n, key: w.keyAt(1).pk })).toBe("reserved");
    // ... while a device without this ledger signed and sent another withdrawal, which failed on chain.
    const revealed = await buildWithdrawTx(conn, payer, w.signed(1n, dest, 50n));
    w.conn.addTransaction("revealed-95", revealed.tx, [w.vault, revealed.payout], { InstructionError: [0, { Custom: 1 }] });
    const r = await prepareWithdrawal(conn, master, "localnet", w.mint, 95, { destinationOwner: walletOf(95), maxAmount: 3n }, { allowLocalnet: true, ledger });
    expect([r.signed, r.pending?.txSignature, r.pending?.maxAmount]).toEqual([null, "revealed-95", 50n]);
    expect(await ledger.get(w.keyAt(1).keyId)).toMatchObject({ status: "signed", origin: "found", signature: toHex(r.pending!.signature), messageHash: toHex(sha256(r.pending!.message)), key: { q: 1, k: toHex(w.keyAt(1).pk.k) } });
    // The reserved request can never be signed now ...
    await expect(signWithdrawal(conn, "localnet", w.keyAt(1), w.keyAt(2).pk, mine, { allowLocalnet: true, ledger })).rejects.toThrow(VaultKeyInUseError);
    // ... and the found one re-broadcasts through the fallback builder.
    w.conn.rpc = () => ({ result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } });
    const p = r.pending!;
    expect((await buildWithdrawTxWithFallback(conn, Keypair.generate(), { ...p, nextKey: p.nextKey! }, { ledger })).simulation.ok).toBe(true);
  });
  // ---- The recipient is confirmed before any signature exists (SDK v2 follow-up: confirmation BEFORE signing).

  /** A memory store that logs every write (add / put). */
  function loggingStore(writes: string[]): LeafLedgerStore {
    const inner = memoryLeafLedgerStore();
    return {
      get: (k) => inner.get(k),
      keys: (prefix) => inner.keys(prefix),
      add: async (k, v) => {
        writes.push(`add ${JSON.parse(v).status}${k.startsWith("phalanx/") ? " (earlier name)" : ""}`);
        return inner.add(k, v);
      },
      put: async (k, v) => {
        writes.push(`put ${JSON.parse(v).status}`);
        return inner.put(k, v);
      },
    };
  }

  it("prepareWithdrawal requires the user's confirmation of this exact recipient check BEFORE anything is read, reserved or signed", async () => {
    const { w } = await opened(60);
    const c = w.conn.asConnection();
    const to = walletOf(60);
    const request = { destinationOwner: to, maxAmount: 5n };
    const writes: string[] = [];
    const ledger = createVaultKeyLedger(loggingStore(writes));
    const check = await checkRecipient(c, to, w.mint, w.vault);
    // The check names what it is for.
    expect([check.destinationOwner.equals(to), check.mint.equals(w.mint), check.vault.equals(w.vault), check.wallet, check.ok]).toEqual([true, true, true, null, true]);
    const otherRecipient = await checkRecipient(c, walletOf(61), w.mint, w.vault);
    const otherVault = vaultAddress(w.mint, w.keyAt(0).keyId.map((b) => b ^ 1));
    const calls = w.conn.calls.length;
    const refused = async (confirm: unknown, reason: string, message: RegExp): Promise<void> => {
      const e = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 60, request, { ...LOCAL, ledger, confirm } as never).catch((x: unknown) => x);
      expect(e, reason).toBeInstanceOf(RecipientConfirmationError);
      expect([(e as RecipientConfirmationError).reason, (e as Error).message], reason).toEqual([reason, expect.stringMatching(message)]);
    };
    await refused(undefined, "missing", /needs opts\.confirm/);
    await refused({ recipient: check }, "missing", /needs opts\.confirm/);
    await refused({ recipient: { ...check, recipientWarnings: undefined }, acknowledged: {} }, "missing", /not a checkRecipient result/);
    // A check of another recipient, mint or vault, or one that does not say what it is for.
    await refused({ recipient: otherRecipient, acknowledged: {} }, "mismatch", /another recipient/);
    await refused({ recipient: { ...check, mint: key("pw/other-mint") }, acknowledged: {} }, "mismatch", /another mint/);
    await refused({ recipient: { ...check, vault: otherVault }, acknowledged: {} }, "mismatch", /another vault/);
    await refused({ recipient: { ...check, destinationOwner: undefined }, acknowledged: {} }, "mismatch", /does not name its recipient/);
    // Refusals stop it, acknowledged or not.
    const refusing: RecipientCheck = { ...check, ok: false, refusals: ["it is a token account"] };
    await refused({ recipient: refusing, acknowledged: { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true } }, "refused", /refuses this recipient: it is a token account/);
    // Each kind of caution needs its own acknowledgment.
    const warned: RecipientCheck = { ...check, recipientWarnings: ["a program wallet"], mintWarnings: ["a freeze authority"], offCurveConfirmation: "off the curve" };
    await refused({ recipient: warned, acknowledged: {} }, "unacknowledged", /recipientWarnings, mintWarnings, offCurveConfirmation.*: off the curve/);
    await refused({ recipient: warned, acknowledged: { recipientWarnings: true, mintWarnings: true } }, "unacknowledged", /check's offCurveConfirmation/);
    await refused({ recipient: warned, acknowledged: { recipientWarnings: true, offCurveConfirmation: true } }, "unacknowledged", /check's mintWarnings/);
    await refused({ recipient: warned, acknowledged: { recipientWarnings: false, mintWarnings: true, offCurveConfirmation: true } }, "unacknowledged", /check's recipientWarnings/);
    // None of it read the chain, wrote the ledger or signed.
    expect(w.conn.calls.length).toBe(calls);
    expect(writes).toEqual([]);
    expect(await ledger.get(w.keyAt(1).keyId)).toBeNull();
    // Confirmed (here nothing to acknowledge): reserved, signed, recorded.
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 60, request, { ...LOCAL, ledger, confirm: { recipient: check, acknowledged: {} } });
    expect([r.signed?.reused, writes]).toEqual([false, ["add reserved (earlier name)", "add reserved", "put signed"]]);
    // Acknowledging cautions the chain does not (or no longer) show is harmless.
    expect((await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 60, request, { ...LOCAL, ledger, confirm: { recipient: warned, acknowledged: { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true } } })).signed?.reused).toBe(true);
  });

  it("a stale confirmation is refused: the check runs again right before reserving, and anything the user was not shown stops it", async () => {
    const { w } = await opened(62);
    const c = w.conn.asConnection();
    const to = walletOf(62);
    const confirm = await confirmAll(c, to, w.mint, w.vault);
    expect([confirm.recipient.recipientWarnings, confirm.recipient.mintWarnings]).toEqual([[], []]);
    // After the user confirmed, the recipient's token account is frozen: a recipient warning nobody confirmed.
    w.conn.set(associatedTokenAddress(to, w.mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: to, amount: 0n, state: 2 }) });
    const writes: string[] = [];
    const ledger = createVaultKeyLedger(loggingStore(writes));
    const e = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 62, { destinationOwner: to, maxAmount: 5n }, { ...LOCAL, ledger, confirm }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecipientConfirmationError);
    expect([(e as RecipientConfirmationError).reason, (e as RecipientConfirmationError).current?.recipientWarnings.join()]).toEqual(["stale", expect.stringMatching(/frozen/)]);
    expect((e as Error).message).toMatch(/changed since the user confirmed it.*frozen/);
    // So does the vault's own token account frozen meanwhile (a mint warning).
    const vaultFrozen = await opened(63);
    const confirm63 = await confirmAll(vaultFrozen.w.conn.asConnection(), walletOf(63), vaultFrozen.w.mint, vaultFrozen.w.vault);
    vaultFrozen.w.conn.set(vaultFrozen.w.tokenAccount, { owner: SPL, data: tokenAccountBytes({ mint: vaultFrozen.w.mint, owner: vaultFrozen.w.vault, amount: 1_000n, state: 2 }) });
    const e63 = await sdkPrepareWithdrawal(vaultFrozen.w.conn.asConnection(), master, "localnet", vaultFrozen.w.mint, 63, { destinationOwner: walletOf(63), maxAmount: 1n }, { ...LOCAL, confirm: confirm63 }).catch((x: unknown) => x);
    expect([(e63 as RecipientConfirmationError).reason, (e63 as RecipientConfirmationError).current?.mintWarnings.join()]).toEqual(["stale", expect.stringMatching(/vault's token account is frozen/)]);
    // A recipient that turned into a token account is refused now.
    const turned = await opened(64);
    const t = turned.w.conn.asConnection();
    const confirm64 = await confirmAll(t, walletOf(64), turned.w.mint, turned.w.vault);
    turned.w.conn.set(walletOf(64), { owner: SPL, data: tokenAccountBytes({ mint: turned.w.mint, owner: walletOf(65), amount: 0n }) });
    const e64 = await sdkPrepareWithdrawal(t, master, "localnet", turned.w.mint, 64, { destinationOwner: walletOf(64), maxAmount: 1n }, { ...LOCAL, confirm: confirm64 }).catch((x: unknown) => x);
    expect([(e64 as RecipientConfirmationError).reason, (e64 as Error).message]).toEqual(["refused", expect.stringMatching(/refuses this recipient now: .*token account/)]);
    // Nothing was reserved or signed by any of them.
    expect(writes).toEqual([]);
    for (const [x, account] of [[w, 62], [vaultFrozen.w, 63], [turned.w, 64]] as const) expect(await LEDGER.get(x.keyAt(1).keyId), String(account)).toBeNull();
    // Confirmed again with what the chain shows now: signed.
    const again = await confirmAll(c, to, w.mint, w.vault);
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 62, { destinationOwner: to, maxAmount: 5n }, { ...LOCAL, ledger, confirm: again });
    expect([r.signed?.reused, r.recipient?.recipientWarnings.join()]).toEqual([false, expect.stringMatching(/frozen/)]);
    // Re-broadcasting what the ledger holds is never blocked by a later change (nothing new is signed).
    w.conn.delete(associatedTokenAddress(to, w.mint, SPL));
    w.conn.set(w.tokenAccount, { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: w.vault, amount: 1_000n, state: 2 }) });
    const reused = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 62, { destinationOwner: to, maxAmount: 5n }, { ...LOCAL, ledger, confirm: again });
    expect([reused.signed?.reused, toHex(reused.signed!.args.signature)]).toEqual([true, toHex(r.signed!.args.signature)]);
  });

  it("signWithdrawal (the low-level signer) is held to the same confirmation", async () => {
    const { w } = await opened(66);
    const c = w.conn.asConnection();
    const to = walletOf(66);
    const msg = withdrawMessage(w.vault, w.mint, 1n, to, 7n, w.keyAt(2).keyId);
    const writes: string[] = [];
    const ledger = createVaultKeyLedger(loggingStore(writes));
    const confirm = await confirmAll(c, to, w.mint, w.vault);
    const other = await confirmAll(c, walletOf(67), w.mint, w.vault);
    const calls = w.conn.calls.length;
    const sign = (o: unknown): Promise<Uint8Array> => sdkSignWithdrawal(c, "localnet", w.keyAt(1), w.keyAt(2).pk, msg, { ...LOCAL, ledger, ...(o as object) } as never);
    await expect(sign({ confirm: undefined })).rejects.toThrow(/signWithdrawal needs opts\.confirm/);
    await expect(sign({ confirm: other })).rejects.toThrow(/another recipient/);
    await expect(sign({ confirm: { recipient: { ...confirm.recipient, offCurveConfirmation: "lost forever" }, acknowledged: {} } })).rejects.toThrow(/not confirmed the recipient check's offCurveConfirmation/);
    expect(w.conn.calls.length).toBe(calls);
    // Stale: the recipient's token account was frozen after the user confirmed.
    w.conn.set(associatedTokenAddress(to, w.mint, SPL), { owner: SPL, data: tokenAccountBytes({ mint: w.mint, owner: to, amount: 0n, state: 2 }) });
    await expect(sign({ confirm })).rejects.toThrow(RecipientConfirmationError);
    expect([writes, await ledger.get(w.keyAt(1).keyId)]).toEqual([[], null]);
    const fresh = await confirmAll(c, to, w.mint, w.vault);
    const sig = await sign({ confirm: fresh });
    expect(lmots.verify(w.keyAt(1).pk, msg, sig)).toBe(true);
    expect(writes).toEqual(["add reserved (earlier name)", "add reserved", "put signed"]);
    // The recorded withdrawal comes back even under the old confirmation: nothing new is signed.
    expect(toHex(await sign({ confirm }))).toBe(toHex(sig));
  });

  it("recordPendingWithdrawal: a withdrawal findPendingWithdrawal found is recorded (verified under the vault's key), then re-broadcast through the fallback builder", async () => {
    const { w, payer } = await opened(69);
    const c = w.conn.asConnection();
    const revealed = await buildWithdrawTx(c, payer, w.signed(1n, dest, 40n));
    w.conn.addTransaction("revealed-69", revealed.tx, [w.vault, revealed.payout], { InstructionError: [0, { Custom: 1 }] });
    const search = await findPendingWithdrawal(c, w.vault);
    expect(search.pending?.txSignature).toBe("revealed-69");
    w.conn.rpc = () => ({ result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } } });
    const ledger = createMemoryVaultKeyLedger();
    // Not recorded yet: the fallback builder refuses to simulate (reveal) it.
    await expect(buildWithdrawTxWithFallback(c, Keypair.generate(), { ...search.pending!, nextKey: search.pending!.nextKey! }, { ledger })).rejects.toThrow(/refusing to simulate/);
    const args = await recordPendingWithdrawal(ledger, search);
    expect(await ledger.get(w.keyAt(1).keyId)).toMatchObject({ origin: "found", status: "signed", key: { q: 1, k: toHex(w.keyAt(1).pk.k) } });
    expect((await buildWithdrawTxWithFallback(c, Keypair.generate(), args, { ledger })).simulation.ok).toBe(true);
    // No other withdrawal is ever signed with that key through this ledger.
    await expect(signWithdrawal(c, "localnet", w.keyAt(1), w.keyAt(2).pk, withdrawMessage(w.vault, w.mint, 1n, walletOf(69), 1n, w.keyAt(2).keyId), { ...LOCAL, ledger })).rejects.toThrow(VaultKeyInUseError);
    // Nothing executable: refused. A forged signature: the ledger refuses it before writing anything.
    await expect(recordPendingWithdrawal(ledger, { ...search, pending: null })).rejects.toThrow(/no withdrawal of the current key/);
    const fresh = createMemoryVaultKeyLedger();
    const forged = { ...search, pending: { ...search.pending!, signature: search.pending!.signature.map((b, i) => (i === 50 ? b ^ 1 : b)) } };
    await expect(recordPendingWithdrawal(fresh, forged)).rejects.toThrow(/does not verify/);
    expect(await fresh.list()).toEqual([]);
  });

  it("two devices, two ledgers: importing the other device's records before signing refuses that key here (the multi-device rule)", async () => {
    const { w } = await opened(68);
    const c = w.conn.asConnection();
    const deviceA = createMemoryVaultKeyLedger();
    const deviceB = createMemoryVaultKeyLedger();
    const to = walletOf(68);
    const a = await prepareWithdrawal(c, master, "localnet", w.mint, 68, { destinationOwner: to, maxAmount: 10n }, { ...LOCAL, ledger: deviceA });
    // Device A's withdrawal was simulated, say, but never landed: only its ledger knows. Carry it over (JSON).
    const carried = JSON.parse(JSON.stringify(await exportVaultKeyRecords(deviceA, { vault: w.vault }))) as Awaited<ReturnType<typeof exportVaultKeyRecords>>;
    expect(await importVaultKeyRecords(deviceB, carried)).toEqual({ added: 1, merged: 0, unchanged: 0, conflicts: [], compromised: [], unverifiable: [] });
    const e = await prepareWithdrawal(c, master, "localnet", w.mint, 68, { destinationOwner: to, maxAmount: 900n }, { ...LOCAL, ledger: deviceB }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VaultKeyInUseError);
    expect(toHex((e as VaultKeyInUseError).withdrawal!.signature)).toBe(toHex(a.signed!.args.signature));
    // The same request on device B returns device A's bytes, signing nothing.
    const same = await prepareWithdrawal(c, master, "localnet", w.mint, 68, { destinationOwner: to, maxAmount: 10n }, { ...LOCAL, ledger: deviceB });
    expect([same.signed?.reused, toHex(same.signed!.args.signature)]).toEqual([true, toHex(a.signed!.args.signature)]);
  });

  // ---- Review round 2 (SDK v2.1): what is signed is what was confirmed; the session guard; records of 0.2.0.

  it("what is signed is what was confirmed at the call: a request, message, key or confirmation edited while the call awaits the network changes nothing (review finding)", async () => {
    // Regression: the confirmation was matched against the request at entry, but the message was built from the
    // request again after the awaits, so a reactive form edited meanwhile was signed for a recipient nobody confirmed
    // (here the vault's own token account, which checkRecipient refuses: the payout would be lost forever).
    const { w } = await opened(80);
    const c = w.conn.asConnection();
    const confirmed = walletOf(70);
    const recipient = await checkRecipient(c, confirmed, w.mint, w.vault);
    expect([recipient.ok, (await checkRecipient(c, w.tokenAccount, w.mint, w.vault)).ok]).toEqual([true, false]);
    const request = { destinationOwner: confirmed, maxAmount: 10n };
    const confirm = { recipient: { ...recipient }, acknowledged: {} as { recipientWarnings?: boolean } };
    const genesis = w.conn.getGenesisHash.bind(w.conn);
    w.conn.getGenesisHash = async () => {
      const h = await genesis();
      // The UI edits the same objects while the call awaits the RPC.
      request.destinationOwner = w.tokenAccount;
      request.maxAmount = 999n;
      confirm.recipient.destinationOwner = w.tokenAccount;
      confirm.recipient.recipientWarnings = ["edited"];
      confirm.acknowledged.recipientWarnings = true;
      return h;
    };
    const ledger = createMemoryVaultKeyLedger();
    // The amount is part of the copy: checked (u64) before anything is read.
    const before = w.conn.calls.length;
    await expect(sdkPrepareWithdrawal(c, master, "localnet", w.mint, 80, { destinationOwner: confirmed, maxAmount: -1n }, { ...LOCAL, ledger, confirm: { recipient, acknowledged: {} } })).rejects.toThrow(
      /request\.maxAmount must be a u64/,
    );
    expect(w.conn.calls.length).toBe(before);
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 80, request, { ...LOCAL, ledger, confirm });
    w.conn.getGenesisHash = genesis;
    const m = parseWithdrawMessage(r.signed!.message);
    expect([m.destinationOwner.toBase58(), m.maxAmount]).toEqual([confirmed.toBase58(), 10n]);
    expect([r.signed!.args.destinationOwner.toBase58(), r.signed!.args.maxAmount]).toEqual([confirmed.toBase58(), 10n]);
    expect(r.recipient!.destinationOwner.toBase58()).toBe(confirmed.toBase58()); // the re-check names what was signed
    expect(lmots.verify(w.keyAt(1).pk, r.signed!.message, r.signed!.args.signature)).toBe(true);
    expect((await ledger.get(w.keyAt(1).keyId))?.message).toBe(toHex(r.signed!.message));

    // signWithdrawal: the caller's message buffer is overwritten (recipient field, bytes 113..145) during the await.
    const { w: v } = await opened(81);
    const cv = v.conn.asConnection();
    const to = walletOf(71);
    const check = await checkRecipient(cv, to, v.mint, v.vault);
    const msg = withdrawMessage(v.vault, v.mint, 1n, to, 7n, v.keyAt(2).keyId);
    const original = Uint8Array.from(msg);
    const recipientField = WITHDRAW_MESSAGE_FIELDS.find((f) => f.name.startsWith("Recipient"))!;
    const g2 = v.conn.getGenesisHash.bind(v.conn);
    v.conn.getGenesisHash = async () => {
      const h = await g2();
      msg.set(v.tokenAccount.toBytes(), recipientField.start);
      return h;
    };
    const ledger2 = createMemoryVaultKeyLedger();
    const sig = await sdkSignWithdrawal(cv, "localnet", v.keyAt(1), v.keyAt(2).pk, msg, { ...LOCAL, ledger: ledger2, confirm: { recipient: check, acknowledged: {} } });
    v.conn.getGenesisHash = g2;
    expect(parseWithdrawMessage(msg).destinationOwner.equals(v.tokenAccount)).toBe(true); // the caller's buffer changed ...
    expect([lmots.verify(v.keyAt(1).pk, original, sig), lmots.verify(v.keyAt(1).pk, msg, sig)]).toEqual([true, false]); // ... what was signed did not
    expect((await ledger2.get(v.keyAt(1).keyId))?.message).toBe(toHex(original));

    // A "lock" that wipes the key's seed while signWithdrawal runs stops it, like a wiped master stops prepareWithdrawal.
    const { w: x } = await opened(82);
    const cx = x.conn.asConnection();
    const xKey = x.keyAt(1);
    const mine = { skSeed: Uint8Array.from(xKey.skSeed), pk: xKey.pk };
    const xMsg = withdrawMessage(x.vault, x.mint, 1n, walletOf(72), 3n, x.keyAt(2).keyId);
    const xConfirm = { recipient: await checkRecipient(cx, walletOf(72), x.mint, x.vault), acknowledged: {} };
    const g3 = x.conn.getGenesisHash.bind(x.conn);
    x.conn.getGenesisHash = async () => {
      const h = await g3();
      mine.skSeed.fill(0);
      return h;
    };
    const ledger3 = createMemoryVaultKeyLedger();
    await expect(sdkSignWithdrawal(cx, "localnet", mine, x.keyAt(2).pk, xMsg, { ...LOCAL, ledger: ledger3, confirm: xConfirm })).rejects.toThrow(/key\.skSeed changed while signWithdrawal ran.*nothing was signed/);
    x.conn.getGenesisHash = g3;
    expect(await ledger3.list()).toEqual([]);
  });

  it("the session guard knows every signature this process saw, not only the ones it computed: a second ledger never gets a second withdrawal signed (review finding)", async () => {
    // Regression: a signature returned from the ledger (`reused`), adopted from chain or carried by a
    // VaultKeyInUseError did not arm the guard, so a fresh ledger signed a second withdrawal with the same key.
    const { w } = await opened(83);
    const c = w.conn.asConnection();
    const k1 = w.keyAt(1);
    const k2 = w.keyAt(2);
    const alice = walletOf(73);
    const confirm = await confirmAll(c, alice, w.mint, w.vault);
    // The durable ledger as an earlier session left it: key 1 signed "10 to alice".
    const durable = createMemoryVaultKeyLedger();
    const msgA = withdrawMessage(w.vault, w.mint, 1n, alice, 10n, k2.keyId);
    const sigA = lmots.signDeterministic(skOf(k1), msgA);
    expect(await durable.reserve(k1.keyId, msgA, { vault: w.vault, sequence: 1n, key: k1.pk })).toBe("reserved");
    await durable.recordSignature(k1.keyId, msgA, sigA, k2.pk);
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 83, { destinationOwner: alice, maxAmount: 10n }, { ...LOCAL, ledger: durable, confirm });
    expect([r.signed?.reused, toHex(r.signed!.args.signature)]).toEqual([true, toHex(sigA)]);
    // Same process, another (non-shared) ledger, another withdrawal with the same one-time key: refused, nothing written.
    const msgB = withdrawMessage(w.vault, w.mint, 1n, alice, 999n, k2.keyId);
    const second = createMemoryVaultKeyLedger();
    await expect(sdkSignWithdrawal(c, "localnet", k1, k2.pk, msgB, { ...LOCAL, ledger: second, confirm })).rejects.toThrow(/already signed a different withdrawal in this session/);
    await expect(sdkPrepareWithdrawal(c, master, "localnet", w.mint, 83, { destinationOwner: alice, maxAmount: 999n }, { ...LOCAL, ledger: second, confirm })).rejects.toThrow(/already signed a different withdrawal in this session/);
    expect(await second.list()).toEqual([]);
    // The withdrawal it holds is still signed again (the identical bytes) through any ledger.
    expect(toHex(await sdkSignWithdrawal(c, "localnet", k1, k2.pk, msgA, { ...LOCAL, ledger: createMemoryVaultKeyLedger(), confirm }))).toBe(toHex(sigA));

    // A withdrawal found on chain arms it too (prepareWithdrawal adopts it; findPendingWithdrawal alone as well).
    const { w: f, payer } = await opened(84);
    const cf = f.conn.asConnection();
    const revealed = await buildWithdrawTx(cf, payer, f.signed(1n, dest, 50n));
    f.conn.addTransaction("revealed-74", revealed.tx, [f.vault, revealed.payout], { InstructionError: [0, { Custom: 1 }] });
    const found = await sdkPrepareWithdrawal(cf, master, "localnet", f.mint, 84, { destinationOwner: walletOf(74), maxAmount: 1n }, { ...LOCAL, ledger: createMemoryVaultKeyLedger(), confirm: await confirmAll(cf, walletOf(74), f.mint, f.vault) });
    expect(found.pending?.txSignature).toBe("revealed-74");
    const other = withdrawMessage(f.vault, f.mint, 1n, walletOf(74), 1n, f.keyAt(2).keyId);
    const fresh = createMemoryVaultKeyLedger();
    await expect(sdkSignWithdrawal(cf, "localnet", f.keyAt(1), f.keyAt(2).pk, other, { ...LOCAL, ledger: fresh, confirm: await confirmAll(cf, walletOf(74), f.mint, f.vault) })).rejects.toThrow(
      /already signed a different withdrawal in this session/,
    );
    expect(await fresh.list()).toEqual([]);

    // A VaultKeyInUseError carrying another withdrawal's signature arms it as well.
    const { w: u } = await opened(85);
    const cu = u.conn.asConnection();
    const held1 = await held(u, u.signed(1n, walletOf(75), 5n));
    const recipientOf76 = await checkRecipient(cu, walletOf(76), u.mint, u.vault);
    const ask = (amount: bigint, l: VaultKeyLedger) => sdkPrepareWithdrawal(cu, master, "localnet", u.mint, 85, { destinationOwner: walletOf(76), maxAmount: amount }, { ...LOCAL, ledger: l, confirm: { recipient: recipientOf76, acknowledged: {} } });
    await expect(ask(6n, held1)).rejects.toThrow(VaultKeyInUseError);
    await expect(ask(6n, createMemoryVaultKeyLedger())).rejects.toThrow(/already signed a different withdrawal in this session/);

    // signWithdrawal handed back a signature its ledger held (an earlier session's): armed too.
    const { w: s } = await opened(87);
    const cs = s.conn.asConnection();
    const toS = walletOf(87);
    const confirmS = await confirmAll(cs, toS, s.mint, s.vault);
    const msgS = withdrawMessage(s.vault, s.mint, 1n, toS, 3n, s.keyAt(2).keyId);
    const earlier = await held(s, s.signed(1n, toS, 3n));
    expect(toHex(await sdkSignWithdrawal(cs, "localnet", s.keyAt(1), s.keyAt(2).pk, msgS, { ...LOCAL, ledger: earlier, confirm: confirmS }))).toBe(toHex(s.signed(1n, toS, 3n).signature));
    const otherS = withdrawMessage(s.vault, s.mint, 1n, toS, 4n, s.keyAt(2).keyId);
    const freshS = createMemoryVaultKeyLedger();
    await expect(sdkSignWithdrawal(cs, "localnet", s.keyAt(1), s.keyAt(2).pk, otherS, { ...LOCAL, ledger: freshS, confirm: confirmS })).rejects.toThrow(/already signed a different withdrawal in this session/);
    expect(await freshS.list()).toEqual([]);

    // recordPendingWithdrawal arms the module it runs in, even for a search made elsewhere (another module instance).
    const { w: g, payer: gp } = await opened(88);
    const cg = g.conn.asConnection();
    const revealedG = await buildWithdrawTx(cg, gp, g.signed(1n, dest, 30n));
    g.conn.addTransaction("revealed-88", revealedG.tx, [g.vault, revealedG.payout], { InstructionError: [0, { Custom: 1 }] });
    const searchG = await findPendingWithdrawal(cg, g.vault);
    const tab = await freshTab();
    await tab.vault.recordPendingWithdrawal(tab.ledger.createMemoryVaultKeyLedger(), searchG);
    const otherG = withdrawMessage(g.vault, g.mint, 1n, walletOf(88), 1n, g.keyAt(2).keyId);
    const freshG = tab.ledger.createMemoryVaultKeyLedger();
    await expect(
      tab.vault.signWithdrawal(cg, "localnet", g.keyAt(1), g.keyAt(2).pk, otherG, { allowLocalnet: true, ledger: freshG, confirm: await confirmAll(cg, walletOf(88), g.mint, g.vault) }),
    ).rejects.toThrow(/already signed a different withdrawal in this session/);
    expect(await freshG.list()).toEqual([]);
  });

  it("records of SDK 0.2.0 (no key) are completed with their key, and an import says when the other device could not carry one (review finding)", async () => {
    // Regression: a signed record without its key was left out of the export (`skipped: no-key`) and the import
    // ignored `skipped`: the other device learned nothing and signed another withdrawal with that key.
    const mint = key("vault-v020/mint");
    const k0 = deriveVaultKey(master, "devnet", mint, 0, 0);
    const k1 = deriveVaultKey(master, "devnet", mint, 0, 1);
    const vault = vaultAddress(mint, k0.keyId);
    const msgA = withdrawMessage(vault, mint, 0n, key("vault-v020/alice"), 10n, k1.keyId);
    const sigA = lmots.signDeterministic(skOf(k0), msgA);
    const v020 = (status: "signed" | "reserved", message: Uint8Array, signature: Uint8Array | null): string =>
      JSON.stringify({
        keyId: toHex(k0.keyId),
        vault: vault.toBase58(),
        sequence: "0",
        message: toHex(message),
        messageHash: toHex(sha256(message)),
        status,
        signature: signature === null ? null : toHex(signature),
        key: null,
        nextKey: signature === null ? null : { id: toHex(k1.pk.id), q: 1, k: toHex(k1.pk.k) },
        origin: "signed",
        createdAt: 1,
        updatedAt: 1,
      });
    const recordKey = `noised/pq/vault-ledger/v1/key/${toHex(k0.keyId)}`;
    // Device A's store as 0.2.0 left it: signed (revealed by a simulation, say), never landed.
    const storeA = memoryLeafLedgerStore();
    await storeA.put(recordKey, v020("signed", msgA, sigA));
    const ledgerA = createVaultKeyLedger(storeA);
    const exported = await exportVaultKeyRecords(ledgerA);
    expect([exported.records.length, exported.skipped]).toEqual([0, [{ keyId: toHex(k0.keyId), reason: "no-key" }]]);
    // The import says so: that key is spent although nothing could be written for it.
    const deviceB = createMemoryVaultKeyLedger();
    expect(await importVaultKeyRecords(deviceB, JSON.parse(JSON.stringify(exported)))).toEqual({ added: 0, merged: 0, unchanged: 0, conflicts: [], compromised: [], unverifiable: [toHex(k0.keyId)] });
    expect(await deviceB.list()).toEqual([]);
    // A skipped list that is missing or malformed is not an export.
    await expect(importVaultKeyRecords(deviceB, { format: exported.format, records: [] } as never)).rejects.toThrow(/not a vault-key ledger export/);
    await expect(importVaultKeyRecords(deviceB, { ...exported, skipped: [{ keyId: "zz", reason: "no-key" }] })).rejects.toThrow(/skipped list is malformed/);
    // Device A completes its records with the phrase (nothing is signed); the export then carries the key.
    const other = deriveVaultKey(master, "devnet", key("vault-v020/other-mint"), 0, 0);
    const otherVault = vaultAddress(key("vault-v020/other-mint"), other.keyId);
    const otherMsg = withdrawMessage(otherVault, key("vault-v020/other-mint"), 0n, key("vault-v020/alice"), 1n, deriveVaultKey(master, "devnet", key("vault-v020/other-mint"), 0, 1).keyId);
    await storeA.put(`noised/pq/vault-ledger/v1/key/${toHex(other.keyId)}`, v020("signed", otherMsg, lmots.signDeterministic(skOf(other), otherMsg)).replaceAll(toHex(k0.keyId), toHex(other.keyId)).replace(vault.toBase58(), otherVault.toBase58()));
    expect(await completeVaultKeyRecords(ledgerA, master, "devnet", mint, 3)).toEqual({ completed: [toHex(k0.keyId)], remaining: [toHex(other.keyId)] });
    expect((await ledgerA.get(k0.keyId))?.key).toEqual({ id: toHex(k0.pk.id), q: 0, k: toHex(k0.pk.k) });
    const again = await exportVaultKeyRecords(ledgerA, { vault });
    expect([again.records.length, again.skipped]).toEqual([1, []]);
    expect(await importVaultKeyRecords(deviceB, JSON.parse(JSON.stringify(again)))).toMatchObject({ added: 1, unverifiable: [] });
    expect(await deviceB.reserve(k0.keyId, withdrawMessage(vault, mint, 0n, key("vault-v020/bob"), 999n, k1.keyId), { vault, sequence: 0n, key: k0.pk })).toBe("conflict");
    await expect(completeVaultKeyRecords(ledgerA, master, "devnet", mint, 1_001)).rejects.toThrow(/maxAccount/);

    // prepareWithdrawal completes the record of the key it uses: re-broadcasting a 0.2.0 signature ...
    const { w } = await opened(86);
    const c = w.conn.asConnection();
    const to = walletOf(176);
    const k = w.keyAt(1);
    const msg = withdrawMessage(w.vault, w.mint, 1n, to, 4n, w.keyAt(2).keyId);
    const legacy = (status: "signed" | "reserved", signature: Uint8Array | null): string =>
      v020(status, msg, signature).replaceAll(toHex(k0.keyId), toHex(k.keyId)).replace(vault.toBase58(), w.vault.toBase58()).replace('"sequence":"0"', '"sequence":"1"').replace(toHex(k1.pk.id), toHex(w.keyAt(2).pk.id)).replace(toHex(k1.pk.k), toHex(w.keyAt(2).pk.k)).replace('"q":1', '"q":2');
    const signedStore = memoryLeafLedgerStore();
    await signedStore.put(`noised/pq/vault-ledger/v1/key/${toHex(k.keyId)}`, legacy("signed", lmots.signDeterministic(skOf(k), msg)));
    const signedLedger = createVaultKeyLedger(signedStore);
    expect((await signedLedger.get(k.keyId))?.key).toBeNull();
    const confirm = await confirmAll(c, to, w.mint, w.vault);
    const r = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 86, { destinationOwner: to, maxAmount: 4n }, { ...LOCAL, ledger: signedLedger, confirm });
    expect(r.signed?.reused).toBe(true);
    expect((await signedLedger.get(k.keyId))?.key).toEqual({ id: toHex(k.pk.id), q: 1, k: toHex(k.pk.k) });
    expect((await exportVaultKeyRecords(signedLedger)).records.length).toBe(1);
    // ... and finishing a 0.2.0 reservation (signed now, then given its key).
    const reservedStore = memoryLeafLedgerStore();
    await reservedStore.put(`noised/pq/vault-ledger/v1/key/${toHex(k.keyId)}`, legacy("reserved", null));
    const reservedLedger = createVaultKeyLedger(reservedStore);
    const finished = await sdkPrepareWithdrawal(c, master, "localnet", w.mint, 86, { destinationOwner: to, maxAmount: 4n }, { ...LOCAL, ledger: reservedLedger, confirm });
    expect(finished.signed?.reused).toBe(false);
    expect(await reservedLedger.get(k.keyId)).toMatchObject({ status: "signed", key: { q: 1, k: toHex(k.pk.k) } });
    expect((await exportVaultKeyRecords(reservedLedger)).skipped).toEqual([]);
  });
});

describe("createVaultKeyLedger: records keyed by the one-time key", () => {
  const mint = key("vault-ledger/mint");
  const vault = key("vault-ledger/vault");
  const dest = key("vault-ledger/dest");
  const k1 = deriveVaultKey(master, "localnet", mint, 97, 1);
  const k2 = deriveVaultKey(master, "localnet", mint, 97, 2);
  const keyId = k1.keyId;
  const nextKey = k2.pk;
  const msgOf = (amount: bigint): Uint8Array => withdrawMessage(vault, mint, 1n, dest, amount, k2.keyId);
  const sigOf = (amount: bigint): Uint8Array => lmots.signDeterministic(skOf(k1), msgOf(amount));
  const info = { vault, sequence: 1n, key: k1.pk };

  it("reserved, same, conflict; a record is never given to another message; an unreadable one is taken", async () => {
    const store = memoryLeafLedgerStore();
    const ledger = createVaultKeyLedger(store);
    expect(await ledger.reserve(keyId, msgOf(1n), info)).toBe("reserved");
    expect(await ledger.reserve(keyId, msgOf(1n), info)).toBe("same");
    expect(await ledger.reserve(keyId, msgOf(2n), info)).toBe("conflict");
    await expect(ledger.recordSignature(keyId, msgOf(2n), sigOf(2n), nextKey)).rejects.toThrow(/another withdrawal/);
    await ledger.recordSignature(keyId, msgOf(1n), sigOf(1n), nextKey);
    // A different signature of the same message (another randomizer) is refused.
    const other = lmots.sign(skOf(k1), msgOf(1n), new Uint8Array(32).fill(9));
    await expect(ledger.recordSignature(keyId, msgOf(1n), other, nextKey)).rejects.toThrow(/different signature/);
    await expect(ledger.adoptFound(keyId, msgOf(2n), sigOf(2n), nextKey, info)).rejects.toThrow(VaultKeyInUseError);
    expect(await ledger.get(keyId)).toMatchObject({
      status: "signed",
      messageHash: toHex(sha256(msgOf(1n))),
      vault: vault.toBase58(),
      sequence: "1",
      origin: "signed",
      key: { id: toHex(k1.pk.id), q: 1, k: toHex(k1.pk.k) },
      nextKey: { id: toHex(k2.pk.id), q: 2, k: toHex(k2.pk.k) },
    });
    expect((await ledger.list()).map((r) => r.keyId)).toEqual([toHex(keyId)]);
    // A record nobody can parse counts as taken, never as free.
    const [k] = await store.keys("noised/pq/vault-ledger/v1/");
    await store.put(k!, "{not json");
    expect(await ledger.reserve(keyId, msgOf(1n), info)).toBe("conflict");
    await expect(ledger.get(keyId)).rejects.toThrow(VaultLedgerError);
    await expect(ledger.list()).rejects.toThrow(VaultLedgerError);
    // Concurrent reservations of one key: exactly one wins, even without a lock (the atomic add alone).
    const bare = createVaultKeyLedger(memoryLeafLedgerStore(), { lock: (_name, fn) => fn() });
    const results = await Promise.all([bare.reserve(keyId, msgOf(1n), info), bare.reserve(keyId, msgOf(2n), info), bare.reserve(keyId, msgOf(3n), info)]);
    expect(results.filter((r) => r === "reserved").length).toBe(1);
    // Inputs are checked.
    await expect(ledger.reserve(keyId.subarray(1), msgOf(1n), info)).rejects.toThrow(/32 bytes/);
    await expect(ledger.reserve(keyId, msgOf(1n).subarray(1), info)).rejects.toThrow(/185-byte/);
  });

  it("a record holds its one-time key, and every signature it records verifies under that key (SDK v2 follow-up)", async () => {
    const ledger = createMemoryVaultKeyLedger();
    // The key is required, must hash to the key id, sit at q = sequence and match the message's vault and sequence.
    await expect(ledger.reserve(keyId, msgOf(1n), { vault, sequence: 1n } as never)).rejects.toThrow(/info\.key .* is required/);
    await expect(ledger.reserve(keyId, msgOf(1n), { ...info, key: k2.pk })).rejects.toThrow(/does not hash to the key id/);
    await expect(ledger.reserve(k2.keyId, msgOf(1n), { ...info, key: k2.pk })).rejects.toThrow(/key-index binding/);
    await expect(ledger.reserve(keyId, msgOf(1n), { ...info, vault: key("vault-ledger/elsewhere") })).rejects.toThrow(/another vault or sequence/);
    expect(await ledger.list()).toEqual([]);
    expect(await ledger.reserve(keyId, msgOf(1n), info)).toBe("reserved");
    // A signature that does not verify under the recorded key, or a next key the message does not name, is never recorded.
    await expect(ledger.recordSignature(keyId, msgOf(1n), sigOf(1n).map((b, i) => (i === 40 ? b ^ 1 : b)), nextKey)).rejects.toThrow(/does not verify under the recorded key/);
    await expect(ledger.recordSignature(keyId, msgOf(1n), lmots.signDeterministic(skOf(k2), msgOf(1n)), nextKey)).rejects.toThrow(/does not verify/);
    await expect(ledger.recordSignature(keyId, msgOf(1n), sigOf(1n), k1.pk)).rejects.toThrow(/next key does not hash/);
    expect((await ledger.get(keyId))?.status).toBe("reserved");
    await ledger.recordSignature(keyId, msgOf(1n), sigOf(1n), nextKey);
    // adoptFound verifies a found signature under the key too, before writing anything.
    const fresh = createMemoryVaultKeyLedger();
    await expect(fresh.adoptFound(keyId, msgOf(1n), sigOf(2n), nextKey, info)).rejects.toThrow(/found signature does not verify/);
    await expect(fresh.adoptFound(keyId, msgOf(1n), sigOf(1n), nextKey, { ...info, key: k2.pk })).rejects.toThrow(/does not hash to the key id/);
    expect(await fresh.list()).toEqual([]);
    await fresh.adoptFound(keyId, msgOf(1n), sigOf(1n), null, info);
    expect(await fresh.get(keyId)).toMatchObject({ origin: "found", key: { q: 1 }, nextKey: null });
  });
});

describe("vault-key ledger export / import (several devices holding one phrase)", () => {
  const mint = key("vault-sync/mint");
  const vault = key("vault-sync/vault");
  const keysAt = (s: number) => deriveVaultKey(master, "localnet", mint, 98, s);
  const msgAt = (s: number, amount: bigint): Uint8Array => withdrawMessage(vault, mint, BigInt(s), key("vault-sync/dest"), amount, keysAt(s + 1).keyId);
  /** A ledger in which key `s` signed `amount`, as prepareWithdrawal leaves it. */
  async function signedIn(ledger: VaultKeyLedger, s: number, amount: bigint): Promise<Uint8Array> {
    const k = keysAt(s);
    const msg = msgAt(s, amount);
    expect(await ledger.reserve(k.keyId, msg, { vault, sequence: BigInt(s), key: k.pk })).toBe("reserved");
    const sig = lmots.signDeterministic(skOf(k), msg);
    await ledger.recordSignature(k.keyId, msg, sig, keysAt(s + 1).pk);
    return sig;
  }

  it("export / import: the other device's signed keys become taken here; the same withdrawal is completed; JSON round trip", async () => {
    const deviceA = createMemoryVaultKeyLedger();
    const deviceB = createMemoryVaultKeyLedger();
    const sig1 = await signedIn(deviceA, 1, 10n);
    await signedIn(deviceA, 2, 20n);
    // Reservations that never signed are not exported (nothing to authenticate, nothing revealed).
    expect(await deviceA.reserve(keysAt(3).keyId, msgAt(3, 30n), { vault, sequence: 3n, key: keysAt(3).pk })).toBe("reserved");
    const exported = await exportVaultKeyRecords(deviceA);
    expect([exported.format, exported.records.map((r) => r.sequence).sort(), exported.skipped]).toEqual([VAULT_KEY_LEDGER_EXPORT_FORMAT, ["1", "2"], [{ keyId: toHex(keysAt(3).keyId), reason: "reserved" }]]);
    expect((await exportVaultKeyRecords(deviceA, { vault: key("vault-sync/other") })).records).toEqual([]);
    // Device B had reserved key 1 for the same withdrawal (never signed): completed. Key 2 was unknown: added.
    expect(await deviceB.reserve(keysAt(1).keyId, msgAt(1, 10n), { vault, sequence: 1n, key: keysAt(1).pk })).toBe("reserved");
    const wire = JSON.parse(JSON.stringify(exported)) as typeof exported;
    expect(await importVaultKeyRecords(deviceB, wire)).toEqual({ added: 1, merged: 1, unchanged: 0, conflicts: [], compromised: [], unverifiable: [] });
    expect(await deviceB.get(keysAt(1).keyId)).toMatchObject({ status: "signed", signature: toHex(sig1), origin: "signed" });
    expect(await deviceB.get(keysAt(2).keyId)).toMatchObject({ status: "signed", origin: "imported", sequence: "2" });
    // Device B can never sign another withdrawal with key 2 now.
    expect(await deviceB.reserve(keysAt(2).keyId, msgAt(2, 999n), { vault, sequence: 2n, key: keysAt(2).pk })).toBe("conflict");
    // Importing again changes nothing.
    expect(await importVaultKeyRecords(deviceB, wire)).toEqual({ added: 0, merged: 0, unchanged: 2, conflicts: [], compromised: [], unverifiable: [] });
  });

  it("conflicts are reported: a local reservation of another withdrawal gives way; a local signature of another withdrawal is a compromised key (nothing written)", async () => {
    const deviceA = createMemoryVaultKeyLedger();
    await signedIn(deviceA, 1, 10n);
    await signedIn(deviceA, 2, 20n);
    const exported = await exportVaultKeyRecords(deviceA);
    const deviceB = createMemoryVaultKeyLedger();
    // B reserved key 1 for 11 (never signed) and SIGNED key 2 for 21: both before syncing.
    expect(await deviceB.reserve(keysAt(1).keyId, msgAt(1, 11n), { vault, sequence: 1n, key: keysAt(1).pk })).toBe("reserved");
    const bSig2 = await signedIn(deviceB, 2, 21n);
    const summary = await importVaultKeyRecords(deviceB, exported);
    expect({ ...summary, conflicts: [...summary.conflicts].sort() }).toEqual({
      added: 0,
      merged: 0,
      unchanged: 0,
      conflicts: [toHex(keysAt(1).keyId), toHex(keysAt(2).keyId)].sort(),
      compromised: [toHex(keysAt(2).keyId)],
      unverifiable: [],
    });
    // Key 1: A's signature replaced B's unsigned reservation; B can never sign its own request now.
    expect(await deviceB.get(keysAt(1).keyId)).toMatchObject({ status: "signed", origin: "imported", messageHash: toHex(sha256(msgAt(1, 10n))) });
    await expect(deviceB.recordSignature(keysAt(1).keyId, msgAt(1, 11n), lmots.signDeterministic(skOf(keysAt(1)), msgAt(1, 11n)), keysAt(2).pk)).rejects.toThrow(/another withdrawal/);
    // Key 2: B's own signature stays (never reassigned); the key is reported compromised.
    expect((await deviceB.get(keysAt(2).keyId))?.signature).toBe(toHex(bSig2));
  });

  it("authenticated: nothing is written if any record fails (forged signature, foreign key, edited message, unsigned, keyless, duplicates)", async () => {
    const deviceA = createMemoryVaultKeyLedger();
    await signedIn(deviceA, 1, 10n);
    await signedIn(deviceA, 2, 20n);
    const good = await exportVaultKeyRecords(deviceA);
    const r1 = good.records.find((r) => r.sequence === "1")!;
    const r2: VaultKeyRecord = good.records.find((r) => r.sequence === "2")!;
    const flip = (hex: string, at: number): string => hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
    const otherMsg = msgAt(2, 21n);
    const forgeries: [string, VaultKeyRecord, RegExp][] = [
      ["forged signature", { ...r2, signature: flip(r2.signature!, 100) }, /does not verify/],
      ["signature of another message", { ...r2, signature: toHex(lmots.signDeterministic(skOf(keysAt(2)), otherMsg)) }, /does not verify/],
      ["edited message (hash kept)", { ...r2, message: toHex(otherMsg) }, /does not hash to its message hash/],
      ["edited message and hash", { ...r2, message: toHex(otherMsg), messageHash: toHex(sha256(otherMsg)) }, /does not verify/],
      ["another key", { ...r2, key: { id: toHex(keysAt(5).pk.id), q: 2, k: toHex(keysAt(5).pk.k) } }, /does not hash to its key id/],
      ["key of another index", { ...r2, keyId: toHex(keysAt(3).keyId), key: { id: toHex(keysAt(3).pk.id), q: 3, k: toHex(keysAt(3).pk.k) } }, /q = 3, but the key of sequence 2/],
      ["another vault", { ...r2, vault: key("vault-sync/elsewhere").toBase58() }, /another vault or sequence/],
      ["wrong next key", { ...r2, nextKey: { id: toHex(keysAt(4).pk.id), q: 4, k: toHex(keysAt(4).pk.k) } }, /next key does not hash/],
      ["unsigned", { ...r2, status: "reserved", signature: null }, /holds no signature/],
      ["keyless (SDK 0.2.0)", { ...r2, key: null }, /holds no key/],
      ["malformed", { ...r2, sequence: "two" }, /malformed/],
    ];
    for (const [name, bad, why] of forgeries) {
      const target = createMemoryVaultKeyLedger();
      await expect(importVaultKeyRecords(target, { ...good, records: [r1, bad] }), name).rejects.toThrow(why);
      expect(await target.list(), name).toEqual([]); // r1 (valid, first) was not written either
      await expect(target.importRecord(bad), name).rejects.toThrow(VaultLedgerError);
    }
    const target = createMemoryVaultKeyLedger();
    await expect(importVaultKeyRecords(target, { ...good, records: [r1, r2, r1] })).rejects.toThrow(/twice/);
    await expect(importVaultKeyRecords(target, { ...good, format: "noised/pq/leaf-ledger-export/v1" } as never)).rejects.toThrow(/not a vault-key ledger export/);
    expect(await target.list()).toEqual([]);
    expect(await importVaultKeyRecords(target, good)).toMatchObject({ added: 2 });
  });
});

// --------------------------------------------------- throwaway fee payer ---

describe("throwaway fee payer", () => {
  it("fund it, then refund everything but the fee", async () => {
    const c = new MockConnection();
    const owner = key("fp/owner");
    const fp = Keypair.generate();
    const fund = await buildFundFeePayerTx(c.asConnection(), owner, fp.publicKey);
    expect(fund.instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
    c.set(fp.publicKey, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: 6_000_000 });
    const refund = await buildRefundFeePayerTx(c.asConnection(), fp, owner);
    expect(refund.signatures[0]!.signature).not.toBeNull();
    const lamports = new DataView(refund.instructions[0]!.data.buffer, refund.instructions[0]!.data.byteOffset).getBigUint64(4, true);
    expect(lamports).toBe(6_000_000n - 5_000n);
  });
});
