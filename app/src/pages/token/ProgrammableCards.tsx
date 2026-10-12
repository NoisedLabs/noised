/**
 * The token page's "Launch rules" and "Autopilot" cards (PROGRAMMABLE_V1 §6):
 * what each says in plain English, decoded from the bytes on Solana, every
 * address in full, and the lines anyone can check (the creator's quantum
 * signature binds exactly the rules shown; the running autopilot matches its
 * published steps; a scheduled change is spelled out, not just counted down).
 * Where rules and Autopilot are not live yet they say "coming soon".
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";

import { useAsync } from "../../app/hooks";
import { Countdown } from "../../components/ui";
import { formatSol } from "../../lib/amounts";
import { describeSeconds, formatTimestamp, toHex } from "../../lib/format";
import { fetchAutopilot, fetchGraphBytes, fetchLaunchRules, PROGRAMMABLE_AVAILABLE, type LaunchAccount } from "../../lib/noised";
import { explainGraphLines, explainRulesBytes, graphFromBytes, graphHashOf, KNOWN_APPS, ruleKeysOfBytes, rulesHashOf } from "../../lib/programmable";
import { CheckLine, Checks, Chip, Panel } from "../inner/kit";
import { PendingChange } from "../autopilot/PendingChange";
import "../create/rules/rules.css";
import "../autopilot/autopilot-page.css";

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function LaunchRulesCard({ launch, now }: { launch: LaunchAccount; now: number }): ReactNode {
  const { connection } = useConnection();
  const r = useAsync(() => fetchLaunchRules(connection, launch.publicKey), [connection, launch.publicKey.toBase58()], { enabled: PROGRAMMABLE_AVAILABLE });
  const info = r.data;
  const rec = info?.record ?? null;
  // One line per rule; the guarantees are the checks below (selling, the end of the rules, the vault and the Shield).
  const lines = useMemo(() => (rec ? explainRulesBytes(rec.bytes, info?.guardSecs ?? launch.guardSecs, launch.tokenDecimal, false) : []), [rec, info?.guardSecs, launch.guardSecs, launch.tokenDecimal]);
  const keys = useMemo(() => (rec ? ruleKeysOfBytes(rec.bytes, info?.guardSecs ?? launch.guardSecs) : []), [rec, info?.guardSecs, launch.guardSecs]);
  if (!PROGRAMMABLE_AVAILABLE) {
    return <Panel title="Launch rules" status={<Chip tone="muted">Early limits only</Chip>} description="This launch uses the standard early limits. Extra launch rules are coming soon on this network." />;
  }
  if (r.error) return <Panel title="Launch rules" description={`Could not read the rules: ${r.error}`} />;
  if (!info) return <Panel title="Launch rules" description="Reading the rules…" />;
  const attested = info.attestedHash;
  const guardEnd = info.openedAt !== null ? info.openedAt + info.guardSecs : null;
  const on = guardEnd !== null && now < guardEnd;
  const none = attested !== null && isZero(attested);
  // The record is only ever the one the attestation names (review U7): no rules are shown that nobody signed.
  const tone = attested === null || none ? "muted" : info.bound ? (on ? "warn" : "ok") : "danger";
  const chip = attested === null ? "Not signed yet" : none ? "None" : !info.bound ? "Missing" : on ? "In force" : "Ended";
  const ruleLines = rec && info.bound ? lines : [];
  return (
    <Panel
      title="Launch rules"
      status={
        <Chip tone={tone} pulse={on && info.bound}>
          {chip}
        </Chip>
      }
      description={
        none
          ? "No extra rules: only the standard early limits apply."
          : attested === null
            ? "The creator's quantum key has not signed this launch yet, so its rules are not final."
            : !info.bound
              ? "The rules the creator signed are not on Solana, so this launch can't open."
              : on
                ? `Extra rules apply until the early limits end, ${guardEnd !== null ? formatTimestamp(guardEnd) : ""}. Selling always works.`
                : guardEnd === null
                  ? "Extra rules apply from the launch until the early limits end. Selling always works."
                  : "The early limits have ended: no rule applies any more, exactly as if there were none."
      }
    >
      {ruleLines.length > 0 ? (
        <ol className="rl-plain">
          {ruleLines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      ) : null}
      {info.bound && keys.length > 0 ? (
        <div className="rl-keys-list">
          <p className="pg-label">Wallets and apps they name</p>
          <ul>
            {keys.map((k) => (
              <li key={k}>
                {KNOWN_APPS[k] !== undefined ? <span className="rl-key-name">{KNOWN_APPS[k]}</span> : null} <code className="pg-break">{k}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Checks label="Launch rules checks">
        {attested !== null && !none ? (
          <CheckLine status={info.bound ? "pass" : "fail"} i={0} detail={<code className="pg-break">{toHex(attested)}</code>}>
            {info.bound ? "The creator's quantum key signed exactly these rules" : "The signed rules are not published"}
          </CheckLine>
        ) : null}
        {rec && info.bound ? (
          <CheckLine status={same(rulesHashOf(rec.bytes), rec.hash) ? "pass" : "fail"} i={1} detail={`${rec.bytes.length} bytes, published ${formatTimestamp(rec.publishedAt)}`}>
            Stored on Solana and checked by the program
          </CheckLine>
        ) : null}
        <CheckLine status="pass" i={2}>
          Selling is always allowed
        </CheckLine>
        <CheckLine status="pass" i={3} detail={guardEnd !== null ? on ? <Countdown to={guardEnd} prefix="ends in " /> : `ended ${formatTimestamp(guardEnd)}` : `${describeSeconds(info.guardSecs)} after launch`}>
          Every rule ends with the early limits (at most 72 hours)
        </CheckLine>
        {!none && attested !== null ? (
          <CheckLine status="pass" i={4}>
            Rules never block what a holder&apos;s quantum vault or the Shield moves
          </CheckLine>
        ) : null}
      </Checks>
    </Panel>
  );
}

export function AutopilotCard({ launch }: { launch: LaunchAccount }): ReactNode {
  const { connection } = useConnection();
  const lk = launch.publicKey.toBase58();
  const ap = useAsync(() => fetchAutopilot(connection, launch.publicKey), [connection, lk], { enabled: PROGRAMMABLE_AVAILABLE });
  const info = ap.data ?? null;
  const hash = info?.graphHash ?? null;
  const hex = hash ? toHex(hash) : null;
  // The bytes come with the hash they were read for (useAsync keeps a previous result while it reloads).
  const loaded = useAsync(async () => (hash ? { hex: toHex(hash), bytes: await fetchGraphBytes(connection, launch.publicKey, hash) } : null), [connection, lk, hex], { enabled: PROGRAMMABLE_AVAILABLE });
  const bytes = loaded.data && loaded.data.hex === hex ? loaded.data.bytes : null;
  const graph = useMemo(() => (bytes ? graphFromBytes(bytes, launch.tokenDecimal) : null), [bytes, launch.tokenDecimal]);
  const symbol = launch.market?.symbol ?? "TOKEN";
  const to = `/token/${(launch.status === "live" ? launch.baseMint : launch.publicKey).toBase58()}/autopilot`;
  const link = (
    <Link to={to} className="btn btn-secondary btn-sm ap-card-link">
      {!PROGRAMMABLE_AVAILABLE ? "See what it will do" : info === null ? "Set up Autopilot" : "Open Autopilot"} <span aria-hidden="true">→</span>
    </Link>
  );
  if (!PROGRAMMABLE_AVAILABLE) {
    return (
      <Panel title="Autopilot" status={<Chip tone="muted">Coming soon</Chip>} description="Automatic buybacks, burns and payouts from a token's treasury, signed by its creator's quantum key. Coming soon on this network.">
        {link}
      </Panel>
    );
  }
  if (ap.error) return <Panel title="Autopilot" description={`Could not read the autopilot: ${ap.error}`} />;
  if (ap.data === undefined) return <Panel title="Autopilot" description="Reading the autopilot…" />;
  if (info === null) {
    return (
      <Panel title="Autopilot" status={<Chip tone="muted">Off</Chip>} description={`${symbol} has no autopilot. Its creator can set up automatic buybacks, burns and payouts from a treasury, signed with their quantum key.`}>
        {link}
      </Panel>
    );
  }
  const status = info.frozen ? "Frozen forever" : info.pending ? (hash ? "Change scheduled" : "Starting soon") : hash ? "Running" : "Off";
  const lines = graph ? explainGraphLines(graph, false) : [];
  return (
    <Panel
      title="Autopilot"
      status={
        <Chip tone={info.frozen ? "ok" : info.pending ? "warn" : hash ? "ok" : "muted"} pulse={status === "Running"}>
          {status}
        </Chip>
      }
      description={`Treasury ${formatSol(info.treasurySol, 3)} · ${(Number(info.totalBurned) / 10 ** launch.tokenDecimal).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })} ${symbol} burned so far.`}
    >
      {lines.length > 0 ? (
        <ol className="rl-plain">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      ) : null}
      {info.pending && !info.frozen ? <PendingChange launch={launch} info={info} running={graph} compact /> : null}
      <Checks label="Autopilot checks">
        {hash && bytes ? (
          <CheckLine status={same(graphHashOf(bytes), hash) ? "pass" : "fail"} i={0} detail={<code className="pg-break">{toHex(hash)}</code>}>
            The running steps match their published fingerprint
          </CheckLine>
        ) : null}
        <CheckLine status="pass" i={1}>
          It can never sell {symbol}, pull liquidity or mint
        </CheckLine>
        <CheckLine status="pass" i={2}>
          It pays only listed recipients and a small tip to whoever runs a step
        </CheckLine>
        <CheckLine status={info.frozen ? "pass" : "none"} i={3} detail={info.frozen ? "nobody can change it" : "a change needs the creator's quantum key and waits 72 hours"}>
          {info.frozen ? "Frozen forever" : "Changes wait 72 hours in public"}
        </CheckLine>
      </Checks>
      {link}
    </Panel>
  );
}
