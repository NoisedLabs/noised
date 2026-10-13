/** Sections 1 (abstract and contributions) and 2 (threat model). */
import type { ReactNode } from "react";

import { BarChart, type BarRow } from "../../../components/charts";
import { securityRows } from "../model/security";
import { Aside, C, Eq, Figure, H3, SecRef, Section, Table, Tag, Thm, XRef } from "../paper";
import { Cite, Fn } from "../refs";
import { M } from "../tex";

export function S01(): ReactNode {
  return (
    <Section id="abstract">
      <p className="wp-abstract">
        Noised is a token launchpad on Solana built so that nobody can rug a launch, not even its creator, and so that the guarantees that matter
        still hold against an adversary with a cryptographically relevant quantum computer. Every privileged role of a launch is held by a
        program-derived address that has no private key. A pro-rata <em>fair-open batch</em> makes the first trade of every launch at one price for
        everyone who joined it. A transfer hook, Launch Guard, refuses every buy before that batch and enforces bounded anti-sniping rules for at most
        72 hours, and graduated liquidity is locked forever. Post-quantum cryptography enters exactly where an elliptic-curve break would otherwise be
        fatal: a launch goes live only after its creator's hash-based identity (LMS, RFC 8554, height 10) signs the launch's exact parameters,
        its metadata and its opening window, verified on-chain; the token's metadata itself (name, symbol, description and icon) is a record
        stored on-chain at the address of its own hash, so that signature covers every byte a reader will display; and the PQ vault keeps tokens
        behind one-time LM-OTS keys that rotate in place and whose signatures, once revealed, always execute. This paper gives the threat model, the protocol, derivations of every bound the design relies on,
        the security argument for each component, measured compute and size costs, and an explicit list of what is still trusted. Nothing in Noised
        makes Solana itself post-quantum.
      </p>
      <ol className="wp-contrib" aria-label="Contributions">
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C1</span>
          <b>Post-quantum origin, enforced by consensus</b>
          An LMS identity with an on-chain one-time-leaf bitmap signs a 189-byte message binding the launch, its parameters, the hash of its
          on-chain metadata record and its window; <C>launch</C> refuses to run without it, and every valid signature lands to burn its leaf (
          <SecRef to="identity" />).
        </li>
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C2</span>
          <b>PQ custody that never forces a second signature</b>
          Vault withdrawals read no account a third party controls, reserve instead of paying, and derive the LM-OTS randomizer deterministically, so a
          revealed signature always executes and re-signing is idempotent (<SecRef to="hbs" />, <SecRef to="vault" />).
        </li>
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C3</span>
          <b>A Sybil-neutral fair open</b>
          Pro-rata fills with proved payout bounds: splitting wallets, committing early or bundling with the launch gain nothing; oversubscription
          refunds proportionally (<SecRef to="batch" />).
        </li>
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C4</span>
          <b>A shield that admits exactly one buy</b>
          Until the batch, the hook passes only the buy made inside a top-level <C>execute_batch</C>, read from the instructions sysvar; the batch must
          also be the pool's first swap or it refunds (<SecRef to="guard" />).
        </li>
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C5</span>
          <b>Liveness quantified, safety unconditional</b>
          A write-lock contention cost model sets the commit and execution windows; a censored batch fails safe into a full refund (
          <SecRef to="liveness" />).
        </li>
        <li className="wp-panel px-corners px-frame">
          <span className="wp-contrib-n">C6</span>
          <b>Evidence</b>
          Eight internal reviews by AI agents, three of them multi-agent adversarial rounds, with regression tests against mainnet binaries,
          mutation testing of every program fix, and measured compute for every instruction (<SecRef to="evaluation" />, <SecRef to="performance" />).
        </li>
      </ol>
      <Aside title="Status" tone="warn">
        <p>
          The programs are deployed on Solana mainnet since 2026-10-13; launches open there once the protocol is initialized. They have had
          internal adversarial reviews by AI agents (<SecRef to="evaluation" />), not an independent audit, and they stay upgradeable until they
          are finalized. Audit round 3's two program fixes (F1, F2) are merged, with their regression tests and
          mutants. Numbers tagged <Tag kind="final" /> come from the final programs with
          on-chain metadata (2026-10-09); <Tag kind="v2" /> from the protocol-v2 integration build of the same day (post-quantum attestation and
          the round-2 fixes, before the metadata change), for instructions the metadata change did not touch; <Tag kind="docs" /> are the
          published round-1b measurements of 2026-10-08. Values tagged <Tag kind="model" /> are computed from stated formulas, not measured.
        </p>
      </Aside>
    </Section>
  );
}

