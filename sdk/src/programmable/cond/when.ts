/**
 * Fluent condition builders shared by launch rules and autopilot graphs:
 *
 *   when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(10))
 *   when.treasurySolGte(1).and(when.graduated())
 *
 * A Condition wraps a plain, serializable tree (`.ast`). Rule leaves and
 * graph leaves share one namespace; using one in the wrong context fails
 * when the rule set / graph is built, with a plain-English message.
 */
import { type KeyInput, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import { type Duration, type Percent, type SolAmount, type TokenAmount, toLamports, toSeconds, toUnix } from "../units.js";
import { type Amount, type Cond, toAmount } from "./ast.js";

export class Condition {
  constructor(readonly ast: Cond) {}
  /** Both this and `other`. */
  and(other: CondLike): Condition {
    return new Condition({ op: "and", a: this.ast, b: condOf(other) });
  }
  /** This or `other`. */
  or(other: CondLike): Condition {
    return new Condition({ op: "or", a: this.ast, b: condOf(other) });
  }
  /** The opposite of this. */
  not(): Condition {
    return new Condition({ op: "not", x: this.ast });
  }
}

/** A Condition, or a plain tree. */
export type CondLike = Condition | Cond;

export const condOf = (c: CondLike): Cond => (c instanceof Condition ? c.ast : c);

/** A wallet / program for a list leaf: an address, a key label, or a PublicKey. */
export type KeyRef = KeyInput;

function keyRef(k: KeyRef): string {
  if (typeof k === "string") return k; // address or label, resolved at build time
  return toAddress(k);
}

function keyList(ks: KeyRef | readonly KeyRef[]): string[] {
  const list = Array.isArray(ks) ? (ks as readonly KeyRef[]) : [ks as KeyRef];
  if (list.length === 0) throw new ProgError("BadModel", "a wallet list needs at least one entry");
  return list.map(keyRef);
}

function count(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new ProgError("BadModel", `${what} must be a whole number`);
  return n;
}

/** A token amount or share of supply: 1000 (tokens), 1_000_000n (raw), "0.5%", "25bps", { bps: 50 }. */
export type SupplyAmount = TokenAmount | Percent | Amount;

const C = (c: Cond): Condition => new Condition(c);

export const when = {
  /** Always true. */
  always: (): Condition => C({ op: "true" }),
  /** Always false. */
  never: (): Condition => C({ op: "false" }),

  // ---------------------------------------------------- launch rules ---
  /** The transfer is a buy from the pool. */
  buy: (): Condition => C({ op: "buy" }),
  /** A wallet-to-wallet transfer (neither side is the pool or the protocol). */
  p2p: (): Condition => C({ op: "p2p" }),
  /** Less than `d` has passed since the launch opened. */
  timeLt: (d: Duration): Condition => C({ op: "timeLt", secs: toSeconds(d, "time") }),
  /** At least `d` has passed since the launch opened. */
  timeGe: (d: Duration): Condition => C({ op: "timeGe", secs: toSeconds(d, "time") }),
  /** The transfer moves more than `x` (tokens, raw bigint, or a share like "0.5%"). */
  amountGt: (x: SupplyAmount): Condition => C({ op: "amountGt", amount: toAmount(x, "amount") }),
  /** The receiver would hold more than `x` after the transfer. */
  balanceGt: (x: SupplyAmount): Condition => C({ op: "balanceGt", amount: toAmount(x, "balance") }),
  /** The receiving wallet is one of `keys` (addresses or key labels). */
  toIn: (keys: KeyRef | readonly KeyRef[]): Condition => C({ op: "toIn", keys: keyList(keys) }),
  /** The sending wallet is one of `keys`. */
  fromIn: (keys: KeyRef | readonly KeyRef[]): Condition => C({ op: "fromIn", keys: keyList(keys) }),
  /** The transaction's current top-level instruction runs one of these programs. */
  programIn: (keys: KeyRef | readonly KeyRef[]): Condition => C({ op: "programIn", keys: keyList(keys) }),
  /** The transaction has more than `n` top-level instructions. */
  txIxCountGt: (n: number): Condition => C({ op: "ixCountGt", n: count(n, "instruction count") }),

  // ---------------------------------------------------- autopilot ---
  /** The treasury holds at least `sol` SOL (number) / lamports (bigint). */
  treasurySolGte: (sol: SolAmount): Condition => C({ op: "treasurySolGte", lamports: toLamports(sol, "treasury SOL") }),
  /** The treasury holds at least `tokens` tokens (number) / raw units (bigint). */
  treasuryTokensGte: (tokens: TokenAmount): Condition =>
    C({ op: "treasuryTokensGte", amount: typeof tokens === "bigint" ? { raw: tokens } : { tokens: String(tokens) } }),
  /** The token has graduated (migrated to its locked DAMM v2 pool). */
  graduated: (): Condition => C({ op: "graduated" }),
  /** The reference price is at most `p` SOL per token (number/string) or sqrt Q64 (bigint). */
  priceLte: (p: number | string | bigint): Condition =>
    C({ op: "priceLte", price: typeof p === "bigint" ? { sqrtPriceQ64: p } : { sol: String(p) } }),
  /** The reference price is at least `p`. */
  priceGte: (p: number | string | bigint): Condition =>
    C({ op: "priceGte", price: typeof p === "bigint" ? { sqrtPriceQ64: p } : { sol: String(p) } }),
  /** It is before `t` (Date, unix seconds, or "2026-12-01"). */
  before: (t: Date | number | bigint | string): Condition => C({ op: "nowLt", unix: toUnix(t) }),
  /** It is `t` or later. */
  onOrAfter: (t: Date | number | bigint | string): Condition => C({ op: "nowGe", unix: toUnix(t) }),
  /** Node `node` has run fewer than `n` times in its current budget epoch. */
  runsInEpochLt: (node: string, n: number): Condition => C({ op: "runsInEpochLt", node, n: count(n, "run count") }),
} as const;

/** All of the conditions (true if empty). */
export function all(...cs: CondLike[]): Condition {
  if (cs.length === 0) return when.always();
  return cs.slice(1).reduce<Condition>((acc, c) => acc.and(c), new Condition(condOf(cs[0]!)));
}

/** Any of the conditions (false if empty). */
export function any(...cs: CondLike[]): Condition {
  if (cs.length === 0) return when.never();
  return cs.slice(1).reduce<Condition>((acc, c) => acc.or(c), new Condition(condOf(cs[0]!)));
}

/** The opposite of `c`. */
export function not(c: CondLike): Condition {
  return new Condition({ op: "not", x: condOf(c) });
}
