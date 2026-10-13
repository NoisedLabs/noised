//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check the program's own encoders, decoders and policy
//! against the code the Anchor build ran: Anchor's serialization and
//! discriminators, the IDL, the anchor-lang error table, Borsh, and the
//! mint policy over spl-token-2022-interface. Random inputs (malformed ones
//! included) must give the same result, or the same error. The shared
//! parsers and checks (Token-2022 parsing, transfer-hook resolution, rent,
//! the framework error table and log lines) are tested against the SPL and
//! Anchor crates in `crates/noised-onchain/tests`.

use std::collections::BTreeSet;

use anchor_lang::{
    error::ErrorCode, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    Event, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        mint_close_authority::MintCloseAuthority, transfer_fee::TransferFeeConfig,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
};
use noised_lmots::{Sha2, Sha256, ID_LEN, N};
use noised_onchain::host::fuzz::{random_mint, Rng};
use noised_vault::{
    accounts, discriminator, error, event_data, instruction,
    processor::{parse_open_vault, WithdrawArgsRef},
    state::{Payout, Vault, VaultKey},
    token, PayoutReleased, Pubkey, VaultOpened, VaultWithdrawn, WithdrawArgs, ID,
};
use solana_instruction::AccountMeta;
use solana_program_error::ProgramError;

fn sha256_8(input: &str) -> [u8; 8] {
    Sha2::hashv(&[input.as_bytes()])[..8].try_into().unwrap()
}

fn idl() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../idls/noised_vault.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read the IDL")).expect("IDL JSON")
}

