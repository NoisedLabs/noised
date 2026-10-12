/** Sections 12 (security evaluation) and 13 (performance). */
import type { ReactNode } from "react";

import { BarChart, type BarRow } from "../../../components/charts";
import { FINAL_SIZES, LAUNCH_CU, launchCuBound, MEASURED, TESTS } from "../model/perf";
import { Aside, C, Eq, Figure, H3, SecRef, Section, Table, Tag, XRef } from "../paper";
import { Cite, Fn } from "../refs";
import { M } from "../tex";

const INVARIANTS: readonly [string, string][] = [
  ["Mint", "Every certified mint has no mint, freeze or metadata authority and exactly the extensions MetadataPointer, TokenMetadata and TransferHook (Launch Guard) until graduation; then the hook is revoked."],
  ["Config", "Every launchpad-created DBC configuration has exactly the fixed safe values."],
  ["Sells", "No sell, and no zero-amount transfer that is not a buy, is ever refused; no rule applies after the guard; mints without a policy are never restricted."],
  ["Batch", "Σ commits = total; quote spent ≤ min(total, cap); each commit is paid once; payouts never exceed tokens out and unspent quote; expired batches refund 100%."],
  ["Fees", "distribute pays at most the balance; the platform share uses the snapshotted bps; recipients never change after create_launch."],
  ["Funds", "No instruction moves launchpad-PDA funds except the batch buy, batch claims, fee distribution and base-token burns."],
  ["No admin", "Protocol cannot be modified; no pause; programs are finalized after audit."],
  ["Vault", "Tokens leave a vault only through release / release_to of a payout created by a valid LM-OTS signature of the current key over the exact message; the sequence increments and the key rotates on every withdrawal."],
  ["Shield", "zToken supply never exceeds the escrow balance, after every instruction (donations can only add surplus)."],
  ["Executable", "A valid vault signature always executes: withdraw reads no account a third party controls."],
  ["Reserve", "reserved ≤ vault token balance, before and after every vault instruction."],
  ["One buy", "Before the shield ends, the only buy is the batch buy, inside a top-level execute_batch."],
  ["First swap", "The batch is the pool's first swap, or it refunds."],
  ["Origin (v2)", "launch runs only with an attestation by the identity the launch names, over its exact parameters, metadata record and window, and only inside that window."],
  ["Leaves (v2)", "Each LMS leaf of an identity lands at most once, ever; every valid signature at an unused leaf lands."],
  ["Shield end (v2)", "Only the launchpad's hook-authority PDA can end a shield, and only earlier, never later."],
  ["Key index (v2)", "A vault's key at sequence k has leaf index k."],
  ["Payout owners (v2)", "claim pays only the payout owners the first commit fixed; a vault named by several commits receives at most one wallet's cap."],
  ["Metadata (v3)", "A TokenMeta record is never modified or closed and sits at the hash of its own content; launch gives the mint exactly the record its attestation names (name, symbol, derived uri, no other field)."],
  ["Relay (v3)", "Every account of attest_launch except the payer is fixed by the signed data; any other record account fails the transaction and burns nothing."],
];

const FINDINGS: readonly { id: string; sev: "High" | "Medium" | "Low"; text: string; status: string }[] = [
  { id: "V1", sev: "High", text: "A recipient could block a signed withdrawal and freeze the vault (v3 paid inside withdraw).", status: "Fixed: vault v4" },
  { id: "L1", sev: "High", text: "The creator could fill the batch cap in the launch transaction (first come, first served).", status: "Fixed: pro-rata fill" },
  { id: "L2", sev: "High", text: "A buy into an exempt account passed the shield and raised the batch's dynamic fee; residual: zero-output buys.", status: "Fixed: sysvar check, first-swap rule" },
  { id: "V3", sev: "Medium", text: "A fixed transfer fee was charged on the whole balance at every withdrawal (successor vaults).", status: "Fixed: rotate in place" },
  { id: "V4", sev: "Medium", text: "A mint with a close authority could be re-created with a permanent delegate.", status: "Fixed: refused at open" },
  { id: "V2", sev: "Low", text: "A withdrawal to the vault itself or its successor could be signed but never executed.", status: "Fixed: v4" },
  { id: "L3", sev: "Low", text: "A reassigned wSOL ATA blocked its owner's claim.", status: "Fixed, with a trade-off" },
  { id: "V5", sev: "Low", text: "SOL or other mints sent to the vault PDA itself are unrecoverable.", status: "Documented limitation" },
  { id: "C1", sev: "Low", text: "Re-signing the same withdrawal drew a fresh randomizer (two signatures).", status: "Fixed in the crate and the SDK" },
  { id: "C2", sev: "Low", text: "No client checked the recipient before signing.", status: "Fixed: recipient check and confirmation" },
];

