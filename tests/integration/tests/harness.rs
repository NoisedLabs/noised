//! Self-checks of the shared harness (`tests/common`), so the suites built on
//! it, including the DBC / DAMM v2 end-to-end tests, can rely on it:
//! mainnet dumps load, lookup tables feed v0 transactions, the clock moves,
//! identical instructions are distinct transactions, oversize transactions
//! are refused, v1 wire bytes follow SPEC §3, signatures are verified unless
//! a PDA signer is explicitly emulated, the exact bytes of a vector
//! transaction execute whatever their blockhash (and only those), the
//! loaded-data meter counts programdata, the log parsers read what the
//! runtime prints, the native relay makes exactly the CPI it is given and
//! signs only for PDAs of its own program id, and LiteSVM ships the SPL Memo
//! program the vault calls.

mod common;

use std::str::FromStr;

use base64::Engine as _;
use common::{
    anchor_discriminator, paths,
    relay::{relay_ix, relay_noop_ix, relay_signed_ix},
    svm::{
        anchor_events, invocations_cu, parse_tx, program_cu, report, tx_from_wire,
        v1_wire_per_spec, wire_size, TxExpect, GENESIS_UNIX_TS, MAX_CU_LIMIT, PACKET_DATA_SIZE,
        TRANSACTION_ACCOUNT_BASE_SIZE,
    },
    vault::MEMO_PROGRAM_ID,
    AccountMeta, Harness, Instruction, Keypair, Pubkey, Signer, ATA_PROGRAM_ID, DAMM_V2_PROGRAM_ID,
    DBC_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use solana_instruction::error::InstructionError;
use solana_message::{v1, Hash, Message, VersionedMessage};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

const WSOL: &str = "So11111111111111111111111111111111111111112";

#[test]
fn mainnet_programs_and_account_dumps_load() {
    let mut files: Vec<String> = std::fs::read_dir(paths::fixtures_dir().join("accounts"))
        .expect("accounts fixture dir")
        .map(|e| {
            format!(
                "accounts/{}",
                e.expect("dir entry").file_name().to_string_lossy()
            )
        })
        .collect();
    files.sort();
    assert_eq!(
        files.len(),
        8,
        "7 DAMM v2 migration configs + the wSOL mint: {files:?}"
    );
    let mut builder = Harness::builder()
        .fixture_program(DBC_PROGRAM_ID, "dbc.so")
        .fixture_program(DAMM_V2_PROGRAM_ID, "damm_v2.so");
    for f in &files {
        builder = builder.fixture_account(f);
    }
    let h = builder.build();

    for program in [
        DBC_PROGRAM_ID,
        DAMM_V2_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        ATA_PROGRAM_ID,
        noised_vault::ID,
        noised_hook::ID,
    ] {
        assert!(
            h.account(&program).expect("program account").executable,
            "{program}"
        );
    }
    let wsol = Pubkey::from_str(WSOL).unwrap();
    assert_eq!(h.token_program_of(&wsol), TOKEN_PROGRAM_ID);
    let mint = h.mint_state(&wsol);
    assert_eq!(mint.decimals, 9);
    assert!(mint.mint_authority.is_none() && mint.freeze_authority.is_none());

    let config_discriminator = anchor_discriminator("account", "Config");
    for f in files.iter().filter(|f| !f.contains(WSOL)) {
        let key =
            Pubkey::from_str(f.trim_start_matches("accounts/").trim_end_matches(".json")).unwrap();
        let account = h.account(&key).expect("config loaded");
        assert_eq!(account.owner, DAMM_V2_PROGRAM_ID, "{f}");
        assert_eq!(account.data.len(), 328, "{f}");
        assert_eq!(
            account.data[..8],
            config_discriminator,
            "{f}: DAMM v2 Config"
        );
    }
}

#[test]
fn our_programs_are_sbpf_v3_and_mainnet_dumps_load_as_is() {
    for so in ["noised_vault", "noised_hook", "noised_launchpad"] {
        assert_eq!(paths::elf_e_flags(&paths::program_so(so)), 3, "{so}");
    }
    for dump in [
        "token_2022.so",
        "spl_token.so",
        "associated_token.so",
        "dbc.so",
        "damm_v2.so",
    ] {
        let flags = paths::elf_e_flags(&paths::fixture(dump));
        report(&format!("{dump} ELF e_flags"), flags);
    }
}

#[test]
fn lookup_tables_feed_v0_transactions() {
    let mut h = Harness::new();
    let mint = h.create_mint(TOKEN_PROGRAM_ID, 6, None);
    let alice = h.funded_keypair(1);
    let alice_ata = h.create_ata(&alice.pubkey(), &mint);
    let bob_ata = h.create_ata(&Pubkey::new_unique(), &mint);
    h.mint_to(&mint, &alice_ata, 100);
    let table = h.create_lookup_table(&[mint, bob_ata, alice_ata]);

    let ix = h.transfer_ix(&mint, &alice_ata, &bob_ata, &alice.pubkey(), 40);
    let v0 = h.v0_tx(
        std::slice::from_ref(&ix),
        &[&alice],
        std::slice::from_ref(&table),
        Some(MAX_CU_LIMIT),
    );
    let VersionedMessage::V0(message) = &v0.message else {
        panic!("not v0")
    };
    assert_eq!(message.address_table_lookups.len(), 1);
    assert_eq!(message.address_table_lookups[0].account_key, table.key);
    let legacy = h.legacy_tx(&[ix], &[&alice], Some(MAX_CU_LIMIT));
    report(
        "transfer via lookup table: v0 / legacy bytes",
        format!("{} / {}", wire_size(&v0), wire_size(&legacy)),
    );
    assert!(wire_size(&v0) < wire_size(&legacy));
    h.submit(v0).expect_ok("v0 transfer through the table");
    assert_eq!(h.balance(&bob_ata), 40);

    let ix = h.transfer_ix(&mint, &alice_ata, &bob_ata, &alice.pubkey(), 2);
    h.send_v0(&[ix], &[&alice], &[table]).expect_ok("send_v0");
    assert_eq!(h.balance(&bob_ata), 42);
}

#[test]
fn clock_starts_realistic_and_warps_with_slots() {
    let mut h = Harness::new();
    assert_eq!(h.now(), GENESIS_UNIX_TS);
    let slot = h.clock().slot;
    h.warp(100);
    assert_eq!(
        (h.now(), h.clock().slot),
        (GENESIS_UNIX_TS + 100, slot + 250)
    );
    h.set_time(GENESIS_UNIX_TS + 50);
    assert_eq!(
        (h.now(), h.clock().slot),
        (GENESIS_UNIX_TS + 50, slot + 250),
        "slots never go back"
    );
}

#[test]
fn identical_instructions_are_distinct_transactions() {
    let mut h = Harness::new();
    let to = Pubkey::new_unique();
    let ix = solana_system_interface::instruction::transfer(&h.payer.pubkey(), &to, 1_000_000);
    h.send(std::slice::from_ref(&ix), &[]).expect_ok("first");
    h.send(std::slice::from_ref(&ix), &[])
        .expect_ok("same instruction again");
    h.send_v1(&[ix], &[]).expect_ok("and as a v1 transaction");
    assert_eq!(h.lamports(&to), 3_000_000);
}

/// `submit_any_blockhash` runs the exact bytes of a vector transaction,
/// whose blockhash is fixed, for that transaction only: signatures are
/// still verified, the age check is back on afterwards, and the same bytes
/// a second time are the runtime's duplicate. `tx_from_wire` takes exactly
/// one transaction's bytes.
#[test]
fn vector_bytes_execute_whatever_their_blockhash() {
    let mut h = Harness::new();
    let to = Pubkey::new_unique();
    let fixed = Hash::new_from_array([7; 32]);
    let signed_at_fixed = |h: &Harness, lamports: u64| {
        let ix = solana_system_interface::instruction::transfer(&h.payer.pubkey(), &to, lamports);
        let msg = Message::new_with_blockhash(&[ix], Some(&h.payer.pubkey()), &fixed);
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&h.payer]).expect("sign")
    };
    let f = h
        .submit(signed_at_fixed(&h, 1_000_000))
        .expect_fail("a blockhash the ledger never had");
    assert_eq!(f.err, TransactionError::BlockhashNotFound);
    let wire = wincode::serialize(&signed_at_fixed(&h, 1_000_000)).expect("wire bytes");
    let tx = tx_from_wire(&wire);
    h.submit_any_blockhash(tx.clone())
        .expect_ok("the same bytes, whatever their blockhash");
    assert_eq!(h.lamports(&to), 1_000_000);
    let f = h
        .submit_any_blockhash(tx)
        .expect_fail("the same bytes again");
    assert_eq!(f.err, TransactionError::AlreadyProcessed);
    let f = h
        .submit(signed_at_fixed(&h, 2_000_000))
        .expect_fail("the age check is back on");
    assert_eq!(f.err, TransactionError::BlockhashNotFound);
    let mut forged = signed_at_fixed(&h, 3_000_000);
    forged.signatures[0] = Signature::default();
    let f = h
        .submit_any_blockhash(forged)
        .expect_fail("a forged signature, whatever the blockhash");
    assert_eq!(f.err, TransactionError::SignatureFailure);
    assert_eq!(h.lamports(&to), 1_000_000);
    let trailing = [wire.as_slice(), &[0]].concat();
    assert!(parse_tx(&trailing).is_none(), "a trailing byte");
    assert!(
        parse_tx(&wire[..wire.len() - 1]).is_none(),
        "one byte short"
    );
}

