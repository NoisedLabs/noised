/**
 * Byte-for-byte parity with the Rust side for vault v4, using the vectors
 * tests/integration/tests/sdk_vectors.rs writes from the program crate
 * (`noised_vault::message::withdraw_message`, its Anchor client types and
 * state types), `noised-lmots`, `solana-message` 4.6 (v1 compile) and
 * `solana-transaction` 4.3 (v1 wire format): test/vectors/vault_withdraw.json,
 * a byte-identical copy of tests/integration/vectors/vault_withdraw.json (the
 * SDK's tests read nothing outside sdk/; re-copy it when the Rust side
 * regenerates it).
 *
 * Covered: SPEC §3.10 key derivation (account, sequence) on all three
 * clusters, the HMAC randomizer and the signature a client makes, the
 * 185-byte message, the LM-OTS signature for a fixed randomizer, PDAs,
 * every vault instruction, borsh of the vault's types and accounts, the
 * signed v1 wire bytes of `withdraw` and of `withdraw + release`, and the
 * vault key-index binding (genesis `q = 0`, next key `q = sequence + 1`).
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import { concatBytes, toHex, u32le, u64le } from "../src/codec/bytes.js";
import { buildInstruction } from "../src/codec/ix.js";
import { CLUSTERS, KNOWN_ACCOUNTS, PROGRAM_IDS, VAULT, type Cluster } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import {
  associatedTokenAddress,
  certificateAddress,
  commitAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  hookAuthorityAddress,
  hookPolicyAddress,
  launchPdasFromLaunch,
  payoutAddress,
  protocolAddress,
  vaultAddress,
} from "../src/pda.js";
import { derivationPath, deriveVaultKey, GENESIS_KEY_INDEX, nextKeyIndex } from "../src/pq/keys.js";
import * as lmots from "../src/pq/lmots.js";
import {
  buildOpenVaultTx,
  buildReleaseToTx,
  buildReleaseTx,
  buildWithdrawTx,
  checkRecipient,
  decodePayout,
  decodeVault,
  parseWithdrawMessage,
  randomizer,
  signWithdrawal,
  withdrawMessage,
} from "../src/pq/vault.js";
import { compileV1Message, decodeV1Transaction, verifyV1Signatures } from "../src/tx/v1.js";
import { createMemoryVaultKeyLedger } from "../src/pq/vaultLedger.js";
import { ext, hex, MockConnection, mintBytes, readJson, tokenAccountBytes } from "./helpers.js";

interface IxJson {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
interface KeyJson {
  account: number;
  sequence: number;
  seed: string;
  id: string;
  q: number;
  k: string;
  keyId: string;
}
interface V1Json {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  header: number[];
  accountKeys: string[];
  message: string;
  wire: string;
}
interface WithdrawalCase {
  name: string;
  inputs: {
    cluster: number;
    master: string;
    mint: string;
    account: number;
    tokenProgram: string;
    hook: boolean;
    sequence: string;
    destinationOwner: string;
    maxAmount: string;
    releaseToDestination: string;
    feePayerSeed: string;
    feePayer: string;
    recentBlockhash: string;
    randomizer: string;
  };
  genesisKey: KeyJson;
  key: KeyJson;
  nextKey: KeyJson;
  addresses: { vault: string; vaultTokenAccount: string; payout: string; destination: string };
  message: string;
  signature: string;
  /** `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" | I | u32be(q) | message)` and the signature a client makes with it. */
  derivedRandomizer: string;
  derivedSignature: string;
  openVaultIx: IxJson;
  withdrawIx: IxJson;
  releaseIx: IxJson;
  releaseToIx: IxJson;
  v1Withdraw: V1Json;
  v1WithdrawRelease: V1Json;
}
interface Vectors {
  source: string;
  programs: Record<string, string>;
  withdrawals: WithdrawalCase[];
  derivation: {
    master: string;
    mint: string;
    keys: (KeyJson & { cluster: number; path: string; vault: string })[];
  };
  randomizer: { seed: string; id: string; q: number; message: string; tag: string; construction: string; c: string };
  pdas: Record<string, string | number>;
  borsh: {
    vaultKey: { id: string; q: number; k: string };
    withdrawArgs: { destinationOwner: string; maxAmount: string; nextKeyId: string };
    withdrawData: string;
    openVaultKeyId: string;
    openVaultData: string;
    releaseData: string;
    releaseToData: string;
    vaultAccount: { mint: string; genesisKeyId: string; sequence: string; keyId: string; reserved: string; bump: number; data: string };
    payoutAccount: { vault: string; sequence: string; destinationOwner: string; amount: string; rentPayer: string; bump: number; data: string };
  };
}

