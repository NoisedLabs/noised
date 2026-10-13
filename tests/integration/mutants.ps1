<#
Mutation check for the integration tests (README.md, "Mutation check").

Builds deliberately broken copies of noised-vault / noised-hook and of the
post-quantum attestation and on-chain metadata record of noised-launchpad
(SBPF v3) in a scratch workspace and runs pinned copies of the already-built
`vault`, `hook`, `vectors_onchain` and `metadata_record` test binaries against
each one via NOISED_SBF_DIR (the launchpad's metadata tests load mainnet DBC
from NOISED_FIXTURES_DIR). A mutant is killed when at least one test fails;
every mutant must be killed. Neither the repo nor the test or SBF target dirs
are ever written.

Prerequisites: `cargo test --no-run` (tests/integration) has run into
-TestTarget, and `cargo-build-sbf --arch v3` for the three programs into
-SbfTarget (the same dir by default). The SBF dependency artifacts are reused
from there, so each mutant only recompiles our crates.

  powershell -NoProfile -ExecutionPolicy Bypass -File tests\integration\mutants.ps1 [-Only 'H*'[,'LR2?'...]] [-TestTarget <dir>] [-SbfTarget <dir>]

If a program changes so that a pattern below no longer matches exactly once,
the script stops: update the mutant instead of dropping it.

Defaults: -TestTarget is $env:CARGO_TARGET_DIR, else <NOISED_BUILD_ROOT or
<repo>\target>\target-tests. -WorkDir (scratch, must be outside the repository)
is $env:NOISED_IT_MUTANTS_DIR, else <NOISED_BUILD_ROOT>\mutants\it, else
<system temp>\noised-mutants\it. -EnvScript (optional, dot-sourced before
cargo) is $env:NOISED_ENV_SCRIPT, else <NOISED_BUILD_ROOT>\env.ps1 if present.
#>
param(
    [string]$Only = '*',
    [string]$TestTarget = $(if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } elseif ($env:NOISED_BUILD_ROOT) { Join-Path $env:NOISED_BUILD_ROOT 'target-tests' } else { Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'target\target-tests' }),
    [string]$SbfTarget = $TestTarget,
    [string]$WorkDir = $(if ($env:NOISED_IT_MUTANTS_DIR) { $env:NOISED_IT_MUTANTS_DIR } elseif ($env:NOISED_BUILD_ROOT) { Join-Path $env:NOISED_BUILD_ROOT 'mutants\it' } else { Join-Path ([IO.Path]::GetTempPath()) 'noised-mutants\it' }),
    [string]$EnvScript = $(if ($env:NOISED_ENV_SCRIPT) { $env:NOISED_ENV_SCRIPT } elseif ($env:NOISED_BUILD_ROOT) { Join-Path $env:NOISED_BUILD_ROOT 'env.ps1' } else { '' })
)
$ErrorActionPreference = 'Stop'
if ($EnvScript -and (Test-Path $EnvScript)) { . $EnvScript }
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
if ($WorkDir.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'WorkDir must be outside the repository' }
$ws = "$WorkDir\ws"; $target = "$WorkDir\target"; $deploy = "$target\deploy"
$pristine = "$WorkDir\pristine"; $logs = "$WorkDir\logs"; $bins = "$WorkDir\bin"
$env:CARGO_TARGET_DIR = $target
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '4' }
$utf8 = New-Object System.Text.UTF8Encoding $false
$members = @('crates/noised-lmots', 'crates/noised-onchain', 'crates/noised-rules', 'programs/noised-vault', 'programs/noised-hook', 'programs/noised-launchpad')
$programs = @('noised-vault', 'noised-hook', 'noised-launchpad')
$testBins = @('vault', 'hook', 'vectors_onchain', 'metadata_record', 'programmable_vectors')

