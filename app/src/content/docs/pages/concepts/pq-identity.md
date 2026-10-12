---
title: Post-quantum creator identity & attestation
nav: PQ identity & attestation
summary: Every launch is signed by its creator's hash-based LMS identity, verified on-chain, before it can go live, so a quantum computer that breaks Ed25519 still cannot launch as you, change your token's metadata or choose when it opens.
---

## Why wallets are not enough

Every Solana address is an Ed25519 public key. Shor's algorithm recovers an Ed25519 private key from its public key, so a cryptographically relevant quantum computer could sign as any wallet whose address it knows, and every address is public. Signatures and addresses recorded today stay forgeable later ("harvest now, forge later"). A launch authorized by the creator's wallet alone would then be authorized by whoever breaks that key.

Hash functions lose only to Grover's algorithm, a square-root speed-up: a preimage search on SHA-256 still costs about 2^128 quantum operations. Noised therefore signs launches with a **hash-based** key whose security rests on SHA-256 alone.

## The identity

A creator identity is an LMS key (RFC 8554; the parameter sets are listed in NIST SP 800-208): `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`. It is a Merkle tree of height 10 over **1,024 one-time LM-OTS leaves**.

| Item | Value |
|---|---|
| Public key | 56 bytes: `u32be(6) ‖ u32be(3) ‖ I (16) ‖ T[1] (32)`, the tree root |
| Signature | 2,508 bytes: `u32be(q) ‖ LM-OTS signature (4 + 2,176) ‖ u32be(6) ‖ path (10 × 32)` |
| Identity id | `pq_identity = SHA256(0x21 ‖ public key)` |
| Security | about 128-bit generic quantum security |
| Verification | RFC 8554 Algorithm 6a: candidate leaf key, then the authentication path to the root (leaf tag `0x8282`, interior tag `0x8383`), compared in constant time |

The on-chain account `["identity", pq_identity]` (196 bytes) stores the public key and a 128-byte **bitmap of used leaves**. A leaf is accepted once, ever: a second signature from one LM-OTS leaf would let an attacker forge others, and the bitmap turns "never sign twice" into a rule the program enforces.

The bitmap records signatures that **landed**. A signature that was revealed (simulated, dropped, or sent in a transaction that failed) leaves its bit clear, yet it must never be followed by a second message at that leaf. Clients therefore keep a durable **leaf ledger**: the leaf is reserved for its message before any signature exists, and the signature is recorded before it is returned. The SDK signs only through it (`leafLedger`), on a store with an atomic add, and re-broadcasts recorded signatures instead of signing again.

## Where the key comes from {#where-the-key-comes-from}

The identity key is **never** derived from your wallet. A wallet never reveals its private key, so a "post-quantum identity derived from your wallet" must hash a wallet *signature* on a fixed message. Two things are then wrong with it:

- **The secret is handed out on request.** A wallet returns that signature to any app the user approves one signing request for, today, with no quantum computer needed.
- **Its link to the creator is classical.** Whatever ties such an identity to its owner is an Ed25519 signature, and a quantum computer that recovers the wallet's key can produce one for any identity, its own included.

