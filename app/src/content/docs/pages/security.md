---
title: Security
nav: Security model
summary: What Noised guarantees and how, who you still trust, what the internal reviews found, how it is tested, and how to report a vulnerability.
---

:::warn Status: not yet finalized
The programs have not been finalized. Until a program's upgrade authority is set to None, its holder can replace that program's code, and every guarantee it enforces is only as strong as that key. Check with `solana program show <program id>`: `Authority:` must read `none`.
:::

## Guarantees

Each row is enforced on-chain and, after finalization, cannot change. The full table, with the code and the tests behind each row, is `docs/SECURITY_GUARANTEES.md` in the repository.

| # | Guarantee | Enforced by |
|---|---|---|
| T1–T2 | Supply can never grow; no holder can be frozen | mint and freeze authority None, checked on the live mint in `launch` (certificate bits 1, 2) |
| T3 | Name, symbol and metadata are permanent, on-chain and signed by the creator's post-quantum identity | the `TokenMeta` record at the address of its own hash, never modified; the mint must equal it (bit 2048); metadata and pointer authorities None (bits 4, 8) |
| T4 | No hidden powers | extension set exactly {MetadataPointer, TokenMetadata, TransferHook} (bit 16) |
| T5 | The only hook is Launch Guard, revoked at graduation | hook program and DBC pool authority checked (bit 32) |
| L1 | Nobody buys before the batch; the batch is the pool's first swap or refunds | hook step 5 + `PoolAlreadyTraded` |
| L2 | One price, pro-rata shares; committing early gains nothing | `math::batch_share`, total cap never refuses, cap floors |
| L3 | Payouts never exceed the escrow, go only to the payout owners the first commit fixed, and nobody but those owners can block a claim | `Commit.claimed`, running totals, `AtaCreator::ensure` |
| L4 | A batch that does not execute refunds every commit in full | `claim`'s expired path |
| L5 | No creator allocation, vesting, first-swap privilege or head start | DBC config checks (bit 256) |
| L6–L7 | Every rule ends within 72 h; sells are never refused | `MAX_GUARD_SECS`; hook step 3 |
| L8 | With the wallet-to-wallet lock on, tokens cannot move between holders until the guard ends | `TransfersLocked`; with audit round 3's F2, guarded transfers only into accounts whose owner can never change (`MutableOwner`) |
| P1–P4 | 100% of the graduated liquidity permanently locked; no creator or partner migration fee; nobody can withdraw the position; graduation needs nobody's permission | DBC config (bits 64, 128); position NFT held by a PDA |
| F1–F6 | Recipients never change; platform share ≤ 50%, into a PQ vault; base-token fees burned; at most 10% trading fee after the schedule; anyone can route fees | `create_launch` validation, `distribute`, `within_fee_ceiling` |
| G1–G5 | No admin, pause or settings update; protocol parameters set once; only the launchpad writes hook policies; certificates state only what was verified | program code |
| V1–V6 | Vault tokens move only as a payout signed by the current LM-OTS key; one key, one withdrawal; a valid signature always executes | `noised_vault` |
| S1–S4 | zTokens fully backed; nobody controls a zToken | `noised_shield` |
| A1–A7 | No launch without its identity's hash-based attestation over its parameters, metadata and window; a leaf signs once, ever; anyone can open the launch inside the window; a relayer cannot change what an attestation does; payout vaults hold one wallet's cap | `attest_launch`, `launch` (bit 1024), the identity bitmap |
| M1–M4 | The metadata record is complete and unchangeable; the mint shows exactly the attested record; a junk record can never become a launch's metadata; nothing depends on hosting by default | `publish_metadata`, `attest_launch`, `launch` (bit 2048) |

## Who you still trust {#who-you-still-trust}

Noised can make its own programs immutable. It cannot remove trust in these parties, so it discloses them here, in the app and in `verifyLaunch`.

