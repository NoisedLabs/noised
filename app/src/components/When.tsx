/**
 * A time the quantum key signs (a launch window, an Autopilot's start, a freeze approval's expiry), shown as this device
 * shows dates and as the absolute UTC date (SDK 0.9.0, audit 4: never only a duration, so a wrong clock can't hide
 * what was signed). `dateTime` carries the ISO date (the SDK's `unixToIso`).
 */
import type { ReactNode } from "react";

import { formatTimestamp } from "../lib/format";
import { isoOf, utcText } from "../lib/signErrors";

export function When({ t }: { t: number | bigint }): ReactNode {
  return (
    <>
      {formatTimestamp(t)} (<time dateTime={isoOf(t)}>{utcText(t)}</time>)
    </>
  );
}
