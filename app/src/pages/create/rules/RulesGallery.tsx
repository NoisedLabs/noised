/**
 * The wizard's extra launch rules, Simple first (owner's direction: switch
 * options on and move sliders, never type values): a gallery of presets,
 * each with one or two sliders and a live sentence, composed into one rule
 * set; what holders will see, in plain English with every wallet's full
 * address, and the warnings their token page will show (the SDK's
 * `ruleWarnings`, QSL-1 revision 0.4: insider-only buying, transfer limits,
 * rules that last more than an hour); "Try a transfer" (the SDK's evaluator,
 * with the vault and Shield exits and the MutableOwner refusal); and, folded
 * away, the block builder and the code (./RulesEditor.tsx).
 *
 * Where custom rules are not live yet (live builds), the gallery says
 * "coming soon" and nothing can be switched on (review U8: no draft that
 * could strand a launch).
 */
import { useId, useMemo, useState, type ReactNode } from "react";

import { PlusIcon, TrashIcon } from "../../../components/icons";
import { Button } from "../../../components/ui";
import { describeSeconds } from "../../../lib/format";
import { explainRuleSet, isAddress, RULES_LIMITS, ruleKeyList, ruleWarnings, type GuardFacts } from "../../../lib/programmable";
import { Chip, Comment, Details, NoteBox, Panel, Toggle } from "../../inner/kit";
import { Say, StopSlider } from "../SimpleControls";
import { defaultValues, PRESETS, tradingOpensAt, type Preset, type PresetValues } from "./presets";
import { RulesEditor } from "./RulesEditor";
import { buildDraft, presetProblems, ruleSetOf, setPreset, type RulesDraft, type RulesEnv } from "./state";
import { TryTransfer, walletChoices } from "./TryTransfer";
import "../../../components/qsl/qsl.css";
import "./rules.css";

/** Under the presets that limit transfers between holders: what they can never stop (review 4 R1). */
export const EXITS_NOTE = "Holders can still take their tokens out of their quantum vault or move them through the Shield: rules never block those. Selling always works.";

