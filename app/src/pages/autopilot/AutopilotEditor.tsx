/**
 * The Autopilot builder: templates, the node palette, the pixel graph canvas,
 * the selected step's inspector, the treasury's recipients and operator, the
 * Code tab (the graph DSL, round-tripping with the canvas) and a TypeScript
 * tab (the same graph as SDK builder code). Everything compiles to the same
 * PXG1 bytes the chain verifies; problems show on the cards and in a list.
 *
 * Layout follows the editor's own width (a container query, autopilot-page.css): wide, the palette, canvas and
 * inspector sit side by side; narrower (the Custom launch's Autopilot step beside its step rail), the canvas takes the
 * full width with the palette above it and the inspector below; on a phone the canvas comes first. "Full screen" lays
 * the same editor over the whole window (Esc or the button closes it).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PlusIcon, TrashIcon } from "../../components/icons";
import { Button, CopyButton } from "../../components/ui";
import { sfx } from "../../fx/sfx";
import {
  canvasOf,
  GRAPH_LIMITS,
  graphTemplates,
  isAddress,
  parseGraphText,
  printGraphText,
  type Canvas,
  type CanvasIssue,
  type DslProblem,
  type GraphBuild,
} from "../../lib/programmable";
import { Chip, Comment, DotBar, NoteBox, Tabs, tabPanel } from "../inner/kit";
import { PALETTE_MIME, GraphCanvas } from "./GraphCanvas";
import {
  ACTION_ITEMS,
  addCondition,
  addStep,
  CONDITION_ITEMS,
  connectSteps,
  disconnectSteps,
  graphOrNull,
  moveStep,
  nodeViews,
  positionsOf,
  removeStep,
  setTrigger,
  TRIGGER_ITEMS,
  type PaletteRef,
} from "./editor";
import { Inspector } from "./Inspector";
import { graphToTypeScript } from "./tsCode";

type Mode = "canvas" | "code" | "ts";

export interface EditorDefaults {
  /** Who a revenue-share template pays (the launch's fee recipients). */
  recipients: { address: string; bps: number; label?: string }[];
  /** The operator key templates start with (the connected wallet). */
  operator: string | null;
}

