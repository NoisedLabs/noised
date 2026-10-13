/**
 * The selected step's settings: name, when it starts, its conditions, what it
 * does, its limits and whether the AI operator decides. Every field maps to
 * one PXG1 field; the SDK checks the result (issues show on the canvas).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { TrashIcon } from "../../components/icons";
import { Button } from "../../components/ui";
import { tryParseUnits } from "../../lib/amounts";
import { describeSeconds } from "../../lib/format";
import { explainGraphNode, GRAPH_LIMITS, minPremiumBps, sqrtPriceOf, type Action, type ActionKind, type Canvas, type CanvasNode, type Cond, type Graph } from "../../lib/programmable";
import { Comment, NoteBox, Toggle } from "../inner/kit";
import {
  ACTION_ITEMS,
  afterChoices,
  chainCondition,
  conditionChain,
  CONDITION_ITEMS,
  condSqrtPrice,
  dateText,
  defaultLeaf,
  LAMPORTS,
  leafText,
  patchStep,
  priceNearNow,
  priceText,
  renameStep,
  setTrigger,
  TRIGGER_ITEMS,
  type GraphLeafOp,
  type TriggerKind,
} from "./editor";

const SOL_DECIMALS = 9;
const PERIODS = [600, 1800, 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400, 30 * 86_400];
const EPOCHS = [3600, 6 * 3600, 12 * 3600, 86_400, 7 * 86_400, 30 * 86_400];

function unitsText(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? (v / base).toString() : `${v / base}.${frac}`;
}

/** A decimal amount field that commits a raw bigint only when what was typed is valid (the text stays while it is not). */
function UnitsField({ id, label, value, decimals, unit, onCommit, disabled }: { id: string; label: string; value: bigint; decimals: number; unit: string; onCommit: (v: bigint) => void; disabled?: boolean }): ReactNode {
  const [text, setText] = useState(() => unitsText(value, decimals));
  const [bad, setBad] = useState(false);
  // While the field has focus, what was typed stays as typed ("0.50" is not rewritten to "0.5" mid-edit).
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setText(unitsText(value, decimals));
    setBad(false);
  }, [value, decimals]);
  return (
    <div className="ap-field">
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      <span className="ap-unit">
        <input
          id={id}
          className="input"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          aria-invalid={bad}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            if (!bad) setText(unitsText(value, decimals));
          }}
          onChange={(e) => {
            setText(e.target.value);
            const v = tryParseUnits(e.target.value, decimals);
            if (v !== null && v > 0n) {
              setBad(false);
              onCommit(v);
            } else setBad(true);
          }}
        />
        <span className="ap-unit-t" aria-hidden="true">
          {unit}
        </span>
      </span>
      {bad ? <span className="field-error">Enter an amount above 0.</span> : null}
    </div>
  );
}

