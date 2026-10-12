use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::token_interface::{
    spl_pod::optional_keys::OptionalNonZeroPubkey,
    spl_token_2022::{
        self,
        extension::{
            metadata_pointer::MetadataPointer, mint_close_authority::MintCloseAuthority,
            transfer_hook::TransferHook, BaseStateWithExtensionsMut, ExtensionType,
            StateWithExtensionsMut,
        },
        state::Mint,
    },
    spl_token_metadata_interface::state::TokenMetadata,
};

use super::key;
use crate::{
    checks::{
        inspect_config, inspect_mint, token_metadata_matches, verify_token_metadata, ExpectedConfig,
    },
    constants::{DBC_POOL_AUTHORITY, WSOL_MINT},
    dynamic_bonding_curve::accounts::ConfigWithTransferHook,
    error::LaunchpadError,
    state::checks,
};

const HOOK: Pubkey = noised_hook::ID;

/// A named mutation that must make the checked state unsafe.
type Case<'a, T> = (&'a str, Box<dyn Fn(&mut T)>);
type ConfigCase = (&'static str, fn(&mut ConfigWithTransferHook));

#[derive(Clone)]
struct Spec {
    mint: Pubkey,
    decimals: u8,
    supply: u64,
    mint_authority: Option<Pubkey>,
    freeze_authority: Option<Pubkey>,
    pointer: Option<(Option<Pubkey>, Option<Pubkey>)>,
    hook: Option<(Option<Pubkey>, Option<Pubkey>)>,
    metadata: Option<(Option<Pubkey>, Pubkey)>,
    /// The TokenMetadata strings: name, symbol, uri.
    strings: (String, String, String),
    additional: Vec<(String, String)>,
    close_authority: bool,
}

/// What DBC leaves behind for a Noised launch.
fn good() -> Spec {
    let mint = key(0x33);
    Spec {
        mint,
        decimals: 6,
        supply: 1_000_000_000_000_000,
        mint_authority: None,
        freeze_authority: None,
        pointer: Some((None, Some(mint))),
        hook: Some((Some(DBC_POOL_AUTHORITY), Some(HOOK))),
        metadata: Some((None, mint)),
        strings: (
            "Noised".into(),
            "PHX".into(),
            "https://example.org/phx.json".into(),
        ),
        additional: vec![],
        close_authority: false,
    }
}

fn opt(k: Option<Pubkey>) -> OptionalNonZeroPubkey {
    OptionalNonZeroPubkey::try_from(k).unwrap()
}

fn coption(k: Option<Pubkey>) -> COption<Pubkey> {
    k.map(COption::Some).unwrap_or(COption::None)
}

fn build(s: &Spec) -> Vec<u8> {
    let mut fixed = vec![];
    if s.pointer.is_some() {
        fixed.push(ExtensionType::MetadataPointer);
    }
    if s.hook.is_some() {
        fixed.push(ExtensionType::TransferHook);
    }
    if s.close_authority {
        fixed.push(ExtensionType::MintCloseAuthority);
    }
    let metadata = s.metadata.map(|(authority, mint)| TokenMetadata {
        update_authority: opt(authority),
        mint,
        name: s.strings.0.clone(),
        symbol: s.strings.1.clone(),
        uri: s.strings.2.clone(),
        additional_metadata: s.additional.clone(),
    });
    let mut len = ExtensionType::try_calculate_account_len::<Mint>(&fixed).unwrap();
    if let Some(m) = &metadata {
        len += m.tlv_size_of().unwrap();
    }
    let mut data = vec![0u8; len];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    if let Some((authority, address)) = s.pointer {
        let e = state.init_extension::<MetadataPointer>(true).unwrap();
        e.authority = opt(authority);
        e.metadata_address = opt(address);
    }
    if let Some((authority, program)) = s.hook {
        let e = state.init_extension::<TransferHook>(true).unwrap();
        e.authority = opt(authority);
        e.program_id = opt(program);
    }
    if s.close_authority {
        let e = state.init_extension::<MintCloseAuthority>(true).unwrap();
        e.close_authority = opt(Some(key(9)));
    }
    state.base = Mint {
        mint_authority: coption(s.mint_authority),
        supply: s.supply,
        decimals: s.decimals,
        is_initialized: true,
        freeze_authority: coption(s.freeze_authority),
    };
    state.pack_base();
    state.init_account_type().unwrap();
    if let Some(m) = &metadata {
        state.init_variable_len_extension(m, false).unwrap();
    }
    data
}

fn inspect(s: &Spec) -> Result<crate::checks::MintFacts> {
    inspect_mint(
        &s.mint,
        &spl_token_2022::ID,
        &build(s),
        6,
        &HOOK,
        &DBC_POOL_AUTHORITY,
    )
}

#[test]
fn launched_mint_passes_with_every_mint_flag() {
    let facts = inspect(&good()).unwrap();
    assert_eq!(facts.supply, 1_000_000_000_000_000);
    let mint_flags = checks::MINT_AUTHORITY_NONE
        | checks::FREEZE_AUTHORITY_NONE
        | checks::METADATA_UPDATE_AUTHORITY_NONE
        | checks::METADATA_POINTER_AUTHORITY_NONE
        | checks::EXTENSION_SET_EXACT
        | checks::HOOK_IS_NOISED;
    assert_eq!(facts.checks, mint_flags);
}

#[test]
fn every_unsafe_mint_is_refused() {
    let cases: Vec<Case<Spec>> = vec![
        (
            "mint authority",
            Box::new(|s| s.mint_authority = Some(key(1))),
        ),
        (
            "freeze authority",
            Box::new(|s| s.freeze_authority = Some(key(1))),
        ),
        ("zero supply", Box::new(|s| s.supply = 0)),
        ("wrong decimals", Box::new(|s| s.decimals = 9)),
        ("no metadata pointer", Box::new(|s| s.pointer = None)),
        ("no transfer hook", Box::new(|s| s.hook = None)),
        ("no metadata", Box::new(|s| s.metadata = None)),
        ("extra extension", Box::new(|s| s.close_authority = true)),
        (
            "foreign hook program",
            Box::new(|s| s.hook = Some((Some(DBC_POOL_AUTHORITY), Some(key(2))))),
        ),
        (
            "revoked hook",
            Box::new(|s| s.hook = Some((Some(DBC_POOL_AUTHORITY), None))),
        ),
        (
            "hook authority not DBC",
            Box::new(|s| s.hook = Some((Some(key(3)), Some(HOOK)))),
        ),
        (
            "hook authority none",
            Box::new(|s| s.hook = Some((None, Some(HOOK)))),
        ),
        (
            "pointer authority",
            Box::new(|s| s.pointer = Some((Some(key(4)), Some(s.mint)))),
        ),
        (
            "pointer elsewhere",
            Box::new(|s| s.pointer = Some((None, Some(key(5))))),
        ),
        (
            "pointer empty",
            Box::new(|s| s.pointer = Some((None, None))),
        ),
        (
            "metadata authority",
            Box::new(|s| s.metadata = Some((Some(key(6)), s.mint))),
        ),
        (
            "metadata for another mint",
            Box::new(|s| s.metadata = Some((None, key(7)))),
        ),
    ];
    for (name, mutate) in cases {
        let mut s = good();
        mutate(&mut s);
        assert!(inspect(&s).is_err(), "accepted a mint with: {name}");
    }
}

#[test]
fn mint_owned_by_another_program_is_refused() {
    let s = good();
    let data = build(&s);
    for owner in [anchor_spl::token::ID, Pubkey::default(), HOOK] {
        assert!(inspect_mint(&s.mint, &owner, &data, 6, &HOOK, &DBC_POOL_AUTHORITY).is_err());
    }
    assert!(inspect_mint(
        &s.mint,
        &spl_token_2022::ID,
        &data[..82],
        6,
        &HOOK,
        &DBC_POOL_AUTHORITY
    )
    .is_err());
}

fn good_config(authority: &Pubkey) -> ConfigWithTransferHook {
    let mut cfg: ConfigWithTransferHook = bytemuck::Zeroable::zeroed();
    cfg.transfer_hook_program = HOOK;
    let c = &mut cfg.config;
    c.quote_mint = WSOL_MINT;
    c.fee_claimer = *authority;
    c.leftover_receiver = *authority;
    c.token_type = 1;
    c.token_update_authority = 1;
    c.migration_option = 1;
    c.collect_fee_mode = 0;
    c.activation_type = 1;
    c.token_decimal = 6;
    c.migration_quote_threshold = 85_000_000_000;
    c.migration_fee_option = 2;
    c.partner_permanent_locked_liquidity_percentage = 100;
    cfg
}

fn expected(authority: &Pubkey) -> ExpectedConfig<'_> {
    ExpectedConfig {
        launch_authority: authority,
        hook_program: &HOOK,
        token_decimal: 6,
        migration_quote_threshold: 85_000_000_000,
        migration_fee_option: 2,
    }
}

