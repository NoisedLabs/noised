# P1c merge: verification run

This summarizes the verification run on the merged tree of P1c (programmable launches: the rules crate, the hook's creator rules, attestation v3, certificate v4, `pq_authorize` and the autopilot program), started on 2026-10-11 at 00:32 (local time), and the re-runs that followed it. What P1c merged and how review 4 then fixed it are in [AUDIT.md](../AUDIT.md) §15.

The run used the crate names from before the rename to Noised, so its steps and files are named `phalanx-*` and `phalanx_*.so`. Today's `noised_*` programs are the same programs.

**Overall result of the first run: FAIL**, for two reasons, both recorded in AUDIT.md: one clippy finding in the `tests/integration` workspace, and two mutation survivors. Every test suite passed.

## Steps

| Step | Result | Tests passed |
|---|---|---:|
| SBPF v3 builds: hook, vault, launchpad, shield, autopilot | PASS | |
| `cargo fmt --check`: root, launchpad, integration, shield, autopilot workspaces | PASS | |
| clippy, root workspace | PASS | |
| host workspace (`cargo test --workspace`) | PASS | 306 |
| `noised-rules` with all features | PASS | 81 |
| LM-OTS/LMS known answers | PASS | 35 |
| clippy, `tests/integration` | FAIL (exit 101, 1 warning line) | |
| `tests/integration` | PASS | 110 |
| clippy, launchpad LiteSVM | PASS | |
| launchpad LiteSVM | PASS | 80 |
| clippy, shield LiteSVM | PASS | |
| shield LiteSVM | PASS | 18 |
| clippy, autopilot LiteSVM | PASS | |
| autopilot LiteSVM | PASS | 27 |
| Python reference checks: Appendix F, attestation vectors, metadata vectors, programmable vectors | PASS | |
| mutant-pattern dry runs: integration, LiteSVM-only, autopilot, rules crate | PASS | |
| IDLs regenerated with `anchor idl build`, all five programs | PASS: identical to `idls/` | |
| integration mutants | 218 of 219 killed | |
| LiteSVM-only mutants (88 selected) | 80 of 81 killed, plus 7 documented equivalents | |
| host mutants | 47 of 47 killed | |
| autopilot mutants | 184 of 184 killed | |
| rules-crate mutants | 180 of 180 killed | |

The integration mutants are vault 38, hook 43, the hook's rules 13 (HR), launchpad 89 and the launchpad's rules and authorization code 36 (LR). The survivor is LR25, "another identity's signature authorizes".

The LiteSVM-only survivor is `hook-rules-before-the-caps`. The 7 documented equivalents, which no test killed as expected: `post-condition-skipped`, `post-condition-allows-additional-metadata`, `window-remainder-from-now-only`, `hook-rule-after-the-exempt-source`, `hook-reads-only-the-first-extension`, `hook-rules-after-the-guard`, `launch-skips-the-rules-post-condition`.

Review 4's fixes added the tests that kill both survivors ([2026-10-11-review4-final-verification.md](2026-10-11-review4-final-verification.md)).

## Re-runs after the clippy fix

| Started | Steps | Result |
|---|---|---|
| 02:27 | fmt (launchpad, integration), clippy and tests of `tests/integration`, clippy and tests of the launchpad LiteSVM workspace | FAIL: clippy of `tests/integration` and its test step (both exit 101, no tests run); launchpad LiteSVM PASS, 81 passed |
| 02:28 | fmt, clippy and tests of `tests/integration` | PASS: clippy clean, 110 passed |
| 02:30 | fmt of all five workspaces, clippy of the launchpad LiteSVM workspace | PASS |

## Program sizes

All five builds have ELF `e_flags` 3 (SBPF v3).

| Program | Bytes |
|---|---:|
| autopilot | 392,664 |
| hook | 213,616 |
| launchpad | 846,208 |
| shield | 288,640 |
| vault | 279,608 |

The full log is kept by the maintainers.
