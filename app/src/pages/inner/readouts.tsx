/**
 * The verification report, the launch certificate and the parties a launch
 * still depends on, as glass cards. Same data and the same warnings as the
 * panels in components/verify.tsx.
 */
import type { ReactNode } from "react";

import { RefreshIcon } from "../../components/icons";
import { Address, Alert, Button, Skeleton } from "../../components/ui";
import { formatSolExact, formatUnits } from "../../lib/amounts";
import { CERTIFICATE_CHECK_LABELS, certificateCheckCount } from "../../lib/display";
import { formatTimestamp, shortKey, toHex } from "../../lib/format";
import { CERTIFICATE_RULES_BOUND, certificateChecksComplete, MIGRATION_FEE_TIERS_BPS, type CertificateAccount, type CheckStatus, type TrustedParty, type VerificationReport } from "../../lib/noised";
import { CheckLine, Checks, Chip, Details, Fold, Panel, Readout, Row, type KitTone } from "./kit";

/** "Verified" and friends, mirroring VerifyBadge. */
export function VerifyChip({ status, loading = false }: { status: CheckStatus | null; loading?: boolean }): ReactNode {
  if (loading && status === null) {
    return (
      <Chip tone="muted" pulse title="Re-checking this token against the chain">
        Verifying
      </Chip>
    );
  }
  if (status === "pass") return <Chip tone="ok" title="Every live check passed">Verified</Chip>;
  if (status === "warn") return <Chip tone="warn" title="Verified, with warnings about third parties">Verified, with warnings</Chip>;
  if (status === "fail") return <Chip tone="danger" title="A check failed">Failed verification</Chip>;
  return <Chip tone="muted">Not verified</Chip>;
}

const statusTone = (s: CheckStatus | null): KitTone => (s === "pass" ? "ok" : s === "warn" ? "warn" : s === "fail" ? "danger" : "muted");

/** The worst status of the report's checks with these ids ("none" when the report has none of them). */
function worstOf(report: VerificationReport, ids: readonly string[]): { status: "pass" | "warn" | "fail" | "none"; detail: string | null } {
  const found = report.checks.filter((c) => ids.includes(c.id));
  const bad = found.find((c) => c.status === "fail") ?? found.find((c) => c.status === "warn");
  if (bad !== undefined) return { status: bad.status, detail: bad.detail };
  return found.length === 0 ? { status: "none", detail: null } : { status: "pass", detail: null };
}

/**
 * The token's origin in three plain lines, from the live checks below: the creator's quantum signature
 * (`pq.origin`), the details stored on Solana (`metadata.onchain`), and the token matching them
 * (`metadata.match`, `metadata.icon`).
 */
export function OriginChecks({ report }: { report: VerificationReport }): ReactNode {
  const signed = worstOf(report, ["pq.origin"]);
  const stored = worstOf(report, ["metadata.onchain"]);
  const match = worstOf(report, ["metadata.match", "metadata.icon"]);
  return (
    <Checks label="Where this token comes from" className="pg-origin">
      <CheckLine i={0} status={signed.status} detail={signed.detail ?? "Its creator's quantum key signed the launch before it went live, and the signature was checked again just now."}>
        Signed with a quantum-safe key
      </CheckLine>
      <CheckLine i={1} status={stored.status} detail={stored.detail ?? "Its name, symbol, icon and description are kept on Solana itself, at an address nobody can change."}>
        Details stored on Solana
      </CheckLine>
      <CheckLine i={2} status={match.status} detail={match.detail ?? "The token carries exactly the name and symbol stored on Solana, and its icon is part of those details."}>
        Name, symbol and icon match
      </CheckLine>
    </Checks>
  );
}