#[test]
#[should_panic(expected = "over the 1232-byte limit")]
fn oversize_legacy_transactions_are_refused() {
    let mut h = Harness::new();
    let ix = Instruction {
        program_id: Pubkey::new_unique(),
        accounts: vec![],
        data: vec![0; PACKET_DATA_SIZE],
    };
    let _ = h.send(&[ix], &[]);
}

#[test]
#[should_panic(expected = "over the 4096-byte limit")]
fn oversize_v1_transactions_are_refused() {
    let mut h = Harness::new();
    let ix = Instruction {
        program_id: Pubkey::new_unique(),
        accounts: vec![],
        data: vec![0; 4096],
    };
    let _ = h.send_v1(&[ix], &[]);
}

#[test]
fn signers_are_matched_to_the_message() {
    let mut h = Harness::new();
    let extra = h.funded_keypair(1);
    let unused = Keypair::new();
    let to = Pubkey::new_unique();
    let ix = solana_system_interface::instruction::transfer(&extra.pubkey(), &to, 1_000_000);
    // Keypairs the message does not need are ignored, order does not matter.
    h.send(&[ix], &[&unused, &extra]).expect_ok("extra signer");
    assert_eq!(h.lamports(&to), 1_000_000);
}

#[test]
fn log_parsers_read_runtime_output() {
    let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
    let logs: Vec<String> = [
        format!("Program {a} invoke [1]"),
        "Program log: transfer success".to_string(),
        format!("Program {b} invoke [2]"),
        format!("Program {b} consumed 100 of 1000 compute units"),
        format!("Program {b} success"),
        format!("Program {a} consumed 500 of 1100 compute units"),
        format!("Program {a} success"),
        format!("Program {a} invoke [1]"),
        format!("Program {a} consumed 7 of 9 compute units"),
        format!("Program {a} failed: custom program error: 0x1"),
    ]
    .into();
    assert_eq!(program_cu(&logs, &a), 507);
    assert_eq!(program_cu(&logs, &b), 0, "b only runs nested");
    assert_eq!(invocations_cu(&logs, &b), vec![100]);
    assert_eq!(invocations_cu(&logs, &a), vec![500, 7]);

    // Anchor `emit!`: `Program data:` with base64(discriminator || borsh).
    let event = |name: &str, payload: &[u8]| {
        let mut bytes = anchor_discriminator("event", name).to_vec();
        bytes.extend_from_slice(payload);
        format!(
            "Program data: {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    };
    let logs: Vec<String> = [
        format!("Program {a} invoke [1]"),
        event("PayoutReleased", &[1, 2, 3]),
        event("VaultWithdrawn", &[4]),
        "Program data: AQID".to_string(), // not an Anchor event
        event("PayoutReleased", &[]),
        format!("Program {a} success"),
    ]
    .into();
    assert_eq!(
        anchor_events(&logs, "PayoutReleased"),
        vec![vec![1, 2, 3], vec![]]
    );
    assert_eq!(anchor_events(&logs, "VaultWithdrawn"), vec![vec![4]]);
    assert!(anchor_events(&logs, "VaultOpened").is_empty());
}

/// SPEC §3 describes the v1 wire format that the SDK serializes by hand.
/// It must match `solana-message` / `solana-transaction` (what validators
/// parse) byte for byte, for every combination of config words, and LiteSVM
/// must execute what it describes.
#[test]
fn v1_wire_format_matches_the_spec() {
    let mut h = Harness::new();
    let co_signer = h.funded_keypair(1);
    let readonly_signer = Keypair::new();
    let program = Pubkey::new_unique();
    let ixs = [
        solana_system_interface::instruction::transfer(
            &co_signer.pubkey(),
            &Pubkey::new_unique(),
            1,
        ),
        Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new_readonly(readonly_signer.pubkey(), true),
                AccountMeta::new(Pubkey::new_unique(), false),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
            ],
            data: (0..=255u8).cycle().take(700).collect(),
        },
    ];
    let configs = [
        v1::TransactionConfig::empty(),
        v1::TransactionConfig::empty()
            .with_compute_unit_limit(400_000)
            .with_loaded_accounts_data_size_limit(4 << 20),
        v1::TransactionConfig::empty()
            .with_priority_fee(12_345)
            .with_compute_unit_limit(1)
            .with_loaded_accounts_data_size_limit(2)
            .with_heap_size(64 * 1024),
        v1::TransactionConfig::empty().with_heap_size(256 * 1024),
    ];
    for config in configs {
        let tx = h.v1_tx_with(&h.payer, &ixs, &[&co_signer, &readonly_signer], config);
        let wire = wincode::serialize(&tx).expect("serialize");
        assert_eq!(wire, v1_wire_per_spec(&tx), "{config:?}");
        assert_eq!(wire[0], 0x81, "the version byte comes first");
        // 3 signers (fee payer, co-signer, read-only signer), 1 of them read-only;
        // 3 read-only non-signers (an account and both program ids).
        assert_eq!(wire[1..4], [3, 1, 3], "{config:?}");
        let VersionedMessage::V1(m) = &tx.message else {
            unreachable!()
        };
        assert_eq!(m.account_keys[0], h.payer.pubkey(), "fee payer first");
        // The signatures close the transaction: one per signer, no length prefix.
        let sigs: Vec<u8> = tx
            .signatures
            .iter()
            .flat_map(|s| s.as_ref().to_vec())
            .collect();
        assert_eq!(wire[wire.len() - 3 * 64..], sigs[..]);
        let back: VersionedTransaction = wincode::deserialize(&wire).expect("deserialize");
        assert_eq!(back, tx);
    }

    // LiteSVM executes v1 transactions, and the config words are binding:
    // unset (zero) limits fail, the SDK's limits pass.
    let to = Pubkey::new_unique();
    let pay = solana_system_interface::instruction::transfer(&h.payer.pubkey(), &to, 1_000_000);
    let unset = h.v1_tx_with(
        &h.payer,
        std::slice::from_ref(&pay),
        &[],
        v1::TransactionConfig::empty(),
    );
    let f = h
        .submit(unset)
        .expect_fail("v1 without compute and loaded-data limits");
    assert_eq!(f.err, TransactionError::MaxLoadedAccountsDataSizeExceeded);
    let no_cu = v1::TransactionConfig::empty().with_loaded_accounts_data_size_limit(4 << 20);
    let unset_cu = h.v1_tx_with(&h.payer, std::slice::from_ref(&pay), &[], no_cu);
    let f = h
        .submit(unset_cu)
        .expect_fail("v1 without a compute-unit limit");
    assert_eq!(
        f.instruction_error(),
        Some(&solana_instruction::error::InstructionError::ComputationalBudgetExceeded),
        "{:?}",
        f.err
    );
    let config = v1::TransactionConfig::empty()
        .with_compute_unit_limit(400_000)
        .with_loaded_accounts_data_size_limit(4 << 20);
    let tx = h.v1_tx_with(&h.payer, &[pay], &[], config);
    h.submit(tx).expect_ok("v1 with both limits set");
    assert_eq!(h.lamports(&to), 1_000_000);
}

