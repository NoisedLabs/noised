//! Client for `noised_vault` (vault v4): LM-OTS keys derived as in SPEC
//! §3.10, the signed withdrawal message, the PDAs, instruction builders and
//! state readers.
//!
//! A user's vaults for one (cluster, mint) are numbered by `account`. Vault
//! `account` lives at `["vault", mint, key_id(key(account, 0))]` forever and
//! its key rotates in place: at sequence `n` it is `key(account, n)`, and
//! every withdrawal hands the vault to `key(account, n + 1)`. A withdrawal
//! only reserves the amount in a `Payout` PDA
//! (`["payout", vault, u64le(sequence)]`); `release` (anyone, to the
//! recipient's canonical ATA) or `release_to` (signed by the recipient, to
//! any token account of the mint) delivers it.
//!
//! The key derivation, the message, `key_id` and the PDAs are re-implemented
//! here from the documented layout rather than imported, so the tests check
//! the program against the format (and `tests/vault.rs` cross-checks them
//! with the crates). Signing uses `noised-lmots`' deterministic signer, and
//! [`spec_randomizer`] re-implements its randomizer for the cross-checks.

use anchor_lang::{InstructionData, ToAccountMetas};
use noised_lmots::{PrivateKey, PublicKey, Sha2, ID_LEN, SIG_LEN};
use noised_vault::{
    state::{Payout, Vault, VaultKey},
    WithdrawArgs,
};
use solana_message::v1;

use super::{
    sha256, token::ata, AccountMeta, Harness, Instruction, Pubkey, ATA_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
};

pub const VAULT_ID: Pubkey = noised_vault::ID;
/// SPL Memo v2. `release` / `release_to` call it right before paying a
/// Token-2022 account that requires memos. LiteSVM 0.17 ships it.
pub const MEMO_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// SPEC §3.10 cluster bytes (the first byte of every derivation path).
pub const CLUSTER_MAINNET: u8 = 0;
pub const CLUSTER_DEVNET: u8 = 1;
pub const CLUSTER_LOCALNET: u8 = 2;
/// `cluster (1) | mint (32) | u32le(account) | u32le(sequence)`.
pub const DERIVATION_PATH_LEN: usize = 1 + 32 + 4 + 4;
/// Domain tag of the deterministic LM-OTS randomizer (SPEC §3.10).
// protocol constant: kept from the original name; changing it changes signatures
pub const RANDOMIZER_TAG: &[u8] = b"phalanx/pq/lmots/C";
/// Domain tag of the v4 withdrawal message.
pub const MESSAGE_TAG: &[u8; 8] = b"PHX-PQV4";
pub const WITHDRAW_MESSAGE_LEN: usize = 185;
/// Borsh `withdraw` instruction data: Anchor discriminator, `Vec` length
/// prefix, signature, `destination_owner`, `max_amount`, `next_key_id`,
/// `VaultKey {id, q, k}`.
pub const WITHDRAW_IX_DATA_LEN: usize = 8 + 4 + SIG_LEN + 32 + 8 + 32 + (ID_LEN + 4 + 32);
/// Compute-unit limit a client sets in a withdrawal's v1 config (SPEC §3).
/// It also covers a `release` in the same transaction.
pub const WITHDRAW_CU_LIMIT: u32 = 400_000;
/// Loaded-accounts data limit a client sets in a withdrawal's v1 config. It
/// must cover the vault, Token-2022, ATA, memo and hook programs (SPEC §3).
pub const WITHDRAW_LOADED_ACCOUNTS_DATA_LIMIT: u32 = 4 * 1024 * 1024;

/// One LM-OTS (`LMOTS_SHA256_N32_W4`) one-time key.
pub struct PqKey {
    /// The vault number this key belongs to (part of the derivation path).
    pub account: u32,
    /// The vault sequence this key signs at; also its LM-OTS `q`.
    pub sequence: u32,
    pub sk: PrivateKey,
    pub pk: PublicKey,
    pub key_id: [u8; 32],
}

