/** Sections 14 (limitations and future work) and 15 (references, with the notes). */
import type { ReactNode } from "react";

import { C, H3, jump, SecRef, Section } from "../paper";
import { Cite, NOTES, REFS } from "../refs";

export function S14(): ReactNode {
  return (
    <Section id="limitations">
      <H3 id="lim-chain" n="14.1">
        The chain is not post-quantum
      </H3>
      <p>
        Noised protects origin and custody at the application level, built from <C>sol_sha256</C>. Everything else on Solana remains classical:
        validator and vote keys, every ordinary wallet, and the multisigs that can upgrade Meteora's programs and Token-2022. A credible quantum
        threat therefore needs a chain-level migration: post-quantum signature verification for transactions and accounts, a way for funds to move
        from Ed25519 addresses to post-quantum ones before the keys are broken, and post-quantum upgrade authorities. No such proposal is active:
        a Falcon verification syscall (SIMD-0461) was closed in June 2026, and no post-quantum code ships in Agave 4.3 <Cite k="simd0461" />. Until
        then, value that must survive a quantum computer belongs in a PQ vault, and the vault's own limits apply (<SecRef to="vault" />).
      </p>
      <H3 id="lim-wallets" n="14.2">
        Wallets
      </H3>
      <p>
        Wallet support for version-1 transactions is uneven, and no mainstream wallet holds hash-based keys. Noised works around both: hash-based
        signatures are produced by the app from a passkey secret or a phrase and relayed by throwaway fee payers, so a user's wallet signs only
        legacy transactions. Wallets that hold LMS or XMSS keys natively, ideally in secure hardware as SP 800-208 envisages, would remove the
        browser from the signing path for both identities and vaults.
      </p>
      <H3 id="lim-roadmap" n="14.3">
        Future work
      </H3>
      <ul className="wp-list">
        <li>
          <strong>Independent audits, then finalization.</strong> At least two independent audits, reproducible verified builds, and the upgrade
          authority of all four programs set to none. Until then the upgrade key is the largest trusted party.
        </li>
        <li>
          <strong>Programmable tokens in other verifiers.</strong> Launch rules and automation are a described component of QSL-1, shown next to
          the level with warnings, never a level (<SecRef to="evaluation" />). Wallets and explorers that show the badge should show the tag and
          its warnings too; the SDK&rsquo;s <C>qslBadge</C> gives them in the standard&rsquo;s words.
        </li>
        <li>
          <strong>Token icons outside Noised.</strong> A token's icon and description are on-chain and signed, but third-party wallets take icons
          from https-hosted JSON or their own registries, so with the default empty uri they show only the name and symbol. The signed inline
          mode would put the document in the mint itself; it stays out of the app until a check on mainnet shows such tokens listed by wallets
          and indexers (one open-source indexer stores uris in a 200-character column). A creator can still submit the on-chain icon to a
          registry; Noised hosts nothing.
        </li>
        <li>
          <strong>One-time keys across devices.</strong> A phrase or identity used on two devices with two unshared ledgers can sign twice with
          one key. Authenticated record export and import narrow the window; a ledger shared by every device of a user, without a server Noised
          runs, is open work.
        </li>
        <li>
          <strong>Stateless signatures for rare, high-value authorities.</strong> SLH-DSA (FIPS 205) needs no state, but its smallest signature
          (about 7.9 KB) exceeds one transaction; verification across several transactions would lose atomicity and is left for future work.
        </li>
        <li>
          <strong>Post-quantum privacy.</strong> Confidential balances use ElGamal over Ristretto, which a quantum computer breaks retroactively.
          A post-quantum confidential layer is an open problem on Solana.
        </li>
        <li>
          <strong>Meteora dependence.</strong> DBC and DAMM v2 are licensed so that an immutable fork cannot be deployed. Noised discloses this
          dependency, monitors upgrades, and is built so that an unexpected change makes a batch refund rather than lose funds.
        </li>
      </ul>
    </Section>
  );
}

export function S15(): ReactNode {
  return (
    <Section id="references">
      <ol className="wp-refs">
        {REFS.map((r, i) => (
          <li key={r.key} id={`ref-${r.key}`} tabIndex={-1}>
            <span className="wp-refs-n">{`[${i + 1}]`}</span>
            <span>
              {r.text}
              {r.where ? (
                <>
                  {" "}
                  <span className="wp-refs-where">{r.where}</span>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <H3 id="notes" n="">
        Notes
      </H3>
      <ol className="wp-refs wp-notes">
        {NOTES.map((n, i) => (
          <li key={n.key} id={`fn-${n.key}`} tabIndex={-1}>
            <span className="wp-refs-n">{i + 1}</span>
            <span>
              {n.body}{" "}
              <a href={`#fnref-${n.key}`} onClick={(e) => jump(e, `fnref-${n.key}`)} aria-label={`Back to note ${i + 1}`} className="wp-xref">
                ↩
              </a>
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