fn idl_bytes(v: &serde_json::Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

// ------------------------------------------------------------------ ids

#[test]
fn program_and_well_known_ids() {
    assert_eq!(
        ID,
        anchor_lang::pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb")
    );
    assert_eq!(ID.to_string(), idl()["address"].as_str().unwrap());
    assert_eq!(token::TOKEN_PROGRAM_ID, anchor_spl::token::ID);
    assert_eq!(token::TOKEN_2022_PROGRAM_ID, anchor_spl::token_2022::ID);
    assert_eq!(
        token::ASSOCIATED_TOKEN_PROGRAM_ID,
        anchor_spl::associated_token::ID
    );
    assert_eq!(token::SYSTEM_PROGRAM_ID, anchor_lang::system_program::ID);
    assert_eq!(
        token::MEMO_PROGRAM_ID,
        anchor_lang::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    );
    assert_eq!(
        <noised_vault::program::NoisedVault as anchor_lang::Id>::id(),
        ID
    );
}

// ------------------------------------------------------- discriminators

#[test]
fn discriminators_are_anchors_and_the_idls() {
    let idl = idl();
    let cases: [(&str, [u8; 8], &[u8]); 4] = [
        (
            "open_vault",
            discriminator::OPEN_VAULT,
            instruction::OpenVault::DISCRIMINATOR,
        ),
        (
            "withdraw",
            discriminator::WITHDRAW,
            instruction::Withdraw::DISCRIMINATOR,
        ),
        (
            "release",
            discriminator::RELEASE,
            instruction::Release::DISCRIMINATOR,
        ),
        (
            "release_to",
            discriminator::RELEASE_TO,
            instruction::ReleaseTo::DISCRIMINATOR,
        ),
    ];
    for (name, disc, client) in cases {
        assert_eq!(disc, sha256_8(&format!("global:{name}")), "{name}");
        assert_eq!(client, disc, "{name}");
        let ix = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ix| ix["name"] == name)
            .unwrap();
        assert_eq!(idl_bytes(&ix["discriminator"]), disc, "{name}");
    }
    for (name, disc, anchor) in [
        ("Vault", discriminator::VAULT, Vault::DISCRIMINATOR),
        ("Payout", discriminator::PAYOUT, Payout::DISCRIMINATOR),
    ] {
        assert_eq!(disc, sha256_8(&format!("account:{name}")));
        assert_eq!(anchor, disc);
        let account = idl["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap();
        assert_eq!(idl_bytes(&account["discriminator"]), disc);
    }
    for (name, disc, anchor) in [
        (
            "VaultOpened",
            discriminator::VAULT_OPENED,
            VaultOpened::DISCRIMINATOR,
        ),
        (
            "VaultWithdrawn",
            discriminator::VAULT_WITHDRAWN,
            VaultWithdrawn::DISCRIMINATOR,
        ),
        (
            "PayoutReleased",
            discriminator::PAYOUT_RELEASED,
            PayoutReleased::DISCRIMINATOR,
        ),
    ] {
        assert_eq!(disc, sha256_8(&format!("event:{name}")));
        assert_eq!(anchor, disc);
        let event = idl["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == name)
            .unwrap();
        assert_eq!(idl_bytes(&event["discriminator"]), disc);
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
    let lists: [(&str, Vec<AccountMeta>); 4] = [
        (
            "open_vault",
            accounts::OpenVault {
                payer: k(1),
                mint: k(2),
                vault: k(3),
                vault_token_account: k(4),
                token_program: k(5),
                associated_token_program: k(6),
                system_program: k(7),
            }
            .to_account_metas(None),
        ),
        (
            "withdraw",
            accounts::Withdraw {
                payer: k(1),
                mint: k(2),
                vault: k(3),
                vault_token_account: k(4),
                payout: k(5),
                token_program: k(6),
                system_program: k(7),
            }
            .to_account_metas(None),
        ),
        (
            "release",
            accounts::Release {
                payer: k(1),
                mint: k(2),
                vault: k(3),
                vault_token_account: k(4),
                payout: k(5),
                rent_payer: k(6),
                destination_owner: k(7),
                destination: k(8),
                memo_program: k(9),
                token_program: k(10),
                associated_token_program: k(11),
                system_program: k(12),
            }
            .to_account_metas(None),
        ),
        (
            "release_to",
            accounts::ReleaseTo {
                destination_owner: k(1),
                mint: k(2),
                vault: k(3),
                vault_token_account: k(4),
                payout: k(5),
                rent_payer: k(6),
                destination: k(7),
                memo_program: k(8),
                token_program: k(9),
            }
            .to_account_metas(None),
        ),
    ];
    for (name, metas) in lists {
        let ix = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ix| ix["name"] == name)
            .unwrap();
        let expected = ix["accounts"].as_array().unwrap();
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
}

/// Byte size of an IDL type (fixed-size types; `bytes` is its 4-byte length).
fn idl_size(ty: &serde_json::Value) -> usize {
    match ty.as_str() {
        Some("u8") => 1,
        Some("u32") => 4,
        Some("u64") => 8,
        Some("pubkey") => 32,
        Some("bytes") => 4,
        _ if ty.get("array").is_some() => ty["array"][1].as_u64().unwrap() as usize,
        _ if ty["defined"]["name"] == "VaultKey" => 52,
        _ => panic!("unexpected IDL type {ty}"),
    }
}

/// The IDL's field offsets of type `name` (after `skip` leading bytes).
fn idl_layout(idl: &serde_json::Value, name: &str, skip: usize) -> Vec<(String, usize, usize)> {
    let ty = idl["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .unwrap_or_else(|| panic!("IDL type {name}"));
    let mut at = skip;
    ty["type"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let size = idl_size(&f["type"]);
            let field = (f["name"].as_str().unwrap().to_string(), at, size);
            at += size;
            field
        })
        .collect()
}

/// The hand-maintained IDL describes the program's layouts: every field of
/// the accounts, events and arguments sits where the IDL's Borsh layout puts
/// it, and nothing follows the last field.
#[test]
fn idl_types_describe_the_layouts() {
    let idl = idl();
    let mut r = Rng(8);
    let vault = random_vault(&mut r);
    let mut data = [0u8; Vault::LEN];
    vault.write(&mut data);
    let layout = idl_layout(&idl, "Vault", 8);
    assert_eq!(
        layout.last().map(|(_, at, size)| at + size),
        Some(Vault::LEN)
    );
    for (name, at, size) in &layout {
        let want: Vec<u8> = match name.as_str() {
            "version" => vec![vault.version],
            "bump" => vec![vault.bump],
            "mint" => vault.mint.to_bytes().to_vec(),
            "genesis_key_id" => vault.genesis_key_id.to_vec(),
            "sequence" => vault.sequence.to_le_bytes().to_vec(),
            "key_id" => vault.key_id.to_vec(),
            "key_ident" => vault.key_ident.to_vec(),
            "key_q" => vault.key_q.to_le_bytes().to_vec(),
            "key_k" => vault.key_k.to_vec(),
            "reserved" => vault.reserved.to_le_bytes().to_vec(),
            other => panic!("Vault.{other}"),
        };
        assert_eq!(&data[*at..at + size], &want[..], "Vault.{name}");
    }

    let payout = random_payout(&mut r);
    let mut data = [0u8; Payout::LEN];
    payout.write(&mut data);
    let layout = idl_layout(&idl, "Payout", 8);
    assert_eq!(
        layout.last().map(|(_, at, size)| at + size),
        Some(Payout::LEN)
    );
    for (name, at, size) in &layout {
        let want: Vec<u8> = match name.as_str() {
            "version" => vec![payout.version],
            "bump" => vec![payout.bump],
            "vault" => payout.vault.to_bytes().to_vec(),
            "sequence" => payout.sequence.to_le_bytes().to_vec(),
            "destination_owner" => payout.destination_owner.to_bytes().to_vec(),
            "amount" => payout.amount.to_le_bytes().to_vec(),
            "rent_payer" => payout.rent_payer.to_bytes().to_vec(),
            other => panic!("Payout.{other}"),
        };
        assert_eq!(&data[*at..at + size], &want[..], "Payout.{name}");
    }

    let (vault_key, mint, payout_key, owner, destination) =
        (r.key(), r.key(), r.key(), r.key(), r.key());
    let (sequence, amount, key_id) = (r.next(), r.next(), r.array::<32>());
    let events: [(&str, Vec<u8>); 3] = [
        (
            "VaultOpened",
            event_data::vault_opened(&vault_key, &mint, &key_id).to_vec(),
        ),
        (
            "VaultWithdrawn",
            event_data::vault_withdrawn(
                &vault_key,
                &mint,
                sequence,
                &owner,
                amount,
                &payout_key,
                &key_id,
            )
            .to_vec(),
        ),
        (
            "PayoutReleased",
            event_data::payout_released(
                &vault_key,
                &payout_key,
                sequence,
                &owner,
                &destination,
                amount,
            )
            .to_vec(),
        ),
    ];
    for (event, data) in events {
        let layout = idl_layout(&idl, event, 8);
        assert_eq!(
            layout.last().map(|(_, at, size)| at + size),
            Some(data.len()),
            "{event}"
        );
        for (name, at, size) in &layout {
            let want: Vec<u8> = match name.as_str() {
                "vault" => vault_key.to_bytes().to_vec(),
                "mint" => mint.to_bytes().to_vec(),
                "key_id" | "next_key_id" => key_id.to_vec(),
                "sequence" => sequence.to_le_bytes().to_vec(),
                "destination_owner" => owner.to_bytes().to_vec(),
                "amount" => amount.to_le_bytes().to_vec(),
                "payout" => payout_key.to_bytes().to_vec(),
                "destination" => destination.to_bytes().to_vec(),
                other => panic!("{event}.{other}"),
            };
            assert_eq!(&data[*at..at + size], &want[..], "{event}.{name}");
        }
    }

    // withdraw(args: WithdrawArgs) with a 2176-byte signature, and VaultKey.
    let key = random_vault_key(&mut r);
    let args = WithdrawArgs {
        signature: r.bytes(2176),
        destination_owner: r.key(),
        max_amount: r.next(),
        next_key_id: r.array(),
        next_key: key,
    };
    let data = instruction::Withdraw { args: args.clone() }.data();
    let layout = idl_layout(&idl, "WithdrawArgs", 8);
    let (name, at, _) = &layout[0];
    assert_eq!((name.as_str(), *at), ("signature", 8));
    assert_eq!(&data[8..12], &2176u32.to_le_bytes());
    let parsed = WithdrawArgsRef::parse(&data[8..]).unwrap();
    assert_eq!(parsed.signature, &args.signature[..]);
    for (name, at, size) in &layout[1..] {
        // After the signature's bytes.
        let at = at + 2176;
        let want: Vec<u8> = match name.as_str() {
            "destination_owner" => args.destination_owner.to_bytes().to_vec(),
            "max_amount" => args.max_amount.to_le_bytes().to_vec(),
            "next_key_id" => args.next_key_id.to_vec(),
            "next_key" => [&key.id[..], &key.q.to_le_bytes(), &key.k].concat(),
            other => panic!("WithdrawArgs.{other}"),
        };
        assert_eq!(&data[at..at + size], &want[..], "WithdrawArgs.{name}");
    }
    let key_layout = idl_layout(&idl, "VaultKey", 0);
    assert_eq!(
        key_layout
            .iter()
            .map(|(n, at, size)| (n.as_str(), *at, *size))
            .collect::<Vec<_>>(),
        [("id", 0, 16), ("q", 16, 4), ("k", 20, 32)]
    );
    assert_eq!(VaultKey::LEN, 52);
}
// ----------------------------------------------------- argument layouts

fn random_vault_key(r: &mut Rng) -> VaultKey {
    VaultKey {
        id: r.array(),
        q: r.next() as u32,
        k: r.array(),
    }
}

/// The program's decoders read Borsh as Anchor's dispatcher did
/// (`deserialize` from the data after the discriminator: trailing bytes are
/// ignored, a short input fails), on valid, truncated, extended and random
/// data.
#[test]
fn argument_decoding_matches_borsh() {
    let mut r = Rng(1);
    for round in 0..20_000 {
        let key = random_vault_key(&mut r);
        let args = WithdrawArgs {
            signature: {
                let len = r.pick(&[0usize, 1, 2175, 2176, 2177, 300]);
                r.bytes(len)
            },
            destination_owner: r.key(),
            max_amount: r.next(),
            next_key_id: r.array(),
            next_key: key,
        };
        let mut data = instruction::Withdraw { args }.data()[8..].to_vec();
        match r.below(6) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(40)),
            2 => data[..4].copy_from_slice(&(r.next() as u32 % 5000).to_le_bytes()),
            3 => data = r.some_bytes(3000),
            _ => {}
        }
        let borsh = WithdrawArgs::deserialize(&mut &data[..]).ok();
        let ours = WithdrawArgsRef::parse(&data);
        assert_eq!(borsh.is_some(), ours.is_some(), "round {round}");
        if let (Some(b), Some(o)) = (borsh, ours) {
            assert_eq!(b.signature, o.signature);
            assert_eq!(b.destination_owner, o.destination_owner);
            assert_eq!(b.max_amount, o.max_amount);
            assert_eq!(b.next_key_id, o.next_key_id);
            assert_eq!(b.next_key, o.next_key);
        }

        let open = instruction::OpenVault {
            key_id_arg: r.array(),
            key: random_vault_key(&mut r),
        };
        let mut data = open.data()[8..].to_vec();
        match r.below(3) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(10)),
            _ => {}
        }
        let borsh = <([u8; 32], VaultKey)>::deserialize(&mut &data[..]).ok();
        assert_eq!(borsh, parse_open_vault(&data), "round {round}");
    }
}

