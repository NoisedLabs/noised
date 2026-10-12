/**
 * Privacy (the shield): wrap a token 1:1 into its zToken, hide the amount in a
 * Token-2022 confidential balance, unwrap any time. Plain words up top (what is
 * hidden and what stays public, honestly), the fine print and the command line
 * one click away. Every transaction goes through the reviewed flow (app/tx).
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useAsync } from "../app/hooks";
import { useTx } from "../app/tx";
import { useOwner } from "../app/wallet";
import { Address, Alert, Button, Field, Segmented } from "../components/ui";
import { formatUnits, tryParseUnits } from "../lib/amounts";
import { formatTimestamp } from "../lib/format";
import {
  buildCreateShieldTx,
  buildUnwrapTx,
  buildWrapTx,
  fetchShield,
  getMintInfo,
  getTokenBalance,
  getTokenSupply,
  listLaunches,
  shieldAddresses,
} from "../lib/noised";
import { AmountInput, Chip, Compare, Details, DotBar, EmptyState, Feats, Grad, Metric, PageHead, Panel, Readout, Reason, Row, Tiles, type CompareColumn, type FeatItem } from "./inner/kit";
import { PageArt } from "./inner/art";
import { DotGlyph } from "./inner/glyphs";

const STEPS: readonly FeatItem[] = [
  {
    title: "Make private copies",
    text: "Your tokens are held safely by the app, and you get the same number of private copies back.",
    icon: <DotGlyph name="wrap" />,
  },
  {
    title: "Hide the amount",
    text: "Move your private copies into a hidden balance. The amount is encrypted on Solana.",
    icon: <DotGlyph name="hide" />,
  },
  {
    title: "Turn back any time",
    text: "Hand back your private copies and get the same tokens back. Turn back before you trade.",
    icon: <DotGlyph name="unwrap" />,
  },
];

/** What a confidential balance hides, and what anyone can still see. */
const VISIBILITY: readonly CompareColumn[] = [
  {
    title: "Hidden",
    mark: "check",
    items: [
      { k: "Your hidden balance", v: "Encrypted under your own key while it is hidden." },
      { k: "How much you send", v: "The amount when you send private copies from your hidden balance." },
    ],
  },
  {
    title: "Still public",
    mark: "eye",
    items: [
      { k: "Who sends to whom", v: "That a transfer happened, and between which accounts and owners." },
      { k: "Copies made and turned back", v: "How many tokens you turn into private copies, and back." },
      { k: "Hiding and un-hiding", v: "Moving between your public and hidden balance shows the amount." },
      { k: "Timing and fees", v: "When you act, who pays the fee and the transaction graph." },
      { k: "Totals", v: "How many private copies exist, and the tokens held behind them." },
    ],
  },
];

