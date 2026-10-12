/**
 * Packaging and source hygiene: what `pnpm pack` publishes and how the
 * package meets its consumers (peer dependencies, the exports map, the
 * license files), and source text that ships verbatim in `src/` and `dist/`.
 * The packed tarball itself is checked by hand before a release
 * (CONTRIBUTING, "Release"); these checks keep the manifest from drifting.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SDK = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(SDK, "..");
const read = (...p: string[]): string => readFileSync(join(...p), "utf8");
const pkg = JSON.parse(read(SDK, "package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  files: string[];
  exports: Record<string, unknown>;
};

describe("package manifest (review finding: packaging had no automated test)", () => {
  it("@solana/web3.js is the only peer, with a range that admits the current 1.x client stack; anchor and spl-token are regular exact dependencies", () => {
    // The API takes and returns web3.js objects (`instanceof PublicKey` / `Transaction`): the app must provide the
    // one copy. Nothing of anchor (only BN, inside buildSwapTx) or spl-token (instruction builders) crosses the API.
    expect(pkg.peerDependencies).toEqual({ "@solana/web3.js": "^1.98.4" });
    expect(pkg.peerDependenciesMeta).toBeUndefined();
    expect("@solana/web3.js" in pkg.dependencies).toBe(false);
    expect(pkg.devDependencies["@solana/web3.js"]).toBe("1.98.4"); // the version the SDK's own tests run on
    expect([pkg.dependencies["@coral-xyz/anchor"], pkg.dependencies["@solana/spl-token"]]).toEqual(["0.31.1", "0.4.14"]);
    // Every regular dependency is pinned exactly.
    for (const [name, v] of Object.entries(pkg.dependencies)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    // The declaration files reference no external module but @solana/web3.js, so a consumer needs no other types.
    const external = new Set<string>();
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) for (const m of read(p).matchAll(/from "([^".][^"]*)"/g)) external.add(m[1]!.startsWith("@") ? m[1]!.split("/").slice(0, 2).join("/") : m[1]!.split("/")[0]!);
      }
    };
    walk(join(SDK, "src"));
    for (const name of external) expect(name in pkg.dependencies || name in pkg.peerDependencies, name).toBe(true);
  });

  it("files and exports: dist, src, the license files; exactly the four documented entry points", () => {
    expect([...pkg.files].sort()).toEqual(["CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "SECURITY.md", "dist", "src"]);
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./idl/*.json", "./package.json", "./programmable"]);
    // The programmable module alone (pure: no Solana client stack), and from the root.
    expect(pkg.exports["./programmable"]).toEqual({ types: "./dist/programmable/index.d.ts", import: "./dist/programmable/index.js", default: "./dist/programmable/index.js" });
    expect(pkg.exports["./idl/*.json"]).toBe("./dist/idl/*.json"); // JSON only: no path reaches the internal signer modules
  });

  it("the vendored Meteora IDLs ship with Meteora's MIT license text, and NOTICE points to it (review finding)", () => {
    const mit = read(SDK, "src", "idl", "LICENSE-meteora");
    expect(mit).toMatch(/dynamic_bonding_curve\.json and cp_amm\.json/);
    expect(mit).toMatch(/MIT License\n\nCopyright \(c\) 2026 Meteora\n/);
    expect(mit).toMatch(/The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
    expect(read(SDK, "NOTICE")).toMatch(/src\/idl\/LICENSE-meteora/);
    expect(read(ROOT, "NOTICE")).toMatch(/sdk\/src\/idl\/LICENSE-meteora/);
    // "src" is published whole, so the license text travels with every copy of the IDLs in the package.
    expect(pkg.files).toContain("src");
    expect(read(ROOT, "LICENSE")).toBe(read(SDK, "LICENSE"));
  });
});

describe("source hygiene", () => {
  /** Every text file the package ships or documents (src, examples, docs), plus the tests. */
  function textFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        if (f === "node_modules" || f === "dist") continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mjs|js|json|md)$|LICENSE|NOTICE/.test(f)) out.push(p);
      }
    };
    for (const d of ["src", "examples", "test", "scripts"]) walk(join(SDK, d));
    for (const f of ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "NOTICE", "LICENSE", "package.json"]) out.push(join(SDK, f));
    return out;
  }

  it("no text was double-encoded (UTF-8 read as Windows-1252 and written back): the review found a garbled em dash and section sign shipped in dist/index.d.ts", () => {
    // UTF-8 of U+2014 / U+201D read as cp1252 starts C3 A2 E2 82 AC; of U+00A7 / U+00B7 etc., C3 82 C2.
    const bad = [Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac]), Buffer.from([0xc3, 0x82, 0xc2])];
    const hits: string[] = [];
    for (const f of textFiles()) {
      const b = readFileSync(f);
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) hits.push(`${f}: UTF-8 BOM`);
      for (const s of bad) if (b.includes(s)) hits.push(`${f}: ${s.toString("hex")}`);
    }
    expect(hits).toEqual([]);
    expect(read(SDK, "src", "index.ts").split("\n")[1]).toBe(" * @noisedlabs/sdk — TypeScript client for Noised (docs/SPEC.md §4.1).");
  });

  it("the programmable module (\"./programmable\") is pure: it imports only @noble/hashes and its own files (no Solana client, no Node APIs)", () => {
    const dir = join(SDK, "src", "programmable");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          for (const m of read(p).matchAll(/from "([^"]+)"/g)) {
            const spec = m[1]!;
            if (spec.startsWith("@noble/hashes/")) continue;
            if (spec.startsWith(".") && join(p, "..", spec).startsWith(dir)) continue;
            offenders.push(`${p.slice(SDK.length)}: ${spec}`);
          }
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });

  it("the identity id has one implementation (lms.identityId): no other module hashes the identity-id domain", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /IDENTITY_ID_DOMAIN|DOMAIN_IDENTITY_ID/.test(read(p))) offenders.push(p.slice(SDK.length));
      }
    };
    walk(join(SDK, "src"));
    // constants.ts declares the program's constant (checked against the Rust sources), lms.ts is the implementation
    // and lmsPublic.ts re-exports its constant; decodeIdentity and the PDA helpers call lms.identityId.
    expect(offenders.map((p) => p.replaceAll("\\", "/").replace(/^\//, "")).sort()).toEqual(["src/constants.ts", "src/pq/lms.ts", "src/pq/lmsPublic.ts"]);
  });
});
