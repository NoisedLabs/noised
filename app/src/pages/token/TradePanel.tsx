/** Buy and sell through Meteora DBC (curve) or DAMM v2 (after graduation); a buy can go straight into the quantum vault. */
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Alert, Button, Field, Segmented } from "../../components/ui";
import { formatSol, formatUnits, SOL_DECIMALS, tryParseUnits } from "../../lib/amounts";
import { formatTimestamp, shortKey } from "../../lib/format";
import { buildSwapTx, capFromBps, getSolBalance, getTokenBalance, type LaunchAccount, type LaunchPhase, type SwapSide } from "../../lib/noised";
import { closesWsolAccount, swapWsolNote } from "../../lib/wsol";
import { AmountInput, Readout, Reason, Row } from "../inner/kit";
import { useVaultTarget, VaultChoice } from "./VaultTarget";

const SLIPPAGES = [50, 100, 300] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * `sellOnly`: the site hides this launch (lib/brandGuard.ts): no buying here, but anyone who holds it can still sell, so
 * nobody is trapped.
 */
export function TradePanel({ launch, phase, now, symbol, sellOnly = false }: { launch: LaunchAccount; phase: LaunchPhase; now: number; symbol: string; sellOnly?: boolean }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const mint = launch.baseMint;
  const [picked, setSide] = useState<SwapSide>(sellOnly ? "sell" : "buy");
  const side: SwapSide = sellOnly ? "sell" : picked;
  const [text, setText] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const decimals = side === "buy" ? SOL_DECIMALS : launch.tokenDecimal;
  const amount = tryParseUnits(text, decimals);
  const debounced = useDebounced(amount, 350);
  // A buy can be paid straight into the user's quantum vault (the swap's recipient).
  const target = useVaultTarget(mint);
  const [toVaultChoice, setToVault] = useState(false);
  const toVault = side === "buy" && toVaultChoice;
  const vaultReady = !toVault || (target.vault !== null && target.opened === true);

  const sol = useAsync(() => (me ? getSolBalance(connection, me) : Promise.resolve(null)), [connection, me?.toBase58()]);
  const tokens = useAsync(() => (me ? getTokenBalance(connection, me, mint) : Promise.resolve(null)), [connection, me?.toBase58(), mint.toBase58()]);

  const shielded = BigInt(now) < launch.executeEndTs;
  const graduating = launch.market?.curveComplete === true && launch.market.migrated !== true;
  const buyBlocked = side === "buy" && shielded;
  const blocked = buyBlocked || graduating;

  const quote = useAsync(
    async () => (me && debounced !== null && debounced > 0n && !blocked ? (await buildSwapTx(connection, me, mint, side, debounced, slippageBps)).quote : null),
    [connection, me?.toBase58(), mint.toBase58(), side, debounced, slippageBps, blocked],
    { watchChain: false },
  );

  // The hook's caps were written at launch from the initial supply (`policy::cap_from_bps`).
  const supply = launch.market?.initialSupply ?? 0n;
  const maxBuy = capFromBps(supply, launch.maxBuyBps) ?? 0n;
  const maxWallet = capFromBps(supply, launch.maxWalletBps) ?? 0n;
  const guarded = phase === "guarded" || phase === "execute" || phase === "commit";
  const warnings: string[] = [];
  const q = quote.data;
  if (q && side === "buy" && guarded && !launch.market?.curveComplete) {
    if (maxBuy > 0n && q.expectedOut > maxBuy) warnings.push(`This buy is above the early limit of ${formatUnits(maxBuy, launch.tokenDecimal, 0)} ${symbol} per buy: it is refused until ${formatTimestamp(launch.guardEndTs)}.`);
    const after = (tokens.data ?? 0n) + q.expectedOut;
    if (maxWallet > 0n && after > maxWallet && !toVault) warnings.push(`You would hold more than the early limit of ${formatUnits(maxWallet, launch.tokenDecimal, 0)} ${symbol} per wallet: it is refused until ${formatTimestamp(launch.guardEndTs)}.`);
  }

  let inputError: string | null = null;
  if (text.trim() !== "" && amount === null) inputError = `Enter a number with at most ${decimals} decimals.`;
  else if (amount !== null && side === "sell" && tokens.data !== undefined && tokens.data !== null && amount > tokens.data) inputError = `You hold ${formatUnits(tokens.data, launch.tokenDecimal)} ${symbol}.`;
  else if (amount !== null && side === "buy" && sol.data !== undefined && sol.data !== null && amount > sol.data) inputError = `Your balance is ${formatSol(sol.data, 4)}.`;

  // Named in the signing review (what the transaction does), not on the page.
  const venue = launch.market?.migrated ? "Meteora DAMM v2" : "Meteora DBC bonding curve";
  const canReview = me !== null && amount !== null && amount > 0n && inputError === null && !blocked && q !== null && q !== undefined && vaultReady;

  return (
    <div className="tk-trade" id="trade">
      <header className="tk-act-head">
        <h2 className="tk-act-title">{sellOnly ? "Sell" : "Trade"}</h2>
        <p className="tk-act-sub">
          {sellOnly ? "Buying is turned off here for this token. If you hold it, you can still sell it." : "Your trade goes straight to the token's pool. Selling is never blocked."}
        </p>
      </header>
      <div className="tk-act-stack">
        <div className="tk-trade-top">
          {sellOnly ? null : (
            <Segmented<SwapSide>
            label="Trade side"
            value={side}
            onChange={(s) => {
              setSide(s);
              setText("");
            }}
            options={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
          />
          )}
          <div className="tk-trade-bal pg-num">
            {me ? (
              <>
                {sol.data !== undefined && sol.data !== null ? formatSol(sol.data, 4) : "…"} ·{" "}
                {tokens.data !== undefined && tokens.data !== null ? `${formatUnits(tokens.data, launch.tokenDecimal, 2)} ${symbol}` : "…"}
              </>
            ) : (
              "Connect a wallet to trade"
            )}
          </div>
        </div>

        {buyBlocked ? (
          <Alert tone="info" title="Buys are closed until the batch has executed">
            The snipe shield refuses every buy from the pool until {formatTimestamp(launch.executeEndTs)}, so nobody, including the creator, trades ahead
            of the fair-open batch. {phase === "commit" ? "Commit to the batch instead." : ""}
          </Alert>
        ) : null}
        {graduating ? (
          <Alert tone="info" title="Graduating">
            The curve is complete. Trading starts again in the bigger pool as soon as anyone moves it there (anyone can).
          </Alert>
        ) : null}

        <Field label={side === "buy" ? "You pay (SOL)" : `You sell (${symbol})`} error={inputError}>
          {(ids) => (
            <AmountInput
              id={ids.input}
              value={text}
              onChange={setText}
              unit={side === "buy" ? "SOL" : symbol}
              invalid={ids.invalid}
              describedBy={ids.describedBy}
              disabled={!me || blocked}
            />
          )}
        </Field>

        <div className="tk-slip">
          <span className="tk-slip-k" id="slippage-label">
            Max slippage
          </span>
          <div className="seg" role="group" aria-labelledby="slippage-label">
            {SLIPPAGES.map((s) => (
              <button key={s} type="button" aria-pressed={slippageBps === s} onClick={() => setSlippageBps(s)}>
                {s / 100}%
              </button>
            ))}
          </div>
        </div>

        {q && !blocked ? (
          <div className="tk-quote">
            <p className="tk-quote-k">You get about</p>
            <p className="tk-quote-v pg-num">{side === "buy" ? `${formatUnits(q.expectedOut, launch.tokenDecimal)} ${symbol}` : formatSol(q.expectedOut, 6)}</p>
            <Readout label="Quote">
              <Row k="Minimum (reverts below)">{side === "buy" ? `${formatUnits(q.minimumOut, launch.tokenDecimal)} ${symbol}` : formatSol(q.minimumOut, 6)}</Row>
              {side === "buy" && q.amountIn < (amount ?? 0n) ? (
                <Row k="Partial fill" wide tone="warn">
                  Only {formatSol(q.amountIn, 4)} fits before the curve graduates; the rest stays in your wallet.
                </Row>
              ) : null}
              <Row k="Trading fee">
                {q.feeBps === null ? "included in the expected amount" : `${q.feeBps / 100}%`}
                {q.feeAmount === null ? "" : ` (${formatSol(q.feeAmount, 6)})`}
              </Row>
              <Row k="Price impact" tone={q.priceImpactBps !== null && q.priceImpactBps > 500 ? "warn" : undefined}>
                {q.priceImpactBps === null ? "n/a" : `${(q.priceImpactBps / 100).toFixed(2)}%`}
              </Row>
              <Row k="Where" wide>
                {q.venue === "dbc" ? "The price curve" : "The locked pool"}
                <span className="pg-note">{q.method === "dbc-sdk" ? " (worked out with the pool's own maths)" : " (checked by trying this exact trade first)"}</span>
              </Row>
            </Readout>
          </div>
        ) : null}
        {quote.error ? <Alert tone="fail" title="Could not quote">{quote.error}</Alert> : null}
        {warnings.map((w) => (
          <Alert key={w} tone="warn">
            {w}
          </Alert>
        ))}

        {side === "buy" && !sellOnly ? <VaultChoice mint={mint} symbol={symbol} target={target} checked={toVault} onChange={setToVault} label="Send what I buy to my quantum vault" /> : null}
        {/* Why the primary is unavailable, right above it (the navbar's Connect glows while this shows). */}
        {!me ? <Reason id="trade-reason">Connect a wallet to trade</Reason> : null}
        <Button
          variant="primary"
          className="pg-wide"
          disabled={!canReview}
          aria-describedby={!me ? "trade-reason" : undefined}
          onClick={() => {
            if (!me || amount === null || !q) return;
            const user = me;
            const amountIn = amount;
            const swap =
              side === "buy"
                ? `Wraps ${formatSol(amountIn, 4)} into wSOL and swaps it on ${venue}; reverts if you would get less than ${formatUnits(q.minimumOut, launch.tokenDecimal)} ${symbol}.`
                : `Swaps ${formatUnits(amountIn, launch.tokenDecimal)} ${symbol} on ${venue}; reverts if you would get less than ${formatSol(q.minimumOut, 6)}.`;
            const tradeSide = side;
            const recipient = toVault ? target.vault : null;
            const into = recipient === null ? [] : [`Pays the ${symbol} into your quantum vault ${shortKey(recipient)}: only your quantum key can move it out.`];
            void run({
              title: side === "buy" ? `Buy ${symbol} with ${formatSol(amountIn, 4)}` : `Sell ${formatUnits(amountIn, launch.tokenDecimal)} ${symbol}`,
              summary: [swap, ...into],
              build: async () => {
                const { tx, warnings: cautions } = await buildSwapTx(connection, user, mint, tradeSide, amountIn, slippageBps, recipient === null ? {} : { recipient });
                // What happens to the wSOL account is read from the built transaction; the SDK's cautions about the recipient are shown above the review.
                return { tx, summary: [swap, ...into, swapWsolNote(tradeSide, closesWsolAccount(tx, user))], notice: cautions.length === 0 ? null : `About where it goes: ${cautions.join("; ")}.` };
              },
            }).then((o) => {
              if (o.status === "confirmed") setText("");
            });
          }}
        >
          Review {side === "buy" ? "buy" : "sell"}
        </Button>
      </div>
    </div>
  );
}
