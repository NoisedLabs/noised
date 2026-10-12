# Audit round 3: final verification

This summarizes the one verification run on the final tree with audit round 3's program fixes F1 and F2, on 2026-10-10 from 19:42 to 20:52 (local time), after the last edit and before the files were merged into the repository. The findings and fixes are in [AUDIT.md](../AUDIT.md) §14.

The run used the crate names from before the rename to Noised, so its steps and files are named `phalanx-*` and `phalanx_*.so`. Today's `noised_*` programs are the same programs.

**Overall result: PASS.** Every step exited 0 with 0 warning lines.

## Steps

| Step | Result | Tests passed |
|---|---|---:|
| SBPF v3 builds: hook, vault, launchpad, shield | PASS | |
| `cargo fmt --check`: root, launchpad, integration, shield workspaces | PASS | |
| clippy, root workspace | PASS | |
| host workspace (`cargo test --workspace`) | PASS | 157 |
| LM-OTS/LMS known answers | PASS | 35 |
| clippy, `tests/integration` | PASS | |
| `tests/integration` | PASS | 103 |
| clippy, launchpad LiteSVM | PASS | |
| launchpad LiteSVM | PASS | 69 |
| clippy, shield LiteSVM | PASS | |
| shield LiteSVM | PASS | 18 |
| Python reference checks: Appendix F, attestation vectors, metadata vectors | PASS | |
| mutant-pattern dry runs: integration, LiteSVM-only | PASS | |
| IDLs regenerated with `anchor idl build`: hook, launchpad | PASS: identical to `idls/` | |
| integration mutants | PASS | 170 of 170 killed |
| LiteSVM-only mutants | PASS | 50 of 50 killed |
| host mutants | PASS | 8 of 8 killed |

The integration mutants are vault 38, hook 43 and launchpad 89.

The LiteSVM-only run also ran its 5 documented equivalent mutants, and as expected no test killed them: `post-condition-skipped`, `post-condition-allows-additional-metadata`, `window-remainder-from-now-only`, `hook-rule-after-the-exempt-source`, `hook-reads-only-the-first-extension`.

## Program sizes

All four builds have ELF `e_flags` 3 (SBPF v3).

| Program | Bytes |
|---|---:|
| hook | 198,104 |
| launchpad | 783,552 |
| shield | 288,640 |
| vault | 279,608 |

The full log is kept by the maintainers.
