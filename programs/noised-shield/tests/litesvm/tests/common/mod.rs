//! LiteSVM harness: our `.so` files plus the mainnet Token-2022 (v11),
//! SPL Token and ATA program dumps, on the mainnet feature set.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program_pack::Pack,
        system_instruction,
    },
    AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    associated_token::{
        self, get_associated_token_address_with_program_id as ata,
        spl_associated_token_account::instruction::create_associated_token_account,
    },
    token::spl_token,
    token_2022::spl_token_2022::{
        self,
        extension::{
            confidential_transfer::{self, ConfidentialTransferMint},
            default_account_state, group_pointer, interest_bearing_mint,
            metadata_pointer::{self, MetadataPointer},
            pausable, scaled_ui_amount, transfer_fee, transfer_hook, BaseStateWithExtensions,
            ExtensionType, StateWithExtensions,
        },
        instruction as t22_ix,
        state::{Account as TokenAccountState, AccountState, Mint as MintState},
    },
    token_2022_extensions::{
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::{self, state::TokenMetadata},
    },
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub use noised_shield::state::{SHIELD_AUTHORITY_SEED, SHIELD_SEED, Z_MINT_SEED};

pub const T22: Pubkey = spl_token_2022::ID;
pub const SPL: Pubkey = spl_token::ID;
pub const SYSTEM: Pubkey = anchor_lang::solana_program::system_program::ID;

/// Where `cargo-build-sbf` put our programs: `NOISED_SBF_DIR` (or the older
/// `SBF_OUT_DIR`), else the `deploy` dir of the target dir this test binary
/// was built in (`<target>/debug/deps/<test>.exe`), else `CARGO_TARGET_DIR`,
/// else the repository's `target/deploy`.
fn deploy_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("NOISED_SBF_DIR")
        .or_else(|_| std::env::var("PHALANX_SBF_DIR"))
        .or_else(|_| std::env::var("SBF_OUT_DIR"))
    {
        return dir.into();
    }
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(3).map(|target| target.join("deploy")));
    let candidates = [
        beside_exe,
        std::env::var("CARGO_TARGET_DIR")
            .ok()
            .map(|dir| Path::new(&dir).join("deploy")),
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../target/deploy")),
    ];
    candidates
        .iter()
        .flatten()
        .find(|dir| dir.join("noised_shield.so").exists())
        .cloned()
        .unwrap_or_else(|| panic!("noised_shield.so not found in {candidates:?}"))
}

fn fixtures_dir() -> PathBuf {
    std::env::var("NOISED_FIXTURES_DIR")
        .or_else(|_| std::env::var("PHALANX_FIXTURES_DIR"))
        .or_else(|_| {
            std::env::var("NOISED_FIXTURES").or_else(|_| std::env::var("PHALANX_FIXTURES"))
        })
        .map(PathBuf::from)
        // Default: <repo>/fixtures (gitignored; scripts/fetch-fixtures.*).
        .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../fixtures"))
}

fn load(svm: &mut LiteSVM, id: Pubkey, path: PathBuf) {
    assert!(
        path.exists(),
        "{} not found (build with cargo-build-sbf; set NOISED_SBF_DIR / NOISED_FIXTURES_DIR)",
        path.display()
    );
    svm.add_program_from_file(id, &path)
        .unwrap_or_else(|e| panic!("load {}: {e:?}", path.display()));
}

/// Base-mint extensions the tests can create (Token-2022 v11 instructions).
#[derive(Clone, Debug)]
pub enum Ext {
    Metadata {
        name: String,
        symbol: String,
        uri: String,
    },
    TransferFee {
        bps: u16,
        max: u64,
    },
    Hook(Pubkey),
    PermanentDelegate,
    NonTransferable,
    Pausable,
    DefaultAccountState,
    MintCloseAuthority,
    InterestBearing,
    ScaledUiAmount,
    GroupPointer,
    ConfidentialTransferMint,
    /// Token-2022 v11 extension 28, unknown to spl-token-2022-interface 2.1.
    PermissionedBurn,
}

/// How a test extension is sized: a known type, or a raw TLV entry length
/// for types spl-token-2022-interface 2.1 does not know.
type ExtSize = Result<ExtensionType, usize>;

