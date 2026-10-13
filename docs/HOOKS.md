# Hooks

Noised has two kinds of hook:

| Kind | What it is | Where it runs | When |
|---|---|---|---|
| **Launch Guard** | A Token-2022 transfer hook. Token-2022 calls it on every transfer of a launched token. During the guard it also applies the creator's launch rules, if the launch has any (§2). | `programs/noised-hook` | Only while the bonding curve runs. Meteora DBC removes it when the curve completes. |
| **Launch hooks** | Lifecycle steps of a launch: the fair-open batch, fee routing and burns. | `programs/noised-launchpad` | Before and after graduation. They are not in the token's transfer path, so they can never block a transfer. |

Creators customize both through bounded parameters, and the Launch Guard also through bounded rule bytes their post-quantum identity signs. They cannot plug in their own hook program. Section 6 explains why. Post-launch automation of a launch's treasury (the Autopilot, `programs/noised-autopilot`) is not a hook: it is outside the transfer path and can never block a transfer (§8).

Normative details are in [SPEC.md](SPEC.md) §1. Facts are cited as "FACTS #n" from [research/FACTS.md](research/FACTS.md).

> **Audit round 1 (2026-10-08).** The snipe shield now admits only the batch buy, recognized from the instructions sysvar, and it is checked before exemptions. Before this change, anyone could buy into a token account owned by an exempt PDA during the shield, move the price and saturate DBC's volatility fee before the batch swap, and that extra fee went to the creator's recipients. The meta list gained a second entry (the instructions sysvar), and every hooked transfer the launchpad makes passes 4 hook accounts instead of 3.
>
> **Audit round 1b (2026-10-08).** A reviewer found that round 1 still let every zero-amount transfer through before the shield check. DBC 0.2.1 executes a buy whose output rounds to zero, and it still moves the price and the volatility accumulator: on a curve whose first segment held dust liquidity, a 2-lamport buy made the batch pay the floor fee plus the maximum dynamic fee. The shield is now checked before the zero-amount pass, so every buy is refused until the shield ends, whatever its amount, unless it is the batch buy, and a transfer out of the base vault is never treated as a sell. As a second layer, `execute_batch` runs only as the pool's first swap (`PoolAlreadyTraded`). See [AUDIT.md](AUDIT.md), round 1b.
>
> **Audit round 2 and PQ v2 (2026-10-09).** Anyone could keep the batch out of its 30-second window by filling the per-block write budget of the launch's accounts, so the execution window is now 600 seconds, and the batch ends the snipe shield itself: once `execute_batch` has bought, it calls the hook's new `end_snipe_shield`, which moves the shield's end to that moment and can only move it earlier. Public trading therefore opens at the batch, not at the end of the window. Commit windows are at least 60 seconds. `launch` is permissionless inside the window the creator's post-quantum identity signed, so T0 below is the moment that transaction lands. See [AUDIT.md](AUDIT.md) §8 and §9.
>
> **Audit round 3 (2026-10-10).** A token account without Token-2022's `ImmutableOwner` extension can be handed to another owner with `SetAuthority`, which moves no tokens and so never reaches the hook: positions bought into such accounts could change hands during a `p2p_locked` guard, and one owner could hold many accounts each at max-wallet. Fix F2 (merged): while the guard is on, the hook refuses a transfer that is not a sell into such an account (`MutableOwner`, 6010), unless an exempt launchpad PDA owns it (§2). The round also documented what max-wallet means for accounts many people pay into, and what the lock cannot see: control changing without a transfer (§9). See [AUDIT.md](AUDIT.md) §14.
>
> **Programmable launches and review 4 (2026-10-11).** A launch can carry the creator's launch rules (PXR1): at most 1,228 bytes of rules that the creator's post-quantum identity signs (attestation v3), that `launch` installs byte-exact in the hook policy (`HookPolicy` version 2) and that certificate v4 binds (`rules_hash`, informational bit `RULES_BOUND` = 4096). The hook applies them last, after every built-in check, so they can only refuse more buys and wallet-to-wallet transfers, and only until `guard_end_ts` (§2, "Creator launch rules"). Review 4 changed three things in the hook: holders' exits, where the Noised vault or shield is the top-level instruction, skip the creator rules (R1); sells and everything after the guard are decided from the policy's fixed head before the rest of it is decoded (R3); the mint's supply and the instructions sysvar are read only for transfers that reach the rules (Rb). Programmable is a disclosed feature, not a safer level. Post-launch automation, the new Autopilot program, never runs in the transfer path (§8). See [AUDIT.md](AUDIT.md) §15.

---

## 1. Why hooks exist only during the bonding curve

| Fact | Consequence | Source |
|---|---|---|
| A DBC transfer-hook config gives the mint a `TransferHook` extension whose authority is DBC's pool authority (`FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`). | Before graduation, only DBC can change the hook, and only a DBC upgrade could make it do anything except revoke. `launch` requires exactly this program and authority (`checks.rs::inspect_mint`). | FACTS #25 |
| The swap that completes the curve sets the hook's `program_id` to None, then its authority to None. | After graduation, Token-2022 never calls Launch Guard for this mint again. The token is a plain Token-2022 token with metadata. | FACTS #25 |
| DAMM v2 moves tokens with a 4-account `transfer_checked`. It forwards no hook accounts, even for badged mints. | An active hook could never trade on DAMM v2. DBC's revocation is what makes graduation possible. | FACTS #34, #35 |
| DLMM supports active hooks only for operator-badged mints, and its source is closed. | Not a permissionless path. Noised does not use DLMM. | FACTS #41 |

**Permanent hooks cannot exist on any permissionless Meteora path** (FACTS, hard constraint 1). Every Launch Guard rule therefore has a hard end time, and the whole hook disappears at graduation.

A future DBC version could also remove the hook early. Draft PR #214, which is not part of DBC 0.2.2 and not deployed, adds an operator instruction that revokes the hook of any hook pool before graduation with one operator signature (FACTS, follow-up on DBC 0.2.2). If Meteora ships it and an operator uses it on a Noised launch, the snipe shield and every guard rule end at once. Under DBC 0.2.1's swap logic, `execute_batch` would then fail, because it always passes hook accounts and DBC refuses them for a mint without a hook (`NoTransferHookProgram`), so the batch would expire and refund in full. A release that also dropped that check would not change the outcome for committers: any buy ahead of the batch sets the pool's `has_swap` flag, and `execute_batch` then refuses to run (`PoolAlreadyTraded`). That is a trust disclosure, not something the hook can prevent ([SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md#who-you-still-trust)).

## 2. Launch Guard rules

The launchpad writes one `HookPolicy` per mint, inside the `launch` transaction (`noised_hook::create_policy`). The creator chooses the values within bounds. Times count from the `launch` transaction (T0). If the creator's identity signed launch rules, the policy also holds their bytes, exactly as signed. Nothing in a policy ever changes afterwards, except that the launchpad's `execute_batch` ends the snipe shield at the batch (`end_snipe_shield`, below).

