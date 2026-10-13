//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check every hand-written encoder, decoder and parser of
//! the program against the code the Anchor build ran: Anchor's own
//! serialization and discriminators, the IDL, the anchor-lang error table,
//! spl-token-2022-interface's account parsing, spl-tlv-account-resolution's
//! extra-account resolution, Borsh, and solana-rent's rent computation.
//! Random inputs (malformed ones included) must give the same result, or
//! the same error.

use std::{
    collections::BTreeSet,
    panic::{catch_unwind, AssertUnwindSafe},
};

use anchor_lang::{
    error::ErrorCode, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    Event, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    error::TokenError,
    extension::{
        memo_transfer::MemoTransfer, mint_close_authority::MintCloseAuthority,
        transfer_fee::TransferFeeConfig, transfer_hook, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
};
use noised_lmots::{Sha2, Sha256, ID_LEN, N};
use noised_vault::{
    accounts, discriminator, error, event_data, hook, instruction,
    processor::{parse_open_vault, WithdrawArgsRef},
    state::{Payout, Vault, VaultKey},
    sys::Rent,
    token, PayoutReleased, Pubkey, VaultOpened, VaultWithdrawn, WithdrawArgs, ID,
};
use solana_account_info::AccountInfo;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

/// Deterministic pseudo-random stream.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 ^ (self.0 >> 29)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn byte(&mut self) -> u8 {
        self.next() as u8
    }
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.byte()).collect()
    }
    /// Fewer than `max` random bytes.
    fn some_bytes(&mut self, max: u64) -> Vec<u8> {
        let len = self.below(max) as usize;
        self.bytes(len)
    }
    fn array<const L: usize>(&mut self) -> [u8; L] {
        std::array::from_fn(|_| self.byte())
    }
    fn key(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.array())
    }
    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

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
    assert_eq!(
        hook::EXECUTE_DISCRIMINATOR,
        sha256_8("spl-transfer-hook-interface:execute")
    );
    assert_eq!(
        &hook::EXECUTE_DISCRIMINATOR[..],
        <ExecuteInstruction as spl_discriminator::SplDiscriminate>::SPL_DISCRIMINATOR_SLICE
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

/// The other programs' error numbers the vault returns as they are.
#[test]
fn spl_error_numbers() {
    use spl_tlv_account_resolution::error::AccountResolutionError as R;
    assert_eq!(
        token::EXTENSION_NOT_FOUND,
        TokenError::ExtensionNotFound as u32
    );
    assert_eq!(
        hook::HOOK_INCORRECT_ACCOUNT,
        spl_transfer_hook_interface::error::TransferHookError::IncorrectAccount as u32
    );
    for (ours, theirs) in [
        (hook::RESOLUTION_INCORRECT_ACCOUNT, R::IncorrectAccount),
        (
            hook::RESOLUTION_INVALID_BYTES_FOR_SEED,
            R::InvalidBytesForSeed,
        ),
        (
            hook::RESOLUTION_INSTRUCTION_DATA_TOO_SMALL,
            R::InstructionDataTooSmall,
        ),
        (hook::RESOLUTION_ACCOUNT_NOT_FOUND, R::AccountNotFound),
        (
            hook::RESOLUTION_ACCOUNT_DATA_TOO_SMALL,
            R::AccountDataTooSmall,
        ),
    ] {
        assert_eq!(ours, theirs as u32);
    }
    assert_eq!(
        ProgramError::Custom(hook::TLV_TYPE_NOT_FOUND),
        spl_type_length_value::error::TlvError::TypeNotFound.into()
    );
    assert_eq!(
        ProgramError::Custom(hook::POD_BUFFER_TOO_SMALL),
        spl_pod::error::PodSliceError::BufferTooSmall.into()
    );
}

// ----------------------------------------------------------------- rent

/// solana-rent 3.1 (what the Anchor build linked) for the thresholds before
/// and after SIMD-0194 and any other value.
#[test]
fn rent_matches_solana_rent() {
    let mut r = Rng(4);
    for i in 0..50_000 {
        let lamports_per_byte_year = match i % 4 {
            0 => 3480,
            1 => 6960,
            2 => r.below(1 << 20),
            _ => r.below(1 << 40),
        };
        let threshold = match i % 5 {
            0 => 2.0,
            1 => 1.0,
            2 => 1.5,
            3 => f64::from_bits(r.next() >> 2),
            _ => r.below(1000) as f64 / 7.0,
        };
        let len = r.below(1 << 14) as usize;
        #[allow(deprecated)]
        let theirs = solana_rent::Rent {
            lamports_per_byte_year,
            exemption_threshold: threshold,
            burn_percent: 50,
        };
        let ours = Rent::new(lamports_per_byte_year, threshold);
        assert_eq!(
            ours.minimum_balance(len),
            theirs.minimum_balance(len),
            "{lamports_per_byte_year} {threshold} {len}"
        );
        let lamports = r.below(1 << 50);
        assert_eq!(
            ours.is_exempt(lamports, len),
            theirs.is_exempt(lamports, len)
        );
    }
    // Products past 2^53 take the float path, as before.
    let big = Rent::new(u64::MAX / (1 << 12), 2.0);
    #[allow(deprecated)]
    let theirs = solana_rent::Rent {
        lamports_per_byte_year: u64::MAX / (1 << 12),
        exemption_threshold: 2.0,
        burn_percent: 50,
    };
    assert_eq!(big.minimum_balance(0), theirs.minimum_balance(0));
}

// ------------------------------------------------------- token accounts

const KNOWN_TYPES: u16 = token::EXTENSION_TYPE_MAX;

/// A TLV area: random entries (known and unknown types, right and wrong
/// lengths), sometimes followed by zero padding or junk.
fn random_tlv(r: &mut Rng, for_mint: bool) -> Vec<u8> {
    let mut tlv = Vec::new();
    for _ in 0..r.below(6) {
        let (ty, len): (u16, usize) = match r.below(10) {
            0 => (token::EXT_MINT_CLOSE_AUTHORITY, 32),
            1 => (token::EXT_TRANSFER_FEE_CONFIG, 108),
            2 => (token::EXT_TRANSFER_HOOK, 64),
            3 => (token::EXT_MEMO_TRANSFER, 1),
            4 => (
                r.pick(&[token::EXT_NON_TRANSFERABLE, token::EXT_PERMANENT_DELEGATE]),
                r.pick(&[0, 32]),
            ),
            5 => (
                r.below(u64::from(KNOWN_TYPES) + 1) as u16,
                r.below(80) as usize,
            ),
            6 => (r.below(40) as u16, r.below(40) as usize),
            7 => (
                r.pick(&[
                    token::EXT_MINT_CLOSE_AUTHORITY,
                    token::EXT_TRANSFER_HOOK,
                    token::EXT_MEMO_TRANSFER,
                ]),
                r.below(70) as usize,
            ),
            _ => (if for_mint { 18 } else { 7 }, r.below(50) as usize),
        };
        tlv.extend_from_slice(&ty.to_le_bytes());
        tlv.extend_from_slice(&(len as u16).to_le_bytes());
        let mut value = r.bytes(len);
        // Authorities are often absent (all zero).
        if r.chance(50) {
            for b in value.iter_mut().take(64) {
                *b = 0;
            }
        }
        tlv.extend(value);
    }
    match r.below(6) {
        0 => tlv.extend(vec![0; r.below(6) as usize]),
        1 => tlv.extend(r.some_bytes(5)),
        2 => {
            // A declared length past the end.
            tlv.extend_from_slice(&(r.below(28) as u16).to_le_bytes());
            tlv.extend_from_slice(&(r.below(500) as u16).to_le_bytes());
        }
        _ => {}
    }
    tlv
}

fn coption(r: &mut Rng) -> [u8; 4] {
    match r.below(10) {
        0 => [r.byte(), r.byte(), 0, 0],
        1..=5 => [0, 0, 0, 0],
        _ => [1, 0, 0, 0],
    }
}

fn random_mint(r: &mut Rng) -> Vec<u8> {
    let mut data = r.bytes(82);
    data[0..4].copy_from_slice(&coption(r));
    data[45] = r.pick(&[0, 1, 1, 1, 1, 2]);
    data[46..50].copy_from_slice(&coption(r));
    match r.below(8) {
        0 => {}
        1 => data.truncate(r.below(83) as usize),
        2 => data.extend(r.some_bytes(120)),
        3 => data.resize(355, 0),
        _ => {
            let mut rest = vec![0u8; 83];
            if r.chance(5) {
                rest[r.below(83) as usize] = 1;
            }
            data.extend(rest);
            data.push(r.pick(&[1, 1, 1, 0, 2, 3]));
            data.extend(random_tlv(r, true));
        }
    }
    data
}

fn random_token_account(r: &mut Rng) -> Vec<u8> {
    let mut data = r.bytes(165);
    data[72..76].copy_from_slice(&coption(r));
    data[108] = r.pick(&[0, 1, 1, 1, 2, 3]);
    data[109..113].copy_from_slice(&coption(r));
    data[129..133].copy_from_slice(&coption(r));
    match r.below(8) {
        0 => {}
        1 => data.truncate(r.below(166) as usize),
        2 => data.resize(355, 0),
        _ => {
            data.push(r.pick(&[2, 2, 2, 1, 0, 9]));
            data.extend(random_tlv(r, false));
        }
    }
    data
}

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

/// Mint and token account parsing, the mint policy, the hook program and
/// the memo requirement are spl-token-2022-interface's, error for error.
#[test]
fn token_parsing_matches_spl_token_2022() {
    let mut r = Rng(5);
    let (mut mints_ok, mut accounts_ok, mut refused, mut hooks, mut memos) = (0, 0, 0, 0, 0);
    for round in 0..200_000 {
        let data = random_mint(&mut r);
        let theirs = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data);
        let ours = token::unpack_mint(&data);
        match (&theirs, &ours) {
            (Ok(t), Ok(o)) => {
                mints_ok += 1;
                assert_eq!(t.base.decimals, o.decimals, "round {round}");
                // Extension types: all parse, or the same error.
                let mut types = Vec::new();
                let walked = token::for_each_extension_type(o.tlv, |ty| {
                    types.push(ty);
                    Ok(())
                });
                match t.get_extension_types() {
                    Ok(expected) => {
                        assert_eq!(walked, Ok(()), "round {round}");
                        let expected: Vec<u16> = expected.into_iter().map(u16::from).collect();
                        assert_eq!(types, expected, "round {round}");
                    }
                    Err(e) => assert_eq!(walked, Err(e), "round {round}"),
                }
                let policy = token::mint_is_supported(o.tlv);
                assert_eq!(policy, anchor_mint_supported(&data), "round {round}");
                if policy == Ok(false) {
                    refused += 1;
                }
                let hook = token::hook_program_id(o.tlv);
                assert_eq!(hook, transfer_hook::get_program_id(t), "round {round}");
                hooks += usize::from(hook.is_some());
                for (ty, len) in [
                    (
                        token::EXT_MINT_CLOSE_AUTHORITY,
                        token::MINT_CLOSE_AUTHORITY_LEN,
                    ),
                    (
                        token::EXT_TRANSFER_FEE_CONFIG,
                        token::TRANSFER_FEE_CONFIG_LEN,
                    ),
                    (token::EXT_TRANSFER_HOOK, token::TRANSFER_HOOK_LEN),
                ] {
                    let theirs = match ty {
                        token::EXT_MINT_CLOSE_AUTHORITY => t
                            .get_extension::<MintCloseAuthority>()
                            .map(bytemuck::bytes_of),
                        token::EXT_TRANSFER_FEE_CONFIG => t
                            .get_extension::<TransferFeeConfig>()
                            .map(bytemuck::bytes_of),
                        _ => t
                            .get_extension::<transfer_hook::TransferHook>()
                            .map(bytemuck::bytes_of),
                    };
                    assert_eq!(
                        token::get_extension(o.tlv, ty, len),
                        theirs,
                        "round {round}"
                    );
                }
            }
            (Err(t), Err(o)) => assert_eq!(t, o, "round {round}"),
            _ => panic!("round {round}: {:?} vs {:?}", theirs.is_ok(), ours.is_ok()),
        }

        let data = random_token_account(&mut r);
        let theirs = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data);
        let ours = token::unpack_token_account(&data);
        match (&theirs, &ours) {
            (Ok(t), Ok(o)) => {
                accounts_ok += 1;
                assert_eq!(
                    (t.base.mint, t.base.owner, t.base.amount),
                    (o.mint, o.owner, o.amount),
                    "round {round}"
                );
                let memo = token::requires_memo(o.tlv);
                assert_eq!(
                    memo,
                    t.get_extension::<MemoTransfer>()
                        .map(|m| bool::from(m.require_incoming_transfer_memos))
                        .unwrap_or(false),
                    "round {round}"
                );
                memos += usize::from(memo);
                assert_eq!(
                    token::get_extension(o.tlv, token::EXT_MEMO_TRANSFER, token::MEMO_TRANSFER_LEN),
                    t.get_extension::<MemoTransfer>().map(bytemuck::bytes_of),
                    "round {round}"
                );
            }
            (Err(t), Err(o)) => assert_eq!(t, o, "round {round}"),
            _ => panic!("round {round}: {:?} vs {:?}", theirs.is_ok(), ours.is_ok()),
        }
    }
    // The random inputs reach every outcome.
    assert!(
        mints_ok > 10_000 && accounts_ok > 10_000,
        "{mints_ok} {accounts_ok}"
    );
    assert!(
        refused > 1_000 && hooks > 100 && memos > 100,
        "{refused} {hooks} {memos}"
    );
}

