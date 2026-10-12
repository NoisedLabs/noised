//! Noised integration tests on LiteSVM. This library is empty on purpose:
//! the suites live in `tests/` (`vault.rs`, `hook.rs`, `harness.rs`, the
//! SDK vector generators `sdk_vectors.rs`, `lms_vectors.rs` and
//! `metadata_vectors.rs`, `vectors_onchain.rs`, which runs those vectors on
//! the program builds, and `metadata_record.rs`, the launchpad's on-chain
//! metadata record end to end against mainnet DBC) and share the harness in
//! `tests/common/`. See `README.md` for building the programs
//! (`cargo-build-sbf --arch v3`) and running the tests.
