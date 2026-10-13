# Post-quantum protection: launch identities and the PQ vault

Noised uses hash-based signatures in two places:

- **Launch identity.** Every launch must be signed by its creator's post-quantum identity, an LMS key, and the launchpad program verifies that signature on-chain before the launch can go live (section 3). The same identity, with the same one-time leaves, authorizes every change to the launch's autopilot (section 3.12).
- **PQ vault.** Tokens held in a vault move only with an LM-OTS one-time signature (sections 4 to 9).

Both rest on SHA-256 alone. This document says exactly what they protect, what they do not, and why.

## 1. Summary

| Protected against a quantum computer | By what |
|---|---|
| **What launches and when.** Nobody can make a launch go live unless the identity named in its parameters signed that launch's configuration, metadata record, creator rules and launch window. The signature is verified on-chain by the launchpad. A quantum computer that forges the creator's wallet signature still cannot launch the creator's configuration under other metadata or rules, at another time, or launch anything the identity did not sign. | LMS `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4` (RFC 8554), verified by `attest_launch`; `launch` requires the attestation and its window (section 3). |
| **The token's name, symbol and metadata document.** They are an on-chain record at the address of their hash, and the identity signs that hash. | `TokenMeta` + message v3 + the `METADATA_ONCHAIN` certificate check (SPEC §1.4). |
| **The launch rules.** The creator rules the Launch Guard enforces are an on-chain record at the address of their hash, signed in the attestation; `launch` installs exactly those bytes. | `LaunchRules` + message v3 + the re-read hook policy and `RULES_BOUND` (sections 3.6 to 3.9). |
| **Autopilot graph changes.** Activating or freezing a launch's autopilot graph, and revoking its operator, each need an LMS authorization by the launch's identity, verified on-chain. No Ed25519 key, the creator's included, can change a graph. | `pq_authorize` writes an `Authorization` the autopilot requires (section 3.12). |
| **Tokens held in a `noised_vault` vault.** They move only as a payout that an LM-OTS signature authorized. No Ed25519 key has any authority over them. | LM-OTS `LMOTS_SHA256_N32_W4` (RFC 8554), verified by `withdraw` (section 5). |
| **Batch payouts, creator fees and the platform's share, when routed to vaults.** A commit can name PQ vaults as its payout owners; fee recipients can be wSOL vaults; the treasury must be one. | Payout owners fixed at the first commit; `distribute` pays the vault's own token account (SPEC §1.4). |

| Not protected | Why |
|---|---|
| Ordinary Solana wallets, the creator's included. Every address is an Ed25519 public key. | Shor's algorithm recovers Ed25519 keys. |
| Noised launch tokens in ordinary wallets, and the pools they trade in. | Same; the pools are Meteora programs. |
| Who opens a launch inside its window, and who lands first. | `launch` is permissionless inside the attested window, by design: the first transaction to land wins. |
| Creating launches. `create_launch` is signed by the creator's Ed25519 wallet. | A quantum attacker can create launches that name any identity. They never go live without that identity's signature. |
| Token-2022 confidential balances (ElGamal), validator and consensus keys, and the multisigs that can upgrade Meteora DBC and DAMM v2, Token-2022 and the ATA program. | Classical keys and classical cryptography outside Noised. |
| Our own programs, until their upgrade authority is set to None. | An upgrade key is an Ed25519 key. |
| The content behind an opt-in external metadata uri. | Only the link is signed; DNS and TLS are classical. The on-chain record stays the canonical metadata. |
| An autopilot's operator and keepers. | Ed25519 keys. They are bounded: they decide only when due nodes run and, for the operator, an amount within the graph's limits; the identity can revoke the operator (section 3.12). |
| Recipients that are ordinary wallets: an autopilot's recipients, fee recipients, payout owners. | Value paid to an Ed25519 wallet is classical custody again (section 8). |

