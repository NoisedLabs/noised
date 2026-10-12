/**
 * What the verification readouts say: every check id the SDK can report
 * has a short plain-English label (no fallback to the SDK's sentence), the
 * certificate's check count comes from the SDK's constant (never a number
 * written into the app), and every certificate flag has a plain label.
 */
import { CERTIFICATE_ALL_CHECKS, CERTIFICATE_CHECKS } from "@noisedlabs/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SHORT_CHECKS, shortCheck } from "../src/components/verifyLabels";
import { CERTIFICATE_CHECK_LABELS, certificateCheckCount } from "../src/lib/display";

const popcount = (v: number): number => v.toString(2).replaceAll("0", "").length;

describe("verification labels", () => {
  it("count the certificate's checks from the SDK's constant", () => {
    expect(certificateCheckCount()).toBe(popcount(CERTIFICATE_ALL_CHECKS));
    expect(SHORT_CHECKS["certificate.checks"]).toEqual(["launch-time checks", `${popcount(CERTIFICATE_ALL_CHECKS)}/${popcount(CERTIFICATE_ALL_CHECKS)}`]);
    // No page writes the count itself.
    for (const file of ["../src/components/verify.tsx", "../src/pages/inner/readouts.tsx", "../src/components/verifyLabels.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/\b(?:All|all) (?:eleven|twelve|11|12) checks\b|\b(?:11|12)\/(?:11|12)\b/);
    }
  });

  it("name every check of the PQ v2 report in plain words: the quantum signature, the on-chain details, the pool fee, the RPC clock", () => {
    for (const id of ["pq.origin", "damm.fee", "rpc.clock", "certificate.bit1024", "certificate.bit2048", "metadata.onchain", "metadata.match", "metadata.icon"]) expect(SHORT_CHECKS[id], id).toBeDefined();
    // SDK 0.4.0 no longer reports an off-chain document check.
    expect(SHORT_CHECKS["pq.metadataJson"]).toBeUndefined();
    expect(shortCheck({ id: "metadata.onchain", label: "Metadata stored on-chain", status: "pass", detail: "" }, null)).toEqual(["token details", "on-chain"]);
    expect(shortCheck({ id: "metadata.onchain", label: "Metadata stored on-chain", status: "warn", detail: "" }, null)).toEqual(["token details", "WARNING"]);
    expect(shortCheck({ id: "pq.origin", label: "Post-quantum origin: …", status: "pass", detail: "" }, null)).toEqual(["quantum signature", "checked"]);
    expect(shortCheck({ id: "rpc.clock", label: "The RPC's clock", status: "warn", detail: "" }, null)).toEqual(["rpc clock", "WARNING"]);
    expect(shortCheck({ id: "damm.fee", label: "x", status: "fail", detail: "" }, null)).toEqual(["pool fee tier", "FAILED"]);
  });

  it("give every certificate flag the SDK knows a plain label", () => {
    const flags = Object.entries(CERTIFICATE_CHECKS as Readonly<Record<string, number>>);
    expect(CERTIFICATE_CHECK_LABELS).toHaveLength(flags.length);
    for (const [name, bit] of flags) {
      // The fallback for a flag the app does not know is its constant name spelled out ("Pq attested").
      const fallback = `${name.charAt(0)}${name.slice(1).toLowerCase().replaceAll("_", " ")}`;
      expect(CERTIFICATE_CHECK_LABELS.find((c) => c.bit === bit)?.label).not.toBe(fallback);
    }
    expect(CERTIFICATE_CHECK_LABELS.find((c) => c.bit === CERTIFICATE_CHECKS.PQ_ATTESTED)?.label).toBe("The creator's quantum-safe key signed the launch");
  });
});
