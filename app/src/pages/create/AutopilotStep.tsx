/**
 * Custom launch, step "Autopilot" (optional; owner's request, 2026-10-11): the token runs itself from the moment it
 * opens. Fund its treasury with a share of the fees, pick ready-made jobs with sliders (or edit the same steps as a
 * LangGraph-style graph, or as code), see the graph and the plain English, and optionally hand the timing to an AI
 * agent. Nothing here is signed: the launch flow switches these exact steps on right after the launch opens, signed
 * by the quantum key (a first Autopilot has no waiting period).
 *
 * Loaded on first use (the graph editor is large).
 */
import { useId, useMemo, useState, type ReactNode } from "react";

import { useNow } from "../../app/hooks";
import { PROGRAMMABLE_AVAILABLE } from "../../lib/noised";
import { explainGraphLines, type GraphBuild } from "../../lib/programmable";
import { AiAgentPanel } from "../autopilot/AiAgentPanel";
import { AutopilotEditor } from "../autopilot/AutopilotEditor";
import { AutopilotSimple } from "../autopilot/AutopilotSimple";
import { nodeViews } from "../autopilot/editor";
import { GraphCanvas } from "../autopilot/GraphCanvas";
import { jobProblems, type JobContext } from "../autopilot/simple";
import { Chip, Comment, NoteBox, Panel, Tabs, tabPanel, Toggle } from "../inner/kit";
import { undoCanvas, withCanvas, withChoices, type AutopilotDraft } from "./autopilotDraft";
import { SPLIT_STOPS_PCT } from "./quick";
import { Say, StopSlider } from "./SimpleControls";
import "../autopilot/autopilot.css";
import "../autopilot/autopilot-page.css";
import "../create/rules/rules.css";

/** Treasury shares the slider offers (whole percent of the creator's fee share). */
const TREASURY_STOPS: readonly number[] = [0, ...SPLIT_STOPS_PCT, 100];

type Tab = "simple" | "graph";

