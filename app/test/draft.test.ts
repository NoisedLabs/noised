/** The Create wizard's draft converts exactly into LaunchParams and routes policy errors to fields. */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { convertDraft, draftFromPreset, priceString, splitError, stepOfField, type Draft } from "../src/pages/create/draft";
import { FIELD_DOCS } from "../src/pages/create/fieldDocs";
import { PRESETS, tokenUri, validateLaunchParams, validateTokenMeta, type PresetName } from "../src/lib/noised";

const wallet = Keypair.generate().publicKey.toBase58();
const ready = (name: PresetName): Draft => ({ ...draftFromPreset(name), name: "Aegis", symbol: "AEGS", recipients: [{ wallet, pct: "100" }] });
/** The creator's quantum key identity id (lib/pqKey.ts derives it; any 32 non-zero bytes here). */
const identity = new Uint8Array(32).fill(9);

describe("draft <-> LaunchParams", () => {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    it(`the ${name} preset converts back to exactly its parameters`, () => {
      const conv = convertDraft(ready(name), identity);
      expect(conv.inputErrors).toEqual({});
      expect(conv.policyErrors).toEqual([]);
      const p = conv.params;
      if (!p) throw new Error("no params");
      expect(p.pqIdentity).toEqual(identity);
      const { recipients: _r, pqIdentity: _q, ...onChain } = p;
      expect(onChain).toEqual(PRESETS[name].params);
      expect(validateLaunchParams(p).ok).toBe(true);
      // The name and symbol go to the token's metadata record (no uri mode: the mint's link stays empty).
      expect(conv.metadata).toEqual({ name: "Aegis", symbol: "AEGS" });
      expect(validateTokenMeta(conv.metadata).ok).toBe(true);
      expect(tokenUri(conv.metadata)).toBe("");
    });
  }

  it("formats prices without exponents", () => {
    expect(priceString(3e-8)).toBe("0.00000003");
    expect(priceString(2.9999999e-8)).toBe("0.00000003");
    expect(priceString(150)).toBe("150");
    expect(priceString(1_500_000)).toBe("1500000");
  });

  it("asks for the quantum key when no identity is given, on the quantum key step", () => {
    const conv = convertDraft(ready("fair"));
    expect(conv.inputErrors).toEqual({ pqIdentity: expect.stringMatching(/Unlock your quantum key/) });
    expect(stepOfField("pqIdentity")).toBe("key");
    // The document's parts are the token's, on the first step.
    for (const f of ["description", "website", "x", "icon"]) expect(stepOfField(f), f).toBe("token");
  });

  it("reports typed garbage as input errors under the validator's field names", () => {
    const conv = convertDraft({ ...ready("fair"), thresholdSol: "abc", maxWalletPct: "1.234", recipients: [{ wallet: "nope", pct: "100" }] }, identity);
    expect(Object.keys(conv.inputErrors).sort()).toEqual(["maxWalletBps", "migrationQuoteThreshold", "recipients[0].wallet"]);
  });

  it("surfaces policy errors as 'fieldName: message' and maps them to wizard steps", () => {
    const conv = convertDraft({ ...ready("fair"), openDelaySecs: "5", guardSecs: "20", symbol: "", feePeriods: "3" }, identity);
    const fields = conv.policyErrors.map((e) => splitError(e).field);
    expect(fields).toEqual(expect.arrayContaining(["openDelaySecs", "symbol", "baseFee"]));
    for (const e of conv.policyErrors) expect(e).toMatch(/^[A-Za-z][\w.[\]]*: \S/);
    expect(stepOfField("symbol")).toBe("token");
    expect(stepOfField("curve[1].liquidity")).toBe("curve");
    expect(stepOfField("dynamicFee.filterPeriod")).toBe("fees");
    expect(stepOfField("guardSecs")).toBe("guard");
    expect(stepOfField("recipients[2].bps")).toBe("recipients");
  });

  it("checks the name and symbol as the metadata record needs them, in the wizard's words", () => {
    const errorsOf = (patch: Partial<Draft>): string[] => convertDraft({ ...ready("fair"), ...patch }, identity).policyErrors;
    expect(errorsOf({ name: "", symbol: "" })).toEqual(["name: is required", "symbol: is required"]);
    expect(errorsOf({ name: "x".repeat(33) })).toEqual(["name: must be at most 32 bytes of UTF-8 (is 33)"]);
    // Bytes, not characters: 16 two-byte letters fit, 17 do not.
    expect(errorsOf({ name: "é".repeat(16) })).toEqual([]);
    expect(errorsOf({ name: "é".repeat(17) })).toEqual(["name: must be at most 32 bytes of UTF-8 (is 34)"]);
    expect(errorsOf({ symbol: "ABCDEFGHIJK" })).toEqual(["symbol: must be at most 10 bytes of UTF-8 (is 11)"]);
    // What the record cannot hold is reported even within the limits (a lone UTF-16 surrogate is not text).
    expect(errorsOf({ name: "a\uD800" })).toEqual([expect.stringMatching(/^name: .*surrogate/)]);
  });

  it("documents every LaunchParams field", () => {
    const fields = Object.keys(PRESETS.fair.params);
    for (const f of [...fields, "recipients", "name", "symbol", "uri"]) expect(FIELD_DOCS[f], f).toBeDefined();
  });
});
