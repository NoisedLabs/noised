/** MOCK implementation of the shield half of SPEC §4.1 (account lists in IDL order). */
import { associatedTokenAddress, KNOWN_ACCOUNTS, noisedHookAccounts, PROGRAM_IDS, shieldAddresses, type ShieldAccount } from "@noisedlabs/sdk";
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";

import { chain } from "./chain";
import { guard, hookActive, liveLaunchByMint, mintFacts, RENT, runtime, shieldFail, T22 } from "./common";
import { createAtaIdempotentIx, idlIx, legacyTx, r, w } from "./ix";
import { mockMint } from "./mints";
import { register } from "./sim";
import { addTokens, latency, tokenBalance } from "./store";

/** `policy::ALLOWED_BASE_EXTENSIONS` of programs/noised-shield. */
const ALLOWED_BASE_EXTENSIONS = new Set(["MetadataPointer", "TokenMetadata", "TransferHook", "TransferFeeConfig"]);

export async function fetchShield(_conn: Connection, baseMint: PublicKey): Promise<ShieldAccount | null> {
  await latency("read");
  const sh = chain().shields[baseMint.toBase58()];
  return sh ? { ...sh.account } : null;
}

export async function buildCreateShieldTx(_conn: Connection, payer: PublicKey, baseMint: PublicKey): Promise<Transaction> {
  await latency("build");
  const s = chain();
  const { decimals, tokenProgram } = mintFacts(s, baseMint);
  const a = shieldAddresses(baseMint, tokenProgram);
  const tx = legacyTx(payer, [
    idlIx("shield", "create_shield", [
      w(payer, true),
      r(baseMint),
      w(a.shield),
      r(a.authority),
      w(a.zMint),
      w(a.escrow),
      r(tokenProgram),
      r(T22),
      r(KNOWN_ACCOUNTS.associatedToken),
      r(KNOWN_ACCOUNTS.system),
    ]),
  ]);
  register(tx, {
    label: "CreateShield",
    program: PROGRAM_IDS.shield,
    computeUnits: 97_000,
    payer,
    rent: RENT.shield,
    solOut: 0n,
    check: (st) => {
      if (st.shields[baseMint.toBase58()]) return runtime(`Allocate: account Address { address: ${a.shield.toBase58()}, base: None } already in use`);
      const m = mockMint(st, baseMint);
      if (!m) return runtime("AnchorError caused by account: base_mint. Error Code: AccountNotInitialized.");
      if (m.tokenProgram.equals(T22) && m.extensions.some((e) => !ALLOWED_BASE_EXTENSIONS.has(e.type))) return shieldFail("UnsupportedExtension");
      return null;
    },
    apply: (st, now) => {
      const bumpOf = (seed: string): number => PublicKey.findProgramAddressSync([new TextEncoder().encode(seed), baseMint.toBytes()], PROGRAM_IDS.shield)[1];
      st.shields[baseMint.toBase58()] = {
        account: {
          publicKey: a.shield,
          version: 1,
          bump: bumpOf("shield"),
          authorityBump: bumpOf("shield-authority"),
          zMintBump: bumpOf("z-mint"),
          decimals,
          baseMint,
          baseTokenProgram: tokenProgram,
          zMint: a.zMint,
          escrow: a.escrow,
          createdAt: BigInt(now),
        },
        zSupply: 0n,
      };
    },
    logs: () => ["zToken mint verified: ConfidentialTransferMint (no authority, auto-approve, no auditor), metadata immutable, no freeze authority"],
  });
  return tx;
}

export async function buildWrapTx(_conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint): Promise<Transaction> {
  return shieldTransfer(owner, baseMint, amount, "wrap");
}

export async function buildUnwrapTx(_conn: Connection, owner: PublicKey, baseMint: PublicKey, amount: bigint): Promise<Transaction> {
  return shieldTransfer(owner, baseMint, amount, "unwrap");
}

