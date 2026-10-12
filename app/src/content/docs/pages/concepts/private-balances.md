---
title: Private balances (Shield)
nav: Private balances
summary: Wrap a token 1:1 into a zToken with Token-2022 Confidential Balances to hide balances and transfer amounts. Parties stay visible, and the encryption is not post-quantum.
---

Shield (`noised_shield`, `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`) is Noised's opt-in privacy layer. It wraps a supported token 1:1 into a **zToken**: a Token-2022 mint with Confidential Balances, which can hide your balance and the amounts you send. Unwrapping gives the original token back. Meteora's pools cannot trade confidential tokens, so privacy is a separate, reversible layer next to the tradeable token.

:::warn It hides how much, not who
Everyone can still see which accounts transact with which. Shield is not Zcash: Confidential Balances hide balances and amounts only, and their encryption (twisted ElGamal over Curve25519) is not post-quantum.
:::

## What is hidden

| Information | Hidden? |
|---|---|
| Your zToken balance while held confidentially | **yes**, encrypted under your ElGamal key |
| The amount of a confidential transfer | **yes** |
| That a transfer happened, and between which accounts and owners | no |
| Wrap and unwrap amounts | no |
| Deposit (public to confidential) and withdrawal (confidential to public) amounts | no |
| Timing, fee payers, the transaction graph | no |
| Total zToken supply and the escrow backing it | no |

The private part of a zToken's life is the time between a deposit into the confidential balance and a withdrawal back out. Amounts and timing at the edges are public and can be correlated.

::figure shield

## How it works

| Instruction | Who | What |
|---|---|---|
| `create_shield()` | anyone, once per base mint | creates `Shield ["shield", base_mint]`, the zToken mint `["z-mint", base_mint]` and the escrow, the ATA of `["shield-authority", base_mint]` |
| `wrap(amount)` | holder | moves `amount` base tokens into the escrow (`transfer_checked`, hook accounts forwarded), then mints zTokens equal to what the escrow **actually received** |
| `unwrap(amount)` | holder | burns `amount` zTokens from the holder's **public** zToken balance and releases `amount` base tokens; any base-mint transfer fee is charged to the unwrapper |
| confidential operations | holder, client-side | plain Token-2022 instructions: configure, deposit, apply pending, transfer, withdraw |

The zToken mint, re-verified on the live account after creation: `ConfidentialTransferMint` with **no authority**, auto-approval of new accounts and **no auditor key**; metadata pointing at itself with no update authority (name `"Shielded " + name`, symbol `"z" + symbol`, truncated; the base mint's uri only if it is at most 200 bytes with no invisible character, otherwise empty); the base mint's decimals; no freeze authority; a mint authority PDA used only by `wrap`.

## Guarantees

- **Fully backed:** escrow balance ≥ zToken supply after every shield instruction. Strict equality cannot be enforced (anyone can donate to the escrow or burn zTokens), so each instruction checks exact deltas and surplus stays in the escrow.
- **Nobody controls a zToken:** no freeze, confidential-transfer or metadata authority, no auditor.
- **One shield per base mint**, never modified or closed.
- **Only safe base mints:** SPL Token, or Token-2022 with extensions within {MetadataPointer, TokenMetadata, TransferHook, TransferFeeConfig}. Everything else fails closed.

## Limits

- A zToken inherits its base mint's powers over the escrow: a freeze authority can strand every holder, a hook can make wraps fail, a fee authority can raise the unwrap fee. Noised launch tokens have none of these once graduated.
- During a launch's guard window, wrap and unwrap are wallet-to-wallet transfers: refused under the wallet-to-wallet lock and limited by max wallet. The escrow is **one** account for every holder of the mint, so a holder of about max-wallet tokens can fill it, after which every wrap fails until the guard ends (audit round 3; griefing only, nothing lost). Shield launch tokens after the guard ends.
- The ElGamal key is derived from a signature of your Ed25519 wallet. Whoever recovers the wallet key can re-derive it, and a quantum computer could decrypt recorded ciphertexts later.
- The ZK ElGamal proof program has a validator kill switch. It was disabled from 2025-06-19 to 2026-06-04; while disabled, confidential balances could not be withdrawn. Keep in the confidential balance only what you can afford to have frozen for a long time.
- At most 2^48 − 1 base units per deposit or confidential transfer. A confidential transfer spans several transactions.

See [Wrap & unwrap](/docs/guides/private-balances) for the commands.
