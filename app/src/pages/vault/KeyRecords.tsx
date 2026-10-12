/**
 * "Use your key on another device": move this browser's records of used
 * one-time keys (vault keys and launch-signing leaves) to another device
 * that holds the same quantum key, and bring that device's records here
 * (lib/ledgerBackup.ts; the SDK authenticates every record on import).
 */
import { useState, type ReactNode } from "react";

import type { LedgersState } from "../../app/ledgers";
import { CLUSTER } from "../../app/settings";
import { Alert, Button } from "../../components/ui";
import { errorMessage } from "../../lib/format";
import { exportKeyRecords, importKeyRecords, type ImportReport } from "../../lib/ledgerBackup";
import { launchIdentity, pqKeyState, usePqKey, vaultMaster } from "../../lib/pqKey";
import { Comment, Details, Panel } from "../inner/kit";

export function KeyRecords({ ledgers }: { ledgers: LedgersState }): ReactNode {
  const key = usePqKey();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [file, setFile] = useState<{ href: string; name: string; summary: string; warning: string | null } | null>(null);
  const [text, setText] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const l = ledgers.ledgers;

  const identityIfUnlocked = async (): Promise<Awaited<ReturnType<typeof launchIdentity>> | null> =>
    pqKeyState().status === "unlocked" ? launchIdentity(CLUSTER).catch(() => null) : null;

  const doExport = async (): Promise<void> => {
    if (l === null) return;
    setBusy("export");
    setError(null);
    try {
      const r = await exportKeyRecords(l, { cluster: CLUSTER, master: vaultMaster(), identity: await identityIfUnlocked() });
      const stamp = new Date().toISOString().slice(0, 10);
      setFile({
        href: `data:application/json;charset=utf-8,${encodeURIComponent(r.text)}`,
        name: `noised-key-records-${CLUSTER}-${stamp}.json`,
        summary: `${r.vaultRecords} vault key${r.vaultRecords === 1 ? "" : "s"} and ${r.leafRecords} launch signature${r.leafRecords === 1 ? "" : "s"}.`,
        warning:
          r.missingKeys > 0
            ? `${r.missingKeys} used key${r.missingKeys === 1 ? " is" : "s are"} missing from this file. Unlock your quantum key and save the file again, or the other device will refuse to withdraw.`
            : null,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (content: string): Promise<void> => {
    if (l === null || content.trim() === "") return;
    setBusy("import");
    setError(null);
    setReport(null);
    try {
      setReport(await importKeyRecords(l, content, { cluster: CLUSTER, identity: await identityIfUnlocked() }));
      setText("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      id="key-records"
      title="Use your key on another device"
      description="Each browser remembers which one-time keys it already used. Before you withdraw or launch from another device with the same quantum key, move these records there, and bring that device's records here."
    >
      <div className="pg-stack">
        {ledgers.error !== null ? <Alert tone="fail">{ledgers.error}</Alert> : null}
        {l !== null && l.migration.conflicts.length > 0 ? (
          <Alert tone="fail" title="A key signed two different withdrawals">
            This browser kept two different signed withdrawals of {l.migration.conflicts.length === 1 ? "one key" : `${l.migration.conflicts.length} keys`}. Send one of
            them now (from &quot;Signed withdrawals in this browser&quot;): until one goes through, someone holding both could misuse that key.
          </Alert>
        ) : null}
        {l !== null && l.persisted === false ? (
          <Comment>This browser has not promised to keep these records when it runs low on space. Save them to a file now and then.</Comment>
        ) : null}
        <div className="pg-btns">
          <Button disabled={l === null || busy !== null} loading={busy === "export"} onClick={() => void doExport()}>
            Save my records to a file
          </Button>
          {file !== null ? (
            <a className="btn btn-primary btn-sm" download={file.name} href={file.href}>
              Download the file
            </a>
          ) : null}
        </div>
        {file !== null ? <p className="pg-small">{file.summary}</p> : null}
        {file?.warning ? <Alert tone="warn">{file.warning}</Alert> : null}
        {key.status !== "unlocked" ? <Comment>Unlock your quantum key to include (or bring in) the records of your launch signatures too.</Comment> : null}

        <Details summary="Bring in records from another device" boxed>
          <p className="pg-small">Choose the file saved on the other device, or paste its text. Every record is checked before anything is added; nothing here is removed.</p>
          <label className="label" htmlFor="key-records-file">
            Records file
          </label>
          <input
            id="key-records-file"
            type="file"
            accept="application/json,.json"
            className="input"
            disabled={l === null || busy !== null}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f !== undefined) void f.text().then(doImport, (err: unknown) => setError(errorMessage(err)));
            }}
          />
          <label htmlFor="key-records-text" className="label">
            Or paste it
          </label>
          <textarea id="key-records-text" className="textarea mono" rows={4} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <Button size="sm" disabled={l === null || busy !== null || text.trim() === ""} loading={busy === "import"} onClick={() => void doImport(text)}>
            Bring them in
          </Button>
        </Details>

        {report !== null ? <ImportResult report={report} /> : null}
        {error !== null ? <Alert tone="fail">{error}</Alert> : null}
      </div>
    </Panel>
  );
}

function ImportResult({ report }: { report: ImportReport }): ReactNode {
  const v = report.vault;
  const leafAdded = report.leaves.reduce((n, x) => n + x.added + x.merged, 0);
  const conflicts = v.conflicts.length + report.leaves.reduce((n, x) => n + x.conflicts.length, 0);
  const compromised = v.compromised.length + report.leaves.reduce((n, x) => n + x.compromised.length, 0);
  return (
    <div className="pg-stack-sm">
      <Alert tone="ok" title="Records brought in">
        {v.added + v.merged} vault key{v.added + v.merged === 1 ? "" : "s"} added ({v.unchanged} already known) and {leafAdded} launch signature{leafAdded === 1 ? "" : "s"}.
      </Alert>
      {v.unverifiable.length > 0 ? (
        <Alert tone="fail" title="That file is incomplete: withdrawals are paused here">
          The other device used {v.unverifiable.length} key{v.unverifiable.length === 1 ? "" : "s"} it could not include. Until you bring in a complete file
          (unlock the quantum key on that device, save the records again), this browser signs no withdrawals.
        </Alert>
      ) : null}
      {conflicts > 0 ? (
        <Alert tone="warn" title="Some keys were used differently on the two devices">
          {conflicts} one-time key{conflicts === 1 ? " was" : "s were"} set aside for different withdrawals or launches on each device. This browser now treats
          {conflicts === 1 ? " it" : " them"} as used.
        </Alert>
      ) : null}
      {compromised > 0 ? (
        <Alert tone="fail" title="A key signed two different things">
          {compromised} one-time key{compromised === 1 ? "" : "s"} signed two different messages, one on each device. Send one of the two withdrawals now (from
          "Signed withdrawals in this browser"): until one goes through, someone holding both could misuse that key.
        </Alert>
      ) : null}
      {report.leavesSkipped.length > 0 ? (
        <Alert tone="info">
          The file also holds launch records of {report.leavesSkipped.length === 1 ? "a key" : `${report.leavesSkipped.length} keys`} that {report.leavesSkipped.length === 1 ? "is" : "are"} not
          unlocked here. Unlock that quantum key and bring the file in again to add them.
        </Alert>
      ) : null}
    </div>
  );
}