/** Every internal review so far, with the severities its confirmed findings were rated (docs/AUDIT.md overview). */
export const REVIEWS: readonly { key: string; label: string; date: string; who: string; high: number; medium: number; low: number; info: number; outcome: string }[] = [
  { key: "r1", label: "Round 1", date: "2026-10-08", who: "7 finders, 45 skeptics", high: 3, medium: 2, low: 5, info: 0, outcome: "every program fix with regression tests; V5 a documented limitation" },
  { key: "r1b", label: "Round 1b", date: "2026-10-08", who: "2 adversarial reviewers, 2 test agents", high: 1, medium: 0, low: 0, info: 0, outcome: "closed in two layers (hook, first-swap rule); weak tests rewritten" },
  { key: "clients", label: "Clients review", date: "2026-10-08", who: "1 reviewer", high: 0, medium: 3, low: 5, info: 1, outcome: "fixed in SDK 0.2 and 0.3 and in the app" },
  { key: "r2", label: "Round 2", date: "2026-10-08", who: "8 finders, 34 skeptics", high: 1, medium: 4, low: 11, info: 0, outcome: "program fixes in protocol v2; contention mitigated, a residual" },
  { key: "pqv2", label: "PQ v2 adversarial", date: "2026-10-09", who: "1 reviewer, proof of concept", high: 0, medium: 2, low: 3, info: 2, outcome: "all fixed" },
  { key: "sdk", label: "SDK 0.2 and 0.3", date: "2026-10-09", who: "3 reviewers", high: 0, medium: 5, low: 9, info: 6, outcome: "all fixed" },
  { key: "meta", label: "On-chain metadata", date: "2026-10-09", who: "1 reviewer, proof of concept", high: 0, medium: 1, low: 0, info: 1, outcome: "fixed: any other record account fails" },
  { key: "r3", label: "Round 3", date: "2026-10-10", who: "6 lenses, 2 skeptics per finding", high: 0, medium: 1, low: 2, info: 2, outcome: "F1, F2 fixed and merged; F3 client check; F4 documented" },
];

const SEVERITIES = ["high", "medium", "low", "info"] as const;

function AuditFigure(): ReactNode {
  const total = (sev: (typeof SEVERITIES)[number]): number => REVIEWS.reduce((a, r) => a + r[sev], 0);
  const rows: BarRow[] = REVIEWS.map((r) => ({
    key: r.key,
    label: r.label,
    sub: r.date,
    bars: SEVERITIES.map((sev) => ({ group: sev, value: r[sev], label: String(r[sev]), note: r.outcome })),
  }));
  return (
    <Figure
      id="fig-audit"
      title="Confirmed findings of every internal review, by severity."
      caption={
        <>
          {`${total("high")} high, ${total("medium")} medium, ${total("low")} low and ${total("info")} informational findings over eight reviews, each confirmed by skeptics or a proof of concept. Every high and medium finding is fixed or, for write-lock contention, made linearly more expensive; round 3's two program fixes are merged. No finding was confirmed against the shield's own code or the LM-OTS and LMS verification. These were internal reviews by AI agents, not an independent audit `}
          <Cite k="noised-sec" />.
        </>
      }
      wide
    >
      <BarChart
        rows={rows}
        groups={[
          { key: "high", label: "high", ink: 1 },
          { key: "medium", label: "medium", ink: 2 },
          { key: "low", label: "low", ink: 3, hatch: true },
          { key: "info", label: "info", ink: 4 },
        ]}
        axis={{ domain: [0, 12], label: "confirmed findings", ticks: [0, 3, 6, 9, 12], format: (v) => String(v) }}
        thickness={7}
        ariaLabel="Bar chart of confirmed findings per internal review, by severity"
      />
    </Figure>
  );
}

