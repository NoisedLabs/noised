/**
 * Autopilot, Simple (pages/autopilot/simple.ts): every stop of every slider
 * makes a graph the SDK verifies; jobs compose into one graph (ids, the
 * operator only with the AI job, recipients only with the revenue share); a
 * buyback's premium is never offered below what the pool's fee needs to fill
 * (review U5); an agent key with a typo blocks the graph instead of keeping an
 * older key (review U1).
 */
import { describe, expect, it } from "vitest";

import { explainGraphLines, graphVerifies, minPremiumBps } from "../src/lib/programmable";
import { composeJobs, defaultChoices, jobProblems, jobSay, premiumStops, STOPS, type Choices, type JobContext } from "../src/pages/autopilot/simple";

const AGENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const R1 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const ctx: JobContext = { symbol: "TEST", decimals: 6, poolFeeBps: 100, recipients: [{ address: AGENT, bps: 6_000 }, { address: R1, bps: 4_000 }] };

function all(): Choices {
  const c = defaultChoices();
  c.buyback.on = true;
  c.burn.on = true;
  c.share.on = true;
  c.ai.on = true;
  c.ai.operator = AGENT;
  return c;
}

describe("simple jobs", () => {
  it("every stop of every slider builds a graph the SDK verifies", () => {
    for (const fee of [25, 100, 400, 600]) {
      const prem = premiumStops(fee);
      const c0 = { ...ctx, poolFeeBps: fee };
      for (let a = 0; a < STOPS.buybackSol.length; a++)
        for (let e = 0; e < STOPS.every.length; e++)
          for (let p = 0; p < prem.length; p++) {
            const c = defaultChoices();
            c.buyback = { on: true, amount: a, every: e, premium: p };
            const r = composeJobs(c, c0);
            expect(r.build?.ok, `buyback ${a}/${e}/${p} fee ${fee}`).toBe(true);
            if (r.build?.ok) expect(graphVerifies(r.build.bytes)).toBe(true);
          }
      for (let i = 0; i < STOPS.burnTokens.length; i++) {
        const c = defaultChoices();
        c.burn = { on: true, amount: i };
        expect(composeJobs(c, c0).build?.ok).toBe(true);
      }
      for (let a = 0; a < STOPS.shareSol.length; a++)
        for (let e = 0; e < STOPS.shareEvery.length; e++) {
          const c = defaultChoices();
          c.share = { on: true, amount: a, every: e };
          expect(composeJobs(c, c0).build?.ok).toBe(true);
        }
      for (let r = 0; r < STOPS.aiPerRunSol.length; r++)
        for (let d = 0; d < STOPS.aiPerDaySol.length; d++)
          for (let p = 0; p < prem.length; p++) {
            const c = defaultChoices();
            c.ai = { on: true, operator: AGENT, perRun: r, perDay: d, premium: p };
            const res = composeJobs(c, c0);
            const tooBig = Number(STOPS.aiPerRunSol[r]) > Number(STOPS.aiPerDaySol[d]);
            expect(res.build?.ok ?? false, `ai ${r}/${d}/${p}`).toBe(!tooBig);
          }
    }
  });

  it("jobs compose into one graph: operator only with the agent, recipients only with the share", () => {
    const r = composeJobs(all(), ctx);
    expect(r.graph?.nodes.map((n) => n.id)).toEqual(["buyback", "burn", "share", "agent"]);
    expect(r.graph?.operator).toBe(AGENT);
    expect(r.graph?.recipients).toEqual([{ address: AGENT, bps: 6_000 }, { address: R1, bps: 4_000 }]);
    const only = defaultChoices();
    only.buyback.on = true;
    const g = composeJobs(only, ctx).graph;
    expect(g?.operator).toBeNull();
    expect(g?.recipients).toEqual([]);
    expect(composeJobs(defaultChoices(), ctx).graph).toBeNull();
  });

  it("each job's sentence says what it does, and the SDK's explanation agrees", () => {
    const c = all();
    expect(jobSay("buyback", c, ctx)).toMatch(/buys back up to 0\.5 SOL of TEST and burns it/);
    expect(jobSay("burn", c, ctx)).toMatch(/burns up to 50 million of the TEST it holds, once/);
    expect(jobSay("share", c, ctx)).toMatch(/2 wallets \(60%, 40%\)/);
    expect(jobSay("ai", c, ctx)).toMatch(/9xQe…VFin decides when to buy back/);
    const lines = explainGraphLines(composeJobs(c, ctx).graph ?? { operator: null, recipients: [], nodes: [] });
    expect(lines.join(" ")).toMatch(/Buyback: every day/);
    expect(lines.join(" ")).toMatch(/Agent: whenever the token has graduated/);
    // Recipients and the operator by their full address (review U14).
    expect(lines.join(" ")).toContain(`${AGENT} (60%)`);
    expect(lines.join(" ")).toContain(`The operator (${AGENT})`);
    const g = composeJobs(c, ctx).graph;
    if (!g) throw new Error("no graph");
    // A typed label never stands alone: the full address is always next to it.
    const labelled = explainGraphLines({ ...g, recipients: g.recipients.map((r, i) => ({ ...r, label: i === 0 ? "jupiter" : "team" })) }).join(" ");
    expect(labelled).toContain(AGENT);
    expect(labelled).toContain(R1);
    // A price condition reads the slow reference price, and says so (review U14).
    const priced = { ...g, nodes: g.nodes.map((n, i) => (i === 0 ? { ...n, when: { op: "priceLte" as const, price: { sol: "0.0001" } } } : n)) };
    expect(explainGraphLines(priced).join(" ")).toMatch(/the price has stayed at most/);
  });

  it("premiums below what the pool's fee needs are never offered (review U5)", () => {
    for (const fee of [25, 30, 100, 200, 400, 600]) {
      const min = minPremiumBps(fee);
      for (const p of premiumStops(fee)) expect(p).toBeGreaterThanOrEqual(min);
      expect(premiumStops(fee).length).toBeGreaterThan(0);
    }
    expect(premiumStops(400)[0]).toBe(500);
    expect(minPremiumBps(100)).toBe(102);
  });

  it("an agent key with a typo is a visible problem and blocks the graph (review U1)", () => {
    const c = all();
    c.ai.operator = `${AGENT.slice(0, -1)}0`;
    expect(jobProblems(c, ctx).ai).toMatch(/not a valid key/);
    const r = composeJobs(c, ctx);
    expect(r.graph).toBeNull();
    expect(r.build).toBeNull();
    c.ai.operator = "";
    expect(jobProblems(c, ctx).ai).toMatch(/Paste the agent's key/);
  });

  it("a revenue share needs someone to pay", () => {
    const c = defaultChoices();
    c.share.on = true;
    expect(jobProblems(c, { ...ctx, recipients: [] }).share).toMatch(/who gets paid/);
  });
});
