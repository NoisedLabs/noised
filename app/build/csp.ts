/**
 * Build-time configuration: the backend flag, the cluster, the RPC endpoints
 * and the Content-Security-Policy derived from them.
 *
 * The site is static (IPFS-deployable), so the policy ships as a <meta> tag
 * that is written at build time from the configured RPC endpoints
 * (VITE_RPC_URL). The app can only ever talk to those endpoints: `connect-src`
 * lists exactly their HTTP origins plus the WebSocket origins web3.js derives
 * from them.
 *
 * Pure functions only (no Node APIs) so they are unit-tested in test/csp.test.ts.
 */

export type ClusterName = "mainnet" | "devnet" | "localnet";

export interface RpcEndpoint {
  /** Short human label shown in the RPC selector. */
  readonly label: string;
  /** Full HTTP(S) URL passed to `new Connection(url)`. */
  readonly url: string;
}

export const DEFAULT_RPC_ENDPOINTS: Readonly<Record<ClusterName, readonly string[]>> = {
  mainnet: ["https://api.mainnet-beta.solana.com"],
  devnet: ["https://api.devnet.solana.com"],
  localnet: ["http://127.0.0.1:8899"],
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * VITE_NOISED_MOCK: exactly "1" builds the simulated-chain backend for UI
 * development; unset, empty or "0" builds the live SDK backend (the default).
 * Anything else fails the build rather than guessing.
 */
export function parseMockFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  if (v === "1") return true;
  if (v === "" || v === "0") return false;
  throw new Error(`VITE_NOISED_MOCK must be "1" (simulated chain) or unset / "0" (live SDK), got "${value ?? ""}"`);
}

/** Default devnet: a mainnet build must be chosen explicitly. */
export function parseCluster(value: string | undefined): ClusterName {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet";
  if (v === "" || v === "devnet") return "devnet";
  if (v === "localnet" || v === "localhost") return "localnet";
  throw new Error(`NOISED cluster must be mainnet, devnet or localnet (got "${value ?? ""}")`);
}

/**
 * Parse VITE_RPC_URL: one URL, or `label=url,label=url` (labels optional; the
 * first endpoint is the default). Empty means the cluster's public endpoint.
 * Rejects anything that is not HTTPS, except plain HTTP to a loopback address
 * for local validators, and URLs carrying credentials or fragments.
 */
export function parseRpcEndpoints(value: string | undefined, cluster: ClusterName): RpcEndpoint[] {
  const raw = (value ?? "").trim();
  const items = raw === "" ? [...DEFAULT_RPC_ENDPOINTS[cluster]] : raw.split(",");
  const out: RpcEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    const hasLabel = eq > 0 && !trimmed.slice(0, eq).includes("://");
    const label = hasLabel ? trimmed.slice(0, eq).trim() : "";
    const urlText = hasLabel ? trimmed.slice(eq + 1).trim() : trimmed;
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      throw new Error(`RPC endpoint is not a valid URL: "${urlText}"`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error(`RPC endpoint must not embed credentials: "${url.host}"`);
    }
    if (url.hash !== "") {
      throw new Error(`RPC endpoint must not contain a fragment: "${urlText}"`);
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`RPC endpoint must use https (http only for loopback): "${urlText}"`);
    }
    if (!/^[\w .()-]{0,40}$/.test(label)) {
      throw new Error(`RPC endpoint label may only contain letters, digits, spaces and . ( ) - _ (max 40): "${label}"`);
    }
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ label: label === "" ? url.host : label, url: normalized });
  }
  if (out.length === 0) throw new Error("At least one RPC endpoint is required");
  return out;
}

/** Hosts of the public RPC endpoints, by the cluster they serve. */
const PUBLIC_RPC_HOSTS: Readonly<Record<string, string>> = {
  "api.mainnet-beta.solana.com": "mainnet",
  "api.mainnet.solana.com": "mainnet",
  "api.devnet.solana.com": "devnet",
  "api.testnet.solana.com": "testnet",
};

/**
 * Refuse a build whose endpoint is a well-known public RPC of another cluster
 * than VITE_NOISED_CLUSTER: the cluster selects the PQ vault key derivation
 * and the explorer links, so a mismatch would derive keys for the wrong
 * cluster. (Other endpoints are checked at runtime by their genesis hash.)
 */