/// Every transaction is signature-verified, except one sent with
/// `send_with_unverified_signers`, which emulates a PDA signer for that
/// transaction only.
#[test]
fn signatures_are_verified_except_for_an_emulated_pda_signer() {
    let mut h = Harness::new();
    assert!(h.svm.get_sigverify());
    let to = Pubkey::new_unique();
    let pay = |from: &Pubkey| solana_system_interface::instruction::transfer(from, &to, 1_000_000);
    let forged = |h: &Harness| {
        let mut tx = h.legacy_tx(&[pay(&h.payer.pubkey())], &[], Some(MAX_CU_LIMIT));
        tx.signatures[0] = Signature::default();
        tx
    };

    let f = h
        .submit(forged(&h))
        .expect_fail("all-zero fee payer signature");
    assert_eq!(f.err, TransactionError::SignatureFailure);

    // A system account at an off-curve address: nobody holds its key.
    let pda = Pubkey::find_program_address(&[b"emulated"], &Pubkey::new_unique()).0;
    h.airdrop(&pda, 5_000_000);
    h.send_with_unverified_signers(&[pay(&pda)], &[])
        .expect_ok("emulated PDA signer");
    assert_eq!(h.lamports(&to), 1_000_000);
    assert!(h.svm.get_sigverify(), "verification is back on afterwards");

    let f = h
        .submit(forged(&h))
        .expect_fail("forged again, after the emulated transaction");
    assert_eq!(f.err, TransactionError::SignatureFailure);
    assert_eq!(h.lamports(&to), 1_000_000);
}

