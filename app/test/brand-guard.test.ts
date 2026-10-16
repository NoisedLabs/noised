/**
 * Brand protection (lib/brandGuard.ts, lists in lib/brandPolicy.ts): a launch that uses the Noised name without being
 * the team's, or one on the hidden list, is left out of every list, warned about on its own page with no way to buy
 * there (selling and claims stay), and the create forms (Quick and Custom) refuse the name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The token page's action panels need a wallet and the transaction runner: stand-ins with no wallet connected.
vi.mock("../src/app/tx", () => ({ useTx: () => ({ run: async () => ({ status: "cancelled" }), busy: false }) }));
vi.mock("../src/app/wallet", () => ({ useOwner: () => ({ publicKey: null, source: null }) }));

import { BrandWarningView, OfficialSentence } from "../src/components/BrandWarning";
import {
  brandFlag,
  brandReadings,
  filterListed,
  hiddenEntry,
  launchBrandFlag,
  matchesReservedBrand,
  mintBrandFlag,
  officialToken,
  RESERVED_NAME_MESSAGE,
  RESERVED_TICKER_MESSAGE,
  reservedNameErrors,
} from "../src/lib/brandGuard";
import { HIDDEN_LAUNCHES, OFFICIAL_TOKENS, RESERVED_BRANDS } from "../src/lib/brandPolicy";
import type { LaunchAccount } from "../src/lib/noised";
import { convertDraft, draftFromPreset } from "../src/pages/create/draft";
import { launchTreasury, quickDefaults, quickDraft, resolveTreasury } from "../src/pages/create/quick";
import { BatchPanel } from "../src/pages/token/BatchPanel";
import { TradePanel } from "../src/pages/token/TradePanel";

const IMPERSONATOR = { launch: "977MBgvsevQKREoRWzh2NW6T9qxmmcqnzqVQikCyTfWb", mint: "DXdARQwZ4u1ymMeUbGwciuZrhwGqi2h191LSEd3uMqWf" };
const OFFICIAL_MINT = "5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd";

const key = (seed: number): PublicKey => new PublicKey(new Uint8Array(32).fill(seed));

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
/** Visible text, entities decoded. */
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

function launchOf(name: string | null, symbol: string | null, addresses: { launch?: PublicKey; mint?: PublicKey } = {}): LaunchAccount {
  return {
    publicKey: addresses.launch ?? key(7),
    baseMint: addresses.mint ?? key(8),
    status: "live",
    ...(name === null ? {} : { market: { name, symbol: symbol ?? "" } }),
  } as unknown as LaunchAccount;
}

describe("the policy lists", () => {
  it("reserve noised and noisd, in plain lowercase", () => {
    expect(RESERVED_BRANDS).toEqual(["noised", "noisd"]);
    expect(RESERVED_BRANDS.every((b) => /^[a-z]+$/.test(b))).toBe(true);
  });

  it("hide the reported impersonator by its launch and by its mint", () => {
    expect(HIDDEN_LAUNCHES.some((h) => h.launch === IMPERSONATOR.launch && h.mint === IMPERSONATOR.mint && h.reason === "impersonation")).toBe(true);
    expect(hiddenEntry(IMPERSONATOR.launch)?.reason).toBe("impersonation");
    expect(hiddenEntry(new PublicKey(IMPERSONATOR.launch))?.reason).toBe("impersonation");
    expect(hiddenEntry(new PublicKey(IMPERSONATOR.mint))?.reason).toBe("impersonation");
    expect(hiddenEntry(key(9))).toBeNull();
    expect(hiddenEntry(null, undefined)).toBeNull();
    // Every entry names at least one valid address.
    for (const h of HIDDEN_LAUNCHES) {
      expect(h.launch !== undefined || h.mint !== undefined).toBe(true);
      for (const a of [h.launch, h.mint]) if (a !== undefined) expect(new PublicKey(a).toBase58()).toBe(a);
    }
  });

  it("allow the team's mint only", () => {
    expect(OFFICIAL_TOKENS.map((o) => o.mint)).toEqual([OFFICIAL_MINT]);
    expect(new PublicKey(OFFICIAL_MINT).toBase58()).toBe(OFFICIAL_MINT);
    expect(officialToken(new PublicKey(OFFICIAL_MINT))?.mint).toBe(OFFICIAL_MINT);
    expect(officialToken(IMPERSONATOR.mint)).toBeNull();
    expect(officialToken(key(3))).toBeNull();
  });
});

