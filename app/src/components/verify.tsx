/** Verification report, certificate and trust panels, as terminal readouts. */
import type { ReactNode } from "react";

import { formatSolExact, formatUnits } from "../lib/amounts";
import { CERTIFICATE_CHECK_LABELS, certificateCheckCount } from "../lib/display";
import { formatTimestamp, toHex } from "../lib/format";
import { CERTIFICATE_RULES_BOUND, certificateChecksComplete, MIGRATION_FEE_TIERS_BPS, type CertificateAccount, type CheckStatus, type TrustedParty, type VerificationCheck, type VerificationReport } from "../lib/noised";
import { RefreshIcon } from "./icons";
import { VerifyBadge } from "./launch";
import { Address, Alert, Button, Card, Skeleton } from "./ui";

import "./landing/tokens.css";
import "./landing/board.css";

const MARK: Record<CheckStatus, string> = { pass: "[✓]", warn: "[!]", fail: "[×]" };
const SAY: Record<CheckStatus, string> = { pass: "passed", warn: "warning", fail: "failed" };

/** One check: `[✓] label` with its detail one click away (open by default when it needs attention). */
function CheckLine({ check }: { check: VerificationCheck }): ReactNode {
  return (
    <li>
      <details className="ld-check" data-status={check.status} open={check.status !== "pass"}>
        <summary>
          <span className="ld-check-mark" aria-hidden="true">
            {MARK[check.status]}
          </span>
          <span className="ld-check-label">
            <span className="sr-only">{SAY[check.status]}: </span>
            {check.label}
          </span>
          <span className="ld-check-more" aria-hidden="true">
            DETAIL
          </span>
        </summary>
        <div className="ld-check-detail">
          {check.detail}
          <span className="ld-check-id">
            check id <code>{check.id}</code>
          </span>
        </div>
      </details>
    </li>
  );
}