| Rule | Creator chooses | Effect | Ends at |
|---|---|---|---|
| Snipe shield | `open_delay_secs`: 60 s to 30 min | Every buy out of the DBC base vault is refused, whatever its amount, unless it happens inside the launchpad's top-level `execute_batch` instruction. That instruction makes exactly one swap, the batch buy. Neither exempt owners nor a zero amount open the shield. Result: the batch buy is the only buy before public trading, and `execute_batch` runs only as the pool's first swap. | the moment the batch executes, or `T0 + open_delay + 600 s` if it does not |
| Max buy | 0 (off), or at least 0.01% of the initial supply | A transfer larger than the cap is refused. | `guard_end_ts` |
| Max wallet | 0 (off), or at least 0.1% of the initial supply | A transfer is refused if the receiving token account would hold more than the cap. | `guard_end_ts` |
| Wallet-to-wallet lock | on / off | Every transfer that is neither a buy nor a sell is refused. It stops token transfers between holders' accounts; it cannot see control changing without a transfer (§9). | `guard_end_ts` |
| Immutable-owner destinations (audit round 3, F2) | nothing: always on during the guard | A transfer that is not a sell is refused (`MutableOwner`) if the receiving token account lacks Token-2022's `ImmutableOwner` extension, unless an exempt launchpad PDA owns it. Every associated token account has the extension, so buys, claims, vault `release` payouts and Shield wraps (the escrow is an ATA) pass; a buy, `release_to`, unwrap or wallet transfer into a hand-made account without it waits for the guard to end. | `guard_end_ts` |
| Creator launch rules (P1c) | PXR1 rule bytes signed by the creator's post-quantum identity: at most 16 rules, 8 wallet keys and 64 condition nodes (1,228 bytes); none by default | Can only refuse more buys and wallet-to-wallet transfers: time-windowed denials, per-transfer and destination-balance caps, wallet lists, top-level program and instruction-count checks. They never see a sell, a claim, the batch buy or anything the built-ins already allowed or refused. Below, "Creator launch rules". | each rule's window; all by `guard_end_ts` |
| Guard length | `guard_secs`: from `open_delay + 600 s` up to 72 h | All rules above stop. | `T0 + guard_secs` |

Bounds are enforced twice:
- `create_launch` checks them (`policy.rs::validate`); `publish_rules` verifies rules for the launch's guard (`InvalidRules`, launchpad error 6048).
- The hook checks its own hard limits again in `create_policy`: guard at most 72 h, shield at most 1 h (the longest schedule is 1,800 + 600 s), shield no longer than the guard, max-wallet at least supply/1000 when on, max-buy at least supply/10,000 when on, and rules that verify for the policy's own guard (`RuleSet::verify`, `InvalidRules`, 6012).

**Ending the shield at the batch.** `end_snipe_shield` is the hook's one instruction that changes a policy after it is written. It sets `snipe_shield_end_ts = min(snipe_shield_end_ts, now)` (`rules::shield_end_after_batch`), so the end can only move earlier, and changes nothing else: the guard rules and their end stay as written. Only the launchpad's `["hook-authority"]` PDA can sign it, the launchpad signs it only in `execute_batch` after the batch bought, for its own launch's policy, and the hook also requires the transaction's top-level instruction to be the launchpad's `execute_batch` (`NotInBatch`). It does not read the mint, so it works when the batch's swap completed the curve and DBC revoked the hook in that same swap. The certificate keeps the scheduled end; the live policy holds the actual one.

Caps are computed from the supply just after pool creation (`policy.rs::cap_from_bps`). A non-zero percentage that would round down to a zero cap is rejected, so a cap can never be disabled by accident.

The two launchpad PDAs (batch authority and launch authority) are exempt owners. A transfer to an account they own skips every later rule; a transfer from one skips the wallet-to-wallet lock and the caps, but its destination still needs an immutable owner (step 8 below). A buy during the shield is refused before exemptions are looked at (step 5). That is what lets batch claims pay out of the batch escrow at any time, into the committers' ATAs, while no exempt account can be used to buy early.

### Decision order in `execute`

The order is part of the safety argument. Code: `programs/noised-hook/src/lib.rs` (`execute`, `inside_execute_batch`, `top_level`), `src/state.rs` (`PolicyHead`) and `src/rules.rs` (`evaluate` = `built_ins`, then `creator_rules`).

A **buy** is any transfer whose source is the policy's DBC base vault, whatever its destination and amount. A **sell** is a transfer into the base vault from any other account.

Steps 1 to 4 are decided from the policy's fixed head before the rest of the policy is decoded (review 4, R3; `state::PolicyHead`): the account must start with `HookPolicy`'s discriminator and hold at least 130 bytes, and the hook reads only `mint` (offset 10), `base_vault` (74) and `guard_end_ts` (122). Every policy version has these fields at these offsets, so nothing stored after the head, the creator rules included, can block a sell or anything after the guard. Only a transfer that gets past step 4 decodes the whole policy.

