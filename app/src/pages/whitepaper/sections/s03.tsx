/** Section 3: system architecture (programs, PDAs, Meteora, Token-2022), with the architecture and sequence figures. */
import type { ReactNode } from "react";

import { DEdge, DGroup, Diagram, DNode, DText } from "../../../components/charts";
import { C, Eq, Figure, H3, SecRef, Section, Table, XRef } from "../paper";
import { Cite } from "../refs";
import { M } from "../tex";

function ArchitectureFigure(): ReactNode {
  return (
    <Figure
      id="fig-arch"
      title="Architecture."
      caption={
        <>
          Solid boxes are Noised's four programs, which hold every launch role through PDAs and are to be finalized after audit. Dashed boxes are
          programs other parties can upgrade (<SecRef to="evaluation" />). Arrows are instructions (from people) and cross-program invocations.
        </>
      }
      wide
    >
      <Diagram w={900} h={470} minWidth={640} label="Architecture diagram of Noised's programs, the people who call them and the external programs they call">
        <DNode x={20} y={18} w={190} h={58} title="Creator" lines={["wallet + PQ identity (LMS)"]} kind="ghost" step={0} />
        <DNode x={236} y={18} w={196} h={58} title="Committers, traders" lines={["any number of wallets"]} kind="ghost" step={0} />
        <DNode x={458} y={18} w={176} h={58} title="Keepers" lines={["anyone: execute, claim, fees"]} kind="ghost" step={0} />
        <DNode x={660} y={18} w={220} h={58} title="Vault owner" lines={["24-word PQ phrase"]} kind="ghost" step={0} />

        <DGroup x={8} y={118} w={884} h={150} label="Noised programs (no admin, finalized after audit)" />
        <DNode x={20} y={146} w={312} h={108} title="noised_launchpad" lines={["create_launch, publish_metadata, attest_launch,", "launch, commit, execute_batch, claim, distribute", "PDAs: Launch, TokenMeta, Attestation, Certificate"]} kind="strong" step={1} />
        <DNode x={350} y={146} w={196} h={108} title="noised_hook" lines={["Launch Guard", "policy + 2-entry meta list", "decides every transfer"]} kind="strong" step={2} />
        <DNode x={564} y={146} w={166} h={108} title="noised_vault" lines={["LM-OTS, v4", "withdraw (v1 tx)", "release, release_to"]} kind="strong" step={3} />
        <DNode x={748} y={146} w={132} h={108} title="noised_shield" lines={["zTokens", "1:1 wrap", "on Token-2022"]} kind="strong" step={4} />

        <DGroup x={8} y={318} w={884} h={140} label="Upgradeable by other parties" />
        <DNode x={20} y={350} w={200} h={90} title="Meteora DBC 0.2.1" lines={["bonding curve", "hook pools, fees"]} kind="ext" step={5} />
        <DNode x={238} y={350} w={180} h={90} title="Meteora DAMM v2" lines={["graduated pool", "LP 100% locked"]} kind="ext" step={5} />
        <DNode x={436} y={350} w={176} h={90} title="Token-2022 v11" lines={["transfer hook", "metadata, confidential"]} kind="ext" step={6} />
        <DNode x={630} y={350} w={122} h={90} title="SPL Token" lines={["wSOL", "(no upgrade key)"]} kind="ext" step={6} />
        <DNode x={770} y={350} w={110} h={90} title="SPL Memo" lines={["memo-required", "payouts"]} kind="ext" step={6} />

        <DEdge points={[[115, 76], [115, 146]]} label="create, publish, attest" labelAt={[122, 90, "start"]} step={7} />
        <DEdge points={[[300, 76], [300, 146]]} label="commit, claim" labelAt={[307, 113, "start"]} step={7} />
        <DEdge points={[[520, 76], [520, 96], [250, 96], [250, 146]]} label="execute_batch (top level)" labelAt={[440, 90, "middle"]} step={8} />
        <DEdge points={[[770, 76], [770, 116], [648, 116], [648, 146]]} label="withdraw, release" labelAt={[708, 110, "middle"]} step={8} />
        <DEdge points={[[332, 200], [350, 200]]} step={9} />
        <DEdge points={[[100, 254], [100, 350]]} label="CPI: config, pool, swap, fees" labelAt={[108, 278, "start"]} step={9} />
        <DEdge points={[[190, 350], [190, 302], [470, 302], [470, 350]]} dash="dash" label="swap transfers" labelAt={[330, 296, "middle"]} step={10} />
        <DEdge points={[[524, 350], [524, 254]]} label="Execute (hook CPI)" labelAt={[530, 330, "start"]} step={10} />
        <DEdge points={[[220, 412], [238, 412]]} step={11} />
        <DText x={222} y={404} kind="small">
          migrate
        </DText>
        <DEdge points={[[648, 254], [648, 312], [690, 312], [690, 350]]} dash="dash" step={11} />
        <DEdge points={[[714, 254], [714, 290], [824, 290], [824, 350]]} dash="dash" step={11} />
      </Diagram>
    </Figure>
  );
}

