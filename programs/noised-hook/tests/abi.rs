//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check the program's own encoders, decoders and tables
//! against the code the Anchor build ran: Anchor's serialization and
//! discriminators, the hand-maintained IDL (`idls/noised_hook.json`), the
//! anchor-lang error table, Borsh, and the transfer-hook interface. Random
//! inputs (malformed ones included) must give the same result, or the same
//! error. The shared parsers and checks (Token-2022 parsing, rent, the
//! framework error table and log lines) are tested against the SPL and
//! Anchor crates in `crates/noised-onchain/tests`; the meta list contents,
//! the instructions-sysvar reader and the token-account reads are tested
//! against their SPL crates in `src/processor.rs`.

use std::collections::BTreeSet;

use anchor_lang::{
    error::ErrorCode, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    Event, InstructionData, Space, ToAccountMetas,
};
use noised_hook::{
    accounts, discriminator, error, event_data, instruction,
    processor::{META_LIST_DATA, META_LIST_LEN},
    state::{
        layout, write_policy, HookPolicy, NewPolicy, PolicyHead, PolicyKeys, PolicyParams,
        PolicyParamsRef, PolicyView, MAX_EXEMPT, MAX_RULES_LEN,
    },
    PolicyCreated, Pubkey, SnipeShieldEnded, ID, INSTRUCTIONS_SYSVAR_ID,
};
use noised_onchain::host::fuzz::Rng;
use solana_instruction::AccountMeta;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

fn sha256_8(input: &str) -> [u8; 8] {
    noised_onchain::hashv(&[input.as_bytes()])[..8]
        .try_into()
        .unwrap()
}

fn idl() -> serde_json::Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../idls/noised_hook.json");
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
        anchor_lang::pubkey!("cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia")
    );
    assert_eq!(ID.to_string(), idl()["address"].as_str().unwrap());
    assert_eq!(
        <noised_hook::program::NoisedHook as anchor_lang::Id>::id(),
        ID
    );
    assert_eq!(INSTRUCTIONS_SYSVAR_ID, solana_instructions_sysvar::ID);
    assert_eq!(
        noised_onchain::ids::TOKEN_2022_PROGRAM_ID,
        anchor_spl::token_2022::ID
    );
    assert_eq!(
        noised_onchain::ids::SYSTEM_PROGRAM_ID,
        anchor_lang::system_program::ID
    );
}

// ------------------------------------------------------- discriminators

