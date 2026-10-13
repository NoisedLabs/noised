//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check the program's own encoders, decoders and CPIs
//! against what the Anchor build used: Anchor's serialization and
//! discriminators, the IDL, the anchor-lang error table, Borsh, the SPL
//! Token / Token-2022 instruction builders and the DAMM v2 client of the
//! launchpad's `declare_program!`. Random inputs (malformed ones included)
//! must give the same result, or the same error. The shared parsers and
//! checks are tested in `crates/noised-onchain/tests`; the pure decisions
//! (`logic`, `reference`, `price`) and the layouts the program reads by
//! offset in `src/tests`.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use anchor_lang::{
    error::ErrorCode, AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
    Event, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022;
use noised_autopilot::{
    accounts, constants::*, cpi, discriminator, error, events::*, instruction, instructions, int,
    processor, state::*, Pubkey, ID,
};
use noised_onchain::{
    host::{fuzz::Rng, take_cpis, take_log_lines, take_logs, HostAccount},
    ids::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
};

fn sha256_8(input: &str) -> [u8; 8] {
    noised_onchain::host::discriminator(
        input.split(':').next().unwrap(),
        input.split(':').nth(1).unwrap(),
    )
}

fn idl() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../idls/noised_autopilot.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read the IDL")).expect("IDL JSON")
}

fn idl_bytes(v: &serde_json::Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn find<'a>(list: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("{name} not in the IDL"))
}

// ------------------------------------------------------------------ ids

