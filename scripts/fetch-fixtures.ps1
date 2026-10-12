# Dump the mainnet programs and accounts the integration tests run against.
#
# usage: scripts/fetch-fixtures.ps1 [-Out <dir>]   (default: $env:NOISED_FIXTURES_DIR or .\fixtures)
#
# Meteora and Token-2022 are upgradeable, so a fresh dump may differ from the
# versions Noised was tested against. Each program's SHA-256 is compared with
# the hash recorded below; investigate any mismatch (read the release notes
# and re-run the full test suite) before trusting results.
param(
    [string]$Out = $(if ($env:NOISED_FIXTURES_DIR) { $env:NOISED_FIXTURES_DIR } elseif ($env:PHALANX_FIXTURES_DIR) { $env:PHALANX_FIXTURES_DIR } else { 'fixtures' }),
    [string]$Rpc = $(if ($env:SOLANA_RPC_URL) { $env:SOLANA_RPC_URL } else { 'https://api.mainnet-beta.solana.com' })
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force (Join-Path $Out 'accounts') | Out-Null

# name, program id, sha256 tested against (2026-10-08)
$programs = @(
    @('dbc', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', '4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b'),
    @('damm_v2', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', '4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b'),
    @('token_2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469'),
    @('spl_token', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697'),
    @('associated_token', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d')
)

# DAMM v2 configs DBC migrates through (migration_fee_option 0..5 and customizable), and the wSOL mint.
$accounts = @(
    '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd', '2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k',
    'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp', '2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq',
    'AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD', 'DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u',
    'A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck', 'So11111111111111111111111111111111111111112'
)

foreach ($p in $programs) {
    $file = Join-Path $Out "$($p[0]).so"
    solana program dump -u $Rpc $p[1] $file | Out-Null
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -eq $p[2]) { "ok        $($p[0]) $actual" } else { "CHANGED   $($p[0]) $actual (tested against $($p[2]))" }
}
foreach ($a in $accounts) {
    solana account -u $Rpc $a --output json-compact -o (Join-Path $Out "accounts\$a.json") | Out-Null
    "ok        account $a"
}