const LANES = [
  { key: "creator", label: "Creator", x: 100 },
  { key: "pq", label: "PQ identity", x: 196 },
  { key: "lp", label: "Launchpad", x: 300 },
  { key: "hook", label: "Hook", x: 402 },
  { key: "dbc", label: "DBC", x: 496 },
  { key: "t22", label: "Token-2022", x: 594 },
  { key: "users", label: "Users", x: 700 },
  { key: "keeper", label: "Keeper", x: 800 },
  { key: "damm", label: "DAMM v2", x: 896 },
] as const;

type Lane = (typeof LANES)[number]["key"];

function laneX(k: Lane): number {
  return LANES.find((l) => l.key === k)?.x ?? 0;
}

interface Msg {
  from: Lane;
  to: Lane;
  label: string;
  dash?: "dash" | "dot";
}

const PHASES: { label: string; msgs: Msg[] }[] = [
  {
    label: "configure",
    msgs: [
      { from: "creator", to: "lp", label: "create_launch(params, pq_identity)" },
      { from: "lp", to: "dbc", label: "create config (PDA signer)" },
    ],
  },
  {
    label: "attest",
    msgs: [
      { from: "creator", to: "lp", label: "publish_metadata(record) · v1 tx · throwaway payer" },
      { from: "pq", to: "lp", label: "attest_launch(LMS sig, record hash, window) · leaf burned" },
    ],
  },
  {
    label: "launch",
    msgs: [
      { from: "keeper", to: "lp", label: "launch() · anyone, in the window" },
      { from: "lp", to: "dbc", label: "init pool (Token-2022 + hook)" },
      { from: "lp", to: "hook", label: "meta list, create_policy" },
    ],
  },
  {
    label: "commit",
    msgs: [{ from: "users", to: "lp", label: "commit(wSOL) × n" }],
  },
  {
    label: "execute",
    msgs: [
      { from: "keeper", to: "lp", label: "execute_batch (top level)" },
      { from: "lp", to: "dbc", label: "swap: the pool's first" },
      { from: "dbc", to: "t22", label: "transfer base" },
      { from: "t22", to: "hook", label: "Execute: batch buy, pass" },
      { from: "lp", to: "hook", label: "end_snipe_shield" },
    ],
  },
  {
    label: "claim, trade",
    msgs: [
      { from: "users", to: "lp", label: "claim: tokens + refund, pro rata" },
      { from: "users", to: "dbc", label: "public swaps (guard rules)", dash: "dash" },
    ],
  },
  {
    label: "graduate",
    msgs: [
      { from: "dbc", to: "damm", label: "migration at threshold" },
      { from: "keeper", to: "lp", label: "claim_lp_fees, distribute", dash: "dash" },
    ],
  },
];

