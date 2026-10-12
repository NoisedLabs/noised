"""Mutation check for crates/noised-lmots (the LMS module and its LM-OTS base).

Each mutant is applied to a scratch copy of the crate (outside the repository)
and must make `cargo test -p noised-lmots --features signer,sha2-backend`
fail; every mutant must be killed. The repository is never written.

  python -I scripts/pq/lms_mutants.py [label ...]

Environment: NOISED_LMS_MUTANTS_DIR (scratch dir outside the repository,
default <NOISED_BUILD_ROOT>/mutants/lms, else <system temp>/noised-mutants/lms)
and NOISED_ENV_SCRIPT (optional PowerShell build environment dot-sourced
before cargo, default <NOISED_BUILD_ROOT>/env.ps1 when set). Windows
PowerShell runs cargo. If a pattern no longer matches exactly once, the script stops: update
the mutant instead of dropping it.
"""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Machine-local locations come from the environment; nothing is hard-coded.
# NOISED_BUILD_ROOT: base for build output and scratch dirs (optional).
BUILD_ROOT = os.environ.get("NOISED_BUILD_ROOT", os.environ.get("PHALANX_BUILD_ROOT", ""))


def default_scratch(name):
    """Scratch dir outside the repository: <NOISED_BUILD_ROOT>/mutants/<name>, else the system temp dir."""
    base = os.path.join(BUILD_ROOT, "mutants") if BUILD_ROOT else os.path.join(tempfile.gettempdir(), "noised-mutants")
    return os.path.join(base, name)


WORK = os.path.abspath(os.environ.get("NOISED_LMS_MUTANTS_DIR", os.environ.get("PHALANX_LMS_MUTANTS_DIR", default_scratch("lms"))))
ENV_SCRIPT = os.environ.get("NOISED_ENV_SCRIPT", os.environ.get("PHALANX_ENV_SCRIPT", os.path.join(BUILD_ROOT, "env.ps1") if BUILD_ROOT else ""))
WS = os.path.join(WORK, "ws")
CRATE = os.path.join(WS, "noised-lmots")

# (file, original, mutant, label)
MUTANTS = [
    ("src/lms.rs", "if node.is_multiple_of(2) {", "if !node.is_multiple_of(2) {", "path order"),
    ("src/lms.rs", "let parent = (node / 2).to_be_bytes();", "let parent = node.to_be_bytes();", "parent node number"),
    ("src/lms.rs", "let mut tmp = H::hashv(&[id, &node.to_be_bytes(), &D_LEAF, kc]);", "let mut tmp = H::hashv(&[id, &node.to_be_bytes(), &D_INTR, kc]);", "verify leaf tag"),
    ("src/lms.rs", "pub const D_LEAF: [u8; 2] = [0x82, 0x82];", "pub const D_LEAF: [u8; 2] = [0x82, 0x83];", "D_LEAF value"),
    ("src/lms.rs", "pub const D_INTR: [u8; 2] = [0x83, 0x83];", "pub const D_INTR: [u8; 2] = [0x83, 0x82];", "D_INTR value"),
    ("src/lms.rs", "if constant_time_eq(&root, &pk.root) {", "if constant_time_eq(&root, &root) {", "root comparison skipped"),
    ("src/lms.rs", "        let q = be32(sig, 0);\n        if q >= LMS_LEAVES {", "        let q = be32(sig, 0);\n        if q > LMS_LEAVES {", "parse q bound"),
    ("src/lms.rs", "            || be32(sig, OTS_TYPE_AT) != LMS_OTS_TYPE\n", "", "parse OTS type"),
    ("src/lms.rs", "            || be32(sig, LMS_TYPE_AT) != LMS_TYPE\n", "", "parse LMS type"),
    ("src/lms.rs", "            || be32(bytes, 0) != LMS_TYPE\n", "", "pk LMS type"),
    ("src/lms.rs", "            || be32(bytes, 4) != LMS_OTS_TYPE\n", "", "pk OTS type"),
    ("src/lms.rs", "if sig.len() != LMS_SIG_LEN", "if sig.len() < LMS_SIG_LEN", "signature length"),
    ("src/lms.rs", "        if lms_verify::<H>(&self.public_key().to_bytes(), msg, &sig) != Some(q) {\n            return None;\n        }\n", "", "self-verify removed"),
    ("src/lms.rs", "*node = nodes[(r ^ 1) as usize];", "*node = nodes[r as usize];", "auth path sibling"),
    ("src/lms.rs", "            &nodes[2 * r],\n            &nodes[2 * r + 1],", "            &nodes[2 * r + 1],\n            &nodes[2 * r],", "tree child order"),
    ("src/lms.rs", "path[1..].copy_from_slice(&identity_index.to_le_bytes());", "path[1..].copy_from_slice(&identity_index.to_be_bytes());", "derivation index endianness"),
    ("src/lms.rs", " || master.iter().all(|&b| b == 0)", "", "zero master accepted"),
    ("src/lms.rs", "if cluster > MAX_IDENTITY_CLUSTER", "if cluster > MAX_IDENTITY_CLUSTER + 1", "cluster bound"),
    ("src/lms.rs", "let seed = H::hashv(&[IDENTITY_SEED_TAG, master, &path]);", "let seed = H::hashv(&[IDENTITY_ID_TAG, master, &path]);", "seed tag"),
    ("src/lms.rs", "H::hashv(&[&[DOMAIN_IDENTITY_ID], pk])", "H::hashv(&[pk])", "identity domain byte"),
    ("src/lms.rs", "                    q,\n                    seed: self.seed,\n                }\n                .public_key::<H>()", "                    q: q ^ 1,\n                    seed: self.seed,\n                }\n                .public_key::<H>()", "keygen leaf index"),
    ("src/lms.rs", "let c = self.private_key.leaf(q)?.randomizer::<H>(msg);", "let c = self.private_key.leaf(q ^ 1)?.randomizer::<H>(msg);", "randomizer leaf"),
    ("src/lms.rs", "    pub fn leaf(&self, q: u32) -> Option<PrivateKey> {\n        if q >= LMS_LEAVES {", "    pub fn leaf(&self, q: u32) -> Option<PrivateKey> {\n        if q > LMS_LEAVES {", "leaf bound"),
    ("src/lms.rs", "    pub fn auth_path(&self, q: u32) -> Option<[[u8; N]; LMS_HEIGHT as usize]> {\n        if q >= LMS_LEAVES {", "    pub fn auth_path(&self, q: u32) -> Option<[[u8; N]; LMS_HEIGHT as usize]> {\n        if q > LMS_LEAVES {", "auth path bound"),
    ("src/lms.rs", "        Some(sig.q)\n", "        Some(0)\n", "returned leaf"),
    ("src/lms.rs", "let mut node = (1u32 << (path.len() / N)) + q;", "let mut node = (1u32 << (path.len() / N)) + (q & !1);", "leaf node number"),
    ("src/lms.rs", "            root: self.nodes[1],", "            root: self.nodes[2],", "public key root"),
    ("src/lms.rs", "        &self.nodes[1..]\n", "        &self.nodes[..LMS_TREE_NODES]\n", "nodes() offset"),
    ("src/lib.rs", "        diff |= x ^ y;", "        diff = x ^ y;", "constant_time_eq accumulation"),
    ("src/lms.rs", "        sig[..OTS_TYPE_AT].copy_from_slice(&q.to_be_bytes());", "        sig[..OTS_TYPE_AT].copy_from_slice(&(q ^ 1).to_be_bytes());", "signed q field"),
    ("src/lms.rs", "        let leaf = self.private_key.leaf(q)?;", "        let leaf = self.private_key.leaf(q ^ 1)?;", "signing leaf key"),
]


