# Build all five programs for SBPF v3 and run every Rust test suite (the host
# tests, the rules crate with all features, the LM-OTS known answers and the
# four LiteSVM suites: integration, launchpad, shield, autopilot).
#
# usage: scripts/test-all.ps1 [-Root <build dir>]
#
# -Root (default: $env:NOISED_BUILD_ROOT, else <repo>\target) holds one target
# dir per workspace (target-sbf, target-host, target-it, ...). The builds need
# tens of GB: point it at a drive with enough free space.
# Before building, the script dot-sources $env:NOISED_ENV_SCRIPT, or
# <Root>\env.ps1 when that file exists: an optional machine-local script that
# puts MSVC and the Agave 4.3.0 CLI on PATH.
# Mainnet dumps come from $env:NOISED_FIXTURES_DIR, default <Root>\fixtures
# when it exists, else <repo>\fixtures (written by scripts/fetch-fixtures.ps1).
#
# Each Cargo workspace gets its own target dir: the program crates are
# cdylib+lib, so their rlibs are not hashed and a shared target dir would mix
# builds from different workspaces (root vs. the LiteSVM test workspaces).
param(
    [string]$Root = $(if ($env:NOISED_BUILD_ROOT) { $env:NOISED_BUILD_ROOT } elseif ($env:PHALANX_BUILD_ROOT) { $env:PHALANX_BUILD_ROOT } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'target' })
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($env:NOISED_ENV_SCRIPT) { . $env:NOISED_ENV_SCRIPT } elseif (Test-Path "$Root\env.ps1") { . "$Root\env.ps1" }
# Fewer parallel rustc processes keep memory use reasonable on 16 GB machines.
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '6' }
$sbf = Join-Path $Root 'target-sbf'
# The PHALANX_* names (before the rename to Noised) are still accepted for one release.
if (-not $env:NOISED_FIXTURES_DIR -and $env:PHALANX_FIXTURES_DIR) { $env:NOISED_FIXTURES_DIR = $env:PHALANX_FIXTURES_DIR }
if (-not $env:NOISED_FIXTURES_DIR) {
    $env:NOISED_FIXTURES_DIR = $(if (Test-Path (Join-Path $Root 'fixtures')) { Join-Path $Root 'fixtures' } else { Join-Path $repo 'fixtures' })
}
$results = [ordered]@{}

function Step($name, [scriptblock]$body) {
    Write-Host "==> $name" -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $body
    $ok = $LASTEXITCODE -eq 0
    $results[$name] = '{0} ({1:N0}s)' -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $sw.Elapsed.TotalSeconds
    if (-not $ok) { Write-Host "FAILED: $name" -ForegroundColor Red }
}

$env:CARGO_TARGET_DIR = $sbf
foreach ($p in 'noised-hook', 'noised-vault', 'noised-launchpad', 'noised-shield', 'noised-autopilot') {
    Step "build $p (SBPF v3)" { cargo-build-sbf --manifest-path "programs/$p/Cargo.toml" --arch v3 }
}
$env:NOISED_SBF_DIR = Join-Path $sbf 'deploy'

$env:CARGO_TARGET_DIR = Join-Path $Root 'target-host'
Step 'host unit tests (root workspace)' { cargo test --workspace --locked }
Step 'rules crate, all features (alloc, std, sha2-backend)' { cargo test -p noised-rules --all-features --locked }
Step 'LM-OTS RFC 8554 known-answer tests' { cargo test -p noised-lmots --features signer,sha2-backend --locked }

$env:CARGO_TARGET_DIR = Join-Path $Root 'target-it'
Step 'integration tests (tests/integration)' { cargo test --manifest-path tests/integration/Cargo.toml }

$env:CARGO_TARGET_DIR = Join-Path $Root 'target-lp-svm'
Step 'launchpad tests (LiteSVM: lifecycle, audits, PQ v2, rules)' { cargo test --manifest-path programs/noised-launchpad/tests/litesvm/Cargo.toml -- --test-threads=1 }

$env:CARGO_TARGET_DIR = Join-Path $Root 'target-sh-svm'
Step 'shield tests (LiteSVM)' { cargo test --manifest-path programs/noised-shield/tests/litesvm/Cargo.toml }

$env:CARGO_TARGET_DIR = Join-Path $Root 'target-ap-svm'
Step 'autopilot tests (LiteSVM: actions, refusals, invariants)' { cargo test --manifest-path programs/noised-autopilot/tests/litesvm/Cargo.toml }

# Independent (standard-library Python) cross-checks of the LMS crate and of
# the SDK's launch-attestation vectors.
if (Get-Command python -ErrorAction SilentlyContinue) {
    Step 'LMS: RFC 8554 Appendix F, independent check' { python -I scripts/pq/lms_reference.py appendix-f crates/noised-lmots/tests/rfc8554_appendix_f.json }
    Step 'LMS: attestation vectors, independent check' { python -I scripts/pq/lms_reference.py attest-vectors tests/integration/vectors/lms.json }
    Step 'programmable vectors, independent check' { python -I scripts/pq/lms_reference.py programmable-vectors tests/integration/vectors/programmable.json }
} else {
    Write-Host 'python not found: skipping the independent LMS checks' -ForegroundColor Yellow
}

Write-Host ''
$results.GetEnumerator() | ForEach-Object { '{0,-45} {1}' -f $_.Key, $_.Value }
if ($results.Values | Where-Object { $_ -like 'FAIL*' }) { exit 1 }
