# sRFC (number to be assigned): QSL-1, a checkable "no-rug" and quantum-attested profile for Token-2022 tokens

| | |
|---|---|
| Status | Draft for discussion on the Solana developer forum, 2026-10-11 (follows QSL-1 revision 0.4) |
| Authors | Noised maintainers |
| Full specification | [QSL-1.md](QSL-1.md) (normative, RFC 2119 language, account layouts, verification algorithm, test vectors) |
| Asks | wallets, explorers, DEX aggregators and indexers: read one extra account and show a level badge with fixed wording |
| Name | "QSL-1" ("Quantum Security Layer token, v1") is a working name; we welcome a better one |

## Summary

QSL-1 is a profile of Token-2022, not a new token program. A QSL-1 token is a plain Token-2022 mint, launched by an immutable program that fixes everything that could hide a rug and records what it verified in one immutable account per mint, the **certificate** at the PDA `["certificate", mint]` of the launchpad `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`. Anyone can re-check the same facts from live accounts in a few RPC calls. There are two nested levels:

| Level | In one line | Checked from |
|---|---|---|
| **L1 No-rug** | Nobody can mint more, freeze holders, change the name, pull the graduated liquidity, block sales, or redirect fees. | The mint (no mint or freeze authority, exactly MetadataPointer + TokenMetadata + TransferHook, metadata authority None), the Meteora DBC config (100% of LP permanently locked, no creator allocation or migration fee, wSOL quote), the hook policy (limits end within 72 h, sales always allowed), the fee recipients, and the Noised programs being finalized. |
| **L2 Quantum-attested** | The launch went live only because the creator's post-quantum identity signed its parameters, its on-chain metadata, its launch rules (if any) and its launch window. | The attestation account: a hash-based LMS signature (RFC 8554), verified on-chain at launch and re-verifiable by anyone from account state; the on-chain metadata record whose hash it signed. |

A token may also be **programmable**: its creator added launch rules (extra limits on some transfers for up to 72 hours, never on sales) or automation for its treasury. That is shown next to the level as a description, "QSL-1 L2 · programmable: read its rules", with plain-English warnings, and it is **not a level**: signed and bound rules can still, for example, let only wallets the creator chose buy for a while. An earlier draft called it "L3"; we dropped that because a level must never rank something that can make a token worse for holders.

## Motivation

Users of new tokens ask the same questions every time: can it be minted, frozen, renamed, drained, honeypotted, or have its fees redirected? The answers are on-chain but spread across several accounts and programs, so most users trust a launchpad's word or a partial check. Separately, every Solana authority is an Ed25519 key that a future quantum computer could forge; QSL-1's level 2 makes a launch's origin rest on SHA-256 instead.

We did not fork a token program. A third token program would be invisible to most wallets and indexers, could not use Meteora's pools (which hold the locked liquidity), and would add a large unaudited codebase with its own upgrade key. QSL-1 layers on Token-2022 the way ERC-4626 layers on ERC-20: unchanged base, constrained use, one extra account to read.

## How to check a mint (summary of QSL-1 §7)