// ------------------------------------------------------ transfer hooks

/// A host account for the program's resolver.
struct TestAccount {
    key: Pubkey,
    data: Vec<u8>,
    is_signer: bool,
    is_writable: bool,
}

impl hook::HookAccount for TestAccount {
    fn key(&self) -> &Pubkey {
        &self.key
    }
    fn data(&self) -> &[u8] {
        &self.data
    }
}

/// A random seed config (sometimes malformed) packed into 32 bytes.
fn random_address_config(r: &mut Rng, accounts: usize) -> [u8; 32] {
    let mut config = [0u8; 32];
    if r.chance(10) {
        return r.array();
    }
    let mut i = 0;
    for _ in 0..r.below(5) {
        let seed: Vec<u8> = match r.below(9) {
            0 | 1 => {
                let len = r.below(12) as usize;
                let mut s = vec![1, len as u8];
                s.extend(r.bytes(len));
                s
            }
            2 | 3 => vec![2, r.below(18) as u8, r.below(10) as u8],
            4 | 5 => vec![3, r.below(accounts as u64 + 2) as u8],
            6 | 7 => vec![
                4,
                r.below(accounts as u64 + 2) as u8,
                r.below(40) as u8,
                r.pick(&[0, 8, 32, 33]),
            ],
            _ => vec![r.below(7) as u8, r.byte(), r.byte()],
        };
        if i + seed.len() > 32 {
            break;
        }
        config[i..i + seed.len()].copy_from_slice(&seed);
        i += seed.len();
    }
    config
}