describe("reserved names: what reads as Noised", () => {
  const variants: [string, string][] = [
    ["plain", "Noised"],
    ["upper", "NOISED"],
    ["lower", "noised"],
    ["ticker with $", "$NOISED"],
    ["short ticker", "NOISD"],
    ["short ticker with $", "$noisd"],
    ["spaces", "N o i s e d"],
    ["no-break and ideographic spaces", "No is　ed"],
    ["tabs and new lines", "Noi\tse\nd"],
    ["dots", "N.O.I.S.E.D"],
    ["dashes and underscores", "n-o_i-s_e-d"],
    ["trailing punctuation", "noised!!!"],
    ["emoji around", "🚀 Noised 🚀"],
    ["prefix", "NoisedAI"],
    ["official prefix", "OfficialNoised"],
    ["suffix words", "Noised Official"],
    ["inside a sentence", "the noised token"],
    ["zero 0 for o", "N0ISED"],
    ["1 for i", "NO1SED"],
    ["l for i", "NOlSED"],
    ["pipe for i", "NO|SED"],
    ["5 for s", "NOI5ED"],
    ["$ for s", "NOI$ED"],
    ["3 for e", "NOIS3D"],
    ["all digits", "N015ED"],
    ["short with digits", "N0I5D"],
    ["zero-width space", "No​ised"],
    ["zero-width joiner and non-joiner", "N‍o‌ised"],
    ["word joiner", "Noi⁠sed"],
    ["byte order mark", "﻿NOISED"],
    ["soft hyphen", "Noi­sed"],
    ["direction override", "‮Noised‬"],
    ["left-to-right mark", "‎NOISED"],
    ["variation selector", "Noise️d"],
    ["Hangul filler", "Noiㅤsed"],
    ["combining underline", "N̲o̲i̲s̲e̲d̲"],
    ["accents", "Nöïséd"],
    ["Cyrillic o, i, s, e", "Nоіѕеd"],
    ["Cyrillic capitals", "NОІЅЕD"],
    ["Greek capital Nu, Omicron, Iota, Epsilon", "ΝΟΙSΕD"],
    ["Greek small omicron and iota", "nοιsed"],
    ["Cyrillic komi de", "noiseԁ"],
    ["d with stroke", "noiseđ"],
    ["dotless i", "noısed"],
    ["Cyrillic palochka", "NOӀSED"],
    ["fullwidth", "ＮＯＩＳＥＤ"],
    ["mathematical bold", "𝐍𝐎𝐈𝐒𝐄𝐃"],
    ["mathematical script", "𝓝𝓸𝓲𝓼𝓮𝓭"],
    ["circled", "ⓝⓞⓘⓢⓔⓓ"],
    ["superscript", "ᴺᴼᴵˢᴱᴰ"],
    ["small capitals", "ɴᴏɪꜱᴇᴅ"],
    ["Lisu letters", "ꓠꓳꓲꓢꓰꓓ"],
    ["negative squared letters", "🅽🅾🅸🆂🅴🅳"],
    ["regional indicators", "🇳🇴🇮🇸🇪🇩"],
    ["cl for d", "Noisecl"],
    ["mixed everything", "$ Ｎ0​І5ëđ AI"],
  ];
  it.each(variants)("%s: %s", (_label, name) => expect(matchesReservedBrand(name)).toBe(true));

  it.each(["Noise", "Noisy", "Poised", "Aegis", "Bastion", "NSD", "NOIS", "Turquoise Dragon", "Noise Club", "Tortoise Den", "Moist Ed", "", "   ", "​"])(
    "%j is free",
    (name) => expect(matchesReservedBrand(name)).toBe(false),
  );

  it("reads names as plain lowercase a-z only", () => {
    for (const [, name] of variants) for (const r of brandReadings(name)) expect(r).toMatch(/^[a-z]*$/);
    expect(brandReadings("$NOISED")).toEqual(expect.arrayContaining(["snoised", "noised"]));
    expect(matchesReservedBrand(null)).toBe(false);
    expect(matchesReservedBrand(undefined)).toBe(false);
  });
});

