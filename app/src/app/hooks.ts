/** Small React hooks shared by the pages. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DependencyList } from "react";

import { withRuntimeHint } from "../lib/display";
import { errorMessage } from "../lib/format";
import { subscribeToChainChanges } from "../lib/noised";
import { readString, writeString } from "../lib/storage";

// ------------------------------------------------------------------ clock ---

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
/** Cluster clock minus local clock, in whole seconds (see ./network.tsx). */
let clockOffset = 0;
const readClock = (): number => Math.floor(Date.now() / 1000) + clockOffset;
let clockNow = readClock();

function tickClock(): void {
  const next = readClock();
  if (next !== clockNow) {
    clockNow = next;
    for (const l of clockListeners) l();
  }
}

/**
 * Follow the cluster's clock (Clock sysvar), which the programs check time
 * windows against. Offsets under 2 s are ignored (request latency and the
 * sysvar's one-second resolution).
 */
export function setChainClockOffset(seconds: number): void {
  const rounded = Number.isFinite(seconds) && Math.abs(seconds) >= 2 ? Math.round(seconds) : 0;
  if (rounded === clockOffset) return;
  clockOffset = rounded;
  tickClock();
}

/** The current cluster-clock offset in seconds (0 when in sync or unknown). */
export function chainClockOffset(): number {
  return clockOffset;
}

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockTimer = setInterval(tickClock, 250);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** Current cluster time in whole unix seconds, re-rendering once per second. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => clockNow,
  );
}

// ------------------------------------------------------------- async data ---

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Re-run now (e.g. after a transaction). */
  reload: () => void;
}

/**
 * Run `fn` when `deps` change and whenever the chain changes. Late results of
 * superseded runs are dropped. `data` keeps the last good value while
 * reloading so the page does not flicker.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, options: { enabled?: boolean; watchChain?: boolean } = {}): AsyncState<T> {
  const { enabled = true, watchChain = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [tick, setTick] = useState(0);
  const run = useRef(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const id = ++run.current;
    setLoading(true);
    fn()
      .then((value) => {
        if (run.current !== id) return;
        setData(value);
        setError(null);
      })
      .catch((e: unknown) => {
        if (run.current !== id) return;
        // RPC transport failures (rate limits, unreachable endpoint) get plain words.
        setError(withRuntimeHint(errorMessage(e)));
      })
      .finally(() => {
        if (run.current === id) setLoading(false);
      });
    // Callers pass the dependencies of `fn`; `fn` itself is a fresh closure every render.
  }, [...deps, tick, enabled]);

  useEffect(() => {
    if (!enabled || !watchChain) return;
    return subscribeToChainChanges(reload);
  }, [enabled, watchChain, reload]);

  return { data, error, loading, reload };
}

// --------------------------------------------------------- stored settings ---

/** A string setting persisted in localStorage (falls back to memory when storage is blocked). */
export function useStoredString(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => readString(key) ?? initial);
  const set = useCallback(
    (v: string) => {
      setValue(v);
      writeString(key, v);
    },
    [key],
  );
  return [value, set];
}
