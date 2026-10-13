#!/usr/bin/env node
/**
 * Generates the reference data behind the in-app developer docs (/docs):
 *
 *   src/content/docs/generated/sdk.ts       every export of ../sdk/src/index.ts: kind, module, signature, JSDoc,
 *                                           and the integrator notes of sdk/README.md (TypeScript compiler API)
 *   src/content/docs/generated/programs.ts  the five programs under ../programs (the vault and the shield from
 *                                           the Anchor reference each implements, programs/<name>/anchor): program IDs, every
 *                                           instruction (docs, arguments, accounts in order with their
 *                                           constraints), account layouts with their sizes, errors with their
 *                                           codes, events, PDAs and constants (a tolerant Rust item scanner)
 *
 * `pnpm build` and `pnpm test` run it first, so shipped docs always match the source. By hand:
 *
 *   node scripts/gen-docs-reference.mjs            (from app/; also `pnpm docs:reference`)
 *   node scripts/gen-docs-reference.mjs --check    exits 1 if the committed files are stale
 *
 * test/docs.test.ts fails when an SDK export, instruction, error or event is missing from the generated files.
 * Pure Node + the app's own `typescript` dev dependency; nothing is fetched.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..");
const OUT_DIR = join(APP, "src", "content", "docs", "generated");
const CHECK = process.argv.includes("--check");

const posix = (p) => p.split(sep).join("/");

// ======================================================================= SDK ===

const SDK = join(REPO, "sdk");
const SDK_SRC = join(SDK, "src");

/** Which reference section a source file belongs to (path relative to sdk/src, no extension). */
const SDK_GROUPS = [
  { id: "constants", title: "Constants", match: (m) => m === "constants" },
  { id: "pda", title: "Addresses (PDAs)", match: (m) => m === "pda" },
  { id: "launch-params", title: "Launch parameters & policy", match: (m) => ["launch/policy", "launch/presets", "launch/curve", "launch/hash", "launch/recipients"].includes(m) },
  { id: "launch-accounts", title: "Launch accounts", match: (m) => m === "launch/accounts" },
  { id: "launch-tx", title: "Launch transactions", match: (m) => m === "launch/builders" || m === "launch/swap" || m === "launch/rules" },
  { id: "launch-flow", title: "Launch flow & window", match: (m) => m === "launch/flow" || m === "launch/window" },
  { id: "launch-quick", title: "Quick launch", match: (m) => m === "launch/quick" },
  { id: "metadata", title: "On-chain metadata", match: (m) => m.startsWith("metadata/") },
  { id: "verify", title: "Verify", match: (m) => m.startsWith("verify/") },
  { id: "qsl", title: "QSL-1 standard", match: (m) => m === "qsl" || m.startsWith("qsl/") },
  { id: "pq-lmots", title: "PQ: LM-OTS", match: (m) => m === "pq/lmots" || m === "pq/lmotsPublic" },
  { id: "pq-keys", title: "PQ: recovery phrase & keys", match: (m) => m === "pq/keys" || m === "pq/ledgerLock" },
  { id: "pq-identity", title: "PQ: identity, attestation & authorization", match: (m) => ["pq/identity", "pq/lms", "pq/lmsPublic", "pq/leafLedger", "pq/legacyNamespace", "pq/attest", "pq/authorize", "pq/signGuard"].includes(m) },
  { id: "pq-vault", title: "PQ vault", match: (m) => ["pq/vault", "pq/vaultLedger", "pq/withdrawMessage"].includes(m) },
  { id: "v1", title: "v1 transactions", match: (m) => m === "tx/v1" },
  { id: "shield", title: "Shield", match: (m) => m.startsWith("shield/") },
  { id: "rpc", title: "RPC helpers", match: (m) => m.startsWith("rpc/") },
  { id: "token", title: "Token-2022 helpers", match: (m) => m.startsWith("token/") },
  { id: "rules", title: "Launch rules (PXR1)", match: (m) => m.startsWith("programmable/rules/") || m.startsWith("programmable/cond/") },
  { id: "graphs", title: "Autopilot graphs (PXG1)", match: (m) => m.startsWith("programmable/graph/") || m === "programmable/templates" },
  { id: "autopilot-logic", title: "Autopilot: the program's decisions", match: (m) => m.startsWith("programmable/autopilot/") },
  { id: "autopilot", title: "Autopilot accounts & transactions", match: (m) => m.startsWith("autopilot/") },
  { id: "programmable", title: "Programmable: units, bytes & errors", match: (m) => m.startsWith("programmable/") },
  { id: "codec", title: "IDLs & codecs", match: (m) => m.startsWith("idl/") || m.startsWith("codec/") },
  { id: "types", title: "Types", match: (m) => m === "types" },
];

/** Modules without an explicit group fall back by directory (and say so), so a new SDK file never breaks the docs. */
const SDK_GROUP_FALLBACK = [
  ["launch/", "launch-params"],
  ["metadata/", "metadata"],
  ["pq/", "pq-keys"],
  ["tx/", "v1"],
  ["rpc/", "rpc"],
  ["token/", "token"],
  ["shield/", "shield"],
  ["verify/", "verify"],
  ["qsl/", "qsl"],
  ["autopilot/", "autopilot"],
  ["programmable/", "programmable"],
];

