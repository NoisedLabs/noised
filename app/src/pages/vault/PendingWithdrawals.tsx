/**
 * Signed withdrawals stored in this browser, one per vault and sequence
 * (vault v4). A signed withdrawal is only ever re-broadcast (rebuilt around
 * the SAME signature with a fresh blockhash and its throwaway fee payer),
 * never re-signed: an LM-OTS key signs one message, ever. Each record shows
 * what the chain says about it now: still waiting at its sequence, executed
 * with its payout pending or delivered, or superseded. A record that can
 * never execute (its key was never the vault's at its sequence, or another
 * withdrawal used that sequence) can be removed. Signings that started here
 * and never finished (a key the key records hold for a message with no
 * signature yet, or an older version's unfinished signing) are listed too:
 * their key may sign only that withdrawal. Retired vault v3 records are
 * listed read-only.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import type { LedgersState } from "../../app/ledgers";
import { CLUSTER } from "../../app/settings";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { Address, Alert, Button } from "../../components/ui";
import { formatSol, formatUnits, U64_MAX } from "../../lib/amounts";
import { formatTimestamp } from "../../lib/format";
import {
  ADAPTER_MODE,
  buildFundFeePayerTx,
  buildRefundFeePayerTx,
  FEE_PAYER_FUNDING_LAMPORTS,
  fetchVault,
  getMintInfo,
  getSolBalance,
  parseWithdrawMessage,
  type PendingWithdrawal,
  type PendingWithdrawalSearch,
  type VaultKeyRecord,
} from "../../lib/noised";
import {
  decodeHex,
  decodeKey,
  deleteRetiredWithdrawal,
  deleteSigningClaim,
  deleteWithdrawal,
  effectiveStatus,
  exportWithdrawal,
  feePayerOf,
  integrityOf,
  loadRetiredWithdrawals,
  loadSigningClaims,
  loadWithdrawals,
  markRetiredRefunded,
  replaceWithRevealed,
  subscribeWithdrawals,
  updateWithdrawal,
  type RetiredWithdrawal,
  type SigningClaim,
  type StoredWithdrawal,
  type WithdrawalStatus,
} from "../../lib/storage";
import {
  cannotExecute,
  importWithdrawalBackup,
  IncompleteBroadcastSearchError,
  planBroadcast,
  recordFromRevealed,
  recordVerdict,
  RevealedConflictError,
  type BroadcastOptions,
  type RecordVerdict,
} from "../../lib/vaultFlow";
import { Chip, Details, EmptyState, Panel, Readout, Row, Steps, Toggle, type KitTone, type StepState } from "../inner/kit";
import { DotGlyph } from "../inner/glyphs";
import { VAULT_CHAIN } from "./chain";
import { payoutAmountText, PayoutRow } from "./Payouts";

const STATUS: Record<WithdrawalStatus, { label: string; tone: KitTone }> = {
  signed: { label: "Signed, not sent", tone: "warn" },
  funded: { label: "Fee payer funded", tone: "signal" },
  broadcast: { label: "Sent, not confirmed", tone: "signal" },
  executed: { label: "Withdrawal done", tone: "ok" },
  failed: { label: "Last try failed", tone: "danger" },
};

/** Lamports a fee payer keeps after a refund (the refund's own fee). */
const DUST = 5_000n;

export function useStoredWithdrawals(): StoredWithdrawal[] {
  const [list, setList] = useState<StoredWithdrawal[]>(() => loadWithdrawals());
  useEffect(() => subscribeWithdrawals(() => setList(loadWithdrawals())), []);
  return list;
}

export function useRetiredWithdrawals(): RetiredWithdrawal[] {
  const [list, setList] = useState<RetiredWithdrawal[]>(() => loadRetiredWithdrawals());
  useEffect(() => subscribeWithdrawals(() => setList(loadRetiredWithdrawals())), []);
  return list;
}

/** Signings that started in this browser (or another tab of it) and whose record was never saved. */
export function useSigningClaims(): SigningClaim[] {
  const [list, setList] = useState<SigningClaim[]>(() => loadSigningClaims());
  useEffect(() => subscribeWithdrawals(() => setList(loadSigningClaims())), []);
  return list;
}

/** A record that may still need the user: not executed in this build, or its fee payer not refunded. */
export function needsAttention(w: StoredWithdrawal): boolean {
  return effectiveStatus(w) !== "executed" || !w.feePayerRefunded;
}

