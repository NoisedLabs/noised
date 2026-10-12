//! `noised_launchpad`'s launch, end to end against mainnet DBC and
//! Token-2022: the `Protocol` account `create_launch` reads, `LaunchParams`
//! and `create_launch`'s instruction, every address of a launch, `launch`'s
//! instruction (no arguments, 23 accounts, the metadata and rules records
//! last), the `Certificate` (version 4) and the mint's Token-2022
//! `TokenMetadata`.
//!
//! Like [`super::launchpad`], everything is written from the documented
//! layouts (SPEC §1.1-1.5, METADATA_PROGRAM.md), not imported from the
//! launchpad crate:
//!
//! ```text
//! create_launch = disc || launch_seed (32) || borsh(LaunchParams)
//! launch        = disc                                   (no arguments)
//! Protocol      = disc || version (1) || bump || treasury || u16 platform_fee_bps           (44 bytes)
//! Certificate   = disc || version (4) || bump || launch || base_mint || pool || dbc_config || creator
//!                 || launched_at || token_decimal || initial_supply || checks u32 || ...
//!                 || params_hash || policy_version u16 || pq_identity || pq_leaf u16
//!                 || attested_slot u64 || metadata (the TokenMeta address, offset 455)
//!                 || rules_hash (offset 487)                                                (519 bytes)
//! mint          = Token-2022 mint (82, padded to 165) || account type 1 || TLV MetadataPointer (18)
//!                 || TLV TransferHook (14) || TLV TokenMetadata (19): update authority (zero)
//!                 || mint || borsh(name) || borsh(symbol) || borsh(uri) || u32 0 (no additional
//!                 metadata)                                                 (386 + name + symbol + uri)
//! ```

use solana_account::Account;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_message::{Message, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

use super::{
    anchor_discriminator,
    hook::{dbc_base_vault, hook_authority, meta_list_pda, policy_pda, HOOK_ID},
    launchpad::{attestation_pda, launch_pda, token_meta_pda, LAUNCH_SEED},
    sha256,
    svm::TxExpect,
    AccountMeta, Harness, Instruction, Keypair, Pubkey, Signer, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID,
    LAMPORTS_PER_SOL, LAUNCHPAD_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
};

pub const PROTOCOL_SEED: &[u8] = b"protocol";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const BATCH_SEED: &[u8] = b"batch";
pub const DBC_CONFIG_SEED: &[u8] = b"dbc-config";
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
/// DBC's `__event_authority` PDA (its `emit_cpi`).
pub const DBC_EVENT_AUTHORITY: Pubkey =
    anchor_lang::pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
pub const WSOL_MINT: Pubkey = anchor_lang::pubkey!("So11111111111111111111111111111111111111112");
/// The mainnet wSOL mint dump (`launch` and `create_launch` read it).
pub const WSOL_FIXTURE: &str = "accounts/So11111111111111111111111111111111111111112.json";
pub const PROTOCOL_ACCOUNT_LEN: usize = 44;
pub const CERTIFICATE_ACCOUNT_LEN: usize = 519;
pub const CERTIFICATE_VERSION: u8 = 4;
/// `Certificate` offsets (discriminator included).
pub const CERTIFICATE_CHECKS_OFFSET: usize = 187;
pub const CERTIFICATE_POLICY_VERSION_OFFSET: usize = 411;
pub const CERTIFICATE_PQ_IDENTITY_OFFSET: usize = 413;
pub const CERTIFICATE_METADATA_OFFSET: usize = 455;
pub const CERTIFICATE_RULES_HASH_OFFSET: usize = 487;
/// Certificate check bits: `METADATA_ONCHAIN` (the mint's TokenMetadata,
/// re-read after the pool CPI, is exactly the attested record's) and all 12.
pub const CHECK_METADATA_ONCHAIN: u32 = 2048;
pub const CHECK_PQ_ATTESTED: u32 = 1024;
pub const CHECKS_ALL: u32 = 4095;
/// Informational, set in addition to `CHECKS_ALL` when the launch has creator
/// rules (amendment A2).
pub const CHECK_RULES_BOUND: u32 = 4096;
pub const SAFETY_POLICY_VERSION: u16 = 3;
/// `Launch` v2 offsets of what `launch` changes.
pub const LAUNCH_BASE_MINT_OFFSET: usize = 174;
pub const LAUNCH_POOL_OFFSET: usize = 206;
/// Token-2022: the account-type byte of an extended mint and the TLV types
/// DBC's mint carries.
pub const MINT_ACCOUNT_TYPE_OFFSET: usize = 165;
pub const EXTENSION_TRANSFER_HOOK: u16 = 14;
pub const EXTENSION_METADATA_POINTER: u16 = 18;
pub const EXTENSION_TOKEN_METADATA: u16 = 19;
/// A DBC mint without its metadata strings (the base, the account type and
/// the three extensions with their fixed fields).
pub const MINT_FIXED_LEN: usize = 386;
/// The compute budget a client sends `launch` with (a legacy transaction
/// with a CU limit and a CU price).
pub const LAUNCH_CU_LIMIT: u32 = 400_000;
pub const LAUNCH_CU_PRICE_MICROLAMPORTS: u64 = 10_000;
/// The shortest commit window (`MIN_OPEN_DELAY`) and a one-hour guard.
pub const OPEN_DELAY_SECS: u32 = 60;
pub const GUARD_SECS: u32 = 3_600;

fn pda(seeds: &[&[u8]], program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program)
}