export function AutopilotStep({
  value,
  onChange,
  ctx,
  build,
  treasuryPct,
  onTreasuryPct,
  operatorDefault,
}: {
  value: AutopilotDraft;
  onChange: (next: AutopilotDraft) => void;
  ctx: JobContext;
  build: GraphBuild | null;
  /** The treasury's share of the fees now (whole percent). */
  treasuryPct: number;
  onTreasuryPct: (pct: number) => void;
  /** Who an AI template starts with (the connected wallet). */
  operatorDefault: string | null;
}): ReactNode {
  const now = useNow();
  const idBase = `aps${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [tab, setTab] = useState<Tab>("simple");
  const [selected, setSelected] = useState<string | null>(null);
  const ap = value;
  const problems = ap.source === "simple" ? jobProblems(ap.choices, ctx) : {};
  const ok = build !== null && build.ok;
  const issues = build !== null && !build.ok ? build.issues : [];
  const views = useMemo(() => nodeViews(ap.canvas, issues, null), [ap.canvas, issues]);
  const edges = useMemo(() => ap.canvas.edges.map((e) => ({ from: e.source, to: e.target })), [ap.canvas.edges]);
  const lines = useMemo(() => (ok && build !== null && build.ok ? explainGraphLines(build.graph, true) : []), [ok, build]);
  const ti = Math.max(0, TREASURY_STOPS.indexOf(TREASURY_STOPS.reduce((best, s) => (Math.abs(s - treasuryPct) < Math.abs(best - treasuryPct) ? s : best), 0)));
  const usesSol = ok && build !== null && build.ok && build.graph.nodes.some((n) => n.action.kind !== "burn");

  return (
    <Panel
      title="Autopilot"
      status={<Chip tone={ap.on ? "ok" : "muted"}>{ap.on ? "On when it opens" : "Optional"}</Chip>}
      description="Your token can run itself from the moment it opens: buybacks that burn, burns and payouts from its own treasury. Your quantum key switches it on right after the launch opens."
      className="aps"
    >
      <Toggle
        checked={ap.on}
        onChange={(on) => {
          // Switched on, the jobs' steps show at once as a graph (an edited graph stays as it was).
          onChange(on && ap.source === "simple" ? withChoices({ ...ap, on: true }, ap.choices, ctx) : { ...ap, on });
          // An Autopilot needs funds: switching it on gives its treasury a quarter of the fees (moved with the slider).
          if (on && treasuryPct === 0) onTreasuryPct(25);
        }}
        strong
      >
        Switch on an Autopilot when the launch opens
      </Toggle>
      {!PROGRAMMABLE_AVAILABLE ? (
        <NoteBox title="Coming soon on this network">
          You can build it and see it here; switching it on at launch is not live on this network yet. The demo shows the whole flow. Launching without it now is fine:
          you can add it later from the token&apos;s page.
        </NoteBox>
      ) : null}
      {ap.on ? (
        <div className="aps-body sm-stack">
          <div className="aps-fund">
            <StopSlider
              label="Share of your fees for the token's treasury"
              stops={TREASURY_STOPS.length}
              index={ti}
              exact={TREASURY_STOPS[ti] === treasuryPct}
              valueText={`${treasuryPct}%`}
              stopText={(i) => `${TREASURY_STOPS[i] ?? 0}%`}
              onIndex={(i) => onTreasuryPct(TREASURY_STOPS[i] ?? 0)}
              ends={["0%", "100%"]}
              say={
                treasuryPct === 0
                  ? "None of the fees go to the treasury: these steps only spend what someone sends it."
                  : `${treasuryPct}% of your share of every trading fee goes to the token's treasury, which these steps spend. The rest goes to your fee recipients.`
              }
            />
            {treasuryPct === 0 && usesSol ? <NoteBox tone="warn">These steps spend SOL from the treasury: give it a share of the fees, or they will have nothing to run with.</NoteBox> : null}
          </div>

          <Tabs<Tab>
            items={[
              { value: "simple", label: "Ready-made jobs" },
              { value: "graph", label: "Graph and code" },
            ]}
            value={tab}
            onChange={setTab}
            label="Build the Autopilot"
            idBase={idBase}
          />
          <div {...tabPanel(idBase, "simple", tab)}>
            {ap.source !== "simple" && ap.canvas.nodes.length > 0 ? (
              <NoteBox title="You changed the steps under Graph and code">Switching a job on here starts over from the jobs.</NoteBox>
            ) : null}
            <AutopilotSimple choices={ap.choices} onChoices={(c) => onChange(withChoices(ap, c, ctx))} ctx={ctx} problems={problems} readOnly={false} />
            {ap.canvas.nodes.length > 0 ? (
              <div className="aps-graph">
                <p className="pg-label">How it runs: trigger, condition, action</p>
                <GraphCanvas nodes={views} edges={edges} selected={selected} onSelect={setSelected} readOnly label="The Autopilot's steps as a graph" className="aps-canvas" />
                <Comment>
                  The same steps as a graph. Open <b>Graph and code</b> to drag steps, connect them (&ldquo;runs after&rdquo;), add conditions, or write them as code.
                </Comment>
              </div>
            ) : null}
          </div>
          <div {...tabPanel(idBase, "graph", tab)}>
            <AutopilotEditor
              canvas={ap.canvas}
              onCanvas={(c) => onChange(withCanvas(ap, c))}
              selected={selected}
              onSelect={setSelected}
              readOnly={false}
              defaults={{ recipients: ctx.recipients, operator: operatorDefault }}
              now={now}
              build={build ?? { ok: false, issues: [] }}
              canUndo={ap.past.length > 0}
              onUndo={() => onChange(undoCanvas(ap))}
              pulse={null}
              poolFeeBps={ctx.poolFeeBps}
            />
          </div>

          {lines.length > 0 ? (
            <div className="ap-summary">
              <p className="pg-label">In plain English</p>
              <ol className="rl-plain">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
            </div>
          ) : build !== null && !build.ok && issues.length > 0 ? (
            <NoteBox tone="warn">{issues[0]?.message}</NoteBox>
          ) : null}
          <Say text="A first Autopilot has no waiting period: it starts a minute or two after your quantum key signs it. Any later change waits 72 hours, in public." />

          <AiAgentPanel
            templateOn={ap.choices.ai.on && ap.source === "simple"}
            onUseTemplate={() => {
              onChange(withChoices(ap, { ...ap.choices, ai: { ...ap.choices.ai, on: true, operator: ap.choices.ai.operator || (operatorDefault ?? "") } }, ctx));
              setTab("simple");
            }}
          />
        </div>
      ) : (
        <Comment>Off: the token launches without one. You can add it later from the token&apos;s Autopilot page (a change to a running one waits 72 hours).</Comment>
      )}
    </Panel>
  );
}
