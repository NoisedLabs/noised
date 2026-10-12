/**
 * Post-build guards: the build fails if the emitted site could load anything
 * the CSP is meant to forbid, or if the CSP itself is missing. Pure functions
 * (unit-tested in test/csp.test.ts); vite.config.ts runs them on the bundle.
 */

const CSP_META_RE = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi;

export function findCspMeta(html: string): string[] {
  return [...html.matchAll(CSP_META_RE)].map((m) => m[1] ?? "");
}

/** Problems with the emitted index.html (empty array = fine). */
export function checkHtml(html: string, expectedCsp: string): string[] {
  const problems: string[] = [];
  const csp = findCspMeta(html);
  if (csp.length !== 1) problems.push(`expected exactly one CSP meta tag, found ${csp.length}`);
  else if (csp[0] !== expectedCsp) problems.push("CSP meta tag does not match the configured policy");

  const head = html.slice(0, Math.max(0, html.search(/<\/head>/i)));
  const cspAt = head.search(/http-equiv="Content-Security-Policy"/i);
  const firstLoad = head.search(/<(script|link)\b/i);
  if (cspAt < 0 || (firstLoad >= 0 && firstLoad < cspAt)) {
    problems.push("CSP meta tag must come before every <script> and <link> element");
  }

  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    if (!/\bsrc\s*=/.test(attrs)) problems.push("inline <script> element found");
    else if (/\bsrc\s*=\s*"(?:https?:)?\/\//i.test(attrs)) problems.push("<script> loads from another origin");
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bhref\s*=\s*"(?:https?:)?\/\//i.test(attrs)) problems.push("<link> loads from another origin");
  }
  if (/<style\b/i.test(html)) problems.push("inline <style> element found");
  if (/\sstyle\s*=/i.test(html)) problems.push("inline style attribute found");
  if (/\son[a-z]+\s*=/i.test(html)) problems.push("inline event handler attribute found");
  return problems;
}

/** Hosts the bundle must never reference: third-party fonts (and the requests a preconnect hint would make). */
export const FORBIDDEN_JS_HOSTS: readonly string[] = ["fonts.googleapis.com", "fonts.gstatic.com"];

/** Problems with one emitted JavaScript chunk. */
export function checkJs(code: string): string[] {
  return FORBIDDEN_JS_HOSTS.filter((h) => code.includes(h)).map((h) => `JavaScript references ${h}`);
}

/**
 * Strings that only the simulated-chain backend (src/lib/mock) contains: its
 * localStorage key and its demo-key derivation label. A live build must not
 * contain them, so a production bundle can never run the mock.
 */
// "phalanx-demo/": the simulated chain's derivation tag, kept from the original name (lib/mock)
export const MOCK_MARKERS: readonly string[] = ["noised.demo-chain.", "phalanx-demo/"];

/** Problems with one chunk of a live (non-mock) build. */
export function checkNoMock(code: string): string[] {
  return MOCK_MARKERS.filter((m) => code.includes(m)).map((m) => `live bundle contains simulated-chain code ("${m}")`);
}

/**
 * The Solana Mobile Wallet Adapter's embedded modal injects Google Fonts
 * links (`const fonts = \`<link ... fonts.googleapis.com ...>\``). Replace that
 * literal with an empty one so the bundle can never even preconnect to a
 * third party. Bundlers may rewrite the declaration: Vite's dev-server
 * dependency pre-bundling emits `var fonts = ...`, and a bundler can rename
 * the binding (`fonts$1`, `fonts2`), so any `const`/`let`/`var fonts*`
 * template literal is matched. Returns null when the module needs no change;
 * throws if the module references the font host in a shape this patch does
 * not know (fail closed: the output check would reject the bundle anyway).
 */
export function stripThirdPartyFonts(code: string): string | null {
  if (!FORBIDDEN_JS_HOSTS.some((h) => code.includes(h))) return null;
  const patched = code.replace(/\b(const|let|var)(\s+)(fonts[\w$]*)(\s*=\s*)`[^`]*`;/g, (m, kw: string, gap: string, name: string, eq: string) =>
    FORBIDDEN_JS_HOSTS.some((h) => m.includes(h)) ? `${kw}${gap}${name}${eq}\`\`;` : m,
  );
  if (FORBIDDEN_JS_HOSTS.some((h) => patched.includes(h))) throw new Error("a dependency references third-party fonts in an unexpected way");
  return patched;
}

/** Problems with one emitted CSS file. */
export function checkCss(css: string): string[] {
  const problems: string[] = [];
  if (/@import\b/i.test(css)) problems.push("CSS @import found");
  for (const m of css.matchAll(/url\(\s*['"]?([^'")\s]*)/gi)) {
    const target = (m[1] ?? "").toLowerCase();
    if (target.startsWith("http:") || target.startsWith("https:") || target.startsWith("//")) {
      problems.push(`CSS references an external resource: ${m[1] ?? ""}`);
    }
  }
  return problems;
}
