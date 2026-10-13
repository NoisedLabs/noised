/**
 * Quick launch: one short screen (owner's request, 2026-10-11).
 *
 *   1. Your token: name, ticker, logo (crop + pixel preview, stored on Solana), X and website (optional);
 *      the trading fee (a slider over safe stops, with what it means) and where the fees go: to my wallet, back into
 *      the token (automatic buyback and burn by the token's Autopilot), or a split;
 *   2. your quantum key (a passkey or 24 words);
 *   3. review and launch: the same launch tracker as every launch.
 *
 * Everything else is the Fair preset. The parameters come from the same draft and `convertDraft` as the Custom
 * launch (./quick.ts), so the program checks the same rules. "Back into the token" switches the token's Autopilot on
 * right after the launch opens, signed by the quantum key, paid from the launch's temporary account.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useNow } from "../../app/hooks";
import { CLUSTER } from "../../app/settings";
import { useOwner } from "../../app/wallet";
import { LaunchTracker, stepText, useLaunchFlows } from "../../components/launchTracker";
import { Alert, Button, Field } from "../../components/ui";
import { cardScene } from "../../components/art/scenes";
import { NoiseArt } from "../../fx/noise";
import { sfx } from "../../fx/sfx";
import { formatSol, formatSolExact } from "../../lib/amounts";
import { describeSeconds, errorMessage, toHex } from "../../lib/format";
import { estimateLaunchFunding, FEES_TO_TOKEN_NOT_LIVE, stagesOf, startLaunchFlow, type FlowStage, type FundingEstimate } from "../../lib/launchFlow";
import * as phx from "../../lib/noised";
import { launchParamsHash, metadataHashV2, planQuickLaunch, POLICY, PRESETS, PROGRAMMABLE_AVAILABLE, type TokenMetaInput } from "../../lib/noised";
import { launchIdentity, shortId, usePqKey } from "../../lib/pqKey";
import { explainGraphLines } from "../../lib/programmable";
import { Chip, Comment, Details, Panel, Readout, Row, Toggle } from "../inner/kit";
import { QuantumKeyPanel } from "../quantumkey/QuantumKeyPanel";
import { convertDraft, iconBudgetOf, metaProblems, splitError, xHandle, type StoredIcon } from "./draft";
import { iconSummary, LogoUpload } from "./LogoUpload";
import { IconCard } from "./PixelIconEditor";
import { blankIcon } from "./pixelIcon";
import { useStoredIcon } from "./useStoredIcon";
import {
  buybackBuild,
  buybackFacts,
  DESTINATION_TEXT,
  DESTINATIONS,
  destinationSentence,
  feeSentence,
  feeText,
  launchTreasury,
  needsAutopilot,
  QUICK_FEE_STOPS_BPS,
  QUICK_PRESET,
  quickDefaults,
  quickDraft,
  quickPlanInput,
  resolveTreasury,
  SPLIT_STOPS_PCT,
  type FeeDestination,
  type QuickState,
} from "./quick";
import { nearestIndex } from "./simple";
import { StopSlider } from "./SimpleControls";

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const freshSeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export function QuickLaunch({ started, onStarted }: { started: string | null; onStarted: (id: string) => void }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const me = owner.publicKey;
  const key = usePqKey();
  const pqId = key.identity.idHex;
  useEffect(() => {
    if (key.status === "unlocked" && key.identity.status === "idle") void launchIdentity(CLUSTER).catch(() => undefined);
  }, [key.status, key.identity.status]);

  const [q, setQ] = useState<QuickState>(quickDefaults);
  const set = (patch: Partial<QuickState>): void => setQ((x) => ({ ...x, ...patch }));
  // The launch's seed: its address, and so its Autopilot treasury, are known before it exists (a new one per launch).
  const [seed, setSeed] = useState<Uint8Array>(freshSeed);
  const treasury = useMemo(() => (me === null ? null : launchTreasury(me, seed).treasury), [me, seed]);
  const draft = useMemo(() => resolveTreasury(quickDraft(q, me?.toBase58() ?? ""), treasury), [q, me, treasury]);

  // The logo the record stores (made asynchronously; an uploaded picture is fitted to the room the details leave).
  const icon = useStoredIcon(draft);
  const pngNow = icon.now === undefined ? undefined : icon.now.png;
  const conv = useMemo(() => convertDraft(draft, pqId === null ? null : Uint8Array.from(pqId.match(/../g) ?? [], (h) => Number.parseInt(h, 16)), pngNow), [draft, pqId, pngNow]);
  const decimals = conv.params?.tokenDecimal ?? 6;
  const autopilot = useMemo(() => (needsAutopilot(q.destination) ? buybackBuild(decimals) : null), [q.destination, decimals]);

  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (f: string): void => setTouched((t) => (t.has(f) ? t : new Set([...t, f])));
  const [tried, setTried] = useState(false);
  const shown = (f: string): boolean => tried || touched.has(f);
  const fieldError = (f: string): string | null => {
    const own = conv.inputErrors[f];
    if (own !== undefined) return own;
    const p = conv.policyErrors.find((e) => splitError(e).field === f);
    return p === undefined ? null : splitError(p).message.replace(/^is /, "");
  };
  const meta = metaProblems(q.meta);

  const symbol = q.symbol.trim();
  const fi = nearestIndex(QUICK_FEE_STOPS_BPS, q.feeBps);
  const si = nearestIndex(SPLIT_STOPS_PCT, q.walletPct);
  const comingSoon = !PROGRAMMABLE_AVAILABLE && needsAutopilot(q.destination);

  return (
    <div className="ql pg-stack-lg">
      <Panel
        title={
          <>
            <span className="ql-n" aria-hidden="true">
              1
            </span>{" "}
            Your token
          </>
        }
        description="A name, a ticker and a logo. They are stored on Solana with your token and can never be changed."
        className="ql-token"
      >
        <div className="ql-grid">
          <div className="ql-logo">
            <p className="label">Logo</p>
            <LogoUpload
              meta={q.meta}
              stored={icon.shown}
              budget={iconBudgetOf(draft)}
              onIcon={(next) => set({ meta: { ...q.meta, icon: next, logo: null } })}
              onLogo={(logo) => set({ meta: { ...q.meta, logo, icon: blankIcon(q.meta.icon.palette) } })}
              name={q.name}
              symbol={q.symbol}
            />
          </div>
          <div className="ql-fields">
            <div className="contents" onBlurCapture={() => touch("name")}>
              <Field label="Name" className="cr-field" error={shown("name") ? fieldError("name") : null} help={<span className="cr-help-live">{new TextEncoder().encode(q.name).length}/{POLICY.MAX_NAME_LEN} bytes</span>}>
                {(ids) => (
                  <input
                    className="input"
                    id={ids.input}
                    aria-invalid={ids.invalid}
                    aria-describedby={ids.describedBy || undefined}
                    value={q.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder="Quantum Lantern"
                    autoComplete="off"
                  />
                )}
              </Field>
            </div>
            <div className="contents" onBlurCapture={() => touch("symbol")}>
              <Field label="Ticker" className="cr-field" error={shown("symbol") ? fieldError("symbol") : null} help={<span className="cr-help-live">{new TextEncoder().encode(q.symbol).length}/{POLICY.MAX_SYMBOL_LEN} bytes</span>}>
                {(ids) => (
                  <span className="ql-ticker">
                    <span className="ql-dollar" aria-hidden="true">
                      $
                    </span>
                    <input
                      className="input"
                      id={ids.input}
                      aria-invalid={ids.invalid}
                      aria-describedby={ids.describedBy || undefined}
                      value={q.symbol}
                      onChange={(e) => set({ symbol: e.target.value.replace(/^\$/, "").toUpperCase() })}
                      placeholder="QLTN"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </span>
                )}
              </Field>
            </div>
            <Field label="X link" optional className="cr-field" error={meta.x}>
              {(ids) => (
                <span className="cr-at">
                  <span className="cr-at-sign" aria-hidden="true">
                    @
                  </span>
                  <input
                    className="input"
                    id={ids.input}
                    aria-invalid={ids.invalid}
                    aria-describedby={ids.describedBy || undefined}
                    value={q.meta.x.replace(/^@/, "")}
                    onChange={(e) => set({ meta: { ...q.meta, x: e.target.value.replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "") } })}
                    placeholder="handle"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </span>
              )}
            </Field>
            <Field label="Website" optional className="cr-field" error={meta.website}>
              {(ids) => (
                <input
                  className="input"
                  id={ids.input}
                  aria-invalid={ids.invalid}
                  aria-describedby={ids.describedBy || undefined}
                  type="url"
                  inputMode="url"
                  value={q.meta.website}
                  onChange={(e) => set({ meta: { ...q.meta, website: e.target.value } })}
                  placeholder="https://"
                  autoComplete="url"
                  spellCheck={false}
                />
              )}
            </Field>
          </div>
        </div>
        {fieldError("icon") !== null ? <Alert tone="fail">{capital(fieldError("icon") ?? "")}</Alert> : null}

        <div className="ql-fee">
          <StopSlider
            label="Trading fee"
            stops={QUICK_FEE_STOPS_BPS.length}
            index={fi}
            exact
            valueText={feeText(QUICK_FEE_STOPS_BPS[fi] ?? q.feeBps)}
            stopText={(i) => feeText(QUICK_FEE_STOPS_BPS[i] ?? 100)}
            onIndex={(i) => set({ feeBps: QUICK_FEE_STOPS_BPS[i] ?? 100 })}
            ends={[feeText(QUICK_FEE_STOPS_BPS[0] ?? 25), feeText(QUICK_FEE_STOPS_BPS[QUICK_FEE_STOPS_BPS.length - 1] ?? 500)]}
            say={feeSentence(q.feeBps)}
          />
        </div>

        <div className="ql-dest">
          <p className="sl-label" id="ql-dest-label">
            Where do trading fees go?
          </p>
          <div className="ql-cards" role="radiogroup" aria-labelledby="ql-dest-label">
            {DESTINATIONS.map((d) => (
              <DestinationCard key={d} id={d} on={q.destination === d} onPick={() => set({ destination: d })} soon={!PROGRAMMABLE_AVAILABLE && needsAutopilot(d)} />
            ))}
          </div>
          {q.destination === "split" ? (
            <StopSlider
              label="Split"
              stops={SPLIT_STOPS_PCT.length}
              index={si}
              exact
              valueText={`${SPLIT_STOPS_PCT[si] ?? 50}% wallet · ${100 - (SPLIT_STOPS_PCT[si] ?? 50)}% token`}
              stopText={(i) => `${SPLIT_STOPS_PCT[i] ?? 50}% to your wallet, ${100 - (SPLIT_STOPS_PCT[i] ?? 50)}% back into the token`}
              onIndex={(i) => set({ walletPct: SPLIT_STOPS_PCT[i] ?? 50 })}
              ends={["More into the token", "More to your wallet"]}
            />
          ) : null}
          <p className="ql-hook" aria-live="polite">
            <span className="sl-say-mark" aria-hidden="true" />
            <span key={`${q.destination}${q.walletPct}${symbol}`}>{destinationSentence(q.destination, q.walletPct, q.symbol)}</span>
          </p>
          {needsAutopilot(q.destination) ? (
            <Details summary="How the buyback works" className="ql-facts">
              <ul className="ql-fact-list">
                {buybackFacts().map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <p className="ql-fact-more">
                Want other jobs, an AI operator or your own steps?{" "}
                <Link className="link" to="/create?mode=custom">
                  Use Custom launch
                </Link>
                .
              </p>
            </Details>
          ) : null}
          {comingSoon ? (
            <Alert tone="info" title="Coming soon on this network">
              {FEES_TO_TOKEN_NOT_LIVE}
            </Alert>
          ) : null}
        </div>
      </Panel>

      <KeySection />

      <QuickReview
        q={q}
        conv={conv}
        autopilotBytes={autopilot !== null && autopilot.ok ? autopilot.bytes : null}
        seed={seed}
        started={started}
        onStarted={(id) => {
          onStarted(id);
          setSeed(freshSeed());
        }}
        onTried={() => setTried(true)}
        comingSoon={comingSoon}
        connection={connection}
        png={pngNow ?? null}
        stored={icon.shown}
      />
    </div>
  );
}

// --------------------------------------------------------------- the cards ---

function DestinationCard({ id, on, onPick, soon }: { id: FeeDestination; on: boolean; onPick: () => void; soon: boolean }): ReactNode {
  const t = DESTINATION_TEXT[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className="ql-card"
      data-dest={id}
      data-on={on ? "" : undefined}
      onClick={() => {
        if (!on) sfx.play("toggle");
        onPick();
      }}
    >
      <span className="ql-card-art" aria-hidden="true">
        <NoiseArt scene={cardScene(id)} />
      </span>
      <span className="ql-card-top">
        <span className="ql-card-title">{t.title}</span>
        <span className="cr-preset-radio" aria-hidden="true" />
      </span>
      <span className="ql-card-line">{t.line}</span>
      {soon ? <span className="ql-card-soon">Coming soon here · try it in the demo</span> : null}
    </button>
  );
}

// ------------------------------------------------------------- the key ---

function KeySection(): ReactNode {
  const key = usePqKey();
  const id = key.identity.idHex;
  const ready = key.status === "unlocked" && id !== null;
  return (
    <section className="ql-key" aria-labelledby="ql-key-title">
      <h2 className="ql-h" id="ql-key-title">
        <span className="ql-n" aria-hidden="true">
          2
        </span>{" "}
        Sign with your quantum key
      </h2>
      {ready ? (
        <Alert tone="ok" title="Ready to sign">
          Key ID {shortId(id)} will sign this launch, not your wallet. It never leaves this page.
        </Alert>
      ) : key.status === "unlocked" && key.identity.status === "deriving" ? (
        <p className="pg-wait" role="status">
          Preparing your key… {Math.round(key.identity.progress * 100)}%
        </p>
      ) : (
        <QuantumKeyPanel use="It signs your launch (not your wallet), so it can open." />
      )}
    </section>
  );
}

// ---------------------------------------------------------- the review ---

function QuickReview({
  q,
  conv,
  autopilotBytes,
  seed,
  started,
  onStarted,
  onTried,
  comingSoon,
  connection,
  png,
  stored,
}: {
  png: Uint8Array | null;
  /** The logo the record stores (the last one made). */
  stored: StoredIcon | undefined;
  q: QuickState;
  conv: ReturnType<typeof convertDraft>;
  autopilotBytes: Uint8Array | null;
  seed: Uint8Array;
  started: string | null;
  onStarted: (id: string) => void;
  onTried: () => void;
  comingSoon: boolean;
  connection: ReturnType<typeof useConnection>["connection"];
}): ReactNode {
  const owner = useOwner();
  const key = usePqKey();
  const flows = useLaunchFlows();
  useNow();
  const me = owner.publicKey;
  const [ack, setAck] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<FundingEstimate | null>(null);
  const view = started === null ? null : (flows.find((f) => f.id === started) ?? null);
  const keyReady = key.status === "unlocked" && key.identity.idHex !== null;
  // What still blocks the launch, once each (the key and the wallet have their own lines below).
  const skip = (f: string): boolean => f === "pqIdentity" || f.startsWith("recipients");
  const problems = [
    ...Object.entries(conv.inputErrors).filter(([f]) => !skip(f)),
    ...conv.policyErrors.map((e) => [splitError(e).field, splitError(e).message] as const).filter(([f]) => !skip(f) && conv.inputErrors[f] === undefined),
  ];
  const recipientsOk = me !== null && !Object.keys(conv.inputErrors).some((f) => f.startsWith("recipients")) && !conv.policyErrors.some((e) => splitError(e).field.startsWith("recipients"));
  const valid = conv.params !== null && problems.length === 0 && recipientsOk && conv.metadataReady && (autopilotBytes !== null || !needsAutopilot(q.destination));
  const canLaunch = valid && ack && me !== null && keyReady && !starting && !comingSoon;
  const fair = PRESETS[QUICK_PRESET].params;
  const graphLines = useMemo(() => (autopilotBytes === null ? [] : explainGraphLines(autopilotBytes, false, conv.params?.tokenDecimal ?? 6, "short")), [autopilotBytes, conv.params?.tokenDecimal]);

  const recordKey = conv.metadataReady ? `${conv.recordBytes}:${autopilotBytes?.length ?? 0}` : "";
  useEffect(() => {
    let alive = true;
    if (recordKey === "" || conv.recordBytes === 0) return;
    estimateLaunchFunding(phx, connection, conv.metadata, autopilotBytes === null ? null : autopilotBytes.length).then(
      (e) => alive && setEstimate(e),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [connection, recordKey]);

  const launch = async (): Promise<void> => {
    onTried();
    if (!canLaunch || conv.params === null || me === null) return;
    setStarting(true);
    setError(null);
    try {
      const identity = await launchIdentity(CLUSTER);
      // The SDK plans the same launch from the same form (planQuickLaunch): its parameters, fee recipients (the wallet,
      // the launch's own Autopilot treasury, or both), record and buyback are what is launched, and they must be exactly
      // the ones reviewed here. (It needs a logo; without one, the reviewed values go as they are.)
      let launchWith: { params: typeof conv.params; metadata: TokenMetaInput; autopilot: Uint8Array | null } = { params: conv.params, metadata: conv.metadata, autopilot: autopilotBytes };
      if (png !== null) {
        const plan = planQuickLaunch(quickPlanInput(q, { creator: me, identity: identity.identityId, launchSeed: seed, iconPng: png }));
        const same =
          toHex(launchParamsHash(plan.params)) === toHex(launchParamsHash(conv.params)) &&
          toHex(metadataHashV2(plan.metadata)) === toHex(metadataHashV2(conv.metadata)) &&
          (plan.graph === null ? autopilotBytes === null : autopilotBytes !== null && toHex(plan.graph.bytes) === toHex(autopilotBytes));
        if (!same) throw new Error("The launch planned from your choices differs from the one you reviewed, so nothing was signed. Reload the page and try again.");
        launchWith = { params: plan.params, metadata: plan.metadata, autopilot: plan.graph === null ? null : plan.graph.bytes };
      }
      const id = await startLaunchFlow({
        cluster: CLUSTER,
        creator: me,
        params: launchWith.params,
        metadata: launchWith.metadata,
        identityIndex: 0,
        lmsPublicKey: identity.keyPair.publicKey,
        opensAt: "asap",
        launchSeed: seed,
        autopilot: launchWith.autopilot,
      });
      sfx.play("success");
      onStarted(id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const dest = DESTINATION_TEXT[q.destination].title;
  const stages = stagesOf({ autopilot: autopilotBytes !== null }).filter((s): s is Exclude<FlowStage, "done"> => s !== "done");
  return (
    <section className="ql-review" aria-labelledby="ql-review-title">
      <h2 className="ql-h" id="ql-review-title">
        <span className="ql-n" aria-hidden="true">
          3
        </span>{" "}
        Review and launch
      </h2>
      <Panel className="cr-launch ql-launch" tone={view !== null || canLaunch ? "signal" : undefined}>
        {view !== null ? (
          <LaunchTracker view={view} />
        ) : (
          <>
            <div className="ql-sum">
              <IconCard icon={q.meta.icon} stored={stored} name={q.name} symbol={q.symbol} />
              <Readout label="Your launch">
                <Row k="Name">{q.name.trim() || "—"}</Row>
                <Row k="Ticker">{q.symbol.trim() ? `$${q.symbol.trim()}` : "—"}</Row>
                <Row k="Logo">{iconSummary(stored)}</Row>
                {xHandle(q.meta) !== "" ? <Row k="X">@{xHandle(q.meta)}</Row> : null}
                {q.meta.website.trim() !== "" ? <Row k="Website">{q.meta.website.trim()}</Row> : null}
                <Row k="Trading fee">{feeText(q.feeBps)}</Row>
                <Row k="Fees go">{q.destination === "split" ? `${q.walletPct}% to your wallet, ${100 - q.walletPct}% back into the token` : dest}</Row>
              </Readout>
            </div>
            {graphLines.length > 0 ? (
              <div className="ql-ap">
                <p className="pg-label">Autopilot your quantum key switches on after the launch opens</p>
                <ol className="rl-plain">
                  {graphLines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ol>
                <Comment>A first Autopilot starts right away: there is no waiting period. Only a later change would wait 72 hours, in public.</Comment>
              </div>
            ) : null}
            <Details summary="Everything else: the safe Fair preset" className="ql-preset">
              <ul className="ql-fact-list">
                <li>Everyone starts together in a {describeSeconds(fair.openDelaySecs)} opening batch at the same price: nothing to snipe.</li>
                <li>For {describeSeconds(fair.guardSecs)} no wallet can hold more than {fair.maxWalletBps / 100}% of the supply. Selling is never blocked.</li>
                <li>It graduates at {formatSolExact(fair.migrationQuoteThreshold)} raised; its liquidity is then locked forever.</li>
                <li>No admin key: no one, including you, can mint more, freeze anyone or change these values.</li>
              </ul>
            </Details>
            <div className="cr-plan">
              <p className="cr-plan-head">What happens when you launch</p>
              <ol className="lt-steps" aria-label="Launch steps">
                {stages.map((s, i) => {
                  const t = stepText(s, { fundLamports: estimate?.total ?? null, window: null });
                  return (
                    <li key={s} className="lt-step" data-state="todo">
                      <span className="lt-node" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="lt-step-text">
                        <span className="lt-step-label">{s === "open" ? "Opens about a minute after it is signed" : t.label}</span>
                        <span className="lt-step-hint">{t.hint}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              {estimate !== null ? (
                <Comment>
                  Step 2 sends about {formatSol(estimate.total, 4)}
                  {estimate.autopilot > 0n ? `, ${formatSol(estimate.autopilot, 4)} of it to switch on the Autopilot` : ""}. Everything not spent comes back to your wallet.
                </Comment>
              ) : null}
            </div>
            <Toggle checked={ack} onChange={setAck}>
              I understand these values are permanent once the launch is created, and that I get no tokens unless I join the opening batch like everyone else.
            </Toggle>
            <ul className="ql-reasons">
              {!me ? <li>Connect a wallet to launch.</li> : null}
              {!keyReady ? <li>Unlock your quantum key (step 2).</li> : null}
              {problems.map(([f, m]) => (
                <li key={`${f}${m}`}>{plainProblem(f, m)}</li>
              ))}
              {!conv.metadataReady ? <li>Preparing your logo…</li> : null}
            </ul>
            <div className="pg-btns">
              <Button variant="primary" loading={starting} disabled={!canLaunch} onClick={() => void launch()}>
                Launch {q.symbol.trim() ? `$${q.symbol.trim()}` : "my token"}
              </Button>
              <Chip tone="muted">Your wallet signs twice · your quantum key signs {autopilotBytes !== null ? "twice" : "once"}</Chip>
            </div>
            {error !== null ? <Alert tone="fail">{error}</Alert> : null}
            <Comment>Keep this tab open until your launch has opened. If you close it, everything picks up again when you come back.</Comment>
          </>
        )}
      </Panel>
    </section>
  );
}

/** A problem of the quick form in plain words (only the fields this screen shows). */
function plainProblem(field: string, message: string): string {
  const m = message.replace(/^is /, "");
  if (field === "name") return `Name: ${m}`;
  if (field === "symbol") return `Ticker: ${m}`;
  if (field === "website") return `Website: ${m}`;
  if (field === "x") return `X link: ${m}`;
  if (field === "icon") return `Logo: ${m}`;
  if (field.startsWith("recipients")) return "Connect a wallet: your fees are paid to it.";
  return `${field}: ${m}`;
}
