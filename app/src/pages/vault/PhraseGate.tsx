/**
 * The 24 words of the quantum key: a separate BIP-39 phrase, never derived
 * from the Ed25519 wallet. It lives only in this component's memory while it
 * is shown or typed; it is handed to the quantum key (lib/pqKey.ts), which
 * keeps only the derived secret, and nothing here is ever written to storage.
 *
 * No field here is a password field and none is in a <form>: browsers and
 * password managers offer to save (and sync) what is typed into a password
 * field or submitted with a form. The phrase is typed into a textarea masked
 * with CSS, and unlocking is a button click.
 */
import { useMemo, useState, type ReactNode } from "react";

import { Alert, Button, Segmented } from "../../components/ui";
import { EyeIcon, EyeOffIcon } from "../../components/icons";
import { generateRecoveryPhrase, isBip39Word, normalizePhrase, phraseProblems, RECOVERY_PHRASE_WORDS } from "../../lib/noised";
import { Chip, Comment, Panel, Toggle } from "../inner/kit";
import { DotGlyph } from "../inner/glyphs";

/**
 * Every field the phrase, or a word of it, is typed into: no autofill,
 * autocorrect, capitalization or spell checking (a spell checker may send the
 * text to a server), and the opt-outs of 1Password, LastPass, Bitwarden and
 * Dashlane, so no password manager offers to save it.
 */
export const SECRET_FIELD = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** The words-only gate (create or type 24 words); `onUnlock` receives the checked phrase. */
export function PhraseGate({ onUnlock }: { onUnlock: (phrase: string) => void }): ReactNode {
  const [mode, setMode] = useState<"new" | "restore">("new");
  return (
    <Panel
      id="phrase"
      status={<Chip tone="muted">Locked</Chip>}
      title="Your recovery phrase"
      glyph={<DotGlyph name="phrase" />}
      description="Your vault keys come from a separate 24-word phrase, never from your wallet. Someone who breaks your wallet's key learns nothing about it."
      className="pg-gate-card"
    >
      <div className="pg-gate">
        <Segmented<"new" | "restore">
          label="Recovery phrase"
          value={mode}
          onChange={setMode}
          options={[
            { value: "new", label: "Create a new phrase" },
            { value: "restore", label: "I have a phrase" },
          ]}
        />
        {mode === "new" ? <NewPhrase onUnlock={onUnlock} /> : <RestorePhrase onUnlock={onUnlock} />}
        <Comment>
          Your phrase and its keys stay in this page's memory only. They are never stored, sent or logged, and reloading the page forgets them.
        </Comment>
      </div>
    </Panel>
  );
}

function pickPositions(): number[] {
  const out = new Set<number>();
  const rnd = new Uint32Array(16);
  crypto.getRandomValues(rnd);
  for (const r of rnd) {
    out.add(r % RECOVERY_PHRASE_WORDS);
    if (out.size === 4) break;
  }
  return [...out].sort((a, b) => a - b);
}

