/**
 * The vaults of one recovery phrase for one mint (vault v4): eligibility,
 * the vault accounts of the phrase, opening one, its deposit address (the
 * vault's TOKEN ACCOUNT), deposits, pending payouts and the withdrawal flow
 * of src/lib/vaultFlow.ts.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { KeyRound } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import type { LedgersState } from "../../app/ledgers";
import { useNetwork } from "../../app/network";
import { CLUSTER } from "../../app/settings";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Alert, Button, Field } from "../../components/ui";
import { formatSol, formatUnits, SOL_DECIMALS, tryParseUnits, U64_MAX } from "../../lib/amounts";
import { clusterRefusal } from "../../lib/clusterGate";
import { errorMessage, hexGroups, toHex } from "../../lib/format";
import {
  ADAPTER_MODE,
  associatedTokenAddress,
  buildDepositTx,
  buildOpenVaultTx,
  checkVaultMint,
  deriveVaultKey,
  getMintInfo,
  getSolBalance,
  getTokenBalance,
  keySequence,
  lmots,
  parseWithdrawMessage,
  scanVaults,
  VAULT,
  WITHDRAW_MESSAGE_FIELDS,
  withdrawMessage,
  WSOL_MINT,
  type MintInfo,
  type PendingWithdrawalContinuation,
  type ScannedVault,
  type VaultKeyRecord,
} from "../../lib/noised";
import { decodeHex, decodeKey, exportWithdrawal, type StoredWithdrawal } from "../../lib/storage";
import {
  allAcknowledged,
  confirmationOf,
  maxAmountText,
  reviewRecipient,
  signWithdrawalOnce,
  type RecipientReview,
  type SignOutcome,
  type WithdrawRequest,
} from "../../lib/vaultFlow";
import { AmountInput, Chip, Comment, Details, KeyTrail, Metric, Panel, Readout, Reason, Row, Steps, Tiles, Toggle, type StepState } from "../inner/kit";
import { VAULT_CHAIN } from "./chain";
import { VaultPayouts } from "./Payouts";
import { useSigningClaims, useStoredWithdrawals } from "./PendingWithdrawals";

/** Vault accounts read per scan step (each costs two LM-OTS key derivations). */
const SCAN_STEP = 4;

/**
 * Whether a stored record of a vault's current sequence holds this vault's
 * signing key back: it does unless its key is provably another one (then it
 * can never execute, and signing archives it). An unreadable key counts as
 * the vault's.
 */
function holdsKey(w: StoredWithdrawal, keyId: Uint8Array | null): boolean {
  if (keyId === null) return true;
  try {
    return toHex(lmots.keyId(decodeKey(w.key))) === toHex(keyId);
  } catch {
    return true;
  }
}

