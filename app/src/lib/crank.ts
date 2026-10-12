/**
 * The armed "start the batch for me" crank: what to do after an attempt.
 *
 * `execute_batch` is accepted only inside [commit end, execute end), and the
 * first attempt often lands right at the boundary (the browser's clock, the
 * RPC's and the validators' differ by a second or two), or meets a busy RPC.
 * Those are worth trying again, with backoff, until the batch executes or
 * the window closes. Errors that will never go away (the batch already ran
 * or is empty, the pool was traded first, the user said no) stop the crank
 * at once: it never loops on them.
 */

/** What one attempt ended with (the transaction flow's outcome). */
export interface CrankAttempt {
  status: "confirmed" | "cancelled" | "failed";
  error?: string | null | undefined;
  /** The program error's IDL name, when the simulation or the send named one. */
  errorName?: string | null | undefined;
}

export type CrankNext =
  | { action: "done" }
  /** Try again at `retryAt` (cluster seconds: the clock the window is judged by), `delayMs` after the attempt ended. */
  | { action: "retry"; delayMs: number; retryAt: number }
  | { action: "stop"; reason: string };

/** Program errors that no retry can fix. */
const PERMANENT: Readonly<Record<string, string>> = {
  AlreadyExecuted: "The batch has already run.",
  EmptyBatch: "Nothing was committed to the batch.",
  PoolAlreadyTraded: "Someone traded on the pool before the batch, so it can no longer run; every commit is refunded in full after the window.",
  WrongLaunchState: "This launch is not live.",
};

/** Failures that say nothing about the batch itself: a busy or unreachable RPC, an expired blockhash, the window edge. */
const TRANSIENT = /NotExecuteWindow|blockhash|block height exceeded|expired|429|Too Many Requests|rate.?limit|Failed to fetch|NetworkError|fetch failed|timed? ?out|ECONNRESET|ECONNREFUSED|could not be reached|Simulation could not run|AccountInUse|try again/i;

/**
 * The attempt as the crank sees it, from the transaction flow's outcome: the
 * program error's name comes from a failed simulation's report, or from a
 * failed send's explanation ("…(NotExecuteWindow, 6024)").
 */
export function attemptOf(outcome: { status: "confirmed" | "cancelled" | "failed"; error?: string; report?: { ok: boolean; errorCode: { name: string } | null } | null }): CrankAttempt {
  if (outcome.status !== "failed") return { status: outcome.status };
  const fromReport = outcome.report !== null && outcome.report !== undefined && !outcome.report.ok ? (outcome.report.errorCode?.name ?? null) : null;
  const fromText = /\((\w+), \d{4}\)/.exec(outcome.error ?? "")?.[1] ?? null;
  return { status: "failed", error: outcome.error ?? null, errorName: fromReport ?? fromText };
}

/** First retry after this long, then doubling, never longer than `MAX_DELAY_MS`. */
export const FIRST_DELAY_MS = 1_500;
export const MAX_DELAY_MS = 20_000;
/** Give up after this many attempts, whatever the window. */
export const MAX_ATTEMPTS = 12;

/**
 * The next step after attempt number `attempt` (1 = the first one), at
 * `nowSecs` (the cluster clock), for a window that closes at
 * `executeEndTs`.
 */
export function crankNext(result: CrankAttempt, attempt: number, nowSecs: number, executeEndTs: bigint): CrankNext {
  if (result.status === "confirmed") return { action: "done" };
  if (result.status === "cancelled") return { action: "stop", reason: "You cancelled it." };
  const name = result.errorName ?? null;
  if (name !== null && PERMANENT[name] !== undefined) return { action: "stop", reason: PERMANENT[name] };
  const text = `${name ?? ""} ${result.error ?? ""}`;
  if (/rejected|denied|declined|User rejected/i.test(text)) return { action: "stop", reason: "Your wallet declined it." };
  if (BigInt(Math.floor(nowSecs)) >= executeEndTs) return { action: "stop", reason: "The window to start the batch has closed." };
  // A program error other than the window edge is permanent; anything else (no name) is retried only if it looks transient.
  const transient = name === "NotExecuteWindow" || (name === null && TRANSIENT.test(text));
  if (!transient) return { action: "stop", reason: result.error ?? "It failed for a reason a retry cannot fix." };
  if (attempt >= MAX_ATTEMPTS) return { action: "stop", reason: `It failed ${attempt} times in a row.` };
  const delayMs = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (attempt - 1));
  return { action: "retry", delayMs, retryAt: Math.floor(nowSecs) + Math.ceil(delayMs / 1000) };
}
