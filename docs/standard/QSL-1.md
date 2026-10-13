# QSL-1: Quantum Security Layer token standard, version 1

| | |
|---|---|
| Status | Draft for review, revision 0.4 (2026-10-11). No token can meet it yet: see "Status of this draft". |
| Name | "QSL-1" ("Quantum Security Layer token, v1") is a working name. No on-chain identifier contains it, so a rename is a search-and-replace. |
| Editors | Noised maintainers |
| Source of truth | The programs in `programs/` and `crates/`. Where this text and the code differ, the code wins and this text is wrong. Engineering detail: [SPEC.md](../SPEC.md). |
| Companion documents | [SRFC-QSL-1.md](SRFC-QSL-1.md) (ecosystem proposal), [SIMD-DRAFT-hash-based-signatures.md](SIMD-DRAFT-hash-based-signatures.md) (native signature verification), [SECURITY_GUARANTEES.md](../SECURITY_GUARANTEES.md), [THREAT_MODEL.md](../THREAT_MODEL.md), [POST_QUANTUM.md](../POST_QUANTUM.md), [PRIVACY.md](../PRIVACY.md) |

## Abstract

QSL-1 defines a class of Solana tokens and a way to recognize them. A QSL-1 token is an ordinary Token-2022 mint with a fixed, minimal configuration (no mint authority, no freeze authority, immutable metadata, exactly three extensions), launched by an immutable program that also fixes its liquidity (100% permanently locked at graduation), its fee routes and a time-bounded transfer hook that can never refuse a sale. That program records what it verified in one immutable account per mint, the certificate at the launchpad PDA `["certificate", mint]`. Any wallet, explorer, DEX aggregator or indexer can re-check the same facts from live accounts.

The standard has two nested conformance levels:

- **L1, No-rug.** Nobody, the creator included, can mint more, freeze holders, change the metadata, withdraw the graduated liquidity, block sales or redirect fees.
- **L2, Quantum-attested.** L1, and the launch went live only because the creator's post-quantum identity (a hash-based LMS key, RFC 8554) signed its parameters, its on-chain metadata record, its launch rules (if any) and its launch window. Anyone can re-verify that signature from account state.

A token may also be **programmable**: its creator bound launch rules (extra limits on some transfers during the first hours) or runs automation on its treasury (an autopilot graph). That is a description shown next to the level ("QSL-1 L2 · programmable: read its rules"), not a level and not a safety claim: rules can, for example, let only wallets the creator chose buy for a while. Verifiers check it, explain it in plain words and warn about what holders should know (§6.4).

QSL-1 does not modify Token-2022. Every program and wallet that handles Token-2022 handles a QSL-1 token unchanged; a QSL-aware one reads one more account.

## Status of this draft

- **Deployed to mainnet, and no Noised program is finalized.** All five programs are on mainnet-beta since 2026-10-13, still upgradeable, and their protocol is not initialized yet, so no Noised launch exists on mainnet ([MAINNET.md](../MAINNET.md)). L1 requires finalized programs (condition C1.24) and mainnet-beta (condition `cluster`), so no token meets QSL-1 today. Until finalization a verifier reports at most "candidate" (§7.9), and on devnet it always does. The mainnet programs were deployed fresh: no launch made with an earlier layout exists on mainnet.
- **Programmable launches (P1c) and review 4's fixes are merged** (2026-10-11). This revision describes those programs: certificate version 4 (519 bytes, with `rules_hash`), attestation version 3 (message v3, which signs the rules hash), hook policy version 2 (with the rule bytes), the rules record, the post-quantum authorization (`pq_authorize`) and the autopilot (`AUTOPILOT`). Review 4 made the hook skip the creator's rules for holders' moves through `VAULT` and `SHIELD`, gave a freeze authorization an expiry (`not_after`, freeze payload v2), made `launch` re-hash the rules record against the attested hash, and pinned the autopilot to known launch layouts.
- **"Programmable" is not a level** (revision 0.4). Revision 0.3 drafted it as a third level, L3. Review 4 found that a rule set can be signed, bound and enforced exactly as written and still let only insiders buy, or freeze wallet-to-wallet transfers for hours: binding proves who set the rules, not that they are good for holders. Levels are L1 and L2; rules and automation are a described component with warnings (§6.4).
- **A reference checker exists.** `checkQsl1` in the Noised SDK 0.8 (`sdk/src/qsl/`, unreleased) implements §7, §6.4 and Appendix A condition by condition. Revision 0.3 settled the ambiguities found while writing it (Appendix C), each with the safer reading, which is the checker's own for every condition and every verdict.
- **No independent audit.** The programs and the LMS crate have had internal reviews by AI agents ([AUDIT.md](../AUDIT.md)), mutation testing and LiteSVM runs against mainnet program dumps. That is not an independent audit.
- **Test vectors for whole verdicts do not exist yet** (§11.3).

---

## 1. Conventions and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals, as shown here.

Notation:

- `a || b` is byte concatenation. `u16le`, `u32le`, `u64le`, `i64le` are little-endian encodings; `u16be`, `u32be` big-endian.
- `SHA256(x)` is SHA-256 (FIPS 180-4).
- `PDA(P; s1, s2, ...)` is the canonical program-derived address of program `P` with those seeds (`find_program_address`), seeds being UTF-8 strings or 32-byte keys as written.
- Byte ranges `a..b` include `a` and exclude `b`. Offsets in account layouts include the 8-byte Anchor discriminator.
- "Zero key" means 32 zero bytes, which Token-2022 and the programs below treat as "None" where a field is optional.
- Program ids are written by name (`LAUNCHPAD`, `HOOK`, ...); their values are in §3.1.

Terms:

| Term | Meaning |
|---|---|
| QSL-1 token | A Token-2022 mint that meets at least L1 (§6). |
| Certifier | The program that writes certificates: the Noised launchpad (`LAUNCHPAD`). QSL-1 recognizes no other certifier (§10.4). |
| Verifier | Software that evaluates a mint's level: a wallet, explorer, DEX aggregator, indexer, the Noised SDK. |
| Launch | The `Launch` account of one token's launch, status `Configured` and then `Live`. |
| Certificate | The `Certificate` account at `PDA(LAUNCHPAD; "certificate", mint)`, written once by `launch`, never modified or closed. |
| Identity | A creator's post-quantum identity: an LMS public key (RFC 8554, `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`, 1,024 one-time leaves). Its id is `pq_identity = SHA256(0x21 \|\| public_key)`. |
| Attestation | The account `PDA(LAUNCHPAD; "attestation", launch)` holding the identity's LMS signature over the launch's attestation message. |
| Record | The token's metadata record, a `TokenMeta` account at `PDA(LAUNCHPAD; "metadata", launch, metadata_hash)`, whose address is the hash of its content. |
| Launch Guard | The transfer hook `HOOK`, active only while the bonding curve runs. |
| Guard period | From `launch_ts` to `guard_end_ts` (at most 72 hours): the hook's limits apply. |
| Snipe shield | The part of the guard period during which the only buy from the pool is the fair-open batch's single buy. |
| Graduation | The bonding curve completes; Meteora DBC sets the mint's transfer-hook program and authority to None in the same swap. A verifier tells it from the pool (**graduated**, C1.19). |
| Migration | DBC moves the liquidity into a Meteora DAMM v2 pool and permanently locks the position. A pool is **migrated** exactly when its `is_migrated != 0` (C1.19). |
| Trusted party | A party outside QSL-1's programs that can still change the outcome (§8.2). |
| Programmable | A token whose certificate binds launch rules, or whose autopilot runs a graph: a description shown next to its level, with warnings, never a level (§6.4). |
| Launch rules | The creator's extra transfer limits for the guard period (format PXR1), stored in a rules record at the hash the attestation signs and enforced by `HOOK` after its own checks. They can only refuse transfers, never a sale, and end with the guard. |
| CRQC | A cryptographically relevant quantum computer: one that runs Shor's algorithm against 256-bit elliptic curves. |

---

## 2. Motivation

### 2.1 The problem

A buyer of a new Solana token wants to know a few things before buying: can more be minted, can holders be frozen, can the name or icon change, can the liquidity be withdrawn, can a hook block sales, can fees be redirected, did the creator keep an allocation. Each answer is on-chain, but spread over the mint, its extensions, the pool configuration, the pool, the hook's state and the liquidity position, in programs with different layouts. Most users and many apps check a subset, or trust a launchpad's word.

There is a second, slower problem. Every authority on Solana is an Ed25519 key. A CRQC could recover any such key from its public key. A launch authorized only by an Ed25519 key could then be relaunched with other metadata, or at a moment the attacker chooses, and look normal.

QSL-1 turns the answers into a named configuration that one immutable program enforces at launch and records in one account, and that anyone can re-check. Level 2 binds the launch to a hash-based signature, whose security rests on SHA-256 alone.

### 2.2 Why not a new token program

Solana's token programs cannot be changed by an application: Token-2022 is maintained by Anza and upgraded through a multisig. A "QSL token program" would have to be a fork, and a fork is worse on every axis that matters here:

- **Reach.** Wallets, explorers, indexers and DEX aggregators recognize SPL Token and Token-2022 mints. A third token program's tokens would be missing or mis-shown in most of them.
- **Liquidity.** Meteora's Dynamic Bonding Curve (DBC) and DAMM v2 create pools only for SPL Token and Token-2022 mints. The permanently locked liquidity that L1 relies on lives in DAMM v2.
- **Attack surface.** A token program is the most security-critical code a token depends on. A fork adds a large, unaudited code base, and its own upgrade authority, to the trusted computing base.

A fork would therefore make tokens less secure and less usable.

### 2.3 Layering, as standards usually do

QSL-1 is layered on Token-2022 the way ERC-4626 is layered on ERC-20: the base standard is unchanged, the layer constrains how it is used and adds what the base lacks. Concretely:

- the **base** is a Token-2022 mint with a fixed extension profile (§4);
- **enforcement** is by immutable programs: the launchpad, which fixes every parameter that could hide a rug and refuses to launch otherwise, and the Launch Guard hook, which enforces bounded launch rules that can never refuse a sale;
- **evidence** is the certificate and, for L2, the attestation and the record, all immutable;
- **verification** is open: the algorithm in §7 needs only an RPC endpoint.

### 2.4 Non-goals

QSL-1 does not:

- change Token-2022, Solana or any Meteora program;
- make tokens "quantum-proof": holders' wallets, the pools and Solana's consensus remain classical (§8.3);
- say anything about price, utility, legality, or the people behind a token;
- provide identity or reputation: an identity is a key, not a person (§8.1);
- provide privacy (§9).

---

## 3. Architecture

### 3.1 Programs

