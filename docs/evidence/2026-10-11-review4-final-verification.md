# Review 4 (P1c): final verification

This summarizes the one verification run on the final tree with the review-4 program fixes, started on 2026-10-11 at 17:33 (local time), and the mutation runs that followed it, before the files were merged into the repository. The findings and fixes are in [AUDIT.md](../AUDIT.md) §15.

The run used the crate names from before the rename to Noised, so its steps and files are named `phalanx-*` and `phalanx_*.so`. Today's `noised_*` programs are the same programs.

**Overall result: PASS.** Every step exited 0 with 0 warning lines.

## Steps

| Step | Result | Tests passed |
|---|---|---:|
| SBPF v3 builds: hook, vault, launchpad, shield, autopilot | PASS | |
| `cargo fmt --check`: root, launchpad, integration, shield, autopilot workspaces | PASS | |
| clippy, root workspace | PASS | |
| host workspace (`cargo test --workspace`) | PASS | 317 |
| `noised-rules` with all features | PASS | 81 |
| LM-OTS/LMS known answers | PASS | 35 |
| clippy, `tests/integration` | PASS | |
| `tests/integration` | PASS | 113 |
| clippy, launchpad LiteSVM | PASS | |
| launchpad LiteSVM | PASS | 82 |
| clippy, shield LiteSVM | PASS | |
| shield LiteSVM | PASS | 19 |
| clippy, autopilot LiteSVM | PASS | |
| autopilot LiteSVM | PASS | 27 |
| Python reference checks: Appendix F, attestation vectors, metadata vectors, programmable vectors | PASS | |
| mutant-pattern dry runs: integration, LiteSVM-only, autopilot, rules crate | PASS | |
| IDLs regenerated with `anchor idl build`, all five programs | PASS: identical to `idls/` | |

## Program sizes

All five builds have ELF `e_flags` 3 (SBPF v3).

| Program | Bytes |
|---|---:|
| autopilot | 394,264 |
| hook | 214,984 |
| launchpad | 846,560 |
| shield | 288,640 |
| vault | 279,608 |

## Hook compute

Measured by the launchpad LiteSVM suite in this run: compute used inside the hook's `execute`.

| Transfer | Without rules | With the largest rule set |
|---|---:|---:|
| buy | 3,295 | 9,126 |
| sell | 2,425 | 2,425 |
| claim | 3,302 | 3,416 |

## Mutation runs

Run right after the final verification, on the mutants of the changed code.

| Run | Result |
|---|---|
| Host, the whole table | 60 of 60 killed |
| LiteSVM-only, 55 selected (hook and launchpad) | 51 of 51 killed, plus 4 documented equivalents (`hook-rule-after-the-exempt-source`, `hook-reads-only-the-first-extension`, `hook-rules-after-the-guard`, `launch-skips-the-rules-post-condition`) |
| Autopilot, 21 selected | 21 of 21 killed; the table's 9 documented equivalents listed with their reasons |
| Integration, 31 selected (13 H, 16 HR, 2 LR) | 31 of 31 killed |

Mutant-pattern dry runs: integration 229, LiteSVM-only 96, autopilot 193 (plus 9 equivalent), rules crate 180. Every pattern matches exactly once.

The full log is kept by the maintainers.
