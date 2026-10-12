/**
 * The armed "start the batch for me" crank (src/lib/crank.ts): it retries
 * with a growing pause while a retry can help (the window edge, a busy or
 * unreachable RPC, an expired blockhash), until the batch executes or the
 * window closes, and stops at once on anything a retry cannot fix (it never
 * loops on a permanent error).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { attemptOf, crankNext, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, type CrankAttempt } from "../src/lib/crank";

const END = 1_000n;
const failed = (errorName: string | null, error = ""): CrankAttempt => ({ status: "failed", errorName, error });

describe("after an attempt, the armed crank", () => {
  it("is done once the batch executed, and stops when the user cancels or the wallet declines", () => {
    expect(crankNext({ status: "confirmed" }, 1, 900, END)).toEqual({ action: "done" });
    expect(crankNext({ status: "cancelled" }, 1, 900, END)).toMatchObject({ action: "stop" });
    expect(crankNext(failed(null, "User rejected the request."), 1, 900, END)).toMatchObject({ action: "stop", reason: "Your wallet declined it." });
  });

  it("never retries an error no retry can fix, even on the first attempt", () => {
    // Each says why in plain words (not the program's message).
    const reasons: Record<string, RegExp> = {
      AlreadyExecuted: /^The batch has already run\.$/,
      EmptyBatch: /^Nothing was committed to the batch\.$/,
      PoolAlreadyTraded: /^Someone traded on the pool before the batch/,
      WrongLaunchState: /^This launch is not live\.$/,
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const next = crankNext(failed(name, `noised_launchpad: … (${name}, 6000)`), 1, 900, END);
      expect(next.action).toBe("stop");
      expect(next.action === "stop" ? next.reason : "").toMatch(reason);
    }
    // Any other named program error is permanent too, and so is a failure that does not look like a passing one.
    expect(crankNext(failed("MaxBuy", "noised_hook: …"), 1, 900, END)).toMatchObject({ action: "stop" });
    expect(crankNext(failed(null, "insufficient lamports"), 1, 900, END)).toMatchObject({ action: "stop" });
  });

  it("retries the window edge and a busy RPC with a doubling pause, capped", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) => crankNext(failed("NotExecuteWindow"), n, 900, END));
    expect(delays.map((d) => (d.action === "retry" ? d.delayMs : -1))).toEqual([FIRST_DELAY_MS, 3_000, 6_000, 12_000, MAX_DELAY_MS, MAX_DELAY_MS]);
    for (const text of ["429 Too Many Requests", "Blockhash not found", "block height exceeded", "Failed to fetch", "Simulation could not run: timed out"]) {
      expect(crankNext(failed(null, text), 1, 900, END)).toEqual({ action: "retry", delayMs: FIRST_DELAY_MS, retryAt: 902 });
    }
  });

  it("times the retry on the cluster clock it judges the window by, and the page schedules exactly that", () => {
    // 900 s on the cluster clock, whatever the browser's clock says: 1.5 s rounds up to the next whole second.
    expect(crankNext(failed("NotExecuteWindow"), 1, 900, END)).toMatchObject({ retryAt: 902 });
    expect(crankNext(failed("NotExecuteWindow"), 4, 900.7, END)).toMatchObject({ delayMs: 12_000, retryAt: 912 });
    // The token page passes its cluster clock and schedules the returned time (never the browser's own clock: the
    // two can differ by more than the pause, which would retry at once or far too late).
    const page = readFileSync(new URL("../src/pages/token/BatchPanel.tsx", import.meta.url), "utf8");
    const crank = page.slice(page.indexOf("function ExecuteCrank("), page.indexOf("function ClaimForOthers("));
    expect(crank).toMatch(/crankNext\(attemptOf\(o\), attempts\.current, clock\.current, launch\.executeEndTs\)/);
    expect(crank).toMatch(/setRetryAt\(next\.retryAt\)/);
    expect(crank).not.toMatch(/Date\.now\(\)/);
  });

  it("stops when the window closed or after too many attempts", () => {
    expect(crankNext(failed("NotExecuteWindow"), 1, 1_000, END)).toMatchObject({ action: "stop", reason: "The window to start the batch has closed." });
    expect(crankNext(failed("NotExecuteWindow"), MAX_ATTEMPTS, 900, END)).toMatchObject({ action: "stop" });
    expect(crankNext(failed("NotExecuteWindow"), MAX_ATTEMPTS - 1, 900, END).action).toBe("retry");
  });
});

describe("reading an attempt from the transaction flow", () => {
  it("names the program error from a failed simulation, or from a failed send's explanation", () => {
    expect(attemptOf({ status: "confirmed" })).toEqual({ status: "confirmed" });
    expect(attemptOf({ status: "failed", error: "x", report: { ok: false, errorCode: { name: "AlreadyExecuted" } } })).toMatchObject({ errorName: "AlreadyExecuted" });
    expect(attemptOf({ status: "failed", error: "noised_launchpad: outside the window (NotExecuteWindow, 6024)", report: null })).toMatchObject({ errorName: "NotExecuteWindow" });
    expect(attemptOf({ status: "failed", error: "fetch failed" })).toMatchObject({ errorName: null, error: "fetch failed" });
  });
});