export function checkEndpointCluster(endpoints: readonly RpcEndpoint[], cluster: ClusterName): void {
  for (const e of endpoints) {
    const serves = PUBLIC_RPC_HOSTS[new URL(e.url).hostname];
    if (serves !== undefined && serves !== cluster) {
      throw new Error(`RPC endpoint ${e.url} serves ${serves}, but this build targets ${cluster}: set VITE_NOISED_CLUSTER to match (or pick another endpoint)`);
    }
  }
}

/**
 * The build-time warning for a mainnet build whose endpoint list includes Solana's public mainnet RPC, or null.
 * That endpoint refuses requests from web pages: any request carrying an Origin header gets HTTP 403 "Access
 * forbidden" (its CORS preflight passes; checked on 2026-10-13 with Origin http://127.0.0.1:5195 and
 * https://noised.fun), and it rate-limits hard. A site built with it alone cannot read mainnet in a browser: a
 * mainnet build needs a dedicated RPC that allows the site's origin, first in VITE_RPC_URL. A warning, not an error,
 * so the build itself still runs (the app then shows "Connection unavailable").
 */
export function publicMainnetRpcWarning(endpoints: readonly RpcEndpoint[], cluster: ClusterName): string | null {
  if (cluster !== "mainnet") return null;
  const pub = endpoints.filter((e) => PUBLIC_RPC_HOSTS[new URL(e.url).hostname] === "mainnet");
  if (pub.length === 0) return null;
  return `This mainnet build uses Solana's public RPC (${pub.map((e) => e.url).join(", ")}). It refuses requests from web pages (HTTP 403 for any request with an Origin header) and rate-limits, so the built site cannot read mainnet in a browser through it: set VITE_RPC_URL to a dedicated mainnet RPC that allows your site's origin (one URL, or "label=url,label=url"; the first is the default).`;
}

/**
 * The WebSocket origin web3.js 1.x opens for subscriptions: https -> wss,
 * http -> ws, and an explicit port is incremented by one
 * (`makeWebsocketUrl` in @solana/web3.js).
 */
export function websocketOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const port = url.port === "" ? "" : `:${Number(url.port) + 1}`;
  return `${scheme}//${url.hostname}${port}`;
}

export function httpOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

export interface CspOptions {
  /**
   * Allow `ws://localhost:*`: the Solana Mobile Wallet Adapter's local
   * association (Android browsers talking to an installed wallet app).
   */
  readonly allowMobileWalletAdapter: boolean;
}

export function connectSources(endpoints: readonly RpcEndpoint[], opts: CspOptions): string[] {
  const sources: string[] = [];
  const add = (s: string): void => {
    if (!sources.includes(s)) sources.push(s);
  };
  for (const e of endpoints) {
    add(httpOrigin(e.url));
    add(websocketOrigin(e.url));
  }
  if (opts.allowMobileWalletAdapter) {
    add("ws://localhost:*");
    add("ws://127.0.0.1:*");
  }
  return sources;
}

/** The full policy. Every fetch directive is explicit; nothing inline, nothing third-party. */
export function buildCsp(endpoints: readonly RpcEndpoint[], opts: CspOptions): string {
  const directives: [string, string][] = [
    ["default-src", "'none'"],
    ["script-src", "'self'"],
    ["style-src", "'self'"],
    // Wallet Standard icons are data: URIs. Token images are never fetched.
    ["img-src", "'self' data:"],
    // Bundled woff2 files only (src/assets/fonts); nothing third-party.
    ["font-src", "'self'"],
    ["connect-src", connectSources(endpoints, opts).join(" ")],
    ["media-src", "'none'"],
    ["object-src", "'none'"],
    ["frame-src", "'none'"],
    ["child-src", "'none'"],
    ["worker-src", "'none'"],
    ["manifest-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'none'"],
    // DOM XSS sinks (innerHTML, script.src, eval...) refuse plain strings.
    ["require-trusted-types-for", "'script'"],
    ["trusted-types", "'none'"],
  ];
  return directives.map(([k, v]) => `${k} ${v}`).join("; ");
}

/** Characters that would break out of the content="" attribute. */
export function assertAttributeSafe(value: string): string {
  if (/["<>&\n\r]/.test(value)) throw new Error("CSP contains characters that are unsafe in an HTML attribute");
  return value;
}
