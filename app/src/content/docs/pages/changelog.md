---
title: Changelog
summary: What changed in the programs, the SDK and the app, newest first.
---

## Renamed to Noised

The project is now **Noised**, at **noised.fun**. Older entries below keep the name of their time (Phalanx).

- **Nothing on-chain changed.** The same programs at the same addresses, with the same instructions, accounts and events; every launch, vault and shield keeps working as before. The quantum keys, recovery phrases and passkeys give exactly the same keys and signatures as before.
- **Your records come with you.** The first time this browser opens the renamed app, it copies what it kept under the earlier name: your settings, your signed withdrawals and the records of every one-time key you already used (so none of them can ever sign twice), your launches in progress and your passkey list. Nothing is deleted. A key records file saved before the rename still imports.
- **For developers:** the SDK is `@noisedlabs/sdk`, the MCP server `@noisedlabs/mcp` (`claude mcp add noised ...`), and the settings are `VITE_NOISED_*` and `NOISED_*` (the `PHALANX_*` names still work for one release).

## This release: the quantum security layer

**QSL-1 (2026-10-10).** The guarantees of a Phalanx launch are now a named, versioned token standard, [QSL-1](/docs/standard/qsl-1), with three nested levels: No-rug, Quantum-attested and Programmable (a draft). Nothing in the programs, accounts or transaction bytes changed.

**SDK 0.5.0**

- `checkQsl1(conn, mint)` runs the standard's verification algorithm; `evaluateQsl1` is its pure core; `qslBadge(result)` gives the standard's wording.
- Older signatures: `buildAttestLaunchTx` and `buildPlannedAttestTx` refuse to sign a new window for a launch while an earlier signed window of it has not ended and never landed (`PendingAttestationError`); `findPendingAttestations` and `landOrBurnPending` deal with them. `getLaunchFlowStatus` reports `pendingSignatures` and `warnings`.

**App:** Phalanx is presented as the quantum security layer for Solana (Launch, Vault, Shield, Verify). The create wizard is simple by default: preset cards and sliders over safe values, each with a plain sentence, with the exact inputs under "Advanced". Every token shows its QSL-1 badge (on devnet: "candidate"), which opens an explainer, and the new Verify page checks any token against QSL-1. A launch whose earlier signature could still land waits for that signature's window before signing a new one.

## Safety policy 3

**Programs: on-chain token metadata (2026-10-09)**

- **`TokenMeta` and `publish_metadata`.** A token's name, symbol, uri mode, optional external uri and document (description, icon, links) are one record at `["metadata", launch, metadata_hash]`, the address of its own hash, written whole by the permissionless, idempotent `publish_metadata` and never modified or closed. `metadata_hash = SHA256("PHX-META-V2" ‖ …)`. Event `MetadataPublished`.
- **Attestation message v2** (189 bytes, `"PHX-ATTEST-V2"`): binds the record's hash instead of the name, symbol, uri and the off-chain document's hash. `attest_launch(lms_pk, lms_sig, metadata_hash, not_before, not_after)` takes the record as its fifth account and attests only if it exists; any other account in that position fails with `ConstraintSeeds` and burns nothing (metadata review fix). `Attestation` version 2 (2,676 bytes) drops `metadata_json_sha256`.
- **`launch()` takes no arguments.** It reads the record the attestation names (22nd account), gives the mint its name, symbol and derived uri (empty by default; `INLINE_URI` and `EXTERNAL_URI` are signed opt-ins), and checks the mint's TokenMetadata against it. A constant 987-byte transaction for every record.
- **Certificate version 3** (487 bytes): check bit 2048 (`METADATA_ONCHAIN`, all twelve bits = 4095) and `metadata`, the record's address. `SAFETY_POLICY_VERSION` = 3.
- New errors `InvalidMetadataFlags` (6045), `MetadataTooLong` (6046), `MetadataMismatch` (6047); `InvalidMetadata` (6016) keeps its number with a new message.

**Programs: post-quantum v2 and audit round 2 (2026-10-09)**

- **Post-quantum creator identity and launch attestation.** New instruction `attest_launch`; new accounts `Identity` (`["identity", pq_identity]`, LMS public key and a 1,024-bit used-leaf bitmap) and `Attestation` (`["attestation", launch]`). `LaunchParams` gains `pq_identity` (appended, covered by `params_hash`); the launch address is `["launch", creator, launch_seed]`. Every valid signature lands and burns its leaf; it attests only for the launch's identity, inside a valid window. `launch` requires the attestation, runs only inside the signed window and is permissionless inside it. The certificate records `pq_identity`, `pq_leaf` and `attested_slot` with check bit 1024 (`PQ_ATTESTED`). Errors 6039–6042 and 6044; events `LaunchAttested`, `PqLeafConsumed`.
- **Payout owners.** The first commit fixes `token_owner` and `refund_owner` (the committer or a PQ vault of the paid mint); `claim` pays only them. `["payout-vault", launch, vault]` holds a vault named by several committers to one wallet's cap. New error `InvalidPayoutOwner` (6043).
- **Contention fixes (round 2).** `MIN_OPEN_DELAY` 10 → 60 seconds; `EXECUTION_GRACE_SECS` 30 → 600 seconds; new hook instruction `end_snipe_shield`, called by `execute_batch`, ends the shield the moment the batch has bought, so the longer window never delays trading (hook error `NotInBatch`, event `SnipeShieldEnded`).
- **Batch-cap floors.** A non-zero `batch_total_cap` is at least threshold / 10; a non-zero `batch_wallet_cap` at least the resolved total cap / 200 (`InvalidBatchCap`).
- **Treasury.** `initialize_protocol` requires the treasury to be a wSOL PQ vault.
- **Vault key-index binding.** `open_vault` requires `q = 0`; `withdraw` requires the next key's `q` to be `sequence + 1` (`InvalidKeyIndex`, 6006).