/// The loaded-data meter counts each account once, plus loader-v3 programdata.
#[test]
fn loaded_accounts_data_size_counts_programdata_once() {
    let h = Harness::new();
    let base = TRANSACTION_ACCOUNT_BASE_SIZE;
    let size = |key: &Pubkey| h.account(key).expect("account").data.len() as u64;
    // Fee payer (no data) + system program; the unfunded recipient is not loaded.
    let ix =
        solana_system_interface::instruction::transfer(&h.payer.pubkey(), &Pubkey::new_unique(), 1);
    let plain = h.legacy_tx(std::slice::from_ref(&ix), &[], None);
    assert_eq!(
        h.loaded_accounts_data_size(&plain),
        base + (base + size(&SYSTEM_PROGRAM_ID))
    );

    // Token-2022 is a loader-v3 program: its programdata counts too, once,
    // however often the program appears.
    let mut with_program = ix;
    with_program
        .accounts
        .push(AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false));
    let tx = h.legacy_tx(&[with_program.clone(), with_program], &[], None);
    let loader_v3 = solana_sdk_ids::bpf_loader_upgradeable::ID;
    let programdata = Pubkey::find_program_address(&[TOKEN_2022_PROGRAM_ID.as_ref()], &loader_v3).0;
    assert_eq!(
        h.loaded_accounts_data_size(&tx),
        base + (base + size(&SYSTEM_PROGRAM_ID))
            + (base + size(&TOKEN_2022_PROGRAM_ID))
            + (base + size(&programdata))
    );
    report("Token-2022 programdata bytes", size(&programdata));
}

