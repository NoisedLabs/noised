//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check the program's own encoders, decoders and policy
//! against the code the Anchor build ran: Anchor's serialization and
//! discriminators, the IDL, the anchor-lang error table, Borsh, the SPL
//! instruction builders, and the Anchor build's own base-mint policy,
//! zToken metadata and zToken verification (the files of `anchor/`,
//! compiled here verbatim as the reference). Random inputs (malformed ones
//! included) must give the same result, or the same error. The shared
//! parsers and checks (Token-2022 parsing, transfer-hook resolution, rent,
//! the framework error table and log lines) are tested against the SPL and
//! Anchor crates in `crates/noised-onchain/tests`.

use std::collections::BTreeSet;

use anchor_lang::{
    error::ErrorCode,
    solana_program::{
        account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
        program_option::COption, system_instruction,
    },
    AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize, Discriminator, Event,
    InstructionData, Space, ToAccountMetas,
};
use anchor_spl::{
    token_2022::spl_token_2022::{
        self,
        extension::{
            confidential_transfer::{self, ConfidentialTransferMint},
            metadata_pointer::{self, MetadataPointer},
            BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
        },
        state::Mint as SplMint,
    },
    token_2022_extensions::{
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::{self, state::TokenMetadata},
    },
};
use noised_onchain::{
    host::{
        fuzz::{random_mint, Rng},
        set_sysvar, take_cpis, take_log_lines, HostAccount,
    },
    sysvar::{Rent, RENT_ID},
    Seed, Signer,
};
use noised_shield::{
    accounts, discriminator, error as lean_error, event_data, instruction,
    metadata as lean_metadata, policy as lean_policy, processor::parse_amount, state::Shield,
    token, zmint as lean_zmint, Pubkey, ShieldCreated, Unwrapped, Wrapped, ID,
};

// The Anchor build's sources (anchor/), compiled as the reference. Their
// own unit tests run here too.
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../anchor/error.rs"]
mod error;
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../anchor/metadata.rs"]
mod metadata;
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../anchor/policy.rs"]
mod policy;
#[allow(dead_code, unused_imports, clippy::all)]
#[path = "../anchor/zmint.rs"]
mod zmint;

fn sha256_8(input: &str) -> [u8; 8] {
    noised_onchain::hashv(&[input.as_bytes()])[..8]
        .try_into()
        .unwrap()
}

fn idl() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../idls/noised_shield.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read the IDL")).expect("IDL JSON")
}

fn idl_bytes(v: &serde_json::Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn find<'a>(idl: &'a serde_json::Value, list: &str, name: &str) -> &'a serde_json::Value {
    idl[list]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("IDL {list}: {name}"))
}

// ------------------------------------------------------------------ ids

#[test]
fn program_and_well_known_ids() {
    assert_eq!(
        ID,
        anchor_lang::pubkey!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9")
    );
    assert_eq!(ID.to_string(), idl()["address"].as_str().unwrap());
    assert_eq!(
        <noised_shield::program::NoisedShield as anchor_lang::Id>::id(),
        ID
    );
    assert!(noised_shield::check_id(&ID) && noised_shield::id() == ID);
    assert_eq!(token::TOKEN_PROGRAM_ID, anchor_spl::token::ID);
    assert_eq!(token::TOKEN_2022_PROGRAM_ID, anchor_spl::token_2022::ID);
    assert_eq!(
        token::ASSOCIATED_TOKEN_PROGRAM_ID,
        anchor_spl::associated_token::ID
    );
    assert_eq!(token::SYSTEM_PROGRAM_ID, anchor_lang::system_program::ID);
    // The seeds the SDK and the hook derive the shield's PDAs with.
    use noised_shield::state::{SHIELD_AUTHORITY_SEED, SHIELD_SEED, Z_MINT_SEED};
    assert_eq!(
        (SHIELD_SEED, SHIELD_AUTHORITY_SEED, Z_MINT_SEED),
        (&b"shield"[..], &b"shield-authority"[..], &b"z-mint"[..])
    );
}

// ------------------------------------------------------- discriminators

#[test]
fn discriminators_are_anchors_and_the_idls() {
    let idl = idl();
    let cases: [(&str, [u8; 8], &[u8]); 3] = [
        (
            "create_shield",
            discriminator::CREATE_SHIELD,
            instruction::CreateShield::DISCRIMINATOR,
        ),
        (
            "wrap",
            discriminator::WRAP,
            instruction::Wrap::DISCRIMINATOR,
        ),
        (
            "unwrap",
            discriminator::UNWRAP,
            instruction::Unwrap::DISCRIMINATOR,
        ),
    ];
    for (name, disc, client) in cases {
        assert_eq!(disc, sha256_8(&format!("global:{name}")), "{name}");
        assert_eq!(client, disc, "{name}");
        assert_eq!(
            idl_bytes(&find(&idl, "instructions", name)["discriminator"]),
            disc,
            "{name}"
        );
    }
    assert_eq!(discriminator::SHIELD, sha256_8("account:Shield"));
    assert_eq!(Shield::DISCRIMINATOR, discriminator::SHIELD);
    assert_eq!(
        idl_bytes(&find(&idl, "accounts", "Shield")["discriminator"]),
        discriminator::SHIELD
    );
    for (name, disc, anchor) in [
        (
            "ShieldCreated",
            discriminator::SHIELD_CREATED,
            ShieldCreated::DISCRIMINATOR,
        ),
        ("Wrapped", discriminator::WRAPPED, Wrapped::DISCRIMINATOR),
        (
            "Unwrapped",
            discriminator::UNWRAPPED,
            Unwrapped::DISCRIMINATOR,
        ),
    ] {
        assert_eq!(disc, sha256_8(&format!("event:{name}")));
        assert_eq!(anchor, disc);
        assert_eq!(
            idl_bytes(&find(&idl, "events", name)["discriminator"]),
            disc
        );
    }
    assert_eq!(
        discriminator::EVENT_IX_TAG_LE,
        anchor_lang::event::EVENT_IX_TAG_LE
    );
}