export function VerificationPanel({
  report,
  loading,
  error,
  onRefresh,
}: {
  report: VerificationReport | undefined;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): ReactNode {
  const failing = report?.checks.filter((c) => c.status !== "pass") ?? [];
  const passed = report?.checks.filter((c) => c.status === "pass") ?? [];
  return (
    <Card
      id="verification"
      title="Live verification"
      subtitle="Re-checked from chain state now, not taken from the certificate."
      actions={
        <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading} aria-label="Run verification again">
          <RefreshIcon />
          Re-verify
        </Button>
      }
    >
      {error ? <Alert tone="fail" title="Verification could not run">{error}</Alert> : null}
      {!report && !error ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : null}
      {report ? (
        <div className="space-y-4">
          <div>
            <div className="ld-vsum">
              <VerifyBadge status={report.overall} />
              <span className="ld-vsum-text">
                {report.checks.length} checks, {failing.length === 0 ? "all passed" : `${failing.length} need attention`}
              </span>
            </div>
            <div className="ld-vmeter" aria-hidden="true">
              {report.checks.map((c) => (
                <i key={c.id} data-s={c.status} />
              ))}
            </div>
          </div>
          {report.overall === "fail" ? (
            <Alert tone="fail" title="Do not rely on this token">
              At least one check failed. A failed check means a guarantee Noised certifies does not hold for this mint, or the mint was not launched
              by Noised at all.
            </Alert>
          ) : null}
          {failing.length > 0 ? (
            <ul className="ld-readout" aria-label="Checks that need attention">
              {failing.map((c) => (
                <CheckLine key={c.id} check={c} />
              ))}
            </ul>
          ) : null}
          <details className="ld-passed">
            <summary>
              <span>
                <span aria-hidden="true">[✓] </span>
                {passed.length} passed checks
              </span>
              <span aria-hidden="true">[+]</span>
            </summary>
            <ul className="ld-readout">
              {passed.map((c) => (
                <CheckLine key={c.id} check={c} />
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </Card>
  );
}

export function CertificatePanel({ certificate }: { certificate: CertificateAccount | null | undefined }): ReactNode {
  if (certificate === undefined) {
    return (
      <Card title="Launch certificate">
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (certificate === null) {
    return (
      <Card title="Launch certificate">
        <Alert tone="fail" title="No certificate">
          The Noised launchpad never certified this mint.
        </Alert>
      </Card>
    );
  }
  const c = certificate;
  const recipients = c.recipients.filter((r) => r.bps > 0);
  return (
    <Card id="certificate" title="Launch certificate" subtitle="Written once by the launchpad in the launch transaction; never modified or closed.">
      <ul className="ld-cert-flags">
        {CERTIFICATE_CHECK_LABELS.map((f) => {
          const ok = (c.checks & f.bit) !== 0;
          return (
            <li key={f.bit} data-ok={ok}>
              <span aria-hidden="true">{ok ? "[✓]" : "[×]"}</span>
              <span>
                <span className="sr-only">{ok ? "recorded: " : "missing: "}</span>
                {f.label}
              </span>
            </li>
          );
        })}
      </ul>
      <dl className="ld-kv">
        <dt>Certificate</dt>
        <dd>
          <Address value={c.publicKey} explorer />
        </dd>
        <dt>Launch</dt>
        <dd>
          <Address value={c.launch} explorer />
        </dd>
        <dt>DBC pool</dt>
        <dd>
          <Address value={c.pool} explorer />
        </dd>
        <dt>DBC config</dt>
        <dd>
          <Address value={c.dbcConfig} explorer />
        </dd>
        <dt>Creator</dt>
        <dd>
          <Address value={c.creator} explorer /> <span className="ld-kv-note">informational: no powers</span>
        </dd>
        <dt>Launched</dt>
        <dd>{formatTimestamp(c.launchedAt)}</dd>
        <dt>Initial supply</dt>
        <dd className="tabular-nums">
          {formatUnits(c.initialSupply, c.tokenDecimal, 0)} ({c.tokenDecimal} decimals)
        </dd>
        <dt>Check flags</dt>
        <dd className="tabular-nums">
          {c.checks}{" "}
          {certificateChecksComplete(c.checks) ? (
            <span className="ld-tag" data-tone="phosphor">
              all {certificateCheckCount()}
              {(c.checks & CERTIFICATE_RULES_BOUND) !== 0 ? " + rules bound" : ""}
            </span>
          ) : (
            <span className="ld-tag" data-tone="danger">
              incomplete
            </span>
          )}
        </dd>
        <dt>Graduates at</dt>
        <dd className="tabular-nums">{formatSolExact(c.migrationQuoteThreshold)} in the curve</dd>
        <dt>DAMM v2 fee tier</dt>
        <dd>
          {(MIGRATION_FEE_TIERS_BPS[c.migrationFeeOption] ?? 0) / 100}% (option {c.migrationFeeOption})
        </dd>
        <dt>Snipe shield ends</dt>
        <dd>{formatTimestamp(c.snipeShieldEndTs)}</dd>
        <dt>Guard ends</dt>
        <dd>{formatTimestamp(c.guardEndTs)}</dd>
        <dt>Max wallet</dt>
        <dd className="tabular-nums">{c.maxWallet === 0n ? "off" : `${formatUnits(c.maxWallet, c.tokenDecimal, 0)} tokens`}</dd>
        <dt>Max buy</dt>
        <dd className="tabular-nums">{c.maxBuy === 0n ? "off" : `${formatUnits(c.maxBuy, c.tokenDecimal, 0)} tokens per transfer`}</dd>
        <dt>Wallet-to-wallet</dt>
        <dd>{c.p2pLocked ? "paused during the guard" : "allowed"}</dd>
        <dt>Platform fee share</dt>
        <dd>{c.platformFeeBps / 100}% of trading fees</dd>
        <dt>Fee recipients</dt>
        <dd>
          <ul className="space-y-1">
            {recipients.map((r) => (
              <li key={r.wallet.toBase58()} className="flex flex-wrap items-center gap-2">
                <Address value={r.wallet} explorer />
                <span className="ld-kv-note">{r.bps / 100}% of the creator share</span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Params hash</dt>
        <dd>
          <code className="text-xs break-all">{toHex(c.paramsHash)}</code>
        </dd>
        <dt>Safety policy</dt>
        <dd>version {c.policyVersion}</dd>
      </dl>
    </Card>
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

export function TrustPanel({ parties, intro = true }: { parties: readonly TrustedParty[] | undefined; intro?: boolean }): ReactNode {
  return (
    <Card id="trust" title="Who you still trust" subtitle="No key controls this launch, but these parties can still affect it.">
      {intro ? (
        <p className="ld-trust-intro">
          Noised holds every launch role through program addresses, so no private key controls the launch. Meteora's programs, their operators,
          Token-2022 and the validators sit underneath it and keep the powers listed here.
        </p>
      ) : null}
      {parties === undefined ? <Skeleton className="h-24 w-full" /> : null}
      <ul className="ld-trust">
        {(parties ?? []).map((p) => (
          <li key={`${p.name}-${p.address?.toBase58() ?? "none"}`}>
            <div className="ld-trust-head">
              <span className="ld-trust-name">{p.name}</span>
              <span className="ld-tag" data-tone={p.kind === "upgrade-multisig" || p.kind === "operator" || p.kind === "admin" ? "amber" : "dim"}>
                {KIND_LABEL[p.kind] ?? p.kind}
              </span>
            </div>
            {p.address ? (
              <div className="mt-2">
                <Address value={p.address} full explorer />
              </div>
            ) : null}
            <p className="ld-trust-note">{p.note}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
