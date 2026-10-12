/** React access to this browser's key ledgers (src/lib/ledger.ts): opened once per page, refreshed when any tab writes. */
import { useEffect, useState } from "react";

import { errorMessage } from "../lib/format";
import { browserLedgers, subscribeLedgers, type BrowserLedgers } from "../lib/ledger";

export interface LedgersState {
  /** Null until open, or when they cannot open (`error`): nothing may be signed then. */
  ledgers: BrowserLedgers | null;
  error: string | null;
  /** Bumps whenever any tab of this browser writes a record (re-read lists on it). */
  version: number;
}

export function useLedgers(): LedgersState {
  const [state, setState] = useState<LedgersState>({ ledgers: null, error: null, version: 0 });
  useEffect(() => {
    let alive = true;
    browserLedgers().then(
      (ledgers) => {
        if (alive) setState((s) => ({ ...s, ledgers, error: null }));
      },
      (e: unknown) => {
        if (alive) setState((s) => ({ ...s, ledgers: null, error: errorMessage(e) }));
      },
    );
    const off = subscribeLedgers(() => setState((s) => ({ ...s, version: s.version + 1 })));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
