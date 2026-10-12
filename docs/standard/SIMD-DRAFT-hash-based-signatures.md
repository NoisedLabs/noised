---
simd: 'XXXX'
title: Native verification of hash-based signatures (LMS/HSS and SLH-DSA)
authors:
  - Noised maintainers
category: Standard
type: Core
status: Idea
created: 2026-10-10
feature: (to be assigned)
---

> **Draft for discussion.** This document is a starting point for a SIMD, not a submitted proposal. Measured numbers cite their source; every other number is marked as an estimate or a placeholder. Interface names are placeholders.

## Summary

Add a syscall that verifies stateful hash-based signatures (LMS and HSS, RFC 8554, as profiled by NIST SP 800-208) and stateless hash-based signatures (SLH-DSA, FIPS 205), priced by a deterministic worst-case count of hash compressions. Programs call it with inputs anywhere in their memory, including account data, and for LMS/HSS receive the one-time leaf indices they must track. A precompile variant is discussed under alternatives; the syscall is preferred because SLH-DSA signatures do not fit in a transaction.

## Motivation

### Post-quantum authorization is already being built, expensively

Every Solana authority is an Ed25519 key. A cryptographically relevant quantum computer could recover any of them from its public key. Solana offers no post-quantum signature verification today: no syscall or precompile exists, and the Falcon precompile proposal (SIMD-0461) was closed on 2026-06-17 with the rationale "sigverify as a library" (as recorded in the Noised research notes, `docs/research/FACTS.md` #59). Applications that want post-quantum authorization therefore verify hash-based signatures in SBF, built on `sol_sha256`.

Noised does this in its programs (not yet deployed to mainnet): every token launch must carry an LMS signature (`LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`, 2,508-byte signatures) by its creator's post-quantum identity, verified on-chain by the launchpad, and its vault moves tokens only on an LM-OTS signature. Measured costs:

| What | Measured | Source |
|---|---|---|
| `lms_verify` alone, SBPF v3 (LiteSVM 0.17, Agave 4.3 cost model) | `8,674 + 137.04 x steps` CU, fit over 129 signatures, largest residual 14 CU; `steps` is the number of Winternitz chain steps | [LMS cost measurements](../evidence/2026-10-09-lms-cost-measurements.md), LMS stage |
| RFC 8554 Appendix F Test Case 2 verified on-chain | 80,563 CU (525 steps) | same |
| Hardest digest found in 4,000 randomizers | 97,075 CU (645 steps) | same |
| Worst case (990 steps), extrapolated from the fit | 144,346 CU | same |
| Average | about 78,000 CU (about 506 steps); p99 about 91,000 CU | same; `docs/POST_QUANTUM.md` §7 |
| The `sol_sha256` charges alone (cost model, 173-byte message) | `3,005 + 112 x steps` CU; over 1,024 signatures min 43,325, mean 59,579, p99 70,205, max 73,565 | same |
| The whole `attest_launch` instruction (signature, leaf bitmap, account writes), all 1,024 leaves of one identity | 79,772 min / 95,439 mean / 114,476 max CU; worst-case projection 169,882 CU; a 2,972-byte v1 transaction | [LMS cost measurements](../evidence/2026-10-09-lms-cost-measurements.md), metadata fix stage |
| The vault's `withdraw` (one LM-OTS verification and state update) | about 79,000 to 106,000 CU | `docs/SPEC.md` §3.9 |
| The same LMS verification natively (Rust, release build, Ryzen 7 5800X) | 31 µs | [LMS cost measurements](../evidence/2026-10-09-lms-cost-measurements.md), LMS stage |

Three things follow.

1. **The cost is mostly syscall pricing, not hashing.** Each Winternitz chain step hashes 55 bytes. `sol_sha256` charges `85 + max(10, floor(len / 2))` CU per call and slice (Agave 4.3.0, `syscalls/src/lib.rs`; `docs/research/FACTS.md` #5), so 112 CU per step, of the 137 CU a step costs in total. The work itself is one SHA-256 compression. At Agave's `COMPUTE_UNIT_TO_US_RATIO` of 30 (`cost-model/src/block_cost_limits.rs`), 112 CU stands for about 3.7 µs; the desktop measurement above implies roughly 55 ns per compression (31 µs for about 565 compressions; an estimate derived from one machine).
2. **Larger and stateless schemes do not fit.** A v1 transaction carries at most 4,096 bytes (SIMD-0385). An LMS H10/W4 signature fits (the Noised attestation transaction is 2,972 bytes). A two-level HSS signature of the same parameters is 5,076 bytes, and every SLH-DSA parameter set has signatures of 7,856 bytes (SLH-DSA-SHA2-128s) or more (FIPS 205, Table 2). Verifying them in SBF needs the signature uploaded to an account over several transactions and a verification modeled at about 0.3 to 0.65 million CU for SLH-DSA-128s (`docs/research/FACTS.md` #62, modeled, not measured).
3. **Every application re-implements a consensus-critical-looking verifier.** Noised's verifier reproduces the RFC test vectors, has 31 of 31 mutants killed and an independent Python implementation, and has still had no independent audit. Each other team will repeat that work, or skip it.

### Why hash-based schemes, specifically

- Their security rests on the hash function alone (SHA-256, SHA-512 or SHAKE256). Against a quantum adversary, Grover's algorithm gives only a square-root speed-up on generic attacks.
- They are standardized: RFC 8554 (LMS, HSS), NIST SP 800-208 (stateful hash-based signatures), FIPS 205 (SLH-DSA).
- Verification is short, deterministic code over public data, with published known-answer tests (RFC 8554 Appendix F; NIST's validation vectors for LMS and SLH-DSA).
- Lattice verifiers exist as unaudited SBF libraries (Falcon-512 about 175,000 CU, ML-DSA-44 about 261,000 CU, as reported in `docs/research/FACTS.md` #63), and a newer non-hash scheme (HAWK) was withdrawn in 2026 after a key-recovery attack (same source). Hash-based schemes are the conservative first step; this proposal does not preclude others.

## New Terminology

| Term | Meaning |
|---|---|
| LMS | Leighton-Micali Signatures (RFC 8554): a Merkle tree of `2^h` one-time LM-OTS keys. Stateful: each leaf may sign once. |
| HSS | Hierarchical Signature System (RFC 8554): `L` levels of LMS trees, each signing the public key of the level below. |
| SLH-DSA | Stateless Hash-Based Digital Signature Algorithm (FIPS 205, derived from SPHINCS+). |
| Leaf index | The `q` of an LMS signature: which one-time key signed. |
| Compression unit | One SHA-256 or SHA-512 compression-function call, or one Keccak-f[1600] permutation for SHAKE256 parameter sets. |
| `B_max` | The largest number of compression units a verification can perform for a given parameter set and input lengths, computed before verifying. |

## Detailed Design

### Syscall

```c
/* Placeholder names. */
#define SOL_HBS_SCHEME_LMS_HSS     1   /* RFC 8554 HSS; an LMS key is HSS with L = 1      */
#define SOL_HBS_SCHEME_SLH_DSA     2   /* FIPS 205 slh_verify (pure, with context)        */
#define SOL_HBS_SCHEME_HASH_SLH_DSA 3  /* FIPS 205 hash_slh_verify (OPTIONAL in v1)       */

typedef struct {
    const uint8_t *public_key;  uint64_t public_key_len;
    const uint8_t *message;     uint64_t message_len;
    const uint8_t *signature;   uint64_t signature_len;
    const uint8_t *context;     uint64_t context_len;   /* SLH-DSA ctx, 0..=255 bytes; 0 for LMS/HSS */
} SolHbsVerifyArgs;

/* Returns 0 if the signature is valid, otherwise a verification result code (below).
 * For SOL_HBS_SCHEME_LMS_HSS and a valid signature, writes to `out` (33 bytes):
 *   u8 levels, then u32le leaf index q for each level, top level first, zero-padded to 8 levels. */
uint64_t sol_hbs_verify(uint64_t scheme, const SolHbsVerifyArgs *args, uint8_t *out);
```

Semantics:

1. Read the scheme, the input lengths and the typecodes (a bounded amount of work, covered by `hbs_base_cost`), then charge the full cost (next section) before any hashing. The charge does not depend on whether the signature is valid.
2. Translate every input range; any range outside readable VM memory, or `out` outside writable memory, aborts the instruction (as for other syscalls). Inputs may be in instruction data or in account data, so large signatures can be staged in an account over several transactions and verified in one instruction.
3. Parse strictly. LMS/HSS: the HSS public key is `u32be(L) || LMS public key`; the signature is `u32be(L - 1)`, then for each upper level an LMS signature followed by the next level's LMS public key, then the bottom LMS signature (RFC 8554 §6). Every length MUST match the typecodes exactly; every typecode MUST be supported; every `q < 2^h`; `L` in 1..=8; the bottom message is `message`, each upper level's message is the next public key. SLH-DSA: the public key and signature lengths MUST equal the parameter set's (identified by an explicit parameter-set byte prefixed to the public key, or by a separate argument; to be decided).
4. Verify per RFC 8554 Algorithms 6, 6a and 4b (LMS/HSS) or FIPS 205 Algorithm 24 (`slh_verify`, which builds `M' = toByte(0, 1) || toByte(|ctx|, 1) || ctx || M`) and, if supported, Algorithm 25 (`hash_slh_verify`).
5. Return codes: `0` valid; `1` invalid signature; `2` malformed or unsupported public key; `3` malformed signature; `4` unsupported scheme or parameter set; `5` context too long. These are results, not errors: the instruction continues and the program decides.
6. Maximum sizes (proposed): public key 65 bytes (64 plus a possible parameter-set byte), signature 65,536 bytes, message 65,536 bytes, context 255 bytes. Inputs above them are not read and return `4`; HSS combinations whose signatures would exceed 65,536 bytes (for example eight levels of `H25`/`W1`) are therefore unsupported.

Parameter sets, version 1 (proposed):

| Scheme | REQUIRED | OPTIONAL |
|---|---|---|
| LMS/HSS | SHA-256 with `n = m = 32`: LMS `H5`, `H10`, `H15`, `H20`, `H25` (typecodes 5 to 9) and LM-OTS `W1`, `W2`, `W4`, `W8` (typecodes 1 to 4), any combination per level, `L <= 8` | the SP 800-208 parameter sets with SHA-256/192 (`n = 24`), SHAKE256/256 and SHAKE256/192, by their registered typecodes |
| SLH-DSA | the twelve FIPS 205 parameter sets (SHA2 and SHAKE; 128, 192, 256; s and f), pure interface with context | HashSLH-DSA |

XMSS and XMSS^MT (RFC 8391, also in SP 800-208) are out of scope for version 1.

### Compute pricing

Principle: charge an upper bound of the work, known before verifying, so that the cost is deterministic and a bad signature costs as much as a good one.

```text
cost = hbs_base_cost
     + sha256_block_cost   x B_max_sha256(params, |message|, |context|)
     + sha512_block_cost   x B_max_sha512(params, ...)          (SLH-DSA-SHA2 at 192 and 256 bits)
     + keccak_perm_cost    x B_max_keccak(params, ...)          (SHAKE parameter sets)
```

`B_max` is a closed form per parameter set, written into the final SIMD. For a single LMS tree with SHA-256, `n = 32`, LM-OTS width `w` with `p` chains and tree height `h`:

```text
B_max = ceil((54 + |message| + 9) / 64)        Q = H(I || q || 0x8181 || C || message)
      + p * (2^w - 1)                          chain steps, 55 bytes each: one block
      + ceil((22 + 32 p + 9) / 64)             K = H(I || q || 0x8080 || z_0 .. z_{p-1})
      + 1                                      leaf hash (54 bytes)
      + 2 h                                    interior hashes (86 bytes: two blocks)
```

For `LMS_SHA256_M32_H10` / `LMOTS_SHA256_N32_W4` (`p = 67`) and a 189-byte message: `4 + 1,005 + 34 + 1 + 20 = 1,064` blocks. The Winternitz checksum actually caps the chain steps at 990, so the true maximum is 1,049, and the average is about 565 (506 steps on average). HSS sums the bound over its levels, each upper level hashing a 56-byte public key as its message.

For SLH-DSA, a rough count from the FIPS 205 parameters (an estimate, to be replaced by exact closed forms): SLH-DSA-SHA2-128s (`k = 14`, `a = 12`, `d = 7`, `h' = 9`, `len = 35`, `w = 16`) makes about 182 FORS hashes, then per hypertree layer up to `35 x 15` chain steps, one public-key compression and 9 tree hashes: about 2,100 hash calls on average and at most about 3,930. The `f` sets have three times as many layers (`d = 22` for 128f) and cost about three times as much to verify.

Calibration. The constants MUST come from benchmarks of every validator client (Agave, Firedancer) on the slowest supported reference hardware, including CPUs without SHA extensions, such that `cost / COMPUTE_UNIT_TO_US_RATIO` (30 CU per µs in Agave 4.3.0) is at least the measured worst-case time with a safety margin. For orientation only:

| Quantity | Value | Kind |
|---|---|---|
| ed25519 precompile, per signature | 2,400 CU (80 µs at 30 CU/µs) | Agave 4.3.0 `ED25519_VERIFY_STRICT_COST` |
| secp256r1 precompile, per signature | 4,800 CU | Agave 4.3.0 `SECP256R1_VERIFY_COST` |
| secp256k1 precompile, per signature | 6,690 CU | Agave 4.3.0 `SECP256K1_VERIFY_COST` |
| LMS H10/W4 natively, mean | 31 µs (about 930 CU at 30 CU/µs) | measured on one desktop CPU; the CU figure is arithmetic |
| LMS H10/W4 natively, worst case | about 58 µs (about 1,700 CU at 30 CU/µs) | estimate: 1,049 blocks at the measured rate per block |
| SLH-DSA-SHA2-128s natively, worst case | about 220 µs (about 6,500 CU at 30 CU/µs) | estimate: about 4,000 blocks at the same rate, with the public seed's first block precomputed |
| Illustration with placeholder constants (base 1,000 CU, 2 CU per SHA-256 block) | LMS H10/W4: 3,128 CU; SLH-DSA-SHA2-128s: about 9,000 CU | placeholders, not a proposal |
| Today in SBF | LMS H10/W4: about 78,000 CU mean, 144,346 CU worst; SLH-DSA-128s: about 0.3 to 0.65 million CU over several transactions | measured; modeled |

Even with a generous margin, native verification would cost one to two orders of magnitude less than today, and SLH-DSA would become verifiable in one instruction.

### Feature gate

The syscall is registered only after a feature gate activates. Before activation, a program that references it cannot be deployed (its ELF names an unregistered syscall).

## Alternatives Considered

1. **Status quo: verification as an SBF library.** Works today (Noised). Costs 78,000 to 144,000 CU per LMS verification, measured, and leaves SLH-DSA and multi-level HSS to multi-transaction designs. Every team audits its own verifier.

2. **A precompile program, like `Ed25519SigVerify111111111111111111111111111`, `KeccakSecp256k11111111111111111111111111111` and `Secp256r1SigVerify1111111111111111111111111`.** The runtime verifies the instruction's data before execution, the cost model charges a fixed price per signature, and programs confirm the result by reading the instructions sysvar.
   - For: an established pattern; no change to the SBF syscall interface; static pricing in the scheduler.
   - Against: inputs must be in instruction data, so only LMS signatures of single trees (2,508 bytes for H10/W4) fit a 4,096-byte transaction; two-level HSS (5,076 bytes) and every SLH-DSA set (7,856 bytes and more) do not. Programs must parse offsets in the instructions sysvar correctly, a source of past integration bugs. The leaf index is not returned; programs must parse it from the signature themselves. A fixed per-signature price must cover the worst case of the largest parameter set unless the price depends on a parameter byte.
   - A precompile limited to LMS single trees is a reasonable smaller first step if the syscall is judged too invasive.

3. **Make generic hashing cheaper instead** (a vectored `sol_sha256` hashing many independent short inputs per call, a compression-function syscall with a caller-supplied midstate, or a lower per-call base cost). Scheme-agnostic and consistent with "sigverify as a library".
   - LM-OTS chains are independent of each other, so a vectored call can advance all 67 chains one step per call (15 calls). Estimate: if the 85-CU base were paid once per call instead of once per hash, a chain step would cost about 27 CU of hashing plus about 25 CU of SBF overhead, so an LMS H10/W4 verification about 35,000 CU on average and 60,000 CU at worst: about twice cheaper, against one to two orders of magnitude for native verification (estimates above). It does not help SLH-DSA's size problem.
   - We would support this as a complementary step.

4. **A Keccak-f[1600] permutation syscall** (SIMD-0579, open). Makes SHAKE-based variants cheaper in SBF. Complementary; same limits as alternative 3.

5. **Native lattice signatures (Falcon, ML-DSA).** Smaller signatures, but more complex verification code and assumptions. SIMD-0461 (Falcon) was closed. Not excluded by this proposal; hash-based verification is the smaller, more conservative addition.

6. **Only one family.** LMS alone serves frequent signers that can keep state; SLH-DSA alone serves rarely used high-value keys without state. Both are cheap to add once the hashing core exists; v1 could ship LMS first.

## Impact

- **Program developers:** post-quantum authorization (launch attestations, vault withdrawals, multisig members, governance votes, program-controlled upgrade paths) for a few thousand CU instead of about 100,000, and stateless SLH-DSA keys for rarely used authorities. Programs already finalized (Noised's will be) cannot adopt it; new program versions can.
- **Validators:** new, small, deterministic code paths over hash functions they already implement; benchmarks per client.
- **Core contributors:** a feature gate, implementations in every validator client, conformance vectors, differential fuzzing.

It does not make Solana post-quantum. Transaction signatures, fee payers, vote and validator keys remain Ed25519 (and BLS under Alpenglow). This proposal gives applications a cheap, shared building block for post-quantum authorization inside programs.

## Security Considerations

**Consensus determinism.** Every client must accept and reject exactly the same inputs. The specification must fix strict parsing (lengths, typecodes, `q` bounds, `L` bounds, trailing bytes), the result codes and the pricing formula. Conformance requires RFC 8554 Appendix F, NIST's validation vectors for LMS and SLH-DSA, negative vectors (one per parsing rule), and differential fuzzing between clients.

**Stateful versus stateless.**

- LMS and HSS are stateful: a one-time leaf that signs two different messages (or one message with two randomizers) lets anyone forge signatures. The runtime cannot track signer state. The syscall therefore returns the leaf indices, and a program that accepts LMS signatures MUST record each used leaf per key and refuse a reuse. It SHOULD also make every valid signature consumable, so that a signature that was revealed but refused for an application reason still burns its leaf; otherwise the signer is pushed to sign again at the same leaf. Noised's attestation follows this rule after an adversarial review demonstrated a forgery against an earlier design that did not (`docs/POST_QUANTUM.md` §3.5, §3.7). Signer-side state (durable ledgers, multiple devices) remains the main risk and is outside the runtime.
- NIST SP 800-208 approves LMS and HSS for specific uses and expects keys to be generated and used inside hardware cryptographic modules. Software keys, as used by Noised, are outside that approval. The syscall does not change that; it verifies.
- SLH-DSA is stateless: no per-key state, at the price of larger signatures and slower signing. It suits keys that sign rarely (upgrade or recovery authorities, multisig members).

**Denial of service.** Pricing is the worst case for the parameter set and input lengths, charged before work. Input sizes are bounded. Inputs are read in place; no allocation proportional to input size is needed.

**Hash assumptions.** Security reduces to properties of SHA-256, SHA-512 or SHAKE256. The `n = 24` sets of SP 800-208 have a smaller security margin than `n = 32` and are OPTIONAL.

**Side channels.** Verification handles public data only.

**Domain separation is the application's job.** The syscall verifies a message; applications must bind what a signature authorizes (program id, accounts, sequence numbers or nonces, a purpose tag and version) so that a signature cannot be replayed elsewhere. The runtime does not expose the cluster's genesis hash to programs; applications that use one key on several clusters must separate them in key derivation, as Noised does.

**Kill switch.** Like other features, the syscall can be disabled by a feature gate. Programs that depend on it for custody would then lock funds. Applications SHOULD keep an alternative path (for example the SBF library) for anything that must stay withdrawable.

## Drawbacks

- More consensus-critical code in every validator client.
- A second way to do something applications can already do (alternative 1).
- Pricing calibration across clients and hardware is work, and a wrong price is either a DoS vector or a useless feature.

## Backwards Compatibility

New syscall behind a feature gate; no existing program or transaction changes behaviour. Programs that use it cannot be deployed before activation. A precompile variant would be a new program id, and transactions that reference it before activation fail.

## Open Questions

1. Syscall, precompile, or both (a precompile for single LMS trees first)?
2. Parameter-set identification for SLH-DSA: a prefix byte on the public key, or an argument?
3. Which sets are REQUIRED in version 1; whether HSS with `L > 2` is needed.
4. Whether to add XMSS and XMSS^MT (RFC 8391, SP 800-208).
5. Calibration method and margins, and whether to price per actual work (variable) instead of the bound.
6. Whether alternative 3 (cheaper generic hashing) should come first, as a scheme-agnostic step.

## References

- RFC 8554, Leighton-Micali Hash-Based Signatures.
- NIST SP 800-208, Recommendation for Stateful Hash-Based Signature Schemes.
- NIST FIPS 205, Stateless Hash-Based Digital Signature Standard.
- RFC 8391, XMSS: eXtended Merkle Signature Scheme.
- SIMD-0385 (transaction format v1), SIMD-0461 (Falcon precompile, closed), SIMD-0579 (Keccak-f[1600] syscall, open).
- Agave 4.3.0: `cost-model/src/block_cost_limits.rs`, `program-runtime/src/execution_budget.rs`, `syscalls/src/lib.rs`, `precompiles/src/lib.rs`.
- Noised: `crates/noised-lmots` (LMS and LM-OTS verifier, RFC 8554 known answers), `docs/POST_QUANTUM.md`, `docs/standard/QSL-1.md`; measurements in `docs/evidence/2026-10-09-lms-cost-measurements.md` (the PQ v2 LMS stage and the metadata fix stage).
