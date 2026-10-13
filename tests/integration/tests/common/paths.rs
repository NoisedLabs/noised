//! Where the program binaries and mainnet fixtures live.
//!
//! Our programs are built by `cargo-build-sbf --arch v3` from the root
//! workspace (see README.md). A test that silently ran against an old or
//! differently-targeted build would be worse than no test, so
//! [`program_so`] fails when a `.so` is older than any of its sources (set
//! `NOISED_ALLOW_STALE_SBF=1` to override knowingly) or is not an SBPF v3
//! binary (the mainnet deployment target).

use std::{
    env,
    path::{Path, PathBuf},
    time::SystemTime,
};

/// Default location of the mainnet dumps, relative to the repository root
/// (gitignored; `scripts/fetch-fixtures.*` writes there). Override with
/// `NOISED_FIXTURES_DIR`.
const DEFAULT_FIXTURES_DIR: &str = "fixtures";

/// ELF `e_flags` value of an SBPF v3 program.
const SBPF_V3_E_FLAGS: u32 = 3;

/// One of our programs: `.so` file stem and the source trees compiled into it
/// (relative to the repository root).
///
/// Keep this exact (the program plus its on-chain path dependencies, not
/// dev-dependencies): a no-op `cargo-build-sbf` does not touch the `.so`, so
/// listing a tree the program does not depend on would report it stale forever.
struct OurProgram {
    so_name: &'static str,
    sources: &'static [&'static str],
}

const OUR_PROGRAMS: &[OurProgram] = &[
    OurProgram {
        so_name: "noised_vault",
        sources: &[
            "programs/noised-vault",
            "crates/noised-lmots",
            "crates/noised-onchain",
        ],
    },
    OurProgram {
        so_name: "noised_hook",
        sources: &["programs/noised-hook"],
    },
    // The launchpad verifies attestations with `noised-lmots` (PQ v2) and
    // creator rules with `noised-rules`, on `noised-onchain`; its hook
    // interface is written by hand (no hook crate compiled in).
    OurProgram {
        so_name: "noised_launchpad",
        sources: &[
            "programs/noised-launchpad",
            "crates/noised-lmots",
            "crates/noised-onchain",
            "crates/noised-rules",
        ],
    },
    OurProgram {
        so_name: "noised_shield",
        sources: &["programs/noised-shield"],
    },
];

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

pub fn fixtures_dir() -> PathBuf {
    env::var_os("NOISED_FIXTURES_DIR")
        .or_else(|| env::var_os("PHALANX_FIXTURES_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join(DEFAULT_FIXTURES_DIR))
}

/// A mainnet program dump, e.g. `fixture("token_2022.so")`, or an account
/// dump, e.g. `fixture("accounts/<pubkey>.json")`.
pub fn fixture(relative: &str) -> PathBuf {
    let path = fixtures_dir().join(relative);
    assert!(
        path.is_file(),
        "missing fixture {} (set NOISED_FIXTURES_DIR to the directory holding the mainnet dumps)",
        path.display()
    );
    path
}

/// Candidate directories holding `cargo-build-sbf` outputs, most explicit first.
fn sbf_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for var in ["NOISED_SBF_DIR", "PHALANX_SBF_DIR", "SBF_OUT_DIR"] {
        if let Some(dir) = env::var_os(var) {
            dirs.push(PathBuf::from(dir));
        }
    }
    // <target>/debug/deps/<test>.exe -> <target>/deploy: the same target dir
    // that `cargo-build-sbf` used when CARGO_TARGET_DIR was shared.
    if let Ok(exe) = env::current_exe() {
        if let Some(target) = exe.ancestors().nth(3) {
            dirs.push(target.join("deploy"));
        }
    }
    if let Some(dir) = env::var_os("CARGO_TARGET_DIR") {
        dirs.push(PathBuf::from(dir).join("deploy"));
    }
    dirs.push(repo_root().join("target").join("deploy"));
    dirs
}

/// Path of our program `<so_name>.so`, checked to be an SBPF v3 build at
/// least as new as every source file that goes into it.
pub fn program_so(so_name: &str) -> PathBuf {
    let file = format!("{so_name}.so");
    let dirs = sbf_dirs();
    let Some(path) = dirs.iter().map(|d| d.join(&file)).find(|p| p.is_file()) else {
        panic!(
            "{file} not found in {dirs:?}.\nBuild it first (README.md), e.g.\n  \
             cargo-build-sbf --manifest-path programs/<program>/Cargo.toml --arch v3\n\
             with CARGO_TARGET_DIR set to the same target dir as `cargo test`, or set NOISED_SBF_DIR."
        )
    };
    check_sbpf_v3(&path);
    check_fresh(so_name, &path);
    path
}

/// ELF `e_flags` (offset 48 in a 64-bit ELF header) of a program binary.
pub fn elf_e_flags(path: &Path) -> u32 {
    let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert!(
        bytes.len() >= 52 && bytes[..4] == *b"\x7fELF" && bytes[4] == 2,
        "{} is not a 64-bit ELF file",
        path.display()
    );
    u32::from_le_bytes(bytes[48..52].try_into().expect("4 bytes"))
}

fn check_sbpf_v3(so: &Path) {
    let flags = elf_e_flags(so);
    assert_eq!(
        flags,
        SBPF_V3_E_FLAGS,
        "{} is not an SBPF v3 build (e_flags = {flags}); rebuild it with `cargo-build-sbf --arch v3`",
        so.display()
    );
}

fn check_fresh(so_name: &str, so: &Path) {
    if env::var_os("NOISED_ALLOW_STALE_SBF")
        .or_else(|| env::var_os("PHALANX_ALLOW_STALE_SBF"))
        .is_some()
    {
        return;
    }
    let Some(program) = OUR_PROGRAMS.iter().find(|p| p.so_name == so_name) else {
        return;
    };
    let built = modified(so).expect("read .so mtime");
    let root = repo_root();
    for source in program.sources {
        if let Some((newest, file)) = newest_file(&root.join(source)) {
            assert!(
                newest <= built,
                "{} is older than {} - rebuild it with cargo-build-sbf --arch v3 (or set NOISED_ALLOW_STALE_SBF=1)",
                so.display(),
                file.display()
            );
        }
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    path.metadata().and_then(|m| m.modified()).ok()
}

/// Newest `.rs` / `Cargo.toml` under `dir`, skipping build output.
fn newest_file(dir: &Path) -> Option<(SystemTime, PathBuf)> {
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                // Host-only trees never reach the .so.
                if !["target", "tests", "examples", "benches"]
                    .iter()
                    .any(|s| name == *s)
                {
                    stack.push(path);
                }
                continue;
            }
            let is_source = path.extension().is_some_and(|e| e == "rs") || name == "Cargo.toml";
            if !is_source {
                continue;
            }
            if let Some(m) = modified(&path) {
                if newest.as_ref().is_none_or(|(t, _)| m > *t) {
                    newest = Some((m, path));
                }
            }
        }
    }
    newest
}