export function ShieldPage(): ReactNode {
  const { connection } = useConnection();
  const launches = useAsync(() => listLaunches(connection), [connection], { watchChain: false });
  const [mint, setMint] = useState<PublicKey | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = (launches.data ?? []).filter((l) => l.status === "live" && l.market);

  return (
    <div className="pg pg-shield">
      <PageHead
        art={<PageArt scene="privacy" />}
        eyebrow="Privacy"
        title={
          <>
            Privacy, <Grad>by choice</Grad>
          </>
        }
        lede="Turn a token into private copies to hide how much you hold and send. Who you deal with stays public, and this encryption is not quantum-proof."
      />
      <Feats items={STEPS} label="How private balances work, in three steps" />

      <Panel
        title="What stays private"
        glyph={<DotGlyph name="hide" />}
        description="It hides how much, not who."
        status={<Chip tone="warn">Not quantum-proof</Chip>}
      >
        <Compare columns={VISIBILITY} />
        <Details summary="The fine print">
          <ul className="pg-list">
            <li>
              <strong className="pg-strong">Amounts, not parties.</strong> Everyone can still see which accounts transact with which. Wrapping 1,234.5678 and
              someone unwrapping 1,234.5678 later is a visible link.
            </li>
            <li>
              <strong className="pg-strong">This encryption is not quantum-proof.</strong> A future quantum computer could read amounts recorded today
              ("harvest now, decrypt later").
            </li>
            <li>
              <strong className="pg-strong">Your wallet key can read it.</strong> The hiding keys come from your wallet's signature, so anyone with your
              wallet key can read your hidden balance.
            </li>
            <li>
              <strong className="pg-strong">It can be switched off.</strong> Solana's token program can be upgraded by a 4-of-6 multisig, and validators can
              switch off the proof program hidden balances need; it was off from 2025-06-19 to 2026-06-04, and hidden balances could not be taken out
              meanwhile. Copies outside your hidden balance can always be turned back. Hide only what you can afford to have stuck for a long time.
            </li>
            <li>No exchange trades hidden balances: turn back to trade.</li>
          </ul>
        </Details>
      </Panel>

      <Panel title="Choose a token" glyph={<DotGlyph name="wrap" />} description="Any Noised token works. Pick one, or paste a token address.">
        <form
          className="pg-pick"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setMint(new PublicKey(text.trim()));
              setError(null);
            } catch {
              setError("That doesn't look like a token address.");
            }
          }}
        >
          <div>
            <label className="label" htmlFor="shield-pick">
              Noised token
            </label>
            <select
              id="shield-pick"
              className="select"
              value={mint?.toBase58() ?? ""}
              onChange={(e) => {
                if (e.target.value === "") return;
                setMint(new PublicKey(e.target.value));
                setText("");
                setError(null);
              }}
            >
              <option value="">Choose a token…</option>
              {options.map((l) => (
                <option key={l.baseMint.toBase58()} value={l.baseMint.toBase58()}>
                  {l.market?.symbol}: {l.market?.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="shield-mint">
              Or paste a token address
            </label>
            <input
              id="shield-mint"
              className="input mono"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error !== null}
              aria-describedby={error ? "shield-mint-error" : undefined}
            />
          </div>
          <Button type="submit">Use this token</Button>
          {error ? (
            <p id="shield-mint-error" className="field-error pg-span-all">
              {error}
            </p>
          ) : null}
        </form>
        {mint ? null : <EmptyState art={<DotGlyph name="wrap" />}>Pick a token to see its private copies, or to make some.</EmptyState>}
      </Panel>

      {mint ? <ShieldPanel key={mint.toBase58()} baseMint={mint} /> : null}

      <p className="pg-hint pg-shield-docs">
        Hiding the balance itself is done with Solana's own wallet tools, on your machine.{" "}
        <Link to="/docs/guides/private-balances" className="pg-link">
          Step-by-step guide in the Docs
        </Link>
        .
      </p>
    </div>
  );
}

function ShieldPanel({ baseMint }: { baseMint: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const shield = useAsync(() => fetchShield(connection, baseMint), [connection, baseMint.toBase58()]);
  const base = useAsync(() => getMintInfo(connection, baseMint), [connection, baseMint.toBase58()], { watchChain: false });
  const s = shield.data ?? null;
  const addresses = s ? { shield: s.publicKey, zMint: s.zMint, escrow: s.escrow, authority: shieldAddresses(baseMint).authority } : shieldAddresses(baseMint);
  // The zToken mint and the escrow exist only once the shield does.
  const exists = { enabled: s !== null };
  const supply = useAsync(() => getTokenSupply(connection, addresses.zMint), [connection, addresses.zMint.toBase58()], exists);
  const escrow = useAsync(() => getTokenBalance(connection, addresses.authority, baseMint), [connection, addresses.authority.toBase58(), baseMint.toBase58()], exists);
  const myBase = useAsync(() => (me ? getTokenBalance(connection, me, baseMint) : Promise.resolve(null)), [connection, me?.toBase58(), baseMint.toBase58()], exists);
  const myZ = useAsync(() => (me ? getTokenBalance(connection, me, addresses.zMint) : Promise.resolve(null)), [connection, me?.toBase58(), addresses.zMint.toBase58()], exists);
  const decimals = base.data?.decimals ?? s?.decimals ?? 0;
  const symbol = base.data?.symbol ?? "tokens";
  const zSymbol = `z${symbol}`.slice(0, 10);

  if (base.data === null) return <Alert tone="fail" title="No such mint">This address is not a token mint on this cluster.</Alert>;
  if (shield.loading && shield.data === undefined) return <p className="pg-wait">Reading the shield…</p>;

  if (!s) {
    return (
      <Panel
        title={`Private copies of ${symbol} are not set up yet`}
        description="Anyone can set them up, once per token. After that, everyone can make private copies and turn them back."
        status={<Chip tone="muted">Not created</Chip>}
      >
        <Details summary="What setting it up does">
          <p className="pg-text">
            The shield program checks the base mint (only MetadataPointer, TokenMetadata, TransferHook and TransferFeeConfig extensions are accepted), then
            creates the zToken mint with confidential balances, no freeze authority, no auditor and immutable metadata.
          </p>
        </Details>
        {!me ? <Reason>Connect a wallet to set it up.</Reason> : null}
        <Button
          className="pg-self-start"
          variant="primary"
          disabled={!me}
          onClick={() =>
            me &&
            void run({
              title: `Create the ${symbol} shield`,
              summary: [
                `Creates the shield account, the ${zSymbol} mint and the escrow for ${symbol}.`,
                "The zToken's only mint authority is a shield PDA that mints exactly what the escrow receives; the program checks zToken supply equals the escrow balance after every instruction.",
                "You pay the rent of the new accounts.",
              ],
              build: () => buildCreateShieldTx(connection, me, baseMint),
            }).then(() => shield.reload())
          }
        >
          Set up private copies
        </Button>
      </Panel>
    );
  }

  // The program enforces escrow >= supply (SPEC §2; docs/PRIVACY.md "Why at least"): donations to the escrow and direct burns only add surplus.
  const backed = supply.data !== undefined && escrow.data !== undefined ? escrow.data >= supply.data : null;
  const surplus = backed === true && supply.data !== undefined && escrow.data !== undefined ? escrow.data - supply.data : 0n;
  return (
    <>
      <Panel
        title={`Private ${symbol}`}
        description={`Set up ${formatTimestamp(s.createdAt)}. Anyone could set it up, and nobody owns it.`}
        status={backed === true ? <Chip tone="ok">Fully backed</Chip> : backed === false ? <Chip tone="danger">Not fully backed</Chip> : <Chip tone="muted" pulse>Reading</Chip>}
      >
        <Tiles label={`${symbol} shield balances`}>
          <Metric label={`Private copies (${zSymbol})`} value={supply.data === undefined ? "…" : formatUnits(supply.data, decimals, 2)} />
          <Metric label={`${symbol} held safely`} value={escrow.data === undefined ? "…" : formatUnits(escrow.data, decimals, 2)} tone="ok" />
          <Metric label={`Your ${symbol}`} value={myBase.data === undefined || myBase.data === null ? "—" : formatUnits(myBase.data, decimals, 2)} />
          <Metric label={`Your ${zSymbol} (not hidden)`} value={myZ.data === undefined || myZ.data === null ? "—" : formatUnits(myZ.data, decimals, 2)} />
        </Tiles>
        {supply.data !== undefined && escrow.data !== undefined ? (
          <div className="pg-gauge">
            <div className="pg-gauge-top">
              <span>Tokens held behind the copies</span>
              <span className="pg-num">{backed === true ? "≥ 1.00×" : "below supply"}</span>
            </div>
            <DotBar value={backed === true ? 1 : 0} max={1} tone={backed === true ? "ok" : "danger"} label="Tokens held behind the private copies" />
          </div>
        ) : null}
        {backed === true ? (
          <Alert tone="ok" title="Fully backed: every private copy has a real token behind it.">
            {surplus > 0n
              ? `An extra ${formatUnits(surplus, decimals)} ${symbol} (donations, or copies destroyed directly) stays held and is never paid out.`
              : "Copies and tokens held are equal."}
          </Alert>
        ) : null}
        {backed === false ? (
          <Alert tone="fail" title="Not fully backed">
            The program checks after every step that every private copy has a token behind it, so this should be impossible. Do not make copies.
          </Alert>
        ) : null}
        <Details summary="Addresses">
          <Readout label="Addresses">
            <Row k="Private copy token">
              <Address value={s.zMint} explorer />
            </Row>
            <Row k="Held tokens account">
              <Address value={s.escrow} explorer />
            </Row>
            <Row k="Shield account">
              <Address value={s.publicKey} explorer />
            </Row>
            <Row k="Base token program">
              <Address value={s.baseTokenProgram} />
            </Row>
          </Readout>
        </Details>
      </Panel>
      <WrapUnwrap baseMint={baseMint} decimals={decimals} symbol={symbol} zSymbol={zSymbol} baseBalance={myBase.data ?? null} zBalance={myZ.data ?? null} />
    </>
  );
}

function WrapUnwrap({
  baseMint,
  decimals,
  symbol,
  zSymbol,
  baseBalance,
  zBalance,
}: {
  baseMint: PublicKey;
  decimals: number;
  symbol: string;
  zSymbol: string;
  baseBalance: bigint | null;
  zBalance: bigint | null;
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const [op, setOp] = useState<"wrap" | "unwrap">("wrap");
  const [text, setText] = useState("");
  const amount = tryParseUnits(text, decimals);
  const available = op === "wrap" ? baseBalance : zBalance;
  let error: string | null = null;
  if (text.trim() !== "" && amount === null) error = `Enter an amount with at most ${decimals} decimals.`;
  else if (amount !== null && available !== null && amount > available) error = `You have ${formatUnits(available, decimals)} ${op === "wrap" ? symbol : `public ${zSymbol}`}.`;
  return (
    <Panel
      title="Make copies or turn back"
      description={op === "wrap" ? `Turn ${symbol} into the same number of private copies (${zSymbol}).` : `Turn ${zSymbol} back into the same number of ${symbol}.`}
      status={<Chip tone="signal">{op === "wrap" ? `${symbol} → ${zSymbol}` : `${zSymbol} → ${symbol}`}</Chip>}
    >
      <form
        className="pg-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!me || amount === null || amount === 0n || error) return;
          void run({
            title: op === "wrap" ? `Wrap ${formatUnits(amount, decimals)} ${symbol}` : `Unwrap ${formatUnits(amount, decimals)} ${zSymbol}`,
            summary:
              op === "wrap"
                ? [
                    `Moves ${formatUnits(amount, decimals)} ${symbol} into the shield escrow and mints the same number of ${zSymbol} to your public zToken balance (exactly what the escrow received, if the token charges a transfer fee).`,
                    `To hide it, deposit the ${zSymbol} into your confidential balance afterwards (see below).`,
                  ]
                : [
                    `Burns ${formatUnits(amount, decimals)} ${zSymbol} from your public zToken balance and releases the same number of ${symbol} from the escrow to you.`,
                    "Confidential balances must be withdrawn to your public balance first.",
                  ],
            build: () => (op === "wrap" ? buildWrapTx(connection, me, baseMint, amount) : buildUnwrapTx(connection, me, baseMint, amount)),
          }).then((o) => {
            if (o.status === "confirmed") setText("");
          });
        }}
      >
        <Segmented<"wrap" | "unwrap">
          label="Make copies or turn back"
          value={op}
          onChange={(v) => {
            setOp(v);
            setText("");
          }}
          options={[
            { value: "wrap", label: "Make private copies" },
            { value: "unwrap", label: "Turn back" },
          ]}
        />
        <Field
          label={`Amount (${op === "wrap" ? symbol : zSymbol})`}
          error={error}
          help={available === null ? "Connect a wallet." : `Available: ${formatUnits(available, decimals)} ${op === "wrap" ? symbol : `public ${zSymbol}`}`}
        >
          {(ids) => (
            <AmountInput
              id={ids.input}
              value={text}
              onChange={setText}
              unit={op === "wrap" ? symbol : zSymbol}
              invalid={ids.invalid}
              describedBy={ids.describedBy}
              disabled={!me}
              onMax={available === null ? undefined : () => setText(formatUnits(available, decimals).replaceAll(",", ""))}
              maxDisabled={available === null || available === 0n}
            />
          )}
        </Field>
        {!me ? <Reason>Connect a wallet to {op === "wrap" ? "make private copies" : "turn them back"}.</Reason> : null}
        <Button type="submit" variant="primary" className="pg-wide" disabled={!me || amount === null || amount === 0n || error !== null}>
          Review
        </Button>
      </form>
    </Panel>
  );
}