export function AutopilotEditor({
  canvas,
  onCanvas,
  selected,
  onSelect,
  readOnly,
  defaults,
  now,
  build,
  canUndo,
  onUndo,
  pulse,
  poolFeeBps,
}: {
  /** The pool's fee after graduation (bps), for the buyback premium check. */
  poolFeeBps: number;
  canvas: Canvas;
  onCanvas: (c: Canvas) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  readOnly: boolean;
  defaults: EditorDefaults;
  now: number;
  build: GraphBuild;
  canUndo: boolean;
  onUndo: () => void;
  pulse: string | null;
}): ReactNode {
  const [mode, setMode] = useState<Mode>("canvas");
  const [announce, setAnnounce] = useState("");
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  // The editor renders into its own host element, which moves between its place on the page and <body> (full screen):
  // panels are glass (backdrop-filter), which would trap a position: fixed child, and moving the host instead of
  // re-rendering keeps every bit of editor state (the canvas's view, a half-typed field). No DOM (tests): inline.
  const [host] = useState<HTMLDivElement | null>(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const [placeholder, setPlaceholder] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (host === null) return;
    if (expanded) {
      host.className = "pgx ap-editor-host";
      document.body.appendChild(host);
    } else {
      host.className = "ap-editor-host";
      anchorRef.current?.appendChild(host);
    }
  }, [expanded, host]);
  useEffect(() => () => host?.remove(), [host]);
  // Full screen: the page behind stops scrolling, keeps its height and can't be reached by Tab (inert; the editor's host
  // sits outside it, in <body>); closing returns focus to the button.
  useEffect(() => {
    if (!expanded) return;
    const root = document.documentElement;
    const app = document.getElementById("root");
    root.classList.add("ap-fullscreen-open");
    if (app) app.inert = true;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      root.classList.remove("ap-fullscreen-open");
      if (app) app.inert = false;
    };
  }, [expanded]);
  const toggleExpanded = (open: boolean): void => {
    setPlaceholder(open ? (rootRef.current?.getBoundingClientRect().height ?? null) : null);
    setExpanded(open);
    sfx.play("toggle");
    if (!open) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(".ap-expand")?.focus({ preventScroll: true }));
  };
  const onEditorKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Esc closes full screen unless something inside already used it (the canvas cancels a selection or a link first).
    if (expanded && e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      toggleExpanded(false);
    }
  };
  const idBase = `ap${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const issues: CanvasIssue[] = build.ok ? [] : build.issues;
  const views = useMemo(() => nodeViews(canvas, issues, pulse), [canvas, issues, pulse]);
  const edges = useMemo(() => canvas.edges.map((e) => ({ from: e.source, to: e.target })), [canvas.edges]);
  const graph = useMemo(() => graphOrNull(canvas), [canvas]);
  const node = canvas.nodes.find((n) => n.id === selected) ?? null;
  const dec = canvas.tokenDecimals ?? 6;

  const say = (text: string): void => setAnnounce(text);

  const usePalette = (ref: PaletteRef, at: { x: number; y: number } | null, target: string | null): void => {
    if (readOnly) return;
    const [group, id] = ref.split(":") as [string, string];
    if (group === "action") {
      if (canvas.nodes.length >= GRAPH_LIMITS.maxNodes) return say(`An autopilot has at most ${GRAPH_LIMITS.maxNodes} steps.`);
      const r = addStep(canvas, id as (typeof ACTION_ITEMS)[number]["id"], at, dec);
      onCanvas(r.canvas);
      onSelect(r.id);
      sfx.play("click");
      return say(`Added step ${r.canvas.nodes.length}: ${ACTION_ITEMS.find((a) => a.id === id)?.label ?? id}.`);
    }
    const stepId = target ?? selected;
    if (stepId === null) return say("Select a step first, then pick what to change.");
    if (group === "trigger") {
      const kind = id as (typeof TRIGGER_ITEMS)[number]["id"];
      if (kind === "after") {
        const other = canvas.nodes.find((n) => n.id !== stepId);
        if (!other) return say("Add another step first: this one would run after it.");
        const r = connectSteps(canvas, other.id, stepId);
        if (r.error) return say(r.error);
        onCanvas(r.canvas);
        onSelect(stepId);
        return say(`Step now runs after ${other.id}. Change which one in its settings.`);
      }
      const t = kind === "every" ? { kind, secs: 86_400 } : kind === "graduated" ? { kind } : { kind: "when" as const };
      const r = setTrigger(canvas, stepId, t);
      onCanvas(r.canvas);
      onSelect(stepId);
      return say(`Changed when ${stepId} runs.`);
    }
    const r = addCondition(canvas, stepId, id as (typeof CONDITION_ITEMS)[number]["id"], now);
    if (r.error) return say(r.error);
    onCanvas(r.canvas);
    onSelect(stepId);
    say(`Added a condition to ${stepId}.`);
  };

  const applyTemplate = (id: string): void => {
    const t = graphTemplates.find((x) => x.id === id);
    if (!t) return;
    const params: Record<string, unknown> = {};
    if (t.id === "revenue-share") params.recipients = defaults.recipients.map((r) => ({ address: r.address, share: r.bps, ...(r.label !== undefined ? { label: r.label } : {}) }));
    if (t.id === "ai-buyback") params.operator = defaults.operator ?? "";
    try {
      const g = { ...t.build(params), tokenDecimals: dec };
      onCanvas(canvasOf(g));
      onSelect(g.nodes[0]?.id ?? null);
      sfx.play("toggle");
      say(`Loaded the "${t.title}" template. Undo brings your steps back.`);
    } catch (e) {
      say(`${t.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const editor = (
    <div
      ref={rootRef}
      className="ap-editor"
      data-expanded={expanded ? "" : undefined}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? "Autopilot builder, full screen" : undefined}
      tabIndex={expanded ? -1 : undefined}
      onKeyDown={onEditorKey}
    >
      <div className="rl-templates" role="group" aria-label="Start from a template">
        <span className="pg-label">Templates</span>
        {graphTemplates.map((t) => (
          <button key={t.id} type="button" className="rl-template" disabled={readOnly} title={t.summary} onClick={() => applyTemplate(t.id)}>
            <span className="rl-template-t">{t.title}</span>
            <span className="rl-template-s">{t.summary}</span>
          </button>
        ))}
      </div>

      <div className="ap-editor-bar">
        <Tabs<Mode>
          items={[
            { value: "canvas", label: "Canvas" },
            { value: "code", label: "Code" },
            { value: "ts", label: "TypeScript" },
          ]}
          value={mode}
          onChange={setMode}
          label="Edit the autopilot as"
          idBase={idBase}
        />
        <span className="ap-editor-tools">
          <Button size="sm" variant="ghost" disabled={!canUndo || readOnly} onClick={onUndo}>
            Undo
          </Button>
          <Button className="ap-expand" size="sm" variant={expanded ? "primary" : "ghost"} onClick={() => toggleExpanded(!expanded)} aria-pressed={expanded}>
            {expanded ? "Exit full screen" : "Full screen"}
          </Button>
        </span>
      </div>

      <div {...tabPanel(idBase, "canvas", mode)}>
        <div className="ap-workbench">
          <Palette readOnly={readOnly} selected={selected} onUse={(ref) => usePalette(ref, null, null)} />
          <div className="ap-center">
            <GraphCanvas
              nodes={views}
              edges={edges}
              selected={selected}
              onSelect={onSelect}
              readOnly={readOnly}
              onMove={(id, p) => onCanvas(moveStep(canvas, id, p))}
              onConnect={(from, to) => {
                const r = connectSteps(canvas, from, to);
                if (!r.error) onCanvas(r.canvas);
                return r.error;
              }}
              onDeleteNode={(id) => {
                onCanvas(removeStep(canvas, id));
                if (selected === id) onSelect(null);
              }}
              onDeleteEdge={(e) => onCanvas(disconnectSteps(canvas, e.from, e.to))}
              onDropItem={(item, at, target) => usePalette(item as PaletteRef, at, target)}
              label="Autopilot steps"
            />
            <Issues issues={issues} canvas={canvas} onShow={onSelect} />
          </div>
          <div className="ap-side">
            {node !== null ? (
              <Inspector
                key={node.id}
                canvas={canvas}
                node={node}
                graph={graph}
                readOnly={readOnly}
                now={now}
                poolFeeBps={poolFeeBps}
                onAnnounce={say}
                onChange={(c, select) => {
                  onCanvas(c);
                  if (select !== undefined) onSelect(select);
                }}
                onRemove={() => {
                  onCanvas(removeStep(canvas, node.id));
                  onSelect(null);
                  say(`Removed ${node.id}.`);
                }}
              />
            ) : (
              <div className="ap-inspector ap-inspector-empty">
                <p className="ap-muted">Select a step to change when it runs, its conditions, what it does and its limits.</p>
                <ul className="ap-legend-list">
                  <li>Drag a card to move it. It snaps to the grid.</li>
                  <li>Drag from a card's bottom square onto another card: that one runs right after it.</li>
                  <li>Ctrl + scroll or the buttons zoom; drag the background to pan.</li>
                  <li>With the keyboard: Tab to a card, arrows move it, C then Enter on another card links them.</li>
                </ul>
              </div>
            )}
            <People canvas={canvas} onCanvas={onCanvas} readOnly={readOnly} />
          </div>
        </div>
      </div>

      <div {...tabPanel(idBase, "code", mode)}>
        <GraphCode canvas={canvas} onCanvas={onCanvas} readOnly={readOnly} onSelect={onSelect} />
      </div>

      <div {...tabPanel(idBase, "ts", mode)}>
        {graph !== null ? (
          <div className="ap-ts">
            <p className="pg-text">The same autopilot as TypeScript, built with the Noised SDK. Developers and AI agents can generate or check it in code; it compiles to exactly the same bytes.</p>
            <pre className="ap-pre" tabIndex={0} aria-label="TypeScript builder code">
              <code>{graphToTypeScript(graph)}</code>
            </pre>
            <CopyButton value={graphToTypeScript(graph)} label="Copy code" />
          </div>
        ) : (
          <NoteBox tone="warn" title="Fix the problems first">
            The TypeScript view appears once every step is valid.
          </NoteBox>
        )}
      </div>

      <SizeMeter build={build} nodes={canvas.nodes.length} />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {announce !== "" ? (
        <p className="ap-announce" aria-hidden="true">
          {announce}
        </p>
      ) : null}
    </div>
  );
  if (host === null) return editor;
  return (
    <>
      <div ref={anchorRef} className="ap-editor-anchor" style={placeholder !== null ? { minHeight: placeholder } : undefined} />
      {createPortal(editor, host)}
    </>
  );
}