(Recovering the key with Shor's algorithm does not by itself recompute the old signature: RFC 8032 derives the signature's nonce from a second secret half of the key's hash. That changes nothing above.)

Noised offers two sources instead, both independent of every Ed25519 key:

- **A passkey.** The app asks your authenticator (Face ID, Touch ID, Windows Hello or a security key) for its WebAuthn PRF output, with user verification: an HMAC computed inside the authenticator with a per-credential secret. It is symmetric, so a quantum computer cannot derive it from anything public. The SDK turns it into the same kind of master as a phrase: `entropy = HKDF-SHA256(prf, salt "phalanx/pq/passkey/v1", info "phalanx/pq/passkey/v1/bip39-entropy", 32 bytes)`, then the BIP-39 seed of the 24 words of that entropy. You can export those 24 words as a backup. The passkey is bound to the app's exact host (its relying-party ID); a synced passkey also trusts its sync provider, and the PRF secret reaches roaming authenticators over classical channels.
- **A PQ recovery phrase.** A dedicated 24-word BIP-39 phrase, separate from any wallet. The same phrase can hold your PQ vaults; identities use their own path.

```text
path = cluster (1 byte: 0 mainnet, 1 devnet, 2 localnet) ‖ u32le(identity_index)
SEED = SHA256("phalanx/pq/identity/v1/seed" ‖ master ‖ path)
I    = SHA256("phalanx/pq/identity/v1/id"   ‖ master ‖ path)[..16]
```

`master` is the 64-byte BIP-39 seed. The cluster byte keeps a devnet identity from ever being a mainnet one, and every SDK signer checks the RPC's genesis hash before it signs. An all-zero master is refused everywhere: its keys would be public. Generating the 1,024-leaf tree takes about 0.6 s in Node on a desktop CPU, in time slices with progress; the app caches the tree, authenticated, so an identity loads in milliseconds afterwards.

## The attestation {#the-attestation}

`create_launch` records `pq_identity` inside `LaunchParams`, so it is covered by `params_hash` and the certificate. Before `launch` can run, that identity signs this **189-byte message v2**, which the program rebuilds from the `Launch` account and the signed terms (`pq::attestation_message`):

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 13 | `"PHX-ATTEST-V2"` |
| 13 | 32 | launchpad program id |
| 45 | 32 | launch address |
| 77 | 32 | `params_hash` (every creator choice, `pq_identity` included) |
| 109 | 32 | creator |
| 141 | 32 | `metadata_hash` of the token's [metadata record](/docs/concepts/token-metadata) |
| 173 | 8 | `not_before`, i64 little-endian |
| 181 | 8 | `not_after`, i64 little-endian |

The signature therefore covers every byte any reader will ever display (name, symbol, the uri mode and the document), and consensus stores those bytes.

::figure attest

`attest_launch(lms_pk, lms_sig, metadata_hash, not_before, not_after)` is **permissionless**: the signature authorizes, not the fee payer. A client sends it as a constant 2,972-byte v1 transaction from a throwaway key, and anyone may relay it. Its accounts are the payer, the launch, the identity, `["attestation", launch]`, the metadata record and the system program. The program:

1. checks that `SHA256(0x21 ‖ lms_pk)` names the identity account it was given, and verifies the LMS signature over the message (`InvalidPqSignature`);
2. burns the leaf: sets bit `q` in the identity's bitmap, or fails with `PqLeafUsed` if it was already set;
3. writes `["attestation", launch]` (2,676 bytes, version 2) with the full signature, the leaf, the metadata hash, the message hash, the slot and the window, **if** the signature attests: the identity is the one the launch names, the record at `["metadata", launch, metadata_hash]` exists, the window is valid and the attestation slot is free. Otherwise the leaf is only burned and the event `PqLeafConsumed` says so.

Any valid signature over an existing launch's message at an unused leaf always lands, to burn its leaf, whatever it signed and whatever the launch's status: an identity must never be left holding a revealed signature it cannot land. The leaf a message tries first is fixed by the message itself, `u16be(SHA256("phalanx/pq/identity/leaf" ‖ I ‖ message)[0..2]) mod 1024`, so a retry of the same message takes the same leaf and two different messages rarely meet.

Every account except the payer is fixed by the signed data. Anyone who lands the creator's signature with another metadata account gets `ConstraintSeeds` (2006): the transaction fails, nothing is written and the leaf is not burned, so the same signature is simply sent again. A relayer can land a signature or hold it back; it cannot change what it does.

### Burn-only landings

A signature that only burned its leaf leaves the launch unattested. The SDK reads the reason back (`confirmAttestation`): the record is missing or not yet final, the window is invalid, the identity is not the launch's, or the launch is already attested. Each new signature spends one of the identity's 1,024 leaves, so the SDK stops after two burn-only landings for one launch (`AttestRetryLimitError`, with the reasons) until the cause is fixed. It also refuses to sign before the launch and the record are finalized: a record lost in a dropped fork would turn the attestation into a burn.

### The launch window

The window is part of what the identity signs. An attestation fixes it only if it lasts **60 seconds to 1 hour**, has not ended, and opens at most **7 days** after the attestation lands. `launch` then runs only inside `[not_before, not_after]` (`NotLaunchWindow`), and inside it **anyone** may run it: the first `launch` transaction to land wins. No Ed25519 key, which a quantum computer could forge, decides what launches or when.

:::note Audit round 3, fix F1
Two rules of `attest_launch` come from audit round 3's fix F1. A window must still have **at least 60 seconds left** when its attestation lands (`max(now, not_before) + 60 ≤ not_after`); otherwise the signature only burns its leaf. And an attestation whose window **passed unused** can be replaced: while the launch is still `Configured` and `now > not_after`, a valid signature by the launch's identity overwrites every field of the old attestation. An unexpired attestation, and a live launch's, are never replaced; the certificate keeps the attestation that opened the launch. In the SDK, the flow step `window-missed` reads "Window passed: sign a new opening time": `replanLaunchWindow` keeps the launch and its record (or takes a new record, published first), and the identity signs the new window at its next leaf. Without F1, a launch nobody opened in time could never go live.
:::

## What `launch` checks

`launch` takes no arguments. It requires the attestation account and the record it names (`["metadata", launch, attestation.metadata_hash]`): their addresses, owners and fields must match the launch and its identity (`AttestationMismatch`), an empty attestation is refused, and the clock must be inside the window. The certificate (version 3, 487 bytes) then records `pq_identity`, the leaf `pq_leaf`, `attested_slot` and the record's address `metadata`, and sets check bits **1024 (`PQ_ATTESTED`)** and **2048 (`METADATA_ONCHAIN`)**: every certificate has all twelve bits set (`(checks & 4095) === 4095`; 8191 with creator rules, which add `RULES_BOUND`).

Anyone can re-verify a launch's origin from account state alone: the attestation keeps the whole 2,508-byte signature, and `verifyLaunch` re-verifies it over the message rebuilt from on-chain data (check `pq.origin`, `report.pqOrigin`).

## Compared with other designs

| | Wallet-derived "PQ identity" | Signature in off-chain metadata | Noised |
|---|---|---|---|
| Key source | a wallet signature, handed to any app the user approves | varies | passkey PRF or a separate phrase |
| Survives an Ed25519 break | no: its binding to the creator is an Ed25519 signature | n/a | yes |
| Verified by | client software | whoever reads the file | the launchpad, on-chain, by consensus |
| Gates the launch | no | no | yes: no attestation, no launch |
| One-time leaf reuse | tracked off-chain, if at all | n/a | on-chain bitmap plus a durable leaf ledger |
| Binds parameters, metadata and timing | no | partly | yes: the whole record, by its hash |
| Where the proof lives | off-chain | a file, while it is hosted | on-chain, forever |

## Residuals

- **Anyone may relay, so anyone may delay.** Whoever holds a pending attestation decides whether and when to land it. The creator can always re-broadcast the same bytes.
- **The first `launch` in the window wins**, whoever sends it. Write-lock contention on the `Launch` account can keep `launch` out of a window while someone pays for it.
- **Two devices, two ledgers.** An identity used on two devices that do not share their leaf ledger can put two messages on one leaf (about once in 1,024 messages). Move the records first (`exportLeafRecords`, `importLeafRecords`) or give each device its own identity index.
- **A lost phrase and passkey** leave a launch that is not attested yet unable to go live. Launches already live are unaffected.

## What it does not protect

- Balances in ordinary wallets: every holder's tokens are still Ed25519-controlled. Keep long-term holdings in a [PQ vault](/docs/concepts/pq-vault).
- Solana consensus, Token-2022, the ATA program and Meteora's upgrade authorities, which are classical keys.
- The content behind an external link, if a creator signs one: only the link is signed.

## Reference

- Instructions: [`attest_launch`](/docs/programs/launchpad#ix-attest_launch), [`publish_metadata`](/docs/programs/launchpad#ix-publish_metadata); accounts [`Identity`](/docs/programs/launchpad#acc-Identity), [`Attestation`](/docs/programs/launchpad#acc-Attestation) and [`TokenMeta`](/docs/programs/launchpad#acc-TokenMeta).
- Errors: `InvalidPqIdentity` (6039), `InvalidPqSignature` (6040), `PqLeafUsed` (6041), `AttestationMismatch` (6042), `NotLaunchWindow` (6044); Anchor's `ConstraintSeeds` (2006) for a wrong account.
- Events: `LaunchAttested`, `PqLeafConsumed`.
- SDK: [identity & attestation](/docs/sdk/pq-identity), [launch flow & window](/docs/sdk/launch-flow).
