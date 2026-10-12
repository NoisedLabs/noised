/// <reference path="./mathml.d.ts" />
/**
 * A small TeX-subset to native MathML (MathML Core) renderer for the whitepaper. It builds React elements (no
 * HTML strings, no innerHTML: Trusted Types stays happy) from strings such as
 *   "u = \\left\\lceil \\frac{8n}{w} \\right\\rceil = 64"
 * Supported: ^ _ {groups}, \frac \tfrac \sqrt[n]{} \text{} \mathrm{} \mathtt{} \mathbf{} \operatorname{},
 * \left \right, \begin{cases|aligned|matrix} with & and \\, \overline \hat \tilde, spacing (\, \; \quad \qquad),
 * Greek letters, the usual relations / operators / arrows / delimiters, big operators with limits, numbers.
 */
import { useMemo, type ReactElement, type ReactNode } from "react";

type Tok =
  | { t: "cmd"; v: string }
  | { t: "char"; v: string }
  | { t: "num"; v: string }
  | { t: "open" }
  | { t: "close" }
  | { t: "sup" }
  | { t: "sub" }
  | { t: "amp" }
  | { t: "nl" }
  | { t: "sp" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (/\s/.test(c)) {
      // One token per run of whitespace: ignored by the math parser, kept by 	ext{...}.
      while (i < src.length && /\s/.test(src[i] ?? "")) i++;
      out.push({ t: "sp" });
      continue;
    }
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (n === "\\") {
        out.push({ t: "nl" });
        i += 2;
        continue;
      }
      if (/[a-zA-Z]/.test(n)) {
        let j = i + 1;
        while (j < src.length && /[a-zA-Z]/.test(src[j] ?? "")) j++;
        out.push({ t: "cmd", v: src.slice(i + 1, j) });
        i = j;
        continue;
      }
      out.push({ t: "cmd", v: n });
      i += 2;
      continue;
    }
    if (c === "{") out.push({ t: "open" });
    else if (c === "}") out.push({ t: "close" });
    else if (c === "^") out.push({ t: "sup" });
    else if (c === "_") out.push({ t: "sub" });
    else if (c === "&") out.push({ t: "amp" });
    else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j] ?? "")) j++;
      // A decimal point or a thousands comma followed by digits stays in the number ("2,176", "0.35").
      while ((src[j] === "." || (src[j] === "," && /^[0-9]{3}(?![0-9])/.test(src.slice(j + 1)))) && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j] ?? "")) j++;
      }
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    } else out.push({ t: "char", v: c });
    i++;
  }
  return out;
}

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", ell: "ℓ",
};

const OPS: Record<string, string> = {
  cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈",
  sim: "∼", simeq: "≃", equiv: "≡", propto: "∝", ll: "≪", gg: "≫", in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆",
  supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖", to: "→", rightarrow: "→", leftarrow: "←", gets: "←", mapsto: "↦",
  Rightarrow: "⇒", Leftarrow: "⇐", implies: "⟹", iff: "⟺", Leftrightarrow: "⇔", leftrightarrow: "↔", uparrow: "↑",
  downarrow: "↓", oplus: "⊕", otimes: "⊗", circ: "∘", bullet: "∙", star: "⋆", ast: "∗", land: "∧", wedge: "∧", lor: "∨",
  vee: "∨", neg: "¬", lnot: "¬", forall: "∀", exists: "∃", infty: "∞", emptyset: "∅", partial: "∂", nabla: "∇",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", langle: "⟨", rangle: "⟩", "|": "‖", Vert: "‖", lVert: "‖", rVert: "‖",
  vert: "|", lvert: "|", rvert: "|", mid: "∣", parallel: "∥", ldots: "…", cdots: "⋯", vdots: "⋮", dots: "…", colon: ":",
  "{": "{", "}": "}", "#": "#", "%": "%", "&": "&", "_": "_", top: "⊤", bot: "⊥", prime: "′", Box: "□", dagger: "†",
  coloneqq: "≔", triangleq: "≜", lll: "⋘", ggg: "⋙", hookrightarrow: "↪", longrightarrow: "⟶", longmapsto: "⟼",
};

