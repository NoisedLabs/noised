/** Sections 10 (the PQ vault, v4) and 11 (private balances). */
import type { ReactNode } from "react";

import { DEdge, Diagram, DNode, DText } from "../../../components/charts";
import { C, Eq, Figure, H3, Proof, SecRef, Section, Table, Tag, Thm, XRef } from "../paper";
import { M } from "../tex";

function VaultFigure(): ReactNode {
  const keys = [0, 1, 2, 3, 4];
  return (
    <Figure
      id="fig-vault"
      title="The vault's state machine."
      caption={
        <>
          The vault address and its token account never change. Each withdrawal is one signature by the current one-time key over the vault's
          current sequence; it reserves a payout, increments the sequence and installs the signed next key in place. Delivery is a separate,
          permissionless step that only the payout's recipient can delay, and only for itself.
        </>
      }
      wide
    >
      <Diagram w={900} h={360} minWidth={680} label="State machine of the PQ vault">
        <DNode x={10} y={40} w={170} h={70} title="open_vault" lines={["genesis key K₀ (q = 0)", "PDA seeded by its key id"]} step={0} />
        <DEdge points={[[180, 75], [262, 75]]} step={0} />
        <DNode x={262} y={22} w={250} h={106} title="Vault" lines={["sequence k, current key Kₖ", "reserved R ≤ balance", "token account: the deposit address"]} kind="strong" step={1} />
        <DEdge d="M 330 128 C 330 162, 444 162, 444 128" label="deposit (anyone)" labelAt={[387, 176, "middle"]} step={2} />
        <DEdge points={[[512, 60], [604, 60]]} label="withdraw: σ by Kₖ" labelAt={[558, 52, "middle"]} step={3} />
        <DNode x={604} y={22} w={286} h={106} title="Payout k" lines={["recipient wallet, amount = min(max, bal − R)", "R += amount; k ← k + 1; key ← Kₖ₊₁", "no token moves, no third-party account read"]} step={4} />
        <DEdge points={[[650, 128], [650, 196]]} label="release (anyone)" labelAt={[642, 166, "end"]} step={5} />
        <DEdge points={[[866, 128], [866, 196]]} label="release_to (recipient signs)" labelAt={[858, 166, "end"]} dash="dash" step={5} />
        <DNode x={604} y={196} w={286} h={66} title="delivered" lines={["R −= amount; payout closed, rent refunded", "a frozen or memo-less account only delays it"]} kind="pda" step={6} />
        <DEdge points={[[604, 100], [512, 100]]} label="vault at k + 1" labelAt={[558, 116, "middle"]} soft step={4} />
        <DText x={14} y={262} kind="small">
          one key per sequence, derived from the phrase: (account, sequence) never repeats
        </DText>
        {keys.map((k, i) => (
          <g key={k}>
            <DNode x={14 + i * 112} y={276} w={92} h={44} title={`K${String.fromCharCode(0x2080 + k)}`} lines={[i < 2 ? "spent" : i === 2 ? "current" : "next"]} kind={i === 2 ? "strong" : i < 2 ? "ghost" : "pda"} r={8} step={7 + i} />
            {i < keys.length - 1 ? <DEdge points={[[106 + i * 112, 298], [126 + i * 112, 298]]} step={7 + i} /> : null}
          </g>
        ))}
      </Diagram>
    </Figure>
  );
}