/// The account lists the client builds are the IDL's, in order, with the
/// IDL's signer and writable flags (the program checks the same flags).
#[test]
fn account_lists_are_the_idls() {
    let idl = idl();
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let wrap = accounts::Wrap {
        user: k(1),
        shield: k(2),
        shield_authority: k(3),
        base_mint: k(4),
        z_mint: k(5),
        escrow: k(6),
        user_base: k(7),
        user_z: k(8),
        base_token_program: k(9),
        token_2022_program: k(10),
    };
    let unwrap = accounts::Unwrap {
        user: k(1),
        shield: k(2),
        shield_authority: k(3),
        base_mint: k(4),
        z_mint: k(5),
        escrow: k(6),
        user_base: k(7),
        user_z: k(8),
        base_token_program: k(9),
        token_2022_program: k(10),
    };
    let lists = [
        (
            "create_shield",
            accounts::CreateShield {
                payer: k(1),
                base_mint: k(2),
                shield: k(3),
                shield_authority: k(4),
                z_mint: k(5),
                escrow: k(6),
                base_token_program: k(7),
                token_2022_program: k(8),
                associated_token_program: k(9),
                system_program: k(10),
            }
            .to_account_metas(None),
        ),
        ("wrap", wrap.to_account_metas(None)),
        ("unwrap", unwrap.to_account_metas(None)),
    ];
    for (name, metas) in lists {
        let expected = find(&idl, "instructions", name)["accounts"]
            .as_array()
            .unwrap();
        assert_eq!(metas.len(), expected.len(), "{name}");
        for (i, (meta, account)) in metas.iter().zip(expected).enumerate() {
            assert_eq!(meta.pubkey, k(i as u8 + 1), "{name} #{i}");
            assert_eq!(
                meta.is_signer,
                account["signer"].as_bool().unwrap_or(false),
                "{name} {}",
                account["name"]
            );
            assert_eq!(
                meta.is_writable,
                account["writable"].as_bool().unwrap_or(false),
                "{name} {}",
                account["name"]
            );
        }
    }
    // Anchor's `is_signer` override applies to the signer field only.
    let metas = wrap.to_account_metas(Some(false));
    assert!(metas.iter().all(|m| !m.is_signer));
}

/// The fields of `data` (from `skip`) laid out as the IDL type `name`
/// says, Borsh: each field's bytes (a string's without its length). The
/// layout must end exactly at the end of the data.
fn idl_fields(
    idl: &serde_json::Value,
    name: &str,
    data: &[u8],
    skip: usize,
) -> Vec<(String, Vec<u8>)> {
    let fields = find(idl, "types", name)["type"]["fields"]
        .as_array()
        .unwrap();
    let mut at = skip;
    let mut out = Vec::new();
    for f in fields {
        let (start, len) = match f["type"].as_str() {
            Some("u8") => (at, 1),
            Some("u64") | Some("i64") => (at, 8),
            Some("pubkey") => (at, 32),
            Some("string") => {
                let n = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
                at += 4;
                (at, n)
            }
            other => panic!("unexpected IDL type {other:?}"),
        };
        out.push((
            f["name"].as_str().unwrap().to_string(),
            data[start..start + len].to_vec(),
        ));
        at = start + len;
    }
    assert_eq!(at, data.len(), "{name}: the layout covers the data");
    out
}

/// The hand-maintained IDL describes the program's layouts: every field of
/// the account and the events sits where the IDL's Borsh layout puts it,
/// and nothing follows the last field.
#[test]
fn idl_types_describe_the_layouts() {
    let idl = idl();
    let mut r = Rng(8);
    let shield = random_shield(&mut r);
    let mut data = [0u8; Shield::LEN];
    shield.write(&mut data);
    for (name, bytes) in idl_fields(&idl, "Shield", &data, 8) {
        let want: Vec<u8> = match name.as_str() {
            "version" => vec![shield.version],
            "bump" => vec![shield.bump],
            "authority_bump" => vec![shield.authority_bump],
            "z_mint_bump" => vec![shield.z_mint_bump],
            "decimals" => vec![shield.decimals],
            "base_mint" => shield.base_mint.to_bytes().to_vec(),
            "base_token_program" => shield.base_token_program.to_bytes().to_vec(),
            "z_mint" => shield.z_mint.to_bytes().to_vec(),
            "escrow" => shield.escrow.to_bytes().to_vec(),
            "created_at" => shield.created_at.to_le_bytes().to_vec(),
            other => panic!("Shield.{other}"),
        };
        assert_eq!(bytes, want, "Shield.{name}");
    }

    for _ in 0..50 {
        let ev = random_shield_created(&mut r);
        let data = ev.log_data();
        for (name, bytes) in idl_fields(&idl, "ShieldCreated", &data, 8) {
            let want: Vec<u8> = match name.as_str() {
                "shield" => ev.shield.to_bytes().to_vec(),
                "base_mint" => ev.base_mint.to_bytes().to_vec(),
                "base_token_program" => ev.base_token_program.to_bytes().to_vec(),
                "z_mint" => ev.z_mint.to_bytes().to_vec(),
                "escrow" => ev.escrow.to_bytes().to_vec(),
                "decimals" => vec![ev.decimals],
                "name" => ev.name.as_bytes().to_vec(),
                "symbol" => ev.symbol.as_bytes().to_vec(),
                "uri" => ev.uri.as_bytes().to_vec(),
                "payer" => ev.payer.to_bytes().to_vec(),
                other => panic!("ShieldCreated.{other}"),
            };
            assert_eq!(bytes, want, "ShieldCreated.{name}");
        }
    }

    let (shield, base_mint, user) = (r.key(), r.key(), r.key());
    let (amount, minted, z_supply, escrow_balance) = (r.next(), r.next(), r.next(), r.next());
    let wrapped = event_data::wrapped(
        &shield,
        &base_mint,
        &user,
        amount,
        minted,
        z_supply,
        escrow_balance,
    );
    let unwrapped =
        event_data::unwrapped(&shield, &base_mint, &user, amount, z_supply, escrow_balance);
    assert_eq!(wrapped.as_slice().len(), event_data::WRAPPED_LEN);
    assert_eq!(unwrapped.as_slice().len(), event_data::UNWRAPPED_LEN);
    for (event, data) in [("Wrapped", wrapped), ("Unwrapped", unwrapped)] {
        for (name, bytes) in idl_fields(&idl, event, data.as_slice(), 8) {
            let want: Vec<u8> = match name.as_str() {
                "shield" => shield.to_bytes().to_vec(),
                "base_mint" => base_mint.to_bytes().to_vec(),
                "user" => user.to_bytes().to_vec(),
                "amount" => amount.to_le_bytes().to_vec(),
                "minted" => minted.to_le_bytes().to_vec(),
                "z_supply" => z_supply.to_le_bytes().to_vec(),
                "escrow_balance" => escrow_balance.to_le_bytes().to_vec(),
                other => panic!("{event}.{other}"),
            };
            assert_eq!(bytes, want, "{event}.{name}");
        }
    }

    // wrap / unwrap take one u64; create_shield none.
    for (name, args) in [("create_shield", 0usize), ("wrap", 1), ("unwrap", 1)] {
        let list = find(&idl, "instructions", name)["args"].as_array().unwrap();
        assert_eq!(list.len(), args, "{name}");
        if args == 1 {
            assert_eq!(list[0]["name"], "amount");
            assert_eq!(list[0]["type"], "u64");
        }
    }
}

