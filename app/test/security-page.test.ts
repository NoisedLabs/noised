/**
 * The security page (/security) says in plain English what docs/SECURITY_GUARANTEES.md says in detail: every party
 * that document says a launch still trusts has a row here, what code protects includes the creator's post-quantum
 * signature and the on-chain metadata, and the user-facing panels carry no jargon (that lives in the docs).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHECK_STEPS, PROTECTION } from "../src/pages/SecurityPage";

const GUARANTEES = readFileSync(fileURLToPath(new URL("../../docs/SECURITY_GUARANTEES.md", import.meta.url)), "utf8");

/** The bold party names of the guarantees' "Who you still trust" table. */
function trustedParties(): string[] {
  const start = GUARANTEES.indexOf("## Who you still trust");
  const end = GUARANTEES.indexOf("\n## ", start + 1);
  const section = GUARANTEES.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^\| \*\*([^*]+)\*\*/gm)].map((m) => (m[1] ?? "").trim());
}

/** Which row of the page's "You still trust" column stands for each party of that table (matched by its name). */
const COUNTERPART: readonly [RegExp, RegExp][] = [
  [/Meteora upgrade|DAMM v2|DBC admins/i, /Meteora/],
  [/Token-2022|ATA program/i, /token programs/],
  [/Validators|ordering gateways|block producers/i, /Solana itself/],
  [/^Wallets/i, /Your wallet/],
  [/Passkey/i, /passkey/],
  [/Authorities of non-Noised mints/i, /Other tokens in your vault/],
  [/autopilot's operator and keepers/i, /Autopilot helpers/],
  [/upgrade authority/i, /upgrade key/],
  [/Frontend|DNS/i, /This site/],
];

/** A column of the "What protects a launch" panel, as plain strings (every item there is text). */
const column = (title: string): { k: string; v: string }[] =>
  (PROTECTION.find((c) => c.title === title)?.items ?? []).map((i) => ({ k: String(i.k), v: String(i.v ?? "") }));

describe("security page", () => {
  it("has a plain-English row for every party the guarantees say a launch still trusts", () => {
    const parties = trustedParties();
    expect(parties.length).toBeGreaterThanOrEqual(10);
    const trust = column("You still trust").map((i) => i.k);
    for (const party of parties) {
      const pair = COUNTERPART.find(([p]) => p.test(party));
      expect(pair, `no row stands for "${party}"`).toBeDefined();
      expect(trust.some((k) => pair?.[1].test(k) === true), party).toBe(true);
    }
  });

  it("lists the creator's quantum signature and the on-chain token details among what code protects", () => {
    const code = column("Protected by code");
    expect(code.find((i) => i.k === "Creator signature")?.v).toMatch(/quantum key signs it/);
    expect(code.find((i) => i.k === "Token details")?.v).toMatch(/stored on Solana itself, signed by the creator/);
    expect(CHECK_STEPS.map((s) => s.title)).toEqual(["Open the token's page", "Look for the creator's signature", "Check without this site"]);
  });

  it("speaks plain English: no jargon in the panels a user reads", () => {
    const text = [
      ...PROTECTION.flatMap((c) => [c.title, ...c.items.flatMap((i) => [i.k, i.v])]),
      ...CHECK_STEPS.flatMap((s) => [s.title, String(s.text)]),
    ].join("\n");
    expect(text).not.toMatch(/Ed25519|\bLMS\b|LM-OTS|\bPDAs?\b|multisig|\bRPC\b|\bDBC\b|DAMM|Token-2022|hash-based|elliptic|attest|protocol v2/i);
  });
});
