/**
 * "This quantum key was used on another device or app" (SDK 0.9.0
 * `UnknownLeavesError`): shown wherever the key refused to sign for that
 * reason (the launch tracker, the Autopilot's Review and sign). Calm and in
 * plain words: nothing was signed, and the fix is to bring that device's
 * records in (the same import as the Vault page's "Use your key on another
 * device"). Only for a small count, after reading the key's record again
 * (and on a second network connection when the build has one), may the person
 * confirm in writing that nothing unsent is left elsewhere; a larger count is
 * never confirmable here (lib/keyElsewhere.ts).
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { useLedgers } from "../app/ledgers";
import { secondConnection, secondEndpointLabel } from "../app/secondRpc";
import { CLUSTER } from "../app/settings";
import { errorMessage } from "../lib/format";
import { confirmUnknown, recheckUnknown, type UnknownRecheck } from "../lib/keyElsewhere";
import { importKeyRecords, type ImportReport } from "../lib/ledgerBackup";
import { launchIdentity } from "../lib/pqKey";
import { CONFIRM_PHRASE, confirmable, confirmationMatches, UNKNOWN_LEAVES_CONFIRM_MAX, UNKNOWN_LEAVES_TEXT, unknownCountText } from "../lib/signErrors";
import { Alert, Button } from "./ui";
import "./keyUsedElsewhere.css";

export function KeyUsedElsewhere({ count, onResolved, className = "" }: { count: number; onResolved: () => void; className?: string }): ReactNode {
  const { connection } = useConnection();
  const ledgers = useLedgers();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [busy, setBusy] = useState<"import" | "check" | "confirm" | null>(null);
  const [text, setText] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<UnknownRecheck | null>(null);
  const [typed, setTyped] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const l = ledgers.ledgers;
  const second = secondEndpointLabel(connection.rpcEndpoint);

  const doImport = async (content: string): Promise<void> => {
    if (l === null || content.trim() === "") return;
    setBusy("import");
    setError(null);
    setReport(null);
    try {
      setReport(await importKeyRecords(l, content, { cluster: CLUSTER, identity: await launchIdentity(CLUSTER) }));
      setText("");
      setRecheck(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doCheck = async (): Promise<void> => {
    if (l === null) return;
    setBusy("check");
    setError(null);
    setTyped("");
    try {
      const identity = await launchIdentity(CLUSTER);
      setRecheck(await recheckUnknown({ conn: connection, second: secondConnection(connection.rpcEndpoint), ledger: l.leaves, identityId: identity.identityId }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doConfirm = async (): Promise<void> => {
    if (l === null || recheck === null || !recheck.canConfirm || !confirmationMatches(typed)) return;
    setBusy("confirm");
    setError(null);
    try {
      const identity = await launchIdentity(CLUSTER);
      await confirmUnknown(l.leaves, identity.publicKey, recheck.used, recheck.count);
      onResolved();
    } catch (e) {
      // The count changed since it was shown (the SDK checks it again): show the new count, never confirm blindly.
      setError(errorMessage(e));
      setRecheck(null);
    } finally {
      setBusy(null);
    }
  };

  const leafAdded = report === null ? 0 : report.leaves.reduce((n, x) => n + x.added + x.merged, 0);
  return (
    <section className={`kue ${className}`} aria-labelledby={`${id}-t`} data-testid="key-used-elsewhere">
      <div className="kue-head">
        <p className="kue-title" id={`${id}-t`}>
          Your quantum key was used somewhere else
        </p>
        <p className="kue-text">{UNKNOWN_LEAVES_TEXT}</p>
        <p className="kue-count">
          <span className="kue-n tabular-nums">{count.toLocaleString("en-US")}</span> {unknownCountText(count).replace(/^[\d,]+ /, "")}. Nothing was signed.
        </p>
      </div>

      <div className="kue-step">
        <p className="kue-step-t">Bring in that device&apos;s records</p>
        <p className="kue-step-d">On the other device, open Vault, then &ldquo;Use your key on another device&rdquo;, and save the records to a file. Choose that file here.</p>
        <div className="pg-btns">
          <Button variant="primary" disabled={l === null || busy !== null} loading={busy === "import"} onClick={() => fileRef.current?.click()}>
            Import records from the other device
          </Button>
          <input
            ref={fileRef}
            id={`${id}-file`}
            type="file"
            accept="application/json,.json"
            className="kue-file"
            tabIndex={-1}
            aria-hidden="true"
            disabled={l === null || busy !== null}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f !== undefined) void f.text().then(doImport, (err: unknown) => setError(errorMessage(err)));
            }}
          />
        </div>
        <details className="kue-paste">
          <summary>Or paste the file&apos;s text</summary>
          <div className="kue-fold">
          <label className="label" htmlFor={`${id}-text`}>
            Records file text
          </label>
          <textarea id={`${id}-text`} className="textarea mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <Button size="sm" disabled={l === null || busy !== null || text.trim() === ""} loading={busy === "import"} onClick={() => void doImport(text)}>
            Bring them in
          </Button>
          </div>
        </details>
        {report !== null ? (
          <Alert tone="ok" title="Records brought in">
            {leafAdded} launch signature{leafAdded === 1 ? "" : "s"} from the other device. Try again: your key now knows them.
          </Alert>
        ) : null}
        {report !== null && report.leavesSkipped.length > 0 && report.leaves.length === 0 ? (
          <Alert tone="warn">That file holds the records of another quantum key. Unlock the key that signed this launch, then bring the file in again.</Alert>
        ) : null}
        <div className="pg-btns">
          <Button variant={report !== null ? "primary" : "secondary"} size="sm" disabled={busy !== null} onClick={onResolved}>
            Try again
          </Button>
        </div>
      </div>

      {confirmable(count) ? (
        <details className="kue-confirm">
          <summary>The other device has nothing unsent</summary>
          <div className="kue-fold">
          <p className="kue-step-d">
            Only if every signature made on the other device has already gone through. First, this page reads your key&apos;s record again
            {second !== null ? ` on two network connections (this one and ${second})` : ""}.
          </p>
          <Button size="sm" disabled={l === null || busy !== null} loading={busy === "check"} onClick={() => void doCheck()}>
            Check again
          </Button>
          {recheck !== null && recheck.count === 0 ? <Alert tone="ok">Your key&apos;s record now matches this device. Try again.</Alert> : null}
          {recheck !== null && recheck.why !== null ? <Alert tone="fail">{recheck.why}</Alert> : null}
          {recheck !== null && recheck.canConfirm ? (
            <div className="kue-typed">
              <p className="kue-step-d">
                <strong>{unknownCountText(recheck.count)}</strong>
                {recheck.secondAgrees === true ? ", read the same on both network connections" : ""}. If any of them was never sent, confirming lets someone copy your key.
              </p>
              <label className="label" htmlFor={`${id}-typed`}>
                Type &ldquo;{CONFIRM_PHRASE}&rdquo;
              </label>
              <input id={`${id}-typed`} className="input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
              <Button variant="danger" size="sm" disabled={busy !== null || !confirmationMatches(typed)} loading={busy === "confirm"} onClick={() => void doConfirm()}>
                Confirm and try again
              </Button>
            </div>
          ) : null}
          </div>
        </details>
      ) : (
        <p className="kue-step-d kue-no">
          That is more than {UNKNOWN_LEAVES_CONFIRM_MAX} signatures, so it can&apos;t be confirmed here. Import the other device&apos;s records, or use a new quantum key.
        </p>
      )}
      {ledgers.error !== null ? <Alert tone="fail">{ledgers.error}</Alert> : null}
      {error !== null ? <Alert tone="fail">{error}</Alert> : null}
    </section>
  );
}