| Party | What they can do |
|---|---|
| **Meteora upgrade multisig** (Squads v3, 4-of-7, no timelock) | Replace DBC and DAMM v2 at any time, including the behaviour the snipe shield relies on (a Token-2022 transfer for every buy). If an upgrade let a buy slip past the hook, the batch refuses to run and refunds in full. |
| **DAMM v2 admins and operators** (single keys) | Disable a pool (trading stops, locked liquidity is stuck), raise a pool's base fee to 10%, change its dynamic fee, close migration configs. |
| **DBC operators** | Manage badges and claim protocol fees. A draft change (not deployed) would let one operator revoke a hook before graduation, which would end the shield; the batch would then refund. |
| **Token-2022 upgrade multisig** (Squads v3, 4-of-6) | Replace Token-2022, which governs every Noised token, every zToken and every Token-2022 vault. |
| **The ATA program** | Creates every canonical token account Noised pays; classical code under classical keys and feature gates. |
| **Validators** (consensus, feature gates) | Validator and vote keys are Ed25519: consensus is not post-quantum. Feature gates change the runtime; they disabled the ZK ElGamal proof program from 2025-06-19 to 2026-06-04. |
| **Ordering gateways and block producers** | See transactions before they land; reorder, delay or drop them. Censoring `execute_batch` for its whole window forces a full refund; censoring `launch` for a whole window makes the creator sign a new one (F1); they decide who lands first. |
| **Wallets** | Show what you sign, and hold classical keys. Noised never needs a user wallet to sign a v1 transaction: withdrawals, metadata records and attestations are paid by throwaway keys. |
| **Passkey authenticators and sync providers** | For creators who use a passkey: the authenticator holds the identity's PRF secret, and a synced passkey's provider can move it. |
| **Authorities of non-Noised mints in vaults** | Delay payouts (freeze, pause, hook) or dilute; never block `withdraw` or take funds. |
| **Noised's upgrade authority**, until finalization | Replace any of the Noised programs. |
| **Frontend, DNS, RPC, wallet** | Show false information or ask you to sign a harmful transaction. Verify with the SDK or the CLI. |

## Residuals no rule removes

- **The first transaction in a window wins.** Inside an attested launch window anyone may send `launch`; block producers and priority fees decide who lands first.
- **A relayer can delay an attestation, a commit or a withdrawal, but not change it.** Everything that matters is signed.
- **Write-lock contention.** A party that fills the per-block compute budget of a launch's accounts with higher-priority transactions keeps others out while it pays: the batch then expires and refunds in full, commits are excluded, or an attested window passes unused. The minute-long commit window and the 10-minute execution window make the cost grow with time; they do not remove it.
- **Two devices, two ledgers.** A phrase or identity used on two devices that do not share their one-time-key records can sign two messages with one key.
- **Quotas and shared accounts.** Anyone may fill a PQ vault's batch quota by naming it in a commit: the tokens that commit buys go to the vault, and its unspent wSOL goes back to the griefer's own refund owner. During the guard anyone may also fill a shared account to max wallet (the Shield's escrow, which every holder of the mint shares, or someone's ATA). Griefing only, at most 72 hours.
- **An Autopilot step that waits on the price can be delayed, never triggered.** A price condition passes only if the price has stayed past its limit for the last 15 to 30 minutes. Someone willing to pay trading fees can push the price across the limit and back once every 15 minutes and hold such a step back for as long as they keep paying, whether it buys back, burns or pays out. They can never make it run, and nothing leaves the treasury. The closer the limit is to the going price, the cheaper this is (roughly 2.4 SOL a day for a pool with 100 SOL a side, a limit about 10% away and a 0.25% fee). So keep price limits well away from the going price, and don't make a payout that must arrive on time depend on the price alone.
- **The lock stops transfers, not changes of control.** Control can move without a token transfer, which no hook sees: several people sharing one wallet (a multisig, a smart wallet or a shared key), a PDA or smart-wallet owner changing hands, a PQ vault's key rotating to the next one-time key, or a delegate approved on a token account.

## Post-quantum scope

Protected against a quantum computer: the authority to launch (the creator's LMS identity, verified on-chain, over the launch's parameters, its metadata record and its window), the token's metadata (the identity signs the record's hash, and consensus stores the bytes), and tokens in a PQ vault (LM-OTS). **Not** protected: ordinary wallets (every address is an Ed25519 key), confidential balances (ElGamal), validator and consensus keys, the multisigs that can upgrade Meteora and Token-2022, and our own programs until finalized. No token is "quantum-proof".

"Superintelligence-proof" is read as: leave a capable attacker nothing to work with. No secrets to steal (every privileged role is a PDA), no admins to phish (no admin instructions), immutable code (finalized after audit), rules anyone can check (`verifyLaunch` re-checks live state and re-verifies the post-quantum signature), a small testable surface, and hash-based keys that never push anyone to sign twice. Where each principle stops is in the tables above.

## Internal reviews {#internal-reviews}

Every review so far was carried out by AI agents: finders with one risk lens each, skeptics told to refute every finding, adversarial reviewers who wrote proofs of concept against the real program builds, and fixers who added a regression test for every fix. The full record is `docs/AUDIT.md`.

