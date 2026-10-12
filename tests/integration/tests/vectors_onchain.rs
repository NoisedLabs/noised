//! The SDK vector files, executed by the program builds: the bytes the SDK's
//! tests must reproduce are bytes the programs accept, and what the
//! programs write is what the vectors say they write.
//!
//! * `vectors/vault_withdraw.json` on the vault build. Every stored
//!   withdrawal installs the key of the next position (`q = sequence + 1`,
//!   audit round 2, amendment A11), so none became unexecutable with the
//!   key-index binding. Each case's own `open_vault` instruction opens the
//!   vault at the case's mint address; real withdrawals of the case's key
//!   chain walk it to the case's sequence; then the exact `v1Withdraw` wire
//!   bytes execute and the case's `release` instruction delivers the payout.
//!   In a second ledger the exact `v1WithdrawRelease` bytes do both at once.
//! * `vectors/lms.json` on the launchpad build (PQ v2). The exact
//!   attestation transaction lands, paid by its throwaway fee payer funded
//!   with exactly the two rents and one signature fee, and writes the
//!   `Identity` and `Attestation` accounts and the `LaunchAttested` event byte
//!   for byte as the vectors state (message v3, no creator rules); the other vector signatures only burn
//!   their leaves (`PqLeafConsumed`), leaving the bitmap the vectors' leaf
//!   selection starts from; a re-broadcast fails `PqLeafUsed`. Every
//!   rejection case is refused with the error the vectors name and writes
//!   nothing. Every burn-only case (a valid signature `launch` could never
//!   use) lands, burns its leaf and leaves the attestation empty, and the
//!   launch is attested afterwards. All 1,024 leaves of the vector identity
//!   land exactly once, each under the compute target, and then the identity
//!   is exhausted.
//! * `vectors/metadata.json` on the launchpad build: every record publishes
//!   to the vectors' account bytes and event (idempotently), and every
//!   invalid record is refused with the vectors' error.
//!
//! The launch is placed with `set_account` from the vectors' `Launch` v2
//! bytes (at `["launch", creator, seed]`), its metadata record from the
//! vectors' `TokenMeta` bytes (at `["metadata", launch, metadataHash]`), and
//! the clock is set to the vectors' landing time: `attest_launch` reads only
//! the launch's creator, `params_hash` and `pq_identity` (a wrong offset
//! would change the message the program rebuilds, and the signature would
//! not verify), the record's fixed fields (whether it is the record the
//! signed hash names) and the clock (whether the signed window can still
//! open). `create_launch`, `publish_metadata`, the gating of `launch` on the
//! attestation and its window belong to the launchpad suite.

mod common;

use std::str::FromStr;

use common::{
    hook::HOOK_ID,
    launchpad::{
        apply_patch, attest_launch_ix, attest_tx_config, attestation_message,
        identity_account_data, identity_id, identity_pda, launch_pda, launchpad_error,
        leaf_probe_start, leaf_used, metadata_hash, next_free_leaf, pq_leaf_consumed_event,
        token_meta_account_data, token_meta_pda, unhex, Metadata, Terms, ATTESTATION_ACCOUNT_LEN,
        ATTESTATION_VERSION, ATTEST_CU_LIMIT, ATTEST_CU_TARGET, ATTEST_LOADED_ACCOUNTS_DATA_LIMIT,
        IDENTITY_ACCOUNT_LEN, LAUNCH_CREATOR_OFFSET, LAUNCH_PARAMS_HASH_OFFSET, LEAF_BITMAP_LEN,
        PQ_LEAF_USED,
    },
    svm::{anchor_events, program_cu, report, tx_from_wire, TxExpect},
    vault::{sign_withdraw, withdraw_ix, PqKey, CLUSTER_LOCALNET},
    AccountMeta, Harness, Instruction, Keypair, Pubkey, Signer, LAMPORTS_PER_SOL,
    LAUNCHPAD_PROGRAM_ID,
};
use noised_lmots::{lms_verify, LmsPrivateKey, Sha2, LMS_LEAVES, LMS_PUBLIC_KEY_LEN};
use noised_vault::state::{next_key_index, GENESIS_KEY_INDEX};
use serde_json::Value;
use solana_transaction_error::TransactionError;

const VAULT_VECTORS: &str = "vectors/vault_withdraw.json";
const LMS_VECTORS: &str = "vectors/lms.json";
const METADATA_VECTORS: &str = "vectors/metadata.json";
const DECIMALS: u8 = 6;
/// More than the SPL Token case's `maxAmount`; the Token-2022 case takes it all.
const VAULT_DEPOSIT: u64 = 5_000_000_000;
/// Fee of a transaction with one signature and no priority fee.
const SIGNATURE_FEE: u64 = 5_000;

