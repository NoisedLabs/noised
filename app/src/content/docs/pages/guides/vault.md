---
title: Open, deposit, withdraw, release
nav: Vault: open to release
summary: The full PQ vault flow with the SDK, in the order that never signs twice: phrase, ledger, open, deposit, check and confirm the recipient, sign once, broadcast, deliver.
---

Read [PQ vault](/docs/concepts/pq-vault) first: the rules below exist because an LM-OTS key must never sign twice.

:::steps
### Create the recovery phrase

The PQ recovery phrase is a dedicated 24-word BIP-39 phrase, separate from any wallet. It is the only way to the funds: no admin, recovery key or reset exists. (In the app, a passkey can stand in for typing the phrase: it derives the same kind of master, and its 24 words are the backup.)

```ts title="phrase.ts"
import { generateRecoveryPhrase, masterFromPhrase } from "@noisedlabs/sdk";

const phrase = generateRecoveryPhrase();  // 256 bits from the platform CSPRNG: write it down, offline
const master = masterFromPhrase(phrase);  // 64-byte BIP-39 seed; keep in memory only, wipe after use
```

### Set up the vault-key ledger

Every signing call needs a durable **vault-key ledger**: one record per one-time key, written before its signature exists. Use one ledger per browser profile or machine, on a store whose `add` is atomic (IndexedDB `add()`, an SQL `INSERT`, an exclusive file create), and in a browser pass a cross-tab lock.

```ts title="ledger.ts"
import { createVaultKeyLedger } from "@noisedlabs/sdk";

const ledger = createVaultKeyLedger(store, { lock: (name, fn) => navigator.locks.request(name, fn) });
await navigator.storage.persist();        // ask the browser to keep the records
```

Holding the phrase on two devices? Share one ledger, or before the second device signs, move the signed records: `exportVaultKeyRecords(ledger)` on the first, `importVaultKeyRecords(ledger, exported)` on the second. An import is authenticated and add-only; refuse to sign while its `unverifiable` list is not empty, and broadcast at once any key it reports as `compromised`.

### Open {#open}

Vault number `account` of a phrase for a mint is opened by its genesis key (`sequence = 0`). Check the mint first and show its warnings.

```ts title="open.ts"
import { checkVaultMint, deriveVaultKey, buildOpenVaultTx, vaultAddress } from "@noisedlabs/sdk";

const mintCheck = await checkVaultMint(conn, mint);
if (!mintCheck.eligible) throw new Error(mintCheck.refusals.join("\n"));
for (const w of mintCheck.warnings) console.warn(w); // freeze, pause, hooks: can delay payouts

const genesis = deriveVaultKey(master, "mainnet", mint, 0, 0); // account 0, sequence 0
const tx = await buildOpenVaultTx(conn, wallet.publicKey, mint, genesis.pk);
const vault = vaultAddress(mint, genesis.keyId);               // ["vault", mint, genesis key id], forever
```

`preparePqVault(conn, { master, cluster, mint, payer })` does the same in one call and returns `openTx: null` when the vault is already open.

### Deposit

Anyone can deposit with an ordinary transfer into the vault's token account. `buildDepositTx` does it (for wSOL: a SOL transfer plus `SyncNative`).

```ts title="deposit.ts"
import { buildDepositTx, fetchVault } from "@noisedlabs/sdk";

const info = await fetchVault(conn, vault);
console.log("deposit address:", info?.tokenAccount.toBase58()); // ATA(vault, mint), never the vault PDA
const depositTx = await buildDepositTx(conn, wallet.publicKey, mint, vault, 1_000_000n);
```

### Check the recipient and confirm it