/// Instructions: `global:<name>`, except `execute`, which carries the
/// transfer-hook interface's `Execute` discriminator (Token-2022 invokes it
/// by that). The interface's `InitializeExtraAccountMetaList` is not an
/// instruction of this program (its own `initialize_extra_account_meta_list`
/// has the Anchor discriminator): data with that prefix, like any other
/// unknown one, falls back to `InstructionFallbackNotFound` in both builds.
#[test]
fn discriminators_are_anchors_and_the_idls() {
    let idl = idl();
    /// (name, the program's, the client's, the expected discriminator).
    type Case<'a> = (&'a str, [u8; 8], &'a [u8], [u8; 8]);
    let cases: [Case; 4] = [
        (
            "initialize_extra_account_meta_list",
            discriminator::INITIALIZE_EXTRA_ACCOUNT_META_LIST,
            instruction::InitializeExtraAccountMetaList::DISCRIMINATOR,
            sha256_8("global:initialize_extra_account_meta_list"),
        ),
        (
            "create_policy",
            discriminator::CREATE_POLICY,
            instruction::CreatePolicy::DISCRIMINATOR,
            sha256_8("global:create_policy"),
        ),
        (
            "end_snipe_shield",
            discriminator::END_SNIPE_SHIELD,
            instruction::EndSnipeShield::DISCRIMINATOR,
            sha256_8("global:end_snipe_shield"),
        ),
        (
            "execute",
            discriminator::EXECUTE,
            instruction::Execute::DISCRIMINATOR,
            ExecuteInstruction::SPL_DISCRIMINATOR_SLICE
                .try_into()
                .unwrap(),
        ),
    ];
    for (name, disc, client, expected) in cases {
        assert_eq!(disc, expected, "{name}");
        assert_eq!(client, disc, "{name}");
        let ix = idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|ix| ix["name"] == name)
            .unwrap();
        assert_eq!(idl_bytes(&ix["discriminator"]), disc, "{name}");
    }
    assert_eq!(
        discriminator::EXECUTE,
        sha256_8("spl-transfer-hook-interface:execute")
    );
    assert_ne!(
        discriminator::INITIALIZE_EXTRA_ACCOUNT_META_LIST,
        InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE
    );
    assert_eq!(idl["instructions"].as_array().unwrap().len(), 4);

    assert_eq!(discriminator::HOOK_POLICY, sha256_8("account:HookPolicy"));
    assert_eq!(HookPolicy::DISCRIMINATOR, discriminator::HOOK_POLICY);
    let account = &idl["accounts"].as_array().unwrap()[0];
    assert_eq!(account["name"], "HookPolicy");
    assert_eq!(
        idl_bytes(&account["discriminator"]),
        discriminator::HOOK_POLICY
    );
    assert_eq!(idl["accounts"].as_array().unwrap().len(), 1);

    for (name, disc, anchor) in [
        (
            "PolicyCreated",
            discriminator::POLICY_CREATED,
            PolicyCreated::DISCRIMINATOR,
        ),
        (
            "SnipeShieldEnded",
            discriminator::SNIPE_SHIELD_ENDED,
            SnipeShieldEnded::DISCRIMINATOR,
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
/// IDL's signer and writable flags (the program checks the same flags) and
/// its fixed addresses.
#[test]
fn account_lists_are_the_idls() {
    let idl = idl();
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let lists: [(&str, Vec<AccountMeta>); 4] = [
        (
            "initialize_extra_account_meta_list",
            accounts::InitializeExtraAccountMetaList {
                payer: k(1),
                extra_account_meta_list: k(2),
                mint: k(3),
                system_program: k(4),
            }
            .to_account_metas(None),
        ),
        (
            "create_policy",
            accounts::CreatePolicy {
                payer: k(1),
                launchpad_authority: k(2),
                mint: k(3),
                pool: k(4),
                policy: k(5),
                system_program: k(6),
            }
            .to_account_metas(None),
        ),
        (
            "end_snipe_shield",
            accounts::EndSnipeShield {
                launchpad_authority: k(1),
                policy: k(2),
                instructions: k(3),
            }
            .to_account_metas(None),
        ),
        (
            "execute",
            accounts::Execute {
                source: k(1),
                mint: k(2),
                destination: k(3),
                authority: k(4),
                extra_account_meta_list: k(5),
                policy: k(6),
                instructions: k(7),
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
    // The fixed addresses the program checks.
    let address = |ix: &str, account: &str| -> Option<String> {
        idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == ix)
            .unwrap()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == account)
            .unwrap()["address"]
            .as_str()
            .map(str::to_string)
    };
    assert_eq!(
        address("end_snipe_shield", "instructions"),
        Some(INSTRUCTIONS_SYSVAR_ID.to_string())
    );
    for ix in ["create_policy", "initialize_extra_account_meta_list"] {
        assert_eq!(
            address(ix, "system_program"),
            Some(anchor_lang::system_program::ID.to_string()),
            "{ix}"
        );
    }
    assert_eq!(address("execute", "instructions"), None);
}

// ------------------------------------------------------- IDL layouts

/// Byte size of an IDL type (fixed-size types; `bytes` is its 4-byte length).
fn idl_size(ty: &serde_json::Value) -> usize {
    match ty.as_str() {
        Some("u8") | Some("bool") => 1,
        Some("u16") => 2,
        Some("u32") => 4,
        Some("u64") | Some("i64") => 8,
        Some("pubkey") => 32,
        Some("bytes") => 4,
        _ if ty.get("array").is_some() => {
            idl_size(&ty["array"][0]) * ty["array"][1].as_u64().unwrap() as usize
        }
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

fn random_policy(r: &mut Rng) -> HookPolicy {
    HookPolicy {
        version: r.byte(),
        bump: r.byte(),
        mint: r.key(),
        pool: r.key(),
        base_vault: r.key(),
        launch_ts: r.next() as i64,
        snipe_shield_end_ts: r.next() as i64,
        guard_end_ts: r.next() as i64,
        max_wallet: r.next(),
        max_buy: r.next(),
        p2p_locked: r.chance(50),
        exempt: [r.key(), r.key(), r.key(), r.key()],
        rules: {
            let len = r.pick(&[0u64, 1, 20, 66, 300, MAX_RULES_LEN as u64]);
            r.bytes(len as usize)
        },
    }
}

/// The policy's fields at `p`'s layout offsets.
fn policy_field(p: &HookPolicy, name: &str) -> Vec<u8> {
    match name {
        "version" => vec![p.version],
        "bump" => vec![p.bump],
        "mint" => p.mint.to_bytes().to_vec(),
        "pool" => p.pool.to_bytes().to_vec(),
        "base_vault" => p.base_vault.to_bytes().to_vec(),
        "launch_ts" => p.launch_ts.to_le_bytes().to_vec(),
        "snipe_shield_end_ts" => p.snipe_shield_end_ts.to_le_bytes().to_vec(),
        "guard_end_ts" => p.guard_end_ts.to_le_bytes().to_vec(),
        "max_wallet" => p.max_wallet.to_le_bytes().to_vec(),
        "max_buy" => p.max_buy.to_le_bytes().to_vec(),
        "p2p_locked" => vec![u8::from(p.p2p_locked)],
        "exempt" => p.exempt.iter().flat_map(|k| k.to_bytes()).collect(),
        "rules" => (p.rules.len() as u32).to_le_bytes().to_vec(),
        other => panic!("HookPolicy.{other}"),
    }
}

/// The hand-maintained IDL describes the program's layouts: every field of
/// the policy, the events and `PolicyParams` sits where the IDL's Borsh
/// layout puts it, the head and the program's offsets are the IDL's, and
/// nothing follows the last field (the policy's rule bytes).
#[test]
fn idl_types_describe_the_layouts() {
    let idl = idl();
    let mut r = Rng(8);
    let p = random_policy(&mut r);
    let mut data = vec![0u8; HookPolicy::space(p.rules.len())];
    write_policy(&mut data, &new_policy(&p)).unwrap();
    // `write_policy` writes the program's version; compare the rest.
    let p = HookPolicy {
        version: HookPolicy::VERSION,
        ..p
    };
    let policy_layout = idl_layout(&idl, "HookPolicy", 8);
    let offsets = [
        ("version", layout::VERSION),
        ("bump", layout::BUMP),
        ("mint", layout::MINT),
        ("pool", layout::POOL),
        ("base_vault", layout::BASE_VAULT),
        ("launch_ts", layout::LAUNCH_TS),
        ("snipe_shield_end_ts", layout::SNIPE_SHIELD_END_TS),
        ("guard_end_ts", layout::GUARD_END_TS),
        ("max_wallet", layout::MAX_WALLET),
        ("max_buy", layout::MAX_BUY),
        ("p2p_locked", layout::P2P_LOCKED),
        ("exempt", layout::EXEMPT),
        ("rules", layout::RULES_LEN),
    ];
    assert_eq!(policy_layout.len(), offsets.len());
    for ((name, at, size), (ours, offset)) in policy_layout.iter().zip(offsets) {
        assert_eq!((name.as_str(), *at), (ours, offset));
        assert_eq!(&data[*at..at + size], &policy_field(&p, name)[..], "{name}");
    }
    let (_, rules_at, _) = policy_layout.last().unwrap();
    assert_eq!(rules_at + 4, HookPolicy::FIXED_LEN);
    assert_eq!(&data[HookPolicy::FIXED_LEN..], &p.rules[..]);
    // The head is the policy's own fields.
    for (name, at) in [
        ("mint", PolicyHead::MINT_OFFSET),
        ("base_vault", PolicyHead::BASE_VAULT_OFFSET),
        ("guard_end_ts", PolicyHead::GUARD_END_TS_OFFSET),
    ] {
        assert!(policy_layout.iter().any(|(n, a, _)| n == name && *a == at));
    }

    let (mint, pool) = (r.key(), r.key());
    let (a, b, c, d) = (r.next() as i64, r.next() as i64, r.next(), r.next());
    let events: [(&str, Vec<u8>); 2] = [
        (
            "PolicyCreated",
            event_data::policy_created(&mint, &pool, a, b, c, d, true, 0x0102).to_vec(),
        ),
        (
            "SnipeShieldEnded",
            event_data::snipe_shield_ended(&mint, &pool, a, b).to_vec(),
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
            let want: Vec<u8> = match (event, name.as_str()) {
                (_, "mint") => mint.to_bytes().to_vec(),
                (_, "pool") => pool.to_bytes().to_vec(),
                ("PolicyCreated", "snipe_shield_end_ts") | (_, "scheduled_end_ts") => {
                    a.to_le_bytes().to_vec()
                }
                ("PolicyCreated", "guard_end_ts") | ("SnipeShieldEnded", "snipe_shield_end_ts") => {
                    b.to_le_bytes().to_vec()
                }
                (_, "max_wallet") => c.to_le_bytes().to_vec(),
                (_, "max_buy") => d.to_le_bytes().to_vec(),
                (_, "p2p_locked") => vec![1],
                (_, "rules_len") => 0x0102u16.to_le_bytes().to_vec(),
                (e, other) => panic!("{e}.{other}"),
            };
            assert_eq!(&data[*at..at + size], &want[..], "{event}.{name}");
        }
    }

    // create_policy(params: PolicyParams).
    let params = random_params(&mut r);
    let data = instruction::CreatePolicy {
        params: params.clone(),
    }
    .data();
    let layout = idl_layout(&idl, "PolicyParams", 8);
    for (name, at, size) in &layout {
        let want: Vec<u8> = match name.as_str() {
            "pool" => params.pool.to_bytes().to_vec(),
            "snipe_shield_secs" => params.snipe_shield_secs.to_le_bytes().to_vec(),
            "guard_secs" => params.guard_secs.to_le_bytes().to_vec(),
            "max_wallet" => params.max_wallet.to_le_bytes().to_vec(),
            "max_buy" => params.max_buy.to_le_bytes().to_vec(),
            "p2p_locked" => vec![u8::from(params.p2p_locked)],
            "exempt" => params.exempt.iter().flat_map(|k| k.to_bytes()).collect(),
            "rules" => (params.rules.len() as u32).to_le_bytes().to_vec(),
            other => panic!("PolicyParams.{other}"),
        };
        assert_eq!(&data[*at..at + size], &want[..], "PolicyParams.{name}");
    }
    let (_, rules_at, _) = layout.last().unwrap();
    assert_eq!(&data[rules_at + 4..], &params.rules[..]);

    // execute(amount: u64).
    let ix = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "execute")
        .unwrap();
    assert_eq!(ix["args"][0]["type"], "u64");
    assert_eq!(
        instruction::Execute { amount: 0x0102 }.data(),
        [&discriminator::EXECUTE[..], &0x0102u64.to_le_bytes()].concat()
    );
}

// ------------------------------------------------------ account layouts

fn new_policy(p: &HookPolicy) -> NewPolicy<'_> {
    NewPolicy {
        bump: p.bump,
        mint: &p.mint,
        pool: &p.pool,
        base_vault: &p.base_vault,
        launch_ts: p.launch_ts,
        snipe_shield_end_ts: p.snipe_shield_end_ts,
        guard_end_ts: p.guard_end_ts,
        max_wallet: p.max_wallet,
        max_buy: p.max_buy,
        p2p_locked: p.p2p_locked,
        exempt: &p.exempt,
        rules: &p.rules,
    }
}

/// `create_policy` writes a policy exactly as Anchor's `try_serialize` of
/// `HookPolicy` (version 2) into an account of `HookPolicy::space` bytes,
/// and refuses a shorter one; the space is Anchor's `8 + INIT_SPACE -
/// MAX_RULES_LEN + rules_len`.
#[test]
fn the_policy_is_written_as_anchor_serializes_it() {
    assert_eq!(
        HookPolicy::FIXED_LEN,
        8 + HookPolicy::INIT_SPACE - MAX_RULES_LEN
    );
    assert_eq!(HookPolicy::FIXED_LEN, 279);
    let mut r = Rng(2);
    for round in 0..3_000 {
        let mut p = random_policy(&mut r);
        p.version = HookPolicy::VERSION;
        let mut anchor = Vec::new();
        p.try_serialize(&mut anchor).unwrap();
        let mut ours = vec![0u8; HookPolicy::space(p.rules.len())];
        write_policy(&mut ours, &new_policy(&p)).unwrap();
        assert_eq!(anchor, ours, "round {round}");
        // Bytes after the policy are left as they are.
        let tail = r.some_bytes(9);
        let mut longer = [vec![0u8; ours.len()], tail.clone()].concat();
        write_policy(&mut longer, &new_policy(&p)).unwrap();
        assert_eq!(longer, [anchor.clone(), tail].concat());
        let short = r.below(ours.len() as u64) as usize;
        assert!(write_policy(&mut vec![0u8; short], &new_policy(&p)).is_none());
    }
}

/// What the program reads of a policy account (`PolicyView`, and
/// `PolicyKeys` for `end_snipe_shield`) is what Anchor's `try_deserialize`
/// of `HookPolicy` reads, and fails exactly when it fails after the
/// discriminator: on valid, truncated, extended and corrupted data (another
/// `p2p_locked` byte, another rules length, random bytes).
#[test]
fn the_policy_is_read_as_anchor_deserializes_it() {
    let mut r = Rng(4);
    let (mut decoded, mut refused) = (0, 0);
    for round in 0..20_000 {
        let p = random_policy(&mut r);
        let mut data = Vec::new();
        p.try_serialize(&mut data).unwrap();
        match r.below(7) {
            0 => data.truncate(8 + r.below(data.len() as u64 - 7) as usize),
            1 => data.extend(r.some_bytes(40)),
            2 => data[layout::P2P_LOCKED] = r.byte(),
            3 => {
                let any = r.next() as u32;
                let len = r.pick(&[0u32, 1, p.rules.len() as u32 + 1, any]);
                data[layout::RULES_LEN..layout::RULES].copy_from_slice(&len.to_le_bytes());
            }
            4 => {
                let at = 8 + r.below(data.len() as u64 - 8) as usize;
                data[at] = r.byte();
            }
            5 => data = [&data[..8], &r.some_bytes(400)[..]].concat(),
            _ => {}
        }
        let anchor = HookPolicy::try_deserialize(&mut &data[..]);
        let view = PolicyView::read(&data);
        let keys = PolicyKeys::read(&data);
        assert_eq!(anchor.is_ok(), view.is_some(), "round {round}");
        assert_eq!(view.is_some(), keys.is_some(), "round {round}");
        match anchor {
            Ok(a) => {
                assert_eq!(view.unwrap(), PolicyView::from(&a), "round {round}");
                let keys = keys.unwrap();
                assert_eq!(
                    (keys.bump, keys.mint, keys.pool, keys.snipe_shield_end_ts),
                    (a.bump, a.mint, a.pool, a.snipe_shield_end_ts)
                );
                decoded += 1;
            }
            Err(e) => {
                assert_eq!(
                    e,
                    anchor_lang::error::Error::from(ErrorCode::AccountDidNotDeserialize),
                    "round {round}"
                );
                refused += 1;
            }
        }
    }
    assert!(decoded > 5_000 && refused > 5_000, "{decoded} {refused}");
}

// ----------------------------------------------------- argument layouts

fn random_params(r: &mut Rng) -> PolicyParams {
    PolicyParams {
        pool: r.key(),
        snipe_shield_secs: r.next() as u32,
        guard_secs: r.next() as u32,
        max_wallet: r.next(),
        max_buy: r.next(),
        p2p_locked: r.chance(50),
        exempt: core::array::from_fn::<_, MAX_EXEMPT, _>(|_| r.key()),
        rules: {
            let len = r.pick(&[0u64, 1, 66, MAX_RULES_LEN as u64, 2_000]);
            r.bytes(len as usize)
        },
    }
}

/// The program's decoders read Borsh as Anchor's dispatcher did
/// (`deserialize` from the data after the discriminator: trailing bytes are
/// ignored, a short input fails, a `bool` is 0 or 1), on valid, truncated,
/// extended, corrupted and random data.
#[test]
fn argument_decoding_matches_borsh() {
    let mut r = Rng(1);
    let (mut parsed, mut failed) = (0, 0);
    for round in 0..20_000 {
        let params = random_params(&mut r);
        let mut data = instruction::CreatePolicy { params }.data()[8..].to_vec();
        match r.below(7) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(40)),
            2 => data[56] = r.byte(),
            3 => {
                let any = r.next() as u32 % 3_000;
                let len = r.pick(&[0u32, 1, 2_000, any]);
                data[185..189].copy_from_slice(&len.to_le_bytes());
            }
            4 => data = r.some_bytes(400),
            _ => {}
        }
        let borsh = PolicyParams::deserialize(&mut &data[..]).ok();
        let ours = PolicyParamsRef::parse(&data);
        assert_eq!(borsh.is_some(), ours.is_some(), "round {round}");
        if let (Some(b), Some(o)) = (borsh, ours) {
            assert_eq!(
                (
                    b.pool,
                    b.snipe_shield_secs,
                    b.guard_secs,
                    b.max_wallet,
                    b.max_buy,
                    b.p2p_locked,
                    b.exempt,
                    &b.rules[..]
                ),
                (
                    o.pool,
                    o.snipe_shield_secs,
                    o.guard_secs,
                    o.max_wallet,
                    o.max_buy,
                    o.p2p_locked,
                    o.exempt,
                    o.rules
                ),
                "round {round}"
            );
            parsed += 1;
        } else {
            failed += 1;
        }

        // execute(amount): eight little-endian bytes, the rest ignored.
        let data = r.some_bytes(12);
        let borsh = instruction::Execute::deserialize(&mut &data[..])
            .ok()
            .map(|e| e.amount);
        let ours = data.first_chunk::<8>().map(|b| u64::from_le_bytes(*b));
        assert_eq!(borsh, ours, "round {round}");
    }
    assert!(parsed > 5_000 && failed > 5_000, "{parsed} {failed}");
}

/// The meta list the program writes, and its size, are the transfer-hook
/// interface's: `ExtraAccountMetaList::size_of(2)` bytes whose TLV entry is
/// the `Execute` discriminator's (`processor::tests` compares every byte
/// with `ExtraAccountMetaList::init` of the Anchor build's
/// `canonical_metas()`; the integration suite resolves it through
/// Token-2022).
#[test]
fn the_meta_list_is_the_interfaces() {
    use spl_tlv_account_resolution::state::ExtraAccountMetaList;
    assert_eq!(META_LIST_LEN, ExtraAccountMetaList::size_of(2).unwrap());
    assert_eq!(META_LIST_DATA.len(), 86);
    assert_eq!(
        &META_LIST_DATA[..8],
        ExecuteInstruction::SPL_DISCRIMINATOR_SLICE
    );
}

// --------------------------------------------------------------- events

/// The events are Anchor's `emit!` payloads: discriminator, then Borsh.
#[test]
fn events_match_anchor() {
    let mut r = Rng(3);
    for _ in 0..2_000 {
        let created = PolicyCreated {
            mint: r.key(),
            pool: r.key(),
            snipe_shield_end_ts: r.next() as i64,
            guard_end_ts: r.next() as i64,
            max_wallet: r.next(),
            max_buy: r.next(),
            p2p_locked: r.chance(50),
            rules_len: r.next() as u16,
        };
        assert_eq!(created.data(), created.log_data());
        let ended = SnipeShieldEnded {
            mint: r.key(),
            pool: r.key(),
            scheduled_end_ts: r.next() as i64,
            snipe_shield_end_ts: r.next() as i64,
        };
        assert_eq!(ended.data(), ended.log_data());
    }
    assert_eq!(event_data::POLICY_CREATED_LEN, 107);
    assert_eq!(event_data::SNIPE_SHIELD_ENDED_LEN, 88);
}

// --------------------------------------------------------------- errors

/// The program's numbers, names and messages are the IDL's (HookError)
/// and anchor-lang 1.2.1's (framework errors), and no other number is
/// logged.
#[test]
fn error_table_matches_anchor_and_the_idl() {
    use error::HookError::*;
    for (e, n) in [
        (SnipeShield, 6000),
        (TransfersLocked, 6001),
        (MaxBuy, 6002),
        (MaxWallet, 6003),
        (WrongHookProgram, 6004),
        (PolicyMismatch, 6005),
        (InvalidPolicy, 6006),
        (InvalidPool, 6007),
        (MalformedTokenAccount, 6008),
        (NotInBatch, 6009),
        (MutableOwner, 6010),
        (RuleDenied, 6011),
        (InvalidRules, 6012),
    ] {
        assert_eq!(u32::from(e), n);
        assert_eq!(e as u32 + 6000, n);
        assert_eq!(e.name(), format!("{e:?}"));
    }
    let idl_errors = idl()["errors"].as_array().unwrap().clone();
    assert_eq!(idl_errors.len(), 13);
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
        ErrorCode::ConstraintRentExempt,
        ErrorCode::ConstraintSeeds,
        ErrorCode::ConstraintAddress,
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
}