fn load(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (see tests/sdk_vectors.rs, tests/lms_vectors.rs)",
            path.display()
        )
    });
    serde_json::from_str(&text).expect("vector JSON")
}

fn address(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().expect("an address")).expect("base58 address")
}

fn bytes(v: &Value) -> Vec<u8> {
    unhex(v.as_str().expect("hex bytes"))
}

fn array<const L: usize>(v: &Value) -> [u8; L] {
    bytes(v).try_into().expect("byte length")
}

/// A u64 written as a JSON number or, beyond 2^53, as a decimal string.
fn number(v: &Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .expect("a u64")
}

fn instruction(v: &Value) -> Instruction {
    Instruction {
        program_id: address(&v["programId"]),
        accounts: v["accounts"]
            .as_array()
            .expect("accounts")
            .iter()
            .map(|m| AccountMeta {
                pubkey: address(&m["pubkey"]),
                is_signer: m["isSigner"].as_bool().expect("isSigner"),
                is_writable: m["isWritable"].as_bool().expect("isWritable"),
            })
            .collect(),
        data: bytes(&v["data"]),
    }
}

/// The vault of withdrawal vector `case`, opened, funded and walked to the
/// case's sequence, in a ledger of its own.
struct VaultVector {
    h: Harness,
    fee_payer: Keypair,
    vault: Pubkey,
}

fn vault_vector(case: &Value) -> VaultVector {
    let name = case["name"].as_str().expect("name");
    let inputs = &case["inputs"];
    assert_eq!(inputs["cluster"], u64::from(CLUSTER_LOCALNET), "{name}");
    let token_program = address(&inputs["tokenProgram"]);
    let mint = address(&inputs["mint"]);
    let hooked = inputs["hook"].as_bool().expect("hook");
    let master: [u8; 64] = array(&inputs["master"]);
    let account = u32::try_from(number(&inputs["account"])).expect("u32 account");
    let sequence = number(&inputs["sequence"]);
    let fee_payer = Keypair::new_from_array(array(&inputs["feePayerSeed"]));
    assert_eq!(fee_payer.pubkey(), address(&inputs["feePayer"]), "{name}");

    let mut h = Harness::new();
    // A mint's data holds no address of its own, so a fresh mint of the same
    // token program (with the Launch Guard hook for the hooked case) placed
    // at the case's address is that mint; the harness payer can mint it.
    let template = h.create_mint(token_program, DECIMALS, hooked.then_some(HOOK_ID));
    let template = h.account(&template).expect("template mint");
    h.set_account(mint, template);
    if hooked {
        h.init_meta_list(&mint);
    }
    h.airdrop(&fee_payer.pubkey(), LAMPORTS_PER_SOL);
    h.send(&[instruction(&case["openVaultIx"])], &[&fee_payer])
        .expect_ok(&format!("{name}: the vector's open_vault"));
    let vault = address(&case["addresses"]["vault"]);
    let genesis: [u8; 32] = array(&case["genesisKey"]["keyId"]);
    assert_eq!(h.vault_state(&vault).genesis_key_id, genesis, "{name}");
    h.mint_to(
        &mint,
        &address(&case["addresses"]["vaultTokenAccount"]),
        VAULT_DEPOSIT,
    );

    // Rotate-only withdrawals by the case's own key chain (SPEC §3.10).
    let walker = Pubkey::new_unique();
    for s in 0..sequence {
        let index = u32::try_from(s).expect("a small sequence");
        let key = PqKey::derive(&master, &mint, account, index);
        let next = PqKey::derive(&master, &mint, account, index + 1);
        let args = sign_withdraw(&key, &next, &vault, &mint, s, &walker, 0);
        let payer = h.payer.pubkey();
        let ix = withdraw_ix(&payer, &mint, &token_program, &vault, s, &args);
        h.send_v1(&[ix], &[])
            .expect_ok(&format!("{name}: rotate to sequence {}", s + 1));
    }
    let state = h.vault_state(&vault);
    let key_id: [u8; 32] = array(&case["key"]["keyId"]);
    assert_eq!(
        (state.sequence, state.key_id, u64::from(state.key_q)),
        (sequence, key_id, number(&case["key"]["q"])),
        "{name}: the vault is at the case's sequence, under the case's key"
    );
    VaultVector {
        h,
        fee_payer,
        vault,
    }
}

