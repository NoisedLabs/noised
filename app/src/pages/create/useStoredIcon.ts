/**
 * The icon the token's record will store, made asynchronously (the SDK's PNG encoder is async) and re-made whenever the
 * draft changes what it would be: another drawing, another logo, or new words next to a logo (its budget).
 */
import { useEffect, useState } from "react";

import { storedIcon, storedIconKey, type Draft, type StoredIcon } from "./draft";

export interface StoredIconState {
  /** The icon for the draft as it is now; undefined while it is being made (the record is not final yet). */
  now: StoredIcon | undefined;
  /** The last icon made, for showing while the next one is being made (no flicker while typing). */
  shown: StoredIcon | undefined;
}

export function useStoredIcon(d: Pick<Draft, "name" | "symbol" | "meta">): StoredIconState {
  const key = storedIconKey(d);
  const [made, setMade] = useState<{ key: string; icon: StoredIcon } | null>(null);
  useEffect(() => {
    let alive = true;
    storedIcon(d).then(
      (icon) => {
        if (alive) setMade({ key, icon });
      },
      () => {
        if (alive) setMade({ key, icon: { kind: "none", png: null } });
      },
    );
    return () => {
      alive = false;
    };
    // `key` changes exactly when the result would (storedIconKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { now: made !== null && made.key === key ? made.icon : undefined, shown: made?.icon };
}