#[test]
fn program_id_and_address_constants() {
    let idl = idl();
    assert_eq!(
        ID,
        anchor_lang::pubkey!("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx")
    );
    assert_eq!(ID.to_string(), idl["address"].as_str().unwrap());
    assert_eq!(
        <noised_autopilot::program::NoisedAutopilot as anchor_lang::Id>::id(),
        ID
    );
    assert_eq!(noised_autopilot::id(), ID);
    assert!(noised_autopilot::check_id(&ID));
    // Every `pubkey!` constant is what `Pubkey::from_str` decodes.
    for (constant, text) in [
        (
            LAUNCHPAD_PROGRAM_ID,
            "CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc",
        ),
        (
            DBC_PROGRAM_ID,
            "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
        ),
        (
            DBC_POOL_AUTHORITY,
            "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
        ),
        (
            DAMM_V2_PROGRAM_ID,
            "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        ),
        (
            DAMM_V2_POOL_AUTHORITY,
            "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
        ),
        (
            DAMM_V2_EVENT_AUTHORITY,
            "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet",
        ),
        (WSOL_MINT, "So11111111111111111111111111111111111111112"),
    ] {
        assert_eq!(constant, Pubkey::from_str(text).unwrap(), "{text}");
    }
    // The const decoder on random addresses, leading zero bytes included.
    let mut r = Rng(11);
    for round in 0..20_000 {
        let mut bytes: [u8; 32] = r.array();
        let zeros = r.pick(&[0usize, 0, 0, 1, 2, 5, 31, 32]);
        bytes[..zeros].fill(0);
        let key = Pubkey::new_from_array(bytes);
        let text = noised_onchain::host::base58(&bytes);
        assert_eq!(noised_autopilot::decode_pubkey(&text), key, "round {round}");
    }
    assert_eq!(
        noised_autopilot::decode_pubkey("11111111111111111111111111111111"),
        Pubkey::default()
    );
}

// ------------------------------------------------------- discriminators

#[test]
fn discriminators_are_anchors_and_the_idls() {
    let idl = idl();
    let instructions: [(&str, [u8; 8], &[u8]); 10] = [
        (
            "init_autopilot",
            discriminator::INIT_AUTOPILOT,
            instruction::InitAutopilot::DISCRIMINATOR,
        ),
        (
            "bind_mint",
            discriminator::BIND_MINT,
            instruction::BindMint::DISCRIMINATOR,
        ),
        (
            "bind_pool",
            discriminator::BIND_POOL,
            instruction::BindPool::DISCRIMINATOR,
        ),
        (
            "publish_graph",
            discriminator::PUBLISH_GRAPH,
            instruction::PublishGraph::DISCRIMINATOR,
        ),
        (
            "activate",
            discriminator::ACTIVATE,
            instruction::Activate::DISCRIMINATOR,
        ),
        (
            "apply_pending",
            discriminator::APPLY_PENDING,
            instruction::ApplyPending::DISCRIMINATOR,
        ),
        (
            "freeze",
            discriminator::FREEZE,
            instruction::Freeze::DISCRIMINATOR,
        ),
        (
            "revoke_operator",
            discriminator::REVOKE_OPERATOR,
            instruction::RevokeOperator::DISCRIMINATOR,
        ),
        ("run", discriminator::RUN, instruction::Run::DISCRIMINATOR),
        (
            "update_price",
            discriminator::UPDATE_PRICE,
            instruction::UpdatePrice::DISCRIMINATOR,
        ),
    ];
    assert_eq!(idl["instructions"].as_array().unwrap().len(), 10);
    for (name, disc, client) in instructions {
        assert_eq!(disc, sha256_8(&format!("global:{name}")), "{name}");
        assert_eq!(client, disc, "{name}");
        assert_eq!(
            idl_bytes(&find(&idl["instructions"], name)["discriminator"]),
            disc,
            "{name}"
        );
    }
    for (name, disc, anchor) in [
        (
            "Autopilot",
            discriminator::AUTOPILOT,
            Autopilot::DISCRIMINATOR,
        ),
        (
            "GraphRecord",
            discriminator::GRAPH_RECORD,
            GraphRecord::DISCRIMINATOR,
        ),
    ] {
        assert_eq!(disc, sha256_8(&format!("account:{name}")));
        assert_eq!(anchor, disc);
        assert_eq!(
            idl_bytes(&find(&idl["accounts"], name)["discriminator"]),
            disc
        );
    }
    let events: [(&str, [u8; 8], &[u8]); 10] = [
        (
            "AutopilotInitialized",
            discriminator::AUTOPILOT_INITIALIZED,
            AutopilotInitialized::DISCRIMINATOR,
        ),
        (
            "MintBound",
            discriminator::MINT_BOUND,
            MintBound::DISCRIMINATOR,
        ),
        (
            "PoolBound",
            discriminator::POOL_BOUND,
            PoolBound::DISCRIMINATOR,
        ),
        (
            "GraphPublished",
            discriminator::GRAPH_PUBLISHED,
            GraphPublished::DISCRIMINATOR,
        ),
        (
            "GraphQueued",
            discriminator::GRAPH_QUEUED,
            GraphQueued::DISCRIMINATOR,
        ),
        (
            "GraphActivated",
            discriminator::GRAPH_ACTIVATED,
            GraphActivated::DISCRIMINATOR,
        ),
        (
            "GraphFrozen",
            discriminator::GRAPH_FROZEN,
            GraphFrozen::DISCRIMINATOR,
        ),
        (
            "OperatorRevoked",
            discriminator::OPERATOR_REVOKED,
            OperatorRevoked::DISCRIMINATOR,
        ),
        ("NodeRan", discriminator::NODE_RAN, NodeRan::DISCRIMINATOR),
        (
            "ReferencePriceUpdated",
            discriminator::REFERENCE_PRICE_UPDATED,
            ReferencePriceUpdated::DISCRIMINATOR,
        ),
    ];
    assert_eq!(idl["events"].as_array().unwrap().len(), 10);
    for (name, disc, anchor) in events {
        assert_eq!(disc, sha256_8(&format!("event:{name}")), "{name}");
        assert_eq!(anchor, disc, "{name}");
        assert_eq!(
            idl_bytes(&find(&idl["events"], name)["discriminator"]),
            disc,
            "{name}"
        );
    }
    assert_eq!(
        discriminator::EVENT_IX_TAG_LE,
        anchor_lang::event::EVENT_IX_TAG_LE
    );
}

// --------------------------------------------------------- account lists

/// The account lists the client builds are the IDL's, in order, with the
/// IDL's signer, writable and optional flags (the program checks the same
/// flags); an `Option` account left out is the program id, read-only.
#[test]
fn account_lists_are_the_idls() {
    let idl = idl();
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let lists: Vec<(
        &str,
        Vec<anchor_lang::solana_program::instruction::AccountMeta>,
    )> = vec![
        (
            "init_autopilot",
            accounts::InitAutopilot {
                payer: k(1),
                launch: k(2),
                dbc_config: k(3),
                autopilot: k(4),
                treasury: k(5),
                wsol_mint: k(6),
                treasury_wsol: k(7),
                token_program: k(8),
                associated_token_program: k(9),
                system_program: k(10),
            }
            .to_account_metas(None),
        ),
        (
            "bind_mint",
            accounts::BindMint {
                payer: k(1),
                autopilot: k(2),
                launch: k(3),
                certificate: k(4),
                mint: k(5),
                treasury: k(6),
                treasury_token: k(7),
                token_2022_program: k(8),
                associated_token_program: k(9),
                system_program: k(10),
            }
            .to_account_metas(None),
        ),
        (
            "bind_pool",
            accounts::BindPool {
                autopilot: k(1),
                damm_config: k(2),
                damm_pool: k(3),
            }
            .to_account_metas(None),
        ),
        (
            "publish_graph",
            accounts::PublishGraph {
                payer: k(1),
                launch: k(2),
                graph: k(3),
                system_program: k(4),
            }
            .to_account_metas(None),
        ),
        (
            "activate",
            accounts::Activate {
                autopilot: k(1),
                launch: k(2),
                graph: k(3),
                authorization: k(4),
            }
            .to_account_metas(None),
        ),
        (
            "apply_pending",
            accounts::ApplyPending {
                autopilot: k(1),
                graph: k(2),
            }
            .to_account_metas(None),
        ),
        (
            "freeze",
            accounts::Govern {
                autopilot: k(1),
                launch: k(2),
                authorization: k(3),
            }
            .to_account_metas(None),
        ),
        (
            "revoke_operator",
            accounts::Govern {
                autopilot: k(1),
                launch: k(2),
                authorization: k(3),
            }
            .to_account_metas(None),
        ),
        (
            "run",
            accounts::Run {
                caller: k(1),
                operator: Some(k(2)),
                autopilot: k(3),
                graph: k(4),
                treasury: k(5),
                treasury_wsol: k(6),
                treasury_token: k(7),
                mint: k(8),
                wsol_mint: k(9),
                damm_pool: Some(k(10)),
                tip_account: k(11),
                token_program: k(12),
                token_2022_program: k(13),
            }
            .to_account_metas(None),
        ),
        (
            "update_price",
            accounts::UpdatePrice {
                autopilot: k(1),
                damm_pool: k(2),
            }
            .to_account_metas(None),
        ),
    ];
    for (name, metas) in lists {
        let expected = find(&idl["instructions"], name)["accounts"]
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
    // `run`'s optional accounts: `None` is the program id, read-only.
    let run = accounts::Run {
        caller: k(1),
        operator: None,
        damm_pool: None,
        ..Default::default()
    }
    .to_account_metas(None);
    let optional: Vec<bool> = find(&idl["instructions"], "run")["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["optional"].as_bool().unwrap_or(false))
        .collect();
    assert_eq!(
        optional
            .iter()
            .enumerate()
            .filter(|(_, o)| **o)
            .map(|(i, _)| i)
            .collect::<Vec<_>>(),
        [1, 9]
    );
    for i in [1, 9] {
        assert_eq!(run[i].pubkey, ID);
        assert!(!run[i].is_signer && !run[i].is_writable);
    }
}

// ------------------------------------------------------- account layouts

/// Byte size of an IDL type (`bytes` is its 4-byte length).
fn idl_size(idl: &serde_json::Value, ty: &serde_json::Value) -> usize {
    match ty.as_str() {
        Some("u8") | Some("bool") => 1,
        Some("u16") => 2,
        Some("u32") => 4,
        Some("u64") | Some("i64") => 8,
        Some("u128") => 16,
        Some("pubkey") => 32,
        Some("bytes") => 4,
        Some(other) => panic!("unexpected IDL type {other}"),
        None if ty.get("array").is_some() => {
            idl_size(idl, &ty["array"][0]) * ty["array"][1].as_u64().unwrap() as usize
        }
        None => {
            let name = ty["defined"]["name"].as_str().unwrap();
            idl_layout(idl, name, 0)
                .last()
                .map_or(0, |(_, at, size)| at + size)
        }
    }
}

/// The IDL's field offsets of type `name` (after `skip` leading bytes).
fn idl_layout(idl: &serde_json::Value, name: &str, skip: usize) -> Vec<(String, usize, usize)> {
    let ty = find(&idl["types"], name);
    let mut at = skip;
    ty["type"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let size = idl_size(idl, &f["type"]);
            let field = (f["name"].as_str().unwrap().to_string(), at, size);
            at += size;
            field
        })
        .collect()
}

fn random_autopilot(r: &mut Rng) -> Autopilot {
    let mark = |r: &mut Rng| AuthMark {
        slot: r.next(),
        key: r.key(),
    };
    let bucket = |r: &mut Rng| ObsBucket {
        index: r.next() as i64,
        first_at: r.next() as i64,
        min: (u128::from(r.next()) << 64) | u128::from(r.next()),
        max: (u128::from(r.next()) << 64) | u128::from(r.next()),
    };
    let node = |r: &mut Rng| NodeRecord {
        last_run: r.next() as i64,
        last_seq: r.next(),
        epoch_start: r.next() as i64,
        runs_in_epoch: r.next() as u16,
        spent_in_epoch: r.next(),
    };
    Autopilot {
        version: r.byte(),
        bump: r.byte(),
        treasury_bump: r.byte(),
        launch: r.key(),
        mint: r.key(),
        damm_pool: r.key(),
        active_graph: r.array(),
        pending_graph: r.array(),
        pending_activate_at: r.next() as i64,
        pending_operator: r.key(),
        activated_at: r.next() as i64,
        frozen: r.chance(50),
        operator: r.key(),
        auth_marks: [mark(r), mark(r), mark(r)],
        seq: r.next(),
        ref_sqrt_price: (u128::from(r.next()) << 64) | u128::from(r.next()),
        ref_updated_at: r.next() as i64,
        ref_allowance: r.next(),
        ref_allowance_at: r.next() as i64,
        observations: [bucket(r), bucket(r)],
        tip_epoch_start: r.next() as i64,
        tips_in_epoch: r.next(),
        nodes: core::array::from_fn(|_| node(r)),
        active_auth: r.key(),
        active_activate_at: r.next() as i64,
        partial_spent: core::array::from_fn(|_| r.next()),
    }
}

fn anchor_bytes<T: AccountSerialize>(account: &T) -> Vec<u8> {
    let mut out = Vec::new();
    account.try_serialize(&mut out).unwrap();
    out
}

/// `write` is Anchor's `try_serialize` and `read` its `try_deserialize`,
/// on random accounts, longer data, a `frozen` byte that is not a bool and
/// truncated data (both refuse).
#[test]
fn autopilot_codec_is_anchors() {
    assert_eq!(Autopilot::LEN, 8 + Autopilot::INIT_SPACE);
    assert_eq!(Autopilot::LEN, 1_244);
    let mut r = Rng(2);
    for round in 0..3_000 {
        let ap = random_autopilot(&mut r);
        let anchor = anchor_bytes(&ap);
        let mut ours = [0u8; Autopilot::LEN];
        ap.write(&mut ours);
        assert_eq!(anchor, ours, "round {round}");
        assert_eq!(Autopilot::read(&ours).as_ref(), Some(&ap));
        assert_eq!(Autopilot::read_boxed(&ours).as_deref(), Some(&ap));
        let mut longer = anchor.clone();
        longer.extend(r.bytes(9));
        assert_eq!(
            Autopilot::try_deserialize(&mut &longer[..]).unwrap(),
            Autopilot::read(&longer).unwrap()
        );
        let mut bad = anchor.clone();
        bad[layout::FROZEN] = 2 + r.byte() % 254;
        assert!(Autopilot::try_deserialize(&mut &bad[..]).is_err());
        assert_eq!(Autopilot::read(&bad), None);
        let cut = r.below(Autopilot::LEN as u64) as usize;
        assert!(Autopilot::try_deserialize(&mut &anchor[..cut]).is_err() || cut < 8);
        assert_eq!(Autopilot::read(&anchor[..cut]), None);
        assert_eq!(
            noised_onchain::host::deserialize::<Autopilot>(&anchor).unwrap(),
            ap
        );
    }
    // `init_autopilot`'s account: the zeroed account with its fields set.
    let mut d = [0xAAu8; Autopilot::LEN];
    let launch = r.key();
    Autopilot::write_new(&mut d, 251, 250, &launch, 0x1234_5678_9abc);
    let expected = Autopilot {
        version: Autopilot::VERSION,
        bump: 251,
        treasury_bump: 250,
        launch,
        ref_sqrt_price: 0x1234_5678_9abc,
        ..Default::default()
    };
    assert_eq!(anchor_bytes(&expected), d);
}

/// The hand-maintained IDL describes the layout the program reads and
/// writes: every field where the IDL's Borsh layout puts it, the offsets
/// of `state::layout` included, and nothing after the last field.
#[test]
fn idl_types_describe_the_autopilot_layout() {
    let idl = idl();
    let layout_of = idl_layout(&idl, "Autopilot", 8);
    assert_eq!(
        layout_of.last().map(|(_, at, size)| at + size),
        Some(Autopilot::LEN)
    );
    let offsets: BTreeMap<&str, usize> = layout_of
        .iter()
        .map(|(name, at, _)| (name.as_str(), *at))
        .collect();
    for (name, at) in [
        ("version", layout::VERSION),
        ("bump", layout::BUMP),
        ("treasury_bump", layout::TREASURY_BUMP),
        ("launch", layout::LAUNCH),
        ("mint", layout::MINT),
        ("damm_pool", layout::DAMM_POOL),
        ("active_graph", layout::ACTIVE_GRAPH),
        ("pending_graph", layout::PENDING_GRAPH),
        ("pending_activate_at", layout::PENDING_ACTIVATE_AT),
        ("pending_operator", layout::PENDING_OPERATOR),
        ("activated_at", layout::ACTIVATED_AT),
        ("frozen", layout::FROZEN),
        ("operator", layout::OPERATOR),
        ("auth_marks", layout::AUTH_MARKS),
        ("seq", layout::SEQ),
        ("ref_sqrt_price", layout::REF_SQRT_PRICE),
        ("ref_updated_at", layout::REF_UPDATED_AT),
        ("ref_allowance", layout::REF_ALLOWANCE),
        ("ref_allowance_at", layout::REF_ALLOWANCE_AT),
        ("observations", layout::OBSERVATIONS),
        ("tip_epoch_start", layout::TIP_EPOCH_START),
        ("tips_in_epoch", layout::TIPS_IN_EPOCH),
        ("nodes", layout::NODES),
        ("active_auth", layout::ACTIVE_AUTH),
        ("active_activate_at", layout::ACTIVE_ACTIVATE_AT),
        ("partial_spent", layout::PARTIAL_SPENT),
    ] {
        assert_eq!(offsets[name], at, "{name}");
    }
    assert_eq!(offsets.len(), 26);
    assert_eq!(
        idl_size(&idl, &serde_json::json!({"defined": {"name": "AuthMark"}})),
        layout::AUTH_MARK_LEN
    );
    assert_eq!(
        idl_size(&idl, &serde_json::json!({"defined": {"name": "ObsBucket"}})),
        layout::OBS_BUCKET_LEN
    );
    assert_eq!(
        idl_size(
            &idl,
            &serde_json::json!({"defined": {"name": "NodeRecord"}})
        ),
        layout::NODE_RECORD_LEN
    );
    // GraphRecord: version, bump, launch, graph_hash, then the bytes.
    let graph = idl_layout(&idl, "GraphRecord", 8);
    assert_eq!(
        graph
            .iter()
            .map(|(n, at, size)| (n.as_str(), *at, *size))
            .collect::<Vec<_>>(),
        [
            ("version", 8, 1),
            ("bump", 9, 1),
            ("launch", 10, 32),
            ("graph_hash", 42, 32),
            ("bytes", 74, 4),
        ]
    );
    assert_eq!(GraphRecord::HEADER_LEN, 78);
    assert_eq!(GraphRecord::space(100), 178);
}

/// `GraphRecord`'s codec is Anchor's, on random records, truncated and
/// extended data and random data.
#[test]
fn graph_record_codec_is_anchors() {
    let mut r = Rng(3);
    for round in 0..3_000 {
        let len = r.pick(&[0usize, 1, 44, 92, 300, 2_044, 2_100]);
        let record = GraphRecord {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            graph_hash: r.array(),
            bytes: r.bytes(len),
        };
        let anchor = anchor_bytes(&record);
        assert_eq!(anchor.len(), GraphRecord::space(len));
        let mut ours = vec![0u8; anchor.len()];
        assert!(record.write(&mut ours), "round {round}");
        assert_eq!(anchor, ours, "round {round}");
        assert!(!record.write(&mut ours[..anchor.len() - 1]));
        assert_eq!(GraphRecord::read(&ours).as_ref(), Some(&record));
        let mut data = anchor.clone();
        match r.below(4) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(40)),
            2 => {
                let at = 74 + r.below(4) as usize;
                data[at] = r.byte();
            }
            _ => data = [anchor[..8].to_vec(), r.some_bytes(200)].concat(),
        }
        let theirs = if data.len() < 8 {
            None
        } else {
            GraphRecord::try_deserialize(&mut &data[..]).ok()
        };
        assert_eq!(GraphRecord::read(&data), theirs, "round {round}");
    }
}

