/**
 * A token's Autopilot (PROGRAMMABLE_V1 §6): automatic buybacks, burns and
 * payouts from the token's treasury. Simple first (owner's direction): four
 * jobs switched on with sliders and a plain sentence each; Advanced: the
 * pixel graph canvas and the code. Then a simulation with the pool's real fee,
 * "Review and sign" with the creator's quantum key (72 hours for a change,
 * "Freeze forever"), "Run now" for anyone (with a tip) and the history.
 *
 * Route: #/token/:address/autopilot (the mint, or the Launch account before
 * launch). The page never decides what is allowed: the chain verifies the
 * same bytes, and the simulator runs the same limits. Where Autopilot is not
 * live yet (live builds) it can be built and simulated; switching it on says
 * "coming soon".
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";

import { useAsync, useNow } from "../../app/hooks";
import { CLUSTER } from "../../app/settings";
import { ownTitle } from "../../app/titles";
import { useOwner } from "../../app/wallet";
import { Address, Alert } from "../../components/ui";
import { DotSpinner } from "../../fx/noise";
import { formatSol } from "../../lib/amounts";
import { shortKey, toHex } from "../../lib/format";
import {
  fetchAutopilot,
  fetchGraphBytes,
  fetchLaunch,
  fetchLaunchByMint,
  fetchMigrationPrice,
  findDueSteps,
  listAutopilotRuns,
  MIGRATION_FEE_TIERS_BPS,
  PROGRAMMABLE_AVAILABLE,
  type AutopilotInfo,
  type LaunchAccount,
} from "../../lib/noised";
import { launchIdentity, usePqKey } from "../../lib/pqKey";
import { buildCanvas, canvasOf, explainGraphLines, graphFromBytes, graphHashOf, priceOf, type Canvas, type GraphBuild } from "../../lib/programmable";
import { QuantumKeyPanel } from "../quantumkey/QuantumKeyPanel";
import { Chip, Crumbs, Grad, Metric, NoteBox, PageHead, Panel, Tabs, tabPanel, Tiles, type KitTone } from "../inner/kit";
import { AiAgentPanel } from "./AiAgentPanel";
import { AutopilotEditor } from "./AutopilotEditor";
import { AutopilotSimple } from "./AutopilotSimple";
import { emptyCanvas, graphOrNull } from "./editor";
import { PayeeCheck, usePayeeCheck } from "./PayeeCheck";
import { PendingChange } from "./PendingChange";
import { ReviewPanel } from "./ReviewPanel";
import { RunPanel } from "./RunPanel";
import { composeJobs, defaultChoices, jobsOn, type Choices, type JobContext } from "./simple";
import { SimPanel, type SimContext } from "./SimPanel";
import "../create/create.css";
import "../create/rules/rules.css";
import "./autopilot.css";
import "./autopilot-page.css";

export function AutopilotPage(): ReactNode {
  const { address = "" } = useParams();
  let key: PublicKey | null = null;
  try {
    key = new PublicKey(address);
  } catch {
    key = null;
  }
  if (!key) {
    return (
      <div className="pg">
        <Crumbs here="Autopilot" />
        <Alert tone="fail" title="Not a valid address">
          <code className="pg-break">{address}</code> is not a Solana address.
        </Alert>
      </div>
    );
  }
  return <AutopilotResolver key={key.toBase58()} address={key} />;
}

function AutopilotResolver({ address }: { address: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const r = useAsync(async () => (await fetchLaunchByMint(connection, address)) ?? (await fetchLaunch(connection, address)), [connection, address.toBase58()], { watchChain: false });
  if (r.error) {
    return (
      <div className="pg">
        <Crumbs here="Autopilot" />
        <Alert tone="fail" title="Could not load this token">
          {r.error}
        </Alert>
      </div>
    );
  }
  if (r.data === undefined) {
    return (
      <div className="pg pg-loading">
        <DotSpinner size={48} decorative />
        <p className="pg-wait" role="status">
          Reading the token…
        </p>
      </div>
    );
  }
  if (r.data === null) {
    return (
      <div className="pg">
        <Crumbs here="Autopilot" />
        <Alert tone="fail" title="Not a Noised launch">
          <code className="pg-break">{address.toBase58()}</code> is not a token launched on Noised, so it has no Autopilot.
        </Alert>
      </div>
    );
  }
  return <AutopilotView launch={r.data} />;
}

/** Undo history for the editor (the last 40 canvases). */
function useCanvasHistory(initial: Canvas): { canvas: Canvas; set: (c: Canvas) => void; reset: (c: Canvas) => void; undo: () => void; canUndo: boolean } {
  const [state, setState] = useState<{ canvas: Canvas; past: Canvas[] }>({ canvas: initial, past: [] });
  const set = useCallback((c: Canvas) => setState((s) => (c === s.canvas ? s : { canvas: c, past: [...s.past.slice(-39), s.canvas] })), []);
  const reset = useCallback((c: Canvas) => setState({ canvas: c, past: [] }), []);
  const undo = useCallback(() => setState((s) => (s.past.length === 0 ? s : { canvas: s.past[s.past.length - 1] as Canvas, past: s.past.slice(0, -1) })), []);
  return { canvas: state.canvas, set, reset, undo, canUndo: state.past.length > 0 };
}

