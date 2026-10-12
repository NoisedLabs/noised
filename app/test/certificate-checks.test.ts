/**
 * Review 4 (R4): every client test of a certificate's `checks` is
 * `(checks & 4095) === 4095` (the SDK's `certificateChecksComplete`), never
 * `checks === 4095`: a launch with creator rules also carries the
 * informational RULES_BOUND bit (4,096), so its certificate holds 8,191 and is
 * complete. Covered: the simulated chain's verification report, both
 * certificate readouts, and a scan of the app's sources for the old equality.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { CertificatePanel } from "../src/components/verify";
import { backend as mock } from "../src/lib/backend/mock";
import { seedState } from "../src/lib/mock/fixtures";
import { replaceStateForTests } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";
import { CertificateReadout } from "../src/pages/inner/readouts";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

beforeEach(() => {
  replaceStateForTests(seedState());
});

describe("certificate checks (review 4, R4)", () => {
  it("the SDK's helper accepts the rules-bound value and nothing missing a required bit", () => {
    expect(phx.CERTIFICATE_ALL_CHECKS).toBe(4095);
    expect(phx.CERTIFICATE_RULES_BOUND).toBe(4096);
    expect(phx.certificateChecksComplete(4095)).toBe(true);
    expect(phx.certificateChecksComplete(8191)).toBe(true);
    expect(phx.certificateChecksComplete(4095 & ~1024)).toBe(false);
    expect(phx.certificateChecksComplete(8191 & ~2048)).toBe(false);
  });

  it("a launch with signed rules has checks = 8191 and the report passes every certificate check", async () => {
    const aegis = await launchBySymbol("AEGS");
    const report = await phx.verifyLaunch(conn, aegis.baseMint);
    expect(report.certificate?.checks).toBe(8191);
    const all = report.checks.find((c) => c.id === "certificate.checks");
    expect(all?.status).toBe("pass");
    expect(all?.detail).toMatch(/^checks = 8191: /);
    expect(all?.detail).toMatch(/RULES_BOUND \(4096\)/);
    expect(report.checks.filter((c) => c.id.startsWith("certificate.") && c.status !== "pass").map((c) => c.id)).toEqual([]);
  });

  it("a launch without rules keeps checks = 4095 and passes too", async () => {
    const lantern = (await phx.listLaunches(conn)).find((l) => l.market !== null && l.market !== undefined && l.market.symbol !== "AEGS");
    if (!lantern) throw new Error("no fixture");
    const report = await phx.verifyLaunch(conn, lantern.baseMint);
    if (report.certificate === null) return;
    expect(phx.certificateChecksComplete(report.certificate.checks)).toBe(true);
    expect(report.checks.find((c) => c.id === "certificate.checks")?.status).toBe("pass");
  });

  it("both certificate readouts call 8191 complete and a missing bit incomplete", async () => {
    const aegis = await launchBySymbol("AEGS");
    const cert = (await phx.verifyLaunch(conn, aegis.baseMint)).certificate;
    if (cert === null) throw new Error("no certificate");
    expect(cert.checks).toBe(8191);
    const html = (c: T.CertificateAccount): string[] => [
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CertificateReadout, { certificate: c }))),
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CertificatePanel, { certificate: c }))),
    ];
    const [inner, terminal] = html(cert);
    expect(inner).toContain("All 12 checks");
    expect(inner).toContain("8191 (all 12, and the launch rules bound)");
    expect(inner).not.toMatch(/Incomplete|\(incomplete\)/);
    expect(terminal).toMatch(/all 12\s*\+ rules bound/);
    expect(terminal).not.toContain("incomplete");
    const [innerBad, terminalBad] = html({ ...cert, checks: 8191 & ~1024 });
    expect(innerBad).toContain("Incomplete");
    expect(terminalBad).toContain("incomplete");
  });

  it("no app source compares checks with === 4095 / CERTIFICATE_ALL_CHECKS", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "generated") walk(p);
        } else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const bad = files.filter((f) => /checks\s*[!=]==?\s*(CERTIFICATE_ALL_CHECKS|4095)\b|(CERTIFICATE_ALL_CHECKS|4095)\s*[!=]==?\s*[\w.]*checks\b/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
