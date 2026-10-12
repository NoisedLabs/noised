/**
 * What the creator signs and what holders see coming, in plain words (review
 * U1, U2): the change list compares the scheduled steps with the running ones
 * (new, changed with what it was, removed, who gets paid, the operator), every
 * wallet by its full address; the people list names every recipient and the
 * operator in full.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { explainGraphLines, graphChanges, graphFromBytes, buildGraph, type Graph } from "../src/lib/programmable";
import { PeopleList } from "../src/pages/autopilot/ReviewPanel";
import { composeJobs, defaultChoices, type JobContext } from "../src/pages/autopilot/simple";

const AGENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const R1 = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const ctx: JobContext = { symbol: "T", decimals: 6, poolFeeBps: 100, recipients: [{ address: R1, bps: 10_000 }] };

function graph(set: (c: ReturnType<typeof defaultChoices>) => void, recipients = ctx.recipients): Graph {
  const c = defaultChoices();
  set(c);
  const g = composeJobs(c, { ...ctx, recipients }).graph;
  if (!g) throw new Error("no graph");
  return g;
}

describe("a scheduled change, spelled out (review U2)", () => {
  it("a first graph: every step is new", () => {
    const next = graph((c) => {
      c.buyback.on = true;
      c.burn.on = true;
    });
    const ch = graphChanges(null, next);
    expect(ch.map((c) => c.kind)).toEqual(["added", "added"]);
    expect(ch[0]?.text).toMatch(/^New step: Buyback: every day/);
  });

  it("new, changed (with what it was), removed, who gets paid and the operator", () => {
    const running = graph((c) => {
      c.buyback.on = true;
      c.burn.on = true;
    });
    const next = graph(
      (c) => {
        c.buyback = { ...c.buyback, on: true, amount: c.buyback.amount + 1 };
        c.share.on = true;
        c.ai = { ...c.ai, on: true, operator: AGENT };
      },
      [
        { address: R1, bps: 6_000 },
        { address: AGENT, bps: 4_000 },
      ],
    );
    const ch = graphChanges(running, next);
    const kinds = ch.map((c) => c.kind);
    expect(kinds).toEqual(["changed", "added", "added", "removed", "recipients", "operator"]);
    const changed = ch.find((c) => c.kind === "changed")?.text ?? "";
    expect(changed).toMatch(/^Changed: Buyback: .* \(was: Buyback: .*\)$/);
    expect(ch.find((c) => c.kind === "removed")?.text).toMatch(/^Removed: Burn: once, when the token graduates/);
    // Every wallet in full, never shortened or labelled.
    expect(ch.find((c) => c.kind === "recipients")?.text).toBe(`Pays: ${R1} (60%), ${AGENT} (40%).`);
    expect(ch.find((c) => c.kind === "operator")?.text).toBe(`Operator: ${AGENT}.`);
  });

  it("the same steps are no change; dropping the operator and the payees says so", () => {
    const g = graph((c) => {
      c.share.on = true;
      c.ai = { ...c.ai, on: true, operator: AGENT };
    });
    expect(graphChanges(g, g)).toEqual([]);
    const fewer = graph((c) => {
      c.burn.on = true;
    });
    const ch = graphChanges(g, fewer);
    expect(ch.filter((c) => c.kind === "recipients").map((c) => c.text)).toEqual(["Nobody is paid any more."]);
    expect(ch.filter((c) => c.kind === "operator").map((c) => c.text)).toEqual(["No operator."]);
  });
});

describe("what the creator signs (review U1)", () => {
  it("the plain-English lines are of exactly the bytes signed, guarantees included", () => {
    const g = graph((c) => {
      c.share.on = true;
    });
    const b = buildGraph(g);
    if (!b.ok) throw new Error("does not build");
    const lines = explainGraphLines(b.bytes, true, 6);
    const back = graphFromBytes(b.bytes, 6);
    if (!back) throw new Error("does not read back");
    expect(lines).toEqual(explainGraphLines(back, true));
    expect(lines.join(" ")).toContain(`${R1} (100%)`);
    expect(lines.join(" ")).toMatch(/never sells the token/);
    expect(lines.join(" ")).toMatch(/72-hour public wait/);
  });

  it("the people list names every recipient and the operator in full", () => {
    const g = graph(
      (c) => {
        c.share.on = true;
        c.ai = { ...c.ai, on: true, operator: AGENT };
      },
      [
        { address: R1, bps: 6_000 },
        { address: AGENT, bps: 4_000 },
      ],
    );
    const html = renderToStaticMarkup(createElement(PeopleList, { graph: g }));
    expect(html).toContain(R1);
    expect(html).toContain(">60%<");
    expect(html.split(AGENT).length - 1).toBe(2);
    const none = renderToStaticMarkup(createElement(PeopleList, { graph: { ...g, recipients: [], operator: null } }));
    expect(none).toMatch(/Nobody: these steps pay no one/);
    expect(none).toMatch(/None: nobody but the schedule decides/);
  });
});