function sdkGroup(module) {
  const g = SDK_GROUPS.find((x) => x.match(module));
  if (g) return g.id;
  const fallback = SDK_GROUP_FALLBACK.find(([prefix]) => module.startsWith(prefix))?.[1] ?? "types";
  console.warn(`gen-docs-reference: no SDK reference group for module ${module}; listed under "${fallback}"`);
  return fallback;
}

/** Function names -> integrator notes, from the tables of sdk/README.md ("| `fn(...)` | notes |"). */
function readmeNotes() {
  const notes = new Map();
  const text = readFileSync(join(SDK, "README.md"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const head = cells[1] ?? "";
    const body = (cells[2] ?? "").replace(/\\\|/g, "|");
    if (!body || /^-+$/.test(body)) continue;
    // Names are the code spans of the first cell that start with an identifier (not "(conn, ...)").
    for (const m of head.matchAll(/`([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (!notes.has(name)) notes.set(name, body);
    }
  }
  return notes;
}

function jsdocOf(checker, symbol) {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  const tags = symbol.getJsDocTags(checker);
  const deprecated = tags.some((t) => t.name === "deprecated");
  const extra = tags
    .filter((t) => t.name === "example" || t.name === "remarks")
    .map((t) => ts.displayPartsToString(t.text ?? []).trim())
    .filter(Boolean);
  return { doc: [text, ...extra].filter(Boolean).join("\n\n"), deprecated };
}

function stripExport(text) {
  return text.replace(/^export\s+(declare\s+)?(default\s+)?/, "");
}

/** `function name<T>(a: A, b: B): R` laid out one parameter per line when long. */
function functionSignature(decl, sf, name) {
  const tp = decl.typeParameters ? `<${decl.typeParameters.map((p) => p.getText(sf)).join(", ")}>` : "";
  const params = decl.parameters.map((p) => p.getText(sf).replace(/\s+/g, " "));
  const ret = decl.type ? `: ${decl.type.getText(sf).replace(/\s+/g, " ")}` : "";
  const one = `function ${name}${tp}(${params.join(", ")})${ret}`;
  if (one.length <= 96 || params.length === 0) return one;
  return `function ${name}${tp}(\n${params.map((p) => `  ${p},`).join("\n")}\n)${ret}`;
}

function constSignature(decl, sf, checker, name) {
  const init = decl.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const params = init.parameters.map((p) => p.getText(sf).replace(/\s+/g, " "));
    const ret = init.type ? `: ${init.type.getText(sf)}` : "";
    return `const ${name} = (${params.join(", ")})${ret} => …`;
  }
  if (decl.type) {
    const t = decl.type.getText(sf);
    if (init && init.getText(sf).length <= 1600 && !/^\s*\(/.test(init.getText(sf))) return `const ${name}: ${t} = ${init.getText(sf)}`;
    return `const ${name}: ${t}`;
  }
  if (init) {
    const text = init.getText(sf);
    if (text.length <= 1600) return `const ${name} = ${text}`;
  }
  const type = checker.typeToString(checker.getTypeAtLocation(decl), decl, ts.TypeFormatFlags.NoTruncation);
  return `const ${name}: ${type}`;
}

function classSignature(decl, sf) {
  const heritage = (decl.heritageClauses ?? []).map((h) => h.getText(sf)).join(" ");
  const lines = [`class ${decl.name?.getText(sf) ?? ""}${heritage ? ` ${heritage}` : ""} {`];
  for (const m of decl.members) {
    const mods = ts.getCombinedModifierFlags(m);
    if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    if (m.name && ts.isPrivateIdentifier(m.name)) continue;
    let text;
    if (ts.isConstructorDeclaration(m)) text = `constructor(${m.parameters.map((p) => p.getText(sf)).join(", ")});`;
    else if (ts.isMethodDeclaration(m)) text = `${m.name.getText(sf)}(${m.parameters.map((p) => p.getText(sf)).join(", ")})${m.type ? `: ${m.type.getText(sf)}` : ""};`;
    else if (ts.isPropertyDeclaration(m)) text = `${mods & ts.ModifierFlags.Readonly ? "readonly " : ""}${mods & ts.ModifierFlags.Static ? "static " : ""}${m.name.getText(sf)}${m.type ? `: ${m.type.getText(sf)}` : ""};`;
    else if (ts.isGetAccessorDeclaration(m)) text = `get ${m.name.getText(sf)}()${m.type ? `: ${m.type.getText(sf)}` : ""};`;
    if (text) lines.push(`  ${text.replace(/\s+/g, " ")}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function describeDeclaration(decl, checker, name) {
  const sf = decl.getSourceFile();
  if (ts.isFunctionDeclaration(decl)) return { kind: "function", signature: functionSignature(decl, sf, name) };
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    return { kind: fn ? "function" : "const", signature: constSignature(decl, sf, checker, name) };
  }
  if (ts.isClassDeclaration(decl)) return { kind: "class", signature: classSignature(decl, sf) };
  if (ts.isInterfaceDeclaration(decl)) return { kind: "interface", signature: stripExport(decl.getText(sf)) };
  if (ts.isTypeAliasDeclaration(decl)) return { kind: "type", signature: stripExport(decl.getText(sf)) };
  if (ts.isEnumDeclaration(decl)) return { kind: "const", signature: stripExport(decl.getText(sf)) };
  return { kind: "const", signature: `${name}` };
}

function moduleOf(decl) {
  return posix(relative(SDK_SRC, decl.getSourceFile().fileName)).replace(/\.(d\.)?ts$/, "");
}

function generateSdk() {
  const index = join(SDK_SRC, "index.ts");
  const program = ts.createProgram([index], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(index);
  if (!sf) throw new Error("sdk/src/index.ts not found");
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const notes = readmeNotes();
  const entries = [];
  const pkg = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));

  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const name = exp.getName();
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decls = target.getDeclarations() ?? [];
    // `export * as lmots from "./pq/lmots.js"`: a namespace of functions.
    if (decls.length > 0 && ts.isSourceFile(decls[0])) {
      const file = decls[0];
      const members = [];
      for (const m of checker.getExportsOfModule(target)) {
        const mt = m.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(m) : m;
        const md = (mt.getDeclarations() ?? []).find((d) => !ts.isFunctionDeclaration(d) || d.body) ?? mt.getDeclarations()?.[0];
        if (!md) continue;
        const { kind, signature } = describeDeclaration(md, checker, m.getName());
        const { doc, deprecated } = jsdocOf(checker, mt);
        members.push({ name: m.getName(), kind, signature, doc, deprecated });
      }
      members.sort((a, b) => a.name.localeCompare(b.name));
      const module = posix(relative(SDK_SRC, file.fileName)).replace(/\.ts$/, "");
      entries.push({
        name,
        kind: "namespace",
        module,
        group: sdkGroup(module),
        signature: `import { ${name} } from "@noisedlabs/sdk";   // namespace: ${members.length} members`,
        doc: (ts.getJSDocCommentsAndTags(file.statements[0] ?? file).map((c) => (typeof c.comment === "string" ? c.comment : "")).join("\n") || "").trim(),
        notes: notes.get(name) ?? "",
        deprecated: false,
        typeOnly: false,
        members,
      });
      continue;
    }
    // Overloads: show the implementation's signature once (or the first declaration).
    const decl = decls.find((d) => ts.isFunctionDeclaration(d) && d.body) ?? decls.find((d) => !ts.isFunctionDeclaration(d) || d.body) ?? decls[0];
    if (!decl) continue;
    const module = moduleOf(decl);
    const { kind, signature } = describeDeclaration(decl, checker, name);
    const { doc, deprecated } = jsdocOf(checker, target);
    const typeOnly = kind === "interface" || kind === "type";
    entries.push({ name, kind, module, group: sdkGroup(module), signature, doc, notes: notes.get(name) ?? "", deprecated, typeOnly, members: [] });
  }
  const order = new Map(SDK_GROUPS.map((g, i) => [g.id, i]));
  const kindOrder = { function: 0, class: 1, namespace: 2, const: 3, interface: 4, type: 5 };
  entries.sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0) || kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));
  return {
    packageName: pkg.name,
    version: pkg.version,
    groups: SDK_GROUPS.map(({ id, title }) => ({ id, title })),
    entries,
  };
}

