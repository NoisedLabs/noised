/**
 * The developer docs (/docs): the generated reference covers every SDK export and every program instruction,
 * error and event; every internal link and anchor resolves; every page renders; the docs search finds the
 * things people look for. `pnpm test` regenerates the reference first (scripts/gen-docs-reference.mjs); run it by
 * hand (`pnpm docs:reference`) when running vitest directly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { parseDoc, parseInline, slugify, type Block } from "../src/content/docs/markdown";
import { DOC_PAGES, DOC_SECTIONS, findDocPage, PROGRAMS, programHeadings, SDK_REFERENCE } from "../src/content/docs/nav";
import { searchDocs } from "../src/content/docs/search";
import { FIGURE_NAMES } from "../src/pages/docs/figures";
import { Blocks, DocSlug } from "../src/pages/docs/Markdown";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : rustFiles(path);
    return name.endsWith(".rs") && !name.endsWith("_tests.rs") ? [path] : [];
  });
}

const PROGRAM_DIRS: Record<string, string> = {
  launchpad: "programs/noised-launchpad",
  hook: "programs/noised-hook",
  vault: "programs/noised-vault",
  shield: "programs/noised-shield",
  autopilot: "programs/noised-autopilot",
};

describe("generated reference", () => {
  it("documents every export of the SDK", () => {
    const index = readFileSync(join(REPO, "sdk/src/index.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const names = new Set<string>();
    for (const m of index.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
      for (const part of (m[1] ?? "").split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    for (const m of index.matchAll(/export\s+\*\s+as\s+(\w+)/g)) if (m[1]) names.add(m[1]);
    expect(names.size).toBeGreaterThan(150);
    const documented = new Set(SDK_REFERENCE.entries.map((e) => e.name));
    expect([...names].filter((n) => !documented.has(n))).toEqual([]);
    const groups = new Set(SDK_REFERENCE.groups.map((g) => g.id));
    expect(SDK_REFERENCE.entries.filter((e) => !groups.has(e.group)).map((e) => e.name)).toEqual([]);
  });

  it("files every SDK module under its own reference group, not a fallback", () => {
    // A module without a group falls back by directory (sdk/src/metadata/* landed under "Types" that way).
    const home: Record<string, string> = {
      "launch/flow": "launch-flow",
      "launch/window": "launch-flow",
      "metadata/doc": "metadata",
      "metadata/png": "metadata",
      "metadata/publish": "metadata",
      "metadata/record": "metadata",
      "pq/attest": "pq-identity",
      // SDK 0.9.0 (audit 4): the signing lock and the cap on unlanded signatures; the clock check.
      "pq/signGuard": "pq-identity",
      "rpc/clock": "rpc",
      "pq/lmsPublic": "pq-identity",
      "pq/lmotsPublic": "pq-lmots",
      "pq/vaultLedger": "pq-vault",
      "pq/withdrawMessage": "pq-vault",
      "pq/ledgerLock": "pq-keys",
      "programmable/rules/model": "rules",
      "programmable/rules/evaluate": "rules",
      "programmable/cond/when": "rules",
      "programmable/graph/model": "graphs",
      "programmable/graph/simulate": "graphs",
      "programmable/templates": "graphs",
      "programmable/autopilot/logic": "autopilot-logic",
      "autopilot/accounts": "autopilot",
      "autopilot/builders": "autopilot",
      "programmable/units": "programmable",
      "programmable/errors": "programmable",
    };
    const misfiled = SDK_REFERENCE.entries.filter((e) => e.module in home && e.group !== home[e.module]).map((e) => `${e.module}: ${e.name} in ${e.group}`);
    expect(misfiled).toEqual([]);
    for (const module of Object.keys(home)) expect(SDK_REFERENCE.entries.some((e) => e.module === module), module).toBe(true);
    // The catch-all groups hold only their own modules.
    expect(SDK_REFERENCE.entries.filter((e) => e.group === "types" && e.module !== "types").map((e) => `${e.module}: ${e.name}`)).toEqual([]);
    expect(SDK_REFERENCE.entries.filter((e) => e.group === "pq-keys" && !["pq/keys", "pq/ledgerLock"].includes(e.module)).map((e) => `${e.module}: ${e.name}`)).toEqual([]);
    expect(SDK_REFERENCE.entries.filter((e) => e.group === "launch-params" && !e.module.startsWith("launch/")).map((e) => e.name)).toEqual([]);
    expect(SDK_REFERENCE.entries.filter((e) => e.group === "launch-params" && ["launch/flow", "launch/window"].includes(e.module)).map((e) => e.name)).toEqual([]);
  });

  for (const [slug, dir] of Object.entries(PROGRAM_DIRS)) {
    it(`documents every instruction, error and event of ${dir}`, () => {
      const p = PROGRAMS.find((x) => x.slug === slug);
      expect(p).toBeDefined();
      if (!p) return;
      const src = rustFiles(join(REPO, dir, "src"))
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      const lib = readFileSync(join(REPO, dir, "src/lib.rs"), "utf8");
      const programMod = lib.slice(lib.indexOf("#[program]"));
      const instructions = [...programMod.matchAll(/pub fn (\w+)\s*(?:<[^>]*>)?\s*\(\s*(?:_?ctx|_)\s*:/g)].map((m) => m[1]);
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.filter((n) => !p.instructions.some((i) => i.name === n))).toEqual([]);
      const errors = [...src.matchAll(/#\[msg\([^\n]*\)\]\s*(\w+)/g)].map((m) => m[1]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.filter((n) => !p.errors.some((e) => e.name === n))).toEqual([]);
      const events = [...src.matchAll(/#\[event\]\s*(?:#\[[^\]]*\]\s*)*pub struct (\w+)/g)].map((m) => m[1]);
      expect(events.filter((n) => !p.events.some((e) => e.name === n))).toEqual([]);
      // Error codes are consecutive from 6000 (Anchor's custom error base).
      p.errors.forEach((e, i) => expect(e.code).toBe(6000 + i));
    });
  }

  it("matches the program ids declared in the sources", () => {
    for (const [slug, dir] of Object.entries(PROGRAM_DIRS)) {
      const lib = readFileSync(join(REPO, dir, "src/lib.rs"), "utf8");
      const id = /declare_id!\("(\w+)"\)/.exec(lib)?.[1];
      expect(PROGRAMS.find((p) => p.slug === slug)?.programId).toBe(id);
    }
  });
});

describe("docs pages", () => {
  it("has the sections the spec asks for, each page titled and summarized", () => {
    expect(DOC_SECTIONS.map((s) => s.id)).toEqual(["start", "concepts", "guides", "sdk", "programs", "security"]);
    for (const p of DOC_PAGES) {
      expect(p.title, p.slug).not.toBe("");
      expect(p.summary, p.slug).not.toBe("");
    }
    expect(new Set(DOC_PAGES.map((p) => p.slug)).size).toBe(DOC_PAGES.length);
    expect(findDocPage("quickstart")?.title).toBe("Quickstart");
    expect(findDocPage("/concepts/fair-open-batch/")?.kind).toBe("md");
    expect(findDocPage("nope")).toBeNull();
  });

  /** Every anchor a page can be linked to: its outline, plus reference rows (errors, events, types). */
  function anchorsOf(slug: string): Set<string> {
    const page = findDocPage(slug);
    const out = new Set(page?.headings.map((h) => h.id) ?? []);
    const prog = PROGRAMS.find((p) => `programs/${p.slug}` === slug);
    if (prog) {
      for (const h of programHeadings(prog)) out.add(h.id);
      for (const e of prog.errors) out.add(`err-${e.code}`);
      for (const e of prog.events) out.add(`ev-${e.name}`);
      for (const t of prog.types) out.add(`type-${t.name}`);
    }
    if (page) {
      const walk = (bs: Block[]): void => {
        for (const b of bs) {
          if (b.t === "h") out.add(b.id);
          if (b.t === "callout") walk(b.blocks);
          if (b.t === "list") b.items.forEach(walk);
        }
      };
      walk(page.blocks);
    }
    return out;
  }

  function linksOf(blocks: Block[]): string[] {
    const out: string[] = [];
    const inline = (text: string): void => {
      const walk = (nodes: ReturnType<typeof parseInline>): void => {
        for (const n of nodes) {
          if (n.t === "a") out.push(n.href);
          if (n.t === "a" || n.t === "b" || n.t === "i") walk(n.c);
        }
      };
      walk(parseInline(text));
    };
    for (const b of blocks) {
      if (b.t === "p" || b.t === "h") inline(b.text);
      else if (b.t === "list") b.items.forEach((item) => out.push(...linksOf(item)));
      else if (b.t === "callout") {
        inline(b.title);
        out.push(...linksOf(b.blocks));
      } else if (b.t === "table") [...b.head, ...b.rows.flat()].forEach(inline);
    }
    return out;
  }

  it("links only to pages and anchors that exist", () => {
    const broken: string[] = [];
    for (const p of DOC_PAGES) {
      for (const href of linksOf(p.blocks)) {
        // App routes the docs may link to (Verify checks a token against QSL-1).
        if (/^https:\/\//.test(href) || href === "/whitepaper" || href === "/verify") continue;
        const [path = "", anchor = ""] = href.split("#");
        const target = href.startsWith("#") ? p.slug : path.startsWith("/docs") ? path.replace(/^\/docs\/?/, "") : null;
        if (target === null) {
          broken.push(`${p.slug || "index"}: ${href} (not a docs link)`);
          continue;
        }
        if (!findDocPage(target)) broken.push(`${p.slug || "index"}: ${href} (no page)`);
        else if (anchor && !anchorsOf(target).has(anchor)) broken.push(`${p.slug || "index"}: ${href} (no anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("uses only figures that exist", () => {
    const missing: string[] = [];
    const walk = (slug: string, bs: Block[]): void => {
      for (const b of bs) {
        if (b.t === "figure" && !FIGURE_NAMES.includes(b.name)) missing.push(`${slug}: ${b.name}`);
        if (b.t === "callout") walk(slug, b.blocks);
      }
    };
    for (const p of DOC_PAGES) walk(p.slug, p.blocks);
    expect(missing).toEqual([]);
  });

  it("renders every Markdown page with its outline anchors", () => {
    for (const p of DOC_PAGES.filter((x) => x.kind === "md")) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocSlug.Provider, { value: p.slug }, createElement(Blocks, { blocks: p.blocks }))));
      for (const h of p.headings) expect(html, `${p.slug}#${h.id}`).toContain(`id="${h.id}"`);
      expect(html).not.toMatch(/undefined|\[object Object\]/);
    }
  });

  it("describes safety policy 3 and audit round 3's merged fixes as shipped: nothing is marked as in review", () => {
    // PQ v2, on-chain metadata and audit round 3's F1 and F2 are all in the programs (LAYER_V1 §B.4).
    expect(DOC_PAGES.filter((p) => p.rolling).map((p) => p.slug)).toEqual([]);
    const marked: string[] = [];
    const walk = (slug: string, bs: Block[]): void => {
      for (const b of bs) {
        if (b.t === "callout") {
          if (b.kind === "rolling") marked.push(`${slug}: ${b.title}`);
          walk(slug, b.blocks);
        }
        if (b.t === "list") b.items.forEach((item) => walk(slug, item));
      }
    };
    for (const p of DOC_PAGES) walk(p.slug, p.blocks);
    expect(marked).toEqual([]);
    const text = (slug: string): string => JSON.stringify(findDocPage(slug)?.blocks ?? []);
    // No "in review" left for F1 and F2 on any page (the changelog says they are merged).
    expect(DOC_PAGES.filter((p) => /in review|being reviewed|being added/i.test(text(p.slug))).map((p) => p.slug)).toEqual([]);
    expect(text("changelog")).toMatch(/Audit round 3 \(2026-10-10\), fixes merged/);
    // The F1 and F2 explanations stay, as notes.
    expect(text("concepts/pq-identity")).toMatch(/Audit round 3, fix F1/);
    expect(text("concepts/launch-guard")).toMatch(/Audit round 3, fix F2/);
    for (const stale of ["221-byte", "PHX-ATTEST-V1", "PHX-META-V1", "metadata_json_sha256", "checks = 2047", "all eleven"]) {
      // The changelog may name what a release removed; every other page describes the current programs.
      expect(DOC_PAGES.filter((p) => p.slug !== "changelog" && text(p.slug).includes(stale)).map((p) => `${p.slug}: ${stale}`)).toEqual([]);
    }
  });
});

describe("the QSL-1 standard page", () => {
  it("summarizes the standard: its levels, the candidate rule, the verifier and the wording rules", () => {
    const page = findDocPage("standard/qsl-1");
    expect(page?.title).toBe("The QSL-1 token standard");
    const t = JSON.stringify(page?.blocks ?? []);
    for (const s of ["QSL-1 · No-rug", "QSL-1 · Quantum-attested", "QSL-1 L2 · programmable", "read its rules", "candidate", "checkQsl1", "qslBadge", "C1.24", "mainnet-beta", "quantum-proof"]) expect(t, s).toContain(s);
    // QSL-1 revision 0.4: two levels; "programmable" is a tag, never a level.
    expect(t).not.toContain("QSL-1 · Programmable");
    expect(t).toContain("There is no level 3");
  });
});

describe("docs Markdown", () => {
  it("parses front matter, headings, lists, tables, code, callouts and figures", () => {
    const doc = parseDoc(
      [
        "---",
        "title: T",
        "summary: S",
        "---",
        "## One {#first}",
        "Text with `code` and **bold** and [a link](/docs/quickstart#install).",
        "",
        "- a",
        "  - nested",
        "- b",
        "",
        "| A | B |",
        "|---|--:|",
        "| 1 \\| 2 | `x|y` |",
        "",
        '```ts title="x.ts"',
        "const a = 1;",
        "```",
        ":::warn Careful",
        "### Inside",
        "body",
        ":::",
        "::figure batch k=v",
        "## One",
      ].join("\n"),
    );
    expect(doc.meta).toEqual({ title: "T", summary: "S" });
    const kinds = doc.blocks.map((b) => b.t);
    expect(kinds).toEqual(["h", "p", "list", "table", "code", "callout", "figure", "h"]);
    const [h1, , list, table, code, callout, fig, h2] = doc.blocks;
    expect(h1?.t === "h" && h1.id).toBe("first");
    expect(h2?.t === "h" && h2.id).toBe("one");
    expect(list?.t === "list" && list.items[0]?.[1]?.t).toBe("list");
    expect(table?.t === "table" && table.rows[0]).toEqual(["1 | 2", "`x|y`"]);
    expect(table?.t === "table" && table.align).toEqual(["left", "right"]);
    expect(code?.t === "code" && [code.lang, code.title, code.code]).toEqual(["ts", "x.ts", "const a = 1;"]);
    expect(callout?.t === "callout" && [callout.kind, callout.title, callout.blocks[0]?.t]).toEqual(["warn", "Careful", "h"]);
    expect(fig?.t === "figure" && [fig.name, fig.args]).toEqual(["batch", { k: "v" }]);
    expect(parseInline("a `b` **c** [d](/e)").map((n) => n.t)).toEqual(["text", "code", "text", "b", "text", "a"]);
    expect(slugify("Snipe shield & `Launch Guard`")).toBe("snipe-shield-launch-guard");
  });
});

describe("docs search", () => {
  it("finds pages, SDK exports, instructions and errors by name or code", () => {
    expect(searchDocs("quickstart")[0]?.path).toBe("/docs/quickstart");
    expect(searchDocs("buildCommitTx")[0]?.path).toBe("/docs/sdk/launch-tx#buildCommitTx");
    expect(searchDocs("execute_batch").some((h) => h.path === "/docs/programs/launchpad#ix-execute_batch")).toBe(true);
    expect(searchDocs("PoolAlreadyTraded")[0]?.path).toBe("/docs/programs/launchpad#err-6038");
    expect(searchDocs("6038").some((h) => h.title === "PoolAlreadyTraded")).toBe(true);
    expect(searchDocs("whitepaper").some((h) => h.path === "/whitepaper")).toBe(true);
    expect(searchDocs("zzqqxx")).toEqual([]);
  });

  it("finds the on-chain metadata surface: instruction, account, errors and SDK group", () => {
    expect(searchDocs("publish_metadata").some((h) => h.path === "/docs/programs/launchpad#ix-publish_metadata")).toBe(true);
    expect(searchDocs("MetadataMismatch")[0]?.path).toBe("/docs/programs/launchpad#err-6047");
    expect(searchDocs("6045").some((h) => h.title === "InvalidMetadataFlags")).toBe(true);
    expect(searchDocs("buildMetadataDoc")[0]?.path).toBe("/docs/sdk/metadata#buildMetadataDoc");
    expect(searchDocs("replanLaunchWindow")[0]?.path).toBe("/docs/sdk/launch-flow#replanLaunchWindow");
    expect(searchDocs("token metadata").some((h) => h.path === "/docs/concepts/token-metadata")).toBe(true);
  });
});