function SequenceFigure(): ReactNode {
  const top = 46;
  const step = 30;
  const phaseGap = 14;
  let y = top + 16;
  const rows: { y: number; msg: Msg }[] = [];
  const phases: { label: string; y0: number; y1: number }[] = [];
  for (const ph of PHASES) {
    const y0 = y - 10;
    for (const m of ph.msgs) {
      rows.push({ y, msg: m });
      y += step;
    }
    phases.push({ label: ph.label, y0, y1: y - step + 12 });
    y += phaseGap;
  }
  const h = y + 6;
  return (
    <Figure
      id="fig-seq"
      title="One launch, from configuration to graduation."
      caption={
        <>
          Time runs downward. Only the creator's hash-based identity can attest; anyone may publish the record, relay that signature, run{" "}
          <C>launch</C> inside the signed window, execute the batch, crank claims and route fees. Until the batch the hook refuses every buy but the batch's own (
          <SecRef to="guard" />).
        </>
      }
      wide
    >
      <Diagram w={940} h={h} minWidth={720} label="Sequence diagram of a launch">
        {LANES.map((l) => (
          <g key={l.key}>
            <DText x={l.x} y={18} anchor="middle" kind="title">
              {l.label}
            </DText>
            <line x1={l.x} x2={l.x} y1={28} y2={h - 4} className="seq-life" />
          </g>
        ))}
        {phases.map((p, i) => (
          <g key={p.label}>
            <rect x={2} y={p.y0} width={936} height={p.y1 - p.y0} rx={6} className={i % 2 === 0 ? "seq-band" : "seq-band-alt"} />
            <DText x={8} y={p.y0 + 13} kind="faint">
              {p.label}
            </DText>
          </g>
        ))}
        {rows.map(({ y: ry, msg }, i) => {
          const a = laneX(msg.from);
          const b = laneX(msg.to);
          const dir = b >= a ? 1 : -1;
          const mid = (a + b) / 2;
          return (
            <DEdge
              key={i}
              points={[
                [a + dir * 4, ry],
                [b - dir * 6, ry],
              ]}
              label={msg.label}
              labelAt={[mid, ry - 6, "middle"]}
              dash={msg.dash ?? "solid"}
              ink={msg.dash ? 3 : 2}
              step={i}
            />
          );
        })}
      </Diagram>
    </Figure>
  );
}

