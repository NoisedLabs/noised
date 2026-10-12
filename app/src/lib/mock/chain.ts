/**
 * MOCK chain access point: loads (or seeds) the state and advances it to the
 * current time, running the keepers a real deployment would have (batch
 * execution a few seconds after the commit window, migration after the curve
 * completes). Both are permissionless instructions anyone can call.
 */
import type { PublicKey } from "@solana/web3.js";

import { fundOwner, migrate, runBatch, seedState } from "./fixtures";
import { installSeed, nowSecs, persist, state, type MockState } from "./store";

installSeed(seedState);

/** Seconds after the commit window closes when the demo keeper executes the batch. */
export const KEEPER_EXECUTE_DELAY = 12;
/** Seconds after curve completion when the demo keeper migrates to DAMM v2. */
export const KEEPER_MIGRATE_DELAY = 45;

export function advance(s: MockState, now: number): boolean {
  let changed = false;
  for (const l of Object.values(s.launches)) {
    if (l.state.status !== "live") continue;
    const executeAt = l.state.commitEndTs + BigInt(KEEPER_EXECUTE_DELAY);
    if (l.keeper && !l.state.executed && l.state.totalCommitted > 0n && BigInt(now) >= executeAt) {
      runBatch(s, l);
      changed = true;
    }
    if (l.curveComplete && !l.migrated && l.completedAt !== null && now >= l.completedAt + KEEPER_MIGRATE_DELAY) {
      migrate(l);
      changed = true;
    }
  }
  return changed;
}

export function chain(): MockState {
  const s = state();
  if (advance(s, nowSecs())) persist();
  return s;
}

/** Give an owner the demo balances the first time the mock sees it. */
export function ensureFunded(owner: PublicKey): MockState {
  const s = chain();
  if (fundOwner(s, owner)) persist();
  return s;
}