/** Script capitals (Unicode Mathematical Alphanumeric Symbols; the holes use the Letterlike Symbols block). */
const CAL: Record<string, string> = Object.fromEntries(
  Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (ch, i) => [ch, ({ B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" } as Record<string, string>)[ch] ?? String.fromCodePoint(0x1d49c + i)]),
);
const BB: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", F: "𝔽" };

const BIGOPS: Record<string, string> = { sum: "∑", prod: "∏", bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", coprod: "∐", int: "∫" };
const LIMIT_FUNCS = new Set(["min", "max", "lim", "sup", "inf", "argmin", "argmax", "Pr"]);
const FUNCS = new Set(["log", "ln", "exp", "lg", "det", "gcd", "sin", "cos", "tan", "deg", "dim", "ker", "mod", "bmod", "Var", "E", "poly", "negl", "len", "Adv"]);
const SPACES: Record<string, string> = { ",": "0.1667em", ":": "0.2222em", ">": "0.2222em", ";": "0.2778em", " ": "0.25em", quad: "1em", qquad: "2em", enspace: "0.5em", thinspace: "0.1667em" };
/** Font-style commands whose name means nothing inside a raw text group, as in \mathrm{HMAC\text{-}SHA256}. */
const STYLE_CMDS = new Set(["text", "textrm", "mbox", "mathrm", "mathit", "mathtt", "texttt", "mathbf", "mathsf", "operatorname"]);
const FENCE_CHARS = new Set(["‖", "|", "∣", "⌈", "⌉", "⌊", "⌋", "⟨", "⟩", "{", "}"]);
const OP_CHARS = "+-=<>()[]|,;:!/*.?";

class Parser {
  private i = 0;
  private key = 0;
  private readonly toks: Tok[];
  private readonly display: boolean;
  constructor(toks: Tok[], display: boolean) {
    this.toks = toks;
    this.display = display;
  }

  k(): string {
    return `m${this.key++}`;
  }

  /** Next significant token (whitespace is skipped). */
  peek(): Tok | undefined {
    while (this.toks[this.i]?.t === "sp") this.i++;
    return this.toks[this.i];
  }

  next(): Tok | undefined {
    this.peek();
    return this.toks[this.i++];
  }

  /** Raw text of a {group} (for \text and friends): token values re-joined with the spacing a reader expects. */
  rawGroup(): string {
    const t = this.peek();
    if (t?.t !== "open") {
      const n = this.next();
      return n && "v" in n ? n.v : "";
    }
    this.next();
    let depth = 1;
    let s = "";
    while (this.i < this.toks.length) {
      // Raw access: whitespace counts inside text.
      const tok = this.toks[this.i++];
      if (!tok) break;
      if (tok.t === "sp") s += " ";
      else if (tok.t === "open") {
        depth++;
      } else if (tok.t === "close") {
        depth--;
        if (depth === 0) break;
      } else if (tok.t === "cmd") s += SPACES[tok.v] !== undefined ? " " : STYLE_CMDS.has(tok.v) ? "" : (OPS[tok.v] ?? GREEK[tok.v] ?? tok.v);
      else if (tok.t === "sub") s += "_";
      else if (tok.t === "sup") s += "^";
      else if (tok.t === "amp") s += "&";
      else if (tok.t === "nl") s += " ";
      else s += tok.v;
    }
    return s;
  }

  /** Parse until a stop token; returns the nodes. */
  seq(stop: (t: Tok) => boolean): ReactNode[] {
    const out: ReactNode[] = [];
    while (this.i < this.toks.length) {
      const t = this.peek();
      if (!t || stop(t)) break;
      const atom = this.atom();
      if (atom === null) continue;
      out.push(this.scripts(atom));
    }
    return out;
  }

  /** Attach any ^ / _ that follow an atom. */
  scripts(atom: { node: ReactNode; big: boolean }): ReactNode {
    let sub: ReactNode | undefined;
    let sup: ReactNode | undefined;
    for (;;) {
      const t = this.peek();
      if (t?.t === "sub" && sub === undefined) {
        this.next();
        sub = this.arg();
      } else if (t?.t === "sup" && sup === undefined) {
        this.next();
        sup = this.arg();
      } else break;
    }
    if (sub === undefined && sup === undefined) return atom.node;
    const limits = atom.big && this.display;
    if (sub !== undefined && sup !== undefined) {
      return limits ? (
        <munderover key={this.k()}>
          {atom.node}
          {sub}
          {sup}
        </munderover>
      ) : (
        <msubsup key={this.k()}>
          {atom.node}
          {sub}
          {sup}
        </msubsup>
      );
    }
    if (sub !== undefined)
      return limits ? (
        <munder key={this.k()}>
          {atom.node}
          {sub}
        </munder>
      ) : (
        <msub key={this.k()}>
          {atom.node}
          {sub}
        </msub>
      );
    return (
      <msup key={this.k()}>
        {atom.node}
        {sup}
      </msup>
    );
  }

  /** One argument: a {group} (as an mrow) or a single atom. */
  arg(): ReactNode {
    const t = this.peek();
    if (t?.t === "open") {
      this.next();
      const inner = this.seq((x) => x.t === "close");
      this.next();
      return <mrow key={this.k()}>{inner}</mrow>;
    }
    const a = this.atom();
    return a ? a.node : <mrow key={this.k()} />;
  }

  /** A delimiter after a left / right command (stretchy), or after big / Big (a fixed larger size). */
  fence(size?: string): ReactNode {
    const t = this.next();
    if (!t) return null;
    let ch = "";
    if (t.t === "char") ch = t.v === "." ? "" : t.v;
    else if (t.t === "cmd") ch = OPS[t.v] ?? t.v;
    if (ch === "") return null;
    return size ? (
      <mo key={this.k()} stretchy="true" fence="true" minsize={size} maxsize={size}>
        {ch}
      </mo>
    ) : (
      <mo key={this.k()} stretchy="true" fence="true">
        {ch}
      </mo>
    );
  }

  env(name: string): ReactNode {
    const rows: ReactNode[][][] = [[[]]];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.t === "cmd" && t.v === "end") {
        this.next();
        this.rawGroup();
        break;
      }
      if (t.t === "amp") {
        this.next();
        rows[rows.length - 1]?.push([]);
        continue;
      }
      if (t.t === "nl") {
        this.next();
        rows.push([[]]);
        continue;
      }
      const cells = rows[rows.length - 1];
      const cell = cells?.[cells.length - 1];
      const nodes = this.seq((x) => x.t === "amp" || x.t === "nl" || (x.t === "cmd" && x.v === "end"));
      cell?.push(...nodes);
    }
    const table = (
      <mtable key={this.k()} className={`tex-${name}`}>
        {rows
          .filter((r) => r.some((c) => c.length > 0))
          .map((r, ri) => (
            <mtr key={ri}>
              {r.map((c, ci) => (
                <mtd key={ci}>
                  <mrow>{c}</mrow>
                </mtd>
              ))}
            </mtr>
          ))}
      </mtable>
    );
    if (name === "cases")
      return (
        <mrow key={this.k()}>
          <mo stretchy="true" fence="true">
            {"{"}
          </mo>
          {table}
        </mrow>
      );
    if (name === "pmatrix" || name === "bmatrix")
      return (
        <mrow key={this.k()}>
          <mo stretchy="true" fence="true">
            {name === "pmatrix" ? "(" : "["}
          </mo>
          {table}
          <mo stretchy="true" fence="true">
            {name === "pmatrix" ? ")" : "]"}
          </mo>
        </mrow>
      );
    return table;
  }

  atom(): { node: ReactNode; big: boolean } | null {
    const t = this.next();
    if (!t) return null;
    const plain = (node: ReactNode): { node: ReactNode; big: boolean } => ({ node, big: false });
    switch (t.t) {
      case "open": {
        const inner = this.seq((x) => x.t === "close");
        this.next();
        return plain(<mrow key={this.k()}>{inner}</mrow>);
      }
      case "close":
      case "amp":
      case "nl":
      case "sp":
        return null;
      case "sup":
      case "sub":
        return plain(<mrow key={this.k()} />);
      case "num":
        return plain(<mn key={this.k()}>{t.v}</mn>);
      case "char": {
        if (/[a-zA-Z]/.test(t.v)) return plain(<mi key={this.k()}>{t.v}</mi>);
        if (t.v === "'") return plain(<mo key={this.k()}>′</mo>);
        if (t.v === "-") return plain(<mo key={this.k()}>−</mo>);
        if ("()[]|".includes(t.v))
          return plain(
            <mo key={this.k()} stretchy="false">
              {t.v}
            </mo>,
          );
        if (OP_CHARS.includes(t.v)) return plain(<mo key={this.k()}>{t.v}</mo>);
        return plain(<mi key={this.k()}>{t.v}</mi>);
      }
      case "cmd":
        return this.command(t.v);
    }
  }

  command(v: string): { node: ReactNode; big: boolean } | null {
    const plain = (node: ReactNode): { node: ReactNode; big: boolean } => ({ node, big: false });
    if (v === "frac" || v === "tfrac" || v === "dfrac") {
      const a = this.arg();
      const b = this.arg();
      const f = (
        <mfrac key={this.k()}>
          {a}
          {b}
        </mfrac>
      );
      return plain(
        v === "tfrac" ? (
          <mstyle key={this.k()} displaystyle="false">
            {f}
          </mstyle>
        ) : (
          f
        ),
      );
    }
    if (v === "sqrt") {
      const t = this.peek();
      if (t?.t === "char" && t.v === "[") {
        this.next();
        const idx = this.seq((x) => x.t === "char" && x.v === "]");
        this.next();
        const body = this.arg();
        return plain(
          <mroot key={this.k()}>
            {body}
            <mrow>{idx}</mrow>
          </mroot>,
        );
      }
      return plain(<msqrt key={this.k()}>{this.arg()}</msqrt>);
    }
    if (v === "text" || v === "textrm" || v === "mbox") {
      // MathML trims the edges of <mtext>: keep a leading or trailing space as real space.
      const raw = this.rawGroup();
      const lead = /^\s/.test(raw);
      const trail = /\s$/.test(raw);
      return plain(
        <mrow key={this.k()}>
          {lead ? <mspace width="0.3em" /> : null}
          <mtext>{raw.trim()}</mtext>
          {trail ? <mspace width="0.3em" /> : null}
        </mrow>,
      );
    }
    if (v === "texttt" || v === "mathtt")
      return plain(
        <mtext key={this.k()} className="tex-tt">
          {this.rawGroup()}
        </mtext>,
      );
    if (v === "mathrm" || v === "operatorname" || v === "mathsf") {
      const s = this.rawGroup();
      return { node: s.length === 1 ? <mi key={this.k()} mathvariant="normal">{s}</mi> : <mi key={this.k()}>{s}</mi>, big: v === "operatorname" && LIMIT_FUNCS.has(s) };
    }
    if (v === "mathit") {
      const s = this.rawGroup();
      return plain(
        <mi key={this.k()} className="tex-it">
          {s}
        </mi>,
      );
    }
    if (v === "mathrel" || v === "mathbin" || v === "mathop" || v === "mathord") return plain(<mrow key={this.k()}>{this.arg()}</mrow>);
    if (v === "mathbf" || v === "boldsymbol")
      return plain(
        <mrow key={this.k()} className="tex-bf">
          {this.arg()}
        </mrow>,
      );
    if (v === "mathcal" || v === "mathbb") {
      const s = this.rawGroup();
      const map = v === "mathcal" ? CAL : BB;
      return plain(<mi key={this.k()}>{Array.from(s, (ch) => map[ch] ?? ch).join("")}</mi>);
    }
    if (v === "left" || v === "right" || v === "bigl" || v === "bigr" || v === "Bigl" || v === "Bigr" || v === "big" || v === "Big") {
      const f = this.fence(v === "left" || v === "right" ? undefined : v.startsWith("B") ? "1.8em" : "1.25em");
      return f === null ? null : plain(f);
    }
    if (v === "begin") return plain(this.env(this.rawGroup()));
    if (v === "overline" || v === "bar")
      return plain(
        <mover key={this.k()} accent="true">
          {this.arg()}
          <mo stretchy="true">‾</mo>
        </mover>,
      );
    if (v === "hat" || v === "widehat")
      return plain(
        <mover key={this.k()} accent="true">
          {this.arg()}
          <mo>^</mo>
        </mover>,
      );
    if (v === "tilde" || v === "widetilde")
      return plain(
        <mover key={this.k()} accent="true">
          {this.arg()}
          <mo>~</mo>
        </mover>,
      );
    if (v === "vec")
      return plain(
        <mover key={this.k()} accent="true">
          {this.arg()}
          <mo>→</mo>
        </mover>,
      );
    if (v === "underbrace") {
      const body = this.arg();
      let label: ReactNode = null;
      if (this.peek()?.t === "sub") {
        this.next();
        label = this.arg();
      }
      return plain(
        <munder key={this.k()}>
          <munder>
            {body}
            <mo stretchy="true">⏟</mo>
          </munder>
          <mrow>{label}</mrow>
        </munder>,
      );
    }
    if (v === "!") return null;
    const space = SPACES[v];
    if (space !== undefined) return plain(<mspace key={this.k()} width={space} />);
    if (v === "pmod") {
      const a = this.arg();
      return plain(
        <mrow key={this.k()}>
          <mspace width="0.6em" />
          <mo>(</mo>
          <mi>mod</mi>
          <mspace width="0.3em" />
          {a}
          <mo>)</mo>
        </mrow>,
      );
    }
    const greek = GREEK[v];
    if (greek !== undefined) return plain(<mi key={this.k()}>{greek}</mi>);
    const big = BIGOPS[v];
    if (big !== undefined)
      return {
        node: (
          <mo key={this.k()} largeop={this.display ? "true" : "false"} movablelimits="true">
            {big}
          </mo>
        ),
        big: true,
      };
    if (LIMIT_FUNCS.has(v))
      return {
        node: (
          <mi key={this.k()} className="tex-fn">
            {v}
          </mi>
        ),
        big: true,
      };
    if (v === "bmod" || v === "mod")
      return plain(
        <mo key={this.k()} lspace="0.3em" rspace="0.3em">
          mod
        </mo>,
      );
    if (FUNCS.has(v))
      return plain(
        <mi key={this.k()} className="tex-fn">
          {v === "bmod" ? "mod" : v}
        </mi>,
      );
    const op = OPS[v];
    // Delimiters written without left / right commands keep their natural size.
    if (op !== undefined)
      return plain(
        FENCE_CHARS.has(op) ? (
          <mo key={this.k()} stretchy="false">
            {op}
          </mo>
        ) : (
          <mo key={this.k()}>{op}</mo>
        ),
      );
    return plain(<mtext key={this.k()}>{`\\${v}`}</mtext>);
  }
}

/** Parse a TeX-subset string into MathML React nodes. */
export function texToMathML(src: string, display = false): ReactNode[] {
  const p = new Parser(tokenize(src), display);
  return p.seq(() => false);
}

/** Inline math: <M>{"p = u + v = 67"}</M> */
export function M({ children, label }: { children: string; label?: string | undefined }): ReactElement {
  const nodes = useMemo(() => texToMathML(children, false), [children]);
  return (
    <math className={children.length > 44 ? "tex tex-long" : "tex"} aria-label={label}>
      <semantics>
        <mrow>{nodes}</mrow>
        <annotation encoding="application/x-tex">{children}</annotation>
      </semantics>
    </math>
  );
}

/** Display math (block), without a number. */
export function MB({ children, label }: { children: string; label?: string | undefined }): ReactElement {
  const nodes = useMemo(() => texToMathML(children, true), [children]);
  return (
    <math display="block" className="tex tex-block" aria-label={label}>
      <semantics>
        <mrow>{nodes}</mrow>
        <annotation encoding="application/x-tex">{children}</annotation>
      </semantics>
    </math>
  );
}

/** Several display lines aligned at "&" (an aligned environment). */
export function Lines({ children }: { children: readonly string[] }): ReactElement {
  return <MB>{`\\begin{aligned}${children.join(" \\\\ ")}\\end{aligned}`}</MB>;
}

