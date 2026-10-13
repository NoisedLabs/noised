import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

import { useNetwork } from "../../app/network";
import { CLUSTER } from "../../app/settings";
import { sfx } from "../../fx/sfx";
import { useOwner } from "../../app/wallet";
import { PlusIcon, TrashIcon } from "../../components/icons";
import { LaunchTracker, OpeningPicker, openingProblem, stepText, useLaunchFlows, type OpeningChoice } from "../../components/launchTracker";
import { Alert, Button, Field, type FieldIds } from "../../components/ui";
import { useNow } from "../../app/hooks";
import { formatSol, formatSolExact, formatUnits } from "../../lib/amounts";
import { describeSeconds, errorMessage, formatTimestamp, toHex } from "../../lib/format";
import { AUTOPILOT_NOT_LIVE, estimateLaunchFunding, FEES_TO_TOKEN_NOT_LIVE, RULES_NOT_LIVE, stagesOf, startLaunchFlow, type FlowStage, type FundingEstimate } from "../../lib/launchFlow";
import { explainGraphLines, type GraphBuild, type GuardFacts, type RulesBuild } from "../../lib/programmable";
import { DotSpinner } from "../../fx/noise";
import { launchIdentity, shortId, usePqKey } from "../../lib/pqKey";
import {
  checkFeeRecipients,
  estimateSupply,
  feeNumeratorToPercent,
  feeScheduleDuration,
  feeSummary,
  launchParamsHash,
  MIGRATION_FEE_TIERS_BPS,
  POLICY,
  PRESETS,
  PROGRAMMABLE_AVAILABLE,
  type FeeRecipientsCheck,
  type LaunchParamsInput,
  type PresetName,
} from "../../lib/noised";
import * as phx from "../../lib/noised";
import { CheckLine, Checks, Chip, Comment, Details, DotBar, Fold, Grad, NoteBox, PageHead, Panel, Readout, Reason, Row, Toggle } from "../inner/kit";
import { PageArt } from "../inner/art";
import { QuantumKeyPanel } from "../quantumkey/QuantumKeyPanel";
import { utcText } from "../../lib/signErrors";
import { convertDraft, DESCRIPTION_MAX, draftFromPreset, dynamicDraftFor, iconBudgetOf, metaProblems, splitError, stepOfField, type Conversion, type Draft, type StepId, type StoredIcon, type TokenMetaDraft } from "./draft";
import {
  AFTER_FEES,
  afterFeeText,
  BATCH_STOPS_SECS,
  batchCapSentence,
  batchPatch,
  evenShares,
  evenSplit,
  FEE_STOPS_BPS,
  feeBpsOf,
  feeIsSimple,
  feePatch,
  feePctOf,
  feeWithDynamicText,
  GOAL_STOPS_SOL,
  goalPatch,
  goalSol,
  GUARD_STOPS_SECS,
  guardPatch,
  limitsSentence,
  nearestIndex,
  pctText,
  plainDuration,
  PROTECTIONS,
  protectionCapText,
  protectionOf,
  protectionPatch,
  RISES,
  riseOf,
  risePatch,
  selectedRise,
  twoWaySplit,
  type Protection,
} from "./simple";
import { ChoiceCards, ChoiceChips, Say, StopSlider } from "./SimpleControls";
import { FIELD_DOCS } from "./fieldDocs";
import { iconSummary, LogoUpload } from "./LogoUpload";
import { IconCard } from "./PixelIconEditor";
import { blankIcon } from "./pixelIcon";
import { useStoredIcon } from "./useStoredIcon";
import { plainRecipientProblem } from "./recipientWords";
import { RulesGallery } from "./rules/RulesGallery";
import { RulesReview } from "./rules/RulesReview";
import { buildDraft, draftProblems, EMPTY_RULES, hasRules, refreshPresets, type RulesDraft, type RulesEnv } from "./rules/state";
import { autopilotBuild, autopilotDraft, graphRecipients, type AutopilotDraft } from "./autopilotDraft";
import { ModeChooser, type LaunchMode } from "./ModeChooser";
import { isTreasuryMark, launchTreasury, resolveTreasury, sendsFeesToTreasury, treasuryShareOf, withTreasuryShare } from "./quick";
import { LaunchGate } from "./LaunchesSoon";
import { QuickLaunch } from "./QuickLaunch";
import type { JobContext } from "../autopilot/simple";
import "./create.css";
import "./quick.css";

// The Autopilot step carries the graph editor: loaded the first time it is opened.
const AutopilotStep = lazy(() => import("./AutopilotStep").then((m) => ({ default: m.AutopilotStep })));

const freshSeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/**
 * The wizard's six steps (SIMPLE_V4 §4). Each groups one or more of the
 * draft's validation steps (draft.ts `StepId`): a step's badge counts the
 * problems of all its parts, and leaving it reveals them. "Your quantum key"
 * holds the key that signs the launch (never the wallet).
 */
type UiStep = "basics" | "curve" | "fees" | "rules" | "autopilot" | "key" | "review";
const STEPS: { id: UiStep; label: string; parts: readonly StepId[] }[] = [
  { id: "basics", label: "Basics", parts: ["preset", "token"] },
  { id: "curve", label: "Price curve", parts: ["curve"] },
  { id: "fees", label: "Fees", parts: ["fees", "recipients"] },
  { id: "rules", label: "Launch rules", parts: ["guard"] },
  { id: "autopilot", label: "Autopilot", parts: [] },
  { id: "key", label: "Your quantum key", parts: ["key"] },
  { id: "review", label: "Review", parts: ["review"] },
];

/** The wizard step that shows a validation step's fields. */
function uiStepOf(part: StepId): UiStep {
  return STEPS.find((s) => s.parts.includes(part))?.id ?? "review";
}

type SetDraft = (patch: Partial<Draft>) => void;
type SetMeta = (patch: Partial<TokenMetaDraft>) => void;

/** A validator field path in words: "symbol" -> "Symbol", "recipients[0].wallet" -> "Fee recipient 1 · wallet". */
function fieldLabel(field: string): string {
  const r = /^recipients\[(\d+)\]\.(wallet|bps)$/.exec(field);
  if (r) return `Fee recipient ${Number(r[1]) + 1} · ${r[2] === "wallet" ? "wallet" : "share"}`;
  const c = /^curve\[(\d+)\]\.(sqrtPrice|liquidity)$/.exec(field);
  if (c) return `Curve point ${Number(c[1]) + 1} · ${c[2] === "sqrtPrice" ? "sqrt price" : "liquidity"}`;
  return FIELD_DOCS[field]?.title ?? field;
}

/** "is required" reads as "required" under its own field. */
const bare = (message: string): string => message.replace(/^is /, "");

/** "Commit window: must be between …" (problem lists, where the field is not next to the message). */
function labelled(e: string): string {
  const { field, message } = splitError(e);
  return field === "" ? message : `${fieldLabel(field)}: ${message}`;
}

/** The messages for the validator fields an input stands for (shown under that input, so without the field name). */
function errorsFor(conv: Conversion, fields: readonly string[]): string | null {
  for (const f of fields) {
    const own = conv.inputErrors[f];
    if (own !== undefined) return bare(own);
  }
  const policy = conv.policyErrors.filter((e) => fields.includes(splitError(e).field));
  return policy.length === 0 ? null : policy.map((e) => bare(splitError(e).message)).join(" · ");
}

/**
 * When a field's error shows: after the field was edited or left, or after the user tried to leave its step
 * (Next). The step badges always count every problem. Presentation only: validation itself is unchanged.
 */
interface Reveal {
  shown: (fields: readonly string[]) => boolean;
  touch: (fields: readonly string[]) => void;
}
const RevealContext = createContext<Reveal>({ shown: () => true, touch: () => undefined });

/** Every problem once: a field's input error replaces the policy errors about the same field. */
function allErrors(conv: Conversion): string[] {
  return [
    ...Object.entries(conv.inputErrors).map(([f, m]) => `${f}: ${m}`),
    ...conv.policyErrors.filter((e) => conv.inputErrors[splitError(e).field] === undefined),
  ];
}

/**
 * The draft's conversion with the fee recipients' chain check folded in (audit round 3, F3): a refused recipient (a
 * quantum vault of another token, a token account, a program, an address nobody holds a key for) is a problem of its
 * wallet field, in plain words, exactly like `create_launch` would refuse it.
 */
export function withRecipientCheck(conv: Conversion, check: FeeRecipientsCheck | null): Conversion {
  if (check === null || check.refusals.length === 0) return conv;
  const plain = check.refusals.map((r) => {
    const { field, message } = splitError(r);
    return `${field}: ${plainRecipientProblem(message)}`;
  });
  return { ...conv, policyErrors: [...conv.policyErrors, ...plain] };
}

/** Problems of a wizard step (all of its validation steps). */
function stepErrorCount(conv: Conversion, parts: readonly StepId[]): number {
  return allErrors(conv).filter((e) => parts.includes(stepOfField(splitError(e).field))).length;
}

/**
 * Launch (owner's request, 2026-10-11): first the way to launch, "Quick launch" (default: one short screen) or
 * "Custom launch" (the full wizard), both signed by the creator's quantum key, with liquidity locked forever and selling
 * never blocked. `?mode=custom` opens the wizard directly.
 */
export function CreatePage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const mode: LaunchMode = params.get("mode") === "custom" ? "custom" : "quick";
  // The launch this page started (its tracker shows in place; other unfinished ones show at the top).
  const [started, setStarted] = useState<string | null>(null);
  // No form until launches are open on this network: before the launchpad's one-time setup, every launch would fail.
  const { launches, recheck } = useNetwork();
  return (
    <div className="pg cr">
      <PageHead
        art={<PageArt scene="create" />}
        eyebrow="Launch"
        title={
          <>
            Launch with <Grad>quantum security</Grad>
          </>
        }
        lede={
          <>
            {launches === "open" ? "Pick how you want to launch. " : null}
            <strong>Every launch</strong> is signed with your quantum key, its liquidity is locked forever, and selling is never blocked. No admin
            key: every launch role is held by a program, not a person.
          </>
        }
      />
      {launches === "open" ? (
        <>
          <ModeChooser
            mode={mode}
            onPick={(m) =>
              setParams(
                (p) => {
                  const next = new URLSearchParams(p);
                  if (m === "custom") next.set("mode", "custom");
                  else next.delete("mode");
                  return next;
                },
                { replace: true },
              )
            }
          />
          <InProgress except={started} />
          {mode === "quick" ? <QuickLaunch started={started} onStarted={setStarted} /> : <CustomLaunch started={started} onStarted={setStarted} />}
        </>
      ) : (
        <>
          <LaunchGate state={launches} onRetry={recheck} />
          <InProgress except={started} />
        </>
      )}
    </div>
  );
}

