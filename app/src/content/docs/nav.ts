/**
 * The developer docs (/docs): every page, in sidebar order, with its outline. Markdown pages come from
 * ./pages/**\/*.md (parsed once, here); the SDK and programs reference pages are built from the generated data.
 * Loaded only with the docs route and, lazily, by the command palette's docs search (./search.ts).
 */
import { PROGRAMS } from "./generated/programs";
import { SDK_REFERENCE } from "./generated/sdk";
import { outlineOf, parseDoc, type Block } from "./markdown";
import type { DocHeading, ProgramDoc, SdkEntry, SdkKind } from "./types";

const RAW = import.meta.glob<string>("./pages/**/*.md", { query: "?raw", import: "default", eager: true });

export type DocKind = "md" | "sdk-group" | "program";

export interface DocPage {
  /** Route under /docs ("" for the introduction). */
  slug: string;
  title: string;
  /** Short sidebar label. */
  nav: string;
  summary: string;
  section: DocSectionId;
  kind: DocKind;
  /** Describes what lands in this release. */
  rolling: boolean;
  headings: DocHeading[];
  blocks: Block[];
  /** sdk-group: the group id; program: the program slug. */
  ref: string;
}

export type DocSectionId = "start" | "concepts" | "guides" | "sdk" | "programs" | "security";

export interface DocSection {
  id: DocSectionId;
  title: string;
  /** A reference section: collapsed in the sidebar unless it holds the current page. */
  reference: boolean;
  pages: DocPage[];
}

