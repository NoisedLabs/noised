/**
 * The creator's quantum signature of one Autopilot authorization
 * (`pq_authorize`): the launch's own identity signs the exact 140-byte
 * message ("PHX-AUTH-V1" || launchpad || launch || creator || kind ||
 * payload_hash) at its next one-time key, through this browser's leaf ledger
 * (the leaf is reserved for the message before the signature exists, and a
 * retry signs the same bytes). Only the key that signed the launch can do it
 * (review U16); everyone else is told so before anything is signed.
 *
 * SDK 0.9.0 (audit 4): the backend runs the SDK's guards first, under this
 * browser's cross-tab signing lock: the network's clock (and a second RPC's,
 * when the build lists one) for a time it signs, a freeze at most 24 hours
 * long, the cap on earlier signatures that never landed (one more only when
 * the person confirmed it), and a key used on another device (nothing is
 * signed; lib/signErrors.ts says why in plain words).
 */
import type { Connection } from "@solana/web3.js";

import { CLUSTER } from "../../app/settings";
import { toHex } from "../../lib/format";
import { programmable, type LaunchAccount } from "../../lib/noised";
import type { AuthPayload } from "../../lib/programmable";
import { launchSigner, pqKeyState } from "../../lib/pqKey";

/** Why this browser's quantum key can't sign for `launch` now (plain words), or null. */
export function signerProblem(launch: Pick<LaunchAccount, "pqIdentity">): string | null {
  const k = pqKeyState();
  if (k.status !== "unlocked") return "Unlock your quantum key first (Launch, step 5, or the Vault page).";
  if (k.identity.idHex === null) return "Your quantum key is still getting ready.";
  if (k.identity.idHex !== toHex(launch.pqIdentity)) return "This launch was signed by another quantum key. Only its creator's key can sign changes.";
  return null;
}

/** What a signature passes besides what it signs: a second RPC for the clock check, a freeze's last second, a confirmed extra signature. */
export interface SignOptions {
  secondConnection?: Connection | null;
  freezeNotAfter?: number;
  acknowledgeExtraSignatures?: boolean;
}

/** The message, its signature and the one-time key it used. */
export async function signAuthorization(
  conn: Connection,
  launch: LaunchAccount,
  p: AuthPayload,
  opts: SignOptions = {},
): Promise<{ message: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array }> {
  const { identity, leaves, lock } = await launchSigner(CLUSTER);
  if (toHex(identity.identityId) !== toHex(launch.pqIdentity)) throw new Error("This launch was signed by another quantum key. Only its creator's key can sign changes.");
  return programmable.signAuthorization(conn, launch.publicKey, {
    kind: p.kind,
    payloadHash: p.hash,
    creator: launch.creator,
    identity,
    ledger: leaves,
    signingLock: lock,
    ...(opts.secondConnection ? { secondConnection: opts.secondConnection } : {}),
    ...(opts.freezeNotAfter !== undefined ? { freezeNotAfter: opts.freezeNotAfter } : {}),
    ...(opts.acknowledgeExtraSignatures === true ? { acknowledgeExtraSignatures: true } : {}),
  });
}
