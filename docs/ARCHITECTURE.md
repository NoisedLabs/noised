# Architecture

This document explains how Noised is put together and why. The normative interface (accounts, seeds, instruction arguments, invariants) is [SPEC.md](SPEC.md). Sourced background facts are in [research/FACTS.md](research/FACTS.md), cited below as "FACTS #n". Security properties are tabulated in [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md) and attacks in [THREAT_MODEL.md](THREAT_MODEL.md).

## 1. Overview

```
                        users, creators, keepers (anyone)
                                     |
          +--------------------------+---------------------------+----------------+-----------------------+
          |                          |                           |                |                       |
          v                          v                           v                v                       v
 +-------------------+     +------------------+       +------------------+  +----------------+  +-------------------+
 | noised_launchpad |---->| noised_hook     |       | noised_vault    |  | noised_shield |  | noised_autopilot |
 | safety policy,    | CPI | create_policy,   |       | LM-OTS custody,  |  | 1:1 zToken     |  | a launch's        |
 | PQ attestation,   |     | end of shield,   |       | payouts          |  | wrapper        |  | treasury, run by  |
 | metadata record,  |     | meta list,       |       |                  |  |                |  | an authorized     |
 | launch rules,     |     | creator's rules  |       |                  |  |                |  | graph: buyback-   |
 | pq_authorize,     |     | (PXR1, can only  |       |                  |  |                |  | and-burn, burns,  |
 | batch, fees, cert |     | refuse)          |       |                  |  |                |  | payouts, tips     |
 +-------------------+     +------------------+       +------------------+  +----------------+  +-------------------+
     |        |                    ^ execute (hook CPI)        |                    |                     |
     |        v                    |                           v                    v                     |  reads Launch,
     |   Meteora DBC ----------> Token-2022 <------------- SPL Token / Token-2022 (+hook)                 |  Certificate and
     |   (bonding curve)           ^                       ATA program, SPL Memo (payouts)                |  Authorization
     |        | migration_damm_v2 (permissionless, Meteora code)                                          |  by layout (no CPI)
     |        v                                                                                           |
     +--> Meteora DAMM v2 (graduated pool; 100% LP permanently locked) <-- buyback swap ------------------+

 off-chain: sdk/ (builders, verifyLaunch, PQ identities and vault keys, ledgers, rules and graphs, keeper planner),
            app/ (static frontend), keepers (cranks), packages/noised-mcp (MCP server for AI agents; never signs)
```

Noised is five programs of our own on top of Meteora's audited but upgradeable programs:

| Program | ID | Role | Code |
|---|---|---|---|
| `noised_launchpad` | `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc` | Validates creator parameters against a fixed safety policy. Stores the token's metadata and the creator's optional launch rules on-chain and verifies, on-chain, the creator's post-quantum (LMS) attestation of the launch's configuration, metadata, rules and window before the launch can go live. Creates the Meteora DBC config and pool by CPI, holding every DBC role through PDAs. Runs the fair-open batch, routes fees and writes the launch certificate. Writes LMS-verified authorizations of the launch identity for autopilot changes (`pq_authorize`). | `programs/noised-launchpad`, `crates/noised-lmots`, `crates/noised-rules` |
| `noised_hook` | `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` | Launch Guard: a Token-2022 transfer hook with stateless, time-bounded rules; the batch ends its snipe shield. It also runs the creator's verified launch rules (PXR1), installed byte-exact at `launch`, which can only refuse more transfers before the guard ends. | `programs/noised-hook`, `crates/noised-rules` |
| `noised_vault` | `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb` | Token vaults that only an LM-OTS (RFC 8554) one-time signature can open. The key rotates in place; a withdrawal reserves a payout that is delivered separately. | `programs/noised-vault`, `crates/noised-lmots` |
| `noised_shield` | `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9` | Wraps a token 1:1 into a Token-2022 confidential-balance "zToken". | `programs/noised-shield` |
| `noised_autopilot` | `D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx` | Optional post-launch automation: runs a launch's treasury (a PDA) by a verified PXG1 graph that the launch identity authorized: buyback-and-burn on the launch's own DAMM v2 pool, burns and payouts to declared recipients, run by anyone for a bounded tip. Changes wait 72 hours; a graph can be frozen. No admin; it never touches the launch, its hook policy, its LP or its mint's authorities. | `programs/noised-autopilot`, `crates/noised-rules` |

`crates/noised-rules` (no_std, allocation-free on-chain) holds the PXR1 rule format, the PXG1 graph format and the condition VM that the launchpad, the hook, the autopilot and the SDK share; its README is normative.

External programs we depend on:

| Program | ID | Upgradeable by (2026-10-08) |
|---|---|---|
| Meteora DBC 0.2.1 | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Squads v3 multisig `CoEsykat…` (4-of-7, no timelock), vault `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` |
| Meteora DAMM v2 (cp_amm 0.2.4) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | same multisig |
| Token-2022 v11.0.0 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Squads v3 multisig `BnD53519…` (4-of-6), vault `AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz` |
| SPL Token (p-token) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | nobody (authority None); validator feature gates can still replace it |
| SPL Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | nobody (non-upgradeable loader); feature gates only |

## 2. Launch lifecycle