function mdSlug(path: string): string {
  const s = path.replace(/^\.\/pages\//, "").replace(/\.md$/, "");
  return s === "index" ? "" : s;
}

const MD = new Map<string, { meta: Record<string, string>; blocks: Block[] }>();
for (const [path, raw] of Object.entries(RAW)) MD.set(mdSlug(path), parseDoc(raw));

function mdPage(slug: string, section: DocSectionId): DocPage {
  const doc = MD.get(slug);
  if (!doc) throw new Error(`docs: missing page content/docs/pages/${slug || "index"}.md`);
  const title = doc.meta.title ?? slug;
  return {
    slug,
    title,
    nav: doc.meta.nav ?? title,
    summary: doc.meta.summary ?? "",
    section,
    kind: "md",
    rolling: doc.meta.rolling === "true",
    headings: outlineOf(doc.blocks),
    blocks: doc.blocks,
    ref: "",
  };
}

// ------------------------------------------------------------ SDK pages ---

export const SDK_KIND_ORDER: readonly { kind: SdkKind; title: string; id: string }[] = [
  { kind: "function", title: "Functions", id: "functions" },
  { kind: "const", title: "Constants", id: "constants" },
  { kind: "class", title: "Classes", id: "classes" },
  { kind: "namespace", title: "Namespaces", id: "namespaces" },
  { kind: "interface", title: "Interfaces", id: "interfaces" },
  { kind: "type", title: "Types", id: "types" },
];

export function sdkEntriesOf(group: string): SdkEntry[] {
  return SDK_REFERENCE.entries.filter((e) => e.group === group);
}

/** The SDK groups that have exports (a group can be declared before its module is exported). */
export const SDK_GROUPS: readonly { id: string; title: string }[] = SDK_REFERENCE.groups.filter((g) => sdkEntriesOf(g.id).length > 0);

/** Entry anchors: the export name (unique within a group page). */
export function sdkAnchor(e: Pick<SdkEntry, "name">): string {
  return e.name;
}

function sdkPage(group: { id: string; title: string }): DocPage {
  const entries = sdkEntriesOf(group.id);
  const modules = [...new Set(entries.map((e) => e.module))];
  const headings: DocHeading[] = [];
  for (const k of SDK_KIND_ORDER) {
    const of = entries.filter((e) => e.kind === k.kind);
    if (of.length === 0) continue;
    headings.push({ id: k.id, text: k.title, level: 2 });
    for (const e of of) headings.push({ id: sdkAnchor(e), text: e.name, level: 3 });
  }
  return {
    slug: `sdk/${group.id}`,
    title: group.title,
    nav: group.title,
    summary: `${entries.length} export${entries.length === 1 ? "" : "s"} from ${modules.map((m) => `sdk/src/${m}.ts`).join(", ")}.`,
    section: "sdk",
    kind: "sdk-group",
    rolling: false,
    headings,
    blocks: [],
    ref: group.id,
  };
}

// -------------------------------------------------------- program pages ---

export const PROGRAM_NAV: Record<string, string> = { launchpad: "Launchpad", hook: "Launch Guard", vault: "PQ vault", shield: "Shield", autopilot: "Autopilot" };

export function programHeadings(p: ProgramDoc): DocHeading[] {
  const h: DocHeading[] = [{ id: "overview", text: "Overview", level: 2 }];
  if (p.instructions.length) {
    h.push({ id: "instructions", text: "Instructions", level: 2 });
    for (const i of p.instructions) h.push({ id: `ix-${i.name}`, text: i.name, level: 3 });
  }
  if (p.accounts.length) {
    h.push({ id: "accounts", text: "Accounts", level: 2 });
    for (const a of p.accounts) h.push({ id: `acc-${a.name}`, text: a.name, level: 3 });
  }
  if (p.types.length) h.push({ id: "types", text: "Types", level: 2 });
  if (p.pdas.length) h.push({ id: "pdas", text: "PDAs", level: 2 });
  if (p.events.length) h.push({ id: "events", text: "Events", level: 2 });
  if (p.errors.length) h.push({ id: "errors", text: "Errors", level: 2 });
  if (p.constants.length) h.push({ id: "constants", text: "Constants", level: 2 });
  return h;
}

function programPage(p: ProgramDoc): DocPage {
  return {
    slug: `programs/${p.slug}`,
    title: `${p.title}`,
    nav: PROGRAM_NAV[p.slug] ?? p.title,
    summary: `${p.crate}: ${p.instructions.length} instructions, ${p.accounts.length} account type${p.accounts.length === 1 ? "" : "s"}, ${p.errors.length} errors, ${p.events.length} events.`,
    section: "programs",
    kind: "program",
    rolling: false,
    headings: programHeadings(p),
    blocks: [],
    ref: p.slug,
  };
}

// -------------------------------------------------------------- sections ---

const CONCEPTS = [
  "concepts/lifecycle",
  "concepts/fair-open-batch",
  "concepts/launch-guard",
  "concepts/liquidity-and-fees",
  "concepts/pq-identity",
  "concepts/token-metadata",
  "concepts/pq-vault",
  "concepts/private-balances",
];

const GUIDES = [
  "guides/launch-a-token",
  "guides/commit-and-claim",
  "guides/buy-into-a-vault",
  "guides/vault",
  "guides/private-balances",
  "guides/keeper",
  "guides/ai-agents",
  "guides/verify-a-mint",
];

export const DOC_SECTIONS: readonly DocSection[] = [
  { id: "start", title: "Get started", reference: false, pages: [mdPage("", "start"), mdPage("quickstart", "start")] },
  { id: "concepts", title: "Concepts", reference: false, pages: CONCEPTS.map((s) => mdPage(s, "concepts")) },
  { id: "guides", title: "Guides", reference: false, pages: GUIDES.map((s) => mdPage(s, "guides")) },
  { id: "sdk", title: "SDK reference", reference: true, pages: [mdPage("sdk", "sdk"), ...SDK_GROUPS.map(sdkPage)] },
  { id: "programs", title: "Programs reference", reference: true, pages: [mdPage("programs", "programs"), ...PROGRAMS.map(programPage)] },
  { id: "security", title: "Security", reference: false, pages: [mdPage("standard/qsl-1", "security"), mdPage("security", "security"), mdPage("changelog", "security")] },
];

export const DOC_PAGES: readonly DocPage[] = DOC_SECTIONS.flatMap((s) => s.pages);

const BY_SLUG = new Map(DOC_PAGES.map((p) => [p.slug, p]));

export function findDocPage(slug: string): DocPage | null {
  return BY_SLUG.get(slug.replace(/^\/+|\/+$/g, "")) ?? null;
}

export function docPath(slug: string, anchor = ""): string {
  return `/docs${slug ? `/${slug}` : ""}${anchor ? `#${anchor}` : ""}`;
}

export function sectionOf(id: DocSectionId): DocSection {
  return DOC_SECTIONS.find((s) => s.id === id) ?? (DOC_SECTIONS[0] as DocSection);
}

/** Previous and next pages in reading order. */
export function neighbours(slug: string): { prev: DocPage | null; next: DocPage | null } {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  return { prev: i > 0 ? (DOC_PAGES[i - 1] ?? null) : null, next: i >= 0 ? (DOC_PAGES[i + 1] ?? null) : null };
}

export { PROGRAMS, SDK_REFERENCE };
