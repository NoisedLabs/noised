//! SPL Token / Token-2022 helpers: mints (optionally with a transfer hook or
//! other extensions), ATAs and plain token accounts, balances, the account
//! changes a holder can make on its own (owner reassignment, required memos)
//! or a freeze authority can make, and `transfer_checked` with transfer-hook
//! extra accounts resolved the way an off-chain client resolves them.

use std::{
    future::Future,
    pin::pin,
    task::{Context, Poll, Waker},
};

use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    associated_token::spl_associated_token_account::{
        address::get_associated_token_address_with_program_id,
        instruction::create_associated_token_account_idempotent,
    },
    token_2022::spl_token_2022::{
        extension::{
            confidential_transfer::{self, instruction as ct, DecryptableBalance},
            immutable_owner, memo_transfer, transfer_fee, transfer_hook, BaseStateWithExtensions,
            ExtensionType, StateWithExtensions,
        },
        instruction::{self as token_ix, AuthorityType},
        state::{Account as TokenAccountState, Mint as MintState},
    },
};
use solana_signer::Signer;
use solana_zk_sdk_v7::{
    encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
    zk_elgamal_proof_program::build_pubkey_validity_proof_data,
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use spl_transfer_hook_interface::offchain::add_extra_account_metas_for_execute;

use super::{
    svm::{TxExpect, TxResult},
    AccountMeta, Harness, Instruction, Keypair, Pubkey, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};

/// ATA of `owner` for `mint` under `token_program`.
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}

/// The same bytes as the other crate version's type. zk-sdk 7 builds the
/// proofs the runtime verifies; spl-token-2022-interface 2.1 names the zk-sdk 4
/// types, whose layout did not change.
fn retype<A: bytemuck::Pod, B: bytemuck::Pod>(value: &A) -> B {
    assert_eq!(
        std::mem::size_of::<A>(),
        std::mem::size_of::<B>(),
        "layout changed"
    );
    bytemuck::pod_read_unaligned(bytemuck::bytes_of(value))
}

/// Drive a future that never waits (account fetches below are synchronous).
fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = pin!(fut);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

/// Token-2022 mint extensions the harness can initialize (extend as needed).
#[derive(Clone, Copy, Debug)]
pub enum MintExt {
    /// Transfer hook program, with no hook authority.
    TransferHook(Pubkey),
    NonTransferable,
    /// Permanent delegate: can move or burn tokens from any account.
    PermanentDelegate(Pubkey),
    /// Transfer fee with the given config and withdraw-withheld authorities.
    TransferFee {
        config_authority: Option<Pubkey>,
        withdraw_authority: Option<Pubkey>,
        basis_points: u16,
        maximum_fee: u64,
    },
    /// Close authority (None: the mint can never be closed).
    MintCloseAuthority(Option<Pubkey>),
    /// Confidential transfers: new accounts approved automatically, no auditor.
    ConfidentialTransfer {
        authority: Option<Pubkey>,
    },
}

impl MintExt {
    fn extension_type(self) -> ExtensionType {
        match self {
            MintExt::TransferHook(_) => ExtensionType::TransferHook,
            MintExt::NonTransferable => ExtensionType::NonTransferable,
            MintExt::PermanentDelegate(_) => ExtensionType::PermanentDelegate,
            MintExt::TransferFee { .. } => ExtensionType::TransferFeeConfig,
            MintExt::MintCloseAuthority(_) => ExtensionType::MintCloseAuthority,
            MintExt::ConfidentialTransfer { .. } => ExtensionType::ConfidentialTransferMint,
        }
    }

