//! LiteSVM tests for the Noised launchpad live in `tests/`
//! (`smoke.rs`: launch, certificate, batch, fees; `lifecycle.rs`: curve
//! completion, migration to DAMM v2, LP fees, burn; `audit_regressions.rs`:
//! the first audit's launchpad attacks L1-L3 and the review's follow-ups,
//! replayed; `audit_round2.rs`: the second audit's write-lock windows, the
//! snipe shield the batch ends and the batch-cap floors; `audit_round3.rs`:
//! the third audit's fixes (an attestation whose window passed unused is
//! replaced, a window needs a minute left when its attestation lands, and
//! while the guard runs tokens go only into accounts whose owner can never
//! change), with its PoCs ported; `pq_v2.rs`: the
//! post-quantum attestation every launch needs and the window it fixes
//! (anyone launches inside it, nobody outside), signatures that only burn
//! their leaf, creator-seeded launch addresses, payout owners fixed at the
//! first commit (a vault held to one wallet's cap), the PQ vault treasury
//! and buys straight into PQ vaults, with the adversarial review's findings
//! as `review_*` tests; `metadata.rs`: the on-chain metadata record end to
//! end in each uri mode, the real mint's TokenMetadata, the SDK's metadata
//! vectors, DBC's heap at the largest inline uri, `launch`'s compute and
//! its post-condition on the mint, the record account `attest_launch` binds
//! to the signed hash, and the largest metadata mints through migration to
//! DAMM v2); `rules.rs`: the creator's launch rules (PXR1) end to end:
//! `publish_rules`, attestation v3 binding them, `launch` installing them in
//! the hook policy (certificate v4, `RULES_BOUND`), and the hook deciding
//! real DBC buys and wallet transfers with them after every built-in
//! refusal, never sells, claims, the batch or anything after the guard,
//! also for random verified rule sets,
//! with the compute at the largest rule set; `pq_authorize.rs`: the
//! generic post-quantum authorizations the autopilot reads, one leaf bitmap
//! with attestations; `audit_round4.rs`: a buy completing the curve during
//! the snipe shield is refused, and no commit follows the batch).
//!
//! They load our SBPF v3 builds (launchpad, hook, vault) plus the mainnet
//! program and account dumps (`NOISED_FIXTURES_DIR`, default
//! `<repo>/fixtures`):
//!
//! ```text
//! cargo-build-sbf --manifest-path programs/noised-hook/Cargo.toml --arch v3
//! cargo-build-sbf --manifest-path programs/noised-vault/Cargo.toml --arch v3
//! cargo-build-sbf --manifest-path programs/noised-launchpad/Cargo.toml --arch v3
//! NOISED_SBF_DIR=<that CARGO_TARGET_DIR>/deploy CARGO_TARGET_DIR=<another dir> \
//!   cargo test --manifest-path programs/noised-launchpad/tests/litesvm/Cargo.toml
//! ```
//!
//! Every launch is attested by the test creator's LMS identity (generated
//! once per test binary; `noised-lmots` and `sha2` build with `opt-level =
//! 3`), sent as the SDK sends it: a v1 transaction from a throwaway fee
//! payer.
//!
//! Use a target dir of its own for this workspace: path crates (the programs)
//! get the same artifact names in both workspaces, so host builds of the root
//! workspace in a shared target dir would replace the rlibs linked here.