fn random_extra_meta(r: &mut Rng, accounts: usize, known: &[Pubkey]) -> [u8; 35] {
    let mut meta = [0u8; 35];
    let discriminator = match r.below(12) {
        0..=3 => 0,
        4..=7 => 1,
        8 => 2,
        9 => 128 + r.below(accounts as u64 + 1) as u8,
        10 => r.pick(&[3, 5, 127, 255]),
        _ => 129,
    };
    meta[0] = discriminator;
    let config = match discriminator {
        0 => {
            if r.chance(70) && !known.is_empty() {
                known[r.below(known.len() as u64) as usize].to_bytes()
            } else {
                r.array()
            }
        }
        2 => {
            let mut c = [0u8; 32];
            match r.below(4) {
                0 => c[..2].copy_from_slice(&[1, r.below(20) as u8]),
                1 => c[..3].copy_from_slice(&[
                    2,
                    r.below(accounts as u64 + 2) as u8,
                    r.below(40) as u8,
                ]),
                2 => c[0] = r.pick(&[0, 3, 9]),
                _ => c = r.array(),
            }
            c
        }
        _ => random_address_config(r, accounts),
    };
    meta[1..33].copy_from_slice(&config);
    meta[33] = r.pick(&[0, 1, 1, 2]);
    meta[34] = r.pick(&[0, 1, 1, 7]);
    meta
}