export function S10(): ReactNode {
  return (
    <Section id="vault">
      <p>
        The vault gives post-quantum custody inside a chain that is not post-quantum. Tokens in a vault move only as payouts authorized by an
        LM-OTS signature (<SecRef to="hbs" />); no Ed25519 key has any authority over them. The design problem is not the signature scheme but
        one-time-ness: a revealed signature that cannot execute tempts its owner to sign again, and a second signature is a forgery waiting to
        happen (<XRef to="fig-forge" />). Version 4, after review round 1, removes every way for a revealed signature to fail.
      </p>
      <H3 id="vault-protocol" n="10.1">
        Protocol
      </H3>
      <p>
        A vault is the PDA <C>["vault", mint, genesis_key_id]</C>; its token account is the deposit address and never moves (
        <XRef to="fig-vault" />). A withdrawal signs the 185-byte message
      </p>
      <Eq n="10.1">{"m_k = \\texttt{\"PHX-PQV4\"} \\,\\|\\, \\texttt{0x01} \\,\\|\\, \\pi_{\\mathrm{vault}} \\,\\|\\, V \\,\\|\\, \\mathit{mint} \\,\\|\\, u64_{le}(k) \\,\\|\\, \\mathit{dest} \\,\\|\\, u64_{le}(\\mathit{max}) \\,\\|\\, \\mathit{id}(K_{k+1})"}</Eq>
      <p>
        with the current key <M>{"K_k"}</M>, where <M>{"k"}</M> is the vault's sequence. The program checks the signature, that the supplied next
        key hashes to the signed id and differs from the current key, and (protocol v2) that the keys' leaf indices follow the sequence:{" "}
        <M>{"q(K_0) = 0"}</M> at open and <M>{"q(K_{k+1}) = k + 1"}</M> at withdrawal (<C>InvalidKeyIndex</C>). It then reserves
      </p>
      <Eq n="10.2">{"\\mathit{amount} = \\begin{cases} 0 & \\mathit{dest} = V \\\\ \\min\\big(\\mathit{max},\\; \\mathit{balance} - R\\big) & \\text{otherwise} \\end{cases}, \\qquad R \\leftarrow R + \\mathit{amount},"}</Eq>
      <p>
        creates <C>["payout", V, u64le(k)]</C>, sets <M>{"k \\leftarrow k + 1"}</M> and installs <M>{"K_{k+1}"}</M>. Keys are derived from a separate
        24-word phrase per (cluster, mint, account, sequence), so keys never repeat; the randomizer is deterministic (4.5). The signed amount is a
        maximum, so a withdrawal never fails for insufficient funds.
      </p>
      <Thm kind="Proposition" n="10.1" title="invariants">
        <p>
          (i) <M>{"R \\le \\mathit{balance}"}</M> before and after every instruction. (ii) No signature executes twice, and no retired key can act on
          the vault again. (iii) A correct signature for the current sequence always executes: <C>withdraw</C> reads no account that a third party
          controls.
        </p>
      </Thm>
      <Proof>
        <p>
          (i) <C>withdraw</C> adds at most <M>{"\\mathit{balance} - R"}</M>; delivery subtracts exactly what it transfers; deposits only raise the
          balance, and only the vault PDA, which never does so, could move tokens out other than by delivery. (ii) The message contains{" "}
          <M>{"k"}</M>, and the instruction that accepts it increments <M>{"k"}</M> and replaces the key with one that must differ; the genesis key
          id is the PDA seed, so <C>open_vault</C> for it fails forever. (iii) <C>withdraw</C> touches the submitter's own signer, the mint (fixed
          and, being eligible, never closable), the vault (this program's), the vault's token account (read-only, only its balance read; a frozen
          account still reads) and a fresh payout PDA only this program can create. No recipient account is read or written.
        </p>
      </Proof>
      <p>
        Version 3 paid the recipient inside <C>withdraw</C>; a recipient could then make a revealed signature fail forever by reassigning its token
        account's owner, requiring memos, or refusing non-confidential credits (finding V1, high). In v4 such a recipient delays only its own
        payout: <C>release</C> pays the canonical ATA (creating it, sending a memo first when required), and <C>release_to</C>, signed by the
        recipient, pays any token account it names (while a Launch Guard is on, only one whose owner cannot change: round 3's F2).{" "}
        <C>open_vault</C> refuses mints that leave an Ed25519 path to the deposit: a permanent delegate, a close authority, live transfer-fee
        authorities, and non-transferable mints.
      </p>
      <p>
        <strong>Never signing twice, in practice.</strong> Proposition 10.1 (ii) concerns signatures that land; the dangerous case is a second{" "}
        <em>revealed</em> one. The SDK therefore requires a durable vault-key ledger for every signature: the key is reserved for its withdrawal
        on a store with an atomic insert (and, in a browser, a cross-tab lock) before any signature exists, the signature is recorded and verified
        before it is returned, the vault's history is searched for a withdrawal the key already signed (and the signer refuses while that search
        is incomplete), and the fallback builder simulates only signatures the ledger holds. Because a signed recipient can never change, the
        signer also requires the user's separate confirmations of the recipient check (cautions about the recipient, about the mint, and an
        off-curve recipient), runs that check again right before signing, and refuses if anything new appeared. Two devices holding one phrase
        with two unshared ledgers could still each sign once; they share a ledger, or move authenticated records before the second device signs.
      </p>
      <H3 id="vault-cost" n="10.2">
        Cost
      </H3>
      <p>
        <C>withdraw</C> carries 2,312 bytes of instruction data, so it travels in a version-1 transaction (4,096 bytes, live since 2026-09-15),
        paid by a throwaway fee payer; no user wallet ever signs a version-1 transaction. <XRef to="tab-vault" /> collects the published
        measurements.
      </p>
      <Table id="tab-vault" title="Measured vault costs (LiteSVM, mainnet token programs, 26 runs, 2026-10-08)." caption="Ranges reflect the per-message verification work and address bump searches.">
        <thead>
          <tr>
            <th>Transaction</th>
            <th className="num">Compute (CU)</th>
            <th className="num">v1 size (bytes)</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>withdraw</td>
            <td className="num">79k-106k</td>
            <td className="num">2,693</td>
            <td className="muted">a legacy encoding would be 2,777 bytes, over the 1,232 limit</td>
          </tr>
          <tr>
            <td>release, SPL Token, ATA created</td>
            <td className="num">34k-58k</td>
            <td className="num">522</td>
            <td className="muted">also fits a legacy transaction</td>
          </tr>
          <tr>
            <td>release, Token-2022 + Launch Guard</td>
            <td className="num">63k-97k</td>
            <td className="num">654</td>
            <td className="muted">forwards the 4 hook accounts</td>
          </tr>
          <tr>
            <td>withdraw + release, SPL Token</td>
            <td className="num">121k-172k</td>
            <td className="num">2,845</td>
            <td className="muted">0.50 MB of loaded account data</td>
          </tr>
          <tr>
            <td>withdraw + release, Token-2022 + hook</td>
            <td className="num">145k-190k</td>
            <td className="num">2,977</td>
            <td className="muted">1.95 MB of loaded account data</td>
          </tr>
          <tr>
            <td>Payout account</td>
            <td className="num">-</td>
            <td className="num">-</td>
            <td className="muted">122 bytes; 1,270,000 lamports of rent, refunded to its payer at delivery</td>
          </tr>
        </tbody>
      </Table>
      <p>
        The SHA-256 syscall model predicts about 58k CU of hashing on average and 112k at worst for one LM-OTS verification, consistent with the
        measured whole-instruction range <Tag kind="docs" />.
      </p>
      <VaultFigure />
    </Section>
  );
}