| Step | Check | Result |
|---|---|---|
| 1 | The policy PDA is not owned by the hook program, or is empty | **allow**: the mint has no Noised policy (see §5) |
| 2 | The head's `mint` differs from the transferred mint | refuse (`PolicyMismatch`) |
| 3 | Not a buy, and either the destination is the base vault (a **sell**) or the amount is 0 | **allow**. Decided from account keys and the amount alone, before any token-account data is read and before the policy is decoded. |
| 4 | `now >= guard_end_ts` | **allow** |
| 5 | A buy, `now < snipe_shield_end_ts`, and the transaction's current top-level instruction is not the launchpad's `execute_batch` | refuse (`SnipeShield`), whatever the amount and whoever receives the tokens. Up to step 12, the instructions sysvar is read only for buys during the shield. |
| 6 | The amount is 0 (from here on, only a buy can be zero: after the shield, or the batch's own) | **allow** |
| 7 | Destination owner is exempt (`Pubkey::default()` never is) | **allow** |
| 8 | The destination token account lacks Token-2022's `ImmutableOwner` extension | refuse (`MutableOwner`, 6010) |
| 9 | Source owner is exempt | **allow** |
| 10 | Not a buy, and the wallet-to-wallet lock is on | refuse (`TransfersLocked`) |
| 11 | `max_buy != 0` and `amount > max_buy` | refuse (`MaxBuy`) |
| 12 | `max_wallet != 0` and destination balance after the transfer `> max_wallet` | refuse (`MaxWallet`) |
| 13 | Creator rules (P1c). Skipped if the policy has no rules, or if the transaction's current top-level instruction is the Noised vault's or the Noised shield's (review 4, R1). The mint's supply and the instructions sysvar (top-level program, instruction count) are read only here (review 4, Rb). | the first active rule that refuses: refuse (`RuleDenied`, 6011), logging "Launch rule {i} (code {c}) refused the transfer" |
| 14 | otherwise | allow |

**Step 8, immutable-owner destinations (audit round 3, F2).** Message: "Launch guard: the receiving token account must have an immutable owner while the guard is on". Without it, the owner of a hand-made token account could reassign it with `SetAuthority(AccountOwner)`: Token-2022 refuses that only for an account with `ImmutableOwner`, no tokens move, and the hook never runs, so a position bought during a `p2p_locked` guard could change hands, and one owner could hold many accounts each at max-wallet. Why this position:
- after step 6: a zero amount moves nothing;
- after step 7: an account owned by an exempt launchpad PDA changes owner only if the launchpad signs for it, and it never does. The batch buy, the one buy `in_batch` admits, pays the batch escrow (an ATA of the batch authority) through this step;
- before step 9: batch claims leave an exempt account, and still land only where the owner is fixed; they pay canonical Token-2022 ATAs, which have the extension (and `claim` refuses any other account with `InvalidRecipientAccounts`);
- before steps 10 to 12: reassignment would get around the lock and the caps.

No other account is excepted. Checked against the mainnet DBC, Token-2022 and ATA binaries: the batch escrow, claimed ATAs, PQ vault ATAs, buyers' ATAs and the Shield escrow have `ImmutableOwner`; the DBC base vault does not, but it only receives sells, which step 3 allows by key.

The hook reads the extension from the destination account's own data, which Token-2022 already passes it (`lib.rs::has_immutable_owner`): the account-type byte at offset 165 must mark a token account, then the extension entries are read as Token-2022's `get_extension` reads them, stopping at an uninitialized entry, and the `ImmutableOwner` entry must have length 0. Short, foreign or cut data reads as "no extension" and never panics. A CPI guard does not count: its owner can turn it off. The meta list does not change (§3) and the policy layout does not change, so `verifyLaunch` is unaffected.

Step 5 comes before steps 6 and 7 on purpose:
- A buy that pays out nothing still moves the pool. DBC 0.2.1 executes an exact-in buy whose output rounds down to zero: the input pays the fee, the rest moves the square-root price and the volatility accumulator, and Token-2022 still calls the hook, with amount 0. On a curve whose first segment holds dust liquidity, a 2-lamport buy crossed that segment and saturated the accumulator, so the batch paid the floor fee plus the maximum dynamic fee (round 1b). A zero amount must therefore never let a buy through the shield.
- Anyone can open a token account whose owner is an exempt PDA, so an exemption must never let a buy through the shield either (round 1).

Step 3 never treats a transfer out of the base vault as a sell, even when its destination is the base vault too. In practice the hook never sees that case: Token-2022 v11 returns from a transfer whose source and destination are the same account before it moves funds or calls the hook, and DBC refuses a buy whose output account is the base vault before any transfer (its `output_token_account` and `base_vault` would be the same mutable account: Anchor's `ConstraintDuplicateMutableAccount`, error 2040). The rule is defense in depth, tested by calling `execute` directly. Behind both, `execute_batch` refuses to run once the pool has traded (`PoolAlreadyTraded`), so a buy that ever got past the hook would turn the batch into a full refund, never into a batch bought at a moved price or fee.

Properties checked by the hook's host tests (39 in `rules.rs`, `lib.rs` and `state.rs`, all passing on 2026-10-11 on the review-4 build, `cargo test -p noised-hook`; 24 before P1c):

| Property | Test |
|---|---|
| A transfer into the base vault from any other account is always allowed (200,000 random cases: random times, amounts, owners, balances, batch flag) | `sells_are_never_blocked` |
| Every transfer at or after `guard_end_ts` is allowed (200,000 random cases) | `everything_is_allowed_after_the_guard` |
| During the shield, every buy outside the batch is refused, zero amounts included, whoever the owners are (200,000 random cases) | `only_the_batch_buys_during_the_shield` |
| A zero-amount buy is refused during the shield, passes inside the batch, and passes once the shield has ended | `zero_amount_buys_wait_for_the_shield` |
| A transfer from the base vault into the base vault is a buy: refused during the shield | `a_transfer_out_of_the_base_vault_is_never_a_sell` |
| A buy is refused during the shield even when its destination or source owner is exempt; the batch buy passes | `exemptions_never_open_the_snipe_shield` |
| The default key is never treated as exempt | `default_pubkey_is_never_exempt` |
| The shield blocks only buys, only until its end, and lets the batch buy through | `snipe_shield_blocks_only_buys_during_countdown` |
| Caps, the wallet-to-wallet lock, disabled caps, zero-amount transfers that are not buys, a zero buy after the shield, and exempt owners (transfers out of an exempt owner's account at any time, buys into one after the shield) | `caps_apply_during_guard`, `p2p_lock_blocks_wallet_transfers_but_not_buys`, `disabled_caps_do_not_restrict`, `zero_amount_and_exempt_owners_pass` |
| The batch moves the shield's end only earlier; the guard rules stay; buys open only from the batch on | `the_shield_end_only_moves_earlier`, `the_batch_ends_the_shield_and_the_guard_rules_stay`, `ending_the_shield_only_opens_buys_from_the_batch_on` |
| Only the launchpad's `execute_batch` is the batch; the `end_snipe_shield` interface, its event layout and the error numbers are pinned (`MutableOwner` = 6010 included) | `only_the_launchpads_execute_batch_is_the_batch`, `end_snipe_shield_interface_is_pinned`, `snipe_shield_ended_layout_is_pinned`, `error_numbers_are_stable` |
| Every branch of `evaluate`, in order: 31 rows, with `MutableOwner` after the sell, guard-end, shield, zero-amount and exempt-destination passes and before the exempt-source pass, the lock and the caps | `decision_table_covers_every_branch` |
| The immutable-owner rule refuses exactly the guarded transfers into accounts without `ImmutableOwner`, and otherwise decides as the pre-audit-3 function did (400,000 random cases) | `the_immutable_owner_rule_only_refuses_mutable_destinations` |
| The extension reader agrees with Token-2022's own `get_extension` on all 1,100 ordered selections of up to four account extensions, padded and cut at every length; malformed data (hand cases and 100,000 random buffers) never panics and never reads as `ImmutableOwner`; the layout constants are Token-2022's | `immutable_owner_is_read_as_token_2022_reads_it`, `malformed_token_accounts_have_no_immutable_owner`, `token_account_layout_constants_are_token_2022s` |
| Creator rules come after every built-in allow and denial: a rule that refuses everything changes only what reaches step 13, and every built-in refusal keeps its own reason | `creator_rules_come_after_every_built_in_decision`, `a_rule_that_refuses_everything_spares_sells_claims_and_the_batch` |
| Random verified rule sets on random transfers (3,000 sets, 100 transfers each): what reaches the rules is decided exactly as the `noised-rules` reference decides it, everything else exactly as without rules | `random_rule_sets_only_refuse_what_reaches_them` |
| Each leaf sees its own field of the transfer, windows count from the launch, the first refusing rule is reported with its code, and stored bytes that do not parse refuse | `creator_rules_see_the_transfer`, `the_refusing_rule_is_reported`, `malformed_stored_rules_fail_closed` |
| Holders' exits (review 4, R1): a rule aimed at the vault and the shield no longer holds their withdrawals, releases or unwraps; the built-ins still apply to them; 200,000 random cases decided by the built-ins alone | `rules_never_freeze_pq_vault_or_shield_releases`, `holders_exits_still_meet_every_built_in_check`, `holders_exits_are_decided_by_the_built_ins_alone`, `holders_exits_are_the_vault_and_the_shield` |
| Disclosed residuals, pinned: an insiders-only buy list verifies and sells still pass; vacuous rules verify and never refuse | `insider_only_buying_verifies_and_sells_still_pass`, `vacuous_rules_verify_and_never_refuse` |
| The policy head (review 4, R3) is read at the policy's offsets, reads the same for a version-1 or any longer policy, and needs the discriminator and 130 bytes | `the_head_is_read_at_the_policys_offsets`, `a_version_1_or_any_longer_policy_has_the_same_head`, `the_head_needs_the_discriminator_and_its_length` |

The launchpad's host test `hook_recognizes_execute_batch` checks that `noised_hook::EXECUTE_BATCH_DISCRIMINATOR` equals the Anchor discriminator of the launchpad's `execute_batch`, and `program_ids_and_pdas_match_their_sources` checks the launchpad ID the hook compares against.

These tests cover the pure decision function and the extension reader. `tests/integration/tests/hook.rs` then runs the deployed SBPF v3 hook under the mainnet Token-2022 v11 binary in LiteSVM, with the mainnet feature set. Its 21 tests passed on 2026-10-10:
- the meta list is the byte-exact two-entry list, and anyone can create it (`meta_list_init_is_permissionless_and_deterministic`);
- policies are accepted only from the launchpad PDA, and written within the hook's hard bounds (`create_policy_only_accepts_the_launchpad_pda`, `create_policy_signed_by_the_launchpad_pda_writes_a_bounded_policy`);
- `end_snipe_shield` accepts only the launchpad PDA, only a policy PDA and the real sysvar, runs only inside `execute_batch`, only moves the end earlier, lets buys through right after, and works after DBC revoked the hook (`end_snipe_shield_only_accepts_the_launchpad_pda`, `end_snipe_shield_takes_only_a_policy_pda_and_the_sysvar`, `end_snipe_shield_runs_only_inside_execute_batch`, `end_snipe_shield_only_moves_the_end_earlier`, `buys_pass_right_after_the_batch_ends_the_shield`, `end_snipe_shield_works_after_dbc_revoked_the_hook`);
- during the shield, buys into exempt accounts and zero-amount buys are refused, and Token-2022 does call the hook for a zero-amount transfer (`buys_are_blocked_during_the_snipe_shield_even_into_exempt_accounts`, `zero_amount_buys_wait_for_the_snipe_shield`);
- a buy passes the shield only inside a top-level instruction with the launchpad's ID and `execute_batch`'s discriminator; the same discriminator from another program, another launchpad instruction, a buy next to `execute_batch`, and `execute_batch` reached through a CPI are refused (`only_a_buy_inside_execute_batch_passes_the_snipe_shield`);
- Token-2022 never calls the hook for a transfer from the base vault into itself, and a direct call refuses it during the shield (`a_transfer_out_of_the_base_vault_is_never_a_sell`);
- caps, the wallet-to-wallet lock, sells, expiry and mints without a policy (`max_buy_and_max_wallet_apply_during_the_guard`, `wallet_to_wallet_transfers_follow_the_p2p_lock`, `sells_into_the_base_vault_are_never_blocked`, `everything_is_allowed_once_the_guard_ends`, `mints_without_a_policy_are_unrestricted`);
- immutable-owner destinations (audit round 3, F2): during the guard a claim, a buy or a wallet transfer into a plain account fails `MutableOwner` (checked before max-buy), the same into an ATA or an account created with `ImmutableOwner` passes, Token-2022 refuses `SetAuthority(AccountOwner)` on both (`TokenError::ImmutableOwner`), and sells never depend on it (`receiving_accounts_need_an_immutable_owner_during_the_guard`); the vault suite adds a `release_to` into a plain account, refused while the payout stays reserved;
- failing closed when hook accounts, the instructions sysvar included, are missing or wrong (`hooked_transfers_fail_closed_without_their_accounts`);
- compute cost (`compute_cost_of_a_hooked_transfer`, §7);
- creator rules (P1c and review 4; the suite has 25 tests, all passing on 2026-10-11): `create_policy` verifies the rules for the policy's own guard and stores them as given (`create_policy_verifies_and_stores_the_creator_rules`); rules read the current top-level instruction, the instruction count and the supply (`creator_rules_read_the_top_level_program_the_instruction_count_and_the_supply`); a version-1 policy, a policy whose rules length runs past its end and a bare head still let every sell and everything after the guard through, while buys and wallet transfers during the guard fail closed (`sells_and_the_guard_end_never_decode_the_whole_policy`, R3); rules cost only the transfers they decide (`creator_rules_cost_only_the_transfers_they_decide`, Rb). The vault suite adds `creator_rules_never_hold_a_vault_release` and the Shield's suite `creator_rules_never_hold_a_wrap_or_an_unwrap` (R1): exits pass under a rule that refuses every wallet transfer, the same tokens sent by a wallet are refused, so is a vault release made through another program's CPI, and with the lock on the built-in lock still refuses the exits.

Those tests write the policy straight into its PDA, use a stand-in base vault (the hook only compares account keys with `policy.base_vault`), and make the batch buy from a native stand-in program at the launchpad's ID. `tests/integration/mutants.ps1` runs them against 43 broken copies of the hook, including both zero-amount shortcuts, a base-vault-to-base-vault transfer counted as a sell, ten mutants of `end_snipe_shield` (H27 to H36) and seven of the immutable-owner rule and its reader (H37 to H43), and all are caught (2026-10-10). The launchpad's LiteSVM suite runs the rule against mainnet DBC in `audit_round3.rs` (`f2_buys_and_transfers_need_an_immutable_owner_while_the_guard_is_on`, `f2_without_the_lock_transfers_still_need_an_immutable_owner`, `f2_launch_payouts_land_only_where_the_owner_cannot_change`, `f2_hook_compute_on_buys_and_sells`), and the Shield's suite in `launch_guard_unwraps_only_into_accounts_whose_owner_cannot_change`. Real DBC swaps are in the launchpad's LiteSVM suite (`programs/noised-launchpad/tests/litesvm/tests/audit_regressions.rs`), against the mainnet DBC binary: `l2_exempt_owner_accounts_cannot_buy_through_the_snipe_shield`, `l2b_zero_output_buys_cannot_cross_the_snipe_shield` (1-lamport buys on the default curve and the reviewer's 2-lamport buy across a dust first segment are refused, the pool stays byte-identical and the batch pays exactly the floor fee), `l2c_batch_must_be_the_first_swap` and `l2d_dbc_refuses_a_buy_whose_output_is_the_base_vault`; the end of the shield at the batch is tested end to end by the nine `r2_…` tests of `audit_round2.rs` (in its own slot, late in the window, when the batch completes the curve, never later, on schedule without a batch, only by the launchpad and only for its own launch).

Since P1c and review 4, `mutants.ps1` holds 66 hook mutants: HR1 to HR16 for the creator-rules step, and H44 to H50 for the head fast path and the lazy reads (R3, Rb). The review-4 run (2026-10-11) re-ran the 31 integration mutants of the changed code, these included, and caught all of them; the host mutation run adds 26 mutants of the creator-rules step and 7 of the policy head, all caught. Against mainnet DBC, the launchpad's LiteSVM `rules.rs` (10 tests) launches with attested rules and checks the installed policy and the certificate (`launch_installs_the_attested_rules_and_certifies_them`, `attestation_v3_binds_the_published_rules`), that rules never touch sells, claims, the batch or anything after the guard (`rules_never_touch_sells_claims_the_batch_or_after_the_guard`), that real transfers under random rule sets are decided as the reference decides them (`random_rule_sets_decide_real_transfers_as_the_reference`), and the compute at the largest rule set (`compute_at_the_largest_rule_set`, §7).

Base tokens leave the DBC vault only through swaps:
- fees are collected in wSOL only (`collect_fee_mode = 0`);
- DBC revokes the hook in the swap that completes the curve, so migration moves tokens without the hook;
- burns and mints never reach a transfer hook.

The only DBC-originated transfers Launch Guard ever sees are buys (vault to buyer) and sells (seller to vault).

### Creator launch rules (PXR1)

A creator can add launch rules to the built-in ones. The PXR1 format is normative in [crates/noised-rules/README.md](../crates/noised-rules/README.md); the policy layout and the decision step are in [SPEC.md](SPEC.md) §1.9.

**What a rule set is.** At most 16 rules, 8 wallet keys and 64 condition nodes (1,228 bytes). A rule is active while `from_rel <= now - launch_ts < to_rel`, a window inside the guard (`to_rel <= min(guard_secs, 259,200)`). It has a condition, a small boolean program over the transfer (is a buy, is wallet-to-wallet, time, amount, destination balance after, source or destination owner in a key list, the current top-level instruction's program in a key list, more than n top-level instructions), and an effect: DENY (refuse if the condition holds), CAP_AMOUNT (if it holds, refuse an amount above the cap) or CAP_DEST_BALANCE (if it holds, refuse a destination balance above the cap). A cap is an amount or basis points of the current supply. The first active rule that refuses wins (`RuleDenied`, 6011); its code (0 to 63) is shown to the user.

**What rules can do.** Only refuse more transfers, and only during the guard (at most 72 h): time-windowed denials, per-transfer caps, destination-balance caps, allow or deny lists of up to 8 wallets, checks on the top-level program and on the instruction count (anti-bot).

**What rules cannot do.**
- allow anything a built-in check refuses;
- touch a sell, a batch claim, the batch buy, a zero-amount transfer, a transfer into or out of an exempt launchpad account, or anything at or after `guard_end_ts`: steps 1 to 12 decide those first, so what reaches step 13 is a non-zero buy or wallet-to-wallet transfer between owners that are not exempt, into an account with `ImmutableOwner`, before the guard ends;
- change after the identity signed them, or run longer than the guard;
- hold a holder's exit through the Noised vault or shield (below).

**How they get into the policy.** Anyone publishes the bytes as a `LaunchRules` record at `["rules", launch, rules_hash]`, where `rules_hash = SHA256("PHX-RULES-V1" || bytes)` (`publish_rules`, verified for the launch's guard, never modified or closed). The creator's identity signs `rules_hash` in the attestation (message v3). `launch` takes only the record that hash names, hashes its bytes again against the attested hash (review 4, R6a), passes them to `create_policy`, which verifies them again for the policy's own guard (`InvalidRules`, 6012), and re-reads the written policy (`written.rules == rules`, else `UnsafePolicy`). Certificate v4 records `rules_hash` and sets `RULES_BOUND` (4096) when the policy holds the attested, non-empty rules, so `checks` is 8,191 with rules and 4,095 without: clients test `(checks & 4095) == 4095`. Nothing changes the rules afterwards.

**Holders' exits (review 4, R1).** If the transaction's current top-level instruction is the Noised PQ vault (`7BQ6…`: withdrawals and releases) or the Noised shield (`BUMH…`: wraps and unwraps), step 13 is skipped. The built-in checks (the lock, max-buy, max-wallet, `MutableOwner`) still apply exactly as before. Without this, a rule aimed at those two programs could hold every vault release and every unwrap for the whole guard. Residual: routing through the vault or the shield gets past creator rules, never past the built-ins. Wrap (rules skipped), move the zTokens (the zToken mint has no hook), unwrap (rules skipped) gets past a rule that restricts wallet-to-wallet transfers or owner lists; under the built-in lock, wrap and unwrap are still refused. A call into the vault or the shield made by another program through CPI has that program as the top-level instruction, so the rules still apply to it.

**Disclosed residuals, not prevented on-chain.**
- Insider-only buying: a rule set can refuse every public buy except into listed wallets, from the batch up to `guard_end_ts` (at most 72 h). The guard is then a private sale. Every holder can still sell.
- Vacuous rules, for example DENY when FALSE, verify and never refuse, yet `RULES_BOUND` is set: the bit means the rules are bound, not that they protect anyone.
- Rules see token transfers only, like the built-ins: control changing without a transfer is invisible to them (§9).

Clients explain every rule set in plain English and warn on buys restricted to a key list, rules on wallet-to-wallet transfers, rules active for more than an hour, and vacuous rules. A launch with rules is tagged "programmable" next to its QSL-1 level ([standard/QSL-1.md](standard/QSL-1.md)): a disclosed feature, not a safer level.

**Storage and failure.** `HookPolicy` version 2 appends the rules after `exempt`: a `u32` length at offset 275, then the bytes from 279. The account is exactly 279 + length bytes (at most 1,507), and its 130-byte head is the same as version 1's. Stored bytes that do not even parse refuse every transfer that reaches step 13 (fail closed, logged as rule 255, code 255); `create_policy` never stores such bytes. Rules add no hook account: the mint is already account 1 of `Execute`, and the sysvar is already in the meta list (§3). They cost up to about 6k CU more per buy or wallet transfer at the largest rule set (§7).

### Why reading the instructions sysvar is sound

The hook decides "is this the batch buy?" from the instructions sysvar alone (`lib.rs::inside_execute_batch`): the transaction's **currently executing top-level instruction** must belong to the launchpad program (`CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`) and its data must start with `execute_batch`'s 8-byte discriminator. Four facts make that enough:

| Fact | Why it matters | Source |
|---|---|---|
| The sysvar lists only the transaction's top-level instructions, with the program ID each one really invokes. During a CPI, the runtime keeps the sysvar's "current index" at the top-level instruction that started the chain. | CPIs never appear as top-level instructions. A program that CPIs into the launchpad shows up as itself, not as the launchpad. Nobody can make an instruction look like the launchpad's `execute_batch` without it being exactly that. | Agave 4.3.0 `svm/src/account_loader.rs:654-685`, `transaction-context/src/transaction.rs:407-456` (FACTS, audit round 1 facts) |
| `load_current_index_checked` and `load_instruction_at_checked` refuse any account other than the real sysvar (`UnsupportedSysvar`). | A direct call to the hook with a forged "sysvar" fails for buys during the shield and for transfers that reach creator rules. Through Token-2022, the account is resolved from the meta list, which pins the sysvar address. | `solana-instructions-sysvar` 3.0.1 `src/lib.rs:166-177, 254-268` |
| `execute_batch` makes exactly one DBC swap, for its own launch's pool, and runs at most once per launch (`executed` flag). | Inside a top-level `execute_batch`, the only transfer out of a base vault is that launch's batch buy. Each launch has its own config, pool and base vault, so `execute_batch` of launch A cannot move launch B's tokens. | `instructions/execute_batch.rs` |
| The launchpad is fixed code once finalized. | The hook trusts the launchpad's `execute_batch` to do only the batch buy. Until finalization, the launchpad's upgrade authority is trusted for this, as for everything else. | |

Consequence: `execute_batch` must be submitted as a **top-level instruction**. A program that calls `execute_batch` by CPI gets the batch buy refused (`SnipeShield`), because the top-level instruction is that program's. The batch window lies entirely inside the shield, so a CPI'd `execute_batch` can never succeed. Other instructions may share the transaction.

Creator rules read the same sysvar the same way (`lib.rs::top_level`): the current top-level instruction's program and the number of top-level instructions, after the same checked loads. By the first fact, only the Noised vault or shield itself can appear as the top-level program that skips the rules (R1); a program that reaches them by CPI appears as itself.

### What the hook deliberately does not do

| Not done | Why it is safe |
|---|---|
| Write any state in `execute` | `execute` is stateless. A direct call with forged accounts, made without Token-2022, can only return success or an error, and changes nothing. For the same reason it does not check Token-2022's `transferring` flag. That check matters for hooks that update state (FACTS #52). The policy is written only by `create_policy` and `end_snipe_shield`, both signed by the launchpad's PDA. |
| Make a CPI | On the batch path the hook runs at depth 4 of the runtime's 5 (§7). It never needs more. |
| Read admin-controlled state | It has no admin. The policy is written once; the only later change is its shield end moving earlier at the batch. |
| Look at the `authority` account (owner or delegate) | Rules use the token-account owners stored in account data. |
| Read the instructions sysvar except for buys during the shield and transfers that reach creator rules | Every other transfer is decided without it, so no other path depends on transaction structure. Under a policy with rules, a buy or wallet transfer that passed every built-in check also reads the current top-level program, the instruction count and the mint's supply (step 13); sells, claims, the batch buy, exempt owners and policies without rules never do (review 4, Rb). |
| Let a creator rule allow a transfer | Rules run after every built-in decision and can only turn an allow into a refusal, before `guard_end_ts`. |
| Refuse zero-amount transfers that are not buys | Step 3 lets them through from the keys and the amount alone: they move no tokens and do not touch the pool. A zero-amount buy is different, because DBC executes it and it moves the price: until the shield ends it is refused like any other buy (step 5). |
| Handle confidential transfers (amount `u64::MAX`) | Noised mints cannot have `ConfidentialTransferMint`. Their extension set is fixed and checked at launch. |

## 3. Why the extra accounts depend only on the mint

The mint's `ExtraAccountMetaList` (PDA `["extra-account-metas", mint]` under the hook) holds exactly two entries, both neither signer nor writable (`canonical_metas`):
1. the policy PDA `["policy", <account 1 = mint>]`;
2. the instructions sysvar, a fixed address (`Sysvar1nstructions1111111111111111111111111`).

The reason is how Meteora's SDKs resolve hook accounts:

| SDK | How it resolves hook accounts | Source |
|---|---|---|
| DBC TypeScript SDK `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 | `getRemainingAccountsForTransferHook` builds a dummy `transfer_checked` with `PublicKey.default` as source, destination and owner and amount 0, then reuses the resolved accounts for every hook slice, the referral slice included | `src/services/program.ts` (commit a28b723) |
| DLMM SDKs (Rust and TypeScript) | Same: `Pubkey::default()` for source, destination and authority, amount 0 | FACTS #41 |

A hook whose extra accounts derived from the source, destination, owner or amount would resolve to the wrong addresses in these SDKs. Token-2022 would then refuse the transfer. Every buy and sell made through Meteora's SDK, or through an aggregator that copies its approach, would fail.

Both entries resolve to the right address in every resolver: one is derived from the mint alone, the other is a constant. The cost is that Launch Guard cannot keep per-wallet state, for example cumulative buys per wallet. That is why:
- max-buy is per transfer;
- max-wallet reads the receiving token account's own balance after the transfer.

The meta list is created permissionlessly, has deterministic contents and has no update instruction. `launch` creates it in the same transaction as the mint, so no transfer can happen before it exists. Every client that moves a Noised token during the curve passes 4 hook accounts: the meta list, the policy, the instructions sysvar and the hook program (`hook_accounts.rs` in the launchpad checks exactly these, in this order).

Because a mint's list can never be rewritten, the hook must never be upgraded in place to a version whose `Execute` expects a different account list. Token-2022 would keep passing the accounts the old lists name, so every transfer of every existing launch, sells included, would fail (`AccountNotEnoughKeys` when the new version expects more). Round 1 grew the list from one entry to two, which was safe only because nothing had been deployed. This is a deployment invariant ([OPERATIONS.md](OPERATIONS.md#deployment-invariants)). P1c kept the list and appended the rules to the policy (version 2); all programs deploy fresh, and since review 4 (R3) a policy whose rest the hook cannot decode still never blocks a sell or anything after the guard (§4).

## 4. Fail-closed and fail-open, case by case

| Situation | Behaviour | Why |
|---|---|---|
| A client omits the meta list (validation) account | Token-2022 calls the hook with only 4 accounts. Anchor's account validation fails, so the transfer fails. | FACTS #50: the validation account is optional in Token-2022's CPI, so the hook must fail closed. |
| A client passes wrong extra accounts, including a fake instructions sysvar | Token-2022 re-derives them from the meta list and refuses the transfer before calling the hook. | Resolution is checked by Token-2022, not by the hook. |
| The hook is called directly with a fake instructions sysvar | Buys during the shield, and transfers that reach creator rules, fail (`UnsupportedSysvar`); other transfers do not read it. A direct call changes nothing either way. | §2, "Why reading the instructions sysvar is sound" |
| A DBC buy whose output account is the base vault itself | Never reaches the hook: DBC refuses it before any transfer (`ConstraintDuplicateMutableAccount` on `base_vault`, error 2040), and Token-2022 never calls a hook for a transfer from an account to itself. Pinned on the mainnet binaries by `l2d_dbc_refuses_a_buy_whose_output_is_the_base_vault`. | The hook would treat it as a buy (§2, step 3); `execute_batch`'s first-swap check backs both up. |
| Policy belongs to another mint | Refused (`PolicyMismatch`), sells included; read from the policy's head. | Cannot happen through Token-2022, because it derives the policy from the mint. |
| Policy account without `HookPolicy`'s discriminator, or shorter than its 130-byte head | Refused (Anchor's account errors), sells included. | Cannot happen: only `create_policy` writes policy accounts. |
| The policy's head reads, but the rest cannot be decoded (for example a version-1 policy under this hook) | Sells and everything after the guard **pass**, decided from the head; buys and wallet transfers during the guard fail (`AccountDidNotDeserialize`). | Review 4, R3: no layout or version of the rest can block a sell or anything after the guard (`sells_and_the_guard_end_never_decode_the_whole_policy`). |
| Stored creator rules that do not parse | Every transfer that reaches step 13 is refused (`RuleDenied`, rule 255, code 255). Sells, claims, the batch and everything after the guard never reach it. | Fail closed, defensive: `create_policy` never stores such bytes (`InvalidRules`). |
| Token account data shorter than 72 bytes | Refused (`MalformedTokenAccount`). | Defensive. |
| **No policy exists for the mint** | **Allowed** | See §5. |

## 5. Mints without a policy are never restricted

DBC configs are permissionless: anyone can launch a pool on any config (FACTS #21). A third party can therefore create a pool on a Noised DBC config. Its mint then has `noised_hook` as its transfer hook. It cannot get a policy, because only the launchpad's `["hook-authority"]` PDA can sign `create_policy`, and the launchpad signs only for the pool it creates in `launch`.

| Design choice | Effect |
|---|---|
| The hook allows every transfer of a mint without a policy | Such a pool is never bricked by Launch Guard (SPEC §7, invariant 3). |
| Such a pool gets no certificate (`["certificate", mint]` is written only by `launch`) | `verifyLaunch` reports it as not a Noised launch, and the app does not list it. |
| The config's fee claimer and LP owner are the launch-authority PDA of the launch that created the config | That launch's `claim_fees` and `claim_lp_fees` are bound to its own pool (`has_one = pool`, pool-mint checks), so they never touch the third party's pool. Fees and LP of such a pool cannot be claimed by anyone. That outcome is the third party's choice of config, and it cannot harm the real launch. |

## 6. Why creators cannot bring their own hook program

| Risk with arbitrary hooks | Source |
|---|---|
| DBC accepts any executable as the hook program, except DBC, SPL Token and Token-2022. It checks no allowlist, no code and no upgrade authority. | FACTS #25 |
| A failing or malicious hook can block buys, sells, fee claims and the swap that completes the curve. The pool is then stuck before migration, with no recovery path. Offside Labs rated this Medium for DBC 0.2.0; Meteora acknowledged it ("meant to be an experiment"). | FACTS #26 |
| A hook cannot steal: extra accounts are forced to non-signer. But it can make every sell fail, which is a honeypot. | FACTS #51 |
| A hook whose upgrade authority is not None can turn into a honeypot later, after a "safe" review. | FACTS #66 |
| A hook that makes CPIs breaks the batch path's depth budget (§7). | FACTS #4 |
| A hook with per-wallet extra accounts breaks Meteora's SDK resolution (§3). | FACTS #41 |

Customization therefore comes as data, not code: bounded, verified rule bytes, signed by the creator's identity and interpreted by the one audited hook after every built-in check (§2, "Creator launch rules"), never a custom program.

So the launchpad pins the hook:
- `create_launch` requires `hook_program == noised_hook` (address and executable check).
- `inspect_config` re-reads the DBC config.
- `inspect_mint` re-reads the mint's `TransferHook` program and authority.

The certificate flag `HOOK_IS_NOISED` (32) records that these checks passed.

Launch Guard itself becomes immutable when its upgrade authority is set to None ([OPERATIONS.md](OPERATIONS.md#release-and-finalization)).

Adding another hook would mean deploying a new launchpad version with a new `SAFETY_POLICY_VERSION`. Finalized programs cannot change, so existing launches would be unaffected.

## 7. Compute and CPI depth

| Path | Depth (top level = 1, maximum 5) |
|---|---|
| launchpad `execute_batch` (top level) -> DBC swap -> Token-2022 -> Launch Guard | 4 |
| launchpad `execute_batch` -> Launch Guard `end_snipe_shield` (after the swap) | 2 |
| user -> DBC swap -> Token-2022 -> Launch Guard | 3 |
| launchpad `claim` -> Token-2022 -> Launch Guard | 3 |
| a program that CPIs `execute_batch` -> launchpad -> DBC -> Token-2022 -> Launch Guard | 5, the limit. It no longer matters: the hook refuses the batch buy when `execute_batch` is not the top-level instruction (§2). |
| a router that CPIs a public DBC buy -> DBC -> Token-2022 -> Launch Guard | 4. Works after the shield, because Launch Guard makes no CPI. |

Launch Guard's own work is small and bounded:
- one read of the policy's 130-byte head; only a transfer it does not decide (steps 1 to 4) also deserializes the policy (at most 1,507 bytes);
- two fixed 72-byte reads;
- one walk over the destination's extension entries (`has_immutable_owner`), bounded by the account's length;
- for buys during the shield only, one read of the current top-level instruction from the instructions sysvar;
- a loop over at most 4 exempt keys;
- for a transfer that reaches creator rules only: the current top-level instruction and the instruction count from the sysvar, the mint's supply, and one evaluation of at most 16 rules over at most 64 condition nodes, each node evaluated at most once.

It makes no CPI and no heap allocation in the rules.

Since 2026-10-13 the hook is written without Anchor (`pinocchio` and `crates/noised-onchain`, the same ABI and the same checks in the same order; SBPF v3 binary 46,600 bytes instead of 214,976). Its own `execute` costs, in CU, measured by the same tests on that build and on the review-4 Anchor build:

| Transfer | Without rules | With the largest rule set |
|---|---|---|
| public buy | 984 (Anchor: 3,295) | 4,723 (Anchor: 9,126) |
| wallet-to-wallet transfer | 995 (3,318) | 4,738 (8,194) |
| sell | 502 (2,425) | 502 (2,425) |
| batch claim (exempt source) | 982 (3,302) | 982 (3,416) |
| public buy after the guard | 615 (2,572) | |
| mint without a policy | 367 (2,260) | |
| batch buy inside `execute_batch` | 1,070 (5,838) | |

`end_snipe_shield` (the CPI from `execute_batch`) costs 2,549 (Anchor: 13,727). The rows are `compute_at_the_largest_rule_set`, `f2_hook_compute_on_buys_and_sells` (against mainnet DBC) and `compute_cost_of_a_hooked_transfer` (`tests/integration`); the hook's own cost does not depend on the mint, a whole transaction's does (Token-2022's PDA searches). The tables below are the Anchor builds, kept for comparison.

On the review-4 build (2026-10-11), the hook's own `execute` costs, in CU:

| Transfer | Without rules | With rules |
|---|---|---|
| public buy | 3,295 | 9,126 at the largest rule set (+5,831) |
| wallet-to-wallet transfer | 3,318 | 8,194 at the largest rule set (+4,876) |
| sell | 2,425 | 2,425 |
| batch claim (exempt source) | 3,302 | 3,416 (+114, decoding the longer policy) |
| batch buy inside `execute_batch` | 4,463 | 4,577 |

The buy, wallet-transfer, sell and claim rows are `compute_at_the_largest_rule_set` against mainnet DBC (1,228-byte rule set); the batch buy is `creator_rules_cost_only_the_transfers_they_decide` in `tests/integration`, with a smaller rule set. A sell costs 2,425 either way, because it is decided from the policy's head (R3). (The 2,848 CU for a sell in the audit-round-3 figures below comes from a different test on an older build, so the two numbers are not a before-and-after measurement.) Without rules, a whole hooked `transfer_checked` mid-guard costs 20,469 CU (hook 3,319), a transfer after the guard 2,603 in the hook and a mint without a policy 2,260 (`compute_cost_of_a_hooked_transfer`); against mainnet DBC, `execute_batch`'s check of the batch buy costs 5,838 and its end of the shield 13,727; in the Shield's suite, a wrap or unwrap during the guard spends 3,318 in the hook. Clients raise compute limits by about 6k CU for buys and wallet transfers under large rule sets. The tables below are older builds, kept for comparison.

On the audit-round-3 build (2026-10-10, the same `compute_cost_of_a_hooked_transfer` test run on the builds before and after F2), the hook's own `execute` costs 3,268 CU when every rule is evaluated (42 more than before F2: the destination's extension read) and 4,415 for the batch buy (13 more); a sell (2,848), a transfer after the guard (3,025) and a mint without a policy (2,260) are unchanged. Against mainnet DBC (`f2_hook_compute_on_buys_and_sells`): a public buy into an ATA spends 3,247 CU in the hook, a claim into a new ATA 3,250, a sell 2,847, `execute_batch`'s batch-buy check 5,790 and its end of the shield 13,653; a Shield wrap or unwrap during the guard 3,265. Whole transactions change by exactly the hook's difference. The table below is the round-1b measurement, kept for the totals.

Measured costs on the round-1b code (2026-10-08), from `compute_cost_of_a_hooked_transfer` in `tests/integration/tests/hook.rs`. Setup: LiteSVM 0.17, mainnet Token-2022 v11, mainnet feature set, SBPF v3 builds. Totals are ranges over 13 runs with random mints; the hook's own cost does not depend on the mint.

| `transfer_checked` | Total CU | Launch Guard `execute` itself |
|---|---|---|
| SPL Token (p-token), no hook, for comparison | 105 | |
| Token-2022, no hook | 2,046 | |
| Launch Guard, mint without a policy | 14,911–22,411 | 2,262 |
| Launch Guard, mid-guard, every rule evaluated | 15,878–23,378 | 3,228 |
| Launch Guard, sell (fast path) | | 2,850 |
| Launch Guard, after the guard | | 3,027 |
| Launch Guard, a buy inside `execute_batch` (reads the instructions sysvar) | | 4,404 |

The rest of the overhead over plain Token-2022 is Token-2022's own work: it resolves the extra accounts on-chain, including the meta-list and policy PDA derivations, and makes the hook CPI. Each extra bump-search step of a derivation costs about 1,500 CU, which explains the spread between mints. The instructions sysvar is a fixed address and needs no search.

The launchpad's LiteSVM suite measured the whole batch and trading paths against mainnet DBC on the same day (round 1b; on the PQ v2 build `execute_batch`, now including the 13.65k-CU `end_snipe_shield` CPI, is 946 bytes and 114k to 174k CU, and `r2_execute_batch_compute_on_the_longest_curve` keeps it under 250k CU on an 8-point curve):

| Transaction | Total CU | Size |
|---|---|---|
| `execute_batch`, default test curve (42 samples) | 88,847–147,807; the hook's share is 5,521 | 911 bytes |
| `execute_batch`, 2-point curve with a dust first segment and the maximum dynamic fee | 112,029–148,029 | 911 bytes |
| `execute_batch`, 16-point curve | 138,806–161,289 | |
| `execute_batch` that completes the curve, so DBC revokes the hook in the same swap | 107,310–125,310 (default curve); 134,286–152,286 (16 points) | |
| public buy after the shield | 56,050–71,050; the hook's share is 3,209 | |
| `[launch, commit]` in one legacy transaction | 181,128–196,128 | 1,191 bytes |
| shield `wrap` / `unwrap` of a launch token, through the hook | 49,373–58,373 / 49,637–58,637 | |

The spread comes from bump searches that depend on the random mint address.

## 8. Launch hooks: customization outside the token

Everything below runs in the launchpad, not in the transfer path. It can never block a transfer, and it keeps working after graduation. Every instruction is permissionless: anyone can crank it, and funds only ever go to the parties fixed at `create_launch`.

| Launch hook | Creator chooses | Fixed by the program | Instructions |
|---|---|---|---|
| **Fair-open batch** | Commit window (60 s to 30 min); per-wallet cap (lamports, 0 = none, else at least the total cap / 200); total cap (0 = the graduation threshold, else a tenth of it up to all of it) | One DBC buy for the whole batch, in a 600 s window, of `min(total committed, total cap)`, and only as the pool's first swap (`PoolAlreadyTraded`); the batch then ends the snipe shield. Commits are never refused for the total cap: an oversubscribed batch is filled pro rata. Pro-rata by lamports: `floor(tokens_out * c / total)` tokens and `floor((total - spent) * c / total)` wSOL, paid to the payout owners the first commit fixed (the committer or its PQ vaults). A full refund if the batch does not execute in time. A fee schedule that ends before the batch (`FeeScheduleTooLong`). | `commit`, `execute_batch`, `claim` |
| **Fee routing** | 1 to 4 recipients with shares summing to 100% (a recipient may be a wSOL PQ vault) | The platform share is snapshotted from the immutable `Protocol` (at most 50%) and paid to the treasury, a wSOL PQ vault. Recipients and shares never change. Payment goes only to canonical wSOL ATAs (a vault's is its own token account), and the last recipient takes the rounding remainder. | `claim_fees`, `claim_surplus`, `claim_lp_fees`, `distribute` |
| **Burns** | nothing | `distribute` burns the launch authority's whole base-token balance (LP fees paid in the launched token). DBC burns the unsold supply at migration (dynamic supply). | `distribute`; DBC `migration_damm_v2` |
| **Liquidity lock** | Post-graduation fee tier (0.25%, 0.3%, 1%, 2%, 4% or 6%; every tier's DAMM v2 config adds a default dynamic fee of up to about 20% of the tier) | 100% of the graduated liquidity is permanently locked and held by the launch-authority PDA. No creator or partner migration fee; Meteora keeps its fixed 0.2% of the migrated liquidity and 20% of any surplus. | DBC `migration_damm_v2` |

The trading fee curve is also chosen within bounds:
- a linear or exponential scheduler that must end before the batch executes;
- an optional volatility fee;
- floor fee plus the largest possible volatility fee at most 10% (`policy.rs::within_fee_ceiling`).

**Autopilot: post-launch treasury automation (P1c).** A separate program, `noised_autopilot` (`D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx`), runs a launch's treasury by a PXG1 graph: buyback-and-burn on the launch's own DAMM v2 pool, burns, and SOL paid to up to 8 declared recipients, each node within a trigger, a condition, a budget per epoch, a per-run cap and, for buybacks, a price bound. It is never in the transfer path: Token-2022 never calls it, it cannot block a transfer, and it cannot touch the launch, its hook policy, its LP or its mint's authorities. The treasury is a PDA (`["treasury", launch]`) that a creator can name as a fee recipient at `create_launch`, so `distribute` pays it. Graphs change only with an LMS authorization by the launch's identity (`pq_authorize`), a replacement only 72 h after it becomes visible, and a frozen graph never. See [SPEC.md](SPEC.md) §9 and [THREAT_MODEL.md](THREAT_MODEL.md) 5.16.

## 9. Caveats

| Caveat | Detail |
|---|---|
| Per account, not per person | Max-wallet and max-buy apply per token account and per transfer. Many wallets get around them. The batch is pro-rata, so splitting wallets gains nothing there, and the batch's per-wallet cap only limits naive concentration. |
| What the wallet-to-wallet lock stops | It stops token transfers between holders' accounts during the guard. Since F2 it also stops consolidation by owner reassignment: a guarded transfer that is not a sell lands only in an account whose owner can never change, so no token account a buy or a claim reaches during the guard can be reassigned. |
| What it cannot stop: control changing without a transfer | The hook sees token transfers only. These move control of a position during the guard with no transfer, so neither the lock nor max-wallet sees them (audit round 3, F4): **a wallet several people control** (a multisig, a smart wallet's members, a key several people hold); **a PDA or smart-wallet owner** whose own program hands control to someone else, for example by changing its members; **a PQ vault's key rotation**: tokens bought or claimed into a vault during the guard stay in the vault, but its holder can sign `withdraw` with `max_amount = 0` and `next_key` set to another party's key, after which only that party can withdraw (no token moves; delivery out of the vault still waits for the guard under the lock); **a delegate approval** (`Approve`): it gives revocable control shared with the owner, and the delegate can sell during the guard, since sells always pass. Accounts owned by an exempt launchpad PDA stay exempt; only the launchpad could sign for them, it never changes their owner, and it moves the launch token out of them only as batch claims into canonical ATAs (`distribute` burns the launch authority's tokens). |
| Shared accounts share one max-wallet | Max-wallet reads the receiving account's balance, whoever pays in. The Shield's escrow for a mint is one account (owned by the shield authority, which is not exempt), so during the guard all Shield deposits of a launch token share one max-wallet: a holder of about max-wallet tokens can fill it, and every further wrap fails with `MaxWallet` until the guard ends. At most max-wallet worth of zTokens can exist for the mint during the guard, which is also why wrapping cannot get around the caps. The same holds for a recipient's canonical ATA: anyone can top it up to max-wallet, after which buys and vault `release` payouts into it fail until the guard ends (`release_to` into another account the recipient owns still works, if that account has an immutable owner). Griefing only, at most 72 h, nothing lost (audit round 3, info). Exempting the shield authority would let `p2p_locked` holders move tokens through wrap and unwrap, so it is not exempt. |
| Batch claims are exempt | Claims are transfers out of the batch escrow, whose owner is exempt. A large batch allocation can therefore exceed max-wallet. Use the batch's per-wallet cap to limit allocations. Claims pay only the payout owners fixed at the first commit (the committer or a PQ vault of that mint), and everything committed for one vault, by every committer naming it, is held to one wallet's cap, so shares cannot add up in one account. |
| Tokens in a PQ vault during the guard | For the hook, a vault's `release` and `release_to` are wallet-to-wallet transfers. Tokens bought or claimed into a vault cannot leave it while a `p2p_locked` guard runs (up to 72 h), and without the lock a release above max-buy is refused until the guard ends. `withdraw` itself always executes; the payout stays reserved and is released after the guard. `release_to` into a token account without an immutable owner also waits for the guard to end (`MutableOwner`, including the guard's last second); `release` pays the recipient's canonical ATA, which has one. A key rotation hands the vault to another key without any transfer (row above). |
| Routes through other programs during the guard | Any hop that delivers the launch token into an account without an immutable owner is refused while the guard is on, even with the lock off: for example an aggregator or multi-hop route that passes tokens through another program's non-ATA account. Buy straight through DBC into your ATA until the guard ends. Sells into the DBC pool are never affected. |
| What the shield relies on in DBC | The hook sees a buy only as the Token-2022 transfer DBC makes for it. DBC 0.2.1 makes one for every buy, even one that pays out nothing (refused during the shield since round 1b, `l2b_zero_output_buys_cannot_cross_the_snipe_shield`), and refuses a buy whose output account is the base vault, which Token-2022 would never pass to the hook (`l2d_dbc_refuses_a_buy_whose_output_is_the_base_vault`). A DBC release that skipped the transfer for a zero output, or accepted the base vault as a buy's output account, would let such a buy run unseen. `execute_batch` would then refuse to run (`PoolAlreadyTraded`, `l2c_batch_must_be_the_first_swap`) and the batch would refund in full: a lost fair open, not a batch bought at a moved price or fee. |
| Buying into exempt accounts after the shield | After the shield, a buy into a token account owned by the batch authority or the launch authority skips the caps. The tokens are stranded in the batch escrow (claims pay only shares of the batch's own swap) or burned by `distribute`. It costs the buyer and nobody else. |
| `execute_batch` must be top-level | Keepers and wallets must submit it as a top-level instruction. Called by CPI, the batch buy is refused and, if nobody submits it top-level in time, the batch expires and refunds everyone. |
| Other holders' transfers during the guard | Deposits into a PQ vault or a Shield escrow, PQ vault payouts, and transfers to an exchange are wallet-to-wallet transfers. The guard's lock, max-wallet and the immutable-owner rule apply to them until `guard_end_ts`, at most 72 h after launch. A vault payout refused this way stays reserved and can be released after the guard. |
| Creator rules can make buying insiders-only | A verified rule set can refuse every public buy except into listed wallets, from the batch up to `guard_end_ts` (at most 72 h): a private sale. Every holder can still sell. Disclosed, not prevented: read the rules' plain-English explanation and the verifier's warnings before buying (THREAT_MODEL R33). |
| Rules that protect nothing | Vacuous rules (for example DENY when FALSE) verify and never refuse, yet the certificate sets `RULES_BOUND`. The bit means the rules are bound, not that they protect anyone, and "programmable" is a disclosed feature, not a safer level (THREAT_MODEL R34). |
| Creator rules do not cover routes through the vault or the shield | Since review 4 (R1), creator rules skip transfers whose top-level instruction is the Noised vault or shield. Wrap, move zTokens, unwrap therefore gets past rules that restrict wallet-to-wallet transfers or owner lists, never past the built-in lock or caps. Through another program's CPI, the rules still apply (THREAT_MODEL R35). |
| Clock | Rules use the cluster's `unix_timestamp`, which can differ from wall-clock time by a few seconds. Built-in windows are 60 s or longer; a creator rule's window may be shorter, and drift shifts it the same way. |
| Sells can fail for reasons outside the hook | Slippage limits, a client passing wrong accounts, a completed curve (DBC rejects swaps between completion and migration), or an upgrade of DBC or Token-2022. |
| Until finalization | Whoever holds Launch Guard's upgrade authority could replace it, for example with one that blocks sells. The launchpad's upgrade authority is trusted the same way, because the hook trusts `execute_batch`. Check `solana program show cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` and the launchpad's ID: the line `Authority:` must read `none`. |
