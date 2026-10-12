/**
 * A graph as TypeScript that rebuilds it with the SDK's builder (the
 * "TypeScript" tab; for developers and AI agents). Amounts are written as
 * raw bigints (lamports, raw token units) so the code rebuilds exactly the
 * same bytes. Pure; test/autopilot-canvas.test.ts checks the output.
 */
import type { Action, Cond, Graph, Trigger } from "../../lib/programmable";
import { formatDurationShort } from "../../lib/programmable";

/** The package the generated code imports (the app itself reaches the SDK only through lib/noised). */
const SDK_PACKAGE = "@noisedlabs/sdk";

const big = (v: bigint): string => `${v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_")}n`;
const str = (s: string): string => JSON.stringify(s);

function condTs(c: Cond): string {
  switch (c.op) {
    case "true":
      return "when.always()";
    case "false":
      return "when.never()";
    case "and":
      return `${condTs(c.a)}.and(${condTs(c.b)})`;
    case "or":
      return `${condTs(c.a)}.or(${condTs(c.b)})`;
    case "not":
      return `not(${condTs(c.x)})`;
    case "treasurySolGte":
      return `when.treasurySolGte(${big(c.lamports)})`;
    case "treasuryTokensGte":
      return `when.treasuryTokensGte(${"raw" in c.amount ? big(c.amount.raw) : str(c.amount.tokens)})`;
    case "graduated":
      return "when.graduated()";
    case "priceLte":
    case "priceGte":
      return `when.${c.op}(${"sqrtPriceQ64" in c.price ? big(c.price.sqrtPriceQ64) : str(c.price.sol)})`;
    case "nowGe":
      return `when.onOrAfter(${big(c.unix)})`;
    case "nowLt":
      return `when.before(${big(c.unix)})`;
    case "runsInEpochLt":
      return `when.runsInEpochLt(${str(c.node)}, ${c.n})`;
    default:
      return `/* a launch-rule condition can't be used here: ${c.op} */ when.never()`;
  }
}

function triggerTs(t: Trigger): string {
  switch (t.kind) {
    case "every":
      return `every(${str(formatDurationShort(t.secs))})`;
    case "after":
      return `after(${str(t.node)})`;
    case "graduated":
      return "onGraduation()";
    case "when":
      return "whenever()";
  }
}

function actionTs(a: Action): string {
  switch (a.kind) {
    case "buybackBurn":
      return `buybackBurn({ maxIn: ${big(a.maxInLamports)}, maxPremiumBps: ${a.maxPremiumBps} })`;
    case "burn":
      return `burn({ maxTokens: ${big(a.maxTokens)} })`;
    case "distributeSol":
      return `distributeSol({ maxPerRun: ${big(a.maxLamports)} })`;
  }
}

/** The builder code for `g` (imports included). */
export function graphToTypeScript(g: Graph): string {
  const used = new Set<string>(["graph"]);
  const lines: string[] = [];
  const opts: string[] = [];
  if (g.operator !== null) opts.push(`operator: ${str(g.operator)}`);
  if (g.tokenDecimals !== undefined) opts.push(`tokenDecimals: ${g.tokenDecimals}`);
  lines.push(`export const autopilot = graph(${opts.length > 0 ? `{ ${opts.join(", ")} }` : ""})`);
  for (const r of g.recipients) lines.push(`  .recipient(${str(r.address)}, ${r.bps}${r.label !== undefined ? `, ${str(r.label)}` : ""})`);
  for (const n of g.nodes) {
    const trig = triggerTs(n.trigger);
    used.add(trig.slice(0, trig.indexOf("(")));
    const cond = n.when === null ? "null" : condTs(n.when);
    if (cond.includes("when.")) used.add("when");
    if (cond.includes("not(")) used.add("not");
    const act = actionTs(n.action);
    used.add(act.slice(0, act.indexOf("(")));
    const o = [`budgetPerEpoch: ${big(n.budgetPerEpoch)}`, `epoch: ${str(formatDurationShort(n.epochSecs))}`, `maxRunsPerEpoch: ${n.maxRunsPerEpoch}`];
    if (n.operatorGated) o.push("operatorGated: true");
    lines.push(`  .node(${str(n.id)}, ${trig}, ${cond}, ${act}, { ${o.join(", ")} })`);
  }
  lines[lines.length - 1] += ";";
  const imports = [...used].sort().join(", ");
  return [`import { ${imports} } from ${JSON.stringify(SDK_PACKAGE)};`, "", ...lines, "", "// autopilot.compile() -> PXG1 bytes; autopilot.hash() -> graph_hash; autopilot.explain() -> plain English", ""].join("\n");
}