export function RulesGallery({ draft, onChange, env, guard, available }: { draft: RulesDraft; onChange: (d: RulesDraft) => void; env: RulesEnv; guard: GuardFacts; available: boolean }): ReactNode {
  const { set } = useMemo(() => ruleSetOf(draft, env), [draft, env]);
  const { build } = useMemo(() => buildDraft(draft, env), [draft, env]);
  const problems = useMemo(() => presetProblems(draft, env), [draft, env]);
  const plain = useMemo(() => (build?.ok === true ? explainRuleSet(set) : []), [build, set]);
  const named = useMemo(() => ruleKeyList(set), [set]);
  // What the token page will warn holders about (the SDK's own analysis of these exact bytes).
  const warnings = useMemo(() => {
    if (build?.ok !== true) return [];
    try {
      return ruleWarnings(build.bytes, { guardSecs: env.guardSecs, supply: guard.supply, tokenDecimals: env.decimals, buysOpenAt: tradingOpensAt(env) }).map((w) => w.plain);
    } catch {
      return [];
    }
  }, [build, env, guard.supply]);
  const on = PRESETS.filter((p) => draft.presets[p.id] !== undefined).length;
  const own = draft.items.filter((x) => x.preset === undefined).length;
  const bytes = build?.ok === true ? build.bytes.length : 0;

  if (!available) {
    return (
      <Panel title="Extra launch rules" status={<Chip tone="muted">Coming soon</Chip>} description="Extra rules for the first hours, picked from a gallery with sliders: fair start, anti-bot, whale cap and more.">
        <NoteBox title="Coming soon on this network">
          Extra launch rules are not live here yet, so none can be added to a launch now: your launch uses the early limits above. Try them in the demo.
        </NoteBox>
        <ul className="rg-grid rg-grid-off" aria-label="Extra rules (coming soon)">
          {PRESETS.map((p) => (
            <li key={p.id} className="rg-card px-corners px-frame" data-off="">
              <span className="rg-title">{p.title}</span>
              <span className="rg-blurb">{p.blurb}</span>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  return (
    <div className="pg-stack-lg rl">
      <Panel
        title="Extra launch rules"
        description="Optional. Switch on what you want and move the sliders. Each one only limits buying or sending in the first hours, and every one ends when the early limits do. Selling always works."
        status={<Chip tone={draft.items.length === 0 ? "muted" : build?.ok === true ? "ok" : "warn"}>{draft.items.length === 0 ? "None" : build?.ok === true ? `${draft.items.length} rule${draft.items.length === 1 ? "" : "s"}` : "Needs a fix"}</Chip>}
      >
        <ul className="rg-grid" aria-label="Extra rules">
          {PRESETS.map((p) => (
            <li key={p.id}>
              <PresetCard
                preset={p}
                values={draft.presets[p.id] ?? null}
                problem={problems[p.id] ?? null}
                env={env}
                onValues={(v) => onChange(setPreset(draft, p.id, v, env))}
              />
            </li>
          ))}
        </ul>
        <p className="rg-sum" aria-live="polite">
          {on === 0 && own === 0
            ? "Nothing extra: only the early limits above apply."
            : `${on} switched on${own > 0 ? `, plus ${own} rule${own === 1 ? "" : "s"} of your own` : ""}. ${bytes > 0 ? `${bytes.toLocaleString("en-US")} of ${RULES_LIMITS.maxBytes.toLocaleString("en-US")} bytes on Solana.` : ""}`}
        </p>
      </Panel>

      <Panel title="What holders will see" description="Your token's page shows exactly this, and the chain checks these rules on every transfer while the early limits last.">
        {plain.length === 0 ? (
          <p className="pg-text">No extra rules: only the early limits apply.</p>
        ) : (
          <ol className="rl-plain">
            {plain.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        )}
        {named.length > 0 ? (
          <div className="rl-keys-list">
            <p className="pg-label">Wallets and apps these rules name</p>
            <ul>
              {named.map((k) => (
                <li key={k.address}>
                  {k.name !== null ? <span className="rl-key-name">{k.name}</span> : null} <code className="pg-break">{k.address}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <NoteBox tone="warn" title="Holders will also see these warnings on its page">
            <ul className="qsl-warn-list">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </NoteBox>
        ) : null}
        <ul className="rl-promises" aria-label="What rules can never do">
          <li>Selling is always allowed. No rule can block a sell.</li>
          <li>Rules never block what a holder's quantum vault or the Shield moves (the early limits above still apply).</li>
          <li>While the early limits last, tokens can't go to a token account whose owner can be changed. Normal wallets are never affected.</li>
          <li>Every rule ends when the early limits end ({describeSeconds(env.guardSecs)} after launch, never more than 72 hours).</li>
          <li>Rules can only refuse a transfer. They can never move, mint or freeze anyone's tokens.</li>
        </ul>
      </Panel>

      <TryTransfer set={set.rules.length > 0 && build?.ok === true ? set : null} guard={guard} wallets={walletChoices(set)} />

      <Details summary="Advanced: write your own rules as blocks or code" className="cr-advanced-fold rg-advanced">
        <RulesEditor draft={draft} onChange={onChange} env={env} />
      </Details>
    </div>
  );
}

function PresetCard({ preset, values, problem, env, onValues }: { preset: Preset; values: PresetValues | null; problem: string | null; env: RulesEnv; onValues: (v: PresetValues | null) => void }): ReactNode {
  const descId = `rg-${preset.id}-blurb`;
  const on = values !== null;
  const v = values ?? defaultValues(preset);
  return (
    <article className="rg-card px-corners px-frame" data-on={on ? "" : undefined} aria-label={preset.title}>
      <Toggle checked={on} onChange={(c) => onValues(c ? v : null)} describedBy={descId} strong className="rg-toggle">
        {preset.title}
      </Toggle>
      <p className="rg-blurb" id={descId}>
        {preset.blurb}
      </p>
      {preset.limitsTransfers === true ? <p className="rg-exits">{EXITS_NOTE}</p> : null}
      {on ? (
        <div className="rg-body sm-stack">
          {preset.sliders.map((s, i) => {
            const idx = i === 0 ? v.a : v.b;
            const value = s.stops[Math.min(idx, s.stops.length - 1)] ?? 0;
            return (
              <StopSlider
                key={s.label}
                label={s.label}
                stops={s.stops.length}
                index={Math.min(idx, s.stops.length - 1)}
                exact
                valueText={s.text(value)}
                stopText={(j) => s.text(s.stops[j] ?? 0)}
                onIndex={(j) => onValues(i === 0 ? { ...v, a: j } : { ...v, b: j })}
                ends={[s.text(s.stops[0] ?? 0), s.text(s.stops[s.stops.length - 1] ?? 0)]}
              />
            );
          })}
          {preset.wallets === true ? <WalletList wallets={v.wallets} onChange={(wallets) => onValues({ ...v, wallets })} /> : null}
          {problem !== null ? (
            <p className="field-error" role="alert">
              {problem}
            </p>
          ) : (
            <Say text={preset.say(v, env)} />
          )}
        </div>
      ) : null}
    </article>
  );
}

/** Team wallets: paste an address, see it in full, remove it. */
function WalletList({ wallets, onChange }: { wallets: readonly string[]; onChange: (w: string[]) => void }): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (): void => {
    const a = text.trim();
    if (a === "") return;
    if (!isAddress(a)) return setError("That is not a Solana address.");
    if (wallets.includes(a)) return setError("Already on the list.");
    if (wallets.length >= RULES_LIMITS.maxKeys) return setError(`At most ${RULES_LIMITS.maxKeys} wallets.`);
    onChange([...wallets, a]);
    setText("");
    setError(null);
  };
  return (
    <div className="rg-wallets">
      <label className="sl-label" htmlFor={`${id}-w`}>
        Team wallets
      </label>
      {wallets.length > 0 ? (
        <ul className="rg-wallet-list">
          {wallets.map((w) => (
            <li key={w}>
              <code className="pg-break">{w}</code>
              <button type="button" className="rl-icon" onClick={() => onChange(wallets.filter((x) => x !== w))} aria-label={`Remove ${w}`}>
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="rg-wallet-add">
        <input
          id={`${id}-w`}
          className="input mono"
          value={text}
          placeholder="Paste a wallet address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${id}-we` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" onClick={add} aria-label="Add this wallet">
          <PlusIcon /> Add
        </Button>
      </span>
      {error !== null ? (
        <span className="field-error" id={`${id}-we`}>
          {error}
        </span>
      ) : null}
      <Comment>Wallets you add here are public on Solana once the launch is created.</Comment>
    </div>
  );
}
