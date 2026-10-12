/**
 * Autopilot, Simple: four jobs as cards, each switched on with a tick and
 * shaped with sliders, with one plain sentence that says exactly what it
 * will do. They make one set of steps (./simple.ts); the Advanced canvas and
 * code edit the same steps.
 */
import { useId, type ReactNode } from "react";

import { Say, StopSlider } from "../create/SimpleControls";
import { Toggle } from "../inner/kit";
import { everyText, JOB_BLURBS, JOB_TITLES, jobSay, pctText, premiumStops, solText, STOPS, tokensText, type Choices, type JobContext, type JobId } from "./simple";

const ORDER: readonly JobId[] = ["buyback", "burn", "share", "ai"];

export function AutopilotSimple({
  choices,
  onChoices,
  ctx,
  problems,
  readOnly,
}: {
  choices: Choices;
  onChoices: (c: Choices) => void;
  ctx: JobContext;
  problems: Partial<Record<JobId, string>>;
  readOnly: boolean;
}): ReactNode {
  const prem = premiumStops(ctx.poolFeeBps);
  const set = <K extends JobId>(id: K, patch: Partial<Choices[K]>): void => onChoices({ ...choices, [id]: { ...choices[id], ...patch } });
  const slider = (label: string, stops: readonly (string | number)[], index: number, text: (v: string | number) => string, on: (i: number) => void): ReactNode => (
    <StopSlider
      key={label}
      label={label}
      stops={stops.length}
      index={Math.min(index, stops.length - 1)}
      exact
      valueText={text(stops[Math.min(index, stops.length - 1)] ?? stops[0] ?? 0)}
      stopText={(i) => text(stops[i] ?? 0)}
      onIndex={on}
      ends={[text(stops[0] ?? 0), text(stops[stops.length - 1] ?? 0)]}
    />
  );
  return (
    <ul className="rg-grid ap-jobs" aria-label="What the autopilot does">
      {ORDER.map((id) => {
        const on = choices[id].on;
        const problem = problems[id] ?? null;
        return (
          <li key={id}>
            <article className="rg-card px-corners px-frame" data-on={on ? "" : undefined} aria-label={JOB_TITLES[id]}>
              <Toggle checked={on} disabled={readOnly} onChange={(v) => set(id, { on: v })} describedBy={`ap-job-${id}`} strong className="rg-toggle">
                {JOB_TITLES[id]}
              </Toggle>
              <p className="rg-blurb" id={`ap-job-${id}`}>
                {JOB_BLURBS[id]}
              </p>
              {on ? (
                <div className="rg-body sm-stack">
                  {id === "buyback" ? (
                    <>
                      {slider("How much each time", STOPS.buybackSol, choices.buyback.amount, (v) => solText(String(v)), (i) => set("buyback", { amount: i }))}
                      {slider("How often", STOPS.every, choices.buyback.every, (v) => cap(everyText(Number(v))), (i) => set("buyback", { every: i }))}
                      {slider("Most it pays above the recent low", prem, choices.buyback.premium, (v) => pctText(Number(v)), (i) => set("buyback", { premium: i }))}
                    </>
                  ) : null}
                  {id === "burn" ? slider("How many tokens", STOPS.burnTokens, choices.burn.amount, (v) => tokensText(Number(v)), (i) => set("burn", { amount: i })) : null}
                  {id === "share" ? (
                    <>
                      {slider("How much each payout", STOPS.shareSol, choices.share.amount, (v) => solText(String(v)), (i) => set("share", { amount: i }))}
                      {slider("How often", STOPS.shareEvery, choices.share.every, (v) => cap(everyText(Number(v))), (i) => set("share", { every: i }))}
                      <div className="ap-people-list">
                        <p className="pg-label">Who gets paid (your launch's fee recipients; change them under Advanced)</p>
                        {ctx.recipients.length === 0 ? (
                          <p className="ap-muted">Nobody yet.</p>
                        ) : (
                          <ul>
                            {ctx.recipients.map((r) => (
                              <li key={r.address}>
                                <span className="ap-share tabular-nums">{r.bps / 100}%</span> <code className="pg-break">{r.address}</code>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  ) : null}
                  {id === "ai" ? (
                    <>
                      <OperatorField value={choices.ai.operator} problem={problem} onChange={(operator) => set("ai", { operator })} readOnly={readOnly} />
                      {slider("Most per buyback", STOPS.aiPerRunSol, choices.ai.perRun, (v) => solText(String(v)), (i) => set("ai", { perRun: i }))}
                      {slider("Most per day", STOPS.aiPerDaySol, choices.ai.perDay, (v) => solText(String(v)), (i) => set("ai", { perDay: i }))}
                      {slider("Most it pays above the recent low", prem, choices.ai.premium, (v) => pctText(Number(v)), (i) => set("ai", { premium: i }))}
                    </>
                  ) : null}
                  {problem !== null && id !== "ai" ? (
                    <p className="field-error" role="alert">
                      {problem}
                    </p>
                  ) : problem === null ? (
                    <Say text={jobSay(id, choices, ctx)} />
                  ) : null}
                </div>
              ) : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

const cap = (s: string): string => (s ? (s[0] ?? "").toUpperCase() + s.slice(1) : s);

/** The agent's key: the field shows what was typed, and a visible error while it is not a valid key (review U1). */
function OperatorField({ value, problem, onChange, readOnly }: { value: string; problem: string | null; onChange: (v: string) => void; readOnly: boolean }): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <div className="ap-field">
      <label className="sl-label" htmlFor={`${id}-op`}>
        The agent's key
      </label>
      <input
        id={`${id}-op`}
        className="input mono"
        value={value}
        disabled={readOnly}
        spellCheck={false}
        autoComplete="off"
        placeholder="Paste the agent's public key"
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? `${id}-op-e` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {problem !== null ? (
        <span className="field-error" id={`${id}-op-e`} role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
