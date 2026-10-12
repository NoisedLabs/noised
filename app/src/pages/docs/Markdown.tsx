/**
 * Renders the docs' Markdown blocks (content/docs/markdown.ts) as React elements. Text only ever becomes text
 * nodes; links to /docs and /whitepaper become router links, other links open in a new tab.
 */
import { Check, Copy } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { parseInline, plainText, type Block, type Inline } from "../../content/docs/markdown";
import { langOf, tokenize } from "./code";
import { Figure } from "./figures";
import { Pixel, type GlyphName } from "./pixels";

/** The page being rendered: in-page anchors ("#id") resolve against it. */
export const DocSlug = createContext("");

export function docHref(slug: string, id: string): string {
  return `/docs${slug ? `/${slug}` : ""}#${id}`;
}

// ---------------------------------------------------------------- inline ---

function InlineNodes({ nodes }: { nodes: Inline[] }): ReactNode {
  const slug = useContext(DocSlug);
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "code":
        return (
          <code key={i} className="dx-ic">
            {n.v}
          </code>
        );
      case "b":
        return (
          <strong key={i}>
            <InlineNodes nodes={n.c} />
          </strong>
        );
      case "i":
        return (
          <em key={i}>
            <InlineNodes nodes={n.c} />
          </em>
        );
      case "kbd":
        return (
          <kbd key={i} className="dx-kbd">
            {n.v}
          </kbd>
        );
      case "a": {
        const href = n.href;
        if (href.startsWith("#")) {
          return (
            <Link key={i} className="dx-a" to={docHref(slug, href.slice(1))}>
              <InlineNodes nodes={n.c} />
            </Link>
          );
        }
        if (href.startsWith("/")) {
          return (
            <Link key={i} className="dx-a" to={href}>
              <InlineNodes nodes={n.c} />
            </Link>
          );
        }
        if (/^https:\/\//.test(href)) {
          return (
            <a key={i} className="dx-a" href={href} target="_blank" rel="noreferrer noopener">
              <InlineNodes nodes={n.c} />
            </a>
          );
        }
        return (
          <span key={i}>
            <InlineNodes nodes={n.c} />
          </span>
        );
      }
    }
  });
}

export function Md({ text }: { text: string }): ReactNode {
  return <InlineNodes nodes={parseInline(text)} />;
}

// ------------------------------------------------------------------ code ---

