---
title: The QSL-1 token standard
nav: QSL-1 standard
summary: QSL-1 names what a Noised launch guarantees as two nested levels, No-rug and Quantum-attested, that anyone can check from live accounts; launch rules and automation are a described "programmable" tag with warnings, never a level. A summary of docs/standard/QSL-1.md (revision 0.4).
---

QSL-1 ("Quantum Security Layer token, version 1") is a token standard layered on Token-2022, the way ERC-4626 is layered on ERC-20. It does not change Token-2022 or any Meteora program: a QSL-1 token is an ordinary Token-2022 mint with a fixed, minimal configuration, launched by an immutable program that also fixes its liquidity, its fee routes and a time-bounded transfer hook that can never refuse a sale. Every wallet that handles Token-2022 handles a QSL-1 token unchanged; a QSL-aware one reads one more account.

This page summarizes the standard. The normative text, with every account offset, the verification algorithm and the test vectors, is `docs/standard/QSL-1.md` in the repository. Where the two differ, that file wins, and where it differs from the programs, the code wins.

:::warn Status: draft, no token can meet it yet
Level 1 requires finalized programs (condition C1.24), and Noised's programs are still upgradeable. Until they are finalized a verifier reports at most "candidate" for a Noised token, and only on mainnet-beta can a level be awarded at all.
:::

## The two levels

Levels are nested: level 2 implies level 1. There is no level 3 (revision 0.4).

| Level | Badge | What it means |
|---|---|---|
| 1 | **QSL-1 · No-rug** | Nobody, the creator included, can mint more, freeze holders, change the name, symbol or icon, withdraw the graduated liquidity, block sales or redirect fees. |
| 2 | **QSL-1 · Quantum-attested** | Level 1, and the launch went live only because the creator's post-quantum identity (an LMS key, RFC 8554) signed its parameters, its on-chain metadata record and its launch window. Anyone can re-verify the signature from account state. |

Level 1 is 24 conditions over the mint (`C1.4` to `C1.10`: no mint or freeze authority, immutable metadata, exactly the extensions `TransferHook`, `MetadataPointer` and `TokenMetadata`), the DBC configuration and pool (`C1.11` to `C1.19`: 100% of the liquidity permanently locked at graduation, no migration fee, no creator allocation, at most 10% trading fees), the fee routing (`C1.20`), the Launch Guard policy (`C1.21`, `C1.22`), the locked position after migration (`C1.23`) and program finality (`C1.24`). Level 2 adds eight conditions over the attestation, the identity and the metadata record (`C2.1` to `C2.8`), described in [Post-quantum identity](/docs/concepts/pq-identity) and [Token metadata](/docs/concepts/token-metadata).

## Programmable: a tag, not a level

A token is **programmable** when its certificate binds launch rules (extra limits on some transfers during the first hours) or its Autopilot runs a plan on its treasury. That is shown next to the level, "QSL-1 L2 · programmable — read its rules", never as a level and never as "safer": a rule set can be signed by the creator, bound into the certificate and enforced exactly as written, and still let only wallets the creator chose buy for a while. Binding proves who set the rules, not that they are good for holders.

A verifier explains the rules and the automation in plain words, from the exact bytes on chain, and warns about what holders should know, most serious first: buying limited to wallets the creator chose (insider-only buying), buys refused, wallet-to-wallet transfers limited, a rule that stays on for more than an hour, a rule that does nothing, an operator who decides when automation runs, a queued change, automation that is not frozen, and an autopilot program that can still be changed. Launch rules never apply to moves made by a holder's quantum vault or the Shield (the built-in early limits still do), and they can never block a sale.

## Where the evidence lives

The launchpad writes one immutable account per mint, the **certificate** at `["certificate", mint]`, in the `launch` transaction. Its `checks` field records twelve bits the program verified from live state; every certificate has all twelve set: test `(checks & 4095) === 4095` (`certificateChecksComplete`), never `checks === 4095`, because a launch with creator rules also carries the informational `RULES_BOUND` bit (`checks = 8191`). A verifier MUST NOT award a level from those flags alone: it re-checks every condition of the level from live accounts.