export function MintVaults({ master, mint, ledgers }: { master: Uint8Array; mint: PublicKey; ledgers: LedgersState }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const [scanMax, setScanMax] = useState(SCAN_STEP - 1);
  const [selected, setSelected] = useState<number | null>(null);
  const check = useAsync(() => checkVaultMint(connection, mint), [connection, mint.toBase58()]);
  const info = useAsync(() => getMintInfo(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  const scan = useAsync(() => scanVaults(connection, master, CLUSTER, mint, scanMax), [connection, mint.toBase58(), scanMax, master]);
  const records = useStoredWithdrawals();

  const m = info.data ?? null;
  const symbol = m?.symbol ?? "tokens";
  const decimals = m?.decimals ?? 0;
  const vaults = scan.data ?? [];
  const opened = vaults.filter((v) => v.opened);
  const firstUnopened = vaults.find((v) => !v.opened) ?? null;
  const current = vaults.find((v) => v.opened && v.account === selected) ?? opened[0] ?? null;
  const eligible = check.data?.eligible === true;
  const shown = vaults.filter((v) => v.opened || v.balance > 0n || v.account === firstUnopened?.account);

  const open = (row: ScannedVault): void => {
    if (!me || !m) return;
    const genesis = deriveVaultKey(master, CLUSTER, mint, row.account, 0);
    genesis.skSeed.fill(0);
    const depositAddress = associatedTokenAddress(row.vault, mint, m.tokenProgram);
    void run({
      title: `Open vault account #${row.account}`,
      summary: [
        `Creates vault ${row.vault.toBase58()} for ${symbol}, controlled only by one-time keys of your quantum key (vault account #${row.account}). Only the genesis key's public part is published.`,
        `Creates the vault's token account ${depositAddress.toBase58()}: the deposit address. The vault and its token account never move.`,
        "A genesis key opens one vault, once. You pay the rent of the vault and its token account.",
      ],
      build: () => buildOpenVaultTx(connection, me, mint, genesis.pk),
    }).then((o) => {
      if (o.status === "confirmed") setSelected(row.account);
      scan.reload();
    });
  };

  return (
    <div className="pg-vault-tree">
      <Panel
        title="Can this token go in a vault?"
        description="Read from the token's settings just now, with the same rules the vault program applies."
        status={check.data ? check.data.eligible ? <Chip tone="ok">Eligible</Chip> : <Chip tone="danger">Refused</Chip> : <Chip tone="muted" pulse>Checking</Chip>}
      >
        {check.loading && !check.data ? <p className="pg-wait">Checking the token…</p> : null}
        {check.error ? <Alert tone="fail" title="Check failed">{check.error}</Alert> : null}
        {check.data ? (
          <div className="pg-stack-sm">
            {check.data.eligible ? (
              <Alert tone="ok" title={`Eligible: no Ed25519 key can take ${symbol} out of a vault`} />
            ) : (
              <Alert tone="fail" title="Refused: the vault program does not accept this token">
                <ul className="pg-bullets">
                  {check.data.refusals.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {check.data.warnings.length > 0 ? (
              <Alert tone="warn" title="Powers that can delay a payout or dilute (none can take vaulted tokens or block a withdrawal)">
                <ul className="pg-bullets">
                  {check.data.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel
        title={`Your ${symbol} vaults`}
        description="Your quantum key can open many vaults for each token. Each vault has a fixed address; every withdrawal is signed by its current key and hands it to the next one."
        status={
          <Button size="sm" variant="ghost" onClick={() => setScanMax((n) => Math.min(n + SCAN_STEP, 1000))} disabled={scan.loading}>
            Look for {SCAN_STEP} more
          </Button>
        }
      >
        {scan.error ? <Alert tone="fail" title="Scan failed">{scan.error}</Alert> : null}
        {scan.loading && !scan.data ? <p className="pg-wait">Making your vault keys and reading the vaults…</p> : null}
        <div className="pg-table-wrap">
          <table className="table pg-table pg-vault-table">
            <thead>
              <tr>
                <th scope="col">Vault</th>
                <th scope="col">Address</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Balance
                </th>
                <th scope="col" className="num">
                  Reserved
                </th>
                <th scope="col" className="num">
                  Available
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => {
                const waiting = records.some((w) => w.vault === v.vault.toBase58() && w.sequence === v.sequence.toString() && holdsKey(w, v.keyId));
                return (
                  <tr key={v.account} aria-current={current?.account === v.account ? "true" : undefined}>
                    <td className="pg-num">#{v.account}</td>
                    <td>
                      <Address value={v.vault} explorer />
                    </td>
                    <td>
                      <span className="pg-badges">
                        {v.opened ? <Chip tone="ok">{`Open · key ${v.sequence.toString()}`}</Chip> : <Chip tone="muted">Not opened</Chip>}
                        {v.keyMatches === false ? <Chip tone="danger">Not from your quantum key</Chip> : null}
                        {v.pendingPayouts.length > 0 ? <Chip tone="warn">{`${v.pendingPayouts.length} payout${v.pendingPayouts.length === 1 ? "" : "s"} waiting`}</Chip> : null}
                        {waiting ? <Chip tone="signal">Signed withdrawal waiting</Chip> : null}
                      </span>
                    </td>
                    <td className="num">{formatUnits(v.balance, decimals)}</td>
                    <td className="num">{formatUnits(v.reserved, decimals)}</td>
                    <td className="num">{formatUnits(v.available, decimals)}</td>
                    <td className="num">
                      {v.opened ? (
                        <Button size="sm" variant={current?.account === v.account ? "primary" : "secondary"} onClick={() => setSelected(v.account)} aria-pressed={current?.account === v.account}>
                          {current?.account === v.account ? "Selected" : "Manage"}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Comment>{`Showing vaults #0 to #${scanMax} of your quantum key for ${symbol} on ${CLUSTER}.`}</Comment>
        {scan.data && firstUnopened ? (
          <div className="pg-stack-sm">
            {!eligible && check.data ? <Reason>This token cannot be held in a vault.</Reason> : null}
            {!me ? <Reason>Connect a wallet to pay for opening a vault.</Reason> : null}
            <Button className="pg-self-start" variant={opened.length === 0 ? "primary" : "secondary"} disabled={!me || !eligible || m === null} onClick={() => open(firstUnopened)}>
              Open vault #{firstUnopened.account}
            </Button>
          </div>
        ) : null}
      </Panel>

      {current && m ? <VaultDetail key={current.account} master={master} mint={mint} m={m} row={current} records={records} ledgers={ledgers} /> : null}

      {m && opened.some((v) => v.account !== current?.account && (v.pendingPayouts.length > 0 || v.reserved > 0n)) ? (
        <Panel title="Payouts of your other vaults" description="Anyone can deliver them; the recipient wallet can also receive them into another account.">
          <div className="pg-stack">
            {opened
              .filter((v) => v.account !== current?.account && (v.pendingPayouts.length > 0 || v.reserved > 0n))
              .map((v) => (
                <section key={v.account} aria-label={`Vault #${v.account}`} className="pg-stack-sm">
                  <h3 className="pg-subhead pg-row">
                    Vault #{v.account} <Address value={v.vault} />
                  </h3>
                  <VaultPayouts vault={v.vault} mint={mint} decimals={decimals} symbol={symbol} tokenProgram={m.tokenProgram} />
                </section>
              ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function VaultDetail({
  master,
  mint,
  m,
  row,
  records,
  ledgers,
}: {
  master: Uint8Array;
  mint: PublicKey;
  m: MintInfo;
  row: ScannedVault;
  records: readonly StoredWithdrawal[];
  ledgers: LedgersState;
}): ReactNode {
  const symbol = m.symbol ?? "tokens";
  const decimals = m.decimals;
  const depositAddress = associatedTokenAddress(row.vault, mint, m.tokenProgram);
  const wsol = mint.equals(WSOL_MINT);
  const slot = records.find((w) => w.vault === row.vault.toBase58() && w.sequence === row.sequence.toString()) ?? null;
  // A record this vault's key did not make can never execute: it does not block the key (signing archives it).
  const existing = slot !== null && holdsKey(slot, row.keyId) ? slot : null;
  const foreign = slot !== null && existing === null ? slot : null;
  return (
    <>
      <Panel
        id="vault-detail"
        title={`Vault #${row.account}`}
        description="Its address and its deposit address never change. Only its key changes, once per withdrawal."
        status={<Chip tone="ok">{`Key ${row.sequence.toString()}`}</Chip>}
      >
        <div className="pg-deposit">
          <span className="pg-deposit-k">Deposit address (send {symbol} here)</span>
          <span className="pg-deposit-v">
            <Address value={depositAddress} full explorer />
          </span>
        </div>
        <Tiles label="Vault balance">
          <Metric label="Balance" value={formatUnits(row.balance, decimals)} unit={symbol} />
          <Metric label="Reserved for payouts" value={formatUnits(row.reserved, decimals)} unit={symbol} tone={row.reserved > 0n ? "warn" : undefined} />
          <Metric label="Free to withdraw" value={formatUnits(row.available, decimals)} unit={symbol} tone="ok" />
        </Tiles>
        <KeyTrail sequence={row.sequence} />
        <Details summary="Vault details">
          <Readout label="Vault account">
            <Row k="Vault address (not for deposits)">
              <Address value={row.vault} explorer />
            </Row>
            <Row k="Withdrawals so far" wide>
              <span className="pg-num">
                {row.sequence.toString()}; the next one is signed by key {row.sequence.toString()}
              </span>
            </Row>
          </Readout>
        </Details>
        <Alert tone="warn" title={`Send only ${symbol} to the deposit address`}>
          <p>
            The deposit address is the vault's account for this token (<Address value={mint} />). SOL or any other token sent to the vault address itself (
            {row.vault.toBase58()}) is lost: nothing can ever move it out.
          </p>
          {wsol ? (
            <p className="pg-gap-top">
              wSOL wraps automatically: the Deposit button below sends SOL straight into the token account and syncs it (SyncNative) in the same
              transaction. SOL sent to the token account any other way counts only once someone calls SyncNative on it.
            </p>
          ) : null}
        </Alert>
      </Panel>
      <DepositCard row={row} mint={mint} m={m} />
      <Panel
        title={`Payouts of vault #${row.account}`}
        description="A withdrawal sets its amount aside; delivering pays the recipient. Anyone can deliver, and the recipient wallet can receive into another account."
      >
        <VaultPayouts vault={row.vault} mint={mint} decimals={decimals} symbol={symbol} tokenProgram={m.tokenProgram} />
      </Panel>
      {row.keyMatches === false ? (
        <Alert tone="fail" title="Your quantum key does not hold this vault's current key">
          The vault's key {row.sequence.toString()} is not vault #{row.account}'s key from your quantum key, so it cannot sign this vault's withdrawals (a
          withdrawal named a next key that does not come from your quantum key). Its waiting payouts can still be delivered.
        </Alert>
      ) : (
        <WithdrawCard key={row.sequence.toString()} master={master} mint={mint} m={m} row={row} existing={existing} foreign={foreign} ledgers={ledgers} />
      )}
    </>
  );
}

function DepositCard({ row, mint, m }: { row: ScannedVault; mint: PublicKey; m: MintInfo }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const me = owner.publicKey;
  const wsol = mint.equals(WSOL_MINT);
  const symbol = m.symbol ?? "tokens";
  const decimals = wsol ? SOL_DECIMALS : m.decimals;
  const balance = useAsync(() => (me ? (wsol ? getSolBalance(connection, me) : getTokenBalance(connection, me, mint)) : Promise.resolve(null)), [connection, me?.toBase58(), mint.toBase58()]);
  const [text, setText] = useState("");
  const amount = tryParseUnits(text, decimals);
  const walletBalance = balance.data ?? null;
  const unit = wsol ? "SOL" : symbol;
  let error: string | null = null;
  if (text.trim() !== "" && amount === null) error = `Enter an amount with at most ${decimals} decimals.`;
  else if (amount !== null && walletBalance !== null && amount > walletBalance) error = `You hold ${formatUnits(walletBalance, decimals)} ${unit}.`;
  const depositAddress = associatedTokenAddress(row.vault, mint, m.tokenProgram);
  return (
    <Panel title={`Deposit into vault #${row.account}`} description="Anyone can deposit. Only a quantum-safe signature from your quantum key can take tokens out.">
      <form
        className="pg-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!me || amount === null || amount === 0n || error) return;
          void run({
            title: `Deposit ${formatUnits(amount, decimals)} ${unit} into vault #${row.account}`,
            summary: wsol
              ? [
                  `Sends ${formatSol(amount, 9)} from your account straight into the vault's wSOL token account ${depositAddress.toBase58()} and wraps it (SyncNative).`,
                  "From then on only a post-quantum signature from your quantum key can move it.",
                ]
              : [
                  `Transfers ${formatUnits(amount, decimals)} ${symbol} from your token account to the vault's token account ${depositAddress.toBase58()}.`,
                  "From then on only a post-quantum signature from your quantum key can move these tokens.",
                ],
            build: () => buildDepositTx(connection, me, mint, row.vault, amount),
          }).then((o) => {
            if (o.status === "confirmed") setText("");
          });
        }}
      >
        <Field
          label={`Amount (${unit})`}
          error={error}
          help={walletBalance === null ? "Connect a wallet." : `In your wallet: ${formatUnits(walletBalance, decimals)} ${unit}${wsol ? " (keep some SOL for fees)" : ""}.`}
        >
          {(ids) => (
            <AmountInput
              id={ids.input}
              value={text}
              onChange={setText}
              unit={unit}
              invalid={ids.invalid}
              describedBy={ids.describedBy}
              disabled={!me}
              onMax={wsol ? undefined : () => setText(walletBalance === null ? "" : formatUnits(walletBalance, decimals).replaceAll(",", ""))}
              maxDisabled={walletBalance === null}
            />
          )}
        </Field>
        {!me ? <Reason>Connect a wallet to deposit.</Reason> : null}
        <Button type="submit" variant="primary" className="pg-self-start" disabled={!me || amount === null || amount === 0n || error !== null}>
          Review deposit
        </Button>
      </form>
    </Panel>
  );
}

/** Two lists of warnings hold the same texts (a fresh check may change them: then they need a new confirmation). */
const sameTexts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function WithdrawCard({
  master,
  mint,
  m,
  row,
  existing,
  foreign,
  ledgers,
}: {
  master: Uint8Array;
  mint: PublicKey;
  m: MintInfo;
  row: ScannedVault;
  existing: StoredWithdrawal | null;
  /** A record of this sequence that this vault's key did not make (it can never execute). */
  foreign: StoredWithdrawal | null;
  ledgers: LedgersState;
}): ReactNode {
  const owner = useOwner();
  const { connection } = useConnection();
  const network = useNetwork();
  const decimals = m.decimals;
  const symbol = m.symbol ?? "tokens";
  const [recipientText, setRecipientText] = useState(owner.publicKey?.toBase58() ?? "");
  const [all, setAll] = useState(true);
  const [amountText, setAmountText] = useState("");
  const [review, setReview] = useState<{ inputs: string; result: RecipientReview } | null>(null);
  const [ackRecipient, setAckRecipient] = useState(false);
  const [ackMint, setAckMint] = useState(false);
  const [ackOffCurve, setAckOffCurve] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<"review" | "sign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SignOutcome | null>(null);
  const claim = useSigningClaims().find((c) => c.vault === row.vault.toBase58() && c.sequence === row.sequence.toString()) ?? null;
  // What this browser's key records say about the vault's current key (another tab, an earlier visit, an import).
  const [keyRecord, setKeyRecord] = useState<VaultKeyRecord | null>(null);
  const l = ledgers.ledgers;
  useEffect(() => {
    let alive = true;
    if (l === null || row.keyId === null) {
      setKeyRecord(null);
      return;
    }
    l.vaultKeys.get(row.keyId).then(
      (r) => {
        if (alive) setKeyRecord(r);
      },
      () => {
        if (alive) setKeyRecord(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [l, row.keyId, ledgers.version]);
  const reservedFor = keyRecord !== null && keyRecord.signature === null ? parsedMessage(keyRecord.message) : null;

  let recipient: PublicKey | null = null;
  try {
    recipient = recipientText.trim() === "" ? null : new PublicKey(recipientText.trim());
  } catch {
    recipient = null;
  }
  const maxAmount = all ? U64_MAX : tryParseUnits(amountText, decimals);
  const inputs = recipient !== null && maxAmount !== null && maxAmount > 0n ? `${recipient.toBase58()}|${maxAmount}|${owner.publicKey?.toBase58() ?? ""}` : null;
  // A review is for exact inputs (and the connected wallet); editing them requires a new one.
  const current = review !== null && review.inputs === inputs ? review.result : null;
  const sequence = current?.vault.sequence ?? row.sequence;
  const nextKeyId = useMemo(() => {
    if (sequence >= 0xffff_ffffn) return null;
    const k = deriveVaultKey(master, CLUSTER, mint, row.account, keySequence(sequence + 1n));
    k.skSeed.fill(0);
    return k.keyId;
  }, [master, mint, row.account, sequence]);
  const message = recipient !== null && maxAmount !== null && maxAmount > 0n && nextKeyId !== null ? withdrawMessage(row.vault, mint, sequence, recipient, maxAmount, nextKeyId) : null;
  const req: WithdrawRequest | null =
    recipient !== null && maxAmount !== null ? { cluster: CLUSTER, mint, account: row.account, vault: row.vault, destinationOwner: recipient, maxAmount, wallet: owner.publicKey } : null;
  const check = current?.check ?? null;
  const acks = { recipientWarnings: ackRecipient, mintWarnings: ackMint, offCurveConfirmation: ackOffCurve };
  const confirmed = check !== null && allAcknowledged(check, acks);
  // Signing waits for an endpoint known to serve this build's cluster (the message names none).
  const networkBlock = clusterRefusal(network.cluster, CLUSTER, ADAPTER_MODE);
  // An incomplete search signs nothing: it is continued, never overridden.
  const continuation = outcome?.kind === "incomplete" ? outcome.search.continuation : null;
  const canSign = current !== null && current.check.ok && confirmed && understood && busy === null && existing === null && networkBlock === null && continuation === null && l !== null;

  const doReview = async (): Promise<void> => {
    if (req === null || inputs === null) return;
    setBusy("review");
    setError(null);
    setOutcome(null);
    try {
      const result = await reviewRecipient(VAULT_CHAIN, connection, req);
      setReview({ inputs, result });
      setAckRecipient(false);
      setAckMint(false);
      setAckOffCurve(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doSign = async (continueFrom: PendingWithdrawalContinuation | null): Promise<void> => {
    if (req === null || inputs === null || current === null || l === null) return;
    setBusy("sign");
    setError(null);
    try {
      // The SDK takes its own copy of the confirmation at the call: what the user ticked now is what it checks.
      const o = await signWithdrawalOnce(VAULT_CHAIN, connection, master, req, l, {
        reviewedSequence: current.vault.sequence,
        confirm: confirmationOf(current.check, acks),
        continueFrom,
      });
      setOutcome(o);
      if (o.kind === "refused" && o.code === "moved") setReview(null);
      else if (o.kind === "refused" && o.check !== null) {
        // Show what the fresh check says; anything that changed needs a new confirmation.
        const fresh = o.check;
        setReview({ inputs, result: { vault: current.vault, check: fresh } });
        if (!sameTexts(fresh.recipientWarnings, current.check.recipientWarnings)) setAckRecipient(false);
        if (!sameTexts(fresh.mintWarnings, current.check.mintWarnings)) setAckMint(false);
        if (fresh.offCurveConfirmation !== current.check.offCurveConfirmation) setAckOffCurve(false);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      id="withdraw"
      title={`Withdraw from vault #${row.account}`}
      description="One quantum-safe signature allows exactly one withdrawal. It is saved, and read back, before anything is sent."
      status={<Chip tone="signal">One key, one signature</Chip>}
      className="pg-withdraw"
    >
      <div className="pg-stack">
        <Steps label="Withdrawal steps" steps={withdrawSteps({ inputs: inputs !== null, current, confirmed: confirmed && understood, signed: existing !== null || outcome?.kind === "stored" || outcome?.kind === "revealed", canSign })} />
        {existing !== null ? (
          <Alert tone="info" title={`Vault #${row.account} already has a signed withdrawal at sequence ${existing.sequence}`}>
            Its key signs once and must never sign anything else. Fund its fee payer and broadcast it from{" "}
            <a className="link" href={`#withdrawal-${existing.vault}-${existing.sequence}`}>
              "Signed withdrawals in this browser"
            </a>
            ; this form opens again once it has executed.
          </Alert>
        ) : null}
        {foreign !== null ? (
          <Alert tone="warn" title={`A stored record of sequence ${foreign.sequence} was not made by this vault's key`}>
            Its signature can never execute (a forged or mistaken import, or a signature of another phrase), so it does not hold this vault's key back:
            signing here archives it. You can also remove it from "Signed withdrawals in this browser".
          </Alert>
        ) : null}
        {reservedFor !== null && existing === null ? (
          <Alert tone="warn" title={`Vault #${row.account}'s key is set aside for one withdrawal`}>
            <p>
              A signing of a withdrawal to <Address value={reservedFor.destinationOwner} /> (at most {maxAmountText(reservedFor.maxAmount)}) started in this
              browser and did not finish. This key may sign only that withdrawal: finish it (the signature is identical), or use another vault.
            </p>
            <Button
              size="sm"
              className="pg-gap-top"
              onClick={() => {
                setRecipientText(reservedFor.destinationOwner.toBase58());
                if (reservedFor.maxAmount === U64_MAX) setAll(true);
                else {
                  setAll(false);
                  setAmountText(formatUnits(reservedFor.maxAmount, decimals).replaceAll(",", ""));
                }
              }}
            >
              Fill in that withdrawal
            </Button>
          </Alert>
        ) : null}
        {l === null && ledgers.error === null ? <p className="pg-wait">Opening this browser's key records…</p> : null}
        {claim !== null && existing === null ? (
          <Alert tone="warn" title={`A signing at sequence ${claim.sequence} did not finish in this browser`}>
            Its record was never saved, so this key may already have signed that withdrawal. It may sign only that one: enter exactly the same recipient
            and amount to sign it again (the signature is identical), or import its backup. See "Signed withdrawals in this browser".
          </Alert>
        ) : null}
        <Field
          label="Recipient wallet"
          error={recipientText.trim() !== "" && recipient === null ? "Not a valid Solana address." : null}
          help="A wallet address, never a token account, a token or a vault. The payout goes to this wallet's usual token account (created if needed), or to any account the wallet picks later."
        >
          {(ids) => (
            <input
              id={ids.input}
              className="input mono"
              value={recipientText}
              onChange={(e) => setRecipientText(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={ids.invalid}
              aria-describedby={ids.describedBy || undefined}
              disabled={existing !== null}
            />
          )}
        </Field>

        <fieldset className="pg-radios" disabled={existing !== null}>
          <legend className="label">Amount</legend>
          <label className="pg-radio">
            <input type="radio" name="withdraw-amount" checked={all} onChange={() => setAll(true)} />
            Everything free when the withdrawal runs (now {formatUnits(row.available, decimals)} {symbol})
          </label>
          <label className="pg-radio">
            <input type="radio" name="withdraw-amount" checked={!all} onChange={() => setAll(false)} />
            At most
            <input
              className="input pg-num"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setAll(false);
              }}
              aria-label={`Maximum amount of ${symbol}`}
              aria-invalid={!all && amountText.trim() !== "" && tryParseUnits(amountText, decimals) === null}
            />
            {symbol}
          </label>
          <Comment>
            The withdrawal sets aside the smaller of your maximum and what is free; the rest stays in the vault under its next key. A later balance
            never makes a signed withdrawal fail.
          </Comment>
        </fieldset>

        <div className="pg-btns">
          <Button loading={busy === "review"} disabled={req === null || busy !== null || existing !== null} onClick={() => void doReview()}>
            Check the recipient
          </Button>
          <span className="pg-note">Reads the vault and the recipient now. Nothing is signed.</span>
        </div>

        {current !== null ? (
          <RecipientReviewView
            review={current}
            acks={{ recipient: ackRecipient, mint: ackMint, offCurve: ackOffCurve }}
            onAck={{ recipient: setAckRecipient, mint: setAckMint, offCurve: setAckOffCurve }}
          />
        ) : null}

        {message !== null && current !== null && current.check.ok ? (
          <Details summary={`The exact ${VAULT.WITHDRAW_MESSAGE_LEN}-byte message you will sign`} boxed>
            <dl className="pg-msg-kv">
              {WITHDRAW_MESSAGE_FIELDS.map((f) => (
                <div key={f.name} className="contents">
                  <dt>{f.name}</dt>
                  <dd>{describeField(f.name, message.subarray(f.start, f.end), decimals, symbol, row.account, sequence)}</dd>
                </div>
              ))}
            </dl>
            <p className="pg-msg-hex">{hexGroups(message)}</p>
          </Details>
        ) : null}

        {current !== null && current.check.ok ? (
          <Toggle checked={understood} onChange={setUnderstood}>
            I understand vault #{row.account}'s key for sequence {sequence.toString()} signs this message once and can never sign anything else. If the
            transaction is dropped, I re-broadcast the same signature, and I never sign withdrawals with this quantum key on two devices at the same time.
          </Toggle>
        ) : null}

        {network.cluster !== null && networkBlock !== null ? (
          <Alert tone="fail" title="Signing is disabled for this RPC endpoint">
            {networkBlock} A withdrawal message names no cluster, so a vault key signs only against an endpoint known to serve {CLUSTER}.
          </Alert>
        ) : null}
        {error ? <Alert tone="fail">{error}</Alert> : null}
        {outcome !== null ? (
          <OutcomeView
            outcome={outcome}
            account={row.account}
            busy={busy !== null}
            decimals={decimals}
            symbol={symbol}
            onContinue={(c) => void doSign(c)}
            onFill={(o) => {
              setRecipientText(o.destinationOwner.toBase58());
              if (o.maxAmount === U64_MAX) setAll(true);
              else {
                setAll(false);
                setAmountText(formatUnits(o.maxAmount, decimals).replaceAll(",", ""));
              }
              setOutcome(null);
            }}
          />
        ) : null}

        <Button variant="primary" className="pg-self-start" loading={busy === "sign"} disabled={!canSign} onClick={() => void doSign(null)}>
          <KeyRound size={16} aria-hidden="true" /> Sign once and save
        </Button>
        <Details summary="What happens when you sign">
          <p className="pg-small">
            Right before signing, the RPC endpoint's cluster is checked, the vault is read again, the recipient re-checked and the vault's history searched
            for a withdrawal this key already signed (which is then saved for re-broadcast instead). Only one tab of this browser signs for this vault and
            key at a time. The signature is deterministic (HMAC randomizer): signing this exact message again gives the identical signature, never a second
            one. The private seed is made from your quantum key, used once and wiped.
          </p>
        </Details>
      </div>
    </Panel>
  );
}

/** The withdrawal as steps (presentation of the card's own state; broadcasting happens in the records list). */
function withdrawSteps(st: { inputs: boolean; current: RecipientReview | null; confirmed: boolean; signed: boolean; canSign: boolean }): { key: string; label: string; state: StepState }[] {
  const checked: StepState = st.signed ? "done" : st.current === null ? (st.inputs ? "current" : "todo") : st.current.check.ok ? "done" : "fail";
  const confirm: StepState = st.signed ? "done" : st.current === null || !st.current.check.ok ? "todo" : st.confirmed ? "done" : "current";
  const sign: StepState = st.signed ? "done" : st.canSign ? "current" : "todo";
  return [
    { key: "to", label: "Recipient", state: st.signed || st.inputs ? "done" : "current" },
    { key: "check", label: "Check", state: checked },
    { key: "confirm", label: "Confirm", state: confirm },
    { key: "sign", label: "Sign once", state: sign },
    { key: "send", label: "Send", state: st.signed ? "current" : "todo" },
  ];
}

type Acks = { recipient: boolean; mint: boolean; offCurve: boolean };

function RecipientReviewView({ review, acks, onAck }: { review: RecipientReview; acks: Acks; onAck: { [K in keyof Acks]: (v: boolean) => void } }): ReactNode {
  const c = review.check;
  return (
    <div className="pg-stack-sm">
      {c.ok ? (
        <Alert tone="ok" title="The recipient is a wallet the vault can pay">
          {c.canonicalAta ? (
            <span>
              release pays its canonical token account <Address value={c.canonicalAta} /> (created if missing).
            </span>
          ) : null}
        </Alert>
      ) : (
        <Alert tone="fail" title="Refused: signing to this recipient would lose or strand the payout">
          <ul className="pg-bullets">
            {c.refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Alert>
      )}
      {c.ok && c.offCurveConfirmation !== null ? (
        <Alert tone="fail" title="Confirm this recipient: no private key controls it and it has no account yet">
          <p>{c.offCurveConfirmation}</p>
          <Toggle checked={acks.offCurve} onChange={onAck.offCurve} className="pg-ack">
            I know which program controls this address and that it can use tokens of this mint. If it is not a program's wallet, the payout is lost forever.
          </Toggle>
        </Alert>
      ) : null}
      {c.ok && c.recipientWarnings.length > 0 ? (
        <Alert tone="warn" title="About this recipient (they can delay or redirect this payout, never the withdrawal)">
          <ul className="pg-bullets">
            {c.recipientWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Toggle checked={acks.recipient} onChange={onAck.recipient} className="pg-ack">
            I have read the warnings about this recipient and still want to withdraw to it.
          </Toggle>
        </Alert>
      ) : null}
      {c.ok && c.mintWarnings.length > 0 ? (
        <Alert tone="warn" title="About this token and vault (the same for every recipient; they can delay a payout, never the withdrawal)">
          <ul className="pg-bullets">
            {c.mintWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Toggle checked={acks.mint} onChange={onAck.mint} className="pg-ack">
            I have read the warnings about this token and still want to withdraw.
          </Toggle>
        </Alert>
      ) : null}
    </div>
  );
}

function OutcomeView({
  outcome,
  account,
  busy,
  decimals,
  symbol,
  onContinue,
  onFill,
}: {
  outcome: SignOutcome;
  account: number;
  busy: boolean;
  decimals: number;
  symbol: string;
  onContinue: (continuation: PendingWithdrawalContinuation) => void;
  onFill: (o: { destinationOwner: PublicKey; maxAmount: bigint }) => void;
}): ReactNode {
  switch (outcome.kind) {
    case "stored": {
      const w = outcome.record;
      const max = BigInt(w.maxAmount);
      return (
        <Alert tone={outcome.signedNow ? "ok" : "info"} title={outcome.signedNow ? "Signed once and saved" : "Already signed and saved"}>
          {/* What was signed (the signer's own copy), not the form. */}
          Signed: to <Address value={w.destinationOwner} />, {max === U64_MAX ? "everything free when it runs" : `at most ${formatUnits(max, decimals)} ${symbol}`}.{" "}
          {outcome.signedNow ? "The record was written and read back. " : "This exact withdrawal was signed before; nothing new was signed. "}
          Next:{" "}
          <a className="link" href={`#withdrawal-${w.vault}-${w.sequence}`}>
            fund its fee payer and broadcast it
          </a>
          .
        </Alert>
      );
    }
    case "revealed": {
      const p = outcome.search.pending;
      return (
        <Alert tone="warn" title="Nothing was signed: this key already signed a withdrawal that is public">
          <p>
            Transaction {p ? <Address value={p.txSignature} /> : null} {p?.failed ? "(it failed) " : ""}revealed a withdrawal of vault #{account}'s current key
            {p ? (
              <>
                {" "}
                to <Address value={p.destinationOwner} />
              </>
            ) : null}
            . It is the only withdrawal this key may make: it was saved here.{" "}
            <a className="link" href={`#withdrawal-${outcome.record.vault}-${outcome.record.sequence}`}>
              Re-broadcast it
            </a>
            .
          </p>
          {outcome.search.all.length > 1 ? <p className="pg-gap-top pg-fail">{outcome.record.lastError}</p> : null}
        </Alert>
      );
    }
    case "in-use": {
      const w = outcome.withdrawal;
      return (
        <Alert tone="warn" title="Nothing was signed: this key already signed another withdrawal">
          <p>
            Vault #{account}'s current key already signed a withdrawal to <Address value={w.destinationOwner} /> (at most {maxAmountText(w.maxAmount)}), in this
            browser or on a device whose records you brought in. A one-time key signs once, so that is the only withdrawal it can make.
          </p>
          {outcome.record !== null ? (
            <p className="pg-gap-top">
              <a className="link" href={`#withdrawal-${outcome.record.vault}-${outcome.record.sequence}`}>
                Send that withdrawal
              </a>
              .
            </p>
          ) : null}
        </Alert>
      );
    }
    case "reserved":
      return (
        <Alert tone="warn" title="Nothing was signed: this key is set aside for another withdrawal">
          <p>
            A signing of a withdrawal to <Address value={outcome.destinationOwner} /> (at most {maxAmountText(outcome.maxAmount)}) started and did not finish.
            This key may sign only that one: finish it (the signature is identical).
          </p>
          <Button size="sm" className="pg-gap-top" disabled={busy} onClick={() => onFill(outcome)}>
            Fill in that withdrawal
          </Button>
        </Alert>
      );
    case "refused":
      return <Alert tone="fail" title="Not signed">{outcome.reason}</Alert>;
    case "incomplete": {
      const continuation = outcome.search.continuation;
      return (
        <Alert tone="warn" title="Not signed: the vault's history is not fully checked yet">
          <p>{outcome.note}</p>
          <p className="pg-gap-top">
            A withdrawal signed with this quantum key on another device would show there, and this key must never sign a second one, so nothing is signed until
            the search is complete ({outcome.search.examined.toLocaleString("en-US")} transactions read so far).
          </p>
          {continuation !== null ? (
            <div className="pg-btns pg-gap-top">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onContinue(continuation)}>
                Continue searching
              </Button>
              <span className="pg-note">
                Reads on from where the search stopped (what landed since is read first). If it completes without finding a signature of this key, this
                withdrawal is signed and saved as you confirmed; if it finds one, that one is saved for re-broadcast instead.
              </span>
            </div>
          ) : (
            <p className="pg-gap-top">
              This RPC endpoint cannot return the history needed. Choose an endpoint that keeps the full history (the footer lists the ones this build
              allows), then sign again.
            </p>
          )}
        </Alert>
      );
    }
    case "unsaved":
      return (
        <Alert tone="fail" title={outcome.record.source === "revealed" ? "Found on chain but NOT saved" : "Signed but NOT saved"}>
          {outcome.error} Download this signed withdrawal now and keep it: it is the only copy, and this key must not sign again at this sequence.{" "}
          <a
            className="link"
            download={`noised-withdrawal-${outcome.record.vault.slice(0, 8)}-${outcome.record.sequence}.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(exportWithdrawal(outcome.record))}`}
          >
            Download the signed withdrawal
          </a>
        </Alert>
      );
  }
}

function describeField(name: string, bytes: Uint8Array, decimals: number, symbol: string, account: number, sequence: bigint): ReactNode {
  const u64 = (): bigint => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
  if (name.startsWith("Tag")) return `${new TextDecoder().decode(bytes)} (${hexGroups(bytes)})`;
  if (name.startsWith("Operation")) return `${bytes[0] ?? 0}`;
  if (name.startsWith("Sequence")) return `${u64().toString()} (this vault's current sequence)`;
  if (name.startsWith("Max amount")) {
    const v = u64();
    return v === U64_MAX ? "u64 max (everything available)" : `${formatUnits(v, decimals)} ${symbol} (${v} base units)`;
  }
  if (name.startsWith("Next key")) return `${hexGroups(bytes)} (vault #${account}'s key for sequence ${(sequence + 1n).toString()})`;
  try {
    return new PublicKey(bytes).toBase58();
  } catch {
    return hexGroups(bytes);
  }
}

/** The recipient and maximum of a withdraw message (hex), or null when it cannot be read. */
function parsedMessage(hex: string): { destinationOwner: PublicKey; maxAmount: bigint } | null {
  try {
    const m = parseWithdrawMessage(decodeHex(hex));
    return { destinationOwner: m.destinationOwner, maxAmount: m.maxAmount };
  } catch {
    return null;
  }
}
