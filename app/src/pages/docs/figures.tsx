/**
 * Figures embedded in the docs with "::figure name" (content/docs/markdown.ts). Hand-built HTML/SVG, monochrome,
 * no chart library. Motion is CSS only (transform / opacity), off under prefers-reduced-motion.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Check, Copy } from "lucide-react";
import { Fragment, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";

import { useNoiseReveal } from "../../fx/noise";
import { PROGRAMS, SDK_GROUPS, SDK_REFERENCE, sdkEntriesOf } from "../../content/docs/nav";
import { Pixel, Segments, type GlyphName } from "./pixels";

// ---------------------------------------------------------------- shared ---

function Fig({ title, children, className = "", note }: { title: string; children: ReactNode; className?: string; note?: ReactNode }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useNoiseReveal(ref, { duration: 600, sweep: "down" });
  return (
    <figure ref={ref} className={`dx-fig ${className}`}>
      <div className="dx-fig-body">{children}</div>
      <figcaption className="dx-fig-cap">
        <span className="dx-fig-tag" aria-hidden="true">
          FIG
        </span>
        <span>{title}</span>
        {note ? <span className="dx-fig-note">{note}</span> : null}
      </figcaption>
    </figure>
  );
}

export function CopyText({ value, label }: { value: string; label: string }): ReactNode {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="dx-copy dx-copy-sm"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          () => setDone(false),
        );
      }}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

// -------------------------------------------------------------- programs ---

const PROGRAM_CARDS: { slug: string; icon: GlyphName; name: string; role: string }[] = [
  { slug: "launchpad", icon: "cube", name: "Launchpad", role: "Fixes every dangerous setting, holds every role through PDAs, runs the fair-open batch, routes fees and writes the certificate." },
  { slug: "hook", icon: "shield", name: "Launch Guard", role: "Transfer hook: only the batch buys before the open, bounded guard rules, never blocks a sell, gone at graduation." },
  { slug: "vault", icon: "vault", name: "PQ vault", role: "Custody that only a one-time LM-OTS signature opens. Keys rotate in place; payouts can't be blocked." },
  { slug: "shield", icon: "eye", name: "Shield", role: "Opt-in private balances: wrap 1:1 into zTokens that hide balances and amounts." },
];

function ProgramsFig(): ReactNode {
  return (
    <Fig title="The four Noised programs" className="dx-fig-flat">
      <ul className="dx-prog-grid">
        {PROGRAM_CARDS.map((c) => {
          const p = PROGRAMS.find((x) => x.slug === c.slug);
          return (
            <li key={c.slug} className="dx-prog">
              <Link to={`/docs/programs/${c.slug}`} className="dx-prog-link">
                <span className="dx-prog-icon">
                  <Pixel name={c.icon} size={33} />
                </span>
                <span className="dx-prog-name">{c.name}</span>
                <span className="dx-prog-role">{c.role}</span>
                <span className="dx-prog-id" title={p?.programId}>
                  {p ? short(p.programId) : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Fig>
  );
}

function ProgramIdsFig(): ReactNode {
  return (
    <Fig title="Program IDs (the same on every cluster)" className="dx-fig-flat">
      <ul className="dx-ids">
        {PROGRAM_CARDS.map((c) => {
          const p = PROGRAMS.find((x) => x.slug === c.slug);
          if (!p) return null;
          return (
            <li key={c.slug} className="dx-id-row">
              <Pixel name={c.icon} size={22} />
              <Link className="dx-id-name" to={`/docs/programs/${c.slug}`}>
                {c.name}
                <span>{p.crate}</span>
              </Link>
              <code className="dx-id-addr">{p.programId}</code>
              <CopyText value={p.programId} label={`${c.name} program id`} />
            </li>
          );
        })}
      </ul>
    </Fig>
  );
}

// ------------------------------------------------------------- lifecycle ---

const LIFE: { icon: GlyphName; name: string; ix: string; who: string; time: string; rolling?: boolean }[] = [
  { icon: "cube", name: "Configure", ix: "create_launch", who: "creator's wallet", time: "any time" },
  { icon: "book", name: "Publish", ix: "publish_metadata", who: "anyone (throwaway key)", time: "before attest" },
  { icon: "sig", name: "Attest", ix: "attest_launch", who: "PQ identity", time: "≤ 1 h window" },
  { icon: "bolt", name: "Go live", ix: "launch", who: "anyone, in window", time: "T0" },
  { icon: "coin", name: "Commit", ix: "commit", who: "anyone", time: "1–30 min" },
  { icon: "check", name: "Batch", ix: "execute_batch", who: "anyone (keeper)", time: "≤ 10 min" },
  { icon: "shield", name: "Guard", ix: "Launch Guard", who: "rules apply", time: "≤ 72 h" },
  { icon: "lock", name: "Graduate", ix: "migration_damm_v2", who: "anyone; LP locked", time: "forever" },
];

/** Line-break opportunities after underscores (snake_case instruction names in narrow columns). */
function breakable(name: string): ReactNode {
  const parts = name.split("_");
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 ? (
        <>
          _<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

function LifecycleFig(): ReactNode {
  return (
    <Fig title="A launch, from configuration to permanently locked liquidity">
      <div className="dx-life-wrap">
        <span className="dx-life-track" aria-hidden="true">
          <span className="dx-life-runner" />
        </span>
        <ol className="dx-life">
        {LIFE.map((s, i) => (
          <li key={s.name} className="dx-life-stop" data-rolling={s.rolling ? "true" : "false"} style={{ "--i": i } as CSSProperties}>
            <span className="dx-life-n" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="dx-life-node">
              <Pixel name={s.icon} size={22} />
            </span>
            <span className="dx-life-name">{s.name}</span>
            <code className="dx-life-ix">{breakable(s.ix)}</code>
            <span className="dx-life-who">{s.who}</span>
            <span className="dx-life-time">{s.time}</span>
          </li>
        ))}
        </ol>
      </div>
    </Fig>
  );
}

// ----------------------------------------------------------------- batch ---

function fmt(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function BatchFig(): ReactNode {
  const id = useId();
  const [total, setTotal] = useState(160);
  const [cap, setCap] = useState(100);
  const [mine, setMine] = useState(8);
  const C = Math.max(total, mine);
  const spent = Math.min(C, cap);
  const fill = spent / C;
  const mySpent = mine * fill;
  const myRefund = mine - mySpent;
  const scale = Math.max(C, cap);
  const SEG = 40;
  const segSpent = Math.round((spent / scale) * SEG);
  const segTotal = Math.round((C / scale) * SEG);
  const segCap = Math.round((cap / scale) * SEG);
  return (
    <Fig title="Pro-rata fill: everyone's commit is spent in the same proportion" note="Interactive: drag the sliders">
      <div className="dx-batch">
        <div className="dx-batch-controls">
          <label htmlFor={`${id}-t`}>
            <span>Total committed</span>
            <b>{total} SOL</b>
          </label>
          <input id={`${id}-t`} type="range" min={10} max={400} step={5} value={total} onChange={(e) => setTotal(Number(e.target.value))} />
          <label htmlFor={`${id}-c`}>
            <span>Batch total cap</span>
            <b>{cap} SOL</b>
          </label>
          <input id={`${id}-c`} type="range" min={20} max={300} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
          <label htmlFor={`${id}-m`}>
            <span>Your commit</span>
            <b>{mine} SOL</b>
          </label>
          <input id={`${id}-m`} type="range" min={1} max={40} step={1} value={mine} onChange={(e) => setMine(Number(e.target.value))} />
        </div>
        <div className="dx-batch-out" aria-live="polite">
          <div className="dx-batch-row">
            <span className="dx-batch-k">Batch</span>
            <span className="dx-batch-bar" data-cap={segCap}>
              {Array.from({ length: SEG }, (_, i) => (
                <i key={i} data-s={i < segSpent ? "spent" : i < segTotal ? "refund" : "empty"} data-cap={i === segCap - 1 ? "true" : undefined} />
              ))}
            </span>
            <span className="dx-batch-v">
              swaps <b>{fmt(spent)}</b> of {fmt(C)} SOL
            </span>
          </div>
          <div className="dx-batch-row">
            <span className="dx-batch-k">You</span>
            <Segments count={20} filled={Math.round(fill * 20)} className="dx-batch-mine" />
            <span className="dx-batch-v">
              <b>{fmt(mySpent)}</b> spent · <b>{fmt(myRefund)}</b> back
            </span>
          </div>
          <p className="dx-batch-sum">
            Fill <b>{(fill * 100).toFixed(1)}%</b> for every committer{C > cap ? ": oversubscribed, the rest is refunded at claim." : ": the whole total is spent."}
          </p>
        </div>
      </div>
    </Fig>
  );
}

// ------------------------------------------------------------ hook order ---

const HOOK_STEPS: { label: string; verdict: "allow" | "refuse" }[] = [
  { label: "No Noised policy for the mint", verdict: "allow" },
  { label: "Policy of another mint", verdict: "refuse" },
  { label: "A sell, or a zero-amount transfer that is not a buy", verdict: "allow" },
  { label: "The guard is over", verdict: "allow" },
  { label: "A buy during the shield, not inside execute_batch", verdict: "refuse" },
  { label: "Zero amount (only a buy can get here)", verdict: "allow" },
  { label: "Source or destination owner is exempt", verdict: "allow" },
  { label: "Wallet-to-wallet transfer while the lock is on", verdict: "refuse" },
  { label: "Larger than max buy", verdict: "refuse" },
  { label: "Receiver would exceed max wallet", verdict: "refuse" },
  { label: "Otherwise", verdict: "allow" },
];

const HOOK_CASES: { name: string; step: number; code: string }[] = [
  { name: "Sell into the pool", step: 3, code: "allowed" },
  { name: "Sniper buy before the batch", step: 5, code: "SnipeShield" },
  { name: "Zero-output buy before the batch", step: 5, code: "SnipeShield" },
  { name: "The batch buy", step: 7, code: "allowed" },
  { name: "Wallet → wallet, lock on", step: 8, code: "TransfersLocked" },
  { name: "Whale buy over max buy", step: 9, code: "MaxBuy" },
  { name: "Anything after the guard", step: 4, code: "allowed" },
];

function HookOrderFig(): ReactNode {
  const [pick, setPick] = useState(1);
  const c = HOOK_CASES[pick] ?? HOOK_CASES[0];
  const name = useId();
  return (
    <Fig title="Launch Guard decides every transfer in this order" note="Pick a transfer">
      <div className="dx-hook">
        <fieldset className="dx-hook-cases">
          <legend className="sr-only">Transfer to evaluate</legend>
          {HOOK_CASES.map((h, i) => (
            <label key={h.name} className="dx-chip-radio">
              <input type="radio" name={name} checked={pick === i} onChange={() => setPick(i)} />
              <span>{h.name}</span>
            </label>
          ))}
        </fieldset>
        <ol className="dx-hook-steps" aria-live="polite">
          {HOOK_STEPS.map((s, i) => {
            const n = i + 1;
            const state = !c ? "todo" : n < c.step ? "pass" : n === c.step ? "hit" : "skip";
            return (
              <li key={s.label} data-state={state} data-verdict={s.verdict}>
                <span className="dx-hook-n">{String(n).padStart(2, "0")}</span>
                <span className="dx-hook-l">{s.label}</span>
                <span className="dx-hook-v">{state === "hit" ? (s.verdict === "allow" ? "ALLOW" : "REFUSE") : state === "pass" ? "·" : ""}</span>
              </li>
            );
          })}
        </ol>
        {c ? (
          <p className="dx-hook-out">
            <b>{c.name}</b> is decided at step {c.step}: <code>{c.code}</code>.
          </p>
        ) : null}
      </div>
    </Fig>
  );
}

// ------------------------------------------------------------------ fees ---

function FeesFig(): ReactNode {
  return (
    <Fig title="Where fees go: fixed at create_launch, cranked by anyone">
      <div className="dx-flow">
        <ul className="dx-flow-col" aria-label="Sources">
          <li>
            <Pixel name="coin" size={18} />
            Curve trading fees <small>wSOL · claim_fees</small>
          </li>
          <li>
            <Pixel name="coin" size={18} />
            Surplus above the threshold <small>80% · claim_surplus</small>
          </li>
          <li>
            <Pixel name="coin" size={18} />
            DAMM v2 LP fees <small>wSOL + base · claim_lp_fees</small>
          </li>
        </ul>
        <span className="dx-flow-arrow" aria-hidden="true" />
        <div className="dx-flow-mid">
          <Pixel name="cube" size={33} />
          <b>Launch authority PDA</b>
          <small>["authority", launch] · no private key</small>
          <code>distribute</code>
        </div>
        <span className="dx-flow-arrow" aria-hidden="true" />
        <ul className="dx-flow-col" aria-label="Destinations">
          <li>
            <Pixel name="vault" size={18} />
            Treasury PQ vault <small>platform share ≤ 50%</small>
          </li>
          <li>
            <Pixel name="key" size={18} />
            1–4 recipients <small>by bps, never change</small>
          </li>
          <li data-tone="burn">
            <Pixel name="flame" size={18} />
            Burn <small>every base token collected</small>
          </li>
        </ul>
      </div>
    </Fig>
  );
}

// ---------------------------------------------------------------- attest ---

const START_USED = 23;

function AttestFig(): ReactNode {
  const [used, setUsed] = useState(START_USED);
  const [flash, setFlash] = useState(-1);
  const next = used;
  const burn = (): void => {
    if (used >= 1024) return;
    setFlash(used);
    setUsed((u) => Math.min(1024, u + 1));
  };
  return (
    <Fig title="One identity, 1,024 one-time leaves; each attestation burns one, on-chain" note="Interactive: burn a leaf">
      <div className="dx-attest">
        <div className="dx-leaves">
          <svg viewBox="0 0 32 32" shapeRendering="crispEdges" role="img" aria-label={`Leaf bitmap: ${used} of 1,024 leaves used, next free leaf ${next}`}>
            {Array.from({ length: 1024 }, (_, q) => {
              const x = q % 32;
              const y = Math.floor(q / 32);
              const cls = q === flash ? "lf-flash" : q === next ? "lf-next" : q < used ? "lf-used" : "lf-free";
              return <rect key={q} x={x + 0.12} y={y + 0.12} width={0.76} height={0.76} className={cls} />;
            })}
          </svg>
          <span className="dx-leaves-k">
            <i className="lf-used" /> used <i className="lf-next" /> next q = {next} <i className="lf-free" /> free
          </span>
          <div className="dx-leaves-actions">
            <button type="button" className="dx-mini-btn" onClick={burn} disabled={used >= 1024}>
              <Pixel name="sig" size={14} /> Attest a launch
            </button>
            <button
              type="button"
              className="dx-mini-btn"
              data-tone="ghost"
              onClick={() => {
                setUsed(START_USED);
                setFlash(-1);
              }}
            >
              Reset
            </button>
          </div>
          <p className="sr-only" aria-live="polite">
            {used} of 1,024 leaves used. The next attestation signs with leaf {next}.
          </p>
        </div>
        <ol className="dx-attest-steps">
          <li>
            <Pixel name="key" size={22} />
            <div>
              <b>Identity</b>
              <span>Passkey PRF or a 24-word phrase, never your wallet. LMS root: 56 bytes.</span>
            </div>
          </li>
          <li>
            <Pixel name="sig" size={22} />
            <div>
              <b>Sign</b>
              <span>Leaf q signs 189 bytes: launch, params_hash, the metadata record's hash, window.</span>
            </div>
          </li>
          <li>
            <Pixel name="check" size={22} />
            <div>
              <b>attest_launch</b>
              <span>Verified on-chain; bit q set forever. Anyone may relay it.</span>
            </div>
          </li>
          <li>
            <Pixel name="bolt" size={22} />
            <div>
              <b>launch</b>
              <span>Only inside [not_before, not_after], then anyone may run it.</span>
            </div>
          </li>
        </ol>
      </div>
    </Fig>
  );
}

// ------------------------------------------------------------- winternitz ---

const W_CHAINS = 16;
const W_STEPS = 16;
const enc = new TextEncoder();

/** 16 base-16 digits of SHA-256(message) and 2 checksum digits: a scaled-down LM-OTS (the real one has 64 + 3). */
function wotsDigits(message: string): { msg: number[]; sum: number[] } {
  const h = sha256(enc.encode(message));
  const msg: number[] = [];
  for (let i = 0; i < W_CHAINS / 2; i++) {
    const b = h[i] ?? 0;
    msg.push(b >> 4, b & 15);
  }
  const checksum = msg.reduce((acc, d) => acc + (W_STEPS - 1 - d), 0);
  return { msg, sum: [(checksum >> 4) & 15, checksum & 15] };
}

function WinternitzFig(): ReactNode {
  const id = useId();
  const [m1, setM1] = useState("pay 10 SOL to alice");
  const [m2, setM2] = useState("pay 10 SOL to bob");
  const [two, setTwo] = useState(false);
  const a = useMemo(() => wotsDigits(m1), [m1]);
  const b = useMemo(() => wotsDigits(m2), [m2]);
  const rows = [...a.msg.map((d, i) => ({ label: `m${i + 1}`, d1: d, d2: b.msg[i] ?? d, sum: false })), ...a.sum.map((d, i) => ({ label: `c${i + 1}`, d1: d, d2: b.sum[i] ?? d, sum: true }))];
  const gained = two ? rows.filter((r) => r.d2 < r.d1).length : 0;
  const forgeable = two && gained > 0;
  return (
    <Fig title="Winternitz chains: a signature reveals one position per chain; anyone can hash forward, nobody backward" note="Interactive: sign twice">
      <div className="dx-wots">
        <div className="dx-wots-controls">
          <label htmlFor={`${id}-m1`}>Message</label>
          <input id={`${id}-m1`} className="dx-input" value={m1} onChange={(e) => setM1(e.target.value)} spellCheck={false} maxLength={60} />
          <label className="dx-check">
            <input type="checkbox" checked={two} onChange={(e) => setTwo(e.target.checked)} />
            <span>Sign a second message with the same key</span>
          </label>
          {two ? (
            <>
              <label htmlFor={`${id}-m2`}>Second message</label>
              <input id={`${id}-m2`} className="dx-input" value={m2} onChange={(e) => setM2(e.target.value)} spellCheck={false} maxLength={60} />
            </>
          ) : null}
          <ul className="dx-wots-key" aria-hidden="true">
            <li>
              <i data-c="secret" /> secret
            </li>
            <li>
              <i data-c="rev" /> revealed
            </li>
            <li>
              <i data-c="fwd" /> anyone can compute
            </li>
            {two ? (
              <li>
                <i data-c="gain" /> gained from the 2nd signature
              </li>
            ) : null}
          </ul>
        </div>
        <div className="dx-wots-grid" role="img" aria-label={two ? `Two signatures: the attacker gained positions on ${gained} of ${rows.length} chains.` : "One signature: each chain is known only from its revealed position onward."}>
          {rows.map((r) => {
            const low = two ? Math.min(r.d1, r.d2) : r.d1;
            return (
              <div key={r.label} className="dx-wots-row" data-sum={r.sum ? "true" : "false"}>
                <span className="dx-wots-l">{r.label}</span>
                {Array.from({ length: W_STEPS }, (_, j) => {
                  const c = j === r.d1 || (two && j === r.d2) ? "rev" : j > r.d1 ? "fwd" : j > low ? "gain" : "secret";
                  return <i key={j} data-c={c} />;
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="dx-wots-out" aria-live="polite">
        {two
          ? forgeable
            ? `Two signatures expose ${gained} of ${rows.length} chains further back. Any message whose digits all sit right of the amber cells, checksum included, can now be forged: that is why a Noised key signs once, and why the vault and the identity's bitmap enforce it on-chain.`
            : "These two messages happen to expose nothing new. Most pairs do: never count on it."
          : "With one signature, forging another message means raising some digit, which lowers the checksum: a checksum chain would have to be walked backwards, which means inverting SHA-256."}
      </p>
    </Fig>
  );
}

// ----------------------------------------------------------------- vault ---

function VaultFig(): ReactNode {
  return (
    <Fig title="One address forever; the key rotates in place at every withdrawal">
      <div className="dx-vault">
        <div className="dx-vault-stages">
          <div className="dx-vault-stage">
            <Pixel name="vault" size={33} />
            <b>open_vault</b>
            <span>
              PDA <code>["vault", mint, id(k0)]</code>, sequence 0. Its token account is the deposit address.
            </span>
          </div>
          <div className="dx-vault-stage">
            <Pixel name="sig" size={33} />
            <b>withdraw</b>
            <span>
              k<sub>n</sub> signs 185 bytes. Reserves min(max, free balance) in payout #n; sequence n+1; key → k<sub>n+1</sub>. No token moves.
            </span>
          </div>
          <div className="dx-vault-stage">
            <Pixel name="coin" size={33} />
            <b>release / release_to</b>
            <span>Anyone pays the recipient's canonical account, or the recipient signs for any of its accounts.</span>
          </div>
        </div>
        <ol className="dx-keychain" aria-label="Key chain">
          {[0, 1, 2, 3, 4].map((n) => (
            <li key={n} data-state={n < 2 ? "spent" : n === 2 ? "current" : "next"}>
              <Pixel name="key" size={22} />
              <span>k{n}</span>
              <small>{n < 2 ? "SPENT" : n === 2 ? "CURRENT" : `q = ${n}`}</small>
            </li>
          ))}
        </ol>
      </div>
    </Fig>
  );
}

// ---------------------------------------------------------------- shield ---

function ShieldFig(): ReactNode {
  return (
    <Fig title="What each balance shows to everyone else">
      <ol className="dx-shield">
        <li>
          <Pixel name="coin" size={22} />
          <b>Base token</b>
          <span className="dx-shield-amt">1,250.00</span>
          <small>public</small>
        </li>
        <li className="dx-shield-op">
          wrap / unwrap <small>amount public</small>
        </li>
        <li>
          <Pixel name="eye" size={22} />
          <b>zToken, public</b>
          <span className="dx-shield-amt">1,250.00</span>
          <small>public</small>
        </li>
        <li className="dx-shield-op">
          deposit / withdraw <small>amount public</small>
        </li>
        <li data-hidden="true">
          <Pixel name="lock" size={22} />
          <b>zToken, confidential</b>
          <span className="dx-shield-amt" aria-label="hidden amount">
            ▓▓▓▓▓▓▓
          </span>
          <small>transfers hide amounts, not parties</small>
        </li>
      </ol>
    </Fig>
  );
}

// --------------------------------------------------------------- doc map ---

const DOC_MAP: { to: string; icon: GlyphName; title: string; line: string }[] = [
  { to: "/docs/quickstart", icon: "bolt", title: "Quickstart", line: "Install the SDK, read launches, verify a mint." },
  { to: "/docs/concepts/lifecycle", icon: "book", title: "Concepts", line: "Lifecycle, batch, guard, fees, PQ identity, metadata, vault, privacy." },
  { to: "/docs/guides/launch-a-token", icon: "terminal", title: "Guides", line: "One task end to end, with code." },
  { to: "/docs/sdk", icon: "cube", title: "SDK reference", line: "Every export, generated from the source." },
  { to: "/docs/programs", icon: "sig", title: "Programs reference", line: "Instructions, accounts, PDAs, events, errors." },
  { to: "/docs/security", icon: "shield", title: "Security", line: "Guarantees, who you still trust, reviews, tests." },
];

function DocMapFig(): ReactNode {
  return (
    <Fig title="Where to go next" className="dx-fig-flat">
      <ul className="dx-map">
        {DOC_MAP.map((d, i) => (
          <li key={d.to}>
            <Link to={d.to} className="dx-map-link">
              <span className="dx-map-n" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <Pixel name={d.icon} size={33} />
              <b>{d.title}</b>
              <span>{d.line}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Fig>
  );
}

// ------------------------------------------------------------ sdk groups ---

function SdkGroupsFig(): ReactNode {
  return (
    <Fig title={`${SDK_REFERENCE.entries.length} exports of ${SDK_REFERENCE.packageName} ${SDK_REFERENCE.version}`} className="dx-fig-flat">
      <ul className="dx-sdk-grid">
        {SDK_GROUPS.map((g) => {
          const entries = sdkEntriesOf(g.id);
          const fns = entries.filter((e) => e.kind === "function").length;
          return (
            <li key={g.id}>
              <Link to={`/docs/sdk/${g.id}`} className="dx-sdk-card">
                <b>{g.title}</b>
                <span>
                  {entries.length} exports{fns ? ` · ${fns} functions` : ""}
                </span>
                <code>{entries.slice(0, 3).map((e) => e.name).join(" · ")}</code>
              </Link>
            </li>
          );
        })}
      </ul>
    </Fig>
  );
}

// ---------------------------------------------------------------- lookup ---

const FIGURES: Record<string, () => ReactNode> = {
  programs: ProgramsFig,
  "program-ids": ProgramIdsFig,
  lifecycle: LifecycleFig,
  batch: BatchFig,
  "hook-order": HookOrderFig,
  fees: FeesFig,
  attest: AttestFig,
  vault: VaultFig,
  shield: ShieldFig,
  "sdk-groups": SdkGroupsFig,
  winternitz: WinternitzFig,
  "doc-map": DocMapFig,
};

export const FIGURE_NAMES: readonly string[] = Object.keys(FIGURES);

export function Figure({ name }: { name: string; args: Record<string, string> }): ReactNode {
  const F = FIGURES[name];
  return F ? <F /> : null;
}
