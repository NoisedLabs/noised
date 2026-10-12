# Deploy one Noised program to Solana DEVNET as an upgradeable program and
# verify it (authority, data length, and the SHA-256 of the on-chain bytes
# against the local .so).
#
# usage (PowerShell 5.1+, with the Agave 4.3.0 solana CLI on PATH, e.g. after
#  dot-sourcing your $env:NOISED_ENV_SCRIPT):
#   $env:NOISED_DEVNET_DEPLOYER = '<path to the devnet deployer keypair>'
#   $env:NOISED_SBF_DIR         = '<dir with the verified noised_*.so builds>'
#   $env:NOISED_DEVNET_DIR      = '<scratch dir for buffers, logs, ledger>'
#   scripts\devnet\deploy.ps1 -Program noised_hook
#
# * The PHALANX_* names of these variables (before the rename to Noised) are
#   still read for one release, and so are builds and keypairs saved under
#   the earlier phalanx_<program> file names.
#
# * Devnet only: the script refuses any cluster whose genesis hash is not
#   devnet's, and always passes `-u devnet` (never relies on solana config).
# * The program keypair comes from .keys\<program>-keypair.json (gitignored);
#   its pubkey must equal the program's declare_id! (read from Anchor.toml).
# * --max-len is the exact .so size; upgrade authority = the deployer.
# * Writes go through a buffer keypair kept in $NOISED_DEVNET_DIR\buffers, so
#   a failed deploy resumes by re-running the same command (the CLI skips
#   chunks already written), or is refunded with
#   `solana program close <buffer address> -u devnet --keypair <deployer>`.
# * Refuses to start when the balance after rent and a fee margin would fall
#   below -ReserveSol. Appends a row to $NOISED_DEVNET_DIR\ledger.md.
# * Never prints key material: the CLI output is filtered for seed phrases.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('noised_hook', 'noised_launchpad', 'noised_autopilot', 'noised_vault', 'noised_shield')]
    [string]$Program,
    [string]$SoDir = $(if ($env:NOISED_SBF_DIR) { $env:NOISED_SBF_DIR } else { $env:PHALANX_SBF_DIR }),
    [string]$Deployer = $(if ($env:NOISED_DEVNET_DEPLOYER) { $env:NOISED_DEVNET_DEPLOYER } else { $env:PHALANX_DEVNET_DEPLOYER }),
    [string]$WorkDir = $(if ($env:NOISED_DEVNET_DIR) { $env:NOISED_DEVNET_DIR } else { $env:PHALANX_DEVNET_DIR }),
    [string]$KeysDir = '',
    [double]$ReserveSol = 0.3,
    [int]$ComputeUnitPrice = 1000,
    # 'rpc' sends writes through the RPC (--use-rpc); 'tpu' lets the CLI send
    # them to the leaders (its default). The public devnet RPC rate-limits
    # sendTransaction, so 'tpu' is the default here.
    [ValidateSet('tpu', 'rpc')][string]$Send = 'tpu'
)
$ErrorActionPreference = 'Continue'  # PS 5.1: native stderr under 2>&1 must not throw
$DevnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $KeysDir) { $KeysDir = Join-Path $repo '.keys' }
foreach ($v in @(@('SoDir', $SoDir), @('Deployer', $Deployer), @('WorkDir', $WorkDir))) {
    if (-not $v[1]) { throw "missing -$($v[0]) (or its NOISED_* environment variable)" }
}
$so = Join-Path $SoDir "$Program.so"
# Builds made before the rename to Noised are named phalanx_<program>.so (the programs already on devnet run
# those bytes, see docs/DEVNET.md): accepted for one release when no noised_<program>.so is in -SoDir.
$legacySo = Join-Path $SoDir "$($Program -replace '^noised_', 'phalanx_').so"
if (-not (Test-Path $so) -and (Test-Path $legacySo)) { $so = $legacySo }
$programKey = Join-Path $KeysDir "$Program-keypair.json"
# Program keypairs saved before the rename to Noised keep their earlier file name (phalanx_<program>-keypair.json):
# accepted for one release. The program id is checked against Anchor.toml below either way.
$legacyKey = Join-Path $KeysDir "$($Program -replace '^noised_', 'phalanx_')-keypair.json"
if (-not (Test-Path $programKey) -and (Test-Path $legacyKey)) { $programKey = $legacyKey }
foreach ($f in $so, $programKey, $Deployer) { if (-not (Test-Path $f)) { throw "not found: $f" } }
New-Item -ItemType Directory -Force (Join-Path $WorkDir 'buffers'), (Join-Path $WorkDir 'logs') | Out-Null
$log = Join-Path $WorkDir "logs\deploy-$Program.log"
$ledger = Join-Path $WorkDir 'ledger.md'

function Say([string]$s) { [IO.File]::AppendAllText($log, "$s`r`n"); Write-Output $s }
# Seed phrases (12 or 24 lowercase words on a line) never reach the console or the log.
function Redact([string]$line) {
    if ($line -match '^\s*([a-z]+\s+){11,23}[a-z]+\s*$') { return '[redacted: seed phrase]' }
    return $line
}
function Sol([string]$addr) {
    $out = solana balance $addr -u devnet --lamports 2>&1 | Out-String
    if ($out -notmatch '(\d+) lamports') { throw "balance query failed: $out" }
    return [int64]$Matches[1]
}

$genesis = (solana genesis-hash -u devnet 2>&1 | Out-String).Trim()
if ($genesis -ne $DevnetGenesis) { throw "refusing: genesis hash '$genesis' is not devnet's" }