// ------------------------------------------------------ account layouts

fn random_shield(r: &mut Rng) -> Shield {
    Shield {
        version: r.byte(),
        bump: r.byte(),
        authority_bump: r.byte(),
        z_mint_bump: r.byte(),
        decimals: r.byte(),
        base_mint: r.key(),
        base_token_program: r.key(),
        z_mint: r.key(),
        escrow: r.key(),
        created_at: r.next() as i64,
    }
}

/// `Shield` is written and read exactly as Anchor's `#[account]`
/// serialization: accounts written by either build read the same in the
/// other.
#[test]
fn account_layout_matches_anchor() {
    assert_eq!(Shield::LEN, 8 + Shield::INIT_SPACE);
    assert_eq!(Shield::LEN, 149);
    assert_eq!(Shield::VERSION, 1);
    let mut r = Rng(2);
    for _ in 0..2_000 {
        let shield = random_shield(&mut r);
        let mut anchor = Vec::new();
        shield.try_serialize(&mut anchor).unwrap();
        let mut ours = [0u8; Shield::LEN];
        shield.write(&mut ours);
        assert_eq!(anchor, ours);
        assert_eq!(Shield::read(&ours), shield);
        let mut longer = anchor.clone();
        longer.extend(r.bytes(9));
        assert_eq!(
            Shield::try_deserialize(&mut &longer[..]).unwrap(),
            Shield::read(longer[..Shield::LEN].try_into().unwrap())
        );
        assert_eq!(
            noised_onchain::host::deserialize::<Shield>(&longer),
            Ok(Shield::read(longer[..Shield::LEN].try_into().unwrap()))
        );
        // Shorter data does not decode (Anchor: AccountDidNotDeserialize).
        let cut = r.below(Shield::LEN as u64) as usize;
        assert!(Shield::try_deserialize(&mut &anchor[..cut]).is_err());
        assert!(noised_onchain::host::deserialize::<Shield>(&anchor[..cut]).is_err());
    }
}

// --------------------------------------------------------------- events

/// A string of up to `max` characters from a palette of plain, multi-byte,
/// whitespace, control, bidirectional and zero-width characters.
fn random_text(r: &mut Rng, max: u64) -> String {
    const PALETTE: [char; 32] = [
        'a',
        'Z',
        '0',
        '.',
        '/',
        ' ',
        ' ',
        '\t',
        '\n',
        '\r',
        '\u{0}',
        '\u{7f}',
        '\u{85}',
        '\u{a0}',
        '\u{61c}',
        '\u{180e}',
        '\u{200b}',
        '\u{200d}',
        '\u{200f}',
        '\u{2028}',
        '\u{202e}',
        '\u{2060}',
        '\u{2066}',
        '\u{2069}',
        '\u{3000}',
        '\u{feff}',
        'é',
        'ß',
        '中',
        '🛡',
        '\u{1f600}',
        '\u{10ffff}',
    ];
    let n = r.below(max + 1);
    (0..n).map(|_| r.pick(&PALETTE)).collect()
}

fn random_shield_created(r: &mut Rng) -> ShieldCreated {
    ShieldCreated {
        shield: r.key(),
        base_mint: r.key(),
        base_token_program: r.key(),
        z_mint: r.key(),
        escrow: r.key(),
        decimals: r.byte(),
        name: random_text(r, 12),
        symbol: random_text(r, 4),
        uri: random_text(r, 60),
        payer: r.key(),
    }
}

/// The events are Anchor's `emit!` payloads: discriminator, then Borsh.
#[test]
fn events_match_anchor() {
    let mut r = Rng(3);
    for _ in 0..2_000 {
        let created = random_shield_created(&mut r);
        assert_eq!(created.data(), created.log_data());
        let wrapped = Wrapped {
            shield: r.key(),
            base_mint: r.key(),
            user: r.key(),
            amount: r.next(),
            minted: r.next(),
            z_supply: r.next(),
            escrow_balance: r.next(),
        };
        assert_eq!(wrapped.data(), wrapped.log_data().as_slice());
        let unwrapped = Unwrapped {
            shield: r.key(),
            base_mint: r.key(),
            user: r.key(),
            amount: r.next(),
            z_supply: r.next(),
            escrow_balance: r.next(),
        };
        assert_eq!(unwrapped.data(), unwrapped.log_data().as_slice());
    }
    // The longest ShieldCreated (every metadata field at its limit) fits.
    let longest = ShieldCreated {
        shield: r.key(),
        base_mint: r.key(),
        base_token_program: r.key(),
        z_mint: r.key(),
        escrow: r.key(),
        decimals: 9,
        name: "n".repeat(lean_metadata::MAX_NAME_LEN),
        symbol: "s".repeat(lean_metadata::MAX_SYMBOL_LEN),
        uri: "u".repeat(lean_metadata::MAX_URI_LEN),
        payer: r.key(),
    };
    assert_eq!(longest.data().len(), event_data::SHIELD_CREATED_MAX_LEN);
    assert_eq!(longest.data(), longest.log_data());
}