describe("flags", () => {
  it("flag a reserved name or ticker on any mint but the team's", () => {
    expect(brandFlag({ mint: key(1), name: "Noised", symbol: "NSD" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: key(1), name: "Cool", symbol: "NOISED" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: key(1), name: "Cool", symbol: "N0ISD" })?.reason).toBe("impersonation");
    // Before launch there is no mint yet: the name alone counts.
    expect(brandFlag({ launch: key(1), name: "Noised", symbol: "NOISED" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: new PublicKey(OFFICIAL_MINT), name: "Noised", symbol: "NOISED" })).toBeNull();
    expect(brandFlag({ mint: key(1), name: "Aegis", symbol: "AEGS" })).toBeNull();
    expect(brandFlag({ mint: key(1) })).toBeNull();
  });

  it("the hidden list counts whatever the name, even on the team's allowlist", () => {
    expect(brandFlag({ launch: IMPERSONATOR.launch, name: "Anything", symbol: "ANY" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: IMPERSONATOR.mint })?.reason).toBe("impersonation");
  });

  it("read a launch's name from its pool, or from its record before launch", () => {
    expect(launchBrandFlag(launchOf("Noised", "NOISED", { launch: key(1), mint: key(2) }))?.reason).toBe("impersonation");
    const upcoming = launchOf(null, null, { launch: key(1), mint: key(2) });
    expect(launchBrandFlag(upcoming)).toBeNull();
    expect(launchBrandFlag(upcoming, { name: "Nоised", symbol: "X" })?.reason).toBe("impersonation");
    expect(launchBrandFlag(upcoming, { name: "Aegis", symbol: "AEGS" })).toBeNull();
  });

  it("a hidden mint is flagged without reading Solana", async () => {
    const conn = {} as Connection;
    expect((await mintBrandFlag(conn, new PublicKey(IMPERSONATOR.mint)))?.reason).toBe("impersonation");
  });
});

