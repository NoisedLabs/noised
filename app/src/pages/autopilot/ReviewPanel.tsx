/**
 * Review and sign (PROGRAMMABLE_V1 §2, §4): what exactly the creator's
 * quantum key signs, in plain English, decoded from the very bytes being
 * signed (review U1): every step, every recipient and the operator with
 * their full addresses, and what changes compared with the running steps.
 * Then the 72-hour wait for a change, "Freeze forever", and removing the
 * operator (always offered while there is one, frozen or not: review U12).
 *
 * A freeze approval (payload v2, review 4 R5) names the last second it may be used: one hour after the creator
 * confirms by default, at most 24 hours (the slider stops there: SDK 0.9.0, audit 4 ID-F5), fixed and shown as an
 * absolute date before anything is signed; it is checked again right before signing and before the freeze is sent,
 * and an expired one ("FreezeExpired") is explained in plain words, never half-used.
 *
 * Removing the operator signs payload v3: it names the activation in force (`AutopilotInfo.activeAuth`), so it can
 * never be replayed against a later activation. Every quantum signature runs the SDK's guards (signAuth.ts); their
 * refusals are shown in plain words: a key used on another device (components/KeyUsedElsewhere), a clock the network
 * disagrees with, and three earlier signatures that never landed (one more only after the creator confirms).
 *
 * The start time is fixed when the review opens and shown as such (review
 * U11): a first autopilot starts 5 minutes later (no waiting period: only room to land), a change 72 hours and one
 * hour later, rounded to the minute; it is checked again right before
 * anything is signed, so no one-time key is spent on a time the chain would
 * refuse. Only the launch's creator, holding the quantum key that signed the
 * launch, can sign (review U16); anyone can create the account, publish the
 * steps and run due steps.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { Keypair, type Connection } from "@solana/web3.js";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { secondConnection } from "../../app/secondRpc";
import { useTx } from "../../app/tx";
import { useOwner } from "../../app/wallet";
import { KeyUsedElsewhere } from "../../components/KeyUsedElsewhere";
import { When } from "../../components/When";
import { Button } from "../../components/ui";
import { describeSeconds, errorMessage, formatTimestamp, toHex } from "../../lib/format";
import {
  ADAPTER_MODE,
  buildActivateGraphTx,
  buildFreezeGraphTx,
  buildInitAutopilotTx,
  buildPqAuthorizeTx,
  buildPublishGraphTx,
  buildRevokeOperatorTx,
  buildFundThrowawayPayerTx,
  buildSweepPayerTx,
  programmable,
  PROGRAM_IDS,
  PROGRAMMABLE_AVAILABLE,
  rentExemptLamports,
  sendAndConfirm,
  simulateAndExplain,
  type AutopilotInfo,
  type LaunchAccount,
} from "../../lib/noised";
import {
  activateAtProblem,
  activationPayload,
  AUTOPILOT_CONSTANTS,
  authMessage,
  chooseActivateAt,
  explainGraphLines,
  FREEZE_EXPIRED_MESSAGE,
  FREEZE_MAX_SECS,
  FREEZE_VALID_SECS,
  FREEZE_WINDOW_CHOICES,
  freezeExpiryProblem,
  freezeNotAfter,
  freezePayload,
  graphChanges,
  graphFromBytes,
  graphPeople,
  revokePayload,
  type AuthPayload,
  type Graph,
  type GraphBuild,
} from "../../lib/programmable";
import { launchSigner, usePqKey } from "../../lib/pqKey";
import { signRefusalOf, utcText, type SignRefusal } from "../../lib/signErrors";
import { CLUSTER } from "../../app/settings";
import { StopSlider } from "../create/SimpleControls";
import { Chip, Comment, Details, NoteBox, Panel, Readout, Row, Steps, Toggle, type StepItem } from "../inner/kit";
import { signAuthorization, signerProblem } from "./signAuth";

const MOCK = ADAPTER_MODE === "mock";

/** The bytes of one authorization, field by field (folded: "Check it yourself"). */
function SignedBytes({ launch, payload }: { launch: LaunchAccount; payload: AuthPayload }): ReactNode {
  const msg = authMessage({ program: PROGRAM_IDS.launchpad, launch: launch.publicKey, creator: launch.creator, kind: payload.kind, payloadHash: payload.hash });
  return (
    <Details summary="Check it yourself: the exact message your quantum key signs" className="ap-signed">
      <Readout label="Message the quantum key signs">
        {msg.fields.map((f) => (
          <Row key={f.name} k={<code className="cr-key">{f.name}</code>} wide={f.size === 32}>
            <span className="ap-bytes">
              <code className="pg-break">{f.text}</code>
              <span className="ap-bytes-n">{f.size} B</span>
            </span>
          </Row>
        ))}
        <Row k="Total" tone="ok">
          {msg.bytes.length} bytes
        </Row>
      </Readout>
      <Readout label="payload_hash = SHA-256 of">
        {payload.fields.map((f) => (
          <Row key={f.name} k={<code className="cr-key">{f.name}</code>} wide={f.bytes.length >= 32}>
            <code className="pg-break">{f.text}</code>
          </Row>
        ))}
      </Readout>
    </Details>
  );
}

