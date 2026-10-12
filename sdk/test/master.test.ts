/**
 * `masterFromPhrase` never hands out an all-zero master (review M2). A real
 * phrase cannot produce one (PBKDF2 output), so BIP-39's seed function is
 * replaced for one phrase here; this file is separate so the mock reaches no
 * other test.
 */
import { describe, expect, it, vi } from "vitest";

import { masterFromPhrase } from "../src/pq/keys.js";

const ZEROED = vi.hoisted(() => `${"legal winner thank year wave sausage worth useful ".repeat(3)}`.trim().replace(/useful$/, "title"));

vi.mock("@scure/bip39", async (importOriginal) => {
  const real = await importOriginal<typeof import("@scure/bip39")>();
  return { ...real, mnemonicToSeedSync: (phrase: string, passphrase?: string) => (phrase === ZEROED ? new Uint8Array(64) : real.mnemonicToSeedSync(phrase, passphrase)) };
});

describe("masterFromPhrase", () => {
  it("refuses an all-zero seed: every key derived from it would be public", () => {
    expect(() => masterFromPhrase(ZEROED)).toThrow(/all-zero master/);
    // Every other phrase is unaffected.
    expect(masterFromPhrase(`${"abandon ".repeat(23)}art`).length).toBe(64);
  });
});