const recordId = (w: StoredWithdrawal): string => `withdrawal-${w.vault}-${w.sequence}`;

export function PendingWithdrawals({ ledgers }: { ledgers: LedgersState }): ReactNode {
  const list = useStoredWithdrawals();
  const waiting = list.filter(needsAttention).length;
  return (
    <Panel
      id="pending"
      title="Signed withdrawals in this browser"
      glyph={<DotGlyph name="letter" />}
      description="One per vault key, kept until you remove it. Sending reuses the saved signature; this app never signs a second message with a vault key."
      status={list.length === 0 ? <Chip tone="muted">None</Chip> : waiting > 0 ? <Chip tone="warn" pulse>{`${waiting} need attention`}</Chip> : <Chip tone="ok">{`${list.length} done`}</Chip>}
      tone={waiting > 0 ? "warn" : undefined}
    >
      {list.length === 0 ? (
        <EmptyState art={<DotGlyph name="letter" />}>None yet. When you sign a withdrawal it is saved here, and read back, before anything is sent.</EmptyState>
      ) : null}
      <ul className="pg-records">
        {[...list]
          .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.createdAt - a.createdAt)
          .map((w) => (
            <li key={`${w.vault}:${w.sequence}`} id={recordId(w)}>
              <WithdrawalItem w={w} ledgers={ledgers} />
            </li>
          ))}
      </ul>
      <InterruptedSignings ledgers={ledgers} />
      <ImportBackup ledgers={ledgers} />
    </Panel>
  );
}

