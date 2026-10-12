# On-chain metadata: final verification

This summarizes the final verification run of the on-chain metadata stage, on 2026-10-09 between 19:06 and 20:04 (local time). The review and its fixes are in [AUDIT.md](../AUDIT.md) §11.

The run used the crate names from before the rename to Noised, so its steps and files are named `phalanx-*` and `phalanx_*.so`. Today's `noised_*` programs are the same programs.

**Overall result: PASS.** Every step exited 0 with 0 warning lines.

## Steps

| Step | Result | Tests passed |
|---|---|---:|
| SBPF v3 builds: hook, vault, launchpad, shield | PASS | |
| `cargo fmt --check`: root, launchpad, integration, shield workspaces | PASS | |
| clippy, root workspace | PASS | |
| host workspace (`cargo test --workspace`) | PASS | 151 |
| LM-OTS/LMS known answers | PASS | 35 |
| clippy, `tests/integration` | PASS | |
| `tests/integration` | PASS | 98 |
| clippy, launchpad LiteSVM | PASS | |
| launchpad LiteSVM | PASS | 58 |
| clippy, shield LiteSVM | PASS | |
| shield LiteSVM | PASS | 17 |
| Python reference checks: Appendix F, attestation vectors, metadata vectors | PASS | |
| mutant-pattern dry runs: integration, LiteSVM-only | PASS | |
| IDL regenerated with `anchor idl build`: launchpad | PASS | |
| integration mutants | PASS | 148 of 148 killed |
| LiteSVM-only mutants | PASS | 23 of 23 killed |
| re-run at the end: `cargo fmt --check` and clippy of the launchpad LiteSVM workspace, then its suite | PASS | 59 |

The integration mutants are vault 38, hook 36 and launchpad 74.

The LiteSVM-only run also ran the 2 documented equivalent `MetadataMismatch` mutants, and as expected no test killed them: `post-condition-skipped` and `post-condition-allows-additional-metadata` (each equivalent with an honest DBC).

## Program sizes

All four builds have ELF `e_flags` 3 (SBPF v3).

| Program | Bytes |
|---|---:|
| hook | 197,016 |
| launchpad | 783,296 |
| shield | 288,640 |
| vault | 279,608 |

The full log is kept by the maintainers.