/// `common::relay`: a native program at any address that makes the one CPI
/// it is given, with the signer flags of its own instruction (it can only
/// pass on signatures the transaction carries), and nothing without accounts.
#[test]
fn relay_makes_exactly_the_cpi_it_is_given() {
    let mut h = Harness::new();
    let relay = Pubkey::new_unique();
    h.add_relay(relay);
    let from = h.funded_keypair(1);
    let to = Pubkey::new_unique();
    let pay = solana_system_interface::instruction::transfer(&from.pubkey(), &to, 1_000_000);

    let sent = h
        .send(&[relay_ix(&relay, [7; 8], &pay)], &[&from])
        .expect_ok("relayed transfer");
    assert_eq!(h.lamports(&to), 1_000_000);
    let nested = format!("Program {SYSTEM_PROGRAM_ID} invoke [2]");
    assert!(sent.logs.contains(&nested), "{:#?}", sent.logs);

    let mut unsigned = relay_ix(&relay, [7; 8], &pay);
    assert_eq!(unsigned.accounts[1].pubkey, from.pubkey());
    unsigned.accounts[1].is_signer = false;
    h.send(&[unsigned], &[]).expect_instruction_error(
        InstructionError::MissingRequiredSignature,
        "no signature to pass on",
    );
    let mut short = relay_ix(&relay, [7; 8], &pay);
    short.data.truncate(7);
    h.send(&[short], &[&from])
        .expect_instruction_error(InstructionError::InvalidInstructionData, "no tag");
    h.send(&[relay_noop_ix(&relay, [7; 8])], &[])
        .expect_ok("no accounts: no CPI");
    assert_eq!(h.lamports(&to), 1_000_000);
}

