---
title: Snipe shield & Launch Guard
nav: Snipe shield & guard
summary: The Token-2022 transfer hook that admits only the batch buy before the open, applies bounded guard rules for at most 72 hours, never blocks a sell and disappears at graduation.
---

Launch Guard (`noised_hook`, `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia`) is a Token-2022 transfer hook: Token-2022 calls it on every transfer of a launched token. It is stateless, makes no CPI, has no admin, and reads one policy per mint that only the launchpad can write, once.

## Rules

The launchpad writes the `HookPolicy` at `["policy", mint]` inside the `launch` transaction. Times count from the `launch` transaction (T0).

| Rule | Creator chooses | Effect | Ends at |
|---|---|---|---|
| Snipe shield | `open_delay_secs`: 60 s to 30 min | Every buy out of the DBC base vault is refused, whatever its amount and whoever receives it, unless it happens inside the launchpad's top-level `execute_batch`. | the batch (`end_snipe_shield`), or `T0 + open_delay + 600 s` |
| Max buy | 0 (off) or at least 0.01% of the initial supply | A transfer larger than the cap is refused. | `guard_end_ts` |
| Max wallet | 0 (off) or at least 0.1% of the initial supply | A transfer is refused if the receiving token account would hold more than the cap. | `guard_end_ts` |
| Wallet-to-wallet lock | on / off | Every transfer that is neither a buy nor a sell is refused. | `guard_end_ts` |
| Fixed-owner receivers (audit round 3, F2) | nothing: always on | A transfer that is not a sell is refused (`MutableOwner`, 6010) if the receiving token account lacks Token-2022's `ImmutableOwner` extension, unless the receiver is owned by an exempt launchpad PDA. Every Token-2022 associated token account has the extension. | `guard_end_ts` |
| Guard length | `guard_secs`: from `open_delay + 600 s` up to 72 h | All rules above stop. | `T0 + guard_secs` |

Bounds are enforced twice: by `create_launch` (`policy::validate`) and again by the hook in `create_policy` (guard at most 72 h, shield at most 1 h and no longer than the guard, max wallet at least supply / 1,000 and max buy at least supply / 10,000 when on). Caps are computed from the supply right after pool creation, and a non-zero percentage that would round down to a zero cap is rejected.

The batch authority and the launch authority PDAs are **exempt owners**: transfers from or to them skip the caps and the lock, so batch claims can pay out at any time. Exemptions are looked at only *after* the snipe shield, so no exempt account can be used to buy early.

## Decision order

A **buy** is any transfer whose source is the policy's DBC base vault, whatever its destination and amount. A **sell** is a transfer into the base vault from any other account. The order is part of the safety argument (`execute`, then `rules::evaluate`):

::figure hook-order

| Step | Check | Result |
|---:|---|---|
| 1 | The mint has no Noised policy | allow |
| 2 | The policy belongs to another mint | refuse `PolicyMismatch` |
| 3 | Not a buy, and either a sell or a zero amount | **allow**, from account keys and the amount alone |
| 4 | `now >= guard_end_ts` | allow |
| 5 | A buy before `snipe_shield_end_ts` whose current top-level instruction is not the launchpad's `execute_batch` | refuse `SnipeShield` |
| 6 | Zero amount (only a buy can reach here with one) | allow |
| 7 | Source or destination owner is exempt | allow |
| 8 | Not a buy and the wallet-to-wallet lock is on | refuse `TransfersLocked` |
| 9 | `max_buy != 0` and `amount > max_buy` | refuse `MaxBuy` |
| 10 | `max_wallet != 0` and the destination would exceed it | refuse `MaxWallet` |
| 11 | otherwise | allow |

Step 5 comes before steps 6 and 7 on purpose. A buy that pays out nothing still moves the pool: DBC 0.2.1 executes an exact-in buy whose output rounds to zero, and it still moves the price and the volatility accumulator. And anyone can open a token account whose owner is an exempt PDA. Neither may let a buy through the shield (audit rounds 1 and 1b).

