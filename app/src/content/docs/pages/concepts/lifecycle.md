---
title: Launch lifecycle
summary: From create_launch to a permanently locked DAMM v2 pool, step by step, with the accounts each step writes and who may run it.
---

A launch moves through a fixed sequence. Every step after `create_launch` is either permissionless (anyone may run it, and nobody gains by doing so) or authorized by a hash-based signature, never by the creator's wallet alone.

::figure lifecycle

## 1. Configure: `create_launch`

The creator's wallet signs one legacy transaction. The launchpad validates the creator's `LaunchParams` against the [safety policy](#the-safety-policy) and creates the launch's DBC transfer-hook config by CPI, with every field that could hide a rug fixed by the program. The new `Launch` account lives at `["launch", creator, launch_seed]` (32 random bytes chosen by the client) with status `Configured`, and it names the creator's post-quantum identity (`pq_identity`), covered by `params_hash`.

`create_launch` carries the whole curve and the recipient list, so its size is bounded: the policy allows at most **8 curve points** and 4 recipients, which keeps the largest `create_launch` inside a 1,232-byte legacy transaction every wallet can sign (1,107 bytes). The token's name and symbol are not launch parameters: they are the metadata record of the next step.

## 2. Publish the metadata: `publish_metadata`

A throwaway key writes the token's [metadata record](/docs/concepts/token-metadata) (name, symbol, the uri mode and a document with the description, icon and links) at `["metadata", launch, metadata_hash]`, the address of its own hash. Anyone may pay for it, it is idempotent, and it is allowed only while the launch is `Configured`. The record is never modified or closed. The client waits until it is finalized before the identity signs.

## 3. Attest: `attest_launch`

The creator's LMS identity signs a 189-byte message that binds the program, the launch, its `params_hash`, the creator, the record's `metadata_hash`, and a **launch window** `[not_before, not_after]`. Anyone may relay the signature in a v1 transaction paid by the same throwaway key: the signature authorizes, not the fee payer. The program verifies it on-chain, burns the one-time leaf that signed, and writes `["attestation", launch]` if the record exists and the window is valid. Details: [Post-quantum creator identity](/docs/concepts/pq-identity).

## 4. Go live: `launch`

Inside the attested window, anyone may run `launch`. It takes no arguments: the payer only pays rent and picks the fresh mint keypair, and its 22 accounts end with the attestation and the record the attestation names. The transaction is a constant 987-byte legacy transaction for every record. In one atomic transaction it:

1. creates the DBC pool and the Token-2022 mint (`initialize_virtual_pool_with_token2022_transfer_hook`), with the record's name and symbol and the uri derived from it (empty by default);
2. creates the hook's `ExtraAccountMetaList` (exactly two entries: the policy PDA and the instructions sysvar);
3. writes the Launch Guard policy through the hook-authority PDA, then re-reads it;
4. checks the live mint: owner Token-2022, mint and freeze authority None, extensions exactly {MetadataPointer, TokenMetadata, TransferHook}, hook program = Launch Guard, metadata pointer and update authorities None, and the TokenMetadata equal to the record (name, symbol, uri, no additional fields);
5. writes the immutable certificate at `["certificate", base_mint]` and sets the launch `Live`.

If any post-condition fails, nothing of the launch exists. The timestamps written here drive everything that follows: `launch_ts`, `commit_end_ts = launch_ts + open_delay_secs`, `execute_end_ts = commit_end_ts + 600` and `guard_end_ts = launch_ts + guard_secs`.

If nobody opens the launch inside its window, the creator signs a new opening time (audit round 3, fix F1): see [the launch window](/docs/concepts/pq-identity#the-launch-window).

## 5. Commit window

From `launch_ts` until `commit_end_ts` (60 seconds to 30 minutes, chosen by the creator), anyone commits wSOL to the fair-open batch with `commit`. Nobody can buy from the pool: the hook refuses every buy. See [Fair-open batch](/docs/concepts/fair-open-batch).

## 6. Execution window and the open

From `commit_end_ts`, anyone may send `execute_batch` as a top-level instruction. It makes one DBC buy for the whole batch, and only as the pool's first swap. The moment it succeeds it ends the snipe shield (`noised_hook::end_snipe_shield`), so public trading opens at once. If nobody executes the batch within the 10-minute window, or it cannot run, the batch expires at `execute_end_ts` and every commit is refunded in full by `claim`.

## 7. Guard

Until `guard_end_ts` (at most 72 hours after launch), the Launch Guard applies the creator's max-buy, max-wallet and optional wallet-to-wallet pause. Sells are never refused. See [Snipe shield & Launch Guard](/docs/concepts/launch-guard).

## 8. Graduation

When the bonding curve reaches its migration threshold, DBC sets the mint's transfer-hook program and authority to None in the very swap that completes the curve: the token is now hook-free forever. Anyone then calls DBC `migration_damm_v2`, which moves the liquidity into a DAMM v2 pool and permanently locks 100% of it under the launch authority PDA. See [Liquidity lock & fees](/docs/concepts/liquidity-and-fees).

## Phases in the SDK

`launchPhase(launch, nowSecs)` returns one of six phases; `nowSecs` is a `bigint` of unix seconds (`unixNowSecs()` for this device's clock, `clusterUnixTime(conn)` for the cluster's). `graduated` needs the market snapshot, because the `Launch` account alone cannot tell that the curve completed. `getLaunchFlowStatus(conn, launch)` adds the steps before the launch: `create`, `publish`, `attest`, `wait-for-window`, `launch` and `window-missed`.

| Phase | When |
|---|---|
| `configured` | created, not yet live |
| `commit` | `[launch_ts, commit_end_ts)` |
| `execute` | `[commit_end_ts, execute_end_ts)` |
| `guarded` | `[execute_end_ts, guard_end_ts)` |
| `open` | after `guard_end_ts` |
| `graduated` | the curve completed (DBC revoked the hook) |

## The safety policy

The creator chooses only the fields of `LaunchParams`, inside these bounds (enforced by `policy::validate`, safety policy version 3):

| Field | Bound |
|---|---|
| `token_decimal` | 6 to 9 |
| `sqrt_start_price`, `curve` | 1 to 8 points, strictly increasing prices, non-zero liquidity; DBC's own rules |
| `migration_quote_threshold` | 1 to 100,000 SOL |
| `base_fee` | linear or exponential schedule that ends within `open_delay_secs` (`FeeScheduleTooLong`) |
| `dynamic_fee` | optional; floor fee + largest possible dynamic fee at most 10% (`FeeTooHigh`) |
| `migration_fee_option` | 0 to 5: DAMM v2 tiers 0.25%, 0.3%, 1%, 2%, 4%, 6% |
| `open_delay_secs` | 60 to 1,800 (the commit window) |
| `guard_secs` | at least `open_delay_secs + 600`, at most 72 h |
| `max_wallet_bps` | 0 (off) or 10 to 10,000 of the initial supply |
| `max_buy_bps` | 0 (off) or 1 to 10,000 |
| `p2p_locked` | pause wallet-to-wallet transfers during the guard |
| `batch_total_cap` | 0 (= the threshold) or from threshold / 10 up to the threshold |
| `batch_wallet_cap` | 0 (no cap) or at least the resolved total cap / 200 |
| `recipients` | 1 to 4 distinct wallets, non-default, not the launch's own PDAs, summing to 10,000 bps |
| `pq_identity` | `SHA256(0x21 ‖ LMS public key)`, never all zero |

Everything else is fixed for every launch: wSOL as the quote token, Token-2022 with immutable metadata taken from the attested record, migration to DAMM v2, quote-only fees, timestamp activation, 100% of the migrated liquidity permanently locked, no LP for anyone, no vesting, no creator allocation, no migration fee, no pool-creation fee, no first-swap privilege, and the Launch Guard as the only transfer hook.

## The certificate

`["certificate", base_mint]` (487 bytes, version 3) is written once by `launch` and never modified or closed. It records the pool, the DBC config, the timestamps, the guard values, the fee recipients, `params_hash` (SHA-256 of the borsh-serialized `LaunchParams`), `policy_version` (3), the post-quantum origin (`pq_identity`, `pq_leaf`, `attested_slot`), the metadata record's address (`metadata`) and a `checks` bitmask that must have all twelve bits set (`(checks & 4095) === 4095`; a launch with creator rules also carries the informational bit 4096, `RULES_BOUND`, so 8191):

| Bit | Check |
|---:|---|
| 1 | mint authority None |
| 2 | freeze authority None |
| 4 | metadata update authority None |
| 8 | metadata pointer authority None |
| 16 | extension set exact |
| 32 | hook = Launch Guard |
| 64 | LP 100% permanently locked by config |
| 128 | no migration fee |
| 256 | no creator allocation |
| 512 | quote = wSOL |
| 1024 | post-quantum attested |
| 2048 | metadata on-chain: the mint shows exactly the attested record |

A certificate states only what was verified on-chain at launch. Clients must not trust it alone: `verifyLaunch` re-checks the live accounts.