| Review | Date | Who | Findings | Outcome |
|---|---|---|---|---|
| Round 1 | 2026-10-08 | 7 finders, 45 skeptics | 24 to skeptics; 20 confirmed reports, 10 issues: 3 high, 2 medium, 5 low | every program fix with regression tests; one documented limitation |
| Round 1b | 2026-10-08 | 2 adversarial reviewers, 2 test agents | 1 new high (a zero-output buy through the shield) and weak tests | all fixed |
| Clients review | 2026-10-08 | 1 reviewer | 9: 3 medium, 5 low, 1 info | fixed in SDK 0.2 and 0.3 and in the app |
| Round 2 | 2026-10-08 | 8 finders, 34 skeptics | 16 confirmed: 1 high, 4 medium, 11 low | program fixes in safety policy 2; contention mitigated, a documented residual |
| PQ v2 reviews | 2026-10-09 | spec reviewer; adversarial reviewer | 17 binding amendments; 7 findings: 2 medium, 3 low, 2 info | all applied or fixed |
| SDK reviews (0.2, 0.3) | 2026-10-09 | 3 reviewers | 20: 5 medium, 9 low, 6 info | all fixed |
| On-chain metadata review | 2026-10-09 | 1 reviewer, with a proof of concept | 2: 1 medium (a relayer could turn an attestation into a burn), 1 info | fixed (`ConstraintSeeds` on any other record account) |
| Round 3 | 2026-10-10 | 6 lenses, 2 skeptics per finding, 4 proofs of concept | 5 confirmed: 1 medium, 2 low, 2 info; 92 areas checked and found sound | F1 (launchpad) and F2 (hook) fixed and merged; F3 client check; F4 documented |

Round 3, in brief:

| ID | Rating | Finding | Fix |
|---|---|---|---|
| R3-1 | medium | An attested launch whose window passed unused could never go live; so could one whose attestation landed in its last second. | **F1** (fixed): an expired, unused attestation can be replaced; a window needs 60 s left when it lands. |
| R3-2 | low | Anyone can use up a PQ vault's batch quota. | **F4**: documented residual (the griefer donates the tokens). |
| R3-3 | info | A fee recipient that is a PQ vault of another mint loses its share. | **F3**: the SDK and the app refuse such recipients. |
| R3-4 | low | The wallet-to-wallet lock could be bypassed by reassigning a token account's owner. | **F2** (fixed): guarded transfers only into accounts with a fixed owner (`MutableOwner`, 6010); F4 documents what the lock stops. |
| R3-5 | info | Max wallet applies to shared accounts anyone can fill. | **F4**: documented. |

No finding of any round was confirmed against the Shield's own code or against the LM-OTS and LMS verification in `noised-lmots`. Every program fix has regression tests, named after its finding, that replay the attack against the mainnet program binaries.

## Testing

On the final programs (2026-10-09, fresh SBPF v3 builds; before round 3's fixes):

- **Host tests** of the pure decision functions: 151, including 200,000-case property tests of the hook (sells never blocked, everything allowed after the guard, only the batch buys during the shield), the safety policy, the payout math, the message and account layouts and the metadata rules.
- **LM-OTS and LMS** known-answer tests: 35, against RFC 8554 Appendix F (the full height-10 tree of Test Case 2 rebuilt from its 1,024 one-time keys), HMAC against RFC 4231, and the deterministic randomizer's known answer; three independent Python reference checks re-derive every vector.
- **LiteSVM suites** that run our builds against mainnet dumps of DBC, DAMM v2, Token-2022, SPL Token and the ATA program: 98 integration tests, the launchpad's 59 and the shield's 17.
- **Mutation testing:** 148 of 148 integration mutants killed (vault 38, hook 36, launchpad 74), 23 of 23 LiteSVM-only mutants, and 31 of 31 mutants of the LMS code; the two surviving `MetadataMismatch` mutants are equivalent (unreachable with an honest DBC) and documented.
- **SDK 0.4:** 545 tests in 28 files, with byte parity against the Rust-produced vectors (vault, LMS and every metadata record); a mutation run over the new code killed 128 of 131 mutants, the 3 survivors equivalent and documented.

## Report a vulnerability

Tell us privately first; please do not open a public issue or post about an unfixed vulnerability. Include the affected component and commit or program id, the impact, and a reproduction, ideally a LiteSVM test. The reporting address and PGP key are published in `SECURITY.md` before deployment. Targets: acknowledgement within 72 hours, initial assessment within 7 days, coordinated disclosure by default 90 days after the report or after a fix ships. No bug bounty is live yet; reports made before one launches will be considered for retroactive rewards.

:::danger There is no pause button
By design, the programs have no admin, no pause and, once finalized, no upgrade path. An exploitable bug cannot be stopped or patched on-chain by anyone, us included. Never run an exploit against mainnet, even "just to check": use a local validator, LiteSVM or devnet.
:::
