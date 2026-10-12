//! zToken metadata of Noised launch mints in each uri mode of the on-chain
//! metadata record (METADATA_PROGRAM.md A1). A launch mint's uri is empty
//! (the default), the inline `data:application/json;base64,` uri of the
//! record's document (at most 4,125 bytes) or an external `https://` uri of
//! at most 200 printable ASCII bytes (the launchpad refuses anything else).
//! The shield copies a base uri only when it is at most 200 bytes and holds
//! no hidden character (`metadata::derive`), whatever its scheme:
//!
//! * no uri: the zToken has none;
//! * an inline uri is over 200 bytes from a 127-byte document on (any
//!   document with an icon), and the zToken gets an empty uri; the inline
//!   uri of a document of at most 126 bytes is at most 197 bytes and is
//!   copied like any short clean uri (base64 has no hidden character);
//! * an external uri is always copied, byte for byte.
//!
//! The base mints are made here as `launch` leaves them (metadata pointer to
//! itself with no authority, the Launch Guard hook, TokenMetadata with no
//! update authority, no freeze authority; the mint authority is revoked
//! once the test has minted), with Token-2022's own instructions: the
//! shield reads nothing but the mint.

mod common;

use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    prelude::Pubkey,
    solana_program::system_instruction,
};
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{metadata_pointer, transfer_hook, ExtensionType},
        instruction::{self as t22_ix, AuthorityType},
        state::Mint,
    },
    token_2022_extensions::{
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::{self, state::TokenMetadata},
    },
};
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The inline uri's prefix (METADATA_PROGRAM.md A1).
const DATA_URI_PREFIX: &str = "data:application/json;base64,";

/// A Token-2022 mint as a Noised launch leaves it, holding `name`,
/// `symbol` and `uri` (its mint authority stays with the payer until
/// `revoke_mint_authority`).
fn launch_mint(env: &mut Env, name: &str, symbol: &str, uri: &str) -> Pubkey {
    let kp = Keypair::new();
    let (mint, payer) = (kp.pubkey(), env.payer.pubkey());
    let space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
        ExtensionType::TransferHook,
    ])
    .unwrap();
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(payer)).unwrap(),
        mint,
        name: name.into(),
        symbol: symbol.into(),
        uri: uri.into(),
        additional_metadata: vec![],
    };
    let lamports = env
        .svm
        .minimum_balance_for_rent_exemption(space + 4 + borsh_len(&metadata));
    let ixs = [
        system_instruction::create_account(&payer, &mint, lamports, space as u64, &T22),
        metadata_pointer::instruction::initialize(&T22, &mint, None, Some(mint)).unwrap(),
        transfer_hook::instruction::initialize(&T22, &mint, Some(payer), Some(noised_hook::ID))
            .unwrap(),
        t22_ix::initialize_mint2(&T22, &mint, &payer, None, 6).unwrap(),
        spl_token_metadata_interface::instruction::initialize(
            &T22,
            &mint,
            &payer,
            &mint,
            &payer,
            name.into(),
            symbol.into(),
            uri.into(),
        ),
        spl_token_metadata_interface::instruction::update_authority(
            &T22,
            &mint,
            &payer,
            OptionalNonZeroPubkey::default(),
        ),
    ];
    // LiteSVM does not enforce the wire size (a 4,125-byte uri is
    // initialized by DBC's CPI on-chain).
    env.ok(&ixs, &[&kp]);
    env.init_hook_meta_list(&mint);
    mint
}

fn revoke_mint_authority(env: &mut Env, mint: &Pubkey) {
    let payer = env.payer.pubkey();
    let ix =
        t22_ix::set_authority(&T22, mint, None, AuthorityType::MintTokens, &payer, &[]).unwrap();
    env.ok(&[ix], &[]);
}

/// A metadata document of exactly `len` bytes (compact JSON).
fn document(len: usize) -> String {
    let head = r#"{"name":"Phalanx Cryo Token","symbol":"PHXCR","description":""#;
    let tail = r#""}"#;
    let doc = format!("{head}{}{tail}", "x".repeat(len - head.len() - tail.len()));
    assert_eq!(doc.len(), len);
    doc
}

/// The inline uri `launch` derives from a document.
fn inline_uri(doc: &str) -> String {
    format!("{DATA_URI_PREFIX}{}", STANDARD.encode(doc))
}