/// SPEC §3.10: `cluster (1) | mint (32) | u32le(account) | u32le(sequence)`.
pub fn derivation_path(
    cluster: u8,
    mint: &Pubkey,
    account: u32,
    sequence: u32,
) -> [u8; DERIVATION_PATH_LEN] {
    let mut path = [0u8; DERIVATION_PATH_LEN];
    path[0] = cluster;
    path[1..33].copy_from_slice(mint.as_ref());
    path[33..37].copy_from_slice(&account.to_le_bytes());
    path[37..41].copy_from_slice(&sequence.to_le_bytes());
    path
}

impl PqKey {
    /// The localnet key of vault `account` for `mint` at `sequence` (see
    /// [`PqKey::derive_on`]). Vault `account` is opened with its sequence-0
    /// key and is controlled by the key at its current sequence.
    pub fn derive(master: &[u8; 64], mint: &Pubkey, account: u32, sequence: u32) -> Self {
        Self::derive_on(CLUSTER_LOCALNET, master, mint, account, sequence)
    }

    /// Derived like the SDK (SPEC §3.10), with `path` from [`derivation_path`]:
    /// `SEED = SHA256("phalanx/pq/lmots/seed" | master | path)`,
    /// `I = SHA256("phalanx/pq/lmots/id" | master | path)[..16]`,
    /// `q = sequence`. Keys never repeat because `(account, sequence)` never
    /// repeats.
    pub fn derive_on(
        cluster: u8,
        master: &[u8; 64],
        mint: &Pubkey,
        account: u32,
        sequence: u32,
    ) -> Self {
        let path = derivation_path(cluster, mint, account, sequence);
        let seed = sha256(&[b"phalanx/pq/lmots/seed", master, &path]);
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(&sha256(&[b"phalanx/pq/lmots/id", master, &path])[..ID_LEN]);
        let sk = PrivateKey {
            id,
            q: sequence,
            seed,
        };
        let pk = sk.public_key::<Sha2>();
        Self {
            account,
            sequence,
            key_id: key_id(&pk),
            sk,
            pk,
        }
    }

    pub fn vault_key(&self) -> VaultKey {
        VaultKey {
            id: self.pk.id,
            q: self.pk.q,
            k: self.pk.k,
        }
    }

    /// The vault this key opens as its genesis key.
    pub fn vault(&self, mint: &Pubkey) -> Pubkey {
        vault_pda(mint, &self.key_id)
    }

    /// LM-OTS signature `C || y` over `msg` from `noised-lmots`'
    /// `sign_deterministic`, whose `C` is [`randomizer`]: signing the same
    /// message again gives the same bytes, as the SDK's `signWithdrawal`.
    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        let mut sig = vec![0u8; SIG_LEN];
        assert!(
            self.sk.sign_deterministic::<Sha2>(msg, &mut sig),
            "LM-OTS sign"
        );
        sig
    }

    /// LM-OTS signature `C || y` with a caller-chosen randomizer `C` (fixed
    /// vectors only).
    pub fn sign_with_randomizer(&self, msg: &[u8], c: &[u8; 32]) -> Vec<u8> {
        let mut sig = vec![0u8; SIG_LEN];
        assert!(self.sk.sign::<Sha2>(msg, c, &mut sig), "LM-OTS sign");
        sig
    }
}

/// The randomizer `PqKey::sign` uses: `noised-lmots`' `PrivateKey::randomizer`,
/// `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" | I | u32be(q) | msg)`.
/// Secret, and fixed by the message, so a client that signs the same
/// withdrawal twice reveals one signature, not two (audit finding C1). The
/// program cannot tell how `C` was chosen.
pub fn randomizer(sk: &PrivateKey, msg: &[u8]) -> [u8; 32] {
    sk.randomizer::<Sha2>(msg)
}

/// The same randomizer written out from RFC 2104 (HMAC with SHA-256, 64-byte
/// block, the 32-byte SEED zero-padded) instead of taken from `noised-lmots`:
/// the cross-check that the crate implements the documented construction.
pub fn spec_randomizer(seed: &[u8; 32], id: &[u8; ID_LEN], q: u32, msg: &[u8]) -> [u8; 32] {
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for (i, b) in seed.iter().enumerate() {
        ipad[i] ^= b;
        opad[i] ^= b;
    }
    let inner = sha256(&[&ipad, RANDOMIZER_TAG, id, &q.to_be_bytes(), msg]);
    sha256(&[&opad, &inner])
}