function BitsFigure(): ReactNode {
  const rows: BarRow[] = securityRows().map((r) => ({
    key: r.key,
    label: r.label,
    sub: r.sub,
    bars: [
      { group: "classical", value: r.classical, label: `${r.classical.toFixed(1)} bits` },
      { group: "quantum", value: r.quantum, label: r.quantum === 0 ? "broken (polynomial)" : `${r.quantum.toFixed(1)} bits`, note: r.quantumNote },
    ],
  }));
  return (
    <Figure
      id="fig-bits"
      title="Generic attack cost against each primitive, classical and quantum."
      caption={
        <>
          log2 of the expected work of the best generic attack<Fn k="bits" />. Elliptic-curve keys fall from about 126-128 bits (Pollard rho{" "}
          <Cite k="pollard" />,{" "}
          <M>{"\\sqrt{\\pi \\ell / 4}"}</M>) to polynomial time under Shor's algorithm; SHA-256 and the hash-based schemes built on it keep about
          127.7 bits under Grover's search, <M>{"(\\pi/4)\\,2^{n/2}"}</M> iterations for <M>{"n = 256"}</M>. Computed from the group orders and the
          formulas, not typed in.
        </>
      }
    >
      <BarChart
        rows={rows}
        groups={[
          { key: "classical", label: "classical attacker", ink: 2 },
          { key: "quantum", label: "with a quantum computer", ink: 1 },
        ]}
        axis={{ domain: [0, 256], label: "security (bits, log2 of work)", ticks: [0, 64, 128, 192, 256] }}
        rules={[{ value: 128, label: "128-bit line" }]}
        ariaLabel="Bar chart: security in bits of Ed25519, secp256k1, SHA-256, LM-OTS and LMS against classical and quantum attackers"
      />
    </Figure>
  );
}

