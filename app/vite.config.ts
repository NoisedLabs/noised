/// <reference types="vitest/config" />
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

import { assertAttributeSafe, buildCsp, checkEndpointCluster, parseCluster, parseMockFlag, parseRpcEndpoints, publicMainnetRpcWarning, type RpcEndpoint } from "./build/csp.ts";
import { checkCss, checkHtml, checkJs, checkNoMock, stripThirdPartyFonts } from "./build/output-checks.ts";

/**
 * Configuration (environment variables or app/.env*):
 *   VITE_RPC_URL           RPC endpoint: one URL, or comma-separated "label=https://url"
 *                          (default: the public RPC of the cluster, i.e. devnet; a mainnet
 *                          build warns when it uses the public mainnet RPC: production needs
 *                          a dedicated endpoint)
 *   VITE_NOISED_CLUSTER    mainnet | devnet | localnet (default devnet); selects the PQ
 *                          vault key derivation and explorer links; checked against the
 *                          endpoint's genesis hash at runtime
 *   VITE_NOISED_MOCK       "1" builds the simulated-chain backend for UI development;
 *                          unset (default) builds the live @noisedlabs/sdk backend
 *   VITE_NOISED_CSP_MWA    "off" drops ws://localhost:* (Solana Mobile Wallet Adapter on Android)
 *   NOISED_OUT_DIR         build output directory (default ./dist); its name must contain "dist"
 *
 * The names before the rename to Noised (VITE_PHALANX_*, PHALANX_OUT_DIR) are still read
 * when the new ones are unset, for one release.
 *
 * The same endpoint list feeds the CSP connect-src and the in-app RPC selector,
 * so the app can never connect anywhere else.
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), ["VITE_", "NOISED_", "PHALANX_"]);
  // NOISED_* first, then the same setting under its name before the rename (PHALANX_*).
  const setting = (name: string): string | undefined => env[name] ?? env[name.replace("NOISED_", "PHALANX_")];
  // Tests always run against the default (live) adapter; they import the mock backend explicitly.
  const mock = parseMockFlag(setting("VITE_NOISED_MOCK")) && mode !== "test";
  const cluster = parseCluster(setting("VITE_NOISED_CLUSTER"));
  const endpoints = parseRpcEndpoints(env.VITE_RPC_URL, cluster);
  checkEndpointCluster(endpoints, cluster);
  const csp = assertAttributeSafe(
    buildCsp(endpoints, { allowMobileWalletAdapter: (setting("VITE_NOISED_CSP_MWA") ?? "").toLowerCase() !== "off" }),
  );
  const outDir = resolve(process.cwd(), setting("NOISED_OUT_DIR") ?? process.env.NOISED_OUT_DIR ?? process.env.PHALANX_OUT_DIR ?? "dist");
  // The output directory is emptied before each build: refuse anything that does not look like one.
  if (!basename(outDir).toLowerCase().includes("dist")) throw new Error(`NOISED_OUT_DIR must name a dist directory (got ${outDir})`);
  // Exactly one chain backend is compiled in; the other is not part of the bundle.
  const backend = fileURLToPath(new URL(mock ? "./src/lib/backend/mock.ts" : "./src/lib/backend/live.ts", import.meta.url));
  if (mock && command === "build") {
    console.warn("\n  VITE_NOISED_MOCK=1: building the SIMULATED-CHAIN demo. It never talks to Solana; do not deploy it as the real app.\n");
  }
  const rpcWarning = mock ? null : publicMainnetRpcWarning(endpoints, cluster);
  if (rpcWarning !== null && command === "build") console.warn(`\n  ${rpcWarning}\n`);

  return {
    // Relative asset URLs: the site works from any IPFS gateway path.
    base: "./",
    plugins: [react(), tailwindcss(), noisedNoThirdPartyFonts(), noisedCsp(csp), noisedOutputChecks(csp, mock)],
    resolve: {
      alias: [{ find: /^#noised-backend$/, replacement: backend }],
    },
    define: {
      __NOISED_CLUSTER__: JSON.stringify(cluster),
      __NOISED_RPC_ENDPOINTS__: JSON.stringify(endpoints satisfies RpcEndpoint[]),
      __NOISED_CSP__: JSON.stringify(csp),
      __NOISED_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      sourcemap: false,
      // Every supported browser implements modulepreload; the polyfill would fetch().
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1400,
      assetsInlineLimit: 0,
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: {
      include: ["test/**/*.test.ts"],
      environment: "node",
      // The live backend's network tests stub the Connection; nothing reaches an RPC.
      testTimeout: 20_000,
    },
  };
});

/** Removes the Google Fonts links a dependency would inject (see build/output-checks.ts). */
function noisedNoThirdPartyFonts(): Plugin {
  return {
    name: "noised-no-third-party-fonts",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("node_modules")) return null;
      const patched = stripThirdPartyFonts(code);
      return patched === null ? null : { code: patched, map: null };
    },
  };
}

/** Writes the CSP meta tag right after <meta charset> in the built index.html. */
function noisedCsp(csp: string): Plugin {
  return {
    name: "noised-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
        const charset = /<meta\s+charset="UTF-8"\s*\/?>/i;
        if (!charset.test(html)) throw new Error("index.html must start its <head> with <meta charset=\"UTF-8\" />");
        return html.replace(charset, (m) => `${m}\n    ${tag}`);
      },
    },
  };
}

/** Fails the build if the output could load inline or third-party code or styles, or if a live build contains the mock. */
function noisedOutputChecks(csp: string, mock: boolean): Plugin {
  return {
    name: "noised-output-checks",
    apply: "build",
    enforce: "post",
    writeBundle(_options, bundle) {
      const problems: string[] = [];
      let sawHtml = false;
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          problems.push(...checkJs(output.code).map((p) => `${fileName}: ${p}`));
          if (!mock) problems.push(...checkNoMock(output.code).map((p) => `${fileName}: ${p}`));
          continue;
        }
        const source = typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source);
        if (fileName.endsWith(".html")) {
          sawHtml = true;
          problems.push(...checkHtml(source, csp).map((p) => `${fileName}: ${p}`));
        } else if (fileName.endsWith(".css")) {
          problems.push(...checkCss(source).map((p) => `${fileName}: ${p}`));
        }
      }
      if (!sawHtml) problems.push("index.html was not emitted");
      if (problems.length > 0) this.error(`Security checks failed:\n  - ${problems.join("\n  - ")}`);
    },
  };
}
