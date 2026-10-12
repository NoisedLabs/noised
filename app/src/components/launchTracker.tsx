/**
 * The launch tracker: the six steps of a creator's launch in plain words
 * (lib/launchFlow.ts runs them), what is going on now, and the one thing the
 * person may need to do (approve in the wallet, unlock the quantum key, pick
 * a new opening time, sign again after a signature that did not count).
 *
 * `LaunchFlowKeeper` (mounted once, in App) gives the runners what they need
 * from the page: the connection, the wallet, the review dialog, the quantum
 * key and the cluster check, and resumes this browser's unfinished launches
 * after a reload. Launches keep going on any page while the tab is open: the
 * launch opens at its time by itself.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";

import { chainClockOffset, useNow } from "../app/hooks";
import { useNetwork } from "../app/network";
import { CLUSTER } from "../app/settings";
import { useTx } from "../app/tx";
import { useOwner } from "../app/wallet";
import { DotSpinner } from "../fx/noise";
import { formatSol } from "../lib/amounts";
import { clusterRefusal } from "../lib/clusterGate";
import { formatClock, formatTimestamp, shortKey } from "../lib/format";
import {
  burnReasonText,
  configureLaunchFlows,
  idbLaunchStore,
  kickLaunchFlows,
  launchFlowAction,
  launchFlowViews,
  LaunchStorageError,
  resumeLaunchFlows,
  stagesOf,
  subscribeLaunchFlows,
  type FlowStage,
  type FlowView,
  type LaunchProgressStore,
} from "../lib/launchFlow";
import { ADAPTER_MODE, checkCluster } from "../lib/noised";
import * as phx from "../lib/noised";
import { launchSigner, pqKeyState, subscribePqKey } from "../lib/pqKey";
import { isoOf, utcText } from "../lib/signErrors";
import { QuantumKeyPanel } from "../pages/quantumkey/QuantumKeyPanel";
import { secondConnection } from "../app/secondRpc";
import { KeyUsedElsewhere } from "./KeyUsedElsewhere";
import { Alert, Button } from "./ui";
import "./launchTracker.css";

// ------------------------------------------------------------- the keeper ---

/** A store that refuses: this browser cannot keep a launch's progress, so nothing is started. */
const NO_STORE: LaunchProgressStore = {
  get: async () => null,
  list: async () => [],
  put: async () => {
    throw new LaunchStorageError("This browser cannot save your launch's progress here (no IndexedDB: a private window may block it), so nothing was started or sent.");
  },
};

function browserStore(): LaunchProgressStore {
  try {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return f === undefined ? NO_STORE : idbLaunchStore(f);
  } catch {
    return NO_STORE;
  }
}

/** `navigator.locks` (one tab at a time per launch); without it, only this tab's own ticks are serialized. */
function browserLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request: (n: string, o: { mode: "exclusive" }, f: () => Promise<T>) => Promise<T> } } }).navigator?.locks;
  return locks === undefined ? fn() : locks.request(name, { mode: "exclusive" }, fn);
}

