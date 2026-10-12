/**
 * The app bundles Meteora's DBC and DAMM v2 IDLs (through the SDK), so
 * Meteora's MIT license ships with the site: public/licenses holds an exact
 * copy of the SDK's, and the notices file points to it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("third-party notices", () => {
  it("ship Meteora's MIT license for the bundled IDLs, identical to the SDK's copy", () => {
    const shipped = read("../public/licenses/LICENSE-meteora.txt");
    expect(shipped).toBe(read("../node_modules/@noisedlabs/sdk/src/idl/LICENSE-meteora"));
    expect(shipped).toMatch(/MIT License[\s\S]*Copyright \(c\) \d{4} Meteora[\s\S]*THE SOFTWARE IS PROVIDED "AS IS"/);
    expect(read("../THIRD_PARTY_NOTICES.md")).toMatch(/\/licenses\/LICENSE-meteora\.txt/);
  });
});
