# Noised documentation

Everything written about Noised, the quantum security layer for Solana, in one list. Start with the [repository README](../README.md) for the overview and the project's status: the programs run on **Solana devnet only**, are **upgradeable**, and have **not been audited by a professional firm** (the reviews in [AUDIT.md](AUDIT.md) are internal).

Where a document and the code disagree, the code wins and the document is wrong: please report it ([SECURITY.md](../SECURITY.md) treats a misleading safety claim as in scope).

## Where to start

| You are | Read |
|---|---|
| Someone deciding whether to buy or hold a Noised token | [What is guaranteed and what is not](../README.md#what-is-guaranteed-in-plain-words), then [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md) and [Verify it yourself](SECURITY_GUARANTEES.md#verify-it-yourself) |
| A creator | [For creators](../README.md#for-creators-what-you-can-customize), the app's [Launch a token](../app/src/content/docs/pages/guides/launch-a-token.md) guide, [HOOKS.md](HOOKS.md) for launch rules, [SPEC §9](SPEC.md#9-autopilot-program-noised_autopilot) for the Autopilot |
| A developer building on Noised | [sdk/README.md](../sdk/README.md), [SPEC.md](SPEC.md), [ARCHITECTURE.md](ARCHITECTURE.md), [programs/README.md](../programs/README.md) |
| Running an AI agent or a keeper | [packages/noised-mcp/README.md](../packages/noised-mcp/README.md), [OPERATIONS.md, Keepers](OPERATIONS.md#keepers) |
| A wallet, explorer or indexer | [standard/QSL-1.md](standard/QSL-1.md) (the verification algorithm and badge wording), [standard/SRFC-QSL-1.md](standard/SRFC-QSL-1.md) |
| An auditor or security researcher | [SPEC §7, invariants](SPEC.md#7-invariants-audit-checklist), [THREAT_MODEL.md](THREAT_MODEL.md), [AUDIT.md](AUDIT.md) (especially §6, the residual risks), [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md), [SECURITY.md](../SECURITY.md) |
| A maintainer or contributor | [CONTRIBUTING.md](../CONTRIBUTING.md), [OPERATIONS.md](OPERATIONS.md), [DEVNET.md](DEVNET.md) |

## Design and specification

| Document | One line |
|---|---|
| [SPEC.md](SPEC.md) | The implementation contract: program IDs, PDAs, the safety policy, every instruction, account layout, error and event, the invariants, the tests each scenario maps to, and the SDK's API. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the five programs, Meteora and Token-2022 fit together: the launch lifecycle, accounts, who holds which power, money flows, the CPI graph and the design decisions. |
| [HOOKS.md](HOOKS.md) | The Launch Guard transfer hook: its decision order, the creator's launch rules (PXR1), why creators cannot bring their own hook, compute costs and caveats. |
| [POST_QUANTUM.md](POST_QUANTUM.md) | Launch identities (LMS), Autopilot authorizations and the PQ vault (LM-OTS): threat model, schemes, key derivation from a phrase or passkey, leaves and ledgers, limits, FAQ. |
| [PRIVACY.md](PRIVACY.md) | The Shield: what confidential balances hide and what they do not, which tokens can be shielded, and why its encryption is not post-quantum. |

## Security

| Document | One line |
|---|---|
| [SECURITY_GUARANTEES.md](SECURITY_GUARANTEES.md) | Every guarantee Noised claims, the code that enforces it, whether it can change, its caveats, the residuals no rule removes, who you still trust, and how to verify a launch yourself. |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Assets, actors and trust boundaries, attack trees with mitigations and residual risks, and the residual risk register (R1 to R43). |
| [AUDIT.md](AUDIT.md) | Every internal security review (rounds 1, 1b, 2, 3 and 4, the PQ v2, metadata and SDK reviews, review 4 of the programmable launches): findings, fixes, regression tests, mutation testing and residual risks. Not an independent audit. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability (`security@noised.fun` or GitHub private reporting), scope, safe harbour. |

## Operations and evidence

| Document | One line |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | Build, test, rehearse, deploy, initialize, finalize, verify, release, monitor, run keepers and respond to incidents. |
| [DEVNET.md](DEVNET.md) | The devnet deployment of 2026-10-12: program IDs and hashes, the protocol initialization, both end-to-end flows with every transaction, the Surfpool rehearsal, costs and next steps. |
| [evidence/2026-10-09-lms-cost-measurements.md](evidence/2026-10-09-lms-cost-measurements.md) | Measured compute cost of LMS verification on-chain and of `attest_launch`, and host timings. |
| [evidence/2026-10-09-metadata-final-verification.md](evidence/2026-10-09-metadata-final-verification.md) | The final verification run of the on-chain metadata stage. |
| [evidence/2026-10-10-audit3-final-verification.md](evidence/2026-10-10-audit3-final-verification.md) | The final verification run with audit round 3's program fixes. |
| [evidence/2026-10-11-p1c-merge-verification.md](evidence/2026-10-11-p1c-merge-verification.md) | The verification run of the programmable-launches merge (P1c), including its first failures and re-runs. |
| [evidence/2026-10-11-review4-final-verification.md](evidence/2026-10-11-review4-final-verification.md) | The final verification run with review 4's program fixes, and the hook's compute. |
| [evidence/2026-10-11-audit4-final-verification.md](evidence/2026-10-11-audit4-final-verification.md) | The final verification run with audit round 4's program fixes: every suite, the program sizes, the mutation runs, compute before and after. |
| [evidence/2026-10-12-devnet-run.md](evidence/2026-10-12-devnet-run.md) | The recorded results of the devnet runs: LiteSVM with devnet binaries, the Surfpool rehearsal and the live run. |

## Standard and proposals

| Document | One line |
|---|---|
| [standard/QSL-1.md](standard/QSL-1.md) | QSL-1, the token standard (draft revision 0.4): levels L1 No-rug and L2 Quantum-attested, account layouts, the verification algorithm, badge wording, test vectors. |
| [standard/SRFC-QSL-1.md](standard/SRFC-QSL-1.md) | A proposal to wallets and apps to check and show QSL-1. |
| [standard/SIMD-DRAFT-hash-based-signatures.md](standard/SIMD-DRAFT-hash-based-signatures.md) | A draft SIMD for native verification of hash-based signatures (LMS/HSS and SLH-DSA) on Solana. |

## Research

| Document | One line |
|---|---|
| [research/FACTS.md](research/FACTS.md) | The sourced facts sheet behind the design: Meteora DBC and DAMM v2, Token-2022, v1 transactions, toolchains, wallets, verification, with a source for every fact. Cited elsewhere as "FACTS #n". |

## Package and component documentation

| Document | One line |
|---|---|
| [../README.md](../README.md) | The project: what Noised is, guarantees and limits, architecture, repository map, program IDs, quick start, build and test, security, roadmap. |
| [../RELEASE_NOTES_v0.9.0.md](../RELEASE_NOTES_v0.9.0.md) | The notes of this release: SDK 0.9.0, MCP server 0.2.0 and the devnet programs. |
| [../programs/README.md](../programs/README.md) | The five programs, one section each: instructions, accounts and PDAs, invariants, errors, events. |
| [../sdk/README.md](../sdk/README.md) | `@noisedlabs/sdk`: install, quickstart, a guide by module, errors, security notes for integrators, the API reference. |
| [../sdk/src/programmable/README.md](../sdk/src/programmable/README.md) | The SDK's programmable module: the rules and graph builders and their text grammars. |
| [../sdk/CHANGELOG.md](../sdk/CHANGELOG.md) | Every SDK version's changes, breaking ones marked. |
| [../sdk/CONTRIBUTING.md](../sdk/CONTRIBUTING.md), [../sdk/SECURITY.md](../sdk/SECURITY.md) | Developing the SDK; reporting a vulnerability in it. |
| [../packages/noised-mcp/README.md](../packages/noised-mcp/README.md) | `@noisedlabs/mcp`: the MCP server for AI agents, every tool, client setup, the threat model. |
| [../packages/noised-mcp/CHANGELOG.md](../packages/noised-mcp/CHANGELOG.md) | The MCP server's changes. |
| [../crates/noised-lmots/README.md](../crates/noised-lmots/README.md) | The LM-OTS / LMS crate (RFC 8554): use on-chain and off-chain, formats, costs, test vectors. |
| [../crates/noised-rules/README.md](../crates/noised-rules/README.md) | The PXR1 / PXG1 crate: examples and the normative byte formats, verification order and parity vectors. |
| [../tests/integration/README.md](../tests/integration/README.md) | The LiteSVM integration suite and the byte vectors the SDK must match. |
| [../app/README.md](../app/README.md) | The web app: build, configuration, structure, tests. |
| [../app/src/content/docs/pages/](../app/src/content/docs/pages/) | The app's built-in developer docs: concepts (lifecycle, fair batch, launch guard, liquidity and fees, PQ identity and vault, private balances, token metadata) and guides (launch a token, commit and claim, buy into a vault, vault, keeper, verify a mint, private balances, AI agents). |
| [../CONTRIBUTING.md](../CONTRIBUTING.md), [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | How to contribute; the code of conduct. |

The project was named Phalanx before it was renamed Noised. Some recorded runs, the devnet test tokens and every signature domain tag (`phalanx/pq/...`, `PHX-...`) keep the earlier name on purpose: changing a tag would change every key and signature derived with it.
