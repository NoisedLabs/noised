/**
 * Advanced: the creator's launch rules as sentence blocks or as code
 * (PROGRAMMABLE_V1 §6), with a timeline and a size meter against the
 * 1,228-byte limit. Rules the Simple gallery made show which preset they come
 * from; editing one makes that preset's rules the creator's own. The chain
 * verifies the same bytes when the launch is created; nothing here is
 * trusted.
 */
import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { PlusIcon, TrashIcon } from "../../../components/icons";
import { Button } from "../../../components/ui";
import { describeSeconds } from "../../../lib/format";
import { explainRuleSet, isAddress, KNOWN_APPS, ruleKeyList, RULE_CODE_CHOICES, RULES_LIMITS, type DslProblem, type RuleKey } from "../../../lib/programmable";
import { Chip, Comment, DotBar, NoteBox, Tabs, tabPanel } from "../../inner/kit";
import { EFFECT_LABELS, EXTRA_LABELS, newExtra, WHO_LABELS, defaultBlock, type AmountText, type Extra, type ExtraKind, type RuleBlock, type RuleItem, type Who } from "./blocks";
import { presetById } from "./presets";
import { buildDraft, editItem, newRuleId, removeItems, ruleSetOf, withItems, withText, type DraftItem, type RulesDraft, type RulesEnv } from "./state";
import "./rules.css";

type Mode = "blocks" | "code";

