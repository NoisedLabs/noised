/**
 * Bibliography and footnotes. Citations render as [n] links (n = position in REFS); footnotes as superscript
 * numbers that link to the notes list at the end of the paper.
 */
import type { ReactNode } from "react";

import { jump } from "./paper";

export interface RefEntry {
  key: string;
  text: string;
  /** Where to find it (shown as text: the site loads nothing from other origins). */
  where?: string | undefined;
}

export const REFS: readonly RefEntry[] = [
  { key: "rfc8554", text: "D. McGrew, M. Curcio, S. Fluhrer. Leighton-Micali Hash-Based Signatures. RFC 8554 (IRTF), April 2019.", where: "rfc-editor.org/rfc/rfc8554" },
  { key: "sp800208", text: "D. Cooper, D. Apon, Q. Dang, M. Davidson, M. Dworkin, C. Miller. Recommendation for Stateful Hash-Based Signature Schemes. NIST Special Publication 800-208, October 2020.", where: "doi.org/10.6028/NIST.SP.800-208" },
  { key: "fips205", text: "NIST. Stateless Hash-Based Digital Signature Standard (SLH-DSA). FIPS 205, August 2024.", where: "doi.org/10.6028/NIST.FIPS.205" },
  { key: "rfc2104", text: "H. Krawczyk, M. Bellare, R. Canetti. HMAC: Keyed-Hashing for Message Authentication. RFC 2104, February 1997.", where: "rfc-editor.org/rfc/rfc2104" },
  { key: "rfc4231", text: "M. Nystrom. Identifiers and Test Vectors for HMAC-SHA-224, HMAC-SHA-256, HMAC-SHA-384, and HMAC-SHA-512. RFC 4231, December 2005.", where: "rfc-editor.org/rfc/rfc4231" },
  { key: "rfc8032", text: "S. Josefsson, I. Liusvaara. Edwards-Curve Digital Signature Algorithm (EdDSA). RFC 8032, January 2017.", where: "rfc-editor.org/rfc/rfc8032" },
  { key: "simd0385", text: "Solana Improvement Document SIMD-0385: version 1 transactions (4,096 bytes). Active on mainnet since slot 447,120,000 (2026-09-15).", where: "github.com/solana-foundation/solana-improvement-documents" },
  { key: "shor", text: "P. W. Shor. Polynomial-Time Algorithms for Prime Factorization and Discrete Logarithms on a Quantum Computer. SIAM Journal on Computing 26(5), 1997.", where: "doi.org/10.1137/S0097539795293172" },
  { key: "grover", text: "L. K. Grover. A fast quantum mechanical algorithm for database search. Proceedings of STOC 1996.", where: "doi.org/10.1145/237814.237866" },
  { key: "pollard", text: "J. M. Pollard. Monte Carlo methods for index computation (mod p). Mathematics of Computation 32(143), 1978.", where: "doi.org/10.2307/2006496" },
  { key: "bernstein", text: "D. J. Bernstein. Cost analysis of hash collisions: will quantum computers make SHARCS obsolete? SHARCS 2009.", where: "cr.yp.to/hash/collisioncost-20090823.pdf" },
  { key: "katz", text: "J. Katz. Analysis of a Proposed Hash-Based Signature Standard. Security Standardisation Research (SSR) 2016, LNCS 10074.", where: "doi.org/10.1007/978-3-319-49100-4_12" },
  { key: "merkle", text: "R. C. Merkle. A Certified Digital Signature. Advances in Cryptology, CRYPTO '89, LNCS 435.", where: "doi.org/10.1007/0-387-34805-0_21" },
  { key: "nistir8547", text: "NIST. Transition to Post-Quantum Cryptography Standards. NIST IR 8547 (initial public draft), November 2024.", where: "doi.org/10.6028/NIST.IR.8547.ipd" },
  { key: "ecdlp2026", text: "Resource estimates for breaking 256-bit elliptic-curve discrete logarithms (about 1,200 logical qubits), arXiv:2603.28846, 2026; summarized in docs/research/FACTS.md #58.", where: "arxiv.org/abs/2603.28846" },
  { key: "webauthn", text: "W3C. Web Authentication: An API for accessing Public Key Credentials, Level 3 (PRF extension); FIDO Alliance, Client to Authenticator Protocol 2.1 (hmac-secret extension).", where: "w3.org/TR/webauthn-3" },
  { key: "bip39", text: "M. Palatinus, P. Rusnak, A. Voisine, S. Bowe. BIP-39: Mnemonic code for generating deterministic keys, 2013.", where: "github.com/bitcoin/bips/blob/master/bip-0039.mediawiki" },
  { key: "dbc", text: "Meteora. Dynamic Bonding Curve (program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN, version 0.2.1): documentation, MIT-licensed SDK and IDL.", where: "docs.meteora.ag" },
  { key: "damm", text: "Meteora. DAMM v2 / cp_amm (program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG, version 0.2.4): documentation and SDK.", where: "docs.meteora.ag" },
  { key: "token2022", text: "Solana Program Library. Token-2022 extensions: transfer hook interface, metadata, confidential transfers (v11.0.0 on mainnet).", where: "spl.solana.com/token-2022" },
  { key: "agave", text: "Anza. Agave validator 4.3.0: cost-model/src/block_cost_limits.rs (MAX_WRITABLE_ACCOUNT_UNITS = 24,000,000; MAX_BLOCK_UNITS = 60,000,000) and program-runtime/src/execution_budget.rs.", where: "github.com/anza-xyz/agave" },
  { key: "simd0461", text: "SIMD-0461: Falcon signature verification (closed 2026-06-17); SIMD-0579: keccak-p1600 (open).", where: "github.com/solana-foundation/solana-improvement-documents" },
  { key: "noised-spec", text: "Noised engineering specification (protocol v2, safety policy 3, on-chain metadata): docs/SPEC.md, docs/POST_QUANTUM.md, docs/HOOKS.md, docs/ARCHITECTURE.md, docs/PRIVACY.md; the SDK's README and sdk/CHANGELOG.md (0.4.0).", where: "this repository" },
  { key: "noised-sec", text: "Noised security documents: docs/SECURITY_GUARANTEES.md, docs/THREAT_MODEL.md, docs/AUDIT.md (internal reviews: rounds 1, 1b, 2 and 3, the PQ v2, on-chain metadata, client and SDK reviews, and the mutation testing), docs/research/FACTS.md.", where: "this repository" },
  { key: "rfc4648", text: "S. Josefsson. The Base16, Base32, and Base64 Data Encodings. RFC 4648, October 2006.", where: "rfc-editor.org/rfc/rfc4648" },
  { key: "png", text: "W3C. Portable Network Graphics (PNG) Specification (Third Edition), 2025.", where: "w3.org/TR/png-3" },
  { key: "das", text: "Metaplex Foundation. Digital Asset RPC infrastructure (the open-source DAS indexer): init.sql (metadata_url varchar(200)) and program_transformers/src/token_extensions; commit 9c7e1b6, 2026-09-17; with the wallet and indexer findings in docs/research/FACTS.md.", where: "github.com/metaplex-foundation/digital-asset-rpc-infrastructure" },
];