// ---------------------------------------------------------------- palette ---

function Palette({ readOnly, selected, onUse }: { readOnly: boolean; selected: string | null; onUse: (ref: PaletteRef) => void }): ReactNode {
  const group = (title: string, hint: string, items: readonly { id: string; label: string; hint: string }[], prefix: "action" | "trigger" | "condition"): ReactNode => (
    <section className="ap-pal-group" aria-label={title}>
      <h3 className="ap-pal-title">{title}</h3>
      <p className="ap-pal-hint">{hint}</p>
      <ul className="ap-pal-list">
        {items.map((it) => {
          const ref = `${prefix}:${it.id}` as PaletteRef;
          const needsSelection = prefix !== "action" && selected === null;
          return (
            <li key={it.id}>
              <button
                type="button"
                className="ap-pal-item"
                data-group={prefix}
                draggable={!readOnly}
                disabled={readOnly}
                aria-disabled={needsSelection ? true : undefined}
                title={it.hint}
                onDragStart={(e) => {
                  e.dataTransfer.setData(PALETTE_MIME, ref);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onUse(ref)}
              >
                <span className="ap-pal-dot" aria-hidden="true" />
                {it.label}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <nav className="ap-palette" aria-label="Node palette">
      {group("Does", "Adds a step.", ACTION_ITEMS, "action")}
      {group("Starts", selected === null ? "Select a step, then pick." : `Sets when ${selected} runs.`, TRIGGER_ITEMS, "trigger")}
      {group("Only if", selected === null ? "Select a step, then pick." : `Adds a condition to ${selected}.`, CONDITION_ITEMS, "condition")}
    </nav>
  );
}

// ----------------------------------------------------------------- issues ---

function Issues({ issues, canvas, onShow }: { issues: readonly CanvasIssue[]; canvas: Canvas; onShow: (id: string | null) => void }): ReactNode {
  if (canvas.nodes.length === 0) return null;
  if (issues.length === 0) {
    return (
      <p className="ap-ok" role="status">
        ✓ Every step is valid. This is exactly what the chain will check.
      </p>
    );
  }
  return (
    <ul className="rl-problems ap-issues" aria-label="Problems to fix">
      {issues.map((x, i) => (
        <li key={i}>
          <button type="button" className="rl-problem" onClick={() => onShow(x.nodeId ?? null)} disabled={x.nodeId === undefined}>
            <span className="rl-problem-at">{x.nodeId !== undefined ? `Step ${canvas.nodes.findIndex((n) => n.id === x.nodeId) + 1} · ${x.nodeId}` : "Autopilot"}</span>
            <span>{x.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------- recipients, operator ---

function People({ canvas, onCanvas, readOnly }: { canvas: Canvas; onCanvas: (c: Canvas) => void; readOnly: boolean }): ReactNode {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const needsRecipients = canvas.nodes.some((n) => n.action.kind === "distributeSol");
  const needsOperator = canvas.nodes.some((n) => n.operatorGated);
  const total = canvas.recipients.reduce((s, r) => s + r.bps, 0);
  // The field IS the operator: what is typed goes into the steps as typed, so a key with a typo blocks the build (the
  // SDK refuses it) and is shown as a problem here, instead of the last valid key being signed silently (review U1).
  const opText = canvas.operator ?? "";
  const opBad = opText !== "" && !isAddress(opText);
  return (
    <section className="ap-people" aria-label="Who gets paid and who operates">
      <h3 className="ap-insp-title">Who gets paid</h3>
      {canvas.recipients.length === 0 ? (
        <p className="ap-muted">{needsRecipients ? "A pay step needs at least one recipient." : "Only needed for a pay step."}</p>
      ) : (
        <ul className="ap-recips">
          {canvas.recipients.map((r, i) => (
            <li key={i} className="ap-recip">
              <span className="ap-field ap-recip-addr">
                <label className="sr-only" htmlFor={`${uid}-ra${i}`}>
                  Recipient {i + 1} address
                </label>
                <input
                  id={`${uid}-ra${i}`}
                  className="input mono"
                  value={r.address}
                  disabled={readOnly}
                  spellCheck={false}
                  aria-invalid={!isAddress(r.address)}
                  aria-describedby={!isAddress(r.address) ? `${uid}-ra${i}-e` : undefined}
                  onChange={(e) => onCanvas({ ...canvas, recipients: canvas.recipients.map((x, j) => (j === i ? { ...x, address: e.target.value.trim() } : x)) })}
                />
                {!isAddress(r.address) ? (
                  <span className="field-error" id={`${uid}-ra${i}-e`}>
                    {r.address === "" ? "Paste a wallet address." : "Not a valid address."}
                  </span>
                ) : null}
              </span>
              <span className="ap-field ap-recip-share">
                <label className="sr-only" htmlFor={`${uid}-rs${i}`}>
                  Recipient {i + 1} share (%)
                </label>
                <span className="ap-unit">
                  <input
                    id={`${uid}-rs${i}`}
                    className="input tabular-nums"
                    inputMode="decimal"
                    value={r.bps / 100}
                    disabled={readOnly}
                    onChange={(e) => {
                      const v = Math.round(Number(e.target.value) * 100);
                      if (Number.isInteger(v) && v >= 0 && v <= 10_000) onCanvas({ ...canvas, recipients: canvas.recipients.map((x, j) => (j === i ? { ...x, bps: v } : x)) });
                    }}
                  />
                  <span className="ap-unit-t" aria-hidden="true">
                    %
                  </span>
                </span>
              </span>
              <button type="button" className="rl-icon" disabled={readOnly} onClick={() => onCanvas({ ...canvas, recipients: canvas.recipients.filter((_, j) => j !== i) })} aria-label={`Remove recipient ${i + 1}`}>
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ap-people-foot">
        <Button
          size="sm"
          disabled={readOnly || canvas.recipients.length >= GRAPH_LIMITS.maxRecipients}
          onClick={() => onCanvas({ ...canvas, recipients: [...canvas.recipients, { address: "", bps: canvas.recipients.length === 0 ? 10_000 : 0 }] })}
        >
          <PlusIcon /> Add recipient
        </Button>
        {canvas.recipients.length > 0 ? (
          <span className="ap-total tabular-nums" data-tone={total === 10_000 ? "ok" : "warn"}>
            Total {total / 100}%
          </span>
        ) : null}
      </div>

      <h3 className="ap-insp-title">Operator (optional)</h3>
      <div className="ap-field">
        <label className="pg-label" htmlFor={`${uid}-op`}>
          Operator key (for example an AI agent)
        </label>
        <input
          id={`${uid}-op`}
          className="input mono"
          value={opText}
          disabled={readOnly}
          spellCheck={false}
          placeholder={needsOperator ? "Needed: a step lets the operator decide" : "None"}
          aria-invalid={opBad}
          aria-describedby={opBad ? `${uid}-op-e` : undefined}
          onChange={(e) => {
            const v = e.target.value.trim();
            onCanvas({ ...canvas, operator: v === "" ? null : v });
          }}
        />
        {opBad ? (
          <span className="field-error" id={`${uid}-op-e`} role="alert">
            That is not a valid key: check every character. Nothing can be signed until it is fixed.
          </span>
        ) : null}
      </div>
      <Comment>The operator can only choose when and how much, inside the limits of the steps it controls. It can never move funds anywhere else. You can revoke it later with your quantum key.</Comment>
    </section>
  );
}

// ------------------------------------------------------------- code tab ---

function GraphCode({ canvas, onCanvas, readOnly, onSelect }: { canvas: Canvas; onCanvas: (c: Canvas) => void; readOnly: boolean; onSelect: (id: string | null) => void }): ReactNode {
  const graph = graphOrNull(canvas);
  const printed = graph !== null ? printGraphText(graph) : null;
  const [draft, setDraft] = useState<{ text: string; problems: DslProblem[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const text = draft?.text ?? printed ?? "";
  const problems = draft?.problems ?? [];
  const lines = Math.max(text.split("\n").length, 10);
  const bad = new Set(problems.map((p) => p.line));
  return (
    <div className="rl-code">
      <p className="pg-text rl-code-intro">
        The same autopilot as text. Valid changes update the canvas right away; card positions are kept.
      </p>
      {graph === null && draft === null ? <NoteBox tone="warn">The canvas has problems, so its code can't be shown yet. Fix them on the canvas, or write the autopilot here from scratch.</NoteBox> : null}
      <div className="rl-editor px-corners px-frame" data-invalid={problems.length > 0 ? "" : undefined}>
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
          value={text}
          rows={lines}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Autopilot code"
          aria-invalid={problems.length > 0}
          aria-describedby="autopilot-code-problems"
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onChange={(e) => {
            const t = e.target.value;
            const parsed = parseGraphText(t, { tokenDecimals: canvas.tokenDecimals ?? 6 });
            if (!parsed.ok) {
              setDraft({ text: t, problems: parsed.problems });
              return;
            }
            setDraft({ text: t, problems: [] });
            onCanvas(canvasOf({ ...parsed.graph, tokenDecimals: canvas.tokenDecimals ?? 6 }, positionsOf(canvas)));
            onSelect(null);
          }}
          onBlur={() => {
            if (draft !== null && draft.problems.length === 0) setDraft(null);
          }}
        />
      </div>
      <div id="autopilot-code-problems" aria-live="polite">
        {problems.length === 0 ? (
          <p className="rl-ok">{text.trim() === "" ? "Empty." : "Valid. The canvas matches this code."}</p>
        ) : (
          <ul className="rl-problems">
            {problems.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="rl-problem"
                  onClick={() => {
                    ref.current?.focus();
                    ref.current?.setSelectionRange(p.offset, p.offset + Math.max(1, p.length));
                  }}
                >
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
      {draft !== null && draft.problems.length > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Discard my edits and show the canvas's code
        </Button>
      ) : null}
    </div>
  );
}

function SizeMeter({ build, nodes }: { build: GraphBuild; nodes: number }): ReactNode {
  const bytes = build.ok ? build.bytes.length : null;
  const max = GRAPH_LIMITS.maxBytes;
  return (
    <div className="rl-meter" aria-label="Autopilot size">
      <div className="rl-meter-bar">
        <span className="pg-label">Size on chain</span>
        <DotBar value={bytes ?? 0} max={max} label={`Autopilot size: ${bytes ?? 0} of ${max} bytes`} size="sm" tone={bytes !== null && bytes > max * 0.85 ? "warn" : "signal"} />
        <span className="rl-meter-v tabular-nums">
          {bytes === null ? "—" : bytes.toLocaleString("en-US")} / {max.toLocaleString("en-US")} bytes
        </span>
      </div>
      <span className="rl-meter-v tabular-nums">
        {nodes} / {GRAPH_LIMITS.maxNodes} steps {build.ok ? <Chip tone="ok">Valid</Chip> : nodes > 0 ? <Chip tone="warn">{build.issues.length} to fix</Chip> : null}
      </span>
    </div>
  );
}