export function statusOf(info: AutopilotInfo | null): { label: string; tone: KitTone } {
  if (info === null) return { label: "Not set up", tone: "muted" };
  if (info.frozen) return { label: "Frozen forever", tone: "ok" };
  if (info.graphHash === null) return info.pending ? { label: "Starting soon", tone: "signal" } : { label: "Off", tone: "muted" };
  if (info.pending) return { label: "Change scheduled", tone: "warn" };
  return { label: "Running", tone: "ok" };
}

type Mode = "simple" | "advanced";
/** Where the steps on screen came from: the Simple jobs, the Advanced editor, or the chain (what runs now). */
type Source = "simple" | "advanced" | "running";

function AutopilotView({ launch }: { launch: LaunchAccount }): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const now = useNow();
  const lk = launch.publicKey.toBase58();
  const symbol = launch.market?.symbol ?? "TOKEN";
  const decimals = launch.tokenDecimal;
  const idBase = `ap${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const key = usePqKey();
  const isCreator = owner.publicKey !== null && owner.publicKey.equals(launch.creator);
  // The launch identity of an unlocked key, ready before anything is signed.
  useEffect(() => {
    if (key.status === "unlocked" && key.identity.status === "idle") void launchIdentity(CLUSTER).catch(() => undefined);
  }, [key.status, key.identity.status]);
  useEffect(() => {
    document.title = ownTitle(`${symbol} Autopilot`);
  }, [symbol]);

  const ap = useAsync(() => fetchAutopilot(connection, launch.publicKey), [connection, lk]);
  const info = ap.data ?? null;
  const activeHex = info?.graphHash ? toHex(info.graphHash) : null;
  const active = useAsync(async () => (info?.graphHash ? fetchGraphBytes(connection, launch.publicKey, info.graphHash) : null), [connection, lk, activeHex]);
  // Only the bytes of the running graph (never a previous result kept while the new one loads).
  const activeGraph = useMemo(
    () => (active.data && activeHex !== null && toHex(graphHashOf(active.data)) === activeHex ? graphFromBytes(active.data, decimals) : null),
    [active.data, activeHex, decimals],
  );
  const runs = useAsync(() => listAutopilotRuns(connection, launch.publicKey), [connection, lk]);
  const due = useAsync(() => findDueSteps(connection, launch.publicKey, owner.publicKey), [connection, lk, owner.publicKey?.toBase58(), Math.floor(now / 15)]);
  const migration = useAsync(() => fetchMigrationPrice(connection, launch.publicKey), [connection, lk], { watchChain: false });

  // The steps on screen: from the Simple jobs, the editor, or (first) what runs now. Chain refreshes never overwrite edits.
  const history = useCanvasHistory(emptyCanvas(decimals));
  const { reset } = history;
  const [mode, setMode] = useState<Mode>("simple");
  const [source, setSource] = useState<Source>("simple");
  const [choices, setChoices] = useState<Choices>(defaultChoices);
  const [selected, setSelected] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (ap.data === undefined) return;
    if (activeHex !== null && (!active.data || toHex(graphHashOf(active.data)) !== activeHex)) return;
    if (loaded.current !== null) return;
    loaded.current = activeHex ?? "none";
    if (activeGraph !== null) {
      reset(canvasOf({ ...activeGraph, tokenDecimals: decimals }));
      setSource("running");
    }
  }, [ap.data, active.data, activeGraph, activeHex, decimals, reset]);

  const poolFeeBps = info !== null && info.graduated ? info.poolFeeBps : (MIGRATION_FEE_TIERS_BPS[launch.migrationFeeOption] ?? 100);
  const recipients = useMemo(
    () =>
      launch.recipients
        .slice(0, launch.recipientCount)
        .filter((r) => info === null || !r.wallet.equals(info.treasury))
        .map((r) => ({ address: r.wallet.toBase58(), bps: r.bps })),
    [launch.recipients, launch.recipientCount, info],
  );
  // Shares of the listed recipients must add up to 100%: the treasury's own share (if it is a fee recipient) is spread back.
  const jobCtx = useMemo<JobContext>(() => ({ symbol, decimals, poolFeeBps, recipients: normalized(recipients) }), [symbol, decimals, poolFeeBps, recipients]);
  const composed = useMemo(() => composeJobs(choices, jobCtx), [choices, jobCtx]);

  const onChoices = (c: Choices): void => {
    setChoices(c);
    setSource("simple");
    const next = composeJobs(c, jobCtx);
    history.set(next.graph !== null ? canvasOf(next.graph) : emptyCanvas(decimals));
  };
  const onCanvas = (c: Canvas): void => {
    history.set(c);
    setSource("advanced");
  };

  const canvas = history.canvas;
  const build: GraphBuild = useMemo(
    () =>
      source === "simple" && jobsOn(choices) > 0 && composed.build === null
        ? { ok: false, issues: Object.values(composed.problems).map((message) => ({ code: "BadModel", message })) }
        : canvas.nodes.length === 0
          ? { ok: false, issues: [{ code: "BadModel", message: "Switch a job on, or add a step under Advanced." }] }
          : buildCanvas(canvas),
    [canvas, source, choices, composed],
  ) as GraphBuild;
  const buildHex = build.ok ? toHex(build.hash) : null;
  const published = useAsync(async () => (build.ok ? (await fetchGraphBytes(connection, launch.publicKey, build.hash)) !== null : false), [connection, lk, buildHex]);
  const graph = useMemo(() => (build.ok ? build.graph : graphOrNull(canvas)), [build, canvas]);
  // SDK 0.9.0: the payees checked on the chain (a payee that could never receive blocks publishing and signing).
  const payees = usePayeeCheck(build.ok ? build.graph : null);
  const [pulse, setPulse] = useState<string | null>(null);
  useEffect(() => {
    if (pulse === null) return;
    const t = window.setTimeout(() => setPulse(null), 2600);
    return () => window.clearTimeout(t);
  }, [pulse]);

  const status = statusOf(info);
  const frozen = info?.frozen === true;
  const graduated = launch.market?.migrated === true;
  const spot = launch.market?.sqrtPrice ?? 0n;
  const simCtx = useMemo<SimContext>(() => {
    const ref = info !== null && info.refSqrtPrice > 0n ? info.refSqrtPrice : (migration.data ?? 0n);
    const startPrice = spot > 0n ? priceOf(spot, decimals) : ref > 0n ? priceOf(ref, decimals) : 0.000001;
    return {
      startTime: Math.floor(now / 60) * 60,
      startPrice,
      // Where the reference starts: the autopilot's own, else the launch's migration price (unknown on a live build: the price now).
      refPrice: ref > 0n ? priceOf(ref, decimals) : startPrice,
      treasurySol: info?.treasurySol ?? 2_000_000_000n,
      treasuryTokens: info?.treasuryTokens ?? 0n,
      supply: launch.market?.supply ?? 1_000_000_000n * 10n ** BigInt(decimals),
      decimals,
      poolFeeBps,
      // The pool's SOL once graduated; before that, what migration puts in it (the whole raise).
      poolSol: info !== null && info.poolSol > 0n ? info.poolSol : launch.migrationQuoteThreshold > 0n ? launch.migrationQuoteThreshold : null,
    };
    // A stable start (the minute), so the simulation does not re-run every second.
  }, [info, migration.data, spot, decimals, launch.market?.supply, launch.migrationQuoteThreshold, poolFeeBps, Math.floor(now / 60)]);
  // Today's prices, for the editor's warning on a price limit close to them (follow-up review L-1): the autopilot's
  // reference (else the migration price it starts from) and, once graduated, the pool's price.
  const pricesNow = useMemo(() => {
    const ref = info !== null && info.refSqrtPrice > 0n ? info.refSqrtPrice : (migration.data ?? 0n);
    return [ref, graduated ? spot : 0n].filter((p) => p > 0n);
  }, [info, migration.data, graduated, spot]);
  const nextDue = due.data?.[0];
  const reloadAll = (): void => {
    ap.reload();
    runs.reload();
    due.reload();
    published.reload();
  };
  const tokenPath = `/token/${(launch.status === "live" ? launch.baseMint : launch.publicKey).toBase58()}`;

  return (
    <div className="pg ap">
      <Crumbs here="Autopilot" to={tokenPath} back={symbol} />
      <PageHead
        eyebrow={`Autopilot · ${symbol}`}
        title={
          <>
            Put <Grad>{symbol}</Grad> on autopilot
          </>
        }
        lede={
          <>
            Automatic buybacks, burns and payouts from {symbol}'s treasury. Pick what it does and move the sliders. Anyone can run a step when it is due and earn a small tip, so
            it keeps going without you. <strong>It can never sell {symbol}, pull liquidity, mint, or pay anyone you didn't list.</strong>
          </>
        }
      />

      {!PROGRAMMABLE_AVAILABLE ? (
        <Alert tone="info" title="Coming soon on this network">
          Autopilot is not live here yet. You can pick its jobs and try them in the simulation; switching one on comes next. The demo shows the whole flow.
        </Alert>
      ) : null}

      <Tiles label="Autopilot at a glance">
        <Metric label="Status" value={<Chip tone={status.tone} pulse={status.label === "Running"}>{status.label}</Chip>} hint={info?.operator ? "with an operator" : frozen ? "can never change" : "changes wait 72 hours"} />
        <Metric
          label="Treasury"
          value={info ? formatSol(info.treasurySol, 3).replace(" SOL", "") : "—"}
          unit="SOL"
          hint={info ? `${(Number(info.treasuryTokens) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol} held` : "not set up"}
        />
        <Metric
          label="Burned so far"
          value={info ? (Number(info.totalBurned) / 10 ** decimals).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : "—"}
          unit={symbol}
          hint={info ? `${formatSol(info.totalBoughtWithSol, 2)} spent on buybacks` : "nothing yet"}
        />
        <Metric label="Due now" value={String(due.data?.length ?? 0)} hint={nextDue ? (nextDue.tip > 0n ? `run it and earn up to ${formatSol(nextDue.tip, 6)}` : "anyone can run it") : "nothing to run right now"} tone={due.data && due.data.length > 0 ? "ok" : "muted"} />
      </Tiles>

      <Panel
        title={activeGraph ? "Running now" : "Nothing running yet"}
        description={activeGraph ? "What the chain runs for this token, in plain English." : "Pick what it does below, try it in the simulation, then sign it with the creator's quantum key."}
        status={<Chip tone={status.tone}>{status.label}</Chip>}
      >
        {activeGraph ? (
          <ol className="rl-plain">
            {explainGraphLines(activeGraph, false).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        ) : null}
        {info !== null && info.pending ? <PendingChange launch={launch} info={info} running={activeGraph} /> : null}
        <ul className="rl-promises" aria-label="What an autopilot can never do">
          <li>It never sells {symbol}: treasury SOL only buys {symbol} back, and every token it buys is burned in the same step.</li>
          <li>It can't touch the locked liquidity, mint new tokens or freeze anyone.</li>
          <li>It pays only the recipients listed in its steps, plus a small tip to whoever runs a due step.</li>
          <li>Every step has a budget and a run limit per period. Changes wait 72 hours in public; a frozen autopilot never changes.</li>
        </ul>
        {info ? (
          <p className="ap-treasury">
            <span className="pg-label">Treasury address</span> <Address value={info.treasury} explorer />
            <span className="ap-muted"> Fees reach it when the launch lists it as a fee recipient.</span>
          </p>
        ) : null}
      </Panel>

      <Panel
        title="What it does"
        description={frozen ? "Frozen forever: you can look and simulate, and anyone can run due steps, but nobody can change it." : "Switch jobs on and move the sliders. Advanced shows the same steps as a graph you can edit, or as code."}
        className="ap-build"
      >
        <Tabs<Mode>
          items={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced: graph and code" },
          ]}
          value={mode}
          onChange={setMode}
          label="Edit the autopilot"
          idBase={idBase}
        />
        <div {...tabPanel(idBase, "simple", mode)}>
          {source !== "simple" && canvas.nodes.length > 0 ? (
            <NoteBox title={source === "running" ? "These are the steps running now" : "You changed the steps under Advanced"}>
              {source === "running" ? "Switching a job on below starts a new set of steps, which you sign and which waits 72 hours." : "Switching a job on below starts over from the jobs (Undo under Advanced brings your steps back)."}
            </NoteBox>
          ) : null}
          <AutopilotSimple choices={choices} onChoices={onChoices} ctx={jobCtx} problems={source === "simple" ? composed.problems : {}} readOnly={frozen} />
          {build.ok ? (
            <div className="ap-summary">
              <p className="pg-label">In plain English</p>
              <ol className="rl-plain">
                {explainGraphLines(build.graph, true).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
        <div {...tabPanel(idBase, "advanced", mode)}>
          <AutopilotEditor
            canvas={canvas}
            onCanvas={onCanvas}
            selected={selected}
            onSelect={setSelected}
            readOnly={frozen}
            defaults={{ recipients: jobCtx.recipients, operator: owner.publicKey?.toBase58() ?? null }}
            now={now}
            build={build}
            canUndo={history.canUndo}
            onUndo={history.undo}
            pulse={pulse}
            poolFeeBps={poolFeeBps}
            pricesNow={pricesNow}
          />
        </div>
        {frozen ? null : <PayeeCheck check={payees} />}
      </Panel>

      <AiAgentPanel
        templateOn={source === "simple" && choices.ai.on}
        {...(frozen
          ? {}
          : {
              onUseTemplate: () => {
                onChoices({ ...choices, ai: { ...choices.ai, on: true, operator: choices.ai.operator || (owner.publicKey?.toBase58() ?? "") } });
                setMode("simple");
              },
            })}
      />

      <SimPanel graph={graph} ctx={simCtx} graduated={graduated} />

      <ReviewPanel launch={launch} info={info} build={build} running={activeGraph} published={published.data === true} now={now} onChanged={reloadAll} payeeRefusals={payees?.refusals ?? []} />
      {/* The creator signs with the quantum key that signed the launch: unlock it right here. */}
      {PROGRAMMABLE_AVAILABLE && isCreator && key.identity.idHex !== toHex(launch.pqIdentity) ? <QuantumKeyPanel use="It signs every change to this token's autopilot." /> : null}

      <RunPanel
        launch={launch}
        info={info}
        graph={activeGraph}
        due={due.data ?? []}
        runs={runs.data ?? []}
        now={now}
        onRan={(id) => {
          setPulse(id);
          reloadAll();
        }}
      />

      {info && info.graphHash ? (
        <NoteBox title="Check it yourself">
          Running fingerprint <code className="pg-break">{toHex(info.graphHash)}</code>. Autopilot account <code>{shortKey(info.address, 6)}</code>.{" "}
          <Link className="link" to={tokenPath}>
            Back to {symbol}
          </Link>
          .
        </NoteBox>
      ) : null}
    </div>
  );
}

/** Recipients scaled so their shares add up to 100% (a graph's must), keeping their order. */
function normalized(rs: { address: string; bps: number }[]): { address: string; bps: number }[] {
  const total = rs.reduce((s, r) => s + r.bps, 0);
  if (total === 10_000 || total === 0) return rs;
  const out = rs.map((r) => ({ address: r.address, bps: Math.floor((r.bps * 10_000) / total) }));
  const left = 10_000 - out.reduce((s, r) => s + r.bps, 0);
  if (out[0]) out[0].bps += left;
  return out;
}