| Name in this document | Program | Id |
|---|---|---|
| `LAUNCHPAD` | Noised launchpad (certifier) | `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc` |
| `HOOK` | Noised Launch Guard (transfer hook) | `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` |
| `VAULT` | Noised PQ vault (optional custody; not part of a token's level) | `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb` |
| `SHIELD` | Noised Shield (optional privacy; §9) | `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9` |
| `AUTOPILOT` | Noised autopilot (optional treasury automation; described, not part of a level, §6.4) | `D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx` |
| `T22` | Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| `DBC` | Meteora Dynamic Bonding Curve 0.2.1 | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| `DBC_POOL_AUTHORITY` | DBC pool authority PDA (the hook authority of every DBC mint) | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| `DAMM` | Meteora DAMM v2 (cp_amm) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| `WSOL` | Wrapped SOL mint | `So11111111111111111111111111111111111111112` |
| `LOADER` | BPF upgradeable loader | `BPFLoaderUpgradeab1e11111111111111111111111` |

The Noised program ids are the same on every cluster. QSL-1 levels are defined for **mainnet-beta** only (genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; condition `cluster`).

### 3.2 Lifecycle

```text
create_launch     creator's wallet          Launch = Configured; parameters validated against the safety policy;
                                            DBC config created with every rug-relevant field fixed; params_hash stored
publish_metadata  anyone                    TokenMeta record at PDA(LAUNCHPAD; "metadata", launch, metadata_hash)
publish_rules     anyone (optional)         LaunchRules record at PDA(LAUNCHPAD; "rules", launch, rules_hash),
                                            verified for the launch's guard
attest_launch     anyone relays             LMS signature by the launch's identity over (launch, params_hash,
                                            creator, metadata_hash, rules_hash, window), verified on-chain; leaf burned
launch()          anyone, inside the window pool + mint (name/symbol/uri from the record) + hook policy (with the
                                            attested rule bytes, re-hashed); live state re-read; Certificate written
                                            with checks = 4095 (8191 with rules: RULES_BOUND)
commit / execute_batch / claim               fair-open batch: one buy, shared pro rata
guard period (<= 72 h)                      Launch Guard limits; sells always pass
graduation                                  DBC revokes the transfer hook (program and authority = None)
migration                                   DAMM v2 pool; 100% of the LP position permanently locked,
                                            NFT held by the launch-authority PDA
```

Detail: [SPEC.md](../SPEC.md) §1.3 and §1.4.

### 3.3 Accounts a verifier reads

| Account | Address | Owner |
|---|---|---|
| Mint `M` | given | `T22` |
| Certificate | `PDA(LAUNCHPAD; "certificate", M)` | `LAUNCHPAD` |
| Launch | `certificate.launch`, which must equal `PDA(LAUNCHPAD; "launch", creator, launch_seed)` | `LAUNCHPAD` |
| Launch authority | `PDA(LAUNCHPAD; "authority", launch)` (no data) | |
| Batch authority | `PDA(LAUNCHPAD; "batch", launch)` (no data) | |
| DBC config | `PDA(LAUNCHPAD; "dbc-config", launch)` | `DBC` |
| DBC pool | `PDA(DBC; "pool", dbc_config, max(M, WSOL), min(M, WSOL))` (byte order) | `DBC` |
| DBC base and quote vaults | `PDA(DBC; "token_vault", M, pool)`, `PDA(DBC; "token_vault", WSOL, pool)` | `T22`, SPL Token |
| Hook policy | `PDA(HOOK; "policy", M)` | `HOOK` |
| Hook account list | `PDA(HOOK; "extra-account-metas", M)` | `HOOK` |
| Attestation (L2) | `PDA(LAUNCHPAD; "attestation", launch)` | `LAUNCHPAD` |
| Identity (L2) | `PDA(LAUNCHPAD; "identity", pq_identity)` | `LAUNCHPAD` |
| Record (L2) | `certificate.metadata`, which must equal `PDA(LAUNCHPAD; "metadata", launch, metadata_hash)` | `LAUNCHPAD` |
| LP position (after migration) | `PDA(DAMM; "position", nft_mint)` for each position NFT held by the launch authority | `DAMM` |
| Programs and program data | the program accounts and `PDA(LOADER; program_id)` for `LAUNCHPAD` and `HOOK` (C1.24), and for `DBC`, `DAMM` and `T22` (§6.6, §8.2) | `LOADER` |
| Rules record (programmable) | `PDA(LAUNCHPAD; "rules", launch, cert.rules_hash)`, when the certificate binds rules | `LAUNCHPAD` |
| Autopilot (programmable) | `PDA(AUTOPILOT; "autopilot", launch)`; when it runs a graph, also `PDA(AUTOPILOT; "graph", launch, graph_hash)`, the authorizations its `auth_marks` name, and `AUTOPILOT` with its `ProgramData` | `AUTOPILOT`, `LAUNCHPAD` |

---

## 4. The base token: Token-2022 mint profile

A QSL-1 mint is a Token-2022 mint created by DBC inside the launchpad's `launch` instruction. The launchpad re-reads it after creation and aborts the whole launch unless every rule below holds (`checks.rs::inspect_mint`, `checks::verify_token_metadata`).

### 4.1 Required

| ID | Rule |
|---|---|
| B-1 | The mint account MUST be owned by `T22`, initialized, with decimals in 6..=9 and a non-zero supply at launch. |
| B-2 | `mint_authority` MUST be None. |
| B-3 | `freeze_authority` MUST be None. |
| B-4 | The mint MUST carry exactly three extensions: `TransferHook` (type 14), `MetadataPointer` (type 18), `TokenMetadata` (type 19). |
| B-5 | `MetadataPointer.authority` MUST be None and `MetadataPointer.metadata_address` MUST be the mint itself. |
| B-6 | `TokenMetadata.update_authority` MUST be None, `TokenMetadata.mint` MUST be the mint, and `additional_metadata` MUST be empty. |
| B-7 | `TokenMetadata.name` and `.symbol` MUST equal the attested record's, and `.uri` MUST equal the uri derived from it (§7.7.3). |
| B-8 | Until graduation, `TransferHook.program_id` MUST be `HOOK` and `TransferHook.authority` MUST be `DBC_POOL_AUTHORITY`. From graduation on, both MUST be None. |

### 4.2 Allowed

Nothing beyond §4.1. After graduation the `TransferHook` extension stays in the mint with both fields None; that is the only allowed change to the mint's configuration over its life.

### 4.3 Forbidden

Every other mint extension is forbidden, including every extension type a verifier does not know. Token-2022 cannot add a mint extension after initialization, so B-4 checked once holds forever (under Token-2022's current code). The reasons, for the extensions that exist today:

| Extension | Why it is forbidden |
|---|---|
| `TransferFeeConfig` | A fee authority can raise transfer fees and withdraw them. |
| `MintCloseAuthority` | A mint at zero supply can be closed and re-created at the same address with other extensions. |
| `PermanentDelegate` | A key can move or burn tokens out of any holder's account. |
| `DefaultAccountState` | New accounts can start frozen. |
| `Pausable` | A key can halt every transfer. |
| `NonTransferable` | Tokens could never be sold. |
| `ConfidentialTransferMint`, `ConfidentialMintBurn`, `ConfidentialTransferFeeConfig` | Hidden balances and supply break the public accounting that L1 relies on (privacy is a separate layer, §9). |
| `InterestBearingConfig`, `ScaledUiAmount` | An authority can change what a unit is displayed as. |
| `GroupPointer`, `TokenGroup`, `GroupMemberPointer`, `TokenGroupMember` | Not needed; each adds an authority field. |
| Any other or unknown type | Fail closed. |

### 4.4 Token accounts, quote and pool

- QSL-1 places no requirement on holders' token accounts. The hook does, during the guard period: it refuses a transfer that is not a sale (and moves tokens) into a destination token account without Token-2022's `ImmutableOwner` extension (hook error 6010 `MutableOwner`), unless the destination's owner is one of the policy's exempt keys (the launchpad's batch-authority and launch-authority PDAs). It reads the extension from the destination account's own data, after the sale, guard-end, snipe-shield, zero-amount and exempt-destination checks and before the exempt-source check, the wallet-to-wallet lock and the caps. Token-2022 associated token accounts always carry `ImmutableOwner`, so ordinary wallets are unaffected. This stops a token account's owner from being reassigned during the guard; it does not stop control changing without a transfer (§8.4). The hook applies this and every other built-in check whatever the transaction's top-level program; only the creator's launch rules are skipped for moves through `VAULT` and `SHIELD` (§6.4).
- The quote mint MUST be `WSOL`. The pool MUST be a DBC transfer-hook pool on the launch's own DBC config, migrating to DAMM v2.

---

## 5. Account layouts (normative)

Integers are little-endian unless stated. Offsets include the 8-byte Anchor discriminator. Account discriminators are `SHA256("account:<Name>")[0..8]`.

### 5.1 Certificate (`PDA(LAUNCHPAD; "certificate", mint)`, version 4, 519 bytes; version 3, 487 bytes)

Discriminator `cae5dedc74144a43`.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 8 | 1 | `version` | 4 (3 for launches made before programmable launches) |
| 9 | 1 | `bump` | canonical bump of the PDA |
| 10 | 32 | `launch` | the `Launch` account |
| 42 | 32 | `base_mint` | the mint |
| 74 | 32 | `pool` | the DBC pool |
| 106 | 32 | `dbc_config` | the DBC config |
| 138 | 32 | `creator` | informational only; has no powers |
| 170 | 8 | `launched_at` | i64, unix seconds |
| 178 | 1 | `token_decimal` | |
| 179 | 8 | `initial_supply` | u64, supply right after pool creation |
| 187 | 4 | `checks` | u32 bit flags (§6.5): 4,095 on every version-3 certificate; on version 4, 4,095 without rules and 8,191 (`RULES_BOUND` added) with them |
| 191 | 8 | `migration_quote_threshold` | lamports |
| 199 | 1 | `migration_fee_option` | 0..=5, DAMM v2 fee tier |
| 200 | 8 | `snipe_shield_end_ts` | the scheduled end (= `execute_end_ts`) |
| 208 | 8 | `execute_end_ts` | |
| 216 | 8 | `guard_end_ts` | |
| 224 | 8 | `max_wallet` | 0 = off |
| 232 | 8 | `max_buy` | per transfer; 0 = off |
| 240 | 1 | `p2p_locked` | |
| 241 | 2 | `platform_fee_bps` | |
| 243 | 136 | `recipients` | 4 x (`wallet` 32, `bps` u16); unused slots zero |
| 379 | 32 | `params_hash` | SHA-256 of the borsh `LaunchParams` |
| 411 | 2 | `policy_version` | 3 |
| 413 | 32 | `pq_identity` | |
| 445 | 2 | `pq_leaf` | the LMS leaf that signed |
| 447 | 8 | `attested_slot` | |
| 455 | 32 | `metadata` | the attested `TokenMeta` record |
| 487 | 32 | `rules_hash` | version 4 only: `SHA256("PHX-RULES-V1" \|\| rule bytes)` of the attested launch rules; all zero for none |

The certificate is written only by `LAUNCHPAD`'s `launch`, after the checks listed in §6.5 passed on live state, in the same atomic instruction that created the mint. No instruction modifies or closes it. Version 4 is version 3 with `rules_hash` appended (§10.2 rule 3): its first 487 bytes have the same fields at the same offsets.

This revision knows certificate versions 3 (487 bytes) and 4 (519 bytes). A version-4 certificate goes with attestation version 3 and hook policy version 2; a version-3 one with attestation version 2 and hook policy version 1 (a verifier that finds the generations mixed fails the condition that reads the mismatching account). A certificate of any other version or length is evaluated by no condition beyond C1.1 and C1.2, and gets no level (§10.2 rules 4 and 5).

### 5.2 Launch (`PDA(LAUNCHPAD; "launch", creator, launch_seed)`, version 2, 585 bytes)

Discriminator `903333a3ce55d526`. Fields a verifier reads:

| Offset | Size | Field |
|---|---|---|
| 8 | 1 | `version` (2) |
| 13 | 1 | `status` (0 Configured, 1 Live) |
| 14 | 32 | `launch_seed` |
| 46 | 32 | `creator` |
| 78 | 32 | `dbc_config` |
| 110 | 32 | `launch_authority` |
| 142 | 32 | `batch_authority` |
| 174 | 32 | `base_mint` |
| 206 | 32 | `pool` |
| 238 | 32 | `treasury` |
| 270 | 2 | `platform_fee_bps` |
| 272 | 136 | `recipients` (as in the certificate) |
| 408 | 1 | `recipient_count` |
| 409 | 1 | `token_decimal` |
| 410 | 8 | `migration_quote_threshold` |
| 418 | 1 | `migration_fee_option` |
| 419 | 4 | `open_delay_secs` |
| 423 | 4 | `guard_secs` |
| 427 | 2 | `max_wallet_bps` |
| 429 | 2 | `max_buy_bps` |
| 431 | 1 | `p2p_locked` |
| 432 | 8 | `batch_wallet_cap` |
| 440 | 8 | `batch_total_cap` (resolved) |
| 448 | 32 | `params_hash` |
| 480 | 8 | `launch_ts` |
| 488 | 8 | `commit_end_ts` |
| 496 | 8 | `execute_end_ts` |
| 504 | 8 | `guard_end_ts` |
| 512 | 8 | `total_committed` |
| 520 | 1 | `executed` |
| 521 | 8 | `quote_spent` |
| 529 | 8 | `tokens_out` |
| 537 | 8 | `tokens_claimed` |
| 545 | 8 | `quote_refunded` |
| 553 | 32 | `pq_identity` |

### 5.3 Attestation (`PDA(LAUNCHPAD; "attestation", launch)`, version 3, 2,708 bytes; version 2, 2,676 bytes)

Discriminator `987db75624927949`. An account with `version` 0 and a zero `launch` is an empty attestation (valid signatures only burned their leaves); it attests nothing. Version 3 (with certificate version 4) inserts `rules_hash` after `metadata_hash`, so every later field moves by 32 bytes; version 2 (with certificate version 3) has no `rules_hash`.

| Field | Version 3: offset | Version 2: offset | Size |
|---|---|---|---|
| `version` | 8 (3) | 8 (2) | 1 |
| `bump` | 9 | 9 | 1 |
| `launch` | 10 | 10 | 32 |
| `pq_identity` | 42 | 42 | 32 |
| `leaf` (u16, < 1,024) | 74 | 74 | 2 |
| `metadata_hash` | 76 | 76 | 32 |
| `rules_hash` (all zero for none) | 108 | none | 32 |
| `message_hash` (SHA-256 of the message, §7.7.4: 221 bytes for v3, 189 for v2) | 140 | 108 | 32 |
| `slot` | 172 | 140 | 8 |
| `not_before` (i64) | 180 | 148 | 8 |
| `not_after` (i64) | 188 | 156 | 8 |
| signature length (u32, 2,508) | 196 | 164 | 4 |
| LMS signature | 200 | 168 | 2,508 |

For a `Live` launch the attestation never changes. While a launch is still `Configured`, an attestation whose window ended unused is replaced whole by the next attesting signature of the same identity; this never affects a launch that has a certificate. A verifier that reads an attestation before launch MUST NOT cache it.

### 5.4 Identity (`PDA(LAUNCHPAD; "identity", pq_identity)`, version 1, 196 bytes)

Discriminator `3a84050cb0a45570`. `version` at 8, `bump` at 9, `public_key` (56 bytes: `u32be(6) || u32be(3) || I[16] || T1[32]`) at 10..66, `used` leaf bitmap (128 bytes; leaf `q` is used when `used[q >> 3] & (1 << (q & 7)) != 0`) at 66..194, `used_count` (u16) at 194..196.

### 5.5 TokenMeta record (`PDA(LAUNCHPAD; "metadata", launch, metadata_hash)`, version 1)

Discriminator `8257ae23152c5c13`. `version` at 8, `bump` at 9, `flags` at 10, `launch` at 11..43, `metadata_hash` at 43..75, then four borsh strings (`u32le` length, then UTF-8 bytes) from 75: `name` (1..=32 bytes), `symbol` (1..=10 bytes), `uri`, `doc` (at most 3,072 bytes). Size `91 + |name| + |symbol| + |uri| + |doc|` bytes, exactly.

`flags` is 0 (no uri), 1 (`INLINE_URI`, requires a non-empty `doc`) or 2 (`EXTERNAL_URI`: `uri` is `https://` plus at least one byte, at most 200 bytes, every byte in 0x21..=0x7E). Without `EXTERNAL_URI`, `uri` is empty. `doc` is UTF-8 the program does not parse; the Noised SDK writes compact JSON with an inline 32x32 PNG icon.

Anyone can publish records under any launch, each at its own address. **Only the record the attestation and the certificate name is the token's.** Verifiers MUST NOT search for a launch's records (§8.5).

### 5.6 Hook policy (`PDA(HOOK; "policy", mint)`, version 2, `279 + rules_len` bytes; version 1, 275 bytes)

Discriminator `6772f6550f16bec3`. Version 2 (with certificate version 4) appends the creator's rule bytes to version 1's fields (with certificate version 3).

| Offset | Size | Field |
|---|---|---|
| 8 | 1 | `version` (2, or 1) |
| 9 | 1 | `bump` |
| 10 | 32 | `mint` |
| 42 | 32 | `pool` |
| 74 | 32 | `base_vault` |
| 106 | 8 | `launch_ts` |
| 114 | 8 | `snipe_shield_end_ts` |
| 122 | 8 | `guard_end_ts` |
| 130 | 8 | `max_wallet` |
| 138 | 8 | `max_buy` |
| 146 | 1 | `p2p_locked` |
| 147 | 128 | `exempt` (4 keys; unused = zero) |
| 275 | 4 | `rules_len` (u32; version 2 only; 0 without rules, at most 1,228) |
| 279 | `rules_len` | the launch rules' PXR1 bytes (version 2 only), exactly the attested rules record's |

Written once by `HOOK`'s `create_policy`, which only `LAUNCHPAD`'s `["hook-authority"]` PDA can sign. The only later change is `end_snipe_shield`, called by `LAUNCHPAD`'s `execute_batch`, which sets `snipe_shield_end_ts = min(snipe_shield_end_ts, now)`. The hook decides a sale, and any transfer after `guard_end_ts`, from `base_vault` and `guard_end_ts` at their fixed offsets before it decodes the rest of the policy, so no layout problem can ever block a sale.

### 5.7 Hook account list (`PDA(HOOK; "extra-account-metas", mint)`, 86 bytes)

Exactly these bytes (two entries: the policy PDA `["policy", mint]` of `HOOK`, then the instructions sysvar; neither signer nor writable):

```text
692565c54bfb661a4a00000002000000010106706f6c69637903010000000000000000000000000000000000000000000000
000006a7d517187bd16635dad40455fdc2c0c124c68f215675a5dbbacb5f080000000000
```

(One line, wrapped for display. Reference: `expectedMetaListData()` in `sdk/src/verify/verifyLaunch.ts`.)

### 5.8 Token-2022 mint layout used

Base mint: `mint_authority` COption at 0..36 (u32le tag, then key; tag 0 = None), `supply` u64 at 36..44, `decimals` at 44, `is_initialized` at 45, `freeze_authority` COption at 46..82. Then zero padding to 165, the account type byte at 165 (1 = mint), then TLV entries from 166: `u16le type`, `u16le length`, value. `TransferHook` value: `authority` 0..32, `program_id` 32..64. `MetadataPointer` value: `authority` 0..32, `metadata_address` 32..64. `TokenMetadata` value: `update_authority` 0..32, `mint` 32..64, then borsh `name`, `symbol`, `uri`, and `additional_metadata` as a `u32le` count followed by pairs.

### 5.9 Third-party accounts

DBC and DAMM v2 accounts are read by field name, decoded with the IDLs in `idls/dynamic_bonding_curve.json` (DBC 0.2.1) and `idls/cp_amm.json` (DAMM v2). A verifier MUST check owner and discriminator before decoding. Field names below are those IDLs'.

### 5.10 Programmable accounts (read for §6.4 only)

- **Rules record** `PDA(LAUNCHPAD; "rules", launch, rules_hash)`, discriminator `ee49471de730278d`, `78 + len` bytes: `version` (1) at 8, `bump` at 9, `launch` 10..42, `rules_hash` 42..74, `len` (u32) 74..78, the PXR1 bytes from 78 (1 to 1,228 bytes).
- **Authorization** `PDA(LAUNCHPAD; "auth", launch, [kind], payload_hash)`, discriminator `0344a8f3c3a8204b`, 2,669 bytes: `version` (1) 8, `bump` 9, `launch` 10..42, `pq_identity` 42..74, `kind` 74, `payload_hash` 75..107, `message_hash` 107..139, `unix_time` (i64) 139..147, `slot` 147..155, `leaf` (u16) 155..157, signature length (u32, 2,508) 157..161, LMS signature 161..2,669. `pq_authorize` writes one only for kinds 1 (activate a graph), 2 (freeze it) and 3 (remove its operator), only when the signer is the launch's identity; any other valid signature only burns its leaf.
- **Autopilot** `PDA(AUTOPILOT; "autopilot", launch)`, discriminator `71c3e5399efa3186`, 1,076 bytes; fields read: `version` (1) 8, `bump` 9, `launch` 11..43, `mint` 43..75, `active_graph` 107..139, `pending_graph` 139..171, `pending_activate_at` 171..179, `activated_at` 211..219, `frozen` 219, `operator` 220..252, `auth_marks` (3 x (`slot` u64, `key` 32): activate 252..292, freeze 292..332, revoke 332..372).
- **Graph record** `PDA(AUTOPILOT; "graph", launch, graph_hash)`, discriminator `765f5c156716b378`, `78 + len` bytes: `version` (1) 8, `bump` 9, `launch` 10..42, `graph_hash` 42..74, `len` (u32) 74..78, the PXG1 bytes from 78 (1 to 2,044 bytes).

---

## 6. Conformance levels

### 6.1 General rules

1. A level is a property of a mint on mainnet-beta at a given slot, established by a verifier from live account state read at that slot. Levels are nested: L2 implies L1. There is no third level: launch rules and automation are described, never levelled (§6.4).
2. A verifier MUST NOT award a level from the certificate's `checks` alone. The flags record what `launch` verified at launch; a verifier MUST re-check the conditions of the level it reports.
3. A verifier MUST NOT award any level on a cluster other than mainnet-beta (condition `cluster`), nor while a program C1.24 covers can still be upgraded: `LAUNCHPAD`, and `HOOK` until graduation. It MAY report "candidate" (§7.9).
4. A verifier MUST fail closed: an account that is missing, owned by the wrong program, of the wrong length or discriminator, or that does not decode, fails the condition that reads it. So does a certificate of a version this document does not list (§10.2 rule 4).
5. Conditions marked "SHOULD" in the tables are recommended checks whose failure a verifier SHOULD report as a warning; all others are required for the level.
6. A verifier MUST state which trusted parties remain (§8.2) wherever it shows a level (Appendix A).
7. A condition that does not apply in the token's current phase is reported as `skip` and does not stand in the way of its level: C1.22 after graduation, C1.23 before migration. A condition the run never reached because an earlier step stopped it (§7.3) is also `skip`, and does stand in the way.
8. Launch rules and automation never raise or lower a level. A verifier MUST NOT show them as a level, as "safer" or with a level's colour, and MUST show the warnings of §6.4 wherever it shows them.

### 6.2 Level 1: No-rug

A mint `M` is **L1** when every condition below holds. `L`, `H` stand for `LAUNCHPAD`, `HOOK`; `cert` is the certificate, `launch` the Launch account it names.

| ID | Account | Field (offset) | Expected value | Cert bit |
|---|---|---|---|---|
| `cluster` | the RPC endpoint | `getGenesisHash` | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (mainnet-beta). Devnet, any other hash, and a hash that cannot be read fail. The Noised program ids are the same on every cluster, so nothing else tells a devnet certificate apart (§7.1) | |
| C1.1 | `PDA(L; "certificate", M)` | owner; length; bytes 0..8 | `L`; 519 or 487; `cae5dedc74144a43` | |
| C1.2 | certificate | `version` (8); `bump` (9); `base_mint` (42..74); `policy_version` (411..413) | 4 with 519 bytes, or 3 with 487 bytes; the canonical bump; `M`; 3. Any other version or policy version fails, higher ones included, and so does a known version at the other version's length (§10.2 rule 4) | |
| C1.3 | certificate | `checks` (187..191); version 4: `rules_hash` (487..519) | `(checks & 4095) == 4095` (never `checks == 4095`), and no bit a verifier does not know: version 3, exactly 4,095; version 4, exactly 4,095 when `rules_hash` is zero and exactly 8,191 (`4095 \| RULES_BOUND`) when it is not (§6.5). Any other bit fails closed | all |
| C1.4 | mint `M` | owner; type byte (165); `is_initialized` (45); `decimals` (44); `supply` (36..44) | `T22`; 1; 1; `cert.token_decimal` (178); `supply <= cert.initial_supply` (179..187) (burns only lower it) | |
| C1.5 | mint `M` | `mint_authority` tag (0..4) | 0 (None) | 1 |
| C1.6 | mint `M` | `freeze_authority` tag (46..50) | 0 (None) | 2 |
| C1.7 | mint `M` | `TokenMetadata` value 0..32 (`update_authority`), 32..64 (`mint`) | zero key; `M` | 4 |
| C1.8 | mint `M` | `MetadataPointer` value 0..32 (`authority`), 32..64 (`metadata_address`) | zero key; `M` | 8 |
| C1.9 | mint `M` | the set of TLV extension types | exactly {14, 18, 19}, each once, TLV well-formed to its end | 16 |
| C1.10 | mint `M` | `TransferHook` value 0..32 (`authority`), 32..64 (`program_id`) | before graduation: `DBC_POOL_AUTHORITY`, `H`; after graduation (C1.19): both zero keys. A revoked hook before graduation, or an active one after it, fails | 32 |
| C1.11 | DBC config at `cert.dbc_config` | owner and discriminator; `transfer_hook_program`; then in `config`: `fee_claimer`, `leftover_receiver`; `token_type`; `token_update_authority`; `migration_option`; `collect_fee_mode`; `activation_type`; `creator_trading_fee_percentage`; `fixed_token_supply_flag`; `pool_creation_fee`; `enable_first_swap_with_min_fee`; `token_decimal`, `migration_quote_threshold`, `migration_fee_option` | `DBC`, `ConfigWithTransferHook`; `H`; both the launch authority; 1 (Token-2022); 1 (immutable); 1 (DAMM v2); 0 (quote only); 1 (timestamp); 0; 0 (dynamic supply: unsold supply is burned at migration); 0; 0; equal to the certificate | |
| C1.12 | DBC config | `partner_permanent_locked_liquidity_percentage`; `partner_liquidity_percentage`; `creator_liquidity_percentage`; `creator_permanent_locked_liquidity_percentage`; `partner_liquidity_vesting_info.is_initialized`; `creator_liquidity_vesting_info.is_initialized` | 100; 0; 0; 0; 0; 0 | 64 |
| C1.13 | DBC config | `migration_fee_percentage`; `creator_migration_fee_percentage` | 0; 0 | 128 |
| C1.14 | DBC config | `locked_vesting_config` (`amount_per_period`, `cliff_duration_from_migration_time`, `frequency`, `number_of_period`, `cliff_unlock_amount`) | all 0 | 256 |
| C1.15 | DBC config | `quote_mint` | `WSOL` | 512 |
| C1.16 | DBC config | `pool_fees.base_fee.base_fee_mode`; the base fee once its schedule has ended (its floor, computed exactly as DBC does: `policy.rs::min_base_fee_numerator`), plus the largest dynamic fee its parameters allow (0 when `dynamic_fee.initialized == 0`); the schedule's duration, `first_factor` (periods) × `second_factor` (seconds per period) | 0 (linear fee schedule) or 1 (exponential fee schedule), the only modes `policy.rs::validate_base_fee` accepts: any other mode fails, including DBC's rate limiter (2), whose fee grows with trade size, and a schedule whose floor cannot be computed; floor and dynamic fee at most 1,000 bps together (`policy.rs::within_fee_ceiling`); duration at most `launch.open_delay_secs` | |
| C1.17 | Launch at `cert.launch` | owner; length; bytes 0..8; `version` (8); `status` (13) | `L`; 585; `903333a3ce55d526`; 2; 1 (Live) | |
| C1.18 | Launch | its address; `base_mint`; `pool`; `dbc_config`; `launch_authority`; `batch_authority`; `creator`; `params_hash`; `token_decimal`, `migration_quote_threshold`, `migration_fee_option`; `platform_fee_bps`; `recipients`; `p2p_locked`; `launch_ts`; `execute_end_ts`; `guard_end_ts` | `PDA(L; "launch", creator, launch_seed)`; `M`; `cert.pool`; `PDA(L; "dbc-config", launch)` = `cert.dbc_config`; `PDA(L; "authority", launch)`; `PDA(L; "batch", launch)`; `cert.creator`; `cert.params_hash`; equal to the certificate; equal; equal; equal; `cert.launched_at`; `cert.execute_end_ts` = `cert.snipe_shield_end_ts`; `cert.guard_end_ts` | |
| C1.19 | DBC pool at `cert.pool` | address; owner and discriminator; `config`; `creator`; `base_mint`; `base_vault`; `quote_vault` | `PDA(DBC; "pool", cert.dbc_config, max(M, WSOL), min(M, WSOL))`; `DBC`, transfer-hook pool; `cert.dbc_config`; the launch authority; `M`; `PDA(DBC; "token_vault", M, pool)`; `PDA(DBC; "token_vault", WSOL, pool)`. **Graduated** means `is_migrated != 0`, or `migration_progress >= 1` (post-bonding-curve or later), or `quote_reserve >= migration_quote_threshold`. **Migrated** means exactly `is_migrated != 0`; a migrated pool is graduated | |
| C1.20 | certificate | `platform_fee_bps` (241..243); `recipients` (243..379), four slots of (`wallet` 32, `bps` u16) | at most 5,000; 1 to 4 recipients in the first slots, then only unused slots, as `create_launch` writes them (`policy.rs::validate_recipients` copies the recipients in order from slot 0 and leaves the rest zero). A slot is used when its key or its `bps` is not zero; an unused slot is 34 zero bytes; a used slot after an unused one fails. Each used slot has a non-zero key and `bps > 0`; the keys are distinct, none is the launch or batch authority, and the `bps` sum to 10,000 | |
| C1.21 | `PDA(H; "policy", M)`, required before graduation, SHOULD after (a mismatch or a missing policy is then a warning) | owner; length; bytes 0..8; `version`; `rules_len` (version 2); `mint`; `pool`; `base_vault`; `launch_ts`; `guard_end_ts`; `snipe_shield_end_ts`; `max_wallet`; `max_buy`; `p2p_locked`; `exempt` | `H`; with a version-4 certificate exactly `279 + rules_len` bytes, version 2, `rules_len` at most 1,228 and not zero exactly when `cert.rules_hash` is not zero (the bytes themselves are P.R4's); with a version-3 certificate 275 bytes, version 1; `6772f6550f16bec3`; `M`; `cert.pool`; the DBC base vault; `cert.launched_at`; `cert.guard_end_ts`, with `guard_end_ts - launch_ts <= 259,200`; equal to `cert.snipe_shield_end_ts` while the batch has not executed (`launch.executed == 0`), otherwise in `[launch.commit_end_ts, launch.execute_end_ts)`, and in every case `<= launch_ts + 3,600` and `<= guard_end_ts`; `cert.max_wallet`, which is 0 or `>= cert.initial_supply / 1,000`; `cert.max_buy`, 0 or `>= cert.initial_supply / 10,000`; `cert.p2p_locked`; `[launch.batch_authority, launch.launch_authority, zero, zero]` | 32 |
| C1.22 | `PDA(H; "extra-account-metas", M)`, required before graduation; after graduation it does not apply (`skip`, §6.1 rule 7) | owner; data | `H`; exactly the 86 bytes of §5.7 | 32 |
| C1.23 | after migration only (before it: `skip`, §6.1 rule 7): the LP position | Token-2022 accounts owned by the launch authority holding exactly 1 unit of a mint `n`; `PDA(DAMM; "position", n)`: owner, discriminator, `nft_mint`, `pool`, `permanent_locked_liquidity`, `vested_liquidity`; the pool: owner, discriminator, `token_a_mint`, `token_b_mint`, `creator` | at least one such position (owned by `DAMM`, `nft_mint == n`) in a pool owned by `DAMM` with `token_a_mint == M`, `token_b_mint == WSOL` and creator `DBC_POOL_AUTHORITY` (the pool DBC's migration created). The verdict is taken on one such pool: the one on the canonical migration config for `migration_fee_option` if the launch authority holds a position there, otherwise the one where it holds the most permanently locked liquidity. In that pool, the launch authority's positions hold more than 0 `permanent_locked_liquidity` together, and every one of them has `vested_liquidity == 0` | 64 |
| C1.24 | `LAUNCHPAD`, and `HOOK` until graduation (while graduation cannot be told, `HOOK` counts): the program account and `PDA(LOADER; program)` | program: owner, executable, u32le tag at 0..4, `ProgramData` address at 4..36; `ProgramData`: owner, u32le tag at 0..4, slot at 4..12, `upgrade_authority_address` option tag at 12 | program: `LOADER`, executable, tag 2, `PDA(LOADER; program)`; `ProgramData`: `LOADER`, tag 3, option tag 0 (None): the program is finalized. A program or `ProgramData` that is missing or malformed fails too, and then the mint is not a candidate (§7.9) | |

What L1 means, and what it does not: §8.1.

Notes on L1:

- "100% of liquidity permanently locked" is, before migration, a property of the DBC config (C1.12) that DBC executes at migration (`permanent_lock_position`). After migration it is checked directly (C1.23). Both rest on Meteora's code (§8.2).
- "Sales are never blocked" is a property of `HOOK`'s code, which is pinned by C1.10 and C1.24: a transfer into the pool's base vault from any other account is allowed before any other rule runs (`rules::evaluate`, property test `sells_are_never_blocked`; LiteSVM `sells_into_the_base_vault_are_never_blocked`). It is not a promise that every sale succeeds (§8.1).
- "Fees go only to declared recipients" is a property of `LAUNCHPAD`'s code: `distribute` pays the treasury (at most 50%, snapshotted from the immutable `Protocol` account) and the 1 to 4 recipients fixed at `create_launch`, and burns fees paid in the token. No instruction changes the recipients.
- `params_hash` is computed on-chain by `create_launch` from the same parameters it validates and configures. A verifier relies on the finalized launchpad for that binding; it MAY recompute `params_hash` from the `create_launch` instruction data in the transaction history (§7.7.2).
- **What C1.24 covers, and why only that.** A level depends on the Noised code that can still act on the token. `LAUNCHPAD` always counts: it wrote the certificate, and its PDAs hold the LP position, pay claims and route fees. `HOOK` counts until graduation. From graduation on, the mint's `TransferHook` program and authority are both None (C1.10), and with no authority nobody can ever set a hook again, so Token-2022 never calls `HOOK` for this mint any more. From then on neither `HOOK`'s upgrade authority nor its account list (C1.22) can affect the token. `VAULT` and `SHIELD` are not part of any token's conformance: a vault is custody a holder may choose, and a zToken is another mint (§9). `AUTOPILOT` counts for no level: whether it is final is reported with the programmable component (P.G5). DBC, DAMM v2 and Token-2022 are not Noised's to finalize; they are trusted parties (§8.2), and their upgrade authorities and last deploy slots are reported as information (§6.6), not as conditions.
- **Graduated and migrated.** C1.19 defines both, and every condition uses those definitions. DBC's migration to DAMM v2 sets `is_migrated = 1` and `migration_progress = 3` (CreatedPool) in the same instruction (seen on the mainnet DBC 0.2.1 binary in LiteSVM: [FACTS.md](../research/FACTS.md), "full DBC 0.2.1 transfer-hook pool lifecycle"), so on every state DBC writes the two agree. The Noised SDK's `curveStatus` helper (used by `verifyLaunch`, the launch readers' `market` snapshot, `launchPhase` and `buildSwapTx`) counts a pool as migrated when either field says so (`is_migrated != 0` or `migration_progress == 3`); a QSL-1 verifier reads **migrated** as `is_migrated` alone, and so does `checkQsl1` for its `migrated` field; `checkQsl1` checks the LP position (C1.23) when either field says the liquidity moved (§7.6, reference behaviour). They could differ only after a change to DBC's code, which is a trusted party's change that already calls for re-running a verdict (§7.10).

### 6.3 Level 2: Quantum-attested

A mint is **L2** when it is L1 and every condition below holds.

| ID | Account | Field (offset) | Expected value | Cert bit |
|---|---|---|---|---|
| C2.1 | certificate | `checks` bits 1024 and 2048 | set. **Implied by C1.3; it cannot fail on its own:** C1.3 requires `(checks & 4095) == 4095`, which includes both bits, and §7.3 stops the run when C1.3 fails. A verifier reports C2.1 as passed whenever the run gets past C1.3 (and as not checked otherwise). It is kept so that the L2 table names the certificate bits L2 rests on | 1024, 2048 |
| C2.2 | `PDA(L; "attestation", cert.launch)` | owner; length; bytes 0..8; `version`; `launch`; `pq_identity`; `leaf`; version 3: `rules_hash`; `slot`; signature length (offsets of §5.3) | `L`; 2,708 with a version-4 certificate (2,676 with version 3); `987db75624927949`; 3 (2); `cert.launch`; `cert.pq_identity` (413..445) and `launch.pq_identity` (553..585), not all zero; `cert.pq_leaf` (445..447), < 1,024; `cert.rules_hash` (487..519, all zero for none); `cert.attested_slot` (447..455); 2,508 | 1024 |
| C2.3 | attestation | `not_before`, `not_after` (180..188, 188..196 in version 3; 148..156, 156..164 in version 2) | `60 <= not_after - not_before <= 3,600`; `not_before <= cert.launched_at <= not_after` | 1024 |
| C2.4 | attestation | `message_hash` (140..172 in version 3; 108..140 in version 2) | `SHA256(m)`, `m` rebuilt from on-chain data (§7.7.4): message v3 (221 bytes, with `rules_hash`) for version 3, message v2 (189 bytes) for version 2 | 1024 |
| C2.5 | `PDA(L; "identity", cert.pq_identity)` | owner; length; bytes 0..8; `version`; `public_key` (10..66); `used` (66..194) | `L`; 196; `3a84050cb0a45570`; 1; `SHA256(0x21 \|\| public_key) == cert.pq_identity` (which C2.2 makes equal to the attestation's and the launch's); the used bit of the attestation's `leaf` (74..76) set, the leaf C2.2 makes equal to `cert.pq_leaf` (a verifier that cannot read the attestation MAY test `cert.pq_leaf`; C2.2 fails then anyway) | 1024 |
| C2.6 | attestation | signature (200..2,708 in version 3; 168..2,676 in version 2) | `LMS_Verify(public_key, m, signature)` (§7.7.5) succeeds and yields leaf `q == leaf` | 1024 |
| C2.7 | record at `cert.metadata` (455..487) | address; owner; bytes 0..8; `version` (8); `bump` (9); `launch` (11..43); `metadata_hash` (43..75); content | `PDA(L; "metadata", cert.launch, attestation.metadata_hash)`; `L`; `8257ae23152c5c13`; 1; that PDA's canonical bump; `cert.launch`; `attestation.metadata_hash` (76..108); `metadata_hash_v2(name, symbol, flags, uri, doc) == metadata_hash` (§7.7.3), and the content meets §5.5 | 2048 |
| C2.8 | mint `M`, `TokenMetadata` | `name`, `symbol`, `uri` as raw bytes; bytes after `uri` | the record's `name` and `symbol`; the uri derived from the record (§7.7.3); exactly `u32le(0)` (no additional metadata) | 2048 |

What L2 adds is a cryptographic statement about origin: under the unforgeability of LMS with one-time leaves (which reduces to properties of SHA-256), nobody could have made this launch go live, with these parameters, this metadata, these launch rules (message v3 signs their hash; C2.2 binds it to the certificate's) and inside this window, without the identity's secret. It says who set the rules, not that they are good for holders (§6.4). §8.1 and §8.3 say what it does not mean.

L2 holds whether the record's uri mode is none, inline or external. With `EXTERNAL_URI` (flags 2) only the link is signed; what it serves can change. Verifiers SHOULD say so (Appendix A).

### 6.4 Programmable: a described component, not a level

A token is **programmable** when its certificate binds launch rules (`rules_hash` not zero) or its autopilot runs a graph (`active_graph` not zero). Programmable is not a level, and it is not a safety property. Revision 0.3 drafted it as a third level; review 4 showed why it cannot be one: a rule set can be signed by the creator's identity, bound into the attestation and the certificate, enforced exactly as written, and still refuse every buy except into wallets the creator chose, or stop wallet-to-wallet transfers for hours. Binding proves who set the rules and that they cannot change, not that they are good for holders. Automation, likewise, can be run by an operator the creator chose, and replaced while it is not frozen.

What a verifier does when a token is programmable:

1. It MUST report the level exactly as without the component (L1, L2, a candidate or not QSL-1). A component never raises or lowers a level, whether its checks pass or fail.
2. It MUST show the tag next to the level, "QSL-1 L2 · programmable" (Appendix A.2), with a way to "read its rules": the rules and the automation in plain words, from the exact bytes on chain, with every address in full.
3. It MUST check the component (P.R1 to P.R4, P.G1 to P.G5 below) and say plainly when a check fails ("could not be confirmed: what it does is not known for sure").
4. It MUST show the warnings below that apply, next to the tag, most serious first. It MUST NOT present the component as safer, as a level, or with a level's colour.

#### 6.4.1 Component R: launch rules (PXR1)

Extra restrictions for the guard period, bound into the attestation (message v3 signs `rules_hash`, C2.4) and installed in the hook policy by `launch`, which re-hashes the record against the attested hash.

| ID | Account | Field | Expected value |
|---|---|---|---|
| P.R1 | certificate, version 4 | `rules_hash` (487..519); `checks` | not zero; `checks == 4095 \| RULES_BOUND` = 8,191 (C1.3 already requires it) |
| P.R2 | attestation, version 3 | the stored `rules_hash` (108..140); the signed message | `== cert.rules_hash`; message v3 (§7.7.4), which includes it, is the one `message_hash` names and the identity's LMS signature covers (C2.4 to C2.6 pass) |
| P.R3 | `PDA(L; "rules", launch, rules_hash)` (§5.10) | owner, discriminator, `version`, `bump`, `launch`, `rules_hash`, length; the rule bytes | `L`; LaunchRules; 1; the canonical bump; `cert.launch`; `cert.rules_hash`; exactly `78 + len` bytes, `1 <= len <= 1,228`; `SHA256("PHX-RULES-V1" \|\| bytes) == rules_hash`; the PXR1 verifier accepts the bytes with `guard_secs = launch.guard_secs`: magic `PXR1`, version 1, at most 8 keys, 1 to 16 rules, at most 64 condition nodes, exact length, every rule active only inside `0 <= from_rel < to_rel <= guard_secs`, effects in {DENY, CAP_AMOUNT, CAP_DEST_BALANCE} with non-zero caps, conditions well-formed for the rules context |
| P.R4 | hook policy, version 2 | `rules_len` and the rule bytes (275..) | exactly the rules record's bytes |

How the hook applies them (`HOOK` `rules.rs`): the creator's rules run after every built-in allow and denial (a sale, after `guard_end_ts`, the snipe shield, a zero amount, an exempt destination, `MutableOwner`, an exempt source, the wallet-to-wallet lock, the caps) and can only refuse. They are skipped when the current top-level instruction's program is `VAULT` or `SHIELD` (holders' post-quantum custody and privacy exits; review 4, R1); the built-in checks still apply to those moves. A call into the vault or the shield made through another program's CPI has that program as its top-level instruction, so the rules still apply to it. Sales are never refused, claims and the batch never reach the rules, and after `guard_end_ts` a launch with rules behaves as one without.

#### 6.4.2 Component G: autopilot graph (PXG1)

Automation of the token's treasury after launch.

| ID | Account | Field | Expected value |
|---|---|---|---|
| P.G1 | `PDA(AUTOPILOT; "autopilot", launch)` (§5.10) | owner; discriminator, length; `version`; `bump`; `launch`; `mint`; `active_graph`; `frozen`; pending update | `AUTOPILOT`; Autopilot, 1,076 bytes; 1; the canonical bump; `cert.launch`; `M`; not zero; 0 or 1; reported with its activation time |
| P.G2 | `PDA(AUTOPILOT; "graph", launch, active_graph)` | the graph bytes | `SHA256("PHX-GRAPH-V1" \|\| bytes) == active_graph`; the PXG1 verifier accepts them: magic `PXG1`, version 1, at most 8 distinct non-zero recipients whose bps sum to 10,000 if there are any, 1 to 16 nodes, at most 96 condition nodes, at most 2,044 bytes, known triggers and actions only (BUYBACK_BURN, BURN, DISTRIBUTE_SOL), `AFTER` references acyclic, epochs of at least 3,600 s, non-zero budgets, an operator present if and only if some node is operator-gated |
| P.G3 | the authorization `auth_marks[0]` names (§5.10), kind 1 | owner and address `PDA(L; "auth", launch, [1], payload_hash)` with its stored bump; `launch`; `pq_identity`; `kind`; `payload_hash`; `message_hash`; `leaf`; the stored LMS signature; `slot` | `L`; `cert.launch`; `cert.pq_identity`; 1 (GRAPH_ACTIVATE); `SHA256("PHX-GRAPH-ACT-V1" \|\| autopilot \|\| active_graph \|\| i64le(activate_at))` for some `activate_at` with `auth.unix_time <= activate_at <= activated_at` (the autopilot does not store it: searched, §7.10, or taken from the `GraphQueued` event); `SHA256(a)` with `a = "PHX-AUTH-V1" \|\| LAUNCHPAD \|\| launch \|\| creator \|\| kind \|\| payload_hash` (140 bytes) rebuilt from account data; the leaf's bit set in the identity's bitmap (shared with attestations); `LMS_Verify(public_key, a, signature)` yields that leaf; `== auth_marks[0].slot`. With an update queued, `auth_marks[0]` is the queued graph's and P.G3 cannot be checked from state (it fails, saying so) |
| P.G4 | autopilot; the authorization `auth_marks[1]` names, kind 2, when frozen | timelock; freeze | the running graph took effect no earlier than `auth.unix_time + 259,200` (72 h) unless it was the first graph; a queued update takes effect no earlier than 72 h after its own authorization landed; `frozen` is set only with a kind-2 authorization verified as in P.G3 whose `payload_hash` is the **freeze payload v2** `SHA256("PHX-GRAPH-FRZ-V2" \|\| autopilot \|\| active_graph \|\| i64le(not_after))` for some `not_after >= auth.unix_time` (the autopilot uses a freeze only while `now <= not_after`, review 4, R5; `not_after` is not stored: searched upwards from the authorization's landing, §7.10, or taken from the `freeze` instruction), newer than the latest activation used; a frozen graph never changes |
| P.G5 | `PDA(LOADER; AUTOPILOT)` | upgrade authority | None (otherwise a warning: the program can still change; never a level matter) |

What the autopilot can do, whatever its graph: treasury value leaves only to burns, buy-back-and-burn swaps on DAMM v2, the graph's declared recipients and bounded keeper tips; the treasury never sells the token; nothing in the autopilot can mint, freeze, touch the LP position, the hook policy or the launch parameters. An optional operator key (for example an AI agent) chooses timing and amounts of operator-gated nodes only within on-chain bounds. No Ed25519 key, the creator's included, can change a graph: every change needs an authorization by the launch's post-quantum identity (`pq_authorize` writes one only for kinds 1 to 3; any other valid signature only burns its leaf), replacements wait 72 h, a freeze is final, and a revocation of the operator only takes power away.

#### 6.4.3 Warnings

A verifier MUST show each warning that applies, in plain words, next to the programmable tag (Appendix A.2). For launch rules, it decides them with the hook's own evaluation of each rule (§6.4.1) on every transfer the rules can see (a buy, or a wallet-to-wallet transfer, of a non-zero amount, before `guard_end_ts`), at every second where the rule's condition can change, and for every amount, destination balance, owner, program and instruction count that can change its outcome; buys only from the snipe shield's end (before it, only the batch buys and the rules never see it); never with `VAULT` or `SHIELD` as the program. An ordinary buy is a small buy with 4 to 8 top-level instructions into a wallet the rules do not list, through a program they do not list.

| Warning | When | Example (the reference checker's words) |
|---|---|---|
| Insider-only buying | A rule refuses ordinary buys except into wallets it lists. Say how many wallets and for how long. | "For the first 2 hours, only 2 wallets chosen by the creator can buy; everyone else's buys are refused (rule 1)." |
| Buys refused | A rule refuses ordinary buys (or some of them, such as those with 8 instructions), for everyone, or except through apps it lists. Say for how long. | "For the first 10 minutes, ordinary buys are refused (rule 1)." |
| Wallet-to-wallet transfers | A rule refuses or limits transfers between wallets. | "For the first hour, some wallet-to-wallet transfers are limited (rule 3)." |
| Long rule | A rule that can refuse something stays on for more than one hour. | "Rule 1 stays on for 2 hours, more than an hour." |
| No-op rule | A rule can never refuse anything (its condition cannot hold, its cap is above the supply, it only matches programs the hook skips, or it lies inside the snipe shield and only targets buys). | "Rule 1 can never block anything, so it does nothing." |
| Too complex | The verifier could not try every case of a rule. | "Rule 4 has too many cases to summarize here: read it carefully." |
| Not confirmed | A component check (P.R1 to P.R4, P.G1 to P.G4) fails. | "Its launch rules could not be fully confirmed on-chain, so what they do is not known for sure." |
| Operator | The running graph has operator-gated steps and an operator that was not revoked. Name the operator in full. | "2 automation steps are run by a wallet the creator chose (<address>), which decides when and how much, within fixed limits." |
| Queued change | A new graph is queued. Say when it can take over. | "A new automation plan is already queued: it can take over from 2026-10-14 12:00 UTC." |
| Not frozen | The running graph is not frozen. | "Its automation is not frozen: the creator can switch to a new plan, which takes over 72 hours after it is approved." |
| Autopilot program can change | P.G5 fails because `AUTOPILOT` still has an upgrade authority. | "The autopilot program can still be changed by its team." |

**Settled by the specification's amendments**: an authorization stores its LMS signature and message hash, so a verifier re-verifies it from account state alone, without trusting the launchpad or searching transaction history (A1); `checks::ALL` stays 4,095, the set `launch` requires, and `RULES_BOUND = 4096` is set in addition when `rules_hash` is not zero and is never required (A2).

### 6.5 Certificate check bits

Every bit is set by `launch` only from a check on live state, never from intent (`checks.rs`). Certificates exist only with all twelve bits set, because `launch` aborts otherwise (`require!(checks_all == flags::ALL)`); a version-4 certificate also carries `RULES_BOUND` exactly when it binds rules.

| Bit | Name | Set by `launch` after | Conditions | Level |
|---|---|---|---|---|
| 1 | `MINT_AUTHORITY_NONE` | re-reading the mint | C1.5 | L1 |
| 2 | `FREEZE_AUTHORITY_NONE` | re-reading the mint | C1.6 | L1 |
| 4 | `METADATA_UPDATE_AUTHORITY_NONE` | re-reading `TokenMetadata` | C1.7 | L1 |
| 8 | `METADATA_POINTER_AUTHORITY_NONE` | re-reading `MetadataPointer` | C1.8 | L1 |
| 16 | `EXTENSION_SET_EXACT` | listing the extension types | C1.9 | L1 |
| 32 | `HOOK_IS_NOISED` | re-reading `TransferHook` (program and authority) | C1.10, C1.21, C1.22 | L1 |
| 64 | `LP_PERMANENTLY_LOCKED` | re-reading the DBC config's LP fields | C1.12, C1.23 | L1 |
| 128 | `NO_MIGRATION_FEE` | re-reading the DBC config | C1.13 | L1 |
| 256 | `NO_CREATOR_ALLOCATION` | re-reading the DBC config's vesting | C1.14 | L1 |
| 512 | `QUOTE_IS_WSOL` | re-reading the DBC config | C1.15 | L1 |
| 1024 | `PQ_ATTESTED` | checking the attestation's launch, identity and record against the launch, before any CPI, and the window against the clock | C2.2 to C2.6 | L2 |
| 2048 | `METADATA_ONCHAIN` | comparing the mint's `TokenMetadata`, after the pool CPI, with the record's name, symbol and derived uri | C2.7, C2.8 | L2 |
| 4096 | `RULES_BOUND` | certificate version 4 only: set in addition to the twelve bits when `rules_hash` is not zero (the attested rules were installed in the hook policy); informational, never required by `launch` (amendment A2) | C1.3; P.R1 to P.R4 | none (programmable, §6.4) |

Masks: L1 bits `0x3FF` (1,023); L1 and L2 bits `0xFFF` (4,095). Every verifier and display tests `(checks & 4095) == 4095`, never `checks == 4095`: a version-4 certificate with rules holds 8,191. C1.3 accepts exactly 4,095, or 8,191 on a version-4 certificate whose `rules_hash` is not zero; any other value fails closed.

### 6.6 Informational checks (not part of a level)

A verifier SHOULD also report, without changing the level:

- the batch caps against the migration threshold (a total cap below a tenth of it, or a per-wallet cap that needs more than about 100 wallets to fill the batch, makes the fair open weak; `verifyLaunch` warns);
- whether the batch is still the pool's first trade (`has_swap == 0` while it is pending);
- after migration: the DAMM v2 pool's status (an operator can disable it) and its fee against the canonical migration config (operators can raise it; `verify/dammFees.ts`);
- the current upgrade authority and last deploy slot of DBC, DAMM v2 and Token-2022 (read in §7.2 step 2), against the values the verifier was reviewed with;
- the record's uri mode, and for `EXTERNAL_URI` that the linked content can change;
- the identity's used-leaf count (a creator identity has 1,024 leaves).

---

## 7. Verification algorithm

### 7.1 Inputs, outputs and reading rules

Input: a mint address `M`, one or more RPC endpoints. Output:

```text
QslResult {
  standard:   "QSL-1",
  mint:       M,
  slot:       the context slot of the reads (the last one; each read is no older than the one before),
  cluster:    "mainnet" | "devnet" | "other" | "unknown",   // from getGenesisHash; condition `cluster`
  level:      0 | 1 | 2,              // 0 = not QSL-1; a level only on mainnet-beta with finalized programs
  candidate:  bool,                   // §7.9: only `cluster` and/or an upgradeable program (C1.24) stand in the way
  wouldBe:    0 | 1 | 2,              // the level the mint would have on mainnet-beta with finalized programs
  programmable: {                     // §6.4: a description, never a level
    present:  bool, verified: bool,
    rules?:   { hash, address, bytes, explain: [string], verified },
    autopilot?: { address, graph, explain: [string], frozen, operator, freeze_not_after, pending, verified },
    checks:   [{ id: "P.R1" .. "P.R4" | "P.G1" .. "P.G5", status: "pass" | "fail" | "skip", ok, detail }],
    warnings: [{ kind, plain }]       // most serious first
  },
  graduated:  bool | null,            // C1.19; null when the pool cannot be read
  migrated:   bool | null,            // is_migrated != 0 (C1.19); null when the pool cannot be read
  checks:     [{ id: "cluster" | "C1.1" .. "C1.24" | "C2.1" .. "C2.8",
                 status: "pass" | "fail" | "warn" | "skip", ok: bool, detail }],
  reasons:    [string],               // why the next level is not reached
  blocking:   [id],                   // the conditions behind `reasons`
  info:       [{ id, status, detail }],           // §6.6
  trusted:    [party]                 // §8.2
}
```

`checks` lists every condition in that order. `ok` is true when the condition does not stand in the way of its level: for `pass`, for `warn` (a SHOULD that does not hold, §6.1 rule 5) and for a `skip` because the condition does not apply now (§6.1 rule 7). It is false for `fail` and for a `skip` because the run stopped before the condition. A verifier that does not implement §6.4 MUST still report `programmable.present` (the certificate's `rules_hash` is not zero, or the autopilot account runs a graph) and MUST then show "programmable, not checked: read its rules elsewhere" instead of nothing. The reference checker adds, per check, a short title and one plain-English sentence for displays, and the record's uri mode (`uriMode`) for Appendix A.2's external-link line.

Reading rules:

- A verifier MUST confirm that the RPC serves mainnet-beta (`getGenesisHash` equals `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`) and reports the result as the condition `cluster`. The Noised program ids are the same on devnet, so a devnet certificate is otherwise indistinguishable.
- A verifier SHOULD read at `finalized` commitment, and SHOULD read the accounts of each step with one `getMultipleAccounts` call (one slot). Where it combines several calls, it SHOULD pass `minContextSlot` so no read is older than an earlier one.
- For decisions of consequence, a verifier SHOULD repeat the reads against a second, independent RPC provider. A dishonest RPC can lie about every account.
- A verifier MUST NOT fetch any URL to decide a level.

### 7.2 Step 0: cluster and programs

1. Check the genesis hash (§7.1) and record `cluster`: `mainnet` (it passes), `devnet`, `other`, or `unknown` when the hash cannot be read (each of these fails). Do not stop if it fails: continue, so that `candidate` can be reported.
2. Read the program accounts of `LAUNCHPAD`, `HOOK`, `DBC`, `DAMM` and `T22` and their `ProgramData` accounts `PDA(LOADER; program)`. For `LAUNCHPAD` and `HOOK`, each program account MUST be executable, owned by `LOADER` and name that `ProgramData`; record whether each `ProgramData.upgrade_authority_address` is None (C1.24, decided once graduation is known, step 10). Do not stop if it is not: continue, so that `candidate` can be reported. For `DBC`, `DAMM` and `T22`, record the upgrade authority and last deploy slot for §6.6 and §8.2; they decide no level.

### 7.3 Step 1: certificate

3. Derive `CERT = PDA(LAUNCHPAD; "certificate", M)` and read `M`, `CERT`, `PDA(HOOK; "policy", M)` and `PDA(HOOK; "extra-account-metas", M)` together (with the accounts of step 2, in one call).
4. If `CERT` does not exist or is not owned by `LAUNCHPAD`: the mint is **not a QSL-1 token**. Stop with level 0. (Anyone can create a pool on a Noised DBC config, so a mint whose hook is `HOOK` is not evidence of anything; only the certificate is.)
5. Check C1.1 to C1.3. On failure, stop with level 0. A certificate of a version or length this document does not list fails here (§10.2 rule 4).

Stopping at step 4 or 5 gives level 0 and `candidate = false`. The result still reports `cluster` and C1.24; every other condition is `skip`, not checked (and not `ok`).

### 7.4 Step 2: mint

6. Parse `M` strictly (§5.8). Check C1.4 to C1.9. Keep the `TransferHook` and `TokenMetadata` values for later steps.

### 7.5 Step 3: launch, configuration, pool, hook

7. Read `cert.launch`, `cert.dbc_config`, `cert.pool`, `PDA(LAUNCHPAD; "attestation", cert.launch)`, `PDA(LAUNCHPAD; "identity", cert.pq_identity)` and `cert.metadata` together, with (for §7.8) `PDA(LAUNCHPAD; "rules", cert.launch, cert.rules_hash)` when `rules_hash` is not zero and `PDA(AUTOPILOT; "autopilot", cert.launch)`.
8. Check C1.17 and C1.18 (the Launch account and every derived address).
9. Check C1.11 to C1.16 (the DBC config) and C1.19 (the pool); determine **graduated** and **migrated** (C1.19). If the pool cannot be read, both are unknown: C1.19 fails, and the steps below treat the hook as active.
10. Check C1.10 against graduation: while not graduated the hook MUST be `HOOK` with authority `DBC_POOL_AUTHORITY`; once graduated both MUST be None. Decide C1.24: `LAUNCHPAD`, and `HOOK` unless graduated.
11. While not graduated, check C1.21 (policy) and C1.22 (account list). After graduation, check C1.21 as a SHOULD and report C1.22 as `skip` (does not apply).
12. Check C1.20 (fee routing).

### 7.6 Step 4: liquidity after migration

13. If the pool is migrated (`is_migrated != 0`): list the Token-2022 token accounts owned by the launch authority (`getTokenAccountsByOwner` with the `T22` program filter), keep those holding exactly 1 unit, derive `PDA(DAMM; "position", nft_mint)` for each, read the positions and then their pools, and check C1.23. If not migrated, report C1.23 as `skip` (does not apply).
14. If graduated but not migrated, record "graduation pending" (migration is permissionless).

Note (reference behaviour). The reference checker (`checkQsl1`, SDK 0.5.1) also runs step 13, and checks C1.23 as after migration, when `migration_progress == 3` (CreatedPool) although `is_migrated == 0`. DBC's migration sets both fields in one instruction (§6.2, notes on L1), so on every state DBC writes they agree and both readings give the same verdict. If a change to DBC ever made them differ, this is the safer reading: the LP position is required rather than C1.23 reported as not applicable. `migrated` in the result (§7.1) stays exactly `is_migrated != 0`.

### 7.7 Step 5: Level 2

15. **Level 1 verdict.** If every condition C1.1 to C1.23 is `ok`, `wouldBe >= 1`. (`cluster` and C1.24 do not enter `wouldBe`; they decide between a level and a candidate, §7.9.)
16. Check C2.1 (implied by C1.3), C2.2 (attestation fields against the certificate and the launch) and C2.3 (window).
17. Check C2.5: `SHA256(0x21 || public_key)` equals `cert.pq_identity` and the bit of the attestation's leaf is set.
18. Check C2.7: the record is at the address the attestation's hash names, and its content hashes to that hash (§7.7.3).
19. Rebuild the attestation message `m` (§7.7.4) and check `SHA256(m) == message_hash` (C2.4).
20. Verify the LMS signature (§7.7.5) and check the leaf it yields (C2.6).
21. Check C2.8: the mint's name, symbol and uri bytes equal the record's and the derived uri, with no additional metadata.
22. **Level 2 verdict.** If `wouldBe >= 1` and every C2 condition passed, `wouldBe >= 2`.

#### 7.7.1 Order

The order above is RECOMMENDED: cheap rejections first, the signature last. A verifier MUST NOT skip C2.4 because C2.6 passed: C2.4 binds the stored message hash to on-chain data, and both are required.

#### 7.7.2 `params_hash`

`params_hash = SHA256(borsh(LaunchParams))`, computed by `create_launch` on-chain from the parameters it validated (field order in `programs/noised-launchpad/src/state.rs`, never changed). A verifier does not need to recompute it for L2: the attestation binds `Launch.params_hash`, and the finalized launchpad binds that hash to the configuration it created. A verifier MAY recompute it from the `create_launch` instruction data (discriminator, `launch_seed`, then borsh `LaunchParams`) in the transaction that created the Launch account.

#### 7.7.3 Record hash and derived uri

```text
metadata_hash_v2 = SHA256( "PHX-META-V2"
                           || u32le(|name|)   || name
                           || u32le(|symbol|) || symbol
                           || u8(flags)
                           || u32le(|uri|)    || uri
                           || u32le(|doc|)    || doc )        lengths in bytes

derived uri = ""                                                   if flags == 0
            = "data:application/json;base64," || base64(doc)       if flags == 1   (RFC 4648, standard alphabet, padded)
            = uri                                                  if flags == 2
```

#### 7.7.4 Attestation message (version 3, 221 bytes; version 2, 189 bytes)

```text
m3 = "PHX-ATTEST-V3"           13 bytes, ASCII            (attestation version 3, certificate version 4)
    || LAUNCHPAD               32
    || launch address          32   (cert.launch)
    || launch.params_hash      32   (Launch 448..480)
    || launch.creator          32   (Launch 46..78)
    || metadata_hash           32   (Attestation 76..108)
    || rules_hash              32   (Attestation 108..140; all zero for none)
    || i64le(not_before)       8    (Attestation 180..188)
    || i64le(not_after)        8    (Attestation 188..196)

m2 = "PHX-ATTEST-V2"           13 bytes, ASCII            (attestation version 2, certificate version 3)
    || LAUNCHPAD || launch || params_hash || creator || metadata_hash     (as above)
    || i64le(not_before)       8    (Attestation 148..156)
    || i64le(not_after)        8    (Attestation 156..164)
```

Every input comes from account state; nothing is taken from the certificate except as a cross-check.

#### 7.7.5 LMS verification (RFC 8554, Algorithms 4b and 6a)

Parameters: `LMS_SHA256_M32_H10` (type 6) over `LMOTS_SHA256_N32_W4` (type 3): `n = 32`, `w = 4`, `p = 67`, `ls = 4`, `h = 10`. Public key 56 bytes, signature 2,508 bytes.

```text
LMS_Verify(pk, m, sig) -> leaf q, or INVALID:
  require |pk| == 56 and |sig| == 2,508
  require u32be(pk[0..4]) == 6 and u32be(pk[4..8]) == 3
  I  = pk[8..24];  T1 = pk[24..56]
  q  = u32be(sig[0..4]);            require q < 1,024
  require u32be(sig[4..8]) == 3
  C  = sig[8..40];  y[i] = sig[40 + 32i .. 72 + 32i] for i in 0..67
  require u32be(sig[2184..2188]) == 6
  path[k] = sig[2188 + 32k .. 2220 + 32k] for k in 0..10

  Q    = SHA256(I || u32be(q) || u16be(0x8181) || C || m)
  cksm = sum over i in 0..64 of (15 - coef(Q, i, 4));  V = Q || u16be(cksm << 4)
  for i in 0..67:
      a = coef(V, i, 4);  tmp = y[i]
      for j in a..15:  tmp = SHA256(I || u32be(q) || u16be(i) || u8(j) || tmp)
      z[i] = tmp
  Kc   = SHA256(I || u32be(q) || u16be(0x8080) || z[0] || ... || z[66])

  node = 1,024 + q
  tmp  = SHA256(I || u32be(node) || u16be(0x8282) || Kc)
  for k in 0..10:
      if node is odd:  tmp = SHA256(I || u32be(node / 2) || u16be(0x8383) || path[k] || tmp)
      else:            tmp = SHA256(I || u32be(node / 2) || u16be(0x8383) || tmp || path[k])
      node = node / 2
  return q if tmp == T1 else INVALID

coef(S, i, 4) = (S[i / 2] >> (4 - 4 * (i mod 2))) & 0xF
```

Verification uses public data only; constant-time comparison is not required for soundness. Implementations: `crates/noised-lmots` (`lms_verify`), `sdk/src/pq/lms.ts`, `scripts/pq/lms_reference.py` (independent, Python standard library). An implementation MUST reproduce RFC 8554 Appendix F Test Case 2 (top level) and the vectors of §11 before it is used.

### 7.8 Step 6: the programmable component (a description)

23. Read the components that exist (§6.4): the rules record when the certificate binds rules; when the autopilot account runs a graph, its graph record, the authorizations its `auth_marks` name and `AUTOPILOT`'s program data, in one more call. A component's existence alone means nothing: the autopilot account can be created by anyone, and only an active graph counts.
24. Check P.R1 to P.R4 and P.G1 to P.G5 for the components present, and compute the warnings (§6.4). Nothing here changes `wouldBe`.

### 7.9 Result

25. `wouldBe` is the highest level whose conditions, leaving out `cluster` and C1.24, are all `ok` (steps 15 and 22); 0 when one of C1.1 to C1.23 is not.
26. **A level.** If `wouldBe >= 1` and both `cluster` and C1.24 pass: `level = wouldBe`, `candidate = false`.
27. **A candidate.** If `wouldBe >= 1` and the level is withheld only because the RPC does not serve mainnet-beta (`cluster` fails: devnet, another cluster, or a genesis hash that could not be read), or because a program C1.24 covers still has an upgrade authority, or both: `level = 0`, `candidate = true`. "Candidate" thus covers programs that are not final yet and clusters that are not mainnet-beta. A C1.24 that fails because a program or its `ProgramData` is missing, not executable or malformed is not "not final yet": `level = 0`, `candidate = false`. A display MAY show "QSL-1 candidate: not final yet" under Appendix A.1's rules, with the reason (programs not final, not mainnet, or both).
28. Otherwise `level = 0` and `candidate = false`.
29. `reasons` (plain sentences) and `blocking` (their condition ids) say why the next level is not reached: at level 2, nothing; at level 1, the failed C2 conditions; for a candidate, the failed ones of `cluster` and C1.24; otherwise the failed ones of `cluster`, C1.1 to C1.23 and C1.24.
30. Attach `info` (§6.6), the trusted parties (§8.2) and `programmable` (step 24).

### 7.10 Cost and caching

- RPC: `getGenesisHash`, then two `getMultipleAccounts` calls: the first with the 4 accounts of step 3 and the 10 program and `ProgramData` accounts of step 2 (`LAUNCHPAD` and `HOOK` for C1.24; `DBC`, `DAMM` and `T22` for §6.6), the second with the 7 accounts of step 7 (8 with a rules record). After migration, one `getTokenAccountsByOwner` and two more `getMultipleAccounts` (the positions, then their pools). When the autopilot runs a graph, one more `getMultipleAccounts` (step 23: the graph record, `AUTOPILOT` and its `ProgramData`, at most two authorizations). Nothing else, and no `getProgramAccounts`.
- The programmable component's searches: the autopilot does not store the running graph's `activate_at` or a freeze's `not_after`, which the authorizations sign; a verifier tries each candidate second (one SHA-256 compression after a shared prefix) between the bounds the program allows (P.G3, P.G4), at most 691,200 of them (about one second), or takes the value from the `GraphQueued` event or the `freeze` instruction.
- Compute: one LMS verification makes 13 SHA-256 calls plus one per chain step, about 506 steps on average and at most 990 ([POST_QUANTUM.md](../POST_QUANTUM.md) §7). It measured 31 µs on a desktop CPU (Rust, release build, Ryzen 7 5800X; [LMS cost measurements](../evidence/2026-10-09-lms-cost-measurements.md), LMS stage). Other implementations were not measured.
- Caching: once a token reaches a level with finalized programs, the only on-chain facts that can still change are the expected ones (graduation flips C1.10, makes C1.21 a SHOULD, makes C1.22 not apply and takes `HOOK` out of C1.24; migration adds C1.23) and the trusted parties' code and settings. A verifier MAY cache a verdict and SHOULD re-run it when the pool graduates or migrates, and when DBC, DAMM v2 or Token-2022 is redeployed (a new last-deploy slot). The attestation, record and certificate never change once the launch is live.

---

## 8. Security considerations

### 8.1 What each level does and does not guarantee

Each guarantee holds only while the trusted parties of §8.2 behave as their current code does.

| Level | Guarantees | Does not guarantee |
|---|---|---|
| L1 | Supply can never grow. No holder can be frozen. Name, symbol and uri can never change. No hidden extension (fees, delegate, pause, close, confidential supply, rescaling). The only transfer hook is Launch Guard, only while the curve runs; its limits end at most 72 h after launch; a sale into the pool is never refused by it. Nobody can buy from the pool before the fair-open batch's single buy. No creator allocation, vesting or first-swap privilege. 100% of the graduated liquidity is permanently locked, and the position is held by a program address with no instruction to remove it. Fees go only to the treasury (at most 50%) and the 1 to 4 recipients fixed at creation; fees paid in the token are burned. On the curve, a trade costs at most 10% in fees once the schedule has ended. No Noised key can change any of this. | That the token has value or a market. That the people behind it are honest: the creator can buy in the batch with as much capital as anyone and sell at any time. That the per-wallet caps stop a determined buyer: they apply per account and many wallets get around them. That a sale succeeds: slippage, a completed curve awaiting migration, or a Meteora or Token-2022 upgrade can make it fail; L1 only says the hook will not refuse it. Fees after graduation: DAMM v2 operators can raise a pool's base fee to 10% and change its dynamic fee, or disable the pool (trading stops, the locked liquidity stays locked). That the name is unique: anyone can launch a token with the same name. |
| L2 | All of L1. The launch went live only because the identity named in its parameters signed this launch's program, address, parameters, creator, metadata record, launch rules (their hash; zero for none) and launch window; the signature is verified on-chain and re-verifiable by anyone, forever, from account state. The name, symbol, description and icon are an on-chain record whose hash the identity signed. A CRQC that recovers the creator's Ed25519 key cannot launch the configuration under other metadata, at another time, or launch anything the identity did not sign. | Who the identity is: it is a key, and anyone can create one; users learn which identity a project uses the way they learn any public key. That the token is quantum-safe: holders' wallets, the pools, wSOL and consensus remain classical. That the identity's secret was not stolen (phrase or passkey). Who opened the launch inside its window: anyone may, and the first transaction to land wins. The content behind an opt-in external uri. |
| Programmable (a description, not a level) | Nothing about safety beyond the level shown. What a verifier confirms: launch rules can only refuse transfers that are not sales, only during the guard period, never for moves through `VAULT` or `SHIELD`, and their bytes are the ones the identity signed; automation can only burn, buy back and burn, pay the graph's declared recipients and pay bounded keeper tips, changes need the identity's signature and wait 72 h, a freeze is used only until the `not_after` it was signed with, and a frozen graph never changes. | That the rules are fair: they can let only wallets the creator lists buy, or stop wallet-to-wallet transfers, for up to 72 h (the warnings of §6.4 say so). That automation runs: keepers must call it, for a tip. Best execution of buy-backs: a keeper can sandwich a buy-back by at most the configured premium times the per-run cap. That an operator (for example an AI agent) acts well: it acts only within on-chain bounds. That a graph that is not frozen stays as it is: the creator can replace it 72 h after approving another. |

### 8.2 Trusted parties

QSL-1 removes Noised's own keys (after finalization) and cannot remove these. Values as recorded on 2026-10-08 ([SECURITY_GUARANTEES.md](../SECURITY_GUARANTEES.md), "Who you still trust"); verifiers SHOULD read the live values.

| Party | Can | QSL-1 consequence |
|---|---|---|
| Solana consensus and feature gates | Decide what is final; change the runtime and core programs (a feature gate disabled the ZK ElGamal proof program from 2025-06-19 to 2026-06-04). Validator keys are Ed25519. | A chain-level failure defeats every level. |
| Token-2022 upgrade authority (Squads v3 multisig, 4-of-6 with the threshold read at medium confidence, `BnD53519LK7QM4ERBGvLedZDe1VoTPgtiBkGPWAACiMZ`) | Replace Token-2022. | Could change any mint rule L1 relies on, for every QSL-1 token at once. |
| The ATA program | Create the canonical accounts claims and fee payouts go to. | Classical code under feature gates. |
| Meteora upgrade authority for DBC and DAMM v2 (Squads v3 multisig, 4-of-7, no timelock, `CoEsykatDegLB7pcMJia79JSriDdi71nPnjgeSfw623k`) | Replace DBC and DAMM v2 at any time. | Could change the curve, the migration, the LP lock and the hook revocation; the launchpad hard-codes DBC 0.2.1 layouts and could stop working after a layout change. |
| DAMM v2 admins and operators (single keys) | Disable pools, raise base fees to 10%, change dynamic fees, close migration configs. | Trading can stop or get expensive after graduation; locked liquidity stays locked. |
| DBC operators | In 0.2.1, manage badges and claim protocol fees. A draft DBC change (PR #214, not deployed) would let one operator revoke a pool's hook before graduation. | If deployed: the snipe shield and guard limits could end early; the batch would then refund. |
| Noised upgrade authority, until finalization | Replace any Noised program. | Why C1.24 is required for `LAUNCHPAD`, and for `HOOK` until graduation. `VAULT` and `SHIELD` are not part of a token's level (§6.2, notes). |
| Block producers and ordering gateways | Reorder, delay or drop transactions; not change signed content. | Who lands first in a launch window or the commit window. |
| RPC providers, front ends, wallets | Show false data; ask users to sign harmful transactions. | Why §7.1 asks for a genesis check and a second RPC. |
| SHA-256 | Collision and preimage resistance. | L2's signature, every content address and every PDA rest on it. |

### 8.3 Quantum adversary model

Assume an adversary with a CRQC that recovers any Ed25519 private key from its public key, and Grover's algorithm against hash functions (a square-root speed-up). Under that model ([POST_QUANTUM.md](../POST_QUANTUM.md) §2):

- **What QSL-1 protects (L2).** Whether a launch goes live, with which parameters, which metadata and in which window: these need an LMS signature, whose forgery needs a SHA-256 preimage-type search (about 2^128 quantum work for the parameter set used). Each leaf signs once: the identity's bitmap is on-chain, every valid signature lands and burns its leaf, and clients keep a durable record of revealed leaves. The identity's secret comes from a dedicated phrase or a passkey PRF output, never from a wallet signature. The certificate, record and attestation addresses are PDAs: there is no private key behind them to recover, provided the programs are finalized (C1.24).
- **What QSL-1 cannot protect.** Holders' wallets (every Solana address is an Ed25519 key), the pools, wSOL, the creator's `create_launch` signature (a CRQC can create launches naming any identity; they never go live without its signature), the Token-2022 and Meteora multisigs (Ed25519 members), validator keys, and Shield's ElGamal encryption (§9).
- **Honest summary.** L2 is post-quantum **launch authorization and metadata integrity** inside a chain that is not post-quantum. No QSL-1 token is "quantum-proof". Tokens held in Noised PQ vaults are in post-quantum custody; that is a property of the holding, not of the token.

LMS (with LM-OTS as its one-time component) is approved by NIST SP 800-208 as a stateful hash-based signature scheme for specific uses, with keys generated and used in hardware modules. Noised identities are software keys derived from a phrase or a passkey; QSL-1 claims neither SP 800-208 approval nor validation for them.

### 8.4 Residual risks from the audits

From [AUDIT.md](../AUDIT.md) §6 and §14 and [THREAT_MODEL.md](../THREAT_MODEL.md) §6. None of them is removed by QSL-1; verifiers and displays SHOULD NOT imply otherwise.

1. **First to land wins inside a window.** Anyone may open an attested launch inside its window and commit at once. The batch is pro rata, so landing first gives no price advantage (R21).
2. **Write-lock contention.** A party that pays more priority per compute unit can fill a writable account's 24,000,000 CU per-block budget and keep commits, `execute_batch` or `launch` out while it pays. Windows of at least 60 s (commit) and 600 s (execution) make that cost linear in time; they do not remove it (R7, R23).
3. **A missed launch window.** If an attested window passes unused, the creator signs a new window, which replaces the expired attestation while the launch is `Configured`; an attestation needs 60 s of its window left when it lands (audit round 3, F1; before it, such a launch could never go live: R3-1, R28). No user funds exist before `launch`. Once a window has passed, an older signature of the identity that never landed can take the freed slot if its own window still has a minute left, delaying the launch to a window the creator signed earlier (R32).
4. **Relayers delay but cannot change.** Whoever holds an attestation, a commit or a vault withdrawal can land it or hold it back (R22).
5. **Caps are per account.** Max-wallet and max-buy apply per token account and per transfer; Sybil wallets get around them (R8).
6. **The wallet-to-wallet lock stops transfers, not changes of control.** Guarded transfers that are not sales land only in accounts with `ImmutableOwner` (§4.4), so a token account cannot be reassigned during the guard (audit round 3, F2; R3-4). Control can still change without any transfer, invisible to any hook: a wallet several people control (a multisig, a smart wallet, a shared key), a PDA or smart-wallet owner, a PQ vault whose key is rotated to another party's key, and a delegate approval (R30).
7. **Shared accounts share one max-wallet.** During the guard, anyone holding about max-wallet tokens can fill the Shield escrow of a mint or top up someone's canonical account, blocking wraps or that account's buys and vault payouts until the guard ends; griefing only, at most 72 h (R3-5, R31).
8. **A PQ vault's batch quota can be used up by others' commits** naming it; the tokens bought go to the vault, and the other committer's unspent wSOL goes to its own refund owner (R3-2, R29).
9. **Burn-only landings spend leaves.** A valid signature that cannot attest (record missing, window invalid, already attested, another identity) still burns one of the identity's 1,024 leaves (AUDIT §6 item 11).
10. **Two devices, two ledgers.** Two devices with unsynchronized leaf ledgers can sign two messages at one leaf (about 1 in 1,024 per pair of messages), which enables forgeries for that identity (R24).
11. **Claims follow a reassigned SPL Token ATA.** A committer that is its own refund owner and reassigned (or was phished into reassigning) its wSOL ATA gets its refund wherever that ATA now points (AUDIT §6 item 1).
12. **Launch Guard relies on DBC's behaviour.** The hook sees a buy only as the Token-2022 transfer DBC makes for it; a DBC release that skipped it for a zero output, or accepted the base vault as a buy's output, would let such a buy run unseen. The batch would then refund in full (R16).
13. **The hook's account list can never change in place.** An in-place hook upgrade with a different `Execute` account list would make every transfer fail, sales included. Finalization (C1.24) removes this risk.
14. **No independent audit yet** (AUDIT §7).
15. **Creator rules can favour insiders.** Bound and signed rules can refuse every buy except into wallets the creator lists, or refuse wallet-to-wallet transfers, for up to 72 h (never a sale). That is why programmable is not a level and its warnings are required (§6.4).
16. **Routing through `VAULT` or `SHIELD` skips the creator's rules** (review 4, R1): a transfer whose current top-level instruction is the vault's or the shield's escapes anti-bot rules too; every built-in check (snipe shield, p2p lock, caps, `MutableOwner`) still applies. A call into either made by another program's CPI has that program as its top-level instruction, so the rules apply to it.
17. **A freeze approval can be withheld until its `not_after`** (review 4, R5): whoever holds a landed freeze authorization can use it or not, but only until the `not_after` it was signed with (the SDK signs one hour ahead by default).

### 8.5 Verifier pitfalls

- A verifier MUST NOT treat the presence of `HOOK` as a mint's transfer hook as evidence of QSL-1: pools on a Noised DBC config can be created by anyone and get no certificate.
- A verifier MUST resolve the record only through `Certificate.metadata` (after launch) or `Attestation.metadata_hash` (before). Searching a launch's records with `getProgramAccounts` returns records anyone can publish (R26).
- A verifier MUST check the cluster (§7.1, condition `cluster`). The same addresses exist on devnet.
- A verifier MUST NOT show a level for a zToken (a Shield mint): it is a different mint with `ConfidentialTransferMint` and is not QSL-1 (§9).
- A verifier MUST compare raw bytes of name, symbol and uri, not decoded or normalized text (a decoder may drop a byte-order mark or replace bytes).
- A verifier SHOULD treat the record's `doc` as untrusted input: size-bounded, parsed defensively, images accepted only as inline PNG (the SDK accepts `data:image/png;base64`, at most 64x64), links shown as text and never fetched.
- A level says nothing about which token a user meant to buy. Displays MUST show the mint address next to the badge and MUST NOT let a badge stand in for the name.

---

## 9. Privacy considerations

- **A QSL-1 token is fully public.** Balances, transfers, the certificate, the attestation, the creator's wallet (`Certificate.creator`) and the launch timeline are on-chain. QSL-1 adds no privacy.
- **Identities link launches.** One identity signing several launches links them publicly; that is the point of an identity. A creator who does not want launches linked uses separate identity indices (the SDK derives many identities from one phrase). The identity is not linked to the creator's wallet by any key relation; it is linked by appearing in the same launch.
- **Shield (opt-in) is a separate layer.** `SHIELD` wraps any supported token 1:1 into a zToken, a Token-2022 mint with Confidential Balances, at `PDA(SHIELD; "z-mint", base_mint)`; `unwrap` returns the base token. A zToken hides balances and transfer amounts, not who transacts with whom; wrap and unwrap amounts and timing are public and can be correlated; its ElGamal encryption is not post-quantum, so recorded ciphertexts could be decrypted later ([PRIVACY.md](../PRIVACY.md)). A zToken is not QSL-1 (§8.5). A display MAY show it as "shielded form of" its base token after checking `PDA(SHIELD; "shield", base_mint)` and that the zToken mint is `PDA(SHIELD; "z-mint", base_mint)`.
- **During the guard**, all Shield deposits of a launch token share the escrow's one max-wallet (§8.4 item 7).
- **Verifiers.** Running the algorithm reveals to the RPC provider which mint the user looks at. QSL-1 verification fetches no URL, so it reveals nothing to metadata hosts.

---

## 10. Versioning and extension rules

### 10.1 What carries a version

| Identifier | Current value | Changes when |
|---|---|---|
| Standard name | `QSL-1` | A change that breaks a level's meaning or the certificate's existing fields (§10.3). |
| `Certificate.version` | 4 (3 for launches before programmable launches) | Fields are appended (version 4 appended `rules_hash`). Verifiers fail closed on a version this document does not list (§10.2 rule 4). |
| `Certificate.policy_version` (`SAFETY_POLICY_VERSION`) | 3 | The launchpad's safety policy changes. |
| `Attestation.version`, message tag | 3, `PHX-ATTEST-V3` (221 bytes, with `rules_hash`); 2, `PHX-ATTEST-V2` (189 bytes) with certificate version 3 | The signed message changes. |
| Hook policy version | 2 (rules appended); 1 with certificate version 3 | Fields are appended. |
| Record hash tag | `PHX-META-V2` | The record's content changes. |
| Programmable tags | `PXR1`, `PXG1`, `PHX-RULES-V1`, `PHX-GRAPH-V1`, `PHX-AUTH-V1`, `PHX-GRAPH-ACT-V1`, `PHX-GRAPH-FRZ-V2` (with `not_after`; review 4 replaced `PHX-GRAPH-FRZ-V1`), `PHX-OP-REVOKE-V3` (binds the running activation `active_auth`; audit round 4 replaced `PHX-OP-REVOKE-V2`) | A format changes (a new magic, never a reinterpretation of an old one). |

### 10.2 Rules within QSL-1

1. Levels are monotone: a new level MUST imply every lower level. A property that can make a token worse for holders (as launch rules can) is never a level.
2. A check bit MUST NOT be reused with another meaning. New bits are appended.
3. A new certificate version MUST be append-only: every field of the previous version keeps its offset and meaning.
4. **Unknown versions fail closed.** A verifier evaluates only the certificate versions this document lists for a level, at the lengths it gives (revision 0.4: version 3, 487 bytes, and version 4, 519 bytes; `policy_version` 3; `(checks & 4095) == 4095` with no other bit than `RULES_BOUND` on a version-4 certificate whose `rules_hash` is not zero). It MUST treat any other certificate, a higher version included, as of an unknown version: C1.1 (length) or C1.2 (version, policy version) fails, the run stops at §7.3 step 5, and the result is level 0 and not a candidate, whatever the certificate's known fields say. Rule 3 keeps old fields at their offsets, but a newer version can add conditions an older verifier cannot check (version 4 binds launch rules into the attestation), so a verdict built from the known fields alone could vouch for less than the certificate holds. A verifier SHOULD say that the certificate's version is newer than it knows and that an updated verifier is needed, rather than that the token has no certificate. Revision 0.4 lists version 4 (`rules_hash` at 487, `RULES_BOUND` = 4096 as an informational bit, §5.1, §6.5) for both levels.
5. A verifier that meets a certificate version, message tag or record tag lower than this document lists (none exist on mainnet) MUST NOT award a level from it.
6. Every domain-separation tag is unique; a new message or hash gets a new tag.

### 10.3 QSL-2 and later

A new major version is needed when a change would break rule 2 or 3, change what an existing level means, add a certifier program, or change the trust model (for example a native signature-verification syscall, see [SIMD-DRAFT-hash-based-signatures.md](SIMD-DRAFT-hash-based-signatures.md)). Candidate topics: post-quantum custody as a token property; a registry of certifier programs other than `LAUNCHPAD`; additional pool programs; HSS or SLH-DSA identities if a native verifier exists.

### 10.4 New programs, errata and revocation

The Noised programs become immutable at finalization, so a fix is a new program at a new id. A new certifier, hook or autopilot program becomes part of QSL-1 only through a revision of this document that lists its id. If a vulnerability is found in a listed program, a revision of this document MAY mark tokens certified by it, or by a range of its certificate or policy versions, as no longer conformant; verifiers SHOULD follow the latest revision. Errata are numbered and dated in Appendix C.

---

## 11. Test vectors

### 11.1 Files

| File | Contents | Checked by |
|---|---|---|
| `tests/integration/vectors/metadata.json` | 9 records with their `metadata_hash_v2`, record PDAs, account bytes and derived uris; 19 invalid records with their errors; a typical record's attestation message, message hash, public key and signature; certificate constants (length 487, all checks 4095, `metadata` at 455) | `tests/integration/tests/metadata_vectors.rs`, `vectors_onchain.rs`; `python -I scripts/pq/lms_reference.py metadata-vectors tests/integration/vectors/metadata.json` |
| `tests/integration/vectors/lms.json` | identity derivation, LMS keys and signatures, the attestation message, account layouts and offsets, 9 burn-only cases, 20 rejection cases, leaf probe, window rules, error numbers | `tests/integration/tests/lms_vectors.rs`; `lms_reference.py` |
| `crates/noised-lmots/tests/rfc8554_appendix_f.json` | RFC 8554 Appendix F, all levels | `crates/noised-lmots/tests/lms.rs` |
| `tests/integration/vectors/vault_withdraw.json` | PQ vault vectors (not part of a level) | `tests/integration/tests/sdk_vectors.rs` |
| `tests/integration/vectors/programmable.json` | the launch of a programmable launch: two LaunchRules records ("typical", 286 bytes; "largest", 1,228 bytes) with their hashes and PDAs; the attestation v3 binding the typical rules (message v3, leaf 534); the three Authorizations (kinds 1, 2, 3) with their payloads (freeze payload v2, `freezeNotAfter` 1,767,229,200), messages, signatures and accounts; certificate, policy and authorization offsets | `tests/integration/tests/programmable_vectors.rs`; `sdk/test/qslProgrammable.test.ts`, `sdk/test/authorize.test.ts` |
| `crates/noised-rules/tests/vectors/` | PXR1 and PXG1 vectors (valid and invalid rule sets and graphs, evaluations) | `crates/noised-rules`; `sdk/test/programmable/` |

### 11.2 Worked example

**Record hash** (`metadata.json`, `cases[0]`): name `Phalanx Cryo Token` (18 bytes), symbol `PHXCR` (5 bytes), flags 0, empty uri and doc.

```text
input  = "PHX-META-V2"
         || 12000000 || 5068616c616e78204372796f20546f6b656e      u32le(18) || "Phalanx Cryo Token"
         || 05000000 || 5048584352                                u32le(5)  || "PHXCR"
         || 00                                                    flags
         || 00000000                                              u32le(0)  || uri
         || 00000000                                              u32le(0)  || doc
SHA256 = 5df054afab0520c59bfe7360f870022fd3a454cb206bbfbca553943cd1110153
derived uri = ""        (flags 0)
```

**Attestation message** (`metadata.json`, `attestation`; the typical record with a description and a 32x32 icon, no uri):

```text
5048582d4154544553542d5632                                         "PHX-ATTEST-V2"
ad538dc6d3b00e1e4805f97ebc4fdfe3c12d086e6a46e3edb973ca5d347f696d   LAUNCHPAD   (CfbRms...AbNgc)
b560c219f6e32bde6013739aa68647d5712dc56790ef4292a66d6508c485dbda   launch      (DD2NGj...1ruRK)
866862f10727eeaaf4e26212283929b2ef643f5ef5f8e70e1bfb657b94fa7811   params_hash
b34953ee8dd44b08c0b4c73d4050d7694d9b0f331ea03deb13e9542088c8c9f0   creator     (D4rq7C...P9Hks)
96253c2820a8bc2a06044224852bb91189083642a9ffeefd48780418dada2910   metadata_hash
00b9556900000000                                                   not_before = 1,767,225,600
10c7556900000000                                                   not_after  = 1,767,229,200 (3,600 s later)

SHA256(m) = 530614f8518c0a8ef4696b4b4a28a874f008e495b39edd53e823bcf2bba497ee   (= message_hash)
```

**Identity and signature.** Public key `0000000600000003c6553c83e1273eb1816ce832d0b700e8ca1d0ac1e2a6cf35812572e4e84b077bc420a18d27f8badfb4b856687daae587` (a localnet test identity); `SHA256(0x21 || pk) = bc0127aba7c34b308ec1790388faa7cf2b58cc3ce2ed3e4b8875678b69096942`. The 2,508-byte signature in the file verifies with §7.7.5 at leaf `q = 108` (525 chain steps). Flipping one bit of `m` makes it invalid. The record is at `6TtUBEv2qYb6K9YvPArVEws9QUycYcxCNh3J4jdV4nPR` = `PDA(LAUNCHPAD; "metadata", launch, metadata_hash)`.

**Certificate bits.** `checks` bytes 187..191 `ff 0f 00 00` = 4,095: L1 bits `0x3FF` and L2 bits `0xC00` set (a version-3 certificate, or a version-4 one without rules). A version-4 certificate with rules holds `ff 1f 00 00` = 8,191 (`RULES_BOUND` added) and its `rules_hash` at 487..519; C1.3 tests `(checks & 4095) == 4095`.

**Attestation message v3** (`programmable.json`, `attestation`; the launch binds the "typical" rules):

```text
5048582d4154544553542d5633                                         "PHX-ATTEST-V3"
ad538dc6d3b00e1e4805f97ebc4fdfe3c12d086e6a46e3edb973ca5d347f696d   LAUNCHPAD   (CfbRms...AbNgc)
580d1524be15be006be97ba0ed8f178c4a8d316b4886bdeece66358ea669314f   launch      (6viSy7...A8T7c)
208f6d94ffc74b0ad0e7c99ab54565557721fa510f74dd1b3aad6113d08946d4   params_hash
81f30f0b5500dba41aaf5ba986a822564fa0bf7ec260383c1a4ba944e9552fd2   creator     (9kGZDR...4DdSh)
2fc3d366c582d965a18ed6df511810615b6fcf07d610999496043e6f4c96b91a   metadata_hash
6360d4aef07dc437364332eb693b64b40abcaa54df50fa0de8c2b456344f6162   rules_hash  (typical, 286 bytes; record FdxCNH...S5E4e)
00b9556900000000                                                   not_before = 1,767,225,600
10c7556900000000                                                   not_after  = 1,767,229,200

SHA256(m3) = 892253ec54bf717a87c81e86439f35db9d0afee1d215dc80b8f5453df0071ed8   (= message_hash, attestation 140..172)
```

The signature in the file verifies at leaf 534. Explained for the launch's one-hour guard, these rules read, among others: "During the launch guard (the first hour): a transfer can't leave the receiving account with more than 1% of the supply." A verifier warns, for this launch (snipe shield 900 s): "For the first hour, some wallet-to-wallet transfers are limited (rule 3).", "From 30 minutes to 1 hour after launch, some wallet-to-wallet transfers are limited (rule 5).", and "Rule 1 can never block anything, so it does nothing." (its two-minute anti-bot rule lies inside the snipe shield, when only the batch buys).

**Freeze payload v2** (`programmable.json`, `authorizations`): `SHA256("PHX-GRAPH-FRZ-V2" || autopilot 477gRr...rTncw || graph_hash 91a3427a...3c3d8369 || i64le(1,767,229,200))` = `fde6ddcd67031df461056da3d0e85cf315aa2d2abd64a25771e98593d9788368`, the kind-2 authorization's `payload_hash` (leaf 477, at `Gf5rPyh6ZA4x4Ne95NbuQcVCEegi2zjq9Hx1FjQxtYQi`).

### 11.3 Not yet available

Whole-verdict vectors (the bytes of every account of a certified launch before graduation, after graduation and after migration, with the expected `QslResult`, and negative cases for each condition) do not exist yet. The LiteSVM suites produce such accounts, and the reference checker's tests build them from the Rust vectors (`sdk/test/qslFixtures.ts`: before and after graduation and after migration, and a failing case for every condition that can fail on its own); publishing them as `tests/integration/vectors/qsl.json` is REQUIRED before this standard leaves draft.

---

## 12. Reference implementations

| Role | Where | Notes |
|---|---|---|
| Certifier | `programs/noised-launchpad`: `instructions/launch.rs` (writes the certificate), `checks.rs` (every post-condition), `policy.rs` (safety policy), `pq.rs` (message, record hash, window), `instructions/attest_launch.rs` | Anchor 1.2.1, SBPF v3 |
| Transfer hook | `programs/noised-hook`: `lib.rs`, `rules.rs` | |
| LMS | `crates/noised-lmots` (`no_std`; RFC 8554 known answers) | |
| Verifier (TypeScript, reference) | `sdk/src/qsl/` (`checkQsl1`, `evaluateQsl1`, `qslBadge`; SDK 0.8, unreleased), tests `sdk/test/qsl.test.ts`, `sdk/test/qslProgrammable.test.ts`; the rules' warnings `ruleWarnings` (`sdk/src/programmable/rules/warnings.ts`) | Implements §7 and Appendix A for L1 and L2, condition by condition (`cluster`, C1.1 to C1.24, C2.1 to C2.8), with the readings of revision 0.4 (certificate versions 3 and 4), and the programmable component of §6.4 (P.R1 to P.R4, P.G1 to P.G5, the warnings, the "programmable" tag). It reads the accounts at §5's offsets, and its tests check those offsets against the programs' IDLs and the Rust vectors' accounts. Mutation testing forced each of the 33 conditions to pass: 32 were caught by the tests; C2.1 survives because it is equivalent (it cannot fail once C1.3 passes, §6.3), and removing C2.1 is caught. SDK 0.5.1 closed the two display differences of 0.5.0 (neither could award a level): `qslBadge` keeps a candidate off trade screens when the cluster is `unknown` (Appendix A.1), and names a certificate of an unknown version, a longer one included, instead of saying the token was not launched with Noised's protections (§10.2 rule 4). It also checks C1.23 by the stricter reading noted in §7.6. |
| Verifier (TypeScript, report) | `sdk/src/verify/verifyLaunch.ts`, `sdk/src/verify/pqOrigin.ts` | The SDK's older report of the same facts: pass, warn or fail rather than a level, and upgradeable programs as a warning where this standard withholds every level (C1.24). A small Rust verification crate is planned and not yet in the repository. |
| Independent LMS and vector check | `scripts/pq/lms_reference.py` | Python standard library only |
| Command line | below | |

A partial check with the Solana CLI ([SECURITY_GUARANTEES.md](../SECURITY_GUARANTEES.md), "Verify it yourself"):

```bash
spl-token display <MINT> --url mainnet-beta
#   no mint authority, no freeze authority; extensions MetadataPointer + TokenMetadata + TransferHook;
#   metadata update authority none; hook program cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia (authority
#   FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM) before graduation, none after
solana find-program-derived-address CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc string:certificate pubkey:<MINT>
solana account <CERTIFICATE> --url mainnet-beta --output json
#   owner CfbRms...; bytes 187..191 = ff 0f 00 00; bytes 455..487 name the record
solana program show CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc --url mainnet-beta   # Authority: none
solana program show cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia --url mainnet-beta   # Authority: none
```

The CLI does not re-verify the LMS signature or the DBC configuration; use a full verifier for L2.

---

## 13. References

- RFC 2119, RFC 8174: requirement levels.
- RFC 8554: Leighton-Micali Hash-Based Signatures.
- NIST SP 800-208: Recommendation for Stateful Hash-Based Signature Schemes.
- FIPS 180-4: SHA-256. RFC 4648: base64.
- Token-2022 (SPL): mint extensions, `TransferHook` interface, `TokenMetadata` interface.
- Meteora DBC 0.2.1 and DAMM v2 IDLs: `idls/dynamic_bonding_curve.json`, `idls/cp_amm.json`.
- SIMD-0385: transaction format v1 (4,096 bytes), used by `attest_launch` and `publish_metadata`.
- EIP-4626: Tokenized Vault Standard (the layering analogy of §2.3).
- Noised: [SPEC.md](../SPEC.md), [SECURITY_GUARANTEES.md](../SECURITY_GUARANTEES.md), [THREAT_MODEL.md](../THREAT_MODEL.md), [POST_QUANTUM.md](../POST_QUANTUM.md), [PRIVACY.md](../PRIVACY.md), [HOOKS.md](../HOOKS.md), [AUDIT.md](../AUDIT.md).

---

## Appendix A. Badges and wording for apps

This appendix is normative for apps that show a QSL level. Its purpose is that users read only true things, in plain words.

### A.1 When to show a badge

- Show a level badge only for a `QslResult` computed by a verifier that follows §7, on mainnet-beta (`cluster` passed), with `level >= 1`.
- Show the mint address with the badge. Never let the badge replace the token's name or address.
- Make the badge open the full report: every check, and the "who you still trust" list (§8.2).
- If the result is older than the last graduation, migration or Meteora/Token-2022 redeploy you know of, re-check before showing it on a trade screen.
- `candidate` (programs not finalized, or not mainnet-beta): show nothing on mainnet trade screens. On a cluster known not to be mainnet-beta (`devnet`, `other`) or in developer views you MAY show "QSL-1 candidate: not final yet", with why. When the cluster is `unknown`, the RPC may still be mainnet: do not show a candidate on a trade screen.
- Failed or unknown: show "Not QSL-1" or nothing. Never show a partial badge for a failed level.

### A.2 What each level may say

| Level | Badge | One-line description | You may also say | Required nearby |
|---|---|---|---|---|
| L1 | **QSL-1 · No-rug** | "Nobody can mint more, freeze your tokens, change its name or pull its liquidity." | "Selling is never blocked by the launch guard." "Launch limits end within 72 hours." "Fees go only to the wallets listed at launch." "No team allocation." "All liquidity is locked forever once it graduates." | "This is not advice about price. Meteora and Token-2022 can still be upgraded by their own teams." |
| L2 | **QSL-1 · Quantum-attested** | "Launched with its creator's quantum-resistant signature, checked just now." | Everything for L1. "Name, symbol, description and icon are stored on-chain and signed." "No one could have launched it with different details or at a different time." | As for L1, and: "The token itself sits in normal wallets, which are not quantum-resistant." |

With an external metadata link (flags 2), add: "Its icon link was chosen by the creator; what it shows can change."

**The "programmable" tag.** When `programmable.present`, show next to the level badge, in the same size or smaller and never in a level's colour: "QSL-1 L2 · programmable" (or "QSL-1 L1 · programmable"; next to a candidate or "Not QSL-1", "programmable"), with a link "read its rules" that opens the rules and automation in plain words (`explain`) and the component checks. Directly under the badge's one-line description, show one sentence and then every warning of §6.4, most serious first:

- rules: "Its creator added launch rules that limit some transfers for a while. They are not a safety feature: read its rules."
- automation: "Its creator set up automation that runs on its treasury. It is not a safety feature: read its rules."
- both: "Its creator added launch rules and automation. They are not a safety feature: read its rules."

The tag never changes the badge, its name, its one-line description or its colour, and a display MUST NOT shorten it to "L3", "programmable level" or anything that ranks it.

### A.3 What no app may say

- "Quantum-proof", "quantum-safe token", "unhackable", "can't lose value", "safe investment", "risk-free".
- "Verified project", "verified team", "official", "trusted creator": an identity is a key, not a person.
- "Audited", unless an independent audit of the listed programs has been published, and then only with a link to it.
- "Private" or "anonymous" for a QSL-1 token; for a zToken, only "hides balances and amounts, not who you trade with".
- Any level for a zToken, a mint without a certificate, a certificate of a version the verifier does not know, a mint on another cluster, or a result computed only from the certificate's flags.
- "Level 3", "L3", "programmable level", "safer", "extra protection" or anything else that presents launch rules or automation as a safety level; or the programmable tag without its warnings.

### A.4 Tone

Plain words, short sentences, no jargon on the badge or its one-line description. Technical names (LMS, PDA, Token-2022) belong in the full report, not in the badge.

---

## Appendix B. Identifiers

| Kind | Value |
|---|---|
| Seeds (`LAUNCHPAD`) | `certificate`, `launch`, `authority`, `batch`, `dbc-config`, `attestation`, `identity`, `metadata`, `hook-authority`, `protocol`, `commit`, `payout-vault`, `rules`, `auth` |
| Seeds (`HOOK`) | `policy`, `extra-account-metas` |
| Seeds (`DBC`, `DAMM`) | `pool`, `token_vault`; `pool`, `position`, `position_nft_account` |
| Seeds (`SHIELD`) | `shield`, `shield-authority`, `z-mint` |
| Seeds (`AUTOPILOT`) | `autopilot`, `graph`, `treasury` |
| Account discriminators | Certificate `cae5dedc74144a43`, Launch `903333a3ce55d526`, Attestation `987db75624927949`, Identity `3a84050cb0a45570`, TokenMeta `8257ae23152c5c13`, HookPolicy `6772f6550f16bec3`, LaunchRules `ee49471de730278d`, Authorization `0344a8f3c3a8204b`, Autopilot `71c3e5399efa3186`, GraphRecord `765f5c156716b378` |
| Instruction discriminators | `launch` `99f15de116454a3d`, `attest_launch` `b518c935f67efd4f`, `publish_metadata` `b3bfa861c719e592` |
| Domain tags | `PHX-ATTEST-V3` (`PHX-ATTEST-V2` with certificate version 3), `PHX-META-V2`, `PHX-RULES-V1`, `PHX-GRAPH-V1`, `PHX-AUTH-V1`, `PHX-GRAPH-ACT-V1`, `PHX-GRAPH-FRZ-V2`, `PHX-OP-REVOKE-V3`; identity id prefix byte `0x21` (vault key ids use `0x20`) |
| Token-2022 extension types | `TransferHook` 14, `MetadataPointer` 18, `TokenMetadata` 19, `ImmutableOwner` 7 (token accounts) |
| Bounds | guard at most 259,200 s; snipe shield at most 3,600 s (hook) and `open_delay_secs + 600` (launchpad, at most 2,400 s); launch window 60..=3,600 s, opening at most 604,800 s after the attestation lands and with at least 60 s of it left then; trading fee ceiling 1,000 bps; platform share at most 5,000 bps; 1 to 4 fee recipients; name 1..=32 bytes, symbol 1..=10, external uri at most 200, document at most 3,072, inline uri at most 4,125 |
| Hook errors | 6000 `SnipeShield`, 6001 `TransfersLocked`, 6002 `MaxBuy`, 6003 `MaxWallet`, ..., 6009 `NotInBatch`, 6010 `MutableOwner`, 6011 `RuleDenied`, 6012 `InvalidRules` |
| Autopilot errors (programmable) | 6000 to 6040; 6040 `FreezeExpired` (a freeze used after its `not_after`) |
| Authorization kinds | 1 activate a graph, 2 freeze it, 3 remove its operator; `pq_authorize` writes no Authorization for any other kind (a valid signature of one only burns its leaf) |

## Appendix C. Pending items and errata

| Item | Effect on this document when it lands |
|---|---|
| Programmable launches | Done in revision 0.4 (§5, §6.4, C1.1 to C1.3, C1.21, C2.2 to C2.6, §10.2), as a described component rather than a level. |
| Finalization of the programs on mainnet | C1.24 becomes satisfiable; the first tokens can be QSL-1. |
| Whole-verdict vectors | §11.3. |

Revisions:

| Revision | Change |
|---|---|
| 0.1 (2026-10-10) | First draft, written before audit round 3's F1 and F2 were merged. |
| 0.2 (2026-10-10) | Updated for the merged F1 and F2 (§5.3, §8.4 and Appendix B describe the merged programs); §4.4 states the immutable-owner rule, its exempt accounts and its position; §5.3 adds that an attestation read before launch is not cached; §8.4 adds the older-signature residual and the changes of control the lock cannot see. No condition of §6 and no verification step of §7 changed. |
| 0.3 (2026-10-10) | Ambiguities found while writing the reference checker (`checkQsl1`, SDK 0.5) settled, each with the safer reading; for every condition and verdict that is the checker's reading, so the two agree (two display points are listed in §12). (a) The mainnet requirement is the condition `cluster` (§6.2, §7.2); "candidate" covers both programs that are not final (C1.24) and clusters that are not mainnet-beta, but not unreadable programs (§7.9); §7.1's output gains `cluster`, `graduated`, `migrated`, `blocking` and each check's `ok`. (b) A certificate of a version or length this document does not list, higher ones included, fails C1.1 or C1.2 and gets no level and no candidate (§10.2 rule 4, replacing "MAY evaluate the levels it knows"); certificate version 4 with `rules_hash` and the informational `RULES_BOUND` = 4096 is expected for L3 (§6.4, §6.5, amendments A1 and A2, which also settle 0.2's two open L3 questions). (c) C2.1 is marked as implied by C1.3, with why. (d) C1.20 requires the used recipient slots first and the unused ones all zero. (e) C1.16 requires a linear or exponential fee schedule (`policy.rs::validate_base_fee`). (f) C1.22 does not apply after graduation (§6.1 rule 7). (g) C1.24 covers `LAUNCHPAD`, and `HOOK` until graduation; not `VAULT` or `SHIELD`; `AUTOPILOT` for L3 (notes on L1). (h) "Migrated" is exactly `is_migrated != 0`, with the SDK's `curveStatus` difference noted. (i) §7.2 and §7.10 read the program data of DBC, DAMM v2 and Token-2022 for §6.6. (j) C2.5 tests the attestation's leaf. Also: C1.23 states how its pool is chosen and that every position counted has no vesting liquidity; Appendix A.1 keeps a candidate off trade screens when the cluster is unknown; §12 lists the reference checker and its two display differences. |
| 0.4 (2026-10-11) | Programmable launches and review 4 merged. (a) **"Programmable" is no longer a level** (review 4, R2): levels are L1 and L2; launch rules and automation are a described component shown as "QSL-1 L2 · programmable: read its rules", checked (P.R1 to P.R4, P.G1 to P.G5, renamed from 0.3's draft C3.R1 to C3.G5) and explained with required warnings: buys limited to wallets the creator lists and for how long, buys refused, rules on wallet-to-wallet transfers, rules on for more than an hour, rules that do nothing, a component that does not check out, automation steps an operator controls, a queued plan, automation that is not frozen, an autopilot program that can still change (§6.4, §6.1 rule 8, Appendix A.2 and A.3). (b) Certificate version 4 (519 bytes, `rules_hash` at 487) is listed with version 3: C1.1, C1.2, C1.3 (`(checks & 4095) == 4095`, 8,191 only with a non-zero `rules_hash`), §5.1, §6.5, §10.2 rule 4. (c) Attestation version 3 and message v3 (221 bytes, with `rules_hash`), hook policy version 2 (with the rule bytes), the rules record, the authorization and the autopilot's accounts (§5.3, §5.6, §5.10, C1.21, C2.2 to C2.6, §7.7.4). (d) The hook skips creator rules for moves through `VAULT` and `SHIELD` and decides sales from the policy's head (§4.4, §5.6, §8.4 items 15 and 16). (e) Freeze payload v2 with `not_after` and the autopilot's `FreezeExpired` (§6.4, §8.4 item 17). (f) `pq_authorize` writes Authorizations for kinds 1 to 3 only (Appendix B). (g) §7.1's output gains `programmable` and loses `components`; §7.8 and §7.10 read the programmable accounts; §11 adds `programmable.json` and the §11.2 examples (certificate bits with rules, message v3, freeze payload v2). |

Errata: none yet.