/// Amendment A11: every stored signed withdrawal names the key of the next
/// position, so it stays executable under the round-2 key-index binding;
/// each one executes as the exact bytes the SDK compares against.
#[test]
fn vault_vectors_execute_on_the_vault_build() {
    let vectors = load(VAULT_VECTORS);
    let cases = vectors["withdrawals"].as_array().expect("withdrawals");
    assert_eq!(cases.len(), 2);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let inputs = &case["inputs"];
        let sequence = number(&inputs["sequence"]);
        assert_eq!(
            number(&case["genesisKey"]["q"]),
            u64::from(GENESIS_KEY_INDEX)
        );
        assert_eq!(number(&case["key"]["q"]), sequence, "{name}");
        assert_eq!(
            u32::try_from(number(&case["nextKey"]["q"])).ok(),
            next_key_index(sequence),
            "{name}: the next key's position"
        );
        let amount = number(&inputs["maxAmount"]).min(VAULT_DEPOSIT);
        let destination_owner = address(&inputs["destinationOwner"]);
        let destination = address(&case["addresses"]["destination"]);
        let payout = address(&case["addresses"]["payout"]);
        let next_key_id: [u8; 32] = array(&case["nextKey"]["keyId"]);

        // The withdrawal alone, then the case's release.
        let mut w = vault_vector(case);
        let sent =
            w.h.submit_any_blockhash(tx_from_wire(&bytes(&case["v1Withdraw"]["wire"])))
                .expect_ok(&format!("{name}: the vector's v1Withdraw bytes"));
        report(
            &format!("vault vector {name}: v1Withdraw size / CU"),
            format!("{} B / {}", sent.size, sent.cu),
        );
        let s = w.h.vault_state(&w.vault);
        assert_eq!(
            (s.sequence, s.key_id, u64::from(s.key_q), s.reserved),
            (sequence + 1, next_key_id, sequence + 1, amount),
            "{name}"
        );
        let p = w.h.payout_state(&payout);
        assert_eq!(
            (p.sequence, p.destination_owner, p.amount, p.rent_payer),
            (sequence, destination_owner, amount, w.fee_payer.pubkey()),
            "{name}"
        );
        let fee_payer = w.fee_payer.insecure_clone();
        w.h.send(&[instruction(&case["releaseIx"])], &[&fee_payer])
            .expect_ok(&format!("{name}: the vector's release"));
        assert_eq!(w.h.balance(&destination), amount, "{name}");
        assert!(w.h.account(&payout).is_none(), "{name}: the payout closed");
        assert_eq!(w.h.vault_state(&w.vault).reserved, 0, "{name}");

        // Withdraw and release in one transaction.
        let mut both = vault_vector(case);
        both.h
            .submit_any_blockhash(tx_from_wire(&bytes(&case["v1WithdrawRelease"]["wire"])))
            .expect_ok(&format!("{name}: the vector's v1WithdrawRelease bytes"));
        assert_eq!(both.h.balance(&destination), amount, "{name}");
        let s = both.h.vault_state(&both.vault);
        assert_eq!(
            (s.sequence, s.key_id, s.reserved),
            (sequence + 1, next_key_id, 0)
        );
    }
}

/// A ledger with the launchpad build, the vectors' launch and its published
/// metadata record placed at their addresses, and the clock at the vectors'
/// landing time and slot.
fn lms_ledger(v: &Value) -> (Harness, Pubkey) {
    let mut h = Harness::builder()
        .program(LAUNCHPAD_PROGRAM_ID, "noised_launchpad")
        .build();
    let launch = address(&v["accounts"]["launch"]["address"]);
    assert_eq!(launch, address(&v["attestation"]["launch"]));
    let creator = address(&v["attestation"]["creator"]);
    let seed: [u8; 32] = array(&v["attestation"]["launchSeed"]);
    assert_eq!(
        launch_pda(&creator, &seed).0,
        launch,
        "[\"launch\", creator, seed]"
    );
    h.place_launchpad_account(&launch, bytes(&v["accounts"]["launch"]["data"]));
    // The record, as `publish_metadata` writes it (the launchpad suite
    // publishes records; `metadata.json` pins their bytes).
    let meta_bytes = metadata_bytes(&v["metadata"]);
    let meta = metadata(&meta_bytes);
    let hash = metadata_hash(meta);
    assert_eq!(hex_of(&hash), v["metadata"]["hash"]);
    let (record, bump) = token_meta_pda(&launch, &hash);
    let placed = &v["accounts"]["tokenMeta"];
    assert_eq!(record, address(&placed["address"]));
    assert_eq!(u64::from(bump), number(&placed["bump"]));
    assert_eq!(
        bytes(&placed["data"]),
        token_meta_account_data(bump, &launch, meta)
    );
    h.place_launchpad_account(&record, bytes(&placed["data"]));
    h.set_time(signed(&v["attestation"]["landsAt"]));
    h.svm
        .warp_to_slot(number(&v["accounts"]["attestation"]["slot"]));
    (h, launch)
}

/// An i64 written as a JSON number.
fn signed(v: &Value) -> i64 {
    v.as_i64().expect("an i64")
}

