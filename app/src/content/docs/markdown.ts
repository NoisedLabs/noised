/**
 * A small Markdown dialect for the developer docs (content/docs/pages/*.md), parsed into plain data and rendered
 * by React (pages/docs/Markdown.tsx). Nothing is ever turned into HTML: no innerHTML anywhere (Trusted Types).
 *
 * Blocks
 *   ---\nkey: value\n---           front matter (title, summary, rolling)
 *   ## Heading / ### Heading       h2 / h3 (ids from the text; "## Text {#id}" sets one)
 *   paragraphs, - lists, 1. lists (nested by indentation), | tables |, --- rules
 *   ```lang title="file.ts"        code block (highlighted by pages/docs/code.ts)
 *   ```math                        a formula block (Unicode math, shown centred)
 *   :::note Title ... :::          callout: note | tip | warn | danger | rolling; :::steps splits on ### headings
 *   ::figure name key=value        a figure component (pages/docs/figures.tsx)
 *   > text                         a plain note callout
 * Inline
 *   `code`  **bold**  *em*  [text](/docs/page#anchor or https://...)  <kbd>K</kbd>
 */

export type CalloutKind = "note" | "tip" | "warn" | "danger" | "rolling" | "steps";

export type Block =
  | { t: "h"; level: 2 | 3 | 4; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "code"; lang: string; code: string; title: string }
  | { t: "math"; text: string }
  | { t: "table"; head: string[]; rows: string[][]; align: ("left" | "right" | "center")[] }
  | { t: "callout"; kind: CalloutKind; title: string; blocks: Block[] }
  | { t: "figure"; name: string; args: Record<string, string> }
  | { t: "hr" };

export interface ParsedDoc {
  meta: Record<string, string>;
  blocks: Block[];
}

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "kbd"; v: string };

const CALLOUTS: readonly CalloutKind[] = ["note", "tip", "warn", "danger", "rolling", "steps"];

/** Heading text without inline markup: what the outline, ids and the search index show. */
export function plainText(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<kbd>([^<]*)<\/kbd>/g, "$1")
    .trim();
}

export function slugify(text: string): string {
  const s = plainText(text)
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "section";
}

/** Gives every heading of `blocks` (callouts included) a unique id, in document order. */
function assignIds(blocks: Block[], used: Set<string>): void {
  for (const b of blocks) {
    if (b.t === "h") {
      let id = b.id || slugify(b.text);
      if (used.has(id)) {
        let n = 2;
        while (used.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      used.add(id);
      b.id = id;
    } else if (b.t === "callout") {
      assignIds(b.blocks, used);
    } else if (b.t === "list") {
      for (const item of b.items) assignIds(item, used);
    }
  }
}

export function parseDoc(source: string): ParsedDoc {
  const text = source.replace(/\r\n?/g, "\n");
  const meta: Record<string, string> = {};
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (fm) {
    for (const line of (fm[1] ?? "").split("\n")) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (m && m[1]) meta[m[1]] = (m[2] ?? "").trim();
    }
    body = text.slice(fm[0].length);
  }
  const blocks = parseBlocks(body.split("\n"));
  assignIds(blocks, new Set());
  return { meta, blocks };
}

const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*(.*)$/;

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m?.[1]?.length ?? 0;
}

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isBlockStart(line: string): boolean {
  return (
    /^#{2,4}\s/.test(line) ||
    FENCE_RE.test(line) ||
    /^:::/.test(line) ||
    /^::figure\s/.test(line) ||
    LIST_RE.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*\|/.test(line) ||
    /^-{3,}\s*$/.test(line)
  );
}