// ------------------------------------------------------------ arguments

/// `wrap` / `unwrap` decode their `amount` as Anchor's dispatcher did
/// (Borsh from the data after the discriminator: trailing bytes ignored, a
/// short input fails); `create_shield` takes no argument and decodes from
/// anything.
#[test]
fn argument_decoding_matches_borsh() {
    let mut r = Rng(1);
    for round in 0..20_000 {
        let mut data = instruction::Wrap { amount: r.next() }.data()[8..].to_vec();
        match r.below(4) {
            0 => data.truncate(r.below(9) as usize),
            1 => data.extend(r.some_bytes(20)),
            2 => data = r.some_bytes(16),
            _ => {}
        }
        let borsh = instruction::Wrap::deserialize(&mut &data[..])
            .ok()
            .map(|w| w.amount);
        let unwrap = instruction::Unwrap::deserialize(&mut &data[..])
            .ok()
            .map(|w| w.amount);
        assert_eq!(borsh, unwrap);
        assert_eq!(borsh, parse_amount(&data).ok(), "round {round}");
        assert!(instruction::CreateShield::deserialize(&mut &data[..]).is_ok());
    }
    let _ = take_log_lines();
    assert_eq!(
        parse_amount(&[1, 2, 3]),
        Err(ProgramError::Custom(
            ErrorCode::InstructionDidNotDeserialize.into()
        ))
    );
    assert_eq!(
        take_log_lines(),
        ["Program log: AnchorError occurred. Error Code: InstructionDidNotDeserialize. Error Number: 102. Error Message: The program could not deserialize the given instruction."]
    );
}

// --------------------------------------------------------------- errors

/// The program's numbers, names and messages are the IDL's and the Anchor
/// build's (`ShieldError`) and anchor-lang 1.2.1's (framework errors), and
/// no other number is logged.
#[test]
fn error_table_matches_anchor_and_the_idl() {
    use lean_error::ShieldError as Lean;
    let pairs = [
        (
            Lean::UnsupportedExtension,
            error::ShieldError::UnsupportedExtension,
        ),
        (
            Lean::MalformedBaseMint,
            error::ShieldError::MalformedBaseMint,
        ),
        (Lean::ZeroAmount, error::ShieldError::ZeroAmount),
        (Lean::NothingReceived, error::ShieldError::NothingReceived),
        (
            Lean::Undercollateralized,
            error::ShieldError::Undercollateralized,
        ),
        (
            Lean::AccountingMismatch,
            error::ShieldError::AccountingMismatch,
        ),
        (Lean::ZMintInUse, error::ShieldError::ZMintInUse),
        (
            Lean::ZMintMisconfigured,
            error::ShieldError::ZMintMisconfigured,
        ),
        (Lean::SameAccount, error::ShieldError::SameAccount),
        (Lean::MathOverflow, error::ShieldError::MathOverflow),
    ];
    for (i, (ours, anchor)) in pairs.into_iter().enumerate() {
        assert_eq!(u32::from(ours), 6000 + i as u32);
        assert_eq!(u32::from(ours), u32::from(anchor));
        assert_eq!(ours.name(), anchor.name());
        assert_eq!(ours.message(), anchor.to_string());
        assert_eq!(ours.name(), format!("{ours:?}"));
    }
    let idl_errors = idl()["errors"].as_array().unwrap().clone();
    assert_eq!(idl_errors.len(), pairs.len());
    for e in &idl_errors {
        let code = e["code"].as_u64().unwrap() as u32;
        assert_eq!(
            lean_error::name_and_message(code),
            (e["name"].as_str().unwrap(), e["msg"].as_str().unwrap())
        );
    }

    let framework = [
        ErrorCode::InstructionFallbackNotFound,
        ErrorCode::InstructionDidNotDeserialize,
        ErrorCode::EventInstructionStub,
        ErrorCode::ConstraintMut,
        ErrorCode::ConstraintHasOne,
        ErrorCode::ConstraintRentExempt,
        ErrorCode::ConstraintSeeds,
        ErrorCode::ConstraintTokenMint,
        ErrorCode::ConstraintTokenOwner,
        ErrorCode::ConstraintTokenTokenProgram,
        ErrorCode::ConstraintMintTokenProgram,
        ErrorCode::ConstraintAssociatedTokenTokenProgram,
        ErrorCode::ConstraintDuplicateMutableAccount,
        ErrorCode::AccountDiscriminatorNotFound,
        ErrorCode::AccountDiscriminatorMismatch,
        ErrorCode::AccountDidNotDeserialize,
        ErrorCode::AccountDidNotSerialize,
        ErrorCode::AccountNotEnoughKeys,
        ErrorCode::AccountOwnedByWrongProgram,
        ErrorCode::InvalidProgramId,
        ErrorCode::InvalidProgramExecutable,
        ErrorCode::AccountNotSigner,
        ErrorCode::AccountNotInitialized,
        ErrorCode::AccountNotAssociatedTokenAccount,
        ErrorCode::DeclaredProgramIdMismatch,
        ErrorCode::TryingToInitPayerAsProgramAccount,
    ];
    let mut codes = BTreeSet::new();
    for e in framework {
        let code = u32::from(e);
        assert!(codes.insert(code));
        assert_eq!(
            lean_error::name_and_message(code),
            (e.name().as_str(), e.to_string().as_str()),
            "{e:?}"
        );
    }
    codes.extend(
        idl_errors
            .iter()
            .map(|e| e["code"].as_u64().unwrap() as u32),
    );
    let table: BTreeSet<u32> = lean_error::numbers().collect();
    assert_eq!(table, codes);
    for code in lean_error::numbers() {
        assert_eq!(lean_error::describe(code)[1], code.to_string().as_bytes());
    }
    assert_eq!(lean_error::describe(1), [b"" as &[u8]; 3]);
}

