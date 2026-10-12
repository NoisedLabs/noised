/**
 * Static checks of the UI source:
 *  - chain access goes through ONE module: UI code imports src/lib/noised,
 *    never @noisedlabs/sdk, a backend or the mock directly;
 *  - the simulated chain is reachable only through the `#noised-backend`
 *    alias, so a default build cannot pull it in by a stray import (the
 *    build also fails if mock code ends up in a live bundle);
 *  - the app never asks a wallet to sign a message (no signMessage/signIn);
 *  - no DOM-injection sinks, eval or raw fetch anywhere in src.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = walk(SRC).map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
const ui = files.filter((f) => !f.path.startsWith("lib/"));

/** Strip comments so documentation may mention what code must not do. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("UI source boundaries", () => {
  it("has UI files to check", () => {
    expect(ui.length).toBeGreaterThan(15);
    expect(files.some((f) => f.path === "lib/noised.ts")).toBe(true);
  });

  it("UI code reaches the chain only through lib/noised", () => {
    const offenders = ui.flatMap((f) =>
      [...f.text.matchAll(/from\s+"([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((spec) => /lib\/(mock|backend)(\/|$)/.test(spec) || spec === "@noisedlabs/sdk" || spec.startsWith("#"))
        .map((spec) => `${f.path} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("only the backend alias selects a backend, and only the mock backend imports the simulated chain", () => {
    const imports = (f: { path: string; text: string }): string[] => [...f.text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
    const backendImports = files.flatMap((f) => imports(f).filter((s) => /backend\/(live|mock)$/.test(s)).map((s) => `${f.path} imports ${s}`));
    expect(backendImports).toEqual([]);
    const aliasUsers = files.filter((f) => imports(f).includes("#noised-backend")).map((f) => f.path);
    expect(aliasUsers).toEqual(["lib/noised.ts"]);
    const mockUsers = files
      .filter((f) => !f.path.startsWith("lib/mock/") && imports(f).some((s) => /(^|\/)mock\//.test(s)))
      .map((f) => f.path);
    expect(mockUsers).toEqual(["lib/backend/mock.ts"]);
  });

  it("never constructs its own RPC connection or calls fetch", () => {
    // One exception (SDK 0.9.0, audit 4): app/secondRpc.ts opens a second connection for the clock and record
    // cross-checks, only to another endpoint of this build's own list (RPC_ENDPOINTS: the CSP's connect-src).
    const offenders = files.filter((f) => f.path !== "app/secondRpc.ts" && /\bnew Connection\(|\bfetch\(/.test(code(f.text))).map((f) => f.path);
    expect(offenders).toEqual([]);
    const second = files.find((f) => f.path === "app/secondRpc.ts");
    expect(second).toBeDefined();
    const body = code(second?.text ?? "");
    expect(body).not.toMatch(/\bfetch\(/);
    expect([...body.matchAll(/\bnew Connection\(([^,)]+)/g)].map((m) => m[1]?.trim())).toEqual(["other.url"]);
    expect(body).toMatch(/const other = RPC_ENDPOINTS\.find\(\(e\) => e\.url !== selectedUrl\);/);
  });

  it("never asks a wallet to sign a message", () => {
    const offenders = files.filter((f) => /\bsignMessage\b|\bsignIn\b/.test(code(f.text))).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("uses no HTML injection sinks or dynamic code", () => {
    const offenders = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(code(f.text))).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("does not import the wallet adapter UI stylesheet (it @imports Google Fonts)", () => {
    const offenders = files.filter((f) => f.text.includes("wallet-adapter-react-ui")).map((f) => f.path);
    expect(offenders).toEqual([]);
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).not.toMatch(/fonts\.googleapis|@import\s+url\(/);
  });

  it("shows the batch caps and the graduation threshold exactly (I1: never formatSol(cap, 0))", () => {
    // A cap of 2.5 SOL shown as "2 SOL", or 0.5 SOL as "0 SOL", misstates what the batch spends.
    const offenders = ui.flatMap((f) =>
      [...code(f.text).matchAll(/formatSol\(\s*([^,()]*(?:Cap|Threshold)[^,()]*)\s*,\s*\d+\s*\)/g)].map((m) => `${f.path}: formatSol(${m[1] ?? ""}, ...)`),
    );
    expect(offenders).toEqual([]);
    const batch = files.find((f) => f.path === "pages/token/BatchPanel.tsx")?.text ?? "";
    expect(batch).toMatch(/the batch spends at most \$\{formatSolExact\(launch\.batchTotalCap\)\}/);
  });

  it("says what a commit, claim or swap does with the wSOL account from the built transaction (L5)", () => {
    // The SDK closes the wSOL account only when the same transaction created it: a fixed sentence would be wrong half the time.
    const batch = code(files.find((f) => f.path === "pages/token/BatchPanel.tsx")?.text ?? "");
    expect(batch).toMatch(/commitWsolNote\(closesWsolAccount\(tx, me\)\)/);
    expect(batch).toMatch(/claimRefundNote\(formatSol\(refund, share \? 6 : 4\), closesWsolAccount\(tx, me\)\)/);
    expect(batch).not.toMatch(/Closes your temporary wSOL account afterwards/);
    const trade = code(files.find((f) => f.path === "pages/token/TradePanel.tsx")?.text ?? "");
    expect(trade).toMatch(/swapWsolNote\(tradeSide, closesWsolAccount\(tx, user\)\)/);
    expect(trade).not.toMatch(/closes the temporary wSOL account \(leftover SOL returns to you\)/);
  });

  it("signs and broadcasts only against an endpoint known to serve this build's cluster (L3)", () => {
    const tx = code(files.find((f) => f.path === "app/tx.tsx")?.text ?? "");
    // requireCluster runs before any signature or send, and fails closed through clusterRefusal (no state-by-state checks).
    expect(tx).toMatch(/const requireCluster = useCallback\(async \(\): Promise<void> => \{[\s\S]*?clusterRefusal\(c, CLUSTER, ADAPTER_MODE\)[\s\S]*?\}, \[connection, network\.cluster\]\);/);
    expect(tx).not.toMatch(/state === "mismatch"\) throw/);
    expect(tx.indexOf("await requireCluster();")).toBeLessThan(tx.indexOf("tx.partialSign("));
    const flow = code(files.find((f) => f.path === "lib/vaultFlow.ts")?.text ?? "");
    expect(flow).toMatch(/clusterRefusal\(await chain\.checkCluster\(conn, req\.cluster\), req\.cluster, chain\.mode\)/);
  });

  it("only the transaction flow signs, and only after simulation", () => {
    const signing = files.filter((f) => /\bsignTransaction\b|\.partialSign\(/.test(code(f.text))).map((f) => f.path);
    expect(signing).toEqual(["app/tx.tsx"]);
    const tx = files.find((f) => f.path === "app/tx.tsx")?.text ?? "";
    expect(tx).toMatch(/simulatedOk\.has\(txKey\(tx\)\)/);
  });
});