/// The extension's size and the instruction that initializes it (before
/// `InitializeMint`).
fn ext_init(ext: &Ext, mint: &Pubkey, payer: &Pubkey) -> (ExtSize, Instruction) {
    use ExtensionType as E;
    let (m, p) = (mint, *payer);
    let (ty, ix) = match ext {
        Ext::Metadata { .. } => (
            E::MetadataPointer,
            metadata_pointer::instruction::initialize(&T22, m, Some(p), Some(*m)),
        ),
        Ext::TransferFee { bps, max } => (
            E::TransferFeeConfig,
            transfer_fee::instruction::initialize_transfer_fee_config(
                &T22,
                m,
                Some(&p),
                Some(&p),
                *bps,
                *max,
            ),
        ),
        Ext::Hook(program) => (
            E::TransferHook,
            transfer_hook::instruction::initialize(&T22, m, Some(p), Some(*program)),
        ),
        Ext::PermanentDelegate => (
            E::PermanentDelegate,
            t22_ix::initialize_permanent_delegate(&T22, m, &p),
        ),
        Ext::NonTransferable => (
            E::NonTransferable,
            t22_ix::initialize_non_transferable_mint(&T22, m),
        ),
        Ext::Pausable => (E::Pausable, pausable::instruction::initialize(&T22, m, &p)),
        Ext::DefaultAccountState => (
            E::DefaultAccountState,
            default_account_state::instruction::initialize_default_account_state(
                &T22,
                m,
                &AccountState::Initialized,
            ),
        ),
        Ext::MintCloseAuthority => (
            E::MintCloseAuthority,
            t22_ix::initialize_mint_close_authority(&T22, m, Some(&p)),
        ),
        Ext::InterestBearing => (
            E::InterestBearingConfig,
            interest_bearing_mint::instruction::initialize(&T22, m, Some(p), 500),
        ),
        Ext::ScaledUiAmount => (
            E::ScaledUiAmount,
            scaled_ui_amount::instruction::initialize(&T22, m, Some(p), 2.0),
        ),
        Ext::GroupPointer => (
            E::GroupPointer,
            group_pointer::instruction::initialize(&T22, m, Some(p), Some(*m)),
        ),
        Ext::ConfidentialTransferMint => (
            E::ConfidentialTransferMint,
            confidential_transfer::instruction::initialize_mint(&T22, m, Some(p), true, None),
        ),
        Ext::PermissionedBurn => {
            // TokenInstruction::PermissionedBurnExtension (46), Initialize (0),
            // then the 32-byte authority; the TLV entry is 4 + 32 bytes.
            let mut data = vec![46u8, 0];
            data.extend_from_slice(p.as_ref());
            let accounts = vec![AccountMeta::new(*m, false)];
            let ix = Instruction {
                program_id: T22,
                accounts,
                data,
            };
            return (Err(4 + 32), ix);
        }
    };
    (Ok(ty), ix.unwrap())
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let fixtures = fixtures_dir();
        load(&mut svm, T22, fixtures.join("token_2022.so"));
        load(&mut svm, SPL, fixtures.join("spl_token.so"));
        load(
            &mut svm,
            associated_token::ID,
            fixtures.join("associated_token.so"),
        );
        load(
            &mut svm,
            noised_shield::ID,
            deploy_dir().join("noised_shield.so"),
        );
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        Self { svm, payer }
    }

    /// Also load the Launch Guard hook (built into the same deploy dir).
    pub fn with_hook(mut self) -> Self {
        load(
            &mut self.svm,
            noised_hook::ID,
            deploy_dir().join("noised_hook.so"),
        );
        self
    }

    pub fn user(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        kp
    }

    /// Send `ixs` paid by `payer`, also signed by `signers`.
    // `TransactionResult` is LiteSVM's own type; callers read its logs.
    #[allow(clippy::result_large_err)]
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let (payer, blockhash) = (self.payer.pubkey(), self.svm.latest_blockhash());
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer), &all, blockhash);
        self.svm.send_transaction(tx)
    }

    /// Send and require success; returns the compute units used.
    pub fn ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> u64 {
        match self.send(ixs, signers) {
            Ok(meta) => meta.compute_units_consumed,
            Err(e) => panic!("transaction failed: {:?}\n{}", e.err, e.meta.pretty_logs()),
        }
    }

    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm
            .get_account(key)
            .map(|a| a.data)
            .unwrap_or_default()
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn owner(&self, key: &Pubkey) -> Pubkey {
        self.svm
            .get_account(key)
            .map(|a| a.owner)
            .unwrap_or_default()
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        let data = self.data(token_account);
        StateWithExtensions::<TokenAccountState>::unpack(&data)
            .unwrap_or_else(|e| panic!("token account {token_account}: {e:?}"))
            .base
            .amount
    }

    pub fn supply(&self, mint: &Pubkey) -> u64 {
        let data = self.data(mint);
        StateWithExtensions::<MintState>::unpack(&data)
            .unwrap()
            .base
            .supply
    }

    /// An SPL Token mint (mint and freeze authority = payer).
    pub fn create_spl_mint(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let (m, payer) = (mint.pubkey(), self.payer.pubkey());
        let len = spl_token::state::Mint::LEN;
        let lamports = self.svm.minimum_balance_for_rent_exemption(len);
        let ixs = [
            system_instruction::create_account(&payer, &m, lamports, len as u64, &SPL),
            spl_token::instruction::initialize_mint2(&SPL, &m, &payer, Some(&payer), decimals)
                .unwrap(),
        ];
        self.ok(&ixs, &[&mint]);
        m
    }

    /// A Token-2022 mint (mint authority = payer, no freeze authority).
    pub fn create_t22_mint(&mut self, decimals: u8, exts: &[Ext]) -> Pubkey {
        let kp = Keypair::new();
        let (mint, payer) = (kp.pubkey(), self.payer.pubkey());
        let mut types = Vec::new();
        let mut raw_len = 0usize;
        let mut init = Vec::new();
        for ext in exts {
            let (ty, ix) = ext_init(ext, &mint, &payer);
            match ty {
                Ok(ty) => types.push(ty),
                Err(len) => raw_len += len,
            }
            init.push(ix);
        }
        let mut space = ExtensionType::try_calculate_account_len::<MintState>(&types).unwrap();
        if raw_len > 0 {
            // 165-byte base + account-type byte, then the raw TLV entries.
            space = space.max(166) + raw_len;
        }
        // Embedded metadata is appended (and paid for) after InitializeMint.
        let mut metadata_len = 0;
        let mut post = Vec::new();
        for ext in exts {
            if let Ext::Metadata { name, symbol, uri } = ext.clone() {
                let meta = TokenMetadata {
                    update_authority: OptionalNonZeroPubkey::try_from(Some(payer)).unwrap(),
                    mint,
                    name: name.clone(),
                    symbol: symbol.clone(),
                    uri: uri.clone(),
                    additional_metadata: vec![],
                };
                metadata_len = 4 + borsh_len(&meta);
                post.push(spl_token_metadata_interface::instruction::initialize(
                    &T22, &mint, &payer, &mint, &payer, name, symbol, uri,
                ));
            }
        }
        let lamports = self
            .svm
            .minimum_balance_for_rent_exemption(space + metadata_len);
        let mut ixs = vec![system_instruction::create_account(
            &payer,
            &mint,
            lamports,
            space as u64,
            &T22,
        )];
        ixs.extend(init);
        ixs.push(t22_ix::initialize_mint2(&T22, &mint, &payer, None, decimals).unwrap());
        ixs.extend(post);
        self.ok(&ixs, &[&kp]);
        mint
    }

    /// Initialize the Launch Guard meta list for a mint hooked to noised_hook.
    pub fn init_hook_meta_list(&mut self, mint: &Pubkey) {
        let ix = Instruction {
            program_id: noised_hook::ID,
            accounts: noised_hook::accounts::InitializeExtraAccountMetaList {
                payer: self.payer.pubkey(),
                extra_account_meta_list: hook_meta_list(mint),
                mint: *mint,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: noised_hook::instruction::InitializeExtraAccountMetaList {}.data(),
        };
        self.ok(&[ix], &[]);
    }

    pub fn create_ata(&mut self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
        let payer = self.payer.pubkey();
        self.ok(
            &[create_associated_token_account(
                &payer, owner, mint, program,
            )],
            &[],
        );
        ata(owner, mint, program)
    }

    pub fn mint_to(&mut self, mint: &Pubkey, program: &Pubkey, to: &Pubkey, amount: u64) {
        let payer = self.payer.pubkey();
        let ix = t22_ix::mint_to(program, mint, to, &payer, &[], amount).unwrap();
        self.ok(&[ix], &[]);
    }

    /// A funded user with a base-token account and a zToken account.
    pub fn funded_user(&mut self, s: &ShieldKeys, amount: u64) -> (Keypair, Pubkey, Pubkey) {
        let user = self.user();
        let base = self.create_ata(&user.pubkey(), &s.base_mint, &s.base_token_program);
        let z = self.create_ata(&user.pubkey(), &s.z_mint, &T22);
        if amount > 0 {
            self.mint_to(&s.base_mint, &s.base_token_program, &base, amount);
        }
        (user, base, z)
    }
}

