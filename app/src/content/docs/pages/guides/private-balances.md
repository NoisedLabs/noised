---
title: Wrap & unwrap private balances
nav: Wrap & unwrap
summary: Create a shield for a token, wrap into zTokens, move amounts privately with Token-2022 confidential transfers, and unwrap to trade again.
---

Read [Private balances](/docs/concepts/private-balances) first: Shield hides amounts, not parties, and its encryption is not post-quantum.

:::steps
### Create the shield (once per token)

Anyone can create the shield of a base mint, once. It fails if one exists already, so check first.

```ts title="shield.ts"
import { shieldAddresses, fetchShield, buildCreateShieldTx } from "@noisedlabs/sdk";

const { shield, zMint, escrow } = shieldAddresses(baseMint); // Token-2022 base mints by default
if (!(await fetchShield(conn, baseMint))) {
  const tx = await buildCreateShieldTx(conn, wallet.publicKey, baseMint);
  // simulate, sign, send
}
```

`buildCreateShieldTx` refuses base mints that `create_shield` would refuse: only MetadataPointer, TokenMetadata, TransferHook and TransferFeeConfig are allowed, and unknown extension types fail closed.

### Wrap

`wrap` locks base tokens in the escrow and mints zTokens equal to what the escrow received (less than `amount` under a transfer fee). For a Noised launch token the Launch Guard's four hook accounts are forwarded in canonical order.

```ts title="wrap.ts"
import { buildWrapTx } from "@noisedlabs/sdk";

const tx = await buildWrapTx(conn, wallet.publicKey, baseMint, 1_000_000n);
```

During a launch's guard window, wrapping is a wallet-to-wallet transfer: refused under the wallet-to-wallet lock and limited by max wallet. Wrap launch tokens after the guard ends.

### Go confidential

Confidential operations are plain Token-2022 instructions with zero-knowledge proofs, which the SDK does not generate. Use `spl-token` 5.6 or newer:

```bash title="terminal"
spl-token create-account <Z_MINT>
spl-token configure-confidential-transfer-account --address <Z_ACCOUNT>          # auto-approved: no authority exists
spl-token deposit-confidential-tokens <Z_MINT> <AMOUNT> --address <Z_ACCOUNT>    # public -> confidential (amount visible)
spl-token apply-pending-balance --address <Z_ACCOUNT>
spl-token transfer <Z_MINT> <AMOUNT> <RECIPIENT> --confidential                  # amount hidden
spl-token withdraw-confidential-tokens <Z_MINT> <AMOUNT> --address <Z_ACCOUNT>   # confidential -> public (amount visible)
```

Incoming confidential transfers land in a *pending* balance that the owner applies. Use proof tooling released after the 2026 re-enablement of the ZK ElGamal proof program: proofs from older bundles are rejected.

### Unwrap

`unwrap` burns zTokens from your **public** zToken balance and releases the same amount of base tokens. Withdraw from the confidential balance first; that amount is public.

```ts title="unwrap.ts"
import { buildUnwrapTx } from "@noisedlabs/sdk";

const tx = await buildUnwrapTx(conn, wallet.publicKey, baseMint, 1_000_000n);
```
:::

## Errors you may see

| Error | Meaning |
|---|---|
| `UnsupportedExtension` (6000) | the base mint has an extension Shield does not accept |
| `NothingReceived` (6003) | the transfer fee took the whole wrap |
| `Undercollateralized` (6004) | an invariant check: zToken supply would exceed the escrow |
| `SameAccount` (6008) | source and destination token accounts are the same |
