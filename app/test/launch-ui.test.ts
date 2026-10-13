/**
 * The launch flow's screens in plain words (rendered with react-dom/server,
 * no DOM needed): the tracker's six steps and what it asks of the person
 * (approve in the wallet, a new opening time after the window passed, one
 * more signature after one that did not count, the leftover SOL), the
 * configured launch's opening status, the token's own details (a data: icon:
 * a logo drawn smoothly, 32 x 32 pixel art pixel-crisp; links as inert text
 * with the domain spelled out), the
 * verification panel's three origin lines and the fee recipients' refusals.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { TokenIcon } from "../src/components/Identicon";
import { LaunchTracker, openingProblem, stepStates } from "../src/components/launchTracker";
import { TokenAbout, tokenMetaView, verifiedTokenMeta } from "../src/components/tokenMeta";
import { formatClock } from "../src/lib/format";
import { plainError, type FlowView } from "../src/lib/launchFlow";
import { decodeTokenMeta, tokenMetaAccountData } from "@noisedlabs/sdk";

import { buildMetadataDoc, encodeIndexedPng, metadataHashV2, tokenMetaAddress, type VerificationReport } from "../src/lib/noised";
import { withRecipientCheck } from "../src/pages/create/CreatePage";
import { convertDraft, draftFromPreset, stepOfField, splitError } from "../src/pages/create/draft";
import { plainRecipientProblem } from "../src/pages/create/recipientWords";
import { OriginChecks } from "../src/pages/inner/readouts";
import { OpeningStatus } from "../src/pages/token/TokenPage";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
/** Visible text, entities decoded. */
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const NOW = Math.floor(Date.now() / 1000);

function view(over: Partial<FlowView> = {}): FlowView {
  return {
    id: "devnet:x",
    launch: Keypair.generate().publicKey,
    name: "Quantum Lantern",
    symbol: "QLTN",
    stage: "create",
    busy: false,
    activity: "",
    need: null,
    window: null,
    fundLamports: null,
    burns: [],
    mint: null,
    returned: null,
    note: null,
    autopilot: false,
    autopilotAt: null,
    done: false,
    abandoned: false,
    ...over,
  };
}

describe("the launch tracker", () => {
  it("lists the six steps in plain words, with the amount, the opening time and a countdown", () => {
    const window = { notBefore: BigInt(NOW + 125), notAfter: BigInt(NOW + 125 + 3600) };
    const t = text(html(createElement(LaunchTracker, { view: view({ stage: "open", window, fundLamports: 59_400_000n, activity: "Signed. Waiting for the opening time" }) })));
    for (const step of [
      "Create the launch",
      "Fund a temporary fee account",
      "Your wallet sends about 0.0594 SOL",
      "Store the token details on Solana",
      "Sign with your quantum key",
      "Your quantum key signs, not your wallet",
      "Anyone can open it during the hour after",
      "Return the leftover SOL",
      "Signed. Waiting for the opening time",
    ]) {
      expect(t).toContain(step);
    }
    // (The page's clock ticks once a second; it started a moment before this render.)
    expect(t).toMatch(/Opens in 02:[01]\d/);
    expect(t).toMatch(/Opens at \S/);
    // No jargon on this page.
    expect(t).not.toMatch(/attest|leaf|PDA|lamports|throwaway|LMS/i);
  });

  it("marks done, current and failed steps", () => {
    expect(stepStates(view({ stage: "publish" }))).toEqual({ create: "done", fund: "done", publish: "current", sign: "todo", open: "todo", return: "todo" });
    expect(stepStates(view({ stage: "sign", need: { kind: "new-time", closedAt: 1n } })).sign).toBe("fail");
    expect(Object.values(stepStates(view({ done: true, stage: "done" })))).toEqual(["done", "done", "done", "done", "done", "done"]);
  });

  it("asks before a wallet step, saying what the wallet will show", () => {
    const create = text(html(createElement(LaunchTracker, { view: view({ need: { kind: "go", stage: "create", lamports: null } }) })));
    expect(create).toContain("Your wallet will ask you to approve creating the launch.");
    expect(create).toContain("Continue");
    const fund = text(html(createElement(LaunchTracker, { view: view({ stage: "fund", need: { kind: "go", stage: "fund", lamports: 59_400_000n } }) })));
    expect(fund).toContain("Your wallet will ask you to send 0.0594 SOL to the temporary fee account.");
  });

  it("after the opening time passed, asks for a new one and offers to sign it (audit round 3 F1)", () => {
    const h = html(createElement(LaunchTracker, { view: view({ stage: "sign", need: { kind: "new-time", closedAt: BigInt(NOW - 10) } }) }));
    const t = text(h);
    expect(t).toContain("The opening time passed — pick a new one");
    expect(t).toContain("Opens at the new time you pick");
    expect(t).toContain("Your token's details are already stored and are reused.");
    expect(t).toContain("As soon as it's signed");
    expect(t).toContain("At a time I pick");
    expect(t).toContain("Sign the new time");
    expect(t).toContain("Stop and return the leftover SOL");
  });

  it("shows a signature that did not count honestly, and why, before one more is spent", () => {
    const t = text(
      html(
        createElement(LaunchTracker, {
          view: view({ stage: "sign", need: { kind: "sign-again", burn: { leaf: 7, reasons: ["invalid-window"], detail: "", window: { notBefore: "1", notAfter: "2" }, at: 0 } } }),
        }),
      ),
    );
    expect(t).toContain("That signature did not count");
    expect(t).toContain("less than a minute of its opening time was left when it arrived");
    expect(t).toContain("It used one of your quantum key's one-time signatures");
    expect(t).toContain("after two that do not count, the app stops to save your key");
    expect(t).toContain("Sign again");
  });

  it("says when it is open, with the way to the token and what came back", () => {
    const mint = Keypair.generate().publicKey;
    const h = html(createElement(LaunchTracker, { view: view({ stage: "done", done: true, mint, returned: 2_500_000n }) }));
    expect(text(h)).toContain("Your launch is open");
    expect(text(h)).toContain("0.0025 SOL went back to your wallet.");
    expect(h).toContain(`href="/token/${mint.toBase58()}"`);
  });

  it("refuses opening times it cannot sign: too soon, or too far", () => {
    expect(openingProblem("asap", NOW)).toBeNull();
    expect(openingProblem(BigInt(NOW + 60), NOW)).toMatch(/at least 2 minutes from now/);
    expect(openingProblem(BigInt(NOW + 3600), NOW)).toBeNull();
    expect(openingProblem(BigInt(NOW + 7 * 86_400), NOW)).toMatch(/within the next 6 days/);
  });
});