/** Live verification: failing checks first (with details), then every passed check behind a fold. */
export function VerificationReadout({ report, loading, error, onRefresh }: { report: VerificationReport | undefined; loading: boolean; error: string | null; onRefresh: () => void }): ReactNode {
  const failing = report?.checks.filter((c) => c.status !== "pass") ?? [];
  const passed = report?.checks.filter((c) => c.status === "pass") ?? [];
  return (
    <Panel
      id="verification"
      title="Live checks"
      description="Checked against the chain just now, not taken from the certificate."
      status={
        <>
          <VerifyChip status={report?.overall ?? null} loading={loading} />
          <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading} aria-label="Run the checks again">
            <RefreshIcon />
            Check again
          </Button>
        </>
      }
      className="pg-verify"
    >
      <div className="pg-stack" aria-live="polite">
        {error ? <Alert tone="fail" title="Verification could not run">{error}</Alert> : null}
        {!report && !error ? (
          <div className="pg-stack-sm">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : null}
        {report ? (
          <>
            <p className="pg-verify-sum" data-tone={statusTone(report.overall)}>
              <span className="pg-num">{report.checks.length}</span> check{report.checks.length === 1 ? "" : "s"},{" "}
              {failing.length === 0 ? "all passed" : `${failing.length} need${failing.length === 1 ? "s" : ""} attention`}
            </p>
            {report.certificate !== null ? <OriginChecks report={report} /> : null}
            {report.overall === "fail" ? (
              <Alert tone="fail" title="Do not rely on this token">
                At least one check failed. A failed check means a guarantee Noised certifies does not hold for this mint, or the mint was not launched by
                Noised at all.
              </Alert>
            ) : null}
            {failing.length > 0 ? (
              <Checks label="Checks that need attention">
                {failing.map((c, i) => (
                  <CheckLine key={c.id} status={c.status} detail={c.detail} i={i}>
                    {c.label}
                  </CheckLine>
                ))}
              </Checks>
            ) : null}
            {passed.length > 0 ? (
              <Details summary={`Show the ${passed.length} passed check${passed.length === 1 ? "" : "s"}`}>
                <Checks label={`${passed.length} passed checks`}>
                  {passed.map((c, i) => (
                    <CheckLine
                      key={c.id}
                      status="pass"
                      i={i}
                      detail={
                        <>
                          {c.detail} <code className="pg-check-id">{c.id}</code>
                        </>
                      }
                    >
                      {c.label}
                    </CheckLine>
                  ))}
                </Checks>
              </Details>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/** The on-chain launch certificate (written once in the launch transaction). */
export function CertificateReadout({ certificate }: { certificate: CertificateAccount | null | undefined }): ReactNode {
  if (certificate === undefined) {
    return (
      <Panel title="Launch certificate">
        <Skeleton className="h-24 w-full" />
      </Panel>
    );
  }
  if (certificate === null) {
    return (
      <Panel title="Launch certificate" status={<Chip tone="danger">None</Chip>}>
        <Alert tone="fail" title="No certificate">
          The Noised launchpad never certified this mint.
        </Alert>
      </Panel>
    );
  }
  const c = certificate;
  const recipients = c.recipients.filter((r) => r.bps > 0);
  // The twelve required bits only: a certificate with launch rules also carries RULES_BOUND (8,191).
  const complete = certificateChecksComplete(c.checks);
  return (
    <Panel
      id="certificate"
      title="Launch certificate"
      description="Written once by the launchpad when the token launched. It can never be changed or closed."
      status={complete ? <Chip tone="ok">{`All ${certificateCheckCount()} checks`}</Chip> : <Chip tone="danger">Incomplete</Chip>}
    >
      <Checks label="Certified at launch" className="pg-cks-2">
        {CERTIFICATE_CHECK_LABELS.map((f, i) => (
          <CheckLine key={f.bit} status={(c.checks & f.bit) !== 0 ? "pass" : "fail"} i={i}>
            {f.label}
          </CheckLine>
        ))}
      </Checks>
      <Details summary="Certificate details">
        <Readout label="Certificate fields">
          <Row k="Certificate">
            <Address value={c.publicKey} explorer />
          </Row>
          <Row k="Launch">
            <Address value={c.launch} explorer />
          </Row>
          <Row k="DBC pool">
            <Address value={c.pool} explorer />
          </Row>
          <Row k="DBC config">
            <Address value={c.dbcConfig} explorer />
          </Row>
          <Row k="Creator">
            <Address value={c.creator} explorer /> <span className="pg-note">for information: no powers</span>
          </Row>
          <Row k="Launched">{formatTimestamp(c.launchedAt)}</Row>
          <Row k="Initial supply">
            {formatUnits(c.initialSupply, c.tokenDecimal, 0)} ({c.tokenDecimal} decimals)
          </Row>
          <Row k="Check flags" tone={complete ? "ok" : "danger"}>
            {c.checks} {complete ? `(all ${certificateCheckCount()}${(c.checks & CERTIFICATE_RULES_BOUND) !== 0 ? ", and the launch rules bound" : ""})` : "(incomplete)"}
          </Row>
          <Row k="Creator's quantum key" wide>
            <code className="pg-break">{toHex(c.pqIdentity)}</code> <span className="pg-note">signed with one-time key #{c.pqLeaf}, at slot {c.attestedSlot.toString()}</span>
          </Row>
          <Row k="Graduates at">{formatSolExact(c.migrationQuoteThreshold)} in the curve</Row>
          <Row k="DAMM v2 fee tier">
            {(MIGRATION_FEE_TIERS_BPS[c.migrationFeeOption] ?? 0) / 100}% (option {c.migrationFeeOption})
          </Row>
          <Row k="Snipe shield ends">{formatTimestamp(c.snipeShieldEndTs)}</Row>
          <Row k="Guard ends">{formatTimestamp(c.guardEndTs)}</Row>
          <Row k="Max wallet">{c.maxWallet === 0n ? "off" : `${formatUnits(c.maxWallet, c.tokenDecimal, 0)} tokens`}</Row>
          <Row k="Max buy">{c.maxBuy === 0n ? "off" : `${formatUnits(c.maxBuy, c.tokenDecimal, 0)} tokens per transfer`}</Row>
          <Row k="Wallet-to-wallet">{c.p2pLocked ? "paused during the guard" : "allowed"}</Row>
          <Row k="Platform fee share">{c.platformFeeBps / 100}% of trading fees</Row>
          <Row k="Fee recipients" wide>
            <ul className="pg-list-plain">
              {recipients.map((r) => (
                <li key={r.wallet.toBase58()}>
                  <Address value={r.wallet} explorer /> <span className="pg-note">{r.bps / 100}% of the creator share</span>
                </li>
              ))}
            </ul>
          </Row>
          <Row k="Parameters hash" wide>
            <code className="pg-break">{toHex(c.paramsHash)}</code>
          </Row>
          <Row k="Safety policy">version {c.policyVersion}</Row>
        </Readout>
      </Details>
    </Panel>
  );
}

const KIND_LABEL: Record<string, string> = {
  "upgrade-multisig": "upgrade multisig",
  operator: "operator",
  admin: "admin key",
  "upgrade-authority": "upgrade authority",
  validators: "validators",
  infrastructure: "infrastructure",
};

const RISKY_KINDS = new Set(["upgrade-multisig", "operator", "admin"]);

/** The parties a launch still depends on. */
export function TrustList({ parties, intro = true }: { parties: readonly TrustedParty[] | undefined; intro?: boolean }): ReactNode {
  return (
    <div className="pg-stack">
      <p className="pg-text">
        <strong>No key controls this launch, but these parties can still affect it.</strong>
        {intro
          ? " Noised holds every launch role through program addresses, so no private key controls the launch. Meteora's programs, their operators, Token-2022 and the validators sit underneath it and keep the powers listed here."
          : ""}
      </p>
      {parties === undefined ? <Skeleton className="h-24 w-full" /> : null}
      <ol className="pg-trust">
        {(parties ?? []).map((p) => (
          <li key={`${p.name}-${p.address?.toBase58() ?? "none"}`} className="pg-trust-item">
            <p className="pg-trust-name">
              <span>{p.name}</span>
              <Chip tone={RISKY_KINDS.has(p.kind) ? "warn" : "muted"} dot={false}>
                {KIND_LABEL[p.kind] ?? p.kind}
              </Chip>
            </p>
            {p.address ? (
              <div className="pg-trust-addr">
                <Address value={p.address} full explorer />
              </div>
            ) : null}
            <p className="pg-trust-note">{p.note}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Trust list in a fold. */
export function TrustFold({ parties, open }: { parties: readonly TrustedParty[] | undefined; open?: boolean }): ReactNode {
  return (
    <Fold label="Who you still trust" status={parties ? `${parties.length} parties` : undefined} open={open}>
      <TrustList parties={parties} />
    </Fold>
  );
}

/** "G2kw…3BYA" for headings. */
export const shortSubject = (s: string): string => shortKey(s, 4);