/** Make 24 new words, show them once, and check four of them from the paper copy. */
export function NewPhrase({ onUnlock }: { onUnlock: (phrase: string) => void }): ReactNode {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [stage, setStage] = useState<"show" | "confirm">("show");
  const [written, setWritten] = useState(false);
  const positions = useMemo(() => (phrase === null ? [] : pickPositions()), [phrase]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const words = phrase?.split(" ") ?? [];

  if (phrase === null) {
    return (
      <div className="pg-gate-step">
        <p className="pg-text">
          Your browser makes a random 24-word phrase. Write it on paper. Anyone who sees it controls every vault it opens, and if you lose it, nobody can
          recover those vaults.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setPhrase(generateRecoveryPhrase());
            setStage("show");
            setWritten(false);
            setAnswers({});
            setError(null);
          }}
        >
          Generate a 24-word phrase
        </Button>
      </div>
    );
  }

  if (stage === "show") {
    return (
      <div className="pg-gate-step">
        <Alert tone="warn" title="Write these 24 words down, in order, on paper">
          Do not take a screenshot or paste them anywhere. Make sure nobody can see your screen.
        </Alert>
        <div className="pg-phrase-bar">
          <span className="pg-phrase-bar-k">24 words</span>
          <Button size="sm" variant="ghost" onClick={() => setVisible((v) => !v)} aria-pressed={!visible}>
            {visible ? <EyeOffIcon /> : <EyeIcon />}
            {visible ? "Hide words" : "Show words"}
          </Button>
        </div>
        <ol className="phrase-grid pg-phrase" aria-label="Recovery phrase" data-hidden={visible ? undefined : "true"}>
          {words.map((w, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              <span>{visible ? w : "••••••"}</span>
            </li>
          ))}
        </ol>
        <Toggle checked={written} onChange={setWritten}>
          I wrote all 24 words down and stored them somewhere safe.
        </Toggle>
        <div className="pg-btns">
          <Button variant="primary" disabled={!written} onClick={() => setStage("confirm")}>
            Continue to confirmation
          </Button>
          <Button variant="ghost" onClick={() => setPhrase(null)}>
            Discard this phrase
          </Button>
        </div>
      </div>
    );
  }

  const complete = positions.every((p) => (answers[p] ?? "").trim() !== "");
  const confirm = (): void => {
    if (!complete) return;
    const wrong = positions.filter((p) => normalizePhrase(answers[p] ?? "") !== words[p]);
    if (wrong.length > 0) {
      setError(`Word ${wrong.map((p) => p + 1).join(", ")} does not match. Check what you wrote down.`);
      return;
    }
    const words24 = phrase;
    setPhrase(null);
    setAnswers({});
    onUnlock(words24);
  };
  return (
    <div className="pg-gate-step">
      <p className="pg-text">Type these words from your paper copy to check you wrote the phrase down correctly.</p>
      <div className="pg-confirm-words">
        {positions.map((p) => (
          <div key={p} className="pg-confirm-word">
            <label className="label" htmlFor={`confirm-word-${p}`}>
              Word {p + 1}
            </label>
            <input
              id={`confirm-word-${p}`}
              className="input mono"
              {...SECRET_FIELD}
              value={answers[p] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [p]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              aria-invalid={error !== null && normalizePhrase(answers[p] ?? "") !== words[p]}
            />
          </div>
        ))}
      </div>
      {error ? <p className="field-error">{error}</p> : null}
      <div className="pg-btns">
        <Button variant="primary" disabled={!complete} onClick={confirm}>
          Confirm and unlock
        </Button>
        <Button variant="ghost" onClick={() => setStage("show")}>
          Show the words again
        </Button>
      </div>
    </div>
  );
}

/** Type the 24 words (a masked textarea outside any form; unlocking is a button click). */
export function RestorePhrase({ onUnlock, label = "Unlock vaults" }: { onUnlock: (phrase: string) => void; label?: string }): ReactNode {
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);
  const words = normalizePhrase(text).split(" ").filter((w) => w !== "");
  const unknown = words.filter((w) => !isBip39Word(w));
  const problems = words.length === RECOVERY_PHRASE_WORDS ? phraseProblems(text) : [];
  const ready = words.length === RECOVERY_PHRASE_WORDS && problems.length === 0;
  const unlock = (): void => {
    if (!ready) return;
    const typed = text;
    setText("");
    onUnlock(typed);
  };
  return (
    <div className="pg-gate-step">
      <div>
        <div className="pg-phrase-bar">
          <label className="label" htmlFor="restore-phrase">
            Recovery phrase (24 words)
          </label>
          <Button size="sm" variant="ghost" onClick={() => setVisible((v) => !v)} aria-pressed={visible} aria-controls="restore-phrase">
            {visible ? <EyeOffIcon /> : <EyeIcon />}
            {visible ? "Hide" : "Show"}
          </Button>
        </div>
        <textarea
          id="restore-phrase"
          className={visible ? "textarea mono" : "textarea mono secret-masked"}
          rows={3}
          {...SECRET_FIELD}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="restore-help"
        />
        <p id="restore-help" className="help" aria-live="polite">
          {words.length}/{RECOVERY_PHRASE_WORDS} words
          {unknown.length > 0 ? `; ${unknown.length} word${unknown.length === 1 ? " is" : "s are"} not in the word list` : ""}
          {problems.length > 0 && unknown.length === 0 ? `; ${problems[0]}` : ""}
        </p>
      </div>
      <button type="button" className="btn btn-primary pg-unlock" disabled={!ready} onClick={unlock}>
        {label}
      </button>
    </div>
  );
}
