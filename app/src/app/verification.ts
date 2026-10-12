/**
 * Cached, rate-limited `verifyLaunch` for lists: each report costs several
 * RPC reads, so the launch list verifies at most three mints at a time,
 * skips the DAMM v2 operator listing (a getProgramAccounts scan; the token
 * page's full report includes it) and reuses a report for a minute. Token
 * pages call `verifyLaunch` directly.
 */
import type { Connection, PublicKey } from "@solana/web3.js";

import { checkQsl1, verifyLaunch, type VerificationReport } from "../lib/noised";
import type { QslVerdict } from "../lib/qsl";

const TTL_MS = 60_000;
const LIMIT = 3;
const cache = new Map<string, { at: number; report: VerificationReport }>();
const inflight = new Map<string, Promise<VerificationReport>>();
const queue: (() => void)[] = [];
let running = 0;

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < LIMIT) start();
    else queue.push(start);
  });
}

export function verifyCached(conn: Connection, mint: PublicKey): Promise<VerificationReport> {
  const id = mint.toBase58();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.report);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = schedule(() => verifyLaunch(conn, mint, { listOperators: false }))
    .then((report) => {
      cache.set(id, { at: Date.now(), report });
      return report;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

const qslCache = new Map<string, { at: number; verdict: QslVerdict }>();
const qslInflight = new Map<string, Promise<QslVerdict>>();

/** `checkQsl1` for lists (the launch cards' QSL-1 badge): the same queue, reused for a minute. */
export function qslCached(conn: Connection, mint: PublicKey): Promise<QslVerdict> {
  const id = mint.toBase58();
  const hit = qslCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.verdict);
  const pending = qslInflight.get(id);
  if (pending) return pending;
  const p = schedule(() => checkQsl1(conn, mint))
    .then((verdict) => {
      qslCache.set(id, { at: Date.now(), verdict });
      return verdict;
    })
    .finally(() => qslInflight.delete(id));
  qslInflight.set(id, p);
  return p;
}
