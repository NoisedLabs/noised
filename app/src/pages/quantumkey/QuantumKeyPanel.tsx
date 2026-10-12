/**
 * "Your quantum key" (lib/pqKey.ts): create it with a passkey (recommended
 * where passkeys can hold it) or 24 words, unlock it, show its backup words
 * and its key ID, lock it. Plain words only; the vault page uses it now, the
 * launch wizard next. Nothing here is stored but a passkey's public id.
 */
import { KeyRound, Lock } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CLUSTER } from "../../app/settings";
import { Alert, Button } from "../../components/ui";
import { EyeIcon, EyeOffIcon } from "../../components/icons";
import { errorMessage } from "../../lib/format";
import { ONE_DEVICE_LINE } from "../../lib/signErrors";
import {
  backupWords,
  createWithPasskey,
  HIDDEN_LOCK_MS,
  launchIdentity,
  lock,
  passkeySupport,
  savedPasskeys,
  shortId,
  unlockWithPasskey,
  unlockWithWords,
  usePqKey,
  type PasskeySupport,
} from "../../lib/pqKey";
import { Chip, Comment, Panel, Toggle } from "../inner/kit";
import { DotGlyph } from "../inner/glyphs";
import { NewPhrase, RestorePhrase } from "../vault/PhraseGate";
import "./quantumkey.css";

type Way = "passkey" | "new-words" | "words";

export function QuantumKeyPanel({ use = "Opens your vaults and signs your launches." }: { use?: string }): ReactNode {
  const key = usePqKey();
  return (
    <Panel
      id="quantum-key"
      title="Your quantum key"
      glyph={<DotGlyph name="key" />}
      status={key.status === "unlocked" ? <Chip tone="ok">Unlocked</Chip> : <Chip tone="muted">Locked</Chip>}
      description={`One key, kept apart from your wallet, that a quantum computer cannot break. ${use}`}
      className="qk"
    >
      {key.status === "unlocked" ? <Unlocked /> : <LockedView />}
    </Panel>
  );
}

