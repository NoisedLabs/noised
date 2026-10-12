/**
 * Where a configured launch stands against its attestation's window (PQ v2:
 * `launch` runs only inside the attested window, and anyone may send it
 * then; the first transaction to land wins). Pure; the token page shows it.
 *
 * `missed`: the window passed unused. That attestation no longer blocks the
 * launch (audit round 3, F1): the creator signs a new opening time at the
 * next leaf, which replaces it, and its window must still have at least
 * `POLICY.MIN_LAUNCH_WINDOW_SECS` left when it lands. An attestation whose
 * window has not passed can never be replaced, and a live launch's never
 * changes.
 */
import { inLaunchWindow, type AttestationAccount } from "./noised";

export type WindowState =
  /** No attestation account yet: the creator's quantum key has not signed. */
  | { kind: "unsigned" }
  /** An empty attestation: a signature landed but only used up its leaf (wrong identity, metadata or window). */
  | { kind: "burned" }
  | { kind: "soon"; opensAt: bigint; closesAt: bigint }
  | { kind: "open"; closesAt: bigint }
  | { kind: "missed"; closedAt: bigint };

export function windowState(a: Pick<AttestationAccount, "attested" | "notBefore" | "notAfter"> | null, nowSecs: bigint): WindowState {
  if (a === null) return { kind: "unsigned" };
  if (!a.attested) return { kind: "burned" };
  if (nowSecs < a.notBefore) return { kind: "soon", opensAt: a.notBefore, closesAt: a.notAfter };
  if (inLaunchWindow(nowSecs, a.notBefore, a.notAfter)) return { kind: "open", closesAt: a.notAfter };
  return { kind: "missed", closedAt: a.notAfter };
}

/**
 * Whether a new attestation may take the launch's attestation slot (the
 * program's `slot_free`, audit round 3 F1): no attestation yet, or the
 * launch is still configured and the attested window passed unused.
 */
export function attestationSlotFree(a: Pick<AttestationAccount, "attested" | "notAfter"> | null, launchStatus: "configured" | "live" | string, nowSecs: bigint): boolean {
  if (a === null || !a.attested) return true;
  return launchStatus === "configured" && nowSecs > a.notAfter;
}
