//! Cross-implementation vectors for the TypeScript SDK (`sdk/`), vault v4.
//!
//! Everything here is produced by the Rust code validators and the programs
//! use: the 185-byte `PHX-PQV4` message from `noised_vault::message`, the
//! vault and payout PDAs, the `open_vault` / `withdraw` / `release` /
//! `release_to` account lists and instruction data from the program crate's
//! Anchor client types, `Vault` and `Payout` account bytes from its state
//! types, LM-OTS keys, randomizers and signatures from `noised-lmots`, and
//! the v1 transactions from `solana-message` (compile) and
//! `solana-transaction` (wire format). The SDK's vector test is meant to
//! rebuild every value with the SDK and compare bytes (it still has to be
//! pointed at this file: `sdk/test/vault_vectors.test.ts` reads an older v3
//! copy under `sdk/test/vectors/`).
//!
//! The vector file `tests/integration/vectors/vault_withdraw.json` is
//! committed. This test fails if it is missing or differs from what the Rust
//! side produces now; to (re)write it after a deliberate format change, run
//! with `NOISED_WRITE_SDK_VECTORS=1`.
//!
//! Inputs are fixed (no randomness). Sections:
//!
//! * `withdrawals[]`: one withdrawal each, from `inputs` (`cluster`,
//!   `master`, `mint`, `account`, `sequence`, ...). Keys follow SPEC §3.10:
//!   `genesisKey` = key(account, 0), whose id names the vault, `key` =
//!   key(account, sequence) signs, `nextKey` = key(account, sequence + 1);
//!   each is `{account, sequence, seed, id, q, k, keyId}`. `signature` uses
//!   the fixed randomizer `inputs.randomizer` (the LM-OTS signer with a given
//!   `C`); `derivedRandomizer` and `derivedSignature` are what a client
//!   signs with (`C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" | I |
//!   u32be(q) | msg)`, the SDK's `signWithdrawal`). The instructions and v1
//!   transactions carry `signature`.
//! * `derivation`: for one master and mint, the keys of several
//!   `(cluster, account, sequence)`: `path` (cluster | mint | u32le(account)
//!   | u32le(sequence)), `seed`, `id`, `q` (= sequence), `k`, `keyId`, and
//!   `vault`, the address of that account's vault (from key(account, 0)).
//! * `randomizer`: the randomizer's known answer (`seed`, `id`, `q`,
//!   `message` -> `c`), the same value `noised-lmots` and the SDK pin.
//! * `pdas`, `borsh`, `programs`: addresses and byte layouts.
//!
//! Schema changes in this revision: key objects carry `account` and
//! `sequence` instead of `index`; `inputs.account`, `derivedRandomizer`,
//! `derivedSignature`, `derivation` and `randomizer` are new.

mod common;