    fn init_ix(self, mint: &Pubkey) -> Instruction {
        let program = &TOKEN_2022_PROGRAM_ID;
        match self {
            MintExt::TransferHook(hook) => {
                transfer_hook::instruction::initialize(program, mint, None, Some(hook))
            }
            MintExt::NonTransferable => token_ix::initialize_non_transferable_mint(program, mint),
            MintExt::PermanentDelegate(delegate) => {
                token_ix::initialize_permanent_delegate(program, mint, &delegate)
            }
            MintExt::TransferFee {
                config_authority,
                withdraw_authority,
                basis_points,
                maximum_fee,
            } => transfer_fee::instruction::initialize_transfer_fee_config(
                program,
                mint,
                config_authority.as_ref(),
                withdraw_authority.as_ref(),
                basis_points,
                maximum_fee,
            ),
            MintExt::MintCloseAuthority(authority) => {
                token_ix::initialize_mint_close_authority(program, mint, authority.as_ref())
            }
            MintExt::ConfidentialTransfer { authority } => {
                confidential_transfer::instruction::initialize_mint(
                    program, mint, authority, true, None,
                )
            }
        }
        .expect("extension init instruction")
    }
}

impl Harness {
    /// New mint with the harness payer as mint authority and no freeze
    /// authority. `transfer_hook` (Token-2022 only) adds a TransferHook
    /// extension with no hook authority.
    pub fn create_mint(
        &mut self,
        token_program: Pubkey,
        decimals: u8,
        transfer_hook: Option<Pubkey>,
    ) -> Pubkey {
        let extensions: Vec<MintExt> = transfer_hook
            .map(MintExt::TransferHook)
            .into_iter()
            .collect();
        self.create_mint_with(token_program, decimals, &extensions)
    }

    /// New mint with the given Token-2022 extensions (see [`Harness::create_mint`]).
    pub fn create_mint_with(
        &mut self,
        token_program: Pubkey,
        decimals: u8,
        extensions: &[MintExt],
    ) -> Pubkey {
        let mint = Keypair::new();
        self.create_mint_at(&mint, token_program, decimals, extensions, None);
        mint.pubkey()
    }

    /// New mint whose freeze authority is the harness payer (see [`Harness::freeze`]).
    pub fn create_freezable_mint(
        &mut self,
        token_program: Pubkey,
        decimals: u8,
        extensions: &[MintExt],
    ) -> Pubkey {
        let mint = Keypair::new();
        let freeze_authority = self.payer.pubkey();
        self.create_mint_at(
            &mint,
            token_program,
            decimals,
            extensions,
            Some(freeze_authority),
        );
        mint.pubkey()
    }

    /// Create a mint at the address of `mint` (also to re-create a closed
    /// one), with the harness payer as mint authority.
    pub fn create_mint_at(
        &mut self,
        mint: &Keypair,
        token_program: Pubkey,
        decimals: u8,
        extensions: &[MintExt],
        freeze_authority: Option<Pubkey>,
    ) {
        assert!(
            extensions.is_empty() || token_program == TOKEN_2022_PROGRAM_ID,
            "mint extensions need Token-2022"
        );
        let types: Vec<ExtensionType> = extensions.iter().map(|e| e.extension_type()).collect();
        let space =
            ExtensionType::try_calculate_account_len::<MintState>(&types).expect("mint len");
        let payer = self.payer.pubkey();
        let mut ixs = vec![solana_system_interface::instruction::create_account(
            &payer,
            &mint.pubkey(),
            self.rent_exempt(space),
            space as u64,
            &token_program,
        )];
        ixs.extend(extensions.iter().map(|e| e.init_ix(&mint.pubkey())));
        ixs.push(
            token_ix::initialize_mint2(
                &token_program,
                &mint.pubkey(),
                &payer,
                freeze_authority.as_ref(),
                decimals,
            )
            .expect("init mint"),
        );
        self.send(&ixs, &[mint]).expect_ok("create mint");
    }

    /// Owning token program of `mint` (SPL Token or Token-2022).
    pub fn token_program_of(&self, mint: &Pubkey) -> Pubkey {
        let owner = self.account(mint).expect("mint exists").owner;
        assert!(
            owner == TOKEN_PROGRAM_ID || owner == TOKEN_2022_PROGRAM_ID,
            "{mint} is not a mint"
        );
        owner
    }

    pub fn mint_state(&self, mint: &Pubkey) -> MintState {
        let data = self.account(mint).expect("mint exists").data;
        StateWithExtensions::<MintState>::unpack(&data)
            .expect("mint")
            .base
    }

