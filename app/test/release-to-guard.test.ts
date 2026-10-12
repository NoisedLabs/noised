/**
 * The live backend's `release_to` (audit round 3, F2): while a token's
 * Launch Guard is on, the hook refuses a payout into a token account whose
 * owner can be reassigned (HookError 6010 MutableOwner), so the app refuses
 * it before anything is signed; an account with an immutable owner (every
 * associated token account of Token-2022), and any account once the guard
 * ended, goes to the SDK's builder unchanged, options included.
 *
 * The SDK's launch read and builder are replaced in this file only (the
 * launch account's market snapshot needs a whole pool to decode).
 */
import { Keypair, SYSVAR_CLOCK_PUBKEY, type Connection, type PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkCalls = vi.hoisted(() => ({ launch: null as unknown, built: [] as unknown[][] }));

vi.mock("@noisedlabs/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noisedlabs/sdk")>();
  return {
    ...actual,
    fetchLaunchByMint: async () => sdkCalls.launch,
    buildReleaseToTx: async (...args: unknown[]) => {
      sdkCalls.built.push(args);
      return "the SDK's transaction";
    },
  };
});

const { backend: live } = await import("../src/lib/backend/live");
const { KNOWN_ACCOUNTS } = await import("../src/lib/noised");
const { MUTABLE_OWNER } = await import("../src/lib/programErrors");

const NOW = 1_000n;
const mint = Keypair.generate().publicKey;
const destination = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const args = { vault: Keypair.generate().publicKey, mint, sequence: 3n, destination };

/** A Token-2022 token account with these extensions (type, length). */
function t22Account(extensions: [number, number][]): Buffer {
  const tlv = extensions.flatMap(([type, len]) => [type & 0xff, type >> 8, len & 0xff, len >> 8, ...new Array<number>(len).fill(0)]);
  return Buffer.from([...new Array<number>(165).fill(0), 2, ...tlv]);
}

function conn(destinationData: Buffer | null): Connection {
  return {
    getAccountInfo: async (k: PublicKey) => {
      if (k.equals(SYSVAR_CLOCK_PUBKEY)) {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(NOW);
        return { owner: KNOWN_ACCOUNTS.system, executable: false, lamports: 1, data: b, rentEpoch: 0 };
      }
      if (k.equals(destination) && destinationData !== null) return { owner: KNOWN_ACCOUNTS.token2022, executable: false, lamports: 1, data: destinationData, rentEpoch: 0 };
      return null;
    },
  } as unknown as Connection;
}

const guarded = (guardEndTs: bigint): unknown => ({ status: "live", market: { hookActive: true }, guardEndTs, p2pLocked: false, maxWalletBps: 0 });

describe("release_to while the Launch Guard is on (F2)", () => {
  beforeEach(() => {
    sdkCalls.built = [];
    sdkCalls.launch = guarded(NOW + 600n);
  });

  it("refuses a receiving account whose owner can be reassigned, before the SDK builds anything", async () => {
    // A Token-2022 account with only the transfer-hook extension: no ImmutableOwner.
    await expect(live.buildReleaseToTx(conn(t22Account([[14, 1]])), recipient, args)).rejects.toThrow(
      `${MUTABLE_OWNER.message} (MutableOwner, 6010): ${destination.toBase58()} is not such an account`,
    );
    await expect(live.buildReleaseToTx(conn(Buffer.alloc(165)), recipient, args)).rejects.toThrow(/MutableOwner, 6010/);
    expect(sdkCalls.built).toEqual([]);
  });

  it("passes an account with an immutable owner to the SDK unchanged, options included", async () => {
    const opts = { computeUnitPrice: 5n };
    expect(await live.buildReleaseToTx(conn(t22Account([[14, 1], [7, 0]])), recipient, args, opts)).toBe("the SDK's transaction");
    expect(sdkCalls.built).toHaveLength(1);
    expect(sdkCalls.built[0]?.slice(1)).toEqual([recipient, args, opts]);
  });

  it("changes nothing once the guard ended, or for a token without a live guard", async () => {
    sdkCalls.launch = guarded(NOW);
    expect(await live.buildReleaseToTx(conn(t22Account([[14, 1]])), recipient, args)).toBe("the SDK's transaction");
    sdkCalls.launch = null;
    expect(await live.buildReleaseToTx(conn(t22Account([[14, 1]])), recipient, args)).toBe("the SDK's transaction");
    expect(sdkCalls.built).toHaveLength(2);
  });
});