/** The full wizard: price curve, fees, launch rules (gallery, blocks, code), the optional Autopilot, the key, the review. */
function CustomLaunch({ started, onStarted }: { started: string | null; onStarted: (id: string) => void }): ReactNode {
  const owner = useOwner();
  const { connection } = useConnection();
  const [draft, setDraftState] = useState<Draft>(() => draftFromPreset("fair"));
  const [step, setStep] = useState<UiStep>("basics");
  // The launch's seed: its address, and so its Autopilot treasury (a possible fee recipient), are known before it exists.
  const [seed, setSeed] = useState<Uint8Array>(freshSeed);
  const meKey = owner.publicKey;
  const treasury = useMemo(() => (meKey === null ? null : launchTreasury(meKey, seed).treasury), [meKey, seed]);
  const resolved = useMemo(() => resolveTreasury(draft, treasury), [draft, treasury]);
  // The launch names the creator's quantum key identity (lib/pqKey.ts): only it can sign the launch so that it can go live.
  const key = usePqKey();
  const pqId = key.identity.idHex;
  useEffect(() => {
    if (key.status === "unlocked" && key.identity.status === "idle") void launchIdentity(CLUSTER).catch(() => undefined);
  }, [key.status, key.identity.status]);
  // The icon the record stores (made asynchronously; an uploaded logo is re-fitted when the words next to it change).
  const icon = useStoredIcon(draft);
  const pngNow = icon.now === undefined ? undefined : icon.now.png;
  // The fee recipients as distribute pays them, checked against the chain as they are typed (audit round 3, F3). The
  // token's own Autopilot treasury is not a wallet and is not checked: create_launch takes it for this launch only.
  const [recipientCheck, setRecipientCheck] = useState<FeeRecipientsCheck | null>(null);
  const walletsKey = draft.recipients.map((r) => (isTreasuryMark(r) ? "treasury" : r.wallet.trim())).join(",");
  useEffect(() => {
    let alive = true;
    setRecipientCheck(null);
    const wallets: { wallet: PublicKey; index: number }[] = [];
    for (const [index, r] of draft.recipients.entries()) {
      if (isTreasuryMark(r)) continue;
      try {
        wallets.push({ wallet: new PublicKey(r.wallet.trim()), index });
      } catch {
        return;
      }
    }
    if (wallets.length === 0) return;
    const t = setTimeout(() => {
      checkFeeRecipients(connection, wallets.map(({ wallet }) => ({ wallet }))).then(
        (c) => {
          // Back to the draft's own indices (the treasury rows were left out).
          const at = (s: string): string => s.replace(/^recipients\[(\d+)\]/, (_m, i: string) => `recipients[${wallets[Number(i)]?.index ?? Number(i)}]`);
          if (alive) setRecipientCheck({ ...c, refusals: c.refusals.map(at), warnings: c.warnings.map(at) });
        },
        () => undefined,
      );
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [connection, walletsKey]);
  const conv = useMemo(
    () => withRecipientCheck(convertDraft(resolved, pqId === null ? null : Uint8Array.from(pqId.match(/../g) ?? [], (h) => Number.parseInt(h, 16)), pngNow), recipientCheck),
    [resolved, pqId, pngNow, recipientCheck],
  );
  const set: SetDraft = (patch) => setDraftState((d) => ({ ...d, ...patch }));
  const setMeta: SetMeta = (patch) => setDraftState((d) => ({ ...d, meta: { ...d.meta, ...patch } }));

  // Extra launch rules (PROGRAMMABLE_V1 §6): bounded by this draft's early limits and batch window.
  const [rules, setRules] = useState<RulesDraft>(EMPTY_RULES);
  const envNow = rulesEnvOf(draft, conv.params);
  const rulesEnv = useMemo<RulesEnv>(
    () => ({ guardSecs: envNow.guardSecs, openDelaySecs: envNow.openDelaySecs, graceSecs: envNow.graceSecs, decimals: envNow.decimals }),
    [envNow.guardSecs, envNow.openDelaySecs, envNow.graceSecs, envNow.decimals],
  );
  const guardFacts = useMemo(() => guardFactsOf(conv.params, rulesEnv), [conv.params, rulesEnv]);
  const rulesProblems = useMemo(() => [...draftProblems(rules, rulesEnv), ...(hasRules(rules) && !PROGRAMMABLE_AVAILABLE ? [RULES_NOT_LIVE] : [])], [rules, rulesEnv]);
  // New early limits, batch window or decimals: the presets' rules again, and the code's text.
  useEffect(() => {
    setRules((r) => (r.items.length === 0 && Object.keys(r.presets).length === 0 ? r : r.problems.length > 0 ? r : refreshPresets(r, rulesEnv)));
  }, [rulesEnv]);

  // Default the first fee recipient to the connected account.
  const me = owner.publicKey?.toBase58() ?? null;
  useEffect(() => {
    if (me === null) return;
    setDraftState((d) => (d.recipients.length === 1 && d.recipients[0]?.wallet === "" ? { ...d, recipients: [{ wallet: me, pct: "100" }] } : d));
  }, [me]);

  // The optional Autopilot (owner's request, 2026-10-11): switched on by the quantum key right after the launch opens.
  const [autopilot, setAutopilot] = useState<AutopilotDraft>(() => autopilotDraft(6));
  const jobCtx = useMemo<JobContext>(() => {
    const wallets = conv.params?.recipients ?? [];
    const own = draft.recipients
      .map((r, i) => ({ mark: isTreasuryMark(r), w: wallets[i] }))
      .filter((x) => !x.mark && x.w !== undefined && !x.w.wallet.equals(PublicKey.default) && x.w.bps > 0)
      .map((x) => ({ address: (x.w as { wallet: PublicKey }).wallet.toBase58(), bps: (x.w as { bps: number }).bps }));
    return {
      symbol: draft.symbol.trim() || "TOKEN",
      decimals: conv.params?.tokenDecimal ?? 6,
      poolFeeBps: MIGRATION_FEE_TIERS_BPS[Number(draft.migrationFeeOption)] ?? 100,
      recipients: graphRecipients(own),
    };
  }, [conv.params, draft.recipients, draft.symbol, draft.migrationFeeOption]);
  const apBuild = useMemo(() => autopilotBuild(autopilot, jobCtx), [autopilot, jobCtx]);
  const treasuryPct = treasuryShareOf(draft.recipients);
  // Refused where they are not live yet (before anything is signed), and an Autopilot that does not build.
  const autopilotProblems = [
    ...(autopilot.on && !PROGRAMMABLE_AVAILABLE ? [AUTOPILOT_NOT_LIVE] : []),
    ...(sendsFeesToTreasury(draft) && !PROGRAMMABLE_AVAILABLE ? [FEES_TO_TOKEN_NOT_LIVE] : []),
    ...(apBuild !== null && !apBuild.ok ? [`Autopilot: ${apBuild.issues[0]?.message ?? "fix its steps"}`] : []),
  ];

  const index = STEPS.findIndex((s) => s.id === step);
  const currentParts: readonly StepId[] = STEPS[index]?.parts ?? [];
  const errorList = allErrors(conv);
  const totalErrors = errorList.length + rulesProblems.length + autopilotProblems.length;
  // Empty required fields are "still to fill in", not policy failures: say so until there is input.
  const emptyFields = new Set<string>([
    ...(draft.name.trim() === "" ? ["name"] : []),
    ...(draft.symbol.trim() === "" ? ["symbol"] : []),
    ...draft.recipients.flatMap((r, i) => (r.wallet.trim() === "" ? [`recipients[${i}].wallet`] : [])),
  ]);
  const missing = errorList.filter((e) => emptyFields.has(splitError(e).field)).length;
  const policyProblems = totalErrors - missing;
  const status =
    policyProblems > 0
      ? { k: "Safety rules", v: `${policyProblems} to fix`, tone: "warn" as const }
      : missing > 0
        ? { k: "Still to fill in", v: `${missing} field${missing === 1 ? "" : "s"}`, tone: "warn" as const }
        : { k: "Safety rules", v: "All pass", tone: "ok" as const };

  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [attempted, setAttempted] = useState<ReadonlySet<StepId>>(() => new Set());
  const reveal = useMemo<Reveal>(
    () => ({
      shown: (fields) => fields.some((f) => touched.has(f) || attempted.has(stepOfField(f))),
      touch: (fields) =>
        setTouched((prev) => {
          if (fields.every((f) => prev.has(f))) return prev;
          const next = new Set(prev);
          for (const f of fields) next.add(f);
          return next;
        }),
    }),
    [touched, attempted],
  );

  // Every real step change brings the top of the wizard into view. A ref of the previous step (not a
  // "first run" flag) so StrictMode's double effect run in dev does not scroll the page on load.
  const wizardRef = useRef<HTMLDivElement>(null);
  const prevStep = useRef(step);
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    const el = wizardRef.current;
    if (!el) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [step]);

  const go = (to: UiStep): void => {
    if (to !== step) sfx.play("click");
    setStep(to);
  };
  const next = STEPS[index + 1];

  return (
    <div className="cr-custom">
      <RevealContext.Provider value={reveal}>
        <div className="cr-wizard" ref={wizardRef}>
          <nav aria-label="Wizard steps" className="cr-rail glass">
            <div className="cr-rail-top">
              <span className="pg-label">
                Step {index + 1} of {STEPS.length}
              </span>
              <DotBar value={index + 1} max={STEPS.length} size="sm" />
            </div>
            <ol className="cr-steps">
              {STEPS.map((s, i) => {
                const count = s.id === "review" ? totalErrors : stepErrorCount(conv, s.parts) + (s.id === "rules" ? rulesProblems.length : 0) + (s.id === "autopilot" ? autopilotProblems.length : 0);
                const state = s.id === step ? "current" : count > 0 && s.id !== "review" ? "error" : i < index ? "done" : "todo";
                return (
                  <li key={s.id} data-current={s.id === step ? "" : undefined}>
                    <button type="button" className="cr-step" data-state={state} aria-current={s.id === step ? "step" : undefined} onClick={() => go(s.id)}>
                      <span className="cr-step-node" aria-hidden="true">
                        {state === "done" ? "✓" : i + 1}
                      </span>
                      <span className="cr-step-label">{s.label}</span>
                      {count > 0 && s.id !== "review" ? (
                        <span className="cr-step-count" aria-label={`${count} problem${count === 1 ? "" : "s"}`}>
                          {count}
                        </span>
                      ) : null}
                      {state === "done" ? <span className="sr-only">: done</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            <dl className="cr-facts">
              <div>
                <dt>Preset</dt>
                <dd>{PRESETS[draft.preset].title}</dd>
              </div>
              <div data-tone={status.tone}>
                <dt>{status.k}</dt>
                <dd>{status.v}</dd>
              </div>
              <div>
                <dt>Autopilot</dt>
                <dd>{autopilot.on ? "On when it opens" : "Off"}</dd>
              </div>
              <div>
                <dt>You sign</dt>
                <dd>2 with your wallet, {autopilot.on ? 2 : 1} with your quantum key</dd>
              </div>
            </dl>
          </nav>

          <div className="cr-main">
            {step === "basics" ? (
              <>
                <PresetStep draft={draft} onPick={(p) => setDraftState((d) => draftFromPreset(p, { name: d.name, symbol: d.symbol, meta: d.meta, recipients: d.recipients }))} />
                <TokenStep draft={draft} set={set} conv={conv} />
                <MetaStep draft={draft} setMeta={setMeta} conv={conv} stored={icon.shown} />
              </>
            ) : null}
            {step === "curve" ? <CurveStep draft={draft} set={set} conv={conv} /> : null}
            {step === "fees" ? (
              <>
                <FeesStep draft={draft} set={set} conv={conv} />
                <RecipientsStep draft={draft} set={set} conv={conv} check={recipientCheck} me={me} />
              </>
            ) : null}
            {step === "rules" ? (
              <>
                <GuardStep draft={draft} set={set} conv={conv} />
                <RulesGallery draft={rules} onChange={setRules} env={rulesEnv} guard={guardFacts} available={PROGRAMMABLE_AVAILABLE} />
              </>
            ) : null}
            {step === "autopilot" ? (
              <Suspense
                fallback={
                  <p className="pg-wait" role="status">
                    <DotSpinner size={18} decorative /> Loading the Autopilot builder…
                  </p>
                }
              >
                <AutopilotStep
                  value={autopilot}
                  onChange={setAutopilot}
                  ctx={jobCtx}
                  build={apBuild}
                  treasuryPct={treasuryPct}
                  onTreasuryPct={(pct) => set({ recipients: withTreasuryShare(draft.recipients, pct, me ?? "") })}
                  operatorDefault={me}
                />
              </Suspense>
            ) : null}
            {step === "key" ? <KeyStep /> : null}
            {step === "review" ? (
              <ReviewStep
                draft={draft}
                stored={icon.shown}
                conv={conv}
                goTo={(part) => go(uiStepOf(part))}
                started={started}
                onStarted={(id) => {
                  onStarted(id);
                  setSeed(freshSeed());
                }}
                rules={rules}
                rulesEnv={rulesEnv}
                rulesProblems={rulesProblems}
                onEditRules={() => go("rules")}
                seed={seed}
                autopilot={apBuild}
                autopilotProblems={autopilotProblems}
                treasuryPct={treasuryPct}
                onEditAutopilot={() => go("autopilot")}
              />
            ) : null}

            <div className="cr-nav">
              <Button variant="ghost" disabled={index === 0} onClick={() => go(STEPS[index - 1]?.id ?? "basics")}>
                <span aria-hidden="true">←</span> Back
              </Button>
              <span className="cr-nav-pos" aria-hidden="true">
                {index + 1} / {STEPS.length}
              </span>
              {next !== undefined ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    // Leaving a step reveals its remaining problems (the badge already counts them).
                    setAttempted((prev) => (currentParts.every((p) => prev.has(p)) ? prev : new Set([...prev, ...currentParts])));
                    go(next.id);
                  }}
                >
                  Next: {next.label}{" "}
                  <span className="btn-arrow" data-dir="right" aria-hidden="true">
                    →
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </RevealContext.Provider>
    </div>
  );
}

// ------------------------------------------------------------- field box ---

/** A form field documented from FIELD_DOCS, showing the policy errors of `fields`. */
function ParamField({
  doc,
  fields,
  conv,
  label,
  children,
  className = "",
  extraHelp,
}: {
  doc: string;
  fields: readonly string[];
  conv: Conversion;
  label?: ReactNode;
  children: (ids: FieldIds & { invalid: boolean }) => ReactNode;
  className?: string;
  extraHelp?: ReactNode;
}): ReactNode {
  const d = FIELD_DOCS[doc];
  const reveal = useContext(RevealContext);
  return (
    // display: contents keeps the Field itself the grid item; the wrapper only listens (edit / leave = touched).
    <div className="contents" onChangeCapture={() => reveal.touch(fields)} onBlurCapture={() => reveal.touch(fields)}>
      <Field
        className={`cr-field ${className}`}
        label={label ?? d?.title ?? doc}
        error={reveal.shown(fields) ? errorsFor(conv, fields) : null}
        help={
          // One quiet line: the live count ("12/32 bytes"), then "What is this?", which opens the explanation and the allowed values.
          <span className="cr-help">
            {extraHelp !== undefined ? <span className="cr-help-live">{extraHelp}</span> : null}
            {d ? (
              <details className="cr-why">
                <summary>What is this?</summary>
                <span className="cr-why-text">
                  {d.what} <span className="cr-why-bounds">Allowed: {d.bounds}</span>
                </span>
              </details>
            ) : null}
          </span>
        }
      >
        {children}
      </Field>
    </div>
  );
}

const inputProps = (ids: FieldIds & { invalid: boolean }): { id: string; "aria-invalid": boolean; "aria-describedby"?: string } =>
  ids.describedBy === "" ? { id: ids.input, "aria-invalid": ids.invalid } : { id: ids.input, "aria-invalid": ids.invalid, "aria-describedby": ids.describedBy };

// ------------------------------------------------------------------ steps ---

function PresetStep({ draft, onPick }: { draft: Draft; onPick: (p: PresetName) => void }): ReactNode {
  return (
    <Panel title="Start from a safe preset" description="Every preset passes the safety rules. You can change any value in the next steps.">
      <div className="cr-presets" role="radiogroup" aria-label="Preset">
        {(Object.keys(PRESETS) as PresetName[]).map((name) => {
          const p = PRESETS[name];
          const selected = draft.preset === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                if (!selected) sfx.play("toggle");
                onPick(name);
              }}
              className="cr-preset"
              data-selected={selected ? "true" : undefined}
            >
              <span className="cr-preset-top">
                <span className="cr-preset-title">{p.title}</span>
                <span className="cr-preset-radio" aria-hidden="true" />
              </span>
              <span className="cr-preset-summary">{p.summary}</span>
              <span className="cr-preset-spec">
                <span>
                  <span>Graduates at</span>
                  <b>{formatSolExact(p.params.migrationQuoteThreshold)}</b>
                </span>
                <span>
                  <span>Batch window</span>
                  <b>{describeSeconds(p.params.openDelaySecs)}</b>
                </span>
                <span>
                  <span>Guard</span>
                  <b>{describeSeconds(p.params.guardSecs)}</b>
                </span>
                <span>
                  <span>Max wallet</span>
                  <b>{p.params.maxWalletBps / 100}%</b>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function TokenStep({ draft, set, conv }: { draft: Draft; set: SetDraft; conv: Conversion }): ReactNode {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  return (
    <Panel title="Name your token" description="Written when the token launches. It can never be changed.">
      <div className="pg-grid-2">
        <ParamField doc="name" fields={["name"]} conv={conv} extraHelp={`${bytes(draft.name)}/${POLICY.MAX_NAME_LEN} bytes`}>
          {(ids) => <input className="input" {...inputProps(ids)} value={draft.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />}
        </ParamField>
        <ParamField doc="symbol" fields={["symbol"]} conv={conv} extraHelp={`${bytes(draft.symbol)}/${POLICY.MAX_SYMBOL_LEN} bytes`}>
          {(ids) => <input className="input" {...inputProps(ids)} value={draft.symbol} onChange={(e) => set({ symbol: e.target.value })} autoComplete="off" />}
        </ParamField>
      </div>
      <Details summary="Advanced" className="cr-advanced-fold">
        <div className="pg-grid-2 cr-advanced-body">
          <ParamField doc="tokenDecimal" fields={["tokenDecimal"]} conv={conv}>
            {(ids) => (
              <select className="select" {...inputProps(ids)} value={draft.tokenDecimal} onChange={(e) => set({ tokenDecimal: e.target.value })}>
                {[6, 7, 8, 9].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}
          </ParamField>
        </div>
      </Details>
    </Panel>
  );
}

/**
 * Icon, description and links: stored on Solana in the token's metadata record (its document), with the name and
 * symbol, and signed by the creator's quantum key. No metadata link: the mint's link stays empty.
 */
function MetaStep({ draft, setMeta, conv, stored }: { draft: Draft; setMeta: SetMeta; conv: Conversion; stored: StoredIcon | undefined }): ReactNode {
  const { connection } = useConnection();
  const m = draft.meta;
  const problems = metaProblems(m);
  const bytes = new TextEncoder().encode(m.description).length;
  const docProblem = errorsFor(conv, ["icon"]);
  // The record's rent, read from the cluster (the temporary fee account pays it once, in step 3).
  const [rent, setRent] = useState<bigint | null>(null);
  useEffect(() => {
    let alive = true;
    if (conv.recordBytes === 0) return;
    const t = setTimeout(() => {
      phx.rentExemptLamports(connection, conv.recordBytes).then(
        (r) => {
          if (alive) setRent(r);
        },
        () => undefined,
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [connection, conv.recordBytes]);
  return (
    <Panel
      title="Make it yours"
      description="Add a logo and say what your token is about. They are stored on Solana with your token's name and symbol: no links to other sites, no IPFS."
      status={
        <span className="cr-meta-chips">
          <Chip tone="muted">Optional</Chip>
          <Chip tone="muted" title="Kept in your token's record on Solana. Nobody can change them after launch.">
            Stored on Solana
          </Chip>
        </span>
      }
      className="cr-meta"
    >
      <LogoUpload
        meta={m}
        stored={stored}
        budget={iconBudgetOf(draft)}
        onIcon={(icon) => setMeta({ icon, logo: null })}
        onLogo={(logo) => setMeta({ logo, icon: blankIcon(m.icon.palette) })}
        name={draft.name}
        symbol={draft.symbol}
      />
      {docProblem !== null ? <Alert tone="fail">{docProblem.charAt(0).toUpperCase() + docProblem.slice(1)}</Alert> : null}
      <div className="pg-grid-2 cr-meta-fields">
        <Field
          className="cr-field pg-span-2"
          label="Description"
          optional
          error={problems.description}
          help={<span className="cr-help-live">{`${bytes}/${DESCRIPTION_MAX} bytes`}</span>}
        >
          {(ids) => (
            <textarea
              className="textarea cr-desc"
              {...inputProps(ids)}
              rows={3}
              value={m.description}
              onChange={(e) => setMeta({ description: e.target.value })}
              placeholder="One or two sentences about your token."
            />
          )}
        </Field>
        <Field className="cr-field" label="Website" optional error={problems.website}>
          {(ids) => (
            <input
              className="input"
              {...inputProps(ids)}
              type="url"
              inputMode="url"
              value={m.website}
              onChange={(e) => setMeta({ website: e.target.value })}
              placeholder="https://"
              autoComplete="url"
              spellCheck={false}
            />
          )}
        </Field>
        <Field className="cr-field" label="X account" optional error={problems.x}>
          {(ids) => (
            <span className="cr-at">
              <span className="cr-at-sign" aria-hidden="true">
                @
              </span>
              <input
                className="input"
                {...inputProps(ids)}
                value={m.x.replace(/^@/, "")}
                onChange={(e) => setMeta({ x: e.target.value.replace(/^@/, "") })}
                placeholder="handle"
                autoComplete="off"
                spellCheck={false}
              />
            </span>
          )}
        </Field>
      </div>
      <p className="cr-meta-size" aria-live="polite">
        {!conv.metadataReady
          ? "Preparing your icon…"
          : conv.recordBytes === 0
            ? "Add a name and symbol to see how much space your token's details take on Solana."
            : `Your token's details take ${conv.recordBytes.toLocaleString("en-US")} bytes on Solana${rent === null ? "" : `, about ${formatSol(rent, 4)} of rent`}. Paid once, when they are stored; they stay with your token for good.`}
      </p>
    </Panel>
  );
}

/** Opens an "Advanced" fold by itself once one of its fields shows a problem (and leaves it to the user after that). */
function useAdvancedOpen(conv: Conversion, fields: readonly string[]): true | undefined {
  const reveal = useContext(RevealContext);
  const problem = reveal.shown(fields) && errorsFor(conv, fields) !== null;
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (problem) setOpened(true);
  }, [problem]);
  return opened || problem ? true : undefined;
}

/** "793 million": a whole-token count in plain words. */
function plainCount(raw: bigint, decimals: number): string {
  const n = Number(raw / 10n ** BigInt(decimals));
  if (n >= 1e9) return `${Number((n / 1e9).toPrecision(3))} billion`;
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))} million`;
  return n.toLocaleString("en-US");
}

const CURVE_FIELDS = ["sqrtStartPrice", "curve", "curve[0].sqrtPrice", "curve[0].liquidity", "curve[1].sqrtPrice", "curve[1].liquidity", "migrationQuoteThreshold", "migrationFeeOption"] as const;

function CurveStep({ draft, set, conv }: { draft: Draft; set: SetDraft; conv: Conversion }): ReactNode {
  const p = conv.params;
  const estimate = p && p.curve.length > 0 ? estimateSupply(p.sqrtStartPrice, p.curve, p.migrationQuoteThreshold) : null;
  const goal = goalSol(draft);
  const gi = nearestIndex(GOAL_STOPS_SOL, goal ?? 85);
  const rise = riseOf(draft);
  const name = draft.name.trim() || "your token";
  const advOpen = useAdvancedOpen(conv, CURVE_FIELDS);
  const goalSay =
    goal === null
      ? "Set the goal under Advanced."
      : `When buyers have put in ${goal.toLocaleString("en-US")} SOL, ${name} graduates: its liquidity moves to a bigger pool and is locked forever.${
          estimate && p ? ` About ${plainCount(estimate.curveBase, p.tokenDecimal)} tokens are sold before then.` : ""
        }`;
  return (
    <Panel title="Price curve" description="The price rises as people buy, until the raise reaches its goal. Then the token graduates and its liquidity is locked forever.">
      <div className="sm-stack">
        <StopSlider
          label="Goal"
          stops={GOAL_STOPS_SOL.length}
          index={gi}
          exact={goal !== null && GOAL_STOPS_SOL[gi] === goal}
          valueText={goal === null ? "—" : `${goal.toLocaleString("en-US")} SOL`}
          stopText={(i) => `${(GOAL_STOPS_SOL[i] ?? 0).toLocaleString("en-US")} SOL`}
          onIndex={(i) => set(goalPatch(draft, GOAL_STOPS_SOL[i] ?? 85))}
          ends={[`${GOAL_STOPS_SOL[0] ?? 0} SOL`, `${(GOAL_STOPS_SOL[GOAL_STOPS_SOL.length - 1] ?? 0).toLocaleString("en-US")} SOL`]}
          say={goalSay}
        />
        <div className="sm-group">
          <p className="sl-label">How fast the price rises</p>
          <ChoiceCards
            size="sm"
            label="How fast the price rises"
            choices={RISES.map((r) => ({ id: r.id, title: `${r.title} · ${r.times}×`, summary: `The last buyer before graduation pays ${r.times} times the first price.` }))}
            value={selectedRise(draft)}
            onPick={(id) => set(risePatch(draft, RISES.find((r) => r.id === id)?.times ?? 10))}
          />
          <Say text={rise === null ? "Set the prices under Advanced." : `Now the price climbs about ${Number(rise.toPrecision(3))} times from the first buy to graduation.`} />
        </div>
        <div className="sm-group">
          <ChoiceChips label="Fee after graduation" choices={AFTER_FEES.map((f) => ({ id: String(f.option), text: `${f.bps / 100}%` }))} value={draft.migrationFeeOption} onPick={(id) => set({ migrationFeeOption: id })} />
          <Say text={`After it graduates, every trade in the bigger pool pays ${afterFeeText(Number(draft.migrationFeeOption))}. It goes to the pool, not to anyone's wallet.`} />
        </div>
      </div>

      {estimate && p ? (
        <Readout className="pg-well" label="Supply estimate">
          <Row k="Sold on the curve">
            <span className="tabular-nums">≈ {formatUnits(estimate.curveBase, p.tokenDecimal, 0)} tokens until graduation</span>
          </Row>
          <Row k="Paired at graduation">
            <span className="tabular-nums">≈ {formatUnits(estimate.migrationBase, p.tokenDecimal, 0)} tokens with the whole raise, all locked</span>
          </Row>
          <Row k="Unsold supply">Burned at graduation: nobody keeps a reserve.</Row>
        </Readout>
      ) : null}

      <Details summary="Advanced: exact prices and amounts" className="cr-advanced-fold" open={advOpen}>
        <div className="pg-grid-2 cr-advanced-body">
          <ParamField doc="sqrtStartPrice" fields={["sqrtStartPrice", "curve"]} conv={conv} label="Start price (SOL per token)">
            {(ids) => <input className="input mono" {...inputProps(ids)} value={draft.startPrice} onChange={(e) => set({ startPrice: e.target.value })} disabled={draft.rawCurve} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="curve" fields={["curve", "curve[0].sqrtPrice", "curve[0].liquidity", "curve[1].sqrtPrice", "curve[1].liquidity"]} conv={conv} label="Graduation price (SOL per token)">
            {(ids) => (
              <input className="input mono" {...inputProps(ids)} value={draft.graduationPrice} onChange={(e) => set({ graduationPrice: e.target.value })} disabled={draft.rawCurve} inputMode="decimal" />
            )}
          </ParamField>
          <ParamField doc="migrationQuoteThreshold" fields={["migrationQuoteThreshold"]} conv={conv} label="Graduates at (SOL raised)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.thresholdSol} onChange={(e) => set({ thresholdSol: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="migrationFeeOption" fields={["migrationFeeOption"]} conv={conv} label="Fee after graduation">
            {(ids) => (
              <select className="select" {...inputProps(ids)} value={draft.migrationFeeOption} onChange={(e) => set({ migrationFeeOption: e.target.value })}>
                {MIGRATION_FEE_TIERS_BPS.map((bps, i) => (
                  <option key={bps} value={i}>
                    {bps / 100}% (option {i})
                  </option>
                ))}
              </select>
            )}
          </ParamField>
        </div>
        <div className="cr-advanced">
          <Toggle
            checked={draft.rawCurve}
            onChange={(raw) => {
              if (raw && p) {
                set({ rawCurve: true, sqrtStartPrice: p.sqrtStartPrice.toString(), curve: p.curve.map((c) => ({ sqrtPrice: c.sqrtPrice.toString(), liquidity: c.liquidity.toString() })) });
              } else set({ rawCurve: raw });
            }}
          >
            Edit the raw curve (advanced)
          </Toggle>
          {draft.rawCurve ? (
            <div className="cr-advanced-body">
              <ParamField doc="sqrtStartPrice" fields={["sqrtStartPrice"]} conv={conv} label="sqrtStartPrice (Q64.64, u128)">
                {(ids) => <input className="input mono" {...inputProps(ids)} value={draft.sqrtStartPrice} onChange={(e) => set({ sqrtStartPrice: e.target.value })} />}
              </ParamField>
              {draft.curve.map((c, i) => (
                <fieldset key={i} className="cr-fieldset cr-curve-point">
                  <legend>Point {i + 1}</legend>
                  <ParamField doc="curve" fields={[`curve[${i}].sqrtPrice`]} conv={conv} label="sqrtPrice">
                    {(ids) => (
                      <input
                        className="input mono"
                        {...inputProps(ids)}
                        value={c.sqrtPrice}
                        onChange={(e) => set({ curve: draft.curve.map((x, j) => (j === i ? { ...x, sqrtPrice: e.target.value } : x)) })}
                      />
                    )}
                  </ParamField>
                  <ParamField doc="curve" fields={[`curve[${i}].liquidity`]} conv={conv} label="liquidity">
                    {(ids) => (
                      <input
                        className="input mono"
                        {...inputProps(ids)}
                        value={c.liquidity}
                        onChange={(e) => set({ curve: draft.curve.map((x, j) => (j === i ? { ...x, liquidity: e.target.value } : x)) })}
                      />
                    )}
                  </ParamField>
                  <div className="cr-fieldset-act">
                    <Button size="sm" variant="ghost" aria-label={`Remove curve point ${i + 1}`} disabled={draft.curve.length <= 1} onClick={() => set({ curve: draft.curve.filter((_, j) => j !== i) })}>
                      <TrashIcon />
                    </Button>
                  </div>
                </fieldset>
              ))}
              {errorsFor(conv, ["curve"]) ? <p className="field-error">{errorsFor(conv, ["curve"])}</p> : null}
              <Button size="sm" className="pg-self-start" disabled={draft.curve.length >= POLICY.MAX_CURVE_POINTS} onClick={() => set({ curve: [...draft.curve, { sqrtPrice: "", liquidity: "" }] })}>
                <PlusIcon /> Add point
              </Button>
            </div>
          ) : null}
        </div>
      </Details>
    </Panel>
  );
}

const FEE_FIELDS = [
  "baseFee",
  "baseFee.cliffFeeNumerator",
  "baseFee.baseFeeMode",
  "baseFee.firstFactor",
  "baseFee.secondFactor",
  "baseFee.thirdFactor",
  "dynamicFee",
  "dynamicFee.binStep",
  "dynamicFee.filterPeriod",
  "dynamicFee.decayPeriod",
  "dynamicFee.reductionFactor",
  "dynamicFee.maxVolatilityAccumulator",
  "dynamicFee.variableFeeControl",
] as const;

function FeesStep({ draft, set, conv }: { draft: Draft; set: SetDraft; conv: Conversion }): ReactNode {
  const p = conv.params;
  const summary = p ? feeSummary(p) : null;
  const schedule = p ? feeScheduleDuration(p.baseFee) : 0n;
  const bps = feeBpsOf(draft);
  const fi = nearestIndex(FEE_STOPS_BPS, bps ?? 100);
  const simple = feeIsSimple(draft);
  const advOpen = useAdvancedOpen(conv, FEE_FIELDS);
  const say =
    simple && bps !== null
      ? `Every trade pays ${feePctOf(draft)}% until the token graduates, up to ${feeWithDynamicText(bps)} when the price moves fast. The fees go to the wallets below, after the platform's share.`
      : "Your exact fee settings are under Advanced.";
  return (
    <Panel title="Trading fees" description="Paid on every trade until the token graduates. After that, the fee you chose for the graduated pool applies.">
      <StopSlider
        label="Trading fee"
        stops={FEE_STOPS_BPS.length}
        index={fi}
        exact={simple}
        valueText={`${feePctOf(draft)}%`}
        stopText={(i) => `${(FEE_STOPS_BPS[i] ?? 0) / 100}%`}
        onIndex={(i) => set(feePatch(FEE_STOPS_BPS[i] ?? 100))}
        ends={[`${(FEE_STOPS_BPS[0] ?? 0) / 100}%`, `${(FEE_STOPS_BPS[FEE_STOPS_BPS.length - 1] ?? 0) / 100}%`]}
        say={say}
      />
      {errorsFor(conv, ["baseFee"]) ? <Alert tone="fail">{errorsFor(conv, ["baseFee"])}</Alert> : null}
      <Details summary="Advanced: fee schedule and dynamic fee" className="cr-advanced-fold" open={advOpen}>
        <div className="pg-grid-2 cr-advanced-body">
          <ParamField doc="baseFee.cliffFeeNumerator" fields={["baseFee.cliffFeeNumerator"]} conv={conv} label="Starting fee (%)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.cliffFeePct} onChange={(e) => set({ cliffFeePct: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="baseFee.baseFeeMode" fields={["baseFee.baseFeeMode"]} conv={conv}>
            {(ids) => (
              <select className="select" {...inputProps(ids)} value={draft.feeMode} onChange={(e) => set({ feeMode: e.target.value })}>
                <option value="0">Linear (0)</option>
                <option value="1">Exponential (1)</option>
              </select>
            )}
          </ParamField>
          <ParamField doc="baseFee.firstFactor" fields={["baseFee.firstFactor"]} conv={conv}>
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.feePeriods} onChange={(e) => set({ feePeriods: e.target.value })} inputMode="numeric" />}
          </ParamField>
          <ParamField doc="baseFee.secondFactor" fields={["baseFee.secondFactor"]} conv={conv} label="Period length (seconds)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.feePeriodSecs} onChange={(e) => set({ feePeriodSecs: e.target.value })} inputMode="numeric" />}
          </ParamField>
          <ParamField doc="baseFee.thirdFactor" fields={["baseFee.thirdFactor"]} conv={conv} className="pg-span-2">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.feeReduction} onChange={(e) => set({ feeReduction: e.target.value })} inputMode="numeric" />}
          </ParamField>
        </div>
        {summary ? (
          <Readout className="pg-well" label="Fee summary">
            <Row k="Fee after the schedule">
              <span className="tabular-nums">{feeNumeratorToPercent(summary.floorFeeNumerator)}% (what the batch and every later trade pay)</span>
            </Row>
            <Row k="Schedule length">{schedule === 0n ? "no schedule (flat fee)" : `${describeSeconds(Number(schedule))}, ends before the batch executes`}</Row>
            <Row k="Largest dynamic fee">
              <span className="tabular-nums">{feeNumeratorToPercent(summary.maxDynamicFeeNumerator)}%</span>
            </Row>
            <Row k="Worst case after the schedule">
              <span className="tabular-nums">
                {feeNumeratorToPercent(summary.floorFeeNumerator + summary.maxDynamicFeeNumerator)}% (ceiling {POLICY.MAX_TRADING_FEE_BPS / 100}%)
              </span>
            </Row>
          </Readout>
        ) : null}

        <div className="cr-advanced">
          <Toggle checked={draft.dynamicFee} onChange={(v) => set({ dynamicFee: v })} strong>
            Dynamic (volatility) fee
          </Toggle>
          <Comment>
            {FIELD_DOCS.dynamicFee?.what} Allowed: {FIELD_DOCS.dynamicFee?.bounds}
          </Comment>
          {errorsFor(conv, ["dynamicFee", "dynamicFee.binStep"]) ? <p className="field-error">{errorsFor(conv, ["dynamicFee", "dynamicFee.binStep"])}</p> : null}
          {draft.dynamicFee ? (
            <div className="pg-grid-2 cr-advanced-body">
              <ParamField doc="dynamicFee.filterPeriod" fields={["dynamicFee.filterPeriod"]} conv={conv} label="Filter period (s)">
                {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.dynFilterPeriod} onChange={(e) => set({ dynFilterPeriod: e.target.value })} inputMode="numeric" />}
              </ParamField>
              <ParamField doc="dynamicFee.decayPeriod" fields={["dynamicFee.decayPeriod"]} conv={conv} label="Decay period (s)">
                {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.dynDecayPeriod} onChange={(e) => set({ dynDecayPeriod: e.target.value })} inputMode="numeric" />}
              </ParamField>
              <ParamField doc="dynamicFee.reductionFactor" fields={["dynamicFee.reductionFactor"]} conv={conv} label="Reduction factor (bps)">
                {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.dynReductionFactor} onChange={(e) => set({ dynReductionFactor: e.target.value })} inputMode="numeric" />}
              </ParamField>
              <ParamField doc="dynamicFee.maxVolatilityAccumulator" fields={["dynamicFee.maxVolatilityAccumulator"]} conv={conv}>
                {(ids) => (
                  <input className="input tabular-nums" {...inputProps(ids)} value={draft.dynMaxVolatilityAccumulator} onChange={(e) => set({ dynMaxVolatilityAccumulator: e.target.value })} inputMode="numeric" />
                )}
              </ParamField>
              <ParamField doc="dynamicFee.variableFeeControl" fields={["dynamicFee.variableFeeControl"]} conv={conv} className="pg-span-2">
                {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.dynVariableFeeControl} onChange={(e) => set({ dynVariableFeeControl: e.target.value })} inputMode="numeric" />}
              </ParamField>
              <div className="pg-span-2">
                <Button
                  size="sm"
                  onClick={() => {
                    const patch = dynamicDraftFor(draft.cliffFeePct);
                    if (patch) set(patch);
                  }}
                >
                  Set the maximum dynamic fee to 20% of the starting fee
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Details>
    </Panel>
  );
}

const GUARD_FIELDS = ["openDelaySecs", "guardSecs", "maxWalletBps", "maxBuyBps", "batchWalletCap", "batchTotalCap"] as const;

function GuardStep({ draft, set, conv }: { draft: Draft; set: SetDraft; conv: Conversion }): ReactNode {
  const p = conv.params;
  const open = Number(draft.openDelaySecs);
  const guard = Number(draft.guardSecs);
  const bi = nearestIndex(BATCH_STOPS_SECS, Number.isFinite(open) ? open : 300);
  const gi = nearestIndex(GUARD_STOPS_SECS, Number.isFinite(guard) ? guard : 21600);
  const protection = protectionOf(draft);
  const advOpen = useAdvancedOpen(conv, GUARD_FIELDS);
  const capOf = (pr: Protection): string => {
    const t = protectionCapText(draft, pr);
    return t === "0" ? "No limit" : `${t} SOL`;
  };
  return (
    <Panel title="Fair start and early limits" description="Everyone starts together in one opening batch, then early limits keep big wallets in check for a while. Every limit ends on its own.">
      <div className="sm-stack">
        <StopSlider
          label="Opening batch"
          stops={BATCH_STOPS_SECS.length}
          index={bi}
          exact={BATCH_STOPS_SECS[bi] === open}
          valueText={Number.isFinite(open) && open > 0 ? plainDuration(open) : "—"}
          stopText={(i) => plainDuration(BATCH_STOPS_SECS[i] ?? 60)}
          onIndex={(i) => set(batchPatch(draft, BATCH_STOPS_SECS[i] ?? 300))}
          ends={[plainDuration(BATCH_STOPS_SECS[0] ?? 60), plainDuration(BATCH_STOPS_SECS[BATCH_STOPS_SECS.length - 1] ?? 1800)]}
          say={
            Number.isFinite(open) && open > 0
              ? `For the first ${plainDuration(open)}, everyone joins one opening batch and pays the same price. Nobody can buy before it, so there is nothing to snipe.`
              : "Set the batch length under Advanced."
          }
        />
        <StopSlider
          label="Early limits"
          stops={GUARD_STOPS_SECS.length}
          index={gi}
          exact={GUARD_STOPS_SECS[gi] === guard}
          valueText={Number.isFinite(guard) && guard > 0 ? plainDuration(guard) : "—"}
          stopText={(i) => plainDuration(GUARD_STOPS_SECS[i] ?? 3600)}
          onIndex={(i) => set(guardPatch(GUARD_STOPS_SECS[i] ?? 21600))}
          ends={[plainDuration(GUARD_STOPS_SECS[0] ?? 3600), plainDuration(GUARD_STOPS_SECS[GUARD_STOPS_SECS.length - 1] ?? 259200)]}
          say={
            Number.isFinite(guard) && guard > 0
              ? `For ${plainDuration(guard)} after launch, ${limitsSentence(draft)}. Selling is never blocked.`
              : "Set the length of the early limits under Advanced."
          }
        />
        <div className="sm-group">
          <p className="sl-label">How strict</p>
          <ChoiceCards
            label="How strict"
            choices={PROTECTIONS.map((pr) => ({
              id: pr.id,
              title: pr.title,
              summary:
                pr.id === "light"
                  ? "A loose cap on wallets and nothing else. For a quick, open start."
                  : pr.id === "balanced"
                    ? "Caps on wallets and on single buys, and a fair share for each wallet in the batch."
                    : "Smaller shares in the batch, and tokens stay in the wallet that bought them until the limits end.",
              facts: [
                ["Biggest wallet", `${pctText(pr.maxWalletBps)}%`],
                ["Biggest buy", pr.maxBuyBps === 0 ? "No limit" : `${pctText(pr.maxBuyBps)}%`],
                ["Per wallet in the batch", capOf(pr)],
                ["Wallet to wallet", pr.p2pLocked ? "Paused" : "Allowed"],
              ],
            }))}
            value={protection?.id ?? null}
            onPick={(id) => {
              const pr = PROTECTIONS.find((x) => x.id === id);
              if (pr) set(protectionPatch(draft, pr));
            }}
          />
          <Say text={protection === null ? `Your exact limits are under Advanced. In the opening batch: ${batchCapSentence(draft)}.` : `In the opening batch: ${batchCapSentence(draft)}.`} />
        </div>
      </div>
      {p ? (
        <NoteBox title="Snipe shield">
          Nobody can buy from the pool during the opening batch plus the {POLICY.EXECUTION_GRACE_SECS / 60} minutes it has to start:{" "}
          {describeSeconds(p.openDelaySecs + POLICY.EXECUTION_GRACE_SECS)} in all. The early limits end {describeSeconds(p.guardSecs)} after launch.
        </NoteBox>
      ) : null}
      <Details summary="Advanced: exact times and limits" className="cr-advanced-fold" open={advOpen}>
        <div className="pg-grid-2 cr-advanced-body">
          <ParamField
            doc="openDelaySecs"
            fields={["openDelaySecs"]}
            conv={conv}
            label="Batch window (seconds)"
            extraHelp={Number.isFinite(open) && open > 0 ? `= ${describeSeconds(open)}` : undefined}
          >
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.openDelaySecs} onChange={(e) => set({ openDelaySecs: e.target.value })} inputMode="numeric" />}
          </ParamField>
          <ParamField doc="guardSecs" fields={["guardSecs"]} conv={conv} label="Guard length (seconds)" extraHelp={Number.isFinite(guard) && guard > 0 ? `= ${describeSeconds(guard)}` : undefined}>
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.guardSecs} onChange={(e) => set({ guardSecs: e.target.value })} inputMode="numeric" />}
          </ParamField>
          <ParamField doc="maxWalletBps" fields={["maxWalletBps"]} conv={conv} label="Max wallet (% of supply, 0 = off)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.maxWalletPct} onChange={(e) => set({ maxWalletPct: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="maxBuyBps" fields={["maxBuyBps"]} conv={conv} label="Max buy (% of supply per transfer, 0 = off)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.maxBuyPct} onChange={(e) => set({ maxBuyPct: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="batchWalletCap" fields={["batchWalletCap"]} conv={conv} label="Batch cap per wallet (SOL, 0 = none)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.batchWalletCapSol} onChange={(e) => set({ batchWalletCapSol: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <ParamField doc="batchTotalCap" fields={["batchTotalCap"]} conv={conv} label="Batch total cap (SOL, 0 = graduation amount)">
            {(ids) => <input className="input tabular-nums" {...inputProps(ids)} value={draft.batchTotalCapSol} onChange={(e) => set({ batchTotalCapSol: e.target.value })} inputMode="decimal" />}
          </ParamField>
          <div className="pg-span-2 cr-advanced">
            <Toggle checked={draft.p2pLocked} onChange={(v) => set({ p2pLocked: v })} describedBy="p2p-help" strong>
              {FIELD_DOCS.p2pLocked?.title}
            </Toggle>
            <Comment id="p2p-help">{FIELD_DOCS.p2pLocked?.what}</Comment>
          </div>
        </div>
      </Details>
    </Panel>
  );
}

/** The two-way split's stops: recipient 1's share in whole percent. */
const SPLIT_STOPS: readonly number[] = Array.from({ length: 19 }, (_, i) => 5 + i * 5);

function RecipientsStep({ draft, set, conv, check, me }: { draft: Draft; set: SetDraft; conv: Conversion; check: FeeRecipientsCheck | null; me: string | null }): ReactNode {
  const reveal = useContext(RevealContext);
  const total = draft.recipients.reduce((sum, r) => {
    const n = Number(r.pct);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  const balanced = Math.abs(total - 100) < 1e-9;
  const n = draft.recipients.length;
  const evenNow = evenShares(n);
  const even = draft.recipients.every((r, i) => r.pct === evenNow[i]);
  const first = Number(draft.recipients[0]?.pct ?? "0");
  const splitIndex = nearestIndex(SPLIT_STOPS, first);
  const splitExact = n === 2 && SPLIT_STOPS[splitIndex] === first && Number(draft.recipients[1]?.pct ?? "") === 100 - first;
  const shareFields = draft.recipients.map((_, i) => `recipients[${i}].bps`);
  const advOpen = useAdvancedOpen(conv, ["recipients", ...shareFields]);
  // Cautions about a recipient (an account of another program, e.g. a multisig): shown, not blocking.
  const warningsOf = (i: number): string[] =>
    (check?.warnings ?? [])
      .map(splitError)
      .filter((w) => w.field === `recipients[${i}].wallet`)
      .map((w) => plainRecipientProblem(w.message));
  const setWallet = (i: number, wallet: string): void => set({ recipients: draft.recipients.map((x, j) => (j === i ? { ...x, wallet } : x)) });
  // Simple mode keeps an even split even when wallets are added or removed; shares set under Advanced are left alone.
  const add = (): void => {
    const next = [...draft.recipients, { wallet: "", pct: "0" }];
    set({ recipients: even ? evenSplit(next) : next });
  };
  const remove = (i: number): void => {
    const next = draft.recipients.filter((_, j) => j !== i);
    set({ recipients: even || next.length === 1 ? evenSplit(next) : next });
  };
  return (
    <Panel title="Who receives the fees" description={FIELD_DOCS.recipients?.what}>
      <div className="pg-stack">
        {draft.recipients.map((r, i) =>
          isTreasuryMark(r) ? (
            <fieldset key={i} className="cr-fieldset cr-recipient cr-treasury" data-simple="">
              <legend>Recipient {i + 1}</legend>
              <div className="cr-treasury-who">
                <b>This token&apos;s Autopilot treasury</b>
                <span>
                  {me === null
                    ? "Connect a wallet: its address comes from your launch's own address."
                    : "Fees paid here go back into the token: its Autopilot spends them on buybacks that burn, burns or payouts (set them in the Autopilot step)."}
                </span>
              </div>
              <span className="sm-share" title="The treasury's share of the fees">
                {r.pct}%
              </span>
              <div className="cr-fieldset-act">
                <Button size="sm" variant="ghost" aria-label="Remove the treasury" onClick={() => set({ recipients: withTreasuryShare(draft.recipients, 0, me ?? "") })}>
                  <TrashIcon />
                </Button>
              </div>
            </fieldset>
          ) : (
          <fieldset key={i} className="cr-fieldset cr-recipient" data-simple="">
            <legend>Recipient {i + 1}</legend>
            <div className="contents" onChangeCapture={() => reveal.touch([`recipients[${i}].wallet`])} onBlurCapture={() => reveal.touch([`recipients[${i}].wallet`])}>
              <Field label="Wallet" error={reveal.shown([`recipients[${i}].wallet`]) ? errorsFor(conv, [`recipients[${i}].wallet`]) : null} className="cr-field">
                {(ids) => <input className="input mono" {...inputProps(ids)} value={r.wallet} onChange={(e) => setWallet(i, e.target.value)} spellCheck={false} autoComplete="off" />}
              </Field>
            </div>
            <span className="sm-share" title="This wallet's share of the fees">
              {r.pct}%
            </span>
            <div className="cr-fieldset-act">
              <Button size="sm" variant="ghost" aria-label={`Remove recipient ${i + 1}`} disabled={n <= 1} onClick={() => remove(i)}>
                <TrashIcon />
              </Button>
            </div>
            {warningsOf(i).map((w) => (
              <Reason key={w}>{w}</Reason>
            ))}
          </fieldset>
          ),
        )}
        {n === 2 ? (
          <StopSlider
            label="Split"
            stops={SPLIT_STOPS.length}
            index={splitIndex}
            exact={splitExact}
            valueText={`${draft.recipients[0]?.pct ?? "?"}% · ${draft.recipients[1]?.pct ?? "?"}%`}
            stopText={(i) => `${SPLIT_STOPS[i] ?? 50}% and ${100 - (SPLIT_STOPS[i] ?? 50)}%`}
            onIndex={(i) => set({ recipients: twoWaySplit(draft.recipients, SPLIT_STOPS[i] ?? 50) })}
            ends={["More to recipient 2", "More to recipient 1"]}
            say={splitExact ? `Recipient 1 gets ${first}% of the fees and recipient 2 gets ${100 - first}%.` : "Your exact shares are under Advanced."}
          />
        ) : n > 2 ? (
          <Say text={even ? `The fees are split evenly: ${evenNow.join("%, ")}%.` : "Your exact shares are under Advanced."} />
        ) : null}
        <div className="cr-total">
          <span className="cr-total-btns">
            <Button size="sm" disabled={n >= POLICY.MAX_RECIPIENTS} onClick={add}>
              <PlusIcon /> Add recipient
            </Button>
            {!draft.recipients.some(isTreasuryMark) ? (
              <Button size="sm" variant="ghost" disabled={n >= POLICY.MAX_RECIPIENTS} onClick={() => set({ recipients: withTreasuryShare(draft.recipients, 25, me ?? "") })}>
                <PlusIcon /> Back into the token
              </Button>
            ) : null}
          </span>
          <div className="cr-total-meter" data-tone={balanced ? "ok" : "warn"}>
            <DotBar value={total} max={100} tone={balanced ? "ok" : "warn"} />
            <span className="tabular-nums">Total {Number(total.toFixed(2))}%</span>
          </div>
        </div>
        {errorsFor(conv, ["recipients"]) ? <p className="field-error">{errorsFor(conv, ["recipients"])}</p> : null}
        <Details summary="Advanced: exact shares" className="cr-advanced-fold" open={advOpen}>
          <div className="pg-grid-2 cr-advanced-body">
            {draft.recipients.map((r, i) => (
              <div key={i} className="contents" onChangeCapture={() => reveal.touch([`recipients[${i}].bps`])} onBlurCapture={() => reveal.touch([`recipients[${i}].bps`])}>
                <Field label={`Share of recipient ${i + 1} (%)`} error={reveal.shown([`recipients[${i}].bps`]) ? errorsFor(conv, [`recipients[${i}].bps`]) : null} className="cr-field">
                  {(ids) => (
                    <input
                      className="input tabular-nums"
                      {...inputProps(ids)}
                      value={r.pct}
                      onChange={(e) => set({ recipients: draft.recipients.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)) })}
                      inputMode="decimal"
                    />
                  )}
                </Field>
              </div>
            ))}
          </div>
        </Details>
        <Comment>
          {FIELD_DOCS.recipients?.bounds} A platform share (fixed when the protocol was deployed) is taken before this split. Fees are paid in wrapped SOL, so a quantum
          vault for SOL can receive them; a vault for another token cannot.
        </Comment>
      </div>
    </Panel>
  );
}

/** "Your quantum key": the key that signs the launch, never the wallet. */
function KeyStep(): ReactNode {
  const key = usePqKey();
  const id = key.identity.idHex;
  return (
    <>
      <Panel
        title="Signed by your quantum key, not your wallet"
        description="Your launch opens only with a signature from your quantum key. A quantum computer could one day break a wallet's key, but not this one, and nobody else holds it."
        className="cr-qkey"
      >
        <Checks label="What your quantum key does">
          <CheckLine status="pass" i={0} detail="Your wallet creates the launch and pays a small fee. Your quantum key decides that it may open, and when.">
            It signs your launch
          </CheckLine>
          <CheckLine status="pass" i={1} detail="It never leaves this page. A passkey or your 24 words bring it back on another device.">
            It stays with you
          </CheckLine>
          <CheckLine status="pass" i={2} detail="Each signature is made once and recorded in this browser, so the same signature can be sent again if needed.">
            One-time signatures
          </CheckLine>
        </Checks>
        {key.status === "unlocked" && id !== null ? (
          <Alert tone="ok" title="Ready to sign">
            Key ID {shortId(id)} will sign this launch.
          </Alert>
        ) : key.identity.status === "deriving" ? (
          <p className="pg-wait" role="status">
            Preparing your key… {Math.round(key.identity.progress * 100)}%
          </p>
        ) : null}
      </Panel>
      <QuantumKeyPanel use="It signs your launch, so it can open." />
    </>
  );
}

/** This browser's launches that are still going (after a reload, or started in another tab): their trackers. */
function InProgress({ except }: { except: string | null }): ReactNode {
  // A launch that finishes while this page shows it stays, so its last word ("Your launch is open") is seen.
  const shown = useRef(new Set<string>());
  const flows = useLaunchFlows().filter((f) => f.id !== except && (!f.done || shown.current.has(f.id)));
  for (const f of flows) shown.current.add(f.id);
  if (flows.length === 0) return null;
  const going = flows.filter((f) => !f.done).length;
  return (
    <Panel
      title={going === 0 ? (flows.length === 1 ? "Your launch" : "Your launches") : flows.length === 1 ? "Your launch in progress" : "Your launches in progress"}
      description="This browser keeps going with them while this tab is open."
      className="cr-inprogress"
    >
      <div className="pg-stack">
        {flows.map((f) => (
          <LaunchTracker key={f.id} view={f} compact />
        ))}
      </div>
    </Panel>
  );
}

// ----------------------------------------------------------------- review ---

function ReviewStep({
  draft,
  stored,
  conv,
  goTo,
  started,
  onStarted,
  rules,
  rulesEnv,
  rulesProblems,
  onEditRules,
  seed,
  autopilot,
  autopilotProblems,
  treasuryPct,
  onEditAutopilot,
}: {
  draft: Draft;
  /** The icon the record stores (the last one made). */
  stored: StoredIcon | undefined;
  conv: Conversion;
  goTo: (s: StepId) => void;
  started: string | null;
  onStarted: (id: string) => void;
  rules: RulesDraft;
  rulesEnv: RulesEnv;
  rulesProblems: readonly string[];
  onEditRules: () => void;
  /** The launch's seed (its address and its Autopilot treasury were derived from it). */
  seed: Uint8Array;
  /** The Autopilot switched on after the launch opens (null: none). */
  autopilot: GraphBuild | null;
  autopilotProblems: readonly string[];
  treasuryPct: number;
  onEditAutopilot: () => void;
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const key = usePqKey();
  const now = useNow();
  const flows = useLaunchFlows();
  const [ack, setAck] = useState(false);
  const [opening, setOpening] = useState<OpeningChoice>("asap");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<FundingEstimate | null>(null);
  const p = conv.params;
  const errors = allErrors(conv);
  const rulesBuild: RulesBuild | null = buildDraft(rules, rulesEnv).build;
  const apBytes = autopilot !== null && autopilot.ok ? autopilot.bytes : null;
  const valid = p !== null && errors.length === 0 && conv.metadataReady && rulesProblems.length === 0 && autopilotProblems.length === 0 && (rulesBuild === null || rulesBuild.ok);
  const hash = valid && p ? toHex(launchParamsHash(p)) : null;
  const me = owner.publicKey;
  const keyReady = key.status === "unlocked" && key.identity.idHex !== null;
  const openingIssue = openingProblem(opening, now);
  const view = started === null ? null : (flows.find((f) => f.id === started) ?? null);
  const canLaunch = valid && ack && me !== null && keyReady && openingIssue === null && !starting;

  // What step 2 will send, read from the cluster once the record is final (shown before anything is signed).
  const recordKey = conv.metadataReady ? `${conv.recordBytes}:${apBytes?.length ?? 0}` : "";
  useEffect(() => {
    let alive = true;
    if (recordKey === "" || conv.recordBytes === 0) return;
    estimateLaunchFunding(phx, connection, conv.metadata, apBytes === null ? null : apBytes.length).then(
      (e) => {
        if (alive) setEstimate(e);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [connection, recordKey]);

  const launch = async (): Promise<void> => {
    if (!canLaunch || p === null || me === null) return;
    setStarting(true);
    setError(null);
    try {
      const identity = await launchIdentity(CLUSTER);
      const id = await startLaunchFlow({
        cluster: CLUSTER,
        creator: me,
        params: p,
        metadata: conv.metadata,
        identityIndex: 0,
        lmsPublicKey: identity.keyPair.publicKey,
        opensAt: opening,
        rules: rulesBuild !== null && rulesBuild.ok ? rulesBuild.bytes : null,
        launchSeed: seed,
        autopilot: apBytes,
      });
      onStarted(id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="pg-stack-lg">
      {rulesProblems.length > 0 ? (
        <Alert tone="fail" title="Your launch rules need a fix">
          <ul className="cr-problems">
            {rulesProblems.map((e) => (
              <li key={e}>
                <button type="button" className="cr-problem" onClick={onEditRules}>
                  <span className="cr-problem-t">{e}</span>
                  <span className="cr-problem-go" aria-hidden="true">
                    Launch rules →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {autopilotProblems.length > 0 ? (
        <Alert tone="fail" title="Your Autopilot needs a fix">
          <ul className="cr-problems">
            {autopilotProblems.map((e) => (
              <li key={e}>
                <button type="button" className="cr-problem" onClick={onEditAutopilot}>
                  <span className="cr-problem-t">{e}</span>
                  <span className="cr-problem-go" aria-hidden="true">
                    Autopilot →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {errors.length > 0 ? (
        <Alert tone="fail" title={`${errors.length} problem${errors.length === 1 ? "" : "s"} to fix`}>
          <ul className="cr-problems">
            {errors.map((e) => {
              const f = splitError(e).field;
              const target = STEPS.find((s) => s.id === uiStepOf(stepOfField(f)));
              return (
                <li key={e}>
                  <button type="button" className="cr-problem" onClick={() => goTo(stepOfField(f))}>
                    <span className="cr-problem-t">{labelled(e)}</span>
                    <span className="cr-problem-go" aria-hidden="true">
                      {target !== undefined ? target.label : ""} →
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Alert>
      ) : (
        <Alert tone="ok" title="Passes every safety rule">
          No problems found. The program checks the same rules again on Solana when the launch is created.
        </Alert>
      )}

      <Panel title="Your token" description="How it shows on a launch card." className="cr-review-token">
        <div className="cr-review-card">
          <IconCard icon={draft.meta.icon} stored={stored} name={draft.name} symbol={draft.symbol} description={draft.meta.description} />
          <Readout label="Token">
            <Row k="Name">{draft.name.trim() || "—"}</Row>
            <Row k="Symbol">{draft.symbol.trim() || "—"}</Row>
            <Row k="Icon">{iconSummary(stored)}</Row>
            {draft.meta.website.trim() !== "" ? <Row k="Website">{draft.meta.website.trim()}</Row> : null}
            {draft.meta.x.trim() !== "" ? <Row k="X">@{draft.meta.x.trim().replace(/^@/, "")}</Row> : null}
            <Row k="On Solana">{conv.recordBytes > 0 ? `${conv.recordBytes.toLocaleString("en-US")} bytes, signed by your quantum key` : "—"}</Row>
          </Readout>
        </div>
        <Comment>The name, symbol, icon, description and links are stored on Solana itself and can never be changed. Wallets show the name and symbol.</Comment>
      </Panel>

      <Panel title="What nobody can do after launch" description="Enforced by the programs, not by this website. After launch nobody, including you, can:">
        <Checks label="Impossible after launch" className="pg-cks-2">
          {IMPOSSIBLE.map((item, i) => (
            <CheckLine key={item.title} status="pass" i={i}>
              {item.title}
            </CheckLine>
          ))}
        </Checks>
        <Details summary="How the programs enforce this">
          <ul className="cr-why-list">
            {IMPOSSIBLE.map((item) => (
              <li key={item.title}>
                <strong>{item.title}.</strong> {item.why}
              </li>
            ))}
          </ul>
        </Details>
        <Comment>
          What still depends on others: Meteora's upgrade multisig, DAMM v2 operators, the Token-2022 multisig and the validators.{" "}
          <Link to="/security" className="link">
            Who you still trust
          </Link>
          .
        </Comment>
      </Panel>

      <RulesReview rules={rules} env={rulesEnv} build={rulesBuild} onEdit={onEditRules} available={PROGRAMMABLE_AVAILABLE} />

      <AutopilotReview build={autopilot} treasuryPct={treasuryPct} decimals={p?.tokenDecimal ?? 6} onEdit={onEditAutopilot} />

      {p ? <ParamsFold draft={draft} params={p} hash={hash} /> : null}

      <Panel title="Launch" className="cr-launch" tone={view !== null || canLaunch ? "signal" : undefined}>
        {view !== null ? (
          <LaunchTracker view={view} />
        ) : (
          <>
            <OpeningPicker value={opening} onChange={setOpening} idBase="cr-open" />
            <div className="cr-plan">
              <p className="cr-plan-head">What happens when you launch</p>
              <ol className="lt-steps" aria-label="Launch steps">
                {stagesOf({ autopilot: apBytes !== null }).map((s, i) => {
                  const t = stepText(s as Exclude<FlowStage, "done">, { fundLamports: estimate?.total ?? null, window: null });
                  return (
                    <li key={s} className="lt-step" data-state="todo">
                      <span className="lt-node" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="lt-step-text">
                        <span className="lt-step-label">{s === "open" ? (opening === "asap" ? "Opens about a minute after it is signed" : `Opens at ${formatTimestamp(opening)} (${utcText(opening)})`) : t.label}</span>
                        <span className="lt-step-hint">{t.hint}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {estimate !== null ? (
                <Comment>
                  Step 2 sends about {formatSol(estimate.total, 4)}: {formatSol(estimate.details, 4)} to store the details, {formatSol(estimate.signature, 4)} for the quantum signature,{" "}
                  {formatSol(estimate.opening, 4)} to open the launch{estimate.autopilot > 0n ? `, ${formatSol(estimate.autopilot, 4)} to switch on the Autopilot` : ""} and{" "}
                  {formatSol(estimate.kept, 4)} kept until the end. Everything not spent comes back to your wallet.
                </Comment>
              ) : null}
            </div>
            <Toggle checked={ack} onChange={setAck}>
              I understand that every value above is permanent once the launch is created, and that I get no tokens unless I commit to the batch like everyone else.
            </Toggle>
            {!me ? <Reason>Connect a wallet to create the launch</Reason> : null}
            {!keyReady ? (
              <Reason>
                Unlock your quantum key first:{" "}
                <button type="button" className="link" onClick={() => goTo("key")}>
                  Your quantum key
                </button>
              </Reason>
            ) : null}
            {!conv.metadataReady ? <Reason>Preparing your icon…</Reason> : null}
            <div className="pg-btns">
              <Button variant="primary" loading={starting} disabled={!canLaunch} onClick={() => void launch()}>
                Launch
              </Button>
            </div>
            {error !== null ? <Alert tone="fail">{error}</Alert> : null}
            <Comment>Keep this tab open until your launch has opened. If you close it, everything picks up again when you come back.</Comment>
          </>
        )}
      </Panel>
    </div>
  );
}

/** The review's Autopilot: what the quantum key switches on right after the launch opens, in plain English. */
function AutopilotReview({ build, treasuryPct, decimals, onEdit }: { build: GraphBuild | null; treasuryPct: number; decimals: number; onEdit: () => void }): ReactNode {
  const lines = useMemo(() => (build !== null && build.ok ? explainGraphLines(build.bytes, false, decimals) : []), [build, decimals]);
  if (build === null) {
    return treasuryPct > 0 ? (
      <Panel title="Autopilot" status={<Chip tone="muted">Off</Chip>} description={`${treasuryPct}% of your fee share goes to the token's treasury. Nothing spends it until an Autopilot is switched on.`}>
        <Button size="sm" onClick={onEdit}>
          Set up the Autopilot
        </Button>
      </Panel>
    ) : null;
  }
  return (
    <Panel
      title="Autopilot"
      status={<Chip tone={build.ok ? "ok" : "warn"}>{build.ok ? "On when it opens" : "Needs a fix"}</Chip>}
      description="Your quantum key switches these steps on right after the launch opens. A first Autopilot has no waiting period; any later change waits 72 hours, in public."
      className="cr-ap-review"
    >
      {lines.length > 0 ? (
        <ol className="rl-plain">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      ) : null}
      <Comment>
        {treasuryPct > 0 ? `Funded by ${treasuryPct}% of your share of the trading fees.` : "No share of the fees goes to its treasury: it only spends what someone sends it."} It can never sell
        the token, touch the locked liquidity, mint, or pay anyone it does not list.
      </Comment>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Change the Autopilot
      </Button>
    </Panel>
  );
}

const IMPOSSIBLE: { title: string; why: string }[] = [
  { title: "Mint more tokens", why: "The launch transaction checks that the mint authority is None; it can never be set again." },
  { title: "Freeze anyone's tokens", why: "The freeze authority is None." },
  { title: "Change the name, symbol or metadata", why: "The metadata update authority and the metadata pointer authority are None, so the name, symbol, URI and metadata pointer are fixed." },
  {
    title: "Add a token extension",
    why: "Token-2022 fixes extensions when the mint is created; the set is checked to be exactly MetadataPointer, TokenMetadata and TransferHook (no permanent delegate, transfer fee, pause, default-frozen accounts or close authority).",
  },
  {
    title: "Buy before the fair-open batch, or get a creator allocation",
    why: "The Launch Guard refuses every buy from the pool until the batch window ends; the DBC config has no locked vesting, no creator fee share and no discounted first swap.",
  },
  {
    title: "Withdraw or shrink the liquidity",
    why: "There is no migration fee, so the whole raise goes into DAMM v2, and 100% of that LP is permanently locked and owned by the launch authority PDA, which no key controls.",
  },
  { title: "Change the fee recipients, their shares or the platform share", why: "They are written into the Launch account by create_launch and no instruction rewrites them." },
  { title: "Change the curve, threshold, fees, timing or caps", why: "The DBC config, the Launch account and the hook policy are each written once." },
  { title: "Block sells or extend the guard", why: "The hook always allows sells into the pool, and every guard rule expires at launch + guard length (at most 72 hours)." },
  { title: "Pause the launch or reclaim funds", why: "The launchpad has no admin, pause, upgrade-path or withdraw instruction in its logic." },
];

/** Every parameter, exactly as it is hashed into the certificate (technical: folded by default). */
function ParamsFold({ draft, params, hash }: { draft: Draft; params: LaunchParamsInput; hash: string | null }): ReactNode {
  const p = params;
  const fee = feeSummary(p);
  const rows: [string, ReactNode][] = [
    ["name / symbol", `${draft.name || "—"} / ${draft.symbol || "—"}`],
    ["tokenDecimal", p.tokenDecimal],
    ["sqrtStartPrice", <code key="s" className="pg-break">{p.sqrtStartPrice.toString()}</code>],
    [
      "curve",
      <ul key="c" className="pg-list-plain">
        {p.curve.map((c, i) => (
          <li key={i} className="pg-break">
            [{i}] sqrtPrice {c.sqrtPrice.toString()}, liquidity {c.liquidity.toString()}
          </li>
        ))}
      </ul>,
    ],
    ["migrationQuoteThreshold", `${formatSolExact(p.migrationQuoteThreshold)} (${p.migrationQuoteThreshold} lamports)`],
    [
      "baseFee",
      `cliff ${feeNumeratorToPercent(p.baseFee.cliffFeeNumerator)}% (${p.baseFee.cliffFeeNumerator}), mode ${p.baseFee.baseFeeMode}, periods ${p.baseFee.firstFactor} × ${p.baseFee.secondFactor}s, reduction ${p.baseFee.thirdFactor}${fee ? `, floor ${feeNumeratorToPercent(fee.floorFeeNumerator)}%` : ""}`,
    ],
    [
      "dynamicFee",
      p.dynamicFee
        ? `filter ${p.dynamicFee.filterPeriod}s, decay ${p.dynamicFee.decayPeriod}s, reduction ${p.dynamicFee.reductionFactor} bps, max accumulator ${p.dynamicFee.maxVolatilityAccumulator}, control ${p.dynamicFee.variableFeeControl}${fee ? ` (max ${feeNumeratorToPercent(fee.maxDynamicFeeNumerator)}%)` : ""}`
        : "none",
    ],
    ["migrationFeeOption", `${p.migrationFeeOption} (${(MIGRATION_FEE_TIERS_BPS[p.migrationFeeOption] ?? 0) / 100}% DAMM v2 tier)`],
    ["openDelaySecs", `${p.openDelaySecs} (${describeSeconds(p.openDelaySecs)})`],
    ["guardSecs", `${p.guardSecs} (${describeSeconds(p.guardSecs)})`],
    ["maxWalletBps", p.maxWalletBps === 0 ? "0 (off)" : `${p.maxWalletBps} (${p.maxWalletBps / 100}%)`],
    ["maxBuyBps", p.maxBuyBps === 0 ? "0 (off)" : `${p.maxBuyBps} (${p.maxBuyBps / 100}%)`],
    ["p2pLocked", p.p2pLocked ? "true" : "false"],
    ["batchWalletCap", p.batchWalletCap === 0n ? "0 (no cap)" : formatSolExact(p.batchWalletCap)],
    ["batchTotalCap", p.batchTotalCap === 0n ? "0 (= threshold)" : formatSolExact(p.batchTotalCap)],
    [
      "recipients",
      <ul key="r" className="pg-list-plain">
        {p.recipients.map((r, i) => (
          <li key={i} className="pg-break">
            {r.wallet.toBase58()} — {r.bps} bps
          </li>
        ))}
      </ul>,
    ],
  ];
  return (
    <Fold label="All parameters" status={<Chip tone={hash ? "ok" : "warn"}>{hash ? "Ready to hash" : "Fix the problems first"}</Chip>} className="cr-params">
      <p className="pg-text">{`Preset: ${PRESETS[draft.preset].title}. These exact values are encoded and hashed into the launch certificate.`}</p>
      <Readout label="Launch parameters" className="cr-params-readout">
        {rows.map(([k, v]) => (
          <Row key={k} k={<code className="cr-key">{k}</code>} wide={k === "curve" || k === "recipients" || k === "baseFee" || k === "dynamicFee" || k === "sqrtStartPrice"}>
            {v}
          </Row>
        ))}
        <Row k={<code className="cr-key">params_hash</code>} wide tone={hash ? "ok" : "warn"}>
          <code className="pg-break">{hash ?? "fix the problems above first"}</code>
        </Row>
      </Readout>
    </Fold>
  );
}

// ------------------------------------------------------- extra rules env ---

/** What extra rules depend on, from the validated parameters (or the raw draft while it has errors). */
function rulesEnvOf(draft: Draft, params: LaunchParamsInput | null): RulesEnv {
  const num = (v: string, fallback: number): number => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    guardSecs: Math.min(params?.guardSecs ?? num(draft.guardSecs, 3_600), POLICY.MAX_GUARD_SECS),
    openDelaySecs: params?.openDelaySecs ?? num(draft.openDelaySecs, 300),
    graceSecs: POLICY.EXECUTION_GRACE_SECS,
    decimals: params?.tokenDecimal ?? num(draft.tokenDecimal, 6),
  };
}

/** The draft's built-in guard, for "Try a transfer" (supply: the curve's estimate, else one billion tokens). */
function guardFactsOf(params: LaunchParamsInput | null, env: RulesEnv): GuardFacts {
  const est = params && params.curve.length > 0 ? estimateSupply(params.sqrtStartPrice, params.curve, params.migrationQuoteThreshold) : null;
  const base = 10n ** BigInt(env.decimals);
  const supply = est ? est.curveBase + est.migrationBase : 1_000_000_000n * base;
  return {
    openDelaySecs: env.openDelaySecs,
    graceSecs: env.graceSecs,
    guardSecs: env.guardSecs,
    maxBuyBps: params?.maxBuyBps ?? 0,
    maxWalletBps: params?.maxWalletBps ?? 0,
    p2pLocked: params?.p2pLocked ?? false,
    supply,
    decimals: env.decimals,
  };
}
