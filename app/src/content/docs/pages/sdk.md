---
title: SDK reference
nav: Overview
summary: Every export of @noisedlabs/sdk, grouped by module, with signatures and documentation generated from the SDK source.
---

The reference pages are generated at build time from `sdk/src/index.ts` and the JSDoc of each declaration (`app/scripts/gen-docs-reference.mjs`), plus the integrator notes of the SDK's README. A test fails when an export is missing or a module has no reference group, so they never drift from the code.

## Conventions

- **Types.** camelCase mirrors of the on-chain structs; `bigint` for every u64, u128 and i64; `PublicKey`, `Transaction` and `Connection` from `@solana/web3.js` 1.98.
- **Time.** Every "now" is a `bigint` of unix seconds named `nowSecs`. A `number` throws a `TypeError` and a millisecond value a `RangeError`. `clusterUnixTime(conn)` reads the cluster's clock, which is what the programs compare with.
- **Builders never send.** A `build…Tx` function returns an unsigned legacy `Transaction` unless stated. The exceptions are explicit: `buildLaunchTx` is partially signed by the fresh mint keypair, and the publish, attest and withdraw builders return **signed v1 wire bytes** (`Uint8Array`) from a throwaway fee payer. Nothing reaches the network unless you call a `send…` function.
- **Builders refuse** what the programs would refuse deterministically (invalid parameters and records, caps, windows judged on the cluster clock, vault sequence, recipients, guard rules) with a plain-English reason that names the program error it pre-empts. Balances are left to simulation: run `simulateAndExplain` before every signature.
- **Fees and compute.** Builders set tight, measured compute-unit limits (`COMPUTE_UNITS`) and take `{ computeUnitPrice?, computeUnitLimit? }` for a priority fee.
- **IDL-driven.** Every account decode and instruction encode is driven by the program IDLs in `src/idl/`, so account order and signer and writable flags come from the programs themselves.
- **No network in tests.** The SDK's test suite runs without a network and checks byte parity with Rust-produced vectors: vault keys, messages and signatures, LMS identities and attestations, and every metadata record, address and account byte.

## Modules

::figure sdk-groups

## Security notes for integrators

- **Verify before you trust.** Show `verifyLaunch` to users before they buy; treat `overall: "fail"` as not a safe Noised launch; run it against two RPC providers for large decisions; disclose `trustedParties`. Show a launch's post-quantum origin and its icon, description and links only when `report.pqOrigin.verified` and `report.metadata.verified` are true.
- **Read records only through the attestation or the certificate.** Anyone can publish records under a launch; never find one with `getProgramAccounts`. Render the icon only as an `<img>` of its `data:image/png` uri, and the text and links only as text.
- **Simulate before you sign.** Refuse to sign if `unknownPrograms` is non-empty, if the signers or writable accounts are not what the user expects, or if the size exceeds the limit. Never modify a transaction after `buildLaunchTx`, `buildRefundFeePayerTx` or `buildSweepPayerTx`.
- **Never sign twice with a one-time key.** Every PQ signing call takes a durable ledger (the leaf ledger for identities, the vault-key ledger for vaults) on a store with an atomic add, reserves the key before any signature exists and records the signature before it returns it. Re-broadcast recorded signatures; never sign while a vault's history search is incomplete; move records between devices before a second device signs.
- **Check recipients, and have the user confirm them.** Vault signers require `checkRecipient`'s result and the user's three separate acknowledgments (`confirm`). Fee recipients go through `checkFeeRecipients`.
- **Attest carefully.** Sign only a finalized launch with the parameters you reviewed, a record that is published and finalized, and a window with time to spare; check the attestation after it lands instead of assuming it attested; on `ConstraintSeeds` resend the same signature.
- **Keep secrets in memory.** The PQ phrase (or passkey) is separate from any wallet; `master` and `skSeed` never leave memory and are wiped after use. Do not mutate `master` while a call that takes it runs.
