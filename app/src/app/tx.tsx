/**
 * The one path every transaction takes:
 *
 *   build -> simulate (simulateAndExplain) -> review -> sign -> send -> confirm
 *
 * Signing is reachable only from the review of the exact transaction object
 * whose simulation passed: `signAndSend` refuses any transaction that is not
 * in `simulatedOk`. A transaction that invokes a program this app does not
 * recognise is never offered for signing, and nothing is signed or sent
 * unless the RPC endpoint is known to serve the cluster this build targets
 * (its genesis hash; a failed or pending check refuses: lib/clusterGate.ts).
 *
 * In live builds the wallet is asked to sign only a transaction (never a
 * message); if the wallet returns a transaction whose message differs from
 * the one simulated and reviewed, it is not sent. A transaction whose
 * blockhash is about to expire is rebuilt and simulated again before the
 * wallet sees it. In mock builds no wallet is asked at all (the simulated
 * chain applies the reviewed transaction).
 */
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction, type Keypair, type PublicKey } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Address, Alert, Button, Modal, explorerUrl, toast } from "../components/ui";
import { DotSpinner } from "../fx/noise";
import { sfx } from "../fx/sfx";
import { formatSol } from "../lib/amounts";
import { clusterMismatchText, clusterRefusal } from "../lib/clusterGate";
import { programDisplayName } from "../lib/display";
import { errorMessage } from "../lib/format";
import { ADAPTER_MODE, checkCluster, notifyChainChanged, sendAndConfirm, simulateAndExplain, type AnyTransaction, type SimulationReport } from "../lib/noised";
import { Details, Readout, Row, Steps, type StepState } from "../pages/inner/kit";
import { useNetwork } from "./network";
import { CLUSTER } from "./settings";
import { useOwner } from "./wallet";

/**
 * A built transaction with what only the build could tell: the summary of
 * what it does (replacing the request's) and a notice shown above the
 * review (e.g. "the release part was left out: ...").
 */
export interface BuiltTx {
  tx: AnyTransaction;
  summary?: string[];
  notice?: string | null;
}

export interface TxRequest {
  /** What the user is doing, e.g. "Commit 2 SOL to the AEGS batch". */
  title: string;
  /** What the transaction does, in plain words, shown with the simulation. */
  summary: string[];
  build: () => Promise<AnyTransaction | BuiltTx>;
  /** Keys that sign besides the wallet (a fresh mint keypair, a throwaway fee payer). */
  extraSigners?: Keypair[];
  /** Human names for signer keys shown in the review. */
  signerLabels?: { key: PublicKey; label: string }[];
  /** False when the connected wallet does not sign (pre-signed v1 bytes, a fee-payer refund). Default true. */
  walletSigns?: boolean;
  /** Skip the confirm click once simulation passes (an armed crank). The wallet still asks in live mode. */
  autoConfirm?: boolean;
  confirmLabel?: string;
  /** Runs right before broadcasting; throwing aborts the send. */
  beforeSend?: () => void;
}

export type TxOutcome =
  | { status: "confirmed"; signature: string; report: SimulationReport }
  | { status: "cancelled" }
  | { status: "failed"; error: string; report: SimulationReport | null };

type Phase = "building" | "simulating" | "review" | "signing" | "sending" | "confirmed" | "failed";

interface Active {
  /** Distinguishes runs, so a late result of a closed run never touches a newer one. */
  id: number;
  request: TxRequest;
  phase: Phase;
  /** The request's summary, or the one its build returned. */
  summary: string[];
  tx: AnyTransaction | null;
  report: SimulationReport | null;
  signature: string | null;
  error: string | null;
  sendLogs: string[];
  /** Shown above the review, e.g. after a rebuild. */
  notice: string | null;
}

type RunTx = (request: TxRequest) => Promise<TxOutcome>;

const TxContext = createContext<{ run: RunTx; busy: boolean } | null>(null);

export function useTx(): { run: RunTx; busy: boolean } {
  const c = useContext(TxContext);
  if (!c) throw new Error("useTx outside TxProvider");
  return c;
}

/** Transactions whose simulation passed in this session (identity, not content). */
const simulatedOk = new WeakSet<object>();

function txKey(tx: AnyTransaction): object {
  return tx;
}