export function RulesEditor({ draft, onChange, env }: { draft: RulesDraft; onChange: (d: RulesDraft) => void; env: RulesEnv }): ReactNode {
  const [mode, setMode] = useState<Mode>("blocks");
  const idBase = `rules${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { set } = useMemo(() => ruleSetOf(draft, env), [draft, env]);
  const { build, blockProblems } = useMemo(() => buildDraft(draft, env), [draft, env]);
  const explained = useMemo(() => (set.rules.length === 0 ? [] : explainRuleSet(set)), [set]);
  // Explanation of each item: rules are explained in order, skipping incomplete blocks.
  const explanationOf = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const it of draft.items) {
      if (blockProblems.has(it.id)) continue;
      const e = explained[i++];
      if (e !== undefined) map.set(it.id, e);
    }
    return map;
  }, [draft.items, blockProblems, explained]);

  const setItems = (items: DraftItem[]): void => onChange(withItems(draft, items, env));
  const bytes = build?.ok === true ? build.bytes.length : null;

  return (
    <div className="rl-adv">
      <p className="pg-text">
        Every rule as a sentence you can change, or as code. The extra rules you switched on above are here too; change one and it becomes your own. Times count from the
        launch, and nobody can buy until trading opens.
      </p>
      <RulesTimeline draft={draft} env={env} problems={blockProblems} />

      <Tabs<Mode>
        items={[
          { value: "blocks", label: "Blocks" },
          { value: "code", label: "Code", badge: draft.problems.length > 0 ? draft.problems.length : undefined },
        ]}
        value={mode}
        onChange={setMode}
        label="Edit rules as"
        idBase={idBase}
        className="rl-tabs"
      />

      <div {...tabPanel(idBase, "blocks", mode)}>
        {draft.problems.length > 0 ? (
          <NoteBox tone="warn" title="The code has a problem">
            These blocks show the last version of your code that worked. Fix line {draft.problems[0]?.line ?? 1} in the Code tab to update them.
          </NoteBox>
        ) : null}
        {draft.items.length === 0 ? (
          <p className="rl-empty">No rules yet. Switch one on above, or add your own.</p>
        ) : (
          <ol className="rl-list">
            {draft.items.map((it, i) => (
              <li key={it.id}>
                <RuleCard
                  item={it}
                  index={i}
                  count={draft.items.length}
                  env={env}
                  keys={draft.keys}
                  problem={blockProblems.get(it.id) ?? null}
                  explanation={explanationOf.get(it.id) ?? null}
                  from={it.preset !== undefined ? presetById(it.preset).title : null}
                  onChange={(next) => onChange(editItem(draft, it.id, next, env))}
                  onRemove={() => onChange(removeItems(draft, [it.id], env))}
                  onMove={(dir) => {
                    const j = i + dir;
                    if (j < 0 || j >= draft.items.length) return;
                    const next = [...draft.items];
                    [next[i], next[j]] = [next[j] as DraftItem, next[i] as DraftItem];
                    setItems(next);
                  }}
                  onEditCode={() => setMode("code")}
                />
              </li>
            ))}
          </ol>
        )}
        <div className="rl-add">
          <Button size="sm" disabled={draft.items.length >= RULES_LIMITS.maxRules} onClick={() => setItems([...draft.items, { id: newRuleId(), block: defaultBlock(env.guardSecs) }])}>
            <PlusIcon /> Add a rule
          </Button>
          {draft.items.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(withItems({ ...draft, presets: {} }, [], env))}>
              Remove all
            </Button>
          ) : null}
        </div>
      </div>

      <div {...tabPanel(idBase, "code", mode)}>
        <CodeEditor draft={draft} onText={(text) => onChange(withText(draft, text, env))} hasIncomplete={blockProblems.size > 0} />
      </div>

      <SizeMeter bytes={bytes} rules={draft.items.length} keys={ruleKeyList(set).length} build={build} />
    </div>
  );
}

// ------------------------------------------------------------ rule card ---

const DURATIONS = [60, 120, 300, 600, 900, 1800, 3600, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600, 48 * 3600, 72 * 3600];

function durationOptions(guardSecs: number, current: number): number[] {
  const list = DURATIONS.filter((d) => d <= guardSecs);
  if (!list.includes(guardSecs)) list.push(guardSecs);
  if (current > 0 && !list.includes(current)) list.push(current);
  return list.sort((a, b) => a - b);
}

function RuleCard({
  item,
  index,
  count,
  env,
  keys,
  problem,
  explanation,
  from,
  onChange,
  onRemove,
  onMove,
  onEditCode,
}: {
  item: RuleItem;
  /** The Simple preset that made this rule, or null for the creator's own. */
  from: string | null;
  index: number;
  count: number;
  env: RulesEnv;
  keys: readonly RuleKey[];
  problem: string | null;
  explanation: string | null;
  onChange: (next: RuleItem) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onEditCode: () => void;
}): ReactNode {
  const n = index + 1;
  const head = (
    <div className="rl-card-head">
      <span className="rl-card-n">Rule {n}</span>
      {"block" in item ? (
        <label className="rl-inline">
          <span className="sr-only">Rule {n}: reason shown to holders</span>
          <select className="select rl-sel" value={item.block.code} onChange={(e) => onChange({ ...item, block: { ...item.block, code: Number(e.target.value) } })}>
            {RULE_CODE_CHOICES.map((c) => (
              <option key={c.code} value={c.code}>
                Reason: {c.text}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <Chip tone="muted">Written in code</Chip>
      )}
      {from !== null ? <Chip tone="signal">From {from}</Chip> : null}
      <span className="rl-card-tools">
        <button type="button" className="rl-icon" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move rule ${n} up`}>
          ↑
        </button>
        <button type="button" className="rl-icon" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move rule ${n} down`}>
          ↓
        </button>
        <button type="button" className="rl-icon" onClick={onRemove} aria-label={`Remove rule ${n}`}>
          <TrashIcon />
        </button>
      </span>
    </div>
  );
  if (!("block" in item)) {
    return (
      <article className="rl-card px-corners px-frame" aria-label={`Rule ${n}`}>
        {head}
        <p className="rl-explain">{explanation ?? "A rule written in code."}</p>
        <Comment>
          This rule uses logic the blocks can't show (for example "or" / "not").{" "}
          <button type="button" className="link" onClick={onEditCode}>
            Edit it in the Code tab
          </button>
          .
        </Comment>
      </article>
    );
  }
  const b = item.block;
  const set = (patch: Partial<RuleBlock>): void => onChange({ ...item, block: { ...b, ...patch } });
  const opts = durationOptions(env.guardSecs, b.toSecs);
  const fromOpts = durationOptions(env.guardSecs, b.fromSecs).filter((d) => d < env.guardSecs);
  const late = b.window !== "whole" && b.who === "buys" && b.toSecs <= env.openDelaySecs;
  return (
    <article className="rl-card px-corners px-frame" data-problem={problem !== null ? "" : undefined} aria-label={`Rule ${n}`}>
      {head}
      <div className="rl-sentence">
        <label className="rl-inline">
          <span className="sr-only">Rule {n}: when it applies</span>
          <select className="select rl-sel" value={b.window} onChange={(e) => set({ window: e.target.value as RuleBlock["window"] })}>
            <option value="first">During the first</option>
            <option value="between">From</option>
            <option value="whole">While the guard is on</option>
          </select>
        </label>
        {b.window === "between" ? (
          <>
            <DurationSelect label={`Rule ${n}: starts after`} value={b.fromSecs} options={fromOpts} onChange={(v) => set({ fromSecs: v })} />
            <span className="rl-word">to</span>
          </>
        ) : null}
        {b.window !== "whole" ? <DurationSelect label={`Rule ${n}: ends after`} value={b.toSecs} options={opts} onChange={(v) => set({ toSecs: v })} /> : null}
        <span className="rl-dot" aria-hidden="true">
          ·
        </span>
        <label className="rl-inline">
          <span className="sr-only">Rule {n}: what it does</span>
          <select className="select rl-sel" value={b.effect} onChange={(e) => set({ effect: e.target.value as RuleBlock["effect"] })}>
            {(Object.keys(EFFECT_LABELS) as RuleBlock["effect"][]).map((k) => (
              <option key={k} value={k}>
                {EFFECT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {b.effect !== "deny" ? <AmountField label={`Rule ${n}: limit`} value={b.cap} onChange={(cap) => set({ cap })} /> : null}
        <span className="rl-dot" aria-hidden="true">
          ·
        </span>
        <span className="rl-word">{b.effect === "deny" ? "" : "for"}</span>
        <label className="rl-inline">
          <span className="sr-only">Rule {n}: which transfers</span>
          <select className="select rl-sel" value={b.who} onChange={(e) => set({ who: e.target.value as Who })}>
            {(Object.keys(WHO_LABELS) as Who[]).map((k) => (
              <option key={k} value={k}>
                {WHO_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {b.extras.length > 0 ? (
        <ul className="rl-extras" aria-label={`Rule ${n}: conditions`}>
          {b.extras.map((x, i) => (
            <li key={i} className="rl-extra">
              <span className="rl-word rl-when">{i === 0 ? "when" : "and"}</span>
              <ExtraEditor
                n={n}
                extra={x}
                keys={keys}
                onChange={(next) => set({ extras: b.extras.map((y, j) => (j === i ? next : y)) })}
              />
              <button type="button" className="rl-icon" onClick={() => set({ extras: b.extras.filter((_, j) => j !== i) })} aria-label={`Remove condition ${i + 1} of rule ${n}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label className="rl-inline rl-addcond">
        <span className="sr-only">Rule {n}: add a condition</span>
        <select
          className="select rl-sel"
          value=""
          onChange={(e) => {
            const k = e.target.value as ExtraKind | "";
            if (k !== "") set({ extras: [...b.extras, newExtra(k)] });
          }}
        >
          <option value="">+ only when…</option>
          {(Object.keys(EXTRA_LABELS) as ExtraKind[]).map((k) => (
            <option key={k} value={k}>
              {EXTRA_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {problem !== null ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : explanation !== null ? (
        <p className="rl-explain">{explanation}</p>
      ) : null}
      {late ? (
        <p className="rl-warn">
          Buys from the pool only start after the {describeSeconds(env.openDelaySecs)} batch window, so this rule ends before anyone can buy. Make it longer.
        </p>
      ) : null}
    </article>
  );
}

function DurationSelect({ label, value, options, onChange }: { label: string; value: number; options: readonly number[]; onChange: (v: number) => void }): ReactNode {
  return (
    <label className="rl-inline">
      <span className="sr-only">{label}</span>
      <select className="select rl-sel" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((d) => (
          <option key={d} value={d}>
            {describeSeconds(d)}
          </option>
        ))}
      </select>
    </label>
  );
}

function AmountField({ label, value, onChange }: { label: string; value: AmountText; onChange: (v: AmountText) => void }): ReactNode {
  return (
    <span className="rl-amount">
      <label className="rl-inline">
        <span className="sr-only">{label}: amount</span>
        <input className="input rl-num" inputMode="decimal" value={value.value} onChange={(e) => onChange({ ...value, value: e.target.value })} />
      </label>
      <label className="rl-inline">
        <span className="sr-only">{label}: unit</span>
        <select className="select rl-sel" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as AmountText["unit"] })}>
          <option value="pct">% of supply</option>
          <option value="tokens">tokens</option>
        </select>
      </label>
    </span>
  );
}