describe("lists", () => {
  it("leave out hidden launches and reserved names, keep the team's and everything else", () => {
    const aegis = launchOf("Aegis", "AEGS", { launch: key(1), mint: key(2) });
    const hidden = launchOf("Fine Name", "FINE", { launch: new PublicKey(IMPERSONATOR.launch), mint: new PublicKey(IMPERSONATOR.mint) });
    const hiddenByMint = launchOf("Fine Name", "FINE", { launch: key(3), mint: new PublicKey(IMPERSONATOR.mint) });
    const fake = launchOf("N0ISED", "NSD", { launch: key(4), mint: key(5) });
    const fakeTicker = launchOf("Some Coin", "$NOISD", { launch: key(12), mint: key(13) });
    const homoglyph = launchOf("Nоіѕеd", "NSD", { launch: key(14), mint: key(15) });
    const official = launchOf("Noised", "NOISED", { launch: key(6), mint: new PublicKey(OFFICIAL_MINT) });
    const configured = launchOf(null, null, { launch: key(10), mint: key(11) });
    expect(filterListed([aegis, hidden, hiddenByMint, fake, fakeTicker, homoglyph, official, configured])).toEqual([aegis, official, configured]);
    expect(filterListed([])).toEqual([]);
  });

  it("every page reads the filtered list, never listLaunches itself", () => {
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const files = walk(SRC).map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
    const allowed = new Set(["lib/noised.ts", "lib/brandGuard.ts"]);
    const offenders = files
      .filter((f) => !allowed.has(f.path) && !f.path.startsWith("lib/backend/") && !f.path.startsWith("lib/mock/") && !f.path.startsWith("content/"))
      .filter((f) => /\blistLaunches\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
    // The pages that list launches do read the filtered list.
    const readers = files.filter((f) => /\blistListedLaunches\(/.test(f.text)).map((f) => f.path);
    expect(readers).toEqual(
      expect.arrayContaining([
        "pages/Home.tsx",
        "components/landing/Hero.tsx",
        "components/CommandPalette.tsx",
        "pages/verify/VerifyPage.tsx",
        "pages/vault/VaultPage.tsx",
        "pages/ShieldPage.tsx",
        "pages/autopilot/AutopilotIndex.tsx",
      ]),
    );
  });
});

describe("the token page of a flagged launch", () => {
  it("warns in red, in plain words, and follows the team's own token", () => {
    const flag = { reason: "impersonation" as const };
    const none = text(html(createElement(BrandWarningView, { flag, trading: true, official: null })));
    expect(none).toContain("Not affiliated with Noised.");
    expect(none).toContain("This token uses the Noised name but wasn't launched by the Noised team. Noised hasn't launched a token yet.");
    expect(none).toContain("Buying is turned off here. If you already hold it, you can still sell it.");
    const live = html(createElement(BrandWarningView, { flag, trading: false, official: OFFICIAL_TOKENS[0] }));
    expect(text(live)).toMatch(/The official Noised token is \$NOISED ?\./);
    expect(text(live)).not.toContain("hasn't launched");
    expect(text(live)).not.toContain("Buying is turned off");
    expect(live).toContain(`href="/token/${OFFICIAL_MINT}"`);
    // While the team's token is being read, the sentence waits.
    expect(text(html(createElement(OfficialSentence, { official: undefined })))).toBe("");
    const box = html(createElement(BrandWarningView, { flag, trading: false, official: null }));
    expect(box).toContain('class="brand-warn"');
    expect(box).toContain('role="alert"');
    const reported = text(html(createElement(BrandWarningView, { flag: { reason: "reported" }, trading: false, official: null })));
    expect(reported).toContain("Hidden on Noised.");
  });

  it("the red box is red", () => {
    const css = readFileSync(new URL("../src/components/brandWarning.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.brand-warn \{[^}]*var\(--danger/);
    expect(css).toMatch(/\.brand-warn-title \{[^}]*color: var\(--danger/);
  });

  const now = 2_000_000_000;
  const live = {
    publicKey: key(1),
    baseMint: key(2),
    status: "live",
    executed: true,
    totalCommitted: 5_000_000_000n,
    quoteSpent: 5_000_000_000n,
    tokensOut: 1_000_000n,
    batchTotalCap: 10_000_000_000n,
    batchWalletCap: 0n,
    commitEndTs: BigInt(now - 7200),
    executeEndTs: BigInt(now - 3600),
    guardEndTs: BigInt(now - 1800),
    tokenDecimal: 6,
    maxBuyBps: 0,
    maxWalletBps: 0,
    market: { name: "Noised", symbol: "NOISED", initialSupply: 1_000_000_000n, curveComplete: false, migrated: false },
  } as unknown as LaunchAccount;

  it("has no Commit tab, no buy and no vault buy; claims and selling stay", () => {
    const panel = (noBuys: boolean, phase: "commit" | "open"): string =>
      text(
        html(
          createElement(BatchPanel, {
            launch: live,
            phase,
            now,
            symbol: "NOISED",
            noBuys,
            trade: createElement(TradePanel, { launch: live, phase, now, symbol: "NOISED", sellOnly: noBuys }),
          }),
        ),
      );
    for (const phase of ["commit", "open"] as const) {
      const hidden = panel(true, phase);
      expect(hidden).not.toMatch(/\bCommit\b/);
      expect(hidden).not.toContain("Review commit");
      expect(hidden).not.toContain("Start the batch");
      expect(hidden).not.toContain("Review buy");
      expect(hidden).not.toContain("You pay (SOL)");
      expect(hidden).not.toContain("Send what I buy to my quantum vault");
      expect(hidden).not.toContain("Send my tokens to my quantum vault");
      expect(hidden).toContain("Claim");
      expect(hidden).toContain("Review sell");
      expect(hidden).toContain("You sell (NOISED)");
      expect(hidden).toContain("Buying is turned off here for this token.");
    }
    // An ordinary launch keeps everything.
    const usual = panel(false, "commit");
    expect(usual).toContain("Commit");
    expect(usual).toContain("Review commit");
    expect(usual).toContain("Review buy");
  });

  it("the page wires the warning and the sell-only panels to the flag", () => {
    const page = readFileSync(new URL("../src/pages/token/TokenPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("const flag = launchBrandFlag(l, meta);");
    expect(page).toContain("<BrandWarning flag={flag} trading />");
    expect(page).toContain("noBuys={flag !== null}");
    expect(page).toContain("sellOnly={flag !== null}");
    // Before launch: the warning and no "Open the launch".
    expect(page).toContain('state?.kind === "open" && flag === null');
    const verify = readFileSync(new URL("../src/pages/verify/VerifyPage.tsx", import.meta.url), "utf8");
    expect(verify).toMatch(/<div className="pg-stack-lg vf-result">\s*<BrandWarning flag=\{flag\} \/>/);
  });
});

describe("create forms", () => {
  it("refuse a reserved name or ticker with a plain message", () => {
    expect(reservedNameErrors({ name: "Noised", symbol: "NOISED" })).toEqual([`name: ${RESERVED_NAME_MESSAGE}`, `symbol: ${RESERVED_TICKER_MESSAGE}`]);
    expect(RESERVED_NAME_MESSAGE).toBe("Noised is reserved for the official token. Pick another name.");
    expect(RESERVED_TICKER_MESSAGE).toBe("Noised is reserved for the official token. Pick another ticker.");
    expect(reservedNameErrors({ name: "Aegis", symbol: "AEGS" })).toEqual([]);
  });

  const pqId = new Uint8Array(32).fill(1);
  const creator = Keypair.generate().publicKey;

  it.each([
    ["Noised", "NOISED"],
    ["N0ised", "COIN"],
    ["My Coin", "$NOISD"],
    ["Nоіѕеd", "NSD"],
  ])("Custom refuses %s / %s", (name, symbol) => {
    const conv = convertDraft({ ...draftFromPreset("fair"), name, symbol, recipients: [{ wallet: creator.toBase58(), pct: "100" }] }, pqId, null);
    expect(conv.policyErrors.some((e) => e.endsWith(RESERVED_NAME_MESSAGE) || e.endsWith(RESERVED_TICKER_MESSAGE))).toBe(true);
  });

  it("Quick refuses the name and the ticker, each under its own field", () => {
    const { treasury } = launchTreasury(creator, new Uint8Array(32).fill(2));
    const conv = convertDraft(resolveTreasury(quickDraft({ ...quickDefaults(), name: "Noised", symbol: "NOISED" }, creator.toBase58()), treasury), pqId, null);
    expect(conv.policyErrors).toEqual(expect.arrayContaining([`name: ${RESERVED_NAME_MESSAGE}`, `symbol: ${RESERVED_TICKER_MESSAGE}`]));
    const fine = convertDraft(
      resolveTreasury(quickDraft({ ...quickDefaults(), name: "Quick Coin", symbol: "QUIK" }, creator.toBase58()), treasury),
      pqId,
      null,
    );
    expect(fine.policyErrors.filter((e) => e.includes("reserved"))).toEqual([]);
  });

  it("an empty or too long name keeps its own message (one per field)", () => {
    const conv = convertDraft({ ...draftFromPreset("fair"), name: "", symbol: "NOISED", recipients: [{ wallet: creator.toBase58(), pct: "100" }] }, pqId, null);
    expect(conv.policyErrors).toContain("name: is required");
    expect(conv.policyErrors).toContain(`symbol: ${RESERVED_TICKER_MESSAGE}`);
    expect(conv.policyErrors.filter((e) => e.startsWith("symbol: ")).length).toBe(1);
  });

  it("the launch flow refuses it too, and the forms offer no override", () => {
    const flow = readFileSync(new URL("../src/lib/launchFlow.ts", import.meta.url), "utf8");
    expect(flow).toMatch(/const reserved = reservedNameErrors\(\{ name: p\.name, symbol: p\.symbol \}\)\[0\];\s*if \(reserved !== undefined\) throw/);
    const forms = ["../src/pages/create/QuickLaunch.tsx", "../src/pages/create/CreatePage.tsx"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const f of forms) expect(f).not.toMatch(/brandPolicy|OFFICIAL_TOKENS|reservedOverride/);
  });
});
