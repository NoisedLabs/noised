#!/usr/bin/env node
/**
 * Prints the in-app whitepaper (#/whitepaper) to app/public/noised-whitepaper.pdf with headless Chrome
 * (Chrome DevTools Protocol Page.printToPDF), using the page's own print stylesheet (src/pages/whitepaper/whitepaper.css).
 * No dependencies: Node >= 22 (global WebSocket and fetch).
 *
 *   node scripts/whitepaper-pdf.mjs [--url http://127.0.0.1:5175/] [--out public/noised-whitepaper.pdf]
 *
 * Point --url at a running dev server or a served build (vite preview --port 5175 --strictPort); the default is a
 * port of its own, never another project's server. Environment:
 *   CHROME        path to Chrome / Chromium (default: the usual install locations)
 *   NOISED_TMP   directory for the throwaway Chrome profile (default: the OS temp directory)
 *   CDP_PORT      remote-debugging port (default 9433)
 *
 * The page is loaded with prefers-reduced-motion: reduce (every figure renders its final, static state at once) and
 * the light theme, laid out at the A4 text width, and printed once every computed figure reports it is done.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = arg("url", "http://127.0.0.1:5175/");
const out = resolve(arg("out", join(here, "..", "public", "noised-whitepaper.pdf")));
const port = Number(process.env.CDP_PORT ?? 9433);

const CANDIDATES = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("Chrome not found: set CHROME to its path");

// A4 at 96 dpi is 793.7 x 1122.5 px; @page margins are 15 mm left and right, so the text block is 180 mm = 680 px.
const TEXT_WIDTH = 680;

const profileRoot = process.env.NOISED_TMP ?? process.env.PHALANX_TMP ?? tmpdir();
mkdirSync(profileRoot, { recursive: true });
const profile = mkdtempSync(join(profileRoot, "noised-pdf-"));
const proc = spawn(
  chrome,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${TEXT_WIDTH},1123`, "about:blank"],
  { stdio: "ignore" },
);

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(150);
  }
  throw new Error("Chrome did not open a debugging target");
}

const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
const problems = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else ok(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
});
const send = (method, params = {}) =>
  new Promise((ok, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: ok, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: TEXT_WIDTH, height: 1123, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { media: "print", features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("noised.theme", "light"); sessionStorage.setItem("noised.boot", "1"); } catch {}`,
  });
  const target = `${url.replace(/#.*$/, "")}#/whitepaper`;
  await send("Page.navigate", { url: target });

  // Wait for the paper, its fonts and every computed figure.
  const started = Date.now();
  for (;;) {
    const state = await evaluate(`(async () => {
      if (!document.querySelector(".wp-article")) return "loading";
      await document.fonts.ready;
      if (document.querySelector('[data-wp-compute="running"]')) return "computing";
      return "ready";
    })()`);
    if (state === "ready") break;
    if (Date.now() - started > 90_000) throw new Error(`whitepaper not ready after 90 s (state: ${state})`);
    await sleep(400);
  }
  await sleep(1200);

  const footer = `<div style="width:100%;padding:0 15mm;font:7.5px Helvetica,Arial,sans-serif;color:#666;display:flex;justify-content:space-between"><span>Noised: the quantum security layer for Solana</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  const { data } = await send("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: footer,
    generateDocumentOutline: true,
    generateTaggedPDF: true,
  });
  const pdf = Buffer.from(data, "base64");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pdf);
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const sha = createHash("sha256").update(pdf).digest("hex");
  console.log(`wrote ${out}: ${pdf.length.toLocaleString("en-US")} bytes, ${pages} pages, sha256 ${sha}`);
  if (problems.length > 0) console.warn(`page exceptions:\n  ${problems.join("\n  ")}`);
} finally {
  try {
    ws.close();
  } catch {
    // already closed
  }
  proc.kill();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold files for a moment; the profile is in a temp directory.
  }
}