/// A record's bytes (name, symbol, uri, document: `nameHex` and the others
/// when given, else the strings) and its flags.
fn metadata_bytes(v: &Value) -> ([Vec<u8>; 4], u8) {
    let strings =
        ["name", "symbol", "uri", "doc"].map(|field| match v.get(format!("{field}Hex")) {
            Some(h) => bytes(h),
            None => v[field]
                .as_str()
                .expect("metadata string")
                .as_bytes()
                .to_vec(),
        });
    let flags = u8::try_from(number(&v["flags"])).expect("flags");
    (strings, flags)
}

fn metadata(m: &([Vec<u8>; 4], u8)) -> Metadata<'_> {
    Metadata {
        name: &m.0[0],
        symbol: &m.0[1],
        flags: m.1,
        uri: &m.0[2],
        doc: &m.0[3],
    }
}

/// The vectors' attestation terms (the window).
fn terms(v: &Value) -> Terms {
    Terms {
        not_before: signed(&v["notBefore"]),
        not_after: signed(&v["notAfter"]),
        rules_hash: array(&v["rulesHash"]),
    }
}

/// The vector signature at leaf `q`.
fn signature_at(v: &Value, q: u64) -> Vec<u8> {
    let entry = v["signatures"]
        .as_array()
        .expect("signatures")
        .iter()
        .find(|s| number(&s["q"]) == q)
        .expect("a vector signature at that leaf");
    bytes(&entry["signature"])
}

/// `attest_launch` from the harness payer, sent as a client sends it (v1,
/// A14 config words).
fn attest(h: &mut Harness, ix: Instruction) -> common::svm::TxResult {
    let tx = h.v1_tx_with(&h.payer, &[ix], &[], attest_tx_config());
    h.submit(tx)
}

