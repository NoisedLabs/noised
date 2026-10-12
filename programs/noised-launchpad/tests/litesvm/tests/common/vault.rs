//! Noised PQ vaults in launchpad tests: LM-OTS keys, `open_vault`, and a
//! withdrawal with its release, as `tests/integration` builds them. The
//! treasury and a commit's payout owners may be vaults (PQ v2 A7, A8).

use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;
use noised_lmots::{key_id, PrivateKey, PublicKey, Sha2, ID_LEN, SIG_LEN};
use noised_vault::{
    accounts as vacc, instruction as vix, message::withdraw_message, state::VaultKey, WithdrawArgs,
};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::{pq::sha256, Env, Expect, Pubkey, ATA_PROGRAM_ID};

/// SPL Memo v2 (`release` names it; LiteSVM ships it).
pub const MEMO_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// The LM-OTS key of vault `label` at `sequence` (its `q`).
pub fn vault_key(label: &str, sequence: u32) -> PrivateKey {
    let path = [label.as_bytes(), &sequence.to_le_bytes()].concat();
    let mut id = [0u8; ID_LEN];
    id.copy_from_slice(&sha256(&[b"phalanx-lp-test/vault/id", &path])[..ID_LEN]);
    PrivateKey {
        id,
        q: sequence,
        seed: sha256(&[b"phalanx-lp-test/vault/seed", &path]),
    }
}

fn vault_key_arg(pk: &PublicKey) -> VaultKey {
    VaultKey {
        id: pk.id,
        q: pk.q,
        k: pk.k,
    }
}

/// An opened vault.
#[derive(Clone, Debug)]
pub struct TestVault {
    pub label: String,
    pub address: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// The vault's token account: its canonical ATA for `mint`.
    pub token_account: Pubkey,
    pub sequence: u32,
}

/// `["vault", mint, key_id]` of the vault program.
pub fn vault_pda(mint: &Pubkey, genesis_key_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[b"vault", mint.as_ref(), genesis_key_id],
        &noised_vault::ID,
    )
    .0
}

/// The address vault `label` of `mint` gets when it is opened (known before:
/// it derives from the vault's first key).
pub fn vault_address(mint: &Pubkey, label: &str) -> Pubkey {
    vault_pda(
        mint,
        &key_id::<Sha2>(&vault_key(label, 0).public_key::<Sha2>()),
    )
}

/// Open vault `label` for `mint` (paid by `payer`).
pub fn open_vault(
    env: &mut Env,
    payer: &Keypair,
    mint: &Pubkey,
    token_program: &Pubkey,
    label: &str,
) -> TestVault {
    let pk = vault_key(label, 0).public_key::<Sha2>();
    let id = key_id::<Sha2>(&pk);
    let address = vault_pda(mint, &id);
    let token_account = ata(&address, mint, token_program);
    let ix = Instruction {
        program_id: noised_vault::ID,
        accounts: vacc::OpenVault {
            payer: payer.pubkey(),
            mint: *mint,
            vault: address,
            vault_token_account: token_account,
            token_program: *token_program,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: vix::OpenVault {
            key_id_arg: id,
            key: vault_key_arg(&pk),
        }
        .data(),
    };
    let payer_key = payer.pubkey();
    env.send_with(&payer_key, &[ix], &[payer], true)
        .expect_ok("open_vault");
    TestVault {
        label: label.to_string(),
        address,
        mint: *mint,
        token_program: *token_program,
        token_account,
        sequence: 0,
    }
}

impl TestVault {
    fn payout(&self, sequence: u32) -> Pubkey {
        Pubkey::find_program_address(
            &[
                b"payout",
                self.address.as_ref(),
                &u64::from(sequence).to_le_bytes(),
            ],
            &noised_vault::ID,
        )
        .0
    }

    /// The vault's signed withdrawal of up to `max_amount` to
    /// `destination_owner` (the vault's key at its sequence signs; the next
    /// key has `q = sequence + 1`), relayed by `payer`.
    pub fn withdraw_ix(
        &self,
        payer: &Pubkey,
        destination_owner: &Pubkey,
        max_amount: u64,
    ) -> Instruction {
        let key = vault_key(&self.label, self.sequence);
        let next = vault_key(&self.label, self.sequence + 1).public_key::<Sha2>();
        let next_key_id = key_id::<Sha2>(&next);
        let msg = withdraw_message(
            &noised_vault::ID,
            &self.address,
            &self.mint,
            u64::from(self.sequence),
            destination_owner,
            max_amount,
            &next_key_id,
        );
        let mut signature = vec![0u8; SIG_LEN];
        assert!(key.sign_deterministic::<Sha2>(&msg, &mut signature));
        Instruction {
            program_id: noised_vault::ID,
            accounts: vacc::Withdraw {
                payer: *payer,
                mint: self.mint,
                vault: self.address,
                vault_token_account: self.token_account,
                payout: self.payout(self.sequence),
                token_program: self.token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: vix::Withdraw {
                args: WithdrawArgs {
                    signature,
                    destination_owner: *destination_owner,
                    max_amount,
                    next_key_id,
                    next_key: vault_key_arg(&next),
                },
            }
            .data(),
        }
    }

    /// `release` of the payout reserved at `sequence` to the canonical ATA of
    /// `destination_owner`, with `hook` (the mint's hook accounts while its
    /// hook is active).
    pub fn release_ix(
        &self,
        payer: &Pubkey,
        sequence: u32,
        rent_payer: &Pubkey,
        destination_owner: &Pubkey,
        hook: Vec<AccountMeta>,
    ) -> Instruction {
        let mut accounts = vacc::Release {
            payer: *payer,
            mint: self.mint,
            vault: self.address,
            vault_token_account: self.token_account,
            payout: self.payout(sequence),
            rent_payer: *rent_payer,
            destination_owner: *destination_owner,
            destination: ata(destination_owner, &self.mint, &self.token_program),
            memo_program: MEMO_PROGRAM_ID,
            token_program: self.token_program,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(hook);
        Instruction {
            program_id: noised_vault::ID,
            accounts,
            data: vix::Release {}.data(),
        }
    }

    /// `release_to` of the payout reserved at `sequence` into any token
    /// account `destination` of the mint, signed by the recipient
    /// `destination_owner` (the vault's only payout to an account of the
    /// recipient's choice), with `hook` (the mint's hook accounts while its
    /// hook is active).
    pub fn release_to_ix(
        &self,
        sequence: u32,
        rent_payer: &Pubkey,
        destination_owner: &Pubkey,
        destination: &Pubkey,
        hook: Vec<AccountMeta>,
    ) -> Instruction {
        let mut accounts = vacc::ReleaseTo {
            destination_owner: *destination_owner,
            mint: self.mint,
            vault: self.address,
            vault_token_account: self.token_account,
            payout: self.payout(sequence),
            rent_payer: *rent_payer,
            destination: *destination,
            memo_program: MEMO_PROGRAM_ID,
            token_program: self.token_program,
        }
        .to_account_metas(None);
        accounts.extend(hook);
        Instruction {
            program_id: noised_vault::ID,
            accounts,
            data: vix::ReleaseTo {}.data(),
        }
    }
}