/// `common::relay` signs as `invoke_signed` does: for a PDA of the program
/// id it is registered at, which the runtime derives from the seeds the
/// relay hands it. The transaction carries no signature for the PDA. Other
/// seeds, or the same seeds from a relay at another program id, derive
/// another address, and the runtime refuses the signer flag
/// (`PrivilegeEscalation`). This is how the hook suite stands in for the
/// launchpad's `hook-authority` signature with every signature verified.
#[test]
fn relay_signs_only_for_pdas_of_its_own_program_id() {
    let mut h = Harness::new();
    let (relay, other) = (Pubkey::new_unique(), Pubkey::new_unique());
    h.add_relay(relay);
    h.add_relay(other);
    let (pda, bump) = Pubkey::find_program_address(&[b"relay-pda"], &relay);
    h.airdrop(&pda, 10_000_000);
    let to = Pubkey::new_unique();
    let pay = solana_system_interface::instruction::transfer(&pda, &to, 1_000_000);
    assert!(pay.accounts[0].is_signer);
    let bump = [bump];
    let seeds: &[&[u8]] = &[b"relay-pda", &bump];

    let ix = relay_signed_ix(&relay, [7; 8], &pay, &[(0, seeds)]);
    assert!(
        !ix.accounts[1].is_signer,
        "the transaction carries no signature for the PDA"
    );
    let sent = h
        .send(&[ix], &[])
        .expect_ok("the relay signs for its own PDA");
    assert_eq!(h.lamports(&to), 1_000_000);
    let nested = format!("Program {SYSTEM_PROGRAM_ID} invoke [2]");
    assert!(sent.logs.contains(&nested), "{:#?}", sent.logs);

    // Valid seeds (off-curve, with their own bumps) of other addresses.
    let other_bump = [Pubkey::find_program_address(&[b"another-pda"], &relay).1];
    let other_seeds: &[&[u8]] = &[b"another-pda", &other_bump];
    let foreign_bump = [Pubkey::find_program_address(&[b"relay-pda"], &other).1];
    let foreign_seeds: &[&[u8]] = &[b"relay-pda", &foreign_bump];
    for (what, ix) in [
        (
            "other seeds of the same program",
            relay_signed_ix(&relay, [7; 8], &pay, &[(0, other_seeds)]),
        ),
        (
            "the same seeds from another program id",
            relay_signed_ix(&other, [7; 8], &pay, &[(0, foreign_seeds)]),
        ),
    ] {
        let f = h
            .send(&[ix], &[])
            .expect_instruction_error(InstructionError::PrivilegeEscalation, what);
        assert!(
            f.logs_contain(&format!("{pda}'s signer privilege escalated")),
            "{what}: {:#?}",
            f.logs
        );
    }
    // A signer section that is cut short or names no inner account.
    let mut cut = relay_signed_ix(&relay, [7; 8], &pay, &[(0, seeds)]);
    cut.data.truncate(8 + 4 + 4);
    let mut no_account = relay_signed_ix(&relay, [7; 8], &pay, &[(0, seeds)]);
    assert_eq!(no_account.data[9], 0, "account index byte");
    no_account.data[9] = 3;
    for (what, ix) in [
        ("cut short", cut),
        ("an account the CPI does not have", no_account),
    ] {
        h.send(&[ix], &[])
            .expect_instruction_error(InstructionError::InvalidInstructionData, what);
    }
    assert_eq!(h.lamports(&to), 1_000_000);
}

/// The vault CPIs SPL Memo v2 before paying an account that requires memos.
/// It is not a mainnet dump: LiteSVM 0.17 ships it at its mainnet address.
#[test]
fn litesvm_ships_the_memo_program_the_vault_calls() {
    let mut h = Harness::new();
    assert!(
        h.account(&MEMO_PROGRAM_ID)
            .expect("memo program")
            .executable
    );
    let memo = Instruction {
        program_id: MEMO_PROGRAM_ID,
        accounts: vec![],
        data: b"noised-vault payout".to_vec(),
    };
    let sent = h.send(&[memo], &[]).expect_ok("memo");
    assert!(
        sent.logs.iter().any(|l| l.contains("noised-vault payout")),
        "{:#?}",
        sent.logs
    );
}
