# Audit round 4: final verification

This summarizes the one verification run on the final tree with the audit-round-4 program fixes, on 2026-10-11 from 19:55 to 20:00 (local time), before the files were merged into the repository. The findings and fixes are in [AUDIT.md](../AUDIT.md) §16.

The run used the crate names from before the rename to Noised, so its steps and files are named `phalanx-*` and `phalanx_*.so`. Today's `noised_*` programs are the same programs.

**Overall result: PASS.** Every step exited 0 with 0 warning lines.

## Steps

| Step | Result | Tests passed |
|---|---|---:|
| SBPF v3 builds: hook, vault, launchpad, shield, autopilot | PASS | |
| `cargo fmt --check`: root, launchpad, integration, shield, autopilot workspaces | PASS | |
| clippy, root workspace | PASS | |
| host workspace (`cargo test --workspace`) | PASS | 323 |
| `noised-rules` with all features | PASS | 81 |
| LM-OTS/LMS known answers | PASS | 35 |
| clippy, `tests/integration` | PASS | |
| `tests/integration` | PASS | 113 |
| clippy, launchpad LiteSVM | PASS | |
| launchpad LiteSVM | PASS | 84 |
| clippy, shield LiteSVM | PASS | |
| shield LiteSVM | PASS | 19 |
| clippy, autopilot LiteSVM | PASS | |
| autopilot LiteSVM | PASS | 36 |
| Python reference checks: Appendix F, attestation vectors, metadata vectors, programmable vectors | PASS | |
| mutant-pattern dry runs: integration, LiteSVM-only, autopilot, rules crate | PASS | |
| IDLs regenerated with `anchor idl build`, all five programs | PASS: identical to `idls/` | |

The host total of 323 is: autopilot 62, hook 39, launchpad 83, `noised-lmots` 34 (8 unit, 10 LM-OTS, 16 LMS) plus 1 doctest, `noised-rules` 81, shield 17 and vault 6.

The new suites: launchpad LiteSVM `audit_round4` 2 tests (`l_i1_a_buy_completing_the_curve_during_the_shield_is_refused`, `l_i2_no_commit_after_the_batch`), autopilot LiteSVM `audit4` 9 tests. Both pass.

## Program sizes

All five builds have ELF `e_flags` 3 (SBPF v3).

| Program | Bytes |
|---|---:|
| autopilot | 402,032 |
| hook | 214,984 |
| launchpad | 846,896 |
| shield | 288,640 |
| vault | 279,608 |

## Mutation runs

Run just before the final verification.

| Run | Result |
|---|---|
| Autopilot, the whole table (234 mutants plus 12 documented equivalents), first full run | 232 of 234 killed. 2 survivors, both M4: "a zero share is skipped" and "skip check of any owner". |
| Autopilot, the 2 survivors again, after a new test and a strengthened test | 2 of 2 killed (`m4_a_share_of_nothing_is_no_skip`, `m4_recipients_without_accounts_are_skipped_and_cost_keepers_nothing`) |
| LiteSVM-only, the 4 mutants of `commit` | 4 of 4 killed (`vault-total-not-capped`, `vault-total-not-recorded`, `vault-without-its-record`, `commit-after-the-batch`) |

Mutant-pattern dry runs: integration 229, LiteSVM-only 97, autopilot 234 (plus 12 equivalent), rules crate 180. Every pattern matches exactly once.

## Compute before and after the fixes

LiteSVM, the same state run against the build before the fixes (baseline) and after them.

| Instruction | Baseline | New | Change |
|---|---:|---:|---:|
| `update_price` | 10,920 | 11,934 | +1,014 |
| `run` BUYBACK_BURN (keeper) | 62,867 | 64,345 | +1,478 |
| `run` BUYBACK_BURN (keeper, 1% of the pool: partial) | 62,882 | 64,543 | +1,661 |
| `run` BURN (graduated) | 36,231 | 37,707 | +1,476 |
| `run` DISTRIBUTE_SOL (8 recipients) | 73,208 | 76,149 | +2,941 |
| `run` BUYBACK_BURN (operator) | 62,720 | 64,197 | +1,477 |
| `revoke_operator` | 12,561 | 13,595 | +1,034 |
| `activate` (a replacement) | 15,185 | 16,199 | +1,014 |
| `apply_pending` | 12,271 | 13,317 | +1,046 |
| `freeze` | 12,810 | 13,824 | +1,014 |
| `init_autopilot` | 38,789 | 39,802 | +1,013 |
| `run` BURN (before graduation; baseline tips) | 35,689 | 34,959 | −730 |

The full log is kept by the maintainers.
