/**
 * The Custom launch's optional Autopilot (owner's request, 2026-10-11): the steps a new token runs from the moment it
 * opens, chosen as Simple jobs (sliders) or edited as a graph / code, compiled to the PXG1 bytes the creator's quantum
 * key switches on right after the launch opens (lib/launchFlow.ts, step 6). Pure: the step's state and its build.
 */
import { buildCanvas, canvasOf, type Canvas, type GraphBuild, type Recipient } from "../../lib/programmable";
import { emptyCanvas } from "../autopilot/editor";
import { composeJobs, defaultChoices, jobsOn, type Choices, type JobContext } from "../autopilot/simple";

export interface AutopilotDraft {
  /** Switch an Autopilot on when the launch opens. */
  on: boolean;
  choices: Choices;
  /** The graph on the canvas (what "Graph and code" edits; the Simple jobs write it too). */
  canvas: Canvas;
  /** Undo history of the canvas (the last 40). */
  past: Canvas[];
  /** Where the steps come from: the Simple jobs, or the graph editor. */
  source: "simple" | "advanced";
}

/** Off, with the daily buyback and burn ready as the first job when it is switched on. */
export function autopilotDraft(decimals: number): AutopilotDraft {
  const choices = defaultChoices();
  return { on: false, choices: { ...choices, buyback: { ...choices.buyback, on: true } }, canvas: emptyCanvas(decimals), past: [], source: "simple" };
}

/** New Simple choices: the canvas shows the graph they make. */
export function withChoices(ap: AutopilotDraft, choices: Choices, ctx: JobContext): AutopilotDraft {
  const c = composeJobs(choices, ctx);
  return { ...ap, choices, source: "simple", canvas: c.graph !== null ? canvasOf(c.graph) : emptyCanvas(ctx.decimals), past: [] };
}

/** An edit on the canvas (undo keeps the previous one). */
export function withCanvas(ap: AutopilotDraft, canvas: Canvas): AutopilotDraft {
  return canvas === ap.canvas ? ap : { ...ap, canvas, past: [...ap.past.slice(-39), ap.canvas], source: "advanced" };
}

export function undoCanvas(ap: AutopilotDraft): AutopilotDraft {
  const prev = ap.past[ap.past.length - 1];
  return prev === undefined ? ap : { ...ap, canvas: prev, past: ap.past.slice(0, -1) };
}

/**
 * The bytes the launch switches on, or why not (null: no Autopilot). Simple jobs build through the SDK's node maker;
 * an edited graph through the canvas compiler; both give what the program verifies.
 */
export function autopilotBuild(ap: AutopilotDraft, ctx: JobContext): GraphBuild | null {
  if (!ap.on) return null;
  if (ap.source === "simple") {
    if (jobsOn(ap.choices) === 0) return { ok: false, issues: [{ code: "BadModel", message: "Switch a job on, or add a step under Graph and code." }] };
    const c = composeJobs(ap.choices, ctx);
    if (c.build !== null) return c.build;
    return { ok: false, issues: Object.values(c.problems).map((message) => ({ code: "BadModel", message })) } as GraphBuild;
  }
  if (ap.canvas.nodes.length === 0) return { ok: false, issues: [{ code: "BadModel", message: "Add a step, or switch a job on under Simple jobs." }] };
  return buildCanvas({ ...ap.canvas, tokenDecimals: ctx.decimals });
}

/** Recipients with shares adding up to exactly 100% (a graph's must), in order: the launch's wallets, scaled. */
export function graphRecipients(rs: readonly { address: string; bps: number }[]): Recipient[] {
  const total = rs.reduce((s, r) => s + r.bps, 0);
  if (rs.length === 0 || total === 0) return [];
  const out = rs.map((r) => ({ address: r.address, bps: Math.floor((r.bps * 10_000) / total) }));
  const left = 10_000 - out.reduce((s, r) => s + r.bps, 0);
  if (out[0]) out[0].bps += left;
  return out;
}
