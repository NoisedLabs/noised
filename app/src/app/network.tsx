/**
 * Network sanity for the selected RPC endpoint:
 *   - its genesis hash must be the cluster this build targets: on a mismatch
 *     the transaction flow refuses to run (the PQ vault keys, explorer links
 *     and trust anchors are all per cluster);
 *   - the deployment status of every program the app uses (shown on the
 *     Security page, and as a banner when Noised is not deployed);
 *   - whether launches are open: the launchpad's one-time setup (its
 *     `Protocol` account) exists. Until it does, `create_launch` fails, so the
 *     Launch page says "Launches open soon" instead of offering the forms, and
 *     this re-checks every 30 s (the chain-change tick) until it opens;
 *   - the cluster clock (Clock sysvar), which the programs check time windows
 *     against: `useNow()` follows it, so countdowns and the batch crank match
 *     what the chain will accept.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { errorMessage } from "../lib/format";
import { chainUnixTime, checkCluster, programStatuses, protocolInitialized, subscribeToChainChanges, type ClusterCheck, type ProgramStatus } from "../lib/noised";
import { LAUNCHES_SOON } from "./brand";
import { setChainClockOffset } from "./hooks";
import { CLUSTER } from "./settings";

/**
 * Whether a new launch can be created on this cluster: `open` once the launchpad's `Protocol` account exists, `soon`
 * while it does not (every `create_launch` would fail), `checking` while the first read runs, `unknown` when the RPC
 * could not be read.
 */
export type LaunchesState = "checking" | "open" | "soon" | "unknown";

export interface NetworkState {
  /** Null while the first check runs. */
  cluster: ClusterCheck | null;
  programs: ProgramStatus[] | null;
  programsError: string | null;
  launches: LaunchesState;
  recheck: () => void;
}

const NetworkContext = createContext<NetworkState | null>(null);

export function useNetwork(): NetworkState {
  const n = useContext(NetworkContext);
  if (!n) throw new Error("useNetwork outside NetworkProvider");
  return n;
}

/** Whether launches are open, for labels only (outside a NetworkProvider: "open"). The Launch page gates on `useNetwork`. */
export function useLaunchesState(): LaunchesState {
  return useContext(NetworkContext)?.launches ?? "open";
}

/** A launch button's label: "Launch a token", or "Launches open soon" while no launch can be created yet. */
export function launchCtaLabel(state: LaunchesState): string {
  return state === "soon" ? LAUNCHES_SOON.title : "Launch a token";
}

/** Re-read the cluster clock this often (the offset drifts slowly). */
const CLOCK_SYNC_MS = 60_000;

export function NetworkProvider({ children }: { children: ReactNode }): ReactNode {
  const { connection } = useConnection();
  const [cluster, setCluster] = useState<ClusterCheck | null>(null);
  const [programs, setPrograms] = useState<ProgramStatus[] | null>(null);
  const [programsError, setProgramsError] = useState<string | null>(null);
  const [launches, setLaunches] = useState<LaunchesState>("checking");
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setCluster(null);
    setPrograms(null);
    setProgramsError(null);
    setLaunches("checking");
    void checkCluster(connection, CLUSTER).then((c) => {
      if (!cancelled) setCluster(c);
    });
    protocolInitialized(connection).then(
      (ok) => {
        if (!cancelled) setLaunches(ok ? "open" : "soon");
      },
      () => {
        if (!cancelled) setLaunches("unknown");
      },
    );
    programStatuses(connection).then(
      (p) => {
        if (!cancelled) setPrograms(p);
      },
      (e: unknown) => {
        if (!cancelled) setProgramsError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection, tick]);

  // While launches are not open yet, look again on every chain-change tick (30 s while the page is visible), so the
  // Launch page opens without a reload once the protocol is set up.
  useEffect(() => {
    if (launches !== "soon") return;
    let cancelled = false;
    const unsubscribe = subscribeToChainChanges(() => {
      protocolInitialized(connection).then(
        (ok) => {
          if (!cancelled && ok) setLaunches("open");
        },
        () => undefined,
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [launches, connection]);

  useEffect(() => {
    let cancelled = false;
    const sync = async (): Promise<void> => {
      const sent = Date.now();
      const chain = await chainUnixTime(connection);
      if (cancelled || chain === null) return;
      // Compare with the local time halfway through the request.
      const local = (sent + Date.now()) / 2000;
      setChainClockOffset(chain - local);
    };
    void sync();
    const id = setInterval(() => void sync(), CLOCK_SYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      setChainClockOffset(0);
    };
  }, [connection]);

  const value = useMemo<NetworkState>(() => ({ cluster, programs, programsError, launches, recheck }), [cluster, programs, programsError, launches, recheck]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

/** The Noised programs that are not deployed (or not executable) on the selected cluster. */
export function missingNoisedPrograms(programs: readonly ProgramStatus[] | null): ProgramStatus[] {
  return (programs ?? []).filter((p) => p.label.startsWith("Noised") && p.state !== "deployed");
}