/** Keys the key records hold for a withdrawal that was never signed (a signing that did not finish, here or in another tab). */
function useReservedKeys(ledgers: LedgersState): VaultKeyRecord[] {
  const [list, setList] = useState<VaultKeyRecord[]>([]);
  const l = ledgers.ledgers;
  useEffect(() => {
    let alive = true;
    if (l === null) return;
    l.vaultKeys.list().then(
      (all) => {
        if (alive) setList(all.filter((r) => r.signature === null));
      },
      () => {
        if (alive) setList([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [l, ledgers.version]);
  return list;
}

/**
 * Signings that started and never finished: a key the key records hold for
 * one message with no signature yet, and the unfinished signings of older
 * versions of this app (moved into the key records when the key is next
 * unlocked). Their key may sign only that withdrawal.
 */
function InterruptedSignings({ ledgers }: { ledgers: LedgersState }): ReactNode {
  const claims = useSigningClaims();
  const reserved = useReservedKeys(ledgers);
  if (claims.length === 0 && reserved.length === 0) return null;
  return (
    <div className="pg-stack-sm">
      <h3 className="pg-subhead">Signings that did not finish</h3>
      <ul className="pg-records">
        {reserved.map((r) => (
          <li key={r.keyId}>
            <ReservedKey r={r} />
          </li>
        ))}
        {claims.map((c) => (
          <li key={`${c.vault}:${c.sequence}`}>
            <InterruptedSigning c={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A key reserved in the key records for a withdrawal that was never signed. */
function ReservedKey({ r }: { r: VaultKeyRecord }): ReactNode {
  const parsed = useMemo(() => {
    try {
      return parseWithdrawMessage(decodeHex(r.message));
    } catch {
      return null;
    }
  }, [r.message]);
  return (
    <article className="pg-record" data-tone="warn">
      <div className="pg-record-head">
        <Chip tone="warn">Signing did not finish</Chip>
        <span className="pg-note">started {formatTimestamp(Math.floor(r.createdAt / 1000))}</span>
      </div>
      <Readout label="Unfinished signing">
        <Row k="Vault">
          <Address value={r.vault} explorer /> <span className="pg-note">key {r.sequence}</span>
        </Row>
        <Row k="Recipient wallet">{parsed ? <Address value={parsed.destinationOwner} explorer /> : "unreadable"}</Row>
        <Row k="Maximum">
          <span className="pg-num">{parsed ? (parsed.maxAmount === U64_MAX ? "everything available" : `${parsed.maxAmount.toString()} base units`) : "unreadable"}</span>
        </Row>
      </Readout>
      <p className="pg-small">
        This key is set aside for this withdrawal and nothing else. To finish, unlock your quantum key, choose the vault and sign exactly this withdrawal (the
        same recipient and amount); the key's withdraw form offers to fill it in.
      </p>
    </article>
  );
}

function InterruptedSigning({ c }: { c: SigningClaim }): ReactNode {
  const { connection } = useConnection();
  const sameCluster = c.cluster === CLUSTER;
  const vault = useAsync(() => fetchVault(connection, new PublicKey(c.vault)), [connection, c.vault], { enabled: sameCluster });
  const parsed = useMemo(() => {
    try {
      return parseWithdrawMessage(decodeHex(c.message));
    } catch {
      return null;
    }
  }, [c.message]);
  // Once the vault is past this sequence, the key of the claim can no longer sign anything: the claim is moot.
  const moot = sameCluster && vault.data !== undefined && vault.data !== null && vault.data.sequence > BigInt(c.sequence);
  return (
    <article className="pg-record" data-tone="warn">
      <div className="pg-record-head">
        <Chip tone="warn">Signing did not finish</Chip>
        {c.cluster !== "" ? <span className="pg-note">{c.cluster}</span> : null}
        {c.createdAt > 0 ? <span className="pg-note">started {formatTimestamp(Math.floor(c.createdAt / 1000))}</span> : null}
      </div>
      <Readout label="Unfinished signing">
        <Row k={`Vault${c.account >= 0 ? ` #${c.account}` : ""}`}>
          <Address value={c.vault} explorer /> <span className="pg-note">key {c.sequence}</span>
        </Row>
        <Row k="Recipient wallet">{parsed ? <Address value={parsed.destinationOwner} explorer /> : "unreadable"}</Row>
        <Row k="Maximum">
          <span className="pg-num">{parsed ? (parsed.maxAmount === U64_MAX ? "everything available" : `${parsed.maxAmount.toString()} base units`) : "unreadable"}</span>
        </Row>
      </Readout>
      <p className="pg-small">
        This withdrawal was being signed in this browser and its record was never saved (storage failed, or the tab closed), so the key of this sequence
        may have signed it. That key may sign only this withdrawal: to finish, unlock your quantum key and sign exactly it again (the same recipient and amount:
        the signature is identical), or import its backup if you downloaded one.
      </p>
      {moot ? (
        <Button size="sm" variant="ghost" className="pg-self-start" onClick={() => deleteSigningClaim(c.vault, c.sequence)}>
          Remove (the vault moved past this sequence)
        </Button>
      ) : null}
    </article>
  );
}

function ImportBackup({ ledgers }: { ledgers: LedgersState }): ReactNode {
  const { connection } = useConnection();
  const l = ledgers.ledgers;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  return (
    <Details summary="Import a signed withdrawal backup" boxed>
      <p className="pg-small">
        Paste a backup downloaded from this page (for example on another device). It is imported only if its vault exists on this cluster, waits at its
        key and the vault's current key made its signature: any other could never execute. It gets a new throwaway fee payer; the signature is reused as
        is, never re-made. Before it is sent, the vault's history is checked for a different withdrawal of the same key.
      </p>
      <label htmlFor="import-backup" className="sr-only">
        Backup JSON
      </label>
      <textarea id="import-backup" className="textarea mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="pg-btns">
        <Button
          size="sm"
          loading={busy}
          disabled={text.trim() === "" || busy || l === null}
          onClick={() => {
            if (l === null) return;
            setBusy(true);
            setResult(null);
            importWithdrawalBackup(VAULT_CHAIN, connection, text, CLUSTER, l.vaultKeys)
              .then(
                () => {
                  setText("");
                  setResult({ tone: "ok", text: "Imported. Fund its fee payer, then broadcast it." });
                },
                (e: unknown) => setResult({ tone: "fail", text: e instanceof Error ? e.message : "Import failed." }),
              )
              .finally(() => setBusy(false));
          }}
        >
          Import
        </Button>
        {result ? <span className={result.tone === "ok" ? "pg-ok" : "pg-fail"}>{result.text}</span> : null}
      </div>
    </Details>
  );
}

function verdictBadge(v: RecordVerdict, w: StoredWithdrawal): { label: string; tone: KitTone } {
  switch (v.kind) {
    case "missing":
      return { label: "No vault on this cluster", tone: "danger" };
    case "pending":
      return { label: `Vault waiting at key ${w.sequence}: not done yet`, tone: "warn" };
    case "dead":
      return { label: "Not the vault's current key", tone: "danger" };
    case "early":
      return { label: `Vault still at key ${v.vault.sequence.toString()}`, tone: "warn" };
    case "executed":
      if (v.ours === false) return { label: "Another withdrawal used this key", tone: "danger" };
      if (v.payout !== null) return { label: "Done, payout waiting for delivery", tone: "warn" };
      return { label: w.status === "executed" ? "Done and delivered" : "Key used, payout delivered", tone: "ok" };
  }
}

function WithdrawalItem({ w, ledgers }: { w: StoredWithdrawal; ledgers: LedgersState }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const feePayer = useMemo(() => feePayerOf(w), [w.feePayerSecret]);
  const sameCluster = w.cluster === CLUSTER;
  const mint = useMemo(() => new PublicKey(w.mint), [w.mint]);
  const balance = useAsync(() => getSolBalance(connection, feePayer.publicKey), [connection, feePayer.publicKey.toBase58()]);
  const mintInfo = useAsync(() => getMintInfo(connection, mint), [connection, w.mint], { watchChain: false, enabled: sameCluster });
  const verdict = useAsync(() => recordVerdict(VAULT_CHAIN, connection, w), [connection, w.vault, w.sequence, w.signature], { enabled: sameCluster });
  const [conflict, setConflict] = useState<PendingWithdrawal | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // The last broadcast stopped before building: the history search could not rule out a different public withdrawal of this key.
  const [incomplete, setIncomplete] = useState<PendingWithdrawalSearch | null>(null);
  const [broadcastAnyway, setBroadcastAnyway] = useState(false);
  const integrity = integrityOf(w);
  const recordStatus = effectiveStatus(w);
  const v = verdict.data;
  const decimals = mintInfo.data?.decimals ?? 0;
  const symbol = mintInfo.data?.symbol ?? "tokens";
  const sol = balance.data ?? 0n;
  const me = owner.publicKey;
  const executed = v?.kind === "executed";
  const ledger = ledgers.ledgers?.vaultKeys ?? null;
  const canBroadcast = integrity.ok && sol > 0n && sameCluster && v?.kind === "pending" && conflict === null && ledger !== null;
  const maxAmount = BigInt(w.maxAmount);
  const amountText = maxAmount === U64_MAX ? `everything available in the vault (${symbol})` : `up to ${formatUnits(maxAmount, decimals)} ${symbol}`;
  const nextSequence = (BigInt(w.sequence) + 1n).toString();
  const badge = v === undefined ? null : verdictBadge(v, w);

  // Keep the record in step with the chain: a used sequence whose payout names this record's recipient executed.
  useEffect(() => {
    if (v?.kind === "executed" && v.ours === true && (w.status !== "executed" || w.mode !== ADAPTER_MODE)) {
      updateWithdrawal(w.vault, w.sequence, { status: "executed", mode: ADAPTER_MODE, lastError: null });
    }
  }, [v, w.status, w.mode, w.vault, w.sequence]);

  const broadcast = (opts: BroadcastOptions = {}): void => {
    if (!canBroadcast || ledger === null) return;
    let sent = false;
    void run({
      title: recordStatus === "signed" || recordStatus === "funded" ? "Broadcast the signed withdrawal" : "Re-broadcast the signed withdrawal",
      summary: [
        `Withdraws ${amountText} for ${w.destinationOwner} with the stored signature, and hands the vault to its next key (sequence ${nextSequence}).`,
        "Sent as a v1 transaction signed only by the throwaway fee payer, which has no authority over the vault. No new vault signature is made.",
      ],
      build: async () => {
        let plan;
        try {
          plan = await planBroadcast(VAULT_CHAIN, connection, w, ledger, opts);
        } catch (e) {
          if (e instanceof RevealedConflictError) setConflict(e.revealed);
          if (e instanceof IncompleteBroadcastSearchError) {
            setIncomplete(e.search);
            setBroadcastAnyway(false);
          }
          throw e;
        }
        setIncomplete(null);
        const reserved = plan.expectedAmount === 0n ? "nothing (the vault has no unreserved balance now)" : `${formatUnits(plan.expectedAmount, decimals)} ${symbol} at today's balance`;
        const summary = plan.includesRelease
          ? [
              `Withdraws with the stored signature: the vault reserves ${reserved} for ${w.destinationOwner} and rotates to its next key (sequence ${nextSequence}).`,
              "Delivers that payout in the same transaction to the recipient's canonical token account (created if missing); the payout account's rent comes back to the fee payer.",
              "Sent as a v1 transaction signed only by the throwaway fee payer, which has no authority over the vault. No new vault signature is made.",
            ]
          : [
              `Withdraws with the stored signature: the vault reserves ${reserved} for ${w.destinationOwner} and rotates to its next key (sequence ${nextSequence}).`,
              "The payout stays reserved for the recipient: deliver it here once its delivery can succeed, or the recipient can receive it into another account.",
              "Sent as a v1 transaction signed only by the throwaway fee payer, which has no authority over the vault. No new vault signature is made.",
            ];
        const notices = [
          plan.releaseError === null
            ? null
            : `Delivering the payout would fail right now (${plan.releaseError}). This transaction therefore executes the withdrawal alone, with the same signature; the payout stays reserved and can be delivered later.`,
          plan.searchNote === null ? null : `The vault's history could not be fully checked for another withdrawal of this key (${plan.searchNote}).`,
        ].filter((n): n is string => n !== null);
        return { tx: plan.tx, summary, notice: notices.length === 0 ? null : notices.join(" ") };
      },
      walletSigns: false,
      signerLabels: [{ key: feePayer.publicKey, label: "Throwaway fee payer (no authority)" }],
      confirmLabel: "Broadcast",
      beforeSend: () => {
        sent = true;
        updateWithdrawal(w.vault, w.sequence, { status: "broadcast", mode: ADAPTER_MODE, lastError: null });
      },
    }).then(async (o) => {
      if (o.status === "confirmed") {
        updateWithdrawal(w.vault, w.sequence, { status: "executed", mode: ADAPTER_MODE, lastTxSignature: o.signature, lastError: null });
        verdict.reload();
        return;
      }
      if (o.status !== "failed") return;
      if (!sent) {
        updateWithdrawal(w.vault, w.sequence, { lastError: o.error });
        return;
      }
      // Whatever failed, the chain decides whether this sequence executed.
      let after: RecordVerdict | null = null;
      try {
        after = await recordVerdict(VAULT_CHAIN, connection, w);
      } catch {
        after = null;
      }
      if (after?.kind === "executed" && after.ours === true) updateWithdrawal(w.vault, w.sequence, { status: "executed", mode: ADAPTER_MODE, lastError: null });
      else updateWithdrawal(w.vault, w.sequence, { status: "failed", mode: ADAPTER_MODE, lastError: o.error });
      verdict.reload();
    });
  };

  const switchToRevealed = (): void => {
    if (conflict === null) return;
    try {
      const revealed = recordFromRevealed(VAULT_CHAIN, { cluster: w.cluster, mint, account: w.account, vault: new PublicKey(w.vault) }, decodeKey(w.key), conflict, feePayer);
      const check = integrityOf(revealed);
      if (!check.ok) throw new Error(check.reason ?? "The public withdrawal does not verify with this record's key.");
      replaceWithRevealed(w, revealed);
      setConflict(null);
    } catch (e) {
      setSwitchError(e instanceof Error ? e.message : String(e));
    }
  };

  const status = STATUS[recordStatus];
  // The record's journey as steps (presentation of the same state the badges show).
  const ours = v?.kind === "executed" ? v.ours !== false : null;
  const funded = sol > 0n || recordStatus === "funded" || recordStatus === "broadcast" || recordStatus === "executed" || executed;
  const journey: { key: string; label: string; state: StepState }[] = [
    { key: "signed", label: "Signed", state: "done" },
    { key: "saved", label: "Saved", state: integrity.ok ? "done" : "fail" },
    { key: "funded", label: "Fee payer", state: funded ? "done" : "current" },
    { key: "sent", label: "Sent", state: executed || recordStatus === "broadcast" ? "done" : funded && canBroadcast ? "current" : recordStatus === "failed" ? "fail" : "todo" },
    { key: "executed", label: "Done", state: executed ? (ours ? "done" : "fail") : "todo" },
    { key: "delivered", label: "Delivered", state: executed && ours ? (v.payout === null ? "done" : "current") : "todo" },
  ];
  return (
    <article className="pg-record" data-tone={needsAttention(w) ? "warn" : "ok"}>
      <Steps label="Withdrawal progress" steps={journey} size="sm" />
      <div className="pg-record-head">
        <span className="pg-record-amount">{maxAmount === U64_MAX ? `Everything free (${symbol})` : `${formatUnits(maxAmount, decimals)} ${symbol}`}</span>
        <Chip tone={status.tone}>{status.label}</Chip>
        {badge !== null ? <Chip tone={badge.tone}>{badge.label}</Chip> : null}
        {integrity.ok ? <Chip tone="ok">Signature checks out</Chip> : <Chip tone="danger">Record damaged</Chip>}
        {w.source === "revealed" ? <Chip tone="signal">Found on chain</Chip> : w.source === "imported" ? <Chip tone="signal">Imported</Chip> : null}
        {w.mode !== ADAPTER_MODE ? <Chip tone="warn">{`Signed in ${w.mode === "mock" ? "demo mode" : "a live build"}`}</Chip> : null}
        <span className="pg-note">saved {formatTimestamp(Math.floor(w.createdAt / 1000))}</span>
      </div>
      <Readout label="Signed withdrawal">
        <Row k={`Vault #${w.account}`}>
          <Address value={w.vault} explorer /> <span className="pg-note">key {w.sequence}</span>
        </Row>
        <Row k="Recipient wallet">
          <Address value={w.destinationOwner} explorer />
        </Row>
        <Row k="Next key">
          vault #{w.account}, key {nextSequence}
        </Row>
        <Row k="Fee payer">
          <Address value={feePayer.publicKey} explorer /> <span className="pg-note pg-num">{balance.data === undefined ? "…" : formatSol(sol, 6)}</span>
        </Row>
        {w.lastTxSignature ? (
          <Row k="Last transaction">
            <Address value={w.lastTxSignature} />
          </Row>
        ) : null}
      </Readout>

      {!sameCluster ? (
        <Alert tone="warn" title={`Signed for ${w.cluster}`}>
          This build targets {CLUSTER}; broadcast it from a {w.cluster} build.
        </Alert>
      ) : null}
      {w.mode === "mock" && ADAPTER_MODE === "live" ? (
        <Alert tone="warn" title="Signed in demo mode with a real key">
          Demo mode signs with the real one-time keys of your quantum key. This key has therefore signed this message for sequence {w.sequence} and must never
          sign another: if this vault exists on this cluster at that sequence, this is the only withdrawal its key can ever make. Broadcast it, or leave
          the vault untouched.
        </Alert>
      ) : null}
      {v?.kind === "executed" && v.ours === false ? (
        <Alert tone="fail" title="Another withdrawal used this sequence">
          Its payout names another recipient, so this vault's key at sequence {w.sequence} signed a different message somewhere (another device or
          browser). This record can never execute. Never sign withdrawals with this quantum key on two devices at the same time.
        </Alert>
      ) : null}
      {v?.kind === "dead" ? (
        <Alert tone="fail" title="This signature cannot execute">
          The vault waits at sequence {w.sequence}, but its current key is not the one that made this signature, so the program would refuse it.
        </Alert>
      ) : null}
      {v?.kind === "executed" && v.ours === true && v.payout !== null ? (
        <div className="pg-stack-sm">
          <p className="pg-small">
            The withdrawal executed and reserved {payoutAmountText(v.payout.amount, decimals, symbol)}. Delivering it pays the recipient (anyone can); its rent returns to
            the fee payer, so refund the fee payer afterwards.
          </p>
          <ul className="pg-records">
            <PayoutRow payout={v.payout} mint={mint} tokenProgram={v.vault.tokenProgram} decimals={decimals} symbol={symbol} onDone={() => verdict.reload()} />
          </ul>
        </div>
      ) : null}
      {conflict !== null ? (
        <Alert tone="fail" title="A different withdrawal of this key is already public">
          <p>
            Transaction <Address value={conflict.txSignature} /> revealed a withdrawal of this vault's current key to <Address value={conflict.destinationOwner} />.
            Broadcasting this record would reveal a second signature of a one-time key, which could let an attacker forge a third. It is blocked.
          </p>
          <p className="pg-gap-top">Switch to the public withdrawal: it is re-broadcast instead, and this record is archived (kept, never broadcast).</p>
          <Button size="sm" variant="primary" className="pg-gap-top" onClick={switchToRevealed}>
            Switch to the public withdrawal
          </Button>
          {switchError ? <p className="pg-gap-top pg-fail">{switchError}</p> : null}
        </Alert>
      ) : null}
      {incomplete !== null && conflict === null ? (
        <Alert tone="warn" title="Not broadcast: the vault's history is not fully checked">
          <p>{incomplete.note ?? "The vault's history could not be read back far enough."}</p>
          <p className="pg-gap-top">
            Nothing was built or sent. Broadcasting reveals this signature: if this key already signed a different withdrawal that is public but was not
            found yet, the two together could let an attacker forge a third.
          </p>
          {incomplete.continuation !== null ? (
            <Button size="sm" variant="primary" className="pg-gap-top" disabled={!canBroadcast} onClick={() => broadcast({ continueFrom: incomplete.continuation })}>
              Continue searching
            </Button>
          ) : null}
          <Toggle checked={broadcastAnyway} onChange={setBroadcastAnyway} className="pg-ack">
            I want to broadcast this stored signature without a complete search, and I accept that risk.
          </Toggle>
          <Button size="sm" className="pg-gap-top" disabled={!canBroadcast || !broadcastAnyway} onClick={() => broadcast({ broadcastDespiteIncompleteSearch: true })}>
            Broadcast anyway
          </Button>
        </Alert>
      ) : null}
      {!integrity.ok ? (
        <Alert tone="fail" title="This record cannot be broadcast">
          {integrity.reason}
        </Alert>
      ) : null}
      {verdict.error ? <p className="pg-small pg-warn">Could not read the vault: {verdict.error}</p> : null}
      {w.lastError ? <p className="pg-small">{w.lastError}</p> : null}

      <div className="pg-btns">
        {!executed ? (
          <>
            <Button
              size="sm"
              disabled={!me || !sameCluster}
              onClick={() =>
                me &&
                void run({
                  title: "Fund the throwaway fee payer",
                  summary: [
                    `Sends ${formatSol(FEE_PAYER_FUNDING_LAMPORTS, 4)} from your account to the fee payer generated for this withdrawal.`,
                    "It pays the v1 transaction fee, the payout account's rent (returned when the payout is delivered) and the recipient's token account if it does not exist yet. Refund what is left afterwards.",
                  ],
                  build: () => buildFundFeePayerTx(connection, me, feePayer.publicKey, FEE_PAYER_FUNDING_LAMPORTS),
                }).then((o) => {
                  if (o.status === "confirmed" && recordStatus === "signed") updateWithdrawal(w.vault, w.sequence, { status: "funded", mode: ADAPTER_MODE });
                })
              }
            >
              {sol >= FEE_PAYER_FUNDING_LAMPORTS / 2n ? `Top up fee payer (${formatSol(FEE_PAYER_FUNDING_LAMPORTS, 2)})` : `Fund fee payer (${formatSol(FEE_PAYER_FUNDING_LAMPORTS, 2)})`}
            </Button>
            <Button size="sm" variant="primary" disabled={!canBroadcast} onClick={() => broadcast()}>
              {recordStatus === "signed" || recordStatus === "funded" ? "Broadcast" : "Re-broadcast (same signature)"}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          disabled={!me || !sameCluster || sol <= DUST}
          onClick={() =>
            me &&
            void run({
              title: "Refund the fee payer",
              summary: [`Returns everything left on the throwaway fee payer (minus the network fee) to your account ${me.toBase58()}.`, "Signed by the fee payer's local key; your wallet signs nothing."],
              build: () => buildRefundFeePayerTx(connection, feePayer, me),
              extraSigners: [feePayer],
              walletSigns: false,
              signerLabels: [{ key: feePayer.publicKey, label: "Throwaway fee payer (key kept in this browser)" }],
              confirmLabel: "Send refund",
            }).then((o) => {
              if (o.status === "confirmed") updateWithdrawal(w.vault, w.sequence, { feePayerRefunded: true });
            })
          }
        >
          Refund fee payer
        </Button>
        <a className="btn btn-ghost btn-sm" download={`noised-withdrawal-${w.vault.slice(0, 8)}-${w.sequence}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(exportWithdrawal(w))}`}>
          Download backup
        </a>
        {cannotExecute(v) ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={sol > DUST}
            title={sol > DUST ? "Refund the fee payer first" : undefined}
            onClick={() => {
              if (window.confirm("Remove this record from this browser? Its signature can never execute: the vault's key at this sequence did not make it, or another withdrawal used this sequence.")) {
                deleteWithdrawal(w.vault, w.sequence);
              }
            }}
          >
            Remove record
          </Button>
        ) : null}
        {executed && v.payout === null && recordStatus === "executed" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={sol > DUST}
            title={sol > DUST ? "Refund the fee payer first" : undefined}
            onClick={() => {
              if (window.confirm("Remove this withdrawal record from this browser? It executed on chain, its payout was delivered and its fee payer is empty.")) deleteWithdrawal(w.vault, w.sequence);
            }}
          >
            Remove record
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** Vault v3 records and archived v4 records: read-only, never broadcast. */
export function RetiredWithdrawals(): ReactNode {
  const list = useRetiredWithdrawals();
  if (list.length === 0) return null;
  return (
    <Panel
      id="retired"
      title="Retired withdrawal records"
      description="Kept in this browser for your records. None of them can or will ever be broadcast, and nothing is signed for them."
      status={<Chip tone="muted">{`${list.length} kept`}</Chip>}
    >
      <Alert tone="info" title="Why these are retired">
        Vault v3 records hold "PHX-PQV3" messages for v3 vaults. The vault program now runs v4 (keys rotate in place; payouts are reserved, then
        delivered), so a v3 signature can never execute, and v3 keys came from another derivation that this app no longer uses. Archived records are v4
        withdrawals replaced by a different public withdrawal of the same key, or set aside because the vault's key never made them. You can download
        each one, refund its fee payer's leftover SOL, or remove it.
      </Alert>
      <ul className="pg-records">
        {list.map((r) => (
          <li key={r.storageKey}>
            <RetiredItem r={r} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function RetiredItem({ r }: { r: RetiredWithdrawal }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const feePayer = useMemo(() => (r.feePayerSecret === null ? null : feePayerOf({ feePayerSecret: r.feePayerSecret })), [r.feePayerSecret]);
  const balance = useAsync(() => (feePayer === null ? Promise.resolve(0n) : getSolBalance(connection, feePayer.publicKey)), [connection, feePayer?.publicKey.toBase58()]);
  const me = owner.publicKey;
  const sol = balance.data ?? 0n;
  return (
    <article className="pg-record">
      <div className="pg-record-head">
        <Chip tone="muted">{r.kind === "v3" ? "Vault v3, retired" : "Archived, never sent"}</Chip>
        <Chip tone="muted" dot={false}>
          {r.mode === "mock" ? "Demo mode" : "Live build"}
        </Chip>
        <span className="pg-note">{r.cluster}</span>
        {r.createdAt > 0 ? <span className="pg-note">saved {formatTimestamp(Math.floor(r.createdAt / 1000))}</span> : null}
      </div>
      <Readout label="Retired record">
        <Row k="Vault">
          <Address value={r.vault} />
        </Row>
        <Row k="Recipient wallet">{r.destinationOwner === "" ? "?" : <Address value={r.destinationOwner} />}</Row>
        <Row k="Maximum">
          <span className="pg-num">{r.maxAmount === U64_MAX.toString() ? "everything" : `${r.maxAmount} base units`}</span>
        </Row>
        {r.reason !== null ? (
          <Row k="Why" wide>
            {r.reason}
          </Row>
        ) : null}
        {feePayer !== null ? (
          <Row k="Fee payer">
            <Address value={feePayer.publicKey} /> <span className="pg-note pg-num">{balance.data === undefined ? "…" : formatSol(sol, 6)}</span>
          </Row>
        ) : null}
      </Readout>
      <div className="pg-btns">
        {feePayer !== null ? (
          <Button
            size="sm"
            disabled={!me || sol <= DUST}
            onClick={() =>
              me &&
              void run({
                title: "Refund a retired record's fee payer",
                summary: [`Returns everything left on this throwaway fee payer (minus the network fee) to your account ${me.toBase58()}.`, "Signed by the fee payer's local key; your wallet signs nothing."],
                build: () => buildRefundFeePayerTx(connection, feePayer, me),
                extraSigners: [feePayer],
                walletSigns: false,
                signerLabels: [{ key: feePayer.publicKey, label: "Throwaway fee payer (key kept in this browser)" }],
                confirmLabel: "Send refund",
              }).then((o) => {
                if (o.status === "confirmed") markRetiredRefunded(r.storageKey);
              })
            }
          >
            Refund fee payer
          </Button>
        ) : null}
        <a className="btn btn-ghost btn-sm" download={`noised-retired-withdrawal-${r.vault.slice(0, 8)}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(r.backup)}`}>
          Download
        </a>
        <Button
          size="sm"
          variant="ghost"
          disabled={sol > DUST}
          title={sol > DUST ? "Refund the fee payer first" : undefined}
          onClick={() => {
            if (window.confirm("Remove this retired record from this browser? It can never be broadcast; download it first if you want to keep it.")) deleteRetiredWithdrawal(r.storageKey);
          }}
        >
          Remove
        </Button>
      </div>
    </article>
  );
}