    /// Transfer-hook program of a Token-2022 mint, if any.
    pub fn hook_program_of(&self, mint: &Pubkey) -> Option<Pubkey> {
        if self.token_program_of(mint) != TOKEN_2022_PROGRAM_ID {
            return None;
        }
        let data = self.account(mint).expect("mint exists").data;
        let state = StateWithExtensions::<MintState>::unpack(&data).expect("mint");
        transfer_hook::get_program_id(&state)
    }

    /// Create (idempotently) the ATA of `owner` for `mint`.
    pub fn create_ata(&mut self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        let program = self.token_program_of(mint);
        let ix =
            create_associated_token_account_idempotent(&self.payer.pubkey(), owner, mint, &program);
        self.send(&[ix], &[]).expect_ok("create ATA");
        ata(owner, mint, &program)
    }

    /// A token account of `owner` for `mint` at a fresh address (not an
    /// ATA). Anyone can create one; the owner does not sign.
    pub fn create_token_account(&mut self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        self.create_plain_token_account(owner, mint, false)
    }

    /// `create_token_account` with Token-2022's ImmutableOwner extension
    /// (InitializeImmutableOwner before InitializeAccount3, as the ATA
    /// program initializes every Token-2022 ATA): its owner never changes.
    pub fn create_immutable_owner_token_account(
        &mut self,
        owner: &Pubkey,
        mint: &Pubkey,
    ) -> Pubkey {
        self.create_plain_token_account(owner, mint, true)
    }

    fn create_plain_token_account(
        &mut self,
        owner: &Pubkey,
        mint: &Pubkey,
        immutable_owner: bool,
    ) -> Pubkey {
        let program = self.token_program_of(mint);
        let space = if program == TOKEN_2022_PROGRAM_ID {
            // Some mint extensions (e.g. TransferFeeConfig) need account extensions.
            let data = self.account(mint).expect("mint exists").data;
            let state = StateWithExtensions::<MintState>::unpack(&data).expect("mint");
            let mint_types = state.get_extension_types().expect("mint extensions");
            let mut types = ExtensionType::get_required_init_account_extensions(&mint_types);
            if immutable_owner {
                types.push(ExtensionType::ImmutableOwner);
            }
            ExtensionType::try_calculate_account_len::<TokenAccountState>(&types)
                .expect("account len")
        } else {
            assert!(!immutable_owner, "ImmutableOwner is a Token-2022 extension");
            TokenAccountState::LEN
        };
        let account = Keypair::new();
        let mut ixs = vec![solana_system_interface::instruction::create_account(
            &self.payer.pubkey(),
            &account.pubkey(),
            self.rent_exempt(space),
            space as u64,
            &program,
        )];
        if immutable_owner {
            ixs.push(
                token_ix::initialize_immutable_owner(&program, &account.pubkey())
                    .expect("init immutable owner"),
            );
        }
        ixs.push(
            token_ix::initialize_account3(&program, &account.pubkey(), mint, owner)
                .expect("init account"),
        );
        self.send(&ixs, &[&account])
            .expect_ok("create token account");
        account.pubkey()
    }

    /// Whether token `account` has Token-2022's ImmutableOwner extension,
    /// read as Token-2022 reads it.
    pub fn has_immutable_owner(&self, account: &Pubkey) -> bool {
        let data = self.account(account).expect("token account").data;
        StateWithExtensions::<TokenAccountState>::unpack(&data)
            .expect("token account")
            .get_extension::<immutable_owner::ImmutableOwner>()
            .is_ok()
    }

    /// The owner of an SPL Token `account` hands its owner field to
    /// `new_owner` (Token-2022 ATAs have ImmutableOwner).
    pub fn reassign_owner(&mut self, account: &Pubkey, owner: &Keypair, new_owner: &Pubkey) {
        self.try_reassign_owner(account, owner, new_owner)
            .expect_ok("reassign the account owner");
    }