/** Gives the launch runners the page's connection, wallet, review dialog and quantum key, and resumes them after a reload. */
export function LaunchFlowKeeper(): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const { run } = useTx();
  const network = useNetwork();
  const store = useMemo(browserStore, []);
  const latest = useRef({ owner: owner.publicKey, run, cluster: network.cluster });
  latest.current = { owner: owner.publicKey, run, cluster: network.cluster };

  useEffect(() => {
    configureLaunchFlows({
      conn: connection,
      cluster: CLUSTER,
      store,
      backend: phx,
      wallet: () => latest.current.owner,
      walletTx: async (step) => {
        const o = await latest.current.run({ title: step.title, summary: step.summary, build: step.build });
        return o.status === "confirmed" ? { status: "confirmed", signature: o.signature } : o.status === "cancelled" ? { status: "cancelled" } : { status: "failed", error: o.error };
      },
      // The key, this browser's leaf ledger and its cross-tab lock (the quantum signature's signingLock: SDK 0.9.0).
      signer: (index) => launchSigner(CLUSTER, index),
      // Another endpoint of this build, when it lists one: the network's clock must agree there too.
      secondConnection: () => secondConnection(connection.rpcEndpoint),
      keyUnlocked: () => pqKeyState().status === "unlocked",
      now: async () => BigInt(Math.floor(Date.now() / 1000) + chainClockOffset()),
      clusterRefusal: async () => {
        const cached = latest.current.cluster;
        const c = cached !== null && cached.state === "match" ? cached : await checkCluster(connection, CLUSTER);
        return clusterRefusal(c, CLUSTER, ADAPTER_MODE);
      },
      lock: browserLock,
    });
    void resumeLaunchFlows();
  }, [connection, store]);

  // A wallet that connects, or a quantum key that unlocks (its launch identity ready), lets waiting launches go on.
  // Only those changes: the key's progress while it is being prepared is not a reason to read the chain again.
  useEffect(() => kickLaunchFlows(), [owner.publicKey?.toBase58()]);
  useEffect(() => {
    let last = keyReadiness();
    return subscribePqKey(() => {
      const now = keyReadiness();
      if (now !== last) {
        last = now;
        kickLaunchFlows();
      }
    });
  }, []);
  return null;
}

/** "locked", "unlocked" or "ready" (unlocked with its launch identity prepared or failed). */
function keyReadiness(): string {
  const k = pqKeyState();
  return k.status === "locked" ? "locked" : k.identity.status === "ready" || k.identity.status === "error" ? "ready" : "unlocked";
}

/** Every launch this browser runs. */
export function useLaunchFlows(): readonly FlowView[] {
  return useSyncExternalStore(subscribeLaunchFlows, launchFlowViews, launchFlowViews);
}

// ------------------------------------------------------------ the picker ---

/** "As soon as it's signed" or a time picked by the person (unix seconds), as the tracker and the wizard take it. */
export type OpeningChoice = "asap" | bigint;

/** The latest a launch may open after its signature (7 days, the program's limit), less an hour of room. */
const MAX_LEAD_SECS = 7 * 86_400 - 3_600;

