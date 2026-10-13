# Operations

How to build, test, deploy, finalize, verify, monitor and respond to incidents. Commands marked *(verified)* were run on the Windows development machine between 2026-10-08 and 2026-10-11. Commands that need a network or keys were not run as part of writing this document; they are standard Solana CLI usage. Nothing is deployed on mainnet. Four programs (launchpad, hook, autopilot, vault) run on devnet since 2026-10-12, deployed fresh and still upgradeable ([DEVNET.md](DEVNET.md)); mainnet will be deployed fresh too, with no in-place upgrade over older account versions (a version-1 `HookPolicy`, a version-2 `Attestation`).

## Environments

| Environment | Use | Notes |
|---|---|---|
| Windows 11 development machine | Day-to-day builds, host tests, LiteSVM tests, frontend | Keep build output, caches and `node_modules` on a drive with enough free space (tens of GB). If you keep a toolchain env script (portable MSVC, the Agave 4.3.0 CLI, `CARGO_HOME`, `TEMP` and caches), point `NOISED_ENV_SCRIPT` at it and dot-source it in the same PowerShell call as any cargo, Solana, Anchor or pnpm command. `NOISED_BUILD_ROOT` is the base directory for build output (default: `target\` in the repository). Docker is not available. If you made `sdk\node_modules` or `app\node_modules` a link to another drive, do not delete it by hand. |
| Linux CI (canonical) | Release builds, verifiable builds, the full test matrix (`.github/workflows/ci.yml`) | Agave CLI 4.3.0, platform-tools v1.57, host Rust 1.98.0, Python 3 (standard library only), Node 22 + pnpm 11.8.0, Anchor CLI 1.2.1 for IDLs, Docker for `solana-verify` |

Pinned versions are in the root `Cargo.toml` (`=` pins), `Cargo.lock`, the lockfiles of the four LiteSVM workspaces (`tests/integration`, `programs/noised-launchpad/tests/litesvm`, `programs/noised-shield/tests/litesvm`, `programs/noised-autopilot/tests/litesvm`) and the pnpm lockfiles. The version matrix and its reasons are in [research/FACTS.md §5](research/FACTS.md).

## Build

All on-chain programs are built as **SBPF v3**. Once the SIMD-0500 feature gate activates, programs older than v3 can no longer be deployed, upgraded or **finalized** (FACTS #2). The bundled cargo-build-sbf 4.3.0 still defaults to v0, so pass `--arch v3` every time.

```powershell
. $env:NOISED_ENV_SCRIPT   # optional: your toolchain env script (MSVC, Agave 4.3.0, caches)
# Put build output on a drive with enough free space (tens of GB): set NOISED_BUILD_ROOT there.
$env:CARGO_TARGET_DIR = "$env:NOISED_BUILD_ROOT\target"   # or your own directory when other builds run in parallel
$env:CARGO_BUILD_JOBS = '4'
cargo-build-sbf --manifest-path programs/noised-hook/Cargo.toml --arch v3        # (verified, all five: ELF e_flags = 3)
cargo-build-sbf --manifest-path programs/noised-vault/Cargo.toml --arch v3
cargo-build-sbf --manifest-path programs/noised-launchpad/Cargo.toml --arch v3
cargo-build-sbf --manifest-path programs/noised-shield/Cargo.toml --arch v3
cargo-build-sbf --manifest-path programs/noised-autopilot/Cargo.toml --arch v3
# output: $env:CARGO_TARGET_DIR\deploy\<name>.so
# final sizes (2026-10-11, with the audit-round-4 fixes; docs\evidence\2026-10-11-audit4-final-verification.md): launchpad 846,896 B,
# hook 214,984 B, vault 279,608 B, shield 288,640 B, autopilot 402,032 B
# cargo-build-sbf also writes <name>-keypair.json there when none exists. That is a RANDOM key, not the
# program ID (verified: none of the first four matched, nor the autopilot's of the review-4 build).
# Always deploy with --program-id .keys\<name>-keypair.json.
# declare_id! and .keys\ are authoritative. The hook and the launchpad hard-code each other's IDs, the hook also
# the vault's and the shield's, and the autopilot the launchpad's.
# .keys\ holds all five program keypairs: noised_autopilot-keypair.json was copied there on 2026-10-11 (from
# the maintainers' key store), and its public key matches the autopilot's declare_id (D5fuqC…).

# Before any deploy: the ELF header's e_flags (offset 48) must print 3, which means SBPF v3
python -c "import struct,sys; print(struct.unpack_from('<I', open(sys.argv[1],'rb').read(64), 48)[0])" "$env:CARGO_TARGET_DIR\deploy\noised_hook.so"

# IDLs (anchor-cli 1.2.1), into both idls\ and sdk\src\idl\ (verified for all five on 2026-10-11:
# regenerated IDLs identical to idls\)
anchor idl build -p noised_launchpad -o idls/noised_launchpad.json   # repeat for the hook, shield and autopilot (the vault's IDL is hand-maintained)
```

The five Noised IDLs in `idls/` and `sdk/src/idl/` must be identical and regenerated from the sources that are deployed. The Meteora IDLs next to them come from Meteora's MIT-licensed SDKs (`idls/LICENSE-meteora`).

Supply-chain hygiene:
- `cargo-build-sbf` downloads platform-tools with no checksum check (FACTS #17). Compare the downloaded archive against the GitHub release digest; for v1.57 on Windows the SHA-256 starts `792bc821…`. CI installs checksum-pinned Agave and platform-tools archives.
- Pin platform-tools in `[workspace.metadata.solana] tools-version` (FACTS #18).
- Verify `anchor.exe` with `gh attestation verify --repo otter-sec/anchor`.

## Test

```powershell
. $env:NOISED_ENV_SCRIPT   # optional: your toolchain env script (MSVC, Agave 4.3.0, caches)
$env:CARGO_BUILD_JOBS = '4'
$root = "$env:NOISED_BUILD_ROOT\target"   # the SBF builds and the root workspace share this directory
$env:CARGO_TARGET_DIR = $root

# Build all five .so files first (see Build). They land in $root\deploy.

# Format and lints, in each of the five workspaces (the root and the four LiteSVM ones, as CI does)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings

# Root workspace (crates/*, programs/*): unit and property tests (Launch Guard rules with
# 200,000-case property tests, safety policy, payout math, attestation and metadata rules,
# vault message layout, shield policy, LM-OTS/LMS, PXR1 rules and PXG1 graphs with their VM,
# the autopilot's planning, price and governance logic).
cargo test --workspace --locked
# LM-OTS and LMS known-answer tests with the signer features (RFC 8554 Appendix F, RFC 4231, the randomizer)
cargo test -p noised-lmots --features signer,sha2-backend --locked
# The rules crate with every feature (std included). The review-4 verification runs this; CI and
# test-all.ps1 cover the crate only through the workspace run above.
cargo test -p noised-rules --all-features --locked

# The LiteSVM suites are four separate Cargo workspaces with their own lockfiles, excluded from
# the root workspace because LiteSVM 0.17 pins older solana-* crates. --workspace never runs them.
# Each gets its OWN target directory (see the warning below) and reads the root build's .so files.
$env:NOISED_SBF_DIR = "$root\deploy"
$env:CARGO_TARGET_DIR = "$env:NOISED_BUILD_ROOT\target-integration"
cargo test --manifest-path tests/integration/Cargo.toml --locked                       # vault, hook, PQ vectors, metadata, programmable
$env:CARGO_TARGET_DIR = "$env:NOISED_BUILD_ROOT\target-lp-svm"
cargo test --manifest-path programs/noised-launchpad/tests/litesvm/Cargo.toml --locked -- --test-threads=1   # launch end to end, serially
$env:CARGO_TARGET_DIR = "$env:NOISED_BUILD_ROOT\target-sh-svm"
cargo test --manifest-path programs/noised-shield/tests/litesvm/Cargo.toml --locked   # shield
$env:CARGO_TARGET_DIR = "$env:NOISED_BUILD_ROOT\target-ap-svm"
cargo test --manifest-path programs/noised-autopilot/tests/litesvm/Cargo.toml --locked   # autopilot, on launches graduated to mainnet DAMM v2

# Independent re-derivations in standard-library Python
python -I scripts/pq/lms_reference.py appendix-f crates/noised-lmots/tests/rfc8554_appendix_f.json
python -I scripts/pq/lms_reference.py attest-vectors tests/integration/vectors/lms.json
python -I scripts/pq/lms_reference.py metadata-vectors tests/integration/vectors/metadata.json
python -I scripts/pq/lms_reference.py programmable-vectors tests/integration/vectors/programmable.json

# SDK, then the app (the app installs the SDK as a copy from ../sdk, so build the SDK first)
cd sdk; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test; pnpm build
cd ..\app; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test; pnpm build
$env:VITE_NOISED_MOCK = '1'; pnpm build; Remove-Item Env:VITE_NOISED_MOCK   # the simulated-chain build
```

`scripts\test-all.ps1` builds all five programs and runs the Rust test steps (not fmt and clippy, not the `noised-rules --all-features` run) and the Appendix F, attestation and programmable-vectors Python checks (not the metadata one), each workspace in its own target directory under `NOISED_BUILD_ROOT` (`target-sbf`, `target-host`, `target-it`, `target-lp-svm`, `target-sh-svm`, `target-ap-svm`; default: `target\` in the repository), and prints a pass/fail table. Before building, it dot-sources `NOISED_ENV_SCRIPT`, or `<NOISED_BUILD_ROOT>\env.ps1` when that file exists. CI (`.github/workflows/ci.yml`) runs all of the above on Linux except the `noised-rules --all-features` run, the app's two builds included. Both app builds run the output checks of `app/build/output-checks.ts` (CSP meta tag, no inline scripts or styles, no third-party loads; the live build must contain no mock code); set `NOISED_OUT_DIR` (its name must contain `dist`) to put the app's build output on another drive, for example in `app\.env.local`.

On the final programs with the audit-round-4 fixes (2026-10-11 19:55, fresh SBPF v3 builds of all five programs with 0 warnings, [verification summary](evidence/2026-10-11-audit4-final-verification.md), overall PASS) every suite passes *(verified)*: fmt and clippy (`-D warnings`) clean in the five workspaces; host 323 (autopilot 62, hook 39, launchpad 83, `noised-lmots` 34 plus a doctest, `noised-rules` 81, shield 17, vault 6); `noised-rules` with all features 81; the known-answer run 35; `tests/integration` 113; the launchpad suite 84 (serial); the shield suite 19; the autopilot suite 36; the four Python checks; every mutant pattern matches exactly once; and the regenerated IDLs of all five programs are identical to `idls/`. The SDK 0.3 run of 2026-10-09 passed 24 files with 467 tests; the SDK's current suite (0.8.0, unreleased) is in `sdk/test`. SPEC §6 maps each required scenario to its tests.

`tests/integration/mutants.ps1` checks that the integration suite catches real bugs: it builds 229 deliberately broken copies of the vault (38), the hook (66) and the launchpad (125) and runs the suites against each (about 70 minutes on the development machine). On 2026-10-11 the P1c merge run caught 218 of the 219 it then had ([summary](evidence/2026-10-11-p1c-merge-verification.md)), and the review-4 run ([summary](evidence/2026-10-11-review4-final-verification.md)) caught all 31 it selected: the hook's H and HR mutants, the new H44-H50 for R3 and Rb among them, and LR25-LR26, so the P1c survivor LR25 is now killed. Run it after any change to `noised-vault`, `noised-hook` or the launchpad's attestation, metadata, rules or `pq_authorize` code, and update a mutant whose pattern no longer matches instead of dropping it ([tests/integration/README.md](../tests/integration/README.md#mutation-check)). The other mutation checks:
- `python -I scripts/pq/lms_mutants.py`: the LMS crate (31 mutants).
- `python -I scripts/autopilot/autopilot_mutants.py`: the autopilot, against its host tests and pinned LiteSVM binaries (234 mutants plus 12 documented equivalent ones; the audit-round-4 run caught all 234, [summary](evidence/2026-10-11-audit4-final-verification.md); earlier, 184 of 184 in the P1c merge run and the 21 selected in the review-4 run). `--check` only tests that every pattern still matches once.
- `python -I scripts/rules/rules_mutants.py`: `crates/noised-rules` (180 mutants; 180 of 180 caught in the P1c merge run). `--check` as above.
- Outside the repository, kept by the maintainers (`svm-mutants.ps1`, `svm_mutate.py`, `host_mutants.py`, one copy per review round): the LiteSVM-only mutants of the launch path, the hook's rules, attestation v3, certificate v4 and `pq_authorize` (97 in the table; the review-4 run killed all 51 killable of the 55 it selected, 4 documented equivalent, and the audit-round-4 run the 4 mutants of `commit`), and the host mutants (60: the token-account reader, the creator rules, the policy head, rules and authorization code; 60 of 60 caught).

**Give every Cargo workspace its own target directory.** The root workspace, `tests/integration`, the launchpad's LiteSVM project (`programs/noised-launchpad/tests/litesvm`), the shield's (`programs/noised-shield/tests/litesvm`) and the autopilot's (`programs/noised-autopilot/tests/litesvm`) resolve different dependency graphs, because LiteSVM pins older `solana-*` crates.

Our program crates have `crate-type = ["cdylib", "lib"]`, so cargo writes their rlibs without a hash suffix (for example `debug\deps\libnoised_hook.rlib`). A build of another workspace in the same directory overwrites those files, and the next build of the first workspace can link the wrong artifact.

On 2026-10-08, after `tests/integration` had been built into the same directory, `cargo test --workspace` failed with `cannot find cpi in noised_hook`, and later with "multiple different versions of crate `anchor_lang`". The unchanged sources passed in a fresh directory.

A toolchain env script may set `CARGO_TARGET_DIR` for everything that runs after it, and the repository has no `.cargo/config.toml`. So set `CARGO_TARGET_DIR` explicitly for each test workspace, as above. When it is not set, cargo builds into `target\` inside the repository.

Builds of these crates with a different feature set may collide the same way. One example is `anchor idl build`, which enables `idl-build`. If a root build fails with duplicate-crate errors right after such a build, rebuild in a clean directory.

The integration tests look for program binaries in `NOISED_SBF_DIR`, then `SBF_OUT_DIR`, then `<target>\deploy`. They **fail on a `.so` that is not SBPF v3, or that is older than its sources**, so a test never silently runs against an old or differently-targeted build. Set `NOISED_ALLOW_STALE_SBF=1` (age check only) only when you know why.

Run against a mainnet feature snapshot. LiteSVM 0.17 bundles one, together with Token-2022 v11.0.0. Do not treat devnet as representative: devnet runs DBC 0.2.2 pre-release code and runtime features mainnet lacks (FACTS #7, #20). LiteSVM's default rent (6,960 lamports per byte) is higher than mainnet's (5,080): compute funding amounts from `getMinimumBalanceForRentExemption`, never from constants.

### Test fixtures

Mainnet program dumps and accounts live in `NOISED_FIXTURES_DIR` (default: `fixtures\` in the repository, which git ignores), which all four LiteSVM suites read (the shield's also accepts `NOISED_FIXTURES`). Refresh the fixtures after any upgrade of a dependency. The scripts dump every program and account below and compare each program's SHA-256 with the hash it was tested against:

```bash
scripts/fetch-fixtures.sh [out_dir]                # PowerShell: scripts\fetch-fixtures.ps1 [-Out <dir>]; default: NOISED_FIXTURES_DIR, else fixtures/
# by hand: solana program dump -um <program id> <name>.so
#          solana account -um <address> --output json-compact --output-file accounts/<address>.json
```

| Fixture | What | SHA-256 tested against (2026-10-08) |
|---|---|---|
| `dbc.so` | Meteora DBC 0.2.1, `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b` |
| `damm_v2.so` | Meteora DAMM v2 0.2.4, `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b` |
| `token_2022.so` | Token-2022 v11.0.0, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469` |
| `spl_token.so` | SPL Token (p-token), `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697` |
| `associated_token.so` | Associated Token Account program, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | `6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d` |
| `accounts/So11111111111111111111111111111111111111112.json` | the wSOL mint | |
| `accounts/<config>.json` | the DAMM v2 configs DBC migrates into (table below) | |

Program dumps include the zero padding of the ProgramData account, so these hashes identify the dump files, not the on-chain executable hash that `solana-verify get-program-hash` reports.

DAMM v2 migration configs. Each one's fee and `pool_creator_authority` = DBC pool authority (`FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`) were decoded from the fixture data. Every one also carries an enabled dynamic fee, which DAMM v2 copies into each migrated pool: up to about 20% of the tier on top of it (FACTS, PQ v2 facts):

| `migration_fee_option` | Pool fee | Default dynamic fee, at most | DAMM v2 config |
|---|---|---|---|
| 0 | 0.25% | +0.05% | `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` |
| 1 | 0.30% | +0.06% | `2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k` |
| 2 | 1% | +0.2% | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` |
| 3 | 2% | +0.4% | `2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq` |
| 4 | 4% | +0.8% | `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD` |
| 5 | 6% | +1.2% | `DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u` |
| customizable (not used by Noised) | set per config | | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` |

## Rehearse on a Surfpool mainnet fork

A Surfpool mainnet fork is the closest rehearsal short of mainnet. It fetches accounts lazily from a mainnet RPC, so our programs run against:
- the deployed Meteora DBC and DAMM v2 binaries;
- the real DAMM v2 migration configs;
- Token-2022 v11.0.0.

Verified on the Windows machine (FACTS #3, #12): Surfpool 1.6.0 runs as a mainnet fork, and both `solana program deploy --use-rpc` and `solana program set-upgrade-authority --final` work against it. The commands below follow `surfpool start --help` for 1.6.0. A full launch lifecycle with the final programs has not yet been rehearsed on a fork.

```powershell
# Window 1: the fork (Surfpool 1.6.0 CLI). On Windows, surfpool.exe needs OpenSSL DLLs on PATH;
# Git for Windows ships them.
surfpool start --network mainnet --no-tui --airdrop-keypair-path <deployer.json>

# Window 2: deploy, always with the program keypairs from .keys (see Build)
. $env:NOISED_ENV_SCRIPT   # optional: your toolchain env script (MSVC, Agave 4.3.0, caches)
solana config set --url http://127.0.0.1:8899 --keypair <deployer.json>
foreach ($p in 'noised_hook', 'noised_vault', 'noised_shield', 'noised_launchpad', 'noised_autopilot') {
  solana program deploy "$env:CARGO_TARGET_DIR\deploy\$p.so" --program-id ".keys\$p-keypair.json" --use-rpc
}
```

Then open the treasury vault, run `initialize_protocol` and the smoke launch listed under the devnet section, autopilot round included. Differences from mainnet:
- Surfpool 1.6.0 embeds the Agave 4.2.1 runtime, which lacks `relax_post_exec_min_balance_check`; that feature is active on mainnet (FACTS #16).
- Meteora's migration keepers do not run on the fork. Call `migration_damm_v2` yourself once the curve completes.
- The fork produces its own slots and clock. The launch window (at least 60 s), the commit window (at least 60 s) and the execution window (up to 600 s, ended by the batch) still have to elapse on that clock before the next step.

## Deploy to devnet

Devnet is a smoke test, not a mainnet rehearsal:
- Devnet DBC is a 0.2.2 pre-release.
- Meteora's devnet upgrade authorities are single keys.
- Runtime features differ (FACTS #7, #20).
- Before testing graduation there, check that the DAMM v2 migration config for your fee option exists on devnet.
- PQ keys carry the cluster byte: identities and vault keys derived for devnet never sign for mainnet, and the SDK refuses a mislabeled cluster (`assertCluster`).

```bash
solana config set --url devnet --keypair ~/deployer.json      # a deployer key with devnet SOL
for p in noised_hook noised_vault noised_shield noised_launchpad noised_autopilot; do
  solana program deploy target/deploy/$p.so \
    --program-id .keys/$p-keypair.json \
    --upgrade-authority ~/upgrade-authority.json \
    --use-rpc                      # sends through the RPC; avoids TPU hangs
done
solana program show CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc     # check Authority and data length
```

The hook hard-codes the launchpad's program ID (and the vault's and the shield's, whose top-level instructions skip the creator's rules), the launchpad hard-codes the hook's and the vault's, and the autopilot the launchpad's. All are fixed by the keypairs, so deployment order does not matter. Nothing works until all exist. Then open the treasury vault and run `initialize_protocol` (next section), and a smoke launch through the SDK:
1. `create_launch` (with `pq_identity`, and the launch's autopilot treasury, `["treasury", launch]` under `noised_autopilot`, among the fee recipients for step 10) from the creator's wallet; wait until it is finalized
2. `publish_metadata` from a throwaway payer (v1); wait for its confirmation
3. optional, for a launch with rules: `publish_rules` with a small PXR1 set (for example a per-transfer cap during the guard); wait for its confirmation
4. `attest_launch` from the throwaway payer (v1) with the rules hash (zero without rules) and a window opening a few minutes later; confirm the `Attestation` (version 3, its `rules_hash` and `message_hash`)
5. `launch` at `not_before` from a keeper key that is not the creator, with the attested rules record as its 23rd account (`buildLaunchTx` sets it); check the certificate (version 4) with `(checks & 4095) == 4095` (4,095 without rules, 8,191 with `RULES_BOUND`), its `rules_hash`, the hook policy's rules (byte-equal to the record) and the mint's metadata
6. a direct DBC buy during the shield, which must fail with `SnipeShield`, and a 1-lamport buy that would receive nothing, which must fail the same way
7. `commit` from two wallets, one naming PQ vaults as payout owners, more than `batch_total_cap` in total; `execute_batch` as a top-level instruction (check that the policy's `snipe_shield_end_ts` moved to the batch); `claim` (check the pro-rata refund and the vault payouts)
8. a public buy and sell; during the guard, a buy into a hand-made token account without `ImmutableOwner`, which must fail with `MutableOwner` (6010), next to a buy into an ATA, which must pass. With rules: a transfer a rule refuses, which must fail with `RuleDenied` (hook 6011, log "Launch rule {i} (code {c}) refused the transfer"), and a sell from the same wallet, which must pass
9. `claim_fees`, `distribute` (the platform share lands in the treasury vault's token account, the autopilot treasury's share in its wSOL ATA; `claim_surplus` / `claim_lp_fees` if the test reaches graduation)
10. an autopilot round: `init_autopilot`; `bind_mint` (once `Live`); `publish_graph` of a small graph; `pq_authorize` kind 1 over the activation payload from the throwaway payer (v1), then `activate` (a first graph may start at once) and `apply_pending` at `activate_at`; `run` a DISTRIBUTE_SOL node with one recipient that has no wSOL account (it must be skipped, `NodeRan.skipped`, with nothing created) and a BURN node (after a token donation to the treasury; before graduation it must earn no tip) and check the tips. After migration: `bind_pool`, `update_price`, wait at least 60 s, then `run` a BUYBACK_BURN node and check that every token it bought was burned in the same transaction; run it once for 1% of the pool (a partial run: the node must stay due) and then for the rest; if the graph names an operator, revoke it with a version-3 revocation
11. a PQ vault round trip: `open_vault`, a deposit, `withdraw` with `release` in one v1 transaction, then a second withdrawal delivered with `release_to`

## The treasury and `initialize_protocol`

`initialize_protocol(platform_fee_bps)` sets the treasury and the platform fee share **once, forever**. There is no update instruction.

- **The treasury is a PQ vault of wSOL, opened first.** `initialize_protocol` refuses anything else (`InvalidProtocolParams`): the account passed as `treasury` must be owned by `noised_vault`, carry the `Vault` discriminator, version 4 and the wSOL mint. Platform fees then arrive at the vault's own token account, ATA(vault, wSOL), which only the vault's hash-based signature can move. Before initializing:
  1. generate the treasury's 24-word PQ recovery phrase offline; make at least two offline backups in separate places;
  2. derive the genesis key (`deriveVaultKey(master, "mainnet", WSOL_MINT, account, 0)`) and open the vault (`buildOpenVaultTx`);
  3. check the vault account (version 4, mint wSOL, sequence 0, key id = the genesis key id) and its token account.
  If the phrase is lost, every platform fee sent there is lost forever, because the treasury cannot be changed.
- **Signer:** the launchpad's current upgrade authority. The program checks `ProgramData.upgrade_authority_address == Some(signer)`. With a Squads multisig as the authority, submit it as a vault transaction (the vault PDA signs and pays rent).
- **Order:** run it **before** finalizing `noised_launchpad`. After finalization nobody can ever sign it, and a launchpad without a `Protocol` account is permanently unusable.
- **Arguments:** `platform_fee_bps` <= 5000. It is visible in every launch's certificate.
- **Verify** afterwards:
  - derive `solana find-program-derived-address CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc string:protocol`;
  - decode the account with the SDK (`fetchProtocol`): `treasury` is the vault, `platform_fee_bps` as intended;
  - check the `ProtocolInitialized` event.
- **Withdrawing platform fees** follows the vault's rules (POST_QUANTUM.md §6): a durable vault-key ledger, the recipient checked and confirmed, signing offline for large amounts, never re-signing.

## Signing with a launch identity

For anyone who signs attestations or autopilot authorizations: the smoke tests above, and creators the app or SDK serves ([POST_QUANTUM.md](POST_QUANTUM.md) §3.5, [AUDIT.md](AUDIT.md) §16).
- **One device per quantum key, unless you import its records** (best practice). Each leaf may sign once, and only the device that signed knows about a signature that has not landed. Before signing on a second device (a synced passkey, a new browser, a profile whose site data was cleared), import the first device's leaf records. Since SDK 0.9.0 the client, and the Noised app, refuse to sign while the chain shows used leaves the device has no record of (`UnknownLeavesError`; the app's "key used elsewhere" panel offers the import); SDK 0.8 and earlier only warned, and as audit round 4 showed, a dishonest RPC could then steer the second device onto a leaf already used.
- **Check the clock.** Windows, `activate_at` and a freeze's `not_after` are signed times. Keep the device's clock right, read them as absolute dates before signing, and use more than one RPC. From SDK 0.9.0 the client refuses when the RPC's clock and the device's differ by more than 120 s.
- **Land or burn what you sign**, never re-sign for a delay (§6 item 22 of AUDIT.md), and stop after three unlanded signatures for one launch (or one launch and kind) to find out why.

## Deployment invariants

These hold for every deployment and every upgrade until the programs are finalized. Breaking one can brick live launches, and once the programs are final nothing can repair them.

1. **Each mint's meta list is written once, with exactly 2 extra metas.** `launch` creates the mint's `ExtraAccountMetaList` (`["extra-account-metas", mint]` under the hook) in the launch transaction, holding exactly the policy PDA `["policy", mint]` and the instructions sysvar. Its contents are deterministic, and no instruction updates or closes it. Checked by `meta_list_init_is_permissionless_and_deterministic` (`tests/integration`) and `launch_guard_hook_accounts_are_forwarded_and_enforced` (shield LiteSVM suite).
2. **Never upgrade the hook in place to a version with a different `Execute` account list.** Token-2022 passes the hook exactly the accounts its mint's meta list names, and the launchpad's `hook_accounts.rs` requires the matching 4 hook accounts. A hook whose `Execute` expects other or more accounts would make every transfer of every existing launch fail, sells included (`AccountNotEnoughKeys` when it expects more), and the existing lists cannot be rewritten. A hook that needs different accounts is a new program under a new ID, used by a new launchpad version ([HOOKS.md](HOOKS.md) §3 and §6). Round 1 grew the list from 1 entry to 2; that was safe only because nothing had been deployed.
3. **Never change a signed format or a seed in place.** The attestation message (`PHX-ATTEST-V3`, 221 bytes), the metadata hash (`PHX-META-V2`), the rules hash (`PHX-RULES-V1` over PXR1 bytes), the authorization message (`PHX-AUTH-V1`, 140 bytes), the graph hash (`PHX-GRAPH-V1` over PXG1 bytes), the autopilot payloads the identity authorizes (`PHX-GRAPH-ACT-V1`, `PHX-GRAPH-FRZ-V2`, `PHX-OP-REVOKE-V3`), the vault's withdraw message (`PHX-PQV4`), the identity id (`SHA256(0x21 ‖ pk)`) and every PDA seed are what existing identities, vault keys and records signed or were created under. A change needs a new version tag, and existing accounts must keep verifying.
4. **The autopilot reads the launchpad's accounts by layout, at pinned versions.** It reads `Launch` only at version 2 (status at offset 13, `dbc_config` at 78, `base_mint` at 174, `pq_identity` at 553; at least 585 bytes), `Certificate` at versions 3 and 4 (`checks` at 187) and `Authorization` at version 1 (2,669 bytes), and refuses any later version (review 4, R6b). A launchpad change to any of these layouts, or a new version of them, therefore needs a new autopilot that knows it, deployed before or with that launchpad; otherwise every autopilot instruction that reads a launch of the new version fails closed.
5. **Make all five programs immutable after verification.** Once the verifiable builds match the deployed programs and `initialize_protocol` has run, finalize `noised_hook`, `noised_vault`, `noised_shield`, `noised_autopilot` and `noised_launchpad` (checklist below). Until then the upgrade authority is trusted for every guarantee, including invariants 2 to 4, for the hook's trust in the launchpad's `execute_batch`, and for the autopilot's trust in the launchpad's authorizations and certificates.

## Release and finalization

Finalization (`--final`) removes the upgrade authority forever. After it, no bug can be fixed in place. It is what turns "the team promises" into "the code guarantees".

Checklist, in order:

1. **Audits done.** At least two independent audits, plus fuzzing and formal checks of the payout math where feasible. All fixes merged, with regression tests (audit round 3's F1 and F2 were merged on 2026-10-10 with theirs, [AUDIT.md](AUDIT.md) §14; the review-4 fixes R1, R3, Ra, Rb, R6a, R6b and R5 on 2026-10-11, §15; audit round 4's program fixes A4-2, A4-3 with A4-S, A4-4, M4 and L-i2 on 2026-10-11, §16). Audit round 4's client fixes are done (SDK 0.9.0, `@noisedlabs/mcp` 0.2.0, the app; AUDIT.md §16). Every suite of the Test section green on the release commit, the mutation runs included. Tag the release commit.
2. **`security.txt` embedded.** Add it to each program with the `solana-security-txt` macro, excluded under `no-entrypoint`. Point it to [SECURITY.md](../SECURITY.md) and a web page, because changing it after finalization is impossible. *Not yet present in the code.* Fill in SECURITY.md's contact first.
3. **Verifiable builds** of all five programs at the tagged commit, in Linux CI (see Verifiable builds), with `--arch v3`. Publish the hashes. Regenerate the five IDLs from the same commit into `idls/` and `sdk/src/idl/`, and release the SDK and the app built against them.
4. **Deploy to mainnet**, with the upgrade authority on a multisig. Check that `solana-verify get-program-hash -um <id>` equals the CI hash.
5. **Open the treasury vault, then run `initialize_protocol`** (see above), and verify `Protocol`.
6. **Upload the verification PDAs** while the upgrade authority still exists. For a multisig, use `solana-verify export-pda-tx`. For a program with no upgrade authority, only the verifier's operator (OtterSec) can attach the record, so do it now.
7. **Smoke launch** on mainnet with small amounts and the devnet steps above: identity, metadata record, launch rules, attestation, a keeper opening the launch inside its window, the batch into PQ vaults, fees into the treasury vault and an autopilot treasury, an autopilot round. Run the full lifecycle, including graduation and a buyback if practical.
8. **Run the wallet and indexer matrix** for the metadata uri modes (FACTS, on-chain metadata facts) on mainnet before the app offers `INLINE_URI`. Record the result in FACTS.
9. **Finalize** each program:
   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> --final --upgrade-authority <CURRENT_AUTHORITY>
   ```
   With a multisig authority, propose the equivalent SetAuthority instruction through the multisig. Do the launchpad last, after confirming `Protocol`.
10. **Confirm** `solana program show <id>` prints `Authority: none` for all five. Publish the result with the program IDs, hashes and commit.

Until step 9, the upgrade key is the most valuable target in the system:
- Use a Squads v4 multisig with an on-chain `time_lock` (FACTS #66). Squads v4 itself is immutable.
- Use hardware keys on separate devices and a threshold that no single person meets.
- Never sign durable-nonce or blind transactions. That is how Drift lost $285M in 2026 (FACTS #64).
- Simulate every proposal.

## Verifiable builds (Linux CI)

`solana-verify` needs Docker, which the Windows machine lacks, so this runs in CI: the `programs` job of the release workflow and the manual `verifiable-build` job of `ci.yml`. The build commands below ran in the release dry run [38334299942](https://github.com/NoisedLabs/noised/actions/runs/38334299942) (2026-10-13, solana-verify 0.5.2): all five programs built, all SBPF v3 (`e_flags` 3). Each `.so` was byte-identical to the host build of the same commit by CI's `programs` job (Agave 4.3.0 release, platform-tools v1.57, outside Docker), which is the build the LiteSVM suites tested. The verification commands need the deployed programs and have not been run. Their flags come from solana-verify 0.5.2's source. Check `--help` for the version you pin.

**solana-verify builds SBPF v0 unless told otherwise**: its own `--arch` defaults to v0. Pass `--arch v3` to `build` and to `verify-from-repo`. On a version without `--arch`, pass `--cargo-build-sbf-args="--arch v3"` instead. Either way, confirm that the hash matches the `--arch v3` build that was deployed. `--arch` is solana-verify's own flag, so it goes before any `--`: what follows `--` is passed to `cargo build`, which rejects `--arch` (the dry run of 2026-10-13 00:57 failed on `-- --arch v3`). cargo-build-sbf has no manifest setting for the architecture (only `tools-version`), so the flag is the only way. `verify-from-repo` stores it in the verification record, and OtterSec's worker replays it.

```bash
cargo install solana-verify --locked --version 0.5.2   # pin the version
# Deterministic Docker build, SBPF v3
solana-verify build --library-name noised_hook --arch v3        # repeat for each program
solana-verify get-executable-hash target/deploy/noised_hook.so
solana-verify get-program-hash -um cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia
solana-verify verify-from-repo -um --program-id cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia \
  https://github.com/NoisedLabs/noised --library-name noised_hook --arch v3 --commit-hash <SHA>
solana-verify remote submit-job --program-id cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia --uploader <UPGRADE_AUTHORITY>
```

The parameters every rebuild must use, the CI builds included:

| Parameter | Value |
|---|---|
| Repository and commit | `https://github.com/NoisedLabs/noised`, the release tag's commit (`--commit-hash`) |
| Mount path | the repository root: no `--mount-path` (it must hold `Cargo.lock`; `programs/<name>` does not) |
| Library names | `noised_hook`, `noised_vault`, `noised_launchpad`, `noised_shield`, `noised_autopilot` (the `[lib]` names, not the package names) |
| Architecture | `--arch v3` |
| Image | chosen from `[workspace.metadata.cli] solana = "4.3.0"` in the root `Cargo.toml`: `solanafoundation/solana-verifiable-build:4.3.0`, digest `sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd` (Rust 1.97.1 image, cargo-build-sbf 4.3.0, platform-tools v1.57 preinstalled, which matches `[workspace.metadata.solana] tools-version`). No `--base-image` |
| Cargo arguments | none (solana-verify adds `--locked` itself) |

The legacy `--remote` flag of `verify-from-repo` stops with an error in 0.5.2. Upload the record with `verify-from-repo` signed by the upgrade authority, or with `export-pda-tx` (same parameters plus `--uploader <MULTISIG_VAULT>`) for a multisig, then queue OtterSec's worker with `remote submit-job`.

The release workflow refuses a `.so` whose `e_flags` is not 3. The CI job should fail if any hash differs from the deployed program. Both the manual `verifiable-build` job of `ci.yml` and the release workflow build all five libraries.

## Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs when the owner pushes a version tag (`vX.Y.Z`, or `vX.Y.Z-rc.N` for a pre-release) on a commit of `main`:

1. **Preflight.** The tagged commit is on `main`; `scripts/release/repo-config.json` names the real GitHub owner (not the placeholder `TBD`) and `node scripts/release/apply-repo-config.mjs --check` passes; both npm packages pass `scripts/release/prepare-publish.mjs --check`.
2. **The whole CI** (`ci.yml`, called as a reusable workflow).
3. **Verifiable builds** of the five programs with `solana-verify` (Docker), SBPF v3. The release gets each `.so`, its IDL, `SHA256SUMS`, `EXECUTABLE_HASHES` (what `solana-verify get-program-hash` prints for the deployed program) and a signed build-provenance attestation (`gh attestation verify <file> --repo <owner>/<repo>`).
4. **npm**: `@noisedlabs/sdk`, then `@noisedlabs/mcp` (its `file:../../sdk` dependency becomes the exact SDK version), with npm provenance, through npm trusted publishing (GitHub OIDC).
5. **crates.io**: `noised-lmots`, then `noised-rules`, through crates.io trusted publishing (OIDC).
6. **The GitHub release** of the tag, with the files of step 3.

A version already on its registry is skipped, so a tag releases only what changed. Run the workflow by hand (`workflow_dispatch`) for a dry run: everything is built and packed, nothing is published.

One-time setup by the owner:

- **Repository.** Set `owner` (and `repo`, if not `noised`) in `scripts/release/repo-config.json`, run `node scripts/release/apply-repo-config.mjs`, and commit the result. It writes the URLs into every `package.json`, the root `Cargo.toml` (the crates inherit them) and the README badges.
- **Environment `release`** (Settings > Environments): required reviewers (the owner), deployment branches and tags limited to `v*` tags. The npm, crates.io and GitHub-release jobs wait for that approval.
- **npm.** Create the `noised` organization (scope `@noised`). For each package, add a trusted publisher: GitHub Actions, this repository, workflow `release.yml`, environment `release`. If npm only allows a trusted publisher on a package that already exists, publish the first version once with a granular token limited to the two packages, with a short expiry, stored as the secret `NPM_BOOTSTRAP_TOKEN` of the `release` environment; then add the trusted publishers, delete the token on npm and the secret on GitHub, and set the packages to require 2FA and disallow tokens for publishing.
- **crates.io.** Trusted publishing is configured on an existing crate, so publish the first versions with an API token scoped to `publish-new` and `publish-update` of `noised-lmots` and `noised-rules`, stored as the secret `CARGO_REGISTRY_TOKEN` of the `release` environment (the workflow uses it when present). Then add a trusted publisher to each crate (this repository, workflow `release.yml`, environment `release`) and delete the token and the secret: later releases use a short-lived OIDC token only.
- **GitHub.** Enable private vulnerability reporting (Settings > Security), branch protection on `main` (reviews, the CI checks required) and tag protection for `v*`.

## Monitoring

Noised cannot stop third-party changes. It must notice them quickly and tell users. Baselines are as of 2026-10-08.

| Watch | How | Baseline | Alert when |
|---|---|---|---|
| Meteora DBC code | `solana program show dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN -um` (ProgramData `HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh`); the DBC repository's release PRs | last deploy slot 445,503,633; authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`; 0.2.2 pending as PR #211; operator hook revoke only in draft PR #214 | slot or authority changes; PR #211 merged (in the last five releases the mainnet upgrade came 1 to 8 minutes before the merge); any release that contains a hook revoke, changes the swap or config layouts, or changes how much heap a pool's metadata may use; any release that stops making a token transfer for a buy whose output rounds to zero, or accepts the base vault as a swap's output account (the launchpad suite's `l2b_…`, `l2d_…` and `dbc_takes_the_largest_inline_uri_with_room_to_spare` fail on fresh dumps) |
| Meteora DAMM v2 code | same for `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (ProgramData `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH`) | slot 445,230,614; same authority | slot or authority changes |
| Token-2022 code | same for `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (ProgramData `DoU57AYuPFu2QU514RktNPG22QhApEjnKxnBcu4BHDTY`) | v11.0.0, slot 427,147,035 | slot or authority changes |
| Our programs | `solana program show` for all five | `Authority: none` after finalization | any change |
| Graduated Noised pools | read each DAMM v2 pool's status and fee fields; the SDK's `damm.fee` check | enabled; the tier of the launch plus its config's default dynamic fee | pool disabled, or fees differ from the canonical config |
| DAMM v2 migration configs | `solana account` on the six fixed-fee configs above (fee options 0-5, `7F6dnUc…` to `DbCRBj8…`) | exist, owned by cp_amm | closed or changed: graduation stalls |
| Feature gates | Solana feature-gate tracker; `solana feature status <id> -um` | SIMD-0500 `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` inactive; ZK ElGamal proof program enabled | SIMD-0500 scheduled (must finalize v3 builds); any gate touching ZK ElGamal, CPI depth or the cost model's per-account limits |
| Launch operations | indexer over launchpad events and failed transactions | | an attested launch whose window is open but not launched yet (keepers must open it; after `not_after` the creator has to sign a new window, audit round 3 F1); `launch` transactions dropped or failing inside a window (possible write-lock contention on the `Launch` account); `PqLeafConsumed` events (burn-only landings, a client problem); identities with more than 1,000 used leaves; a batch window about to close unexecuted, or `execute_batch` transactions dropped or failing near the window's end (possible write-lock contention); `execute_batch` failing with `PoolAlreadyTraded` (6038: the pool traded before the batch, which the hook should make impossible; SEV2); a completed curve not migrated after N minutes; unclaimed fees piling up |
| Launch rules | hook errors in failed transactions per mint; the launch's rules in plain English (`verifyLaunch` `report.rules`) | | a spike of `RuleDenied` (hook 6011) on one launch: its rules may be refusing ordinary buys (Incident response); any `RuleDenied` logged with code 255 (stored rules that do not parse, which `create_policy` should make impossible; SEV2) |
| Autopilots | indexer over autopilot events; the SDK's `fetchAutopilotView` / `fetchDueNodes` | | `GraphQueued`: a graph change takes effect at its `activate_at` (a replacement at least 72 h ahead): show it to the launch's holders at once, with the new graph explained; `GraphFrozen` (and the queued update it `cancelled`); `OperatorRevoked`; `NodeRan` tips of one autopilot near 5,000,000 lamports in a UTC day, or every run of one autopilot by the same caller; `PendingUpdateDue` refusals (nobody landed `apply_pending`); a graduated autopilot with no observation in the current 15-minute window before a due buyback (run `update_price`: THREAT_MODEL R36), or a buyback whose window holds only its own caller's observations (the honest-observation dependency, audit round 4, A4-1); `NodeRan` with `partial` set many times on one node and one day (a keeper splitting buybacks), or with `skipped` set (recipients without a wSOL account; `kept` is their share, left in the treasury); `NoRecipientAccount` (6042) refusals; due nodes nobody runs |

On a Meteora or Token-2022 upgrade:
1. Diff the new binary against the release Meteora announced (`solana-verify get-program-hash`, published audits).
2. Re-dump the fixtures and re-run the LiteSVM suites, the launchpad's included: `l2b_zero_output_buys_cannot_cross_the_snipe_shield` and `l2d_dbc_refuses_a_buy_whose_output_is_the_base_vault` pin the DBC behaviour the snipe shield relies on, and `dbc_takes_the_largest_inline_uri_with_room_to_spare` the heap margin the metadata relies on.
3. Show a banner in the app.
4. Pause app-side creation of new launches until reviewed. The programs stay permissionless; only the app pauses.

## Keepers

Every crank is permissionless, so anyone can run one and no keeper holds a privileged key. Run at least two independent keepers, on different RPC providers. A keeper's key pays fees and rent only (an autopilot keeper also earns capped tips into a wSOL account it names); use a dedicated key with a small balance, topped up as needed. Only an autopilot graph's operator-gated nodes need a particular key, the operator's.

Three autopilot rules since audit round 4 ([AUDIT.md](AUDIT.md) §16):
- **Observe before every buyback, yourself.** Send your own `update_price` at least 60 s before running a buyback, even when an observation is already counting. A buyback's price bound is only as good as the observations in its window; if every one of them came from one party, the bound can be stale. The SDK keeper does this since 0.9.0; SDK 0.8's keeper observed only when no observation was counting.
- **Run an independent observer.** Besides the keepers, send `update_price` for every graduated autopilot at least every 10 minutes, from a separate key and RPC, so that every 15-minute bucket holds an honest observation. It costs only the transaction fee (no tip).
- **Never fund recipient accounts.** A distribution skips a recipient without a wSOL account (its share stays in the treasury), so a keeper never needs to create one. A keeper that creates them pays a token account's rent for each, every run, and a recipient can take that rent back by closing the account, far more than the tip. Pass every recipient's canonical wSOL ATA address, writable, in graph order, whether or not an account exists there. Since SDK 0.9.0 (and `@noisedlabs/mcp` 0.2.0) the SDK keeper and the MCP server never create them, and they state the costs.

| Job | When | How | If missed |
|---|---|---|---|
| **Open attested launches**: `launch()` | inside `[not_before, not_after]` of each attestation (60 s to 1 h), as soon as it opens | Watch `LaunchAttested` events (or `getLaunchFlowStatus`); at `not_before` send `launch` alone, as a legacy transaction with a fresh mint keypair, a 300,000-CU limit and a priority fee (`buildLaunchTx`, or `buildLaunchCommitBundleV1` for `[launch, commit]` as v1). `launch` takes the attested rules record as its 23rd account (the launchpad's program id when the attested rules hash is zero); `buildLaunchTx` sets it from the attestation: 988 bytes without rules, 1,020 with. Inside the window the first transaction to land wins, so retry every slot until one lands or the window ends, with a priority fee that escalates on each retry: the `Launch` account is the one fixed account a competitor can write-lock. | **That window is over for good.** Nobody's funds are at risk (no commit exists before `launch`). The creator signs a new opening time at its identity's next leaf (`getLaunchFlowStatus`: "Window passed: sign a new opening time"), reusing its metadata record or publishing a new one; while the launch is `Configured` the new attestation replaces the expired one (audit round 3, F1), and the keepers watch for the new `LaunchAttested`. A launch can then have several `LaunchAttested` events: always take the window from the `Attestation` account, never from an older event, and never cache it before the launch is `Live` (an older signature that never landed may also take the slot, with its own window). |
| `execute_batch`, as a **top-level** instruction (a CPI'd call has its buy refused by the hook) | inside `[commit_end_ts, execute_end_ts)`, a **600 s** window | Tight compute limit (the SDK's default is 220,000; measured at most about 174k CU) and a priority fee that escalates on each retry; re-simulate and retry every slot until it lands or the window closes. Watch for contention: dropped or failing transactions near the window's end. | Batch expires, everyone is refunded in full, and the launch opens without a batch buy at `execute_end_ts`. The same happens if it fails with `PoolAlreadyTraded`; do not retry that, raise an alert (Incident response). |
| `claim(owner)` for every commit | after execution or expiry | `buildClaimTx` pays the commit's recorded payout owners | users can claim themselves; nothing is lost |
| DBC `migration_damm_v2` | when a curve completes | Meteora's instruction | Meteora's keepers migrate only some quote/threshold pairs. Until migration, swaps revert. |
| `claim_fees`, `claim_surplus` (after completion), `claim_lp_fees` (after migration, one position per transaction), `distribute` | periodically | the SDK builders | fees accumulate; nothing is lost |
| vault `release` of pending payouts | after a `withdraw` that was sent without `release` | `buildReleaseTx` | the payout stays reserved in the vault; the recipient or anyone can release it later |
| Autopilot setup: `init_autopilot`, then `bind_mint` | `init_autopilot` once the launch exists (`Configured` or `Live`); `bind_mint` once it is `Live` | `buildInitAutopilotTx`, `buildBindMintTx` (the creator's activation flow sends them too) | nothing can run: `run` needs a bound mint and an active graph |
| `bind_pool` | once, after DBC migrated the curve | `buildBindPoolTx` takes the canonical DAMM v2 config of the launch's migration fee option (table above). If the pool is not under it, pass `dammConfig`: the config named in the migration transaction, or one found with `getProgramAccounts` on DAMM v2 for `Config` accounts (328 bytes) whose `pool_creator_authority` at offset 40 is `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` and whose pool of (mint, wSOL) exists | the launch does not count as graduated: buybacks and graduation-triggered nodes wait; nothing is lost |
| `apply_pending` | at or after a queued graph's `activate_at` | `buildApplyPendingTx`; `planKeeperStep` returns it first | every `run` of that autopilot is refused (`PendingUpdateDue`) until someone lands it |
| `update_price` | at least every 10 minutes once the pool is bound, from an independent observer as well as the keepers, and by every keeper at least 60 s before each buyback it runs; never "too soon", no tip, only the transaction fee | `buildUpdatePriceTx` | One honest observation per 15-minute window closes the reference-price residuals (THREAT_MODEL R36): without it, one party making every observation can walk the reference up (at most about 5% an hour) or, after a fall nobody observed, run a buyback against the stale reference (audit round 4, A4-1). |
| `run` due nodes | when a node's trigger, condition, budget and runs per epoch allow | `planKeeperStep` / `runKeeper` (SDK), or `fetchDueNodes` and `buildRunTx`. For a buyback: your own `update_price`, wait at least 60 s, then `run`, either with no amount (the node's whole remaining amount, as far as the treasury allows) or with an amount of at least 1% of the pool's wSOL (or the node's maximum, if smaller) and at most the maximum (`AmountTooSmall` below) that equals the maximum or leaves at least that 1% for the rest (`RemainderTooSmall`, 6041). A smaller amount is a partial run: the node stays due for the rest, and the tip is only its share. For a distribution: pass every recipient's canonical wSOL ATA address and create none; recipients without an account are skipped, and a run that would pay nobody fails (`NoRecipientAccount`, 6042). The tip goes to a wSOL account the caller names: at most 100,000 lamports per run, 5,000,000 per autopilot per UTC day and 10% of what the run moved; a burn before graduation earns none. Operator-gated nodes are the operator's: keepers skip them. | the automation waits and the treasury keeps its funds. A node whose per-run cap is below 0.001 SOL pays less than the full tip, and a burn node before graduation pays nothing, so keepers may ignore them |

## Incident response

**Principles.** Noised has no pause and, after finalization, no upgrade. Response is therefore:
1. protect users through information and the frontend;
2. coordinate with the affected third party;
3. if needed, ship *new* program versions that users opt into.

Never run exploit code against mainnet, not even to "rescue" funds, unless the plan has been reviewed and the legal position is understood.

| Severity | Meaning | Target first response |
|---|---|---|
| SEV1 | Funds at risk now, or a live exploit | 1 hour |
| SEV2 | Funds at risk under specific conditions; a third party changed something trusted | 24 hours |
| SEV3 | Degraded function or wrong information, no funds at risk | 1 week |

| Playbook | Steps |
|---|---|
| **Vulnerability report in our code** | Acknowledge within 72 h ([SECURITY.md](../SECURITY.md)). Reproduce in LiteSVM. **Before finalization:** prepare the fix, pass it through the multisig with its timelock, and disclose after deployment. **After finalization:** no in-place fix exists. Warn users in the app, show which launches are affected, publish mitigations (for example "do not commit to new batches"), deploy a fixed program under a new ID, and coordinate disclosure. |
| **Meteora upgrade** (DBC or DAMM v2) | Check whether it matches an announced, audited release. Re-run the integration tests on fresh dumps. If the behaviour changed in a way that breaks a guarantee, stop new launches in the app, publish an advisory and contact Meteora. |
| **Noised pool disabled or re-fee'd by a DAMM v2 operator** | Confirm on-chain. Notify holders in the app (locked liquidity cannot be withdrawn by anyone). Contact Meteora. Record it in the launch's page. |
| **Migration configs closed** | Confirm. Tell affected launches that graduation is stalled (swaps revert after completion). Keepers retry once a config exists again. |
| **Frontend, DNS or package compromise** | Take the site down or point DNS at a static warning page. Publish the last known-good IPFS hash. Rotate deploy credentials. Identify affected transactions from the logs. Publish indicators. Remind users that the SDK and CLI work without the site. |
| **Suspected upgrade-key compromise** (before finalization) | Use the remaining multisig members to rotate the authority immediately, which is why the timelock and threshold matter. Watch for queued upgrade proposals. Warn users. |
| **Token-2022 upgrade or ZK proof kill switch** | Warn shield users: confidential balances may be frozen while the feature is off. Public zToken balances can still be unwrapped. |
| **`execute_batch` fails with `PoolAlreadyTraded`** | Something traded the pool before the batch, which the hook should make impossible (SEV2). Committers lose nothing: the batch expires at `execute_end_ts` and `claim` refunds every commit in full, so crank the claims. Find the pool's first swap and how it passed the snipe shield: a DBC or Token-2022 upgrade (re-run the launchpad suite on fresh dumps), or a bug in the hook. Warn in the app and pause app-side launch creation until it is understood. |
| **A batch is kept out of its window by write-lock contention** | Committers lose nothing (full refunds at `execute_end_ts`); crank the claims. Record the contending transactions and their priority fees; raise the keepers' fee ceiling for later launches; tell creators to choose longer commit windows. |
| **An attested launch was not opened in its window** | Nothing to refund (no commit exists before `launch`). Tell the creator to make sure every signature it sent earlier for that launch has landed, then sign a new window; the new attestation replaces the expired one and the launch opens in the new window (audit round 3, F1). If an older signature took the slot first, the launch opens in that signature's window instead; the creator waits for it. Find out why the keepers missed the window (RPC, fees, an outage, or someone write-locking the `Launch` account for the whole window: record the contending transactions and their priority fees, raise the keepers' fee ceiling, and suggest a longer window, up to an hour). |
| **Burn-only attestations for one launch** (`PqLeafConsumed`) | A client problem: the metadata or rules record missing or not finalized, a window that cannot open, another identity, or the launch already attested. Each one spent a leaf. Find the cause before anyone signs again; never let a client re-sign in a loop. |
| **A creator's identity secret is suspected stolen** | Launches already live keep their metadata, rules and policy. Pending launches of that identity could be attested with other metadata, rules or windows by the thief: warn their communities, and have the creator move to a new identity (a new phrase or passkey) for new launches. The thief can also authorize autopilot changes for the identity's launches whose graphs are not frozen: a replacement still waits 72 h after `GraphQueued` and may pay the treasury to new recipients, so warn those holders at once; the creator's own newer authorization (another activation, or a freeze, which cancels the queued update) can still land, but so can the thief's. A frozen graph cannot change. |
| **An autopilot operator key is compromised** | The key can only run its graph's operator-gated nodes, choosing their timing (within the trigger) and amount (up to the node's limit); it cannot widen a bound, run other nodes or move the treasury anywhere else (SECURITY_GUARANTEES AP4, THREAT_MODEL R40). The launch's identity signs a revocation (`pq_authorize` kind 3, payload naming the active graph and the operator); anyone then lands `revoke_operator`, which also works on a frozen graph and clears the same operator from a queued graph. Its gated nodes stop until a graph with a new operator is activated (72 h for a replacement). Warn holders meanwhile. |
| **An unwanted graph change is queued** | A replacement is visible in `GraphQueued` at least 72 h before `apply_pending` can make it active: show it in the app with the new graph explained, so holders can decide to exit. If the creator did not sign it, treat it as a stolen identity secret (above). If the creator signed it by mistake, it can land a newer authorization of its own: another activation (which replaces the queued one, again 72 h ahead) or a freeze of the active graph (which cancels it). A frozen graph can never be changed, so this cannot happen to one. |
| **A launch's rules refuse ordinary buys** | Usually not a bug: the creator's rules were signed and disclosed, and nobody can change them. They end at the guard (at most 72 h after the launch opened), and they never refuse a sell, a claim or the batch, so every holder can still sell. Confirm from the hook policy and the plain-English explanation (`verifyLaunch` `report.rules`), and warn on the launch's page in the app. A rule set that blocks every buy for the whole guard, or allows only listed wallets to buy, is a disclosed residual (THREAT_MODEL R33), not something the programs prevent. SEV3, unless the rules do not parse (code 255: SEV2). |
| **A vault payout cannot be delivered** | Simulate `release` to see why: a frozen account, a paused mint, a hook refusal (for a launch token, the guard window), or the recipient's account settings. The withdrawal has already executed and the amount stays reserved; nothing else in the vault is affected. Ask the recipient to fix its account or sign `release_to`; for mint-side causes, wait or contact the issuer. **Never re-sign the withdrawal.** |
| **Quantum-relevant news** | Re-state what the post-quantum parts do and do not protect ([POST_QUANTUM.md](POST_QUANTUM.md)). Advise moving long-term holdings of authority-free mints into vaults and naming vaults as payout owners and fee recipients. |

Communicate through a status page and the repository's security advisories. Publish a post-mortem within 14 days of a SEV1 or SEV2. Ecosystem help is available through SIRN, the Solana incident-response network (FACTS #69).
