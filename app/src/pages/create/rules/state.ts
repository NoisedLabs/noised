/**
 * The Create wizard's custom-rules draft: one list of rules, shown three
 * ways and kept in step:
 *
 *   - the Simple gallery: presets switched on with sliders (./presets.ts);
 *     their rules are items tagged with the preset, regenerated whenever a
 *     slider or the launch's timing changes;
 *   - Advanced, as sentence blocks (./blocks.ts): editing a preset's rule
 *     there turns that preset's rules into the creator's own (untagged);
 *   - Advanced, as code (the SDK's text DSL): editing re-parses it; presets
 *     whose rules are still there unchanged stay on, others turn off (their
 *     rules stay as written). While the code has errors the blocks keep the
 *     last version that parsed (the errors show where, by line and column).
 *
 * Pure (no React). test/rules-blocks.test.ts and test/rules-presets.test.ts
 * cover the round trips.
 */
import { compileRuleSet, parseRulesText, printRulesText, type DslProblem, type Rule, type RuleKey, type RuleSet, type RulesBuild } from "../../../lib/programmable";
import { blockToRule, itemsFromRules, rulesFromItems, sameCond, type RuleItem } from "./blocks";
import { presetRules, PRESETS, type PresetId, type PresetValues, type RulesEnv } from "./presets";

export type { RulesEnv } from "./presets";

/** A rule in the draft, possibly made by a preset (then the gallery owns it). */
export type DraftItem = RuleItem & { preset?: PresetId };

export interface RulesDraft {
  /** Named wallets / apps (labels exist only in the code; the chain stores addresses). */
  keys: RuleKey[];
  items: DraftItem[];
  /** Presets switched on, with their slider positions. */
  presets: Partial<Record<PresetId, PresetValues>>;
  /** The Code tab's text. */
  text: string;
  /** Problems of `text` (empty when it parses). */
  problems: DslProblem[];
}

export const EMPTY_RULES: RulesDraft = { keys: [], items: [], presets: {}, text: "", problems: [] };

let nextId = 0;
export const newRuleId = (): string => `rule-${++nextId}`;

/** The SDK rule set of a draft (blocks with problems left out) and those problems by item id. */
export function ruleSetOf(d: RulesDraft, env: RulesEnv): { set: RuleSet; problems: Map<string, string> } {
  const { rules, problems } = rulesFromItems(d.items);
  return { set: { guardSecs: env.guardSecs, tokenDecimals: env.decimals, keys: d.keys, rules }, problems };
}

/** The code printed from items (empty for none). */
function textOf(d: Pick<RulesDraft, "keys" | "items">, env: RulesEnv): string {
  const { set } = ruleSetOf({ ...EMPTY_RULES, ...d }, env);
  if (set.rules.length === 0) return "";
  try {
    return printRulesText(set);
  } catch {
    return "";
  }
}

/** After a blocks edit: the new items, and the code printed from them. */
export function withItems(d: RulesDraft, items: DraftItem[], env: RulesEnv): RulesDraft {
  const next = { ...d, items };
  return { ...next, text: textOf(next, env), problems: [] };
}

/** A blocks edit of one item. Editing a preset's rule makes all of that preset's rules the creator's own. */
export function editItem(d: RulesDraft, id: string, next: RuleItem, env: RulesEnv): RulesDraft {
  const old = d.items.find((x) => x.id === id);
  const preset = old?.preset;
  const items = d.items.map((x) => (x.id === id ? { ...next } : preset !== undefined && x.preset === preset ? untag(x) : x));
  const presets = { ...d.presets };
  if (preset !== undefined) delete presets[preset];
  return withItems({ ...d, presets }, items, env);
}

/** Removes items; a preset that loses one of its rules turns off (its other rules stay, as the creator's own). */
export function removeItems(d: RulesDraft, ids: readonly string[], env: RulesEnv): RulesDraft {
  const gone = new Set(ids);
  const touched = new Set(d.items.filter((x) => gone.has(x.id) && x.preset !== undefined).map((x) => x.preset as PresetId));
  const items = d.items.filter((x) => !gone.has(x.id)).map((x) => (x.preset !== undefined && touched.has(x.preset) ? untag(x) : x));
  const presets = { ...d.presets };
  for (const p of touched) delete presets[p];
  return withItems({ ...d, presets }, items, env);
}

function untag(x: DraftItem): DraftItem {
  const { preset: _p, ...rest } = x;
  return rest as DraftItem;
}

/** Rules a preset makes now, as tagged items (null: it can't build yet, e.g. no team wallet). */
function presetItems(id: PresetId, v: PresetValues, env: RulesEnv): DraftItem[] | null {
  const r = presetRules(id, v, env);
  if (!r.ok) return null;
  return itemsFromRules(r.set.rules, env.guardSecs, env.decimals, newRuleId).map((it) => ({ ...it, preset: id }));
}

/**
 * Switches a preset on (with these values), moves its sliders, or off (null). Its rules stay where they were in the
 * list; a new preset's go after the rules already there.
 */
export function setPreset(d: RulesDraft, id: PresetId, v: PresetValues | null, env: RulesEnv): RulesDraft {
  const at = d.items.findIndex((x) => x.preset === id);
  const rest = d.items.filter((x) => x.preset !== id);
  const presets = { ...d.presets };
  if (v === null) {
    delete presets[id];
    return withItems({ ...d, presets }, rest, env);
  }
  presets[id] = { ...v, wallets: [...v.wallets] };
  const made = presetItems(id, v, env) ?? [];
  const pos = at < 0 ? rest.length : Math.min(at, rest.length);
  const items = [...rest.slice(0, pos), ...made, ...rest.slice(pos)];
  return withItems({ ...d, presets }, items, env);
}