// ------------------------------------------------------ account layouts

fn random_vault(r: &mut Rng) -> Vault {
    Vault {
        version: r.byte(),
        bump: r.byte(),
        mint: r.key(),
        genesis_key_id: r.array(),
        sequence: r.next(),
        key_id: r.array(),
        key_ident: r.array::<ID_LEN>(),
        key_q: r.next() as u32,
        key_k: r.array::<N>(),
        reserved: r.next(),
    }
}

fn random_payout(r: &mut Rng) -> Payout {
    Payout {
        version: r.byte(),
        bump: r.byte(),
        vault: r.key(),
        sequence: r.next(),
        destination_owner: r.key(),
        amount: r.next(),
        rent_payer: r.key(),
    }
}

/// `Vault` and `Payout` are written and read exactly as Anchor's
/// `#[account]` serialization: accounts written by either build read the
/// same in the other.
#[test]
fn account_layouts_match_anchor() {
    assert_eq!(Vault::LEN, 8 + Vault::INIT_SPACE);
    assert_eq!(Payout::LEN, 8 + Payout::INIT_SPACE);
    assert_eq!((Vault::LEN, Payout::LEN), (174, 122));
    let mut r = Rng(2);
    for _ in 0..2_000 {
        let vault = random_vault(&mut r);
        let mut anchor = Vec::new();
        vault.try_serialize(&mut anchor).unwrap();
        let mut ours = [0u8; Vault::LEN];
        vault.write(&mut ours);
        assert_eq!(anchor, ours);
        assert_eq!(Vault::read(&ours), vault);
        let mut longer = anchor.clone();
        longer.extend(r.bytes(9));
        assert_eq!(
            Vault::try_deserialize(&mut &longer[..]).unwrap(),
            Vault::read(longer[..Vault::LEN].try_into().unwrap())
        );

        let payout = random_payout(&mut r);
        let mut anchor = Vec::new();
        payout.try_serialize(&mut anchor).unwrap();
        let mut ours = [0u8; Payout::LEN];
        payout.write(&mut ours);
        assert_eq!(anchor, ours);
        assert_eq!(Payout::read(&ours), payout);
    }
}