/// The validation account data: TLV entries around the Execute entry, its
/// list of metas (sometimes malformed).
fn validation_data(r: &mut Rng, metas: &[[u8; 35]]) -> Vec<u8> {
    let mut list = Vec::new();
    let count = if r.chance(5) {
        metas.len() as u32 + r.below(3) as u32
    } else {
        metas.len() as u32
    };
    list.extend_from_slice(&count.to_le_bytes());
    for m in metas {
        list.extend_from_slice(m);
    }
    if r.chance(3) {
        list.push(0);
    }
    if r.chance(2) {
        list.truncate(r.below(4) as usize);
    }
    let mut data = Vec::new();
    if r.chance(15) {
        // An entry of another type first.
        data.extend_from_slice(&r.array::<8>());
        let len = r.below(10) as u32;
        data.extend_from_slice(&len.to_le_bytes());
        data.extend(r.bytes(len as usize));
    }
    let mut tag = hook::EXECUTE_DISCRIMINATOR;
    if r.chance(3) {
        tag = [0; 8];
    } else if r.chance(2) {
        tag[0] ^= 1;
    }
    data.extend_from_slice(&tag);
    let mut len = list.len() as u32;
    if r.chance(3) {
        len += r.below(5) as u32;
    }
    data.extend_from_slice(&len.to_le_bytes());
    data.extend(list);
    match r.below(10) {
        0 => data.extend(vec![0; r.below(9) as usize]),
        1 => data.extend(r.some_bytes(9)),
        _ => {}
    }
    data
}

