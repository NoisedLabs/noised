// Dependency-free local browser QA. Uses installed Chrome; never submits real transactions.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const url = process.env.NOISED_QA_URL ?? process.env.PHALANX_QA_URL ?? "http://127.0.0.1:5177/";
const out = resolve(process.env.NOISED_QA_DIR ?? process.env.PHALANX_QA_DIR ?? `${tmpdir()}/noised-terminal-qa`);
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(`${out}/chrome-`);
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = Number(process.env.NOISED_CDP_PORT ?? process.env.PHALANX_CDP_PORT ?? 9358);
const proc = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
const errors = [];
let ws;
let seq = 0;
const waiting = new Map();
const send = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  waiting.set(id, { accept, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression) => {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(250); }
  throw new Error(`UI condition failed: ${expression}`);
};
const click = async (selector) => {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await delay(250);
};
const type = async (selector, value) => {
  await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  await delay(200);
};
const navigate = async (route) => {
  await send("Page.navigate", { url: `${url}#/${route}` });
  await waitFor("document.querySelector('main h1') !== null");
  await delay(500);
};
const screenshot = async (name) => {
  await evaluate("document.fonts.ready");
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${out}/${name}.png`, Buffer.from(data, "base64"));
};
const assert = (value, message) => { if (!value) throw new Error(message); };

try {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (target) break;
    await delay(200);
  }
  if (!target) throw new Error("Chrome did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (m.id && waiting.has(m.id)) { const p = waiting.get(m.id); waiting.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.accept(m.result); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1060, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('noised.theme','dark'); localStorage.setItem('noised.sound','off');" });
  await navigate("");
  await waitFor("document.querySelectorAll('.terminal-row-open').length > 0");
  assert(await evaluate("document.querySelector('.terminal-statusbar').textContent.includes('SIMULATION')"), "Browser transaction tests require the simulated build");
  await waitFor("document.querySelector('.terminal-dot-field canvas')?.dataset.ready === 'true'");
  const movingFrame = await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()");
  await delay(400);
  assert(movingFrame !== await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()"), "Dot field is not animating");
  await click(".terminal-motion-toggle");
  const pausedFrame = await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()");
  assert(await evaluate("document.querySelector('.terminal-shell').dataset.motion === 'paused' && getComputedStyle(document.querySelector('.terminal-activity-glyph')).animationPlayState === 'paused'"), "Ambient pause did not stop CSS motion");
  await delay(300);
  assert(pausedFrame === await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()"), "Pause control did not stop the dot field");
  await click(".terminal-motion-toggle");
  await delay(300);
  assert(pausedFrame !== await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()"), "Play control did not resume the dot field");
  assert(await evaluate("document.querySelector('.terminal-phase-track').getAttribute('aria-label').includes('opening')"), "Launch activity is not labelled");
  await waitFor("![...document.querySelectorAll('.terminal-verification')].some(e => e.textContent.includes('CHECKING'))");
  await screenshot("desktop-dark");
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "Desktop horizontal overflow");
  await click(".terminal-text-link");
  assert(await evaluate("location.hash === '#/' || location.hash === ''"), "Explore link changed the router path");
  await type("#launch-search", "Aegis");
  assert(await evaluate("document.querySelectorAll('.terminal-row-open').length === 1"), "Name filtering failed");
  await click(".terminal-command button");
  await waitFor("document.querySelector('#launch-search-error') !== null");
  await type("#launch-search", "");
  await evaluate("[...document.querySelectorAll('.terminal-filters button')].find(e => e.textContent.includes('Opening now')).click()");
  await delay(200);
  assert(await evaluate("[...document.querySelectorAll('.terminal-phase')].every(e => ['commit','execute'].includes(e.dataset.phase))"), "Phase filtering failed");
  await click(".terminal-filters button:first-child");
  await click(".terminal-row-open");
  await waitFor("document.querySelector('main h1') && !document.querySelector('.terminal-hero')");
  await screenshot("token-detail");
  await navigate("create");
  await evaluate("[...document.querySelectorAll('button')].find(e => e.textContent.includes('Next: Token')).click()");
  await waitFor("document.querySelectorAll('main input').length >= 3");
  await screenshot("create-token");
  await click(".terminal-nav-actions .btn");
  await waitFor("document.querySelector('dialog[open]') !== null");
  await evaluate("[...document.querySelectorAll('dialog button')].find(e => e.textContent.includes('demo account')).click()");
  await waitFor("document.querySelector('.terminal-nav-actions').textContent.includes('demo')");
  await navigate("shield");
  await waitFor("document.querySelector('#shield-pick option:nth-child(2)') !== null");
  await evaluate("(() => { const e = document.querySelector('#shield-pick'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, e.options[1].value); e.dispatchEvent(new Event('change', {bubbles: true})); })()");
  await delay(500);
  await screenshot("privacy");
  await navigate("vault");
  await screenshot("vault");
  await navigate("");
  await waitFor("document.querySelectorAll('.terminal-row-open').length > 0");
  await click(".terminal-theme");
  assert(await evaluate("document.documentElement.dataset.theme === 'light'"), "Paper theme failed");
  await screenshot("desktop-light");
  await click(".terminal-theme");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.scrollTo(0,0)");
  await delay(300);
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile horizontal overflow");
  await screenshot("mobile-dark");
  for (const width of [320, 768]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: true });
    await delay(200);
    await screenshot(`responsive-${width}`);
    assert(await evaluate(`document.documentElement.scrollWidth <= ${width}`), `Horizontal overflow at ${width}px`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click(".terminal-menu");
  await waitFor("document.querySelector('#mobile-nav') !== null");
  await click("#mobile-nav a[href='#/create']");
  await waitFor("document.querySelector('.terminal-page-heading') !== null && document.querySelector('#mobile-nav') === null");
  await screenshot("mobile-create");
  await navigate("");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await waitFor("document.querySelector('.terminal-motion-toggle')?.disabled === true");
  const frame = await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()");
  await delay(300);
  assert(frame === await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()"), "Reduced motion did not stop dot animation");
  assert(await evaluate("document.querySelector('.terminal-motion-toggle').disabled"), "Reduced motion preference did not disable playback");
  assert(await evaluate("getComputedStyle(document.querySelector('.terminal-cross')).animationName === 'none'"), "Reduced motion did not disable crosshair animation");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await waitFor("document.querySelector('.terminal-motion-toggle')?.disabled === false");
  await delay(300);
  assert(frame !== await evaluate("document.querySelector('.terminal-dot-field canvas').toDataURL()"), "Dot animation did not resume after preference changed");
  assert(errors.length === 0, errors.join("\n"));
  console.log(JSON.stringify({ result: "PASS", checks: ["desktop", "mobile and tablet", "animated dots", "global ambient pause and resume", "launch activity", "search", "invalid address", "animated phase filters", "token page", "create wizard", "demo wallet", "privacy", "vault", "light theme", "mobile navigation", "reduced motion", "no runtime errors"], screenshots: out }));
} finally {
  ws?.close();
  proc.kill();
  await delay(800);
  const child = relative(out, resolve(profile));
  if (child && !child.startsWith("..") && !isAbsolute(child)) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