A signed withdrawal names its recipient forever, so the user confirms the recipient check before anything is signed. `checkRecipient` refuses recipients that would lose the payout (a token account, a mint, the vault itself, a payout address, another program's account) and lists cautions in three kinds, each needing its own acknowledgment.

```ts title="recipient.ts"
import { checkRecipient } from "@noisedlabs/sdk";

const recipient = await checkRecipient(conn, recipientWallet, mint, vault, { wallet: wallet.publicKey });
if (!recipient.ok) throw new Error(recipient.refusals.join("\n")); // never sign then
const acknowledged = {
  recipientWarnings: await ask(recipient.recipientWarnings),        // e.g. "this wallet has never been used"
  mintWarnings: await ask(recipient.mintWarnings),                  // e.g. "the mint has a freeze authority"
  offCurveConfirmation: await askOffCurve(recipient.offCurveConfirmation),
};
```

### Prepare and sign once

`prepareWithdrawal` runs the safe order in one call, on private copies of the request and the confirmation: it checks the confirmation, the cluster (genesis hash), the ledger and the vault's history for a withdrawal the current key already signed, runs the recipient check again, reserves the key in the ledger, and only then signs one deterministic signature naming the key at `sequence + 1`. The signature is recorded before it is returned.

```ts title="withdraw.ts"
import { prepareWithdrawal, VaultKeyInUseError } from "@noisedlabs/sdk";

const prepared = await prepareWithdrawal(
  conn, master, "mainnet", mint, 0,
  { destinationOwner: recipientWallet, maxAmount: 500_000n },   // a WALLET; min(maxAmount, unreserved) is reserved
  { ledger, confirm: { recipient, acknowledged } },
);
master.fill(0);

// prepared.pending: the key already signed a withdrawal: re-broadcast THAT one; nothing new was signed.
// prepared.signed.args: what was signed (show these, not the form). signed.reused: the ledger's own record.
```

It throws `VaultKeyInUseError` when the ledger holds this key for another withdrawal (re-broadcast `error.withdrawal`), `RecipientConfirmationError` when the confirmation is missing, for another recipient, or stale (show `error.current` and ask again), and `IncompleteSearchError` when the history search could not finish. There is no override: pass `error.search.continuation` back as `continueFrom`, or use an RPC that keeps the full history. Never sign while the search is incomplete.

### Broadcast

The withdrawal is a v1 transaction paid by a throwaway fee payer. Fund it from your wallet, then send withdraw + release together when the release would succeed now. The builder simulates (and so reveals) only a signature the ledger holds for this exact withdrawal.

```ts title="broadcast.ts"
import { Keypair } from "@solana/web3.js";
import { buildFundFeePayerTx, buildWithdrawTxWithFallback, sendAndConfirm } from "@noisedlabs/sdk";

const feePayer = Keypair.generate(); // no authority over the vault
await sendAndConfirm(conn, await wallet.signTransaction(await buildFundFeePayerTx(conn, wallet.publicKey, feePayer.publicKey)));

const args = toArgs(prepared);       // prepared.signed.args, or the pending withdrawal's arguments
const built = await buildWithdrawTxWithFallback(conn, feePayer, args, { ledger });
if (!built.simulation.ok) throw new Error(built.simulation.error ?? "withdraw would fail");
await sendAndConfirm(conn, built.tx, { lastValidBlockHeight: built.lastValidBlockHeight }); // signed v1 wire bytes
console.log(built.includesRelease ? "paid" : `reserved; release later (${built.releaseError})`);
```

If the transaction is dropped or expires, rebuild it from the **recorded** signature (any fresh fee payer, new blockhash) and send again. Never sign a new message for the same sequence.

### Deliver later if needed

A payout that could not be delivered stays reserved. Anyone can release it to the recipient's canonical account, or the recipient signs `release_to` into any of its token accounts.

```ts title="release.ts"
import { listPayouts, buildReleaseTx, buildReleaseToTx, buildRefundFeePayerTx } from "@noisedlabs/sdk";

const { payouts } = await listPayouts(conn, vault);
for (const p of payouts) {
  const tx = await buildReleaseTx(conn, wallet.publicKey, { vault, mint, sequence: p.sequence });
  // or, signed by the recipient: buildReleaseToTx(conn, recipient, { vault, mint, sequence: p.sequence, destination })
}
// finally return the fee payer's SOL (the payout's rent comes back to it on release)
```

While a launch's guard is on, `buildReleaseToTx` refuses a destination whose owner can be reassigned (no `ImmutableOwner` extension; the hook's `MutableOwner`, 6010, audit round 3 fix F2). Every Token-2022 associated token account has a fixed owner.
:::

## Recover from the phrase alone

`scanVaults(conn, master, cluster, mint, maxAccount)` walks accounts 0, 1, 2 … and reports each vault's address, sequence, balance, reserved amount, unreleased payouts and whether its current key is this phrase's. Before signing anything for a recovered vault, the same rules hold: a ledger, a confirmed recipient, and a search for a pending withdrawal first (`prepareWithdrawal` does all three).

## Errors you may see

| Error | Meaning |
|---|---|
| `InvalidSignature` (6001) | the signature does not verify with the vault's current key and sequence: usually a stale sequence (someone already executed a withdrawal) |
| `InvalidNextKey` (6002) | the next key equals the current key |
| `KeyIdMismatch` (6000) | the next public key does not hash to the signed `next_key_id` |
| `InvalidKeyIndex` (6006) | a genesis key with `q ≠ 0`, or a next key whose `q` is not `sequence + 1` |
| `UnsupportedMint` (6003) | the mint has an extension a vault cannot protect |
| `InvalidDestination` (6004) | `release` was given an account that is not the recipient's canonical ATA |
| Launch Guard `TransfersLocked`, `MaxWallet`, `MutableOwner` (hook 6001, 6003, 6010) | a payout of a launched token during its guard: it stays reserved; release it after `guard_end_ts` |