// ================================================================== programs ===

const PROGRAMS = [
  { dir: "noised-launchpad", crate: "noised_launchpad", title: "Launchpad", slug: "launchpad" },
  { dir: "noised-hook", crate: "noised_hook", title: "Launch Guard (transfer hook)", slug: "hook" },
  // Written without Anchor; its Anchor reference (same ABI and checks, not compiled) documents it.
  { dir: "noised-vault", crate: "noised_vault", title: "PQ vault", slug: "vault", src: "anchor" },
  // Likewise written without Anchor, documented from its Anchor reference.
  { dir: "noised-shield", crate: "noised_shield", title: "Shield", slug: "shield", src: "anchor" },
  { dir: "noised-autopilot", crate: "noised_autopilot", title: "Autopilot", slug: "autopilot" },
];

/** Index just past the string / char literal / comment that starts at `i`, or -1 if none starts there. */
function skipLiteral(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const e = src.indexOf("\n", i);
    return e < 0 ? src.length : e;
  }
  if (c === "/" && src[i + 1] === "*") {
    let depth = 1;
    let j = i + 2;
    while (j < src.length && depth > 0) {
      if (src[j] === "/" && src[j + 1] === "*") {
        depth++;
        j += 2;
      } else if (src[j] === "*" && src[j + 1] === "/") {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  }
  // Raw strings: r"..." r#"..."# br#"..."# (the prefix must not continue an identifier).
  const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 12));
  if (raw && !/[\w]/.test(src[i - 1] ?? "")) {
    const close = `"${raw[2]}`;
    const e = src.indexOf(close, i + raw[0].length);
    return e < 0 ? src.length : e + close.length;
  }
  if (c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "'") {
    // Char literal ('a', '\n', '\u{1F600}') or lifetime ('info).
    if (src[i + 1] === "\\") {
      const e = src.indexOf("'", i + 2);
      return e < 0 ? i + 1 : e + 1;
    }
    if (src[i + 2] === "'") return i + 3;
    return -1;
  }
  return -1;
}

/** Index of the bracket that closes the one at `open` (one of ( [ {). */
function matchBracket(src, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length) {
    const s = skipLiteral(src, i);
    if (s >= 0) {
      i = s;
      continue;
    }
    const c = src[i];
    if (c in pairs) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) throw new Error(`unbalanced bracket at ${i}`);
      if (stack.length === 0) return i;
    }
    i++;
  }
  throw new Error(`unclosed bracket at ${open}`);
}