/** Rebuild instead of signing when fewer than this many blocks (~20 s) of the blockhash's lifetime remain. */
const BLOCKHASH_MARGIN = 50;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function builtOf(b: AnyTransaction | BuiltTx): BuiltTx {
  return b instanceof Uint8Array || b instanceof Transaction ? { tx: b } : b;
}

export function TxProvider({ children }: { children: ReactNode }): ReactNode {
  const { connection } = useConnection();
  const wallet = useWallet();
  const owner = useOwner();
  const network = useNetwork();
  const [active, setActive] = useState<Active | null>(null);
  const resolver = useRef<((o: TxOutcome) => void) | null>(null);
  const activeRef = useRef<Active | null>(null);

  // The ref is the source of truth (read synchronously by `confirm`); state mirrors it for rendering.
  const update = useCallback((id: number, patch: Partial<Active>) => {
    const a = activeRef.current;
    if (!a || a.id !== id) return;
    const next = { ...a, ...patch };
    activeRef.current = next;
    setActive(next);
  }, []);

  const nextId = useRef(0);
  const settle = useCallback((id: number, o: TxOutcome) => {
    if (activeRef.current?.id !== id) return;
    const r = resolver.current;
    resolver.current = null;
    r?.(o);
  }, []);

  /** Build and simulate; on success the transaction is marked reviewable. Returns false if it may not be signed. */
  const prepare = useCallback(
    async (id: number, request: TxRequest, notice: string | null): Promise<boolean> => {
      update(id, { phase: "building", tx: null, report: null, notice, summary: request.summary });
      const built = builtOf(await request.build());
      const tx = built.tx;
      const notices = [notice, built.notice ?? null].filter((n): n is string => n !== null && n !== "");
      update(id, { tx, phase: "simulating", summary: built.summary ?? request.summary, notice: notices.length === 0 ? null : notices.join(" ") });
      const report = await simulateAndExplain(connection, tx);
      if (report.ok && report.unknownPrograms.length === 0) simulatedOk.add(txKey(tx));
      update(id, { report, phase: "review" });
      if (!report.ok || report.unknownPrograms.length > 0) {
        settle(id, { status: "failed", error: report.error ?? "This transaction calls a program this app does not recognise.", report });
        return false;
      }
      return true;
    },
    [connection, update, settle],
  );

  /**
   * True when a legacy transaction's blockhash expires before a wallet prompt
   * could reasonably complete. A convenience, not a safety check: if the
   * height cannot be read, signing proceeds and an expired transaction fails
   * at send with a plain explanation.
   */
  const blockhashStale = useCallback(
    async (tx: AnyTransaction): Promise<boolean> => {
      if (ADAPTER_MODE !== "live" || !(tx instanceof Transaction) || tx.lastValidBlockHeight === undefined) return false;
      try {
        const height = await connection.getBlockHeight("confirmed");
        return height > tx.lastValidBlockHeight - BLOCKHASH_MARGIN;
      } catch {
        return false;
      }
    },
    [connection],
  );

  /**
   * Nothing is signed or sent unless the endpoint is known to serve this
   * build's cluster (the simulated chain of a demo build reports the
   * cluster it stands for). Unless the startup check matched, it runs again
   * now; anything but a match (another cluster, a failed or pending check,
   * an unverified endpoint outside localnet) refuses.
   */
  const requireCluster = useCallback(async (): Promise<void> => {
    const cached = network.cluster;
    const c = cached !== null && cached.state === "match" ? cached : await checkCluster(connection, CLUSTER);
    const refusal = clusterRefusal(c, CLUSTER, ADAPTER_MODE);
    if (refusal !== null) throw new Error(`Refusing to sign or send: ${refusal}`);
  }, [connection, network.cluster]);

  const signAndSend = useCallback(
    async (id: number, request: TxRequest, tx: AnyTransaction, report: SimulationReport): Promise<"sent" | "rebuilt"> => {
      if (!simulatedOk.has(txKey(tx)) || !report.ok || report.unknownPrograms.length > 0) {
        throw new Error("Refusing to sign: this exact transaction has not passed simulation.");
      }
      await requireCluster();
      let toSend: AnyTransaction = tx;
      if (!(tx instanceof Uint8Array) && ADAPTER_MODE === "live") {
        update(id, { phase: "signing" });
        if (await blockhashStale(tx)) {
          // Never let a wallet sign something that would expire: rebuild and simulate again.
          await prepare(id, request, "The review took longer than the transaction's lifetime (about a minute), so it was rebuilt with a fresh blockhash and simulated again. Check it once more.");
          return "rebuilt";
        }
        const signers = request.extraSigners ?? [];
        if (signers.length > 0) tx.partialSign(...signers);
        if (request.walletSigns !== false) {
          if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect a wallet that can sign transactions.");
          const reviewed = tx.serializeMessage();
          const signed = await wallet.signTransaction(tx);
          if (!(signed instanceof Transaction)) throw new Error("The wallet returned an unsupported transaction type. Nothing was sent.");
          if (!sameBytes(signed.serializeMessage(), reviewed)) {
            throw new Error(
              "Your wallet returned a different transaction than the one simulated and reviewed here (it changed its instructions, accounts or blockhash). Nothing was sent.",
            );
          }
          toSend = signed;
        }
        if (!(toSend instanceof Uint8Array) && !toSend.verifySignatures(true)) {
          throw new Error("A required signature is missing or invalid. Nothing was sent.");
        }
      }
      request.beforeSend?.();
      update(id, { phase: "sending" });
      const signature = await sendAndConfirm(connection, toSend);
      update(id, { phase: "confirmed", signature });
      notifyChainChanged();
      settle(id, { status: "confirmed", signature, report });
      return "sent";
    },
    [connection, wallet, update, settle, blockhashStale, prepare, requireCluster],
  );

  const confirm = useCallback(async () => {
    const a = activeRef.current;
    if (!a || a.phase !== "review" || !a.tx || !a.report) return;
    try {
      const result = await signAndSend(a.id, a.request, a.tx, a.report);
      // A rebuilt transaction waits for a fresh review, even for an armed crank.
      if (result === "rebuilt") return;
    } catch (e) {
      const logs = e instanceof Error && "logs" in e && Array.isArray((e as { logs: unknown }).logs) ? ((e as { logs: string[] }).logs ?? []) : [];
      const message = clusterMismatchText(e) ?? errorMessage(e);
      update(a.id, { phase: "failed", error: message, sendLogs: logs });
      settle(a.id, { status: "failed", error: message, report: a.report });
    }
  }, [signAndSend, update, settle]);

  const run = useCallback<RunTx>(
    (request) => {
      if (activeRef.current && resolver.current) {
        return Promise.resolve({ status: "failed", error: "Another transaction is still in progress.", report: null });
      }
      const id = ++nextId.current;
      if (network.cluster?.state === "mismatch") {
        // Nothing is built: show why in the dialog instead of silently doing nothing.
        const error = `Transactions are disabled: ${network.cluster.detail}`;
        const refused: Active = { id, request, phase: "failed", summary: request.summary, tx: null, report: null, signature: null, error, sendLogs: [], notice: null };
        activeRef.current = refused;
        setActive(refused);
        return Promise.resolve({ status: "failed", error, report: null });
      }
      return new Promise<TxOutcome>((resolve) => {
        resolver.current = resolve;
        const initial: Active = { id, request, phase: "building", summary: request.summary, tx: null, report: null, signature: null, error: null, sendLogs: [], notice: null };
        activeRef.current = initial;
        setActive(initial);
        void (async () => {
          try {
            const ok = await prepare(id, request, null);
            if (ok && request.autoConfirm === true) await confirm();
          } catch (e) {
            const message = clusterMismatchText(e) ?? errorMessage(e);
            const report = activeRef.current?.id === id ? activeRef.current.report : null;
            update(id, { phase: "failed", error: message });
            settle(id, { status: "failed", error: message, report });
          }
        })();
      });
    },
    [network.cluster, prepare, update, settle, confirm],
  );

  const close = useCallback(() => {
    const a = activeRef.current;
    if (a && (a.phase === "signing" || a.phase === "sending")) return;
    if (a && (a.phase === "building" || a.phase === "simulating" || a.phase === "review")) settle(a.id, { status: "cancelled" });
    activeRef.current = null;
    setActive(null);
  }, [settle]);

  const value = useMemo(() => ({ run, busy: active !== null }), [run, active]);
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    if (owner.publicKey) m.set(owner.publicKey.toBase58(), owner.source === "demo" ? "You (demo account)" : "You (connected wallet)");
    for (const s of active?.request.signerLabels ?? []) m.set(s.key.toBase58(), s.label);
    return m;
  }, [owner.publicKey, owner.source, active?.request.signerLabels]);

  return (
    <TxContext.Provider value={value}>
      {children}
      {active ? <TxDialog active={active} labels={labels} onConfirm={() => void confirm()} onClose={close} /> : null}
    </TxContext.Provider>
  );
}

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "building", label: "Build" },
  { phase: "simulating", label: "Test run" },
  { phase: "review", label: "Review" },
  { phase: "signing", label: "Sign" },
  { phase: "sending", label: "Send" },
  { phase: "confirmed", label: "Done" },
];