# The program id must be the declare_id! pinned in Anchor.toml.
$programId = (solana address -k $programKey 2>&1 | Out-String).Trim()
$anchorToml = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'Anchor.toml')
if ($anchorToml -notmatch "(?m)^\s*$Program\s*=\s*`"$programId`"") {
    throw "program keypair $programId does not match Anchor.toml's id for $Program"
}
$deployerId = (solana address -k $Deployer 2>&1 | Out-String).Trim()
$size = (Get-Item $so).Length
$localHash = (Get-FileHash $so -Algorithm SHA256).Hash.ToLower()
Say "== $Program $programId  size $size  sha256 $localHash  deployer $deployerId  $(Get-Date -Format s)"

# Already deployed with these exact bytes? Then only verify.
$existing = solana program show $programId -u devnet --output json 2>&1 | Out-String
$alreadyDeployed = $existing -match '"programdataAddress"'

$before = Sol $deployerId
if (-not $alreadyDeployed) {
    $rentOut = solana rent ($size + 45) -u devnet --lamports 2>&1 | Out-String
    if ($rentOut -notmatch '(\d+) lamports') { throw "rent query failed: $rentOut" }
    $rent = [int64]$Matches[1]
    $rentOut = solana rent 36 -u devnet --lamports 2>&1 | Out-String
    $null = $rentOut -match '(\d+) lamports'; $rent += [int64]$Matches[1]
    # Fee margin: one ~1 KB write per transaction at 5,000 lamports, doubled, plus 0.01 SOL.
    $fees = [int64]([math]::Ceiling($size / 1000) * 10000) + 10000000
    $after = $before - $rent - $fees
    Say ("balance {0:N9} SOL; rent {1:N9}; fee margin {2:N9}; worst case after {3:N9}" -f ($before / 1e9), ($rent / 1e9), ($fees / 1e9), ($after / 1e9))
    if ($after -lt [int64]($ReserveSol * 1e9)) { throw "refusing: the deploy would leave less than the $ReserveSol SOL reserve" }

    $buffer = Join-Path $WorkDir "buffers\$Program-buffer.json"
    if (-not (Test-Path $buffer)) {
        solana-keygen new --no-bip39-passphrase --silent --outfile $buffer | Out-Null
    }
    $bufferId = (solana address -k $buffer 2>&1 | Out-String).Trim()
    Say "buffer $bufferId (re-run to resume; refund with: solana program close $bufferId -u devnet --keypair <deployer>)"
    $deployArgs = @('program', 'deploy', $so, '--program-id', $programKey, '--buffer', $buffer,
        '--keypair', $Deployer, '--upgrade-authority', $Deployer, '-u', 'devnet',
        '--max-len', "$size", '--with-compute-unit-price', "$ComputeUnitPrice")
    if ($Send -eq 'rpc') { $deployArgs += '--use-rpc' }
    & solana @deployArgs 2>&1 | ForEach-Object { Say (Redact "$_") }
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $after = Sol $deployerId
        Say ("DEPLOY FAILED (exit $code). Balance now {0:N9} SOL; buffer $bufferId kept for resume/refund." -f ($after / 1e9))
        exit 1
    }
}

# Verify: upgradeable, authority = deployer, data length = max-len, bytes = local .so.
$show = solana program show $programId -u devnet --output json 2>&1 | Out-String
$info = $show | ConvertFrom-Json
$dump = Join-Path $WorkDir "logs\$Program.devnet-dump.so"
solana program dump $programId $dump -u devnet 2>&1 | Out-Null
$dumpBytes = [IO.File]::ReadAllBytes($dump)
$localBytes = [IO.File]::ReadAllBytes($so)
# The dump is the ProgramData account minus its header, i.e. max-len bytes:
# the .so followed by zero padding (none when max-len = .so size).
$sha = [Security.Cryptography.SHA256]::Create()
$dumpHash = ([BitConverter]::ToString($sha.ComputeHash($dumpBytes)) -replace '-', '').ToLower()
$prefixOk = $dumpBytes.Length -ge $localBytes.Length
for ($i = 0; $prefixOk -and $i -lt $localBytes.Length; $i++) { if ($dumpBytes[$i] -ne $localBytes[$i]) { $prefixOk = $false } }
$paddingOk = $true
for ($i = $localBytes.Length; $paddingOk -and $i -lt $dumpBytes.Length; $i++) { if ($dumpBytes[$i] -ne 0) { $paddingOk = $false } }
$ok = $info.authority -eq $deployerId -and [int64]$info.dataLen -eq $size -and $dumpHash -eq $localHash -and $prefixOk -and $paddingOk
Say ("verify: authority {0}; dataLen {1}; programdata {2}; lastDeploySlot {3}; dump sha256 {4}; {5}" -f `
        $info.authority, $info.dataLen, $info.programdataAddress, $info.lastDeploySlot, $dumpHash, $(if ($ok) { 'MATCH' } else { 'MISMATCH' }))

$afterBal = Sol $deployerId
$spent = ($before - $afterBal) / 1e9
Say ("balance {0:N9} -> {1:N9} SOL (spent {2:N9})" -f ($before / 1e9), ($afterBal / 1e9), $spent)
if (Test-Path $ledger) {
    $row = "| deploy | {0} | deploy $Program ($programId, $size bytes) | {1:N9} | {2:N9} | {3:N9} | sha256 {4}; {5} |" -f `
        (Get-Date -Format 'yyyy-MM-dd HH:mm'), ($before / 1e9), ($afterBal / 1e9), $spent, $localHash, $(if ($ok) { 'verified' } else { 'VERIFY FAILED' })
    [IO.File]::AppendAllText($ledger, "$row`r`n")
}
if (-not $ok) { exit 2 }
