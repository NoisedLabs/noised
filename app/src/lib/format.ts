/** Display formatting (pure). Amount math lives in ./amounts and never uses floats. */
import type { PublicKey } from "@solana/web3.js";

/** `Abcd…wxyz` for addresses and hashes. */
export function shortKey(key: PublicKey | string, chars = 4): string {
  const s = typeof key === "string" ? key : key.toBase58();
  return s.length <= chars * 2 + 1 ? s : `${s.slice(0, chars)}…${s.slice(-chars)}`;
}

/** "2h 05m", "4m 09s", "37s"; negative durations clamp to 0. */
export function formatDuration(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** A countdown as a clock: "04:09", "1:02:05"; negative durations clamp to 0. */
export function formatClock(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Human length of a configured duration ("6 hours", "30 minutes", "45 seconds"). */
export function describeSeconds(secs: number): string {
  if (secs % 86_400 === 0 && secs >= 86_400) return plural(secs / 86_400, "day");
  if (secs % 3_600 === 0 && secs >= 3_600) return plural(secs / 3_600, "hour");
  if (secs % 60 === 0 && secs >= 60) return plural(secs / 60, "minute");
  if (secs > 3_600) return `${(secs / 3_600).toFixed(1)} hours`;
  if (secs > 60) return `${Math.floor(secs / 60)} min ${secs % 60} s`;
  return plural(secs, "second");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Local date and time with seconds, e.g. "8 Oct 2026, 14:03:12". */
export function formatTimestamp(secs: number | bigint): string {
  const d = new Date(Number(secs) * 1000);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Whole unix seconds as the bigint the SDK takes for every "now" (`launchPhase`, `batchOutcome`, window checks). */
export function unixSecs(now: number): bigint {
  return BigInt(Math.floor(now));
}

/** "in 4m 09s" / "12m 30s ago". */
export function relativeTime(targetSecs: number | bigint, nowSecs: number): string {
  const diff = Number(targetSecs) - nowSecs;
  return diff >= 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

/** Compact number for display only (never used for amounts that are signed). */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

/** Percentage with up to 2 decimals. */
export function percent(fraction: number, digits = 2): string {
  return `${(fraction * 100).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;
}

/** Hex with a separator every 4 bytes, for byte dumps. */
export function hexGroups(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    out.push(Array.from(bytes.subarray(i, i + 4), (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return out.join(" ");
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An error's message, for display. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