/** End of the item starting at `i`: after its `;` at depth 0, or after the block of its first `{` at depth 0. */
function itemEnd(src, i, limit) {
  let depth = 0;
  while (i < limit) {
    const s = skipLiteral(src, i);
    if (s >= 0) {
      i = s;
      continue;
    }
    const c = src[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth === 0) return { bodyStart: i, end: matchBracket(src, i) + 1 };
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth === 0) return { bodyStart: -1, end: i + 1 };
    i++;
  }
  return { bodyStart: -1, end: limit };
}

const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Doc comment lines -> one text with paragraphs; code fences kept as written. */
function joinDocs(lines) {
  const out = [];
  let fence = false;
  for (const raw of lines) {
    const l = raw.replace(/^ ?/, "");
    if (/^```/.test(l.trim())) {
      fence = !fence;
      out.push(l.trim());
      continue;
    }
    out.push(fence ? l : l.trimEnd());
  }
  return out.join("\n").trim();
}

/**
 * Items of a Rust source range: { kind, name, docs, attrs, header, body, vis } for fn, struct, enum, mod, const,
 * static, impl, trait, type, use and macro items. Doc comments (///) and outer attributes (#[...]) attach to the
 * next item; anything else is skipped.
 */
function scanItems(src, start = 0, limit = src.length) {
  const items = [];
  let docs = [];
  let attrs = [];
  let i = start;
  while (i < limit) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("///", i) && src[i + 3] !== "/") {
      const e = src.indexOf("\n", i);
      docs.push(src.slice(i + 3, e < 0 ? limit : e).replace(/\r$/, ""));
      i = e < 0 ? limit : e + 1;
      continue;
    }
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      i = skipLiteral(src, i);
      continue;
    }
    if (src.startsWith("#![", i)) {
      i = matchBracket(src, i + 2) + 1;
      continue;
    }
    if (src.startsWith("#[", i)) {
      const e = matchBracket(src, i + 1);
      attrs.push(src.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    const head = src.slice(i, Math.min(limit, i + 240));
    const m = /^(pub(?:\s*\([^)]*\))?\s+)?((?:const\s+|unsafe\s+|async\s+|extern\s+"C"\s+)*)(fn|struct|enum|mod|const|static|impl|trait|type|use|union)\b\s*([A-Za-z_][\w]*)?/.exec(head);
    const macro = /^([A-Za-z_][\w]*)!\s*[({[]/.exec(head);
    const { bodyStart, end } = itemEnd(src, i, limit);
    if (m) {
      let kind = m[3];
      let name = m[4] ?? "";
      if (kind === "const" && name === "fn") {
        kind = "fn";
        name = /fn\s+([A-Za-z_]\w*)/.exec(head)?.[1] ?? "";
      }
      if (m[2] && /const\s+$/.test(m[2]) && kind === "fn") kind = "fn";
      items.push({
        kind,
        name,
        vis: Boolean(m[1]),
        docs: joinDocs(docs),
        attrs,
        start: i,
        header: src.slice(i, bodyStart >= 0 ? bodyStart : end),
        bodyStart,
        end,
      });
    } else if (macro) {
      items.push({ kind: "macro", name: macro[1], vis: false, docs: joinDocs(docs), attrs, start: i, header: src.slice(i, end), bodyStart, end });
    }
    docs = [];
    attrs = [];
    i = end;
  }
  return items;
}

/** Fields of a braced struct body (or variants of an enum body): docs, attrs, name, type. */
function scanFields(src, open, close) {
  const out = [];
  let docs = [];
  let attrs = [];
  let i = open + 1;
  while (i < close) {
    const c = src[i];
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith("///", i) && src[i + 3] !== "/") {
      const e = src.indexOf("\n", i);
      docs.push(src.slice(i + 3, e).replace(/\r$/, ""));
      i = e + 1;
      continue;
    }
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      i = skipLiteral(src, i);
      continue;
    }
    if (src.startsWith("#[", i)) {
      const e = matchBracket(src, i + 1);
      attrs.push(src.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    // One field / variant: up to the next comma at depth 0 (angle brackets count too).
    let j = i;
    let depth = 0;
    while (j < close) {
      const s = skipLiteral(src, j);
      if (s >= 0) {
        j = s;
        continue;
      }
      const d = src[j];
      if ("([{<".includes(d)) depth++;
      else if (")]}".includes(d)) depth--;
      else if (d === ">" && src[j - 1] !== "-" && src[j - 1] !== "=") depth--;
      else if (d === "," && depth === 0) break;
      j++;
    }
    const text = src.slice(i, j).trim();
    const fm = /^(pub(?:\s*\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*(?::\s*([\s\S]+))?$/.exec(text);
    if (fm) out.push({ name: fm[2], type: fm[3] ? squash(fm[3]) : "", docs: joinDocs(docs), attrs });
    else out.push({ name: text.split(/[\s({]/)[0] ?? text, type: "", docs: joinDocs(docs), attrs, raw: squash(text) });
    docs = [];
    attrs = [];
    i = j + 1;
  }
  return out;
}

const attrName = (a) => /^#\[\s*([\w:]+)/.exec(a)?.[1] ?? "";
const attrArgs = (a) => {
  const open = a.indexOf("(");
  return open < 0 ? "" : squash(a.slice(open + 1, a.lastIndexOf(")")).replace(/,\s*$/, ""));
};
const hasAttr = (item, name) => item.attrs.some((a) => attrName(a) === name);

/** Collect every `.rs` file of a source tree (tests excluded). */
function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests") continue;
      out.push(...rustFiles(p));
    } else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** Constants of a file, including those in inline `mod x { ... }` blocks: { path, name, type, value, docs }. */
function collectConsts(src, items, prefix, out) {
  for (const it of items) {
    if ((it.kind === "const" || it.kind === "static") && it.name && it.name !== "_") {
      const cm = /:\s*([\s\S]+?)\s*=\s*([\s\S]+?);\s*$/.exec(it.header);
      if (cm) out.push({ path: prefix ? `${prefix}::${it.name}` : it.name, name: it.name, type: squash(cm[1]), value: squash(cm[2]), docs: it.docs, cfg: it.attrs.filter((a) => attrName(a) === "cfg").map(attrArgs) });
    } else if (it.kind === "mod" && it.bodyStart >= 0 && !hasAttr(it, "cfg") && !hasAttr(it, "program")) {
      collectConsts(src, scanItems(src, it.bodyStart + 1, it.end - 1), prefix ? `${prefix}::${it.name}` : it.name, out);
    }
  }
}

// ----------------------------------------------------------- const values ---

/** Evaluate a constant expression (integers, + - * / % << >> as casts, .len() of byte strings, other constants). */
function makeEvaluator(consts) {
  const byName = new Map();
  for (const c of consts) {
    if (!byName.has(c.name)) byName.set(c.name, c);
    byName.set(c.path, c);
  }
  const cache = new Map();
  function value(name, seen = new Set()) {
    if (cache.has(name)) return cache.get(name);
    const c = byName.get(name);
    if (!c || seen.has(name)) return undefined;
    seen.add(name);
    const v = evaluate(c.value, seen);
    cache.set(name, v);
    return v;
  }
  function evaluate(expr, seen = new Set()) {
    const bs = /^b"((?:[^"\\]|\\.)*)"$/.exec(expr.trim());
    if (bs) return { bytes: bs[1] };
    let e = expr
      .replace(/\bas\s+(u8|u16|u32|u64|u128|usize|i64|i32)\b/g, "")
      .replace(/([A-Z_][A-Z0-9_]*)\.len\(\)/g, (_, n) => {
        const v = value(n, seen);
        return v && typeof v === "object" ? String(v.bytes.length) : "NaN";
      })
      .replace(/(\d)_(?=\d)/g, "$1");
    e = e.replace(/(?:[a-z_]+::)*([A-Z_][A-Z0-9_]*)/g, (_, n) => {
      const v = value(n, seen);
      return typeof v === "number" ? String(v) : "NaN";
    });
    if (!/^[\d\s+\-*/%()<>]+$/.test(e)) return undefined;
    const v = arithmetic(e);
    return Number.isFinite(v) ? v : undefined;
  }
  return { value, evaluate };
}

/** Integer arithmetic: + - * / % << >> and parentheses, Rust precedence (no dynamic code). */
function arithmetic(text) {
  const toks = text.match(/\d+|<<|>>|[-+*/%()]/g) ?? [];
  let k = 0;
  const peek = () => toks[k];
  const take = () => toks[k++];
  function primary() {
    const t = take();
    if (t === "(") {
      const v = shift();
      take();
      return v;
    }
    if (t === "-") return -primary();
    return Number(t);
  }
  function mul() {
    let v = primary();
    while (["*", "/", "%"].includes(peek())) {
      const op = take();
      const r = primary();
      v = op === "*" ? v * r : op === "/" ? Math.trunc(v / r) : v % r;
    }
    return v;
  }
  function add() {
    let v = mul();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + mul() : v - mul();
    return v;
  }
  function shift() {
    let v = add();
    while (peek() === "<<" || peek() === ">>") v = take() === "<<" ? v * 2 ** add() : Math.trunc(v / 2 ** add());
    return v;
  }
  const v = shift();
  return k === toks.length ? v : NaN;
}

// ------------------------------------------------------------- type sizes ---

function makeSizer(evalr, structs, enums) {
  const prim = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, Pubkey: 32 };
  function size(type, maxLen) {
    const t = type.replace(/\s+/g, "");
    if (t in prim) return prim[t];
    const arr = /^\[(.+);(.+)\]$/.exec(t);
    if (arr) {
      const n = evalr.evaluate(arr[2]);
      const inner = size(arr[1]);
      return typeof n === "number" && typeof inner === "number" ? n * inner : undefined;
    }
    const opt = /^Option<(.+)>$/.exec(t);
    if (opt) {
      const inner = size(opt[1]);
      return typeof inner === "number" ? 1 + inner : undefined;
    }
    const vec = /^Vec<(.+)>$/.exec(t);
    if (vec || t === "String") {
      const n = maxLen === undefined ? undefined : evalr.evaluate(maxLen);
      const inner = vec ? size(vec[1]) : 1;
      return typeof n === "number" && typeof inner === "number" ? 4 + n * inner : undefined;
    }
    if (structs.has(t)) {
      let total = 0;
      for (const f of structs.get(t)) {
        const ml = f.attrs.map((a) => (attrName(a) === "max_len" ? attrArgs(a) : null)).find((x) => x !== null);
        const s = size(f.type, ml ?? undefined);
        if (typeof s !== "number") return undefined;
        total += s;
      }
      return total;
    }
    if (enums.has(t)) {
      const vs = enums.get(t);
      return vs.every((v) => !v.type && !v.raw) ? 1 : undefined;
    }
    return undefined;
  }
  return size;
}

// ---------------------------------------------------------- seed display ---

/** `[LAUNCH_SEED, creator.key().as_ref(), &launch_seed]` -> `["launch", creator, launch_seed]`. */
function prettySeeds(seedsExpr, seedConsts) {
  const inner = seedsExpr.trim().replace(/^&?\[/, "").replace(/\]$/, "");
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const name = p.replace(/^&/, "").replace(/\.as_ref\(\)$/, "").replace(/\.as_bytes\(\)$/, "");
      if (seedConsts.has(name)) return `"${seedConsts.get(name)}"`;
      const bs = /^b"([^"]*)"(?:\.as_ref\(\))?$/.exec(name);
      if (bs) return `"${bs[1]}"`;
      return name
        .replace(/\.key\(\)/g, "")
        .replace(/\.as_ref\(\)/g, "")
        .replace(/\.to_le_bytes\(\)/g, " (u64 LE)")
        .replace(/^&/, "")
        .replace(/identity_id::<\w+>\(&?([\w.]+)\)/, "SHA256(0x21 || $1)");
    });
}

function accountFlags(f) {
  const acc = f.attrs.filter((a) => attrName(a) === "account").map(attrArgs).join(", ");
  const tokens = acc.split(/[\s,()]+/);
  const type = f.type.replace(/'info,\s*/g, "").replace(/<'info>/g, "");
  return {
    signer: /^(Box<)?Signer\b/.test(type) || tokens.includes("signer"),
    writable: tokens.includes("mut") || tokens.includes("init") || tokens.includes("init_if_needed") || /\bclose\s*=/.test(acc),
    optional: /^Option</.test(type),
    init: tokens.includes("init") ? "init" : tokens.includes("init_if_needed") ? "init_if_needed" : "",
    constraints: acc,
    type,
  };
}

function generatePrograms() {
  // Constants of the LM-OTS / LMS crate resolve array lengths in the programs (LMS_SIG_LEN, ID_LEN, N, ...).
  const crateConsts = [];
  for (const file of rustFiles(join(REPO, "crates", "noised-lmots", "src"))) {
    const src = readFileSync(file, "utf8");
    collectConsts(src, scanItems(src), "", crateConsts);
  }
  // Seed constants of every program (the launchpad derives the hook's policy PDA with POLICY_SEED, ...).
  const seedConsts = new Map();
  for (const meta of PROGRAMS) {
    for (const file of rustFiles(join(REPO, "programs", meta.dir, meta.src ?? "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/pub const ([A-Z_]+_SEED): &\[u8\] = b"([^"]*)";/g)) seedConsts.set(m[1], m[2]);
    }
  }

  const programs = [];
  for (const meta of PROGRAMS) {
    const root = join(REPO, "programs", meta.dir, meta.src ?? "src");
    const files = rustFiles(root).map((p) => ({ path: posix(relative(REPO, p)), src: readFileSync(p, "utf8") }));
    const consts = [];
    const structs = new Map();
    const enums = new Map();
    const accountsStructs = new Map();
    const handlers = new Map();
    const stateAccounts = [];
    const argTypes = [];
    const events = [];
    let errors = [];
    let errorEnum = "";
    let programMod = null;
    let programId = "";
    let crateDocs = "";

    for (const f of files) {
      const items = scanItems(f.src);
      collectConsts(f.src, items, posix(relative(root, join(REPO, f.path))).replace(/\.rs$/, "").replace(/^lib$/, "").replace(/\//g, "::"), consts);
      if (f.path.endsWith("/lib.rs")) {
        const inner = [...f.src.matchAll(/^\/\/!(.*)$/gm)].map((m) => m[1]);
        crateDocs = joinDocs(inner);
      }
      const walk = (list, filePath) => {
        for (const it of list) {
          if (it.kind === "macro" && it.name === "declare_id") programId = /"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(it.header)?.[1] ?? programId;
          if (it.kind === "mod" && hasAttr(it, "program")) programMod = { item: it, src: f.src, path: filePath };
          if (it.kind === "mod" && it.bodyStart >= 0 && !hasAttr(it, "cfg") && !hasAttr(it, "program")) walk(scanItems(f.src, it.bodyStart + 1, it.end - 1), filePath);
          if (it.kind === "fn" && /^handle_/.test(it.name)) handlers.set(it.name.replace(/^handle_/, ""), { docs: it.docs, path: filePath });
          if (it.kind === "struct" && it.bodyStart >= 0) {
            const fields = scanFields(f.src, it.bodyStart, it.end - 1);
            structs.set(it.name, fields);
            const derive = it.attrs.filter((a) => attrName(a) === "derive").map(attrArgs).join(", ");
            if (/\bAccounts\b/.test(derive)) {
              const ixAttr = it.attrs.find((a) => attrName(a) === "instruction");
              accountsStructs.set(it.name, { fields, path: filePath, instructionArgs: ixAttr ? attrArgs(ixAttr) : "" });
            } else if (it.attrs.some((a) => /^#\[\s*account\s*(\]|\()/.test(a))) stateAccounts.push({ name: it.name, docs: it.docs, fields, path: filePath });
            else if (hasAttr(it, "event")) events.push({ name: it.name, docs: it.docs, fields, path: filePath });
            else if (/AnchorSerialize|AnchorDeserialize/.test(derive)) argTypes.push({ name: it.name, kind: "struct", docs: it.docs, fields, path: filePath });
          }
          if (it.kind === "enum" && it.bodyStart >= 0) {
            const variants = scanFields(f.src, it.bodyStart, it.end - 1);
            enums.set(it.name, variants);
            if (hasAttr(it, "error_code")) {
              const offset = Number(/offset\s*=\s*(\d+)/.exec(it.attrs.find((a) => attrName(a) === "error_code") ?? "")?.[1] ?? 6000);
              errorEnum = it.name;
              errors = variants.map((v, k) => ({
                code: offset + k,
                name: v.name,
                msg: /#\[\s*msg\(\s*"((?:[^"\\]|\\.)*)"/.exec(v.attrs.join(" "))?.[1]?.replace(/\\"/g, '"') ?? "",
                docs: v.docs,
              }));
            } else {
              const derive = it.attrs.filter((a) => attrName(a) === "derive").map(attrArgs).join(", ");
              if (/AnchorSerialize|AnchorDeserialize/.test(derive)) argTypes.push({ name: it.name, kind: "enum", docs: it.docs, fields: variants, path: filePath });
            }
          }
        }
      };
      walk(items, f.path);
    }
    if (!programMod) throw new Error(`${meta.dir}: no #[program] module`);
    if (!programId) throw new Error(`${meta.dir}: no declare_id!`);

    const evalr = makeEvaluator([...consts, ...crateConsts]);
    const sizer = makeSizer(evalr, structs, enums);

    // Instructions, in program order.
    const instructions = [];
    const pdas = new Map();
    const pmod = programMod.item;
    for (const it of scanItems(programMod.src, pmod.bodyStart + 1, pmod.end - 1)) {
      if (it.kind !== "fn" || !it.vis) continue;
      const sig = it.header;
      const open = sig.indexOf("(");
      const close = matchBracket(sig, open);
      const params = [];
      let depth = 0;
      let cur = "";
      for (const ch of sig.slice(open + 1, close)) {
        if ("(<[".includes(ch)) depth++;
        if (")>]".includes(ch)) depth--;
        if (ch === "," && depth === 0) {
          params.push(cur);
          cur = "";
        } else cur += ch;
      }
      if (cur.trim()) params.push(cur);
      const parsed = params.map((p) => squash(p)).filter(Boolean).map((p) => {
        const k = p.indexOf(":");
        return { name: p.slice(0, k).trim(), type: p.slice(k + 1).trim() };
      });
      const ctx = parsed.shift();
      const ctxType = /Context<\s*(?:'info\s*,\s*)?([A-Za-z_]\w*)/.exec(ctx?.type ?? "")?.[1] ?? "";
      const accountsDef = accountsStructs.get(ctxType);
      if (!accountsDef) throw new Error(`${meta.dir}: accounts struct ${ctxType} of ${it.name} not found`);
      const discriminatorAttr = it.attrs.find((a) => attrName(a) === "instruction");
      const handler = handlers.get(it.name);
      const accounts = accountsDef.fields.map((f, index) => {
        const flags = accountFlags(f);
        const seedsExpr = /\bseeds\s*=\s*(&?\[[^\]]*(?:\[[^\]]*\][^\]]*)*\])/.exec(flags.constraints)?.[1] ?? "";
        const seedsProgram = /\bseeds::program\s*=\s*([\w:.()]+)/.exec(flags.constraints)?.[1] ?? "";
        const seeds = seedsExpr ? prettySeeds(seedsExpr, seedConsts) : [];
        if (seeds.length > 0) {
          // One entry per PDA family (same first seed and arity): instructions spell the same address differently
          // (["vault", mint, key_id_arg] when opening, ["vault", mint, vault.genesis_key_id] afterwards).
          const key = `${seeds[0]}/${seeds.length}@${seedsProgram}`;
          const entry = pdas.get(key) ?? { seeds, program: seedsProgram, names: new Set(), forms: new Set(), docs: "" };
          entry.names.add(f.name);
          entry.forms.add(seeds.join(", "));
          if (!entry.docs && f.docs) entry.docs = f.docs;
          pdas.set(key, entry);
        }
        return {
          index,
          name: f.name,
          type: flags.type,
          signer: flags.signer,
          writable: flags.writable,
          optional: flags.optional,
          init: flags.init,
          seeds,
          seedsProgram,
          constraints: flags.constraints,
          docs: f.docs.replace(/^CHECK:\s*/, ""),
        };
      });
      instructions.push({
        name: it.name,
        docs: it.docs,
        handlerDocs: handler?.docs ?? "",
        file: handler?.path ?? accountsDef.path,
        args: parsed,
        accountsStruct: ctxType,
        instructionAttr: accountsDef.instructionArgs,
        customDiscriminator: discriminatorAttr ? attrArgs(discriminatorAttr).replace(/^discriminator\s*=\s*/, "") : "",
        accounts,
      });
    }

    // PDAs a handler derives in code (`let (batch_authority, bump) = Pubkey::find_program_address(&[BATCH_SEED, ...], &crate::ID)`).
    for (const f of files) {
      for (const m of f.src.matchAll(/let\s*\(\s*([a-z_]\w*)\s*,[^)]*\)\s*=\s*(?:Pubkey::)?find_program_address\(\s*&(\[[^\]]*\])\s*,\s*&([\w:]+)\s*,?\s*\)/g)) {
        const seeds = prettySeeds(m[2], seedConsts);
        if (!/^"/.test(seeds[0] ?? "")) continue;
        const program = m[3] === "crate::ID" ? "" : m[3];
        const key = `${seeds[0]}/${seeds.length}@${program}`;
        if ([...pdas.keys()].some((k) => k.startsWith(`${seeds[0]}/`) && k.endsWith(`@${program}`))) continue;
        pdas.set(key, { seeds, program, names: new Set([m[1]]), forms: new Set([seeds.join(", ")]), docs: "" });
      }
    }

    // Argument types used by instructions (and the types they contain).
    const argNames = new Set();
    const wanted = (t) => {
      for (const m of t.matchAll(/[A-Z][A-Za-z0-9_]*/g)) {
        if (argTypes.some((a) => a.name === m[0]) && !argNames.has(m[0])) {
          argNames.add(m[0]);
          const def = argTypes.find((a) => a.name === m[0]);
          for (const f of def?.fields ?? []) wanted(f.type);
        }
      }
    };
    for (const ix of instructions) for (const a of ix.args) wanted(a.type);
    for (const acc of stateAccounts) for (const f of acc.fields) wanted(f.type);

    const fieldsOut = (fields, withSizes) =>
      fields.map((f) => {
        const maxLen = f.attrs.map((a) => (attrName(a) === "max_len" ? attrArgs(a) : null)).find((x) => x !== null);
        const size = withSizes ? sizer(f.type, maxLen ?? undefined) : undefined;
        return { name: f.name, type: f.type || f.raw || "", docs: f.docs, ...(maxLen ? { maxLen } : {}), ...(typeof size === "number" ? { size } : {}) };
      });

    const accountsOut = stateAccounts.map((a) => {
      const space = sizer(a.name);
      const version = consts.find((c) => c.path.endsWith(`${a.name}::VERSION`))?.value;
      return { name: a.name, docs: a.docs, file: a.path, size: typeof space === "number" ? space + 8 : null, fields: fieldsOut(a.fields, true), ...(version ? { version } : {}) };
    });

    programs.push({
      slug: meta.slug,
      crate: meta.crate,
      title: meta.title,
      dir: `programs/${meta.dir}`,
      programId,
      docs: crateDocs,
      instructions,
      accounts: accountsOut,
      types: argTypes.filter((t) => argNames.has(t.name)).map((t) => ({ name: t.name, kind: t.kind, docs: t.docs, file: t.path, fields: fieldsOut(t.fields, false) })),
      events: events.map((e) => ({ name: e.name, docs: e.docs, file: e.path, fields: fieldsOut(e.fields, false) })),
      errorEnum,
      errors,
      pdas: [...pdas.values()].map((p) => ({ seeds: p.seeds, program: p.program, names: [...p.names], forms: [...p.forms].slice(1), docs: p.docs })),
      constants: consts
        .filter((c) => c.cfg.length === 0 && !/^_/.test(c.name))
        .map((c) => ({ path: c.path, type: c.type, value: c.value, docs: c.docs })),
    });
  }
  return programs;
}