pub fn borsh_len<T: anchor_lang::AnchorSerialize>(value: &T) -> usize {
    let mut v = Vec::new();
    value.serialize(&mut v).unwrap();
    v.len()
}

pub fn hook_meta_list(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &noised_hook::ID).0
}

pub fn hook_policy(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"policy", mint.as_ref()], &noised_hook::ID).0
}

/// Remaining accounts a transfer of a Launch Guard mint needs: the meta list,
/// its two extra accounts (policy PDA, instructions sysvar) and the hook.
pub fn hook_extras(mint: &Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(hook_meta_list(mint), false),
        AccountMeta::new_readonly(hook_policy(mint), false),
        AccountMeta::new_readonly(noised_hook::INSTRUCTIONS_SYSVAR_ID, false),
        AccountMeta::new_readonly(noised_hook::ID, false),
    ]
}

/// Every address of one shield.
#[derive(Clone, Copy, Debug)]
pub struct ShieldKeys {
    pub base_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub shield: Pubkey,
    pub authority: Pubkey,
    pub z_mint: Pubkey,
    pub escrow: Pubkey,
}

impl ShieldKeys {
    pub fn new(base_mint: Pubkey, base_token_program: Pubkey) -> Self {
        let pda = |seed: &[u8]| {
            Pubkey::find_program_address(&[seed, base_mint.as_ref()], &noised_shield::ID).0
        };
        let authority = pda(SHIELD_AUTHORITY_SEED);
        Self {
            base_mint,
            base_token_program,
            shield: pda(SHIELD_SEED),
            authority,
            z_mint: pda(Z_MINT_SEED),
            escrow: ata(&authority, &base_mint, &base_token_program),
        }
    }
}