/// `["protocol"]`.
pub fn protocol_pda() -> (Pubkey, u8) {
    pda(&[PROTOCOL_SEED], &LAUNCHPAD_PROGRAM_ID)
}

/// `Protocol` account bytes (what `initialize_protocol` writes).
pub fn protocol_account_data(bump: u8, treasury: &Pubkey, platform_fee_bps: u16) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "Protocol").to_vec();
    d.extend_from_slice(&[1, bump]);
    d.extend_from_slice(treasury.as_ref());
    d.extend_from_slice(&platform_fee_bps.to_le_bytes());
    assert_eq!(d.len(), PROTOCOL_ACCOUNT_LEN);
    d
}

/// One point of the bonding curve (Q64.64 sqrt price, liquidity).
#[derive(Clone, Copy, Debug)]
pub struct CurvePoint {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

/// The fee-scheduler base fee (`first_factor` periods of `second_factor`
/// seconds, `third_factor` reduction; mode 0 linear).
#[derive(Clone, Copy, Debug)]
pub struct BaseFee {
    pub cliff_fee_numerator: u64,
    pub first_factor: u16,
    pub second_factor: u64,
    pub third_factor: u64,
    pub base_fee_mode: u8,
}

/// `LaunchParams` (SPEC §1.2) without a dynamic fee (borsh `None`).
#[derive(Clone, Debug)]
pub struct LaunchParams {
    pub token_decimal: u8,
    pub sqrt_start_price: u128,
    pub curve: Vec<CurvePoint>,
    pub migration_quote_threshold: u64,
    pub base_fee: BaseFee,
    pub migration_fee_option: u8,
    pub open_delay_secs: u32,
    pub guard_secs: u32,
    pub max_wallet_bps: u16,
    pub max_buy_bps: u16,
    pub p2p_locked: bool,
    pub batch_wallet_cap: u64,
    pub batch_total_cap: u64,
    pub recipients: Vec<(Pubkey, u16)>,
    pub pq_identity: [u8; 32],
}

impl LaunchParams {
    /// A realistic launch: 6 decimals, opening at 1e-8 SOL per token, a
    /// 10-SOL raise, a 1% fee after a 10 s schedule, the shortest commit
    /// window and a one-hour guard, named after `pq_identity`.
    pub fn new(recipients: &[(Pubkey, u16)], pq_identity: [u8; 32]) -> Self {
        let q64 = |sqrt_price: f64| (sqrt_price * 2f64.powi(64)) as u128;
        let start = q64(1e-5f64.sqrt());
        let threshold = 10 * LAMPORTS_PER_SOL;
        let liquidity = (threshold as f64 * 2f64.powi(128) / (4.0 * start as f64)) as u128;
        LaunchParams {
            token_decimal: 6,
            sqrt_start_price: start,
            curve: vec![CurvePoint {
                sqrt_price: start * 10,
                liquidity,
            }],
            migration_quote_threshold: threshold,
            base_fee: BaseFee {
                cliff_fee_numerator: 500_000_000,
                first_factor: 10,
                second_factor: 1,
                third_factor: 49_000_000,
                base_fee_mode: 0,
            },
            migration_fee_option: 2,
            open_delay_secs: OPEN_DELAY_SECS,
            guard_secs: GUARD_SECS,
            max_wallet_bps: 100,
            max_buy_bps: 50,
            p2p_locked: true,
            batch_wallet_cap: 0,
            batch_total_cap: 0,
            recipients: recipients.to_vec(),
            pq_identity,
        }
    }