function PeriodSelect({ id, label, value, options, onChange, disabled }: { id: string; label: string; value: number; options: readonly number[]; onChange: (v: number) => void; disabled?: boolean }): ReactNode {
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <div className="ap-field">
      <label className="pg-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {list.map((s) => (
          <option key={s} value={s}>
            {describeSeconds(s)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Inspector({
  canvas,
  node,
  graph,
  onChange,
  onRemove,
  onAnnounce,
  readOnly,
  now,
  poolFeeBps,
  pricesNow = [],
}: {
  canvas: Canvas;
  node: CanvasNode;
  /** The pool's fee after graduation (bps): a buyback's premium must cover it (review U5). */
  poolFeeBps: number;
  /** The whole graph when it compiles (for the plain-English line), else null. */
  graph: Graph | null;
  onChange: (c: Canvas, select?: string) => void;
  onRemove: () => void;
  onAnnounce: (text: string) => void;
  readOnly: boolean;
  now: number;
  /** Today's prices (sqrt Q64.64: the reference, the pool's), to warn about a price limit close to them; empty when unknown. */
  pricesNow?: readonly bigint[];
}): ReactNode {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const dec = canvas.tokenDecimals ?? 6;
  const [name, setName] = useState(node.id);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    setName(node.id);
    setNameError(null);
  }, [node.id]);
  const index = canvas.nodes.findIndex((n) => n.id === node.id);
  const indexOf = (id: string): number => canvas.nodes.findIndex((n) => n.id === id) + 1;
  const chain = conditionChain(node.when);
  const set = (patch: Parameters<typeof patchStep>[2]): void => onChange(patchStep(canvas, node.id, patch));
  const setLeaves = (leaves: Cond[]): void => set({ when: chainCondition(leaves) });
  const tokenUnit = "tokens";
  const actionUnit = node.action.kind === "burn" ? tokenUnit : "SOL";
  const actionDecimals = node.action.kind === "burn" ? dec : SOL_DECIMALS;
  const explanation = graph !== null && index >= 0 ? explainGraphNode(graph, index) : null;

  const changeTrigger = (kind: TriggerKind): void => {
    const t =
      kind === "every"
        ? { kind, secs: 86_400 }
        : kind === "after"
          ? { kind, node: afterChoices(canvas, node.id)[0] ?? "" }
          : kind === "graduated"
            ? { kind }
            : { kind };
    if (t.kind === "after" && t.node === "") {
      onAnnounce("There is no other step to run after yet.");
      return;
    }
    const r = setTrigger(canvas, node.id, t);
    if (r.error) onAnnounce(r.error);
    else onChange(r.canvas);
  };

  const changeAction = (kind: ActionKind): void => {
    if (kind === node.action.kind) return;
    const a: Action =
      kind === "buybackBurn" ? { kind, maxInLamports: LAMPORTS / 4n, maxPremiumBps: 300 } : kind === "burn" ? { kind, maxTokens: 1_000_000n * 10n ** BigInt(dec) } : { kind, maxLamports: LAMPORTS / 10n };
    const per = kind === "buybackBurn" ? a.kind === "buybackBurn" ? a.maxInLamports : 0n : a.kind === "burn" ? a.maxTokens : a.kind === "distributeSol" ? a.maxLamports : 0n;
    set({ action: a, budgetPerEpoch: per * BigInt(node.maxRunsPerEpoch) });
  };

  return (
    <div className="ap-inspector" aria-label={`Step ${index + 1} settings`}>
      <div className="ap-insp-head">
        <span className="ap-node-n">{index + 1}</span>
        <h3 className="ap-insp-title">Step settings</h3>
      </div>

      <div className="ap-field">
        <label className="pg-label" htmlFor={`${uid}-name`}>
          Name
        </label>
        <input
          id={`${uid}-name`}
          className="input mono"
          value={name}
          disabled={readOnly}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={nameError !== null}
          aria-describedby={nameError !== null ? `${uid}-name-err` : undefined}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const r = renameStep(canvas, node.id, name.trim());
            if (r.error) setNameError(r.error);
            else {
              setNameError(null);
              if (name.trim() !== node.id) onChange(r.canvas, name.trim());
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {nameError !== null ? (
          <span id={`${uid}-name-err`} className="field-error">
            {nameError}
          </span>
        ) : null}
      </div>

      <fieldset className="ap-group" disabled={readOnly}>
        <legend className="ap-legend">Starts</legend>
        <div className="ap-field">
          <label className="pg-label" htmlFor={`${uid}-trig`}>
            When it runs
          </label>
          <select id={`${uid}-trig`} className="select" value={node.trigger.kind} onChange={(e) => changeTrigger(e.target.value as TriggerKind)}>
            {TRIGGER_ITEMS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {node.trigger.kind === "every" ? (
          <PeriodSelect id={`${uid}-every`} label="Every" value={node.trigger.secs} options={PERIODS} onChange={(secs) => onChange(setTrigger(canvas, node.id, { kind: "every", secs }).canvas)} />
        ) : null}
        {node.trigger.kind === "after" ? (
          <div className="ap-field">
            <label className="pg-label" htmlFor={`${uid}-after`}>
              Runs after
            </label>
            <select
              id={`${uid}-after`}
              className="select"
              value={node.trigger.node}
              onChange={(e) => {
                const r = setTrigger(canvas, node.id, { kind: "after", node: e.target.value });
                if (r.error) onAnnounce(r.error);
                else onChange(r.canvas);
              }}
            >
              {afterChoices(canvas, node.id).map((id) => (
                <option key={id} value={id}>
                  Step {indexOf(id)} · {id}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Comment>{TRIGGER_ITEMS.find((t) => t.id === node.trigger.kind)?.hint}</Comment>
      </fieldset>

      <fieldset className="ap-group" disabled={readOnly}>
        <legend className="ap-legend">Only if</legend>
        {chain === null ? (
          <p className="ap-codeonly">
            {node.when ? leafText(node.when, dec, indexOf) : "always"}
            <span className="ap-codeonly-n">This condition uses "or" or "not": edit it in the Code tab.</span>
          </p>
        ) : chain.length === 0 ? (
          <p className="ap-muted">No conditions: it runs whenever it is due.</p>
        ) : (
          <ul className="ap-conds">
            {chain.map((c, i) => (
              <li key={i} className="ap-cond">
                <CondEditor
                  id={`${uid}-c${i}`}
                  cond={c}
                  decimals={dec}
                  canvas={canvas}
                  pricesNow={pricesNow}
                  onChange={(next) => setLeaves(chain.map((x, j) => (j === i ? next : x)))}
                />
                <button type="button" className="rl-icon" onClick={() => setLeaves(chain.filter((_, j) => j !== i))} aria-label={`Remove condition ${i + 1}`}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {chain !== null ? (
          <div className="ap-field">
            <label className="sr-only" htmlFor={`${uid}-addc`}>
              Add a condition
            </label>
            <select
              id={`${uid}-addc`}
              className="select ap-add-sel"
              value=""
              onChange={(e) => {
                const op = e.target.value as GraphLeafOp | "";
                if (op !== "") setLeaves([...chain, defaultLeaf(op, node.id, dec, now)]);
              }}
            >
              <option value="">+ add a condition…</option>
              {CONDITION_ITEMS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="ap-group" disabled={readOnly}>
        <legend className="ap-legend">Does</legend>
        <div className="ap-field">
          <label className="pg-label" htmlFor={`${uid}-act`}>
            Action
          </label>
          <select id={`${uid}-act`} className="select" value={node.action.kind} onChange={(e) => changeAction(e.target.value as ActionKind)}>
            {ACTION_ITEMS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        {node.action.kind === "buybackBurn" ? (
          <>
            <UnitsField id={`${uid}-maxin`} label="Spend up to, per run" value={node.action.maxInLamports} decimals={SOL_DECIMALS} unit="SOL" onCommit={(v) => set({ action: { ...(node.action as Extract<Action, { kind: "buybackBurn" }>), maxInLamports: v } })} />
            <div className="ap-field">
              <label className="pg-label" htmlFor={`${uid}-prem`}>
                Pay at most this much above the recent low price
              </label>
              <select
                id={`${uid}-prem`}
                className="select"
                value={node.action.maxPremiumBps}
                onChange={(e) => set({ action: { ...(node.action as Extract<Action, { kind: "buybackBurn" }>), maxPremiumBps: Number(e.target.value) } })}
              >
                {[50, 100, 200, 300, 500, 750, 1000, 1500, GRAPH_LIMITS.maxPremiumBps, node.action.maxPremiumBps]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .sort((a, b) => a - b)
                  .map((b) => (
                    <option key={b} value={b}>
                      {b / 100}%{b < minPremiumBps(poolFeeBps) ? " (too low for this pool)" : ""}
                    </option>
                  ))}
              </select>
              {node.action.maxPremiumBps < minPremiumBps(poolFeeBps) ? (
                <span className="field-error" role="alert">
                  The pool keeps {poolFeeBps / 100}% of every buy, so a buyback allowed to pay only {node.action.maxPremiumBps / 100}% above the recent low price can never fill. Pick at least {Math.ceil(minPremiumBps(poolFeeBps) / 100)}%.
                </span>
              ) : null}
            </div>
          </>
        ) : null}
        {node.action.kind === "burn" ? (
          <UnitsField id={`${uid}-maxtok`} label="Burn up to, per run" value={node.action.maxTokens} decimals={dec} unit="tokens" onCommit={(v) => set({ action: { kind: "burn", maxTokens: v } })} />
        ) : null}
        {node.action.kind === "distributeSol" ? (
          <UnitsField id={`${uid}-maxpay`} label="Pay up to, per run" value={node.action.maxLamports} decimals={SOL_DECIMALS} unit="SOL" onCommit={(v) => set({ action: { kind: "distributeSol", maxLamports: v } })} />
        ) : null}
        <Comment>{ACTION_ITEMS.find((a) => a.id === node.action.kind)?.hint}</Comment>
      </fieldset>

      <fieldset className="ap-group" disabled={readOnly}>
        <legend className="ap-legend">Limits</legend>
        <PeriodSelect id={`${uid}-epoch`} label="Budget period" value={node.epochSecs} options={EPOCHS} onChange={(epochSecs) => set({ epochSecs })} />
        <UnitsField id={`${uid}-budget`} label={`Most it spends per ${describeSeconds(node.epochSecs)}`} value={node.budgetPerEpoch} decimals={actionDecimals} unit={actionUnit} onCommit={(v) => set({ budgetPerEpoch: v })} />
        <div className="ap-field">
          <label className="pg-label" htmlFor={`${uid}-runs`}>
            Most runs per period
          </label>
          <input
            id={`${uid}-runs`}
            className="input tabular-nums"
            inputMode="numeric"
            value={node.maxRunsPerEpoch}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 65_535) set({ maxRunsPerEpoch: n });
            }}
          />
        </div>
        <Toggle checked={node.operatorGated} onChange={(v) => set({ operatorGated: v })} disabled={readOnly}>
          Let the operator (for example an AI agent) choose when and how much, within these limits
        </Toggle>
        {node.operatorGated ? <Comment>Only the operator key you set below can run this step. Even a hacked agent can't go past these limits.</Comment> : null}
      </fieldset>

      {explanation !== null ? <p className="rl-explain">{explanation}</p> : null}

      {!readOnly ? (
        <Button size="sm" variant="danger" onClick={onRemove}>
          <TrashIcon /> Remove this step
        </Button>
      ) : null}
    </div>
  );
}

/** One condition with its value. */
function CondEditor({
  id,
  cond,
  decimals,
  canvas,
  pricesNow,
  onChange,
}: {
  id: string;
  cond: Cond;
  decimals: number;
  canvas: Canvas;
  pricesNow: readonly bigint[];
  onChange: (c: Cond) => void;
}): ReactNode {
  const label = CONDITION_ITEMS.find((c) => c.id === cond.op)?.label ?? cond.op;
  switch (cond.op) {
    case "treasurySolGte":
      return <UnitsField id={id} label="Treasury has at least" value={cond.lamports} decimals={SOL_DECIMALS} unit="SOL" onCommit={(lamports) => onChange({ op: cond.op, lamports })} />;
    case "treasuryTokensGte":
      return (
        <UnitsField
          id={id}
          label="Treasury has at least"
          value={"raw" in cond.amount ? cond.amount.raw : 0n}
          decimals={decimals}
          unit="tokens"
          onCommit={(raw) => onChange({ op: cond.op, amount: { raw } })}
        />
      );
    case "graduated":
      return <span className="ap-cond-t">The token has graduated</span>;
    case "priceLte":
    case "priceGte":
      return <PriceField id={id} label={label} cond={cond} decimals={decimals} pricesNow={pricesNow} onChange={onChange} />;
    case "nowGe":
    case "nowLt":
      return (
        <div className="ap-field">
          <label className="pg-label" htmlFor={id}>
            {cond.op === "nowGe" ? "From" : "Until"}
          </label>
          <input
            id={id}
            type="date"
            className="input"
            value={dateText(cond.unix)}
            onChange={(e) => {
              const t = Date.parse(`${e.target.value}T00:00:00Z`);
              if (Number.isFinite(t)) onChange({ op: cond.op, unix: BigInt(Math.floor(t / 1000)) });
            }}
          />
        </div>
      );
    case "runsInEpochLt":
      return (
        <span className="ap-cond-row">
          <span className="ap-field">
            <label className="pg-label" htmlFor={`${id}-node`}>
              Step
            </label>
            <select id={`${id}-node`} className="select" value={cond.node} onChange={(e) => onChange({ ...cond, node: e.target.value })}>
              {canvas.nodes.map((n, i) => (
                <option key={n.id} value={n.id}>
                  {i + 1} · {n.id}
                </option>
              ))}
            </select>
          </span>
          <span className="ap-field">
            <label className="pg-label" htmlFor={`${id}-n`}>
              ran fewer than
            </label>
            <input
              id={`${id}-n`}
              className="input tabular-nums"
              inputMode="numeric"
              value={cond.n}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 65_535) onChange({ ...cond, n });
              }}
            />
          </span>
        </span>
      );
    default:
      return <span className="ap-cond-t">{cond.op}</span>;
  }
}

/**
 * A price limit. A price condition holds only while the price has stayed past its limit for the last 15 to 30
 * minutes, so someone willing to pay trading fees can delay its step (one trade across the limit and back every
 * 15 minutes) but never trigger it, and the closer the limit is to today's price, the cheaper that is
 * (follow-up review L-1): warn within PRICE_NEAR_PCT, and say it plainly when today's price is unknown.
 */
function PriceField({
  id,
  label,
  cond,
  decimals,
  pricesNow,
  onChange,
}: {
  id: string;
  label: string;
  cond: Extract<Cond, { op: "priceLte" | "priceGte" }>;
  decimals: number;
  pricesNow: readonly bigint[];
  onChange: (c: Cond) => void;
}): ReactNode {
  const shown = "sqrtPriceQ64" in cond.price ? priceText(cond.price.sqrtPriceQ64, decimals) : cond.price.sol;
  const limit = condSqrtPrice(cond, decimals);
  const known = pricesNow.some((p) => p > 0n);
  const near = limit !== null && priceNearNow(limit, pricesNow);
  const hint = CONDITION_ITEMS.find((c) => c.id === cond.op)?.hint;
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  // The note is its own row of the condition (under the field and its remove button), so the button stays by the input.
  return (
    <>
      <div className="ap-field">
        <label className="pg-label" htmlFor={id}>
          {label} (SOL per token)
        </label>
        <input
          id={id}
          className="input mono"
          inputMode="decimal"
          value={text}
          aria-invalid={bad}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
          }}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const s = sqrtPriceOf(e.target.value.trim(), decimals);
              if (s <= 0n) throw new Error("zero");
              setBad(false);
              onChange({ op: cond.op, price: { sqrtPriceQ64: s } });
            } catch {
              setBad(true);
            }
          }}
        />
        {bad ? <span className="field-error">Enter a price such as 0.000002.</span> : null}
      </div>
      {!bad && near ? (
        <NoteBox tone="warn" title="Close to today's price" className="ap-cond-note">
          Someone willing to pay trading fees could delay this step. They can never trigger it.
        </NoteBox>
      ) : (
        <Comment className="ap-cond-note">
          {hint}
          {known ? null : " Someone willing to pay trading fees could delay this step, but never trigger it. A limit far from the going price makes that costly."}
        </Comment>
      )}
    </>
  );
}
