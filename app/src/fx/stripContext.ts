/**
 * Page context for the simulation strip under the navbar. A page (the token
 * page) publishes what it is about, and the strip shows it instead of a
 * generic line: "AEGS · BATCH OPEN · CLOSES 11m 43s". Presentation only.
 */
import { useSyncExternalStore } from "react";

export interface StripContext {
  /** Token symbol, e.g. "AEGS". */
  symbol: string;
  /** Phase label, e.g. "Batch open". */
  phase: string;
  /** Unix seconds the current phase ends at, or null. */
  endsAt: number | null;
  /** What happens at endsAt, e.g. "closes". */
  endsLabel: string;
  tone: "signal" | "ok" | "warn" | "violet" | "muted";
}

let current: StripContext | null = null;
const listeners = new Set<() => void>();

export function setStripContext(next: StripContext | null): void {
  current = next;
  for (const l of listeners) l();
}

export function useStripContext(): StripContext | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}