function ExtraEditor({ n, extra, keys, onChange }: { n: number; extra: Extra; keys: readonly RuleKey[]; onChange: (x: Extra) => void }): ReactNode {
  switch (extra.kind) {
    case "ixCountGt":
      return (
        <span className="rl-extra-body">
          <span className="rl-word">the transaction has more than</span>
          <label className="rl-inline">
            <span className="sr-only">Rule {n}: instruction count</span>
            <input className="input rl-num" inputMode="numeric" value={extra.n} onChange={(e) => onChange({ ...extra, n: e.target.value })} />
          </label>
          <span className="rl-word">instructions</span>
          <span className="rl-note">(ordinary buys use up to about 8)</span>
        </span>
      );
    case "amountGt":
    case "balanceGt":
      return (
        <span className="rl-extra-body">
          <span className="rl-word">{extra.kind === "amountGt" ? "it moves more than" : "the receiver would hold more than"}</span>
          <AmountField label={`Rule ${n}: ${extra.kind === "amountGt" ? "amount" : "balance"}`} value={extra.amount} onChange={(amount) => onChange({ ...extra, amount })} />
        </span>
      );
    default:
      return (
        <span className="rl-extra-body">
          <span className="rl-word">{EXTRA_LABELS[extra.kind].replace(/ (these wallets|these apps|this list)$/, "")}</span>
          <KeyList n={n} kind={extra.kind.startsWith("program") ? "app" : "wallet"} value={extra.keys} keys={keys} onChange={(list) => onChange({ ...extra, keys: list })} />
        </span>
      );
  }
}