// ------------------------------------------------- base mint policy

/// An initialized Token-2022 mint whose extension area is `tlv`.
fn mint_with_tlv(r: &mut Rng, tlv: &[u8]) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    if r.chance(80) {
        data[0] = 1;
        data[4..36].copy_from_slice(&r.array::<32>());
    }
    data[36..44].copy_from_slice(&r.next().to_le_bytes());
    data[44] = r.byte();
    data[45] = 1;
    if r.chance(20) {
        data[46] = 1;
        data[50..82].copy_from_slice(&r.array::<32>());
    }
    if tlv.is_empty() && r.chance(50) {
        return data;
    }
    data.resize(165, 0);
    data.push(1);
    data.extend_from_slice(tlv);
    data
}

fn entry(extension_type: u16, value: &[u8]) -> Vec<u8> {
    let mut v = extension_type.to_le_bytes().to_vec();
    v.extend((value.len() as u16).to_le_bytes());
    v.extend(value);
    v
}

fn borsh_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut v = (bytes.len() as u32).to_le_bytes().to_vec();
    v.extend(bytes);
    v
}

/// A `TokenMetadata` value naming `mint` (or another), with random strings
/// (sometimes not UTF-8, sometimes long), sometimes damaged.
fn random_token_metadata(r: &mut Rng, mint: &Pubkey) -> Vec<u8> {
    let mut v = r.array::<32>().to_vec();
    if r.chance(80) {
        v.extend(mint.as_ref());
    } else {
        v.extend(r.key().as_ref());
    }
    for max in [40, 14, 230] {
        let text = match r.below(10) {
            0 => r.some_bytes(max),
            1 => "x".repeat(r.below(300) as usize).into_bytes(),
            2 => "é".repeat(r.below(80) as usize).into_bytes(),
            _ => random_text(r, max).into_bytes(),
        };
        v.extend(borsh_bytes(&text));
    }
    let extra = r.below(3) as u32;
    v.extend(extra.to_le_bytes());
    for _ in 0..extra {
        v.extend(borsh_bytes(b"key"));
        v.extend(borsh_bytes(&r.some_bytes(10)));
    }
    match r.below(8) {
        0 => v.truncate(r.below(v.len() as u64 + 1) as usize),
        1 => {
            let at = 64 + r.below(8) as usize;
            if at + 4 <= v.len() {
                v[at..at + 4].copy_from_slice(&(r.next() as u32).to_le_bytes());
            }
        }
        _ => {}
    }
    v
}

/// Extension areas a base mint may have: the allowlist in random order and
/// form (a metadata pointer to the mint or elsewhere, embedded metadata),
/// refused and unknown types, damaged entries.
fn random_base_tlv(r: &mut Rng, mint: &Pubkey) -> Vec<u8> {
    let mut tlv = Vec::new();
    for _ in 0..r.below(5) {
        let e = match r.below(12) {
            0 | 1 => {
                let mut pointer = if r.chance(20) {
                    r.array::<32>()
                } else {
                    [0; 32]
                }
                .to_vec();
                match r.below(4) {
                    0 => pointer.extend([0u8; 32]),
                    1 => pointer.extend(r.key().as_ref()),
                    _ => pointer.extend(mint.as_ref()),
                }
                if r.chance(10) {
                    pointer.pop();
                }
                entry(18, &pointer)
            }
            2 | 3 => entry(19, &random_token_metadata(r, mint)),
            4 => entry(14, &r.bytes(64)),
            5 => entry(1, &r.bytes(108)),
            6 => entry(r.below(28) as u16, &r.some_bytes(70)),
            7 => entry(28 + r.below(2000) as u16, &r.some_bytes(8)),
            8 => entry(0, &r.some_bytes(8)),
            9 => r.some_bytes(5),
            _ => entry(12, &r.bytes(32)),
        };
        tlv.extend(e);
    }
    tlv
}

/// The Anchor build's result in the lean program's terms.
fn anchor_inspect(
    data: &[u8],
    mint: &Pubkey,
) -> Result<(String, String, String), lean_policy::Rejection> {
    match policy::inspect_token_2022_mint(data, mint) {
        Ok(z) => Ok((z.name, z.symbol, z.uri)),
        Err(policy::Rejection::Malformed) => Err(lean_policy::Rejection::Malformed),
        Err(policy::Rejection::Unknown) => Err(lean_policy::Rejection::Unknown),
        Err(policy::Rejection::Unsupported(e)) => {
            Err(lean_policy::Rejection::Unsupported(u16::from(e)))
        }
    }
}

fn lean_inspect(
    data: &[u8],
    mint: &Pubkey,
) -> Result<(String, String, String), lean_policy::Rejection> {
    lean_policy::inspect_token_2022_mint(data, mint).map(|z| {
        (
            z.name.as_str().to_string(),
            z.symbol.as_str().to_string(),
            z.uri.as_str().to_string(),
        )
    })
}