/// The v1 config words a client sends a withdrawal with (SPEC §3). Both
/// limits are set: an unset word means a limit of 0 in v1.
pub fn withdraw_tx_config() -> v1::TransactionConfig {
    v1::TransactionConfig::empty()
        .with_compute_unit_limit(WITHDRAW_CU_LIMIT)
        .with_loaded_accounts_data_size_limit(WITHDRAW_LOADED_ACCOUNTS_DATA_LIMIT)
}

/// `key_id = SHA256(0x20 || u32be(3) || I || u32be(q) || K)` (SPEC §3).
pub fn key_id(pk: &PublicKey) -> [u8; 32] {
    sha256(&[
        &[0x20],
        &3u32.to_be_bytes(),
        &pk.id,
        &pk.q.to_be_bytes(),
        &pk.k,
    ])
}

/// A deterministic stand-in for a BIP-39 seed (64 bytes).
pub fn master_seed(label: &str) -> [u8; 64] {
    let mut m = [0u8; 64];
    m[..32].copy_from_slice(&sha256(&[b"phalanx-it/master/0", label.as_bytes()]));
    m[32..].copy_from_slice(&sha256(&[b"phalanx-it/master/1", label.as_bytes()]));
    m
}

/// `["vault", mint, genesis_key_id]`: stable for the vault's lifetime.
pub fn vault_pda(mint: &Pubkey, genesis_key_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", mint.as_ref(), genesis_key_id], &VAULT_ID).0
}

/// `["payout", vault, u64le(sequence)]`: the reservation of one withdrawal.
pub fn payout_pda(vault: &Pubkey, sequence: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"payout", vault.as_ref(), &sequence.to_le_bytes()],
        &VAULT_ID,
    )
    .0
}

/// SPEC §3 (vault v4): `"PHX-PQV4" | 0x01 | program_id | vault | mint |
/// sequence u64 LE | destination_owner | max_amount u64 LE | next_key_id`
/// (185 bytes). The recipient is a wallet; `release` pays its canonical ATA.
pub fn withdraw_message(
    vault: &Pubkey,
    mint: &Pubkey,
    sequence: u64,
    destination_owner: &Pubkey,
    max_amount: u64,
    next_key_id: &[u8; 32],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(WITHDRAW_MESSAGE_LEN);
    m.extend_from_slice(MESSAGE_TAG);
    m.push(0x01);
    m.extend_from_slice(VAULT_ID.as_ref());
    m.extend_from_slice(vault.as_ref());
    m.extend_from_slice(mint.as_ref());
    m.extend_from_slice(&sequence.to_le_bytes());
    m.extend_from_slice(destination_owner.as_ref());
    m.extend_from_slice(&max_amount.to_le_bytes());
    m.extend_from_slice(next_key_id);
    assert_eq!(m.len(), WITHDRAW_MESSAGE_LEN);
    m
}

/// What a client persists before broadcasting: `key`, the vault's key at
/// `sequence`, signs "reserve up to `max_amount` for `destination_owner`,
/// then hand the vault to `next`".
pub fn sign_withdraw(
    key: &PqKey,
    next: &PqKey,
    vault: &Pubkey,
    mint: &Pubkey,
    sequence: u64,
    destination_owner: &Pubkey,
    max_amount: u64,
) -> WithdrawArgs {
    let msg = withdraw_message(
        vault,
        mint,
        sequence,
        destination_owner,
        max_amount,
        &next.key_id,
    );
    WithdrawArgs {
        signature: key.sign(&msg),
        destination_owner: *destination_owner,
        max_amount,
        next_key_id: next.key_id,
        next_key: next.vault_key(),
    }
}