/// What a resolution run gives: the accounts with their flags, an error,
/// or a panic (no viable PDA, or invalid seeds).
#[derive(Debug, PartialEq)]
enum Outcome {
    Accounts(Vec<(Pubkey, bool, bool)>),
    Error(ProgramError),
    Panic,
}

fn run_spl(
    program_id: &Pubkey,
    base: &[TestAccount; 4],
    extra: &[TestAccount],
    amount: u64,
) -> Outcome {
    let owner = Pubkey::new_from_array([9; 32]);
    let mut lamports: Vec<u64> = vec![0; 4 + extra.len()];
    let mut datas: Vec<Vec<u8>> = base.iter().chain(extra).map(|a| a.data.clone()).collect();
    let all: Vec<&TestAccount> = base.iter().chain(extra).collect();
    let mut infos = Vec::new();
    for ((account, lamports), data) in all.iter().zip(lamports.iter_mut()).zip(datas.iter_mut()) {
        infos.push(AccountInfo::new(
            &account.key,
            account.is_signer,
            account.is_writable,
            lamports,
            data,
            &owner,
            false,
        ));
    }
    let (base_infos, extra_infos) = infos.split_at(4);
    let mut cpi = Instruction::new_with_bytes(
        token::TOKEN_2022_PROGRAM_ID,
        &[],
        vec![
            AccountMeta::new(base[0].key, false),
            AccountMeta::new_readonly(base[1].key, false),
            AccountMeta::new(base[2].key, false),
            AccountMeta::new_readonly(base[3].key, true),
        ],
    );
    let mut cpi_infos = base_infos.to_vec();
    let result = catch_unwind(AssertUnwindSafe(|| {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut cpi,
            &mut cpi_infos,
            program_id,
            base_infos[0].clone(),
            base_infos[1].clone(),
            base_infos[2].clone(),
            base_infos[3].clone(),
            amount,
            extra_infos,
        )
    }));
    match result {
        Err(_) => Outcome::Panic,
        Ok(Err(e)) => Outcome::Error(e),
        Ok(Ok(())) => {
            assert_eq!(cpi.accounts.len(), cpi_infos.len());
            for (meta, info) in cpi.accounts.iter().zip(&cpi_infos) {
                assert_eq!(meta.pubkey, *info.key);
            }
            Outcome::Accounts(
                cpi.accounts
                    .iter()
                    .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                    .collect(),
            )
        }
    }
}