const vectors = readJson<Vectors>("./vectors/vault_withdraw.json");

/** The SDK's cluster name for a SPEC §3.10 cluster byte. */
function clusterOf(id: number): Cluster {
  const name = (Object.keys(CLUSTERS) as Cluster[]).find((c) => CLUSTERS[c].id === id);
  if (name === undefined) throw new Error(`unknown cluster byte ${id}`);
  return name;
}

const pk = (s: string): PublicKey => new PublicKey(s);
const metas = (ix: TransactionInstruction): IxJson["accounts"] => ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }));
const keyOf = (k: KeyJson): lmots.LmotsPublicKey => ({ id: hex(k.id), q: k.q, k: hex(k.k) });
const ixOf = (j: IxJson): TransactionInstruction =>
  new TransactionInstruction({ programId: pk(j.programId), keys: j.accounts.map((a) => ({ pubkey: pk(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(hex(j.data)) });

/** Vault account bytes as the program writes them: genesis key `g`, current key `k` at `sequence`. */
function vaultData(mint: PublicKey, g: KeyJson, k: KeyJson, sequence: bigint, reserved = 0n): Uint8Array {
  const codec = idlCodecs().vault;
  const [, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), mint.toBytes(), hex(g.keyId)], PROGRAM_IDS.vault);
  return concatBytes([
    codec.accountDiscriminator("Vault"),
    codec.encodeType("Vault", { version: 4, bump, mint, genesisKeyId: hex(g.keyId), sequence, keyId: hex(k.keyId), keyIdent: hex(k.id), keyQ: k.q, keyK: hex(k.k), reserved }),
  ]);
}

function mintFor(c: WithdrawalCase): Uint8Array {
  const mint = pk(c.inputs.mint);
  return c.inputs.hook ? mintBytes({ decimals: 6, extensions: [ext.metadataPointer(null, mint), ext.transferHook(null, PROGRAM_IDS.hook)] }) : mintBytes({ decimals: 9 });
}

describe("Rust-produced key derivation and randomizer (SPEC §3.10)", () => {
  const d = vectors.derivation;
  const master = hex(d.master);
  const mint = pk(d.mint);

  it("derives every Rust key: path, SEED, I, q, K, key id and the account's vault", () => {
    expect(d.keys.map((k) => k.cluster).sort()).toEqual([0, 1, 2, 2, 2, 2]);
    for (const k of d.keys) {
      const cluster = clusterOf(k.cluster);
      const label = `${cluster} account ${k.account} sequence ${k.sequence}`;
      expect(toHex(derivationPath(cluster, mint, k.account, k.sequence)), label).toBe(k.path);
      expect(k.path.length, label).toBe(2 * 41);
      const key = deriveVaultKey(master, cluster, mint, k.account, k.sequence);
      expect([toHex(key.skSeed), toHex(key.pk.id), key.pk.q, toHex(key.pk.k), toHex(key.keyId)], label).toEqual([k.seed, k.id, k.q, k.k, k.keyId]);
      expect(k.q).toBe(k.sequence);
      const genesis = deriveVaultKey(master, cluster, mint, k.account, 0);
      expect(vaultAddress(mint, genesis.keyId).toBase58(), label).toBe(k.vault);
    }
  });

  it("the randomizer known answer, with the crate's construction", () => {
    const r = vectors.randomizer;
    expect(r.tag).toBe(VAULT.RANDOMIZER_TAG);
    expect(r.construction).toMatch(/HMAC-SHA256\(key = seed/);
    expect(toHex(lmots.randomizer({ id: hex(r.id), q: r.q, seed: hex(r.seed) }, hex(r.message)))).toBe(r.c);
    expect(r.c).toBe("efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3");
  });
});

describe("Rust-produced vault v4 vectors", () => {
  it("are v4 vectors and cover the program ids", () => {
    // The vector file is pinned byte for byte: its provenance names the program before the rename to Noised.
    expect(vectors.source).toMatch(/phalanx_vault v4/);
    expect(vectors.programs["vault"]).toBe(PROGRAM_IDS.vault.toBase58());
    expect(vectors.programs["hook"]).toBe(PROGRAM_IDS.hook.toBase58());
    expect(vectors.programs["launchpad"]).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect(vectors.programs["memo"]).toBe(KNOWN_ACCOUNTS.memo.toBase58());
    expect(vectors.programs["associatedToken"]).toBe(KNOWN_ACCOUNTS.associatedToken.toBase58());
    expect(vectors.programs["system"]).toBe(KNOWN_ACCOUNTS.system.toBase58());
    expect(vectors.withdrawals.map((w) => w.name)).toEqual(["spl", "t22-hook"]);
  });

  for (const c of vectors.withdrawals) {
    describe(`withdrawal case ${c.name}`, () => {
      const mint = pk(c.inputs.mint);
      const tp = pk(c.inputs.tokenProgram);
      const sequence = BigInt(c.inputs.sequence);
      const vault = pk(c.addresses.vault);
      const dest = pk(c.inputs.destinationOwner);
      const maxAmount = BigInt(c.inputs.maxAmount);
      const feePayer = Keypair.fromSeed(hex(c.inputs.feePayerSeed));

      /** The vault at the case's sequence, held by its key; balance 1,000. */
      function chain(): MockConnection {
        const conn = new MockConnection();
        conn.blockhash = c.inputs.recentBlockhash;
        conn.set(mint, { owner: tp, data: mintFor(c) });
        conn.set(vault, { owner: PROGRAM_IDS.vault, data: vaultData(mint, c.genesisKey, c.key, sequence) });
        conn.set(pk(c.addresses.vaultTokenAccount), { owner: tp, data: tokenAccountBytes({ mint, owner: vault, amount: 1_000n, token2022: c.inputs.hook }) });
        return conn;
      }

      it("derives the genesis, current and next keys exactly like the Rust client", () => {
        const master = hex(c.inputs.master);
        expect([c.genesisKey.sequence, c.key.sequence, c.nextKey.sequence]).toEqual([0, Number(sequence), Number(sequence) + 1]);
        for (const k of [c.genesisKey, c.key, c.nextKey]) {
          expect(k.account).toBe(c.inputs.account);
          const d = deriveVaultKey(master, clusterOf(c.inputs.cluster), mint, k.account, k.sequence);
          expect([toHex(d.skSeed), toHex(d.pk.id), d.pk.q, toHex(d.pk.k), toHex(d.keyId)]).toEqual([k.seed, k.id, k.q, k.k, k.keyId]);
        }
      });

      it("signs like a client: the HMAC randomizer and the deterministic signature", async () => {
        const cluster = clusterOf(c.inputs.cluster);
        const k = deriveVaultKey(hex(c.inputs.master), cluster, mint, c.key.account, c.key.sequence);
        const next = deriveVaultKey(hex(c.inputs.master), cluster, mint, c.nextKey.account, c.nextKey.sequence);
        const msg = hex(c.message);
        expect(toHex(randomizer(k.skSeed, k.pk, msg))).toBe(c.derivedRandomizer);
        const conn = chain().asConnection();
        const ledger = createMemoryVaultKeyLedger();
        // The user confirmed the recipient check of this withdrawal first (required by every vault signer).
        const m = parseWithdrawMessage(msg);
        const confirm = { recipient: await checkRecipient(conn, m.destinationOwner, m.mint, m.vault), acknowledged: { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true } };
        const sig = await signWithdrawal(conn, cluster, k, next.pk, msg, { allowLocalnet: true, ledger, confirm });
        expect(toHex(sig)).toBe(c.derivedSignature);
        // Again: the identical signature, never a second one (read back from the ledger).
        expect(toHex(await signWithdrawal(conn, cluster, k, next.pk, msg, { allowLocalnet: true, ledger, confirm }))).toBe(c.derivedSignature);
        expect((await ledger.get(k.keyId))?.signature).toBe(c.derivedSignature);
        expect(lmots.verify(keyOf(c.key), msg, sig)).toBe(true);
      });

      it("key-index binding: genesis q = 0, the signing key q = sequence, the next key q = sequence + 1; anything else is refused", async () => {
        expect(c.genesisKey.q).toBe(GENESIS_KEY_INDEX);
        expect(c.key.q).toBe(Number(sequence));
        expect(c.nextKey.q).toBe(nextKeyIndex(sequence));
        // withdraw's data ends with the next key: I || u32le(q) || K.
        expect(c.withdrawIx.data.endsWith(c.nextKey.id + toHex(u32le(c.nextKey.q)) + c.nextKey.k)).toBe(true);
        // A next key of another position (here sequence + 2) hashes fine but can never execute (InvalidKeyIndex).
        const cluster = clusterOf(c.inputs.cluster);
        const master = hex(c.inputs.master);
        const k = deriveVaultKey(master, cluster, mint, c.key.account, c.key.sequence);
        const skipped = deriveVaultKey(master, cluster, mint, c.key.account, c.nextKey.sequence + 1);
        const msg = withdrawMessage(vault, mint, sequence, dest, maxAmount, skipped.keyId);
        const confirm = { recipient: await checkRecipient(chain().asConnection(), dest, mint, vault), acknowledged: { recipientWarnings: true, mintWarnings: true, offCurveConfirmation: true } };
        await expect(signWithdrawal(chain().asConnection(), cluster, k, skipped.pk, msg, { allowLocalnet: true, ledger: createMemoryVaultKeyLedger(), confirm })).rejects.toThrow(/InvalidKeyIndex/);
        const args = { mint, vault, sequence, destinationOwner: dest, maxAmount, signature: hex(c.signature), nextKey: skipped.pk, nextKeyId: skipped.keyId };
        await expect(buildWithdrawTx(chain().asConnection(), feePayer, args)).rejects.toThrow(/InvalidKeyIndex/);
        // The genesis key opens; the next key cannot.
        await expect(buildOpenVaultTx(new MockConnection().asConnection(), feePayer.publicKey, mint, keyOf(c.nextKey))).rejects.toThrow(/genesis key/);
      });

      it("vault, payout and token-account addresses", () => {
        expect(vaultAddress(mint, hex(c.genesisKey.keyId)).toBase58()).toBe(c.addresses.vault);
        expect(payoutAddress(vault, sequence).toBase58()).toBe(c.addresses.payout);
        expect(associatedTokenAddress(vault, mint, tp).toBase58()).toBe(c.addresses.vaultTokenAccount);
        expect(associatedTokenAddress(dest, mint, tp).toBase58()).toBe(c.addresses.destination);
      });

      it("builds the 185-byte PHX-PQV4 message byte for byte", () => {
        const msg = withdrawMessage(vault, mint, sequence, dest, maxAmount, hex(c.nextKey.keyId));
        expect(msg.length).toBe(VAULT.WITHDRAW_MESSAGE_LEN);
        expect(toHex(msg)).toBe(c.message);
        expect(new TextDecoder().decode(msg.subarray(0, 8))).toBe("PHX-PQV4");
      });

      it("reproduces the Rust LM-OTS signature for the same randomizer", () => {
        const sig = lmots.sign({ id: hex(c.key.id), q: c.key.q, seed: hex(c.key.seed) }, hex(c.message), hex(c.inputs.randomizer));
        expect(sig.length).toBe(VAULT.SIGNATURE_LEN);
        expect(toHex(sig)).toBe(c.signature);
        expect(lmots.verify(keyOf(c.key), hex(c.message), sig)).toBe(true);
      });

      it("encodes withdraw exactly like the program's Anchor client", () => {
        const ix = buildInstruction(
          idlCodecs().vault,
          PROGRAM_IDS.vault,
          "withdraw",
          { payer: feePayer.publicKey, mint, vault, vaultTokenAccount: pk(c.addresses.vaultTokenAccount), payout: pk(c.addresses.payout), tokenProgram: tp },
          { args: { signature: hex(c.signature), destinationOwner: dest, maxAmount, nextKeyId: hex(c.nextKey.keyId), nextKey: keyOf(c.nextKey) } },
        );
        expect(metas(ix)).toEqual(c.withdrawIx.accounts);
        expect(toHex(ix.data)).toBe(c.withdrawIx.data);
        expect(ix.data.length).toBe(VAULT.WITHDRAW_IX_DATA_LEN);
      });

      it("compiles both v1 messages exactly like solana-message", () => {
        for (const [ixs, v1] of [
          [[c.withdrawIx], c.v1Withdraw],
          [[c.withdrawIx, c.releaseIx], c.v1WithdrawRelease],
        ] as const) {
          const m = compileV1Message(feePayer.publicKey, ixs.map(ixOf), c.inputs.recentBlockhash, {
            computeUnitLimit: v1.computeUnitLimit,
            loadedAccountsDataSizeLimit: v1.loadedAccountsDataSizeLimit,
          });
          expect(m.accountKeys.map((k) => k.toBase58())).toEqual(v1.accountKeys);
          expect([m.header.numRequiredSignatures, m.header.numReadonlySigned, m.header.numReadonlyUnsigned]).toEqual(v1.header);
          expect(toHex(m.bytes)).toBe(v1.message);
        }
      });

      it("buildWithdrawTx emits the exact v1 wire bytes solana-transaction produces (withdraw, and withdraw + release)", async () => {
        expect(feePayer.publicKey.toBase58()).toBe(c.inputs.feePayer);
        expect(c.v1Withdraw.computeUnitLimit).toBe(VAULT.WITHDRAW_COMPUTE_UNITS);
        expect(c.v1Withdraw.loadedAccountsDataSizeLimit).toBe(VAULT.WITHDRAW_LOADED_ACCOUNTS_BYTES);
        const args = {
          mint,
          vault,
          sequence,
          destinationOwner: dest,
          maxAmount,
          signature: hex(c.signature),
          nextKey: keyOf(c.nextKey),
          nextKeyId: hex(c.nextKey.keyId),
        };
        for (const [includeRelease, v1] of [
          [false, c.v1Withdraw],
          [true, c.v1WithdrawRelease],
        ] as const) {
          // The vectors use SPEC §3.9's 400,000-unit config word; the SDK's default is tighter (VAULT_COMPUTE_UNITS).
          const out = await buildWithdrawTx(chain().asConnection(), feePayer, { ...args, includeRelease }, { computeUnitLimit: VAULT.WITHDRAW_COMPUTE_UNITS });
          expect(toHex(out.tx)).toBe(v1.wire);
          expect(out.tx.length).toBeLessThanOrEqual(4096);
          expect(out.payout.toBase58()).toBe(c.addresses.payout);
          const d = decodeV1Transaction(out.tx);
          expect(toHex(d.message)).toBe(v1.message);
          expect([d.computeUnitLimit, d.loadedAccountsDataSizeLimit, d.signatures.length]).toEqual([400_000, 4 * 1024 * 1024, 1]);
          expect(verifyV1Signatures(d)).toBe(true);
          // Message first, then exactly one 64-byte signature, no length prefix.
          expect(out.tx.length).toBe(d.message.length + 64);
          expect(out.tx[0]).toBe(0x81);
        }
      });

      it("builds open_vault, release and release_to exactly like the program's Anchor client", async () => {
        const fresh = new MockConnection();
        fresh.set(mint, { owner: tp, data: mintFor(c) });
        const open = await buildOpenVaultTx(fresh.asConnection(), feePayer.publicKey, mint, keyOf(c.genesisKey));
        const openIx = open.instructions.at(-1)!;
        expect(metas(openIx)).toEqual(c.openVaultIx.accounts);
        expect(toHex(openIx.data)).toBe(c.openVaultIx.data);

        // After the withdrawal: the vault is at sequence + 1 under the next key, the payout exists.
        const conn = chain();
        const codec = idlCodecs().vault;
        conn.set(vault, { owner: PROGRAM_IDS.vault, data: vaultData(mint, c.genesisKey, c.nextKey, sequence + 1n, 5n) });
        const [, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("payout"), vault.toBytes(), u64le(sequence)], PROGRAM_IDS.vault);
        conn.set(pk(c.addresses.payout), {
          owner: PROGRAM_IDS.vault,
          data: concatBytes([
            codec.accountDiscriminator("Payout"),
            codec.encodeType("Payout", { version: 1, bump, vault, sequence, destinationOwner: dest, amount: 5n, rentPayer: feePayer.publicKey }),
          ]),
        });
        const release = await buildReleaseTx(conn.asConnection(), feePayer.publicKey, { vault, mint, sequence });
        const releaseIx = release.instructions.at(-1)!;
        expect(metas(releaseIx)).toEqual(c.releaseIx.accounts);
        expect(toHex(releaseIx.data)).toBe(c.releaseIx.data);

        const releaseToDestination = pk(c.inputs.releaseToDestination);
        conn.set(releaseToDestination, { owner: tp, data: tokenAccountBytes({ mint, owner: dest, amount: 0n, token2022: c.inputs.hook }) });
        const releaseTo = await buildReleaseToTx(conn.asConnection(), dest, { vault, mint, sequence, destination: releaseToDestination });
        const releaseToIx = releaseTo.instructions.at(-1)!;
        expect(metas(releaseToIx)).toEqual(c.releaseToIx.accounts);
        expect(toHex(releaseToIx.data)).toBe(c.releaseToIx.data);
      });
    });
  }
});

describe("Rust-derived PDAs", () => {
  const p = vectors.pdas as Record<string, string>;
  const mint = pk(p["mint"]!);
  const pool = pk(p["pool"]!);
  const owner = pk(p["owner"]!);

  it("hook, vault, payout, DBC and ATA addresses", () => {
    expect(hookPolicyAddress(mint).toBase58()).toBe(p["hookPolicy"]);
    expect(PublicKey.findProgramAddressSync([new TextEncoder().encode("policy"), mint.toBytes()], PROGRAM_IDS.hook)[1]).toBe(vectors.pdas["hookPolicyBump"]);
    expect(extraAccountMetaListAddress(mint).toBase58()).toBe(p["extraAccountMetaList"]);
    expect(KNOWN_ACCOUNTS.sysvarInstructions.toBase58()).toBe(p["instructionsSysvar"]);
    expect(hookAuthorityAddress().toBase58()).toBe(p["hookAuthority"]);
    expect(dbcTokenVaultAddress(mint, pool).toBase58()).toBe(p["dbcBaseVault"]);
    const vault = vaultAddress(mint, hex(p["keyId"]!));
    expect(vault.toBase58()).toBe(p["vault"]);
    expect(payoutAddress(vault, BigInt(p["payoutSequence"]!)).toBase58()).toBe(p["payout"]);
    expect(payoutAddress(vault, 0n).toBase58()).toBe(p["payoutSequence0"]);
    expect(associatedTokenAddress(owner, mint).toBase58()).toBe(p["ataToken2022"]);
    expect(associatedTokenAddress(owner, mint, KNOWN_ACCOUNTS.splToken).toBase58()).toBe(p["ataToken"]);
  });

  it("launchpad addresses", () => {
    // vault_withdraw.json predates PQ v2's creator-seeded launch PDA
    // (["launch", creator, launch_seed]; checked against lms.json in
    // launch_v2.test.ts): its launch address only roots the launch's own PDAs here.
    const pdas = launchPdasFromLaunch(pk(p["launch"]!));
    expect(pdas.protocol.toBase58()).toBe(p["protocol"]);
    expect(protocolAddress().toBase58()).toBe(p["protocol"]);
    expect(pdas.launchAuthority.toBase58()).toBe(p["launchAuthority"]);
    expect(pdas.batchAuthority.toBase58()).toBe(p["batchAuthority"]);
    expect(pdas.dbcConfig.toBase58()).toBe(p["dbcConfig"]);
    expect(pdas.hookAuthority.toBase58()).toBe(p["hookAuthority"]);
    expect(certificateAddress(mint).toBase58()).toBe(p["certificate"]);
    expect(commitAddress(pdas.launch, owner).toBase58()).toBe(p["commit"]);
  });
});

describe("Rust borsh of the vault's instructions and accounts", () => {
  const b = vectors.borsh;
  const codec = idlCodecs().vault;
  const key = { id: hex(b.vaultKey.id), q: b.vaultKey.q, k: hex(b.vaultKey.k) };
  const signature = Uint8Array.from({ length: 2176 }, (_, i) => i % 251);

  it("withdraw(WithdrawArgs)", () => {
    const args = { signature, destinationOwner: pk(b.withdrawArgs.destinationOwner), maxAmount: BigInt(b.withdrawArgs.maxAmount), nextKeyId: hex(b.withdrawArgs.nextKeyId), nextKey: key };
    const data = codec.encodeInstruction("withdraw", { args });
    expect(toHex(data)).toBe(b.withdrawData);
    expect(data.length).toBe(VAULT.WITHDRAW_IX_DATA_LEN);
    // Hand layout: disc | u32 len | sig | recipient | u64 | [32] | VaultKey { [16] | u32 | [32] }
    const expected = concatBytes([
      Uint8Array.from(codec.instruction("withdraw").discriminator),
      Uint8Array.of(0x80, 0x08, 0, 0),
      signature,
      pk(b.withdrawArgs.destinationOwner).toBytes(),
      Uint8Array.of(0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      hex(b.withdrawArgs.nextKeyId),
      key.id,
      Uint8Array.of(0x04, 0x03, 0x02, 0x01),
      key.k,
    ]);
    expect(toHex(expected)).toBe(b.withdrawData);
    const back = codec.decodeType<{ signature: Uint8Array; maxAmount: bigint; destinationOwner: PublicKey; nextKey: { q: number } }>("WithdrawArgs", hex(b.withdrawData).subarray(8));
    expect(back.maxAmount).toBe(BigInt(b.withdrawArgs.maxAmount));
    expect(back.signature).toEqual(signature);
    expect(back.destinationOwner.toBase58()).toBe(b.withdrawArgs.destinationOwner);
    expect(back.nextKey.q).toBe(0x01020304);
  });

  it("open_vault(key_id, VaultKey), release(), release_to()", () => {
    expect(toHex(codec.encodeInstruction("open_vault", { keyIdArg: hex(b.openVaultKeyId), key }))).toBe(b.openVaultData);
    expect(toHex(codec.encodeInstruction("release"))).toBe(b.releaseData);
    expect(toHex(codec.encodeInstruction("release_to"))).toBe(b.releaseToData);
    expect(toHex(codec.encodeType("VaultKey", key))).toBe(toHex(concatBytes([key.id, Uint8Array.of(4, 3, 2, 1), key.k])));
  });

  it("Vault and Payout account bytes", () => {
    const v = b.vaultAccount;
    const vaultValue = {
      version: 4,
      bump: v.bump,
      mint: pk(v.mint),
      genesisKeyId: hex(v.genesisKeyId),
      sequence: BigInt(v.sequence),
      keyId: hex(v.keyId),
      keyIdent: key.id,
      keyQ: key.q,
      keyK: key.k,
      reserved: BigInt(v.reserved),
    };
    const vaultBytes = concatBytes([codec.accountDiscriminator("Vault"), codec.encodeType("Vault", vaultValue)]);
    expect(toHex(vaultBytes)).toBe(v.data);
    expect(vaultBytes.length).toBe(codec.accountSize("Vault"));
    expect(codec.decodeAccount<{ sequence: bigint; reserved: bigint }>("Vault", hex(v.data))).toMatchObject({ sequence: BigInt(v.sequence), reserved: BigInt(v.reserved) });
    // decodeVault refuses these bytes: they are not at the PDA of their mint and genesis key.
    expect(() => decodeVault(KNOWN_ACCOUNTS.system, hex(v.data))).toThrow(/not the PDA/);

    const p = b.payoutAccount;
    const payoutValue = { version: 1, bump: p.bump, vault: pk(p.vault), sequence: BigInt(p.sequence), destinationOwner: pk(p.destinationOwner), amount: BigInt(p.amount), rentPayer: pk(p.rentPayer) };
    const payoutBytes = concatBytes([codec.accountDiscriminator("Payout"), codec.encodeType("Payout", payoutValue)]);
    expect(toHex(payoutBytes)).toBe(p.data);
    expect(payoutBytes.length).toBe(codec.accountSize("Payout"));
    const decoded = decodePayout(payoutAddress(pk(p.vault), BigInt(p.sequence)), hex(p.data));
    expect([decoded.sequence, decoded.amount, decoded.destinationOwner.toBase58(), decoded.rentPayer.toBase58()]).toEqual([BigInt(p.sequence), BigInt(p.amount), p.destinationOwner, p.rentPayer]);
  });
});