#[test]
fn lms_vectors_land_on_the_launchpad_build() {
    let v = load(LMS_VECTORS);
    let (mut h, launch) = lms_ledger(&v);
    let tx_vector = &v["attestLaunch"];
    let payer = Keypair::new_from_array(array(&tx_vector["payerSeed"]));
    assert_eq!(payer.pubkey(), address(&tx_vector["payer"]));
    assert_eq!(
        number(&tx_vector["v1"]["computeUnitLimit"]),
        u64::from(ATTEST_CU_LIMIT)
    );
    let identity = address(&v["accounts"]["identity"]["address"]);
    let attestation = address(&v["accounts"]["attestation"]["address"]);
    assert_eq!(identity, address(&v["identity"]["identityAccount"]));
    assert_eq!(
        attestation,
        address(&v["attestation"]["attestationAccount"])
    );
    let launch_data = h.account(&launch).expect("launch").data;
    assert_eq!(
        hex_of(&launch_data[LAUNCH_CREATOR_OFFSET..LAUNCH_CREATOR_OFFSET + 32]),
        v["attestation"]["creatorBytes"]
    );
    assert_eq!(
        hex_of(&launch_data[LAUNCH_PARAMS_HASH_OFFSET..LAUNCH_PARAMS_HASH_OFFSET + 32]),
        v["attestation"]["paramsHash"]
    );

    // The throwaway fee payer holds exactly what the landing costs.
    let rent = h.rent_exempt(IDENTITY_ACCOUNT_LEN) + h.rent_exempt(ATTESTATION_ACCOUNT_LEN);
    h.airdrop(&payer.pubkey(), rent + SIGNATURE_FEE);
    let tx = tx_from_wire(&bytes(&tx_vector["v1"]["wire"]));
    let loaded = h.loaded_accounts_data_size(&tx);
    let sent = h
        .submit_any_blockhash(tx)
        .expect_ok("the vector's attestation transaction");
    let own_cu = program_cu(&sent.logs, &LAUNCHPAD_PROGRAM_ID);
    report(
        "attest_launch, the vector transaction: size / CU (launchpad) / loaded data",
        format!("{} B / {} ({own_cu}) / {loaded} B", sent.size, sent.cu),
    );
    report(
        "attest_launch rent: identity + attestation (lamports)",
        rent,
    );
    assert!(sent.cu <= ATTEST_CU_TARGET, "{} CU", sent.cu);
    assert!(loaded <= u64::from(ATTEST_LOADED_ACCOUNTS_DATA_LIMIT));
    assert_eq!(sent.fee, SIGNATURE_FEE);
    assert_eq!(h.lamports(&payer.pubkey()), 0, "the payer is left empty");

    for (key, name) in [(identity, "identity"), (attestation, "attestation")] {
        let account = h.account(&key).expect(name);
        assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID, "{name}");
        assert_eq!(
            hex_of(&account.data),
            v["accounts"][name]["data"],
            "{name}: byte for byte as the vectors state"
        );
    }
    assert_eq!(
        anchor_events(&sent.logs, "LaunchAttested"),
        vec![bytes(&v["events"]["launchAttested"]["data"])]
    );
    assert!(anchor_events(&sent.logs, "PqLeafConsumed").is_empty());

    // Every other vector signature lands and only burns its leaf.
    let pk: [u8; LMS_PUBLIC_KEY_LEN] = array(&v["identity"]["publicKey"]);
    let pq_identity: [u8; 32] = array(&v["identity"]["identityId"]);
    let meta_bytes = metadata_bytes(&v["metadata"]);
    let meta = metadata(&meta_bytes);
    let signed_terms = terms(&v["attestation"]);
    let attested = number(&tx_vector["q"]);
    let first = h.account(&attestation).expect("attestation").data;
    let mut leaves = vec![attested];
    for entry in v["signatures"].as_array().expect("signatures") {
        let q = number(&entry["q"]);
        if q == attested {
            continue;
        }
        let payer = h.payer.pubkey();
        let ix = attest_launch_ix(
            &payer,
            &launch,
            &pk,
            &bytes(&entry["signature"]),
            meta,
            &signed_terms,
        );
        let sent = attest(&mut h, ix).expect_ok(&format!("the leaf-{q} signature"));
        report(
            &format!("attest_launch burning leaf {q}: size / CU"),
            format!("{} B / {}", sent.size, sent.cu),
        );
        let leaf = u16::try_from(q).expect("leaf");
        let consumed = anchor_events(&sent.logs, "PqLeafConsumed");
        assert_eq!(
            consumed,
            vec![pq_leaf_consumed_event(&pq_identity, leaf, &launch)]
        );
        if q == number(&v["events"]["pqLeafConsumed"]["leaf"]) {
            assert_eq!(consumed[0], bytes(&v["events"]["pqLeafConsumed"]["data"]));
        }
        assert!(anchor_events(&sent.logs, "LaunchAttested").is_empty());
        assert_eq!(
            h.account(&attestation).expect("attestation").data,
            first,
            "the first attestation stands"
        );
        leaves.push(q);
    }
    assert_eq!(leaves.len(), 5);

    // The bitmap the vectors' leaf selection starts from.
    let data = h.account(&identity).expect("identity").data;
    let used: [u8; LEAF_BITMAP_LEN] = data[66..66 + LEAF_BITMAP_LEN].try_into().unwrap();
    let selection = &v["leafSelection"][1];
    assert_eq!(hex_of(&used), selection["used"]);
    assert_eq!(
        u64::from(u16::from_le_bytes([data[194], data[195]])),
        number(&selection["usedCount"])
    );
    let start = u32::try_from(number(&selection["probeStart"])).unwrap();
    assert_eq!(
        next_free_leaf(&used, start).map(u64::from),
        selection["next"].as_u64()
    );
    let bump = u8::try_from(number(&v["accounts"]["identity"]["bump"])).unwrap();
    assert_eq!(data, identity_account_data(bump, &pk, &used));

    // The landed signature again: its leaf is used. The same bytes again:
    // the runtime's duplicate.
    let payer_key = h.payer.pubkey();
    let again = attest_launch_ix(
        &payer_key,
        &launch,
        &pk,
        &signature_at(&v, attested),
        meta,
        &signed_terms,
    );
    attest(&mut h, again).expect_error(PQ_LEAF_USED, "the landed signature, re-broadcast");
    let f = h
        .submit_any_blockhash(tx_from_wire(&bytes(&tx_vector["v1"]["wire"])))
        .expect_fail("the vector's bytes again");
    assert_eq!(f.err, TransactionError::AlreadyProcessed);
    assert_eq!(h.account(&attestation).expect("attestation").data, first);
}

