import { describe, expect, it } from "vitest";

import { buildCsp, checkEndpointCluster, connectSources, parseCluster, parseMockFlag, parseRpcEndpoints, publicMainnetRpcWarning, websocketOrigin } from "../build/csp";
import { checkCss, checkHtml, checkJs, checkNoMock, stripThirdPartyFonts } from "../build/output-checks";

describe("backend flag", () => {
  it("builds the live SDK backend unless VITE_NOISED_MOCK is exactly 1", () => {
    expect(parseMockFlag(undefined)).toBe(false);
    expect(parseMockFlag("")).toBe(false);
    expect(parseMockFlag("0")).toBe(false);
    expect(parseMockFlag("1")).toBe(true);
    expect(() => parseMockFlag("true")).toThrow(/VITE_NOISED_MOCK/);
    expect(() => parseMockFlag("yes")).toThrow();
  });

  it("a live bundle containing the simulated chain fails the build", () => {
    expect(checkNoMock("const x = 1;")).toEqual([]);
    expect(checkNoMock('localStorage.getItem("noised.demo-chain.v2")')).toHaveLength(1);
    expect(checkNoMock("sha256(utf8(`phalanx-demo/${label}`))")).toHaveLength(1);
  });
});

describe("RPC endpoint configuration", () => {
  it("VITE_RPC_URL takes a single URL", () => {
    expect(parseRpcEndpoints("https://my-rpc.example.com/?api-key=k", "mainnet")).toEqual([{ label: "my-rpc.example.com", url: "https://my-rpc.example.com/?api-key=k" }]);
    expect(parseRpcEndpoints(undefined, "devnet")).toEqual([{ label: "api.devnet.solana.com", url: "https://api.devnet.solana.com/" }]);
  });

  it("refuses a public endpoint of another cluster than the build targets", () => {
    expect(() => checkEndpointCluster(parseRpcEndpoints("https://api.mainnet-beta.solana.com", "devnet"), "devnet")).toThrow(/serves mainnet/);
    expect(() => checkEndpointCluster(parseRpcEndpoints("https://api.devnet.solana.com", "mainnet"), "mainnet")).toThrow(/serves devnet/);
    expect(() => checkEndpointCluster(parseRpcEndpoints("https://api.testnet.solana.com", "devnet"), "devnet")).toThrow(/serves testnet/);
    expect(() => checkEndpointCluster(parseRpcEndpoints("https://api.devnet.solana.com", "devnet"), "devnet")).not.toThrow();
    // Private endpoints are checked at runtime by their genesis hash.
    expect(() => checkEndpointCluster(parseRpcEndpoints("https://rpc.example.com", "mainnet"), "mainnet")).not.toThrow();
  });

  it("warns when a mainnet build uses Solana's public mainnet RPC (it refuses web pages: a dedicated one is needed)", () => {
    // The default endpoint of a mainnet build is the public one: it builds, with a warning.
    const def = parseRpcEndpoints(undefined, "mainnet");
    expect(def).toEqual([{ label: "api.mainnet-beta.solana.com", url: "https://api.mainnet-beta.solana.com/" }]);
    expect(publicMainnetRpcWarning(def, "mainnet")).toMatch(/refuses requests from web pages/);
    expect(publicMainnetRpcWarning(def, "mainnet")).toMatch(/public RPC .*api\.mainnet-beta\.solana\.com.*VITE_RPC_URL/);
    // Listed next to a dedicated one, still a warning (it may be picked in the footer).
    expect(publicMainnetRpcWarning(parseRpcEndpoints("main=https://rpc.example.com,public=https://api.mainnet-beta.solana.com", "mainnet"), "mainnet")).not.toBeNull();
    // A dedicated endpoint only, or another cluster: no warning.
    expect(publicMainnetRpcWarning(parseRpcEndpoints("https://rpc.example.com/?api-key=k", "mainnet"), "mainnet")).toBeNull();
    expect(publicMainnetRpcWarning(parseRpcEndpoints(undefined, "devnet"), "devnet")).toBeNull();
    expect(publicMainnetRpcWarning(parseRpcEndpoints(undefined, "localnet"), "localnet")).toBeNull();
  });

  it("defaults to the cluster's public endpoint (devnet unless chosen)", () => {
    expect(parseCluster(undefined)).toBe("devnet");
    expect(parseCluster("mainnet-beta")).toBe("mainnet");
    expect(() => parseCluster("testnet")).toThrow();
    expect(parseRpcEndpoints("", "mainnet")).toEqual([{ label: "api.mainnet-beta.solana.com", url: "https://api.mainnet-beta.solana.com/" }]);
  });

  it("accepts labelled https endpoints and loopback http only", () => {
    const e = parseRpcEndpoints("Main=https://rpc.example.com/path?api-key=x, http://127.0.0.1:8899", "localnet");
    expect(e.map((x) => x.label)).toEqual(["Main", "127.0.0.1:8899"]);
    expect(() => parseRpcEndpoints("http://rpc.example.com", "mainnet")).toThrow(/https/);
    expect(() => parseRpcEndpoints("https://user:pw@rpc.example.com", "mainnet")).toThrow(/credentials/);
    expect(() => parseRpcEndpoints("https://rpc.example.com/#x", "mainnet")).toThrow(/fragment/);
    expect(() => parseRpcEndpoints("javascript:alert(1)", "mainnet")).toThrow();
    expect(() => parseRpcEndpoints("Bad<label>=https://rpc.example.com", "mainnet")).toThrow(/label/);
  });

  it("derives the websocket origin like web3.js (port + 1)", () => {
    expect(websocketOrigin("https://rpc.example.com/x")).toBe("wss://rpc.example.com");
    expect(websocketOrigin("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8900");
  });
});

describe("Content-Security-Policy", () => {
  const endpoints = parseRpcEndpoints("https://rpc.example.com", "mainnet");

  it("allows only self scripts/styles and the configured RPC for connections", () => {
    const csp = buildCsp(endpoints, { allowMobileWalletAdapter: false });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src https://rpc.example.com wss://rpc.example.com;");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).not.toMatch(/unsafe-(inline|eval)/);
    expect(connectSources(endpoints, { allowMobileWalletAdapter: true })).toContain("ws://localhost:*");
  });

  it("allows only bundled fonts and no media files or workers (sound is synthesized)", () => {
    const csp = buildCsp(endpoints, { allowMobileWalletAdapter: false });
    expect(csp).toContain("font-src 'self';");
    expect(csp).toContain("img-src 'self' data:;");
    expect(csp).toContain("media-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("trusted-types 'none'");
    expect(csp).not.toMatch(/font-src[^;]*(https?:|data:|\*)/);
  });
});

describe("post-build output checks", () => {
  const csp = "default-src 'none'";
  const good = `<!doctype html><html><head><meta charset="UTF-8" />\n<meta http-equiv="Content-Security-Policy" content="${csp}" />\n<script type="module" crossorigin src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css"></head><body><div id="root"></div></body></html>`;

  it("accepts a clean page", () => {
    expect(checkHtml(good, csp)).toEqual([]);
  });

  it("rejects inline code, external resources and a missing or misplaced CSP", () => {
    expect(checkHtml(good.replace("</body>", "<script>alert(1)</script></body>"), csp)).toContain("inline <script> element found");
    expect(checkHtml(good.replace("./assets/index.js", "https://cdn.example.com/x.js"), csp)).toContain("<script> loads from another origin");
    expect(checkHtml(good.replace('<div id="root">', '<div id="root" style="color:red">'), csp)).toContain("inline style attribute found");
    expect(checkHtml(good.replace('<div id="root">', '<div id="root" onclick="x()">'), csp)).toContain("inline event handler attribute found");
    expect(checkHtml(good.replace(/<meta http-equiv[^>]*>/, ""), csp)[0]).toMatch(/exactly one CSP/);
    expect(checkHtml(good, "default-src 'self'")).toContain("CSP meta tag does not match the configured policy");
    const late = good.replace(/<meta http-equiv[^>]*>\n/, "").replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${csp}" /></head>`);
    expect(checkHtml(late, csp)).toContain("CSP meta tag must come before every <script> and <link> element");
  });

  it("rejects CSS that imports or references remote resources", () => {
    expect(checkCss(".a{color:red}")).toEqual([]);
    expect(checkCss("@import url('https://fonts.googleapis.com/css2?family=DM+Sans');")).toHaveLength(2);
    expect(checkCss(".a{background:url(//evil.example/x.png)}")).toHaveLength(1);
    expect(checkCss(".a{background:url(data:image/svg+xml;base64,AAAA)}")).toEqual([]);
  });
});

describe("third-party fonts", () => {
  const MODULE = "const css = `a{}`;\nconst fonts = `\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Inter+Tight\" rel=\"stylesheet\">\n`;\nvar X = 1;";

  it("strips the mobile wallet adapter's Google Fonts links and leaves other code alone", () => {
    expect(stripThirdPartyFonts("const a = 1;")).toBeNull();
    const patched = stripThirdPartyFonts(MODULE);
    expect(patched).toBe("const css = `a{}`;\nconst fonts = ``;\nvar X = 1;");
    expect(checkJs(patched ?? "")).toEqual([]);
  });

  it("also strips the declaration shapes bundlers emit (dev pre-bundling uses var; bindings can be renamed)", () => {
    const links = "`\n<link href=\"https://fonts.googleapis.com/css2?family=Inter+Tight\" rel=\"stylesheet\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n`";
    expect(stripThirdPartyFonts(`var fonts = ${links};\nvar EmbeddedModal = class {};`)).toBe("var fonts = ``;\nvar EmbeddedModal = class {};");
    expect(stripThirdPartyFonts(`let fonts$1 = ${links};`)).toBe("let fonts$1 = ``;");
    expect(stripThirdPartyFonts(`const fonts2=${links};`)).toBe("const fonts2=``;");
    // A font template literal bound to another name is still an unknown shape.
    expect(() => stripThirdPartyFonts(`var links = ${links};`)).toThrow(/unexpected/);
  });

  it("fails closed on references it does not know and flags them in the bundle", () => {
    expect(() => stripThirdPartyFonts("load('https://fonts.gstatic.com/x.woff2')")).toThrow(/unexpected/);
    expect(() => stripThirdPartyFonts('const fonts = "https://fonts.googleapis.com/css2";')).toThrow(/unexpected/);
    expect(checkJs("x='https://fonts.googleapis.com'")).toEqual(["JavaScript references fonts.googleapis.com"]);
  });
});