export function parseBlocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Headings.
    const h = /^(#{2,4})\s+(.*?)\s*(?:\{#([\w-]+)\})?\s*$/.exec(line);
    if (h) {
      const level = (h[1]?.length ?? 2) as 2 | 3 | 4;
      out.push({ t: "h", level, text: h[2] ?? "", id: h[3] ?? "" });
      i++;
      continue;
    }

    // Fenced code.
    const f = FENCE_RE.exec(line);
    if (f) {
      const fence = f[2] ?? "```";
      const pad = f[1]?.length ?? 0;
      const lang = (f[3] ?? "").toLowerCase();
      const titleM = /title="([^"]*)"/.exec(f[4] ?? "");
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence)) {
        const l = lines[i] ?? "";
        body.push(l.slice(Math.min(pad, indentOf(l))));
        i++;
      }
      i++; // closing fence
      if (lang === "math") out.push({ t: "math", text: body.join("\n").trim() });
      else out.push({ t: "code", lang, code: body.join("\n").replace(/\s+$/, ""), title: titleM?.[1] ?? "" });
      continue;
    }

    // Figures.
    const fig = /^::figure\s+([\w-]+)\s*(.*)$/.exec(line);
    if (fig) {
      const args: Record<string, string> = {};
      for (const m of (fig[2] ?? "").matchAll(/([\w-]+)=("([^"]*)"|\S+)/g)) {
        if (m[1]) args[m[1]] = m[3] ?? m[2] ?? "";
      }
      out.push({ t: "figure", name: fig[1] ?? "", args });
      i++;
      continue;
    }

    // Containers.
    const c = /^:::(\w+)\s*(.*)$/.exec(line);
    if (c) {
      const kind = (CALLOUTS.includes(c[1] as CalloutKind) ? c[1] : "note") as CalloutKind;
      const inner: string[] = [];
      let depth = 1;
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (/^:::\w/.test(l)) depth++;
        else if (/^:::\s*$/.test(l)) {
          depth--;
          if (depth === 0) break;
        }
        inner.push(l);
        i++;
      }
      i++;
      out.push({ t: "callout", kind, title: (c[2] ?? "").trim(), blocks: parseBlocks(inner) });
      continue;
    }

    // Rules.
    if (/^-{3,}\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    // Blockquote: a plain note.
    if (/^>\s?/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      out.push({ t: "callout", kind: "note", title: "", blocks: parseBlocks(inner) });
      continue;
    }

    // Tables.
    if (/^\s*\|/.test(line) && isTableSep(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? "").map((s) => (s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : "left") as "left" | "right" | "center");
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      out.push({ t: "table", head, rows, align });
      continue;
    }

    // Lists.
    const li = LIST_RE.exec(line);
    if (li) {
      const base = li[1]?.length ?? 0;
      const ordered = /\d/.test(li[2] ?? "");
      const start = ordered ? Number.parseInt(li[2] ?? "1", 10) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = LIST_RE.exec(l);
        if (m && (m[1]?.length ?? 0) === base && /\d/.test(m[2] ?? "") === ordered) {
          const contentIndent = (m[1]?.length ?? 0) + (m[2]?.length ?? 0) + 1;
          items.push([m[3] ?? ""]);
          i++;
          // Continuation: indented lines (or blank lines followed by indented lines).
          while (i < lines.length) {
            const n = lines[i] ?? "";
            if (n.trim() === "") {
              const next = lines[i + 1] ?? "";
              if (next.trim() !== "" && indentOf(next) > base) {
                items[items.length - 1]?.push("");
                i++;
                continue;
              }
              break;
            }
            if (indentOf(n) > base) {
              items[items.length - 1]?.push(n.slice(Math.min(contentIndent, indentOf(n))));
              i++;
              continue;
            }
            // A lazy continuation line of the item's paragraph.
            if (!isBlockStart(n)) {
              items[items.length - 1]?.push(n.trim());
              i++;
              continue;
            }
            break;
          }
          continue;
        }
        break;
      }
      out.push({ t: "list", ordered, start, items: items.map((item) => parseBlocks(item)) });
      continue;
    }

    // Paragraph: until a blank line or a block start.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !isBlockStart(lines[i] ?? "")) {
      para.push((lines[i] ?? "").trim());
      i++;
    }
    out.push({ t: "p", text: para.join(" ") });
  }
  return out;
}

// --------------------------------------------------------------- inline ---

/** Inline Markdown to a small tree: `code`, **bold**, *em*, [links](href), <kbd>. Everything else is text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = (): void => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[`*[\]\\_<]/.test(src[i + 1] ?? "")) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== " " && src[i + 1] !== "*" && !/\w/.test(src[i - 1] ?? "")) {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " " && !/\w/.test(src[end + 1] ?? "")) {
        flush();
        out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = findClosingBracket(src, i);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > close) {
          flush();
          out.push({ t: "a", href: src.slice(close + 2, end).trim(), c: parseInline(src.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "<" && src.startsWith("<kbd>", i)) {
      const end = src.indexOf("</kbd>", i + 5);
      if (end > i) {
        flush();
        out.push({ t: "kbd", v: src.slice(i + 5, end) });
        i = end + 6;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function findClosingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) i = end;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Plain text of a block list (search snippets, word counts). */
export function blocksText(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.t === "p" || b.t === "h") parts.push(plainText(b.text));
    else if (b.t === "list") for (const item of b.items) parts.push(blocksText(item));
    else if (b.t === "callout") parts.push(blocksText(b.blocks));
    else if (b.t === "table") parts.push(...b.head.map(plainText), ...b.rows.flat().map(plainText));
  }
  return parts.join(" ");
}

/** The h2/h3 outline of a document, callouts and steps included. */
export function outlineOf(blocks: readonly Block[]): { id: string; text: string; level: 2 | 3 }[] {
  const out: { id: string; text: string; level: 2 | 3 }[] = [];
  const walk = (bs: readonly Block[]): void => {
    for (const b of bs) {
      if (b.t === "h" && b.level <= 3) out.push({ id: b.id, text: plainText(b.text), level: b.level as 2 | 3 });
      else if (b.t === "callout") walk(b.blocks);
    }
  };
  walk(blocks);
  return out;
}