#[test]
fn safe_config_sets_every_config_flag() {
    let authority = key(0x44);
    let flags = inspect_config(&good_config(&authority), &expected(&authority)).unwrap();
    assert_eq!(
        flags,
        checks::LP_PERMANENTLY_LOCKED
            | checks::NO_MIGRATION_FEE
            | checks::NO_CREATOR_ALLOCATION
            | checks::QUOTE_IS_WSOL
    );
    // The mint's six flags, the config's four, the attestation's and the
    // mint metadata's make ALL.
    assert_eq!(
        flags | 63 | checks::PQ_ATTESTED | checks::METADATA_ONCHAIN,
        checks::ALL
    );
}

/// Every certificate check is its own bit, and ALL is exactly their union
/// (PQ v2 added PQ_ATTESTED, the on-chain metadata METADATA_ONCHAIN).
#[test]
fn check_bits_are_distinct_and_make_all() {
    let bits = [
        checks::MINT_AUTHORITY_NONE,
        checks::FREEZE_AUTHORITY_NONE,
        checks::METADATA_UPDATE_AUTHORITY_NONE,
        checks::METADATA_POINTER_AUTHORITY_NONE,
        checks::EXTENSION_SET_EXACT,
        checks::HOOK_IS_NOISED,
        checks::LP_PERMANENTLY_LOCKED,
        checks::NO_MIGRATION_FEE,
        checks::NO_CREATOR_ALLOCATION,
        checks::QUOTE_IS_WSOL,
        checks::PQ_ATTESTED,
        checks::METADATA_ONCHAIN,
    ];
    for (i, bit) in bits.iter().enumerate() {
        assert_eq!(*bit, 1 << i);
    }
    assert_eq!(bits.iter().fold(0, |all, bit| all | bit), checks::ALL);
    assert_eq!(
        (checks::PQ_ATTESTED, checks::METADATA_ONCHAIN, checks::ALL),
        (1_024, 2_048, 4_095)
    );
    // Amendment A2: RULES_BOUND is the next bit, informational, outside the
    // set `launch` requires.
    assert_eq!(checks::RULES_BOUND, 1 << bits.len());
    assert_eq!(checks::RULES_BOUND, 4_096);
    assert_eq!(checks::RULES_BOUND & checks::ALL, 0);
}

