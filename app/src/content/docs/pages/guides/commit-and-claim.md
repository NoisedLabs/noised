---
title: Commit & claim
summary: Join a fair-open batch, see your expected fill before you sign, and collect your tokens and refund, optionally straight into a PQ vault.
---

## Before you commit

Check the launch first: `verifyLaunch(conn, mint)` must not report `fail`, and the batch caps should make sense. Then look at the expected fill:

```ts title="fill.ts"
import { fetchLaunch, expectedBatchFill } from "@noisedlabs/sdk";

const launch = await fetchLaunch(conn, launchAddress);
if (!launch) throw new Error("no such launch");

const mine = 2_000_000_000n; // 2 SOL
const fill = expectedBatchFill(launch, mine);
console.log(`batch spends at most ${fill.fill} of ${fill.totalCommitted} lamports`);
console.log(`your commit: about ${fill.commit.spent} spent, ${fill.commit.refund} refunded`);
```

While the batch is pending, the fill is an upper bound: `fill = min(total, cap)`, and every commit is spent in the same proportion `fillBps / 10,000`. Commits keep arriving until the window closes, so the final fill can be lower than what you see now.

## Commit

`commit` runs only in the commit window (`NotCommitWindow` otherwise). It moves wSOL from your token account into the batch escrow; `buildCommitTx` wraps your SOL first and, if it created your wSOL account, closes it again in the same transaction.

```ts title="commit.ts"
import { buildCommitTx, simulateAndExplain, sendAndConfirm } from "@noisedlabs/sdk";

const tx = await buildCommitTx(conn, wallet.publicKey, launchAddress, mine);
const sim = await simulateAndExplain(conn, tx);
if (!sim.ok) throw new Error(sim.error ?? "commit would fail"); // e.g. CapExceeded: above your per-wallet cap
await sendAndConfirm(conn, await wallet.signTransaction(tx));
```

You can commit several times; each adds to your `["commit", launch, owner]` record, up to `batch_wallet_cap`. The total cap never refuses you.

## Claim

After the batch executes, or after it expires, anyone may run `claim(owner)` for your commit. Funds only ever go to your payout owners, into canonical associated token accounts created if missing:

- **Executed:** `⌊tokens_out · c / total⌋` base tokens and `⌊(total − quote_spent) · c / total⌋` wSOL.
- **Expired:** your whole commit back in wSOL.

```ts title="claim.ts"
import { buildClaimTx } from "@noisedlabs/sdk";

const tx = await buildClaimTx(conn, wallet.publicKey, launchAddress, wallet.publicKey);
// payer = owner: if the transaction created your wSOL account, it closes it, so the refund arrives as SOL
```

A claim made by someone else for you leaves the refund as wSOL in your wSOL account (a third party cannot close it). `claim` fails with `BatchPending` before execution or expiry and `AlreadyClaimed` after a claim.

:::note Your wSOL account
`claim` pays your canonical wSOL ATA wherever its owner field points. If you ever reassigned that account (or a drainer tricked you into it), the refund goes where it now points. Your base tokens always reach you: a Token-2022 account's owner cannot be reassigned.
:::

## Claim into a vault {#claim-into-a-vault}

Your **first** commit fixes two payout owners: `token_owner` (receives the tokens) and `refund_owner` (receives the unspent or refunded wSOL). Each is either you or a Noised PQ vault of the right mint: a vault of the launched token for `token_owner`, a wSOL vault for `refund_owner`. Later commits must pass the same two accounts, and `claim`, which anyone may crank, pays only them. No key, Ed25519 or otherwise, can redirect your share afterwards.

```ts title="commit-to-vault.ts"
import { buildCommitTx, fetchPayoutVault, preparePqVault, prepareFeeVault } from "@noisedlabs/sdk";

const tokenVault = await preparePqVault(conn, { master, cluster: "mainnet", mint: launch.baseMint, payer: wallet.publicKey });
const wsolVault = await prepareFeeVault(conn, { master, cluster: "mainnet", payer: wallet.publicKey });
// send tokenVault.openTx / wsolVault.openTx first when they are not null (in the same transaction as the commit is best)

const tx = await buildCommitTx(conn, wallet.publicKey, launchAddress, mine, {
  tokenOwner: tokenVault.vault, // an opened PQ vault of the launched token
  refundOwner: wsolVault.vault, // an opened PQ vault of wSOL (leave it out and the refund comes back to you)
  computeUnitPrice: 50_000n,    // a priority fee: commits compete for the launch's write lock
});
```

Because claims are exempt from the Launch Guard, a vault named by several committers is held to one wallet's batch cap **together**: the account `["payout-vault", launch, vault]` adds up every commit naming it (`fetchPayoutVault` shows how much is left). Anything else fails with `InvalidPayoutOwner`.

:::warn Anyone can use up a vault's quota
Anyone may commit naming your vault as its token owner, which fills that vault's one-wallet cap: your own commit naming it then fails `CapExceeded`. The griefer's tokens still go to your vault, so it costs them what the batch spent (audit round 3, a documented residual). Open a fresh vault and commit to it in the same transaction, so nobody sees its address first.
:::

The app's batch panel offers the token vault (your quantum vault of the launched token) and shows how much room it has left; the refund comes back to your wallet there. The tokens arrive in the vault's own token account, a Token-2022 associated token account, so they are in post-quantum custody from the first moment; a `p2p_locked` guard keeps them there until it ends.