export function S12(): ReactNode {
  const t1 = TESTS.r1b;
  const t2 = TESTS.v2;
  const t3 = TESTS.final;
  return (
    <Section id="evaluation">
      <H3 id="eval-invariants" n="12.1">
        Invariants
      </H3>
      <p>
        <XRef to="tab-invariants" /> is the audit checklist: each line is a property the programs enforce in every reachable state, and each is
        pinned by tests that replay attacks against the mainnet binaries of DBC, DAMM v2, Token-2022 and SPL Token.
      </p>
      <Table id="tab-invariants" title="Invariants (SPEC §7, protocol v2 and safety policy 3).">
        <thead>
          <tr>
            <th>Name</th>
            <th>Property</th>
          </tr>
        </thead>
        <tbody>
          {INVARIANTS.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <H3 id="eval-review" n="12.2">
        Adversarial review
      </H3>
      <p>
        Round 1 (2026-10-08) ran seven finders in parallel, each with one lens (accounts and PDAs; CPI and Meteora integration; Token-2022 and the
        hook; economics; post-quantum crypto and the vault state machine; liveness and DoS; policy completeness), all reading the specification,
        the code and the Meteora, Anchor and Token-2022 sources, and writing proof-of-concept tests against mainnet binaries in scratch copies. Each
        finding then went to one to three skeptics instructed to answer "not real" unless the scenario held. Fixes were checked by two further
        adversarial reviewers; the launchpad reviewer found one more path through the shield (a buy whose output rounds to zero), closed in round
        1b in two layers. <XRef to="tab-findings" /> lists round 1's issues.
      </p>
      <Table id="tab-findings" title="Round 1 and 1b: confirmed issues.">
        <thead>
          <tr>
            <th>ID</th>
            <th>Severity</th>
            <th>Finding</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {FINDINGS.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.id}</td>
              <td>{f.sev}</td>
              <td>{f.text}</td>
              <td className="muted">{f.status}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p>
        Every later change was reviewed the same way (<XRef to="tab-reviews" />, <XRef to="fig-audit" />). Round 2 added a lens on the documents'
        own claims and found that write-lock contention made the 10-second commit and 30-second execution windows cheap to block (
        <SecRef to="liveness" />); its program fixes are protocol v2. A spec review issued 17 binding amendments to the post-quantum design before
        any code was written (among them: the identity binds the metadata, every revealed signature must be landable, and "NIST approved" and
        "audited" were not facts), and an adversarial review of the result found an unburnable leaf that let a third party forge a second
        signature, fixed by verifying first and always burning the leaf (<SecRef to="identity" />). The on-chain metadata review found that a
        relayer could turn an attesting signature into a burn by naming another record account, fixed by deriving that account from the signed
        hash. Round 3, on the final programs, confirmed five findings, recorded 92 areas checked and found sound, and led to two program fixes,
        both merged: F1 (an expired, unused attestation can be replaced, and a window needs 60 s left when it lands) and
        F2 (guarded transfers only into token accounts with a fixed owner).
      </p>
      <Table id="tab-reviews" title="Every internal review." caption="Severities as confirmed; round 1b's other results (3 weak tests, 1 documentation claim, 1 size limit) were not severity-rated.">
        <thead>
          <tr>
            <th>Review</th>
            <th>Date</th>
            <th>Reviewers</th>
            <th className="num">High</th>
            <th className="num">Medium</th>
            <th className="num">Low</th>
            <th className="num">Info</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {REVIEWS.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="mono">{r.date}</td>
              <td>{r.who}</td>
              <td className="num">{r.high}</td>
              <td className="num">{r.medium}</td>
              <td className="num">{r.low}</td>
              <td className="num">{r.info}</td>
              <td className="muted">{r.outcome}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <AuditFigure />
      <H3 id="eval-tests" n="12.3">
        Testing
      </H3>
      <Table id="tab-tests" title="Test results." caption="Round 1b as published; v2 from the integration build's logs; final from the final verification of the programs with on-chain metadata (before round 3's fixes) and SDK 0.4.0.">
        <thead>
          <tr>
            <th>Suite</th>
            <th className="num">Round 1b, {t1.date}</th>
            <th className="num">v2 build, {t2.date}</th>
            <th className="num">Final build, {t3.date}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Host unit and property tests (programs)</td>
            <td className="num">{t1.host}</td>
            <td className="num">{t2.hostLaunchpad + t2.hostHook + t2.hostShield + t2.hostVault}</td>
            <td className="num">{t3.host}</td>
          </tr>
          <tr>
            <td>noised-lmots (RFC 8554 vectors, HMAC, randomizer, LMS)</td>
            <td className="num">{t1.lmots}</td>
            <td className="num">{t2.lmotsUnit + t2.lmotsKat + t2.lmsTests}</td>
            <td className="num">{t3.kat}</td>
          </tr>
          <tr>
            <td>Vault, hook and launchpad integration (LiteSVM, mainnet token programs)</td>
            <td className="num">{t1.integration}</td>
            <td className="num">{t2.integration}</td>
            <td className="num">{t3.integration}</td>
          </tr>
          <tr>
            <td>Launchpad end to end (LiteSVM, mainnet DBC and DAMM v2)</td>
            <td className="num">{t1.launchpadSvm}</td>
            <td className="num">{t2.launchpadSvm}</td>
            <td className="num">{t3.launchpadSvm}</td>
          </tr>
          <tr>
            <td>Shield (LiteSVM)</td>
            <td className="num">{t1.shieldSvm}</td>
            <td className="num">{t2.shieldSvm}</td>
            <td className="num">{t3.shieldSvm}</td>
          </tr>
          <tr>
            <td>Mutation testing: broken program copies caught by the integration suite</td>
            <td className="num">{`${t1.mutantsKilled} / ${t1.mutantsTotal}`}</td>
            <td className="num">{`${t2.itMutantsKilled} / ${t2.itMutantsTotal}`}</td>
            <td className="num">{`${t3.itMutantsKilled} / ${t3.itMutantsTotal}`}</td>
          </tr>
          <tr>
            <td>Mutation testing: launchpad mutants only the LiteSVM suite reaches</td>
            <td className="num">-</td>
            <td className="num">8 / 8</td>
            <td className="num">{`${t3.svmMutantsKilled} / ${t3.svmMutantsTotal}`}</td>
          </tr>
          <tr>
            <td>Mutation testing: LMS implementation</td>
            <td className="num">-</td>
            <td className="num">{`${t2.lmsMutantsKilled} / ${t2.lmsMutantsTotal}`}</td>
            <td className="num">unchanged crate</td>
          </tr>
          <tr>
            <td>SDK (byte parity with Rust-produced vectors)</td>
            <td className="num">{t1.sdk}</td>
            <td className="num">{t2.sdk}</td>
            <td className="num">{t3.sdk}</td>
          </tr>
          <tr>
            <td>Mutation testing: the SDK's new code</td>
            <td className="num">-</td>
            <td className="num">-</td>
            <td className="num">{`${t3.sdkMutantsKilled} / ${t3.sdkMutantsTotal}`}</td>
          </tr>
        </tbody>
      </Table>
      <p>
        The LM-OTS and LMS code reproduces RFC 8554 Appendix F byte for byte, including the full height-10 tree of Test Case 2 rebuilt from its
        1,024 one-time keys, and its HMAC matches RFC 4231 <Cite k="rfc4231" />; three independent Python re-derivations match every committed
        vector, the metadata records included. The final integration mutants are 38 vault, 36 hook and 74 launchpad mutants; two more LiteSVM
        mutants survive by design, because they change only the <C>MetadataMismatch</C> comparison, which an honest DBC can never reach (host
        tests pin it directly). The SDK's three surviving mutants are equivalent re-checks kept as defence in depth. Round 3's F1 and F2 came
        with their own tests (the audit's proofs of concept as LiteSVM tests, plus integration tests of the hook) and kill every mutant of
        their new rules: 43 hook and 74 launchpad integration mutants, 17 LiteSVM and 8 host mutants.
      </p>
      <H3 id="eval-residual" n="12.4">
        Residual risks and trusted parties
      </H3>
      <ul className="wp-list">
        <li>
          <strong>Write-lock contention</strong> can keep commits, the batch or <C>launch</C> out of their windows while someone pays for it; the
          batch then refunds in full, and an unused launch window is signed again (F1; <SecRef to="liveness" />).
        </li>
        <li>
          <strong>The first transaction in a window wins</strong>, and whoever relays an attestation decides when it lands; nobody can change what a
          signed transaction does.
        </li>
        <li>
          <strong>Two devices, two ledgers.</strong> A phrase or identity used on two devices that do not share their one-time-key records can sign
          two messages with one key; the SDK's authenticated export and import narrow the window, and a shared ledger closes it.
        </li>
        <li>
          Claims and payouts follow a reassigned SPL Token ATA (so that nobody but the holder can block them); a wallet tricked into signing an
          owner change loses later refunds to the new owner.
        </li>
        <li>
          Anyone may fill a PQ vault's batch quota by naming it in a commit (the tokens go to the vault, the unspent wSOL back to the griefer's
          own refund owner); during the guard anyone may fill a shared account (the shield's escrow, shared by every holder, or someone's ATA)
          to max wallet; and the wallet-to-wallet lock stops transfers, not changes of control without one: a shared wallet, a PDA or
          smart-wallet owner changing hands, a PQ vault's key rotation, or a delegate approval.
        </li>
        <li>Launch Guard trusts the launchpad's <C>execute_batch</C> to make exactly one swap; any change to it must keep that property.</li>
        <li>A hook upgraded in place with a different account list would break every existing mint's transfers, so it must never be done.</li>
        <li>The batch is pro rata: capital still counts, and per-wallet caps are Sybil-splittable.</li>
      </ul>
      <Table id="tab-trust" title="Who a launch still trusts.">
        <thead>
          <tr>
            <th>Party</th>
            <th>What it can do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Meteora upgrade multisig (4-of-7, no timelock)</td>
            <td>Replace DBC and DAMM v2, including behaviour the shield relies on; a batch that then cannot execute refunds.</td>
          </tr>
          <tr>
            <td>DAMM v2 admins and operators</td>
            <td>Disable a graduated pool (locked liquidity stuck), raise its base fee up to 10%, close migration configs.</td>
          </tr>
          <tr>
            <td>Token-2022 upgrade multisig (4-of-6); the ATA program</td>
            <td>Replace the token program governing every Noised token, zToken and Token-2022 vault; create every account Noised pays.</td>
          </tr>
          <tr>
            <td>Validators (feature gates), consensus</td>
            <td>Change the runtime; Ed25519 vote keys are not post-quantum.</td>
          </tr>
          <tr>
            <td>Leaders and ordering gateways</td>
            <td>Reorder, delay or drop transactions and decide who lands first in a window; cannot change signed content.</td>
          </tr>
          <tr>
            <td>Wallets; passkey authenticators and sync providers</td>
            <td>Show what the user signs and hold classical keys; a synced passkey's provider can move the identity's PRF secret.</td>
          </tr>
          <tr>
            <td>Noised's upgrade key, until finalization</td>
            <td>Replace any of the four programs. Removed by finalizing after audit.</td>
          </tr>
          <tr>
            <td>Frontend, DNS, RPC, wallet</td>
            <td>Show false information or ask for a harmful signature; verify with the SDK against several RPCs.</td>
          </tr>
        </tbody>
      </Table>
      <Aside title="Bottom line" tone="warn">
        <p>
          The evidence is local: LiteSVM against mainnet program dumps and host tests, reviewed by AI agents in eight reviews. Two independent
          audits are required before the programs are finalized (<SecRef to="limitations" />). Until then, treat Noised as pre-audit software.
        </p>
      </Aside>
      <H3 id="eval-qsl" n="12.5">
        The QSL-1 standard
      </H3>
      <p>
        The guarantees above are written down as a named, versioned token standard, QSL-1 (&ldquo;Quantum Security Layer token, version 1&rdquo;),
        so that a wallet, an explorer or an indexer can recognise them without trusting Noised&rsquo;s word. QSL-1 does not change Token-2022: a QSL-1
        token is an ordinary Token-2022 mint with a fixed profile (no mint or freeze authority, immutable metadata, exactly three extensions),
        layered the way ERC-4626 is layered on ERC-20. The launchpad, which refuses to launch anything else, records what it verified in the
        certificate, one immutable account per mint; a verifier re-checks every condition from live accounts and never trusts the certificate&rsquo;s
        flags alone.
      </p>
      <ul className="wp-list">
        <li>
          <strong>Level 1, No-rug.</strong> Nobody can mint more, freeze holders, change the metadata, withdraw the graduated liquidity, block sales
          or redirect fees; 24 conditions over the mint, the DBC configuration, the pool, the hook policy and, after migration, the locked
          position, ending with finalized programs.
        </li>
        <li>
          <strong>Level 2, Quantum-attested.</strong> Level 1, and the launch went live only because the creator&rsquo;s LMS identity signed its
          parameters, its on-chain metadata record and its window (<SecRef to="identity" />); the 189-byte message is rebuilt from account state and
          the signature re-verified.
        </li>
      </ul>
      <p>
        There is no third level. A token whose creator added launch rules or automation is <em>programmable</em>: a tag shown next to its level
        (&ldquo;QSL-1 L2 &middot; programmable &mdash; read its rules&rdquo;) with plain-English warnings, never a level and never
        &ldquo;safer&rdquo;. A rule set can be signed, bound and enforced exactly as written and still let only the creator&rsquo;s chosen
        wallets buy for a while: binding proves who set the rules, not that they are good for holders.
      </p>
      <p>
        A verifier awards no level while the programs can still be upgraded or the endpoint is not mainnet-beta: until finalization every token
        is at most a <em>candidate</em>, which is what the app shows on devnet. The SDK&rsquo;s <C>checkQsl1</C> implements the algorithm, and the
        app&rsquo;s badge uses only the standard&rsquo;s own wording, which forbids &ldquo;quantum-proof&rdquo;: a QSL-1 token is held in ordinary
        wallets, and level 2 is post-quantum launch authorization and metadata integrity inside a chain that is not post-quantum.
      </p>
    </Section>
  );
}

function CuFigure(): ReactNode {
  const groups = ["launch", "trade", "vault", "hook", "shield"] as const;
  const rows: BarRow[] = MEASURED.map((m) => ({
    key: m.key,
    label: m.label,
    sub: m.source === "final" ? "final build" : m.source === "v2" ? "v2 build" : "round 1b",
    bars: [
      {
        group: m.group,
        value: m.cuMid ?? m.cuHi,
        ...(m.cuLo !== m.cuHi ? { lo: m.cuLo, hi: m.cuHi } : {}),
        label: m.cuLo === m.cuHi ? `${(m.cuHi / 1000).toFixed(1)}k` : m.cuHi - m.cuLo < 2_000 ? `${(m.cuLo / 1000).toFixed(1)}k-${(m.cuHi / 1000).toFixed(1)}k` : `${(m.cuLo / 1000).toFixed(0)}k-${(m.cuHi / 1000).toFixed(0)}k`,
        note: m.note,
      },
    ],
  }));
  const largest = MEASURED.reduce((a, m) => (m.cuHi > a.cuHi ? m : a));
  return (
    <Figure
      id="fig-cu"
      title="Compute per instruction, measured."
      caption={
        <>
          Ranges are minimum to maximum over all runs (random addresses change bump searches; signature verification depends on the digest; the
          tick in <C>attest_launch</C> is the mean over all 1,024 leaves of one identity, in <C>publish_metadata</C> the typical record).
          Every instruction stays far below Solana's 1.4M-CU transaction limit; the largest measured, <C>{largest.label}</C> at{" "}
          {largest.cuHi.toLocaleString("en-US")} CU, is about {Math.round((largest.cuHi / 1_400_000) * 100)}% of it. Hover a bar for details.
        </>
      }
      wide
    >
      <BarChart
        rows={rows}
        groups={groups.map((g, i) => ({ key: g, label: { launch: "launchpad", trade: "trading", vault: "PQ vault", hook: "Launch Guard", shield: "shield" }[g], ink: ([1, 2, 2, 3, 3] as const)[i] ?? 1, hatch: g === "trade" || g === "hook" }))}
        axis={{ domain: [0, 250_000], label: "compute units", ticks: [0, 50_000, 100_000, 150_000, 200_000, 250_000], format: (v) => (v === 0 ? "0" : `${v / 1000}k`) }}
        thickness={10}
        ariaLabel="Measured compute units per instruction"
      />
    </Figure>
  );
}

function BytesFigure(): ReactNode {
  const rows: BarRow[] = MEASURED.filter((m) => m.bytes !== undefined).map((m) => ({
    key: m.key,
    label: m.label,
    sub: m.format === "v1" ? "version-1 transaction" : "legacy transaction",
    bars: [{ group: m.format, value: m.bytes ?? 0, label: `${(m.bytes ?? 0).toLocaleString("en-US")} B`, note: m.note }],
  }));
  return (
    <Figure
      id="fig-bytes"
      title="Transaction sizes against their limits."
      caption={
        <>
          Legacy transactions are limited to 1,232 bytes; version-1 transactions (SIMD-0385) to 4,096. Version 1 carries what cannot fit: the two
          hash-based signatures (an LM-OTS signature is 2,176 bytes, an LMS signature 2,508) and metadata records of up to 3,405 bytes (the bar is
          the largest record; the typical one is 1,460 bytes). Every wallet-signed step fits a legacy transaction, <C>launch</C> in a constant 987
          bytes for every record; version-1 transactions are paid by a throwaway key, because several wallets cannot sign them.
        </>
      }
      wide
    >
      <BarChart
        rows={rows}
        groups={[
          { key: "legacy", label: "legacy", ink: 2 },
          { key: "v1", label: "version 1", ink: 1 },
        ]}
        axis={{ domain: [0, 4096], label: "bytes", ticks: [0, 1024, 2048, 3072, 4096], format: (v) => v.toLocaleString("en-US") }}
        rules={[
          { value: 1232, label: "1,232 legacy" },
          { value: 4096, label: "4,096 v1" },
        ]}
        thickness={10}
        ariaLabel="Transaction sizes in bytes against the legacy and version-1 limits"
      />
    </Figure>
  );
}

export function S13(): ReactNode {
  const L = LAUNCH_CU;
  return (
    <Section id="performance">
      <p>
        All measurements are LiteSVM 0.17 runs with the mainnet feature set, SBPF v3 builds of the Noised programs and the mainnet binaries of
        DBC 0.2.1, DAMM v2, Token-2022 v11 and SPL Token. <XRef to="fig-cu" /> covers every instruction a launch, a trade, a vault or a shield uses;{" "}
        <XRef to="fig-bytes" /> the transaction sizes. Values from the final build <Tag kind="final" /> are the programs with on-chain metadata
        after their review fix (2026-10-09), as reported by that stage; values from the v2 build <Tag kind="v2" /> include the post-quantum
        attestation and the round-2 changes (the batch now also ends the shield, 13,653 CU, and creates the base escrow) and are the latest exact
        measurements of instructions the metadata change did not touch (their final-build ranges are in each bar's note); round-1b values{" "}
        <Tag kind="docs" /> are as published.
      </p>
      <CuFigure />
      <BytesFigure />
      <H3 id="perf-launch" n="13.1">
        What <C>launch</C> costs
      </H3>
      <p>
        <C>launch</C> takes no arguments and reads the record the attestation names, so its transaction is a constant{" "}
        {FINAL_SIZES.launchTx.toLocaleString("en-US")} bytes for every record <Tag kind="final" />. Its compute is a constant base per record,
        measured to within 8 CU over 18 launches, plus 1,500 CU for every extra step the bump search of the six mint-derived addresses takes:
      </p>
      <Eq n="13.1">{"\\mathrm{CU}_{\\mathrm{launch}} = b_{\\mathrm{record}} + 1{,}500\\, e,"}</Eq>
      <p>
        with the base <M>{"b"}</M> 142,672 CU with no uri, 143,996 with a 200-byte external uri and 188,107 with the largest inline uri. The extra
        steps <M>{"e"}</M> are random (seven on average); more than {L.rareSteps} has probability below one in a million, which bounds
        the worst launch at {launchCuBound(L.base.inline, L.rareSteps).toLocaleString("en-US")} CU with the largest inline uri and{" "}
        {launchCuBound(L.base.none, L.rareSteps).toLocaleString("en-US")} without a uri. The SDK therefore requests {L.limit.toLocaleString("en-US")}{" "}
        CU; at the earlier 200,000 a launch with the largest inline uri would have run out about four times in ten. Of one inline-maximum
        run's 204,607 CU, DBC took 88,545 and the hook 32,085; the launchpad's own share is about 40k CU above the no-uri mode, mostly base64
        (36.2k CU for a 3,072-byte document). The launchpad's heap peaks at 19,904 of its 32,768 bytes, and DBC accepts uris up to{" "}
        {FINAL_SIZES.dbcMaxUri.toLocaleString("en-US")} bytes, 2.1 times the largest inline uri <Tag kind="final" />.
      </p>
      <H3 id="perf-costs" n="13.2">
        Other costs worth isolating
      </H3>
      <ul className="wp-list">
        <li>
          <strong>The batch.</strong> An <C>execute_batch</C> on the Fair preset spent 162,504 CU, of which DBC's swap 70,156 (the hook's check of
          the batch buy 5,778), ending the shield 13,654, creating the escrow's token account 19,407 and the launchpad itself 59,287 <Tag kind="v2" />.
        </li>
        <li>
          <strong>The origin.</strong> The first attestation of a launch also creates its identity (196 bytes) and attestation (2,708 bytes)
          accounts: {FINAL_SIZES.rent.firstAttestation.toLocaleString("en-US")} lamports with the fee at mainnet's rent<Fn k="rent" />, paid by the
          relaying key. Its transaction is a constant {FINAL_SIZES.attestTx.toLocaleString("en-US")} bytes; after the metadata review fix every
          signature also derives the record's address, which added 1,500 CU per bump-search step <Tag kind="final" />.
        </li>
        <li>
          <strong>The metadata.</strong> A typical record ({FINAL_SIZES.tokenMeta.typical.toLocaleString("en-US")} bytes) holds{" "}
          {FINAL_SIZES.rent.typicalRecord.toLocaleString("en-US")} lamports of rent forever; the largest possible (
          {FINAL_SIZES.tokenMeta.max.toLocaleString("en-US")} bytes) {FINAL_SIZES.rent.largestRecord.toLocaleString("en-US")}. With the default empty
          uri the mint is {FINAL_SIZES.mintBase} bytes plus the name and symbol; the largest inline uri makes it 4,553 bytes, still far below the
          runtime's 10,240-byte growth limit <Tag kind="final" />.
        </li>
        <li>
          <strong>Graduation at the largest records.</strong> <C>migration_damm_v2</C> costs 151,105 to 155,605 CU in a 1,107-byte transaction
          with the largest inline uri: the metadata changes nothing after launch <Tag kind="final" />.
        </li>
      </ul>
    </Section>
  );
}
