# Devnet deployment and end-to-end tests

Status on 2026-10-12, 14:51 local. Noised runs on Solana devnet (test SOL only):
- **Deployed and verified:** the hook, launchpad, autopilot and vault programs.
- **Not deployed:** the shield program (the budget rule allows it only with 1.77 SOL or more left over).
- **Protocol initialized:** treasury `8LgGRG…` (a wSOL vault of `noised_vault`), platform fee 1000 bps.
- **Live end-to-end tests:**
  - **Flow B** (custom launch with rules): PASS, in full. Not every check passed the first time: in the live run, run 1 recorded two checks as failed because the script lost a refused transaction's signature (fixed; run 2 passed), and in the rehearsal the metadata check failed once before passing (both below).
  - **Flow A** (Quick launch, fees back into the token): PASS up to the graduation buy. It stopped there on purpose: graduation needs about 1.15 SOL in the test wallets, and the deployer would have dropped below the 0.3 SOL reserve. It resumes after a top-up of at least 0.47 SOL.
  - **`40-verify`**: PASS on both mints.
- **Rehearsed in full:** both flows, including Flow A's graduation, migration and buyback, also ran and passed on a local Surfpool fork of devnet (see the rehearsal section below).

The deployer `EeGcnw6yAjVC73QdjdtQDqoQgjxDpm2amLWzdoX1Kxvf` holds **0.985409105 SOL**.

## Deployed before the rename to Noised

Everything on this page was deployed and run while the project was still called Phalanx. The programs on devnet keep those binaries: the builds made before the rename (`phalanx_*.so`), with the same program ids as today's `noised_*` programs. The facts below describe what is on devnet, so they keep the earlier name where the chain or the recorded runs carry it:
- **Program bytes.** The SHA-256 values in the table below are those of the `phalanx_*.so` builds. A build of the renamed source is not byte-identical: the source paths compiled into the programs (`programs/noised-*/src/...`) changed, and so did the vault's payout memo. Instructions, discriminators, accounts, PDA seeds, errors, events and the signature domain tags are unchanged, so today's SDK, app and MCP server work with the deployed programs.
- **Payout memo.** The deployed vault writes the memo `phalanx-vault payout` before a payout to a memo-required account. A vault built from the renamed source writes `noised-vault payout`.
- **Test mints.** The two devnet test tokens are named "Phalanx Devnet A" (PXDA) and "Phalanx Devnet B" (PXDB) in their attested metadata. The flow scripts keep those names because a re-run rebuilds its plan from them.
- **Run state.** The live run's leaf ledger and tree cache (in the run state directory, outside the repo) were written by `@phalanx/sdk` under `phalanx/pq/...` keys. Today's SDK reads them through its migration: every leaf already used stays used, so resuming a flow stays safe.
- **Earlier names still accepted (one release).** The scripts read the `PHALANX_*` names of their environment variables when the `NOISED_*` one is unset. `deploy.ps1` and `00-preflight.mjs` fall back to a `phalanx_<program>.so` build, and `deploy.ps1` to a `.keys\phalanx_<program>-keypair.json` keypair, when no `noised_*` file is there.

## Programs on devnet

Each program was deployed from the final verified build made before the rename (the `phalanx_*.so` files of the final `scripts\test-all.ps1` run, PASS on 2026-10-11) with the keypair in `.keys/` (now `.keys/noised_*-keypair.json`, the same keys renamed). Each keypair's public key equals the program's `declare_id!`.

All four programs are upgradeable. The upgrade authority is the devnet deployer `EeGcnw6yAjVC73QdjdtQDqoQgjxDpm2amLWzdoX1Kxvf`, and `--max-len` is the exact `.so` size.