export function refNo(key: string): number {
  return REFS.findIndex((r) => r.key === key) + 1;
}

/** [n] or [n, m] citation. */
export function Cite({ k }: { k: string | readonly string[] }): ReactNode {
  const keys = typeof k === "string" ? [k] : k;
  return (
    <span className="wp-cite">
      [
      {keys.map((key, i) => (
        <span key={key}>
          {i > 0 ? ", " : ""}
          <a href={`#ref-${key}`} onClick={(e) => jump(e, `ref-${key}`)}>
            {refNo(key)}
          </a>
        </span>
      ))}
      ]
    </span>
  );
}

export interface NoteEntry {
  key: string;
  body: ReactNode;
}

export const NOTES: readonly NoteEntry[] = [
  {
    key: "bits",
    body: "Bits of security here means log2 of the expected number of basic operations (group operations, hash evaluations or Grover iterations) of the best known generic attack. It ignores memory, parallelism and error correction, which make quantum attacks costlier in practice, never cheaper.",
  },
  {
    key: "category5",
    body: "The generic quantum attack on a 256-bit hash target is a Grover search over 2^256, about 2^128 iterations, the same order as a quantum key search on AES-256. That comparison is all we claim: the LMS and LM-OTS parameter sets are defined in RFC 8554 and listed in SP 800-208, but Noised's keys are software keys from a phrase or a passkey secret, outside the hardware setting SP 800-208 approves, so no SP 800-208 approval is claimed (docs/POST_QUANTUM.md §3.2).",
  },
  {
    key: "shor-rfc8032",
    body: "An RFC 8032 secret key is a 32-byte seed k. SHA-512(k) yields the scalar a (first half, clamped) and a nonce prefix (second half). The public key is A = [a]B. Shor's algorithm returns a modulo the group order, which suffices to sign anything, but it does not return the prefix: recovering it means finding a SHA-512 preimage. The distinction matters for wallet-derived secrets (section 5).",
  },
  {
    key: "dust",
    body: "Each floor loses less than one base unit per commit, so the escrow keeps at most n - 1 base units and n - 1 lamports of dust for n commits (in practice fewer). The dust is never paid out.",
  },
  {
    key: "slot",
    body: "400 ms is the nominal slot time; real slots vary. The model is linear in the number of slots, so a different slot time scales every curve by the same factor.",
  },
  {
    key: "rent",
    body: "Rent-exempt balances are (128 + size) x 5,080 lamports at mainnet's rate (docs/research/FACTS.md). LiteSVM's default rate, used by some measurements in section 13, is 6,960 lamports per byte; where a figure comes from LiteSVM the text says so.",
  },
  {
    key: "grover-serial",
    body: "Grover's algorithm parallelizes badly: splitting the search over M machines only reduces the time by a factor sqrt(M). A 2^128-iteration search is also long and serial, so these figures are lower bounds on the real cost.",
  },
];

export function noteNo(key: string): number {
  return NOTES.findIndex((n) => n.key === key) + 1;
}

/** Superscript footnote marker. */
export function Fn({ k }: { k: string }): ReactNode {
  const n = noteNo(k);
  return (
    <sup className="wp-fn" id={`fnref-${k}`}>
      <a href={`#fn-${k}`} onClick={(e) => jump(e, `fn-${k}`)} aria-label={`Note ${n}`}>
        {n}
      </a>
    </sup>
  );
}