Noised gives post-quantum **launch authorization** (its rules and its autopilot's graph changes included) and post-quantum **custody** inside a chain that is not post-quantum. Section 8 lists exactly where that protection stops. **No Noised token is "quantum-proof".**

> **Vault v4 (audit round 1, 2026-10-08).** The vault address and its token account never change: each withdrawal replaces the one-time key in place and increments a sequence number. A withdrawal only reserves a payout, and delivery is a separate step, so a recipient can no longer make a revealed signature fail. Successor vaults and `sweep` are gone. Section 5 has the protocol, SPEC §3 the exact interface.
>
> **PQ v2 and on-chain metadata (2026-10-09).** Launch identities and attestations (section 3); the vault's key-index binding (section 5); payouts, fees and the treasury into vaults. The client rules are enforced by the SDK's durable ledgers (section 6).
>
> **Audit round 3 (2026-10-10).** An attestation whose window passed unused is replaced by the next one of the same identity while the launch is `Configured`, and a window must have at least 60 s left when its attestation lands (F1, merged; sections 3.7 and 3.8). No finding concerned the LMS or LM-OTS code.
>
> **Programmable launches and review 4 (2026-10-11).** Attestation message v3 also signs the creator rules' hash, and `launch` installs exactly the attested rules (sections 3.6, 3.7 and 3.9). `pq_authorize` lets the same identity, with the same leaves, authorize changes to a launch's autopilot (section 3.12). Review 4 limited authorizations to kinds 1 to 3 (Ra), made a freeze expire at its signed `not_after` (R5) and has `launch` hash the rules record again (R6a); all merged. Nothing was deployed then, and the programs were later deployed fresh (devnet 2026-10-12, mainnet 2026-10-13, [MAINNET.md](MAINNET.md)).

## 2. Threat model

- **What a cryptographically relevant quantum computer (CRQC) breaks.** Shor's algorithm recovers an Ed25519 private key from its public key.
  - On Solana every keypair account's address *is* its public key, so every funded wallet is exposed at rest, including receive-only addresses, and there is no protocol key rotation (FACTS #58).
  - Shor also breaks validator keys, BLS votes, discrete-log ZK proofs, and ElGamal encryption. Ciphertexts recorded today can be decrypted later ("harvest now, decrypt later"), and signatures recorded today can be followed by forged ones later.
  - Published 2026 estimates put a 256-bit elliptic-curve break at about 1,200 logical qubits. NIST IR 8547 plans to disallow quantum-vulnerable signatures such as EdDSA after 2035.
- **What it does not break.** Hash functions lose only to Grover's algorithm, a square-root speed-up. A preimage search on a 256-bit hash still costs about 2^128 quantum operations, and in practice more, because Grover search is long and serial.
- **PDAs.** Program-derived addresses are SHA-256 outputs that are not curve points, so no private key exists to recover. They are quantum-safe *only if* the owning program is immutable and trusts no Ed25519 authority (FACTS #60). That is why every Noised program must be finalized.
- **The chain itself.** Solana offers no post-quantum signature syscall, and the Falcon proposal (SIMD-0461) was closed (FACTS #59). Anything post-quantum has to be built from `sol_sha256` at the application level. That is what the launchpad and the vault do.

## 3. The launch identity

### 3.1 What it is for

A launch decides a token's supply, metadata, opening time and fair-open batch. Before PQ v2 those were authorized by the creator's wallet, an Ed25519 key. A quantum attacker who recovers that key from its public address could then launch the creator's prepared configuration under another name, ticker or document, or at a moment of its choosing (for example when only its own bots are ready), and the certificate would look normal.

Noised therefore makes every launch carry a **post-quantum attestation**: a hash-based signature by the creator's identity, verified on-chain by the launchpad, over everything that makes the launch what it is. `launch` refuses to run without it, and runs only inside the window it signed.

### 3.2 The scheme: LMS H10 over LM-OTS W4

An identity is one LMS key (RFC 8554): a Merkle tree of height 10 over **1,024 one-time LM-OTS leaves**. Implementation: `crates/noised-lmots` (`lms` module, `no_std`, used on-chain with the `sol_sha256` syscall) and `sdk/src/pq/lms.ts`.

| Item | Value |
|---|---|
| Parameter sets | `LMS_SHA256_M32_H10` (typecode 6) over `LMOTS_SHA256_N32_W4` (typecode 3), as defined in RFC 8554 |
| Public key | 56 bytes: `u32be(6) ‖ u32be(3) ‖ I (16) ‖ T[1] (32)`, the tree root |
| Signature | 2,508 bytes: `u32be(q) ‖ u32be(3) ‖ C (32) ‖ y[67 × 32] ‖ u32be(6) ‖ path (10 × 32)` |
| Identity id | `pq_identity = SHA256(0x21 ‖ public key)`; the domain byte 0x21 is distinct from the vault key id's 0x20 |
| Verification | RFC 8554 Algorithm 6a: the candidate LM-OTS key from the signature, then the authentication path to the root (leaf tag `0x8282`, node `2^10 + q`, interior tag `0x8383`), compared with `T[1]` in constant time. The typecodes, the length and `q < 1024` are checked strictly. |
| Security | about 128-bit security against a quantum attacker for generic attacks: every hash is SHA-256 with a 256-bit output, against which Grover's algorithm gives only a square-root speed-up |
| Cost | key generation is about 1.14 million SHA-256 compressions (the SDK builds the tree without blocking and caches the public tree); the whole `attest_launch` instruction, verification included, measured 91k to 115k CU on the review-4 build, and `pq_authorize` 93k to 107k (sections 3.7 and 3.12) |

**NIST status, stated precisely.** NIST SP 800-208 approves LMS (with LM-OTS as its one-time component) as a stateful hash-based signature scheme, and restricts it: such schemes need state management, because a one-time key that signs twice can be forged, and SP 800-208 approves them for specific uses only. The two parameter sets above are defined in RFC 8554 and listed in SP 800-208. Noised does not claim SP 800-208 approval or validation for its keys or its implementation: SP 800-208 expects key and signature generation inside hardware cryptographic modules that never export the private key, and Noised's keys are software keys, derived from a recovery phrase or a passkey secret and exportable as 24 words (audit round 2, finding C15). The parameter choice was reviewed in the PQ v2 spec review: W8 would cost about 600k CU to verify, W2 or a two-level tree overflows the 4,096-byte transaction, and H15 would need about 36 million hashes to generate in a browser.

### 3.3 Where the key comes from: a phrase or a passkey, never the wallet

The identity's secret is the 32-byte entropy of a 24-word BIP-39 phrase, `master` its 64-byte BIP-39 seed. It comes from one of two sources:

- **The PQ recovery phrase**, the same dedicated 24 words as the vault's (never a wallet's phrase).
- **A passkey** (WebAuthn PRF, CTAP2 `hmac-secret`): the authenticator (Face ID, Touch ID, Windows Hello or a security key) computes an HMAC with a per-credential secret over the fixed salt `"phalanx/pq/passkey/v1/prf-salt"`, with user verification required. Then `entropy = HKDF-SHA256(IKM = PRF output, salt = "phalanx/pq/passkey/v1", info = "phalanx/pq/passkey/v1/bip39-entropy", L = 32)`. The derived entropy can be exported as 24 words for backup, and re-imported to reproduce every identity byte for byte.

Each identity has its own domain-separated path (`noised_lmots::LmsPrivateKey::derive_identity`, `pqIdentity.deriveIdentity`). Every domain tag (`phalanx/pq/...`) keeps the project's original name: the tags are protocol constants, and renaming one would change every signature and every key derived from a phrase or passkey.

```text
path = cluster (1 byte: 0 mainnet, 1 devnet, 2 localnet) || u32le(identity index)
SEED = SHA256("phalanx/pq/identity/v1/seed" || master || path)
I    = SHA256("phalanx/pq/identity/v1/id"   || master || path)[..16]
leaf q's LM-OTS key: RFC 8554 Appendix A from (I, q, SEED)
```

The cluster byte keeps each cluster's leaves apart: the program cannot see which cluster it runs on, and one key on two clusters would have two bitmaps, so a leaf could sign once on each. Every PQ signer in the SDK checks the RPC's genesis hash against the cluster first (`assertCluster`). An all-zero master is refused everywhere: its keys would be public.

**Passkey trust, stated precisely.** The PRF secret stays inside the authenticator, and the derivation is symmetric: a quantum computer gets only Grover's speed-up against it. But the PRF salt and output travel encrypted under a P-256 key agreement to roaming authenticators (the CTAP2 PIN/UV protocol), the hybrid transport (a phone through a QR code) runs a P-256 handshake through a cloud tunnel, and synced passkeys move the secret through the provider's sync, which rests on classical public-key cryptography and the provider's own recovery. A recording of those channels could be decrypted by a future quantum computer. The safest posture is a platform authenticator or a directly attached security key, user verification always on, and the 24-word export kept offline. The relying party is the app's exact host (never an IP address, never a shared parent domain), so the same passkey does not work from another origin.

### 3.4 Why the identity is never derived from the wallet

A tempting design derives the post-quantum secret from the user's existing wallet: "no new seed phrase". A wallet never reveals its private key, so such a derivation must hash a wallet **signature** over a fixed message. That works only because Ed25519 signatures are deterministic (RFC 8032): the same key and message always give the same signature. Three facts follow.

1. **The secret is held by an oracle that answers on request.** Any application or site that gets the user to approve one signing request for that message obtains the signature, and with it the identity, today, with no quantum computer. The user cannot rotate it without abandoning the wallet.
2. **A quantum computer does not simply recompute it, and that is not the point.** RFC 8032 §5.1.6 signs with `r = SHA512(prefix ‖ m) mod ℓ`, where the scalar `a` and `prefix` are the two halves of `SHA512(seed)`. Shor's algorithm recovers `a` from the public key, which is enough to forge any *new* signature, but the deterministic signature also needs `prefix`, which is not a function of the public key. The often-repeated claim "a quantum computer recomputes the signature, hence the identity" is imprecise. (A derivation that uses the scalar itself, as some key-derivation schemes do, is broken outright.)
3. **What ties such an identity to its owner is classical.** With `a`, an attacker can produce the Ed25519 statement "wallet A vouches for identity X" for any X, its own included. After an elliptic-curve break, the link proves nothing.

So Noised requires: the identity's secret is independent of every Ed25519 key and of everything a wallet can be asked to sign; the program verifies the hash-based signature itself before the launch can go live; the one-time state lives on-chain; and the signed message binds everything the launch is. The creator's wallet still pays for and signs `create_launch`, and the certificate records it, but as information only: after `create_launch` it has no power.

### 3.5 Leaves, the on-chain bitmap and the client's ledger

**One leaf, one message, ever.** Each leaf is an LM-OTS key. Two signatures from one leaf, even of the same message under another randomizer `C`, reveal enough hash-chain values for anyone to forge a signature on a message of their choice: for 10% of signature pairs with at most about 2^36 SHA-256 evaluations, with a median around 2^61 (AUDIT.md, finding C1, and the PQ v2 spec review's model).

**The bitmap records landed signatures.** The identity account `["identity", pq_identity]` stores the public key and a 128-byte bitmap, one bit per leaf, least significant bit first (`used[q >> 3] & (1 << (q & 7))`). `attest_launch` and `pq_authorize` share it (`pq::burn_leaf`): each sets the bit of the leaf that signed, and refuses a signature at a leaf already set (`PqLeafUsed`). A leaf is therefore accepted at most once, ever, whichever of the two messages it signed.

**Landed is not the same as revealed.** A signature also becomes visible when it is simulated, sent and dropped, or lands in a transaction that fails, and none of these sets the bit. "The next free leaf on-chain" alone would then hand a second message the same leaf. Two rules close this:

- **Every valid signature lands and burns its leaf** (sections 3.7 and 3.12), so a revealed signature can always be landed by anyone to consume its leaf. The PQ v2 adversarial review showed what happens otherwise: a valid signature over metadata the program refused never landed, the user's corrected retry was handed the same leaf, and a third party forged an attestation of its own launch in the victim's name (end-to-end proof of concept; fixed before the code shipped).
- **The client keeps a durable ledger of revealed leaves** (`sdk/src/pq/leafLedger.ts`): it reserves the leaf for one message with the store's atomic `add` before any signature exists, signs, records the signature, and only then returns it. Any other message at that leaf is refused (`LeafConflictError`); an in-process guard refuses it even through a second ledger. Web Storage needs a cross-tab lock (`navigator.locks`). Records can be exported and imported between devices (authenticated; a leaf two devices gave to two messages is reported).

**Leaf choice: secret-keyed since audit round 4.** Up to SDK 0.8, for a message `m`, the client started at `u16be(SHA256("phalanx/pq/identity/leaf" ‖ I ‖ m)[0..2]) mod 1024` and took the first leaf, stepping +1 with wrap-around, that was clear in the bitmap and absent from its ledger. Anyone could compute that start, and the bitmap the client read came from its RPC. Audit round 4 (finding ID-F1, rated medium-high, reported independently by two reviewers with proofs of concept; [AUDIT.md](AUDIT.md) §16) showed what that allowed. Take two devices with the same identity (a synced passkey, or one device whose site data was cleared after a send that was dropped). A dishonest RPC keeps one device's signature without landing it, then reports fake used bits to the other device, so that its probe walks onto exactly that leaf. The identity has then signed two different messages at one leaf, which is enough for forgeries.

So, since SDK 0.9.0 (and in the Noised app):
- the start is `u16be(HMAC-SHA256(probe key, "phalanx/pq/identity/leaf/v2" ‖ m)[0..2]) mod 1024`, where the probe key is derived from the identity's secret seed. The same message still gives the same leaf and the same signature, so a retry stays idempotent, but nobody without the secret can predict which leaf a message will use, or aim at one;
- the leaf is the first from that start, stepping +1 with wrap-around, that is absent from the ledger and the in-process guard. What the RPC reports never moves it;
- the client refuses to sign, rather than warns, if that leaf is already set on-chain, or if the bitmap shows any used leaf its ledger has no record of: that key was used on another device, whose records must be imported first (or the user confirms the identity is new);
- before any signature that contains a time, the client compares the cluster's clock with the device's clock (and a second RPC when it has one) and refuses when they differ by more than 120 s.

The program never checks how a leaf was chosen, so this is a client rule; the on-chain rule (one landed signature per leaf, A2) is unchanged. **Best practice: one device per quantum key, unless you import its records.** Two devices with unsynced ledgers can still each sign at the same leaf, with probability about 1 in 1,024 per pair of messages when one device's signature never landed, but nobody can steer them into it any more. A synced passkey on a second device should import the first device's records before signing. The SDK warns at 1,000 used leaves; at 1,024 the creator moves to the next identity index.

### 3.6 What the identity signs

The message is built on-chain from the `Launch` account and the signed terms alone (`pq::attestation_message`), so a signature binds exactly what the program will launch, and when. Message v3, 221 bytes:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 13 | `"PHX-ATTEST-V3"` |
| 13 | 32 | launchpad program id |
| 45 | 32 | launch address (`["launch", creator, launch_seed]`) |
| 77 | 32 | `params_hash`: SHA-256 of every creator choice, `pq_identity` included |
| 109 | 32 | creator |
| 141 | 32 | `metadata_hash = SHA256("PHX-META-V2" ‖ borsh(name) ‖ borsh(symbol) ‖ u8 flags ‖ borsh(uri) ‖ borsh(doc))` |
| 173 | 32 | `rules_hash = SHA256("PHX-RULES-V1" ‖ PXR1 bytes)`, or 32 zero bytes for no creator rules |
| 205 | 8 | `not_before`, i64 little-endian, unix seconds |
| 213 | 8 | `not_after`, i64 little-endian, unix seconds |

What each part binds: the leaf is bound by the LMS hashing; `pq_identity` by `params_hash` and the key-hash check; the DBC config is a PDA of the launch and its contents follow from the parameters, re-checked at launch; the pool and mint are written once, by the single Configured-to-Live transition of `launch`; the metadata hash names the on-chain record (`["metadata", launch, metadata_hash]`) whose bytes consensus stores, so the signature covers every byte any reader displays and the uri mode; the rules hash names the on-chain rules record (`["rules", launch, rules_hash]`), whose bytes `launch` installs in the hook policy (section 3.9); the window decides when `launch` may run. The program id and the launch address stop a signature from being replayed on another program or launch; the cluster byte of the derivation stops it across clusters.

Message v2 (189 bytes, `"PHX-ATTEST-V2"`, without the rules hash) is superseded by v3. Message v1 of the first PQ v2 build (`"PHX-ATTEST-V1"`, which signed the name, symbol and uri strings and a SHA-256 of an off-chain JSON document) is retired; the tag differs, so no v1 signature verifies as v3. The on-chain metadata change replaced it, because DNS and TLS behind an `https` document are classical (PQ v2 adversarial review, finding 5).

### 3.7 `attest_launch`: every valid signature lands; only the right one attests

`attest_launch(lms_pk, lms_sig, metadata_hash, rules_hash, not_before, not_after)` is **permissionless**: the signature authorizes, not the fee payer. A client sends it from a throwaway key in a v1 transaction (3,005 bytes, 3,037 with a rules account), and anyone may relay it. Its accounts are the payer, the launch, the identity, the attestation, `token_meta`, the system program and, last, `rules`: the rules record the signed rules hash names, or the launchpad's program id in its place (no account) for the zero hash. The program:

1. requires the `token_meta` account to be exactly `["metadata", launch, metadata_hash]`, and `rules` to be exactly `["rules", launch, rules_hash]` or none for the zero hash (else the transaction fails with `ConstraintSeeds` and nothing is burned);
2. derives the identity account from the key sent, `["identity", SHA256(0x21 ‖ lms_pk)]`, and verifies the LMS signature over the message (`InvalidPqSignature`);
3. burns the leaf: sets its bit, or fails with `PqLeafUsed` if it was already set;
4. **attests** only if the attestation slot is free (never written, or written for a window that has passed while the launch is still `Configured`), the signing identity is the one the launch names, the metadata record exists at the address its hash names (owned by the launchpad, the `TokenMeta` discriminator, version 1, that launch and hash, the canonical bump), for a non-zero rules hash the rules record exists at the address its hash names (`pq::is_rules_record`: owned by the launchpad, the `LaunchRules` discriminator, version 1, that launch and hash, the canonical bump), and the window is usable: it lasts 60 s to 1 hour, opens at most 7 days ahead and has at least 60 s left when the attestation lands (`max(now, not_before) + 60 <= not_after`). Then it writes `["attestation", launch]` (version 3, 2,708 bytes) whole, with the full 2,508-byte signature, the leaf, the metadata hash, the rules hash, the message hash, the slot and the window, and emits `LaunchAttested` (with `rules_hash`); a replacement keeps no byte of the attestation it replaces. Otherwise it emits `PqLeafConsumed` and the leaf is simply burned. An attestation whose window has not ended is never replaced, and a live launch's attestation never changes.

The free-slot rule and the minute-left rule are audit round 3's F1 (merged 2026-10-10). Before it, the attestation was written once, so a window that passed without a `launch`, or an attestation a relayer landed in its window's last second, left the launch unable ever to go live.

The order is deliberate: every valid signature at an unused leaf lands, whatever it signed, whatever the launch's status, and whatever a third party did to the accounts its message names. An identity is therefore never left holding a revealed signature it cannot consume. A client mistake (a wrong hash, a record not published yet, a window in milliseconds) costs one of 1,024 leaves, never a launch that cannot open.

**Older signatures and a freed slot** (round 3 fix review). Because a slot whose window passed is free again, any valid signature by the identity whose own window still has a minute left can fill it, including one the creator sent earlier that never landed: a dropped transaction whose bytes an RPC or relayer kept. Whoever holds it can land it ahead of the creator's new signature and pick, among windows and records the creator signed, one that opens up to 7 days later; the creator's new signature then only burns its leaf until that window ends. Nothing unsigned can happen, and the slot frees again after that window, so the cost is delay. The rule for clients: land, or let burn, every signature you reveal before signing a new window for the same launch. SDK 0.5.0 (unreleased) enforces it for the signatures in its leaf ledger, which keeps every signed message and so every signed window (`leafLedger.launchSignatures`). `buildAttestLaunchTx` throws `PendingAttestationError`, before it reserves a leaf or signs, when the ledger holds an earlier signature of the same launch whose leaf is still clear on-chain and whose window has not ended; rebuilding a recorded signature is never refused. `findPendingAttestations` lists those signatures and what landing each now would do (attest its window, or only burn its leaf). `landOrBurnPending` re-sends them and never makes a new signature; with `burnOnly` it lands only the ones that would just burn their leaf, which is the safe way to retire them while the current attestation holds the slot. `getLaunchFlowStatus` lists them and warns. The guard sees only the ledger it is given: a signature another device made is invisible until that device's records are imported (`importLeafRecords`).

**What a relayer can and cannot do.** Every account except the fee payer is fixed by the signed data: the launch by the message, the identity by the key, the attestation by the launch, each record by the launch and its hash. Any other account fails the transaction (this closed the on-chain metadata review's medium finding: a relayer could name another record account and turn an attesting signature into a burn, at every retry). So whoever holds a pending attestation can land it or delay it, but cannot change what it does, and the creator can re-broadcast the same bytes. This is inherent to permissionless relay.

**Client rules** (enforced by the SDK's `buildAttestLaunchTx`): sign only a finalized launch that this wallet created, with the reviewed configuration (`expectedParamsHash`); publish the metadata record and, for a launch with creator rules, the rules record (`publish_rules`), and wait for their confirmation (finalized preferred) before sending the attestation, because a record lost in a dropped fork turns the attestation into a burn; after landing, check the `Attestation` account (version 3, `message_hash` = SHA-256 of your message) rather than trusting the landing; cap automatic re-signs after burn-only landings (two or three for one launch), then show the reason: record missing, window, identity or already attested.

**The rules record.** `publish_rules(bytes)` is permissionless and idempotent, and runs only while the launch is `Configured` (`WrongLaunchState`). It verifies the PXR1 bytes for the launch's guard (`InvalidRules`) and writes them whole at `["rules", launch, rules_hash]` (`LaunchRules`, 78 + length bytes, at most 1,306), never modified or closed; an address pre-funded by anyone is taken over. A typical 286-byte rule set takes 11,117 CU and the largest (1,228 bytes) about 16k to 17.6k; the SDK's v1 transaction is 580 to 1,522 bytes, and a legacy transaction fits up to 898 bytes of rules. Rent: `(128 + 78 + length) × 5,080` lamports, 2,499,360 for the typical set.

**Cost** (2026-10-11, review-4 build): `attest_launch` takes 91k to 115k CU. Earlier detail (2026-10-10, message v2 on the build with F1): the integration vector transaction took 99,113 CU and loaded 784,820 bytes of account data; all 1,024 leaves of one identity took 79,778 to 114,482 CU (mean 95,445); a chain-step model puts the worst possible digest (990 steps) at about 170k CU. Clients set 300,000 CU and 2 MiB of loaded data. The first attestation's payer also funds the identity (196 bytes) and attestation (2,708 bytes) accounts: 16,057,800 lamports with one fee, at mainnet's 5,080 lamports per byte. A replacement pays only the fee.

### 3.8 The launch window

The window is part of what the identity signs. An attestation fixes it only if it lasts **60 seconds to 1 hour**, opens at most **7 days** later, and still has at least **60 seconds** left when the attestation lands; any other window only burns the leaf. `launch` then runs only inside `[not_before, not_after]` (`NotLaunchWindow`), and inside it **anyone** may run it: the payer only pays rent and picks the fresh mint keypair. No Ed25519 key, which a quantum computer could forge, decides what launches or when.

**A window nobody uses.** Keepers open attested launches as soon as their window opens (OPERATIONS.md, Keepers), but a window can still pass without a `launch`: an outage, congestion, or a party that fills the `Launch` account's write budget for the whole window. The creator then signs a new window at its identity's next leaf, and while the launch is `Configured` that attestation replaces the expired one (audit round 3, F1). Before F1 such a launch could never go live, and a relayer that held a signature back and landed it in the window's last second had the same effect (rated medium; no user funds exist before `launch`, so the loss was the creator's rent and work); now a landing with less than 60 s left only burns its leaf. The PQ guarantee is unchanged: only the identity's signature can set a window, `launch` runs only inside the stored one, and an expired window never reopens. What remains: contention can keep `launch` out of each new window while someone pays for it, each retry costs a leaf, and an older signature that never landed can take the freed slot (section 3.7).

The residual is explicit: inside the window, the first `launch` transaction to land wins. Anyone, including whoever forged the creator's wallet key, can open the launch at `not_before` and commit in the same moment as everyone else. The fair-open batch is pro rata, so landing first in the commit window gives no price advantage; what remains is contention for the `Launch` account's write lock, which costs the attacker linearly in time (THREAT_MODEL §5.3).

### 3.9 What `launch` checks, and what the certificate says

`launch()` takes no arguments. It requires `["attestation", launch]` with its stored bump, the attestation's launch and identity equal to the launch's, the `TokenMeta` record its `metadata_hash` names, and, as its last account, the `LaunchRules` record its `rules_hash` names, present exactly when that hash is not zero (the program id otherwise; `AttestationMismatch`). It hashes the record's bytes again and requires `SHA256("PHX-RULES-V1" ‖ bytes) == rules_hash` (review 4, R6a), so the binding does not rest on `publish_rules` being the only writer of such records. A burn-only (empty) attestation is refused. The mint's name and symbol are the record's and its uri is derived from the record; after the pool CPI the mint's metadata is re-read and must equal them exactly. The rules' bytes go to the hook's `create_policy`, which verifies them again for the guard; `launch` re-reads the written policy and requires exactly those bytes along with every other field (`UnsafePolicy`). The certificate (version 4) then sets bit **1024 (`PQ_ATTESTED`)** and bit **2048 (`METADATA_ONCHAIN`)**, completing the twelve bits `launch` requires (`checks::ALL = 4095`), and, when the policy holds non-empty attested rules, the informational bit **4096 (`RULES_BOUND`)**. So `checks` is 4,095 without rules and 8,191 with them: test `(checks & 4095) == 4095`, never `checks == 4095`. It records `pq_identity`, `pq_leaf`, `attested_slot`, `metadata` (the record's address) and `rules_hash`. A verifier re-verifies the LMS signature stored in the attestation over the message rebuilt from on-chain data, re-hashes the metadata record, and compares the policy's rules with the certificate's `rules_hash`.

Assurance, in short: if LMS is existentially unforgeable when each leaf signs at most one message, then no adversary, including one with a quantum computer, can make a launch live whose certificate names identity X unless X's holder signed that launch's message, and no attestation by X can be moved to another launch, other parameters, other metadata, other rules or another window. Under a quantum attacker, an attacker can still create launches that *name* any identity (`create_launch` is signed by an Ed25519 wallet); such a launch never goes live (`a5_a_launch_naming_another_creators_identity_never_goes_live`). It can also launch under its *own* identity with any name and ticker: origin is cryptographic, not reputational, and users learn which identity a project uses the way they learn any public key.

### 3.10 What is and is not post-quantum about a launch

| Part of a launch | Post-quantum? |
|---|---|
| That the launch goes live at all, with these parameters, this metadata, these rules and inside this window | **Yes**: an LMS signature verified on-chain, one-time state on-chain |
| The token's name, symbol, description and icon | **Yes**: an on-chain record bound by the signed hash; the mint is checked against it |
| The creator's launch rules | **Yes**: an on-chain record bound by the signed hash; `launch` installs exactly its bytes and the certificate records them (`RULES_BOUND`) |
| Changes to an autopilot graph: activating, freezing, revoking the operator | **Yes**: an LMS authorization by the same identity, verified on-chain (section 3.12). Running the graph is classical but bounded: keepers and an optional operator are Ed25519 keys that act only within the graph's limits |
| No mint, freeze or metadata authority; the LP lock; the fee routes; an autopilot's treasury | **Yes, by construction**: no key holds these powers, only PDAs of programs that will be finalized |
| Who opens the launch inside the window, and the order of transactions | No: anyone may; the first to land wins |
| `create_launch` (the creator's wallet signature) | No: classical; it only creates a launch that cannot go live without the identity |
| Holders' balances in ordinary wallets, the pools, wSOL | No: Ed25519 wallets, Meteora and token programs |
| Batch payouts, creator fees, the platform share | Only when paid to PQ vaults (commit payout owners, vault fee recipients, the vault treasury) |
| Meteora DBC and DAMM v2, Token-2022, the ATA program, Solana consensus | No: upgradeable by, or run by, classical keys |
| An opt-in external metadata uri's content | No: only the link is signed |

### 3.11 Assurance

- **Known answers.** RFC 8554 Appendix F: only Test Case 2's top-level tree uses H10/W4. The crate rebuilds its root from `SEED` and `I`, reassembles and verifies the published signature at `q = 3`, and reproduces it byte for byte; Test Case 1 and Test Case 2's second level (H5/W8) are negative tests (their typecodes are refused). All 1,024 authentication paths of one tree verify; tampering with `q` (including `q >= 1024`), each typecode, the length, `C`, every `y` chunk, every path chunk, `I` and `T` fails (`crates/noised-lmots/tests/lms.rs`; 35 known-answer tests with the signer features on 2026-10-09).
- **An independent implementation.** `scripts/pq/lms_reference.py` (Python standard library only) re-verifies all four Appendix F levels, rebuilds Test Case 2 byte for byte, and recomputes the attestation, metadata and programmable-launch vectors (`tests/integration/vectors/lms.json`, `metadata.json`, `programmable.json`; `python -I scripts/pq/lms_reference.py programmable-vectors tests/integration/vectors/programmable.json` checks the PXR1 rule sets with its own verifier, their hashes and records, message v3, the authorization message, the payload hashes and the account layouts).
- **Byte parity.** The SDK reproduces the Rust derivation, keys, signatures, message v3, the authorization message and the attest transaction from the same vectors.
- **On-chain behaviour.** The vector identity lands every one of its 1,024 leaves exactly once on the real build; burn-only vectors attest nothing; the programmable vectors land on the launchpad build (`programmable_vectors_land_on_the_launchpad_build`); the launchpad's LiteSVM suite runs its PQ v2, metadata, rules and `pq_authorize` tests against mainnet DBC and DAMM v2, and the autopilot's suite drives `activate`, `revoke_operator` and `freeze` with real launchpad authorizations (`launchpad_authorizations_drive_activate_revoke_and_freeze`).
- **Mutation testing.** 31 of 31 mutants of the LMS crate are caught (`scripts/pq/lms_mutants.py`). The attestation, rules and authorization code is covered by the integration, LiteSVM-only and host mutant tables; the review-4 run (2026-10-11) caught every selected mutant, among them the 19 host rules-and-authorization mutants, and the P1c merge run's one launchpad survivor (another identity's signature authorizes) is killed by a test added with review 4 (SPEC §6).
- **Reviews.** A spec review, an adversarial review with an end-to-end forgery proof of concept, a review of the on-chain metadata change, review 4 of programmable launches and audit round 4, all by AI agents ([AUDIT.md](AUDIT.md) §9, §11, §15 and §16). Audit round 4 found `noised-lmots` and the on-chain checks clean, and found the client's leaf choice steerable by a dishonest RPC (section 3.5). This is not an independent audit: neither the crate nor the programs have had one.

### 3.12 `pq_authorize`: autopilot changes signed by the same identity

A launch's autopilot ([SECURITY_GUARANTEES.md §11](SECURITY_GUARANTEES.md#11-autopilot), SPEC §9) changes its graph only with the launch identity's hash-based signature, never with an Ed25519 key. The launchpad verifies the signature and writes an `Authorization`; the autopilot reads that account.

**The message**, built on-chain (`pq::authorization_message`), 140 bytes:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 11 | `"PHX-AUTH-V1"` |
| 11 | 32 | launchpad program id |
| 43 | 32 | launch address |
| 75 | 32 | the launch's creator |
| 107 | 1 | `kind` |
| 108 | 32 | `payload_hash` |

**Same identity, same leaves.** `pq_authorize(lms_pk, lms_sig, kind, payload_hash)` is permissionless and accepts a launch in any status. It verifies the LMS signature and burns its leaf in the identity's bitmap, the same account and bitmap `attest_launch` uses (`pq::burn_leaf`), so every valid signature at an unused leaf lands and burns it, whatever it signed (section 3.5). It writes the `Authorization` at `["auth", launch, [kind], payload_hash]` only if nothing was written there yet, the signer is the launch's identity, and `kind` is 1, 2 or 3 (review 4, Ra); any other valid signature emits `PqLeafConsumed` and only burns its leaf. Every account but the payer is fixed by the signed data (the launch by the message, the identity by the key, the authorization by the launch, kind and payload), so a relayer can land or delay a signature but not change what it does.

**The account** (version 1, 2,669 bytes, never modified or closed): launch, `pq_identity`, `kind` (byte 74), `payload_hash` (75..107), `message_hash` (107..139, SHA-256 of the 140-byte message), `unix_time` (139..147) and `slot` (147..155) of the landing, from the clock, the leaf (155..157), and the full 2,508-byte signature (length at 157, bytes from 161), so anyone can re-verify it from account state alone. Event `Authorized`.

**Kinds and payloads.** The launchpad gives the payload no meaning; the autopilot recomputes it and reads the account by layout. `autopilot` is the `["autopilot", launch]` address under the autopilot program; integers are little-endian.

| Kind | Payload hash | Used by |
|---|---|---|
| 1 `GRAPH_ACTIVATE` | `SHA256("PHX-GRAPH-ACT-V1" ‖ autopilot ‖ graph_hash ‖ i64 activate_at)` | `activate` |
| 2 `GRAPH_FREEZE` | `SHA256("PHX-GRAPH-FRZ-V2" ‖ autopilot ‖ graph_hash ‖ i64 not_after)`: version 2 since review 4 (R5) | `freeze` |
| 3 `OPERATOR_REVOKE` | `SHA256("PHX-OP-REVOKE-V3" ‖ autopilot ‖ graph_hash of the active graph ‖ operator ‖ active_auth)`: version 3 since audit round 4 (A4-3); `active_auth` is the authorization that activated the running graph, stored in the `Autopilot` account | `revoke_operator` |

**How the autopilot uses them.** It checks the account's owner, address, version, launch, identity (the launch's), kind, payload and signature length, and orders authorizations by (landing slot, address). Each is used at most once, and never after a newer one it could undo: an activation must be newer than the latest activation and revocation used, a freeze newer than the latest freeze and activation, a revocation newer than the latest revocation. So a revoked operator gets no power back from anything signed before its revocation, and a freeze cannot cancel a newer queued graph. A replacement graph's 72-hour timelock counts from the later of now and the authorization's landing time (`activate_at >= max(now, unix_time) + 259,200`), so a replacement is visible on-chain for 72 h before it applies; a first graph may take effect at its `activate_at`. A freeze is refused after its signed `not_after` (`FreezeExpired`). A revocation names the activation it revokes (payload v3): after another activation is applied, even of the same graph with the same operator, an earlier revocation no longer applies and the identity signs a new one. Before audit round 4, an operator revoked and then appointed again by the same graph could never be revoked again, because a new signature had the same payload and only burned its leaf. The `Autopilot` account also stores the running graph's activation (`active_auth`, `active_activate_at`), so anyone can find and re-verify the LMS signature behind the graph that runs (SPEC §9.1).

**Withheld authorizations.** A landed authorization can be used by anyone at any later time it is still valid: an activation while its signed `activate_at` is still far enough ahead for the timelock, a freeze until its `not_after`, a revocation at any time (it only removes power). A signature that has not landed can be held back by whoever relays it, and the order that counts is the landing slot, not the signing time. Land your own through several RPCs, and give a freeze a short `not_after` (the SDK's default is one hour).

**Leaf budget.** Every change spends a leaf of the same 1,024 the identity's attestations use, and so does a signature that only burns. The SDK warns at 1,000 used leaves (section 3.5).

**Client rules.** The same leaf-ledger discipline as attestations: reserve the leaf in the durable ledger before signing, record the signature, land it through several RPCs, and if it has not landed re-send the same signature; never sign a payload again while a signature over it may be pending (`confirmAuthorization` tells a landing that only burned its leaf from one still pending). Build the freeze payload version 2 with its `not_after`: a kind-2 authorization over any other payload is written, but no freeze can ever use it, and its leaf is spent. SDK 0.8.0 (unreleased) builds it (`freezePayload` with `notAfter`, `planFreeze`; review 4, R5). Likewise build the revocation payload version 3 with the account's `active_auth`; SDK 0.8 builds version 2, which no revocation can use, and SDK 0.9.0 builds version 3. The times an authorization signs (`activate_at`, a freeze's `not_after`) are shown as absolute dates and checked against the device's clock before signing (SDK 0.9.0; audit round 4 found that a lying RPC clock could turn a one-hour freeze approval into one usable for a year), and a freeze's `not_after` is at most 24 h ahead.

**Cost.** A v1 transaction of about 2,924 bytes and 93k to 107k CU. The first landing at an authorization's address, even one that only burns, also creates that account: 14,208,760 lamports of rent at mainnet's 5,080 lamports per byte.

**What stays classical.** Running the graph: keepers and an optional operator are Ed25519 keys. They choose only when due nodes run and, for the operator, an amount within the graph's limits; a forged operator key can do no more than the operator could, and the identity can revoke it (kind 3), even on a frozen graph. Recipients that are ordinary wallets, Meteora's DAMM v2 and Token-2022 remain classical too. The treasury itself has no key: it is a PDA.

## 4. The vault's signature scheme: LM-OTS `LMOTS_SHA256_N32_W4`

Implementation: `crates/noised-lmots` (Rust, `no_std`, used on-chain and by tests). Its TypeScript twin is `sdk/src/pq/lmots.ts`.

| Parameter | Value |
|---|---|
| Standard | RFC 8554 §4, typecode 3 (the parameter set is also listed in NIST SP 800-208; section 3.2 says what that does and does not mean) |
| Hash | SHA-256 (`sol_sha256` on-chain), n = 32 bytes |
| Winternitz width | w = 4 bits (chains of 16 positions) |
| Chains | p = 67: 64 message digits + 3 checksum digits (ls = 4) |
| Signature | `C \|\| y[0..67]` = 32 + 67 * 32 = **2,176 bytes**. The typecode is fixed by the verifier and not transmitted. |
| Public key | `I` (16-byte key identifier), `q` (u32 leaf index), `K` (32-byte hash) |
| Key id | `SHA256(0x20 \|\| u32be(3) \|\| I \|\| u32be(q) \|\| K)`; the first key's id is the vault's PDA seed |
| Security | ~256-bit classical / ~128-bit generic quantum security (Grover against SHA-256) |

Byte layout. `u32str` and `u16str` are big-endian, as in the RFC.

```text
x[i]  = SHA256(I || u32str(q) || u16str(i) || 0xff || SEED)            chain secrets (RFC 8554 App. A), signer only
step  = SHA256(I || u32str(q) || u16str(i) || u8str(j) || tmp)         55 bytes per chain step
Q     = SHA256(I || u32str(q) || 0x8181 || C || message)               message hash with signer randomizer C
K     = SHA256(I || u32str(q) || 0x8080 || z[0] || ... || z[66])       public key hash
```

Why it is secure, in short:
- Each chain value is revealed at the position given by one digit of `Q || checksum`. An attacker can only hash chain values *forward*, which can only raise digits. Raising any message digit lowers the checksum, so some checksum digit would have to fall. That needs a chain walked *backward*, which means inverting SHA-256.
- Every hash is tweaked with `I`, `q`, the chain index `i` and the step `j`, so work spent against one key or position does not help against another (no multi-target attacks).
- The randomizer `C` is fixed only once the message is fixed, and nobody without the secret seed can predict it. An attacker who influences part of the signed message therefore cannot prepare a collision in advance. RFC 8554 has the signer draw `C` at random. Noised clients derive it instead as `HMAC-SHA256(key = SEED, data = "phalanx/pq/lmots/C" || I || u32be(q) || message)` (section 6, rule 4). That is the construction FIPS 205 uses for SLH-DSA's `PRF_msg`: a MAC keyed by a secret, over the message. It is just as unpredictable to everyone else, and it makes re-signing an identical message reproduce the identical signature. LMS leaves use the same randomizer.

Assurance:
- The crate reproduces RFC 8554 Appendix F, Test Case 2 byte for byte: key generation from the seed, the published signature, and the full height-10 LMS tree root rebuilt from 1,024 one-time public keys.
- Tamper tests flip a bit in every 7th signature byte and at both ends of `C` and `y`. They also change the key identifier, `q` and the length.
- The deterministic randomizer has its own tests: HMAC-SHA256 against RFC 4231 test case 2 (`hmac_sha256_matches_rfc4231_test_case_2`), a known answer that every implementation must reproduce (`deterministic_randomizer_vector`: `SEED = 0x11 × 32`, `I = 0x22 × 16`, `q = 7`, message "phalanx" give `C = efff9f33…9d79d3`, written out in full in SPEC §3.10), and signing the same message twice giving the same bytes (`deterministic_signing_is_idempotent_and_message_bound`).
- Run these tests with `cargo test -p noised-lmots --features signer,sha2-backend --locked` (35 tests, LMS included, all passing on 2026-10-09).
- Rust and TypeScript must agree byte for byte on keys, `C` and signatures, or one withdrawal signed in two tools becomes two signatures. `tests/integration/vectors/vault_withdraw.json` carries the key derivation for several accounts, sequences and clusters, the randomizer known answer, and each withdrawal's derived `C` and signature. The Rust side checks it (`sdk_vectors_match_the_committed_file`); the SDK's vector test reads a byte-identical copy.
- The verifier compares `K` in constant time.
- Neither implementation has had an independent audit yet.

**Why this scheme.** It is the standardized Winternitz scheme, with published test vectors. Its signature fits a single v1 transaction, which has been live on mainnet since 2026-09-15 (FACTS #6). By our model, verification costs about 70k CU in a typical case and at most about 140k; the whole `withdraw` instruction measured about 79k–106k CU (section 7).
- Lattice schemes such as Falcon and ML-DSA have only unaudited on-chain verifiers. A newer non-hash scheme, HAWK, was withdrawn in 2026 after a key-recovery attack (FACTS #63). Hash-based signatures rest on SHA-256 alone.
- Earlier designs of the vault used WOTS+C with n = 24, sized for 1,232-byte legacy transactions. It was a non-standard variant at a lower security level, costing about 0.3M CU. It is superseded, and its crate (`crates/noised-wots`) has been removed.
- Noised never used the crates.io `solana-winternitz` 0.1.1 crate. It has no checksum, so a single published signature lets anyone forge others classically: a forgery was demonstrated with about 2^18.6 hash evaluations for one sample signature (FACTS #61). A newer, unaudited crate with the same name is distributed only from git, so a plain `solana-winternitz = "0.1"` dependency still resolves to the forgeable code.

**One-time keys, rotated in place.** An LM-OTS key must produce at most one signature. A second signature by the same key, of a different message or of the same message with a different `C`, can reveal enough chain values to forge others. The vault turns this into a rule enforced on-chain: a vault has exactly one current key, every withdrawal is bound to the vault's sequence number, the same instruction replaces the key with the next key named in the signed message, and that key's index must be the next position.

## 5. The vault protocol

```
open_vault(genesis key id, key)    --> Vault PDA ["vault", mint, genesis_key_id]; sequence 0; key index q must be 0
                                       owns ATA(vault, mint) = the deposit address, forever
                                       | deposits: ordinary token transfers into that ATA, by anyone
withdraw(signature, destination_owner, max_amount, next_key_id, next_key)
                                       | verify LM-OTS over the 185-byte message (with vault.sequence)
                                       | next_key.q must be sequence + 1 (InvalidKeyIndex)
                                       | amount = min(max_amount, balance - reserved)   (0 if paying the vault itself)
                                       | reserved += amount; create Payout ["payout", vault, sequence]
                                       | sequence += 1; current key := next key          (no token moves)
release()      anyone                  | Payout -> canonical ATA of destination_owner (created if missing;
                                       |           memo sent first if the account requires one)
release_to()   destination_owner signs | Payout -> any token account of the mint the recipient names
                                       | reserved -= amount; Payout closed, rent back to whoever paid it
```

Signed message (`programs/noised-vault/src/message.rs`), 185 bytes:

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | `"PHX-PQV4"` (domain tag and version) |
| 8 | 1 | `0x01` (withdraw) |
| 9 | 32 | program ID (`7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`) |
| 41 | 32 | vault address |
| 73 | 32 | mint |
| 105 | 8 | `sequence`, u64 little-endian: the vault's withdrawal counter before this withdrawal |
| 113 | 32 | recipient **wallet** (`destination_owner`) |
| 145 | 8 | `max_amount`, u64 little-endian |
| 153 | 32 | next key id |

Properties:
- **Binding.** Recipient wallet, amount bound, next key, sequence, mint, vault and program are all signed. A relayer or fee payer can submit the withdrawal but cannot change anything. The next public key must hash to the signed key id, and the program re-checks this.
- **One use per key.** The signature is valid only at the vault's current `sequence`, which the same instruction increments, and the key is replaced by the signed next key. That key must differ from the current one (`InvalidNextKey`) and its LM-OTS index must be `sequence + 1` (`InvalidKeyIndex`, audit round 2). The index is hashed into every LM-OTS hash and into the key id, so a key can control a vault only at its own position: a spent key can never be reinstalled, and no signature can execute twice. The genesis key id is the vault's PDA seed, so `open_vault` for it fails forever. A vault supports up to 2^32 - 1 withdrawals.
- **Always executable.** `withdraw` reads no account a third party controls and moves no tokens: it reads the vault's own token account balance (read-only) and creates a payout account only this program can create. Once revealed, a correct signature for the current sequence executes whenever anyone submits it. The signed amount is a *maximum*: `min(max_amount, unreserved balance)` is reserved, so it never fails for "insufficient funds" either.
- **No time dependence.** The message contains no blockhash or timestamp. A dropped transaction is re-sent with the *same* signature in a new transaction (new blockhash, new fee payer).
- **Delivery.** `release` is permissionless and pays only the recipient wallet's canonical associated token account. It creates that account if missing and does not compare its owner field (only the wallet itself can reassign it). When the destination is a Token-2022 account that requires memos, the program sends a memo right before the transfer. `release_to`, signed by the recipient wallet, pays any token account of the mint, for recipients whose canonical account cannot receive (for example a confidential-transfer account that refuses non-confidential credits). A recipient can delay only its own payout. The rest of the vault, and every later withdrawal, is unaffected.
- **A stable deposit address.** The vault's token account never changes, so deposits made at any time stay under the vault's current key. Nothing has to follow a chain of addresses. Launch payouts, creator fees and the platform's share land in this same account when a vault is named (SPEC §1.4).
- **Mints.** `open_vault` refuses mints a vault cannot protect: NonTransferable (tokens could never leave), PermanentDelegate (an Ed25519 key can move tokens out of any account), MintCloseAuthority with an authority (at zero supply the mint can be closed and re-created at the same address with a permanent delegate) and TransferFeeConfig with a live config or withdraw-withheld authority (a stolen authority could set a 100% fee and collect it). Unknown extension types fail to parse and are refused. A fixed transfer fee with both authorities None is accepted; it is charged only on what a payout moves. Transfer-hook mints are supported: hook accounts are forwarded on delivery and Token-2022 re-checks them. Freeze, pause and hooks can delay a payout, but they never block `withdraw` and cannot take funds. Clients warn about them (`checkVaultMint`).
- **Not recoverable.** Native SOL, or tokens of another mint, sent to the vault PDA itself can never be moved: no instruction moves lamports out of a vault account or tokens out of ATA(vault, other mint). Deposit only into the vault's token account. For wSOL, send SOL to that token account and call `SyncNative`; the SDK's `buildDepositTx` does both.

## 6. Key management rules (SDK and users)

SDK function names below are the client API defined in SPEC §4.1. The rules apply to any client; the SDK enforces them.

**The PQ recovery phrase is separate.** It is a dedicated 24-word BIP-39 phrase (256 bits of entropy). It is never derived from an Ed25519 wallet (section 3.4). The same phrase, or a passkey's PRF secret, also derives launch identities on their own path.

Derivation (SPEC §3.10). `account` numbers a user's vaults for one cluster and mint; `sequence` is the vault's withdrawal counter:

```text
master = BIP-39 seed of the PQ phrase (64 bytes)
path   = cluster (1 byte: 0 mainnet, 1 devnet, 2 localnet) || mint (32) || u32le(account) || u32le(sequence)
SEED   = SHA256("phalanx/pq/lmots/seed" || master || path)
I      = SHA256("phalanx/pq/lmots/id"   || master || path)[..16]
q      = sequence
C      = HMAC-SHA256(key = SEED, data = "phalanx/pq/lmots/C" || I || u32be(q) || message)    (per signature, RFC 2104)
```

The genesis key is `sequence = 0`, and its key id fixes the vault address. Keys never repeat, because `(account, sequence)` never repeats.

Rules:
1. **One key, one signature, ever.** Never produce a second signature with a key: not for "the same withdrawal with a corrected amount", not for another recipient or next key, and not for the same message with a different randomizer. For a sizable share of signature pairs, two signatures by one key let an attacker forge a third with feasible work: for example a withdrawal of the whole unreserved balance to itself, naming a next key of its own, which would hand it the vault.
2. **Reserve, sign, record, then return.** The SDK's vault-key ledger (`createVaultKeyLedger`, required by `prepareWithdrawal`, `signWithdrawal` and `buildWithdrawTxWithFallback`) reserves the key for one message with the store's atomic `add` before any signature exists, and records the signature before returning it. Any other withdrawal for that key throws `VaultKeyInUseError` with the recorded withdrawal to re-broadcast. Use one ledger per browser profile on an IndexedDB store with an atomic `add`, with `navigator.locks` and `navigator.storage.persist()`, and back it up.
3. **Re-broadcast, never re-sign.** If a transaction is dropped, expires or fails for a transient reason, send the stored signature again in a fresh transaction. Before signing anything for a vault, `prepareWithdrawal` searches the vault's transaction history, failed transactions included (`findPendingWithdrawal`), for a signature already revealed at the current sequence, authenticates it with the vault's current key, and returns it for re-broadcast instead. An incomplete search refuses (`IncompleteSearchError`) rather than signing: history search can be flooded with cheap spam (audit round 2, findings C1 and C10), so the durable ledger is the primary record. A signature that was sent but never reached the chain leaves no trace there; if its record is lost, the only safe signature at that sequence is the identical message again.
4. **Deterministic randomizer.** The SDK derives `C` as above, so signing an identical message twice yields the identical signature and reveals nothing new. It verifies its own signature before returning it. A client that draws `C` at random, or derives it any other way, turns an accidental re-sign, or a second tool signing the same withdrawal, into a second signature (rule 1). Every signer must reproduce the known answer in SPEC §3.10, as the Rust crate's `sign_deterministic` does. The SDK exports no raw one-time signer.
5. **Sign only for the current sequence, with the next position's key.** Read the vault (`fetchVault`), derive `key(account, vault.sequence)`, and check that its key id equals the vault's `key_id`; if not, do not sign. Name `key(account, vault.sequence + 1)` as the next key: the program refuses any other index. The message carries the sequence, so it can execute only at that position.
6. **Check and confirm the recipient before signing.** `checkRecipient(conn, destinationOwner, mint, vault)` refuses recipients the program cannot pay usefully: a token account or a mint (the payout would land in an account owned by that address, usually one nobody can sign for), the vault itself, its payout addresses, and other PDAs of the vault program. It warns about off-curve recipients (a program must sign `release_to`), an existing canonical ATA whose owner field differs (`release` pays it anyway), an account that refuses non-confidential credits (use `release_to`) and frozen accounts. The signers require the user's confirmation of that result (`confirm`), with separate acknowledgments for recipient warnings, mint warnings and an off-curve recipient, and match it against the exact bytes signed. Signing is final; broadcasting can wait.
7. **Different keys per cluster, mint and account.** The cluster byte, mint and account in the path give every vault its own keys. The message does not include a genesis hash, so every PQ signer checks the RPC's genesis hash against the cluster (`assertCluster`; `allowLocalnet` for local validators), and a key is never reused across clusters by hand.
8. **Throwaway fee payer.** The SDK's `buildWithdrawTx` builds the withdrawal, optionally followed by `release` (`includeRelease`), as a v1 transaction signed by a fresh Ed25519 fee payer funded with a little SOL, and returns the signed wire bytes. That key has no authority over the vault. The user's wallet never has to sign a v1 transaction: funding the fee payer, `release` and `release_to` are ordinary transactions.
9. **Recovery from the phrase alone.** `scanVaults(conn, master, cluster, mint, maxAccount)` walks account 0, 1, 2, ...: for each it derives the genesis key and the vault address, then reads the vault's sequence, balance, reserved amount and pending payouts. For each vault, let `prepareWithdrawal` look for a pending withdrawal before signing anything (rule 3), and release pending payouts with `buildReleaseTx` or, for the recipient, `buildReleaseToTx`. A second device imports the first one's ledger records (`exportVaultKeyRecords` / `importVaultKeyRecords`, authenticated) before it signs; while the import reports `unverifiable` keys, it must not sign.
10. **Offline signing for large amounts.** Signing needs only the phrase and the message: the SDK's signer and message builder can run on an offline machine. The resulting signature can be relayed from any online device.
11. **Lose the phrase, lose the funds.** No admin, recovery key or reset exists. That is the point. The same holds for an identity: lose the phrase and the passkey, and its launches that are not attested yet can never go live.

## 7. Cost and transaction format

| Item | Value |
|---|---|
| `withdraw` instruction data | 2,312 bytes: 8-byte discriminator, 2,176-byte signature with its 4-byte length prefix, 32-byte recipient wallet, 8-byte `max_amount`, 32-byte next key id, 52-byte next `VaultKey` |
| Transaction | **v1** (SIMD-0385; 4,096-byte limit; mainnet since slot 447,120,000, 2026-09-15). Measured in LiteSVM (`tests/integration` `withdraw_and_release_sizes_and_compute`, 2026-10-08): `withdraw` alone, sent as the SDK sends it (8 addresses, one signature, both limit words set), is 2,693 bytes; with `release` in the same transaction it is 2,845 bytes for an SPL Token mint and 2,977 bytes for a Token-2022 mint with the Launch Guard hook. A legacy encoding of `withdraw` alone would be 2,777 bytes, far over the 1,232-byte legacy limit. `release` alone is small (522 bytes for SPL Token, 654 bytes for Token-2022 with the hook, as measured v1 transactions). v1 has no address lookup tables, allows at most 64 accounts, and ignores ComputeBudget instructions. Its compute-unit limit and loaded-accounts-data-size limit **default to 0**, so clients must set them (FACTS #6). Submit it to RPC base64-encoded. |
| Verification work | 67 chains. On average about 506 chain-step hashes of 55 bytes; at most 990. The digest depends on `C` and therefore on the message, so the cost varies per signature. |
| Compute: signature verification (model) | SHA-256 syscall cost about 58k CU on average and 112k at worst (`85 + Σ max(10, ⌊len/2⌋)` per call, FACTS #5). Assuming about 30 CU of loop overhead per step, roughly 73k / 142k. |
| Compute: whole instructions | Measured in LiteSVM 0.17 with the mainnet feature set, SBPF v3 builds and the mainnet token programs; ranges over 26 runs on 2026-10-08, because the digest, and so the work, differs per message. `withdraw` alone: about 79k–106k CU on either token program (it moves no tokens and creates one 122-byte account). `release` that creates the recipient's ATA: about 34k–58k (SPL Token) and 63k–97k (Token-2022 with the Launch Guard hook). `withdraw` + `release` in one transaction: about 121k–172k (SPL Token) and 145k–190k (Token-2022 with the hook). The SDK sets 200,000 CU for `withdraw` plus 80,000 to 300,000 for a `release` leg (SPEC §3.9). |
| Loaded account data | Measured with SIMD-0186 counting, program data included: `withdraw` alone about 0.39 MB (SPL Token) or 1.66 MB (Token-2022); with `release`, which also loads the ATA program, SPL Memo (74,800 bytes) and any hook, about 0.50 MB (SPL Token) or 1.95 MB (Token-2022 with the Launch Guard hook). The SDK sets 4 MiB. |
| Fee payer's cost | The signature fee (5,000 lamports per signature, plus any priority fee) and the payout account's rent: 1,270,000 lamports for 122 bytes at mainnet's current rent, refunded to the payer when the payout is released. If `release` has to create the recipient's ATA, its rent too: 1,488,440 lamports for an SPL Token account, slightly more for Token-2022 accounts with extensions. Rent figures are from mainnet on 2026-10-08 (FACTS, audit round 1 facts). |
| `open_vault`, deposits, `release`, `release_to` | Ordinary legacy transactions |
| Launch identity (`attest_launch`) | v1, 3,005 bytes (3,037 with a rules account); 91k–115k CU measured on the review-4 build; first attestation 16,057,800 lamports with rents (section 3.7) |
| Autopilot change (`pq_authorize`) | v1, about 2,924 bytes; 93k–107k CU; 14,208,760 lamports of rent for the authorization (section 3.12) |

## 8. Limits: what the post-quantum parts do not protect

| Limit | Why | What to do |
|---|---|---|
| **The token program can be upgraded.** | Token-2022 is upgradeable by a 4-of-6 multisig of Ed25519 keys (FACTS #47). A quantum attacker who forges four member signatures could replace it, and with it the rules for every Token-2022 account, vaults and launch tokens included. SPL Token (p-token) has no upgrade authority, though feature gates can still replace it (FACTS #8). | For the strongest custody, prefer SPL Token mints, such as wSOL. |
| **Meteora and the ATA program.** | DBC and DAMM v2 are upgradeable by a 4-of-7 multisig; the ATA program and Token-2022 are run by classical keys. They hold the pools every launch trades in. | Disclosed in [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md#who-you-still-trust). |
| **The mint's own authorities.** | Mint authorities are ordinary keys and can act on the vault's token account regardless of LM-OTS. The vault refuses the mints that leave an Ed25519 path to the deposit (permanent delegate, close authority, live transfer-fee authorities, plus NonTransferable). What remains: a freeze authority can freeze the vault's or the recipient's account, a pause authority can halt transfers, a transfer-hook authority can make transfers fail, and a mint authority can dilute. None of them can block `withdraw` or take funds; they can delay a payout until they stop. | Prefer mints whose authorities are None. Graduated Noised launch tokens qualify: no mint, freeze or metadata authority, and no hook. They are still Token-2022 mints, so the first row applies. During a launch's guard window, deposits and payouts of that launch's token are wallet-to-wallet transfers for the Launch Guard ([HOOKS.md](HOOKS.md#9-caveats)); a refused payout stays reserved and can be released after the guard. Since audit round 3's F2, a `release_to` of a launch token into a token account without an immutable owner also waits for the guard to end; `release` pays the canonical ATA, which always has one. A pure key rotation (`withdraw` with `max_amount = 0`) moves no token, so the Launch Guard never sees it: a vault holder can hand a vault holding guarded tokens to another party's key during the guard (HOOKS.md §9). |
| **Noised's programs are upgradeable until finalized.** | Until then, a forged or stolen upgrade-authority signature could replace them, the launchpad's attestation check and the autopilot's authorization check included. | Use them for real value only after finalization (`Authority: none`). |
| **An autopilot's operator and keepers.** | They are Ed25519 keys. Graph changes need the identity's LMS signature, but running the graph does not: keepers run due nodes, and an operator named in the graph runs its gated nodes, choosing their timing and an amount within the limits. A forged operator key can do no more than the operator could. | Revoke a compromised operator with a kind-3 authorization (section 3.12); prefer graphs keepers can run without an operator. |
| **Destination wallets.** | Once tokens are paid to an ordinary wallet, they are Ed25519-protected again. | Keep long-term holdings in the vault; name vaults as payout owners and fee recipients. |
| **SOL and other mints sent to the vault PDA.** | No instruction can move them (section 5). | Deposit only into the vault's token account, the address the SDK and app show as the deposit address. |
| **Transaction ordering.** | Block producers and the transaction-ordering gateways in front of most leaders (BAM, Harmonic, block engines) see a withdrawal, an attestation or an authorization before it lands. They can delay or drop it, but not change it, and seeing one signature does not let anyone forge another. Inside a launch window the first `launch` to land wins; a landed authorization can be used by anyone while it is valid (section 3.12). | Re-broadcast the stored signature (section 6, rule 3). |
| **Fee payer.** | A quantum attacker can steal the throwaway fee payer's SOL or spend it to grief. It cannot touch vault funds or change an attestation. | Fund it with only what one transaction needs, then sweep it back. |
| **Consensus.** | Validator and vote keys are not post-quantum. A quantum attack on consensus is a chain-level failure that no application can survive. | Out of scope. |
| **Your device, your passkey provider and your client.** | Malware that reads the phrase or drives the authenticator defeats any signature scheme. A synced passkey also trusts its sync provider. A client that breaks rule 1, or signs two messages at one LMS leaf, hands over the vault or the identity. A client that trusts its RPC's view of the leaf bitmap or the clock can be led into either (audit round 4, section 3.5). | Offline signing; treat the phrase like the highest-value secret you own; use a client that follows sections 3.5 and 6 and keeps its ledgers; sign with one device per quantum key unless you import its records; keep the device's clock right. |
| **Not yet audited.** | The LM-OTS and LMS code reproduces the RFC 8554 test vectors and the randomizer's known answer, and an independent Python implementation agrees, for the programmable-launch vectors too. The programs pass their LiteSVM suites against mainnet binaries, and mutation runs catch every selected non-equivalent mutant, the rules crate's and the autopilot's included (SPEC §6). Internal reviews by AI agents found and fixed the issues listed in [AUDIT.md](AUDIT.md). That is not an independent audit, and neither the programs nor the crate has had one. | Wait for the audits before relying on significant value. |

## 9. FAQ

**Is the token I launched on Noised quantum-proof?** No. It is an ordinary Token-2022 token held in ordinary wallets and traded in ordinary pools. What is post-quantum is the *launch*: that it went live, with exactly these parameters, this metadata and these rules, in this window, only because your identity signed it, and every change to its autopilot graph. You can also *hold* the token in a PQ vault. Launch tokens are good candidates, because they have no mint, freeze or metadata authority.

**Can someone with a quantum computer launch my token under a different name?** Not on Noised. Your identity signs the hash of the on-chain metadata record, and `launch` takes the name, symbol and uri from that record and checks the mint against it. A wallet signature alone cannot make any launch go live. The same holds for your launch rules: the identity signs their hash, and `launch` installs exactly those bytes.

**Can someone with a quantum computer change my token's autopilot?** Not its graph: activating, freezing and revoking the operator each need your identity's signature (section 3.12). It could forge an operator's Ed25519 key, if your graph names one, and then do only what the operator could, within the graph's limits, until your identity revokes it.

**Can I sign with my identity from two devices?** Only if they share their records. Each of the identity's 1,024 one-time keys may sign once, and a device only knows what it signed itself. Before signing on a second device (or after clearing a browser's data), import the first device's records. Clients built on SDK 0.9.0, the Noised app included, refuse to sign until you do, whenever the chain shows keys used elsewhere (section 3.5).

**Why not derive the identity from my wallet, so I need no new phrase?** Because the result would be a secret your wallet hands to any app you approve one signature for, and its link to you would be a classical signature that a quantum attacker can forge (section 3.4). A passkey gives the same "nothing new to write down" experience without either problem; export its 24 words once as a backup.

**Why not Falcon or ML-DSA?** No syscall exists. On-chain verifiers for them are unaudited libraries. Hash-based signatures need only SHA-256, which Solana provides natively.

**Why not a stateless scheme (SLH-DSA)?** Its smallest signatures (about 7.9 KB) do not fit one transaction. It would need buffered multi-transaction verification, which loses atomicity (FACTS #62). It remains a possible future option for rarely used, high-value authorities.

**Why does the vault use single LM-OTS keys but the identity an LMS tree?** A vault's state is its sequence number, which the program already tracks: each sequence gets a fresh one-time key derived from the phrase, and the program executes at most one withdrawal per sequence, so no tree is needed. An identity signs many launches under one public name, which needs a tree of one-time leaves; its state, which leaves have signed, is tracked on-chain by the identity's bitmap, and on the client by the leaf ledger.

**What if nobody opens my launch inside its window?** Nothing is lost by anyone else: commits only start after `launch`. You sign a new opening time at your identity's next leaf, and the launch opens in the new window; your published metadata record can be reused (section 3.8). Before you sign it, make sure every earlier signature you sent for that launch has landed, so none of them can take the new slot first.

**Can a relayer or validator front-run my withdrawal or my attestation?** It can only submit it early, or hold it back. The outcome (recipient, maximum amount and next key; or the launch, metadata and window) is fixed by your signature. Anyone can also release the resulting payout, but only to your recipient's canonical account.

**What if the recipient's account cannot receive?** The withdrawal still executes and the amount stays reserved in the vault. The recipient can fix its account and anyone can then `release`, or the recipient signs `release_to` to another of its token accounts. Nobody else's funds are affected.
