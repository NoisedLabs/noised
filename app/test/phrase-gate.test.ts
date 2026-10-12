/**
 * The PQ recovery phrase is never typed into a password field or submitted
 * with a form: browsers and password managers offer to save (and sync) both.
 * It goes into a textarea masked with CSS, with every autofill, autocorrect,
 * spell-check and password-manager opt-out, and unlocking is a button click.
 * Rendered with react-dom/server (no DOM needed) and checked in the source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhraseGate, RestorePhrase, SECRET_FIELD } from "../src/pages/vault/PhraseGate";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Source without comments, so documentation may name what the code must not do. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The attributes every phrase field must carry, as HTML reads them. */
const REQUIRED = {
  autocomplete: "off",
  autocorrect: "off",
  autocapitalize: "off",
  spellcheck: "false",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** The attributes of the input or textarea with this id; names lower-cased, as HTML reads them (React's server renderer writes `autoComplete`). */
function attributesOf(html: string, id: string): Record<string, string> | null {
  const tag = new RegExp(`<(input|textarea)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
  if (tag === undefined) return null;
  return Object.fromEntries([...tag.matchAll(/\s([\w-]+)="([^"]*)"/g)].map((m) => [(m[1] ?? "").toLowerCase(), m[2] ?? ""]));
}

describe("the recovery phrase field", () => {
  it("is a masked textarea, never a password field, outside any form, with every opt-out", () => {
    const html = renderToStaticMarkup(createElement(RestorePhrase, { onUnlock: () => undefined }));
    expect(html).not.toMatch(/type="password"/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).toMatch(/<textarea\b[^>]*id="restore-phrase"/);
    const attrs = attributesOf(html, "restore-phrase");
    expect(attrs).not.toBeNull();
    expect(attrs).toMatchObject(REQUIRED);
    // Hidden by default: drawn as discs by CSS, not by a password input.
    expect(attrs?.class?.split(" ")).toContain("secret-masked");
    expect(attrs).not.toHaveProperty("name");
    // Unlocking is a plain button, not a form submission.
    expect(html).toMatch(/<button type="button"[^>]*>Unlock vaults<\/button>/);
  });

  it("is masked with CSS, with a fallback that still hides the text", () => {
    const css = readFileSync(join(SRC, "styles.css"), "utf8");
    expect(css).toMatch(/\.secret-masked\s*\{\s*-webkit-text-security:\s*disc;\s*\}/);
    expect(css).toMatch(/@supports not \(-webkit-text-security: disc\)\s*\{\s*\.secret-masked\s*\{\s*color:\s*transparent;/);
  });

  it("every phrase field of the gate spreads the same opt-outs, and the gate has no form", () => {
    expect(SECRET_FIELD).toEqual({
      autoComplete: "off",
      autoCorrect: "off",
      autoCapitalize: "off",
      spellCheck: false,
      "data-1p-ignore": "true",
      "data-lpignore": "true",
      "data-bwignore": "true",
      "data-form-type": "other",
    });
    const gate = renderToStaticMarkup(createElement(PhraseGate, { onUnlock: () => undefined }));
    expect(gate).not.toMatch(/type="password"|<form\b/i);
    const source = code(readFileSync(join(SRC, "pages/vault/PhraseGate.tsx"), "utf8"));
    // The confirmation words and the phrase itself.
    expect(source).toMatch(/id=\{`confirm-word-\$\{p\}`\}\s*className="input mono"\s*\{\.\.\.SECRET_FIELD\}/);
    expect(source).toMatch(/id="restore-phrase"[\s\S]{0,200}\{\.\.\.SECRET_FIELD\}/);
    expect(source).not.toMatch(/<form\b|onSubmit|type="submit"/);
  });

  it("no page of the app has a password field", () => {
    const offenders = walk(SRC)
      .filter((path) => /type=\{?["']password["']|type:\s*["']password["']/i.test(code(readFileSync(path, "utf8"))))
      .map((path) => relative(SRC, path).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
