---
title: Buy into a vault
summary: Get a launched token into post-quantum custody: through the batch, by swapping straight into your vault, or by depositing after a buy.
---

Tokens in an ordinary wallet are protected by an Ed25519 key, which a quantum computer could break. Tokens in a [PQ vault](/docs/concepts/pq-vault) move only with a hash-based signature. There are three ways to get a launched token there.

## 1. Through the batch

At your first commit, name your PQ vault of the launched token as `token_owner` (and, if you like, a wSOL vault as `refund_owner`). The batch tokens are then paid by `claim` straight into the vault's token account, and nothing ever passes through a wallet. Claims are exempt from the Launch Guard, so this works during the guard window too; see [Claim into a vault](/docs/guides/commit-and-claim#claim-into-a-vault).

## 2. Buy, then deposit

After the open, buy with your wallet, then deposit into the vault. The deposit address is the vault's **token account**, ATA(vault, mint), never the vault PDA itself.

```ts title="deposit.ts"
import { buildSwapTx, fetchVault, buildDepositTx } from "@noisedlabs/sdk";

// 1. buy (DBC while the curve runs, DAMM v2 after graduation); slippage capped at 50%
const { tx: buy, quote } = await buildSwapTx(conn, wallet.publicKey, mint, "buy", 1_000_000_000n, 100);

// 2. once the buy landed, deposit it (at least quote.minimumOut arrived; read your balance for the exact amount)
const vault = await fetchVault(conn, vaultAddress);
console.log("deposit address", vault?.tokenAccount.toBase58());
const deposit = await buildDepositTx(conn, wallet.publicKey, mint, vaultAddress, quote.minimumOut);
```

:::warn During the guard window
A deposit is a wallet-to-wallet transfer for the Launch Guard. If the launch paused wallet-to-wallet transfers (`p2p_locked`), deposits are refused until `guard_end_ts`, and max wallet applies to the vault's token account as the receiver. Deposit after the guard, or use the batch.
:::

:::danger Never send to the vault PDA
Native SOL or tokens of another mint sent to the vault address itself can never be moved. Always use the deposit address the SDK or the app shows. For wSOL vaults, `buildDepositTx` sends SOL into the token account and calls `SyncNative`.
:::

## 3. Swap straight into a vault

`buildSwapTx` can route the output of a buy to another owner's associated token account: name your PQ vault of the launched token as `recipient`, and the tokens land in its token account without ever touching an Ed25519 wallet. It works on the bonding curve and after graduation. Show the returned `warnings` before signing.

```ts title="buy-into-vault.ts"
const { tx, quote, warnings } = await buildSwapTx(conn, wallet.publicKey, mint, "buy", 1_000_000_000n, 100, {
  recipient: vaultAddress, // an opened PQ vault of this mint
});
```

The SDK refuses recipients that would strand the tokens: token accounts and mints, programs, vaults of another mint and off-curve addresses with no account. A buy is not a wallet-to-wallet transfer, so the guard's lock does not apply to it; max wallet does, with the vault's token account as the receiver. The output goes to the recipient's associated token account, which always has an immutable owner, so the guard's fixed-owner rule (audit round 3, F2) never refuses it; `buildSwapTx` refuses a buy into a token account whose owner could change while the guard is on (`MutableOwner`, 6010).

The app's trade panel has the same option: a buy can go straight into your quantum vault.

## Fees into a vault

Creators can make a PQ vault of wSOL a fee recipient: `distribute` pays the canonical wSOL ATA of each recipient, which for a vault is its own token account. The platform treasury already works this way: it must be a wSOL PQ vault.