A mint whose transfer hook is Launch Guard is not evidence of anything: anyone can create a pool on a Noised DBC config. Only the certificate is.

## How a verifier decides

1. Confirm the RPC serves mainnet-beta (its genesis hash). Noised's program ids are the same on devnet.
2. Read the launchpad and hook programs and whether each can still be upgraded. Continue either way, so that "candidate" can be reported.
3. Read the certificate. No certificate, or one that does not decode: the mint is **not QSL-1** (level 0).
4. Check the mint, the Launch account, the DBC configuration, the pool, the hook policy and, after migration, the locked LP position: level 1.
5. Check the attestation, the identity and the metadata record, rebuild the 189-byte attestation message and verify the LMS signature: level 2.
6. If every condition holds, including finality, the token has that level. If everything holds except finality, it is a **candidate** with no level. Otherwise its level is the highest one whose conditions all hold, with the failed conditions of the next one as reasons.

A verifier fails closed (an account that is missing, owned by the wrong program, of the wrong length or that does not decode fails the condition that reads it), fetches no URL, and SHOULD repeat the reads against a second RPC provider before a decision of consequence.

## Checking a token

In the app, open [Verify](/verify) and paste the token's address, or click the QSL-1 badge on a token's page. Every check is listed in plain words, with who you still trust.

With the SDK, `checkQsl1` runs the algorithm above against your connection and `qslBadge` turns its result into the standard's own wording:

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { checkQsl1, qslBadge } from "@noisedlabs/sdk";

const result = await checkQsl1(new Connection(RPC_URL), new PublicKey(mint));
// result.level: 0 | 1 | 2, result.candidate, result.wouldBe, result.reasons,
// result.checks: { id: "cluster" | "C1.1".."C1.24" | "C2.1".."C2.8", level, status, ok, plain, detail }[]
// result.programmable: { present, verified, rules?, autopilot?, checks (P.R1..P.G5), warnings: { kind, plain }[] }
const badge = qslBadge(result);
// badge.title: "QSL-1 · No-rug" | "QSL-1 · Quantum-attested" | "QSL-1 candidate: not final yet" | "Not QSL-1"
// badge.summary, badge.lines, badge.required (show them with it), badge.showOnTradeScreen
// badge.programmable: { text: "QSL-1 L2 · programmable", link: "read its rules", summary, warnings, tone } | null
```

## Wording for apps

The standard's Appendix A is normative for any app that shows a level:

- Show a level only for a result computed as above, on mainnet-beta, with level 1 or more. On test clusters a candidate MAY be shown as "QSL-1 candidate: not final yet"; on mainnet trade screens a candidate shows nothing.
- Show the mint address with the badge, never instead of the token's name, and let the badge open the full report with the list of who you still trust.
- Next to level 1: "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams." Next to level 2, also: "The token itself sits in normal wallets, which are not quantum-resistant."
- A programmable token shows its tag next to the level ("QSL-1 L2 · programmable — read its rules") with every warning. The tag never changes the badge's level, words or colour, and is never called safer.
- Never say "quantum-proof", "quantum-safe token", "unhackable", "safe investment", "risk-free", "verified team", "official" or "audited" (unless an independent audit is published and linked), and never show a level for a Shield zToken or a mint without a certificate.

## What a level does not say

A level is not advice about price, value or the people behind a token. Identities are keys, not persons. The caps of the Launch Guard apply per account, so many wallets get around them. Meteora's and Token-2022's upgrade multisigs, DAMM v2 operators and Solana's validators can still change the outcome: see [Security](/docs/security). And no QSL-1 token is quantum-proof: level 2 is post-quantum launch authorization and metadata integrity inside a chain that is not post-quantum.
