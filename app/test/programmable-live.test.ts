/**
 * Live builds with SDK 0.7.0 (the P1c programs): launch rules and Autopilot are available, so the launch flow no
 * longer refuses them, while the pieces a wallet can't do itself are routed correctly:
 *   - `pq_authorize` (a 2.5 KB quantum signature) is never a wallet's legacy transaction: it goes from a temporary
 *     account (`walletAuthorize: false`, `prepareAuthorizeFromPayer`);
 *   - the attestation's message v3 carries the rules hash itself, so binding is a no-op;
 *   - the simulated chain keeps the wallet path (`walletAuthorize: true`).
 */
import { Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { programmableLive } from "../src/lib/backend/programmableLive";
import { programmableMock } from "../src/lib/mock/programmable";

const conn = new Connection("http://127.0.0.1:8899");

describe("live programmable backend (SDK 0.7.0)", () => {
  it("is available, and sends the quantum authorization from a temporary account, never a wallet", async () => {
    expect(programmableLive.available).toBe(true);
    expect(programmableLive.walletAuthorize).toBe(false);
    await expect(
      programmableLive.buildPqAuthorizeTx(conn, Keypair.generate().publicKey, Keypair.generate().publicKey, { kind: 1, payloadHash: new Uint8Array(32), lmsPublicKey: new Uint8Array(56), leaf: 0, signature: new Uint8Array(2508) }),
    ).rejects.toThrow(/temporary account/);
    // Attestation v3: the signed message carries the rules hash; nothing to record on the side.
    expect(() => programmableLive.bindRulesToAttestation(Keypair.generate().publicKey, new Uint8Array(32), new Uint8Array(32))).not.toThrow();
    expect(await programmableLive.listAutopilotRuns(conn, Keypair.generate().publicKey)).toEqual([]);
  });

  it("the simulated chain keeps the wallet path for the same authorization", () => {
    expect(programmableMock.available).toBe(true);
    expect(programmableMock.walletAuthorize).toBe(true);
  });
});