    /// The borsh encoding, field by field in SPEC §1.2's order (what
    /// `params_hash` hashes).
    pub fn borsh(&self) -> Vec<u8> {
        let mut d = vec![self.token_decimal];
        d.extend_from_slice(&self.sqrt_start_price.to_le_bytes());
        d.extend_from_slice(&u32::try_from(self.curve.len()).unwrap().to_le_bytes());
        for p in &self.curve {
            d.extend_from_slice(&p.sqrt_price.to_le_bytes());
            d.extend_from_slice(&p.liquidity.to_le_bytes());
        }
        d.extend_from_slice(&self.migration_quote_threshold.to_le_bytes());
        let f = &self.base_fee;
        d.extend_from_slice(&f.cliff_fee_numerator.to_le_bytes());
        d.extend_from_slice(&f.first_factor.to_le_bytes());
        d.extend_from_slice(&f.second_factor.to_le_bytes());
        d.extend_from_slice(&f.third_factor.to_le_bytes());
        d.push(f.base_fee_mode);
        d.push(0); // dynamic_fee: None
        d.push(self.migration_fee_option);
        d.extend_from_slice(&self.open_delay_secs.to_le_bytes());
        d.extend_from_slice(&self.guard_secs.to_le_bytes());
        d.extend_from_slice(&self.max_wallet_bps.to_le_bytes());
        d.extend_from_slice(&self.max_buy_bps.to_le_bytes());
        d.push(u8::from(self.p2p_locked));
        d.extend_from_slice(&self.batch_wallet_cap.to_le_bytes());
        d.extend_from_slice(&self.batch_total_cap.to_le_bytes());
        d.extend_from_slice(&u32::try_from(self.recipients.len()).unwrap().to_le_bytes());
        for (wallet, bps) in &self.recipients {
            d.extend_from_slice(wallet.as_ref());
            d.extend_from_slice(&bps.to_le_bytes());
        }
        d.extend_from_slice(&self.pq_identity);
        d
    }
}

/// Every address of one launch: `["launch", creator, seed]`, its PDAs, and
/// the DBC, hook and certificate accounts of the mint `mint`.
#[derive(Clone, Copy, Debug)]
pub struct LaunchKeys {
    pub creator: Pubkey,
    pub seed: [u8; 32],
    pub launch: Pubkey,
    pub launch_authority: Pubkey,
    pub batch_authority: Pubkey,
    pub dbc_config: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub meta_list: Pubkey,
    pub policy: Pubkey,
    pub certificate: Pubkey,
    pub attestation: Pubkey,
}

impl LaunchKeys {
    pub fn new(creator: &Pubkey, seed: [u8; 32], mint: &Pubkey) -> Self {
        let launch = launch_pda(creator, &seed).0;
        let dbc_config = pda(&[DBC_CONFIG_SEED, launch.as_ref()], &LAUNCHPAD_PROGRAM_ID).0;
        // DBC's pool: ["pool", config, larger mint, smaller mint].
        let (hi, lo) = if *mint > WSOL_MINT {
            (*mint, WSOL_MINT)
        } else {
            (WSOL_MINT, *mint)
        };
        let pool = pda(
            &[b"pool", dbc_config.as_ref(), hi.as_ref(), lo.as_ref()],
            &DBC_PROGRAM_ID,
        )
        .0;
        LaunchKeys {
            creator: *creator,
            seed,
            launch,
            launch_authority: pda(&[AUTHORITY_SEED, launch.as_ref()], &LAUNCHPAD_PROGRAM_ID).0,
            batch_authority: pda(&[BATCH_SEED, launch.as_ref()], &LAUNCHPAD_PROGRAM_ID).0,
            dbc_config,
            mint: *mint,
            pool,
            base_vault: dbc_base_vault(mint, &pool),
            quote_vault: dbc_base_vault(&WSOL_MINT, &pool),
            meta_list: meta_list_pda(mint),
            policy: policy_pda(mint).0,
            certificate: pda(&[CERTIFICATE_SEED, mint.as_ref()], &LAUNCHPAD_PROGRAM_ID).0,
            attestation: attestation_pda(&launch).0,
        }
    }