:::note Audit round 3, fix F2
Changing a token account's owner (`SetAuthority`) moves no tokens, so the hook never sees it: a position bought into a hand-made account could change hands during a locked guard, and one owner could gather many accounts each at max wallet. F2 added one refusal to step 7: after an exempt **destination** is allowed, a receiver without the `ImmutableOwner` extension is refused (`MutableOwner`, 6010, "Launch guard: the receiving token account must have an immutable owner while the guard is on"); only then is an exempt **source** allowed, so batch claims land only in such accounts too (they pay Token-2022 ATAs). The hook reads the extension from the receiving account's own data, so neither the meta list nor the policy layout changes. Buys into ATAs, claims, vault `release` payouts and Shield wraps keep working; sells are never affected. The SDK already refuses such receivers before you sign (`buildSwapTx`, `buildReleaseToTx`) and names error 6010.
:::

## How the hook recognizes the batch buy

The hook reads the instructions sysvar, only for buys during the shield: the transaction's **currently executing top-level instruction** must belong to the launchpad (`CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`) and its data must start with `execute_batch`'s 8-byte discriminator (`EXECUTE_BATCH_DISCRIMINATOR`). This is sound because:

- the sysvar lists only top-level instructions, each with the program it really invokes, and during a CPI its current index stays on the top-level instruction that started the chain;
- the sysvar accessors refuse any account other than the real sysvar, and the meta list pins its address;
- `execute_batch` makes exactly one DBC swap, for its own launch's pool, at most once;
- the launchpad is fixed code once finalized.

So `execute_batch` must be sent as a top-level instruction. Called by CPI, its buy is refused; other instructions may share the transaction.

## Ending the shield at the batch

`execute_batch` calls `noised_hook::end_snipe_shield` once the batch has bought. Its only effect is `snipe_shield_end_ts = min(snipe_shield_end_ts, now)`: the end can only move earlier, every other field (the guard rules and their end included) stays as written, and only the launchpad's hook-authority PDA can sign it, inside a top-level `execute_batch` (`NotInBatch`). That is why a 10-minute execution window never delays public trading.

## Hook accounts

Every transfer of a hooked mint carries four extra accounts, in this order for the launchpad: the `ExtraAccountMetaList` at `["extra-account-metas", mint]`, the policy `["policy", mint]`, the instructions sysvar and the hook program. The meta list holds exactly two entries (the policy PDA and the instructions sysvar) and is written once, deterministically, by anyone. Without these accounts a hooked transfer fails closed. `noisedHookAccounts(mint)` returns them; `canonicalizeLaunchGuardAccounts` puts the accounts Meteora's SDK resolves into the launchpad's canonical order.

## Guarantees

- **Sells are never refused** by the hook (step 3), checked by a 200,000-case property test and under the mainnet Token-2022 binary.
- **Everything is allowed after `guard_end_ts`**, at most 72 hours after launch.
- **Mints without a Noised policy are never restricted.**
- **No honeypot.** The policy is written once, only by the launchpad, and has no update instruction. The only change ever made to it is the batch ending the shield earlier.
- **Gone at graduation.** The swap that completes the curve sets the hook's program and authority to None. From then on Token-2022 never calls Launch Guard for that mint again. DAMM v2 forwards no hook accounts, so this revocation is also what makes graduation possible.

## Caveats

- Max wallet and max buy are per token account and per transfer: many wallets get around them.
- **The wallet-to-wallet lock stops token transfers, not shared control.** During the guard it stops transfers between holders' accounts, and with F2 it also stops consolidation by handing an account to another owner. It cannot see several people controlling one wallet (a multisig, a smart wallet, a shared key), which needs no transfer at all.
- **Max wallet also applies to accounts many people pay into.** The Shield's escrow for a mint is one account, and a holder of about max-wallet tokens can fill it, after which every wrap of that token fails until the guard ends. Plain transfers can likewise top up someone's associated token account to max wallet, after which buys and vault `release` payouts into it fail until then (`release_to` elsewhere still works). Griefing only, at most 72 hours, nothing lost.
- During the guard, deposits into a PQ vault and vault payouts of that token are wallet-to-wallet transfers, so the lock and max wallet apply to them. A refused payout stays reserved and can be released after the guard.
- The hook sees a buy only as the Token-2022 transfer DBC makes for it. DBC 0.2.1 makes one for every buy, even one that pays out nothing. A Meteora upgrade that changed that would let a buy run unseen; the first-swap rule then turns the batch into a full refund. Meteora's upgrade multisig and operators are listed in [Security](/docs/security#who-you-still-trust).
- Creators cannot bring their own hook program: a creator-controlled hook could refuse sells, which is exactly the honeypot Noised exists to prevent.