function Sync-Workspace {
    if (Test-Path $ws) { Remove-Item -Recurse -Force $ws }
    New-Item -ItemType Directory -Force $ws | Out-Null
    Copy-Item "$repo\Cargo.lock" $ws
    # Only the copied crates are members; drop path deps that are not copied.
    $manifest = [IO.File]::ReadAllText("$repo\Cargo.toml")
    $old = 'members = ["crates/*", "programs/*"]'
    if (-not $manifest.Contains($old)) { throw 'root workspace members line changed' }
    $new = 'members = [' + (($members | ForEach-Object { '"' + $_ + '"' }) -join ', ') + ']'
    $manifest = $manifest.Replace($old, $new)
    [IO.File]::WriteAllText("$ws\Cargo.toml", $manifest, $utf8)
    foreach ($d in $members) {
        $src = Join-Path $repo ($d -replace '/', '\')
        $dst = Join-Path $ws ($d -replace '/', '\')
        New-Item -ItemType Directory -Force $dst | Out-Null
        Get-ChildItem $src | Where-Object { $_.Name -ne 'target' } | Copy-Item -Destination $dst -Recurse
    }
    # The launchpad's `declare_program!` reads the DBC / DAMM v2 IDLs from the
    # first `idls` directory above its manifest.
    Copy-Item "$repo\idls" "$ws\idls" -Recurse
}

# Pinned copies: a concurrent `cargo test` must not swap the binaries mid-run.
function Pin-TestBinaries {
    New-Item -ItemType Directory -Force $bins | Out-Null
    foreach ($bin in $testBins) {
        $exe = Get-ChildItem "$TestTarget\debug\deps\$bin-*.exe" | Sort-Object LastWriteTime | Select-Object -Last 1
        if (-not $exe) { throw "no $bin test binary in $TestTarget (run cargo test --no-run first)" }
        Copy-Item $exe.FullName "$bins\$bin.exe" -Force
        Write-Output "pinned $($exe.Name) ($($exe.LastWriteTime))"
    }
}

# Fresh mtimes so cargo always recompiles what changed.
function Write-Source($path, $text) {
    [IO.File]::WriteAllText($path, $text, $utf8)
    (Get-Item $path).LastWriteTime = Get-Date
}

function Restore-Program($prog) {
    Get-ChildItem -Recurse -File "$repo\programs\$prog\src" | ForEach-Object {
        Write-Source (Join-Path $ws $_.FullName.Substring($repo.Length + 1)) ([IO.File]::ReadAllText($_.FullName))
    }
}

# An edit's file: relative to the mutant's program, or to the repository root
# when it names a crate (`crates\...`), compiled into that program.
function Edit-Path($m, $e) {
    if ($e.File -like 'crates\*') { return Join-Path $ws $e.File }
    return Join-Path $ws "programs\$($m.Prog)\$($e.File)"
}

function Restore-Edits($m) {
    Restore-Program $m.Prog
    foreach ($e in $m.Edits | Where-Object { $_.File -like 'crates\*' }) {
        Write-Source (Edit-Path $m $e) ([IO.File]::ReadAllText((Join-Path $repo $e.File)))
    }
}

# Deployed .so path, or $null if the build failed.
function Build($prog, $label) {
    $start = Get-Date
    Start-Sleep -Milliseconds 1100 # mtime resolution
    cmd /c "cargo-build-sbf --manifest-path $ws\programs\$prog\Cargo.toml --arch v3 > $logs\build-$label.log 2>&1"
    if ($LASTEXITCODE -ne 0) { return $null }
    $so = Join-Path $deploy (($prog -replace '-', '_') + '.so')
    if ((Get-Item $so).LastWriteTime -lt $start) { throw "$so was not rebuilt ($label)" }
    return $so
}

function Run-Tests($label) {
    $env:NOISED_SBF_DIR = $deploy
    # The age check compares with the live repo, which others may be editing.
    $env:NOISED_ALLOW_STALE_SBF = '1'
    $rows = foreach ($bin in $testBins) {
        $out = "$logs\$label-$bin.txt"
        cmd /c "`"$bins\$bin.exe`" --test-threads=4 > `"$out`" 2>&1"
        $code = $LASTEXITCODE
        $text = [IO.File]::ReadAllText($out)
        [pscustomobject]@{
            Bin     = $bin
            Exit    = $code
            Summary = ([regex]::Match($text, '(?m)^test result: (.*)$')).Groups[1].Value
            Failed  = ([regex]::Matches($text, '(?m)^test (\S+) \.\.\. FAILED') | ForEach-Object { $_.Groups[1].Value }) -join ', '
        }
    }
    Remove-Item Env:NOISED_SBF_DIR, Env:NOISED_ALLOW_STALE_SBF
    return $rows
}

function E($file, $old, $new) { [pscustomobject]@{ File = $file; Old = $old; New = $new } }
function M($id, $prog, $desc, $edits) { [pscustomobject]@{ Id = $id; Prog = $prog; Desc = $desc; Edits = @($edits) } }

$mutants = @(
    # The vault is written without Anchor (src\processor.rs): each mutant drops or weakens the explicit check
    # that implements the Anchor constraint or handler line the mutant of the same id removed before.
    (M 'V1' 'noised-vault' 'signature never checked' (E 'src\processor.rs' '    if !noised_lmots::verify::<SolSha256>(&state.public_key(), &msg, args.signature) {' '    if false && !noised_lmots::verify::<SolSha256>(&state.public_key(), &msg, args.signature) {')),
    (M 'V2' 'noised-vault' 'next public key not checked against the signed next key id' (E 'src\processor.rs' '    if key_id(&args.next_key.public_key()) != args.next_key_id {' '    if false && key_id(&args.next_key.public_key()) != args.next_key_id {')),
    (M 'V3' 'noised-vault' 'next key may equal the current key' (E 'src\processor.rs' '    if args.next_key_id == state.key_id {' '    if false && args.next_key_id == state.key_id {')),
    (M 'V4' 'noised-vault' 'reserves max_amount instead of min(max_amount, unreserved balance)' (E 'src\processor.rs' 'args.max_amount.min(available)' 'args.max_amount')),
    (M 'V5' 'noised-vault' 'earlier reservations ignored' (E 'src\processor.rs' 'let available = vault_tokens.amount.saturating_sub(state.reserved);' 'let available = vault_tokens.amount;')),
    (M 'V6' 'noised-vault' 'a withdrawal to the vault itself reserves tokens' (E 'src\processor.rs' 'let amount = if same(&args.destination_owner, vault.address()) {' 'let amount = if false {')),
    (M 'V7' 'noised-vault' 'sequence not advanced' (E 'src\processor.rs' "    state.sequence = sequence`n        .checked_add(1)`n        .ok_or_else(|| vault_error(VaultError::MathOverflow))?;" '    state.sequence = sequence;')),
    (M 'V8' 'noised-vault' 'key not rotated' (E 'src\processor.rs' '    state.set_key(args.next_key_id, &args.next_key);' '')),
    (M 'V9' 'noised-vault' 'sequence not in the signed message' (E 'src\processor.rs' "        mint.address(),`n        sequence,`n        &args.destination_owner,`n        args.max_amount," "        mint.address(),`n        0,`n        &args.destination_owner,`n        args.max_amount,")),
    (M 'V10' 'noised-vault' 'recipient not in the signed message' (E 'src\processor.rs' "        &args.destination_owner,`n        args.max_amount," "        &Pubkey::default(),`n        args.max_amount,")),
    (M 'V11' 'noised-vault' 'max_amount not in the signed message' (E 'src\processor.rs' "        args.max_amount,`n        &args.next_key_id,`n    );" "        0,`n        &args.next_key_id,`n    );")),
    (M 'V12' 'noised-vault' 'next key id not in the signed message' (E 'src\processor.rs' "        &args.next_key_id,`n    );" "        &[0u8; 32],`n    );")),
    (M 'V13' 'noised-vault' 'delivery keeps the reservation' (E 'src\processor.rs' "    d.state.reserved = d`n        .state`n        .reserved`n        .checked_sub(amount)`n        .ok_or_else(|| vault_error(VaultError::MathOverflow))?;`n" '')),
    (M 'V14' 'noised-vault' 'payout address not per sequence' @((E 'src\processor.rs' '        &[PAYOUT_SEED, vault.address().as_ref(), &sequence_le],' '        &[PAYOUT_SEED, vault.address().as_ref()],'), (E 'src\processor.rs' "            Seed::from(&sequence_le),`n" ''))),
    (M 'V15' 'noised-vault' 'withdraw reads any token account of the mint as the balance' (E 'src\processor.rs' "    check_vault(vault, &state, mint)?;`n    check_vault_token_account(`n        vault_token_account,`n        &vault_tokens,`n        vault,`n        mint,`n        token_program,`n    )?;" "    check_vault(vault, &state, mint)?;`n    if !same(&vault_tokens.mint, mint.address()) || !owned_by(vault_token_account, token_program.address()) {`n        return Err(fail(CONSTRAINT_TOKEN_MINT, Some(VAULT_TOKEN_ACCOUNT)));`n    }")),
    (M 'V16' 'noised-vault' 'release / release_to: payout not bound to its recipient (one check serves both)' (E 'src\processor.rs' "    check_has_one::<P>(&state.destination_owner, destination_owner, PAYOUT)?;`n" '')),
    (M 'V17' 'noised-vault' 'release / release_to: payout not bound to its rent payer' (E 'src\processor.rs' "    check_has_one::<P>(&state.rent_payer, rent_payer, PAYOUT)?;`n" '')),
    (M 'V18' 'noised-vault' 'release_to: the vault''s own token account accepted as the destination (no duplicate-account check)' (E 'src\processor.rs' "        (payout, PAYOUT),`n        (destination, DESTINATION),`n    ])?;" "        (payout, PAYOUT),`n    ])?;")),
    (M 'V19' 'noised-vault' 'release_to without the recipient signature' (E 'src\processor.rs' 'let destination_owner = accounts.signer(DESTINATION_OWNER)?;' 'let destination_owner = accounts.unchecked(DESTINATION_OWNER)?;')),
    (M 'V20' 'noised-vault' 'release_to accepts an account of another mint' (E 'src\processor.rs' '    if !same(&destination_tokens.mint, mint.address()) {' '    if false && !same(&destination_tokens.mint, mint.address()) {')),
    (M 'V21' 'noised-vault' 'release pays any account (canonical ATA not required)' (E 'src\processor.rs' '    if !same(ata.address(), &expected) {' '    if false && !same(ata.address(), &expected) {')),
    (M 'V22' 'noised-vault' 'release does not create a missing ATA' (E 'src\processor.rs' 'if ata.is_data_empty() {' 'if false {')),
    (M 'V23' 'noised-vault' 'release checks the destination of an empty payout' (E 'src\processor.rs' 'if receipt.amount > 0 {' 'if true {')),
    (M 'V24' 'noised-vault' 'no memo before paying a memo-required account' (E 'src\processor.rs' 'if destination_requires_memo(d.destination)? {' 'if false && destination_requires_memo(d.destination)? {')),
    (M 'V25' 'noised-vault' 'open_vault does not check that key_id commits to the key' (E 'src\processor.rs' '    if key_id(&key.public_key()) != key_id_arg {' '    if false {')),
    (M 'V26' 'noised-vault' 'open_vault accepts a mint close authority' (E 'src\token.rs' '                supported = optional_key(config, 0).is_none();' '                supported = true;')),
    (M 'V27' 'noised-vault' 'open_vault accepts a permanent delegate' (E 'src\token.rs' 'EXT_NON_TRANSFERABLE | EXT_PERMANENT_DELEGATE => supported = false,' 'EXT_NON_TRANSFERABLE => supported = false,')),
    (M 'V28' 'noised-vault' 'open_vault accepts a live transfer-fee config authority' (E 'src\token.rs' 'supported = optional_key(config, 0).is_none() && optional_key(config, 32).is_none();' 'supported = true && optional_key(config, 32).is_none();')),
    (M 'V29' 'noised-vault' 'open_vault accepts a live withdraw-withheld authority' (E 'src\token.rs' 'supported = optional_key(config, 0).is_none() && optional_key(config, 32).is_none();' 'supported = optional_key(config, 0).is_none() && true;')),
    (M 'V30' 'noised-vault' 'VaultWithdrawn reports max_amount instead of the reserved amount' (E 'src\processor.rs' "        &args.destination_owner,`n        amount,`n        payout.address()," "        &args.destination_owner,`n        args.max_amount,`n        payout.address(),")),
    (M 'V31' 'noised-vault' 'VaultWithdrawn reports the next sequence' (E 'src\processor.rs' "        mint.address(),`n        sequence,`n        &args.destination_owner,`n        amount," "        mint.address(),`n        sequence + 1,`n        &args.destination_owner,`n        amount,")),
    (M 'V32' 'noised-vault' 'PayoutReleased names the vault token account as the destination' (E 'src\processor.rs' "        d.destination.address(),`n        amount,`n    ));" "        d.vault_token_account.address(),`n        amount,`n    ));")),
    (M 'V33' 'noised-vault' 'PayoutReleased reports the vault''s current sequence' (E 'src\processor.rs' '        d.receipt.sequence,' '        d.state.sequence,')),
    # Audit round 2: every key is bound to its position (LM-OTS index q).
    (M 'V34' 'noised-vault' 'withdraw accepts any next key index (a spent key can come back)' (E 'src\processor.rs' '    if next_key_index(sequence) != Some(args.next_key.q) {' '    if false {')),
    (M 'V35' 'noised-vault' 'open_vault accepts any key index' (E 'src\processor.rs' '    if key.q != GENESIS_KEY_INDEX {' '    if false {')),
    (M 'V36' 'noised-vault' 'the next key index wraps to 0 after u32::MAX' (E 'src\state.rs' "    sequence`n        .checked_add(1)`n        .and_then(|next| u32::try_from(next).ok())" '    Some((sequence as u32).wrapping_add(1))')),
    (M 'V37' 'noised-vault' 'the next key takes the current index' (E 'src\state.rs' "    sequence`n        .checked_add(1)`n        .and_then(|next| u32::try_from(next).ok())" '    u32::try_from(sequence).ok()')),
    (M 'V38' 'noised-vault' 'the next key index saturates at u32::MAX (another key of index u32::MAX follows the last one)' (E 'src\state.rs' "    sequence`n        .checked_add(1)`n        .and_then(|next| u32::try_from(next).ok())" '    Some(u32::try_from(sequence.saturating_add(1)).unwrap_or(u32::MAX))')),
    (M 'H1' 'noised-hook' 'sells evaluated like other transfers' @((E 'src\lib.rs' 'if !is_buy && (destination == head.base_vault || amount == 0) {' 'if !is_buy && amount == 0 {'), (E 'src\rules.rs' 'if t.destination == policy.base_vault && !is_buy {' 'if false {'))),
    (M 'H2' 'noised-hook' 'no snipe shield' (E 'src\rules.rs' 'if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch {' 'if is_buy && t.now < policy.launch_ts && !t.in_batch {')),
    (M 'H3' 'noised-hook' 'max_wallet off by one' (E 'src\rules.rs' 't.destination_balance > policy.max_wallet' 't.destination_balance >= policy.max_wallet')),
    (M 'H4' 'noised-hook' 'mints without a policy are blocked' (E 'src\lib.rs' 'if policy_info.owner != &crate::ID || policy_info.data_is_empty() {' 'if policy_info.owner != &crate::ID || policy_info.data_is_empty() { return err!(HookError::PolicyMismatch); } if false {')),
    (M 'H5' 'noised-hook' 'create_policy accepts any signer' (E 'src\lib.rs' "    /// The launchpad's PDA; only the launchpad program can produce this signature.`n    #[account(seeds = [HOOK_AUTHORITY_SEED], bump, seeds::program = LAUNCHPAD_PROGRAM_ID)]" "    /// The launchpad's PDA; only the launchpad program can produce this signature.`n    #[account()]")),
    (M 'H6' 'noised-hook' 'policy meta marked writable' (E 'src\lib.rs' "            false,`n            false,`n        )?," "            false,`n            true,`n        )?,")),
    (M 'H7' 'noised-hook' 'only exempt sources skip the rules' (E 'src\rules.rs' "    if policy.is_exempt(&t.destination_owner) {`n        return Ok(Step::Allowed);`n    }`n" '')),
    (M 'H8' 'noised-hook' 'p2p lock ignored' (E 'src\rules.rs' 'if !is_buy && policy.p2p_locked {' 'if false && !is_buy && policy.p2p_locked {')),
    (M 'H9' 'noised-hook' 'guard ends one second late' @((E 'src\lib.rs' 'if now >= head.guard_end_ts {' 'if now > head.guard_end_ts {'), (E 'src\rules.rs' 'if t.now >= policy.guard_end_ts {' 'if t.now > policy.guard_end_ts {'))),
    (M 'H10' 'noised-hook' 'create_policy skips the max-wallet floor' (E 'src\lib.rs' '|| params.max_wallet >= supply / bounds::MIN_MAX_WALLET_DIVISOR)' '|| true)')),
    (M 'H11' 'noised-hook' 'create_policy accepts a pool DBC does not own' (E 'src\lib.rs' '#[account(owner = DBC_PROGRAM_ID @ HookError::InvalidPool)]' '#[account()]')),
    (M 'H12' 'noised-hook' 'create_policy ignores which pool account is passed' (E 'src\lib.rs' 'require_keys_eq!(ctx.accounts.pool.key(), params.pool, HookError::InvalidPool);' '')),
    (M 'H13' 'noised-hook' 'base vault derived with swapped seeds' (E 'src\lib.rs' "                DBC_TOKEN_VAULT_SEED,`n                mint_key.as_ref(),`n                params.pool.as_ref()," "                DBC_TOKEN_VAULT_SEED,`n                params.pool.as_ref(),`n                mint_key.as_ref(),")),
    (M 'H14' 'noised-hook' 'exempt recipients open the snipe shield (audit L2)' (E 'src\rules.rs' 'if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch {' 'if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch && !policy.is_exempt(&t.destination_owner) {')),
    (M 'H15' 'noised-hook' 'batch check ignores the program id' (E 'src\lib.rs' "Ok(ix.program_id == LAUNCHPAD_PROGRAM_ID`n        && " "Ok(true`n        && ")),
    (M 'H16' 'noised-hook' 'batch check ignores the discriminator' (E 'src\lib.rs' "`n        && ix.data.get(..8) == Some(&EXECUTE_BATCH_DISCRIMINATOR[..]))" "`n        && true)")),
    (M 'H17' 'noised-hook' 'batch check reads the first instruction, not the current one' (E 'src\lib.rs' "let ix = load_instruction_at_checked(usize::from(index), instructions)?;`n    Ok(ix.program_id == LAUNCHPAD_PROGRAM_ID" "let ix = load_instruction_at_checked(0, instructions)?; let _ = index;`n    Ok(ix.program_id == LAUNCHPAD_PROGRAM_ID")),
    (M 'H18' 'noised-hook' 'every buy during the shield counts as the batch buy' (E 'src\lib.rs' '&& inside_execute_batch(&ctx.accounts.instructions)?;' '&& (true || inside_execute_batch(&ctx.accounts.instructions)?);')),
    (M 'H19' 'noised-hook' 'the batch buy is refused too' (E 'src\lib.rs' '&& inside_execute_batch(&ctx.accounts.instructions)?;' '&& (false && inside_execute_batch(&ctx.accounts.instructions)?);')),
    (M 'H20' 'noised-hook' 'instructions sysvar meta marked writable' (E 'src\lib.rs' 'ExtraAccountMeta::new_with_pubkey(&INSTRUCTIONS_SYSVAR_ID, false, false)?,' 'ExtraAccountMeta::new_with_pubkey(&INSTRUCTIONS_SYSVAR_ID, false, true)?,')),
    # The L2 residual: zero-amount buys and buys into the base vault itself.
    # H23 / H24 are reachable only through a direct `execute` call: Token-2022
    # never calls the hook for a self-transfer.
    (M 'H21' 'noised-hook' 'zero-amount buys skip the snipe shield (rules: zero check first)' (E 'src\rules.rs' 'if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch {' 'if t.amount == 0 { return Ok(()); } if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch {')),
    (M 'H22' 'noised-hook' 'zero-amount buys skip the snipe shield (execute: early return)' (E 'src\lib.rs' 'if !is_buy && (destination == head.base_vault || amount == 0) {' 'if (!is_buy && destination == head.base_vault) || amount == 0 {')),
    (M 'H23' 'noised-hook' 'a transfer out of the base vault into it counts as a sell (execute)' (E 'src\lib.rs' 'if !is_buy && (destination == head.base_vault || amount == 0) {' 'if destination == head.base_vault || (!is_buy && amount == 0) {')),
    (M 'H24' 'noised-hook' 'a transfer out of the base vault into it counts as a sell (rules)' (E 'src\rules.rs' 'if t.destination == policy.base_vault && !is_buy {' 'if t.destination == policy.base_vault {')),
    (M 'H25' 'noised-hook' 'the round-1 early return: transfers into the base vault and zero amounts pass first' (E 'src\lib.rs' 'if !is_buy && (destination == head.base_vault || amount == 0) {' 'if destination == head.base_vault || amount == 0 {')),
    (M 'H26' 'noised-hook' 'zero-amount buys after the shield are capped' (E 'src\rules.rs' 'if t.amount == 0 {' 'if false {')),
    # Audit round 2: the launchpad's execute_batch ends the snipe shield once the batch has bought.
    (M 'H27' 'noised-hook' 'end_snipe_shield accepts any signer' (E 'src\lib.rs' "    /// signature (it does so only in ``execute_batch``, after the batch buy).`n    #[account(seeds = [HOOK_AUTHORITY_SEED], bump, seeds::program = LAUNCHPAD_PROGRAM_ID)]" "    /// signature (it does so only in ``execute_batch``, after the batch buy).`n    #[account()]")),
    (M 'H28' 'noised-hook' 'end_snipe_shield sets the end to now, even when that is later' (E 'src\lib.rs' 'policy.snipe_shield_end_ts = rules::shield_end_after_batch(scheduled_end_ts, now);' 'policy.snipe_shield_end_ts = now;')),
    (M 'H29' 'noised-hook' 'the shield ends at the later of its end and the batch' (E 'src\rules.rs' 'snipe_shield_end_ts.min(now)' 'snipe_shield_end_ts.max(now)')),
    (M 'H30' 'noised-hook' 'end_snipe_shield also ends the guard' (E 'src\lib.rs' 'policy.snipe_shield_end_ts = rules::shield_end_after_batch(scheduled_end_ts, now);' 'policy.snipe_shield_end_ts = rules::shield_end_after_batch(scheduled_end_ts, now); policy.guard_end_ts = policy.snipe_shield_end_ts;')),
    (M 'H31' 'noised-hook' 'SnipeShieldEnded reports the new end as the scheduled one' (E 'src\lib.rs' "            scheduled_end_ts,`n            snipe_shield_end_ts: policy.snipe_shield_end_ts," "            scheduled_end_ts: policy.snipe_shield_end_ts,`n            snipe_shield_end_ts: policy.snipe_shield_end_ts,")),
    (M 'H32' 'noised-hook' 'SnipeShieldEnded names the pool as the mint' (E 'src\lib.rs' 'mint: policy.mint,' 'mint: policy.pool,')),
    (M 'H33' 'noised-hook' 'end_snipe_shield does not persist the new end (policy not mut)' (E 'src\lib.rs' "    #[account(`n        mut,`n        seeds = [POLICY_SEED, policy.mint.as_ref()]," "    #[account(`n        seeds = [POLICY_SEED, policy.mint.as_ref()],")),
    (M 'H34' 'noised-hook' 'end_snipe_shield runs outside execute_batch (no NotInBatch)' (E 'src\lib.rs' "        require!(`n            inside_execute_batch(&ctx.accounts.instructions)?,`n            HookError::NotInBatch`n        );`n" '')),
    (M 'H35' 'noised-hook' 'end_snipe_shield takes any hook-owned policy, PDA or not' (E 'src\lib.rs' "    #[account(`n        mut,`n        seeds = [POLICY_SEED, policy.mint.as_ref()],`n        bump = policy.bump,`n    )]" '    #[account(mut)]')),
    (M 'H36' 'noised-hook' 'end_snipe_shield does not check the sysvar address itself' (E 'src\lib.rs' '    #[account(address = INSTRUCTIONS_SYSVAR_ID)]' '    #[account()]')),
    # Audit round 3 (F2): while the guard is on, tokens go (other than to the
    # pool) only into accounts with ImmutableOwner or of an exempt owner.
    (M 'H37' 'noised-hook' 'no immutable-owner rule (owner reassignment moves tokens past the lock and the caps)' (E 'src\rules.rs' '    if !t.destination_immutable_owner {' '    if false {')),
    (M 'H38' 'noised-hook' 'the immutable-owner rule only for buys' (E 'src\rules.rs' '    if !t.destination_immutable_owner {' '    if !t.destination_immutable_owner && is_buy {')),
    (M 'H39' 'noised-hook' 'batch claims (exempt sources) skip the immutable-owner rule' (E 'src\rules.rs' '    if !t.destination_immutable_owner {' '    if !t.destination_immutable_owner && !policy.is_exempt(&t.source_owner) {')),
    (M 'H40' 'noised-hook' 'an exempt owner''s account needs ImmutableOwner too' (E 'src\rules.rs' '    if policy.is_exempt(&t.destination_owner) {' '    if policy.is_exempt(&t.destination_owner) && t.destination_immutable_owner {')),
    (M 'H41' 'noised-hook' 'zero amounts into accounts without ImmutableOwner are refused' (E 'src\rules.rs' '    if t.amount == 0 {' '    if t.amount == 0 && t.destination_immutable_owner {')),
    (M 'H42' 'noised-hook' 'the rule reads the source''s extensions, not the destination''s' (E 'src\lib.rs' 'has_immutable_owner(&ctx.accounts.destination.try_borrow_data()?);' 'has_immutable_owner(&ctx.accounts.source.try_borrow_data()?);')),
    (M 'H43' 'noised-hook' 'MutableOwner reported as TransfersLocked' (E 'src\lib.rs' 'Refusal::MutableOwner => error!(HookError::MutableOwner),' 'Refusal::MutableOwner => error!(HookError::TransfersLocked),')),
    # PQ v2: the launch attestation, against the SDK vectors (vectors_onchain).
    (M 'L1' 'noised-launchpad' 'the metadata hash has another domain tag' (E 'src\pq.rs' 'pub const METADATA_HASH_TAG: &[u8; 11] = b"PHX-META-V2";' 'pub const METADATA_HASH_TAG: &[u8; 11] = b"PHX-META-V3";')),
    (M 'L2' 'noised-launchpad' 'the metadata hash leaves out the uri' (E 'src\pq.rs' "        &len(uri),`n        uri,`n" '')),
    (M 'L3' 'noised-launchpad' 'the attestation message does not bind the program id' (E 'src\pq.rs' "        ATTEST_MESSAGE_TAG,`n        program_id.as_ref(),`n" "        ATTEST_MESSAGE_TAG,`n        &[0u8; 32],`n")),
    (M 'L4' 'noised-launchpad' 'params_hash and creator swap places in the message' (E 'src\pq.rs' "        params_hash,`n        creator.as_ref()," "        creator.as_ref(),`n        params_hash,")),
    (M 'L5' 'noised-launchpad' 'the leaf bitmap is most significant bit first' (E 'src\pq.rs' '1u8 << (q & 7)))' '0x80u8 >> (q & 7)))')),
    (M 'L6' 'noised-launchpad' 'a used leaf is accepted again (no PqLeafUsed)' (E 'src\pq.rs' "    require!(`n        mark_leaf_used(&mut identity.used, q),`n        LaunchpadError::PqLeafUsed`n    );" '    let _ = mark_leaf_used(&mut identity.used, q);')),
    (M 'L7' 'noised-launchpad' 'used_count does not count the leaf' (E 'src\pq.rs' "        .used_count`n        .checked_add(1)" "        .used_count`n        .checked_add(0)")),
    (M 'L8' 'noised-launchpad' 'a later signature rewrites the attestation (no free-slot check)' (E 'src\instructions\attest_launch.rs' '    let attests = slot_free' '    let attests = true')),
    (M 'L9' 'noised-launchpad' 'the attestation stores the metadata hash as the message hash' (E 'src\instructions\attest_launch.rs' '        attestation.message_hash = solana_sha256_hasher::hash(&message).to_bytes();' '        attestation.message_hash = terms.metadata_hash;')),
    (M 'L10' 'noised-launchpad' 'the attestation records leaf 0' (E 'src\instructions\attest_launch.rs' '        attestation.leaf = leaf;' '        attestation.leaf = 0;')),
    (M 'L11' 'noised-launchpad' 'LaunchAttested reports slot 0' (E 'src\instructions\attest_launch.rs' "            slot: now.slot,`n            not_before," "            slot: 0,`n            not_before,")),
    (M 'L12' 'noised-launchpad' 'PqLeafConsumed reports leaf 0' (E 'src\instructions\attest_launch.rs' "            leaf,`n            launch: launch_key," "            leaf: 0,`n            launch: launch_key,")),
    (M 'L13' 'noised-launchpad' 'identity ids use the key-id domain byte 0x20' (E 'crates\noised-lmots\src\lms.rs' 'pub const DOMAIN_IDENTITY_ID: u8 = 0x21;' 'pub const DOMAIN_IDENTITY_ID: u8 = 0x20;')),
    # The adversarial review's fixes: any valid signature lands and burns its
    # leaf; it attests only for the launch's identity, a published metadata
    # record and a window that can still open (vectors' burnOnly cases).
    (M 'L14' 'noised-launchpad' 'another identity''s signature attests the launch' (E 'src\instructions\attest_launch.rs' "        && pq_identity == launch.pq_identity`n" '')),
    (M 'L15' 'noised-launchpad' 'a hash that names no published record is attested' (E 'src\instructions\attest_launch.rs' "        && pq::is_metadata_record(`n            &ctx.accounts.token_meta,`n            &launch_key,`n            &metadata_hash,`n            record_bump,`n        )`n" '')),
    (M 'L16' 'noised-launchpad' 'the attestation keeps no signature' (E 'src\instructions\attest_launch.rs' '        attestation.signature = lms_sig;' '        attestation.signature = Vec::new();')),
    (M 'L17' 'noised-launchpad' 'a window that cannot open is attested' (E 'src\instructions\attest_launch.rs' "        && pq::launch_window_is_valid(now.unix_timestamp, not_before, not_after)`n" "        && true`n")),
    (M 'L18' 'noised-launchpad' 'a window of exactly an hour is refused' (E 'src\pq.rs' '    (i128::from(MIN_LAUNCH_WINDOW_SECS)..=i128::from(MAX_LAUNCH_WINDOW_SECS))' '    (i128::from(MIN_LAUNCH_WINDOW_SECS)..i128::from(MAX_LAUNCH_WINDOW_SECS))')),
    (M 'L19' 'noised-launchpad' 'a window over a second ago is attested' (E 'src\pq.rs' "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n" "        && now <= end + 1`n")),
    (M 'L20' 'noised-launchpad' 'a window opening a week and a second ahead is attested' (E 'src\pq.rs' "        && start <= now + i128::from(MAX_LAUNCH_LEAD_SECS)`n" "        && start <= now + i128::from(MAX_LAUNCH_LEAD_SECS) + 1`n")),
    (M 'L21' 'noised-launchpad' 'the message binds not_before in place of not_after' (E 'src\pq.rs' "        &not_before,`n        &not_after,`n    ];" "        &not_before,`n        &not_before,`n    ];")),
    (M 'L22' 'noised-launchpad' 'the message leaves out the metadata hash' (E 'src\pq.rs' "        &terms.metadata_hash,`n" "        &[0u8; 32],`n")),
    (M 'L23' 'noised-launchpad' 'the attestation records no window' (E 'src\instructions\attest_launch.rs' "        attestation.not_before = not_before;`n        attestation.not_after = not_after;`n" '')),
    (M 'L24' 'noised-launchpad' 'the attestation records no metadata hash' (E 'src\instructions\attest_launch.rs' "        attestation.metadata_hash = metadata_hash;`n" '')),
    (M 'L25' 'noised-launchpad' 'the identity account is the launch''s, not the signing key''s' (E 'src\instructions\attest_launch.rs' '        seeds = &[IDENTITY_SEED, &identity_id::<SolSha256>(&lms_pk)],' '        seeds = [IDENTITY_SEED, launch.pq_identity.as_ref()],')),
    (M 'L26' 'noised-launchpad' 'an attestation account keeps no bump' (E 'src\instructions\attest_launch.rs' "    attestation.bump = ctx.bumps.attestation;`n" '')),
    # The on-chain metadata record (METADATA_PROGRAM.md), against
    # metadata.json (vectors_onchain publishes every record and every
    # invalid one).
    (M 'L27' 'noised-launchpad' 'an external uri may hold a space' (E 'src\policy.rs' '        && bytes.iter().all(|b| (0x21..=0x7E).contains(b))' '        && bytes.iter().all(|b| (0x20..=0x7E).contains(b))')),
    (M 'L28' 'noised-launchpad' 'a name is counted in characters, not bytes' (E 'src\policy.rs' '    (1..=MAX_NAME_LEN).contains(&name.len()) && (1..=MAX_SYMBOL_LEN).contains(&symbol.len())' '    (1..=MAX_NAME_LEN).contains(&name.chars().count()) && (1..=MAX_SYMBOL_LEN).contains(&symbol.len())')),
    (M 'L29' 'noised-launchpad' 'both uri modes at once are accepted' (E 'src\policy.rs' '    matches!(flags, 0 | META_FLAG_INLINE_URI | META_FLAG_EXTERNAL_URI)' '    flags <= 3')),
    (M 'L30' 'noised-launchpad' 'a document of 3,073 bytes is accepted' (E 'src\policy.rs' '        doc.len() <= MAX_DOC_LEN && uri.len() <= MAX_URI_LEN,' '        doc.len() <= MAX_DOC_LEN + 1 && uri.len() <= MAX_URI_LEN,')),
    (M 'L31' 'noised-launchpad' 'an inline uri without a document is accepted' (E 'src\policy.rs' '        flags != META_FLAG_INLINE_URI || !doc.is_empty(),' '        true,')),
    (M 'L32' 'noised-launchpad' 'a record stores no hash' (E 'src\instructions\publish_metadata.rs' '    token_meta.metadata_hash = metadata_hash;' '    token_meta.metadata_hash = [0; 32];')),
    (M 'L33' 'noised-launchpad' 'MetadataPublished reports the uri length as the document length' (E 'src\instructions\publish_metadata.rs' '        doc_len,' '        doc_len: uri_len,')),
    (M 'L34' 'noised-launchpad' 'the metadata hash leaves out the flags' (E 'src\pq.rs' "        &[flags],`n" '')),
    # The record's every new check (METADATA_PROGRAM.md A1 / A2), against
    # metadata_record (and vectors_onchain): publish_metadata's rules and
    # writes, what attest_launch accepts as the record, and what launch
    # gives the mint and certifies.
    (M 'L35' 'noised-launchpad' 'publish_metadata takes records for a launch that is live' (E 'src\instructions\publish_metadata.rs' "        constraint = launch.status == LaunchStatus::Configured @ LaunchpadError::WrongLaunchState,`n" '')),
    (M 'L36' 'noised-launchpad' 'an empty name is accepted' (E 'src\policy.rs' '    (1..=MAX_NAME_LEN).contains(&name.len()) &&' '    (0..=MAX_NAME_LEN).contains(&name.len()) &&')),
    (M 'L37' 'noised-launchpad' 'a name of 33 bytes is accepted' (E 'src\policy.rs' '    (1..=MAX_NAME_LEN).contains(&name.len()) &&' '    (1..=MAX_NAME_LEN + 1).contains(&name.len()) &&')),
    (M 'L38' 'noised-launchpad' 'an empty symbol is accepted' (E 'src\policy.rs' '&& (1..=MAX_SYMBOL_LEN).contains(&symbol.len())' '&& (0..=MAX_SYMBOL_LEN).contains(&symbol.len())')),
    (M 'L39' 'noised-launchpad' 'a symbol of 11 bytes is accepted' (E 'src\policy.rs' '&& (1..=MAX_SYMBOL_LEN).contains(&symbol.len())' '&& (1..=MAX_SYMBOL_LEN + 1).contains(&symbol.len())')),
    (M 'L40' 'noised-launchpad' 'unknown flag bits are accepted' (E 'src\policy.rs' '    matches!(flags, 0 | META_FLAG_INLINE_URI | META_FLAG_EXTERNAL_URI)' '    flags & 3 != 3')),
    (M 'L41' 'noised-launchpad' 'an external uri needs no https:// (an http uri is accepted)' (E 'src\policy.rs' "        && bytes.starts_with(EXTERNAL_URI_PREFIX.as_bytes())`n" '')),
    (M 'L42' 'noised-launchpad' 'an external uri of https:// alone is accepted' (E 'src\policy.rs' '(EXTERNAL_URI_PREFIX.len() + 1..=MAX_URI_LEN)' '(EXTERNAL_URI_PREFIX.len()..=MAX_URI_LEN)')),
    (M 'L43' 'noised-launchpad' 'an external uri may hold control bytes' (E 'src\policy.rs' '        && bytes.iter().all(|b| (0x21..=0x7E).contains(b))' '        && bytes.iter().all(|b| *b != b'' '' && *b <= 0x7E)')),
    (M 'L44' 'noised-launchpad' 'an external uri may hold DEL (0x7F)' (E 'src\policy.rs' '        && bytes.iter().all(|b| (0x21..=0x7E).contains(b))' '        && bytes.iter().all(|b| (0x21..=0x7F).contains(b))')),
    (M 'L45' 'noised-launchpad' 'a uri over 200 bytes is not MetadataTooLong' (E 'src\policy.rs' 'doc.len() <= MAX_DOC_LEN && uri.len() <= MAX_URI_LEN,' 'doc.len() <= MAX_DOC_LEN,')),
    (M 'L46' 'noised-launchpad' 'a uri without the external-uri flag is accepted' (E 'src\policy.rs' '        require!(uri.is_empty(), LaunchpadError::InvalidMetadataFlags);' '        let _ = uri;')),
    (M 'L47' 'noised-launchpad' 'publishing again rewrites the record and emits MetadataPublished' (E 'src\instructions\publish_metadata.rs' '    if token_meta.version != 0 {' '    if false {')),
    (M 'L48' 'noised-launchpad' 'a record stores another bump' (E 'src\instructions\publish_metadata.rs' '    token_meta.bump = ctx.bumps.token_meta;' '    token_meta.bump = ctx.bumps.token_meta.wrapping_sub(1);')),
    (M 'L49' 'noised-launchpad' 'a record stores no launch' (E 'src\instructions\publish_metadata.rs' '    token_meta.launch = launch_key;' '    token_meta.launch = Pubkey::default();')),
    (M 'L50' 'noised-launchpad' 'a record stores no flags' (E 'src\instructions\publish_metadata.rs' '    token_meta.flags = flags;' '    token_meta.flags = 0;')),
    (M 'L51' 'noised-launchpad' 'MetadataPublished reports flags 0' (E 'src\instructions\publish_metadata.rs' "        flags,`n        uri_len," "        flags: 0,`n        uri_len,")),
    (M 'L52' 'noised-launchpad' 'attest_launch takes a record of another owner' (E 'src\pq.rs' "    metadata_hash: &[u8; 32],`n    bump: u8,`n) -> bool {`n    if *info.owner != crate::ID {`n        return false;`n    }`n" "    metadata_hash: &[u8; 32],`n    bump: u8,`n) -> bool {`n")),
    (M 'L53' 'noised-launchpad' 'attest_launch takes any discriminator as a record' (E 'src\pq.rs' "        && data[..8] == *TokenMeta::DISCRIMINATOR`n" '')),
    (M 'L54' 'noised-launchpad' 'attest_launch takes a record of any version' (E 'src\pq.rs' "        && data[TokenMeta::VERSION_OFFSET] == TokenMeta::VERSION`n" '')),
    (M 'L55' 'noised-launchpad' 'attest_launch takes a record of another launch' (E 'src\pq.rs' "        && data[launch_at..launch_at + 32] == launch.to_bytes()`n        && data[hash_at..hash_at + 32] == *metadata_hash" '        && data[hash_at..hash_at + 32] == *metadata_hash')),
    (M 'L56' 'noised-launchpad' 'attest_launch takes a record of another hash' (E 'src\pq.rs' "`n        && data[hash_at..hash_at + 32] == *metadata_hash" '')),
    (M 'L57' 'noised-launchpad' 'attest_launch takes a record whose stored bump is not its address''s' (E 'src\pq.rs' "        && data[TokenMeta::BUMP_OFFSET] == bump`n" '')),
    (M 'L58' 'noised-launchpad' 'attest_launch reads an account shorter than a record (no length check)' (E 'src\pq.rs' "    data.len() >= TokenMeta::FIXED_LEN`n        && data[..8]" "    data[..8]")),
    (M 'L59' 'noised-launchpad' 'attest_launch types the record account (a signature over an unpublished record fails)' @((E 'src\instructions\attest_launch.rs' '    pub token_meta: UncheckedAccount<''info>,' '    pub token_meta: Account<''info, crate::state::TokenMeta>,'), (E 'src\instructions\attest_launch.rs' "            &ctx.accounts.token_meta,`n" "            &ctx.accounts.token_meta.to_account_info(),`n"))),
    (M 'L60' 'noised-launchpad' 'launch finds the record by its own hash, not the attestation''s' (E 'src\instructions\launch.rs' 'seeds = [METADATA_SEED, launch.key().as_ref(), attestation.metadata_hash.as_ref()],' 'seeds = [METADATA_SEED, launch.key().as_ref(), token_meta.metadata_hash.as_ref()],')),
    (M 'L61' 'noised-launchpad' 'launch takes a record of any version' (E 'src\instructions\launch.rs' "                && token_meta.version == TokenMeta::VERSION`n" '')),
    (M 'L62' 'noised-launchpad' 'launch takes a record of another launch' (E 'src\instructions\launch.rs' "                && token_meta.launch == launch_key`n" '')),
    (M 'L63' 'noised-launchpad' 'launch takes a record of another hash' (E 'src\instructions\launch.rs' '                && token_meta.metadata_hash == attestation.metadata_hash,' '                && true,')),
    (M 'L64' 'noised-launchpad' 'the certificate does not name the record' (E 'src\instructions\launch.rs' "    cert.metadata = metadata_key;`n" '')),
    (M 'L65' 'noised-launchpad' 'the inline uri has another prefix' (E 'src\constants.rs' 'pub const INLINE_URI_PREFIX: &str = "data:application/json;base64,";' 'pub const INLINE_URI_PREFIX: &str = "data:application/json,";')),
    (M 'L66' 'noised-launchpad' 'base64 swaps + and /' (E 'src\base64.rs' '0123456789+/";' '0123456789/+";')),
    (M 'L67' 'noised-launchpad' 'base64 pads one remaining byte with A, not =' (E 'src\base64.rs' "            b'='`n        };" "            b'A'`n        };")),
    (M 'L68' 'noised-launchpad' 'base64 leaves out the last partial group' (E 'src\base64.rs' '(rest.is_empty(), chars.last_mut())' '(true, chars.last_mut())')),
    (M 'L69' 'noised-launchpad' 'launch gives the mint no external uri (length and bytes)' @((E 'src\policy.rs' "    } else if flags & META_FLAG_EXTERNAL_URI != 0 {`n        uri.len()" "    } else if false {`n        uri.len()"), (E 'src\policy.rs' "    } else if flags & META_FLAG_EXTERNAL_URI != 0 {`n        out.extend_from_slice(uri.as_bytes());" "    } else if false {`n        out.extend_from_slice(uri.as_bytes());"))),
    (M 'L70' 'noised-launchpad' 'launch gives the mint no inline uri (length and bytes)' @((E 'src\policy.rs' "    if flags & META_FLAG_INLINE_URI != 0 {`n        INLINE_URI_PREFIX.len()" "    if false {`n        INLINE_URI_PREFIX.len()"), (E 'src\policy.rs' "    if flags & META_FLAG_INLINE_URI != 0 {`n        out.extend_from_slice(INLINE_URI_PREFIX.as_bytes());" "    if false {`n        out.extend_from_slice(INLINE_URI_PREFIX.as_bytes());"))),
    (M 'L71' 'noised-launchpad' 'the certificate lacks METADATA_ONCHAIN (and ALL omits it)' @((E 'src\checks.rs' '    Ok(checks::METADATA_ONCHAIN)' '    Ok(0)'), (E 'src\state.rs' '    pub const ALL: u32 = 4095;' '    pub const ALL: u32 = 2047;'))),
    (M 'L72' 'noised-launchpad' 'launch runs outside the signed window' (E 'src\instructions\launch.rs' "        require!(`n            pq::in_launch_window(now, attestation.not_before, attestation.not_after),`n            LaunchpadError::NotLaunchWindow`n        );`n" '')),
    (M 'L73' 'noised-launchpad' 'only the creator may pay for launch' (E 'src\instructions\launch.rs' '        has_one = dbc_config @ LaunchpadError::AccountMismatch,' '        has_one = dbc_config @ LaunchpadError::AccountMismatch, constraint = launch.creator == payer.key() @ LaunchpadError::WrongCreator,')),
    # The adversarial review of the metadata change: attest_launch's record
    # account is the address the signed hash names, so whoever relays a
    # signature cannot turn one that attests into a burn (metadata_record).
    (M 'L74' 'noised-launchpad' 'attest_launch takes any account as the record (a relayer turns an attesting signature into a burn)' (E 'src\instructions\attest_launch.rs' '    if token_meta_key != record {' '    if false && token_meta_key != record {')),
    # Audit round 3 (F1), against metadata_record: an attestation whose window
    # passed while the launch was Configured is replaced, whole, by the next
    # attesting signature; one whose window has not ended, or of a Live
    # launch, never changes; a window is recorded only with a minute left.
    (M 'L75' 'noised-launchpad' 'an attestation is written once (a window that passed unused leaves the launch Configured forever)' (E 'src\instructions\attest_launch.rs' "        || (launch.status == LaunchStatus::Configured`n" "        || (false && launch.status == LaunchStatus::Configured`n")),
    (M 'L76' 'noised-launchpad' 'a Live launch''s attestation is replaced once its window has passed' (E 'src\instructions\attest_launch.rs' "        || (launch.status == LaunchStatus::Configured`n" "        || ((launch.status == LaunchStatus::Configured || true)`n")),
    (M 'L77' 'noised-launchpad' 'an attestation is replaced in its window''s last second' (E 'src\instructions\attest_launch.rs' '            && now.unix_timestamp > attestation.not_after);' '            && now.unix_timestamp >= attestation.not_after);')),
    (M 'L78' 'noised-launchpad' 'an attestation whose window has not ended is replaced' (E 'src\instructions\attest_launch.rs' '            && now.unix_timestamp > attestation.not_after);' '            && true);')),
    (M 'L79' 'noised-launchpad' 'an attestation is replaced once its window has opened (not_before for not_after)' (E 'src\instructions\attest_launch.rs' '            && now.unix_timestamp > attestation.not_after);' '            && now.unix_timestamp > attestation.not_before);')),
    (M 'L80' 'noised-launchpad' 'a replacement keeps the old record (the metadata hash is written once)' (E 'src\instructions\attest_launch.rs' "        attestation.metadata_hash = metadata_hash;`n" "        if attestation.metadata_hash == [0; 32] {`n            attestation.metadata_hash = metadata_hash;`n        }`n")),
    (M 'L81' 'noised-launchpad' 'a replacement keeps the old message hash' (E 'src\instructions\attest_launch.rs' "        attestation.message_hash = solana_sha256_hasher::hash(&message).to_bytes();`n" "        if attestation.message_hash == [0; 32] {`n            attestation.message_hash = solana_sha256_hasher::hash(&message).to_bytes();`n        }`n")),
    (M 'L82' 'noised-launchpad' 'a replacement keeps the old leaf' (E 'src\instructions\attest_launch.rs' "        attestation.leaf = leaf;`n" "        if attestation.message_hash == [0; 32] {`n            attestation.leaf = leaf;`n        }`n")),
    (M 'L83' 'noised-launchpad' 'a replacement keeps the old slot' (E 'src\instructions\attest_launch.rs' "        attestation.slot = now.slot;`n" "        if attestation.slot == 0 {`n            attestation.slot = now.slot;`n        }`n")),
    (M 'L84' 'noised-launchpad' 'a replacement keeps the old window' (E 'src\instructions\attest_launch.rs' "        attestation.not_before = not_before;`n        attestation.not_after = not_after;`n" "        if attestation.not_after == 0 {`n            attestation.not_before = not_before;`n            attestation.not_after = not_after;`n        }`n")),
    (M 'L85' 'noised-launchpad' 'a replacement keeps the old signature' (E 'src\instructions\attest_launch.rs' "        attestation.signature = lms_sig;`n" "        if attestation.signature.is_empty() {`n            attestation.signature = lms_sig;`n        }`n")),
    (M 'L86' 'noised-launchpad' 'a window is recorded without a minute left (the pre-audit-3 rule: not over when it lands)' (E 'src\pq.rs' "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n" "        && now <= end`n")),
    (M 'L87' 'noised-launchpad' 'a window with 59 seconds left is recorded' (E 'src\pq.rs' "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n" "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end + 1`n")),
    (M 'L88' 'noised-launchpad' 'a window with exactly a minute left is refused' (E 'src\pq.rs' "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n" "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) < end`n")),
    (M 'L89' 'noised-launchpad' 'the minute is counted from the opening only (a late landing is recorded)' (E 'src\pq.rs' "        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n" "        && start + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end`n")),
    # Programmable launches (PROGRAMMABLE_V1 §1.2, §2, §3): the hook's creator
    # rules, the launchpad's rules record, attestation message v3 and
    # pq_authorize (the Authorization layout the autopilot reads).
    (M 'HR1' 'noised-hook' 'create_policy stores rules without verifying them' (E 'src\lib.rs' 'params.rules.is_empty() || RuleSet::verify(&params.rules, params.guard_secs).is_ok(),' 'true,')),
    (M 'HR2' 'noised-hook' 'create_policy verifies rules for 72 hours, not the policy''s guard' (E 'src\lib.rs' 'RuleSet::verify(&params.rules, params.guard_secs)' 'RuleSet::verify(&params.rules, 259_200)')),
    (M 'HR3' 'noised-hook' 'the policy keeps no rules' (E 'src\lib.rs' "        policy.rules = params.rules;`n" "        let _ = params.rules;`n")),
    (M 'HR4' 'noised-hook' 'PolicyCreated reports no rules length' (E 'src\lib.rs' 'rules_len: policy.rules.len() as u16,' 'rules_len: 0,')),
    (M 'HR5' 'noised-hook' 'the policy is sized for the largest rule set' (E 'src\lib.rs' 'space = HookPolicy::space(params.rules.len()),' 'space = HookPolicy::space(noised_rules::rules::MAX_LEN),')),
    (M 'HR6' 'noised-hook' 'rules never see the top-level program' (E 'src\lib.rs' 'Ok((ix.program_id, u16::from_le_bytes(*count)))' 'Ok((Pubkey::default(), u16::from_le_bytes(*count)))')),
    (M 'HR7' 'noised-hook' 'rules see one top-level instruction' (E 'src\lib.rs' 'Ok((ix.program_id, u16::from_le_bytes(*count)))' 'Ok((ix.program_id, 1))')),
    (M 'HR8' 'noised-hook' 'rules read the transaction''s first instruction, not the current one' (E 'src\lib.rs' "let ix = load_instruction_at_checked(usize::from(index), instructions)?;`n    let data = instructions" "let ix = load_instruction_at_checked(0, instructions)?; let _ = index;`n    let data = instructions")),
    (M 'HR9' 'noised-hook' 'the mint''s supply is read at the wrong offset' (E 'src\lib.rs' '.get(36..44)' '.get(4..12)')),
    (M 'HR10' 'noised-hook' 'rules never see the mint''s supply' (E 'src\lib.rs' "                view.supply = mint_supply(&ctx.accounts.mint)?;`n" "                view.supply = 0;`n")),
    (M 'HR11' 'noised-hook' 'the creator rules are never evaluated' (E 'src\lib.rs' "                rules::creator_rules(&policy, &view)`n" "                Ok(())`n")),
    (M 'HR12' 'noised-hook' 'a rule refusal is reported as MaxBuy' (E 'src\lib.rs' 'error!(HookError::RuleDenied)' 'error!(HookError::MaxBuy)')),
    (M 'HR13' 'noised-hook' 'the log swaps the rule index and its code' (E 'src\lib.rs' "                    v.rule,`n                    v.code`n" "                    v.code,`n                    v.rule`n")),
    # Review 4. R1: creator rules never see a transfer whose top-level
    # instruction is the PQ vault (holders' custody exits; the shield's are
    # the shield suite's). R3: sells and the guard's end are decided from the
    # policy's head, before it is decoded. Rb: only a transfer that reaches
    # the rules reads the supply and the instructions sysvar.
    (M 'HR14' 'noised-hook' 'rules hold the vault''s releases' (E 'src\rules.rs' '    if t.top_program == VAULT_PROGRAM_ID || t.top_program == SHIELD_PROGRAM_ID {' '    if t.top_program == SHIELD_PROGRAM_ID {')),
    (M 'HR15' 'noised-hook' 'rules skip every transfer of a program''s CPI' (E 'src\rules.rs' '    if t.top_program == VAULT_PROGRAM_ID || t.top_program == SHIELD_PROGRAM_ID {' '    if t.top_program != anchor_spl::token_2022::ID {')),
    (M 'HR16' 'noised-hook' 'the vault''s id is off' (E 'src\lib.rs' 'pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");' 'pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9");')),
    (M 'H44' 'noised-hook' 'the whole policy is decoded before the sell check (R3)' (E 'src\lib.rs' "        let head = PolicyHead::read(&data)?;`n" "        let head = PolicyHead::read(&data)?;`n        HookPolicy::try_deserialize(&mut &data[..])?;`n")),
    (M 'H45' 'noised-hook' 'the head reads the shield''s end as the guard''s' (E 'src\state.rs' 'pub const GUARD_END_TS_OFFSET: usize = 122;' 'pub const GUARD_END_TS_OFFSET: usize = 114;')),
    (M 'H46' 'noised-hook' 'the head reads the pool as the base vault' (E 'src\state.rs' 'pub const BASE_VAULT_OFFSET: usize = 74;' 'pub const BASE_VAULT_OFFSET: usize = 42;')),
    (M 'H47' 'noised-hook' 'the head takes any discriminator' (E 'src\state.rs' "        require!(`n            discriminator == HookPolicy::DISCRIMINATOR,`n            ErrorCode::AccountDiscriminatorMismatch`n        );`n" "        let _ = discriminator;`n")),
    (M 'H48' 'noised-hook' 'sells pass a head of another mint' @((E 'src\lib.rs' "        require_keys_eq!(`n            head.mint,`n            ctx.accounts.mint.key(),`n            HookError::PolicyMismatch`n        );`n" ''), (E 'src\lib.rs' "        let policy = HookPolicy::try_deserialize(&mut &data[..])?;`n" "        require_keys_eq!(head.mint, ctx.accounts.mint.key(), HookError::PolicyMismatch);`n        let policy = HookPolicy::try_deserialize(&mut &data[..])?;`n"))),
    (M 'H49' 'noised-hook' 'every decoded transfer under rules reads the supply and the sysvar (Rb)' (E 'src\lib.rs' "        let decision = match rules::built_ins(&policy, &view) {`n" "        if !policy.rules.is_empty() {`n            (view.top_program, view.tx_ix_count) = top_level(&ctx.accounts.instructions)?;`n            view.supply = mint_supply(&ctx.accounts.mint)?;`n        }`n        let decision = match rules::built_ins(&policy, &view) {`n")),
    (M 'H50' 'noised-hook' 'a policy without rules reads the supply and the sysvar (Rb)' (E 'src\lib.rs' '            Ok(Step::CreatorRules) if !policy.rules.is_empty() => {' '            Ok(Step::CreatorRules) => {')),
    (M 'LR1' 'noised-launchpad' 'publish_rules stores rules without verifying them' (E 'src\instructions\publish_rules.rs' 'RuleSet::verify(&bytes, ctx.accounts.launch.guard_secs).is_ok(),' 'true,')),
    (M 'LR2' 'noised-launchpad' 'publish_rules verifies rules for 72 hours, not the launch''s guard' (E 'src\instructions\publish_rules.rs' 'RuleSet::verify(&bytes, ctx.accounts.launch.guard_secs)' 'RuleSet::verify(&bytes, 259_200)')),
    (M 'LR3' 'noised-launchpad' 'publishing again rewrites the record and emits RulesPublished' (E 'src\instructions\publish_rules.rs' '    if record.version != 0 {' '    if false {')),
    (M 'LR4' 'noised-launchpad' 'a rules record stores no hash' (E 'src\instructions\publish_rules.rs' '    record.rules_hash = rules_hash;' '    record.rules_hash = [0; 32];')),
    (M 'LR5' 'noised-launchpad' 'a rules record stores another bump' (E 'src\instructions\publish_rules.rs' '    record.bump = ctx.bumps.rules;' '    record.bump = ctx.bumps.rules.wrapping_sub(1);')),
    (M 'LR6' 'noised-launchpad' 'a rules record stores no launch' (E 'src\instructions\publish_rules.rs' '    record.launch = launch_key;' '    record.launch = Pubkey::default();')),
    (M 'LR7' 'noised-launchpad' 'a rules record stores version 0' (E 'src\instructions\publish_rules.rs' '    record.version = LaunchRules::VERSION;' '    record.version = 0;')),
    (M 'LR8' 'noised-launchpad' 'RulesPublished reports another length' (E 'src\instructions\publish_rules.rs' "        len,`n" "        len: len + 1,`n")),
    (M 'LR9' 'noised-launchpad' 'the rules hash has another domain tag' (E 'src\pq.rs' 'noised_rules::rules_hash::<SolSha256>(bytes)' 'solana_sha256_hasher::hashv(&[b"PHX-RULES-V2", bytes]).to_bytes()')),
    (M 'LR10' 'noised-launchpad' 'the message leaves out the rules hash' (E 'src\pq.rs' "        &terms.rules_hash,`n" "        &[0u8; 32],`n")),
    (M 'LR11' 'noised-launchpad' 'the rules hash and the metadata hash swap places in the message' (E 'src\pq.rs' "        &terms.metadata_hash,`n        &terms.rules_hash,`n" "        &terms.rules_hash,`n        &terms.metadata_hash,`n")),
    (M 'LR12' 'noised-launchpad' 'the attestation records no rules hash' (E 'src\instructions\attest_launch.rs' "        attestation.rules_hash = rules_hash;`n" '')),
    (M 'LR13' 'noised-launchpad' 'LaunchAttested reports no rules hash' (E 'src\instructions\attest_launch.rs' "            rules_hash,`n            slot: now.slot," "            rules_hash: [0; 32],`n            slot: now.slot,")),
    (M 'LR14' 'noised-launchpad' 'unpublished rules are attested' (E 'src\instructions\attest_launch.rs' "                pq::is_rules_record(info, &launch_key, &rules_hash, bump)`n" "                let _ = (info, bump);`n                true`n")),
    (M 'LR15' 'noised-launchpad' 'attest_launch takes a rules record of another owner' (E 'src\pq.rs' "    rules_hash: &[u8; 32],`n    bump: u8,`n) -> bool {`n    if *info.owner != crate::ID {`n        return false;`n    }`n" "    rules_hash: &[u8; 32],`n    bump: u8,`n) -> bool {`n")),
    (M 'LR16' 'noised-launchpad' 'attest_launch takes any discriminator as a rules record' (E 'src\pq.rs' "        && data[..8] == *LaunchRules::DISCRIMINATOR`n" '')),
    (M 'LR17' 'noised-launchpad' 'attest_launch takes a rules record of any version' (E 'src\pq.rs' "        && data[LaunchRules::VERSION_OFFSET] == LaunchRules::VERSION`n" '')),
    (M 'LR18' 'noised-launchpad' 'attest_launch takes a rules record whose stored bump is not its address''s' (E 'src\pq.rs' "        && data[LaunchRules::BUMP_OFFSET] == bump`n" '')),
    (M 'LR19' 'noised-launchpad' 'attest_launch takes a rules record of another launch' (E 'src\pq.rs' "        && data[launch_at..launch_at + 32] == launch.to_bytes()`n        && data[hash_at..hash_at + 32] == *rules_hash" '        && data[hash_at..hash_at + 32] == *rules_hash')),
    (M 'LR20' 'noised-launchpad' 'attest_launch takes a rules record of another hash' (E 'src\pq.rs' "`n        && data[hash_at..hash_at + 32] == *rules_hash" '')),
    (M 'LR21' 'noised-launchpad' 'attest_launch reads an account shorter than a rules record' (E 'src\pq.rs' "    data.len() >= LaunchRules::FIXED_LEN`n        && data[..8]" '    data[..8]')),
    (M 'LR22' 'noised-launchpad' 'the authorization message does not bind the program id' (E 'src\pq.rs' "        AUTH_MESSAGE_TAG,`n        program_id.as_ref(),`n" "        AUTH_MESSAGE_TAG,`n        &[0u8; 32],`n")),
    (M 'LR23' 'noised-launchpad' 'the authorization message leaves out the kind' (E 'src\pq.rs' "        &[kind],`n" "        &[0],`n")),
    (M 'LR24' 'noised-launchpad' 'the authorization message names the launch as creator' (E 'src\pq.rs' "        launch.as_ref(),`n        creator.as_ref(),`n        &[kind]," "        launch.as_ref(),`n        launch.as_ref(),`n        &[kind],")),
    (M 'LR25' 'noised-launchpad' 'another identity''s signature authorizes' (E 'src\instructions\pq_authorize.rs' '    if auth.version == 0 && pq_identity == launch.pq_identity && AUTHORIZATION_KINDS.contains(&kind)' '    if auth.version == 0 && AUTHORIZATION_KINDS.contains(&kind)')),
    (M 'LR26' 'noised-launchpad' 'a second signature rewrites an authorization' (E 'src\instructions\pq_authorize.rs' '    if auth.version == 0 && pq_identity == launch.pq_identity && AUTHORIZATION_KINDS.contains(&kind)' '    if pq_identity == launch.pq_identity && AUTHORIZATION_KINDS.contains(&kind)')),
    (M 'LR27' 'noised-launchpad' 'an authorization stores another bump' (E 'src\instructions\pq_authorize.rs' '        auth.bump = ctx.bumps.authorization;' '        auth.bump = ctx.bumps.authorization.wrapping_sub(1);')),
    (M 'LR28' 'noised-launchpad' 'an authorization stores no message hash' (E 'src\instructions\pq_authorize.rs' '        auth.message_hash = solana_sha256_hasher::hash(&message).to_bytes();' '        auth.message_hash = payload_hash;')),
    (M 'LR29' 'noised-launchpad' 'an authorization stores the slot as its time' (E 'src\instructions\pq_authorize.rs' '        auth.unix_time = now.unix_timestamp;' '        auth.unix_time = now.slot as i64;')),
    (M 'LR30' 'noised-launchpad' 'an authorization stores slot 0' (E 'src\instructions\pq_authorize.rs' '        auth.slot = now.slot;' '        auth.slot = 0;')),
    (M 'LR31' 'noised-launchpad' 'an authorization stores leaf 0' (E 'src\instructions\pq_authorize.rs' '        auth.leaf = leaf;' '        auth.leaf = 0;')),
    (M 'LR32' 'noised-launchpad' 'an authorization keeps no signature' (E 'src\instructions\pq_authorize.rs' '        auth.signature = lms_sig;' '        auth.signature = Vec::new();')),
    (M 'LR33' 'noised-launchpad' 'an authorization stores kind 0' (E 'src\instructions\pq_authorize.rs' '        auth.kind = kind;' '        auth.kind = 0;')),
    (M 'LR34' 'noised-launchpad' 'Authorized reports the payload as the authorization' (E 'src\instructions\pq_authorize.rs' '            authorization: authorization_key,' '            authorization: Pubkey::new_from_array(payload_hash),')),
    (M 'LR35' 'noised-launchpad' 'an authorization is at an address without its kind' (E 'src\instructions\pq_authorize.rs' 'seeds = [AUTH_SEED, launch.key().as_ref(), &[kind], payload_hash.as_ref()],' 'seeds = [AUTH_SEED, launch.key().as_ref(), payload_hash.as_ref()],')),
    (M 'LR36' 'noised-launchpad' 'an authorization version 2' (E 'src\state.rs' "impl Authorization {`n    pub const VERSION: u8 = 1;" "impl Authorization {`n    pub const VERSION: u8 = 2;"))
)

New-Item -ItemType Directory -Force $logs, $pristine | Out-Null
# Reuse the dependency artifacts (registry crates do not depend on the
# workspace path), so only our crates compile here.
foreach ($d in 'release', 'sbpfv3-solana-solana') {
    cmd /c "robocopy `"$SbfTarget\$d`" `"$target\$d`" /E /NFL /NDL /NJH /NJS /NP > NUL"
}
Pin-TestBinaries
Sync-Workspace
$hash = @{}
foreach ($prog in $programs) {
    Restore-Program $prog # fresh mtimes: a real compile of the pristine copy
    $so = Build $prog "pristine-$prog"
    if (-not $so) { throw "pristine build of $prog failed, see $logs" }
    Copy-Item $so $pristine -Force
    $hash[$prog] = (Get-FileHash $so).Hash
}
$base = Run-Tests 'pristine'
$base | Format-Table -AutoSize | Out-String -Width 300 | Write-Output
if ($base | Where-Object { $_.Exit -ne 0 }) { throw 'the pristine programs fail the tests' }

$globs = @($Only -split ',' | Where-Object { $_ })
$results = @(foreach ($m in ($mutants | Where-Object { $id = $_.Id; [bool]($globs | Where-Object { $id -like $_ }) })) {
    foreach ($e in $m.Edits) {
        $path = Edit-Path $m $e
        $text = [IO.File]::ReadAllText($path)
        $count = ([regex]::Matches($text, [regex]::Escape($e.Old))).Count
        if ($count -ne 1) { throw "$($m.Id): expected exactly one match in $($e.File), found $count" }
        Write-Source $path ($text.Replace($e.Old, $e.New))
    }
    $so = Build $m.Prog $m.Id
    if (-not $so) {
        $row = [pscustomobject]@{ Id = $m.Id; Mutation = $m.Desc; Killed = 'BUILD FAILED'; FailingTests = "see $logs\build-$($m.Id).log" }
    } else {
        if ((Get-FileHash $so).Hash -eq $hash[$m.Prog]) { throw "$($m.Id): mutant binary equals the pristine one" }
        $rows = Run-Tests $m.Id
        $row = [pscustomobject]@{
            Id = $m.Id; Mutation = $m.Desc
            Killed = [bool]($rows | Where-Object { $_.Exit -ne 0 })
            FailingTests = ($rows | Where-Object { $_.Failed } | ForEach-Object { "$($_.Bin): $($_.Failed)" }) -join ' | '
        }
    }
    Restore-Edits $m
    Copy-Item (Join-Path $pristine (($m.Prog -replace '-', '_') + '.so')) $deploy -Force
    $row
})
$results | Format-List | Out-String -Width 400 | Write-Output
$survivors = @($results | Where-Object { $_.Killed -ne $true })
Write-Output "killed $($results.Count - $survivors.Count) of $($results.Count) mutants"
if ($survivors.Count -gt 0) { exit 1 }
