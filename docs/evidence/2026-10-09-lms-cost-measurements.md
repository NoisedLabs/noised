# LMS verification cost measurements

This summarizes the LMS cost measurements of 2026-10-09: the LMS stage of PQ v2 (the `noised-lmots` LMS code, `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`) and the fix stage of the on-chain metadata change (the launchpad's `attest_launch`). [QSL-1](../standard/QSL-1.md) and the [SIMD draft](../standard/SIMD-DRAFT-hash-based-signatures.md) cite them.

## LMS stage (PQ v2)

On-chain, in a scratch probe program (SBPF v3 release build, LiteSVM 0.17, Agave 4.3 cost model):

| Measurement | Result |
|---|---|
| RFC 8554 Appendix F, Test Case 2, verified on-chain | 80,563 CU (525 steps, the same count as the review's independent model) |
| A wrong claimed leaf, a tampered `y`, a tampered path, a wrong LMS typecode | all refused on-chain |
| `lms_verify` cost, fit over 129 signatures | 8,674 + 137.04 × steps CU (largest residual 14 CU; steps 420 to 645) |
| The same, on average and at p99 | about 78k CU on average, 91k at p99 |
| The hardest digest found in 4,000 randomizers (645 steps) | 97,075 CU |
| Worst case, extrapolated (990 steps) | 144,346 CU |

`steps` is the number of Winternitz chain steps.

The `sol_sha256` charges alone, from a counting backend priced like Agave's `sol_sha256` (85 + Σ max(10, len/2)): 13 + steps calls, `3,005 + 112 × steps` CU for a 173-byte message. Over 1,024 signatures: min 43,325, mean 59,579, p99 70,205, max 73,565 CU.

On the host (Ryzen 7 5800X, release build, the crate's `lms_bench` example with the `signer` and `sha2-backend` features):

| Operation | Time |
|---|---|
| key generation (1,024 leaves) | 62 ms |
| sign (including self-verification) | 65 µs |
| verify | 31 µs |

The LMS mutation check (`scripts/pq/lms_mutants.py`) killed 31 of 31 mutants.

## Metadata fix stage (`attest_launch`)

The whole `attest_launch` instruction: signature, leaf bitmap and account writes.

| Measurement | Result |
|---|---|
| Transaction size | 2,972 bytes, v1, for every record |
| The integration vector transaction | 99,096 CU; 784,564 bytes loaded |
| All 1,024 leaves of one identity | 79,772 min / 95,439 mean / 114,476 max CU |
| LiteSVM, 41 signatures with the largest metadata | 86,869 min / 97,063 median / 109,305 max CU |
| Worst-case projection (990 chain steps) | 169,882 CU |

The full measurement records are kept by the maintainers.
