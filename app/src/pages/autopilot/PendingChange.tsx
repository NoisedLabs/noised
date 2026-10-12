/**
 * A scheduled change (the 72-hour wait), in plain words (review U2): the
 * steps that will run once it takes effect, what changes compared with the
 * running ones (new, changed or removed steps, who gets paid, the operator),
 * and a countdown. The whole point of the wait is that holders can read the
 * change, so it is never shown as only a fingerprint.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useMemo, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { Countdown } from "../../components/ui";
import { When } from "../../components/When";
import { toHex } from "../../lib/format";
import { fetchGraphBytes, type AutopilotInfo, type LaunchAccount } from "../../lib/noised";
import { explainGraphLines, graphChanges, graphFromBytes, graphHashOf, type Graph } from "../../lib/programmable";
import { Details, NoteBox } from "../inner/kit";

export function PendingChange({ launch, info, running, compact = false }: { launch: LaunchAccount; info: AutopilotInfo; running: Graph | null; compact?: boolean }): ReactNode {
  const { connection } = useConnection();
  const pending = info.pending;
  const hex = pending ? toHex(pending.graphHash) : null;
  const loaded = useAsync(async () => (pending ? { hex: toHex(pending.graphHash), bytes: await fetchGraphBytes(connection, launch.publicKey, pending.graphHash) } : null), [connection, launch.publicKey.toBase58(), hex]);
  // Only the bytes of exactly the queued hash (never an older result kept while this one loads).
  const bytes = loaded.data && loaded.data.hex === hex && loaded.data.bytes !== null && toHex(graphHashOf(loaded.data.bytes)) === hex ? loaded.data.bytes : null;
  const next = useMemo(() => (bytes ? graphFromBytes(bytes, launch.tokenDecimal) : null), [bytes, launch.tokenDecimal]);
  const changes = useMemo(() => (next ? graphChanges(running, next) : []), [running, next]);
  if (!pending || info.frozen) return null;
  const operatorNote = pending.operator !== null ? `The operator ${pending.operator.toBase58()} gets control of its operator steps.` : null;
  return (
    <NoteBox tone="warn" title={running === null ? "Switching on soon" : "A change is coming"} className="ap-pending" live>
      <p className="ap-pending-when">
        {running === null ? "These steps start" : "These steps replace the running ones"}{" "}
        <strong>
          <Countdown to={pending.activateAt} prefix="in " done="now" />
        </strong>
        , on <When t={pending.activateAt} />. {running === null ? "" : "Until then the current steps keep running. Holders who disagree have until then."}
      </p>
      {next === null ? (
        <p className="ap-muted">{loaded.data === undefined ? "Reading the new steps…" : "The new steps could not be read from Solana."}</p>
      ) : (
        <>
          {changes.length > 0 && running !== null ? (
            <ul className="ap-changes" aria-label="What changes">
              {changes.map((c, i) => (
                <li key={i} data-kind={c.kind}>
                  {c.text}
                </li>
              ))}
            </ul>
          ) : null}
          {compact && running !== null ? (
            <Details summary="All the new steps">
              <ol className="rl-plain">
                {explainGraphLines(next).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
            </Details>
          ) : (
            <ol className="rl-plain" aria-label="The new steps">
              {explainGraphLines(next).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          )}
          {operatorNote !== null ? <p className="ap-muted">{operatorNote}</p> : null}
        </>
      )}
    </NoteBox>
  );
}