fn run_ours(
    program_id: &Pubkey,
    base: &[TestAccount; 4],
    extra: &[TestAccount],
    amount: u64,
) -> Outcome {
    let mut entries: Vec<hook::Entry<TestAccount>> = vec![
        hook::Entry::new(&base[0], false, true),
        hook::Entry::new(&base[1], false, false),
        hook::Entry::new(&base[2], false, true),
        hook::Entry::new(&base[3], true, false),
    ];
    let result = catch_unwind(AssertUnwindSafe(|| {
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            program_id,
            &base[0],
            &base[1],
            &base[2],
            &base[3],
            amount,
            extra,
        )
    }));
    match result {
        Err(_) => Outcome::Panic,
        Ok(Err(e)) => Outcome::Error(e),
        Ok(Ok(())) => Outcome::Accounts(
            entries
                .iter()
                .map(|e| (e.account.key, e.is_signer, e.is_writable))
                .collect(),
        ),
    }
}

/// The transfer-hook accounts the vault adds to its `transfer_checked` are
/// exactly spl-transfer-hook-interface's (`add_extra_accounts_for_execute_cpi`
/// with spl-tlv-account-resolution 0.11.1): the same accounts, order and
/// flags, or the same error, for random validation data, seed configs and
/// account sets.
#[test]
fn hook_accounts_match_spl_transfer_hook_interface() {
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut r = Rng(6);
    let mut tally = std::collections::BTreeMap::<&str, usize>::new();
    for round in 0..20_000 {
        let program_id = r.key();
        let account = |r: &mut Rng, signer: bool, writable: bool| TestAccount {
            key: r.key(),
            data: r.some_bytes(80),
            is_signer: signer,
            is_writable: writable,
        };
        let base = [
            account(&mut r, false, true),
            account(&mut r, false, false),
            account(&mut r, false, true),
            account(&mut r, true, false),
        ];
        let amount = r.next();
        let validation_key = hook::extra_account_metas_address(&base[1].key, &program_id);
        let known: Vec<Pubkey> = base
            .iter()
            .map(|a| a.key)
            .chain([program_id, validation_key])
            .collect();
        let metas: Vec<[u8; 35]> = (0..r.below(6))
            .map(|i| random_extra_meta(&mut r, 5 + i as usize, &known))
            .collect();

        let mut extra = Vec::new();
        if r.chance(92) {
            extra.push(TestAccount {
                key: program_id,
                data: vec![],
                is_signer: false,
                is_writable: false,
            });
        }
        if r.chance(92) {
            extra.push(TestAccount {
                key: validation_key,
                data: validation_data(&mut r, &metas),
                is_signer: false,
                is_writable: r.chance(50),
            });
        }
        // Accounts the metas resolve to (usually present), found by running
        // the SPL resolver step by step.
        let mut seen: Vec<(Pubkey, Vec<u8>)> = base
            .iter()
            .map(|a| (a.key, a.data.clone()))
            .chain(
                extra
                    .iter()
                    .filter(|a| a.key == validation_key)
                    .map(|a| (a.key, a.data.clone())),
            )
            .collect();
        let mut execute_data = hook::EXECUTE_DISCRIMINATOR.to_vec();
        execute_data.extend_from_slice(&amount.to_le_bytes());
        for meta in &metas {
            let meta: &ExtraAccountMeta = bytemuck::from_bytes(meta);
            let resolved = catch_unwind(AssertUnwindSafe(|| {
                meta.resolve(&execute_data, &program_id, |i| {
                    seen.get(i).map(|(k, d)| (k, Some(d.as_slice())))
                })
            }));
            let Ok(Ok(resolved)) = resolved else { break };
            let data = r.some_bytes(60);
            if r.chance(90) && !extra.iter().any(|a| a.key == resolved.pubkey) {
                extra.push(TestAccount {
                    key: resolved.pubkey,
                    data: data.clone(),
                    is_signer: r.chance(30),
                    is_writable: r.chance(50),
                });
            }
            let data = extra
                .iter()
                .chain(base.iter())
                .find(|a| a.key == resolved.pubkey)
                .map(|a| a.data.clone())
                .unwrap_or(data);
            seen.push((resolved.pubkey, data));
        }
        for _ in 0..r.below(3) {
            let (signer, writable) = (r.chance(20), r.chance(50));
            extra.push(account(&mut r, signer, writable));
        }
        if r.chance(20) {
            // A base account among the extras too.
            let i = r.below(4) as usize;
            extra.push(TestAccount {
                key: base[i].key,
                data: base[i].data.clone(),
                is_signer: base[i].is_signer,
                is_writable: base[i].is_writable,
            });
        }
        // Shuffle.
        for i in (1..extra.len()).rev() {
            let j = r.below(i as u64 + 1) as usize;
            extra.swap(i, j);
        }

        let theirs = run_spl(&program_id, &base, &extra, amount);
        let ours = run_ours(&program_id, &base, &extra, amount);
        assert_eq!(ours, theirs, "round {round}");
        let label = match &theirs {
            Outcome::Accounts(a) if a.len() > 6 => "resolved extra accounts",
            Outcome::Accounts(_) => "program only / no extras",
            Outcome::Error(_) => "error",
            Outcome::Panic => "panic",
        };
        *tally.entry(label).or_default() += 1;
    }
    std::panic::set_hook(quiet);
    println!("{tally:?}");
    for label in [
        "resolved extra accounts",
        "program only / no extras",
        "error",
    ] {
        assert!(tally.get(label).copied().unwrap_or(0) > 100, "{tally:?}");
    }
}