    /// `reassign_owner` as a transaction that may fail (Token-2022 refuses
    /// it for an account with ImmutableOwner).
    pub fn try_reassign_owner(
        &mut self,
        account: &Pubkey,
        owner: &Keypair,
        new_owner: &Pubkey,
    ) -> TxResult {
        let program = self.account(account).expect("token account").owner;
        let ix = token_ix::set_authority(
            &program,
            account,
            Some(new_owner),
            AuthorityType::AccountOwner,
            &owner.pubkey(),
            &[],
        )
        .expect("set_authority");
        self.send(&[ix], &[owner])
    }

    /// The owner of a Token-2022 `account` makes incoming transfers require
    /// a memo (Reallocate + EnableRequiredMemoTransfers, both owner-signed).
    pub fn require_memos(&mut self, account: &Pubkey, owner: &Keypair) {
        let o = owner.pubkey();
        let realloc = token_ix::reallocate(
            &TOKEN_2022_PROGRAM_ID,
            account,
            &o,
            &o,
            &[],
            &[ExtensionType::MemoTransfer],
        )
        .expect("reallocate");
        let enable = memo_transfer::instruction::enable_required_transfer_memos(
            &TOKEN_2022_PROGRAM_ID,
            account,
            &o,
            &[],
        )
        .expect("enable required memos");
        self.send(&[realloc, enable], &[owner])
            .expect_ok("require memos");
    }

    /// Freeze `account`, signed by the harness payer (the freeze authority of
    /// mints from [`Harness::create_freezable_mint`]).
    pub fn freeze(&mut self, account: &Pubkey) {
        let mint = self.token_account(account).mint;
        let program = self.token_program_of(&mint);
        let ix = token_ix::freeze_account(&program, account, &mint, &self.payer.pubkey(), &[])
            .expect("freeze");
        self.send(&[ix], &[]).expect_ok("freeze account");
    }

    pub fn thaw(&mut self, account: &Pubkey) {
        let mint = self.token_account(account).mint;
        let program = self.token_program_of(&mint);
        let ix = token_ix::thaw_account(&program, account, &mint, &self.payer.pubkey(), &[])
            .expect("thaw");
        self.send(&[ix], &[]).expect_ok("thaw account");
    }

    /// The owner of a Token-2022 `account` (of a mint with confidential
    /// transfers) configures it for confidential balances and turns off
    /// non-confidential credits: from then on it accepts no public transfer.
    /// All owner-signed: Reallocate, ConfigureAccount with its ElGamal
    /// pubkey-validity proof (verified by the ZK ElGamal proof program), and
    /// DisableNonConfidentialCredits.
    pub fn refuse_public_credits(&mut self, account: &Pubkey, owner: &Keypair) {
        let o = owner.pubkey();
        let mint = self.token_account(account).mint;
        let realloc = token_ix::reallocate(
            &TOKEN_2022_PROGRAM_ID,
            account,
            &o,
            &o,
            &[],
            &[ExtensionType::ConfidentialTransferAccount],
        )
        .expect("reallocate");
        let elgamal = ElGamalKeypair::new_rand();
        let validity: ct::PubkeyValidityProofData =
            retype(&build_pubkey_validity_proof_data(&elgamal).expect("pubkey validity proof"));
        let zero: DecryptableBalance =
            bytemuck::pod_read_unaligned(&AeKey::new_rand().encrypt(0).to_bytes());
        let mut ixs = vec![realloc];
        ixs.extend(
            ct::configure_account(
                &TOKEN_2022_PROGRAM_ID,
                account,
                &mint,
                &zero,
                65_536,
                &o,
                &[],
                // The proof instruction follows ConfigureAccount.
                ProofLocation::InstructionOffset(1.try_into().expect("offset"), &validity),
            )
            .expect("configure_account"),
        );
        ixs.push(
            ct::disable_non_confidential_credits(&TOKEN_2022_PROGRAM_ID, account, &o, &[])
                .expect("disable credits"),
        );
        self.send(&ixs, &[owner])
            .expect_ok("confidential-only account");
        let data = self.account(account).expect("token account").data;
        let state = StateWithExtensions::<TokenAccountState>::unpack(&data).expect("token account");
        let ct_state = state
            .get_extension::<confidential_transfer::ConfidentialTransferAccount>()
            .expect("confidential transfer account");
        assert!(
            bool::from(ct_state.approved),
            "approved (the mint auto-approves)"
        );
        assert!(!bool::from(ct_state.allow_non_confidential_credits));
    }

