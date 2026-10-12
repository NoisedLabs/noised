/**
 * A clock for things that only change when a launch changes phase (the board's
 * rows, the hero stats, the lifecycle counts): it re-renders at the next phase
 * boundary of any launch (and every 30 s as a safety net), not every second.
 * Countdowns tick in their own leaf components (useNow), so a page using this
 * does not re-render once a second. Presentation only: `launchPhase` and the
 * boundaries come from the launch accounts unchanged.
 */
import { useEffect, useState } from "react";

import { chainClockOffset } from "../../app/hooks";
import type { LaunchAccount } from "../../lib/noised";

/** Cluster time in whole unix seconds (same source as useNow). */
export function chainNow(): number {
  return Math.floor(Date.now() / 1000) + chainClockOffset();
}

function nextBoundary(launches: readonly LaunchAccount[], now: number): number | null {
  let next: number | null = null;
  for (const l of launches) {
    for (const t of [l.launchTs, l.commitEndTs, l.executeEndTs, l.guardEndTs]) {
      const s = Number(t);
      if (Number.isFinite(s) && s > now && (next === null || s < next)) next = s;
    }
  }
  return next;
}

export function usePhaseNow(launches: readonly LaunchAccount[] | undefined): number {
  const [now, setNow] = useState(chainNow);
  useEffect(() => {
    const at = nextBoundary(launches ?? [], now);
    const ms = at === null ? 30_000 : Math.min(30_000, Math.max(250, (at - chainNow()) * 1000 + 300));
    const t = window.setTimeout(() => setNow(chainNow()), ms);
    return () => window.clearTimeout(t);
  }, [launches, now]);
  return now;
}
