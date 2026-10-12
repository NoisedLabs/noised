/**
 * Who the steps pay, checked on the chain (SDK 0.9.0 `checkGraphRecipients`, audit 4 C1 and M4), right in the editor:
 *   - a payee that could never receive its share (a quantum vault of another token, a token account or a mint, a
 *     program, an address nobody holds a key for) blocks publishing and signing;
 *   - a payee without a wSOL account yet is skipped when a payout runs: its share stays in the treasury until it opens
 *     one (nobody pays to open it for them);
 *   - anything else the check says is shown as a caution.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMemo, type ReactNode } from "react";

import { useAsync } from "../../app/hooks";
import { Alert } from "../../components/ui";
import { shortKey } from "../../lib/format";
import { checkGraphRecipients, type GraphRecipientsCheck } from "../../lib/noised";
import type { Graph } from "../../lib/programmable";
import { NoteBox } from "../inner/kit";

/** A payee line without its "recipients[i] (address): " label, as "Abcd…wxyz: reason". */
function plainLine(line: string): string {
  const m = /^recipients\[\d+\] \(([1-9A-HJ-NP-Za-km-z]{32,44})\): (.*)$/s.exec(line);
  if (m === null) return line;
  const reason = (m[2] ?? "").replace(/^./, (c) => c.toUpperCase());
  return `${shortKey(m[1] ?? "", 4)}: ${reason}`;
}

/** The chain's check of a graph's payees (null while it runs, or when the steps pay nobody). */
export function usePayeeCheck(graph: Graph | null): GraphRecipientsCheck | null {
  const { connection } = useConnection();
  const keys = useMemo(() => {
    const out: PublicKey[] = [];
    for (const r of graph?.recipients ?? []) {
      try {
        out.push(new PublicKey(r.address));
      } catch {
        return null; // an address still being typed: the editor says what is wrong with it
      }
    }
    return out;
  }, [graph]);
  const id = keys === null ? "" : keys.map((k) => k.toBase58()).join(",");
  const r = useAsync(async () => (keys === null || keys.length === 0 ? null : checkGraphRecipients(connection, keys)), [connection, id]);
  return keys === null || keys.length === 0 ? null : (r.data ?? null);
}

export function PayeeCheck({ check }: { check: GraphRecipientsCheck | null }): ReactNode {
  if (check === null) return null;
  const without = new Set(check.withoutAccount.map((k) => k.toBase58()));
  const others = check.warnings.filter((w) => !/has no wSOL account yet/.test(w));
  if (check.refusals.length === 0 && without.size === 0 && others.length === 0) return null;
  return (
    <div className="ap-payees" data-testid="payee-check">
      {check.refusals.length > 0 ? (
        <Alert tone="fail" title="A payee can never receive its share">
          <ul className="ap-payee-list">
            {check.refusals.map((r, i) => (
              <li key={i}>{plainLine(r)}</li>
            ))}
          </ul>
          <p>Change or remove it: nothing is published or signed while it is listed.</p>
        </Alert>
      ) : null}
      {without.size > 0 ? (
        <NoteBox tone="warn" title={`${without.size} payee${without.size === 1 ? " has" : "s have"} no wSOL account yet`}>
          <p>Until they open one, a payout skips them and their share stays in the treasury. Nobody pays to open it for them.</p>
          <ul className="ap-payee-list">
            {[...without].map((a) => (
              <li key={a}>
                <code className="pg-break">{a}</code>
              </li>
            ))}
          </ul>
        </NoteBox>
      ) : null}
      {others.length > 0 ? (
        <NoteBox title="Worth knowing about these payees">
          <ul className="ap-payee-list">
            {others.map((w, i) => (
              <li key={i}>{plainLine(w)}</li>
            ))}
          </ul>
        </NoteBox>
      ) : null}
    </div>
  );
}
