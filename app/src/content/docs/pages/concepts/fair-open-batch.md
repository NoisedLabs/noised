---
title: Fair-open batch
summary: Commits are pooled and bought in one swap at the opening price, then shared out pro rata, so racing, splitting wallets or committing first gains nothing.
---

On most launchpads the first block decides everything: bots and insiders buy first, at the lowest price, and sell into everyone else. Noised replaces that race with a **batch**. During the commit window anyone commits wSOL. When the window closes, one instruction buys for everybody in a single swap, as the pool's first trade, and every participant gets the same average price.

## Commit

`commit(amount)` moves `amount` wSOL from the committer's token account into the batch escrow (the wSOL ATA of the batch-authority PDA `["batch", launch]`) and records it in `["commit", launch, owner]`.

- **Window:** `launch_ts <= now < commit_end_ts`, otherwise `NotCommitWindow`. `amount > 0`.
- **Wallet cap:** a wallet's total commit may not exceed `batch_wallet_cap` (when non-zero), otherwise `CapExceeded`. The cap is per wallet, and anyone can split across wallets, so it only limits naive concentration.
- **Total cap:** `batch_total_cap` is how much the batch *swaps*. It never refuses a commit: commits above it are accepted and refunded pro rata at claim.
- **Payout owners:** the first commit fixes who receives the payouts: `token_owner` (the tokens) and `refund_owner` (the unspent wSOL), each either the committer itself or a Noised PQ vault of the right mint. Later commits must pass the same two accounts and `claim` pays only them. The SDK takes them as `buildCommitTx` options and the app's batch panel offers them (see [Commit & claim](/docs/guides/commit-and-claim#claim-into-a-vault)).
- **One wallet's cap per vault:** claims are exempt from the Launch Guard, so every commit naming the same vault is added up in `["payout-vault", launch, vault]` and held to `batch_wallet_cap` together (`CapExceeded`). Otherwise unrelated wallets could pool guard-exempt shares into one account.

`buildCommitTx(conn, owner, launch, lamports, { tokenOwner?, refundOwner? })` wraps SOL into the owner's wSOL account and commits it in one transaction. When that account did not exist before, the transaction closes it again afterwards, so its rent returns to the owner.

## Execute

`execute_batch()` is permissionless and runs once, in `[commit_end_ts, execute_end_ts)`, a window of 600 seconds. It:

1. requires `total_committed > 0` and that the batch has not executed;
2. requires that **the pool has never been traded** (DBC's `has_swap == 0`), otherwise `PoolAlreadyTraded`;
3. swaps `amount_in = min(total_committed, batch_total_cap)` through DBC `swap2_with_transfer_hook` in PartialFill mode with a minimum output of zero (safe: nobody else can buy first);
4. records `quote_spent` and `tokens_out` from the escrow balance differences, requires `quote_spent <= amount_in` and `tokens_out > 0` (`EmptySwap`);
5. ends the snipe shield at once through `noised_hook::end_snipe_shield`, so public trading opens immediately instead of at the end of the window.

`execute_batch` must be a **top-level** instruction: the hook recognizes the batch buy only when the transaction's currently executing top-level instruction is the launchpad's `execute_batch`, so a CPI'd call has its buy refused. Other instructions may share the transaction.

## Claim

`claim(owner)` is permissionless: anyone may crank it, and funds only ever go to the payout owners the first commit fixed, into their canonical associated token accounts (created if missing; the caller pays the rent). Each commit is paid once (`AlreadyClaimed`).

Let `C` be the total committed, `c` one commit, `Q` the wSOL the batch spent and `T` the tokens it bought:

```math
S = min(C, cap)                  what the batch may spend (upper bound while pending)
tokens(c) = ⌊ T · c / C ⌋        base tokens to the token owner
refund(c) = ⌊ (C − Q) · c / C ⌋  unspent wSOL to the refund owner
```

An oversubscribed batch is therefore filled pro rata: every commit gets the same fraction `Q / C` spent and the rest back. If the batch expired (never executed), every commit is refunded in full.

::figure batch

### Invariants

- `Σ commits == total_committed`.
- `quote_spent <= min(total_committed, batch_total_cap)`.
- Every commit is paid at most once; total payouts never exceed `tokens_out` and `total_committed − quote_spent` (`PayoutExceedsEscrow` guards the running totals `tokens_claimed` and `quote_refunded`).
- An expired batch refunds 100%.
- Rounding dust (under one base unit per participant per asset) stays in the escrows forever.

## Why it is fair

- **No head start.** Until the batch buys, the hook refuses every buy from the pool, of any size and into any account, the creator's included. The batch is the pool's first swap or it refunds.
- **One price.** Everyone in the batch pays the same average price, `Q / T`.
- **Nothing to gain by racing.** Order inside the commit window does not matter, and a commit bundled into the `launch` transaction is pro-rated like any other.
- **Nothing to gain by splitting.** Shares are proportional to lamports, so ten wallets get exactly what one wallet with the same total gets.

## What it does not promise

- **Equal allocation.** A participant with more capital gets a proportionally larger share, at the same price.
- **That the batch happens.** Anyone who can keep `execute_batch` out of blocks for the whole execution window forces an expiry: block producers and ordering gateways for free, anyone else by filling the per-block write budget of the launch's accounts for ten minutes. Everyone is then refunded in full and trading opens without a batch buy. The 10-minute window makes that cost grow with time instead of taking seconds; [run a keeper](/docs/guides/keeper) with priority fees to make sure it executes.
- **That your vault's quota stays yours.** Anyone may commit naming your PQ vault as its token owner, which uses up that vault's one-wallet cap: your own commit naming it then fails `CapExceeded`. The tokens that commit buys still go to your vault (its unspent wSOL goes back to the committer's own refund owner), so it costs the griefer what the batch spent, as a donation to you (audit round 3, a documented residual). Open a fresh vault and commit to it in one transaction, so nobody sees its address first.
- **A large batch.** Since policy v2 a non-zero `batch_total_cap` is at least 10% of the threshold and a non-zero `batch_wallet_cap` at least the resolved total cap / 200, so a creator cannot shrink the fair open to dust. The verifier still reports the cap as a share of the threshold.