/** A status line with a spinner (role=status, like <Spinner>). */
function Busy({ label }: { label: string }): ReactNode {
  return (
    <p className="pg-busy" role="status">
      <DotSpinner size={16} decorative />
      <span>{label}…</span>
    </p>
  );
}

function TxDialog({ active, labels, onConfirm, onClose }: { active: Active; labels: Map<string, string>; onConfirm: () => void; onClose: () => void }): ReactNode {
  const { request, phase, report } = active;
  const busy = phase === "signing" || phase === "sending";
  const stepIndex = STEPS.findIndex((s) => s.phase === phase);
  const canConfirm = phase === "review" && report !== null && report.ok && report.unknownPrograms.length === 0;
  const walletSigns = request.walletSigns !== false && !(active.tx instanceof Uint8Array);
  const confirmLabel = request.confirmLabel ?? (ADAPTER_MODE === "mock" ? "Approve and send (demo)" : walletSigns ? "Sign with wallet and send" : "Send");

  // Presentation only: outcome sounds (muted unless the user turned sound on) and a "[OK] ... confirmed" toast.
  const heard = useRef<Phase | null>(null);
  useEffect(() => {
    if (heard.current === phase) return;
    heard.current = phase;
    if (phase === "confirmed") toast({ text: `${request.title}: confirmed`, tone: "ok" });
    else if (phase === "failed" || (phase === "review" && report !== null && (!report.ok || report.unknownPrograms.length > 0))) sfx.play("error");
    else if (phase === "sending") sfx.play("commit");
  }, [phase, report, request.title]);

  const finished = phase === "confirmed" || phase === "failed" || (phase === "review" && !canConfirm);
  const footer =
    finished ? (
      <Button variant="primary" onClick={onClose}>
        Close
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {phase === "review" ? (
          <Button variant="primary" onClick={onConfirm} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        ) : null}
      </>
    );

  return (
    <Modal open onClose={onClose} title={request.title} footer={footer} dismissable={!busy}>
      <div className="pgx pg-tx">
        <Steps
          label="Progress"
          size="sm"
          steps={STEPS.map((s, i): { key: string; label: string; state: StepState } => ({
            key: s.phase,
            label: s.label,
            state:
              phase === "failed"
                ? i < Math.max(stepIndex, 0)
                  ? "done"
                  : i === Math.max(stepIndex, 0)
                    ? "fail"
                    : "todo"
                : i < stepIndex
                  ? "done"
                  : i === stepIndex
                    ? phase === "confirmed"
                      ? "done"
                      : "current"
                    : "todo",
          }))}
        />

        <div aria-live="polite" className="pg-tx-body">
          {active.notice ? <Alert tone="warn">{active.notice}</Alert> : null}
          {phase === "building" ? <Busy label="Building the transaction" /> : null}
          {phase === "simulating" ? <Busy label="Test-running it against the chain before anything is signed" /> : null}
          {phase === "signing" ? <Busy label={walletSigns ? "Waiting for your wallet" : "Signing"} /> : null}
          {phase === "sending" ? <Busy label="Sending and waiting for confirmation" /> : null}

          {/* The outcome first, so it shows without scrolling past the review. */}
          {phase === "confirmed" && active.signature ? (
            <Alert tone="ok" title="Confirmed">
              <span className="pg-tx-sig">
                Signature{" "}
                {ADAPTER_MODE === "live" ? (
                  <a className="link pg-mono" href={explorerUrl(active.signature, "tx")} target="_blank" rel="noopener noreferrer">
                    {active.signature}
                  </a>
                ) : (
                  <code className="pg-mono">{active.signature}</code>
                )}
                {ADAPTER_MODE === "mock" ? " (simulated chain)" : ""}
              </span>
            </Alert>
          ) : null}

          {phase === "failed" && active.error && (!report || report.ok) ? (
            <Alert tone="fail" title="The transaction did not go through">
              <p className="pg-break">{active.error}</p>
              {active.sendLogs.length > 0 ? <Logs logs={active.sendLogs} /> : null}
            </Alert>
          ) : null}

          {phase === "review" && canConfirm ? (
            ADAPTER_MODE === "mock" ? (
              <Alert tone="info" title="Demo mode">
                No wallet signature is requested. The simulated chain applies this exact transaction when you approve.
              </Alert>
            ) : walletSigns ? (
              <p className="pg-tx-note">
                Your wallet will show this transaction for signature. Compare it with the review below before you approve. If the wallet changes the
                transaction, this app refuses to send it.
              </p>
            ) : null
          ) : null}

          {report ? <SimulationView report={report} summary={active.summary} labels={labels} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function SimulationView({ report, summary, labels }: { report: SimulationReport; summary: string[]; labels: Map<string, string> }): ReactNode {
  const unknown = report.unknownPrograms.length > 0;
  return (
    <div className="pg-tx-sim">
      {report.ok && !unknown ? (
        <section className="pg-tx-pass" aria-label="Test run passed">
          <p className="pg-tx-pass-head">
            <span className="pg-tx-pass-ico" aria-hidden="true">
              ✓
            </span>
            <span>Test run passed. This transaction will:</span>
          </p>
          <ul className="pg-tx-summary">
            {summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      ) : unknown ? (
        <Alert tone="fail" title="Refusing to sign">
          This transaction calls programs this app does not recognise:{" "}
          {report.unknownPrograms.map((p) => (
            <code key={p.toBase58()} className="pg-mono">
              {p.toBase58()}
            </code>
          ))}
        </Alert>
      ) : (
        <Alert tone="fail" title="Test run failed: nothing was signed or sent">
          <p className="pg-break">{report.error}</p>
          {report.errorCode ? (
            <p className="pg-tx-code">
              {report.errorCode.program} error {report.errorCode.code} ({report.errorCode.name})
            </p>
          ) : null}
        </Alert>
      )}

      <Readout className="pg-tx-facts" label="Transaction">
        <Row k="Programs" wide>
          <ul className="pg-tx-list">
            {report.programs.map((p) => {
              const name = programDisplayName(p.programId) ?? p.name;
              return (
                <li key={p.programId.toBase58()}>
                  <span className={name ? undefined : "pg-tx-unknown"}>{name ?? "Unknown program"}</span>
                  <Address value={p.programId} />
                </li>
              );
            })}
          </ul>
        </Row>
        <Row k="Signers" wide>
          <ul className="pg-tx-list">
            {report.signers.map((k) => (
              <li key={k.toBase58()}>
                <span>{labels.get(k.toBase58()) ?? "Other signer"}</span>
                <Address value={k} />
              </li>
            ))}
          </ul>
        </Row>
        <Row k="Network fee">
          <span className="pg-num">{report.feeLamports === null ? "not priced by the RPC endpoint" : formatSol(report.feeLamports, 6)}</span>
        </Row>
        <Row k="Compute">
          <span className="pg-num">{report.unitsConsumed === null ? "n/a" : `${report.unitsConsumed.toLocaleString("en-US")} units`}</span>
        </Row>
        <Row k="Size">
          <span className="pg-num">
            {report.sizeBytes.toLocaleString("en-US")} of {report.sizeLimit.toLocaleString("en-US")} bytes ({report.format === "v1" ? "v1 transaction" : "legacy transaction"})
          </span>
        </Row>
      </Readout>

      <Details summary={`Accounts it changes (${report.writableAccounts.length})`}>
        <ul className="pg-tx-accounts">
          {report.writableAccounts.map((k) => (
            <li key={k.toBase58()}>
              <Address value={k} full />
            </li>
          ))}
        </ul>
      </Details>
      {report.logs.length > 0 ? <Logs logs={report.logs} /> : null}
    </div>
  );
}

function Logs({ logs }: { logs: string[] }): ReactNode {
  return (
    <Details summary={`Program logs (${logs.length})`} className="pgx">
      <pre className="pg-tx-logs">{logs.join("\n")}</pre>
    </Details>
  );
}