/// `launch`'s metadata post-condition reads Token-2022's own encoding of
/// TokenMetadata (built here with spl-token-metadata-interface) in place:
/// it accepts the mint exactly when name, symbol and uri equal the expected
/// strings byte for byte and there is no additional metadata, for an empty,
/// an external and a 4,125-byte inline uri, and a multi-byte name.
#[test]
fn mint_metadata_must_equal_the_record() {
    let inline = format!("data:application/json;base64,{}", "QUJD".repeat(1_024));
    assert_eq!(inline.len(), 4_125);
    let euros = "\u{20ac}".repeat(10) + "NN";
    assert_eq!(euros.len(), 32);
    for (name, symbol, uri) in [
        ("Noised", "PHX", ""),
        ("Noised", "PHX", "https://example.org/phx.json"),
        (euros.as_str(), "S", inline.as_str()),
    ] {
        let mut s = good();
        s.strings = (name.into(), symbol.into(), uri.into());
        let data = build(&s);
        assert_eq!(
            verify_token_metadata(&data, name, symbol, uri.as_bytes()).unwrap(),
            checks::METADATA_ONCHAIN
        );
        // The mint's other checks do not depend on its strings.
        assert!(inspect(&s).is_ok());
        let mismatch = |n: &str, sy: &str, u: &str| {
            let err = verify_token_metadata(&data, n, sy, u.as_bytes()).unwrap_err();
            assert_eq!(err, LaunchpadError::MetadataMismatch.into(), "{n} {sy} {u}");
        };
        let longer = format!("{uri} ");
        mismatch("Rugged", symbol, uri);
        mismatch(name, "RUG", uri);
        mismatch(name, symbol, &longer);
        mismatch(name, symbol, "https://example.org/other.json");
        mismatch(&name[..name.len() - 1], symbol, uri);
        mismatch(symbol, name, uri);
        if !uri.is_empty() {
            mismatch(name, symbol, &uri[..uri.len() - 1]);
            mismatch(name, symbol, "");
        }
    }
    // Additional metadata is refused even when the three strings match.
    let mut s = good();
    s.additional = vec![("description".into(), "x".into())];
    let data = build(&s);
    let (name, symbol, uri) = (&s.strings.0, &s.strings.1, s.strings.2.as_bytes());
    assert!(verify_token_metadata(&data, name, symbol, uri).is_err());
    // A mint without TokenMetadata, or no mint at all, is refused.
    let mut s = good();
    s.metadata = None;
    let data = build(&s);
    let (name, symbol, uri) = (&s.strings.0, &s.strings.1, s.strings.2.as_bytes());
    assert!(verify_token_metadata(&data, name, symbol, uri).is_err());
    assert!(verify_token_metadata(&[0; 82], name, symbol, uri).is_err());
    assert!(verify_token_metadata(&[], name, symbol, uri).is_err());
}