/** Wallet / app chips with an input that adds a pasted address (or a name declared in the code). */
function KeyList({ n, kind, value, keys, onChange }: { n: number; kind: "wallet" | "app"; value: readonly string[]; keys: readonly RuleKey[]; onChange: (v: string[]) => void }): ReactNode {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // A known program by its address first (never only by a typed label: review U14), then the code's name, then the address.
  const labelOf = (k: string): string => {
    const named = keys.find((x) => x.label === k || x.address === k);
    const address = named?.address ?? k;
    if (KNOWN_APPS[address] !== undefined) return KNOWN_APPS[address] as string;
    if (named?.label !== undefined) return `${named.label} (${address.slice(0, 4)}…${address.slice(-4)})`;
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
  };
  const add = (): void => {
    const v = text.trim();
    if (v === "") return;
    const known = keys.some((x) => x.label === v);
    if (!known && !isAddress(v)) {
      setError(`Not a Solana address${keys.length > 0 ? " or a name from the code" : ""}.`);
      return;
    }
    if (!value.includes(v)) onChange([...value, v]);
    setText("");
    setError(null);
  };
  return (
    <span className="rl-keys">
      {value.map((k) => (
        <span key={k} className="rl-key" title={k}>
          <span>{labelOf(k)}</span>
          <button type="button" onClick={() => onChange(value.filter((x) => x !== k))} aria-label={`Remove ${labelOf(k)} from rule ${n}`}>
            ✕
          </button>
        </span>
      ))}
      <span className="rl-key-add">
        <label className="rl-inline">
          <span className="sr-only">
            Rule {n}: add a {kind === "app" ? "program address" : "wallet address"}
          </span>
          <input
            ref={input}
            className="input rl-addr"
            value={text}
            placeholder={kind === "app" ? "Paste a program address" : "Paste a wallet address"}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
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
        </label>
        <button type="button" className="rl-icon" onClick={add} aria-label={`Add to rule ${n}`}>
          <PlusIcon />
        </button>
      </span>
      {error !== null ? <span className="field-error rl-key-error">{error}</span> : null}
    </span>
  );
}

// ------------------------------------------------------------- code tab ---

