/**
 * The whitepaper's figures are computed from code (src/pages/whitepaper/model). These tests pin that code to the
 * protocol: the LM-OTS parameter derivation and its exact distributions, the dominance lemma, the live demo
 * signature, the bonding-curve mirror against the SDK's presets, the fee scheduler, the batch payout bounds, the
 * contention model's headline numbers, the final build's sizes and launch compute against the SDK and the metadata
 * vectors, the review counts, and the TeX-to-MathML renderer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { attestTransactionSize, CERTIFICATE, COMPUTE_UNITS, METADATA, PQ_IDENTITY, publishTransactionSize, tokenMetaSpace } from "@noisedlabs/sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PRESETS } from "../src/lib/noised";
import { batchShare, splitGain } from "../src/pages/whitepaper/model/batch";
import { attackerSol, honestSol, TX_PER_BLOCK } from "../src/pages/whitepaper/model/contention";
import { averagePrice, marginalPrice, PRESET_DECIMALS, PRESET_SHAPES, presetCurve } from "../src/pages/whitepaper/model/curve";
import { baseFeeAt, exampleSchedules, pct, presetDynamicCap, scheduleDuration } from "../src/pages/whitepaper/model/fees";
import { checksumDigits, forgeryAt, log2AttemptSuccess, mulberry32, parameterDerivation, randomDigits, stepsForChecksum, verifyStepsDistribution } from "../src/pages/whitepaper/model/lmots";
import { demoSign } from "../src/pages/whitepaper/model/lmotsDemo";
import { FINAL_SIZES, LAUNCH_CU, launchCuBound, mainnetRent, MEASURED, TESTS } from "../src/pages/whitepaper/model/perf";
import { ED25519_L, groverBits, rhoBits } from "../src/pages/whitepaper/model/security";
import { REVIEWS } from "../src/pages/whitepaper/sections/s12-13";
import { M } from "../src/pages/whitepaper/tex";

describe("LM-OTS arithmetic (RFC 8554 section 4.1)", () => {
  it("derives u = 64, v = 3, ls = 4, p = 67 for n = 32, w = 4", () => {
    expect(parameterDerivation()).toEqual({ u: 64, v: 3, ls: 4, p: 67, maxSum: 960 });
  });

  it("checksum digits are the hex digits of the checksum; the worst digest costs 990 steps", () => {
    expect(checksumDigits(960)).toEqual([3, 12, 0]);
    expect(checksumDigits(0x1f6)).toEqual([1, 15, 6]);
    expect(stepsForChecksum(960)).toBe(990);
  });

  it("the verification-work distribution sums to 1, has mean ~505.9 and lives on multiples of 15 (lemma 4.3)", () => {
    const d = verifyStepsDistribution();
    let total = 0;
    let mean = 0;
    let max = 0;
    for (let t = 0; t < d.length; t++) {
      const p = d[t] ?? 0;
      total += p;
      mean += t * p;
      if (p > 0) {
        max = t;
        expect(t % 15).toBe(0);
      }
    }
    expect(total).toBeCloseTo(1, 12);
    expect(mean).toBeCloseTo(505.92, 2);
    expect(max).toBe(990);
  });

  it("one signature leaves exactly 2^256 forgery work (lemma 4.1); two leave far less", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 4; i++) expect(-log2AttemptSuccess(randomDigits(rand))).toBeCloseTo(256, 9);
    const two = forgeryAt(2, 16, 7);
    const sorted = [...two.log2Work].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)] ?? 256).toBeLessThan(128);
  });

  it("the in-browser demo signature verifies and is deterministic", () => {
    const a = demoSign("noised");
    const b = demoSign("noised");
    expect(a.ok).toBe(true);
    expect(Array.from(a.C)).toEqual(Array.from(b.C));
    expect(a.digits).toHaveLength(67);
    expect(a.verifierSteps % 15).toBe(0);
    expect(demoSign("noised!").ok).toBe(true);
  });
});

describe("bonding-curve mirror", () => {
  it("matches the SDK's presets exactly", () => {
    for (const shape of PRESET_SHAPES) {
      const sdk = PRESETS[shape.name].params;
      const curve = presetCurve(shape);
      expect(sdk.tokenDecimal).toBe(PRESET_DECIMALS);
      expect(sdk.sqrtStartPrice).toBe(curve.sqrtStart);
      expect(sdk.curve.map((p) => [p.sqrtPrice, p.liquidity])).toEqual(curve.points.map((p) => [p.sqrtPrice, p.liquidity]));
      expect(sdk.migrationQuoteThreshold).toBe(shape.thresholdSol * 1_000_000_000n);
      expect(sdk.openDelaySecs).toBe(shape.openDelaySecs);
      expect(sdk.guardSecs).toBe(shape.guardSecs);
      expect(sdk.maxWalletBps).toBe(shape.maxWalletBps);
      expect(sdk.maxBuyBps).toBe(shape.maxBuyBps);
      expect(sdk.p2pLocked).toBe(shape.p2pLocked);
      expect(sdk.migrationFeeOption).toBe(shape.migrationFeeOption);
      expect(sdk.batchWalletCap).toBe(shape.batchWalletCapSol * 1_000_000_000n);
      expect(sdk.baseFee.cliffFeeNumerator).toBe((BigInt(shape.feeBps) * 1_000_000_000n) / 10_000n);
    }
  });

  it("a batch pays the geometric mean of its first and last marginal prices (lemma 6.4)", () => {
    const curve = presetCurve(PRESET_SHAPES[0] ?? (undefined as never));
    for (const b of [1, 5, 20, 40]) {
      const expected = Math.sqrt(marginalPrice(curve, 0) * marginalPrice(curve, b));
      expect(averagePrice(curve, 0, b) / expected).toBeCloseTo(1, 6);
    }
  });
});

describe("fees", () => {
  it("example schedules end within the commit window at the 1% floor", () => {
    const { linear, exponential } = exampleSchedules(300);
    for (const s of [linear, exponential]) {
      expect(scheduleDuration(s)).toBeLessThanOrEqual(300);
      expect(pct(baseFeeAt(s, 300))).toBeGreaterThanOrEqual(1);
      expect(pct(baseFeeAt(s, 300))).toBeLessThan(1.05);
      expect(pct(baseFeeAt(s, 0))).toBe(50);
    }
  });

  it("the presets' dynamic-fee cap is 20% of the base fee", () => {
    expect(pct(presetDynamicCap(10_000_000n))).toBeCloseTo(0.2, 2);
  });
});

describe("batch payouts", () => {
  it("never pay out more than the swap returned and splitting never gains", () => {
    const rand = mulberry32(9);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rand() * 12);
      const commits = Array.from({ length: n }, () => BigInt(1 + Math.floor(rand() * 1e9)));
      const total = commits.reduce((a, b) => a + b, 0n);
      const spent = (total * BigInt(Math.floor(rand() * 1000))) / 1000n;
      const out = BigInt(Math.floor(rand() * 1e15));
      let tokens = 0n;
      let refunds = 0n;
      for (const c of commits) {
        const s = batchShare(c, total, spent, out);
        expect(s).not.toBeNull();
        tokens += s?.tokens ?? 0n;
        refunds += s?.refund ?? 0n;
      }
      expect(tokens <= out).toBe(true);
      expect(refunds <= total - spent).toBe(true);
      expect(out - tokens < BigInt(n)).toBe(true);
      const c0 = commits[0] ?? 1n;
      expect(splitGain(c0, 1 + Math.floor(rand() * 5), total, out) <= 0n).toBe(true);
    }
  });
});

describe("contention and security models", () => {
  it("blocking a minute at zero priority costs about 0.0135 SOL", () => {
    expect(TX_PER_BLOCK).toBe(18);
    expect(attackerSol(60, 0)).toBeCloseTo(0.0135, 4);
    expect(attackerSol(600, 1_000_000)).toBeCloseTo(36.135, 2);
    expect(honestSol(1_000_000)).toBeCloseTo(0.000055, 9);
  });

  it("Pollard rho on Ed25519 is about 2^125.8; Grover on 256 bits about 2^127.65", () => {
    expect(rhoBits(ED25519_L)).toBeCloseTo(125.83, 1);
    expect(groverBits(256)).toBeCloseTo(127.65, 2);
  });
});

describe("final build: sizes, compute and costs (safety policy 3)", () => {
  const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/integration/vectors/metadata.json", import.meta.url)), "utf8")) as {
    cases: { name: string; record: { name: string; symbol: string; flags: number; uri: string; doc: string }; tokenMeta: { data: string } }[];
  };
  const typical = vectors.cases.find((c) => c.name.startsWith("typical: "));

  it("quotes the transaction and account sizes the SDK builds and the programs define", () => {
    expect(FINAL_SIZES.attestTx).toBe(attestTransactionSize());
    expect(MEASURED.find((m) => m.key === "attest")?.bytes).toBe(attestTransactionSize());
    expect(FINAL_SIZES.attestation).toBe(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN);
    expect(FINAL_SIZES.identity).toBe(PQ_IDENTITY.IDENTITY_ACCOUNT_LEN);
    expect(FINAL_SIZES.certificate).toBe(CERTIFICATE.ACCOUNT_LEN);
    expect(FINAL_SIZES.tokenMeta.fixed).toBe(METADATA.TOKEN_META_FIXED_LEN);
    expect(FINAL_SIZES.tokenMeta.max).toBe(METADATA.MAX_TOKEN_META_LEN);
    expect(FINAL_SIZES.maxInlineUri).toBe(METADATA.MAX_INLINE_URI_LEN);
    expect(FINAL_SIZES.mintBase).toBe(METADATA.MINT_BASE_LEN);
    expect(MEASURED.find((m) => m.key === "launch")?.bytes).toBe(FINAL_SIZES.launchTx);
    expect(MEASURED.find((m) => m.key === "publish")?.bytes).toBe(FINAL_SIZES.publishTx.max);
  });

  it("the typical record of the metadata vectors is the one the paper prices", () => {
    expect(typical).toBeDefined();
    if (!typical) return;
    expect(tokenMetaSpace(typical.record)).toBe(FINAL_SIZES.tokenMeta.typical);
    expect(typical.tokenMeta.data.length / 2).toBe(FINAL_SIZES.tokenMeta.typical);
    expect(publishTransactionSize(typical.record)).toBe(FINAL_SIZES.publishTx.typical);
    expect(mainnetRent(FINAL_SIZES.tokenMeta.typical)).toBe(FINAL_SIZES.rent.typicalRecord);
    expect(mainnetRent(FINAL_SIZES.tokenMeta.max)).toBe(FINAL_SIZES.rent.largestRecord);
    // The first attestation's payer: the identity and attestation rents plus one 5,000-lamport fee.
    expect(mainnetRent(FINAL_SIZES.identity) + mainnetRent(FINAL_SIZES.attestation) + 5_000).toBe(FINAL_SIZES.rent.firstAttestation);
  });

  it("bounds launch compute below the SDK's limit in every uri mode", () => {
    expect(LAUNCH_CU.limit).toBe(COMPUTE_UNITS.launch);
    expect(launchCuBound(LAUNCH_CU.base.none, LAUNCH_CU.rareSteps)).toBe(213_172);
    expect(launchCuBound(LAUNCH_CU.base.inline, LAUNCH_CU.rareSteps)).toBe(258_607);
    expect(launchCuBound(LAUNCH_CU.base.external, LAUNCH_CU.rareSteps)).toBe(214_496);
    for (const base of Object.values(LAUNCH_CU.base)) expect(launchCuBound(base, LAUNCH_CU.rareSteps)).toBeLessThan(COMPUTE_UNITS.launch);
    const launch = MEASURED.find((m) => m.key === "launch");
    expect(launch?.cuHi).toBeLessThanOrEqual(launchCuBound(LAUNCH_CU.base.inline, LAUNCH_CU.rareSteps));
    expect(launch?.cuLo).toBeGreaterThanOrEqual(LAUNCH_CU.base.none);
  });

  it("every measured range is ordered, and only v1 transactions exceed the legacy limit", () => {
    for (const m of MEASURED) {
      expect(m.cuLo, m.key).toBeLessThanOrEqual(m.cuHi);
      if (m.cuMid !== undefined) expect(m.cuMid >= m.cuLo && m.cuMid <= m.cuHi, m.key).toBe(true);
      if (m.bytes !== undefined) expect(m.bytes, m.key).toBeLessThanOrEqual(m.format === "v1" ? 4_096 : 1_232);
    }
    expect(MEASURED.filter((m) => m.source === "final").map((m) => m.key).sort()).toEqual(["attest", "launch", "migrate", "publish"]);
  });

  it("counts the reviews and tests as docs/AUDIT.md records them", () => {
    const sum = (k: "high" | "medium" | "low" | "info"): number => REVIEWS.reduce((a, r) => a + r[k], 0);
    expect(REVIEWS).toHaveLength(8);
    expect([sum("high"), sum("medium"), sum("low"), sum("info")]).toEqual([5, 18, 35, 12]);
    expect(REVIEWS.find((r) => r.key === "r3")).toMatchObject({ medium: 1, low: 2, info: 2 });
    expect(TESTS.final).toMatchObject({ host: 151, kat: 35, integration: 98, launchpadSvm: 59, shieldSvm: 17, itMutantsKilled: 148, itMutantsTotal: 148, svmMutantsKilled: 23 });
  });
});

describe("TeX to MathML", () => {
  const html = (src: string): string => renderToStaticMarkup(createElement(M, null, src));

  it("renders fractions, scripts, roots, fences and text as native MathML elements", () => {
    const out = html("u = \\left\\lceil \\frac{8n}{w} \\right\\rceil = 64, \\; x_i^{2} + \\sqrt{\\pi \\ell / 4} \\text{ iterations for } n");
    expect(out).toContain("<math");
    expect(out).toContain("<mfrac>");
    expect(out).toContain("<msubsup>");
    expect(out).toContain("<msqrt>");
    expect(out).toContain('stretchy="true"');
    expect(out).toContain("<mtext>iterations for</mtext>");
    expect(out).toContain('<annotation encoding="application/x-tex">');
    // Only the annotation keeps the TeX source; the rendered tree has no unparsed command left.
    expect(out.slice(0, out.indexOf("<annotation"))).not.toContain("\\");
  });

  it("keeps thousands separators inside numbers and handles environments", () => {
    expect(html("2,176")).toContain("<mn>2,176</mn>");
    const cases = html("f = \\begin{cases} 0 & a \\\\ 1 & b \\end{cases}");
    expect(cases).toContain("<mtable");
    expect(cases.match(/<mtr>/g)).toHaveLength(2);
  });
});

describe("whitepaper sections", () => {
  it("render, and every equation parses (no unknown TeX command reaches the page)", async () => {
    const mods = await Promise.all([
      import("../src/pages/whitepaper/sections/s01-02"),
      import("../src/pages/whitepaper/sections/s03"),
      import("../src/pages/whitepaper/sections/s04"),
      import("../src/pages/whitepaper/sections/s05"),
      import("../src/pages/whitepaper/sections/s06-07"),
      import("../src/pages/whitepaper/sections/s08-09"),
      import("../src/pages/whitepaper/sections/s10-11"),
      import("../src/pages/whitepaper/sections/s12-13"),
      import("../src/pages/whitepaper/sections/s14-15"),
    ]);
    let maths = 0;
    for (const mod of mods) {
      for (const [name, Section] of Object.entries(mod)) {
        if (!/^S\d\d$/.test(name) || typeof Section !== "function") continue;
        const out = renderToStaticMarkup(createElement(Section as () => null));
        maths += (out.match(/<math/g) ?? []).length;
        const rendered = out.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "");
        expect(rendered, `${name} has an unparsed TeX command`).not.toMatch(/<mtext>\\/);
      }
    }
    expect(maths).toBeGreaterThan(200);
  });
});
