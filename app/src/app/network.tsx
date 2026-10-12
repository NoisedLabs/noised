/**
 * Network sanity for the selected RPC endpoint:
 *   - its genesis hash must be the cluster this build targets: on a mismatch
 *     the transaction flow refuses to run (the PQ vault keys, explorer links
 *     and trust anchors are all per cluster);
 *   - the deployment status of every program the app uses (shown on the
 *     Security page, and as a banner when Noised is not deployed);
 *   - the cluster clock (Clock sysvar), which the programs check time windows
 *     against: `useNow()` follows it, so countdowns and the batch crank match
 *     what the chain will accept.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { errorMessage } from "../lib/format";
import { chainUnixTime, checkCluster, programStatuses, type ClusterCheck, type ProgramStatus } from "../lib/noised";
import { setChainClockOffset } from "./hooks";
import { CLUSTER } from "./settings";

export interface NetworkState {
  /** Null while the first check runs. */
  cluster: ClusterCheck | null;
  programs: ProgramStatus[] | null;
  programsError: string | null;
  recheck: () => void;
}

const NetworkContext = createContext<NetworkState | null>(null);

export function useNetwork(): NetworkState {
  const n = useContext(NetworkContext);
  if (!n) throw new Error("useNetwork outside NetworkProvider");
  return n;
}

/** Re-read the cluster clock this often (the offset drifts slowly). */
const CLOCK_SYNC_MS = 60_000;

export function NetworkProvider({ children }: { children: ReactNode }): ReactNode {
  const { connection } = useConnection();
  const [cluster, setCluster] = useState<ClusterCheck | null>(null);
  const [programs, setPrograms] = useState<ProgramStatus[] | null>(null);
  const [programsError, setProgramsError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setCluster(null);
    setPrograms(null);
    setProgramsError(null);
    void checkCluster(connection, CLUSTER).then((c) => {
      if (!cancelled) setCluster(c);
    });
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

  const value = useMemo<NetworkState>(() => ({ cluster, programs, programsError, recheck }), [cluster, programs, programsError, recheck]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

/** The Noised programs that are not deployed (or not executable) on the selected cluster. */
export function missingNoisedPrograms(programs: readonly ProgramStatus[] | null): ProgramStatus[] {
  return (programs ?? []).filter((p) => p.label.startsWith("Noised") && p.state !== "deployed");
}