pub fn create_shield_ix(payer: &Pubkey, s: &ShieldKeys) -> Instruction {
    Instruction {
        program_id: noised_shield::ID,
        accounts: noised_shield::accounts::CreateShield {
            payer: *payer,
            base_mint: s.base_mint,
            shield: s.shield,
            shield_authority: s.authority,
            z_mint: s.z_mint,
            escrow: s.escrow,
            base_token_program: s.base_token_program,
            token_2022_program: T22,
            associated_token_program: associated_token::ID,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
        data: noised_shield::instruction::CreateShield {}.data(),
    }
}

pub fn wrap_ix(
    user: &Pubkey,
    s: &ShieldKeys,
    user_base: &Pubkey,
    user_z: &Pubkey,
    amount: u64,
    extras: &[AccountMeta],
) -> Instruction {
    let mut accounts = noised_shield::accounts::Wrap {
        user: *user,
        shield: s.shield,
        shield_authority: s.authority,
        base_mint: s.base_mint,
        z_mint: s.z_mint,
        escrow: s.escrow,
        user_base: *user_base,
        user_z: *user_z,
        base_token_program: s.base_token_program,
        token_2022_program: T22,
    }
    .to_account_metas(None);
    accounts.extend_from_slice(extras);
    let data = noised_shield::instruction::Wrap { amount }.data();
    Instruction {
        program_id: noised_shield::ID,
        accounts,
        data,
    }
}

pub fn unwrap_ix(
    user: &Pubkey,
    s: &ShieldKeys,
    user_base: &Pubkey,
    user_z: &Pubkey,
    amount: u64,
    extras: &[AccountMeta],
) -> Instruction {
    let mut accounts = noised_shield::accounts::Unwrap {
        user: *user,
        shield: s.shield,
        shield_authority: s.authority,
        base_mint: s.base_mint,
        z_mint: s.z_mint,
        escrow: s.escrow,
        user_base: *user_base,
        user_z: *user_z,
        base_token_program: s.base_token_program,
        token_2022_program: T22,
    }
    .to_account_metas(None);
    accounts.extend_from_slice(extras);
    let data = noised_shield::instruction::Unwrap { amount }.data();
    Instruction {
        program_id: noised_shield::ID,
        accounts,
        data,
    }
}

/// The custom error code a failed transaction ended with.
pub fn custom_error(result: &TransactionResult) -> Option<u32> {
    match result {
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
            _ => None,
        },
        Ok(_) => None,
    }
}

