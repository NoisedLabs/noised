/**
 * The PQ vault functions the app calls (through the adapter, i.e. the SDK)
 * against vectors produced by the Rust code that validators and the vault
 * program run (tests/integration/tests/sdk_vectors.rs: noised_vault v4's
 * message builder and Anchor client types, noised-lmots including its HMAC
 * randomizer, solana-message 4.6 v1 compile, solana-transaction 4.3 wire
 * format). The vector file is read in place
 * (tests/integration/vectors/vault_withdraw.json), so a stale copy can never
 * pass here. The SDK's builders are tested against the same file in
 * sdk/test/vault_vectors.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { toHex } from "../src/lib/format";
import { mockSignDeterministic } from "../src/lib/mock/lmotsSigner";
import {
  associatedTokenAddress,
  certificateAddress,
  CLUSTERS,
  commitAddress,
  decodeV1Transaction,
  deriveVaultKey,
  extraAccountMetaListAddress,
  hookPolicyAddress,
  KNOWN_ACCOUNTS,
  launchPdas,
  launchPdasFromLaunch,
  lmots,
  payoutAddress,
  PROGRAM_IDS,
  VAULT,
  vaultAddress,
  WITHDRAW_MESSAGE_FIELDS,
  withdrawMessage,
  type Cluster,
} from "../src/lib/noised";

interface KeyVector {
  account: number;
  sequence: number;
  seed: string;
  id: string;
  q: number;
  k: string;
  keyId: string;
}
interface IxVector {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}
interface V1Vector {
  header: number[];
  accountKeys: string[];
  message: string;
  wire: string;
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
}
interface Case {
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
    randomizer: string;
    feePayerSeed: string;
    feePayer: string;
  };
  genesisKey: KeyVector;
  key: KeyVector;
  nextKey: KeyVector;
  addresses: { vault: string; vaultTokenAccount: string; payout: string; destination: string };
  message: string;
  signature: string;
  derivedRandomizer: string;
  derivedSignature: string;
  withdrawIx: IxVector;
  releaseIx: IxVector;
  v1Withdraw: V1Vector;
  v1WithdrawRelease: V1Vector;
}
interface Vectors {
  source: string;
  programs: Record<string, string>;
  withdrawals: Case[];
  derivation: { master: string; mint: string; keys: (KeyVector & { cluster: number; path: string; vault: string })[] };
  randomizer: { seed: string; id: string; q: number; message: string; tag: string; c: string };
  pdas: Record<string, string | number>;
}

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/integration/vectors/vault_withdraw.json", import.meta.url)), "utf8")) as Vectors;

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/** The app's cluster name for a SPEC §3.10 cluster byte. */
function clusterOf(id: number): Cluster {
  const name = (Object.keys(CLUSTERS) as Cluster[]).find((c) => CLUSTERS[c].id === id);
  if (name === undefined) throw new Error(`unknown cluster byte ${id}`);
  return name;
}

