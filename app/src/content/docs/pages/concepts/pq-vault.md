---
title: PQ vault
summary: Token custody that only a one-time LM-OTS signature can open. Keys rotate in place with a sequence number, withdrawals reserve payouts, and delivery is a separate step nobody can block.
---

The PQ vault (`noised_vault`, `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`) holds tokens that move only as a payout an LM-OTS signature authorized. No Ed25519 key has any authority over them. It gives post-quantum *custody* inside a chain that is not post-quantum; [where that stops](#limits) is listed below.

## The signature scheme

LM-OTS, RFC 8554 §4, parameter set `LMOTS_SHA256_N32_W4` (typecode 3; the set is listed in NIST SP 800-208, but Noised's software keys claim no SP 800-208 approval). Rust: `crates/noised-lmots` (`no_std`, used on-chain); TypeScript twin: `sdk/src/pq/lmots.ts`. Both reproduce RFC 8554 Appendix F Test Case 2 byte for byte.

| Parameter | Value |
|---|---|
| Hash | SHA-256 (`sol_sha256` on-chain), n = 32 |
| Winternitz width | w = 4 (chains of 16 positions) |
| Chains | p = 67: 64 message digits + 3 checksum digits (ls = 4) |
| Signature | `C ‖ y[0..67]` = 32 + 67 × 32 = **2,176 bytes** |
| Public key | `I` (16 bytes), `q` (u32 leaf index), `K` (32-byte hash) |
| Key id | `SHA256(0x20 ‖ u32be(3) ‖ I ‖ u32be(q) ‖ K)` |
| Security | about 256-bit classical, about 128-bit generic quantum (a Grover search over the 256-bit digest) |

Each chain value is revealed at the position given by one digit of the message hash and its checksum. An attacker can only hash forward, which only raises digits; raising any message digit lowers the checksum, so some checksum digit would have to fall, which means inverting SHA-256. Every hash is tweaked with `I`, `q`, the chain index and the step, so work against one key or position does not help against another.

**One key signs one message, ever.** A second signature by the same key, of a different message or of the same message with a different randomizer `C`, can reveal enough chain values to forge others.

::figure winternitz

## Accounts

| Account | Address | Contents |
|---|---|---|
| `Vault` | `["vault", mint, genesis_key_id]` | version 4, mint, `genesis_key_id`, `sequence` (withdrawals executed), the current key (`key_id`, `I`, `q`, `K`), `reserved`. 174 bytes. Never closed. |
| Vault token account | ATA(vault, mint) | **The deposit address.** Never moves, never closed. |
| `Payout` | `["payout", vault, u64le(sequence)]` | sequence, `destination_owner`, `amount`, `rent_payer`. 122 bytes. Closed on delivery. |

The vault address commits to the key that opened it, so nobody can open a vault at someone else's address with a different key, and the genesis key id can never open a second vault. Since this release every key is bound to its position: the genesis key has `q = 0`, and the next key named by a withdrawal must have `q = sequence + 1` (`InvalidKeyIndex`).

## The protocol

::figure vault

- **`open_vault(key_id_arg, key)`**: creates the vault with `sequence = 0` and its token account. Refuses mints a vault cannot protect (below).
- **`withdraw(args)`**: verifies the LM-OTS signature over the 185-byte message with the vault's **current** key and **current** sequence. Then `amount = min(max_amount, balance − reserved)` (0 when paying the vault itself), `reserved += amount`, a `Payout` is created, `sequence += 1` and the key becomes the signed next key, which must differ from the current one. **No token moves.**
- **`release()`**: permissionless. Pays a payout to the canonical ATA of its recipient wallet, created if missing; sends an SPL Memo first when the account requires one.
- **`release_to()`**: signed by the recipient wallet. Pays any token account of the mint it names, for recipients whose canonical account cannot receive (confidential-only, frozen, or by preference). While a Launch Guard is on, a destination without Token-2022's `ImmutableOwner` extension waits for the guard to end (audit round 3, F2); the SDK's `buildReleaseToTx` refuses it before anyone signs.

Both delivery instructions subtract exactly the payout's amount from `reserved` and close the payout, returning its rent to whoever paid it. `withdraw` with `max_amount = 0` is a pure key rotation.

### The signed message (185 bytes)

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 8 | `"PHX-PQV4"` (domain tag and version) |
| 8 | 1 | `0x01` (withdraw) |
| 9 | 32 | program id |
| 41 | 32 | vault |
| 73 | 32 | mint |
| 105 | 8 | `sequence`, u64 little-endian (before this withdrawal) |
| 113 | 32 | `destination_owner`, the recipient **wallet** |
| 145 | 8 | `max_amount`, u64 little-endian |
| 153 | 32 | `next_key_id` |

Everything that matters is signed, so a relayer or fee payer can submit a withdrawal but cannot change it. The message has no blockhash or timestamp: a dropped transaction is re-sent with the **same** signature in a new transaction.

## Why a valid signature always executes

A revealed one-time signature must stay executable, or its owner would be tempted to sign a second message. `withdraw` therefore reads nothing a third party controls: the payer is the submitter's own signer, the mint is fixed by the vault and cannot be closed, the vault and the payout PDA belong to this program, and the vault's token account is read-only (only its balance is read). A recipient can delay only its own payout (a frozen or memo-requiring account, a hook), never the withdrawal and never the rest of the vault.

## Keys

Vault keys come from a **separate** 24-word PQ recovery phrase, never from a wallet. (The `phalanx/pq/...` tags below keep the project's original name: they are fixed protocol constants, and renaming them would change every key.) A user can hold several vaults per (cluster, mint), numbered by `account`:

```text
master = BIP-39 seed of the PQ phrase (64 bytes)
path   = cluster (1 byte) ‖ mint (32) ‖ u32le(account) ‖ u32le(sequence)
SEED   = SHA256("phalanx/pq/lmots/seed" ‖ master ‖ path)
I      = SHA256("phalanx/pq/lmots/id"   ‖ master ‖ path)[..16]
q      = sequence
C      = HMAC-SHA256(key = SEED, "phalanx/pq/lmots/C" ‖ I ‖ u32be(q) ‖ message)
```

The deterministic randomizer `C` (the construction FIPS 205 uses for SLH-DSA's `PRF_msg`) is unpredictable without `SEED`, and signing an identical message again reproduces the identical signature. Every signer must reproduce the known answer: `SEED = 0x11 × 32`, `I = 0x22 × 16`, `q = 7`, message `"phalanx"` (a fixed test input from the project's original name) gives `C = efff9f33…79d3`.

### Rules every client follows

1. **One key, one signature, ever.** Not for a corrected amount, not for another recipient, not with another randomizer.
2. **Reserve, then sign, then record.** A durable **vault-key ledger** (`createVaultKeyLedger`, on a store with an atomic add and, in a browser, a cross-tab lock) reserves the key for its withdrawal before any signature exists and records the signature before it is returned. Every tab and device sharing the ledger is then refused any other withdrawal for that key. Every SDK signing call requires one; there is no default.
3. **Re-broadcast, never re-sign.** Before signing at a vault's sequence, search its history, failed transactions included, for a signature already revealed (`findPendingWithdrawal`), and never sign while that search is incomplete. A dropped transaction is rebuilt from the recorded signature.
4. **Sign only for the current sequence**, with the key whose id equals the vault's `key_id`, naming the key at `sequence + 1`.
5. **Check the recipient, and have the user confirm it.** `checkRecipient` refuses a token account, a mint, the vault, a payout address or another program's account as recipient (each would lose the payout), and lists cautions in three kinds: about the recipient, about the mint, and an off-curve recipient with no account. The signer requires the user's separate acknowledgment of each kind present (`opts.confirm`), runs the check again right before signing, and refuses if anything new appeared. A signed recipient can never be changed.
6. **One ledger per phrase, or move the records.** Two devices holding one phrase with two ledgers could each sign a different withdrawal with one key. Share one ledger, or export the signed records on one device and import them on the other before it signs (`exportVaultKeyRecords`, `importVaultKeyRecords`: authenticated and add-only), or give each device its own vault accounts.

`prepareWithdrawal` runs these steps in order; see [Open, deposit, withdraw, release](/docs/guides/vault).

## Mints a vault refuses

| Refused | Why |
|---|---|
| NonTransferable | tokens could never leave |
| PermanentDelegate | an Ed25519 key could move tokens out of any account |
| MintCloseAuthority with an authority | at zero supply the mint could be closed and re-created with a permanent delegate |
| TransferFeeConfig with a live config or withdraw-withheld authority | a stolen authority could set a 100% fee and collect it |
| unknown extension types | fail to parse |

Freeze, pause and transfer-hook authorities are accepted: they can delay a payout but never block `withdraw` or take funds. `checkVaultMint` reports them as warnings. Graduated Noised tokens qualify: no mint, freeze or metadata authority and no hook.

## Cost

Measured in LiteSVM against the mainnet token programs (26 runs, 2026-10-08):

| Transaction | Size | Compute |
|---|---:|---:|
| `withdraw` alone (v1) | 2,693 bytes | ~79k–106k CU |
| `withdraw` + `release`, SPL Token (v1) | 2,845 bytes | ~121k–172k CU |
| `withdraw` + `release`, Token-2022 with Launch Guard (v1) | 2,977 bytes | ~145k–190k CU |

A `withdraw` carries 2,312 bytes of instruction data, so it must go in a **v1 transaction** (SIMD-0385, 4,096-byte limit, live on mainnet since 2026-09-15). The SDK builds it with a throwaway Ed25519 fee payer (it has no authority over the vault) and sets the v1 compute and loaded-data limits, which default to zero. `open_vault`, deposits, `release` and `release_to` are ordinary legacy transactions, so no user wallet ever has to sign a v1 transaction.

## Limits {#limits}

- **The token program.** Token-2022 is upgradeable by a 4-of-6 multisig; prefer SPL Token mints (such as wSOL) for the strongest custody.
- **The mint's own authorities** can freeze, pause or dilute; they cannot take vault funds.
- **`noised_vault` is upgradeable until finalized.**
- **Destinations.** Once paid to an ordinary wallet, tokens are Ed25519-protected again.
- **SOL or other mints sent to the vault PDA itself are unrecoverable.** Deposit only into the vault's token account.
- **Two ledgers, two signatures.** The program cannot see a signature that never landed. Two devices that hold one phrase but do not share their vault-key records can each sign a different withdrawal with one key before either lands, and anyone who sees both can forge a third (rule 6 above).
- **Reviews.** Internal AI-agent reviews found five vault issues in round 1 (four fixed in v4, one the documented limitation above) and one in round 2 (the key-index binding, fixed); round 3 found nothing in the vault's code.
