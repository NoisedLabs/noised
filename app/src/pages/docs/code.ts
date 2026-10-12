/**
 * A tiny tokenizer for the docs' code blocks (TypeScript, Rust, shell, PowerShell, text). It only splits text
 * into typed spans; React renders them as text nodes, never HTML. Good enough for documentation, not a parser.
 */

export type TokenKind = "plain" | "comment" | "string" | "keyword" | "number" | "fn" | "type" | "punct" | "prompt" | "flag" | "literal";

export interface Token {
  k: TokenKind;
  v: string;
}

const TS_KEYWORDS = new Set(
  "import export from as const let var function return if else for while of in new await async type interface extends implements class throw try catch finally typeof keyof readonly void null undefined true false this default switch case break continue satisfies enum declare".split(
    " ",
  ),
);
const RUST_KEYWORDS = new Set(
  "pub fn let mut const static struct enum impl trait use mod crate self Self super where for in if else match return as ref move loop while break continue unsafe dyn type true false Some None Ok Err".split(
    " ",
  ),
);
const SH_KEYWORDS = new Set("cd export if then fi for do done echo set foreach in".split(" "));

export type Lang = "ts" | "rust" | "sh" | "ps" | "text";

export function langOf(tag: string): Lang {
  const t = tag.toLowerCase();
  if (["ts", "tsx", "typescript", "js", "javascript", "jsx", "json"].includes(t)) return "ts";
  if (["rust", "rs"].includes(t)) return "rust";
  if (["bash", "sh", "shell", "zsh", "console"].includes(t)) return "sh";
  if (["powershell", "ps1", "ps", "pwsh"].includes(t)) return "ps";
  return "text";
}

interface Rule {
  re: RegExp;
  k: TokenKind | ((m: string, rest: string) => TokenKind);
}

function rulesFor(lang: Lang): Rule[] {
  const ident = (keywords: Set<string>) => (m: string, rest: string): TokenKind => {
    if (keywords.has(m)) return "keyword";
    if (/^\s*\(/.test(rest) || /^\s*!/.test(rest)) return "fn";
    if (/^[A-Z]/.test(m)) return "type";
    return "plain";
  };
  switch (lang) {
    case "ts":
      return [
        { re: /^\/\/[^\n]*/, k: "comment" },
        { re: /^\/\*[\s\S]*?\*\//, k: "comment" },
        { re: /^`(?:\\[\s\S]|[^`\\])*`/, k: "string" },
        { re: /^"(?:\\.|[^"\\\n])*"/, k: "string" },
        { re: /^'(?:\\.|[^'\\\n])*'/, k: "string" },
        { re: /^(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?)n?\b/, k: "number" },
        { re: /^[A-Za-z_$][\w$]*/, k: ident(TS_KEYWORDS) },
        { re: /^(?:=>|[{}()[\];,.:?=<>+\-*/%!&|^~@])/, k: "punct" },
      ];
    case "rust":
      return [
        { re: /^\/\/[^\n]*/, k: "comment" },
        { re: /^\/\*[\s\S]*?\*\//, k: "comment" },
        { re: /^b?"(?:\\.|[^"\\])*"/, k: "string" },
        { re: /^(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?)(?:u8|u16|u32|u64|u128|i64|usize)?\b/, k: "number" },
        { re: /^#\[[^\]]*\]/, k: "literal" },
        { re: /^[A-Za-z_][\w]*/, k: ident(RUST_KEYWORDS) },
        { re: /^(?:->|=>|::|[{}()[\];,.:?=<>+\-*/%!&|^~@])/, k: "punct" },
      ];
    case "sh":
    case "ps":
      return [
        { re: /^#[^\n]*/, k: "comment" },
        { re: /^"(?:\\.|[^"\\\n])*"/, k: "string" },
        { re: /^'[^'\n]*'/, k: "string" },
        { re: /^<[A-Z_]+>/, k: "literal" },
        { re: /^\$[\w:]+/, k: "type" },
        { re: /^(?:--?|\s-)[A-Za-z][\w-]*/, k: "flag" },
        { re: /^\d[\d_.]*\b/, k: "number" },
        {
          re: /^[A-Za-z_.][\w.\\/-]*/,
          k: (m) => (SH_KEYWORDS.has(m) ? "keyword" : "plain"),
        },
        { re: /^[|;&<>(){}=]/, k: "punct" },
      ];
    default:
      return [];
  }
}

/** Splits `code` into tokens; consecutive plain characters are merged. */
export function tokenize(code: string, lang: Lang): Token[] {
  const rules = rulesFor(lang);
  if (rules.length === 0) return [{ k: "plain", v: code }];
  const out: Token[] = [];
  const push = (k: TokenKind, v: string): void => {
    const last = out[out.length - 1];
    if (last && last.k === k && (k === "plain" || k === "punct")) last.v += v;
    else out.push({ k, v });
  };
  let i = 0;
  // Shell: the first word of each line is a command.
  let lineStart = true;
  while (i < code.length) {
    const rest = code.slice(i);
    const ch = code[i] ?? "";
    if (ch === "\n" || ch === " " || ch === "\t") {
      push("plain", ch);
      if (ch === "\n") lineStart = true;
      i++;
      continue;
    }
    let matched = false;
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (!m || m[0] === "") continue;
      const v = m[0];
      let k = typeof r.k === "function" ? r.k(v, rest.slice(v.length)) : r.k;
      if ((lang === "sh" || lang === "ps") && lineStart && k === "plain" && /^[A-Za-z.]/.test(v)) k = "fn";
      push(k, v);
      i += v.length;
      matched = true;
      break;
    }
    if (!matched) {
      push("plain", ch);
      i++;
    }
    lineStart = false;
  }
  return out;
}