/// Every rejection case of the vectors fails with the error they name, and
/// writes nothing; the verifier refuses each one too. The untampered inputs
/// then land.
#[test]
fn lms_rejection_vectors_are_refused_by_the_launchpad_build() {
    let v = load(LMS_VECTORS);
    let (mut h, launch) = lms_ledger(&v);
    let pk: [u8; LMS_PUBLIC_KEY_LEN] = array(&v["identity"]["publicKey"]);
    let attested = number(&v["attestLaunch"]["q"]);
    let sig = signature_at(&v, attested);
    let params_hash: [u8; 32] = array(&v["attestation"]["paramsHash"]);
    let creator = address(&v["attestation"]["creator"]);
    let signed_terms = terms(&v["attestation"]);
    let identity = address(&v["accounts"]["identity"]["address"]);
    let attestation = address(&v["accounts"]["attestation"]["address"]);
    let cases = v["rejections"].as_array().expect("rejections");
    assert_eq!(cases.len(), 20);
    let payer = h.payer.pubkey();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let bad_pk: [u8; LMS_PUBLIC_KEY_LEN] = apply_patch(&pk, &case["publicKeyPatch"])
            .try_into()
            .expect("56 bytes");
        let bad_sig = apply_patch(&sig, &case["signaturePatch"]);
        let meta_bytes = metadata_bytes(&case["metadata"]);
        let meta = metadata(&meta_bytes);
        let message = attestation_message(
            &launch,
            &params_hash,
            &creator,
            &metadata_hash(meta),
            &signed_terms,
        );
        assert!(case["verify"].is_null(), "{name}");
        assert_eq!(
            lms_verify::<Sha2>(&bad_pk, &message, &bad_sig),
            None,
            "{name}"
        );
        let error = launchpad_error(case["programError"].as_str().expect("programError"));
        assert_eq!(
            number(&case["programErrorNumber"]),
            u64::from(error.number),
            "{name}"
        );
        let ix = attest_launch_ix(&payer, &launch, &bad_pk, &bad_sig, meta, &signed_terms);
        attest(&mut h, ix).expect_error(error, name);
        let bad_identity = identity_pda(&identity_id(&bad_pk)).0;
        assert!(
            h.account(&identity).is_none()
                && h.account(&bad_identity).is_none()
                && h.account(&attestation).is_none(),
            "{name}: nothing written"
        );
    }
    let meta_bytes = metadata_bytes(&v["metadata"]);
    let ix = attest_launch_ix(
        &payer,
        &launch,
        &pk,
        &sig,
        metadata(&meta_bytes),
        &signed_terms,
    );
    attest(&mut h, ix).expect_ok("the untampered inputs");
    let data = h.account(&attestation).expect("attestation").data;
    assert_eq!(data.len(), ATTESTATION_ACCOUNT_LEN);
    assert_eq!(
        u64::from(u16::from_le_bytes([data[74], data[75]])),
        attested
    );
}

/// The vectors' burn-only cases (the adversarial review's first finding):
/// valid signatures over metadata that can never be a record, over a valid
/// record that was never published, over a window that cannot open, or by
/// another identity of the same phrase each land on the launchpad build,
/// burn exactly their leaf (`PqLeafConsumed` as the vectors state) and
/// attest nothing: the attestation account they leave is the vectors' empty
/// one, and `burnOnly`'s leaves, chosen from each message, never repeat
/// within an identity. A further signature at any of those leaves is
/// refused, and the launch is then attested by a valid signature at the leaf
/// its message probes to.
#[test]
fn burn_only_vectors_land_and_attest_nothing() {
    let v = load(LMS_VECTORS);
    let (mut h, launch) = lms_ledger(&v);
    let burn = &v["burnOnly"];
    assert_eq!(signed(&burn["landsAt"]), h.now());
    let attestation = address(&v["accounts"]["attestation"]["address"]);
    let payer = h.payer.pubkey();
    let cases = burn["cases"].as_array().expect("burn-only cases");
    assert_eq!(cases.len(), 10);
    let mut burned: Vec<([u8; 32], u32)> = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let pk: [u8; LMS_PUBLIC_KEY_LEN] = array(&case["publicKey"]);
        let pq_identity: [u8; 32] = array(&case["identityId"]);
        assert_eq!(identity_id(&pk), pq_identity, "{name}");
        let meta_bytes = metadata_bytes(&case["metadata"]);
        let meta = metadata(&meta_bytes);
        let t = terms(&case["terms"]);
        let sig = bytes(&case["signature"]);
        let q = u32::try_from(number(&case["q"])).expect("leaf");
        assert!(!burned.contains(&(pq_identity, q)), "{name}");
        let ix = attest_launch_ix(&payer, &launch, &pk, &sig, meta, &t);
        assert_eq!(ix.data, bytes(&case["data"]), "{name}");
        assert_eq!(
            ix.accounts[2].pubkey,
            address(&case["identityAccount"]),
            "{name}"
        );
        assert_eq!(
            ix.accounts[4].pubkey,
            address(&case["tokenMetaAccount"]),
            "{name}"
        );
        assert_eq!(
            ix.accounts[6].pubkey,
            address(&case["rulesAccount"]),
            "{name}"
        );
        let sent = attest(&mut h, ix.clone()).expect_ok(name);
        assert_eq!(
            anchor_events(&sent.logs, "PqLeafConsumed"),
            vec![bytes(&case["event"])],
            "{name}"
        );
        assert!(
            anchor_events(&sent.logs, "LaunchAttested").is_empty(),
            "{name}"
        );
        assert_eq!(
            hex_of(&h.account(&attestation).expect("attestation").data),
            burn["emptyAttestation"],
            "{name}: the attestation stays empty"
        );
        let id = h
            .account(&address(&case["identityAccount"]))
            .expect("identity")
            .data;
        let used: [u8; LEAF_BITMAP_LEN] = id[66..66 + LEAF_BITMAP_LEN].try_into().unwrap();
        assert!(leaf_used(&used, q), "{name}");
        attest(&mut h, ix).expect_error(PQ_LEAF_USED, &format!("{name}, again"));
        burned.push((pq_identity, q));
    }

    // The launch's own identity attests it, at the leaf the vectors'
    // message probes to (the first clear one).
    let ident = &v["identity"];
    let master: [u8; 64] = array(&v["derivation"]["master"]);
    let kp = LmsPrivateKey::derive_identity::<Sha2>(&master, CLUSTER_LOCALNET, 0)
        .expect("identity derivation")
        .keygen::<Sha2>();
    let pk = kp.public_key().to_bytes();
    assert_eq!(pk, array::<LMS_PUBLIC_KEY_LEN>(&ident["publicKey"]));
    let message = bytes(&v["attestation"]["message"]);
    let identity = address(&ident["identityAccount"]);
    let id = h.account(&identity).expect("identity").data;
    let used: [u8; LEAF_BITMAP_LEN] = id[66..66 + LEAF_BITMAP_LEN].try_into().unwrap();
    let start = leaf_probe_start(&pk[8..24], &message);
    assert_eq!(
        u64::from(start),
        number(&v["attestation"]["leafProbeStart"])
    );
    let q = next_free_leaf(&used, start).expect("a free leaf");
    let meta_bytes = metadata_bytes(&v["metadata"]);
    let ix = attest_launch_ix(
        &payer,
        &launch,
        &pk,
        &kp.sign_deterministic::<Sha2>(q, &message).expect("sign"),
        metadata(&meta_bytes),
        &terms(&v["attestation"]),
    );
    let sent = attest(&mut h, ix).expect_ok("the launch's attestation after the burns");
    assert_eq!(anchor_events(&sent.logs, "LaunchAttested").len(), 1);
    let data = h.account(&attestation).expect("attestation").data;
    assert_eq!(data[8], ATTESTATION_VERSION, "attested");
    assert_eq!(u32::from(u16::from_le_bytes([data[74], data[75]])), q);
}