/// Shield a launch mint and check the zToken's metadata.
fn shield(env: &mut Env, base: Pubkey, name: &str, symbol: &str, uri: &str) -> (ShieldKeys, u64) {
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    let cu = env.ok(&[create_shield_ix(&payer, &s)], &[]);
    assert_z_mint(env, &s, 6, name, symbol, uri);
    (s, cu)
}

#[test]
fn a_launch_mint_without_uri_gives_a_ztoken_without_uri() {
    let mut env = Env::new().with_hook();
    let base = launch_mint(&mut env, "Phalanx Cryo Token", "PHXCR", "");
    revoke_mint_authority(&mut env, &base);
    shield(&mut env, base, "Shielded Phalanx Cryo Token", "zPHXCR", "");
}

/// Inline uris over 200 bytes: the 201-byte uri of a 127-byte document, a
/// typical document with an icon (1,130 bytes) and the largest (3,072
/// bytes, a 4,125-byte uri, with a multi-byte name and symbol of the
/// largest sizes, cut on character boundaries). The zToken of the largest
/// still wraps and unwraps through the Launch Guard hook.
#[test]
fn an_inline_uri_over_200_bytes_gives_a_ztoken_without_uri() {
    let mut env = Env::new().with_hook();
    for len in [127, 1_130] {
        let uri = inline_uri(&document(len));
        assert!(uri.len() > 200, "{}", uri.len());
        let base = launch_mint(&mut env, "Phalanx Cryo Token", "PHXCR", &uri);
        revoke_mint_authority(&mut env, &base);
        shield(&mut env, base, "Shielded Phalanx Cryo Token", "zPHXCR", "");
    }
    assert_eq!(inline_uri(&document(127)).len(), 201);

    let uri = inline_uri(&document(3_072));
    assert_eq!(uri.len(), 4_125);
    let (name, symbol) = ("Noised 🛡 Inline 0123456789012", "PHX🛡INL");
    assert_eq!((name.len(), symbol.len()), (32, 10));
    let base = launch_mint(&mut env, name, symbol, &uri);
    let (s, cu) = shield(
        &mut env,
        base,
        "Shielded Noised 🛡 Inline 0123",
        "zPHX🛡IN",
        "",
    );
    eprintln!("create_shield (launch mint with a 4,125-byte inline uri): {cu} CU");
    let (alice, alice_base, alice_z) = env.funded_user(&s, 5_000);
    revoke_mint_authority(&mut env, &base);
    let a = alice.pubkey();
    let extras = hook_extras(&base);
    let cu = env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 3_000, &extras)],
        &[&alice],
    );
    eprintln!("wrap (launch mint with a 4,125-byte inline uri): {cu} CU");
    let cu = env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &extras)],
        &[&alice],
    );
    eprintln!("unwrap (launch mint with a 4,125-byte inline uri): {cu} CU");
    assert_eq!(assert_exactly_backed(&env, &s), 2_000);
    assert_eq!(env.balance(&alice_base), 3_000);
}

/// The inline uri of a document of at most 126 bytes is at most 197 bytes:
/// the shield copies it like any short uri without hidden characters, so
/// the zToken points at the same data uri as its base mint.
#[test]
fn an_inline_uri_of_a_short_document_is_copied_like_any_short_uri() {
    let mut env = Env::new().with_hook();
    let uri = inline_uri(&document(126));
    assert_eq!(uri.len(), 197);
    let base = launch_mint(&mut env, "Phalanx Cryo Token", "PHXCR", &uri);
    revoke_mint_authority(&mut env, &base);
    shield(
        &mut env,
        base,
        "Shielded Phalanx Cryo Token",
        "zPHXCR",
        &uri,
    );
}

/// An external uri (`https://`, at most 200 bytes, every byte printable
/// ASCII) is copied byte for byte: a typical one, and one of 200 bytes that
/// holds every printable ASCII byte (none is hidden).
#[test]
fn an_external_uri_is_copied_byte_for_byte() {
    let mut env = Env::new().with_hook();
    let mut every = String::from("https://noised.example/m/");
    for b in (0x21..=0x7Eu8).cycle() {
        if every.len() == 200 {
            break;
        }
        every.push(char::from(b));
    }
    for uri in ["https://noised.example/phxcr.json", every.as_str()] {
        let base = launch_mint(&mut env, "Phalanx Cryo Token", "PHXCR", uri);
        revoke_mint_authority(&mut env, &base);
        shield(&mut env, base, "Shielded Phalanx Cryo Token", "zPHXCR", uri);
    }
}