    /// The metadata record `["metadata", launch, metadata_hash]`.
    pub fn token_meta(&self, metadata_hash: &[u8; 32]) -> Pubkey {
        token_meta_pda(&self.launch, metadata_hash).0
    }
}

/// `create_launch(launch_seed, params)`: creator (signer, writable), the
/// protocol, the launch (writable), its authority, its DBC config
/// (writable), the wSOL mint, the hook, DBC, DBC's event authority, the
/// system program.
pub fn create_launch_ix(k: &LaunchKeys, params: &LaunchParams) -> Instruction {
    let mut data = anchor_discriminator("global", "create_launch").to_vec();
    data.extend_from_slice(&k.seed);
    data.extend_from_slice(&params.borsh());
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(k.creator, true),
            AccountMeta::new_readonly(protocol_pda().0, false),
            AccountMeta::new(k.launch, false),
            AccountMeta::new_readonly(k.launch_authority, false),
            AccountMeta::new(k.dbc_config, false),
            AccountMeta::new_readonly(WSOL_MINT, false),
            AccountMeta::new_readonly(HOOK_ID, false),
            AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data,
    }
}

/// `launch`'s 23 accounts in order, as (name, signer, writable): the
/// documented list (`metadata.json`, `launchInstruction`).
pub const LAUNCH_ACCOUNTS: [(&str, bool, bool); 23] = [
    ("payer", true, true),
    ("launch", false, true),
    ("launch_authority", false, false),
    ("dbc_config", false, false),
    ("base_mint", true, true),
    ("pool", false, true),
    ("base_vault", false, true),
    ("quote_vault", false, true),
    ("quote_mint", false, false),
    ("dbc_pool_authority", false, false),
    ("hook_authority", false, false),
    ("extra_account_meta_list", false, true),
    ("policy", false, true),
    ("certificate", false, true),
    ("hook_program", false, false),
    ("dbc_program", false, false),
    ("dbc_event_authority", false, false),
    ("token_2022_program", false, false),
    ("token_program", false, false),
    ("system_program", false, false),
    ("attestation", false, false),
    ("token_meta", false, false),
    ("rules", false, false),
];

/// `launch()`: no arguments; `token_meta` is the record the attestation
/// names (any other is refused), and no rules (the program id in the rules
/// slot).
pub fn launch_ix(payer: &Pubkey, k: &LaunchKeys, token_meta: &Pubkey) -> Instruction {
    launch_ix_with_rules(payer, k, token_meta, &LAUNCHPAD_PROGRAM_ID)
}