/// All 1,024 leaves of the vector identity sign the vectors' message and
/// land on the launchpad build, in probe order from the message's probe
/// start: the first writes the attestation, every later one only burns its
/// leaf, and each needs less than A5's compute target. Then the bitmap is
/// full (`used_count` 1,024), the leaf selection finds nothing, and every
/// leaf is refused (`PqLeafUsed`): an identity signs at most 1,024 times.
#[test]
fn every_leaf_of_the_vector_identity_lands_exactly_once() {
    let v = load(LMS_VECTORS);
    let (mut h, launch) = lms_ledger(&v);
    let ident = &v["identity"];
    let master: [u8; 64] = array(&v["derivation"]["master"]);
    let cluster = u8::try_from(number(&ident["cluster"])).expect("cluster");
    let index = u32::try_from(number(&ident["index"])).expect("identity index");
    let kp = LmsPrivateKey::derive_identity::<Sha2>(&master, cluster, index)
        .expect("identity derivation")
        .keygen::<Sha2>();
    let pk = kp.public_key().to_bytes();
    assert_eq!(pk, array::<LMS_PUBLIC_KEY_LEN>(&ident["publicKey"]));
    let pq_identity: [u8; 32] = array(&ident["identityId"]);
    let message = bytes(&v["attestation"]["message"]);
    let meta_bytes = metadata_bytes(&v["metadata"]);
    let meta = metadata(&meta_bytes);
    let signed_terms = terms(&v["attestation"]);
    let identity = address(&v["accounts"]["identity"]["address"]);
    let attestation = address(&v["accounts"]["attestation"]["address"]);
    let start = u32::try_from(number(&v["attestation"]["leafProbeStart"])).unwrap();
    assert_eq!(start, leaf_probe_start(&pk[8..24], &message));
    let payer = h.payer.pubkey();
    let sign = |q: u32| kp.sign_deterministic::<Sha2>(q, &message).expect("sign");

    let mut cu = Vec::with_capacity(LMS_LEAVES as usize);
    for i in 0..LMS_LEAVES {
        let q = (start + i) % LMS_LEAVES;
        let ix = attest_launch_ix(&payer, &launch, &pk, &sign(q), meta, &signed_terms);
        let sent = attest(&mut h, ix).expect_ok(&format!("leaf {q}"));
        let leaf = u16::try_from(q).unwrap();
        if i == 0 {
            assert_eq!(anchor_events(&sent.logs, "LaunchAttested").len(), 1);
        } else {
            assert_eq!(
                anchor_events(&sent.logs, "PqLeafConsumed"),
                vec![pq_leaf_consumed_event(&pq_identity, leaf, &launch)]
            );
        }
        cu.push(sent.cu);
    }
    let (min, max) = (cu.iter().min().unwrap(), cu.iter().max().unwrap());
    let mean = cu.iter().sum::<u64>() / cu.len() as u64;
    report(
        "attest_launch over all 1,024 leaves: min / mean / max CU",
        format!("{min} / {mean} / {max}"),
    );
    assert!(*max <= ATTEST_CU_TARGET, "{max} CU");

    let data = h.account(&identity).expect("identity").data;
    let used: [u8; LEAF_BITMAP_LEN] = data[66..66 + LEAF_BITMAP_LEN].try_into().unwrap();
    assert_eq!(used, [0xff; LEAF_BITMAP_LEN]);
    assert_eq!(u16::from_le_bytes([data[194], data[195]]), 1024);
    assert_eq!(next_free_leaf(&used, start), None);
    let attested = h.account(&attestation).expect("attestation").data;
    assert_eq!(
        u32::from(u16::from_le_bytes([attested[74], attested[75]])),
        start,
        "the first leaf to land is the attestation's"
    );
    for q in [start, 0, 511, LMS_LEAVES - 1] {
        let ix = attest_launch_ix(&payer, &launch, &pk, &sign(q), meta, &signed_terms);
        attest(&mut h, ix).expect_error(PQ_LEAF_USED, &format!("leaf {q} again"));
    }
    assert_eq!(h.account(&attestation).expect("attestation").data, attested);
}