// ---------------------------------------------------------------- events

/// The events are Anchor's `emit!` payloads: discriminator, then Borsh;
/// their lengths are the IDL layouts'.
#[test]
fn events_match_anchor_and_the_idl() {
    let idl = idl();
    let mut r = Rng(4);
    let len = |name: &str| {
        idl_layout(&idl, name, 8)
            .last()
            .map(|(_, at, size)| at + size)
            .unwrap()
    };
    let wide = |r: &mut Rng| (u128::from(r.next()) << 64) | u128::from(r.next());
    for _ in 0..1_000 {
        let e = AutopilotInitialized {
            autopilot: r.key(),
            launch: r.key(),
            treasury: r.key(),
            ref_sqrt_price: wide(&mut r),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("AutopilotInitialized"));
        let e = MintBound {
            autopilot: r.key(),
            mint: r.key(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("MintBound"));
        let e = PoolBound {
            autopilot: r.key(),
            damm_pool: r.key(),
            damm_config: r.key(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("PoolBound"));
        let e = GraphPublished {
            launch: r.key(),
            graph: r.key(),
            graph_hash: r.array(),
            len: r.next() as u16,
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("GraphPublished"));
        let e = GraphQueued {
            autopilot: r.key(),
            graph_hash: r.array(),
            activate_at: r.next() as i64,
            authorization: r.key(),
            operator: r.key(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("GraphQueued"));
        let e = GraphActivated {
            autopilot: r.key(),
            graph_hash: r.array(),
            operator: r.key(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("GraphActivated"));
        let e = GraphFrozen {
            autopilot: r.key(),
            graph_hash: r.array(),
            cancelled: r.array(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("GraphFrozen"));
        let e = OperatorRevoked {
            autopilot: r.key(),
            operator: r.key(),
            pending_cleared: r.chance(50),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("OperatorRevoked"));
        let e = NodeRan {
            autopilot: r.key(),
            node: r.byte(),
            action: r.byte(),
            seq: r.next(),
            spent: r.next(),
            bought: r.next(),
            burned: r.next(),
            tip: r.next(),
            caller: r.key(),
            spot_sqrt_price: wide(&mut r),
            ref_sqrt_price: wide(&mut r),
            partial: r.chance(50),
            skipped: r.byte(),
            kept: r.next(),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("NodeRan"));
        let e = ReferencePriceUpdated {
            autopilot: r.key(),
            old_sqrt_price: wide(&mut r),
            new_sqrt_price: wide(&mut r),
            spot_sqrt_price: wide(&mut r),
        };
        assert_eq!(e.data(), e.log_data());
        assert_eq!(e.log_data().len(), len("ReferencePriceUpdated"));
    }
    assert_eq!(NodeRan::LEN, 8 + 148);
}

// ------------------------------------------------------------- arguments

/// The program's argument decoders read Borsh as Anchor's dispatcher did
/// (`deserialize` from the data after the discriminator: trailing bytes
/// ignored, short input or a bad `Option` tag refused), on valid,
/// truncated, extended and random data; and the IDL's argument lists are
/// those.
#[test]
fn argument_decoding_matches_borsh() {
    let idl = idl();
    let args = |name: &str| -> Vec<(String, String)> {
        find(&idl["instructions"], name)["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| (a["name"].as_str().unwrap().into(), a["type"].to_string()))
            .collect()
    };
    assert_eq!(
        args("run"),
        [
            ("node".into(), "\"u8\"".into()),
            ("amount".into(), "{\"option\":\"u64\"}".into())
        ]
    );
    assert_eq!(
        args("publish_graph"),
        [("bytes".into(), "\"bytes\"".into())]
    );
    assert_eq!(args("activate"), [("activate_at".into(), "\"i64\"".into())]);
    assert_eq!(args("freeze"), [("not_after".into(), "\"i64\"".into())]);
    for name in [
        "init_autopilot",
        "bind_mint",
        "bind_pool",
        "apply_pending",
        "revoke_operator",
        "update_price",
    ] {
        assert!(args(name).is_empty(), "{name}");
    }

    let mut r = Rng(5);
    for round in 0..20_000 {
        let run = instruction::Run {
            node: r.byte(),
            amount: r.chance(50).then(|| r.next()),
        };
        let mut data = run.data()[8..].to_vec();
        match r.below(5) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(10)),
            2 if data.len() > 1 => data[1] = r.byte() % 4,
            3 => data = r.some_bytes(12),
            _ => {}
        }
        let borsh = instruction::Run::deserialize(&mut &data[..])
            .ok()
            .map(|a| (a.node, a.amount));
        assert_eq!(borsh, instructions::run::parse_args(&data), "round {round}");

        let publish = instruction::PublishGraph {
            bytes: r.some_bytes(300),
        };
        let mut data = publish.data()[8..].to_vec();
        match r.below(4) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(10)),
            2 => data[..4].copy_from_slice(&(r.next() as u32 % 400).to_le_bytes()),
            _ => {}
        }
        let borsh = instruction::PublishGraph::deserialize(&mut &data[..])
            .ok()
            .map(|a| a.bytes);
        assert_eq!(
            borsh.as_deref(),
            instructions::publish_graph::parse_args(&data),
            "round {round}"
        );

        let at = r.next() as i64;
        let mut data = instruction::Activate { activate_at: at }.data()[8..].to_vec();
        if r.chance(30) {
            data.truncate(r.below(9) as usize);
        } else if r.chance(30) {
            data.extend(r.some_bytes(5));
        }
        let borsh = i64::deserialize(&mut &data[..]).ok();
        assert_eq!(
            borsh,
            instructions::governance::parse_i64(&data).ok(),
            "round {round}"
        );
        assert_eq!(
            instruction::Freeze { not_after: at }.data()[8..],
            at.to_le_bytes()
        );
        let _ = take_logs();
    }
    // Instructions without arguments ignore whatever follows.
    for data in [
        instruction::InitAutopilot.data(),
        instruction::BindMint.data(),
        instruction::BindPool.data(),
        instruction::ApplyPending.data(),
        instruction::RevokeOperator.data(),
        instruction::UpdatePrice.data(),
    ] {
        assert_eq!(data.len(), 8);
    }
}

// ---------------------------------------------------------------- errors

/// The program's numbers, names and messages are the IDL's
/// (AutopilotError) and anchor-lang 1.2.1's (framework errors), and no
/// other number is logged.
#[test]
fn error_table_matches_anchor_and_the_idl() {
    use error::AutopilotError::*;
    for (e, n) in [
        (NotALaunch, 6000),
        (InvalidAuthorization, 6008),
        (Frozen, 6010),
        (PoolAlreadyBound, 6039),
        (FreezeExpired, 6040),
        (RemainderTooSmall, 6041),
        (NoRecipientAccount, 6042),
    ] {
        assert_eq!(u32::from(e), n);
        assert_eq!(e as u32 + 6000, n);
        assert_eq!(e.name(), format!("{e:?}"));
    }
    let idl_errors = idl()["errors"].as_array().unwrap().clone();
    assert_eq!(idl_errors.len(), 43);
    for (i, e) in idl_errors.iter().enumerate() {
        let code = e["code"].as_u64().unwrap() as u32;
        assert_eq!(code, 6000 + i as u32);
        assert_eq!(
            error::name_and_message(code),
            (e["name"].as_str().unwrap(), e["msg"].as_str().unwrap())
        );
        let variant = error::AutopilotError::ERRORS[i];
        assert_eq!(
            (variant.0, variant.1, variant.2),
            (
                code,
                e["name"].as_str().unwrap(),
                e["msg"].as_str().unwrap()
            )
        );
    }

    let framework = [
        ErrorCode::InstructionFallbackNotFound,
        ErrorCode::InstructionDidNotDeserialize,
        ErrorCode::EventInstructionStub,
        ErrorCode::ConstraintMut,
        ErrorCode::ConstraintOwner,
        ErrorCode::ConstraintRentExempt,
        ErrorCode::ConstraintSeeds,
        ErrorCode::ConstraintAssociated,
        ErrorCode::ConstraintTokenMint,
        ErrorCode::ConstraintTokenOwner,
        ErrorCode::ConstraintSpace,
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
}

/// The program's `fail_values` is `noised_onchain`'s (which `publish_graph`'s
/// `init_if_needed` calls): `Left: <n>` / `Right: <n>` in decimal after the
/// error line, as Anchor's `with_values` logs them, for any numbers.
#[test]
fn fail_values_logs_as_the_shared_helper() {
    type P = noised_autopilot::program::NoisedAutopilot;
    let mut r = Rng(6);
    let _ = take_logs();
    for round in 0..5_000 {
        let (left, right) = match r.below(4) {
            0 => (r.next(), r.next()),
            1 => (r.below(10), r.below(1_000)),
            2 => (u64::MAX, 0),
            _ => (r.next() >> r.below(64), 10u64.pow(r.below(20) as u32)),
        };
        let account = r.chance(50).then_some("graph");
        let ours = error::fail_values(
            anchor_lang::error::ErrorCode::ConstraintSpace.into(),
            account,
            left,
            right,
        );
        let ours_logs = take_log_lines();
        let theirs = noised_onchain::error::fail_values::<P>(
            anchor_lang::error::ErrorCode::ConstraintSpace.into(),
            account,
            left,
            right,
        );
        assert_eq!(ours, theirs, "round {round}");
        assert_eq!(ours_logs, take_log_lines(), "round {round}");
        assert_eq!(ours_logs.len(), 3);
        assert_eq!(ours_logs[1], format!("Program log: Left: {left}"));
        assert_eq!(ours_logs[2], format!("Program log: Right: {right}"));
    }
}

// ---------------------------------------------------------------- integer

/// `int::div_euclid` / `int::rem_euclid` are the standard library's, for
/// every dividend and every positive divisor (the program's: the bucket
/// length and the tip epoch).
#[test]
fn euclid_division_matches_std() {
    let mut r = Rng(7);
    let edges = [
        i64::MIN,
        i64::MIN + 1,
        -86_401,
        -86_400,
        -86_399,
        -901,
        -900,
        -899,
        -1,
        0,
        1,
        899,
        900,
        901,
        86_399,
        86_400,
        86_401,
        i64::MAX - 1,
        i64::MAX,
    ];
    for b in [1i64, 2, 7, 900, 86_400, i64::MAX] {
        for a in edges {
            assert_eq!(int::div_euclid(a, b), a.div_euclid(b), "{a} / {b}");
            assert_eq!(int::rem_euclid(a, b), a.rem_euclid(b), "{a} % {b}");
        }
    }
    for _ in 0..200_000 {
        let a = match r.below(3) {
            0 => r.next() as i64,
            1 => (r.next() as i64) >> r.below(64),
            _ => r.below(4_000_000) as i64 - 2_000_000,
        };
        let b = match r.below(3) {
            0 => r.pick(&[OBS_BUCKET_SECS, TIP_EPOCH_SECS]),
            1 => 1 + r.below(100_000) as i64,
            _ => 1 + (r.next() >> 1) as i64 % i64::MAX,
        };
        assert_eq!(int::div_euclid(a, b), a.div_euclid(b), "{a} / {b}");
        assert_eq!(int::rem_euclid(a, b), a.rem_euclid(b), "{a} % {b}");
    }
    // Non-positive divisors fall back to the standard library.
    assert_eq!(int::div_euclid(-7, -2), (-7i64).div_euclid(-2));
    assert_eq!(int::rem_euclid(-7, -2), (-7i64).rem_euclid(-2));
}

// ------------------------------------------------------------------ CPIs

fn host(key: Pubkey, owner: Pubkey, writable: bool) -> HostAccount {
    HostAccount::new(key, owner, 1, &[], false, writable, false)
}

/// The CPIs the treasury signs are the instructions the Anchor build built:
/// SPL Token `transfer_checked` of wSOL, Token-2022 `burn_checked`, and
/// DAMM v2's `swap` (accounts in the client's order, the referral left
/// out as the program id), each signed by one PDA.
#[test]
fn cpis_are_the_anchor_builds() {
    use anchor_lang::solana_program::instruction::Instruction;
    let mut r = Rng(8);
    let flat = |ix: &Instruction| {
        (
            ix.program_id,
            ix.accounts
                .iter()
                .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                .collect::<Vec<_>>(),
            ix.data.clone(),
        )
    };
    let recorded = || {
        let cpis = take_cpis();
        assert_eq!(cpis.len(), 1);
        let c = &cpis[0];
        assert_eq!(c.signers, 1);
        (c.program_id, c.accounts.clone(), c.data.clone())
    };
    for _ in 0..200 {
        let keys: Vec<Pubkey> = (0..14).map(|_| r.key()).collect();
        let accts: Vec<HostAccount> = keys
            .iter()
            .map(|k| host(*k, TOKEN_PROGRAM_ID, true))
            .collect();
        let v: Vec<_> = accts.iter().map(HostAccount::view).collect();
        let seed = [r.byte()];
        let seeds = [noised_onchain::Seed::from(&seed[..])];
        let signers = [noised_onchain::Signer::from(&seeds)];
        let amount = r.next();

        // transfer_wsol(token_program, from, wsol_mint, to, authority, ..)
        cpi::transfer_wsol(&v[0], &v[1], &v[2], &v[3], &v[4], amount, &signers).unwrap();
        let spl = spl_token_2022::instruction::transfer_checked(
            &anchor_spl::token::ID,
            &keys[1],
            &keys[2],
            &keys[3],
            &keys[4],
            &[],
            amount,
            WSOL_DECIMALS,
        )
        .unwrap();
        assert_eq!(recorded(), flat(&spl));

        // burn(token_2022_program, from, mint, authority, amount, decimals)
        let decimals = r.byte();
        cpi::burn(&v[0], &v[1], &v[2], &v[3], amount, decimals, &signers).unwrap();
        let spl = spl_token_2022::instruction::burn_checked(
            &anchor_spl::token_2022::ID,
            &keys[1],
            &keys[2],
            &keys[3],
            &[],
            amount,
            decimals,
        )
        .unwrap();
        assert_eq!(recorded(), flat(&spl));

        // damm_swap: the cp_amm client's `swap` with no referral.
        let min_out = r.next();
        cpi::damm_swap(
            &cpi::DammSwap {
                pool_authority: &v[0],
                pool: &v[1],
                input: &v[2],
                output: &v[3],
                token_a_vault: &v[4],
                token_b_vault: &v[5],
                token_a_mint: &v[6],
                token_b_mint: &v[7],
                payer: &v[8],
                token_a_program: &v[9],
                token_b_program: &v[10],
                event_authority: &v[11],
                program: &v[12],
            },
            amount,
            min_out,
            &signers,
        )
        .unwrap();
        use noised_launchpad::cp_amm::client::{accounts as amm, args};
        let mut metas = amm::Swap {
            pool_authority: keys[0],
            pool: keys[1],
            input_token_account: keys[2],
            output_token_account: keys[3],
            token_a_vault: keys[4],
            token_b_vault: keys[5],
            token_a_mint: keys[6],
            token_b_mint: keys[7],
            payer: keys[8],
            token_a_program: TOKEN_2022_PROGRAM_ID,
            token_b_program: TOKEN_PROGRAM_ID,
            referral_token_account: None,
            event_authority: keys[11],
            program: DAMM_V2_PROGRAM_ID,
        }
        .to_account_metas(None);
        // The payer signs (the treasury PDA, through the CPI's signer).
        metas[8].is_signer = true;
        let swap = Instruction {
            program_id: DAMM_V2_PROGRAM_ID,
            accounts: metas,
            data: args::Swap {
                _params: noised_launchpad::cp_amm::types::SwapParameters {
                    amount_in: amount,
                    minimum_amount_out: min_out,
                },
            }
            .data(),
        };
        assert_eq!(recorded(), flat(&swap));
        assert_eq!(cpi::damm_swap_data(amount, min_out).to_vec(), swap.data);
    }
    let _ = take_logs();
}

// ------------------------------------------------------------- dispatch

/// Dispatch and argument decoding happen as in Anchor's `entry`: the
/// program id first (`DeclaredProgramIdMismatch`), then the discriminator
/// (`InstructionFallbackNotFound`, the event-CPI tag `EventInstructionStub`),
/// then `Instruction: <Name>` and the arguments
/// (`InstructionDidNotDeserialize`), then the first account
/// (`AccountNotEnoughKeys`, named after the field, or naming none for an
/// `init` field).
#[test]
fn dispatch_and_first_checks_are_anchors() {
    let run = |program: &Pubkey, data: &[u8]| {
        let _ = take_logs();
        let result = processor::process_instruction(program, &mut [], data);
        (result, take_log_lines())
    };
    let custom = |n: u32| Err(noised_onchain::ProgramError::Custom(n));
    let other = Pubkey::new_from_array([7; 32]);
    let (result, logs) = run(&other, &discriminator::RUN);
    assert_eq!(result, custom(4100));
    assert!(logs[0].contains("Error Code: DeclaredProgramIdMismatch. Error Number: 4100."));
    for short in [&[][..], &[1, 2, 3], &discriminator::RUN[..7]] {
        assert_eq!(run(&ID, short).0, custom(101));
    }
    assert_eq!(run(&ID, &[0xAB; 8]).0, custom(101));
    let (result, logs) = run(&ID, &discriminator::EVENT_IX_TAG_LE);
    assert_eq!(result, custom(1500));
    assert!(logs[0].contains("EventInstructionStub"));

    // Arguments before accounts.
    for (disc, name) in [
        (discriminator::RUN, "Run"),
        (discriminator::PUBLISH_GRAPH, "PublishGraph"),
        (discriminator::ACTIVATE, "Activate"),
        (discriminator::FREEZE, "Freeze"),
    ] {
        let (result, logs) = run(&ID, &disc);
        assert_eq!(result, custom(102), "{name}");
        assert_eq!(logs[0], format!("Program log: Instruction: {name}"));
        assert!(logs[1].starts_with(
            "Program log: AnchorError occurred. Error Code: InstructionDidNotDeserialize."
        ));
    }
    // The first account, by name.
    for (data, name, field) in [
        (
            instruction::InitAutopilot.data(),
            "InitAutopilot",
            Some("payer"),
        ),
        (instruction::BindMint.data(), "BindMint", Some("payer")),
        (instruction::BindPool.data(), "BindPool", Some("autopilot")),
        (
            instruction::PublishGraph { bytes: vec![1] }.data(),
            "PublishGraph",
            Some("payer"),
        ),
        (
            instruction::Activate { activate_at: 5 }.data(),
            "Activate",
            Some("autopilot"),
        ),
        (
            instruction::ApplyPending.data(),
            "ApplyPending",
            Some("autopilot"),
        ),
        (
            instruction::Freeze { not_after: 5 }.data(),
            "Freeze",
            Some("autopilot"),
        ),
        (
            instruction::RevokeOperator.data(),
            "RevokeOperator",
            Some("autopilot"),
        ),
        (
            instruction::Run {
                node: 0,
                amount: None,
            }
            .data(),
            "Run",
            Some("caller"),
        ),
        (
            instruction::UpdatePrice.data(),
            "UpdatePrice",
            Some("autopilot"),
        ),
    ] {
        let (result, logs) = run(&ID, &data);
        assert_eq!(result, custom(3005), "{name}");
        assert_eq!(logs[0], format!("Program log: Instruction: {name}"));
        let origin = field.map_or("occurred".to_string(), |f| {
            format!("caused by account: {f}")
        });
        assert!(
            logs[1].starts_with(&format!("Program log: AnchorError {origin}. Error Code: AccountNotEnoughKeys. Error Number: 3005.")),
            "{name}: {}",
            logs[1]
        );
    }
}