async function shieldTransfer(owner: PublicKey, baseMint: PublicKey, amount: bigint, op: "wrap" | "unwrap"): Promise<Transaction> {
  await latency("build");
  if (amount <= 0n) throw new RangeError("amount must be greater than zero");
  const s = chain();
  const { tokenProgram } = mintFacts(s, baseMint);
  const a = shieldAddresses(baseMint, tokenProgram);
  const l = liveLaunchByMint(s, baseMint);
  const userBase = associatedTokenAddress(owner, baseMint, tokenProgram);
  const userZ = associatedTokenAddress(owner, a.zMint, T22);
  const tx = legacyTx(owner, [
    // The receiving account may not exist yet.
    op === "wrap" ? createAtaIdempotentIx(owner, owner, a.zMint, T22) : createAtaIdempotentIx(owner, owner, baseMint, tokenProgram),
    idlIx(
      "shield",
      op,
      [
        r(owner, true),
        r(a.shield),
        r(a.authority),
        r(baseMint),
        w(a.zMint),
        w(a.escrow),
        w(userBase),
        w(userZ),
        r(tokenProgram),
        r(T22),
        ...(hookActive(l) ? noisedHookAccounts(baseMint) : []),
      ],
      { amount },
    ),
  ]);
  const receiving = op === "wrap" ? a.zMint : baseMint;
  register(tx, {
    label: op === "wrap" ? "Wrap" : "Unwrap",
    program: PROGRAM_IDS.shield,
    computeUnits: op === "wrap" ? 39_000 : 36_000,
    payer: owner,
    rent: tokenBalance(s, owner, receiving) === 0n ? RENT.t22Account : 0n,
    solOut: 0n,
    check: (st, now) => {
      const sh = st.shields[baseMint.toBase58()];
      if (!sh) return runtime("AnchorError caused by account: shield. Error Code: AccountNotInitialized. Create the shield first.");
      const cur = liveLaunchByMint(st, baseMint);
      const via = [tokenProgram];
      if (op === "wrap") {
        if (tokenBalance(st, owner, baseMint) < amount) return runtime("Program log: Error: insufficient funds");
        return guard(
          cur,
          now,
          { amount, isBuy: false, isSell: false, sourceOwner: owner, destinationOwner: a.authority, destinationBalanceAfter: tokenBalance(st, a.authority, baseMint) + amount, topProgram: PROGRAM_IDS.shield },
          via,
        );
      }
      if (tokenBalance(st, owner, a.zMint) < amount) {
        return runtime("Program log: Error: insufficient funds (public zToken balance: apply pending confidential balance and withdraw it to public first)");
      }
      if (tokenBalance(st, a.authority, baseMint) < amount) return shieldFail("Undercollateralized");
      return guard(
        cur,
        now,
        { amount, isBuy: false, isSell: false, sourceOwner: a.authority, destinationOwner: owner, destinationBalanceAfter: tokenBalance(st, owner, baseMint) + amount, topProgram: PROGRAM_IDS.shield },
        via,
      );
    },
    apply: (st) => {
      const sh = st.shields[baseMint.toBase58()];
      if (!sh) return;
      if (op === "wrap") {
        addTokens(st, owner, baseMint, -amount);
        addTokens(st, a.authority, baseMint, amount);
        addTokens(st, owner, a.zMint, amount);
        sh.zSupply += amount;
      } else {
        addTokens(st, owner, a.zMint, -amount);
        sh.zSupply -= amount;
        addTokens(st, a.authority, baseMint, -amount);
        addTokens(st, owner, baseMint, amount);
      }
    },
    logs: (st) => {
      const sh = st.shields[baseMint.toBase58()];
      if (!sh) return [];
      const after = op === "wrap" ? sh.zSupply + amount : sh.zSupply - amount;
      const escrowAfter = tokenBalance(st, a.authority, baseMint) + (op === "wrap" ? amount : -amount);
      return [`${op === "wrap" ? "Wrapped" : "Unwrapped"} { amount: ${amount}, z_supply: ${after}, escrow_balance: ${escrowAfter} }`, `Backing check: escrow ${escrowAfter} >= z_supply ${after}`];
    },
  });
  return tx;
}
