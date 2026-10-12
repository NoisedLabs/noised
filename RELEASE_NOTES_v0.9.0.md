# Noised v0.9.0: the first public release

**The quantum security layer for Solana, open source.** This release publishes the whole Noised repository under Apache-2.0, the TypeScript SDK **`@noisedlabs/sdk` 0.9.0** and the MCP server for AI agents **`@noisedlabs/mcp` 0.2.0** on npm, and documents the five on-chain programs that run on **Solana devnet**.

> [!WARNING]
> **Devnet only, pre-audit.** Four of the five programs (launchpad, hook, autopilot, vault) are deployed on Solana **devnet**; the Shield is not deployed yet. They are **upgradeable** (the devnet deployer holds the upgrade authority) and have **not been audited by a professional security firm**: the reviews so far were internal and carried out by AI agents ([docs/AUDIT.md](https://github.com/NoisedLabs/noised/blob/main/docs/AUDIT.md)). **Nothing is deployed on mainnet.** Do not use Noised with funds you cannot afford to lose.

## Highlights

- **Launches that nobody can rug, signed with a post-quantum key.** Every launch must be signed by its creator's post-quantum identity (an LMS key, RFC 8554, 1,024 one-time leaves, derived from a separate 24-word phrase or a passkey, never from the wallet) over its parameters, its on-chain metadata, its launch rules and its opening window. The launchpad verifies that signature on-chain before the launch can go live. Mint and freeze authorities are None, metadata is immutable and on-chain, sells are never blocked, 100% of the liquidity is permanently locked at graduation, and there is no admin key.
- **A fair opening batch.** Nobody, not even the creator, can buy before the batch; everyone in it buys at the same price, pro rata; if it does not run, everyone is refunded in full.
- **Quick launch and Custom launch.** `planQuickLaunch` turns a short form (name, ticker, logo, links, trading fee, where the creator's fees go) into a complete, validated plan with every step in order. Custom launches add a curve, caps, a guard, the creator's own launch rules (PXR1) and an Autopilot.
- **Autopilot.** A token's treasury runs itself within on-chain limits: buy back and burn on the token's own locked pool, burn, pay named recipients, on a schedule, for a capped tip to whoever runs a due step. Changes need the creator's post-quantum key and wait 72 hours; a plan can be frozen forever. An optional operator (for example an AI agent) chooses only when and how much.
- **PQ vault.** Token custody that only an LM-OTS one-time signature can move, with the key rotating in place and a durable record of every one-time key so none ever signs twice.
- **Verify and QSL-1.** `verifyLaunch` re-checks any Noised token against the live chain, and `checkQsl1` / `qslBadge` implement the draft [QSL-1 token standard](https://github.com/NoisedLabs/noised/blob/main/docs/standard/QSL-1.md) condition by condition. On devnet, and until the programs are finalized, every token is at most a "candidate".
- **AI agents.** `@noisedlabs/mcp` gives Claude, LangGraph and any MCP client eleven tools to read launches, rules and autopilots, check tokens against QSL-1, simulate, and build **unsigned** autopilot transactions. It never signs and holds no keys.
- **Audit round 4's fixes, all of them.** The program fixes are merged and deployed on devnet; the client fixes ship in SDK 0.9.0, MCP 0.2.0 and the app. The round's main finding (ID-F1, medium-high: a dishonest RPC could steer a second device onto the one-time leaf of a withheld signature) is fixed: the leaf choice is secret and keyed, signing stops when the chain shows signatures this device does not know (`UnknownLeavesError`), signed times are checked against the device's clock (`ClockSkewError`), signing runs under a cross-tab lock, and unlanded signatures are capped (`SignatureCapError`).

## What is included

| Component | Version | Where | Notes |
|---|---|---|---|
| `@noisedlabs/sdk` | 0.9.0 | [npm](https://www.npmjs.com/package/@noisedlabs/sdk), source in [`sdk/`](https://github.com/NoisedLabs/noised/tree/main/sdk) | The first npm release. ESM, Node 22.12+ and browsers; peer dependency `@solana/web3.js` ^1.98.4. 1,700 tests in 59 files pass. [README](https://github.com/NoisedLabs/noised/blob/main/sdk/README.md), [CHANGELOG](https://github.com/NoisedLabs/noised/blob/main/sdk/CHANGELOG.md) |
| `@noisedlabs/mcp` | 0.2.0 | [npm](https://www.npmjs.com/package/@noisedlabs/mcp), source in [`packages/noised-mcp/`](https://github.com/NoisedLabs/noised/tree/main/packages/noised-mcp) | The first npm release: `npx -y @noisedlabs/mcp@0.2.0`. Built on `@noisedlabs/sdk` 0.9.0. [README](https://github.com/NoisedLabs/noised/blob/main/packages/noised-mcp/README.md) |
| Five Anchor programs | 0.1.0 (vault 0.2.0) | [`programs/`](https://github.com/NoisedLabs/noised/tree/main/programs) | Anchor 1.2.1, SBPF v3. Four deployed on devnet (below). [programs/README.md](https://github.com/NoisedLabs/noised/blob/main/programs/README.md) |
| `noised-lmots`, `noised-rules` | 0.1.0 | [`crates/`](https://github.com/NoisedLabs/noised/tree/main/crates) | `no_std` Rust crates (LM-OTS/LMS; PXR1 rules and PXG1 graphs). **crates.io: coming soon**; use them by git until then. |
| The web app | | [`app/`](https://github.com/NoisedLabs/noised/tree/main/app) | Static Vite + React, strict CSP, IPFS-deployable; a simulated-chain demo build. |
| Documentation | | [`docs/`](https://github.com/NoisedLabs/noised/blob/main/docs/README.md) | Specification, architecture, guarantees, threat model, post-quantum design, internal reviews, operations, the devnet report, QSL-1 and its proposals. |

## Programs on devnet

The program IDs are the same on every cluster. Each devnet program was deployed on 2026-10-12 from the final verified build of the audit-round-4 sources, made before the project's rename from Phalanx (the files were called `phalanx_*.so`; same program IDs). Upgrade authority: the devnet deployer `EeGcnw6yAjVC73QdjdtQDqoQgjxDpm2amLWzdoX1Kxvf`.

| Program | Program ID | Devnet | Size | SHA-256 of the deployed `.so` (= on-chain dump) |
|---|---|---|---:|---|
| `noised_launchpad` | [`CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`](https://explorer.solana.com/address/CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc?cluster=devnet) | deployed, upgradeable | 846,896 | `b20d0a610db3f3e272e148719b645c6526cabad6bf63c0ad20d204a079f7fced` |
| `noised_hook` | [`cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia`](https://explorer.solana.com/address/cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia?cluster=devnet) | deployed, upgradeable | 214,984 | `5f71b6812c62301e86bb369acfdff70d57721f61330cd78f8c5a55e0db45e141` |
| `noised_autopilot` | [`D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx`](https://explorer.solana.com/address/D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx?cluster=devnet) | deployed, upgradeable | 402,032 | `46f3a4242ac4961bdbc7e24e4ec5e0bf17d25b925706468418c0b9cd386a61ea` |
| `noised_vault` | [`7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`](https://explorer.solana.com/address/7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb?cluster=devnet) | deployed, upgradeable | 279,608 | `c3be1ece4893576f9bae8c94da5b6d7afa3338144148e90d76a4f7fcd3afb132` |
| `noised_shield` | [`BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`](https://explorer.solana.com/address/BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9?cluster=devnet) | **not deployed** | 288,640 | `1104ae12e301dab66729be44ca12ce3490f7993bb27c5fb98ab5263dd58735de` (the build kept for its deployment) |

The devnet protocol is initialized (`Protocol` `BTiVRCENNQB8wnDCbAAoufHX3EgDKG9AioTu3BiDKc5M`, platform fee 10%, treasury a wSOL PQ vault). Two test tokens launched end to end on devnet: a Custom launch with a launch rule ([`4QQ2L5ptTtrGyMqPbQ7DSiEmD58GPHKvpRcJDdbVos73`](https://explorer.solana.com/address/4QQ2L5ptTtrGyMqPbQ7DSiEmD58GPHKvpRcJDdbVos73?cluster=devnet)), refused on-chain with `RuleDenied` exactly where the rule says, and a Quick launch with a daily buyback Autopilot ([`FpV8CpGZ5bXR1iZ6Gn7UdmYs3UBGjTaBbMUuFVCXPgBB`](https://explorer.solana.com/address/FpV8CpGZ5bXR1iZ6Gn7UdmYs3UBGjTaBbMUuFVCXPgBB?cluster=devnet)), run up to the graduation buy. Graduation, migration, fees and the buyback ran only on a Surfpool fork of devnet. Every transaction and check: [docs/DEVNET.md](https://github.com/NoisedLabs/noised/blob/main/docs/DEVNET.md).

## How to verify a program build

**A deployed devnet program against the hashes above:**

```bash
solana program show CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc -u devnet
#   Authority: EeGcnw6yAjVC73QdjdtQDqoQgjxDpm2amLWzdoX1Kxvf   (upgradeable; "none" only after finalization)
#   Data Length: 846896 (0xcec30) bytes
solana program dump CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc launchpad.so -u devnet
sha256sum launchpad.so
#   b20d0a610db3f3e272e148719b645c6526cabad6bf63c0ad20d204a079f7fced
```

Repeat with each program ID. The deploys used `--max-len` equal to the `.so` size, so the dump is exactly the deployed file.

**The program builds attached to this release.** If this release has `.so` files, `SHA256SUMS` and `EXECUTABLE_HASHES`, they were built by the [release workflow](https://github.com/NoisedLabs/noised/blob/main/.github/workflows/release.yml) with `solana-verify` 0.5.2 (Docker, deterministic, SBPF v3) from the tagged commit, each with a signed build-provenance attestation:

```bash
sha256sum -c SHA256SUMS
gh attestation verify noised_launchpad.so --repo NoisedLabs/noised
solana-verify get-program-hash -u <cluster> <program id>   # equals the program's line in EXECUTABLE_HASHES only if that exact build is deployed
```

**These release builds are not the devnet binaries.** The devnet programs were built before the rename, and a build of the renamed source is not byte-identical: the source paths compiled into the programs changed (`programs/noised-*` instead of `programs/phalanx-*`), and so did the vault's payout memo (`noised-vault payout`; devnet's vault writes `phalanx-vault payout`). Instructions, discriminators, accounts, PDA seeds, errors, events and signature domain tags are unchanged, so SDK 0.9.0, the app and the MCP server work with the deployed programs. Mainnet will be deployed from verifiable builds of a tagged commit, and the deployed hashes will be published next to them.

**To reproduce a build yourself:** Agave CLI 4.3.0 (platform-tools v1.57), Rust 1.98.0, then `cargo-build-sbf --manifest-path programs/<program>/Cargo.toml --arch v3`, or `solana-verify build --library-name <program> -- --arch v3` for a deterministic Docker build. Details: [OPERATIONS.md, Verifiable builds](https://github.com/NoisedLabs/noised/blob/main/docs/OPERATIONS.md#verifiable-builds-linux-ci).

**The npm packages** are published from the release workflow with npm provenance. In your project, `npm audit signatures` checks that the packages you installed were built from this repository.

## Testing and reviews behind this release

- **Rust and Python** (the final verification run on the programs with audit round 4's fixes, 2026-10-11, overall PASS): 323 host tests, 81 for `noised-rules` with every feature, 35 LM-OTS/LMS known-answer tests, 113 integration tests, 84 launchpad, 19 Shield and 36 Autopilot LiteSVM tests against mainnet Meteora and Token-2022 binaries, four independent Python reference checks, and mutation runs that killed every killable mutant ([evidence](https://github.com/NoisedLabs/noised/blob/main/docs/evidence/2026-10-11-audit4-final-verification.md)). The LiteSVM suites also pass with devnet's own Meteora and Token-2022 binaries.
- **TypeScript:** the SDK's 1,700 tests (59 files), the MCP server's and the app's suites.
- **Internal reviews** (by AI agents, not an independent audit): rounds 1, 1b, 2, 3 and 4, the PQ v2 spec and adversarial reviews, the metadata and SDK reviews, and review 4 of the programmable launches. Audit round 4 found no exploitable issue in the launch path, the vault, the Shield or `noised-lmots`; its Autopilot findings and every client finding are fixed. Full record: [docs/AUDIT.md](https://github.com/NoisedLabs/noised/blob/main/docs/AUDIT.md).

## Known limitations

- **Not audited, not final, devnet only.** No independent audit yet; every program is upgradeable; nothing on mainnet. QSL-1 awards no level until the programs are finalized on mainnet, so every token shows "candidate" at most.
- **The Shield is not deployed on devnet**, and graduation, migration, fee distribution and the Autopilot buyback have run on devnet only on a Surfpool fork, not on devnet itself ([next steps](https://github.com/NoisedLabs/noised/blob/main/docs/DEVNET.md#next-steps-finish-flow-a-then-the-shield)).
- **Devnet's Meteora and Token-2022 are newer builds than mainnet's**, and Meteora's devnet programs are upgradeable by a single key. The test suites pass against both.
- **The crates are not on crates.io yet**; their badges show "not found" until they are.
- **One-time keys depend on their records.** Two devices that hold the same quantum key but not each other's records can still, rarely, sign at the same leaf (about 1 in 1,024 per pair of unlanded messages); nobody can steer that any more. Best practice: one device per quantum key, unless you import its records first.
- **Clock check.** The SDK compares the network's clock with this device's (and a second RPC's, when given); a device whose own clock is wrong together with an RPC that agrees with it is not caught.
- **The LangGraph keeper example** in `packages/noised-mcp/examples/langgraph-operator` does not make its own `update_price` observation before a buyback, which audit round 4 recommends (A4-1). The SDK's keeper (`planKeeperStep`, `runKeeper`) does; prefer it for anything beyond a demo.
- **Third parties stay trusted:** Meteora's upgrade multisig and operators, the Token-2022 multisig, validators and ordering gateways, your wallet, RPC and frontend ([who you still trust](https://github.com/NoisedLabs/noised/blob/main/docs/SECURITY_GUARANTEES.md#who-you-still-trust)).
- The full list of residual risks: [docs/AUDIT.md §6](https://github.com/NoisedLabs/noised/blob/main/docs/AUDIT.md#6-residual-risks-current-2026-10-11) and the [README](https://github.com/NoisedLabs/noised/blob/main/README.md#what-is-not-guaranteed).

## Upgrade and compatibility notes

- **First npm release.** `@noisedlabs/sdk` 0.9.0 and `@noisedlabs/mcp` 0.2.0 are the first versions on npm. Earlier SDK versions (0.1.0 to 0.8.0) were never published; the [CHANGELOG](https://github.com/NoisedLabs/noised/blob/main/sdk/CHANGELOG.md) records each of them. While the version is 0.x, a minor release may break the API (breaking changes are marked **BREAKING**).
- **Renamed from Phalanx.** The package is `@noisedlabs/sdk` (it was `@phalanx/sdk` during development), the IDLs are `noised_*.json`, and the identifiers `NOISED_VAULT_PROGRAM`, `NOISED_SHIELD_PROGRAM`, `noisedHookAccounts`, `HOOK_IS_NOISED` replace their `PHALANX_*` / `phalanx*` names. Nothing on-chain changed.
- **Your records come with you.** The leaf and vault-key ledgers copy records kept under `phalanx/pq/...` to their new keys before their first operation (never overwriting, never deleting), so a one-time key used by an earlier build is never used again. Exports made before the rename still import. Environment variables are `NOISED_*`; the `PHALANX_*` names are still read for one release.
- **Keys and signatures are unchanged.** Every domain tag (`phalanx/pq/...`, `PHX-...`) keeps its original spelling, so the same phrase or passkey gives the same keys and the same signatures.
- **Leaf choice changed in 0.9.0.** The SDK now starts the leaf search from a secret, keyed probe, so a given message gets a different leaf than SDK 0.8 chose. Signatures recorded by older builds are honoured from the ledger.
- **New refusals to handle** before a quantum signature: `UnknownLeavesError` (import the other device's records, or confirm with `acknowledgeUnknownLeaves` for a small count the user saw), `ClockSkewError` (fix the clock or use another RPC), `SignatureCapError` (pass `acknowledgeExtraSignatures` after the user confirms). In a browser, pass `signingLock: (name, fn) => navigator.locks.request(name, fn)`.
- **Autopilot layout.** The `Autopilot` account is 1,244 bytes, the revocation payload is version 3 (it names the running graph's approval), keepers may run partial buybacks, a distribution skips recipients without a wSOL account, and `buildRunTx` never creates recipients' accounts.
- **Plain Node.** `buildSwapTx` on the bonding curve now works under plain Node ESM (it failed with "BN is not a constructor"; bundlers were not affected).
- **Requirements:** Node.js 22.12 or later, ESM only; `@solana/web3.js` ^1.98.4 as a peer dependency.

## Reporting a vulnerability

Privately, never in a public issue: `security@noised.fun` or [GitHub private vulnerability reporting](https://github.com/NoisedLabs/noised/security/advisories/new). Scope and safe harbour: [SECURITY.md](https://github.com/NoisedLabs/noised/blob/main/SECURITY.md). Test only on local validators, LiteSVM or devnet.

## Credits

Built by NoisedLabs; implementation with Claude.

Noised builds on Meteora's Dynamic Bonding Curve and DAMM v2 (the vendored IDLs come from Meteora's MIT-licensed SDKs), Solana's Token-2022, Anchor, LiteSVM and Surfpool, and on RFC 8554 (Leighton-Micali hash-based signatures). Licensed under Apache-2.0; third-party notices are in [NOTICE](https://github.com/NoisedLabs/noised/blob/main/NOTICE).
