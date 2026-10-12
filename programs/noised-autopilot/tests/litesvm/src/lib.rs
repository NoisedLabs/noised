//! LiteSVM tests for the Noised autopilot live in `tests/`
//! (`autopilot.rs`: the whole life of an autopilot on a launch made,
//! graduated and migrated by the launchpad against mainnet DBC, DAMM v2 and
//! Token-2022: every instruction, every action, every refusal, compute and
//! transaction sizes; `invariants.rs`: random histories of runs, trades,
//! inflows and graph changes in which value leaves the treasury only to the
//! allowed sinks; `review_fixes.rs`: the programs review's scenarios;
//! `audit4.rs`: audit round 4's (partial buybacks, revocations of the
//! current activation, burn tips, recipients without accounts);
//! `cross_program.rs`: the launchpad's `pq_authorize` driving graph
//! changes).
//!
//! They reuse the launchpad's LiteSVM harness
//! (`programs/noised-launchpad/tests/litesvm/tests/common`) and load our
//! SBPF v3 builds (launchpad, hook, vault, autopilot) from
//! `NOISED_SBF_DIR`, plus the mainnet program and account dumps
//! (`NOISED_FIXTURES_DIR`, default `<repo>/fixtures`):
//!
//! ```text
//! cargo-build-sbf --manifest-path programs/noised-hook/Cargo.toml --arch v3
//! cargo-build-sbf --manifest-path programs/noised-vault/Cargo.toml --arch v3
//! cargo-build-sbf --manifest-path programs/noised-launchpad/Cargo.toml --arch v3
//! cargo-build-sbf --manifest-path programs/noised-autopilot/Cargo.toml --arch v3
//! NOISED_SBF_DIR=<that CARGO_TARGET_DIR>/deploy CARGO_TARGET_DIR=<another dir> \
//!   cargo test --manifest-path programs/noised-autopilot/tests/litesvm/Cargo.toml
//! ```
//!
//! `cross_program.rs` drives `activate`, `revoke_operator` and `freeze`
//! with `Authorization` accounts the launchpad build writes itself
//! (`pq_authorize`: an LMS signature by the launch's identity, verified
//! on-chain). The other tests write authorizations by hand, byte for byte
//! in that same layout (`ap::put_authorization`), owned by the launchpad at
//! their canonical address, to choose their slots freely.