function CodeEditor({ draft, onText, hasIncomplete }: { draft: RulesDraft; onText: (t: string) => void; hasIncomplete: boolean }): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = Math.max(draft.text.split("\n").length, 8);
  const bad = new Set(draft.problems.map((p) => p.line));
  const jump = (p: DslProblem): void => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(p.offset, p.offset + Math.max(1, p.length));
  };
  return (
    <div className="rl-code">
      <p className="pg-text rl-code-intro">
        The same rules as text. Changes here update the blocks as soon as the code is valid. Times count from the launch; amounts are tokens or a share of supply such as
        <code> 0.5%</code>.
      </p>
      {hasIncomplete ? <NoteBox tone="warn">A rule in the Blocks tab is incomplete, so it isn't shown here yet. Finish it there first, or it is dropped when you edit this code.</NoteBox> : null}
      <div className="rl-editor px-corners px-frame" data-invalid={draft.problems.length > 0 ? "" : undefined}>
        <div className="rl-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} data-bad={bad.has(i + 1) ? "" : undefined}>
              {i + 1}
            </span>
          ))}
        </div>
        <textarea
          ref={ref}
          className="rl-textarea"
          value={draft.text}
          rows={lines}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Rules code"
          aria-invalid={draft.problems.length > 0}
          aria-describedby="rules-code-problems"
          placeholder={"rule BOT: during first 15m, deny buy when ixCountGt 3"}
          onChange={(e) => onText(e.target.value)}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      <div id="rules-code-problems" aria-live="polite">
        {draft.problems.length === 0 ? (
          <p className="rl-ok">{draft.text.trim() === "" ? "Empty: no custom rules." : "Valid. The blocks match this code."}</p>
        ) : (
          <ul className="rl-problems">
            {draft.problems.map((p, i) => (
              <li key={i}>
                <button type="button" className="rl-problem" onClick={() => jump(p)}>
                  <span className="rl-problem-at">
                    Line {p.line}, column {p.col}
                  </span>
                  <span>
                    {p.message}
                    {p.hint !== undefined ? ` (${p.hint})` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ size meter ---

function SizeMeter({ bytes, rules, keys, build }: { bytes: number | null; rules: number; keys: number; build: ReturnType<typeof buildDraft>["build"] }): ReactNode {
  const max = RULES_LIMITS.maxBytes;
  return (
    <div className="rl-meter" aria-label="Rule set size">
      <div className="rl-meter-bar">
        <span className="pg-label">Size on chain</span>
        <DotBar value={bytes ?? 0} max={max} tone={bytes !== null && bytes > max * 0.85 ? "warn" : "signal"} label={`Rule set size: ${bytes ?? 0} of ${max} bytes`} size="sm" />
        <span className="rl-meter-v tabular-nums">
          {bytes === null ? "—" : bytes.toLocaleString("en-US")} / {max.toLocaleString("en-US")} bytes
        </span>
      </div>
      <span className="rl-meter-v tabular-nums">
        {rules} / {RULES_LIMITS.maxRules} rules · {keys} / {RULES_LIMITS.maxKeys} wallets or apps
      </span>
      {build !== null && !build.ok ? (
        <p className="field-error" role="alert">
          {build.rule !== null ? `Rule ${build.rule + 1}: ` : ""}
          {build.message}
        </p>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------- timeline ---

/**
 * The guard on one line: the batch window (no buys from the pool), then each rule's window, until the guard ends.
 * Decorative copy of what the cards and the plain-English list say; the scale is linear up to the guard end. Bars are
 * positioned with React style props (CSSOM, CSP-safe).
 */
function RulesTimeline({ draft, env, problems }: { draft: RulesDraft; env: RulesEnv; problems: Map<string, string> }): ReactNode {
  const g = Math.max(1, env.guardSecs);
  const pct = (s: number): number => Math.max(0, Math.min(100, (s / g) * 100));
  const batch = pct(Math.min(env.openDelaySecs, g));
  const span = (from: number, to: number): CSSProperties => ({ left: `${pct(from)}%`, width: `${Math.max(0.8, pct(to) - pct(from))}%` });
  return (
    <figure className="rl-timeline" aria-label="When each rule applies">
      <div className="rl-tl-row rl-tl-axis" aria-hidden="true">
        <span className="rl-tl-n" />
        <span className="rl-tl-track">
          <i className="rl-tl-batch" style={{ width: `${batch}%` }} />
          <i className="rl-tl-trade" style={{ left: `${batch}%`, width: `${100 - batch}%` }} />
        </span>
      </div>
      {draft.items.map((it, i) => {
        const r = "block" in it ? null : it.code;
        const b = "block" in it ? it.block : null;
        const from = r !== null ? r.from : b?.window === "between" ? b.fromSecs : 0;
        const to = r !== null ? (r.to ?? g) : b?.window === "whole" ? g : (b?.toSecs ?? g);
        return (
          <div key={it.id} className="rl-tl-row" aria-hidden="true">
            <span className="rl-tl-n">{i + 1}</span>
            <span className="rl-tl-track">
              <i className="rl-tl-rule" data-problem={problems.has(it.id) ? "" : undefined} style={span(from, to)} />
            </span>
          </div>
        );
      })}
      <figcaption className="rl-tl-cap">
        <span>
          <i className="rl-tl-k rl-tl-k-batch" aria-hidden="true" /> Batch window ({describeSeconds(env.openDelaySecs)}): only the batch buys
        </span>
        <span>
          <i className="rl-tl-k rl-tl-k-rule" aria-hidden="true" /> Your rules
        </span>
        <span>The guard ends {describeSeconds(env.guardSecs)} after launch</span>
      </figcaption>
    </figure>
  );
}