```
create_launch          creator's wallet  validate LaunchParams incl. pq_identity (policy.rs) -> CPI DBC
                                         create_config_with_transfer_hook (config = PDA ["dbc-config", launch]);
                                         Launch ["launch", creator, seed], status = Configured
publish_metadata       anyone (v1)       TokenMeta ["metadata", launch, metadata_hash] written whole (name, symbol,
                                         uri mode, document); the client waits for confirmation
publish_rules          anyone (optional) LaunchRules ["rules", launch, rules_hash] written whole after the PXR1 rules
                                         verify for the launch's guard; the client waits for confirmation
attest_launch          anyone relays (v1)  verify the identity's LMS signature over message v3 (launch, params_hash,
                                         creator, metadata_hash, rules_hash, window); burn its leaf; write Attestation
                                         if it attests (a non-zero rules_hash needs its valid LaunchRules record)
launch          T0     ANYONE, inside the signed window [not_before, not_after]
                                         CPI DBC initialize_virtual_pool_with_token2022_transfer_hook (creator = launch
                                         authority) with the record's name, symbol and derived uri;
                                         post-condition checks on mint (metadata included), config and pool (checks.rs);
                                         all 12 flags required; CPI hook initialize_extra_account_meta_list, hook
                                         create_policy with the attested rules (hook-authority PDA), policy re-read
                                         (rules byte-equal) -> Certificate v4 (+ RULES_BOUND if rules); status = Live
                                         (one atomic instruction)
commit         [T0, T0+open_delay)       anyone: wSOL -> batch escrow, Commit PDA with payout owners fixed at the first
                                         commit (never refused for the total cap)
execute_batch  [T0+open_delay, T0+open_delay+600s)  anyone, once, top-level: ONE DBC buy of min(total, cap),
                                         only as the pool's first swap (else expiry and full refunds); then CPI hook
                                         end_snipe_shield: the shield ends now
claim          after execution or expiry anyone may crank; tokens + refund go to the payout owners' canonical ATAs
public trading from the batch (or T0+open_delay+600s without one)  DBC swap2_with_transfer_hook; Launch Guard checks
                                         every transfer: built-in rules first, then the creator's rules (refuse only)
guard ends     T0+guard_secs (<= 72 h)   every transfer allowed from here on (the creator's rules end too)
curve completes                          DBC revokes the hook in the same swap (program + authority = None)
migration_damm_v2                        anyone (Meteora instruction): DAMM v2 pool, 100% LP permanently locked
claim_fees / claim_surplus / claim_lp_fees / distribute
                                         anyone, any time: collect fees, route wSOL by fixed bps (platform share to
                                         the treasury vault), burn base-token fees

autopilot (optional, noised_autopilot; every step permissionless unless noted)
init_autopilot         Configured/Live   Autopilot ["autopilot", launch] + treasury wSOL ATA; reference = migration price
bind_mint              once Live         certificate checked ((checks & 4095) == 4095); treasury token ATA
publish_graph          any time          GraphRecord ["graph", launch, graph_hash], verified PXG1; activates nothing
pq_authorize, activate                   the identity signs kind 1 over the activation (launchpad writes the
                                         Authorization); activate queues the graph: a first graph at once, a
                                         replacement >= 72 h after it became visible
apply_pending          at activate_at    the queued graph becomes active (runs are refused while one is due)
update_price, run      keepers, any time observe the pool; run one due node for a tip (operator-gated: the operator)
bind_pool              once migrated     the DAMM v2 pool DBC's migration created: graduated; buybacks possible
freeze, revoke_operator                  the identity's kind 2 / kind 3 authorization: freeze for good (only until its
                                         signed not_after); clear the operator (also on a frozen graph)
```

Timing is enforced in three places. The attestation fixes the launch window, and `launch` runs only inside it (anyone may send it; the first to land wins). The launchpad checks its own windows (`commit_end_ts`, `execute_end_ts`). The hook's policy stores `snipe_shield_end_ts = T0 + open_delay + 600 s` and `guard_end_ts = T0 + guard_secs`, and `execute_batch` moves `snipe_shield_end_ts` to the moment of the batch. Until `snipe_shield_end_ts`, the hook refuses every buy out of the DBC base vault, whatever its amount, unless the transaction's current top-level instruction is the launchpad's `execute_batch`, which it reads from the instructions sysvar. That instruction makes exactly one swap, so the batch purchase is the only purchase possible before public trading. Exempt owners (the launch's batch-authority and launch-authority PDAs) and zero amounts do not change this; the exemption and the zero-amount pass apply only after the shield check ([HOOKS.md](HOOKS.md) §2). Behind the hook, `execute_batch` runs only as the pool's first swap (`PoolAlreadyTraded`), so a buy that ever got past the hook would turn the batch into a full refund, never into a batch bought at a moved price.

The creator's launch rules, when a launch has them, are bound by the same timing: the hook evaluates them only after every built-in allow and denial and only before `guard_end_ts`, so they never see a sell, a claim, the batch buy or anything after the guard, and a transfer whose top-level instruction is the Noised vault or shield skips them (holders' exits; review 4, R1). Their windows count from the launch's opening (SPEC §1.9, [HOOKS.md](HOOKS.md) §2). The autopilot runs on its own clock, after `launch`: nodes are due by their triggers, a replacement graph waits 72 hours, and buybacks wait for `bind_pool` (SPEC §9).

## 3. Accounts

### Launchpad PDAs (`["seed", ...]` under `noised_launchpad`)

| Account | Seeds | Holds / does | Closed? |
|---|---|---|---|
| `Protocol` | `["protocol"]` | treasury (a wSOL PQ vault), `platform_fee_bps`; written once by `initialize_protocol` | never |
| `Launch` | `["launch", creator, launch_seed]` | all creator choices (`pq_identity` included), snapshots of treasury and platform bps, timeline, batch caps and totals, and running payout totals (`tokens_claimed`, `quote_refunded`) | never |
| Launch authority | `["authority", launch]` | DBC pool creator, partner/fee claimer, leftover receiver; owner of the DAMM v2 LP position and the fee ATAs | data-less |
| Batch authority | `["batch", launch]` | owner of the batch escrows (wSOL ATA, base ATA); payer of the batch swap | data-less |
| DBC config | `["dbc-config", launch]` | Meteora `ConfigWithTransferHook`, created by CPI with this PDA as the signing `config` | owned by DBC, immutable |
| Hook authority | `["hook-authority"]` | the only signer `noised_hook::create_policy` and `end_snipe_shield` accept | data-less |
| `Certificate` | `["certificate", base_mint]` | the launch certificate (SPEC §1.5); version 4 adds the attested `rules_hash` and the informational `RULES_BOUND` bit (4,096) next to the twelve required checks (4,095) | never |
| `Commit` | `["commit", launch, owner]` | one participant's commitment, `claimed` flag and payout owners (`token_owner`, `refund_owner`) | never |
| `PayoutVault` | `["payout-vault", launch, vault]` | what every commit naming that PQ vault as token owner committed, held to `batch_wallet_cap` | never |
| `Identity` | `["identity", SHA256(0x21 ‖ lms_pk)]` | a creator's LMS public key and the bitmap of its 1,024 one-time leaves, shared by `attest_launch` and `pq_authorize` | never |
| `Attestation` | `["attestation", launch]` | the launch's attestation (version 3, 2,708 bytes): identity, leaf, metadata hash, rules hash, message hash, slot, window and the full 2,508-byte signature; overwritten whole by the next attestation of the same identity once its window has passed with the launch still `Configured` (audit round 3, F1); never changed once the launch is `Live` | never |
| `TokenMeta` | `["metadata", launch, metadata_hash]` | a metadata record (name, symbol, uri mode, optional external uri, document), at the address its content hashes to; only the one the attestation names is the launch's | never |
| `LaunchRules` | `["rules", launch, rules_hash]` | the creator's PXR1 launch rules (at most 1,228 bytes), verified for the launch's guard by `publish_rules` while the launch is `Configured`, at the address of `rules_hash = SHA256("PHX-RULES-V1" ‖ bytes)`; only the one the attestation names is installed | never |
| `Authorization` | `["auth", launch, [kind], payload_hash]` | one LMS-verified authorization by the launch's identity (version 1, 2,669 bytes): kind (1 activate a graph, 2 freeze, 3 revoke the operator), payload hash, message hash, landing time and slot, leaf and the full signature. Written once by `pq_authorize`; the launchpad gives the payload no meaning, the autopilot reads it | never |