export function S02(): ReactNode {
  return (
    <Section id="threats">
      <p>
        We consider three adversaries of increasing strength and design for the strongest one wherever the protocol can. They are summarized in{" "}
        <XRef to="tab-adversaries" />; the rest of the paper refers to them as <M>{"\\mathcal{A}_{\\mathrm{cl}}"}</M>,{" "}
        <M>{"\\mathcal{A}_{\\mathrm{q}}"}</M> and <M>{"\\mathcal{A}_{\\mathrm{si}}"}</M>.
      </p>
      <Table id="tab-adversaries" title="Adversary classes.">
        <thead>
          <tr>
            <th>Adversary</th>
            <th>Capabilities</th>
            <th>Cannot</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <M>{"\\mathcal{A}_{\\mathrm{cl}}"}</M> classical
            </td>
            <td>Any number of wallets; submits any transaction; reads every account; pays priority fees; runs bots and bundles.</td>
            <td>Break Ed25519 or SHA-256; control which leader produces a block.</td>
          </tr>
          <tr>
            <td>
              <M>{"\\mathcal{A}_{\\mathrm{q}}"}</M> quantum
            </td>
            <td>
              Everything above, plus a cryptographically relevant quantum computer: discrete logarithms in polynomial time (Shor), square-root speed-ups
              on search (Grover).
            </td>
            <td>Invert SHA-256 faster than about 2^128 serial iterations; forge a hash-based signature it has not seen.</td>
          </tr>
          <tr>
            <td>
              <M>{"\\mathcal{A}_{\\mathrm{si}}"}</M> "superintelligence"
            </td>
            <td>
              Everything above, plus perfect bug finding (it knows every reachable state of every program), optimal ordering and MEV strategy,
              unbounded coordination, and social engineering of any human who holds a key.
            </td>
            <td>Violate an invariant that holds in every reachable state; break the hash function beyond generic bounds.</td>
          </tr>
        </tbody>
      </Table>

      <H3 id="threats-quantum" n="2.1">
        What a quantum computer breaks, and what it does not
      </H3>
      <p>
        Ed25519 <Cite k="rfc8032" /> works in a group of prime order <M>{"\\ell = 2^{252} + 27742317777372353535851937790883648493"}</M> generated
        by a base point <M>{"B"}</M>. A public key is a point <M>{"A = [a]B"}</M>, and on Solana an ordinary account's address <em>is</em> that public
        key. Shor's algorithm <Cite k="shor" /> computes the discrete logarithm
      </p>
      <Eq n="2.1">{"a \\equiv \\log_{B} A \\pmod{\\ell}"}</Eq>
      <p>
        in time polynomial in <M>{"\\log \\ell"}</M>; published 2026 estimates put a 256-bit elliptic-curve break at about 1,200 logical qubits{" "}
        <Cite k="ecdlp2026" />, and NIST plans to disallow quantum-vulnerable signatures such as EdDSA after 2035{" "}
        <Cite k="nistir8547" />. Knowing <M>{"a"}</M> is enough to produce valid signatures on any message. Because addresses are public keys, every
        funded wallet is exposed <em>at rest</em>, including receive-only addresses, and Solana has no protocol-level key rotation. We call this{" "}
        <strong>harvest now, forge later</strong>: unlike encrypted traffic, nothing has to be intercepted today. The public keys are already on chain,
        and the day a quantum computer exists every key behind them can sign. The same holds for every upgrade authority and multisig member key that
        can change a program, which is why <SecRef to="evaluation" /> lists them as trusted parties.
      </p>
      <p>
        Hash functions lose only to generic search. Grover's algorithm <Cite k="grover" /> finds a preimage of an <M>{"n"}</M>-bit hash in about
      </p>
      <Eq n="2.2">{"\\frac{\\pi}{4}\\, 2^{n/2} \\;\\approx\\; 2^{127.65} \\quad \\text{iterations for } n = 256,"}</Eq>
      <p>
        and the iterations are long and serial<Fn k="grover-serial" />. For collisions, the best quantum algorithms do not beat classical parallel
        collision search once their hardware cost is counted <Cite k="bernstein" />, so SHA-256 keeps about 128 bits there too. Program-derived
        addresses are SHA-256 outputs that are not curve points: no private key exists, so there is nothing to recover, provided the program that owns
        them is immutable and trusts no Ed25519 authority. <XRef to="fig-bits" /> puts these numbers side by side; LM-OTS and LMS inherit SHA-256's
        bound because, as <SecRef to="hbs" /> shows, forging them reduces to a 256-bit search<Fn k="category5" />.
      </p>
      <BitsFigure />

      <H3 id="threats-si" n="2.2">
        The superintelligence adversary
      </H3>
      <p>
        No system can be proven safe against an arbitrarily capable adversary, and Noised makes no such claim. We take the goal to mean: leave{" "}
        <M>{"\\mathcal{A}_{\\mathrm{si}}"}</M> nothing to work with. Let the <em>trust surface</em> <M>{"\\mathcal{T}(L)"}</M> of a launch{" "}
        <M>{"L"}</M> be the set of keys, people and upgradeable programs whose action can change <M>{"L"}</M>'s outcome after it starts. Perfect bug
        finding means any property that fails in <em>some</em> reachable state will be made to fail; social engineering means every element of{" "}
        <M>{"\\mathcal{T}(L)"}</M> that a human controls will eventually act against the user. The design rules follow:
      </p>
      <ol className="wp-list">
        <li>
          <strong>No admin keys.</strong> The <C>Protocol</C> account is written once; no instruction pauses, updates or redirects anything. After{" "}
          <C>launch</C>, every DBC role (pool creator, partner, fee claimer, leftover receiver, LP owner) is a PDA.
        </li>
        <li>
          <strong>Immutability.</strong> All four Noised programs are to be finalized (upgrade authority set to none) after independent audit;
          until then the upgrade key is the largest element of <M>{"\\mathcal{T}"}</M>, and we say so.
        </li>
        <li>
          <strong>Invariants, not procedures.</strong> Every guarantee is a property checked by the program in the instruction that could break it
          (post-conditions on the fresh mint, payout bounds, the first-swap check), so it holds in every reachable state, not only along the intended
          path.
        </li>
        <li>
          <strong>Sybil neutrality.</strong> Mechanisms must not reward splitting capital across wallets or arriving first; the batch is additive in
          commits (<SecRef to="batch" />). Per-wallet caps exist but are documented as limiting only naive concentration.
        </li>
        <li>
          <strong>Safe failure under censorship.</strong> Liveness cannot be guaranteed against leaders and ordering gateways; every time-bounded step
          therefore fails into a full refund, never into a loss (<SecRef to="liveness" />).
        </li>
        <li>
          <strong>Nothing off-chain is needed for safety.</strong> Origin, parameters, attestation and the token's metadata are stored and checked
          on-chain; verifiers re-read live state rather than trusting a certificate.
        </li>
      </ol>
      <Thm kind="Remark" n="2.1" title="what Noised does not claim">
        <p>
          Solana consensus (Ed25519 validator and vote keys), Token-2022, the associated-token-account program, and Meteora's DBC and DAMM v2 are
          upgradeable or classical, and remain in every launch's trust surface. Tokens held in ordinary wallets are quantum-vulnerable. Noised
          narrows the trust surface to these parties, discloses them in the app and in the verifier, and offers post-quantum custody (the vault)
          for value that must survive them. It does not make any token "quantum-proof".
        </p>
      </Thm>
    </Section>
  );
}