function LockedView(): ReactNode {
  const key = usePqKey();
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  const passkeys = useMemo(() => savedPasskeys(), [key]);
  const known = passkeys.length > 0;
  const [way, setWay] = useState<Way | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void passkeySupport().then((s) => {
      if (alive) setSupport(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const attempt = (fn: () => Promise<void> | void): void => {
    setBusy(true);
    setError(null);
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => setError(plainPasskeyError(e)))
      .finally(() => setBusy(false));
  };
  const words = (phrase: string): void => {
    try {
      unlockWithWords(phrase);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const recommended = support?.available === true && support.prf === "yes";

  return (
    <div className="qk-body">
      {key.autoLocked === "hidden" ? <Alert tone="info">Locked because this tab was in the background for {HIDDEN_LOCK_MS / 60_000} minutes. Unlock it again.</Alert> : null}
      {support?.demo === true ? (
        <Alert tone="warn" title="Demo passkey">
          In the demo, the passkey is simulated in this browser. It protects nothing: use it only to try the app.
        </Alert>
      ) : null}

      {known && way === null ? (
        <div className="qk-choice">
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => attempt(() => unlockWithPasskey())}>
            <KeyRound size={16} aria-hidden="true" /> Unlock with your passkey
          </Button>
          <Button variant="ghost" onClick={() => setWay("words")}>
            Use my 24 words instead
          </Button>
        </div>
      ) : null}

      {!known && way === null ? (
        <div className="qk-ways">
          <WayCard
            title="Use a passkey"
            tag={recommended ? "Recommended" : null}
            text="Face ID, Touch ID, Windows Hello or a security key. Nothing to type; you can still save 24 backup words later."
            disabled={support !== null && !support.available}
            note={support !== null && !support.available ? support.reason : support?.prf === "unknown" ? "Some devices cannot hold a quantum key in a passkey. If yours can't, use 24 words." : null}
          >
            <Button variant={recommended ? "primary" : "secondary"} loading={busy} disabled={busy || support === null || !support.available} onClick={() => attempt(() => createWithPasskey())}>
              Create with a passkey
            </Button>
          </WayCard>
          <WayCard title="Use 24 words" tag={recommended ? null : "Works everywhere"} text="Your browser makes 24 words. Write them on paper: they are your key, and only you have them.">
            <Button variant={recommended ? "secondary" : "primary"} disabled={busy} onClick={() => setWay("new-words")}>
              Create 24 words
            </Button>
          </WayCard>
          <p className="qk-have">
            Already have one?{" "}
            <button type="button" className="link qk-link" onClick={() => setWay("words")}>
              Type your 24 words
            </button>
          </p>
        </div>
      ) : null}

      {way === "new-words" ? <NewPhrase onUnlock={words} /> : null}
      {way === "words" ? <RestorePhrase onUnlock={words} label="Unlock" /> : null}
      {way !== null ? (
        <Button variant="ghost" size="sm" className="qk-back" onClick={() => setWay(null)}>
          Back
        </Button>
      ) : null}

      {error !== null ? <Alert tone="fail">{error}</Alert> : null}
      <Comment>Your key stays in this page&apos;s memory only. It is never stored or sent, and it locks itself when you close the tab.</Comment>
      <p className="qk-device">{ONE_DEVICE_LINE}</p>
    </div>
  );
}

/** One way to hold the key, as a card. */
function WayCard({ title, tag, text, note = null, disabled = false, children }: { title: string; tag: string | null; text: string; note?: string | null; disabled?: boolean; children: ReactNode }): ReactNode {
  return (
    <section className="qk-way" data-disabled={disabled ? "true" : undefined} aria-label={title}>
      <p className="qk-way-head">
        <span className="qk-way-title">{title}</span>
        {tag !== null ? <span className="qk-tag">{tag}</span> : null}
      </p>
      <p className="qk-way-text">{text}</p>
      {note !== null ? <p className="qk-way-note">{note}</p> : null}
      {children}
    </section>
  );
}

function Unlocked(): ReactNode {
  const key = usePqKey();
  const [showWords, setShowWords] = useState(false);
  const [safe, setSafe] = useState(false);
  const [visible, setVisible] = useState(true);
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idHex = key.identity.idHex;

  // The key ID is the launch identity's: derived once per unlock (from this browser's cache after the first time).
  useEffect(() => {
    if (key.identity.status === "idle") void launchIdentity(CLUSTER).catch(() => undefined);
  }, [key.identity.status]);

  useEffect(() => {
    if (!showWords || !safe) {
      setWords(null);
      return;
    }
    try {
      setWords(backupWords().split(" "));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [showWords, safe]);

  return (
    <div className="qk-body">
      <div className="qk-head">
        <div className="qk-id">
          <span className="qk-id-k">Key ID</span>
          <span className="qk-id-v pg-num" aria-live="polite">
            {idHex !== null ? shortId(idHex) : key.identity.status === "error" ? "unavailable" : `preparing ${Math.round(key.identity.progress * 100)}%`}
          </span>
          <span className="qk-id-h">Not secret. It shows on the launches this key signs.</span>
        </div>
        <div className="pg-btns">
          <Button size="sm" variant="ghost" onClick={() => setShowWords((v) => !v)} aria-expanded={showWords}>
            {showWords ? "Hide backup words" : "Show backup words"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => lock()}>
            <Lock size={14} aria-hidden="true" /> Lock
          </Button>
        </div>
      </div>
      {key.identity.status === "error" ? <Alert tone="fail">The key ID could not be prepared: {key.identity.error}</Alert> : null}
      <p className="qk-meta">
        {key.source === "passkey" ? "Held by your passkey." : "Made from your 24 words."} Keys are made for {CLUSTER}; other networks use different ones.
      </p>
      {showWords ? (
        <div className="qk-words">
          <Alert tone="warn" title="Your 24 backup words">
            Anyone who sees them controls your vaults and launches. Write them on paper; no screenshots.
          </Alert>
          <Toggle checked={safe} onChange={setSafe}>
            Nobody can see my screen.
          </Toggle>
          {words !== null ? (
            <>
              <div className="pg-phrase-bar">
                <span className="pg-phrase-bar-k">24 words</span>
                <Button size="sm" variant="ghost" onClick={() => setVisible((v) => !v)} aria-pressed={!visible}>
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                  {visible ? "Hide words" : "Show words"}
                </Button>
              </div>
              <ol className="phrase-grid pg-phrase" aria-label="Backup words" data-hidden={visible ? undefined : "true"}>
                {words.map((w, i) => (
                  <li key={i}>
                    <span>{i + 1}</span>
                    <span>{visible ? w : "••••••"}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {error !== null ? <Alert tone="fail">{error}</Alert> : null}
        </div>
      ) : null}
      <Comment>It locks itself when you close this tab, or after {HIDDEN_LOCK_MS / 60_000} minutes in the background.</Comment>
      <p className="qk-device">{ONE_DEVICE_LINE}</p>
    </div>
  );
}

/** Plain words for what a passkey attempt can fail with. */
function plainPasskeyError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError") return "The passkey request was cancelled or timed out. Nothing changed.";
  if (name === "InvalidStateError") return "This device already has a passkey for this app. Unlock with it instead.";
  if (name === "SecurityError") return "Passkeys are not allowed on this page (open the app at its own web address over https).";
  return errorMessage(e);
}
