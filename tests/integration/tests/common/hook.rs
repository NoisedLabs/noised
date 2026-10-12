//! Client for `noised_hook`: PDAs, instruction builders (including a
//! direct `execute`), the launchpad's CPIs signed by its `hook-authority`
//! PDA (through a relay at the launchpad's program id), policy injection.

use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use noised_hook::state::{
    HookPolicy, PolicyParams, DBC_TOKEN_VAULT_SEED, HOOK_AUTHORITY_SEED, MAX_EXEMPT,
    META_LIST_SEED, POLICY_SEED,
};
use solana_account::Account;
use solana_signer::Signer;

use super::{
    relay::relay_signed_ix, sha256, svm::TxExpect, AccountMeta, Harness, Instruction, Pubkey,
    DBC_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID, SYSTEM_PROGRAM_ID,
};

pub const HOOK_ID: Pubkey = noised_hook::ID;
/// The instructions sysvar: the hook's second extra account, read to tell
/// the batch buy (inside the launchpad's `execute_batch`) from other buys.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey =
    anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");

pub fn policy_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POLICY_SEED, mint.as_ref()], &HOOK_ID)
}

pub fn meta_list_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[META_LIST_SEED, mint.as_ref()], &HOOK_ID).0
}

/// The launchpad PDA that alone may sign `create_policy` and
/// `end_snipe_shield`.
pub fn hook_authority() -> Pubkey {
    hook_authority_of(&LAUNCHPAD_PROGRAM_ID).0
}

/// The `["hook-authority"]` PDA of `program` and its bump: the launchpad's
/// for the launchpad, a look-alike for any other program.
pub fn hook_authority_of(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED], program)
}

/// `ix` sent as the launchpad sends it: a CPI from a top-level instruction
/// of `caller` (a [`Relay`](super::relay) registered at that id) tagged
/// `tag`, signed with the seeds of `caller`'s `["hook-authority"]` PDA. The
/// runtime derives the PDA from those seeds and `caller`, so the account at
/// `authority` in `ix` is a signer only if it is that PDA: with the
/// launchpad's id, the launchpad's `hook-authority`, the one signer the hook
/// accepts. Every signature the transaction carries is verified.
pub fn as_hook_authority_cpi(
    caller: &Pubkey,
    tag: [u8; 8],
    ix: &Instruction,
    authority: usize,
) -> Instruction {
    let bump = [hook_authority_of(caller).1];
    let seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, &bump];
    relay_signed_ix(caller, tag, ix, &[(authority, seeds)])
}

/// Meteora DBC base vault of `pool` for `mint`.
pub fn dbc_base_vault(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[DBC_TOKEN_VAULT_SEED, mint.as_ref(), pool.as_ref()],
        &DBC_PROGRAM_ID,
    )
    .0
}

pub fn init_meta_list_ix(payer: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: HOOK_ID,
        accounts: noised_hook::accounts::InitializeExtraAccountMetaList {
            payer: *payer,
            extra_account_meta_list: meta_list_pda(mint),
            mint: *mint,
            system_program: SYSTEM_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: noised_hook::instruction::InitializeExtraAccountMetaList.data(),
    }
}