export function CodeBlock({ code, lang, title }: { code: string; lang: string; title?: string | undefined }): ReactNode {
  const tokens = tokenize(code, langOf(lang));
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const label = title || (lang ? lang.toUpperCase() : "TEXT");
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };
  return (
    <figure className="dx-code">
      <figcaption className="dx-code-bar">
        <span className="dx-code-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="dx-code-title">{label}</span>
        <button type="button" className="dx-copy" onClick={copy} aria-label={copied ? "Copied" : `Copy ${title || "code"}`}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre tabIndex={0} aria-label={`Code: ${label}`}>
        <code>
          {tokens.map((t, i) =>
            t.k === "plain" ? (
              <Fragment key={i}>{t.v}</Fragment>
            ) : (
              <span key={i} className={`tk-${t.k}`}>
                {t.v}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}

// -------------------------------------------------------------- headings ---

export function Heading({ level, id, children, text }: { level: 2 | 3 | 4; id: string; children: ReactNode; text: string }): ReactNode {
  const slug = useContext(DocSlug);
  const Tag = level === 2 ? "h2" : level === 3 ? "h3" : "h4";
  return (
    <Tag id={id} className={`dx-h dx-h${level}`}>
      {children}
      <Link className="dx-anchor" to={docHref(slug, id)} aria-label={`Link to ${text}`}>
        #
      </Link>
    </Tag>
  );
}

// --------------------------------------------------------------- callout ---

const CALLOUT_META: Record<string, { icon: GlyphName; label: string }> = {
  note: { icon: "book", label: "Note" },
  tip: { icon: "bolt", label: "Tip" },
  warn: { icon: "shield", label: "Careful" },
  danger: { icon: "flame", label: "Danger" },
  // :::rolling marks what is specified for this release but not yet in its programs (none at the moment: audit round
  // 3's F1 and F2 are merged).
  rolling: { icon: "clock", label: "Coming" },
};

function Callout({ kind, title, blocks }: { kind: string; title: string; blocks: Block[] }): ReactNode {
  const meta = CALLOUT_META[kind] ?? { icon: "book" as GlyphName, label: "Note" };
  return (
    <aside className="dx-callout" data-kind={kind} aria-label={title || meta.label}>
      <div className="dx-callout-head">
        <Pixel name={meta.icon} size={22} />
        <span className="dx-callout-tag">{meta.label}</span>
        {title && title !== meta.label ? (
          <strong className="dx-callout-title">
            <Md text={title} />
          </strong>
        ) : null}
      </div>
      <div className="dx-callout-body">
        <Blocks blocks={blocks} />
      </div>
    </aside>
  );
}

/** `:::steps`: the blocks split at each ### heading, rendered as a numbered track. */
function Steps({ blocks }: { blocks: Block[] }): ReactNode {
  const steps: { head: Extract<Block, { t: "h" }> | null; body: Block[] }[] = [];
  for (const b of blocks) {
    if (b.t === "h" && b.level === 3) steps.push({ head: b, body: [] });
    else if (steps.length === 0) steps.push({ head: null, body: [b] });
    else steps[steps.length - 1]?.body.push(b);
  }
  return (
    <ol className="dx-steps">
      {steps.map((s, i) => (
        <li key={s.head?.id ?? i} className="dx-step">
          <span className="dx-step-n" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="dx-step-body">
            {s.head ? (
              <Heading level={3} id={s.head.id} text={plainText(s.head.text)}>
                <Md text={s.head.text} />
              </Heading>
            ) : null}
            <Blocks blocks={s.body} />
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- blocks ---

function ListItem({ blocks }: { blocks: Block[] }): ReactNode {
  const first = blocks[0];
  const task = first?.t === "p" ? /^\[( |x)\]\s+/i.exec(first.text) : null;
  if (task && first?.t === "p") {
    const rest: Block[] = [{ t: "p", text: first.text.slice(task[0].length) }, ...blocks.slice(1)];
    const done = task[1]?.toLowerCase() === "x";
    return (
      <li className="dx-task" data-done={done ? "true" : "false"}>
        <span className="dx-task-box" aria-hidden="true">
          {done ? <Pixel name="check" size={14} /> : null}
        </span>
        <span className="sr-only">{done ? "Done: " : "To do: "}</span>
        <div>
          <Blocks blocks={rest} tight />
        </div>
      </li>
    );
  }
  return (
    <li>
      <Blocks blocks={blocks} tight />
    </li>
  );
}

export function Blocks({ blocks, tight = false }: { blocks: Block[]; tight?: boolean }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "h":
        return (
          <Heading key={b.id || i} level={b.level} id={b.id} text={plainText(b.text)}>
            <Md text={b.text} />
          </Heading>
        );
      case "p":
        return tight && blocks.length === 1 ? (
          <Md key={i} text={b.text} />
        ) : (
          <p key={i} className="dx-p">
            <Md text={b.text} />
          </p>
        );
      case "list": {
        const items = b.items.map((item, j) => <ListItem key={j} blocks={item} />);
        const isTasks = b.items.every((it) => it[0]?.t === "p" && /^\[( |x)\]\s+/i.test(it[0].text));
        return b.ordered ? (
          <ol key={i} className="dx-ol" start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i} className={isTasks ? "dx-tasks" : "dx-ul"}>
            {items}
          </ul>
        );
      }
      case "code":
        return <CodeBlock key={i} code={b.code} lang={b.lang} title={b.title} />;
      case "math":
        return (
          <div key={i} className="dx-math" role="math" aria-label={b.text}>
            {b.text.split("\n").map((line, j) => {
              const [expr, ...note] = line.split(/\s{2,}/);
              return (
                <div key={j} className="dx-math-line">
                  <span className="dx-math-expr">{expr}</span>
                  {note.length ? <span className="dx-math-note">{note.join(" ")}</span> : null}
                </div>
              );
            })}
          </div>
        );
      case "table":
        return (
          <div key={i} className="dx-table-wrap" role="region" aria-label="Table" tabIndex={0}>
            <table className="dx-table" data-cols={b.head.length}>
              <thead>
                <tr>
                  {b.head.map((h, j) => (
                    <th key={j} scope="col" data-align={b.align[j] ?? "left"}>
                      <Md text={h} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, k) => (
                      <td key={k} data-align={b.align[k] ?? "left"}>
                        <Md text={r[k] ?? ""} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "callout":
        return b.kind === "steps" ? <Steps key={i} blocks={b.blocks} /> : <Callout key={i} kind={b.kind} title={b.title} blocks={b.blocks} />;
      case "figure":
        return <Figure key={i} name={b.name} args={b.args} />;
      case "hr":
        return <hr key={i} className="dx-hr" />;
    }
  });
}