describe("vault v4 vectors from the Rust programs", () => {
  it("are v4 vectors for the deployed program ids", () => {
    // The vector file is pinned byte for byte: its provenance names the program before the rename to Noised.
    expect(vectors.source).toMatch(/phalanx_vault v4/);
    expect(vectors.programs.vault).toBe(PROGRAM_IDS.vault.toBase58());
    expect(vectors.programs.hook).toBe(PROGRAM_IDS.hook.toBase58());
    expect(vectors.programs.launchpad).toBe(PROGRAM_IDS.launchpad.toBase58());
    expect(vectors.programs.memo).toBe(KNOWN_ACCOUNTS.memo.toBase58());
    expect(vectors.withdrawals.map((c) => c.name)).toEqual(["spl", "t22-hook"]);
  });

  it("derive every key the way the app does: (cluster, mint, account, sequence) on all three clusters", () => {
    const d = vectors.derivation;
    const master = fromHex(d.master);
    const mint = new PublicKey(d.mint);
    expect(new Set(d.keys.map((k) => k.cluster))).toEqual(new Set([0, 1, 2]));
    for (const k of d.keys) {
      const label = `cluster ${k.cluster} account ${k.account} sequence ${k.sequence}`;
      const key = deriveVaultKey(master, clusterOf(k.cluster), mint, k.account, k.sequence);
      expect([toHex(key.skSeed), toHex(key.pk.id), key.pk.q, toHex(key.pk.k), toHex(key.keyId)], label).toEqual([k.seed, k.id, k.q, k.k, k.keyId]);
      // q = sequence; the vault address is the genesis (sequence 0) key's.
      expect(k.q, label).toBe(k.sequence);
      expect(vaultAddress(mint, deriveVaultKey(master, clusterOf(k.cluster), mint, k.account, 0).keyId).toBase58(), label).toBe(k.vault);
    }
  });

  it("reproduce the deterministic randomizer known answer (HMAC-SHA256, SPEC §3.10)", () => {
    const r = vectors.randomizer;
    expect(r.tag).toBe(VAULT.RANDOMIZER_TAG);
    expect(toHex(lmots.randomizer({ id: fromHex(r.id), q: r.q, seed: fromHex(r.seed) }, fromHex(r.message)))).toBe(r.c);
    expect(r.c).toBe("efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3");
    // RFC 4231 test case 2 for the HMAC itself.
    expect(toHex(lmots.hmacSha256(new TextEncoder().encode("Jefe"), [new TextEncoder().encode("what do ya want for nothing?")]))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  for (const c of vectors.withdrawals) {
    describe(`withdrawal case ${c.name}`, () => {
      const inputs = c.inputs;
      const master = fromHex(inputs.master);
      const cluster = clusterOf(inputs.cluster);
      const mint = new PublicKey(inputs.mint);
      const tokenProgram = new PublicKey(inputs.tokenProgram);
      const destinationOwner = new PublicKey(inputs.destinationOwner);
      const maxAmount = BigInt(inputs.maxAmount);
      const sequence = BigInt(inputs.sequence);
      const vault = new PublicKey(c.addresses.vault);

      it("derives the genesis, current and next keys, the vault, its token account and the payout PDA", () => {
        for (const v of [c.genesisKey, c.key, c.nextKey]) {
          const k = deriveVaultKey(master, cluster, mint, v.account, v.sequence);
          expect([toHex(k.skSeed), toHex(k.pk.id), k.pk.q, toHex(k.pk.k), toHex(k.keyId)]).toEqual([v.seed, v.id, v.q, v.k, v.keyId]);
        }
        expect([c.genesisKey.sequence, c.key.sequence, c.nextKey.sequence]).toEqual([0, Number(sequence), Number(sequence) + 1]);
        expect(vaultAddress(mint, fromHex(c.genesisKey.keyId)).toBase58()).toBe(c.addresses.vault);
        expect(associatedTokenAddress(vault, mint, tokenProgram).toBase58()).toBe(c.addresses.vaultTokenAccount);
        expect(associatedTokenAddress(destinationOwner, mint, tokenProgram).toBase58()).toBe(c.addresses.destination);
        expect(payoutAddress(vault, sequence).toBase58()).toBe(c.addresses.payout);
      });

      it("builds the byte-identical 185-byte PHX-PQV4 message", () => {
        const msg = withdrawMessage(vault, mint, sequence, destinationOwner, maxAmount, fromHex(c.nextKey.keyId));
        expect(msg).toHaveLength(VAULT.WITHDRAW_MESSAGE_LEN);
        expect(toHex(msg)).toBe(c.message);
        const seqField = WITHDRAW_MESSAGE_FIELDS.find((f) => f.name.startsWith("Sequence"));
        if (!seqField) throw new Error("no sequence field");
        expect(new DataView(msg.buffer, msg.byteOffset + seqField.start, 8).getBigUint64(0, true)).toBe(sequence);
      });

      it("the demo build's signer signs like the Rust client: the HMAC randomizer, and the identical signature on every retry", () => {
        // The SDK exports no raw signer (a vault key signs only behind its key ledger); the simulated chain's
        // signer (src/lib/mock/lmotsSigner.ts) must give the Rust client's exact bytes.
        const k = deriveVaultKey(master, cluster, mint, c.key.account, c.key.sequence);
        const msg = fromHex(c.message);
        expect(toHex(lmots.randomizer({ id: k.pk.id, q: k.pk.q, seed: k.skSeed }, msg))).toBe(c.derivedRandomizer);
        const sig = mockSignDeterministic(k.skSeed, k.pk, msg);
        expect(toHex(sig)).toBe(c.derivedSignature);
        expect(toHex(mockSignDeterministic(k.skSeed, k.pk, msg))).toBe(c.derivedSignature);
        expect(lmots.verify(k.pk, msg, sig)).toBe(true);
        // The vector's fixed-randomizer signature verifies too: a signature is valid whatever its C.
        expect(lmots.verify(k.pk, msg, fromHex(c.signature))).toBe(true);
        expect(lmots.verify(deriveVaultKey(master, cluster, mint, c.nextKey.account, c.nextKey.sequence).pk, msg, sig)).toBe(false);
      });

      for (const [label, v1, ixs] of [
        ["withdraw", c.v1Withdraw, [c.withdrawIx]],
        ["withdraw + release", c.v1WithdrawRelease, [c.withdrawIx, c.releaseIx]],
      ] as const) {
        it(`decodes the Rust-built v1 wire bytes of ${label}: fee payer first, config words set, the vector's instructions`, () => {
          const wire = fromHex(v1.wire);
          expect(wire.length).toBeLessThanOrEqual(VAULT.V1_MAX_TX_BYTES);
          const decoded = decodeV1Transaction(wire);
          expect(decoded.accountKeys.map((k) => k.toBase58())).toEqual(v1.accountKeys);
          expect([decoded.header.numRequiredSignatures, decoded.header.numReadonlySigned, decoded.header.numReadonlyUnsigned]).toEqual(v1.header);
          expect(decoded.accountKeys[0]?.toBase58()).toBe(Keypair.fromSeed(fromHex(inputs.feePayerSeed)).publicKey.toBase58());
          expect(decoded.computeUnitLimit).toBe(VAULT.WITHDRAW_COMPUTE_UNITS);
          expect(decoded.loadedAccountsDataSizeLimit).toBe(VAULT.WITHDRAW_LOADED_ACCOUNTS_BYTES);
          expect(decoded.instructions).toHaveLength(ixs.length);
          decoded.instructions.forEach((ix, i) => {
            const want = ixs[i];
            if (!want) throw new Error("missing instruction vector");
            expect(decoded.accountKeys[ix.programIdIndex]?.toBase58()).toBe(want.programId);
            expect(toHex(ix.data)).toBe(want.data);
            expect(ix.accounts.map((a) => decoded.accountKeys[a]?.toBase58())).toEqual(want.accounts.map((a) => a.pubkey));
          });
          // The withdraw data embeds the vector's LM-OTS signature verbatim.
          expect(toHex(decoded.instructions[0]?.data ?? new Uint8Array())).toContain(c.signature);
        });
      }
    });
  }
});

describe("PDA vectors", () => {
  const p = vectors.pdas as Record<string, string>;
  it("match the launchpad, hook, vault, payout and token seeds", () => {
    const mint = new PublicKey(p.mint ?? "");
    const owner = new PublicKey(p.owner ?? "");
    // PQ v2: the launch PDA is ["launch", creator, seed]; this file names the launch itself (pre-v2 seed), so every
    // address that follows from the launch is checked from it, and the creator-seeded derivation from lms.json below.
    const l = launchPdasFromLaunch(new PublicKey(p.launch ?? ""));
    expect(l.protocol.toBase58()).toBe(p.protocol);
    expect(l.launch.toBase58()).toBe(p.launch);
    expect(l.launchAuthority.toBase58()).toBe(p.launchAuthority);
    expect(l.batchAuthority.toBase58()).toBe(p.batchAuthority);
    expect(l.dbcConfig.toBase58()).toBe(p.dbcConfig);
    expect(l.hookAuthority.toBase58()).toBe(p.hookAuthority);
    expect(certificateAddress(mint).toBase58()).toBe(p.certificate);
    expect(commitAddress(l.launch, owner).toBase58()).toBe(p.commit);
    expect(hookPolicyAddress(mint).toBase58()).toBe(p.hookPolicy);
    expect(extraAccountMetaListAddress(mint).toBase58()).toBe(p.extraAccountMetaList);
    expect(KNOWN_ACCOUNTS.sysvarInstructions.toBase58()).toBe(p.instructionsSysvar);
    const vault = vaultAddress(mint, fromHex(p.keyId ?? ""));
    expect(vault.toBase58()).toBe(p.vault);
    expect(payoutAddress(vault, BigInt(p.payoutSequence ?? "0")).toBase58()).toBe(p.payout);
    expect(payoutAddress(vault, 0n).toBase58()).toBe(p.payoutSequence0);
    expect(associatedTokenAddress(owner, mint, KNOWN_ACCOUNTS.token2022).toBase58()).toBe(p.ataToken2022);
    expect(associatedTokenAddress(owner, mint, KNOWN_ACCOUNTS.splToken).toBase58()).toBe(p.ataToken);
  });

  it("derive the launch from its creator and seed (PQ v2: the seed alone gives another address)", () => {
    const lms = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/integration/vectors/lms.json", import.meta.url)), "utf8")) as { attestation: { creator: string; launchSeed: string; launch: string } };
    const a = lms.attestation;
    expect(launchPdas(new PublicKey(a.creator), fromHex(a.launchSeed)).launch.toBase58()).toBe(a.launch);
    expect(launchPdas(Keypair.generate().publicKey, fromHex(a.launchSeed)).launch.toBase58()).not.toBe(a.launch);
  });
});