/** `datetime-local` value (local time, minutes) of unix seconds. */
function localInput(secs: number): string {
  const d = new Date(secs * 1000);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Why a picked opening time cannot be used, in plain words (null: it can). */
export function openingProblem(choice: OpeningChoice, nowSecs: number): string | null {
  if (choice === "asap") return null;
  const t = Number(choice);
  if (!Number.isFinite(t)) return "Pick a date and time.";
  if (t < nowSecs + 120) return "Pick a time at least 2 minutes from now.";
  if (t > nowSecs + MAX_LEAD_SECS) return "Pick a time within the next 6 days.";
  return null;
}

export function OpeningPicker({ value, onChange, idBase }: { value: OpeningChoice; onChange: (v: OpeningChoice) => void; idBase: string }): ReactNode {
  const now = useNow();
  const [text, setText] = useState(() => localInput(now + 3_600));
  const problem = openingProblem(value, now);
  return (
    <fieldset className="lt-pick">
      <legend className="lt-pick-legend">When it opens</legend>
      <label className="lt-pick-opt">
        <input type="radio" name={`${idBase}-when`} checked={value === "asap"} onChange={() => onChange("asap")} />
        <span>
          <b>As soon as it&apos;s signed</b>
          <span className="lt-pick-sub">About a minute after your quantum key signs.</span>
        </span>
      </label>
      <label className="lt-pick-opt">
        <input
          type="radio"
          name={`${idBase}-when`}
          checked={value !== "asap"}
          onChange={() => {
            const t = Date.parse(text);
            onChange(Number.isFinite(t) ? BigInt(Math.floor(t / 1000)) : BigInt(now + 3_600));
          }}
        />
        <span>
          <b>At a time I pick</b>
          <span className="lt-pick-sub">Your computer&apos;s local time.</span>
        </span>
      </label>
      {value !== "asap" ? (
        <div className="lt-pick-time">
          <input
            id={`${idBase}-time`}
            className="input"
            type="datetime-local"
            aria-label="Opening time"
            value={text}
            min={localInput(now + 120)}
            onChange={(e) => {
              setText(e.target.value);
              const t = Date.parse(e.target.value);
              if (Number.isFinite(t)) onChange(BigInt(Math.floor(t / 1000)));
            }}
          />
          {problem !== null ? <p className="field-error">{problem}</p> : null}
        </div>
      ) : null}
      <p className="lt-pick-note">It stays open for one hour. Anyone can open it during that hour; this tab opens it right at the start if it is open.</p>
    </fieldset>
  );
}

// ----------------------------------------------------------- the tracker ---

/** The steps' words. */
export function stepText(stage: Exclude<FlowStage, "done">, v: Pick<FlowView, "fundLamports" | "window"> & { need?: FlowView["need"]; autopilotAt?: bigint | null }): { label: string; hint: string } {
  switch (stage) {
    case "create":
      return { label: "Create the launch", hint: "Your wallet signs. This records your launch's rules." };
    case "fund":
      return {
        label: "Fund a temporary fee account",
        hint: `Your wallet sends ${v.fundLamports === null ? "a small amount" : `about ${formatSol(v.fundLamports, 4)}`}. It pays for the next steps; what is left comes back.`,
      };
    case "publish":
      return { label: "Store the token details on Solana", hint: "Name, symbol, icon and description, kept on Solana itself." };
    case "sign":
      return { label: "Sign with your quantum key", hint: "Your quantum key signs, not your wallet. Only this signature lets the launch open." };
    case "open":
      return {
        label: v.need?.kind === "new-time" ? "Opens at the new time you pick" : v.window === null ? "Opens at the time you picked" : `Opens at ${formatTimestamp(v.window.notBefore)} (${utcText(v.window.notBefore)})`,
        hint: "This tab opens it right then if it is still open. Anyone can open it during the hour after.",
      };
    case "autopilot":
      return {
        label: "Switch on the Autopilot",
        hint:
          v.autopilotAt !== undefined && v.autopilotAt !== null
            ? `Your launch's quantum key signs it; it starts at ${formatTimestamp(v.autopilotAt)} (${utcText(v.autopilotAt)}). A first Autopilot has no waiting period.`
            : "Your launch's quantum key signs it, right after the launch opens. A first Autopilot has no waiting period.",
      };
    case "return":
      return { label: "Return the leftover SOL", hint: "What the temporary account did not spend goes back to your wallet." };
  }
}

/** The state of each step for the list. */
export function stepStates(v: Pick<FlowView, "stage" | "need" | "done"> & { autopilot?: boolean }): Record<Exclude<FlowStage, "done">, "done" | "current" | "todo" | "fail"> {
  const stages = stagesOf({ autopilot: v.autopilot === true });
  const at = v.done ? stages.length : Math.max(0, stages.indexOf(v.stage));
  const failed =
    v.need !== null &&
    (v.need.kind === "retry" || v.need.kind === "stopped" || v.need.kind === "sign-again" || v.need.kind === "new-time" || v.need.kind === "key-used-elsewhere" || v.need.kind === "signature-cap");
  const out = {} as Record<Exclude<FlowStage, "done">, "done" | "current" | "todo" | "fail">;
  stages.forEach((s, i) => {
    out[s as Exclude<FlowStage, "done">] = i < at ? "done" : i === at ? (failed ? "fail" : "current") : "todo";
  });
  return out;
}

export function LaunchTracker({ view, compact = false }: { view: FlowView; compact?: boolean }): ReactNode {
  const now = useNow();
  const states = stepStates(view);
  const v = view;
  const opensIn = v.window !== null && v.stage === "open" && !v.done ? Number(v.window.notBefore) - now : null;
  return (
    <section className="lt glass" aria-label={`Launch of ${v.name}`} data-compact={compact ? "" : undefined}>
      <header className="lt-head">
        <span className="lt-title">
          {v.name} <span className="lt-sym">{v.symbol}</span>
        </span>
        <span className="lt-status" role="status" aria-live="polite">
          {v.busy ? <DotSpinner size={14} decorative /> : null}
          <span>{v.done ? (v.abandoned ? "Stopped" : "Done") : v.activity}</span>
        </span>
      </header>
      <ol className="lt-steps" aria-label="Launch steps">
        {stagesOf(v).map((s, i) => {
          const key = s as Exclude<FlowStage, "done">;
          const t = stepText(key, v);
          return (
            <li key={s} className="lt-step" data-state={states[key]} aria-current={states[key] === "current" ? "step" : undefined}>
              <span className="lt-node" aria-hidden="true">
                {states[key] === "done" ? "✓" : i + 1}
              </span>
              <span className="lt-step-text">
                <span className="lt-step-label">{t.label}</span>
                <span className="lt-step-hint">{t.hint}</span>
                {key === "open" && opensIn !== null && opensIn > 0 ? <span className="lt-count">Opens in {formatClock(opensIn)}</span> : null}
                {key === "open" && v.window !== null && !v.done ? (
                  <span className="lt-step-hint">
                    Signed window: <time dateTime={isoOf(v.window.notBefore)}>{utcText(v.window.notBefore)}</time> to <time dateTime={isoOf(v.window.notAfter)}>{utcText(v.window.notAfter)}</time>
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {v.note !== null ? <Alert tone="info">{v.note}</Alert> : null}
      {!v.done && v.stage === "autopilot" && v.mint !== null ? (
        <Alert tone="ok" title="Your launch is open">
          <p>
            The opening batch is taking commits now. This tab is switching on its Autopilot.{" "}
            <Link className="link" to={`/token/${v.mint.toBase58()}`}>
              See your token
            </Link>
          </p>
        </Alert>
      ) : null}
      <NeedPanel view={v} />
      {v.done && !v.abandoned && v.mint !== null ? (
        <Alert tone="ok" title="Your launch is open">
          <p>
            The opening batch is taking commits now.{v.returned !== null && v.returned > 0n ? ` ${formatSol(v.returned, 4)} went back to your wallet.` : ""}{" "}
            <Link className="link" to={`/token/${v.mint.toBase58()}`}>
              See your token
            </Link>
          </p>
        </Alert>
      ) : null}
      {v.done && v.abandoned ? <Alert tone="info">Stopped. {v.returned !== null && v.returned > 0n ? `${formatSol(v.returned, 4)} went back to your wallet.` : "Nothing was left to return."}</Alert> : null}
    </section>
  );
}

/** What the person can do now. */
function NeedPanel({ view }: { view: FlowView }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<OpeningChoice>("asap");
  const [capAck, setCapAck] = useState(false);
  const now = useNow();
  const need = view.need;
  if (need === null) return null;
  const act = (a: Parameters<typeof launchFlowAction>[1]): void => {
    setBusy(true);
    setError(null);
    launchFlowAction(view.id, a)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const leftover = (
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => act({ kind: "return-leftover" })}>
      Stop and return the leftover SOL
    </Button>
  );
  return (
    <div className="lt-need">
      {need.kind === "go" ? (
        <>
          <p className="lt-need-text">
            {need.stage === "create"
              ? "Your wallet will ask you to approve creating the launch."
              : `Your wallet will ask you to send ${need.lamports === null ? "a small amount" : formatSol(need.lamports, 4)} to the temporary fee account.`}
          </p>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => act({ kind: "go" })}>
            Continue
          </Button>
        </>
      ) : null}
      {need.kind === "wallet" ? <Alert tone="warn">{need.message}</Alert> : null}
      {need.kind === "key" ? (
        <>
          <Alert tone="info" title="Your quantum key signs next">
            {need.message}
          </Alert>
          <QuantumKeyPanel use={view.stage === "autopilot" ? "It switches on your token's Autopilot." : "It signs your launch, so it can open."} />
        </>
      ) : null}
      {need.kind === "new-time" ? (
        <>
          <Alert tone="warn" title="The opening time passed — pick a new one">
            Nobody opened it before {formatTimestamp(need.closedAt)} (<time dateTime={isoOf(need.closedAt)}>{utcText(need.closedAt)}</time>). Pick a new time and your quantum key signs it. Your token&apos;s details are already stored and are reused.
          </Alert>
          <OpeningPicker value={opening} onChange={setOpening} idBase={`lt-${view.id}`} />
          <div className="pg-btns">
            <Button variant="primary" loading={busy} disabled={busy || openingProblem(opening, now) !== null} onClick={() => act({ kind: "new-time", opensAt: opening })}>
              Sign the new time
            </Button>
            {leftover}
          </div>
        </>
      ) : null}
      {need.kind === "sign-again" ? (
        <>
          <Alert tone="warn" title="That signature did not count">
            It reached Solana, but {need.burn.reasons.length === 0 ? "the launch did not accept it" : need.burn.reasons.map(burnReasonText).join(", and ")}. It used one of your quantum key&apos;s one-time
            signatures. You can sign once more; after two that do not count, the app stops to save your key.
          </Alert>
          <div className="pg-btns">
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => act({ kind: "sign-again" })}>
              Sign again
            </Button>
            {leftover}
          </div>
        </>
      ) : null}
      {need.kind === "key-used-elsewhere" ? (
        <>
          <KeyUsedElsewhere count={need.count} onResolved={() => act({ kind: "retry" })} />
          <div className="pg-btns">{leftover}</div>
        </>
      ) : null}
      {need.kind === "signature-cap" ? (
        <>
          <Alert tone="warn" title="Earlier signatures never landed">
            <p>{need.message}</p>
          </Alert>
          <label className="lt-ack">
            <input type="checkbox" checked={capAck} onChange={(e) => setCapAck(e.target.checked)} /> I understand: sign one more anyway.
          </label>
          <div className="pg-btns">
            <Button variant="primary" loading={busy} disabled={busy || !capAck} onClick={() => act({ kind: "sign-extra" })}>
              Sign one more
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act({ kind: "retry" })}>
              Check again
            </Button>
            {leftover}
          </div>
        </>
      ) : null}
      {need.kind === "retry" ? (
        <>
          <Alert tone="fail" title={/^Your device clock and the network disagree/.test(need.message) ? "Your clock and the network disagree" : "That did not go through"}>
            <p className="pg-break">{need.message}</p>
          </Alert>
          <div className="pg-btns">
            <Button variant="primary" loading={busy} disabled={busy} onClick={() => act({ kind: "retry" })}>
              Try again
            </Button>
            {leftover}
          </div>
        </>
      ) : null}
      {need.kind === "stopped" ? (
        <>
          <Alert tone="fail" title="Stopped">
            <p className="pg-break">{need.message}</p>
          </Alert>
          <div className="pg-btns">{leftover}</div>
        </>
      ) : null}
      {error !== null ? <Alert tone="fail">{error}</Alert> : null}
    </div>
  );
}

/** The tracker of a launch this browser runs, by its address (null: none). */
export function TrackerFor({ launch }: { launch: string }): ReactNode {
  const views = useLaunchFlows();
  const v = views.find((x) => x.launch.toBase58() === launch);
  return v === undefined ? null : <LaunchTracker view={v} />;
}

/** A one-line label of a launch in progress, for lists. */
export function flowLabel(v: FlowView): string {
  return `${v.name} (${v.symbol}) · ${shortKey(v.launch, 4)}`;
}