export function S03(): ReactNode {
  return (
    <Section id="architecture">
      <p>
        Noised is four Anchor programs and a TypeScript SDK (<XRef to="fig-arch" />). The launchpad creates a Meteora Dynamic Bonding Curve (DBC){" "}
        <Cite k="dbc" /> configuration with fixed safe values, launches the pool with a Token-2022 <Cite k="token2022" /> mint whose transfer hook is
        Launch Guard, runs the fair-open batch, routes fees by immutable rules and writes an on-chain certificate. At graduation DBC migrates the
        pool to DAMM v2 <Cite k="damm" />, where 100% of the liquidity is permanently locked under a launchpad PDA. The vault and the shield are
        independent of launches: post-quantum custody for any eligible mint, and opt-in confidential balances <Cite k="noised-spec" />.
      </p>
      <ArchitectureFigure />
      <H3 id="arch-pdas" n="3.1">
        Roles held by addresses without keys
      </H3>
      <p>
        A program-derived address is <M>{"\\mathrm{PDA}(s, \\pi) = \\mathrm{SHA256}(s \\,\\|\\, \\pi \\,\\|\\, \\texttt{\"ProgramDerivedAddress\"})"}</M>{" "}
        for seeds <M>{"s"}</M> and program <M>{"\\pi"}</M>, accepted only when the result is not an Ed25519 point; only <M>{"\\pi"}</M> can sign
        for it. <XRef to="tab-pdas" /> lists every PDA a launch uses. None is ever closed, and no instruction changes a launch's fee recipients,
        hook policy or DBC configuration after creation.
      </p>
      <Table id="tab-pdas" title="Launchpad PDAs and their roles.">
        <thead>
          <tr>
            <th>Account</th>
            <th>Seeds</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Protocol</td>
            <td className="mono">"protocol"</td>
            <td>Treasury and platform fee share, written once, never updatable.</td>
          </tr>
          <tr>
            <td>Launch</td>
            <td className="mono">"launch", creator, seed[32]</td>
            <td>All creator choices (including <C>pq_identity</C>), timeline, batch caps and totals.</td>
          </tr>
          <tr>
            <td>Launch authority</td>
            <td className="mono">"authority", launch</td>
            <td>DBC pool creator, partner, fee claimer and leftover receiver; owns the DAMM v2 LP position and the fee vaults.</td>
          </tr>
          <tr>
            <td>Batch authority</td>
            <td className="mono">"batch", launch</td>
            <td>Owns the batch escrows and pays for the batch swap.</td>
          </tr>
          <tr>
            <td>DBC config</td>
            <td className="mono">"dbc-config", launch</td>
            <td>The DBC transfer-hook configuration, created by CPI with this PDA as signer.</td>
          </tr>
          <tr>
            <td>Hook authority</td>
            <td className="mono">"hook-authority"</td>
            <td>The only signer Launch Guard accepts for policies and for ending the shield.</td>
          </tr>
          <tr>
            <td>Identity</td>
            <td className="mono">"identity", pq_identity</td>
            <td>A creator's LMS public key and its 1,024-bit used-leaf bitmap (<SecRef to="identity" />).</td>
          </tr>
          <tr>
            <td>Token metadata</td>
            <td className="mono">"metadata", launch, metadata_hash</td>
            <td>The token's name, symbol, uri mode and document, at the address of its own hash; never modified or closed (<SecRef to="identity" />).</td>
          </tr>
          <tr>
            <td>Attestation</td>
            <td className="mono">"attestation", launch</td>
            <td>The LMS signature that let the launch go live, kept in full, with the record's hash and the window.</td>
          </tr>
          <tr>
            <td>Certificate</td>
            <td className="mono">"certificate", mint</td>
            <td>Immutable record of the launch checks, the policy and the post-quantum origin.</td>
          </tr>
          <tr>
            <td>Commit</td>
            <td className="mono">"commit", launch, owner</td>
            <td>One participant's batch commitment and its fixed payout owners.</td>
          </tr>
          <tr>
            <td>Payout vault</td>
            <td className="mono">"payout-vault", launch, vault</td>
            <td>What every commit naming one PQ vault committed, held to one wallet's cap together (<SecRef to="batch" />).</td>
          </tr>
        </tbody>
      </Table>
      <H3 id="arch-flow" n="3.2">
        Life of a launch
      </H3>
      <p>
        <XRef to="fig-seq" /> follows one launch. <C>create_launch</C> validates the creator's parameters against the safety policy and creates the
        DBC configuration (status Configured). A throwaway key publishes the token's metadata record (<C>publish_metadata</C>); the creator's
        post-quantum identity then signs the launch's attestation message, which names that record by its hash, and the same key relays it in a
        version-1 transaction (<C>attest_launch</C>), which burns one LMS leaf. <C>launch</C>, permissionless inside the signed window and without
        arguments, creates the pool and the mint from the record, the hook's meta list and policy, verifies the mint's post-conditions and writes
        the certificate. With launch time{" "}
        <M>{"T_0"}</M>, commit window <M>{"\\delta \\in [60, 1800]"}</M> s, execution window <M>{"E = 600"}</M> s and guard <M>{"g \\le 72"}</M> h,
        the timeline is
      </p>
      <Eq n="3.1">
        {
          "\\underbrace{[T_0,\\, T_0 + \\delta)}_{\\text{commit}} \\;\\to\\; \\underbrace{[T_0 + \\delta,\\, T_0 + \\delta + E)}_{\\text{execute (ends early at the batch)}} \\;\\to\\; \\underbrace{[\\,\\cdot\\,,\\, T_0 + g)}_{\\text{guard}} \\;\\to\\; \\text{open} \\;\\to\\; \\text{graduation}"
        }
      </Eq>
      <SequenceFigure />
      <H3 id="arch-depth" n="3.3">
        Call depth
      </H3>
      <p>
        Solana allows an instruction stack of depth 5. The deepest Noised path is the batch buy, <C>execute_batch</C> → DBC <C>swap</C> →
        Token-2022 → Launch Guard, of depth 4. The design never adds a layer in between; a <C>execute_batch</C> invoked by another program would
        reach depth 5 but is refused by the hook anyway (<SecRef to="guard" />). The launchpad links neither the vault nor the shield: it recognizes
        a PQ vault (as treasury or payout owner) by the vault account's owner, discriminator, version and mint bytes alone.
      </p>
    </Section>
  );
}