1. Confirm the RPC serves mainnet-beta (genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`): the program ids are the same on devnet.
2. Read the certificate at `PDA(launchpad; "certificate", mint)`. If it does not exist or is not owned by the launchpad, the mint is not QSL-1. A transfer hook pointing at the Noised hook proves nothing; only the certificate does.
3. Re-check the mint, the DBC config and pool, the hook policy and the fee recipients against the certificate (L1). Never award a level from the certificate's `checks` field alone.
4. For L2: read the attestation, the identity and the metadata record; recompute the record's hash; rebuild the signed message from account data (221 bytes with the launch rules' hash, or 189 bytes for launches made before rules existed); verify the 2,508-byte LMS signature (about 520 SHA-256 calls on average; 31 µs measured in Rust on a desktop CPU). Test the certificate's checks as `(checks & 4095) == 4095`: a certificate that binds launch rules holds 8,191.
5. Check that the launchpad (and, until graduation, the hook) can no longer be upgraded. Until then, and on any cluster other than mainnet-beta, the result is only a "candidate".
6. If the token is programmable, read its rules record and autopilot, explain them, and show the warnings QSL-1 §6.4 lists (buys limited to wallets the creator lists and for how long, rules on wallet-to-wallet transfers, rules on for more than an hour, rules that do nothing, automation an operator controls or that is not frozen). This never changes the level.

Cost for an integrator: `getGenesisHash` and two `getMultipleAccounts` calls, plus after migration one `getTokenAccountsByOwner` and two more `getMultipleAccounts` (the LP positions and their pools), and one more when an autopilot runs a graph; no `getProgramAccounts`, no URL fetches. A TypeScript reference checker exists: `checkQsl1(conn, mint)` in the Noised SDK 0.8 (unreleased) returns the level, every condition with a plain-English sentence, the reasons the next level is not reached, the parties still trusted and, for a programmable token, its rules and automation in plain English with the warnings; `qslBadge(result)` gives the badge wording of Appendix A, with the "programmable" tag next to the level. A small Rust crate is planned.

## What we ask

**Wallets**
- Show the level badge next to a token, with the wording of QSL-1 Appendix A ("QSL-1 · No-rug", "QSL-1 · Quantum-attested"), and let it open the full report and the list of parties still trusted (Meteora's and Token-2022's upgrade multisigs, validators).
- For a programmable token, show "programmable" next to the level with a "read its rules" link and the warnings, never as a level, never as safer.
- Never show a badge for a zToken (Shield mint), for a mint on another cluster, or from the certificate's flags alone.
- QSL-1 tokens default to an empty metadata uri: the description and icon are in an on-chain record (`TokenMeta`). Consider reading it (one account, named by the certificate) instead of showing a placeholder.

**Explorers**
- Decode the certificate, the attestation and the record; link them from the mint page; show the record's icon and description from chain data.

**DEX aggregators**
- Expose the level in token metadata APIs; optionally let users filter by level. Do not rank or endorse by level: it says nothing about price or the people behind a token.

**Indexers (DAS and others)**
- Index the certificate PDA and expose a `qsl` object (`level`, `slot`, `checks`) on token assets. Re-verify on graduation, on migration, and when DBC, DAMM v2 or Token-2022 is redeployed; everything else in a verdict is immutable once reached.

**Everyone**
- Review the conditions in QSL-1 §6 and the residual risks in §8.4, and tell us what is missing or overclaimed.

## What we are not asking

No change to Token-2022, to the runtime or to any Meteora program. No new instruction, no CPI, no fee. Showing nothing remains a correct implementation; only showing a wrong badge is not.

## Honest status

- Nothing is deployed to mainnet and no Noised program is finalized, so **no token is QSL-1 today**. Levels become reachable when the programs are finalized after audit.
- The programs have had internal reviews (by AI agents), mutation testing and LiteSVM runs against mainnet program dumps, not an independent audit.
- Two fixes from the third internal audit round (a re-signable launch window, and immutable-owner destinations during the launch guard) are merged, with regression tests and mutation testing; neither changed an account a verifier reads.
- Programmable launches (launch rules bound into the attestation and the certificate, version 4; automation authorized by the post-quantum identity) and the fourth review's fixes are merged. The fourth review is why "programmable" is a description with warnings and not a level.
- Meteora DBC and DAMM v2 (4-of-7 multisig, no timelock), Token-2022 (4-of-6 multisig) and Solana consensus remain trusted. DAMM v2 operators can raise a graduated pool's fee or disable it. QSL-1 says so wherever it shows a level.
- No QSL-1 token is "quantum-proof": holders' wallets and the pools are classical. L2 protects the launch's authorization and metadata.

## Open questions

1. **Name and scope.** Is "QSL" a good name? Should the standard be launchpad-neutral, with a generic certificate interface other launchpads could implement, instead of naming one certifier program?
2. **Registry and revocation.** If other certifiers join, who maintains the list of conforming program ids, and how is a program with a discovered bug marked non-conforming (QSL-1 §10.4 proposes revisions of the document)?
3. **Where verification runs.** In the wallet client (most trustworthy, needs an LMS verifier in the client) or in an indexer (cheaper, adds a trusted party)? Is "indexer computes, wallet spot-checks" acceptable?
4. **Before finalization and on devnet.** Should wallets show anything for candidates? QSL-1 says nothing on mainnet trade screens.
5. **Badge vocabulary.** Do "No-rug" and "Quantum-attested" read clearly to non-technical users without overclaiming? We prefer plain words and want counter-proposals.
6. **On-chain metadata.** Would a general convention for an on-chain metadata record (content-addressed, signed, with an inline icon) be useful beyond QSL-1, for example as a DAS field?
7. **Stateful keys.** Creators' identities are LMS keys: each of 1,024 leaves may sign once, tracked on-chain and in a client ledger. Is that acceptable to wallet teams that might sign with them? A native hash-based verification syscall (see [SIMD-DRAFT-hash-based-signatures.md](SIMD-DRAFT-hash-based-signatures.md)) would make stateless SLH-DSA practical.
8. **Programmable.** We show signed launch rules and automation as a description with warnings, not a level. Are the warnings (QSL-1 §6.4) the right ones, and is "QSL-1 L2 · programmable: read its rules" clear enough?
9. **Audits as a condition.** Should a future revision require published independent audits of the listed programs as a conformance condition?

## Links

- Specification: [QSL-1.md](QSL-1.md)
- Engineering specification: [../SPEC.md](../SPEC.md); guarantees with their enforcing code: [../SECURITY_GUARANTEES.md](../SECURITY_GUARANTEES.md); threat model: [../THREAT_MODEL.md](../THREAT_MODEL.md); post-quantum design: [../POST_QUANTUM.md](../POST_QUANTUM.md)
- Test vectors: `tests/integration/vectors/metadata.json`, `tests/integration/vectors/lms.json`, `tests/integration/vectors/programmable.json`
- Native verification proposal: [SIMD-DRAFT-hash-based-signatures.md](SIMD-DRAFT-hash-based-signatures.md)