/// The comparison on raw TLV values: authority and mint (64 bytes) are
/// skipped, then every byte from there to the end counts.
#[test]
fn token_metadata_values_compare_byte_for_byte() {
    let mut value = vec![0xEE; 64];
    for s in ["Nm", "S", "u"] {
        value.extend_from_slice(&(s.len() as u32).to_le_bytes());
        value.extend_from_slice(s.as_bytes());
    }
    value.extend_from_slice(&0u32.to_le_bytes());
    let u: &[u8] = b"u";
    assert!(token_metadata_matches(&value, b"Nm", b"S", u));
    // Every single-byte change after the first 64 bytes is caught, and so is
    // any truncation or extension.
    for at in 64..value.len() {
        let mut v = value.clone();
        v[at] ^= 1;
        assert!(!token_metadata_matches(&v, b"Nm", b"S", u), "byte {at}");
    }
    for len in 0..value.len() {
        assert!(!token_metadata_matches(&value[..len], b"Nm", b"S", u));
    }
    let mut longer = value.clone();
    longer.push(0);
    assert!(!token_metadata_matches(&longer, b"Nm", b"S", u));
    // Length prefixes keep the fields apart: the same bytes, split
    // differently, are other strings.
    assert!(!token_metadata_matches(&value, b"N", b"mS", u));
    // A huge length prefix is refused, not read past the end.
    let mut huge = value.clone();
    huge[64..68].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(!token_metadata_matches(&huge, b"Nm", b"S", u));
    // Another uri.
    assert!(!token_metadata_matches(&value, b"Nm", b"S", b"v"));
    assert!(!token_metadata_matches(&value, b"Nm", b"S", b""));
}

#[test]
fn every_unsafe_config_is_refused() {
    let authority = key(0x44);
    let cases: Vec<ConfigCase> = vec![
        ("hook program", |c| c.transfer_hook_program = key(1)),
        ("fee claimer", |c| c.config.fee_claimer = key(1)),
        ("leftover receiver", |c| c.config.leftover_receiver = key(1)),
        ("spl token", |c| c.config.token_type = 0),
        ("creator update authority", |c| {
            c.config.token_update_authority = 0
        }),
        ("creator mint authority", |c| {
            c.config.token_update_authority = 3
        }),
        ("partner mint authority", |c| {
            c.config.token_update_authority = 4
        }),
        ("damm v1", |c| c.config.migration_option = 0),
        ("output-token fees", |c| c.config.collect_fee_mode = 1),
        ("slot activation", |c| c.config.activation_type = 0),
        ("creator fee share", |c| {
            c.config.creator_trading_fee_percentage = 1
        }),
        ("fixed supply", |c| c.config.fixed_token_supply_flag = 1),
        ("creation fee", |c| c.config.pool_creation_fee = 1),
        ("first swap discount", |c| {
            c.config.enable_first_swap_with_min_fee = 1
        }),
        ("decimals", |c| c.config.token_decimal = 9),
        ("threshold", |c| c.config.migration_quote_threshold += 1),
        ("migration fee option", |c| {
            c.config.migration_fee_option = 6
        }),
        ("unlocked partner lp", |c| {
            c.config.partner_permanent_locked_liquidity_percentage = 99;
            c.config.partner_liquidity_percentage = 1;
        }),
        ("creator lp", |c| c.config.creator_liquidity_percentage = 1),
        ("creator locked lp", |c| {
            c.config.creator_permanent_locked_liquidity_percentage = 1
        }),
        ("partner vesting", |c| {
            c.config.partner_liquidity_vesting_info.is_initialized = 1
        }),
        ("creator vesting", |c| {
            c.config.creator_liquidity_vesting_info.is_initialized = 1
        }),
        ("migration fee", |c| c.config.migration_fee_percentage = 1),
        ("creator migration fee", |c| {
            c.config.creator_migration_fee_percentage = 1
        }),
        ("creator allocation", |c| {
            c.config.locked_vesting_config.cliff_unlock_amount = 1
        }),
        ("vesting allocation", |c| {
            c.config.locked_vesting_config.amount_per_period = 1
        }),
        ("vesting frequency", |c| {
            c.config.locked_vesting_config.frequency = 1
        }),
        ("vesting periods", |c| {
            c.config.locked_vesting_config.number_of_period = 1
        }),
        ("vesting cliff", |c| {
            c.config
                .locked_vesting_config
                .cliff_duration_from_migration_time = 1
        }),
        ("quote mint", |c| c.config.quote_mint = key(1)),
    ];
    for (name, mutate) in cases {
        let mut cfg = good_config(&authority);
        mutate(&mut cfg);
        assert!(
            inspect_config(&cfg, &expected(&authority)).is_err(),
            "accepted config with: {name}"
        );
    }
}