/// The events are Anchor's `emit!` payloads: discriminator, then Borsh.
#[test]
fn events_match_anchor() {
    let mut r = Rng(3);
    for _ in 0..2_000 {
        let opened = VaultOpened {
            vault: r.key(),
            mint: r.key(),
            key_id: r.array(),
        };
        assert_eq!(opened.data(), opened.log_data());
        let withdrawn = VaultWithdrawn {
            vault: r.key(),
            mint: r.key(),
            sequence: r.next(),
            destination_owner: r.key(),
            amount: r.next(),
            payout: r.key(),
            next_key_id: r.array(),
        };
        assert_eq!(withdrawn.data(), withdrawn.log_data());
        let released = PayoutReleased {
            vault: r.key(),
            payout: r.key(),
            sequence: r.next(),
            destination_owner: r.key(),
            destination: r.key(),
            amount: r.next(),
        };
        assert_eq!(released.data(), released.log_data());
    }
    assert_eq!(event_data::VAULT_WITHDRAWN_LEN, 184);
}

// --------------------------------------------------------------- errors

/// The program's numbers, names and messages are the IDL's (VaultError)
/// and anchor-lang 1.2.1's (framework errors), and no other number is
/// logged.
#[test]
fn error_table_matches_anchor_and_the_idl() {
    use error::VaultError::*;
    for (e, n) in [
        (KeyIdMismatch, 6000),
        (InvalidSignature, 6001),
        (InvalidNextKey, 6002),
        (UnsupportedMint, 6003),
        (InvalidDestination, 6004),
        (MathOverflow, 6005),
        (InvalidKeyIndex, 6006),
    ] {
        assert_eq!(u32::from(e), n);
        assert_eq!(e as u32 + 6000, n);
        assert_eq!(e.name(), format!("{e:?}"));
    }
    let idl_errors = idl()["errors"].as_array().unwrap().clone();
    assert_eq!(idl_errors.len(), 7);
    for e in &idl_errors {
        let code = e["code"].as_u64().unwrap() as u32;
        assert_eq!(
            error::name_and_message(code),
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
        ErrorCode::ConstraintAssociated,
        ErrorCode::ConstraintClose,
        ErrorCode::ConstraintAddress,
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
            error::name_and_message(code),
            (e.name().as_str(), e.to_string().as_str()),
            "{e:?}"
        );
    }
    codes.extend(
        idl_errors
            .iter()
            .map(|e| e["code"].as_u64().unwrap() as u32),
    );
    let table: BTreeSet<u32> = error::numbers().collect();
    assert_eq!(table, codes);
    for code in error::numbers() {
        assert_eq!(error::describe(code)[1], code.to_string().as_bytes());
    }
    assert_eq!(error::describe(1), [b"" as &[u8]; 3]);
    {
        use error::anchor::*;
        for (ours, theirs) in [
            (CONSTRAINT_SEEDS, ErrorCode::ConstraintSeeds),
            (ACCOUNT_NOT_INITIALIZED, ErrorCode::AccountNotInitialized),
            (
                CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
                ErrorCode::ConstraintDuplicateMutableAccount,
            ),
            (ACCOUNT_NOT_ENOUGH_KEYS, ErrorCode::AccountNotEnoughKeys),
        ] {
            assert_eq!(ours, u32::from(theirs));
        }
    }
}