**Audit round 3 (2026-10-10), fixes merged**

- **F1, launchpad:** an attestation whose window passed unused can be replaced by a new one while the launch is `Configured`, and a window must have at least 60 seconds left when its attestation lands.
- **F2, hook:** while the guard is on, a transfer that is not a sell into a token account without `ImmutableOwner` is refused (`MutableOwner`, 6010).
- **Evidence:** the audit's proofs of concept are LiteSVM tests (`audit_round3.rs`), with `pq_v2.rs`, `metadata_record.rs` and the integration test `hook.rs`; every mutant of the new rules is killed.
- **F3, clients:** fee recipients that are PQ vaults of another mint are refused by the SDK and the app.
- **F4, documentation:** payout-vault quota griefing, max wallet on shared accounts, and what the wallet-to-wallet lock stops.

**SDK 0.4.0**

- Metadata: `buildMetadataDoc`, `encodeIndexedPng`, `validateTokenMeta`, `metadataHashV2`, `tokenMetaAddress`, `buildPublishMetadataTx`, `waitForTokenMeta`, `fetchTokenMetaForLaunch` / `ForMint`, `parseMetadataDoc`; one throwaway payer funded by `throwawayPayerFunding` and swept by `buildSweepPayerTx`.
- Launch flow: `planLaunch` takes `metadata`; `buildLaunchTx` and `buildLaunchCommitBundleV1` take no metadata; `COMPUTE_UNITS.launch` = 300,000; flow step `publish`; `window-missed` now means "Window passed: sign a new opening time" (`replanLaunchWindow`); at most two burn-only landings per launch (`AttestRetryLimitError`).
- Verify: `report.metadata` and the checks `metadata.onchain`, `metadata.match`, `metadata.icon`; `pq.metadataJson` and `fetchMetadataJson` removed; `verifyAttestation` for launches not yet live.
- Audit round 3 client sides: hook error 6010 named; `buildSwapTx` and `buildReleaseToTx` refuse mutable-owner destinations during the guard; `checkFeeRecipients`.
- Breaking: `LaunchParamsInput` has no `name`, `symbol` or `uri`; `launchMetadataHash`, `validateMetadata` and the `metadataJson` inputs are gone. Launches, attestations and certificates made with SDK 0.3 are not compatible.

**App:** the create wizard writes the token's record (icon, description, links) instead of asking for a metadata link; quantum keys from a passkey or the phrase, with this browser's key records; commits and buys straight into your quantum vault; the token page opens a configured launch inside its signed window; the verify panel shows the new checks.

**Docs:** this developer documentation and the [whitepaper](/whitepaper).

## Audit round 1b (2026-10-08)

- The snipe shield is checked before the zero-amount pass: a buy whose output rounds to zero is refused like any other, and a transfer out of the base vault is never a sell.
- `execute_batch` runs only as the pool's first swap (`PoolAlreadyTraded`, 6038); otherwise the batch can only expire and refund in full.
- The LM-OTS randomizer is deterministic: `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" ‖ I ‖ u32be(q) ‖ msg)`.

## Audit round 1 (2026-10-08)

- **Vault v4.** Keys rotate in place with a sequence number; `withdraw` only reserves a payout; delivery by `release` or `release_to`; successor vaults and `sweep` removed; message tag `PHX-PQV4`; mints with a close authority refused.
- **Snipe shield** admits only the buy inside the launchpad's top-level `execute_batch`, read from the instructions sysvar; exempt owners no longer open it. The meta list gains the instructions sysvar; hooked transfers carry four hook accounts.
- **Batch total cap** no longer refuses commits: an oversubscribed batch is filled pro rata.
- **Claims** validate the committer's accounts like `distribute` (canonical address, owner field not compared).

## Post-quantum scheme

- The vault moved from WOTS+C (n = 24, NIST category 3) to the standardized LM-OTS `LMOTS_SHA256_N32_W4`, made practical by v1 transactions (SIMD-0385, 4,096 bytes, live on mainnet since 2026-09-15): about 70k CU to verify instead of about 300k, published RFC test vectors and a per-signature randomizer. The superseded `crates/phalanx-wots` was removed.
