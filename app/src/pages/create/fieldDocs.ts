/**
 * Plain-words explanation of every field a creator chooses (SPEC §1.2
 * `LaunchParams` plus the token metadata), shown next to each input.
 * Time bounds are read from the protocol's POLICY, so the copy follows the
 * program's constants when they change.
 */
import { describeSeconds } from "../../lib/format";
import { POLICY } from "../../lib/noised";

export interface FieldDoc {
  /** `LaunchParams` field name (or metadata field). */
  field: string;
  title: string;
  what: string;
  bounds: string;
}

export const FIELD_DOCS: Record<string, FieldDoc> = {
  name: {
    field: "name",
    title: "Token name",
    what: "Written into the Token-2022 metadata at launch. The metadata update authority is then set to None, so it can never change.",
    bounds: "1 to 32 bytes of UTF-8.",
  },
  symbol: {
    field: "symbol",
    title: "Symbol",
    what: "The ticker in the token metadata. Permanent, like the name.",
    bounds: "1 to 10 bytes.",
  },
  uri: {
    field: "uri",
    title: "Metadata link",
    what: "Noised keeps the token's icon and description itself, on Solana, so the token's metadata link is left empty: nothing off-chain to host, swap or lose.",
    bounds: "Empty (up to 200 bytes is allowed).",
  },
  tokenDecimal: {
    field: "tokenDecimal",
    title: "Decimals",
    what: "How many decimal places one token has (base units per token = 10^decimals). Fixed in the mint.",
    bounds: "6 to 9.",
  },
  sqrtStartPrice: {
    field: "sqrtStartPrice",
    title: "Start price",
    what: "The price of the first token on the bonding curve, in SOL per whole token. Stored by Meteora DBC as a Q64.64 square root of lamports per base unit (sqrtStartPrice).",
    bounds: "Within DBC's representable range; every curve point must be above it.",
  },
  curve: {
    field: "curve",
    title: "Curve",
    what: "The bonding curve as up to 8 points {sqrtPrice, liquidity}: constant-liquidity segments, each ending at its sqrt price. The default design reaches the graduation price exactly when the curve holds the migration threshold, then adds a headroom segment for the last swap.",
    bounds: "1 to 8 points (DBC accepts 16, but the launch transaction must fit one legacy transaction every wallet can sign), strictly increasing sqrt prices, liquidity above zero (DBC validates the rest).",
  },
  migrationQuoteThreshold: {
    field: "migrationQuoteThreshold",
    title: "Graduation threshold",
    what: "How much SOL the curve must hold before it completes. The swap that completes it makes DBC revoke the transfer hook; then anyone can migrate the pool to DAMM v2, where 100% of the liquidity is permanently locked.",
    bounds: "1 to 100,000 SOL.",
  },
  baseFee: {
    field: "baseFee",
    title: "Base trading fee",
    what: "Meteora DBC's base fee: a cliff (starting) fee that can decay linearly or exponentially over a number of periods. The schedule must end before the batch executes, so the batch and everyone after it pay the floor fee; anti-sniping is done by the fair-open batch and the hook instead.",
    bounds: "Cliff at most 99%; floor at least 0.25%; schedule length at most the open delay; floor plus the largest dynamic fee at most 10%.",
  },
  "baseFee.cliffFeeNumerator": {
    field: "baseFee.cliffFeeNumerator",
    title: "Cliff fee",
    what: "The fee at the start of the schedule (equal to the floor when there is no schedule). Stored as a numerator over 1,000,000,000.",
    bounds: "0.25% to 99% (the floor must stay at least 0.25%).",
  },
  "baseFee.baseFeeMode": {
    field: "baseFee.baseFeeMode",
    title: "Schedule mode",
    what: "Linear: the fee drops by a fixed amount each period. Exponential: it drops by a percentage of the current fee each period.",
    bounds: "0 (linear) or 1 (exponential).",
  },
  "baseFee.firstFactor": {
    field: "baseFee.firstFactor",
    title: "Number of periods",
    what: "How many times the fee steps down (DBC first_factor). 0 together with period length 0 and reduction 0 means a flat fee.",
    bounds: "0 to 65,535; all three schedule values set, or all zero.",
  },
  "baseFee.secondFactor": {
    field: "baseFee.secondFactor",
    title: "Period length",
    what: "Seconds per period (DBC second_factor; activation is by timestamp).",
    bounds: "periods x length must not exceed the open delay.",
  },
  "baseFee.thirdFactor": {
    field: "baseFee.thirdFactor",
    title: "Reduction per period",
    what: "Linear mode: fee numerator removed each period. Exponential mode: basis points of the current fee removed each period.",
    bounds: "Exponential: below 10,000 bps. Linear: the floor may not go below 0.25%.",
  },
  dynamicFee: {
    field: "dynamicFee",
    title: "Dynamic fee",
    what: "Optional volatility fee added on top of the base fee by DBC (and carried into DAMM v2 after graduation). It rises with recent price movement and decays back.",
    bounds: "Bin step fixed at 1 bps; filter period below decay period; floor plus the maximum dynamic fee at most 10%.",
  },
  "dynamicFee.filterPeriod": {
    field: "dynamicFee.filterPeriod",
    title: "Filter period",
    what: "Seconds within which trades count as one burst of volatility.",
    bounds: "Below the decay period.",
  },
  "dynamicFee.decayPeriod": {
    field: "dynamicFee.decayPeriod",
    title: "Decay period",
    what: "Seconds after which accumulated volatility starts to decay.",
    bounds: "0 to 65,535 and above the filter period.",
  },
  "dynamicFee.reductionFactor": {
    field: "dynamicFee.reductionFactor",
    title: "Reduction factor",
    what: "How much accumulated volatility is kept when it decays, in basis points.",
    bounds: "At most 10,000 bps.",
  },
  "dynamicFee.maxVolatilityAccumulator": {
    field: "dynamicFee.maxVolatilityAccumulator",
    title: "Max volatility accumulator",
    what: "Upper bound of the volatility measure; together with the fee control it caps the dynamic fee.",
    bounds: "At most 16,777,215.",
  },
  "dynamicFee.variableFeeControl": {
    field: "dynamicFee.variableFeeControl",
    title: "Variable fee control",
    what: "Scales volatility into fee: max fee = ceil((accumulator x bin step)^2 x control / 10^11) over 10^9.",
    bounds: "At most 16,777,215.",
  },
  migrationFeeOption: {
    field: "migrationFeeOption",
    title: "DAMM v2 fee tier",
    what: "The fixed trading fee of the DAMM v2 pool the curve graduates into. DAMM v2 operators can still raise a pool's fee later (up to 10%): see Who you still trust.",
    bounds: "0.25%, 0.3%, 1%, 2%, 4% or 6% (options 0 to 5).",
  },
  openDelaySecs: {
    field: "openDelaySecs",
    title: "Commit window",
    what: "How long the fair-open batch accepts commits after launch. Nobody can buy from the pool during it, not even the creator.",
    bounds: `${describeSeconds(POLICY.MIN_OPEN_DELAY)} to ${describeSeconds(POLICY.MAX_OPEN_DELAY)}.`,
  },
  guardSecs: {
    field: "guardSecs",
    title: "Guard length",
    what: "How long after launch the guard rules (max wallet, max buy, wallet-to-wallet pause) apply. Every rule ends at the same moment; sells are never blocked.",
    bounds: `At least the commit window plus the execution window (${describeSeconds(POLICY.EXECUTION_GRACE_SECS)}); at most ${POLICY.MAX_GUARD_SECS / 3_600} hours.`,
  },
  maxWalletBps: {
    field: "maxWalletBps",
    title: "Max wallet",
    what: "During the guard, no receiving account may hold more than this share of the initial supply (the batch and launch PDAs are exempt).",
    bounds: "0 (off) or 0.1% to 100%.",
  },
  maxBuyBps: {
    field: "maxBuyBps",
    title: "Max buy",
    what: "During the guard, no single transfer may move more than this share of the initial supply.",
    bounds: "0 (off) or 0.01% to 100%.",
  },
  p2pLocked: {
    field: "p2pLocked",
    title: "Pause wallet-to-wallet transfers",
    what: "During the guard, only buys from and sells to the pool are allowed, which stops caps being dodged by moving tokens between wallets. Sells always work.",
    bounds: "On or off.",
  },
  batchWalletCap: {
    field: "batchWalletCap",
    title: "Per-wallet batch cap",
    what: "The most SOL one wallet may commit to the batch. Commits are pro rata, so the cap limits size, not price.",
    bounds: "0 means no cap.",
  },
  batchTotalCap: {
    field: "batchTotalCap",
    title: "Batch total cap",
    what: "The most SOL the batch swap spends. Commits above it are still accepted: the swap spends the cap, every commit gets the same share of it, and the rest is refunded at claim, so committing early gives no advantage. A cap far below the threshold leaves most of the curve to buyers after the batch (verification warns below 10%).",
    bounds: "0 means the graduation threshold; at most the threshold.",
  },
  recipients: {
    field: "recipients",
    title: "Fee recipients",
    what: "Who receives the creator share of trading fees (after the platform share), split by percentage. Recipients and shares are written once and can never change.",
    bounds: "1 to 4 distinct wallets, shares adding up to 100%, no all-zero address, not the launch's own program addresses.",
  },
};