// ------------------------------------------------------- token accounts

/// The Anchor build's `require_supported_mint` (after the mint
/// deserialized), with spl-token-2022-interface.
fn anchor_mint_supported(data: &[u8]) -> Result<bool, ProgramError> {
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(data)?;
    for extension in state.get_extension_types()? {
        match extension {
            ExtensionType::NonTransferable | ExtensionType::PermanentDelegate => return Ok(false),
            ExtensionType::MintCloseAuthority => {
                let config = state.get_extension::<MintCloseAuthority>()?;
                if Option::<Pubkey>::from(config.close_authority).is_some() {
                    return Ok(false);
                }
            }
            ExtensionType::TransferFeeConfig => {
                let config = state.get_extension::<TransferFeeConfig>()?;
                if Option::<Pubkey>::from(config.transfer_fee_config_authority).is_some()
                    || Option::<Pubkey>::from(config.withdraw_withheld_authority).is_some()
                {
                    return Ok(false);
                }
            }
            _ => {}
        }
    }
    Ok(true)
}

/// The mint policy (`open_vault` refuses `UnsupportedMint`) is the Anchor
/// build's `require_supported_mint` over spl-token-2022-interface, error
/// for error, on random mints (malformed ones included).
#[test]
fn mint_policy_matches_the_anchor_build() {
    let mut r = Rng(5);
    let (mut parsed, mut refused) = (0, 0);
    for round in 0..200_000 {
        let data = random_mint(&mut r);
        let Ok(mint) = noised_onchain::token::unpack_mint(&data) else {
            continue;
        };
        parsed += 1;
        let policy = token::mint_is_supported(mint.tlv);
        assert_eq!(policy, anchor_mint_supported(&data), "round {round}");
        refused += usize::from(policy == Ok(false));
    }
    assert!(parsed > 10_000 && refused > 1_000, "{parsed} {refused}");
}