/** Who a graph pays and who operates it, every address in full. */
export function PeopleList({ graph }: { graph: Graph }): ReactNode {
  const p = graphPeople(graph);
  return (
    <div className="ap-people-list">
      <p className="pg-label">Who gets paid</p>
      {p.recipients.length === 0 ? (
        <p className="ap-muted">Nobody: these steps pay no one.</p>
      ) : (
        <ul>
          {p.recipients.map((r) => (
            <li key={r.address}>
              <span className="ap-share tabular-nums">{r.bps / 100}%</span> <code className="pg-break">{r.address}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="pg-label">Operator</p>
      {p.operator === null ? <p className="ap-muted">None: nobody but the schedule decides.</p> : <code className="pg-break">{p.operator}</code>}
    </div>
  );
}

interface Review {
  hashHex: string;
  activateAt: number;
  replacing: boolean;
}

/** The freeze slider's stop for a window length (the default: one hour). */
const freezeStop = (secs: number): number => Math.max(0, FREEZE_WINDOW_CHOICES.indexOf(secs));

/** "15 minutes", "1 hour", "24 hours": how long a freeze approval may be used. */
const freezeLength = (secs: number): string => (secs < 3_600 ? `${Math.round(secs / 60)} minutes` : `${secs / 3_600} hour${secs === 3_600 ? "" : "s"}`);

export function ReviewPanel({
  launch,
  info,
  build,
  running,
  published,
  now,
  onChanged,
  payeeRefusals = [],
}: {
  launch: LaunchAccount;
  info: AutopilotInfo | null;
  build: GraphBuild;
  /** The running graph (null: none). */
  running: Graph | null;
  /** Whether the current steps' bytes are already published. */
  published: boolean;
  now: number;
  onChanged: () => void;
  /** Payees that could never receive (SDK 0.9.0 `checkGraphRecipients`): nothing is published or signed while any is listed. */
  payeeRefusals?: readonly string[];
}): ReactNode {
  const { connection } = useConnection();
  const owner = useOwner();
  const key = usePqKey();
  const { run } = useTx();
  const me = owner.publicKey;
  const [freezeAck, setFreezeAck] = useState(false);
  // The freeze approval's last second, fixed when the creator confirms (one hour later), for the running graph it names.
  const [freezePlan, setFreezePlan] = useState<{ notAfter: number; hashHex: string } | null>(null);
  // How long the freeze approval may be used: a stop of FREEZE_WINDOW_CHOICES (one hour by default, 24 hours at most).
  const [freezeIdx, setFreezeIdx] = useState(freezeStop(FREEZE_VALID_SECS));
  const freezeSecs = FREEZE_WINDOW_CHOICES[freezeIdx] ?? FREEZE_VALID_SECS;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The SDK refused before anything was signed (a key used elsewhere, or earlier signatures that never landed).
  const [refusal, setRefusal] = useState<SignRefusal | null>(null);
  const [capAck, setCapAck] = useState(false);
  // The signature the refusal stopped: run again after an import, or with one more signature confirmed.
  const again = useRef<((extra: boolean) => void) | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const frozen = info?.frozen === true;
  const runningHash = info?.graphHash ?? null;
  // A running graph, or a scheduled first one holders can already see: either way the 72-hour wait applies.
  const replacing = runningHash !== null || info?.pending != null;
  const buildHex = build.ok ? toHex(build.hash) : null;
  const same = buildHex !== null && runningHash !== null && toHex(runningHash) === buildHex;
  const pendingSame = buildHex !== null && info?.pending != null && toHex(info.pending.graphHash) === buildHex;
  const isCreator = me !== null && me.equals(launch.creator);
  // Read again whenever the quantum key locks, unlocks or finishes getting ready.
  const keyIssue = useMemo(() => signerProblem(launch), [key, launch]);
  const signBlock = !PROGRAMMABLE_AVAILABLE
    ? "Switching an autopilot on is coming soon on this network."
    : me === null
      ? "Connect the creator's wallet to sign."
      : !isCreator
        ? `Only ${launch.market?.symbol ?? "this token"}'s creator can sign changes, with the quantum key that signed the launch.`
        : keyIssue;
  const payeeBlock = payeeRefusals.length > 0 ? "A payee in these steps could never receive its share. Fix it above first." : null;
  // The review of exactly these steps, with its fixed start time (review U11); another set of steps needs a new review.
  const current = review !== null && review.hashHex === buildHex ? review : null;
  const signed = useMemo(() => (build.ok ? graphFromBytes(build.bytes, launch.tokenDecimal) : null), [build, launch.tokenDecimal]);
  const lines = useMemo(() => (build.ok ? explainGraphLines(build.bytes, true, launch.tokenDecimal) : []), [build, launch.tokenDecimal]);
  const changes = useMemo(() => (signed !== null && replacing ? graphChanges(running, signed) : []), [signed, running, replacing]);
  const payload = current !== null && info !== null && build.ok ? activationPayload(info.address, build.hash, current.activateAt) : null;

  /** Signs one authorization with the quantum key and records it; then the follow-up transaction. */
  const authorize = async (
    p: AuthPayload,
    title: string,
    follow: { title: string; summary: string[]; build: () => Promise<{ tx: import("@solana/web3.js").Transaction }> },
    recheck?: () => string | null,
    opts: { freezeNotAfter?: number; extra?: boolean } = {},
  ): Promise<void> => {
    if (!me) return;
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    // SDK 0.9.0: a second RPC of this build (when it lists one) must agree on the clock too.
    const second = secondConnection(connection.rpcEndpoint);
    try {
      const early = recheck?.() ?? null;
      if (early !== null) return setProblem(early);
      const issue = signerProblem(launch);
      if (issue !== null) return setProblem(issue);
      if (!programmable.walletAuthorize) {
        // A real cluster: the 2.5 KB quantum signature goes in a v1 transaction from a temporary account the wallet funds.
        const ok = await authorizeFromTemporaryAccount(p, opts.freezeNotAfter, opts.extra === true, second);
        if (!ok) return;
        const late = recheck?.() ?? null;
        if (late !== null) return setProblem(late);
        followUp(await run({ ...follow, build: async () => (await follow.build()).tx }));
        onChanged();
        return;
      }
      const sig = await signAuthorization(connection, launch, p, {
        secondConnection: second,
        ...(opts.freezeNotAfter !== undefined ? { freezeNotAfter: opts.freezeNotAfter } : {}),
        acknowledgeExtraSignatures: opts.extra === true,
      });
      const authorized = await run({
        title,
        summary: [
          `Records your quantum key's signature of the ${sig.message.length}-byte message shown above. It uses one of your key's one-time signatures.`,
          "Nobody else can make this signature: it must be the key that signed the launch.",
          ...(MOCK ? ["Demo: everything happens on a simulated chain in this browser."] : []),
        ],
        build: async () => (await buildPqAuthorizeTx(connection, me, launch.publicKey, { kind: p.kind, payloadHash: p.hash, lmsPublicKey: sig.lmsPublicKey, leaf: sig.leaf, signature: sig.signature })).tx,
      });
      if (authorized.status !== "confirmed") return;
      const late = recheck?.() ?? null;
      if (late !== null) return setProblem(late);
      followUp(await run({ ...follow, build: async () => (await follow.build()).tx }));
      onChanged();
    } catch (e) {
      const r = signRefusalOf(e);
      if (r !== null && r.kind !== "clock") {
        // Nothing was signed: the creator imports the other device's records (or confirms one more), then it runs again.
        setRefusal(r);
        setCapAck(false);
        again.current = (extra) => void authorize(p, title, follow, recheck, { ...opts, extra });
      } else setProblem(r?.message ?? errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** A freeze the chain refused as expired (FreezeExpired) is said plainly; anything else the transaction dialog showed. */
  const followUp = (o: Awaited<ReturnType<typeof run>>): void => {
    if (o.status === "failed" && `${o.error} ${o.report?.errorCode?.name ?? ""}`.includes("FreezeExpired")) {
      setProblem(FREEZE_EXPIRED_MESSAGE);
      setFreezePlan(null);
      setFreezeAck(false);
    }
  };

  /**
   * The quantum signature from a temporary account: the wallet funds it (its review says how much and why), the key
   * signs at its next one-time key (the ledger reserves it first), the account sends it (simulated first), then what is
   * left goes back to the wallet. Returns whether the authorization is on chain.
   */
  const authorizeFromTemporaryAccount = async (p: AuthPayload, freezeAt: number | undefined, extra: boolean, second: Connection | null): Promise<boolean> => {
    if (!me) return false;
    const payer = Keypair.generate();
    const [cost, floor] = await Promise.all([programmable.autopilotSetupCost(connection, 0), rentExemptLamports(connection, 0)]);
    const lamports = cost.authorize + floor + 1_000_000n;
    const funded = await run({
      title: "Fund your quantum signature",
      summary: [
        `Sends ${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL to a temporary account this page made for one signature.`,
        "The quantum signature is too large for a wallet transaction, so this account sends it. What it does not spend comes back to your wallet right after.",
      ],
      build: async () => (await buildFundThrowawayPayerTx(connection, me, payer.publicKey, { lamports })).tx,
    });
    if (funded.status !== "confirmed") return false;
    try {
      const { identity, leaves, lock } = await launchSigner(CLUSTER);
      const prepared = await programmable.prepareAuthorizeFromPayer(connection, payer, launch.publicKey, {
        kind: p.kind,
        payloadHash: p.hash,
        creator: launch.creator,
        identity,
        ledger: leaves,
        ...(freezeAt !== undefined ? { freezeNotAfter: freezeAt } : {}),
        // SDK 0.9.0: this browser's cross-tab signing lock, a second RPC for the clock, a confirmed extra signature.
        signingLock: lock,
        ...(second !== null ? { secondConnection: second } : {}),
        ...(extra ? { acknowledgeExtraSignatures: true } : {}),
      });
      if (prepared !== null) {
        const sim = await simulateAndExplain(connection, prepared.tx);
        if (!sim.ok) throw new Error(sim.error ?? "The test run of the quantum signature failed.");
        await prepared.send();
      }
      return true;
    } finally {
      try {
        const back = await buildSweepPayerTx(connection, payer, me);
        if (back !== null) await sendAndConfirm(connection, back.tx);
      } catch {
        // Nothing left to return, or the cluster refused: the amount is small and stays visible on the account.
      }
    }
  };

  const steps: StepItem[] = [
    { key: "init", label: "Create the autopilot", hint: "once per token · anyone", state: info !== null ? "done" : "current" },
    { key: "publish", label: "Publish the steps", hint: "stored by their fingerprint · anyone", state: published ? "done" : info !== null && build.ok ? "current" : "todo" },
    { key: "sign", label: "Sign with your quantum key", hint: "only the creator", state: pendingSame || same ? "done" : published ? "current" : "todo" },
    { key: "on", label: replacing ? "Takes effect after 72 hours" : "Switches on", hint: replacing ? "holders see it coming" : "a few minutes later: no waiting period", state: same ? "done" : pendingSame ? "current" : "todo" },
  ];

  return (
    <Panel
      title="Review and sign"
      description="Your quantum key, not your wallet, decides what the autopilot runs. Nobody else can change it, and every change waits 72 hours in public."
      status={!PROGRAMMABLE_AVAILABLE ? <Chip tone="muted">Coming soon</Chip> : undefined}
      className="ap-review"
    >
      {!PROGRAMMABLE_AVAILABLE ? (
        <NoteBox title="Coming soon on this network">Switching an autopilot on is not live here yet. You can build it and try it in the simulation above; the demo shows the whole flow.</NoteBox>
      ) : null}
      {frozen ? (
        <NoteBox tone="ok" title="Frozen forever">
          These steps can never change again, not even by the creator. They keep running as long as the treasury has funds.
        </NoteBox>
      ) : PROGRAMMABLE_AVAILABLE ? (
        <>
          <Steps steps={steps} label="Switching it on" />
          {!build.ok ? <NoteBox tone="warn">Pick at least one job (or fix the problems above) first.</NoteBox> : null}
          {same ? <NoteBox tone="ok">These are exactly the steps running now.</NoteBox> : null}
          {pendingSame && info?.pending ? (
            <NoteBox tone="signal" title="Signed and scheduled">
              Signed by your launch&apos;s quantum key. These steps take effect on <When t={info.pending.activateAt} />.
            </NoteBox>
          ) : null}

          {build.ok && !same && !pendingSame ? (
            <div className="ap-sign">
              <h3 className="ap-insp-title">What your quantum key signs</h3>
              <ol className="rl-plain">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
              {signed !== null ? <PeopleList graph={signed} /> : null}
              {replacing && changes.length > 0 ? (
                <div className="ap-change-list">
                  <p className="pg-label">Compared with what runs now</p>
                  <ul className="ap-changes">
                    {changes.map((c, i) => (
                      <li key={i} data-kind={c.kind}>
                        {c.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {current === null ? (
                <div className="pg-btns">
                  <Button variant="primary" disabled={info === null || !published || busy || payeeBlock !== null} onClick={() => setReview({ hashHex: buildHex ?? "", activateAt: chooseActivateAt(now, replacing), replacing })}>
                    Review the start time
                  </Button>
                  {info === null || !published ? <Comment>Create the autopilot and publish the steps first (anyone can).</Comment> : null}
                </div>
              ) : (
                <>
                  <Readout label="When it takes effect">
                    <Row k="Starts" tone="ok">
                      <When t={current.activateAt} /> · {current.replacing ? "72 hours and 1 hour after you opened this review" : "5 minutes after you opened this review: a first Autopilot has no waiting period"}
                    </Row>
                  </Readout>
                  {current.replacing ? (
                    <NoteBox tone="warn" title="A change waits 72 hours">
                      The current steps keep running until <When t={current.activateAt} />. Everyone can read this change before it happens, so holders who don't like it have time to leave.
                    </NoteBox>
                  ) : null}
                  {payload !== null ? <SignedBytes launch={launch} payload={payload} /> : null}
                  <div className="pg-btns">
                    <Button
                      variant="primary"
                      disabled={signBlock !== null || payeeBlock !== null || busy || payload === null}
                      loading={busy}
                      onClick={() => {
                        if (!build.ok || payload === null || !me) return;
                        const at = current.activateAt;
                        const hash = build.hash;
                        void authorize(
                          payload,
                          "Sign with your quantum key",
                          {
                            title: current.replacing ? "Schedule the change" : "Switch the autopilot on",
                            summary: current.replacing
                              ? [`Schedules these steps to take effect on ${formatTimestamp(at)} (${utcText(at)}).`, "Until then the current steps keep running and everyone can see the change coming. Anyone can apply it when the time comes."]
                              : [`Switches the autopilot on from ${formatTimestamp(at)} (${utcText(at)}).`, "From then on anyone can run a step that is due and earn the small tip."],
                            build: () => buildActivateGraphTx(connection, me, launch.publicKey, hash, at),
                          },
                          () => activateAtProblem(at, Math.floor(Date.now() / 1000), current.replacing),
                        );
                      }}
                    >
                      {current.replacing ? "Sign the change (takes effect in 72 hours)" : "Sign and switch on"}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>
                      Review again
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {signBlock !== null && build.ok && !same && !pendingSame ? <Comment>{signBlock}</Comment> : null}
          {payeeBlock !== null && build.ok && !same && !pendingSame ? <Comment>{payeeBlock}</Comment> : null}
          <div className="pg-btns">
            {info === null ? (
              <Button
                variant={build.ok ? "primary" : "secondary"}
                disabled={!me || busy}
                onClick={() => {
                  if (!me) return;
                  void run({
                    title: "Create the autopilot",
                    summary: [
                      "Creates this token's autopilot account and its treasury address (anyone can, once).",
                      "It holds no keys: only steps signed by the creator's quantum key can move treasury funds, and only to burns, buybacks that burn, listed recipients and small tips.",
                    ],
                    build: async () => (await buildInitAutopilotTx(connection, me, launch.publicKey)).tx,
                  }).then((o) => o.status === "confirmed" && onChanged());
                }}
              >
                Create the autopilot
              </Button>
            ) : null}
            {info !== null && build.ok && !published ? (
              <Button
                variant="primary"
                disabled={!me || busy || payeeBlock !== null}
                onClick={() => {
                  if (!me || !build.ok) return;
                  const bytes = build.bytes;
                  void run({
                    title: "Publish the steps",
                    summary: [`Stores these steps on Solana (${bytes.length} bytes) under their fingerprint. Anyone can; it switches nothing on.`, "The program checks them first: only buybacks that burn, burns, payments to listed recipients and small tips."],
                    build: async () => (await buildPublishGraphTx(connection, me, launch.publicKey, bytes)).tx,
                  }).then((o) => o.status === "confirmed" && onChanged());
                }}
              >
                Publish the steps
              </Button>
            ) : null}
          </div>
          {!me ? <Comment>Connect a wallet to pay the network fees.</Comment> : null}
        </>
      ) : null}

      {info !== null && runningHash !== null && !frozen && PROGRAMMABLE_AVAILABLE ? (
        <div className="ap-danger">
          <h3 className="ap-insp-title">Freeze forever</h3>
          <p className="pg-text">Make the running steps permanent. After this nobody, including you, can change, pause or replace them, and any scheduled change is dropped.</p>
          {running !== null ? (
            <ol className="rl-plain" aria-label="The steps that would be frozen">
              {explainGraphLines(running).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          ) : null}
          <StopSlider
            label="Your approval can be used for"
            stops={FREEZE_WINDOW_CHOICES.length}
            index={freezeIdx}
            exact
            valueText={freezeLength(freezeSecs)}
            stopText={(i) => freezeLength(FREEZE_WINDOW_CHOICES[i] ?? FREEZE_VALID_SECS)}
            onIndex={(i) => {
              setFreezeIdx(i);
              // A new length is a new approval: fixed again from now, shown below, named in what the key signs.
              if (freezeAck) setFreezePlan({ notAfter: freezeNotAfter(now, FREEZE_WINDOW_CHOICES[i] ?? FREEZE_VALID_SECS), hashHex: toHex(runningHash) });
            }}
            ends={[freezeLength(FREEZE_WINDOW_CHOICES[0] ?? FREEZE_VALID_SECS), freezeLength(FREEZE_MAX_SECS)]}
            say={`If the freeze isn't sent in that time, the approval expires and nothing is frozen. ${freezeLength(FREEZE_MAX_SECS)} at most.`}
          />
          <Toggle
            checked={freezeAck}
            onChange={(v) => {
              setFreezeAck(v);
              // The approval is good for the chosen time from now: fixed here, shown below, and named in what the key signs.
              setFreezePlan(v ? { notAfter: freezeNotAfter(now, freezeSecs), hashHex: toHex(runningHash) } : null);
              setProblem(null);
            }}
          >
            I understand this can never be undone, by anyone.
          </Toggle>
          {freezeAck && freezePlan !== null && freezePlan.hashHex === toHex(runningHash) ? (
            <>
              <Readout label="Your launch's quantum key approves the freeze">
                <Row k="Can be used until" tone="ok">
                  <span data-testid="freeze-expiry">
                    <When t={freezePlan.notAfter} />
                  </span>{" "}
                  · after that it expires and nothing is frozen
                </Row>
              </Readout>
              <SignedBytes launch={launch} payload={freezePayload(info.address, runningHash, freezePlan.notAfter)} />
            </>
          ) : null}
          <Button
            variant="danger"
            disabled={!freezeAck || freezePlan === null || signBlock !== null || busy}
            onClick={() => {
              if (!me || freezePlan === null) return;
              const notAfter = freezePlan.notAfter;
              const clock = (): number => Math.floor(Date.now() / 1000);
              const early = freezeExpiryProblem(notAfter, clock());
              if (early !== null) {
                // Nothing was signed: offer a fresh approval of the same length.
                setProblem(early);
                setFreezePlan({ notAfter: freezeNotAfter(clock(), freezeSecs), hashHex: toHex(runningHash) });
                return;
              }
              void authorize(
                freezePayload(info.address, runningHash, notAfter),
                "Sign the freeze with your quantum key",
                {
                  title: "Freeze the autopilot forever",
                  summary: [
                    "Makes the running steps permanent. No key, not even yours, can change or stop them again.",
                    "Any scheduled change is dropped.",
                    `Your approval can be used until ${formatTimestamp(notAfter)} (${utcText(notAfter)}); after that it expires and nothing is frozen.`,
                  ],
                  build: () => buildFreezeGraphTx(connection, me, launch.publicKey, notAfter),
                },
                () => freezeExpiryProblem(notAfter, clock()),
                { freezeNotAfter: notAfter },
              );
            }}
          >
            Sign and freeze forever
          </Button>
        </div>
      ) : null}

      {info?.operator && runningHash !== null && PROGRAMMABLE_AVAILABLE ? (
        <div className="ap-danger">
          <h3 className="ap-insp-title">Operator</h3>
          <p className="pg-text">
            <code className="pg-break">{info.operator.toBase58()}</code> chooses when and how much for the steps it controls, inside their limits. It can never send funds anywhere else.
          </p>
          {frozen ? <Comment>Freezing locked the steps, but you can still remove the operator: that only takes a power away.</Comment> : null}
          {info.activeAuth !== null ? (
            <SignedBytes launch={launch} payload={revokePayload(info.address, runningHash, info.operator, info.activeAuth)} />
          ) : (
            <Comment>The approval that switched these steps on can&apos;t be read yet, so the removal can&apos;t be signed. Reload the page.</Comment>
          )}
          <Button
            variant="danger"
            size="sm"
            disabled={signBlock !== null || busy || info.activeAuth === null}
            onClick={() => {
              if (!me || !info.operator || info.activeAuth === null) return;
              // Payload v3 (audit 4, A4-3): it names the activation in force, so it can never be replayed against a later one.
              void authorize(revokePayload(info.address, runningHash, info.operator, info.activeAuth), "Sign the removal with your quantum key", {
                title: "Remove the operator",
                summary: ["Clears the operator key. Steps only it could run stop for good (and a scheduled change does not give it back)."],
                build: () => buildRevokeOperatorTx(connection, me, launch.publicKey),
              });
            }}
          >
            Sign and remove the operator
          </Button>
        </div>
      ) : null}

      {refusal?.kind === "unknown-leaves" ? (
        <KeyUsedElsewhere
          count={refusal.count}
          onResolved={() => {
            setRefusal(null);
            again.current?.(false);
          }}
        />
      ) : null}
      {refusal?.kind === "cap" ? (
        <NoteBox tone="warn" title="Earlier signatures never landed" live>
          <p>{refusal.message}</p>
          <Toggle checked={capAck} onChange={setCapAck}>
            I understand: sign one more anyway.
          </Toggle>
          <div className="pg-btns">
            <Button
              variant="primary"
              size="sm"
              disabled={!capAck || busy}
              onClick={() => {
                setRefusal(null);
                again.current?.(true);
              }}
            >
              Sign one more
            </Button>
          </div>
        </NoteBox>
      ) : null}
      {problem !== null ? (
        <NoteBox tone="danger" title={/^Your device clock and the network disagree/.test(problem) ? "Your clock and the network disagree" : "Nothing more was sent"} live>
          {problem}
        </NoteBox>
      ) : null}

      <p className="ap-foot">
        <Chip tone="muted">Waiting period {describeSeconds(AUTOPILOT_CONSTANTS.updateTimelockSecs)}</Chip> <Chip tone="muted">No admin key</Chip> <Chip tone="muted">Liquidity stays locked</Chip>
      </p>
    </Panel>
  );
}