export function S11(): ReactNode {
  return (
    <Section id="privacy">
      <p>
        AMMs cannot trade Token-2022 mints with confidential transfers, so privacy is a separate, reversible layer next to the tradeable token. The
        shield wraps any eligible token 1:1 into a zToken, a Token-2022 mint with the Confidential Transfer extension (no auditor key, no mint
        authority except the shield PDA, no freeze authority). Unwrapping burns zTokens and returns the base token. After every instruction the
        program asserts <M>{"\\mathrm{supply}(z) \\le \\mathrm{balance}(\\mathit{escrow})"}</M>, minting the escrow's measured balance
        difference so that transfer fees cannot break the invariant (equality cannot be enforced: anyone can donate to the escrow, and a
        one-unit donation must not brick the shield). A zToken copies its base mint's uri only if it is at most 200 bytes with no invisible
        character, so a Noised token's empty uri is copied as is. Confidential operations themselves are plain Token-2022 instructions.
      </p>
      <Table id="tab-shield" title="What private balances hide, and what they do not.">
        <thead>
          <tr>
            <th>Hidden</th>
            <th>Not hidden</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Confidential balances of zToken accounts</td>
            <td>Who owns which accounts, and who transacts with whom (the transaction graph)</td>
          </tr>
          <tr>
            <td>Amounts of confidential transfers</td>
            <td>Wrap and unwrap amounts (they are ordinary token transfers), and their timing</td>
          </tr>
          <tr>
            <td />
            <td>Everything recorded today from a quantum attacker later: ElGamal over Ristretto is not post-quantum (harvest now, decrypt later)</td>
          </tr>
          <tr>
            <td />
            <td>Availability: Token-2022 is upgradeable, and the ZK ElGamal proof program has a feature-gate kill switch (used in 2025-26)</td>
          </tr>
        </tbody>
      </Table>
      <p>
        The shield is therefore described as private balances, not anonymity, and it is opt-in. Its LiteSVM suite (13 tests) covers wrap and
        unwrap round trips, donations and direct burns that try to break the supply invariant, every refused base-mint extension, Launch Guard
        accounts forwarded through wraps, and a confidential transfer between accounts.
      </p>
    </Section>
  );
}