describe("plain words for the SDK's refusals", () => {
  it("says what happened, keeping the SDK's sentence for reference", () => {
    const sdkText = "refusing to sign: the launch's parameters are not the ones reviewed (params_hash differs); never sign a configuration you did not check";
    expect(plainError(new Error(sdkText))).toBe(`The launch's rules on Solana are not the ones you reviewed, so your quantum key did not sign. Nothing was signed. (${sdkText})`);
    expect(plainError(new Error("refusing to sign: this identity... every leaf of this identity is used: move to the next identity index"))).toMatch(/^Your quantum key has used all its one-time signatures/);
    expect(plainError(new Error("something else"))).toBe("something else");
  });

  it("counts down as a clock", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(754)).toBe("12:34");
    expect(formatClock(3_725)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("a configured launch's opening", () => {
  it("waits for its quantum signature, counts down, and asks for a new time when it passed", () => {
    expect(text(html(createElement(OpeningStatus, { state: { kind: "unsigned" }, now: NOW, mine: false })))).toContain("Waiting for its quantum signature");
    expect(text(html(createElement(OpeningStatus, { state: { kind: "burned" }, now: NOW, mine: false })))).toContain("Waiting for its quantum signature");
    expect(text(html(createElement(OpeningStatus, { state: { kind: "soon", opensAt: BigInt(NOW + 754), closesAt: BigInt(NOW + 4354) }, now: NOW, mine: false })))).toContain("Opens in 12:34");
    const theirs = text(html(createElement(OpeningStatus, { state: { kind: "missed", closedAt: BigInt(NOW - 5) }, now: NOW, mine: false })));
    expect(theirs).toContain("The opening time passed — pick a new one");
    expect(theirs).toContain("can sign a new opening time");
    expect(text(html(createElement(OpeningStatus, { state: { kind: "missed", closedAt: BigInt(NOW - 5) }, now: NOW, mine: true })))).toContain("your quantum key signs it");
  });
});

describe("the token's own details", () => {
  it("draws its icon from the record's data URI (a logo smooth, pixel art crisp), and never a remote image", async () => {
    const png = await encodeIndexedPng(new Uint8Array(32 * 32 * 4).fill(255), 32, 32, 16);
    const launch = Keypair.generate().publicKey;
    const input = { name: "Icon", symbol: "ICN", doc: buildMetadataDoc({ name: "Icon", symbol: "ICN", iconPng: png, description: "Hello", links: { website: "https://example.org/a", x: "https://x.com/icn" } }) };
    const record = decodeTokenMeta(tokenMetaAddress(launch, metadataHashV2(input)), tokenMetaAccountData(launch, input));
    const meta = tokenMetaView(record);
    expect(meta.icon?.dataUri.startsWith("data:image/png;base64,")).toBe(true);
    const img = html(createElement(TokenIcon, { address: launch, image: meta.icon?.dataUri ?? null, size: 64 }));
    // 32 x 32 pixel art keeps its square pixels...
    expect(img).toMatch(/<img class="tk-face tk-img" data-pixel="" src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="64" height="64"/);
    // ...an uploaded logo (64 x 64) scales smoothly.
    const logo = await encodeIndexedPng(new Uint8Array(64 * 64 * 4).fill(200), 64, 64, 256);
    const logoInput = { name: "Logo", symbol: "LGO", doc: buildMetadataDoc({ name: "Logo", symbol: "LGO", iconPng: logo }) };
    const logoMeta = tokenMetaView(decodeTokenMeta(tokenMetaAddress(launch, metadataHashV2(logoInput)), tokenMetaAccountData(launch, logoInput)));
    expect(logoMeta.icon?.width).toBe(64);
    expect(html(createElement(TokenIcon, { address: launch, image: logoMeta.icon?.dataUri ?? null, size: 64 }))).toMatch(/<img class="tk-face tk-img" src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="64" height="64"/);
    // Anything but a data: PNG is drawn as the pixel coin instead.
    expect(html(createElement(TokenIcon, { address: launch, image: "https://example.org/x.png", size: 64 }))).not.toMatch(/<img/);
    // Links are text with their domain spelled out: nothing is clickable or loaded.
    const about = html(createElement(TokenAbout, { meta }));
    expect(about).not.toMatch(/<a\b|href=/);
    expect(text(about)).toContain("Hello");
    expect(text(about)).toContain("Website example.org https://example.org/a");
    expect(text(about)).toContain("X x.com https://x.com/icn");
  });

  it("before launch, shows a record only when its attestation re-verified", () => {
    const launch = Keypair.generate().publicKey;
    const input = { name: "Up", symbol: "UP" };
    const record = decodeTokenMeta(tokenMetaAddress(launch, metadataHashV2(input)), tokenMetaAccountData(launch, input));
    expect(verifiedTokenMeta({ verified: true, tokenMeta: record })?.name).toBe("Up");
    expect(verifiedTokenMeta({ verified: false, tokenMeta: record })).toBeNull();
    expect(verifiedTokenMeta({ verified: true, tokenMeta: null })).toBeNull();
  });

  it("shows nothing of a document part with a problem", () => {
    const launch = Keypair.generate().publicKey;
    const input = { name: "Bad", symbol: "BAD", doc: '{"name":"Bad","symbol":"BAD","image":"data:image/png;base64,AAAA","external_url":"http://plain.example"}' };
    const record = decodeTokenMeta(tokenMetaAddress(launch, metadataHashV2(input)), tokenMetaAccountData(launch, input));
    const meta = tokenMetaView(record);
    expect(meta.icon).toBeNull();
    expect(meta.links).toEqual([]);
  });
});

describe("the verification panel's origin lines", () => {
  const report = (statuses: Record<string, "pass" | "warn" | "fail">): VerificationReport =>
    ({
      checks: Object.entries(statuses).map(([id, status]) => ({ id, status, label: id, detail: `${id} detail` })),
    }) as unknown as VerificationReport;

  it("says it in three plain lines, from the live checks", () => {
    const ok = text(html(createElement(OriginChecks, { report: report({ "pq.origin": "pass", "metadata.onchain": "pass", "metadata.match": "pass", "metadata.icon": "pass" }) })));
    expect(ok).toContain("Signed with a quantum-safe key");
    expect(ok).toContain("Details stored on Solana");
    expect(ok).toContain("Name, symbol and icon match");
    const bad = html(createElement(OriginChecks, { report: report({ "pq.origin": "pass", "metadata.onchain": "pass", "metadata.match": "fail", "metadata.icon": "pass" }) }));
    expect(text(bad)).toContain("metadata.match detail");
  });
});

describe("the fee recipients' refusals (audit round 3, F3)", () => {
  it("says why a quantum vault of another token cannot receive the fees", () => {
    const reason = `a PQ vault of another mint (${new PublicKey(new Uint8Array(32).fill(9)).toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`;
    expect(plainRecipientProblem(reason)).toMatch(/^This is a quantum vault for another token\. .* its share of the fees would be stuck forever/);
    expect(plainRecipientProblem("something new")).toBe("Something new");
  });

  it("counts a refused recipient as a problem of its wallet field, on the fees step, in plain words", () => {
    const vault = Keypair.generate().publicKey;
    const conv = convertDraft({ ...draftFromPreset("fair"), name: "A", symbol: "B", recipients: [{ wallet: vault.toBase58(), pct: "100" }] }, new Uint8Array(32).fill(1), null);
    const reason = `a PQ vault of another mint (${Keypair.generate().publicKey.toBase58()}): a vault only releases its own mint, so these tokens would be stuck forever`;
    const checked = withRecipientCheck(conv, { ok: false, refusals: [`recipients[0].wallet: ${reason}`], warnings: [] });
    const added = checked.policyErrors.filter((e) => !conv.policyErrors.includes(e));
    expect(added).toEqual([`recipients[0].wallet: ${plainRecipientProblem(reason)}`]);
    expect(stepOfField(splitError(added[0] ?? "").field)).toBe("recipients");
    expect(withRecipientCheck(conv, { ok: true, refusals: [], warnings: ["recipients[0].wallet: an off-curve account of program X: only that program can move what its token account receives"] })).toBe(conv);
  });
});