/// `create_shield`'s base-mint policy (`UnsupportedExtension` /
/// `MalformedBaseMint`) and the zToken metadata it derives are the Anchor
/// build's, on random mints (malformed ones included), and refused
/// extensions are named as the Anchor build logged them.
#[test]
fn base_mint_policy_matches_the_anchor_build() {
    let mut r = Rng(5);
    let mut seen = [0usize; 4];
    for round in 0..100_000 {
        let mint = r.key();
        let data = if r.chance(30) {
            random_mint(&mut r)
        } else {
            let tlv = random_base_tlv(&mut r, &mint);
            mint_with_tlv(&mut r, &tlv)
        };
        let anchor = anchor_inspect(&data, &mint);
        assert_eq!(lean_inspect(&data, &mint), anchor, "round {round}");
        seen[match anchor {
            Ok(_) => 0,
            Err(lean_policy::Rejection::Unsupported(e)) => {
                let name = format!("{:?}", ExtensionType::try_from(e).unwrap());
                assert_eq!(lean_policy::extension_name(e), name.as_bytes());
                1
            }
            Err(lean_policy::Rejection::Unknown) => 2,
            Err(lean_policy::Rejection::Malformed) => 3,
        }] += 1;
    }
    assert!(seen.iter().all(|n| *n > 1_000), "{seen:?}");
}