def sync():
    if WORK.lower().startswith(REPO.lower()):
        raise SystemExit("NOISED_LMS_MUTANTS_DIR must be outside the repository")
    if os.path.exists(WS):
        shutil.rmtree(WS)
    os.makedirs(WS)
    shutil.copy(os.path.join(REPO, "Cargo.lock"), WS)
    with open(os.path.join(WS, "Cargo.toml"), "w", newline="\n") as f:
        f.write(
            '[workspace]\nmembers = ["noised-lmots"]\nresolver = "2"\n\n'
            '[workspace.package]\nedition = "2021"\nlicense = "Apache-2.0"\n\n'
            "[profile.dev.package.sha2]\nopt-level = 3\n\n"
            "[profile.dev.package.noised-lmots]\nopt-level = 3\n"
        )
    # shutil.copy, not copy2: fresh mtimes, so cargo never reuses a build of a
    # previous mutant.
    shutil.copytree(os.path.join(REPO, "crates", "noised-lmots"), CRATE, copy_function=shutil.copy)


def run_tests():
    cmd = (
        f"if ('{ENV_SCRIPT}' -and (Test-Path '{ENV_SCRIPT}')) {{ . '{ENV_SCRIPT}' }}; $env:CARGO_BUILD_JOBS='4'; $env:CARGO_NET_OFFLINE='true'; "
        f"$env:CARGO_TARGET_DIR='{WORK}\\target'; Set-Location '{WS}'; "
        "cargo test --no-fail-fast -p noised-lmots --features signer,sha2-backend 2>&1 | Out-String; exit $LASTEXITCODE"
    )
    p = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=1800)
    return p.returncode, p.stdout + p.stderr


def main():
    only = set(sys.argv[1:])
    sync()
    code, out = run_tests()
    if code != 0:
        print(out[-4000:])
        raise SystemExit("baseline fails")
    print("baseline passes", flush=True)
    survivors = []
    for path, old, new, label in MUTANTS:
        if only and label not in only:
            continue
        full = os.path.join(CRATE, path.replace("/", os.sep))
        src = open(full, encoding="utf-8").read()
        if src.count(old) != 1:
            raise SystemExit(f"mutant '{label}': pattern matches {src.count(old)} times")
        open(full, "w", encoding="utf-8", newline="\n").write(src.replace(old, new))
        code, out = run_tests()
        open(full, "w", encoding="utf-8", newline="\n").write(src)
        failed = [l.split()[1] for l in out.splitlines() if l.strip().startswith("test ") and l.strip().endswith("FAILED")]
        if code == 0:
            survivors.append(label)
            print(f"SURVIVED  {label}", flush=True)
        elif "could not compile" in out:
            print(f"killed    {label}  (compile error)", flush=True)
        else:
            print(f"killed    {label}  ({len(failed)} failing, e.g. {', '.join(failed[:3])})", flush=True)
    print(f"{len(survivors)} survivor(s) {survivors}")
    if survivors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