/// `launch()` with `rules` in the rules slot (the record the attestation's
/// rules hash names, or the program id for none).
pub fn launch_ix_with_rules(
    payer: &Pubkey,
    k: &LaunchKeys,
    token_meta: &Pubkey,
    rules: &Pubkey,
) -> Instruction {
    let keys = [
        *payer,
        k.launch,
        k.launch_authority,
        k.dbc_config,
        k.mint,
        k.pool,
        k.base_vault,
        k.quote_vault,
        WSOL_MINT,
        DBC_POOL_AUTHORITY,
        hook_authority(),
        k.meta_list,
        k.policy,
        k.certificate,
        HOOK_ID,
        DBC_PROGRAM_ID,
        DBC_EVENT_AUTHORITY,
        TOKEN_2022_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        SYSTEM_PROGRAM_ID,
        k.attestation,
        *token_meta,
        *rules,
    ];
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: keys
            .iter()
            .zip(LAUNCH_ACCOUNTS)
            .map(|(key, (_, is_signer, is_writable))| AccountMeta {
                pubkey: *key,
                is_signer,
                is_writable,
            })
            .collect(),
        data: anchor_discriminator("global", "launch").to_vec(),
    }
}

/// The legacy transaction a keeper (or the creator's wallet) sends `launch`
/// in: a CU limit, a CU price, then `launch`, paid by `payer` and signed by
/// it and the fresh mint.
pub fn launch_tx(
    h: &Harness,
    payer: &Keypair,
    mint: &Keypair,
    k: &LaunchKeys,
    token_meta: &Pubkey,
) -> VersionedTransaction {
    let ixs = [
        ComputeBudgetInstruction::set_compute_unit_limit(LAUNCH_CU_LIMIT),
        ComputeBudgetInstruction::set_compute_unit_price(LAUNCH_CU_PRICE_MICROLAMPORTS),
        launch_ix(&payer.pubkey(), k, token_meta),
    ];
    let msg = Message::new_with_blockhash(&ixs, Some(&payer.pubkey()), &h.svm.latest_blockhash());
    VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer, mint])
        .expect("sign the launch transaction")
}

/// What `launch` certifies, read from the `Certificate` bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CertificateView {
    pub version: u8,
    pub launch: Pubkey,
    pub base_mint: Pubkey,
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub checks: u32,
    pub params_hash: [u8; 32],
    pub policy_version: u16,
    pub pq_identity: [u8; 32],
    pub pq_leaf: u16,
    pub attested_slot: u64,
    pub metadata: Pubkey,
    pub rules_hash: [u8; 32],
}

/// Parse a `Certificate` account (discriminator and length checked).
pub fn certificate_view(data: &[u8]) -> CertificateView {
    assert_eq!(data.len(), CERTIFICATE_ACCOUNT_LEN, "Certificate length");
    assert_eq!(
        data[..8],
        anchor_discriminator("account", "Certificate"),
        "Certificate discriminator"
    );
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    let bytes32 = |at: usize| -> [u8; 32] { data[at..at + 32].try_into().unwrap() };
    let u16_at = |at: usize| u16::from_le_bytes([data[at], data[at + 1]]);
    CertificateView {
        version: data[8],
        launch: key(10),
        base_mint: key(42),
        pool: key(74),
        creator: key(138),
        checks: u32::from_le_bytes(
            data[CERTIFICATE_CHECKS_OFFSET..CERTIFICATE_CHECKS_OFFSET + 4]
                .try_into()
                .unwrap(),
        ),
        params_hash: bytes32(379),
        policy_version: u16_at(CERTIFICATE_POLICY_VERSION_OFFSET),
        pq_identity: bytes32(CERTIFICATE_PQ_IDENTITY_OFFSET),
        pq_leaf: u16_at(445),
        attested_slot: u64::from_le_bytes(data[447..455].try_into().unwrap()),
        metadata: key(CERTIFICATE_METADATA_OFFSET),
        rules_hash: bytes32(CERTIFICATE_RULES_HASH_OFFSET),
    }
}

