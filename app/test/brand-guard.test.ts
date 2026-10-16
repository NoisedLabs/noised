/**
 * Brand protection (lib/brandGuard.ts, lists in lib/brandPolicy.ts): a launch that uses the Noised name without being
 * the team's, or one on the hidden list, is left out of every list, warned about on its own page with no way to buy
 * there, and the create forms refuse the name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { brandFlag, filterListed, hiddenEntry, matchesReservedBrand, officialToken, RESERVED_NAME_MESSAGE, RESERVED_TICKER_MESSAGE, reservedNameErrors } from "../src/lib/brandGuard";
import { HIDDEN_LAUNCHES, OFFICIAL_TOKENS } from "../src/lib/brandPolicy";
import type { LaunchAccount } from "../src/lib/noised";

const IMPERSONATOR = { launch: "977MBgvsevQKREoRWzh2NW6T9qxmmcqnzqVQikCyTfWb", mint: "DXdARQwZ4u1ymMeUbGwciuZrhwGqi2h191LSEd3uMqWf" };
const OFFICIAL_MINT = "5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd";

const key = (seed: number): PublicKey => new PublicKey(new Uint8Array(32).fill(seed));

function launchOf(name: string | null, symbol: string | null, addresses: { launch?: PublicKey; mint?: PublicKey } = {}): LaunchAccount {
  return {
    publicKey: addresses.launch ?? key(7),
    baseMint: addresses.mint ?? key(8),
    status: "live",
    ...(name === null ? {} : { market: { name, symbol: symbol ?? "" } }),
  } as unknown as LaunchAccount;
}

describe("the policy lists", () => {
  it("hide the reported impersonator by its launch and by its mint", () => {
    expect(HIDDEN_LAUNCHES.some((h) => h.launch === IMPERSONATOR.launch && h.mint === IMPERSONATOR.mint && h.reason === "impersonation")).toBe(true);
    expect(hiddenEntry(IMPERSONATOR.launch)?.reason).toBe("impersonation");
    expect(hiddenEntry(new PublicKey(IMPERSONATOR.mint))?.reason).toBe("impersonation");
    expect(hiddenEntry(key(9))).toBeNull();
  });

  it("allow the team's mint only", () => {
    expect(OFFICIAL_TOKENS.map((o) => o.mint)).toEqual([OFFICIAL_MINT]);
    expect(officialToken(new PublicKey(OFFICIAL_MINT))?.mint).toBe(OFFICIAL_MINT);
    expect(officialToken(IMPERSONATOR.mint)).toBeNull();
  });
});

describe("reserved names", () => {
  it.each(["Noised", "NOISED", "noised", "$NOISED", "NOISD", "$noisd", "No ised", "N.O.I.S.E.D", "noised!", "NoisedAI", "OfficialNoised", "Noised Official", "the noised token"])(
    "%s reads as Noised",
    (name) => expect(matchesReservedBrand(name)).toBe(true),
  );

  it.each(["Noise", "Aegis", "Poised", "Bastion", "NSD", "Turquoise Dragon", "", "Noisy"])("%s is free", (name) => expect(matchesReservedBrand(name)).toBe(false));

  it("flags a reserved name or ticker on any mint but the team's", () => {
    expect(brandFlag({ mint: key(1), name: "Noised", symbol: "NSD" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: key(1), name: "Cool", symbol: "NOISED" })?.reason).toBe("impersonation");
    expect(brandFlag({ mint: new PublicKey(OFFICIAL_MINT), name: "Noised", symbol: "NOISED" })).toBeNull();
    expect(brandFlag({ mint: key(1), name: "Aegis", symbol: "AEGS" })).toBeNull();
    // The hidden list counts whatever the name.
    expect(brandFlag({ launch: IMPERSONATOR.launch, name: "Anything", symbol: "ANY" })?.reason).toBe("impersonation");
  });
});

describe("lists", () => {
  it("leave out hidden launches and reserved names, keep the team's and everything else", () => {
    const aegis = launchOf("Aegis", "AEGS", { launch: key(1), mint: key(2) });
    const hidden = launchOf("Fine Name", "FINE", { launch: new PublicKey(IMPERSONATOR.launch), mint: new PublicKey(IMPERSONATOR.mint) });
    const hiddenByMint = launchOf("Fine Name", "FINE", { launch: key(3), mint: new PublicKey(IMPERSONATOR.mint) });
    const fake = launchOf("N0ISED", "NSD", { launch: key(4), mint: key(5) });
    const official = launchOf("Noised", "NOISED", { launch: key(6), mint: new PublicKey(OFFICIAL_MINT) });
    const configured = launchOf(null, null, { launch: key(10), mint: key(11) });
    expect(filterListed([aegis, hidden, hiddenByMint, fake, official, configured])).toEqual([aegis, official, configured]);
  });

  it("every page reads the filtered list, never listLaunches itself", () => {
    const SRC = fileURLToPath(new URL("../src", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const allowed = new Set(["lib/noised.ts", "lib/brandGuard.ts"]);
    const offenders = walk(SRC)
      .map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }))
      .filter((f) => !allowed.has(f.path) && !f.path.startsWith("lib/backend/") && !f.path.startsWith("lib/mock/") && !f.path.startsWith("content/"))
      .filter((f) => /\blistLaunches\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("create forms", () => {
  it("refuse a reserved name or ticker with a plain message", () => {
    expect(reservedNameErrors({ name: "Noised", symbol: "NOISED" })).toEqual([`name: ${RESERVED_NAME_MESSAGE}`, `symbol: ${RESERVED_TICKER_MESSAGE}`]);
    expect(RESERVED_NAME_MESSAGE).toBe("Noised is reserved for the official token. Pick another name.");
    expect(reservedNameErrors({ name: "Aegis", symbol: "AEGS" })).toEqual([]);
  });
});