/// The validation account's TLV area and list, alone: the Execute entry is
/// spl-type-length-value's `get_first_bytes` (after `unpack`), the list
/// spl-pod's `ListView` unpack.
#[test]
fn validation_tlv_matches_spl_type_length_value() {
    use spl_type_length_value::state::{TlvState, TlvStateBorrowed};
    let mut r = Rng(7);
    let known = [Pubkey::new_from_array([1; 32])];
    for round in 0..100_000 {
        let metas: Vec<[u8; 35]> = (0..r.below(4))
            .map(|_| random_extra_meta(&mut r, 5, &known))
            .collect();
        let data = if r.chance(20) {
            r.some_bytes(80)
        } else {
            validation_data(&mut r, &metas)
        };
        let theirs = TlvStateBorrowed::unpack(&data).and_then(|s| {
            s.get_first_bytes::<ExecuteInstruction>()
                .map(<[u8]>::to_vec)
        });
        let ours = hook::execute_entry(&data).map(<[u8]>::to_vec);
        assert_eq!(ours, theirs, "round {round}");
        if let Ok(value) = ours {
            let theirs = spl_pod::list::ListView::<ExtraAccountMeta>::unpack(&value)
                .map(|l| bytemuck::cast_slice::<ExtraAccountMeta, u8>(&l).to_vec());
            assert_eq!(
                hook::extra_account_metas(&value).map(<[u8]>::to_vec),
                theirs,
                "round {round}"
            );
        }
    }
}