/// The Token-2022 `TokenMetadata` of a mint, read from its TLV entries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MintMetadata {
    /// Zero bytes: no update authority.
    pub update_authority: [u8; 32],
    pub mint: Pubkey,
    pub name: Vec<u8>,
    pub symbol: Vec<u8>,
    pub uri: Vec<u8>,
    /// The number of additional (key, value) pairs.
    pub additional: u32,
    /// Bytes of the TLV value after the additional-metadata count.
    pub trailing: usize,
    /// The TLV types of the mint, in order.
    pub extensions: Vec<u16>,
}

/// Walk an extended Token-2022 mint's TLV entries and decode its
/// `TokenMetadata` (type 19), written from the token-metadata interface's
/// layout. `None` if the mint has none.
pub fn mint_metadata(data: &[u8]) -> Option<MintMetadata> {
    assert!(data.len() > MINT_ACCOUNT_TYPE_OFFSET, "an extended mint");
    assert_eq!(data[MINT_ACCOUNT_TYPE_OFFSET], 1, "account type: mint");
    let mut at = MINT_ACCOUNT_TYPE_OFFSET + 1;
    let mut extensions = Vec::new();
    let mut found = None;
    while at + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = usize::from(u16::from_le_bytes([data[at + 2], data[at + 3]]));
        if kind == 0 {
            break;
        }
        let value = &data[at + 4..at + 4 + len];
        extensions.push(kind);
        if kind == EXTENSION_TOKEN_METADATA {
            found = Some(value.to_vec());
        }
        at += 4 + len;
    }
    let value = found?;
    let mut cursor = 64;
    let mut string = || {
        let len = u32::from_le_bytes(value[cursor..cursor + 4].try_into().unwrap()) as usize;
        let s = value[cursor + 4..cursor + 4 + len].to_vec();
        cursor += 4 + len;
        s
    };
    let (name, symbol, uri) = (string(), string(), string());
    let additional = u32::from_le_bytes(value[cursor..cursor + 4].try_into().unwrap());
    Some(MintMetadata {
        update_authority: value[..32].try_into().unwrap(),
        mint: Pubkey::new_from_array(value[32..64].try_into().unwrap()),
        name,
        symbol,
        uri,
        additional,
        trailing: value.len() - (cursor + 4),
        extensions,
    })
}

impl Harness {
    /// A ledger for launches: our three programs, mainnet DBC, the wSOL mint
    /// and the `Protocol` account in place (as `initialize_protocol` leaves
    /// it; `create_launch` reads its treasury and fee share, `launch` does
    /// not).
    pub fn with_dbc() -> Harness {
        let mut h = Harness::builder()
            .program(LAUNCHPAD_PROGRAM_ID, "noised_launchpad")
            .fixture_program(DBC_PROGRAM_ID, "dbc.so")
            .fixture_account(WSOL_FIXTURE)
            .build();
        let (protocol, bump) = protocol_pda();
        let treasury = Pubkey::new_from_array(sha256(&[b"phalanx-it/treasury"]));
        h.place_launchpad_account(&protocol, protocol_account_data(bump, &treasury, 2_000));
        h
    }

    /// Run `create_launch` for `creator` under `seed` with `params`, the
    /// creator paying (legacy).
    pub fn create_launch(&mut self, creator: &Keypair, k: &LaunchKeys, params: &LaunchParams) {
        assert_eq!(k.creator, creator.pubkey());
        assert_eq!(
            k.launch,
            Pubkey::find_program_address(
                &[LAUNCH_SEED, k.creator.as_ref(), &k.seed],
                &LAUNCHPAD_PROGRAM_ID
            )
            .0
        );
        let ix = create_launch_ix(k, params);
        self.send(&[ix], &[creator]).expect_ok("create_launch");
    }

    /// The account at `key`, which must exist.
    pub fn must(&self, key: &Pubkey, what: &str) -> Account {
        self.account(key)
            .unwrap_or_else(|| panic!("{what} ({key}) does not exist"))
    }
}

/// A fixed address from a label, for readable test accounts.
pub fn label_key(label: &str) -> Pubkey {
    Pubkey::new_from_array(sha256(&[b"phalanx-it/", label.as_bytes()]))
}