/// zToken names, symbols and uris are the Anchor build's for any base
/// metadata, and the base metadata is read as it read it.
#[test]
fn metadata_matches_the_anchor_build() {
    let mut r = Rng(6);
    for round in 0..50_000 {
        let mint = if r.chance(5) {
            let mut k = r.array::<32>();
            for b in k.iter_mut().take(r.below(4) as usize) {
                *b = 0;
            }
            Pubkey::new_from_array(k)
        } else {
            r.key()
        };
        let (name, symbol, uri) = (
            random_text(&mut r, 60),
            random_text(&mut r, 20),
            match r.below(4) {
                0 => "h".repeat(195 + r.below(10) as usize),
                _ => random_text(&mut r, 220),
            },
        );
        let base = r.chance(80);
        let anchor = metadata::derive(
            base.then_some(metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &mint,
        );
        let lean = lean_metadata::derive(
            base.then_some(lean_metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &mint,
        );
        assert_eq!(
            (lean.name.as_str(), lean.symbol.as_str(), lean.uri.as_str()),
            (
                anchor.name.as_str(),
                anchor.symbol.as_str(),
                anchor.uri.as_str()
            ),
            "round {round}: {name:?} {symbol:?} {uri:?}"
        );

        let value = random_token_metadata(&mut r, &mint);
        let anchor = metadata::read_base_metadata(&value, &mint).map(|b| (b.name, b.symbol, b.uri));
        let lean =
            lean_metadata::read_base_metadata(&value, &mint).map(|b| (b.name, b.symbol, b.uri));
        assert_eq!(lean, anchor, "round {round}");
        assert_eq!(lean_metadata::base58(&mint), mint.to_string());
    }
}

// ------------------------------------------------------------ the zToken

/// What `zmint::create` leaves at the zToken address: Token-2022 with
/// confidential transfers (no authority, auto-approve, no auditor), a
/// metadata pointer to itself (no authority), the mint, and immutable
/// metadata.
fn z_mint_data(
    z_mint: &Pubkey,
    authority: &Pubkey,
    decimals: u8,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Vec<u8> {
    let fixed = ExtensionType::try_calculate_account_len::<SplMint>(&[
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::MetadataPointer,
    ])
    .unwrap();
    let tm = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::default(),
        mint: *z_mint,
        name: name.into(),
        symbol: symbol.into(),
        uri: uri.into(),
        additional_metadata: vec![],
    };
    let mut value = Vec::new();
    tm.serialize(&mut value).unwrap();
    let mut data = vec![0u8; fixed + 4 + value.len()];
    let mut state = StateWithExtensionsMut::<SplMint>::unpack_uninitialized(&mut data).unwrap();
    let ct = state
        .init_extension::<ConfidentialTransferMint>(true)
        .unwrap();
    ct.auto_approve_new_accounts = true.into();
    let mp = state.init_extension::<MetadataPointer>(true).unwrap();
    mp.metadata_address = OptionalNonZeroPubkey::try_from(Some(*z_mint)).unwrap();
    state.base.mint_authority = COption::Some(*authority);
    state.base.decimals = decimals;
    state.base.is_initialized = true;
    state.pack_base();
    state.init_account_type().unwrap();
    state.init_variable_len_extension(&tm, false).unwrap();
    data
}

/// `zmint::verify` of the Anchor build on an `AccountInfo`.
fn anchor_verify(
    owner: &Pubkey,
    z_mint: &Pubkey,
    data: &[u8],
    authority: &Pubkey,
    decimals: u8,
    meta: &metadata::ZMetadata,
) -> Result<(), ProgramError> {
    let (mut lamports, mut data) = (1_000_000u64, data.to_vec());
    let info = AccountInfo::new(z_mint, false, true, &mut lamports, &mut data, owner, false);
    zmint::verify(&info, authority, decimals, meta).map_err(ProgramError::from)
}

/// `zmint::verify` of the lean program on a runtime-layout account.
fn lean_verify(
    owner: &Pubkey,
    z_mint: &Pubkey,
    data: &[u8],
    authority: &Pubkey,
    decimals: u8,
    meta: &lean_metadata::ZMetadata,
) -> Result<(), ProgramError> {
    let account = HostAccount::new(*z_mint, *owner, 1_000_000, data, false, true, false);
    lean_zmint::verify(&account.view(), authority, decimals, meta)
}

/// The zToken's post-creation check accepts exactly what the Anchor
/// build's accepted, and fails with the same error otherwise: on the real
/// zToken layout, every field changed, random byte flips, truncations and
/// extensions, and other owners.
#[test]
fn z_mint_verify_matches_the_anchor_build() {
    let mut r = Rng(7);
    let mut seen = BTreeSet::new();
    for round in 0..20_000 {
        let (z_mint, authority, base_mint) = (r.key(), r.key(), r.key());
        let decimals = r.byte() % 12;
        let (name, symbol, uri) = (
            random_text(&mut r, 20),
            random_text(&mut r, 6),
            random_text(&mut r, 40),
        );
        let base = r.chance(70);
        let anchor_meta = metadata::derive(
            base.then_some(metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &base_mint,
        );
        let lean_meta = lean_metadata::derive(
            base.then_some(lean_metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &base_mint,
        );
        let mut data = z_mint_data(
            &z_mint,
            &authority,
            decimals,
            &anchor_meta.name,
            &anchor_meta.symbol,
            &anchor_meta.uri,
        );
        let mut owner = spl_token_2022::ID;
        let (mut check_authority, mut check_decimals) = (authority, decimals);
        match r.below(16) {
            0 => {}
            1 => {
                owner = if r.chance(50) {
                    anchor_spl::token::ID
                } else {
                    r.key()
                }
            }
            2 => data.truncate(r.below(data.len() as u64) as usize),
            3 => data.extend(r.some_bytes(30)),
            4 => check_authority = r.key(),
            5 => check_decimals = decimals + 1,
            // supply
            6 => data[36] = 1,
            // freeze authority
            7 => data[46] = 1,
            // CT authority, auto-approve, auditor
            8 => data[170 + r.below(65) as usize] ^= 1 << r.below(8),
            // metadata pointer authority / address
            9 => data[239 + r.below(64) as usize] ^= 1 << r.below(8),
            // TokenMetadata update authority / mint / strings
            10 => {
                let at = 307 + r.below((data.len() - 307) as u64) as usize;
                data[at] ^= 1 << r.below(8);
            }
            // a TLV header
            11 => {
                let at = [166, 168, 235, 237, 303, 305][r.below(6) as usize];
                data[at] ^= 1 << r.below(8);
            }
            _ => {
                for _ in 0..1 + r.below(3) {
                    let at = r.below(data.len() as u64) as usize;
                    data[at] = r.byte();
                }
            }
        }
        let anchor = anchor_verify(
            &owner,
            &z_mint,
            &data,
            &check_authority,
            check_decimals,
            &anchor_meta,
        );
        let lean = lean_verify(
            &owner,
            &z_mint,
            &data,
            &check_authority,
            check_decimals,
            &lean_meta,
        );
        assert_eq!(lean, anchor, "round {round}");
        seen.insert(format!("{anchor:?}"));
    }
    let _ = take_log_lines();
    // Accepted, ZMintMisconfigured, and the parse errors passed through.
    assert!(seen.contains("Ok(())"), "{seen:?}");
    assert!(seen.contains("Err(Custom(6007))"), "{seen:?}");
    assert!(seen.len() >= 3, "{seen:?}");
}

/// The rent sysvar on the host (`Rent::get`): 3,480 lamports per byte-year,
/// threshold 2.0.
fn set_rent() -> Rent {
    let mut raw = Vec::new();
    raw.extend_from_slice(&3480u64.to_le_bytes());
    raw.extend_from_slice(&2.0f64.to_bits().to_le_bytes());
    raw.push(50);
    set_sysvar(&RENT_ID, &raw);
    Rent::get().unwrap()
}

/// `(program id, accounts as (address, signer, writable), data)`.
type Call = (Pubkey, Vec<(Pubkey, bool, bool)>, Vec<u8>);

fn call(ix: &Instruction) -> Call {
    (
        ix.program_id,
        ix.accounts
            .iter()
            .map(|m| (m.pubkey, m.is_signer, m.is_writable))
            .collect(),
        ix.data.clone(),
    )
}

/// `zmint::create` makes the Anchor build's CPIs, byte for byte and in
/// order (each built here with the SPL builders the Anchor build used), for
/// an empty zToken address and pre-funded ones; the PDA signs the system
/// program's calls, the shield authority the metadata calls. An address
/// that holds data or another owner's account is `ZMintInUse`.
#[test]
fn z_mint_creation_cpis_are_the_anchor_builds() {
    let rent = set_rent();
    let _ = take_cpis();
    let _ = take_log_lines();
    let mut r = Rng(9);
    let t22 = spl_token_2022::ID;
    for round in 0..300 {
        let (payer, z_mint, authority, base_mint) = (r.key(), r.key(), r.key(), r.key());
        let decimals = r.byte();
        let (name, symbol, uri) = (
            random_text(&mut r, 20),
            random_text(&mut r, 6),
            random_text(&mut r, 60),
        );
        let base = r.chance(70);
        let anchor_meta = metadata::derive(
            base.then_some(metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &base_mint,
        );
        let meta = lean_metadata::derive(
            base.then_some(lean_metadata::BaseMetadata {
                name: &name,
                symbol: &symbol,
                uri: &uri,
            }),
            &base_mint,
        );
        // Sizes: the Anchor build's.
        let reference = zmint::z_mint_size(
            &zmint::initial_metadata(&z_mint, &authority, &anchor_meta).unwrap(),
        )
        .unwrap();
        let size = lean_zmint::z_mint_size(&meta);
        assert_eq!((size.fixed, size.total), (reference.fixed, reference.total));
        let lamports = rent.minimum_balance(size.total);
        let current = match r.below(4) {
            0 => 0,
            1 => 1 + r.below(lamports),
            2 => lamports,
            _ => lamports + 1 + r.below(1_000_000),
        };

        let payer_account =
            HostAccount::new(payer, Pubkey::default(), 1 << 40, &[], true, true, false);
        let z_account =
            HostAccount::new(z_mint, Pubkey::default(), current, &[], false, true, false);
        let authority_account =
            HostAccount::new(authority, Pubkey::default(), 0, &[], false, false, false);
        let program_account = HostAccount::new(t22, Pubkey::default(), 1, &[], false, false, true);
        let (pv, zv, av, tv) = (
            payer_account.view(),
            z_account.view(),
            authority_account.view(),
            program_account.view(),
        );
        let z_seeds = [
            Seed::from(b"z-mint".as_ref()),
            Seed::from(base_mint.as_ref()),
        ];
        let a_seeds = [Seed::from(b"shield-authority".as_ref())];
        let result = lean_zmint::create(
            &lean_zmint::ZMintAccounts {
                payer: &pv,
                z_mint: &zv,
                shield_authority: &av,
                token_2022_program: &tv,
            },
            decimals,
            &meta,
            &[Signer::from(&z_seeds)],
            &[Signer::from(&a_seeds)],
        );
        assert_eq!(result, Ok(()), "round {round}");

        // The Anchor build's sequence (anchor/zmint.rs `create`).
        let space = size.fixed as u64;
        let mut expected: Vec<(Call, usize)> = Vec::new();
        if current == 0 {
            expected.push((
                call(&system_instruction::create_account(
                    &payer, &z_mint, lamports, space, &t22,
                )),
                1,
            ));
        } else {
            if lamports > current {
                expected.push((
                    call(&system_instruction::transfer(
                        &payer,
                        &z_mint,
                        lamports - current,
                    )),
                    0,
                ));
            }
            expected.push((call(&system_instruction::allocate(&z_mint, space)), 1));
            expected.push((call(&system_instruction::assign(&z_mint, &t22)), 1));
        }
        expected.push((
            call(
                &confidential_transfer::instruction::initialize_mint(
                    &t22, &z_mint, None, true, None,
                )
                .unwrap(),
            ),
            0,
        ));
        expected.push((
            call(
                &metadata_pointer::instruction::initialize(&t22, &z_mint, None, Some(z_mint))
                    .unwrap(),
            ),
            0,
        ));
        expected.push((
            call(
                &spl_token_2022::instruction::initialize_mint2(
                    &t22, &z_mint, &authority, None, decimals,
                )
                .unwrap(),
            ),
            0,
        ));
        expected.push((
            call(&spl_token_metadata_interface::instruction::initialize(
                &t22,
                &z_mint,
                &authority,
                &z_mint,
                &authority,
                anchor_meta.name.clone(),
                anchor_meta.symbol.clone(),
                anchor_meta.uri.clone(),
            )),
            1,
        ));
        expected.push((
            call(
                &spl_token_metadata_interface::instruction::update_authority(
                    &t22,
                    &z_mint,
                    &authority,
                    OptionalNonZeroPubkey::default(),
                ),
            ),
            1,
        ));
        let cpis: Vec<(Call, usize)> = take_cpis()
            .into_iter()
            .map(|c| ((c.program_id, c.accounts, c.data), c.signers))
            .collect();
        assert_eq!(cpis, expected, "round {round}");
    }
    assert!(take_log_lines().is_empty());

    // ZMintInUse: another owner (both keys logged), or data.
    let (payer, z_mint, authority) = (r.key(), r.key(), r.key());
    let meta = lean_metadata::derive(None, &r.key());
    let payer_account = HostAccount::new(payer, Pubkey::default(), 1 << 40, &[], true, true, false);
    let authority_account =
        HostAccount::new(authority, Pubkey::default(), 0, &[], false, false, false);
    let program_account = HostAccount::new(t22, Pubkey::default(), 1, &[], false, false, true);
    for (owner, data, keys) in [
        (t22, &[][..], true),
        (ID, &[1u8][..], true),
        (Pubkey::default(), &[0u8; 3][..], false),
    ] {
        let z_account = HostAccount::new(z_mint, owner, 1_000, data, false, true, false);
        let (pv, zv, av, tv) = (
            payer_account.view(),
            z_account.view(),
            authority_account.view(),
            program_account.view(),
        );
        let result = lean_zmint::create(
            &lean_zmint::ZMintAccounts {
                payer: &pv,
                z_mint: &zv,
                shield_authority: &av,
                token_2022_program: &tv,
            },
            6,
            &meta,
            &[],
            &[],
        );
        assert_eq!(result, Err(ProgramError::Custom(6006)));
        let mut lines = vec!["Program log: AnchorError occurred. Error Code: ZMintInUse. Error Number: 6006. Error Message: zToken mint address is already in use.".to_string()];
        if keys {
            lines.extend([
                "Program log: Left:".to_string(),
                format!("Program log: {owner}"),
                "Program log: Right:".to_string(),
                format!("Program log: {}", Pubkey::default()),
            ]);
        }
        assert_eq!(take_log_lines(), lines);
        assert!(take_cpis().is_empty());
    }
}

/// The zToken instructions' data, as the SPL builders make them.
#[test]
fn z_mint_instruction_data_is_the_spl_builders() {
    let t22 = spl_token_2022::ID;
    let (z_mint, authority) = (Pubkey::new_unique(), Pubkey::new_unique());
    assert_eq!(
        lean_zmint::confidential_transfer_initialize_mint_data().to_vec(),
        confidential_transfer::instruction::initialize_mint(&t22, &z_mint, None, true, None)
            .unwrap()
            .data
    );
    assert_eq!(
        lean_zmint::token_metadata_revoke_authority_data().to_vec(),
        spl_token_metadata_interface::instruction::update_authority(
            &t22,
            &z_mint,
            &authority,
            OptionalNonZeroPubkey::default(),
        )
        .data
    );
    let mut r = Rng(10);
    for _ in 0..1_000 {
        let meta = lean_metadata::derive(
            Some(lean_metadata::BaseMetadata {
                name: &random_text(&mut r, 40),
                symbol: &random_text(&mut r, 12),
                uri: &random_text(&mut r, 220),
            }),
            &r.key(),
        );
        assert_eq!(
            lean_zmint::token_metadata_initialize_data(&meta).as_slice(),
            spl_token_metadata_interface::instruction::initialize(
                &t22,
                &z_mint,
                &authority,
                &z_mint,
                &authority,
                meta.name.as_str().into(),
                meta.symbol.as_str().into(),
                meta.uri.as_str().into(),
            )
            .data
        );
    }
    // The longest metadata fits the buffer.
    let longest = lean_metadata::derive(
        Some(lean_metadata::BaseMetadata {
            name: &"N".repeat(100),
            symbol: &"S".repeat(100),
            uri: &"u".repeat(200),
        }),
        &z_mint,
    );
    assert_eq!(
        lean_zmint::token_metadata_initialize_data(&longest)
            .as_slice()
            .len(),
        lean_zmint::TOKEN_METADATA_INITIALIZE_MAX_LEN
    );
    assert_eq!(lean_zmint::FIXED_LEN, 303);
}