| Program | Program id | Data length | SHA-256 (local `.so` = on-chain dump) | ProgramData | Deploy transaction |
|---|---|---|---|---|---|
| `noised_hook` (built as `phalanx_hook.so`) | `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` | 214,984 | `5f71b6812c62301e86bb369acfdff70d57721f61330cd78f8c5a55e0db45e141` | `CPh2VRvpRG1Utp8kkPtxvsEM2kvyHeBJLdXojn33Jowx` | [5nMTMwbe…](https://explorer.solana.com/tx/5nMTMwbe9p85FbvpdbU3H9atLAqPEjkMQ6omQEgSGQ7P4ELxGiGp4Mr3i5FWYgQyX7eG35u3L2Um9U2D8Jkm9SJE?cluster=devnet) |
| `noised_autopilot` (built as `phalanx_autopilot.so`) | `D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx` | 402,032 | `46f3a4242ac4961bdbc7e24e4ec5e0bf17d25b925706468418c0b9cd386a61ea` | `CzC1TELZTPPUVYENqJbRGunsGJH8zegfKTsoda2RXcR8` | [4MTDKesb…](https://explorer.solana.com/tx/4MTDKesbMCQGhwWBqzBZcWzSUUudGc5oa3H9syN9gyDNYVcSFR2vbKn8p5jyNx5f4HTno7WLhcFQhqAKtKyDgmgn?cluster=devnet) |
| `noised_launchpad` (built as `phalanx_launchpad.so`) | `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc` | 846,896 | `b20d0a610db3f3e272e148719b645c6526cabad6bf63c0ad20d204a079f7fced` | `7F533qLZoXf4cEGnywZ4H4p2fkTUC7MkQghm8VwBzYnv` | [4kJFCA7Y…](https://explorer.solana.com/tx/4kJFCA7YfxM1R1F8Ek1mfnQpcP7iHk2Lnw6yqY1U28guEaEi4pUSW5jUwzvzkeFoVvKPMid7qriZT64anvJAXMW1?cluster=devnet) |
| `noised_vault` (built as `phalanx_vault.so`) | `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb` | 279,608 | `c3be1ece4893576f9bae8c94da5b6d7afa3338144148e90d76a4f7fcd3afb132` | `AXNGGsEypP6ocuiAkm3EMuABGGkFGL4F88cmG8A8dwS7` | [5gsngy6X…](https://explorer.solana.com/tx/5gsngy6XP8eGNQcwD7cZtbLxVrLXxMR9SXyjXzw3gVvSTmwUDHaRXA3MELeJvdjcfCYUpk4CWfRpYrNk824kYMYC?cluster=devnet) (slot 510,278,232) |
| `noised_shield` | `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9` | not deployed | `1104ae12e301dab66729be44ca12ce3490f7993bb27c5fb98ab5263dd58735de` (the `phalanx_shield.so` build) | | |

**How the deploys were verified.** `scripts/devnet/deploy.ps1` checked each one with `solana program show`: the authority is the deployer, and the data length equals the `.so` size. It then ran `solana program dump` and compared the SHA-256 of the dump with the local file: they match. `scripts/devnet/00-preflight.mjs` re-checks the same three facts from chain data; it passed for all four programs after the vault deploy.

**Deploy hiccup (hook only).** The first hook attempt used `--use-rpc`. The public devnet RPC rate-limited the buffer writes ("Max retries exceeded"). The script keeps its buffer keypair, so re-running it without `--use-rpc` resumed the same buffer. Nothing was lost. The vault deployed in one go. No buffers are left open.

### SOL spent

The deployer started with 10 SOL and now holds **0.985409105 SOL**. The 9.014590895 SOL spent splits into:

| What | SOL |
|---|---|
| Hook, autopilot, launchpad deploys (first session) | 7.449503436 (rent 7.44180884, fees 0.007694596) |
| Vault deploy | 1.423601482 (rent 1.42212060: program data 1.42128748 + program account 0.00083312; fees 0.001480882) |
| `10-init-protocol` | 0.003906360 |
| `30-flow-b` (two runs) | 0.056510603 |
| `20-flow-a`, up to the graduation stop | 0.081069014 |

So 8.86392944 SOL is rent locked in the four programs. The rest is protocol and launch rent, the small test buys, and fees.

Step-by-step rows are in the deploy script's `ledger.md`. The test wallets' balances after every phase are in the live run's `ledger.md`. Both are kept by the maintainers, outside the repo. Two devnet airdrops were attempted in total, one per session; both were refused by the rate limit and not retried.

## Pre-flight (read-only, no SOL spent)

`node scripts/devnet/00-preflight.mjs`: every check passes.
- **Network.** The genesis hash is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, devnet's.
- **External programs.** Meteora DBC `dbcij3LW…`, DAMM v2 `cpamdpZC…`, Token-2022, SPL Token, ATA and Memo v2 all exist and are executable.
- **DAMM v2 configs.** All seven pinned configs exist on devnet (`DAMM_V2_MIGRATION_CONFIGS` for fee options 0 to 5, plus the customizable one). Each is owned by DAMM v2, is 328 bytes, and is byte-identical to its mainnet fixture.
- **Other accounts.** The wSOL mint is fine. DBC's pool authority `FhVo3mqL…` holds a 99 SOL float, which DBC lends rent from during migration.
- **Runtime features.** SBPF v3 deployment is active, and so is SIMD-0385 v1 transactions (which attestations, approvals and vault withdrawals use).
- **Our programs.** Hook, launchpad, autopilot and vault: the on-chain bytes equal the local build. The shield is not deployed.
- **No address problems.** The launchpad pins no mainnet-only address that is missing on devnet.

### How devnet differs from the mainnet fixtures

Devnet runs newer Meteora and Token-2022 builds than the fixtures:

| Program | Devnet build (data length, dump SHA-256) | Mainnet fixture tested against |
|---|---|---|
| DBC | 1,983,568 bytes, `5edf76d9…`, deployed in slot 508,712,305. Adds a `CreateConfig2` instruction (OPERATIONS.md calls it a 0.2.2 pre-release). | 2,326,577 bytes, `4c26a8a5…` |
| DAMM v2 | 1,559,448 bytes, `82bb9375…`. Same 38 instructions. | 2,174,352 bytes, `4d5b920b…` |
| Token-2022 | 711,008 bytes, `b781b71d…` | 1,382,016 bytes, `0999dbf7…` |
| SPL Token, ATA | Identical | |

Meteora's devnet upgrade authority is a single key, `DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX`.

The whole LiteSVM suite was re-run with these devnet binaries as fixtures (`NOISED_FIXTURES_DIR` pointed at a directory of devnet dumps). Everything passes: launchpad 84 tests, autopilot 36, integration 113 ([recorded results](evidence/2026-10-12-devnet-run.md)).

## Live run on devnet (2026-10-12)

All state, secrets and logs are in the run state directory, kept by the maintainers outside the repo (`results.jsonl` holds every transaction and check; `console-*.log` the full output). A summary of the recorded results is in [evidence/2026-10-12-devnet-run.md](evidence/2026-10-12-devnet-run.md). Fork compute units are from the Surfpool rehearsal, for comparison.

### Protocol init: PASS

| Step | Compute units | Fork | Transaction |
|---|---|---|---|
| `open_vault` (treasury, wSOL) | 30,642 | 33,648 | [2KZnNNmA…](https://explorer.solana.com/tx/2KZnNNmAHZe4P4GcUZcPRoKtzTvJtaRe2E7PQmVPhBCabn5Anxv32xuvCDxf6racZgHdidivmWWadDvofsgKdG2R?cluster=devnet) |
| `initialize_protocol(1000)`, by the upgrade authority | 10,924 | 10,924 | [2pSiBt7Y…](https://explorer.solana.com/tx/2pSiBt7YX4pnqoM2gRou9PTqStrtT7JMiD9BpVFb9ycRGark62RREeFmXvXVRWbRxSCKHXFgckxLkGNi4WSKvuXc?cluster=devnet) |

What was set, read back from the chain:
- **`Protocol`** `BTiVRCENNQB8wnDCbAAoufHX3EgDKG9AioTu3BiDKc5M` (owner: the launchpad, 44 bytes): version 1, bump 254, treasury `8LgGRGoK3SxtV9yosGr5G3S61ibfgrvdHaYoTYnBFgHH`, `platform_fee_bps` 1000. There is no update instruction, so these values are final for this devnet deployment.
- **Treasury vault** `8LgGRGoK…` (owner: `noised_vault`, 174 bytes): version 4, mint wSOL, sequence 0, token program SPL Token, token account `6ErXXcTq2Az6rfPmmLDci3U2qwRHobpE3UPFX3QMUuAC`, balance 0. Its genesis key comes from the devnet test treasury phrase (`live\secrets\treasury-phrase.txt`), account 0.
- **Cost.** 0.00390636 SOL: rent 0.00153416 (vault) + 0.00148844 (token account) + 0.00087376 (`Protocol`), plus 0.00001 fees.

### Flow B, custom launch with rules: PASS

- **Mint:** [`4QQ2L5ptTtrGyMqPbQ7DSiEmD58GPHKvpRcJDdbVos73`](https://explorer.solana.com/address/4QQ2L5ptTtrGyMqPbQ7DSiEmD58GPHKvpRcJDdbVos73?cluster=devnet) ("Phalanx Devnet B", PXDB).
- **Accounts:** launch `6WTwQU74W6Gw6TKxmhMGS6144vbYig3QttwQ4wEvD8gq`, TokenMeta record `2LnzFaLA2v7ivtk1bxLLyGqDAQ1K1DVraxCvS1DMef3N`, LaunchRules record `C3k1TGvhbqhxahvuax3nm5125m4UXEA3RoH9TgQL4pDn`.
- **Rules** (PXR1, 62 bytes): `always: deny when p2p and amount > 1000 tokens code P2P`, with a 30-minute guard.

| Step | Compute units | Fork | Transaction |
|---|---|---|---|
| fund creator (0.15 SOL) and keeper (0.04 SOL) | 150 each | | [3XUXk8ix…](https://explorer.solana.com/tx/3XUXk8ixTRjXCmrfvLBcodQMhj1FproXiBzud93L5XMgmFyBJzNmTfRg9BNNGZEcBgmabLbvK8piQo5K43eqjAEZ?cluster=devnet), [2VTjcox1…](https://explorer.solana.com/tx/2VTjcox12XAy7duEL6wqeUpt5sXDn651rDnww5yhnjqxNRXN5RwysqrCmnXWkjyKQd64oaYXgnrq5ickDCiZCSo7?cluster=devnet) |
| `create_launch` (legacy, 801 B) | 64,740 | 55,740 | [5UmXpmzv…](https://explorer.solana.com/tx/5UmXpmzvdaMBrtbNnvS5MurzDYzXPoQd3dNjyoEdZwR8Hi3Ax88iWYuaTs1McFAqV4CvTuDbkcSoJk2ZNhCttitm?cluster=devnet) |
| fund the throwaway payer | 150 | | [ExRFyvoM…](https://explorer.solana.com/tx/ExRFyvoMrNcYcivvBGrRWRHzFMXudd6KdyAuk1ymKeEdxK6jq5pjY17CgCrohcvjg4fDoL3DqP4sQR2tij4oxqH?cluster=devnet) |
| `publish_metadata` (v1, 1,006 B) | 14,115 | 17,115 | [4S1PVgrq…](https://explorer.solana.com/tx/4S1PVgrqGtQzphHi83HHeaD5zAb34YyMYFHkDf6NRgA4urZGXDuU2sj72kVG2BzKU8msxTyyB16mis51caZVeSdL?cluster=devnet) |
| `publish_rules` (v1) | 13,149 | 10,149 | [3MH1N22r…](https://explorer.solana.com/tx/3MH1N22rsAHssJXriXZsmTM8X4LcfcjWiJf6NaML5TcBqVA4KZgoXt6wStgHP6KCVzGaUkNLPvYzMQ3mo3GAAQgV?cluster=devnet) |
| `attest_launch` (v3 with rules hash; v1, 3,037 B) | 109,995 | 114,366 | [gZoGpoKG…](https://explorer.solana.com/tx/gZoGpoKGM5NVfSiFNtg8w8jX1iKzuQg6AP3QMEUJt6m5t1AsNhJHZamuiaJU6JZ4Rm9XYBSwPfBJzbHx72VdVYP?cluster=devnet) |
| `launch`, sent by a keeper key (legacy, 1,008 B) | 153,591 | 150,892 | [58FxerCm…](https://explorer.solana.com/tx/58FxerCmWf9poVawe3vXgoQhQeGwQUfUBJkpZES4rhaXVbR8PQAXTBS4qdYZ2FBPYR3DBAWdv89CtLt4YATJv5mc?cluster=devnet) |
| `commit` 0.003 SOL | 59,393 | 53,405 | [555mpmYt…](https://explorer.solana.com/tx/555mpmYtVKZUeVy9bEHd523mHMU99oXs9Yg4KPHRHZiX7svvpaisg97guX1NJqxpe43WkBLkAYu334QCdXCLPnHF?cluster=devnet) |
| `execute_batch` (keeper) | 149,738 | 144,370 | [97nhtave…](https://explorer.solana.com/tx/97nhtaveNKD7E36L7cMZqMqzrqoHEwWXiZ6jGuPyaGZYBwbzRA8EiNHiugJ3HP7UxAi4J85ska4HeFzUY4owyyC?cluster=devnet) |
| `claim` | 95,006 | 83,638 | [4WCDqzyb…](https://explorer.solana.com/tx/4WCDqzybzQJBiDe5Ucy5BYWwchMEhtFZAqiYjZc3ZkJSwTPZ2ErdRfwLBA1yHQe4aP5XrhQhppA7NKyE1CJoKBVv?cluster=devnet) |
| the keeper's token account | 18,672 | | [5s5APVKx…](https://explorer.solana.com/tx/5s5APVKx1WXcvpMPe45GGdBqnRyCcpLgg1uwjuARfFYztivTbUQkBAj4EdP2rqeSsFu9xuzPEse1xkcv13D4E9HQ?cluster=devnet) |
| 2,000-token wallet-to-wallet transfer: **refused on-chain, `RuleDenied` (6011)** | 22,865 | 21,371 | [64CuNFUp…](https://explorer.solana.com/tx/64CuNFUpgHg5VbCcK9JaYVhvD9pPkGtjYo4bWx5ww3MdsEHC723R6jHgGwRXTAGrbtVhnKVVJXpVjwT2yM2qvKeo?cluster=devnet) (run 1), [3WS69MrP…](https://explorer.solana.com/tx/3WS69MrPDTQmLNBuaSvRhZbXPeSkFZeZdKMpoAv6PhTW1Jp8x5RAvWgR4XfNy1HHTQNNh4gfr4Z4g62phASmZV7c?cluster=devnet) (run 2) |
| 500-token transfer (passes) | 21,036 | 19,542 | [5uGvC7Jh…](https://explorer.solana.com/tx/5uGvC7JhBbodGHQPxu6oCw77ySQjFneApfnyC3VLHkHTAh7f9JnyY8Po4z7tT4vGdE125dNkTTayLbqNHh9mpsXU?cluster=devnet) |
| DBC sell of half the tokens, same wallet (passes) | 76,642 | 73,406 | [4DKaWG5r…](https://explorer.solana.com/tx/4DKaWG5rx8CxB8nRkff1RovXUJdNHSaeaU4WpMiestAL3LcxU9Mq4puhMJt2x3EKThsQYQ8rKYSQ4bJLhmrf5VBq?cluster=devnet) |
| sweeps back to the deployer, run 1 | 150 each | | [3ytaD5oT…](https://explorer.solana.com/tx/3ytaD5oT4Luc72zoZNA5C6BqakE899TXEogwVPY4cTjvPk6RRc2WBKSo9KstPfA6paRydW9iiwZbUKddpDH4kgU1?cluster=devnet), [3N6Mk1NG…](https://explorer.solana.com/tx/3N6Mk1NG1jiZ8jZ2MSfaGajrAuL5bFARCHhh2anQ9bSbLt2TKstyCzAjYavWxrC5DuY9citkUmdvu6b7ShDwwqoK?cluster=devnet) |
| run 2: fund creator (0.02 SOL) and keeper | 150 each | | [4qQ2oVKb…](https://explorer.solana.com/tx/4qQ2oVKbSU8F9bL3qz3rfJRcoT9j45B6NXN9iphWNrkfmRdQHTxeCAK9jkDJ29aPbip38v9a3byeVfEqFPf7jLKU?cluster=devnet), [xiJTcG1D…](https://explorer.solana.com/tx/xiJTcG1Dy9NvP1ud9CjJu9UcUBStaH53Vp7VomscTYxyqXMcoPkq6y83D7xJAchXR4WhPtM3bxUTXmZriBzedxp?cluster=devnet) |
| run 2: sweeps back | 150 each | | [48bKxjwD…](https://explorer.solana.com/tx/48bKxjwD6K8Ac9be8z6xrZ8MY34YZfQ6wz9h3oDcV1LCQyaA9uzXdCkUt2BQyPboER8R4hcjygoY39Uf21ASyHdr?cluster=devnet), [ZUckiDB7…](https://explorer.solana.com/tx/ZUckiDB7r5H7kxZ5EKwzfhabueEPb2u53ESd9vLWUVqL24pE1jC8jMBXcHA3JNQaaJJeWy3ZjFRM8fMmkq8aScx?cluster=devnet) |

What was checked:
- **Certificate.** Version 4, with `checks = 8191` (all twelve checks plus RULES_BOUND). Initial supply 12,776,332,094,497 base units.
- **Hook policy.** It holds exactly the attested 62 rules bytes. The attestation (v3) carries the rules hash `b92b1a1e090f29a0…`.
- **Mint metadata.** It equals the attested record.
- **Snipe shield.** `execute_batch` ended it. The batch spent 0.003 SOL for 98,226,475,674 base units.
- **The rule refuses.** The 2,000-token transfer was refused in simulation, then sent without preflight and failed on-chain with `InstructionError [0, Custom 6011]`. The log says "Launch rule 0 (code 7) refused the transfer … Error Code: RuleDenied".
- **The rule is specific.** The 500-token transfer passed.
- **Sells are never blocked.** The same wallet's DBC sell passed. It also confirms the SDK's `buildSwapTx` DBC fix under plain Node (no workaround loaded).
- **Run 2.** In run 1 the refused transfer landed, but the script could not find its signature, so it recorded two failed checks (see "Differences from the rehearsal"). After the fix, run 2 sent a second refused transfer inside the guard and recorded it: PASS.
- **Cost.** 0.056510603 SOL. Run 1 cost 0.056485603: `create_launch` 0.01000752, publish + rules + attest 0.02209768, `launch` 0.01529064, `commit` 0.00589044 (including the 0.003 SOL batch buy), execute + claim 0.00308848, keeper token account and transfers 0.00154424, the DBC sell returned 0.00145340, and fees. Run 2 cost 0.000025.

### Flow A, Quick launch with fees "back into the token": PASS up to the graduation buy (stopped by the reserve)

- **Mint:** [`FpV8CpGZ5bXR1iZ6Gn7UdmYs3UBGjTaBbMUuFVCXPgBB`](https://explorer.solana.com/address/FpV8CpGZ5bXR1iZ6Gn7UdmYs3UBGjTaBbMUuFVCXPgBB?cluster=devnet) ("Phalanx Devnet A", PXDA).
- **Accounts:** launch `7X9jy8rQkkQvWYbLYLTfzYn8FoFs7Y7rE4MGLbkYk6TS`, autopilot `6SiouAcwS49hgGRZiG21X6cxqmWkt3TY2DpeHjRuQi1y`, autopilot treasury `DP7k1RqtpPZm94GzgJ1KNPjL6qXiswWwf5UAJ9t7sz2g`, TokenMeta record `FxSgEegFzr8zTJkrbWTz6Twsv2yKwzJxJk6J5rdcjfiq`.

Setup:
- **Plan.** `planQuickLaunch` with fee destination `buyback-burn`: 100% of the creator share goes to the autopilot treasury.
- **Graph.** The 122-byte graph runs a daily buyback-and-burn of up to 0.01 SOL, never more than 3% above the recent low, with a tip of at most 0.0001 SOL.
- **Parameters.** Threshold 1 SOL (`MIN_THRESHOLD`), fee option 2, a 60 s batch, a 660 s guard, max wallet 100 bps, max buy 50 bps.
- **A caveat.** The plan's summary text still says "graduates once buyers have put 85 SOL into it". The script overrides the threshold after `planQuickLaunch`, so the summary describes the default curve, not the 1 SOL one that was launched.

| Step | Compute units | Fork | Transaction |
|---|---|---|---|
| fund creator (0.2 SOL, stage 1) and keeper (0.08 SOL) | 150 each | | [4BiFApT1…](https://explorer.solana.com/tx/4BiFApT1qkYunfdzgLHAWpg8sbCCd1rL81oGxZKNrTUPYkWxwJ2JJK63pr4gyW17agY4YF6FfoJYfsUZkc6oSqAG?cluster=devnet), [54uJsUN5…](https://explorer.solana.com/tx/54uJsUN5Hmj6dSDSSbad1AJkv22oLhfQygkRN6WJjbryb14Gd2Kzme5RCz1tgbkfM5KCs3cjLP72bo3f6Y9CgwZj?cluster=devnet) |
| `create_launch` | 55,746 | 61,746 | [zCXZVyK6…](https://explorer.solana.com/tx/zCXZVyK6uTMSVsWqEUed4Bmb6yrMHHZRCg78dt1A1C4TuU4vmRqTW1AzxbCYR4JGLcXFjPJMdsmnpArhSXgcHJ9?cluster=devnet) |
| fund the throwaway payer | 150 | | [3bajBTcc…](https://explorer.solana.com/tx/3bajBTccBBr3HNcZGDrA7WBMCcDsAUhUhhYtgCaX2iAfcVFJKDtJ1eBR4eBsn2JguvYQDkoS9edWrBt44pKUobuP?cluster=devnet) |
| `publish_metadata` (v1, 1,013 B) | 17,215 | 21,715 | [2gmCYLCK…](https://explorer.solana.com/tx/2gmCYLCKdyu6Wei25CQG8MQHoCbRmgYJaTuu6NBHcGscpzoXBwMYphZCtAWV8VtJqosBYd3pUfBaisD53JaYVhYn?cluster=devnet) |
| `attest_launch` (v3; v1, 3,005 B) | 103,910 | 104,879 | [268VvYVH…](https://explorer.solana.com/tx/268VvYVHY515CSRsbZNtYSgtwKFdaZGpR55ar7QtX83ipxgM7cHzPzUA2rW1RcJeUH5pjovx3Uwsv2Rczo9BRiSt?cluster=devnet) |
| `init_autopilot` | 47,303 | 63,809 | [4otQ8KKw…](https://explorer.solana.com/tx/4otQ8KKwKBCRgjqg3tc5rQhXnAKDELRrcp88fRut2wQBWCL4Eg8c6DWvPmpE8LbCs1F98nfZChVXDnvwTd7c3Lzo?cluster=devnet) |
| `publish_graph` (122 B, legacy) | 10,980 | 9,480 | [5jyMSt1J…](https://explorer.solana.com/tx/5jyMSt1J8TeE6CQyXuh89rw4vcja4K6gqzrYYks8R8YmmdTu3dvt3rqKhqqpCJ6ERbSXWc5EcF8Wq6dD4t47xoBp?cluster=devnet) |
| `pq_authorize` kind 1, signed with the quantum key (v1, 2,924 B) | 86,459 | 100,502 | [21roZ9Ym…](https://explorer.solana.com/tx/21roZ9YnmfqqMk4iDqDp62arVR4q9EqGxKvEn5pi9pkUbasFG7iBY9Yd7b1Juuk3WKGcmTuHzieURYtzfZpeBo2G?cluster=devnet) |
| `activate` | 16,205 | 16,205 | [7BTtb8nK…](https://explorer.solana.com/tx/7BTtb8nKNBQMgN18sx4FbjPC27wfxTYGzCzw7nSsdyDJMuUZtxn1ZYYSaQRVJjWLQqKx1vzpo7jFLGP3Q8kHruK?cluster=devnet) |
| `apply_pending` | 13,317 | 13,317 | [BZZ5q76t…](https://explorer.solana.com/tx/BZZ5q76txiU9CyghFQKT9udCjLCaVhXpu4XD1i7g9xMPg9jFa6NxZ9Das1zzmXc8YSwE4JUHGfaWfeJsQhx5cZF?cluster=devnet) |
| sweep the throwaway payer | 150 | | [5XM1TAJj…](https://explorer.solana.com/tx/5XM1TAJjwU8uRWyR9jb23afVd2dTHk7X3boG4P92coJE8Aez9ZByTY9xyT4FFHysAkzBGQBUDctndGkSTMDBXGmh?cluster=devnet) |
| `launch` (keeper, legacy, 976 B) | 154,022 | 154,323 | [JWrZVynJ…](https://explorer.solana.com/tx/JWrZVynJBoq7HhG8wC4kUaJNWSdJFe2BBeCAdzWxtCYT9MzYDD6yg4iAHBGeq6bS48JvM9QKbSdU2MTk5z2CQDr?cluster=devnet) |
| `bind_mint` | 42,722 | 46,348 | [5vMoS8wp…](https://explorer.solana.com/tx/5vMoS8wpxc9eSX35PWodmteXRem7ykhQxaPth6NUVoVjMuKAPkjStwqfkBMSEN6PX88vY2izYH4jC8c7jypqr6QT?cluster=devnet) |
| `commit` 0.003 SOL | 63,895 | 54,907 | [2Qojv5nz…](https://explorer.solana.com/tx/2Qojv5nzVqXnJiDxUEjfFzPimo7kmW2DeHu5GFJYdisXMtZKKLpNgu4Pj1WUBvFyztuwR94KZWEywVuWm5K2grpR?cluster=devnet) |
| `execute_batch` (keeper) | 152,484 | 154,616 | [4kLqeRy9…](https://explorer.solana.com/tx/4kLqeRy9NTarg19RTZFdNiP8zGHnZAJm33QWMw6AUFAUALrjMwWpPMrj4f6WZPEpesg3Fp3VqEKnDp78cc4ifSJA?cluster=devnet) |
| `claim` | 87,392 | 92,524 | [5jKTPMhC…](https://explorer.solana.com/tx/5jKTPMhCXNHnpivgf2tWeGjSRDwvEYzVJg82DiATwZYtHGGz8VCjNkjJjKPaaFiJLrzHvr7uLkJAzQh792VNAN8C?cluster=devnet) |
| DBC buy 0.001 SOL during the guard (keeper) | 99,876 | 105,014 | [23jH3SJi…](https://explorer.solana.com/tx/23jH3SJijEXaL1cbb4DPMaSPAdm9t9FwGQEsXHspgLN4ofTvPZUzSsegSjTHfzu3NYrrwzHnSFiTgL63bs4BvHoD?cluster=devnet) |
| DBC sell of half during the guard (keeper) | 76,641 | 79,366 | [Uu3dnRDs…](https://explorer.solana.com/tx/Uu3dnRDs1r9vfwZCxT8xBwcP71LBB4U7FH4MRYzdS8H2xPBpehsGzMMh7HhFGKQ7BhMC6xjATMHVfvXtDkcovX6?cluster=devnet) |
| sweeps back to the deployer (paused before graduation) | 150 each | | [4A4W7AZn…](https://explorer.solana.com/tx/4A4W7AZn9fcxQGaBNsG9TZTb9VTAuTzDyA1PVNZ6DnqR7cpe51vYLrbSJSdDr1YdmeBQWn1jZdAve5qPMQnbQgE4?cluster=devnet), [5B6TEDNF…](https://explorer.solana.com/tx/5B6TEDNFABgVs2XArxXEi7Qn4SvV22sjb1caCTr4bsUNyjKXAbcymx8P9ewBxwmdLBezVqbfLZEnCARU2dayrKw3?cluster=devnet) |

What was checked:
- **Certificate.** Version 4, `checks = 4095`. The hook policy has no rules.
- **Autopilot.** It runs the quick-launch graph. The active graph is `70feac4c81465afe…`, approved with the creator identity's quantum key (`pq_authorize` kind 1), activated at 1791812895. The active authorization is `ByMimp6bUfK6YWYZ1KPc1zfFgEnCGUJV6kW1JCAaeWza`. After `launch`, `bind_mint` bound it to the mint.
- **Snipe shield.** `execute_batch` ended it. The batch spent 0.003 SOL for 98,226,475,674 base units.
- **Guard-time trades.** A fresh wallet bought 0.001 SOL on DBC within max-buy and max-wallet, then sold half. Both swaps were built by the fixed SDK under plain Node.
- **Cost so far.** 0.081069014 SOL: creator 0.06247052 (`create_launch` 0.01000752; publish, attest and the autopilot setup 0.04348408; `bind_mint` and `commit` 0.00743468; `claim` 0.00154424), keeper 0.01857849 (`launch`, `execute_batch`, the guard trades), and 0.00002 of fund and sweep fees.

**Where it stopped.** Before the graduation buy, the script compares what graduation needs with what the deployer can give while keeping the reserve:
- **The curve.** Its quote reserve was 3,464,345 of 1,000,000,000 lamports, so 0.996535655 SOL was missing.
- **The graduation buy.** It would put in 1.028431724 SOL.
- **The funding.** Topping the creator up to 1.088431724 SOL (buy, migration, buyback donation) and the keeper to 0.06 SOL needed 0.950902244 SOL. The deployer held 0.786468119.
- **The result.** The deployer would have ended at −0.164 SOL, below the 0.3 reserve. So the flow stopped and swept the test wallets back; their test tokens stay in their token accounts.
- **What was not run on devnet.** The graduation buy, `migration_damm_v2`, `claim_fees`, `claim_surplus`, the DAMM v2 trades, `claim_lp_fees`, `distribute` to the autopilot treasury, `bind_pool`, `update_price`, the 60 s wait and the buyback. All of them passed on the fork (below).

### `40-verify`: PASS on both mints

- **`checkQsl1`.** "QSL-1 candidate: not final yet", level 0 (would be level 2). The only blocking conditions are `cluster` (devnet) and `C1.24` (the programs are not final).
- **Programmable tag.** Present and verified on both mints.
  - Mint B shows its rules: P.R1 to P.R4 pass, with the warning `transferLimits`.
  - Mint A shows the automation: P.G1 to P.G4 pass. P.G5 ("the autopilot program can no longer be changed") fails because the autopilot is upgradeable on devnet, the same as in the rehearsal. Its warnings are `notFrozen` and `autopilotUpgradeable`.
- **`verifyLaunch`.** Phase "guarded", 35 checks, no failing check. The only warnings are the upgradeable programs: launchpad, hook, Meteora DBC, DAMM v2 and Token-2022. PQ origin, metadata and rules are all verified.

### Differences from the Surfpool rehearsal

- **The public devnet RPC rate-limits hard.** Many requests got "429 Too Many Requests", and web3.js retried them; websocket subscriptions got 429s as well.
  - Once, "429 … Connection rate limits exceeded" was thrown from a request nobody awaited, which killed Flow A's first attempt. `create_launch` had already landed, and the resumed run picked up at `publish_metadata`.
  - `lib.mjs` now retries rate-limited requests with a longer backoff in live mode too.
- **Refused transactions must be found by signature.** On devnet, `sdk.sendAndConfirm` rejected the skip-preflight refused transfer with a plain object, not an Error. On Surfpool it threw "transaction … failed".
  - Run 1 of Flow B therefore lost the signature and recorded two failed checks, although the refused transfer did land with `RuleDenied` (`64CuNFUp…`).
  - `lib.mjs` now takes the signature from the signed transaction before sending, and looks the transaction up on chain.
- **Compute units differ by up to about 16k** in both directions, because PDA bump searches depend on the random launch seeds and keys. For example: `create_launch` 64,740 (B) and 55,746 (A) against 55,740 and 61,746 on the fork; `init_autopilot` 47,303 against 63,809; `pq_authorize` 86,459 against 100,502; `claim` (B) 95,006 against 83,638. Every step stays inside the SDK's compute budgets.
- **Rent is lower on devnet** (5,080 lamports per byte against 6,960 on the fork). For example, Flow B's `create_launch` cost the creator 0.01000752 SOL against 0.01370924 on the fork, and publish + attest 0.02209768 against 0.03026816.
- **Graduation, migration, fees and the buyback were not reached** on devnet (budget). The fork remains the only run of those steps.

## Rehearsal on a Surfpool fork of devnet (no devnet SOL spent)

Surfpool 1.6.0 forked devnet, fetching accounts lazily from `api.devnet.solana.com`. It runs our three deployed programs, devnet's Meteora and Token-2022 programs, and the real DAMM v2 configs.

`noised_vault` (the same verified `phalanx_vault.so` build) was deployed only on the fork. The scripts below then ran unchanged, with `RPC_URL=http://127.0.0.1:8899` and `PHALANX_REHEARSAL=1` (now `NOISED_REHEARSAL=1`). Results and logs (`results.jsonl`, `console-*.log`, `ledger.md`) are kept by the maintainers in a separate run state directory; [evidence/2026-10-12-devnet-run.md](evidence/2026-10-12-devnet-run.md) summarizes them.

Fork transactions are not on devnet, so they have no explorer links.

**Protocol init: PASS.** `open_vault` (treasury `BvDB7a…`) 33,648 compute units; `initialize_protocol(1000)` 10,924. The `Protocol` account checked out: the right treasury, `platform_fee_bps` 1000, version 1.

**Flow B, custom launch with rules: PASS, after one failed check.** The same rules and checks as the live run above (fork compute units are in its table): certificate `checks = 8191`, the hook policy holds the rules, `RuleDenied` (6011) on the 2,000-token transfer, the 500-token transfer and the sell pass. One check did not pass the first time: "mint metadata = attested record" was recorded as **failed** at 12:51:51 (UTC) and as passed when the resumed run checked it again at 12:54:39. Both records show the same values (name "Phalanx Devnet B", symbol "PXDB", empty uri, mint 406 bytes), and the recorded results do not say why the first check failed ([recorded results](evidence/2026-10-12-devnet-run.md)). Of the rehearsal's 17 Flow B checks, 16 passed the first time.

**Flow A, Quick launch with fees "back into the token": PASS, through graduation and buyback.** The steps up to the guard-time trades are in the live table above. The rest ran only on the fork:

| Step | Compute units | Size |
|---|---|---|
| DBC buy to graduation, PartialFill, 1.028 SOL in | 92,659 | |
| `migration_damm_v2`, sent by us | 147,934 | v1, 1,080 B |
| `claim_fees` | 75,197 | |
| `claim_surplus` | 41,867 | |
| DAMM v2 buy | 42,351 | |
| DAMM v2 sell | 41,396 | |
| `claim_lp_fees` | 40,684 | |
| `distribute` | 28,975 | |
| `bind_pool` | 13,174 | |
| `update_price` | 11,934 | |
| buyback `run` | 82,511 | |

What was checked:
- **Certificate.** Version 4, `checks = 4095`.
- **Graduation.** The curve completed and DBC revoked the hook. Migration created exactly the expected DAMM v2 pool `9WYMej…`.
- **Fees.** `distribute` split them 90% to the autopilot treasury (7,477,574 lamports) and 10% to the protocol treasury vault (830,841 lamports).
- **Buyback.** The keeper ran `update_price`, waited 60 s on the cluster clock, then ran the buyback node. The `NodeRan` event: spent 0.01 SOL, bought 24,824,212,940 base units, burned the same amount, tip 100,000 lamports.
- **Burn.** Mint supply fell by exactly the amount bought, and the treasury's token balance stayed at 0.

The treasury got a 0.0045 SOL wSOL donation so that one full 0.01 SOL buyback could run, because devnet fee income is tiny.

**`checkQsl1` and `verifyLaunch` on both mints** gave the same results as the live `40-verify` above.

### Things the rehearsal found

- **SDK 0.9.0 bug in plain Node.js: fixed.** `buildSwapTx` broke on the DBC path with "BN is not a constructor": it did `const { BN } = await import("@coral-xyz/anchor")`, and anchor 0.31.1 has no `exports` map, so Node loads its CommonJS build, where `BN` is only on the default export.
  - Vite and vitest resolve the ESM build, which is why the SDK tests and the app never hit this.
  - The SDK now does `const BN = anchor.BN ?? anchor.default?.BN` (`sdk/src/launch/swap.ts`). The scripts' module-hook workaround (`anchor-bn-hooks.mjs`, `anchor-bn-shim.mjs`) is removed.
  - Under plain Node, anchor's named `BN` is `undefined` and `default.BN` is the constructor. The live DBC swaps (Flow B's sell, Flow A's guard-time buy and sell) were all built this way, with no hook.
- **Rent per byte.** Devnet charges 5,080 lamports per byte (SIMD-0194 is active). LiteSVM and Surfpool charge 6,960. So rents on the fork, and in the LiteSVM suites, are about 37% higher than on devnet. Compute amounts from `getMinimumBalanceForRentExemption`, as the SDK does.
- **Compute units are close to LiteSVM's.** For example, `migration_damm_v2` took 147,934 on the fork against 149,537 in LiteSVM, `update_price` 11,934 against 12,773, `claim_fees` 75,197 against 79,779. `attest_launch` (104k to 114k) and `create_launch` (56k to 65k) fall in the same ranges on the fork and on devnet. Every measured step stays inside the SDK's compute budgets (`COMPUTE_UNITS`, `AUTOPILOT_COMPUTE_UNITS`).
- **Transaction sizes.** Every legacy transaction stays under 1,232 bytes. The DBC migration with both position slots is 1,080 bytes as a v1 transaction.
- **Surfpool quirks.**
  - Its lazy account fetches from the public devnet RPC sometimes fail ("Failed to fetch accounts from remote"). In rehearsal mode `lib.mjs` retries those requests; nothing is processed when it happens.
  - Surfpool signs with synthetic blockhashes, so fork transactions can never be replayed on devnet.
  - Use `--db <file>.sqlite` so a restart keeps the fork's state.

### Devnet cost: estimate and actual

| Step | Estimate (fork, scaled to devnet rent) | Actual on devnet |
|---|---|---|
| Deploy `noised_vault` | 1.424 SOL | **1.423601482** |
| `10-init-protocol.mjs` | 0.004 SOL | **0.003906360** |
| `30-flow-b.mjs` | 0.06 SOL (peak 0.19 in the test wallets) | **0.056510603** (peak 0.19) |
| `20-flow-a.mjs` up to graduation | about 0.1 SOL | **0.081069014** (peak 0.28) |
| `20-flow-a.mjs` from graduation to the end | about 0.25 SOL net; about 1.15 SOL sits in the test wallets for a while | not run yet |

The rest of Flow A costs about 0.25 SOL net, mostly the graduation buy: 1.03 SOL goes in, and selling the tokens back on DAMM v2 recovers about 0.78 SOL. Migration rent and fees make up the rest.

`noised_shield` costs 1.4672 SOL of rent plus fees.

## Next steps: finish Flow A, then the shield

Start from the current balance of 0.9854 SOL and keep the 0.3 SOL reserve.

**What each top-up allows:**
- **+0.47 SOL at least** (+0.6 for margin): finish Flow A. That is graduation, migration, fees, `distribute` to the autopilot treasury, `bind_pool`, `update_price`, the 60 s wait and the buyback, then `40-verify`. About 1.3 SOL would be left.
- **+1.05 SOL at least** (+1.2 recommended): all of the above, plus the shield deploy. The rule is a balance of 1.77 SOL or more after everything else.

**To resume Flow A** after a top-up, with the same environment as below:

```powershell
node scripts/devnet/20-flow-a.mjs   # resumes at the graduation buy (state-flow-a.json); stops again if the reserve would be crossed
node scripts/devnet/40-verify.mjs
```

**Commands.** In PowerShell, after `. $env:NOISED_ENV_SCRIPT` (optional: your toolchain env script with MSVC, Agave 4.3.0 and caches):

```powershell
$env:NOISED_DEVNET_DEPLOYER = '<path to the devnet deployer keypair, outside the repo>'
$env:NOISED_SBF_DIR         = '<dir with the verified noised_*.so builds>'  # on devnet: the phalanx_*.so builds
$env:NOISED_DEVNET_DIR      = '<run state dir, outside the repo>'   # buffers, logs, ledger.md of the deploy script
scripts\devnet\deploy.ps1 -Program noised_shield                # only when funded: about 1.47 SOL

$env:NOISED_DEVNET_DIR      = '<run state dir, outside the repo>'   # the live run's state and secrets
$env:NOISED_FIXTURES_DIR    = '<mainnet fixtures dir>'          # default: fixtures\ in the repo
node scripts/devnet/00-preflight.mjs                            # read-only
node scripts/devnet/10-init-protocol.mjs                        # done: reports the existing Protocol
node scripts/devnet/30-flow-b.mjs                               # done: re-running only re-verifies and sweeps
node scripts/devnet/20-flow-a.mjs                               # resumes at the graduation buy
node scripts/devnet/40-verify.mjs                               # checkQsl1 + verifyLaunch on the recorded mints
```

With `NOISED_SBF_DIR` pointed at the verified builds the other four programs came from, `deploy.ps1 -Program noised_shield` deploys the shield from `phalanx_shield.so`, the build made before the rename, like the other four programs. To deploy a build of the renamed source instead, point `NOISED_SBF_DIR` at a directory holding `noised_shield.so`.

**How the scripts behave:**
- **Resumable.** Every script saves its state in `NOISED_DEVNET_DIR` (`state-*.json`), so a re-run resumes.
- **Records everything.** Each transaction is written to `results.jsonl` with its explorer link, compute units and fee. Balances go to `ledger.md` after each phase.
- **Protects the reserve.** The scripts refuse any funding that would take the deployer below `NOISED_RESERVE_SOL` (default 0.3).
- **Funds Flow A in two stages.** First 0.2 SOL to the creator and 0.08 SOL to the keeper, enough for everything up to the guard-time trades. Right before the graduation buy, both are topped up to what graduation and the buyback need (about 1.09 and 0.06 SOL). If that would cross the reserve, the flow records exactly where it stopped, sweeps the test wallets back and exits; `FLOW_A_STOP_BEFORE_GRADUATION=1` forces the same stop.
- **Negative tests land on chain.** A transaction that must fail is simulated first, then sent without preflight. The script looks it up by the signature taken from the signed transaction, and checks the on-chain error.
- **Rate limits.** Rate-limited RPC requests ("429") are retried with a longer backoff.
- **Devnet only.** They refuse any RPC whose genesis hash is not devnet's.
- **Secrets stay outside the repo.** The devnet test phrases (`secrets/pq-phrase.txt` for the creator identity, `secrets/treasury-phrase.txt` for the protocol treasury) and the throwaway wallets are created on first use under `NOISED_DEVNET_DIR\secrets` and never printed. The leaf ledger is `leaf-ledger/`.
- **Migration.** On devnet, Flow A gives Meteora's migration keeper `MIGRATION_WAIT_SECS` (default 60) before sending `migration_damm_v2` itself.

**To rehearse first** (free):
1. Start `surfpool start --network devnet --no-tui --no-studio --no-deploy --airdrop-keypair-path <deployer> --db <file>.sqlite` (Surfpool 1.6.0 CLI).
2. Deploy any program missing on devnet to the fork with `solana program deploy … -u http://127.0.0.1:8899`.
3. Run the same scripts with `RPC_URL=http://127.0.0.1:8899`, `NOISED_REHEARSAL=1` and a separate `NOISED_DEVNET_DIR`.

## Files

| Path | What |
|---|---|
| `scripts/devnet/deploy.ps1` | Deploys one program (upgradeable, exact `--max-len`, resumable buffer, reserve check, seed-phrase redaction) and verifies it. |
| `scripts/devnet/00-preflight.mjs` | Read-only checks of devnet. |
| `scripts/devnet/10-init-protocol.mjs` | Treasury vault plus `initialize_protocol`. |
| `scripts/devnet/20-flow-a.mjs`, `30-flow-b.mjs` | The two end-to-end flows. |
| `scripts/devnet/40-verify.mjs` | Re-verifies the recorded mints. |
| `scripts/devnet/lib.mjs`, `launch-steps.mjs`, `verify-steps.mjs` | Shared helpers. |
| [evidence/2026-10-12-devnet-run.md](evidence/2026-10-12-devnet-run.md) | A summary of the recorded results: the LiteSVM suites with devnet fixtures, the rehearsal and the live run. |
| The deploy script's `NOISED_DEVNET_DIR` (outside the repo, kept by the maintainers) | `ledger.md` (every step's SOL), deploy logs, devnet dumps and fixtures, rehearsal state and logs. |
| The live run's `NOISED_DEVNET_DIR` (outside the repo, kept by the maintainers) | The live run: `results.jsonl`, `console-*.log`, `ledger.md`, `state-*.json`, secrets, leaf ledger. |