use anchor_lang::{AccountSerialize, InstructionData};
use common::{
    hook::{dbc_base_vault, hook_authority, meta_list_pda, policy_pda, INSTRUCTIONS_SYSVAR_ID},
    sha256,
    token::ata,
    vault::{
        derivation_path, key_id, master_seed, open_vault_ix, payout_pda, randomizer, release_ix,
        release_to_ix, spec_randomizer, vault_pda, withdraw_ix, withdraw_tx_config, PayoutRef,
        PqKey, CLUSTER_DEVNET, CLUSTER_LOCALNET, CLUSTER_MAINNET, MEMO_PROGRAM_ID, RANDOMIZER_TAG,
        WITHDRAW_IX_DATA_LEN, WITHDRAW_MESSAGE_LEN,
    },
    AccountMeta, Instruction, Keypair, Pubkey, Signer, ATA_PROGRAM_ID, LAUNCHPAD_PROGRAM_ID,
    SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use noised_lmots::{PrivateKey, Sha2};
use noised_vault::{
    message::withdraw_message,
    state::{next_key_index, Payout, Vault, VaultKey, GENESIS_KEY_INDEX},
    WithdrawArgs,
};
use serde_json::{json, Value};
use solana_message::{v1, Hash, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

const VECTOR_FILE: &str = "vectors/vault_withdraw.json";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn metas_json(metas: &[AccountMeta]) -> Value {
    Value::Array(
        metas
            .iter()
            .map(|m| {
                json!({
                    "pubkey": m.pubkey.to_string(),
                    "isSigner": m.is_signer,
                    "isWritable": m.is_writable,
                })
            })
            .collect(),
    )
}

fn ix_json(ix: &Instruction) -> Value {
    json!({
        "programId": ix.program_id.to_string(),
        "accounts": metas_json(&ix.accounts),
        "data": hex(&ix.data),
    })
}

fn key_json(key: &PqKey) -> Value {
    json!({
        "account": key.account,
        "sequence": key.sequence,
        "seed": hex(&key.sk.seed),
        "id": hex(&key.pk.id),
        "q": key.pk.q,
        "k": hex(&key.pk.k),
        "keyId": hex(&key.key_id),
    })
}

/// A deterministic 32-byte value derived from a label.
fn fixed(label: &str) -> [u8; 32] {
    sha256(&[b"phalanx-sdk-vectors/", label.as_bytes()])
}

fn pubkey(label: &str) -> Pubkey {
    Pubkey::new_from_array(fixed(label))
}

/// A v1 transaction of `ixs` paid and signed by `fee_payer`, with the
/// SDK's config words, exactly as validators parse it.
fn v1_json(fee_payer: &Keypair, ixs: &[Instruction], recent_blockhash: Hash) -> Value {
    let config = withdraw_tx_config();
    let msg =
        v1::Message::try_compile_with_config(&fee_payer.pubkey(), ixs, recent_blockhash, config)
            .expect("compile v1 message");
    let tx = VersionedTransaction::try_new(VersionedMessage::V1(msg), &[fee_payer])
        .expect("sign v1 transaction");
    let wire = wincode::serialize(&tx).expect("serialize v1 transaction");
    assert_eq!(wire, common::svm::v1_wire_per_spec(&tx), "SPEC §3 layout");
    assert!(wire.len() <= v1::MAX_TRANSACTION_SIZE);
    let message_bytes = tx.message.serialize();
    assert_eq!(&wire[..message_bytes.len()], &message_bytes[..]);
    let VersionedMessage::V1(compiled) = &tx.message else {
        unreachable!("v1 message")
    };
    json!({
        "computeUnitLimit": config.compute_unit_limit,
        "loadedAccountsDataSizeLimit": config.loaded_accounts_data_size_limit,
        "header": [
            compiled.header.num_required_signatures,
            compiled.header.num_readonly_signed_accounts,
            compiled.header.num_readonly_unsigned_accounts,
        ],
        "accountKeys": compiled.account_keys.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
        "message": hex(&message_bytes),
        "wire": hex(&wire),
    })
}

/// One withdrawal: vault `account` (opened with key(account, 0)) is at
/// `sequence`, so key(account, sequence) signs "reserve up to `max_amount`
/// for `destination_owner`, then key(account, sequence + 1) holds the
/// vault"; then the release instructions that deliver it.
fn withdrawal_case(
    name: &str,
    token_program: Pubkey,
    hook: bool,
    account: u32,
    sequence: u64,
    max_amount: u64,
    recent_blockhash: Hash,
) -> Value {
    let master = master_seed("sdk-vectors");
    let mint = pubkey(&format!("{name}/mint"));
    let destination_owner = pubkey(&format!("{name}/destination-owner"));
    let release_to_destination = pubkey(&format!("{name}/release-to-destination"));
    let fee_payer = Keypair::new_from_array(fixed(&format!("{name}/fee-payer")));
    let fixed_randomizer = fixed(&format!("{name}/randomizer"));

    let index = u32::try_from(sequence).expect("the SDK refuses sequence >= 2^32");
    let genesis = PqKey::derive(&master, &mint, account, 0);
    let key = PqKey::derive(&master, &mint, account, index);
    let next = PqKey::derive(&master, &mint, account, index + 1);
    let vault = genesis.vault(&mint);
    for k in [&genesis, &key, &next] {
        assert_eq!(k.key_id, noised_vault::state::key_id(&k.pk));
        assert_eq!(k.key_id, key_id(&k.pk));
        assert_eq!((k.account, k.pk.q), (account, k.sequence));
    }

    // The program's own message builder.
    let message = withdraw_message(
        &noised_vault::ID,
        &vault,
        &mint,
        sequence,
        &destination_owner,
        max_amount,
        &next.key_id,
    );
    assert_eq!(message.len(), WITHDRAW_MESSAGE_LEN);
    assert_eq!(
        message.to_vec(),
        common::vault::withdraw_message(
            &vault,
            &mint,
            sequence,
            &destination_owner,
            max_amount,
            &next.key_id
        ),
        "SPEC §3 layout and program agree"
    );
    let signature = key.sign_with_randomizer(&message, &fixed_randomizer);
    assert!(noised_lmots::verify::<Sha2>(&key.pk, &message, &signature));
    // What a client signs (SDK `signWithdrawal`): C derived from the key and
    // the message, by the crate and by the documented HMAC construction.
    let derived_randomizer = randomizer(&key.sk, &message);
    assert_eq!(
        derived_randomizer,
        spec_randomizer(&key.sk.seed, &key.sk.id, key.sk.q, &message)
    );
    let derived_signature = key.sign(&message);
    assert_eq!(derived_signature[..32], derived_randomizer);
    assert_eq!(
        derived_signature,
        key.sign_with_randomizer(&message, &derived_randomizer)
    );
    assert!(noised_lmots::verify::<Sha2>(
        &key.pk,
        &message,
        &derived_signature
    ));
    assert_ne!(derived_signature, signature);

    let args = WithdrawArgs {
        signature: signature.clone(),
        destination_owner,
        max_amount,
        next_key_id: next.key_id,
        next_key: next.vault_key(),
    };
    let withdraw = withdraw_ix(
        &fee_payer.pubkey(),
        &mint,
        &token_program,
        &vault,
        sequence,
        &args,
    );
    assert_eq!(withdraw.data.len(), WITHDRAW_IX_DATA_LEN);

    let payout = PayoutRef {
        mint,
        token_program,
        vault,
        payout: payout_pda(&vault, sequence),
        rent_payer: fee_payer.pubkey(),
        destination_owner,
    };
    let extra: Vec<AccountMeta> = if hook {
        // What a client resolves for a Launch Guard mint, in the order
        // `spl_transfer_hook_interface::offchain` appends them (the program
        // looks each one up by key).
        vec![
            AccountMeta::new_readonly(policy_pda(&mint).0, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
            AccountMeta::new_readonly(noised_hook::ID, false),
            AccountMeta::new_readonly(meta_list_pda(&mint), false),
        ]
    } else {
        Vec::new()
    };
    let release = release_ix(
        &fee_payer.pubkey(),
        &payout,
        &payout.canonical_destination(),
        &extra,
    );
    let release_to = release_to_ix(&payout, &release_to_destination, &extra);
    let open = open_vault_ix(
        &fee_payer.pubkey(),
        &mint,
        &token_program,
        genesis.key_id,
        genesis.vault_key(),
    );
    let v1_withdraw = v1_json(
        &fee_payer,
        std::slice::from_ref(&withdraw),
        recent_blockhash,
    );
    let v1_withdraw_release = v1_json(
        &fee_payer,
        &[withdraw.clone(), release.clone()],
        recent_blockhash,
    );

    json!({
        "name": name,
        "inputs": {
            "cluster": CLUSTER_LOCALNET,
            "master": hex(&master),
            "mint": mint.to_string(),
            "tokenProgram": token_program.to_string(),
            "hook": hook,
            "account": account,
            "sequence": sequence.to_string(),
            "destinationOwner": destination_owner.to_string(),
            "maxAmount": max_amount.to_string(),
            "releaseToDestination": release_to_destination.to_string(),
            "feePayerSeed": hex(&fixed(&format!("{name}/fee-payer"))),
            "feePayer": fee_payer.pubkey().to_string(),
            "recentBlockhash": recent_blockhash.to_string(),
            "randomizer": hex(&fixed_randomizer),
        },
        "genesisKey": key_json(&genesis),
        "key": key_json(&key),
        "nextKey": key_json(&next),
        "addresses": {
            "vault": vault.to_string(),
            "vaultTokenAccount": ata(&vault, &mint, &token_program).to_string(),
            "payout": payout.payout.to_string(),
            "destination": payout.canonical_destination().to_string(),
        },
        "message": hex(&message),
        "signature": hex(&signature),
        "derivedRandomizer": hex(&derived_randomizer),
        "derivedSignature": hex(&derived_signature),
        "openVaultIx": ix_json(&open),
        "withdrawIx": ix_json(&withdraw),
        "releaseIx": ix_json(&release),
        "releaseToIx": ix_json(&release_to),
        "v1Withdraw": v1_withdraw,
        "v1WithdrawRelease": v1_withdraw_release,
    })
}

/// SPEC §3.10 key derivation for one master seed (bytes 0..64) and mint:
/// the keys of several `(account, sequence)` pairs on localnet, plus the
/// first key on mainnet and devnet (the cluster byte leads the path). Each
/// entry gives the path, the LM-OTS private seed and public key, its key id,
/// and the vault of its account (the PDA named by key(account, 0)).
fn derivation_cases() -> Value {
    let master: [u8; 64] = std::array::from_fn(|i| i as u8);
    let mint = pubkey("derivation/mint");
    let cases = [
        (CLUSTER_LOCALNET, 0, 0),
        (CLUSTER_LOCALNET, 0, 1),
        (CLUSTER_LOCALNET, 1, 0),
        (CLUSTER_LOCALNET, 7, 42),
        (CLUSTER_MAINNET, 0, 0),
        (CLUSTER_DEVNET, 0, 0),
    ];
    let keys: Vec<Value> = cases
        .iter()
        .map(|&(cluster, account, sequence)| {
            let key = PqKey::derive_on(cluster, &master, &mint, account, sequence);
            let path = derivation_path(cluster, &mint, account, sequence);
            assert_eq!(
                key.sk.seed,
                sha256(&[b"phalanx/pq/lmots/seed", &master, &path])
            );
            assert_eq!(key.pk.q, sequence, "q is the sequence");
            assert_eq!(key.pk, key.sk.public_key::<Sha2>());
            let vault = PqKey::derive_on(cluster, &master, &mint, account, 0).vault(&mint);
            json!({
                "cluster": cluster,
                "account": account,
                "sequence": sequence,
                "path": hex(&path),
                "seed": hex(&key.sk.seed),
                "id": hex(&key.pk.id),
                "q": key.pk.q,
                "k": hex(&key.pk.k),
                "keyId": hex(&key.key_id),
                "vault": vault.to_string(),
            })
        })
        .collect();
    let distinct: std::collections::HashSet<&str> = keys
        .iter()
        .map(|k| k["keyId"].as_str().expect("keyId"))
        .collect();
    assert_eq!(distinct.len(), keys.len(), "keys never repeat");
    json!({
        "master": hex(&master),
        "mint": mint.to_string(),
        "keys": keys,
    })
}

/// The deterministic randomizer's known answer, the same one `noised-lmots`
/// and the SDK pin: SEED = 0x11 * 32, I = 0x22 * 16, q = 7, message
/// "phalanx".
fn randomizer_case() -> Value {
    let sk = PrivateKey {
        id: [0x22; 16],
        q: 7,
        seed: [0x11; 32],
    };
    let message = b"phalanx";
    let c = randomizer(&sk, message);
    assert_eq!(
        hex(&c),
        "efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3",
        "published known answer"
    );
    assert_eq!(c, spec_randomizer(&sk.seed, &sk.id, sk.q, message));
    json!({
        "construction": "HMAC-SHA256(key = seed, tag || id || u32be(q) || message)",
        "tag": std::str::from_utf8(RANDOMIZER_TAG).expect("ASCII tag"),
        "seed": hex(&sk.seed),
        "id": hex(&sk.id),
        "q": sk.q,
        "message": hex(message),
        "c": hex(&c),
    })
}

/// PDAs of the hook, the vault and Meteora DBC, from the program crates'
/// seed constants, plus the launchpad PDAs from its documented seeds
/// (`programs/noised-launchpad/src/constants.rs`, checked against that file
/// by the SDK test).
fn pda_cases() -> Value {
    let mint = pubkey("pda/mint");
    let pool = pubkey("pda/pool");
    let owner = pubkey("pda/owner");
    let launch_seed = fixed("pda/launch-seed");
    let lp = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &LAUNCHPAD_PROGRAM_ID).0;
    let launch = lp(&[b"launch", &launch_seed]);
    let key_id = fixed("pda/key-id");
    let vault = vault_pda(&mint, &key_id);
    let payout_sequence = 0x0102_0304_0506_0708u64;
    json!({
        "mint": mint.to_string(),
        "pool": pool.to_string(),
        "owner": owner.to_string(),
        "launchSeed": hex(&launch_seed),
        "keyId": hex(&key_id),
        "hookPolicy": policy_pda(&mint).0.to_string(),
        "hookPolicyBump": policy_pda(&mint).1,
        "extraAccountMetaList": meta_list_pda(&mint).to_string(),
        "instructionsSysvar": INSTRUCTIONS_SYSVAR_ID.to_string(),
        "hookAuthority": hook_authority().to_string(),
        "dbcBaseVault": dbc_base_vault(&mint, &pool).to_string(),
        "vault": vault.to_string(),
        "payoutSequence": payout_sequence.to_string(),
        "payout": payout_pda(&vault, payout_sequence).to_string(),
        "payoutSequence0": payout_pda(&vault, 0).to_string(),
        "ataToken2022": ata(&owner, &mint, &TOKEN_2022_PROGRAM_ID).to_string(),
        "ataToken": ata(&owner, &mint, &TOKEN_PROGRAM_ID).to_string(),
        "protocol": lp(&[b"protocol"]).to_string(),
        "launch": launch.to_string(),
        "launchAuthority": lp(&[b"authority", launch.as_ref()]).to_string(),
        "batchAuthority": lp(&[b"batch", launch.as_ref()]).to_string(),
        "dbcConfig": lp(&[b"dbc-config", launch.as_ref()]).to_string(),
        "certificate": lp(&[b"certificate", mint.as_ref()]).to_string(),
        "commit": lp(&[b"commit", launch.as_ref(), owner.as_ref()]).to_string(),
    })
}

/// Borsh of the vault's argument types and accounts, from the program crate.
fn borsh_cases() -> Value {
    let key = VaultKey {
        id: fixed("borsh/id")[..16].try_into().expect("16 bytes"),
        q: 0x0102_0304,
        k: fixed("borsh/k"),
    };
    let args = WithdrawArgs {
        signature: (0..2176u32).map(|i| (i % 251) as u8).collect(),
        destination_owner: pubkey("borsh/destination-owner"),
        max_amount: u64::MAX - 1,
        next_key_id: fixed("borsh/next-key-id"),
        next_key: key,
    };
    let withdraw = noised_vault::instruction::Withdraw { args }.data();
    let open = noised_vault::instruction::OpenVault {
        key_id_arg: fixed("borsh/key-id"),
        key,
    }
    .data();

    let vault = Vault {
        version: Vault::VERSION,
        bump: 254,
        mint: pubkey("borsh/mint"),
        genesis_key_id: fixed("borsh/genesis-key-id"),
        sequence: 0x0a0b_0c0d_0e0f_1011,
        key_id: fixed("borsh/key-id"),
        key_ident: key.id,
        key_q: key.q,
        key_k: key.k,
        reserved: 0x1112_1314_1516_1718,
    };
    let payout = Payout {
        version: Payout::VERSION,
        bump: 253,
        vault: pubkey("borsh/vault"),
        sequence: 0x2122_2324_2526_2728,
        destination_owner: pubkey("borsh/destination-owner"),
        amount: 0x3132_3334_3536_3738,
        rent_payer: pubkey("borsh/rent-payer"),
    };
    let (mut vault_bytes, mut payout_bytes) = (Vec::new(), Vec::new());
    vault
        .try_serialize(&mut vault_bytes)
        .expect("serialize Vault");
    payout
        .try_serialize(&mut payout_bytes)
        .expect("serialize Payout");
    assert_eq!(
        vault_bytes[..8],
        common::anchor_discriminator("account", "Vault")
    );
    assert_eq!(
        payout_bytes[..8],
        common::anchor_discriminator("account", "Payout")
    );

    json!({
        "vaultKey": { "id": hex(&key.id), "q": key.q, "k": hex(&key.k) },
        "withdrawArgs": {
            "destinationOwner": pubkey("borsh/destination-owner").to_string(),
            "maxAmount": (u64::MAX - 1).to_string(),
            "nextKeyId": hex(&fixed("borsh/next-key-id")),
        },
        "withdrawData": hex(&withdraw),
        "openVaultKeyId": hex(&fixed("borsh/key-id")),
        "openVaultData": hex(&open),
        "releaseData": hex(&noised_vault::instruction::Release.data()),
        "releaseToData": hex(&noised_vault::instruction::ReleaseTo.data()),
        "vaultAccount": {
            "mint": vault.mint.to_string(),
            "genesisKeyId": hex(&vault.genesis_key_id),
            "sequence": vault.sequence.to_string(),
            "keyId": hex(&vault.key_id),
            "reserved": vault.reserved.to_string(),
            "bump": vault.bump,
            "data": hex(&vault_bytes),
        },
        "payoutAccount": {
            "vault": payout.vault.to_string(),
            "sequence": payout.sequence.to_string(),
            "destinationOwner": payout.destination_owner.to_string(),
            "amount": payout.amount.to_string(),
            "rentPayer": payout.rent_payer.to_string(),
            "bump": payout.bump,
            "data": hex(&payout_bytes),
        },
    })
}

/// Audit round 2 (amendment A11): `open_vault` takes only a key of LM-OTS
/// index 0 and `withdraw` installs only the key of the next position,
/// index `sequence + 1`. Every withdrawal in the committed file names such
/// keys, so none of the signed withdrawals stored there (and in the SDK's
/// copies) became unexecutable; `tests/vectors_onchain.rs` executes them.
/// Every derived key's index is its sequence.
#[test]
fn committed_withdrawals_name_the_key_of_the_next_position() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_FILE);
    let text = std::fs::read_to_string(&path).expect("committed SDK vectors");
    let committed: Value = serde_json::from_str(&text).expect("vector JSON");
    let withdrawals = committed["withdrawals"].as_array().expect("withdrawals");
    assert_eq!(withdrawals.len(), 2);
    for w in withdrawals {
        let name = w["name"].as_str().expect("name");
        let sequence: u64 = w["inputs"]["sequence"]
            .as_str()
            .expect("decimal string")
            .parse()
            .expect("u64");
        let q = |key: &str| {
            let q = w[key]["q"].as_u64().expect("q");
            assert_eq!(w[key]["q"], w[key]["sequence"], "{name}: {key}");
            u32::try_from(q).expect("u32 index")
        };
        assert_eq!(q("genesisKey"), GENESIS_KEY_INDEX, "{name}");
        assert_eq!(u64::from(q("key")), sequence, "{name}");
        assert_eq!(Some(q("nextKey")), next_key_index(sequence), "{name}");
        // The signed message names that next key (`next_key_id`, bytes 153..185).
        let message = w["message"].as_str().expect("message hex");
        assert_eq!(message.len(), 2 * WITHDRAW_MESSAGE_LEN);
        assert_eq!(
            &message[2 * 153..],
            w["nextKey"]["keyId"].as_str().expect("keyId"),
            "{name}"
        );
    }
    for key in committed["derivation"]["keys"].as_array().expect("keys") {
        assert_eq!(key["q"], key["sequence"]);
    }
}

