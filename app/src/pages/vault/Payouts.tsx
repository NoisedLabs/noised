/**
 * Pending payouts (vault v4). A withdrawal only RESERVES tokens in a payout
 * account; delivery is separate: `release` (anyone, to the recipient
 * wallet's canonical token account, created if missing) or `release_to`
 * (signed by the recipient wallet, to any token account of the mint). A
 * recipient can delay only its own payout, never the withdrawal.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Alert, Button } from "../../components/ui";
import { formatUnits } from "../../lib/amounts";
import { associatedTokenAddress, buildReleaseToTx, buildReleaseTx, fetchVault, getMintInfo, listPayouts, type PayoutAccount } from "../../lib/noised";
import { parseKey } from "../../lib/storage";
import { Chip, EmptyState, Panel, Readout, Reason, Row } from "../inner/kit";
import { DotGlyph } from "../inner/glyphs";

/** "1,234.5 MRDN", or "nothing" for a key-rotation-only payout. */
export function payoutAmountText(amount: bigint, decimals: number, symbol: string): string {
  return amount === 0n ? "nothing (key rotation only)" : `${formatUnits(amount, decimals)} ${symbol}`;
}

/** One pending payout with its permissionless "Deliver" and, for the recipient wallet, "Receive into another account". */
export function PayoutRow({
  payout,
  mint,
  tokenProgram,
  decimals,
  symbol,
  onDone,
}: {
  payout: PayoutAccount;
  mint: PublicKey;
  /** The mint's token program (where the canonical token account lives). */
  tokenProgram: PublicKey;
  decimals: number;
  symbol: string;
  onDone?: () => void;
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const isRecipient = me !== null && me.equals(payout.destinationOwner);
  const [receiving, setReceiving] = useState(false);
  const [destText, setDestText] = useState("");
  const destination = destText.trim() === "" ? null : parseKey(destText);
  const amount = payoutAmountText(payout.amount, decimals, symbol);
  const rentNote = `The payout account's rent returns to ${payout.rentPayer.toBase58()}, which paid it.`;

  const deliver = (): void => {
    if (!me) return;
    void run({
      title: `Deliver payout #${payout.sequence}`,
      summary: [
        payout.amount > 0n
          ? `Pays ${amount} to the canonical token account of ${payout.destinationOwner.toBase58()} (created if missing; you pay its rent).`
          : "This payout is zero: delivering it only closes the payout account.",
        rentNote,
        "Permissionless: anyone may deliver a payout, and it can only go to the recipient wallet the signed withdrawal named.",
      ],
      build: () => buildReleaseTx(connection, me, { vault: payout.vault, mint, sequence: payout.sequence }),
    }).then((o) => {
      if (o.status === "confirmed") onDone?.();
    });
  };

  const receive = (): void => {
    if (!me || destination === null) return;
    const to = destination;
    void run({
      title: `Receive payout #${payout.sequence} into another account`,
      summary: [
        `Pays ${amount} into token account ${to.toBase58()}: any token account of this mint you choose.`,
        "Signed by your wallet, the recipient the signed withdrawal named: nobody else can choose where this payout goes.",
        rentNote,
      ],
      build: () => buildReleaseToTx(connection, me, { vault: payout.vault, mint, sequence: payout.sequence, destination: to }),
    }).then((o) => {
      if (o.status === "confirmed") {
        setReceiving(false);
        setDestText("");
        onDone?.();
      }
    });
  };

  return (
    <li className="pg-record" data-tone="warn">
      <div className="pg-record-head">
        <span className="pg-record-title">Payout #{payout.sequence.toString()}</span>
        <span className="pg-record-amount">{amount}</span>
        <Chip tone="warn">Set aside, not delivered</Chip>
        {isRecipient ? <Chip tone="signal">To your wallet</Chip> : null}
      </div>
      <Readout label={`Payout #${payout.sequence.toString()}`}>
        <Row k="Recipient wallet">
          <Address value={payout.destinationOwner} explorer />
        </Row>
        <Row k="Pays into">
          <Address value={associatedTokenAddress(payout.destinationOwner, mint, tokenProgram)} />
        </Row>
        <Row k="Payout account">
          <Address value={payout.publicKey} explorer />
        </Row>
      </Readout>
      {!me ? <Reason>Connect a wallet to deliver it (anyone can).</Reason> : null}
      <div className="pg-btns">
        <Button size="sm" variant="primary" disabled={!me} onClick={deliver}>
          Deliver
        </Button>
        {isRecipient ? (
          <Button size="sm" onClick={() => setReceiving((r) => !r)} aria-expanded={receiving}>
            Receive into another account
          </Button>
        ) : null}
      </div>
      {receiving ? (
        <form
          className="pg-form pg-well"
          onSubmit={(e) => {
            e.preventDefault();
            receive();
          }}
        >
          <label className="label" htmlFor={`release-to-${payout.publicKey.toBase58()}`}>
            Token account to receive into (any account of this token)
          </label>
          <input
            id={`release-to-${payout.publicKey.toBase58()}`}
            className="input mono"
            value={destText}
            onChange={(e) => setDestText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={destText.trim() !== "" && destination === null}
          />
          <p className="help">
            For when your usual token account cannot receive (frozen, confidential-only) or you prefer another one. The account must exist and hold this
            token.
          </p>
          <Button type="submit" size="sm" variant="primary" className="pg-self-start" disabled={destination === null}>
            Review release_to
          </Button>
        </form>
      ) : null}
    </li>
  );
}

/** The unreleased payouts of one vault (`listPayouts`). */
export function VaultPayouts({ vault, mint, decimals, symbol, tokenProgram }: { vault: PublicKey; mint: PublicKey; decimals: number; symbol: string; tokenProgram: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const listing = useAsync(() => listPayouts(connection, vault), [connection, vault.toBase58()]);
  const payouts = listing.data?.payouts ?? [];
  return (
    <div className="pg-stack-sm">
      {listing.error ? <Alert tone="fail" title="Could not list the payouts">{listing.error}</Alert> : null}
      {listing.loading && !listing.data ? <p className="pg-wait">Reading the payouts…</p> : null}
      {listing.data && payouts.length === 0 ? <EmptyState art={<DotGlyph name="letter" />}>No payout is waiting to be delivered.</EmptyState> : null}
      {payouts.length > 0 ? (
        <ul className="pg-records">
          {payouts.map((p) => (
            <PayoutRow key={p.publicKey.toBase58()} payout={p} mint={mint} tokenProgram={tokenProgram} decimals={decimals} symbol={symbol} onDone={listing.reload} />
          ))}
        </ul>
      ) : null}
      {listing.data && !listing.data.complete ? (
        <Alert tone="warn" title="This list may be incomplete">
          {listing.data.note ?? "The RPC could not list every payout."}
        </Alert>
      ) : null}
    </div>
  );
}

/** Look up any vault's pending payouts: delivering needs no recovery phrase, and a recipient can receive into another account. */
export function DeliverAnyPayout(): ReactNode {
  const { connection } = useConnection();
  const [text, setText] = useState("");
  const [vault, setVault] = useState<PublicKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = useAsync(
    async () => {
      if (vault === null) return null;
      const v = await fetchVault(connection, vault);
      if (v === null) throw new Error(`There is no vault at ${vault.toBase58()} on this cluster.`);
      const m = await getMintInfo(connection, v.mint);
      return { v, m };
    },
    [connection, vault?.toBase58()],
    { enabled: vault !== null },
  );
  const d = info.data;
  return (
    <Panel
      id="deliver"
      title="Deliver a payout"
      glyph={<DotGlyph name="courier" />}
      description="Anyone can deliver a vault's waiting payouts to the wallets its signed withdrawals named."
      status={<Chip tone="muted">No key needed</Chip>}
    >
      <form
        className="pg-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const k = parseKey(text);
          setError(k === null ? "Enter a valid vault address." : null);
          setVault(k);
        }}
      >
        <div className="pg-grow">
          <label className="label" htmlFor="deliver-vault">
            Vault address
          </label>
          <input
            id="deliver-vault"
            className="input mono"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error ? "deliver-vault-error" : undefined}
          />
        </div>
        <Button type="submit">Show its payouts</Button>
        {error ? (
          <p id="deliver-vault-error" className="field-error pg-span-all">
            {error}
          </p>
        ) : null}
      </form>
      {info.error ? <Alert tone="fail">{info.error}</Alert> : null}
      {vault === null && !info.error ? (
        <EmptyState art={<DotGlyph name="courier" />}>Paste a vault's address to see the payouts it is holding for people. Delivering one costs only the network fee.</EmptyState>
      ) : null}
      {d && vault ? (
        <div className="pg-stack-sm">
          <Readout label="Vault">
            <Row k="Vault">
              <Address value={vault} explorer />
            </Row>
            <Row k="Token">
              {d.m?.symbol ? `${d.m.symbol} ` : null}
              <Address value={d.v.mint} />
            </Row>
            <Row k="Balance">
              <span className="pg-num">{formatUnits(d.v.balance, d.m?.decimals ?? 0)}</span>
            </Row>
            <Row k="Set aside for payouts">
              <span className="pg-num">{formatUnits(d.v.reserved, d.m?.decimals ?? 0)}</span>
            </Row>
            <Row k="Withdrawals so far">
              <span className="pg-num">{d.v.sequence.toString()}</span>
            </Row>
          </Readout>
          <VaultPayouts vault={vault} mint={d.v.mint} decimals={d.m?.decimals ?? 0} symbol={d.m?.symbol ?? "tokens"} tokenProgram={d.v.tokenProgram} />
        </div>
      ) : null}
    </Panel>
  );
}