pub fn open_vault_ix(
    payer: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    key_id_arg: [u8; 32],
    key: VaultKey,
) -> Instruction {
    let vault = vault_pda(mint, &key_id_arg);
    Instruction {
        program_id: VAULT_ID,
        accounts: noised_vault::accounts::OpenVault {
            payer: *payer,
            mint: *mint,
            vault,
            vault_token_account: ata(&vault, mint, token_program),
            token_program: *token_program,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: SYSTEM_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: noised_vault::instruction::OpenVault { key_id_arg, key }.data(),
    }
}

/// `withdraw` of `vault` at `sequence` (the payout PDA it creates). Touches
/// no account of the recipient; `payer` pays the payout's rent and gets it
/// back on release.
pub fn withdraw_ix(
    payer: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    vault: &Pubkey,
    sequence: u64,
    args: &WithdrawArgs,
) -> Instruction {
    Instruction {
        program_id: VAULT_ID,
        accounts: noised_vault::accounts::Withdraw {
            payer: *payer,
            mint: *mint,
            vault: *vault,
            vault_token_account: ata(vault, mint, token_program),
            payout: payout_pda(vault, sequence),
            token_program: *token_program,
            system_program: SYSTEM_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: noised_vault::instruction::Withdraw { args: args.clone() }.data(),
    }
}

/// The accounts that identify one payout to `release` / `release_to`.
#[derive(Clone, Copy, Debug)]
pub struct PayoutRef {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub payout: Pubkey,
    pub rent_payer: Pubkey,
    pub destination_owner: Pubkey,
}

impl PayoutRef {
    /// The recipient's canonical ATA, where `release` pays.
    pub fn canonical_destination(&self) -> Pubkey {
        ata(&self.destination_owner, &self.mint, &self.token_program)
    }

    pub fn vault_token_account(&self) -> Pubkey {
        ata(&self.vault, &self.mint, &self.token_program)
    }
}

/// `release` (anyone; `payer` pays for a missing ATA) into `destination`,
/// which the program requires to be the canonical ATA of the payout's
/// `destination_owner`. `extra` are the transfer-hook accounts for hooked
/// mints (see `Harness::hook_extra_metas`).
pub fn release_ix(
    payer: &Pubkey,
    p: &PayoutRef,
    destination: &Pubkey,
    extra: &[AccountMeta],
) -> Instruction {
    let mut accounts = noised_vault::accounts::Release {
        payer: *payer,
        mint: p.mint,
        vault: p.vault,
        vault_token_account: p.vault_token_account(),
        payout: p.payout,
        rent_payer: p.rent_payer,
        destination_owner: p.destination_owner,
        destination: *destination,
        memo_program: MEMO_PROGRAM_ID,
        token_program: p.token_program,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
    }
    .to_account_metas(None);
    accounts.extend_from_slice(extra);
    Instruction {
        program_id: VAULT_ID,
        accounts,
        data: noised_vault::instruction::Release.data(),
    }
}

/// `release_to`, signed by the payout's `destination_owner`, into any token
/// account of the mint.
pub fn release_to_ix(p: &PayoutRef, destination: &Pubkey, extra: &[AccountMeta]) -> Instruction {
    let mut accounts = noised_vault::accounts::ReleaseTo {
        destination_owner: p.destination_owner,
        mint: p.mint,
        vault: p.vault,
        vault_token_account: p.vault_token_account(),
        payout: p.payout,
        rent_payer: p.rent_payer,
        destination: *destination,
        memo_program: MEMO_PROGRAM_ID,
        token_program: p.token_program,
    }
    .to_account_metas(None);
    accounts.extend_from_slice(extra);
    Instruction {
        program_id: VAULT_ID,
        accounts,
        data: noised_vault::instruction::ReleaseTo.data(),
    }
}

impl Harness {
    pub fn vault_state(&self, vault: &Pubkey) -> Vault {
        self.anchor_account(vault)
    }

    pub fn payout_state(&self, payout: &Pubkey) -> Payout {
        self.anchor_account(payout)
    }

    /// The payout of `vault` at `sequence`, read from chain.
    pub fn payout_ref(&self, vault: &Pubkey, sequence: u64) -> PayoutRef {
        let payout = payout_pda(vault, sequence);
        let state = self.payout_state(&payout);
        let mint = self.vault_state(vault).mint;
        PayoutRef {
            mint,
            token_program: self.token_program_of(&mint),
            vault: *vault,
            payout,
            rent_payer: state.rent_payer,
            destination_owner: state.destination_owner,
        }
    }
}