#[test]
fn sdk_vectors_match_the_committed_file() {
    let blockhash = Hash::new_from_array(fixed("blockhash"));
    let vectors = json!({
        // Provenance text pinned byte-for-byte in the committed vector file (written before the rename to Noised): kept so the file stays identical.
        "source": "tests/integration/tests/sdk_vectors.rs (phalanx_vault v4, phalanx-lmots, solana-message 4.6 v1, solana-transaction 4.3)",
        "programs": {
            "vault": noised_vault::ID.to_string(),
            "hook": noised_hook::ID.to_string(),
            "launchpad": LAUNCHPAD_PROGRAM_ID.to_string(),
            "associatedToken": ATA_PROGRAM_ID.to_string(),
            "system": SYSTEM_PROGRAM_ID.to_string(),
            "memo": MEMO_PROGRAM_ID.to_string(),
        },
        "withdrawals": [
            withdrawal_case("spl", TOKEN_PROGRAM_ID, false, 0, 0, 1_234_567_890, blockhash),
            withdrawal_case("t22-hook", TOKEN_2022_PROGRAM_ID, true, 3, 7, u64::MAX, blockhash),
        ],
        "derivation": derivation_cases(),
        "randomizer": randomizer_case(),
        "pdas": pda_cases(),
        "borsh": borsh_cases(),
    });
    let text = serde_json::to_string_pretty(&vectors).expect("json") + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_FILE);
    if std::env::var_os("NOISED_WRITE_SDK_VECTORS")
        .or_else(|| std::env::var_os("PHALANX_WRITE_SDK_VECTORS"))
        .is_some()
    {
        std::fs::create_dir_all(path.parent().expect("vector dir")).expect("create vector dir");
        std::fs::write(&path, &text).expect("write SDK vector file");
        println!("wrote {}", path.display());
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; run with NOISED_WRITE_SDK_VECTORS=1 to create it",
            path.display()
        )
    });
    assert_eq!(
        committed.replace("\r\n", "\n"),
        text,
        "SDK vectors are stale; rerun with NOISED_WRITE_SDK_VECTORS=1"
    );
}
