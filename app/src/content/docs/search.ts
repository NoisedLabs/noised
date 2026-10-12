/**
 * The docs search index behind the command palette: pages, their headings, every SDK export, and every program
 * instruction, account, event and error (by name and by code). The palette imports this module lazily, the first
 * time it opens, so none of it is in the main bundle.
 */
import { DOC_PAGES, docPath, PROGRAM_NAV, PROGRAMS, sdkAnchor, SDK_REFERENCE } from "./nav";

export type DocHitKind = "page" | "section" | "sdk" | "instruction" | "account" | "event" | "error";

export interface DocSearchItem {
  /** What the palette shows and matches first. */
  title: string;
  /** Where it lives (page title, program, module). */
  where: string;
  /** Hash route: "/docs/..." with an optional "#anchor", or "/whitepaper". */
  path: string;
  kind: DocHitKind;
  /** Extra words that match (error codes, module paths, summaries). */
  keywords: string;
}

function build(): DocSearchItem[] {
  const out: DocSearchItem[] = [];
  for (const p of DOC_PAGES) {
    if (p.kind === "md") {
      out.push({ title: p.title, where: "Docs", path: docPath(p.slug), kind: "page", keywords: `${p.nav} ${p.summary}` });
      for (const h of p.headings) out.push({ title: h.text, where: p.title, path: docPath(p.slug, h.id), kind: "section", keywords: "" });
    } else {
      out.push({ title: p.title, where: p.kind === "sdk-group" ? "SDK reference" : "Programs reference", path: docPath(p.slug), kind: "page", keywords: p.summary });
    }
  }
  const groupTitle = new Map(SDK_REFERENCE.groups.map((g) => [g.id, g.title]));
  for (const e of SDK_REFERENCE.entries) {
    out.push({
      title: e.name,
      where: `SDK · ${groupTitle.get(e.group) ?? e.group}`,
      path: docPath(`sdk/${e.group}`, sdkAnchor(e)),
      kind: "sdk",
      keywords: `${e.kind} ${e.module}`,
    });
  }
  for (const p of PROGRAMS) {
    const where = PROGRAM_NAV[p.slug] ?? p.title;
    for (const i of p.instructions) out.push({ title: i.name, where: `${where} · instruction`, path: docPath(`programs/${p.slug}`, `ix-${i.name}`), kind: "instruction", keywords: p.crate });
    for (const a of p.accounts) out.push({ title: a.name, where: `${where} · account`, path: docPath(`programs/${p.slug}`, `acc-${a.name}`), kind: "account", keywords: p.crate });
    for (const ev of p.events) out.push({ title: ev.name, where: `${where} · event`, path: docPath(`programs/${p.slug}`, "events"), kind: "event", keywords: p.crate });
    for (const er of p.errors) {
      out.push({ title: er.name, where: `${where} · error ${er.code}`, path: docPath(`programs/${p.slug}`, `err-${er.code}`), kind: "error", keywords: `${er.code} 0x${er.code.toString(16)} ${er.msg}` });
    }
  }
  out.push({ title: "Whitepaper", where: "Noised: post-quantum token launches on Solana", path: "/whitepaper", kind: "page", keywords: "paper pdf research" });
  return out;
}

export const DOC_SEARCH: readonly DocSearchItem[] = build();

function norm(s: string): string {
  return s.toLowerCase();
}

/** Score one item against a query (higher is better; -1: no match). Word starts and exact names rank first. */
export function scoreDocItem(query: string, item: DocSearchItem): number {
  const q = norm(query.trim());
  if (q === "") return -1;
  const title = norm(item.title);
  if (title === q) return 1000;
  if (title.startsWith(q)) return 800 - title.length;
  const words = title.split(/[^a-z0-9]+/);
  if (words.some((w) => w.startsWith(q))) return 600 - title.length;
  const at = title.indexOf(q);
  if (at >= 0) return 500 - at;
  // Every query word somewhere in the title or keywords.
  const hay = `${title} ${norm(item.where)} ${norm(item.keywords)}`;
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => hay.includes(p))) return 300 - Math.min(200, title.length);
  // Subsequence of the title (camelCase and snake_case names).
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const i = title.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === ti ? 3 : 1;
    ti = i + 1;
  }
  return Math.min(200, score * 4);
}

/** The best `limit` matches, pages and exact names first. */
export function searchDocs(query: string, limit = 8): DocSearchItem[] {
  const rank: Record<DocHitKind, number> = { page: 30, sdk: 20, instruction: 20, account: 15, error: 15, section: 10, event: 5 };
  return DOC_SEARCH.map((item) => ({ item, s: scoreDocItem(query, item) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s + rank[b.item.kind] - (a.s + rank[a.item.kind]))
    .slice(0, limit)
    .map((x) => x.item);
}