    /// Mint `amount` to `destination` (minting never runs a transfer hook).
    pub fn mint_to(&mut self, mint: &Pubkey, destination: &Pubkey, amount: u64) {
        let program = self.token_program_of(mint);
        let decimals = self.mint_state(mint).decimals;
        let ix = token_ix::mint_to_checked(
            &program,
            mint,
            destination,
            &self.payer.pubkey(),
            &[],
            amount,
            decimals,
        )
        .expect("mint_to");
        self.send(&[ix], &[]).expect_ok("mint_to");
    }

    pub fn token_account(&self, account: &Pubkey) -> TokenAccountState {
        let data = self
            .account(account)
            .unwrap_or_else(|| panic!("token account {account} does not exist"))
            .data;
        StateWithExtensions::<TokenAccountState>::unpack(&data)
            .expect("token account")
            .base
    }

    pub fn balance(&self, account: &Pubkey) -> u64 {
        self.token_account(account).amount
    }

    /// `transfer_checked` with only the four base accounts.
    pub fn plain_transfer_ix(
        &self,
        mint: &Pubkey,
        source: &Pubkey,
        destination: &Pubkey,
        authority: &Pubkey,
        amount: u64,
    ) -> Instruction {
        let program = self.token_program_of(mint);
        let decimals = self.mint_state(mint).decimals;
        token_ix::transfer_checked(
            &program,
            source,
            mint,
            destination,
            authority,
            &[],
            amount,
            decimals,
        )
        .expect("transfer_checked")
    }

    /// `transfer_checked` plus, for a hooked mint, the extra accounts a
    /// client resolves from the mint's ExtraAccountMetaList.
    pub fn transfer_ix(
        &self,
        mint: &Pubkey,
        source: &Pubkey,
        destination: &Pubkey,
        authority: &Pubkey,
        amount: u64,
    ) -> Instruction {
        let mut ix = self.plain_transfer_ix(mint, source, destination, authority, amount);
        ix.accounts
            .extend(self.hook_extra_metas(mint, source, destination, authority, amount));
        ix
    }

    /// The accounts Token-2022 needs to run `mint`'s transfer hook: the
    /// resolved extra metas, the hook program and the validation account, in
    /// the order `spl_transfer_hook_interface::offchain` appends them. Also
    /// what a program that CPIs `transfer_checked` (e.g. the vault) expects
    /// in its remaining accounts. Empty for mints without a hook.
    pub fn hook_extra_metas(
        &self,
        mint: &Pubkey,
        source: &Pubkey,
        destination: &Pubkey,
        authority: &Pubkey,
        amount: u64,
    ) -> Vec<AccountMeta> {
        let Some(hook_program) = self.hook_program_of(mint) else {
            return Vec::new();
        };
        let mut ix = self.plain_transfer_ix(mint, source, destination, authority, amount);
        let base_len = ix.accounts.len();
        let fetch = |key: Pubkey| {
            std::future::ready(Ok::<
                _,
                spl_transfer_hook_interface::offchain::AccountFetchError,
            >(
                self.svm
                    .get_account(&key)
                    .filter(|a| a.lamports > 0)
                    .map(|a| a.data),
            ))
        };
        block_on(add_extra_account_metas_for_execute(
            &mut ix,
            &hook_program,
            source,
            mint,
            destination,
            authority,
            amount,
            fetch,
        ))
        .expect("resolve transfer-hook extra accounts");
        ix.accounts.split_off(base_len)
    }

    /// Transfer with hook accounts, signed by `authority`.
    pub fn transfer(
        &mut self,
        mint: &Pubkey,
        source: &Pubkey,
        destination: &Pubkey,
        authority: &Keypair,
        amount: u64,
    ) -> super::svm::TxResult {
        let ix = self.transfer_ix(mint, source, destination, &authority.pubkey(), amount);
        self.send(&[ix], &[authority])
    }
}