### Hook PDAs (under `noised_hook`)

| Account | Seeds | Contents |
|---|---|---|
| ExtraAccountMetaList | `["extra-account-metas", mint]` | exactly two extra accounts: the policy PDA and the instructions sysvar. Created permissionlessly; no update instruction. |
| `HookPolicy` | `["policy", mint]` | version 2: pool, DBC base vault, timestamps, caps, p2p flag, up to 4 exempt owners, then the creator's launch rules (u32 length and bytes; empty for none), exactly the attested record's bytes; written once, only by the launchpad, whose `execute_batch` later moves the shield end earlier. Its fixed head (mint, base vault, `guard_end_ts`) is read before the rest (`PolicyHead`, review 4, R3) |

### Vault and shield PDAs

| Account | Seeds | Contents |
|---|---|---|
| `Vault` | `["vault", mint, genesis_key_id]` under `noised_vault` | mint, genesis key id, `sequence`, the current LM-OTS public key (`key_id`, `I`, `q`, `K`), `reserved`; owns ATA(vault, mint), the deposit address. Never closed; the address never changes. |
| `Payout` | `["payout", vault, u64le(sequence)]` under `noised_vault` | one signed withdrawal waiting for delivery: recipient wallet, amount, rent payer. Closed by `release` / `release_to`. |
| `Shield` | `["shield", base_mint]` under `noised_shield` | base mint, token program, zToken mint, escrow |
| Shield authority | `["shield-authority", base_mint]` | zToken mint authority and escrow owner |
| zToken mint | `["z-mint", base_mint]` | Token-2022 mint with ConfidentialTransferMint, MetadataPointer, TokenMetadata |

### Autopilot PDAs (under `noised_autopilot`)

| Account | Seeds | Holds / does | Closed? |
|---|---|---|---|
| `Autopilot` | `["autopilot", launch]` | version 1, 1,244 bytes: the launch, its bound mint and DAMM v2 pool, the active graph and a queued one (`activate_at`, operator), `frozen`, the operator, the latest authorization used per kind, the reference price with its rise allowance, two 15-minute observation buckets, tip counters and each node's run state; since audit round 4 also the running graph's activation (`active_auth`, `active_activate_at`) and what keepers' partial buybacks moved per node (`partial_spent`). Created by `init_autopilot` | never |
| Treasury authority | `["treasury", launch]` | data-less; owns the treasury's wSOL ATA (SPL Token) and token ATA (Token-2022) and signs only the autopilot's own CPIs. Derivable before the launch exists, so `create_launch` can name it as a fee recipient | data-less |
| Treasury accounts | ATA(treasury, wSOL), ATA(treasury, mint) | the treasury's balances; the wSOL ATA is created by `init_autopilot` (or by `distribute` if the treasury is a fee recipient), the token ATA by `bind_mint`. Never closed, delegated or re-owned | never |
| `GraphRecord` | `["graph", launch, graph_hash]` | a PXG1 graph (78 + len bytes, at most 2,044 bytes of graph) verified by `publish_graph` at the address of `graph_hash = SHA256("PHX-GRAPH-V1" ‖ bytes)`; activating it needs an `Authorization` | never |

## 4. Who holds which power

Nothing that matters is held by a private key after `launch`. The one Ed25519 key that can be named afterwards, an autopilot graph's operator, chooses only the timing and amount of its own nodes inside bounds the program checks.

