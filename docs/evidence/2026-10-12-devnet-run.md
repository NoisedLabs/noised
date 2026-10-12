# Devnet run: recorded results

This summarizes the recorded results of the devnet test runs of 2026-10-12: the LiteSVM suites run against devnet's program binaries, the rehearsal on a Surfpool fork of devnet, and the live run on devnet. Times are UTC. The full story, with every transaction's explorer link, is in [DEVNET.md](../DEVNET.md).

The scripts write one record per transaction and per check. A check passes when what the chain holds matches what the script expects.

## LiteSVM suites with devnet's binaries as fixtures

Devnet's DBC, DAMM v2, Token-2022, SPL Token and ATA programs, dumped from devnet and used in place of the mainnet fixtures. Every suite passes.

| Suite | Tests passed |
|---|---:|
| `tests/integration` (9 test files) | 113 |
| launchpad LiteSVM (10 test files, `audit_round4` included) | 84 |
| autopilot LiteSVM (5 test files, `audit4` included) | 36 |

## Rehearsal on a Surfpool fork of devnet (12:45 to 13:19)

| Phase | Transactions | Checks | Result |
|---|---:|---:|---|
| Protocol init | 2, all landed | 2, all pass | PASS |
| Flow B (custom launch with rules) | 18, all landed; 1 negative transaction refused on-chain with `RuleDenied`, as expected | 17: 16 pass, 1 recorded as failed (below) | PASS after the resumed run |
| Flow A (Quick launch, through graduation and buyback) | 34, all landed | 17, all pass | PASS |
| `40-verify` (both mints) | | 6, all pass | PASS |

In Flow B, the check "mint metadata = attested record" was recorded as failed at 12:51:51 and as passed when the resumed run checked it again at 12:54:39. Both records show the same values (name "Phalanx Devnet B", symbol "PXDB", empty uri, mint 406 bytes).

Flow A's checks include: the curve completed and DBC revoked the hook; migration created the expected DAMM v2 pool; `distribute` paid the autopilot treasury (7,477,574 lamports of wSOL); the autopilot bound to the DAMM v2 pool; `update_price`, the wait and a buyback ran; every token the buyback bought (24,824,212,940 base units) was burned in the same transaction.

## Live run on devnet (13:16 to 13:50)

| Phase | Transactions | Checks | Result |
|---|---:|---:|---|
| Pre-flight (read-only) | | 41, all pass | PASS |
| Protocol init | 2, all landed | 2, all pass | PASS |
| Flow B, run 1 (13:28 to 13:32) | 16, all landed; 1 negative transaction recorded as failed (below) | 12: 11 pass, 1 recorded as failed (below) | see below |
| Flow B, run 2 (13:34 to 13:35) | 4, all landed; 1 negative transaction refused on-chain with `RuleDenied`, as expected | 9, all pass | PASS |
| Flow A, up to the graduation buy (13:36 to 13:50) | 20, all landed | 11, all pass | PASS; stopped on purpose before graduation (the reserve rule) |
| `40-verify` (both mints) | | 6, all pass | PASS |

In Flow B's run 1, the 2,000-token transfer that the launch rule must refuse did land on-chain refused with `RuleDenied`, but the script could not find its signature. So it recorded that transaction and the `RuleDenied` check as failed. After the script was fixed, run 2 sent a second refused transfer inside the guard and recorded both as passed.

Flow A's `create_launch` is not in the records: the first attempt was stopped by a rate-limit error ("429 Too Many Requests") after sending it, and the resumed run found the launch already created and continued at `publish_metadata`.

The full records are kept by the maintainers.