/// `create_policy` with `authority` in the launchpad-authority slot
/// (account 1), marked as a signer only if `authority_signs` (nobody holds
/// a key for the real PDA, so a transaction can only pass it unsigned; the
/// launchpad signs for it in a CPI, see [`as_hook_authority_cpi`]).
pub fn create_policy_ix(
    payer: &Pubkey,
    authority: &Pubkey,
    authority_signs: bool,
    mint: &Pubkey,
    pool: &Pubkey,
    params: PolicyParams,
) -> Instruction {
    let mut accounts = noised_hook::accounts::CreatePolicy {
        payer: *payer,
        launchpad_authority: *authority,
        mint: *mint,
        pool: *pool,
        policy: policy_pda(mint).0,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    accounts[1].is_signer = authority_signs;
    Instruction {
        program_id: HOOK_ID,
        accounts,
        data: noised_hook::instruction::CreatePolicy { params }.data(),
    }
}

/// `end_snipe_shield` on `policy` with `authority` in the
/// launchpad-authority slot (account 0), marked as a signer only if
/// `authority_signs`, then the instructions sysvar. The launchpad signs it
/// with its PDA inside `execute_batch` ([`as_hook_authority_cpi`] sends it
/// that way).
pub fn end_snipe_shield_ix(
    authority: &Pubkey,
    authority_signs: bool,
    policy: &Pubkey,
) -> Instruction {
    let mut accounts = noised_hook::accounts::EndSnipeShield {
        launchpad_authority: *authority,
        policy: *policy,
        instructions: INSTRUCTIONS_SYSVAR_ID,
    }
    .to_account_metas(None);
    accounts[0].is_signer = authority_signs;
    Instruction {
        program_id: HOOK_ID,
        accounts,
        data: noised_hook::instruction::EndSnipeShield.data(),
    }
}

/// The hook's `Execute` instruction sent on its own, with the accounts
/// Token-2022 passes for a transfer of `amount` from `source` to
/// `destination`: source, mint, destination, authority, the meta list, then
/// the policy PDA and the instructions sysvar it resolves. The hook keeps no
/// state, so this only asks for its decision. It is how a test puts inputs
/// before the hook that Token-2022 never sends it: Token-2022 returns from a
/// self-transfer (source == destination) before moving funds or calling
/// the hook.
pub fn execute_ix(
    mint: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
) -> Instruction {
    spl_transfer_hook_interface::instruction::execute_with_extra_account_metas(
        &HOOK_ID,
        source,
        mint,
        destination,
        authority,
        &meta_list_pda(mint),
        &[
            AccountMeta::new_readonly(policy_pda(mint).0, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
        ],
        amount,
    )
}

/// The TLV bytes `initialize_extra_account_meta_list` must write, encoded by
/// hand (independently of the resolution library the program uses): a PDA
/// of the hook program with seeds `["policy", <account 1 = mint>]`, then
/// the instructions sysvar by address, neither of them signer nor writable.
pub fn expected_meta_list_data() -> Vec<u8> {
    let mut d = Vec::with_capacity(86);
    // TLV type: the Execute instruction's SPL discriminator.
    d.extend_from_slice(&sha256(&[b"spl-transfer-hook-interface:execute"])[..8]);
    d.extend_from_slice(&74u32.to_le_bytes()); // TLV length: count + two 35-byte entries
    d.extend_from_slice(&2u32.to_le_bytes()); // entries
    d.push(1); // ExtraAccountMeta discriminator 1: PDA of the hook program
    let mut config = [0u8; 32];
    config[..8].copy_from_slice(&[1, 6, b'p', b'o', b'l', b'i', b'c', b'y']); // Literal "policy"
    config[8..10].copy_from_slice(&[3, 1]); // AccountKey index 1 (the mint)
    d.extend_from_slice(&config);
    d.push(0); // is_signer
    d.push(0); // is_writable
    d.push(0); // ExtraAccountMeta discriminator 0: a fixed address
    d.extend_from_slice(INSTRUCTIONS_SYSVAR_ID.as_ref());
    d.push(0); // is_signer
    d.push(0); // is_writable
    d
}

/// Inputs for a test policy; times are relative to `launch_ts`.
#[derive(Clone, Debug)]
pub struct PolicySpec {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub base_vault: Pubkey,
    pub launch_ts: i64,
    pub shield_secs: i64,
    pub guard_secs: i64,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: Vec<Pubkey>,
    /// PXR1 creator rules (empty for none).
    pub rules: Vec<u8>,
}

impl PolicySpec {
    pub fn to_policy(&self) -> HookPolicy {
        assert!(self.exempt.len() <= MAX_EXEMPT);
        let mut exempt = [Pubkey::default(); MAX_EXEMPT];
        exempt[..self.exempt.len()].copy_from_slice(&self.exempt);
        HookPolicy {
            version: HookPolicy::VERSION,
            bump: policy_pda(&self.mint).1,
            mint: self.mint,
            pool: self.pool,
            base_vault: self.base_vault,
            launch_ts: self.launch_ts,
            snipe_shield_end_ts: self.launch_ts + self.shield_secs,
            guard_end_ts: self.launch_ts + self.guard_secs,
            max_wallet: self.max_wallet,
            max_buy: self.max_buy,
            p2p_locked: self.p2p_locked,
            exempt,
            rules: self.rules.clone(),
        }
    }
}

impl Harness {
    /// Create `mint`'s ExtraAccountMetaList (permissionless).
    pub fn init_meta_list(&mut self, mint: &Pubkey) {
        let ix = init_meta_list_ix(&self.payer.pubkey(), mint);
        self.send(&[ix], &[])
            .expect_ok("initialize_extra_account_meta_list");
    }

    /// Write `policy` into its PDA as `create_policy` would have: Anchor
    /// discriminator + borsh, owned by the hook program, rent-exempt. The
    /// discriminator is checked against `sha256("account:HookPolicy")`.
    pub fn inject_policy(&mut self, policy: &HookPolicy) -> Pubkey {
        let mut data = Vec::new();
        policy
            .try_serialize(&mut data)
            .expect("serialize HookPolicy");
        assert_eq!(data.len(), HookPolicy::space(policy.rules.len()));
        assert_eq!(
            data[..8],
            super::anchor_discriminator("account", "HookPolicy")
        );
        self.inject_raw_policy(&policy.mint, data)
    }

    /// Put arbitrary bytes at `mint`'s policy PDA (owned by the hook program).
    pub fn inject_raw_policy(&mut self, mint: &Pubkey, data: Vec<u8>) -> Pubkey {
        let pda = policy_pda(mint).0;
        let account = Account {
            lamports: self.rent_exempt(data.len()),
            data,
            owner: HOOK_ID,
            executable: false,
            rent_epoch: 0,
        };
        self.set_account(pda, account);
        pda
    }

    pub fn policy(&self, mint: &Pubkey) -> Option<HookPolicy> {
        let pda = policy_pda(mint).0;
        self.account(&pda).map(|_| self.anchor_account(&pda))
    }
}