#[track_caller]
pub fn assert_error(result: TransactionResult, code: impl Into<u32>) {
    let code = code.into();
    match &result {
        Ok(meta) => panic!(
            "expected error {code}, transaction succeeded\n{}",
            meta.pretty_logs()
        ),
        Err(f) => assert_eq!(
            custom_error(&result),
            Some(code),
            "expected custom error {code}, got {:?}\n{}",
            f.err,
            f.meta.pretty_logs()
        ),
    }
}

#[track_caller]
pub fn assert_fails(result: TransactionResult) {
    if let Ok(meta) = result {
        panic!(
            "expected failure, transaction succeeded\n{}",
            meta.pretty_logs()
        );
    }
}

/// Decode the first Anchor event of type `E` from transaction logs.
pub fn event<E: AnchorDeserialize + Discriminator>(logs: &[String]) -> Option<E> {
    use anchor_lang::__private::base64::{engine::general_purpose::STANDARD, Engine};
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b64| STANDARD.decode(b64).ok())
        .find(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .and_then(|bytes| E::try_from_slice(&bytes[E::DISCRIMINATOR.len()..]).ok())
}

/// Check the zToken mint end to end, independently of the program's own
/// post-condition check: exact extension list, every authority revoked,
/// confidential transfers auto-approved without auditor, metadata immutable.
#[track_caller]
pub fn assert_z_mint(env: &Env, s: &ShieldKeys, decimals: u8, name: &str, symbol: &str, uri: &str) {
    assert_eq!(env.owner(&s.z_mint), T22);
    let data = env.data(&s.z_mint);
    let state = StateWithExtensions::<MintState>::unpack(&data).unwrap();
    assert!(state.base.is_initialized);
    assert_eq!(
        Option::<Pubkey>::from(state.base.mint_authority),
        Some(s.authority)
    );
    assert_eq!(Option::<Pubkey>::from(state.base.freeze_authority), None);
    assert_eq!(state.base.decimals, decimals);
    assert_eq!(
        state.get_extension_types().unwrap(),
        vec![
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::MetadataPointer,
            ExtensionType::TokenMetadata
        ]
    );
    let ct = state.get_extension::<ConfidentialTransferMint>().unwrap();
    assert_eq!(Option::<Pubkey>::from(ct.authority), None);
    assert!(bool::from(ct.auto_approve_new_accounts));
    assert!(
        ct.auditor_elgamal_pubkey == Default::default(),
        "auditor must be None"
    );
    let pointer = state.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(Option::<Pubkey>::from(pointer.authority), None);
    assert_eq!(
        Option::<Pubkey>::from(pointer.metadata_address),
        Some(s.z_mint)
    );
    let tm = state.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(Option::<Pubkey>::from(tm.update_authority), None);
    assert_eq!(tm.mint, s.z_mint);
    assert_eq!(
        (tm.name.as_str(), tm.symbol.as_str(), tm.uri.as_str()),
        (name, symbol, uri)
    );
    assert!(tm.additional_metadata.is_empty());
    // Exactly sized and rent-exempt for its final length.
    assert_eq!(
        data.len(),
        303 + 4 + 80 + name.len() + symbol.len() + uri.len()
    );
    assert!(env.lamports(&s.z_mint) >= env.svm.minimum_balance_for_rent_exemption(data.len()));
}

/// zToken supply equals the escrow balance (no donations or direct burns).
#[track_caller]
pub fn assert_exactly_backed(env: &Env, s: &ShieldKeys) -> u64 {
    let supply = env.supply(&s.z_mint);
    assert_eq!(
        supply,
        env.balance(&s.escrow),
        "zToken supply != escrow balance"
    );
    supply
}
