---
title: Programs reference
nav: Overview
summary: Program IDs, the PDAs each program derives, and per-program references of every instruction, account, event and error, generated from the Anchor sources.
---

Noised is five Anchor 1.2.1 programs and one `no_std` crate. The fifth, the autopilot (programmable launches: a token's own treasury jobs), is not deployed on any cluster yet; the app shows it as coming soon and runs it in the demo. The per-program pages are generated from the Rust sources (`app/scripts/gen-docs-reference.mjs`): instruction order, accounts with their signer and writable flags, seeds and constraints, account layouts with their byte sizes, errors with their codes, events and constants.

::figure program-ids

## External programs

| Program | ID | Role |
|---|---|---|
| Meteora DBC 0.2.1 | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | bonding curve, pool, hook revocation at completion |
| DBC pool authority | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` | owns DBC vaults and the hook authority of every DBC mint |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | post-graduation pool, permanent LP lock |
| DAMM v2 pool authority | `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` | |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | every launched token and zToken |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | wSOL |
| SPL Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | memo before vault payouts to memo-required accounts |
| Instructions sysvar | `Sysvar1nstructions1111111111111111111111111` | read by the hook to recognize the batch buy |
| wSOL mint | `So11111111111111111111111111111111111111112` | the quote token |

## CPI depth

The runtime allows an instruction stack depth of 5. The deepest Noised path is `launchpad → DBC swap → Token-2022 → hook` = 4, on the batch buy. `launchpad → DBC init → Token-2022 / System` = 3. A CPI'd `execute_batch` cannot succeed (the hook refuses its buy), so the spare fifth level is never used on the batch path.

## How accounts bind to each other

- Every privileged role of a launch is a PDA of the launchpad: the launch authority `["authority", launch]` is DBC's pool creator, partner and fee claimer, leftover receiver and the owner of the DAMM v2 LP position; the batch authority `["batch", launch]` owns the batch escrows; the DBC config is `["dbc-config", launch]`.
- Only the launchpad's `["hook-authority"]` PDA can write a hook policy (`create_policy`) or end a snipe shield (`end_snipe_shield`).
- A launch's post-quantum origin lives in three launchpad accounts: the creator's `["identity", pq_identity]` (the LMS public key and a used-leaf bitmap that only ever gains bits), the launch's `["attestation", launch]` (the full signature, the leaf, the window and the metadata hash) and the token's metadata record `["metadata", launch, metadata_hash]`, at the address of its own content's hash and never modified. `launch` reads the record only through the attestation, and the certificate names it (`Certificate.metadata`).
- No launchpad PDA is ever closed. There is no admin, no pause, and no instruction that changes a launch's fee recipients, hook policy, DBC config or metadata record after creation. (Since audit round 3's fix F1, an attestation whose window passed unused can be replaced by a new one while the launch is still `Configured`.)