/** Every preset's rules again for a new guard length, batch window or decimals (the creator's own rules stay). */
export function refreshPresets(d: RulesDraft, env: RulesEnv): RulesDraft {
  let next = d;
  for (const p of PRESETS) {
    const v = d.presets[p.id];
    if (v !== undefined) next = setPreset(next, p.id, v, env);
  }
  return next === d ? withItems(d, d.items, env) : next;
}

/** Structural equality of two rules (amounts and conditions compared by their fields). */
export function sameRule(a: Rule, b: Rule): boolean {
  return a.from === b.from && a.to === b.to && a.effect === b.effect && a.code === b.code && JSON.stringify(a.cap ?? null) === JSON.stringify(b.cap ?? null) && sameCond(a.when, b.when);
}

const ruleOf = (it: RuleItem): Rule | null => {
  if ("code" in it) return it.code;
  try {
    return blockToRule(it.block);
  } catch {
    return null;
  }
};

/** After a code edit: presets whose rules are all still there, unchanged and in a row, keep them; others turn off. */
function retag(items: DraftItem[], presets: RulesDraft["presets"], env: RulesEnv): { items: DraftItem[]; presets: RulesDraft["presets"] } {
  const out = items.map(untag);
  const kept: RulesDraft["presets"] = {};
  for (const p of PRESETS) {
    const v = presets[p.id];
    if (v === undefined) continue;
    const r = presetRules(p.id, v, env);
    if (!r.ok || r.set.rules.length === 0) continue;
    const want = r.set.rules;
    for (let i = 0; i + want.length <= out.length; i++) {
      const run = out.slice(i, i + want.length);
      if (run.some((x) => x.preset !== undefined)) continue;
      if (run.every((x, j) => {
        const got = ruleOf(x);
        return got !== null && sameRule(got, want[j] as Rule);
      })) {
        for (let j = i; j < i + want.length; j++) out[j] = { ...(out[j] as DraftItem), preset: p.id };
        kept[p.id] = v;
        break;
      }
    }
  }
  return { items: out, presets: kept };
}

/** After a code edit: the blocks from the code when it parses, else the same blocks and the problems. */
export function withText(d: RulesDraft, text: string, env: RulesEnv): RulesDraft {
  if (text.trim() === "") return { keys: [], items: [], presets: {}, text, problems: [] };
  const parsed = parseRulesText(text, { guardSecs: env.guardSecs, tokenDecimals: env.decimals });
  if (!parsed.ok) return { ...d, text, problems: parsed.problems };
  const items: DraftItem[] = itemsFromRules(parsed.set.rules, env.guardSecs, env.decimals, newRuleId);
  const r = retag(items, d.presets, env);
  return { keys: parsed.set.keys, items: r.items, presets: r.presets, text, problems: [] };
}

/** Compiles the draft: no rules -> null (no custom rules, the all-zero hash). */
export function buildDraft(d: RulesDraft, env: RulesEnv): { build: RulesBuild | null; blockProblems: Map<string, string> } {
  const { set, problems } = ruleSetOf(d, env);
  if (d.items.length === 0) return { build: null, blockProblems: problems };
  if (problems.size > 0) return { build: { ok: false, message: "Finish the highlighted rules first.", rule: null }, blockProblems: problems };
  return { build: compileRuleSet(set), blockProblems: problems };
}

/** Problems of the presets that are on (e.g. the team preset without a wallet), by preset. */
export function presetProblems(d: RulesDraft, env: RulesEnv): Partial<Record<PresetId, string>> {
  const out: Partial<Record<PresetId, string>> = {};
  for (const p of PRESETS) {
    const v = d.presets[p.id];
    if (v === undefined) continue;
    const r = presetRules(p.id, v, env);
    if (!r.ok) out[p.id] = r.problem;
  }
  return out;
}

/** Every problem of the draft in plain words (for the wizard's step badge and the review). */
export function draftProblems(d: RulesDraft, env: RulesEnv): string[] {
  const out: string[] = [];
  for (const [id, problem] of Object.entries(presetProblems(d, env))) out.push(`${PRESETS.find((p) => p.id === id)?.title ?? id}: ${problem}`);
  if (d.problems.length > 0) out.push(`Your rules' code has ${d.problems.length} problem${d.problems.length === 1 ? "" : "s"} (first: line ${d.problems[0]?.line ?? 1})`);
  const { build, blockProblems } = buildDraft(d, env);
  d.items.forEach((it, i) => {
    const p = blockProblems.get(it.id);
    if (p !== undefined) out.push(`Rule ${i + 1}: ${p}`);
  });
  if (build !== null && !build.ok && blockProblems.size === 0) out.push(`Launch rules: ${build.rule !== null ? `rule ${build.rule + 1}: ` : ""}${build.message}`);
  return out;
}

/** True when the draft has any rule or preset at all (live builds refuse to launch with one: review U8). */
export const hasRules = (d: RulesDraft): boolean => d.items.length > 0 || Object.keys(d.presets).length > 0 || d.text.trim() !== "";