| Power | Holder | Notes |
|---|---|---|
| Mint new base tokens | nobody | mint authority None. Checked live in `launch` (`checks.rs::inspect_mint`). |
| Freeze accounts | nobody | freeze authority None |
| Change name, symbol, URI or the metadata document | nobody | metadata update authority and pointer authority None; the on-chain metadata record (`TokenMeta`) is never modified or closed, and the certificate names the one the identity attested |
| Change or remove the transfer hook | DBC pool authority `FhVo3mqL…` until graduation, then nobody | `launch` requires this exact authority. DBC 0.2.1 uses it only to revoke the hook when the curve completes. A future DBC release could add an operator revoke (draft PR #214). |
| Claim DBC trading fees and surplus | launch authority PDA, so effectively anyone through `claim_fees` and `claim_surplus` | proceeds can only go to the launch authority's wSOL ATA, then out through `distribute` |
| Own the DAMM v2 LP position | launch authority PDA | the launchpad has no instruction that removes liquidity |
| Write a hook policy | launchpad, through the hook-authority PDA | only inside `launch`, with the attested rules; `execute_batch` only ends the shield early |
| Make a launch go live | anyone, but only with an attestation by the launch's post-quantum identity and only inside the window it signed | the creator's wallet has no say after `create_launch` |
| Choose a launch's name, symbol, document and uri mode | the identity, by signing the record's hash | the record is on-chain at the address of its hash and never changes |
| Choose the launch rules | the identity, by signing their hash (attestation message v3) | `launch` installs exactly the attested record's bytes in the hook policy, re-hashed and re-read. The rules can only refuse more transfers, only before `guard_end_ts`, and never see a sell, a claim, the batch buy or a holder's exit through the vault or shield. Nobody can change them afterwards. |
| Change the autopilot graph | the identity, through `pq_authorize` (kind 1) and `activate` | a first graph may start at once; a replacement takes effect at least 72 hours after it became visible. Never after `freeze`, which needs the identity's kind-2 authorization and is usable only until its signed `not_after`. |
| Run a due autopilot node | anyone (keepers, for a bounded tip); an operator-gated node only the graph's operator | only when its trigger, condition, budget and runs per epoch allow, for at most `min(p1, budget left, treasury)`; a buyback also within the price bounds |
| Move treasury funds | nobody, except through `run` | burns of treasury tokens, buyback-and-burn on the bound pool, the active graph's recipients' wSOL ATAs and the caller's tip. No withdraw, close, approve or set-authority instruction exists; the treasury never sells the token. |
| Revoke the autopilot operator | the identity (kind-3 authorization; anyone lands `revoke_operator`) | also on a frozen graph; nothing signed before the revocation gives the operator power back; a revocation names the activation it revokes, so an operator appointed again can be revoked again (audit round 4) |
| Burn a leaf of an identity | whoever lands a valid signature of that identity | a leaf is accepted once, ever, by `attest_launch` or `pq_authorize` (one bitmap); every valid signature can land |
| Buy during the snipe shield | nobody but the launch's own `execute_batch` | checked by the hook from the instructions sysvar |
| Set the treasury and platform fee | the launchpad's upgrade authority, once | `initialize_protocol` checks `ProgramData.upgrade_authority_address == signer`; the treasury must be a wSOL PQ vault |
| Choose where a commit's tokens and refund go | the committer, at its first commit (itself or its PQ vaults of the right mints) | fixed afterwards; `claim` pays only them |
| Reserve a vault payout | holder of the vault's current LM-OTS key, one signature per key | relayers cannot alter a signed withdrawal; the key rotates in the same instruction |
| Deliver a vault payout | anyone (`release`, to the signed recipient's canonical ATA) or the signed recipient (`release_to`, to any of its token accounts of that mint) | the payout's recipient is fixed by the signature |
| Mint zTokens | shield authority PDA, only inside `wrap`, exactly what the escrow received | |
| Upgrade our programs | our upgrade authority, until it is set to None | see [OPERATIONS.md](OPERATIONS.md#release-and-finalization) |

The `creator` recorded in `Launch` and `Certificate` is informational only (it is part of the attestation and authorization messages and of the `Launch` address). After `create_launch` it has no powers: the identity attests and authorizes, and anyone launches and lands authorizations.

## 5. Money flows

```
commit:        committer wSOL account -----------------------> batch wSOL escrow (ATA of batch authority)
execute_batch: batch wSOL escrow -> DBC quote vault (at most min(total, cap));  DBC base vault -> batch base escrow   (one swap)
claim:         batch base escrow -> token owner's base ATA (floor(tokens_out * c / total))   (the committer or its PQ vault)
               batch wSOL escrow -> refund owner's wSOL ATA (floor((total - spent) * c / total)); expired: c
trading:       traders <-> DBC vaults; fee taken in wSOL; DBC keeps 20% for Meteora, 80% accrues to the partner (launch authority)
claim_fees:    DBC partner trading fees (wSOL) ---------------> launch authority wSOL ATA
claim_surplus: after completion, partner + creator surplus ---> launch authority wSOL ATA
migration:     DBC vaults -> DAMM v2 pool (Meteora keeps 0.2%); unsold base burned; LP NFT -> launch authority, permanently locked
claim_lp_fees: DAMM v2 position fees ----> launch authority wSOL ATA (+ base ATA)
distribute:    launch authority wSOL -> treasury wSOL ATA:   floor(balance * platform_fee_bps / 10_000)   (the treasury vault's token account)
                                     -> recipient wSOL ATAs: floor(rest * bps / 10_000), last recipient takes the remainder
               launch authority base tokens -> burned (burn_checked)

vault:         anyone -> ATA(vault, mint) (deposit, never moves)
               withdraw: no token moves; reserved += payout amount
               release / release_to: ATA(vault, mint) -> recipient's account (payout amount); reserved -= amount

autopilot treasury (["treasury", launch] under noised_autopilot):
funding:       distribute -> treasury wSOL ATA (when create_launch named the treasury a fee recipient); anyone's donations
run BUYBACK_BURN: treasury wSOL ATA -> bound DAMM v2 pool's wSOL vault (exactly the amount);
               pool's token vault -> treasury token ATA (at least min out), every token received burned in the same instruction
run BURN:      treasury token ATA -> burned (burn_checked)
run DISTRIBUTE_SOL: treasury wSOL ATA -> each declared recipient's canonical wSOL ATA: floor(amount * bps / 10_000); dust stays;
               a recipient with no wSOL account of its own there is skipped, its share stays (audit round 4)
tip (each run): treasury wSOL ATA -> a wSOL account the caller names: min(100,000 lamports (a partial buyback: its share),
               what is left of 5,000,000 lamports this UTC day, 10% of the value the run moved, the treasury's wSOL
               after the action); a burn before graduation is worth nothing
```

- **Rounding.** Every division rounds down (`math.rs::pro_rata`). The sum of payouts therefore never exceeds what is held. Batch dust stays in the escrows forever: less than one base unit per participant per asset. The `Launch` running totals bound every claim.
- **Oversubscription.** `execute_batch` offers `min(total_committed, batch_total_cap)` to the swap, and the claim formula refunds `total - spent` pro rata, so commits above the cap are refunded in the same proportion for everyone.
- **Meteora's share.**
  - DBC: 20% of every trading fee. A referrer gets 20% of that share when a referral account is passed; Noised's batch passes none. DBC also takes 20% of the post-completion surplus and 0.2% of migrated liquidity.
  - DAMM v2: the protocol fee on post-graduation trading fees.
  - None of this is controlled by Noised (FACTS #28, #29).
- **Surplus.** Quote above the graduation threshold (from the last partial-fill buy) is not added to the pool. The partner's 80% of it reaches the launch authority and is distributed like trading fees.
- **Snapshots.** Each `Launch` stores copies of the treasury and `platform_fee_bps` taken at creation. `Protocol` cannot change anyway, and the copies make every launch self-contained.
- **Autopilot bounds.** A run moves at most `min(p1, budget left this epoch, treasury balance)`. A keeper moves that maximum, except that it may run a buyback for less, down to 1% of the pool's wSOL; such a partial run leaves the node due for the rest and earns only its share of a tip (audit round 4); an operator chooses any amount up to it on its own nodes. A buyback needs observations of the pool spanning at least 60 s in the last 15 to 30 minutes, is refused when the pool price is above `bound × (1 + premium)` with `bound = min(reference price, lowest observed price)`, and sets a minimum out priced at that limit. The reference starts at the launch's migration price, rises at most about 5% per hour and falls at once. The treasury never sells the token. A tip's value counts lamports swapped or paid, or tokens burned at the lower of the reference and the lowest observed price (nothing before graduation) (SPEC §9; [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md) AP1, AP2, AP5).

## 6. CPI graph and depth budget

The runtime allows an instruction stack depth of 5: the top level plus 4 nested CPIs (FACTS #4).

| Path | Depth |
|---|---|
| launchpad `execute_batch` (must be top level) -> DBC `swap2_with_transfer_hook` -> Token-2022 -> `noised_hook::execute` | 4 |
| launchpad -> DBC `initialize_virtual_pool_with_token2022_transfer_hook` -> Token-2022 / System | 3 |
| launchpad -> `noised_hook::create_policy` -> System | 3 |
| launchpad `execute_batch` -> `noised_hook::end_snipe_shield` | 2 |
| launchpad `attest_launch` / `publish_metadata` / `publish_rules` / `pq_authorize` -> System (account creation) | 2 |
| launchpad -> Token-2022 `transfer_checked` (batch claim) -> `noised_hook::execute` | 3 |
| launchpad -> DAMM v2 `claim_position_fee` -> Token-2022 / SPL Token | 3 |
| vault `release` -> ATA program -> token program / System (recipient ATA, if missing) | 3 |
| vault `release` / `release_to` -> SPL Memo (if the destination requires memos), then -> token program -> hook (if any) | 3 |
| shield -> token program -> hook (if any) | 3 |
| autopilot `run` (buyback) -> DAMM v2 `swap` -> SPL Token / Token-2022 (no hook: DBC revoked it when the curve completed, before any pool can be bound) | 3 |
| autopilot `run` -> Token-2022 `burn_checked` (buyback, burn) / SPL Token `transfer_checked` (distribution, tip) | 2 |
| autopilot `init_autopilot` / `bind_mint` -> ATA program -> SPL Token or Token-2022 / System (treasury accounts, if missing) | 3 |
| autopilot `init_autopilot` / `publish_graph` -> System (account creation) | 2 |

Consequences:
- The hook makes no CPI and must never make one. The creator's rules run inside it, on the accounts it already has; it reads the mint's supply and the transaction's top-level instructions for them only when a transfer reaches the rules under a policy that has rules (review 4, Rb).
- The autopilot calls neither the launchpad nor the hook: it reads the launchpad's accounts by layout (§7).
- `execute_batch` must be the top-level instruction: the hook identifies the batch buy by the transaction's current top-level instruction, so another program calling `execute_batch` by CPI gets the buy refused. The spare fifth level therefore matters only for other paths, such as a router in front of a public DBC trade (router -> DBC -> Token-2022 -> hook = 4).
- No new layer may ever be inserted between the launchpad and DBC.
- Indirect reentrancy (A -> B -> A) is rejected by the runtime.

Every CPI target is one of two kinds:
- a declared constant (`declare_id!`, `declare_program!` with the Meteora IDLs vendored in `idls/`, the ATA program, the vault's `MEMO_PROGRAM_ID`, whose account is also address-constrained, or the fixed DAMM v2, Token-2022 and SPL Token ids the autopilot's `cpi.rs` invokes);
- a token-program account that Anchor has checked against the SPL Token and Token-2022 IDs (`Interface<TokenInterface>`).

Our programs never invoke a hook's `execute` themselves: Token-2022 calls the hook named in the mint's `TransferHook` extension, and re-derives and checks its extra accounts. (The launchpad's CPIs into `noised_hook` for the meta list and the policy go to the declared constant.)

No program ID is ever taken unchecked from an account.

## 7. How child accounts are bound to parents

| Check | Where |
|---|---|
| `Launch` PDA from the creator and a client-chosen 32-byte seed; `init` fails on reuse | `create_launch` |
| Identity PDA from the hash of the signing key; attestation PDA from the launch; the metadata record from the launch and the signed hash; any other account fails `attest_launch` (`ConstraintSeeds`) | `attest_launch` |
| `launch` loads the attestation with its stored bump and the record at `["metadata", launch, attestation.metadata_hash]`; launch, identity, version and hash re-checked | `launch` |
| Rules record at `["rules", launch, SHA256("PHX-RULES-V1" ‖ bytes)]`, verified for the launch's guard, launch `Configured`. `attest_launch` takes the record the signed rules hash names (the program id for the zero hash) and attests only if it is valid (owner, discriminator, version 1, launch, hash, canonical bump; `pq::is_rules_record`), else the signature only burns its leaf | `publish_rules`, `attest_launch` |
| `launch` takes the record at `["rules", launch, attestation.rules_hash]`, present exactly when that hash is not zero, re-hashes its bytes against the attested hash (review 4, R6a), and passes them to `create_policy`, which verifies them for the policy's guard (`InvalidRules`); the policy re-read must hold them byte-equal, with every other field | `launch`, `noised_hook::create_policy` |
| Authorization at `["auth", launch, [kind], payload_hash]`; identity PDA from the signing key, the same leaf bitmap as attestations; written only into an empty address, only for the launch's own identity and kinds 1 to 3 (review 4, Ra), else burn-only | `pq_authorize` |
| Payout owners: the committer or a vault-program account with the `Vault` discriminator, version 4 and the paid mint; the treasury: such a vault of wSOL | `pq::is_payout_owner`, `pq::is_vault_of` |
| launch authority, batch authority and DBC config are PDAs of the `Launch` key | account constraints |
| `quote_mint == wSOL`, `hook_program == noised_hook` (executable), `dbc_program == DBC`, `dbc_event_authority` pinned | `create_launch` constraints |
| The DBC config re-read after creation must hold every fixed value of SPEC §1.2; certificate flags 64/128/256/512 come from it | `checks.rs::inspect_config` |
| The pool must reference this config, mint and vaults, and its creator must be the launch authority | `checks.rs::inspect_pool` |
| Mint post-conditions (owner, authorities, exact extension set, hook program and authority, decimals, supply > 0); certificate flags 1-32 come from them; the mint's TokenMetadata equals the record's name, symbol and derived uri (flag 2048) | `checks.rs::inspect_mint`, `checks.rs::verify_token_metadata` |
| Fee recipients: 1 to 4, distinct, non-default, not the launch's own PDAs, bps > 0 summing to 10,000 | `policy.rs::validate_recipients` |
| Recipient fee accounts and claim accounts must be the canonical ATAs of the stored wallets or the committer; created if missing; owner field not compared | `token_util.rs::AtaCreator::ensure` |
| Hook accounts of `execute_batch` and `claim`: exactly `[meta list, policy, instructions sysvar, hook program]` for the launch's mint | `hook_accounts.rs` |
| Hook policy keyed by mint; `policy.mint` re-checked in `execute`, from the fixed head (discriminator, length >= 130, mint, base vault, `guard_end_ts`) before the rest is decoded; base vault derived from (mint, pool) under DBC; pool must be DBC-owned; stored rules that do not parse refuse (fail closed) | `noised_hook::create_policy`, `execute` |
| The autopilot reads the launchpad's accounts by layout: owner, discriminator, version and length checked before any field. `Launch` only at version 2 (length >= 585); `Certificate` at `["certificate", mint]`, versions 3 and 4, for this launch and mint, with `(checks & 4095) == 4095`; `Authorization` version 1, exactly 2,669 bytes, at the address re-derived from its stored bump, for this launch, by the launch's `pq_identity`, of the kind and payload hash the instruction expects. Later versions are refused until the autopilot is updated (review 4, R6b) | `noised_autopilot` `launchpad.rs` |
| `Autopilot`, treasury authority and graph records are PDAs of the launch; a graph record is content-addressed (`SHA256("PHX-GRAPH-V1" ‖ bytes)`) and verified before it is written; `run` loads only the active graph's record, `apply_pending` only the queued one's | `init_autopilot`, `publish_graph`, `run`, `apply_pending` |
| `init_autopilot`: the DBC config must be the launch's `dbc_config`, DBC-owned, with wSOL as quote; the reference price starts at its migration price | `init_autopilot`, `external.rs` |
| `bind_pool`: `damm_config` is a DAMM v2 `Config` (owner DAMM v2, 328 bytes) whose `pool_creator_authority` (offset 40) is DBC's pool authority `FhVo3mqL…`; `damm_pool` is its existing pool `["pool", config, max(mint, wSOL), min(mint, wSOL)]` of the bound mint and wSOL | `bind_pool`, `external.rs` |
| `run`: treasury accounts are the treasury authority's canonical ATAs; the pool is the bound one; a buyback's remaining accounts are DAMM v2's pool authority, that pool's own two vaults, its event authority and program; a distribution's are the active graph's recipients' canonical wSOL ATA addresses in graph order, whether or not an account exists there; a recipient is paid only if its address holds an initialized wSOL account it owns, else skipped (audit round 4) | `run` |
| Vault PDA keyed by the genesis `key_id = SHA256(0x20 \|\| pubkey)`; `open_vault` re-derives it; the next key is checked against the signed next key id | `noised_vault` |
| Payout PDA keyed by (vault, sequence); `has_one` vault, recipient and rent payer; `release` re-derives the recipient's canonical ATA | `noised_vault` |
| Shield accounts keyed by base mint; `has_one` on mint, token program, zToken and escrow | `noised_shield` |

Certificate flags are set only from these live checks, never from the requested parameters; `RULES_BOUND` only when the re-read policy holds exactly the attested record's non-empty bytes. The SDK's `verifyLaunch` re-checks the live accounts anyway, the bound rules included (SPEC §1.5).

## 8. Design decisions

| Decision | Why | Rejected alternative |
|---|---|---|
| A thin launchpad program in front of Meteora DBC (FACTS option 4.1-A) | DBC is permissionless, audited and CPI-friendly with PDAs in every role. Migration to DAMM v2 is permissionless. | Forking DBC/DAMM v2 to make them immutable is forbidden by Meteora's non-commercial licence (FACTS #44). An AMM of our own would be a large new audit surface and no longer "on Meteora". |
| DBC transfer-hook configs | The snipe shield and launch guard need a transfer hook. DBC removes it at graduation, which DAMM v2 requires (FACTS #25, #35). | Plain Token-2022 configs: no way to stop sniping before the fair open. |
| Every DBC role held by PDAs of the launch | No key can claim fees elsewhere, withdraw LP, mint or change metadata. A PDA has no private key to steal or quantum-forge. | Creator-held roles, as on most launchpads |
| Fair-open pro-rata batch instead of anti-sniper fees | One price for everyone; splitting wallets gains nothing. Elsewhere, decaying sniper fees are often paid to the creator, making self-sniping free (FACTS #68). The fee schedule must end before the batch (`FeeScheduleTooLong`). | High-cliff fee schedules |
| Oversubscription filled pro rata (`amount_in = min(total, cap)`) | Commit order, and a commit bundled with `launch`, give no advantage. | A first-come-first-served total cap (before audit round 1): the creator could fill it inside the launch transaction |
| The shield admits the batch buy by instruction introspection | Only a buy inside the launchpad's top-level `execute_batch` passes, which nobody else can produce (HOOKS.md §2). | Exempt owners opening the shield (before audit round 1): anyone can open a token account owned by an exempt PDA, so a cheap buy could move the price and the batch's volatility fee |
| The shield refuses zero-amount buys too | DBC executes a buy whose output rounds to zero, and it still moves the price and the volatility accumulator; on a dust first curve segment, 2 lamports saturated the batch's dynamic fee. | Passing every zero-amount transfer (round 1): only the transfer is empty, not the swap |
| `execute_batch` runs only as the pool's first swap (`has_swap == 0`) | A second, independent layer: if anything ever traded the pool before the batch, the batch refunds in full instead of buying at a moved price or fee. With the hook refusing every earlier buy, it fires only if the hook layer fails. | A minimum-output or zero-accumulator check in `execute_batch` as the only defence, which the auditors warned against: one cheap buy would then force every batch to expire |
| Fee ceiling after the schedule: floor + max volatility fee <= 10% | DBC allows 99%, which would make selling after the batch economically impossible. Enforced by `policy.rs::within_fee_ceiling`. | Trusting DBC's 99% bound |
| wSOL quote | No freeze authority, no badge, no transfer fee. SPL Token has no upgrade authority. | USDC: its issuer can freeze the pool's quote vault (FACTS #33) |
| Quote-only fee collection (`collect_fee_mode = 0`) | Base tokens leave the DBC vault only through swaps, so the hook never sees fee transfers. All fees are wSOL. | Output-token fees |
| Dynamic supply (`token_supply = None`) | Unsold tokens are burned at migration. Nobody receives leftovers. | Fixed supply with a leftover receiver |
| No creator allocation | No insider supply, and no dependency on the upgradeable Jupiter Lock (FACTS #43) | DBC `locked_vesting` |
| 100% permanently locked LP, no creator or partner migration fee | Liquidity can never be pulled, and the raise goes into the pool minus only Meteora's fixed 0.2% (and 20% of any surplus) | DBC's minimum (10% locked for one day; FACTS #27). Trade-off: if Meteora disables the DAMM v2 pool, the liquidity is stuck forever (FACTS #37). |
| Pool created by CPI | `enable_first_swap_with_min_fee` is off and impossible through CPI anyway: no creator first-swap privilege | Top-level DBC init with introspection |
| One audited, bounded hook; no custom hooks | DBC accepts any executable as a hook with no immutability check. A bad hook can strand a pool forever (FACTS #26). See [HOOKS.md](HOOKS.md). | User-supplied hook programs |
| Certificate per mint + independent verifier | A cheap on-chain registry of what was checked at launch. Pools created by others on a Noised config (DBC configs are permissionless, FACTS #21) have no certificate. | Off-chain lists |
| `initialize_protocol` gated on the upgrade authority | Cannot be front-run, runs once, no update instruction. Must run before finalization. | First-caller initialization |
| Claim ATAs validated without comparing the owner field | Only the committer can reassign its own ATA, so nobody else can block its claim, and a reassigned wSOL ATA no longer strands tokens and refund. | Anchor's ATA constraint (before audit round 1), which refused a reassigned ATA forever |
| PQ vault on LM-OTS `LMOTS_SHA256_N32_W4` in V1 transactions | Standardized in RFC 8554 (the parameter set is also listed in NIST SP 800-208; POST_QUANTUM.md §3.2 says what that does and does not mean) with test vectors; about 128-bit generic quantum security. Signature verification is about 70k CU typical and at most about 140k (model); the whole `withdraw` measured about 79k–106k CU. The withdrawal fits the 4,096-byte V1 limit: 2,693 bytes alone, at most 2,977 with `release` (measured; FACTS #6, #62). | WOTS+C n = 24 (category 3, ~0.3M CU), used before V1 transactions went live; its crate has been removed |
| Vault key rotates in place, with a sequence number | The vault address and its token account never move, so deposits always land in one place, a fixed transfer fee is charged only on payouts, and there is no ordering hazard between vaults. | A chain of successor vaults (v3): every withdrawal moved the remainder (and paid fees on it), late deposits needed `sweep`, and a spent successor stranded the previous vault's signed withdrawal |
| `withdraw` only reserves; delivery is a separate `release` / `release_to` | A revealed one-time signature must always remain executable, so nobody is tempted to sign twice. `withdraw` touches nothing a third party controls; a recipient can only delay its own payout. | Paying inside `withdraw` (v3): the recipient could make the signed withdrawal fail forever through its own account state |
| Payout pays `min(max_amount, unreserved balance)` | The signed amount is a maximum, so a signature never fails for lack of funds. | Exact amounts |
| Shield as a separate 1:1 wrapper | AMMs cannot trade confidential mints and DBC cannot create them (FACTS #55). Privacy stays opt-in and reversible. | Confidential launch tokens |
| Shield requires `escrow >= zToken supply` rather than equality | Donations into the escrow and direct zToken burns cannot be prevented. Equality would let a 1-unit donation brick every wrap and unwrap (`token.rs::require_backed`). | Strict equality |
| Every launch attested by a post-quantum identity, verified on-chain (PQ v2) | After an elliptic-curve break, the creator's wallet key no longer decides what launches, under which metadata or when. LMS H10/W4: 1,024 leaves per identity, a 2,508-byte signature that fits a v1 transaction with its accounts, under 115k CU measured. | An identity derived from the wallet (a secret any approved signing request reveals, with a classical link to its owner); a proof of origin in off-chain metadata, which nothing on-chain checks |
| Every valid signature lands and burns its leaf; only the right one attests | A revealed one-time signature can always be consumed, so a client is never left with a leaf that a second message could reuse (PQ v2 adversarial review, finding 1). | Validating first and refusing (the leaf stayed clear and a corrected retry reused it) |
| A signed launch window; `launch` permissionless inside it | No classical key decides when a launch opens (finding 2). The residual is explicit: the first transaction to land wins. | A creator-signed `launch` |
| Metadata as an on-chain, content-addressed record, signed by the identity | Every byte any reader displays is on-chain and signed; no hosting, DNS or TLS is involved. One v1 transaction writes the whole record; it is never modified. The mint's uri is empty by default. | A metadata link to https or IPFS hosting; a signed hash of an off-chain document; chunked writes with a seal step; Token-2022 additional metadata |
| Payout owners fixed at the first commit; a payout vault held to one wallet's cap | Batch shares can land straight in PQ custody, and nobody can redirect them afterwards; one vault cannot collect more than one wallet could. | An owner-signed `claim_to` (pre-emptable by the permissionless `claim`, and an Ed25519 power until claim time) |
| The treasury is a wSOL PQ vault | The platform's share is under post-quantum custody from day one; the treasury can never change. | Any wallet as treasury |
| 60-second minimum commit window; 600-second execution window ended by the batch | Excluding commits or the batch by write-lock contention costs linearly more; trading still opens at the batch. | 10 s and 30 s windows (round 2: cheap to block) |
| Batch-cap floors | A creator cannot shrink the fair open to dust while every other check passes. | No on-chain lower bound (round 1, accepted then; round 2, C0) |
| Vault key-index binding | A spent one-time key can never be reinstalled. | Comparing the next key only with the current one (round 2, C5) |
| An attestation whose window passed unused can be replaced; a window needs 60 s left when its attestation lands (audit round 3, F1) | A window kept free of `launch` (write-lock contention, congestion, an outage) or an attestation landed in its last seconds becomes a retry at the next leaf instead of a launch that can never go live. Only the identity's signature sets a window, and an expired window never reopens. The cost: an older signature that never landed can take a freed slot, a delay to a window the creator signed (clients land or burn every signature they reveal). | A write-once attestation (round 3, R3-1); an admin reset |
| Guarded transfers only into token accounts whose owner cannot change (audit round 3, F2) | An owner change moves no tokens and so never reaches the hook; requiring `ImmutableOwner` on the destination while the guard is on (except for accounts an exempt launchpad PDA owns) keeps the wallet-to-wallet lock and max-wallet meaningful. Token-2022 ATAs always have it. Read from the destination's own data, so the hook's account list and the policy layout stay the same. It does not cover changes of control without a transfer: shared wallets, PDA and smart-wallet owners, a PQ vault's key rotation, delegates (HOOKS.md §9). | Documenting the gap only (round 3, R3-4) |
| Creator launch rules as verified bytes in the one audited hook, evaluated last, able only to refuse | Creators get anti-bot limits, caps, wallet lists and time windows without a hook of their own. The rules are data (PXR1, at most 1,228 bytes) verified by the launchpad and again by the hook, signed by the identity (message v3) and installed byte-exact. They run after every built-in allow and denial, only before `guard_end_ts`, and the first rule that refuses wins (`RuleDenied`). Programmable is a disclosed tag, not a safer level: rules can restrict buys to listed wallets for the guard, and vacuous rules still set `RULES_BOUND` (THREAT_MODEL R33, R34). | Custom hook programs per launch (FACTS #26: a bad hook can strand a pool); rules that can allow what a built-in refuses |
| Holders' exits skip the creator rules (review 4, R1) | A transfer whose current top-level instruction is the Noised vault or shield is decided by the built-ins alone, so a creator's rules can never hold vault releases or shield wraps and unwraps. Residual: routing tokens through the vault or shield (for example wrap, move zTokens, unwrap) gets past anti-bot rules, never the built-ins (R35). A CPI into the vault or shield from another program is still subject to the rules. | Rules applying to vault and shield exits, which would let a creator freeze PQ custody and privacy exits for the whole guard |
| Sells and the guard's end decided from the policy's fixed head (review 4, R3) | `execute` decides "no policy", "another mint's policy", a sell and "after the guard" from fixed offsets before decoding the rest of the policy, so no layout or version problem in a policy can block a sell or any transfer after the guard. | Decoding the whole policy before every decision |
| The autopilot as a separate program with a PDA treasury, a closed action catalogue, keepers paid by capped tips, and a slow reference price checked against observations | Creators can promise "buy back and burn daily" or "pay these recipients" and nobody, the creator included, can do anything else with the treasury: three actions, per-run and per-epoch caps, DAMM v2, Token-2022 and SPL Token at fixed ids. Buybacks are priced against `min(reference, lowest observed price)` plus a premium, so a keeper's sandwich gains at most about premium x amount. It calls neither the launchpad nor the hook; the launchpad only writes the authorizations it reads. | Spot-price buybacks; an admin or pause key; arbitrary CPI or user-defined actions; automation inside the launchpad |
| Graph changes only through LMS authorizations, a 72-hour timelock, and a freeze that expires unused (review 4, R5) | No Ed25519 key can change what a treasury does. Each change is an `Authorization` the launchpad writes after verifying the launch identity's signature (`pq_authorize`, the attestation's leaf bitmap), used at most once and never after a newer one it could undo; holders see a replacement 72 hours ahead; a freeze is final, and usable only until the `not_after` it was signed with, so a withheld freeze cannot be landed much later. | The creator's wallet as graph admin; a freeze authorization without expiry (before review 4) |
| `RULES_BOUND` (4,096) is informational; `checks::ALL` stays 4,095 | A launch with rules carries 8,191, one without 4,095, and both pass `(checks & 4095) == 4095`. The bit says rules are bound, not that the launch is safer. | Changing `ALL`, which would break every client that compared `checks` exactly |

## 9. Off-chain components

| Component | Role | Trust |
|---|---|---|
| `sdk/` | API per SPEC §4.1. Transaction builders and the planned launch flow. `verifyLaunch(connection, mint)` re-checks every certificate flag, the DBC config, the hook policy, the batch caps, the phase and, after migration, the LP lock, the hook revocation and the pool's fee against live state, re-verifies the launch's LMS attestation and the bound rules (`report.rules`), and lists the trusted third parties. Also PQ identity and vault key derivation (phrase or passkey), the durable one-signature ledgers, deterministic signers, recipient and pending-withdrawal checks, and the shield client. 0.6 and 0.7 (unreleased) add the programmable module `@noisedlabs/sdk/programmable` (rules and graph builders, text language, verify, explain, simulate), attestation v3 and `publish_rules`, certificate v4 (`certificateChecksComplete`), `buildPqAuthorizeTx` and the graph activation flow, the autopilot's accounts and builders, keepers (`planKeeperStep`, `runKeeper`) and `planQuickLaunch`; 0.8 (unreleased) follows review 4 (freeze payload v2 and the freeze flow; "programmable" is a tag shown next to the QSL-1 level, never a level). | Runs on the user's machine and needs only an RPC endpoint. A lying RPC can lie about state; cross-check with a second RPC for large decisions. |
| `app/` | Per SPEC §5. Static Vite + React site, deployable to IPFS. Strict CSP, no third-party scripts. Shows program IDs and simulates every transaction before asking to sign. Two ways to launch: **Quick launch** (one short form; the creator's fee share goes to its wallet, to a daily buyback-and-burn by the launch's autopilot, or split) and **Custom launch** (the full wizard: price curve, fee schedule, launch rules, an optional autopilot graph). Launch rules and autopilots are shown in plain English. | A compromised build or DNS can show false data. Users can verify with the SDK or the CLI. |
| Keepers | Permissionless cranks: `launch` inside each attested window, `execute_batch` (top-level) in its 600 s window, `claim` for users, DBC `migration_damm_v2`, fee claims and `distribute`, vault `release` of pending payouts, and the autopilot jobs: `bind_mint`, `bind_pool`, `apply_pending`, `update_price` and due `run`s for a tip (OPERATIONS.md, Keepers). | Anyone can run them. No keeper holds a privileged key. Missing the batch window refunds everyone; missing a launch window means the creator signs a new window; a missed autopilot run only delays it; none loses anyone's funds. |
| `packages/noised-mcp` | A local stdio MCP server over the SDK for AI agents (Claude Code, Claude Desktop, LangGraph, any MCP client): reads launches, launch rules and autopilots, checks a token against QSL-1, simulates rules and autopilots, and builds unsigned autopilot transactions (`update_price`, `run`, `publish_graph`). LangGraph examples (an AI operator with human approval; a keeper with no LLM) are in `examples/langgraph-operator`. | It never signs and holds no keys; on-chain strings come back marked as untrusted data; it refuses mainnet unless `NOISED_ALLOW_MAINNET=1`. The guardrails are on-chain: an AI operator key can only choose timing and amount within the program's bounds, and the server only helps. |