/// `vectors/metadata.json` on the launchpad build: every record publishes
/// (from a throwaway payer, in a v1 transaction with the attestation's
/// config words) to exactly the vectors' account bytes and
/// `MetadataPublished` event, a second publication of it succeeds without
/// writing (idempotent), and every invalid record is refused with the
/// vectors' error, writing nothing. The launch is the `lms.json` one (the
/// vectors share it), placed as `create_launch` leaves it.
#[test]
fn metadata_vectors_publish_on_the_launchpad_build() {
    let v = load(METADATA_VECTORS);
    let lms = load(LMS_VECTORS);
    let mut h = Harness::builder()
        .program(LAUNCHPAD_PROGRAM_ID, "noised_launchpad")
        .build();
    let launch = address(&v["launch"]["address"]);
    assert_eq!(launch, address(&lms["accounts"]["launch"]["address"]));
    h.place_launchpad_account(&launch, bytes(&lms["accounts"]["launch"]["data"]));
    let payer = Keypair::new();
    h.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL);
    let send = |h: &mut Harness, data: Vec<u8>, record: Pubkey| {
        let ix = Instruction {
            program_id: LAUNCHPAD_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(launch, false),
                AccountMeta::new(record, false),
                AccountMeta::new_readonly(common::SYSTEM_PROGRAM_ID, false),
            ],
            data,
        };
        let tx = h.v1_tx_with(&payer, &[ix], &[], attest_tx_config());
        h.submit(tx)
    };
    for case in v["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let record = address(&case["tokenMeta"]["address"]);
        let meta_bytes = metadata_bytes(&case["record"]);
        let meta = metadata(&meta_bytes);
        assert_eq!(
            token_meta_pda(&launch, &metadata_hash(meta)).0,
            record,
            "{name}"
        );
        let data = bytes(&case["publishData"]);
        let sent = send(&mut h, data.clone(), record).expect_ok(name);
        report(
            &format!("publish_metadata, {name}: size / CU"),
            format!("{} B / {}", sent.size, sent.cu),
        );
        let account = h.account(&record).expect("the record");
        assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID, "{name}");
        assert_eq!(
            hex_of(&account.data),
            case["tokenMeta"]["data"],
            "{name}: byte for byte"
        );
        assert_eq!(account.lamports, h.rent_exempt(account.data.len()));
        assert_eq!(
            anchor_events(&sent.logs, "MetadataPublished"),
            vec![bytes(&case["metadataPublishedEvent"])],
            "{name}"
        );
        // Published again (a retry, or a racing relayer): nothing written.
        let again = send(&mut h, data, record).expect_ok(&format!("{name}, again"));
        assert!(anchor_events(&again.logs, "MetadataPublished").is_empty());
        assert_eq!(h.account(&record).expect("the record"), account, "{name}");
    }
    for case in v["invalid"].as_array().expect("invalid records") {
        let name = case["name"].as_str().expect("name");
        let meta_bytes = metadata_bytes(&case["record"]);
        let record = token_meta_pda(&launch, &metadata_hash(metadata(&meta_bytes))).0;
        let error = launchpad_error(case["error"].as_str().expect("error"));
        assert_eq!(u64::from(error.number), number(&case["errorNumber"]));
        send(&mut h, bytes(&case["publishData"]), record).expect_error(error, name);
        assert!(h.account(&record).is_none(), "{name}: nothing written");
    }
}

fn hex_of(bytes: &[u8]) -> Value {
    Value::String(common::launchpad::hex(bytes))
}