// ==================================================================== output ===

function header(what) {
  return [
    "/* eslint-disable */",
    `// GENERATED by app/scripts/gen-docs-reference.mjs from ${what}. Do not edit by hand:`,
    "// run `node scripts/gen-docs-reference.mjs` (from app/) after changing the source.",
    "",
  ].join("\n");
}

function emit(file, text) {
  const path = join(OUT_DIR, file);
  let old = "";
  try {
    old = readFileSync(path, "utf8");
  } catch {
    // first run
  }
  if (old === text) return false;
  if (CHECK) {
    console.error(`stale: ${posix(relative(APP, path))}`);
    return true;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${posix(relative(APP, path))} (${(text.length / 1024).toFixed(1)} KB)`);
  return true;
}

const sdk = generateSdk();
const programs = generatePrograms();

const sdkText = `${header("sdk/src (exports of index.ts) and sdk/README.md")}import type { SdkReference } from "../types";\n\nexport const SDK_REFERENCE: SdkReference = ${JSON.stringify(sdk, null, 1)};\n`;
const programsText = `${header("programs/*/src (Anchor sources; the vault's and the shield's Anchor references, programs/noised-vault/anchor and programs/noised-shield/anchor) and crates/noised-lmots")}import type { ProgramDoc } from "../types";\n\nexport const PROGRAMS: readonly ProgramDoc[] = ${JSON.stringify(programs, null, 1)};\n`;

let stale = false;
stale = emit("sdk.ts", sdkText) || stale;
stale = emit("programs.ts", programsText) || stale;
console.log(
  `SDK: ${sdk.entries.length} exports. Programs: ${programs.map((p) => `${p.crate} ${p.instructions.length} ix / ${p.accounts.length} accounts / ${p.errors.length} errors / ${p.events.length} events`).join("; ")}`,
);
if (CHECK && stale) process.exit(1);
