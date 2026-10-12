//! The on-chain metadata record (`publish_metadata`; METADATA_PROGRAM.md on
//! METADATA_ONCHAIN.md §4) end to end, against our SBF builds and the
//! mainnet Meteora DBC, Token-2022, SPL Token and ATA programs:
//!
//! * `create_launch`, `publish_metadata`, `attest_launch` and `launch` in
//!   each uri mode: no uri (the default), an inline uri of the largest
//!   document (4,125 bytes) and of a typical one, an external uri of 200
//!   bytes, with the largest name and symbol. The real Token-2022 mint holds
//!   exactly the record's name and symbol and the uri derived from it (here
//!   from the spec, not from the program), the certificate sets
//!   `METADATA_ONCHAIN` and names the record, and the batch (commit,
//!   execute, claim) and public trading work on the mint as on any other.
//!   Compute and sizes are printed as `MEASURE` lines;
//! * the SDK's metadata vectors (`tests/integration/vectors/metadata.json`)
//!   launch to exactly their documented mint uri;
//! * DBC's own 32 KiB heap takes the largest inline uri with room to spare;
//! * `launch`'s post-condition (`checks::verify_token_metadata`) on the real
//!   mints' bytes and on Token-2022's own encoding of additional metadata
//!   and field updates: with an honest DBC `MetadataMismatch` cannot happen
//!   on-chain, so the comparison is pinned here directly;
//! * `launch` checks the record's own fields, not only its address; a
//!   pre-funded record address blocks nothing, and a record-shaped account
//!   the launchpad does not own attests nothing; nothing is published under
//!   a live launch;
//! * `attest_launch` refuses any record account but the one its signed hash
//!   names, so whoever relays a signature cannot turn one that attests into
//!   one that only burns its leaf (the adversarial review's finding);
//! * the largest metadata mints live through completion, migration to DAMM
//!   v2, LP fees and `distribute`.
//!
//! How to build and run: see `src/lib.rs`.

mod common;

use std::{path::Path, sync::OnceLock};

use anchor_lang::{
    solana_program::system_instruction, system_program, AccountSerialize, InstructionData,
    ToAccountMetas,
};
use anchor_spl::token_interface::{
    spl_token_2022::{
        self,
        extension::{
            metadata_pointer, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
        state::Mint,
    },
    spl_token_metadata_interface::{
        self,
        state::{Field, TokenMetadata},
    },
};
use base64::Engine as _;
use common::{
    launch::*,
    lifecycle::*,
    pq::{self, Terms},
    world::*,
    *,
};
use noised_launchpad::{
    checks as post,
    constants::*,
    dynamic_bonding_curve::{
        client::{accounts as dbc_acc, args as dbc_args},
        types::InitializePoolParameters,
    },
    error::LaunchpadError as E,
    events::{LaunchAttested, MetadataPublished, PqLeafConsumed},
    state::{checks, Attestation, Certificate, Launch, LaunchStatus, TokenMeta},
};
use solana_account::Account;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Anchor's `AccountOwnedByWrongProgram`.
const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3_007;
/// The inline uri's prefix, written out from METADATA_PROGRAM.md A1 (not
/// taken from the program).
const DATA_URI_PREFIX: &str = "data:application/json;base64,";

/// A metadata record as `publish_metadata` takes it.
#[derive(Clone, Debug)]
struct Record {
    name: String,
    symbol: String,
    flags: u8,
    uri: String,
    doc: String,
}

impl Record {
    fn meta(&self) -> pq::Meta<'_> {
        pq::Meta {
            name: self.name.as_bytes(),
            symbol: self.symbol.as_bytes(),
            flags: self.flags,
            uri: self.uri.as_bytes(),
            doc: self.doc.as_bytes(),
        }
    }

    fn hash(&self) -> [u8; 32] {
        pq::metadata_hash(self.meta())
    }

    /// The uri `launch` must give the mint, derived from the spec
    /// (METADATA_PROGRAM.md A1), not by the program: nothing without a uri
    /// mode, the document as a data uri (standard base64, padded) with
    /// `INLINE_URI` (bit 0), the record's own uri with `EXTERNAL_URI` (bit
    /// 1).
    fn mint_uri(&self) -> String {
        match self.flags {
            0 => String::new(),
            1 => format!(
                "{DATA_URI_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(&self.doc)
            ),
            2 => self.uri.clone(),
            f => panic!("no uri mode has flags {f}"),
        }
    }

    /// The record's account at launch `launch`, byte for byte, from the
    /// layout of METADATA_PROGRAM.md A1: `sha256("account:TokenMeta")[..8]`,
    /// version 1, the canonical bump, flags, launch, the hash, then name,
    /// symbol, uri and document as borsh strings.
    fn account_bytes(&self, launch: &Pubkey) -> Vec<u8> {
        let hash = self.hash();
        let (_, bump) = Pubkey::find_program_address(
            &[b"metadata", launch.as_ref(), &hash],
            &noised_launchpad::ID,
        );
        let mut data = pq::sha256(&[b"account:TokenMeta"])[..8].to_vec();
        data.extend_from_slice(&[1, bump, self.flags]);
        data.extend_from_slice(launch.as_ref());
        data.extend_from_slice(&hash);
        for s in [&self.name, &self.symbol, &self.uri, &self.doc] {
            data.extend_from_slice(&(s.len() as u32).to_le_bytes());
            data.extend_from_slice(s.as_bytes());
        }
        data
    }

    /// A record of the SDK's metadata vectors (`record` of a case).
    fn from_vector(v: &serde_json::Value) -> Self {
        let text = |key: &str| {
            let hex = v[key].as_str().unwrap_or_else(|| panic!("record.{key}"));
            String::from_utf8(unhex(hex)).expect("UTF-8")
        };
        Record {
            name: text("nameHex"),
            symbol: text("symbolHex"),
            flags: u8::try_from(v["flags"].as_u64().expect("flags")).expect("u8"),
            uri: text("uriHex"),
            doc: text("docHex"),
        }
    }
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `tests/integration/vectors/metadata.json`: the SDK's metadata vectors.
fn vectors() -> &'static serde_json::Value {
    static V: OnceLock<serde_json::Value> = OnceLock::new();
    V.get_or_init(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../tests/integration/vectors/metadata.json");
        let text =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).expect("metadata.json")
    })
}

/// `text` filled out with digits to exactly `len` bytes.
fn exactly(text: &str, len: usize) -> String {
    let mut s = text.to_string();
    for d in (0..10u8).cycle() {
        if s.len() >= len {
            break;
        }
        s.push(char::from(b'0' + d));
    }
    assert_eq!(s.len(), len, "{text:?}");
    s
}

/// A metadata document as the SDK writes it (compact JSON in the key order
/// of METADATA_ONCHAIN.md §4.8) of exactly `len` bytes: the record's name
/// and symbol, a description with multi-byte characters and runs of `?` and
/// `>` (whose base64 holds `/` and `+`), filled out to the length, and the
/// vectors' 32x32 16-colour PNG icon.
fn document(name: &str, symbol: &str, len: usize) -> String {
    let icon = vectors()["icon"]["dataUri"].as_str().expect("icon");
    let head = format!(r#"{{"name":"{name}","symbol":"{symbol}","description":""#);
    let tail = format!(r#"","image":"{icon}"}}"#);
    let mut description =
        String::from("On-chain metadata, no link: ünïcödé ✓ 🛡 ???>>> ?>?>?> >>>??? ");
    let fill = len
        .checked_sub(head.len() + description.len() + tail.len())
        .expect("document too short for its icon");
    description.push_str(&".".repeat(fill));
    let doc = format!("{head}{description}{tail}");
    assert_eq!(doc.len(), len);
    doc
}

/// A uri of exactly `len` bytes after `https://noised.example/m/` that
/// cycles through every printable ASCII byte (0x21..=0x7E), all of which an
/// external uri may hold.
fn printable_uri(len: usize) -> String {
    let mut uri = String::from("https://noised.example/m/");
    for b in (0x21..=0x7Eu8).cycle() {
        if uri.len() >= len {
            break;
        }
        uri.push(char::from(b));
    }
    uri
}

/// No uri (the default): the largest record without one (name 32 bytes,
/// symbol 10, document 3,072).
fn no_uri_record() -> Record {
    let name = exactly("Noised Default Mode ", MAX_NAME_LEN);
    let symbol = exactly("PHXDEF", MAX_SYMBOL_LEN);
    Record {
        doc: document(&name, &symbol, MAX_DOC_LEN),
        name,
        symbol,
        flags: 0,
        uri: String::new(),
    }
}

/// `INLINE_URI` at the largest document, with a multi-byte name and symbol
/// of the largest sizes: the longest uri a record derives (4,125 bytes).
fn inline_max_record() -> Record {
    let name = exactly("Noised 🛡 Inline ", MAX_NAME_LEN);
    let symbol = "PHX🛡INL".to_string();
    assert_eq!(symbol.len(), MAX_SYMBOL_LEN);
    Record {
        doc: document(&name, &symbol, MAX_DOC_LEN),
        name,
        symbol,
        flags: META_FLAG_INLINE_URI,
        uri: String::new(),
    }
}

/// `INLINE_URI` of a typical 1,300-byte document (one byte over a multiple
/// of 3: the base64 ends in `==`).
fn inline_typical_record() -> Record {
    let (name, symbol) = ("Phalanx Cryo Token".to_string(), "PHXCR".to_string());
    Record {
        doc: document(&name, &symbol, 1_300),
        name,
        symbol,
        flags: META_FLAG_INLINE_URI,
        uri: String::new(),
    }
}

/// `EXTERNAL_URI` of 200 bytes with every printable ASCII byte, and the
/// largest document: the largest record (3,405 bytes).
fn external_record() -> Record {
    let name = exactly("Noised External ", MAX_NAME_LEN);
    let symbol = exactly("PHXEXT", MAX_SYMBOL_LEN);
    let uri = printable_uri(MAX_URI_LEN);
    assert_eq!(uri.len(), MAX_URI_LEN);
    Record {
        doc: document(&name, &symbol, MAX_DOC_LEN),
        name,
        symbol,
        flags: META_FLAG_EXTERNAL_URI,
        uri,
    }
}

/// The single event `T` of a transaction.
#[track_caller]
fn one_event<T: anchor_lang::Event>(sent: &Sent) -> T {
    let mut all = events::<T>(&sent.logs);
    assert_eq!(all.len(), 1, "{}", sent.logs.join("\n"));
    all.remove(0)
}

/// A launch of the test creator created (not attested) under `seed`, in the
/// world's ledger.
fn create_another(w: &mut World, seed: [u8; 32]) -> (Keys, Keypair) {
    let mint = Keypair::new();
    let c = w.creator.pubkey();
    let k = Keys::new(&c, seed, mint.pubkey());
    let p = w.params.clone();
    w.env
        .send(&[create_launch(&c, &k, p)], &[&w.creator])
        .expect_ok("create_launch");
    (k, mint)
}

/// The test creator's signature of launch `k`'s message for this record and
/// these terms, at the leaf that message probes to (the client's rule).
fn sign_next(env: &Env, k: &Keys, meta: pq::Meta, terms: Terms) -> pq::Signed {
    let msg = pq::message(env, k, meta, &terms);
    let q = pq::next_free_leaf(env, pq::identity(), &msg);
    pq::sign_with(env, pq::identity(), q, k, meta, terms)
}

/// `launch` of launch `k` with record `record`, as the creator sends it: a
/// legacy transaction with both compute-budget instructions.
fn launch_tx(w: &mut World, k: &Keys, mint: &Keypair, record: Pubkey) -> Result<Sent, Failed> {
    let c = w.creator.pubkey();
    let ixs = [
        ComputeBudgetInstruction::set_compute_unit_price(1_000),
        launch_with_record(&c, k, record),
    ];
    w.env.send_with(&c, &ixs, &[&w.creator, mint], true)
}

/// The mint's Token-2022 metadata, decoded independently of the program.
fn mint_metadata(env: &Env, mint: &Pubkey) -> TokenMetadata {
    let account = env.account(mint).expect("the mint");
    assert_eq!(account.owner, spl_token_2022::ID);
    StateWithExtensions::<Mint>::unpack(&account.data)
        .expect("a Token-2022 mint")
        .get_variable_len_extension::<TokenMetadata>()
        .expect("embedded TokenMetadata")
}

/// The launched mint holds exactly the record's name and symbol and the uri
/// derived from it, with no update authority and no additional metadata,
/// and is exactly `386 + name + symbol + uri` bytes; the certificate sets
/// every check, `METADATA_ONCHAIN` (2,048) included, and names the record.
#[track_caller]
fn assert_launched_with(env: &Env, k: &Keys, r: &Record) {
    let uri = r.mint_uri();
    let md = mint_metadata(env, &k.mint);
    assert_eq!(
        (md.name.as_str(), md.symbol.as_str(), md.uri.as_str()),
        (r.name.as_str(), r.symbol.as_str(), uri.as_str())
    );
    assert_eq!(Option::<Pubkey>::from(md.update_authority), None);
    assert_eq!(md.mint, k.mint);
    assert!(md.additional_metadata.is_empty());
    let mint = env.account(&k.mint).unwrap();
    assert_eq!(
        mint.data.len(),
        386 + r.name.len() + r.symbol.len() + uri.len()
    );
    let cert: Certificate = env.anchor(&k.certificate);
    assert_eq!(
        (cert.version, cert.policy_version, SAFETY_POLICY_VERSION),
        (4, 3, 3)
    );
    assert_eq!(
        (cert.checks, checks::ALL, checks::METADATA_ONCHAIN),
        (4_095, 4_095, 2_048)
    );
    let record = pq::token_meta_pda(&k.launch, &r.hash());
    assert_eq!(cert.metadata, record);
    let attestation: Attestation = env.anchor(&k.attestation);
    assert_eq!(attestation.metadata_hash, r.hash());
    assert_eq!(env.anchor::<Launch>(&k.launch).status, LaunchStatus::Live);
}

/// `launch`'s post-condition (`checks::verify_token_metadata`) on a mint's
/// bytes: exactly the record's name and symbol and the derived uri pass
/// (`METADATA_ONCHAIN`); any other name, symbol or uri, by one byte more,
/// one byte less or one byte changed, is `MetadataMismatch`.
#[track_caller]
fn assert_compares_exactly(data: &[u8], name: &str, symbol: &str, uri: &str) {
    let check = |n: &str, s: &str, u: &[u8]| post::verify_token_metadata(data, n, s, u);
    assert_eq!(
        check(name, symbol, uri.as_bytes()).expect("the mint's own metadata"),
        checks::METADATA_ONCHAIN
    );
    let mismatch = |n: &str, s: &str, u: &[u8], what: &str| {
        assert_eq!(
            check(n, s, u).expect_err(what),
            E::MetadataMismatch.into(),
            "{what}"
        );
    };
    let (longer_name, longer_symbol) = (format!("{name}x"), format!("{symbol}x"));
    let shorter = |s: &str| {
        let mut s = s.to_string();
        s.pop();
        s
    };
    let first_changed = |s: &str| format!("Q{}", &s[1..]);
    let u = uri.as_bytes();
    mismatch(&longer_name, symbol, u, "a name one byte longer");
    mismatch(&shorter(name), symbol, u, "a name one byte shorter");
    mismatch(
        &first_changed(name),
        symbol,
        u,
        "another first byte of the name",
    );
    mismatch(name, &longer_symbol, u, "a symbol one byte longer");
    mismatch(name, &shorter(symbol), u, "a symbol one character shorter");
    mismatch(
        name,
        &first_changed(symbol),
        u,
        "another first byte of the symbol",
    );
    mismatch(symbol, name, u, "name and symbol swapped");
    mismatch(name, symbol, &[u, b"x"].concat(), "a uri one byte longer");
    if u.is_empty() {
        mismatch(name, symbol, b"x", "a uri where there is none");
    } else {
        mismatch(name, symbol, &u[..u.len() - 1], "a uri one byte shorter");
        mismatch(name, symbol, b"", "no uri");
        for at in [0, u.len() / 2, u.len() - 1] {
            let mut changed = u.to_vec();
            changed[at] ^= 0x01;
            mismatch(name, symbol, &changed, "a uri with one byte changed");
        }
    }
    // The mint's own bytes changed: TokenMetadata is the last TLV entry and
    // ends with its additional-metadata count (0); a count of 1 is refused.
    let mut forged = data.to_vec();
    let count_at = forged.len() - 4;
    assert_eq!(forged[count_at..], [0u8; 4]);
    forged[count_at] = 1;
    assert_eq!(
        post::verify_token_metadata(&forged, name, symbol, u).expect_err("a forged count"),
        E::MetadataMismatch.into()
    );
}

/// `create_launch`, `publish_metadata` (v1, throwaway payer), `attest_launch`
/// (v1, throwaway payer) and `launch` (legacy, the creator) of record `r`,
/// checked step by step against the spec; then the batch and public trading
/// on the launched mint. Prints `MEASURE` lines.
fn end_to_end(label: &str, r: &Record) {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let hash = r.hash();
    let record = pq::token_meta_pda(&k.launch, &hash);
    assert_eq!(record, pq::token_meta_of(&k, r.meta()));
    let uri = r.mint_uri();
    // The SDK's derivation (`policy::token_uri`) agrees with the spec.
    assert_eq!(
        noised_launchpad::policy::token_uri(r.flags, &r.uri, &r.doc),
        uri
    );

    // 1. The record, published whole by a throwaway payer.
    let publish = pq::try_publish(&mut w.env, &k, r.meta()).expect_ok("publish_metadata");
    assert!(publish.size <= V1_MAX_TRANSACTION_SIZE);
    let account = w.env.account(&record).expect("the record");
    assert_eq!(account.owner, noised_launchpad::ID);
    assert_eq!(
        account.data,
        r.account_bytes(&k.launch),
        "{label}: record bytes"
    );
    let size = 91 + r.name.len() + r.symbol.len() + r.uri.len() + r.doc.len();
    assert_eq!(account.data.len(), size);
    assert_eq!(
        account.lamports,
        w.env.svm.minimum_balance_for_rent_exemption(size)
    );
    let stored: TokenMeta = w.env.anchor(&record);
    assert_eq!(
        (
            stored.version,
            stored.flags,
            stored.launch,
            stored.metadata_hash
        ),
        (1, r.flags, k.launch, hash)
    );
    let e: MetadataPublished = one_event(&publish);
    assert_eq!(
        (e.launch, e.token_meta, e.metadata_hash, e.flags),
        (k.launch, record, hash, r.flags)
    );
    assert_eq!(
        (usize::from(e.uri_len), usize::from(e.doc_len)),
        (r.uri.len(), r.doc.len())
    );

    // 2. The identity signs the record's hash: the attestation names it.
    let attest = pq::attest(&mut w.env, &k, r.meta());
    assert!(attest.size <= V1_MAX_TRANSACTION_SIZE);
    assert_eq!(one_event::<LaunchAttested>(&attest).metadata_hash, hash);

    // 3. `launch`, with no arguments: DBC creates the mint from the record.
    let launch = launch_tx(&mut w, &k, &mint, record).expect_ok("launch");
    assert!(launch.size <= PACKET_DATA_SIZE);
    assert_launched_with(&w.env, &k, r);
    let data = w.env.account(&k.mint).unwrap().data;
    assert_compares_exactly(&data, &r.name, &r.symbol, &uri);
    // The transactions do not depend on the record: every mode's `launch`
    // and `attest_launch` have the sizes of the first one measured here.
    static SIZES: OnceLock<(usize, usize)> = OnceLock::new();
    let first = *SIZES.get_or_init(|| (launch.size, attest.size));
    assert_eq!((launch.size, attest.size), first, "{label}: sizes");

    // Once the launch is live, no record is published under it.
    let late = Record {
        flags: 0,
        uri: String::new(),
        doc: String::new(),
        ..r.clone()
    };
    pq::try_publish(&mut w.env, &k, late.meta()).fails_with(
        code(E::WrongLaunchState),
        "WrongLaunchState",
        "a record under a live launch",
    );

    let launchpad_cu = program_cu(&launch.logs, &noised_launchpad::ID, Some(1));
    let dbc_cu = program_cu(&launch.logs, &DBC_PROGRAM_ID, Some(2));
    let hook_cu = program_cu(&launch.logs, &noised_hook::ID, Some(2));
    let mint_size = data.len();
    let rent = |size: usize| w.env.svm.minimum_balance_for_rent_exemption(size);
    println!(
        "MEASURE {label}: publish_metadata {} CU, {} B (v1) | attest_launch {} CU, {} B (v1) | launch {} CU, {} B (legacy; launchpad {launchpad_cu} CU of which DBC {dbc_cu}, hook {hook_cu}) | record {size} B, rent {} | mint {mint_size} B, rent {} (at mainnet's 5,080 lamports per byte, FACTS #314: {} and {})",
        publish.cu,
        publish.size,
        attest.cu,
        attest.size,
        launch.cu,
        launch.size,
        rent(size),
        rent(mint_size),
        (size + 128) * 5_080,
        (mint_size + 128) * 5_080,
    );
    // An instrumented build (heap marks) logs `MEASURE` lines; ours none.
    for line in launch.logs.iter().filter(|l| l.contains("MEASURE")) {
        println!("MEASURE {label}: {line}");
    }

    batch_works(&mut w, label);
}

/// The batch on a metadata launch: two commits (1 and 2 SOL), executed at
/// the end of the commit window, both claimed pro rata (tokens through the
/// Launch Guard hook), then a public buy and a sell on DBC.
fn batch_works(w: &mut World, label: &str) {
    let k = w.k;
    let env = &mut w.env;
    let alice = committer(env, LAMPORTS_PER_SOL);
    let bob = committer(env, 2 * LAMPORTS_PER_SOL);
    let mut commit_cu = Vec::new();
    for (who, amount) in [(&alice, LAMPORTS_PER_SOL), (&bob, 2 * LAMPORTS_PER_SOL)] {
        let sent = env
            .send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit after a metadata launch");
        commit_cu.push(sent.cu);
    }
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    let executed = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch after a metadata launch");
    let mut claim_cu = Vec::new();
    for who in [&alice, &bob] {
        let sent = env
            .send(&[claim(&payer, &k, &who.pubkey(), true, true)], &[])
            .expect_ok("claim after a metadata launch");
        claim_cu.push(sent.cu);
    }
    let l: Launch = env.anchor(&k.launch);
    assert!(l.executed && l.tokens_out > 0);
    let share = |amount: u64| {
        (u128::from(l.tokens_out) * u128::from(amount) / u128::from(3 * LAMPORTS_PER_SOL)) as u64
    };
    let alice_tokens = env.token_amount(&base_ata(&alice.pubkey(), &k.mint));
    assert_eq!(alice_tokens, share(LAMPORTS_PER_SOL));
    assert_eq!(
        env.token_amount(&base_ata(&bob.pubkey(), &k.mint)),
        share(2 * LAMPORTS_PER_SOL)
    );
    assert_escrow_invariants(env, &k);
    let carol = buyer(env, &k);
    let bought = env
        .send(
            &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL / 200)],
            &[&carol],
        )
        .expect_ok("a public buy of a metadata mint");
    assert!(env.token_amount(&base_ata(&carol.pubkey(), &k.mint)) > 0);
    env.send(
        &[dbc_swap(&alice.pubkey(), &k, false, alice_tokens / 2)],
        &[&alice],
    )
    .expect_ok("a sell of a metadata mint");
    println!(
        "MEASURE {label}: commit {commit_cu:?} CU | execute_batch {} CU | claim {claim_cu:?} CU | public buy {} CU",
        executed.cu, bought.cu
    );
}

/// The default mode: no uri. The mint's uri is empty whatever the document
/// (the largest here), so every wallet and indexer shows the record's name
/// and symbol and nothing can break.
#[test]
fn no_uri_mode_end_to_end() {
    let r = no_uri_record();
    assert_eq!(r.mint_uri(), "");
    end_to_end("no uri, name 32, symbol 10, document 3,072", &r);
}

/// `INLINE_URI` at the largest document, with a multi-byte name and symbol
/// of the largest sizes: the mint's uri is the 4,125-byte data uri of the
/// document, which mainnet DBC and Token-2022 store byte for byte. Its
/// base64 holds `+` and `/`.
#[test]
fn inline_uri_mode_end_to_end_at_the_largest_document() {
    let r = inline_max_record();
    let uri = r.mint_uri();
    assert_eq!(uri.len(), MAX_INLINE_URI_LEN);
    assert_eq!(MAX_INLINE_URI_LEN, 4_125);
    assert!(uri.contains('+') && uri.contains('/') && !uri.ends_with('='));
    end_to_end("inline uri 4,125, name 32 (multi-byte), symbol 10", &r);
}

/// `INLINE_URI` of a typical document whose base64 is padded with `==`.
#[test]
fn inline_uri_mode_end_to_end_with_a_typical_document() {
    let r = inline_typical_record();
    let uri = r.mint_uri();
    assert!(uri.ends_with("==") && !uri.ends_with("==="));
    assert_eq!(
        uri.len(),
        DATA_URI_PREFIX.len() + 1_300_usize.div_ceil(3) * 4
    );
    end_to_end("inline uri 1,765, name 18, symbol 5", &r);
}

/// `EXTERNAL_URI` of 200 bytes holding every printable ASCII byte, with the
/// largest document: the largest record. The mint gets the uri verbatim.
#[test]
fn external_uri_mode_end_to_end_at_200_bytes() {
    let r = external_record();
    end_to_end("external uri 200, name 32, symbol 10, document 3,072", &r);
}

/// `[launch, commit]` (a v1 bundle: the creator commits in the launch
/// transaction) at the largest inline uri, the heaviest `launch`: what the
/// SDK's bundle budget must cover.
#[test]
fn launch_and_commit_bundle_at_the_largest_inline_uri() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let r = inline_max_record();
    pq::attest(&mut w.env, &k, r.meta());
    let c = w.creator.pubkey();
    w.env
        .send(&wrap_sol(&c, LAMPORTS_PER_SOL), &[&w.creator])
        .expect_ok("creator wraps");
    let record = pq::token_meta_of(&k, r.meta());
    let ixs = [
        launch_with_record(&c, &k, record),
        commit(&c, &k, LAMPORTS_PER_SOL),
    ];
    let config = solana_message::v1::TransactionConfig::empty()
        .with_compute_unit_limit(1_400_000)
        .with_priority_fee(10_000)
        .with_loaded_accounts_data_size_limit(64 * 1024 * 1024);
    let bundle = w
        .env
        .send_v1(&w.creator, &ixs, &[&mint], config)
        .expect_ok("[launch, commit] at the largest inline uri");
    assert_launched_with(&w.env, &k, &r);
    let extra = bump_iterations(&k);
    println!(
        "MEASURE [launch, commit] (v1, priority fee) at the largest inline uri: {} CU ({} without the mint's {extra} extra bump iterations), {} B",
        bundle.cu,
        bundle.cu - 1_500 * extra,
        bundle.size
    );
}

/// How many times `launch` runs each bump search of `bump_searches`: the
/// DBC base vault twice (DBC creates it, the hook's `create_policy` derives
/// it again), every other once.
const SEARCH_TIMES: [u64; 6] = [1, 1, 2, 1, 1, 1];

/// The bump searches `launch` makes that depend on its mint (the payer's
/// fresh keypair), as the addresses each tries after bump 255: the
/// certificate (the launchpad), the DBC pool, its base and quote vaults,
/// the hook's meta list and policy. Each address tried costs 1,500 CU
/// (`create_program_address`).
fn bump_searches(k: &Keys) -> [u64; 6] {
    let extra = |seeds: &[&[u8]], program: &Pubkey| {
        255 - u64::from(Pubkey::find_program_address(seeds, program).1)
    };
    let (hi, lo) = if k.mint > WSOL_MINT {
        (k.mint, WSOL_MINT)
    } else {
        (WSOL_MINT, k.mint)
    };
    [
        extra(&[CERTIFICATE_SEED, k.mint.as_ref()], &noised_launchpad::ID),
        extra(
            &[b"pool", k.dbc_config.as_ref(), hi.as_ref(), lo.as_ref()],
            &DBC_PROGRAM_ID,
        ),
        extra(
            &[b"token_vault", k.mint.as_ref(), k.pool.as_ref()],
            &DBC_PROGRAM_ID,
        ),
        extra(
            &[b"token_vault", WSOL_MINT.as_ref(), k.pool.as_ref()],
            &DBC_PROGRAM_ID,
        ),
        extra(&[b"extra-account-metas", k.mint.as_ref()], &noised_hook::ID),
        extra(&[b"policy", k.mint.as_ref()], &noised_hook::ID),
    ]
}

/// The extra iterations of `bump_searches` that `launch` runs, in total.
fn bump_iterations(k: &Keys) -> u64 {
    bump_searches(k)
        .iter()
        .zip(SEARCH_TIMES)
        .map(|(extra, times)| extra * times)
        .sum()
}

/// The smallest `n` with P(X > n) < 1e-6 for X = sum of `times_i * G_i`, the
/// `G_i` independent geometric(1/2) counts (the addresses a bump search
/// tries after 255: each is a valid PDA with probability 1/2).
fn tail_iterations(times: &[u64]) -> u64 {
    const N: usize = 256;
    let mut pmf = vec![0f64; N];
    pmf[0] = 1.0;
    for &t in times {
        let mut next = vec![0f64; N];
        for (i, p) in pmf.iter().enumerate() {
            for (j, at) in (i..N).step_by(t as usize).enumerate() {
                next[at] += p * 0.5f64.powi(j as i32 + 1);
            }
        }
        pmf = next;
    }
    let mut tail = 1.0;
    for (n, p) in pmf.iter().enumerate() {
        tail -= p;
        if tail < 1e-6 {
            return n as u64;
        }
    }
    panic!("no tail under 1e-6 within {N} iterations")
}

/// The compute of `launch`, per uri mode at the largest records: a constant
/// per record (its base) plus 1,500 CU per extra bump iteration of the PDAs
/// its mint names (`bump_searches`), checked over several mints. The
/// iterations are random, and more than 47 of them in total has a
/// probability under 1e-6: the base plus 47 iterations is what a client
/// must budget, and it stays under `LAUNCH_CU_BUDGET`. A client whose mint
/// keypair has all six bumps at 255 (one keypair in 64) pays the base alone.
#[test]
fn launch_compute_is_a_base_per_record_plus_the_mints_bump_searches() {
    /// The `launch` compute-unit limit a client must set for every record
    /// (the SDK's 200,000 is short in the inline mode).
    const LAUNCH_CU_BUDGET: u64 = 300_000;
    const MINTS: u8 = 6;
    let tail = tail_iterations(&SEARCH_TIMES);
    assert_eq!(tail, 47);
    for (label, r) in [
        ("no uri, document 3,072", no_uri_record()),
        ("inline uri 4,125", inline_max_record()),
        ("external uri 200, document 3,072", external_record()),
    ] {
        let mut w = created_with(|_| {});
        let (mut bases, mut seen) = (Vec::new(), Vec::new());
        for i in 0..MINTS {
            let (k, mint) = if i == 0 {
                (w.k, w.mint.insecure_clone())
            } else {
                create_another(&mut w, [0xC0 + i; 32])
            };
            pq::attest(&mut w.env, &k, r.meta());
            let record = pq::token_meta_of(&k, r.meta());
            let sent = launch_tx(&mut w, &k, &mint, record).expect_ok(label);
            let extra = bump_iterations(&k);
            bases.push(sent.cu - 1_500 * extra);
            seen.push((sent.cu, extra));
        }
        let base = *bases.iter().max().unwrap();
        assert!(
            bases.iter().all(|b| base - b <= 50),
            "{label}: bases {bases:?} from {seen:?}"
        );
        let worst = base + 1_500 * tail;
        println!(
            "MEASURE launch compute, {label}: base {base} CU (bases {bases:?}; launches {seen:?} as (CU, extra iterations)); {worst} CU with {tail} extra iterations (p < 1e-6)"
        );
        assert!(worst <= LAUNCH_CU_BUDGET, "{label}: {worst} CU");
    }
}

/// The SDK's metadata vectors (`tests/integration/vectors/metadata.json`,
/// generated in Rust and checked by the Python reference) on mainnet DBC
/// and Token-2022: each record publishes, is attested and launches, and
/// the mint holds exactly the vector's `tokenUri` (and the record's name and
/// symbol). The vectors' launch address is not this ledger's, so the record
/// addresses differ; their hashes do not.
#[test]
fn the_sdk_metadata_vectors_launch_to_their_documented_uri() {
    let v = vectors();
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.len() >= 8);
    assert_eq!(v["parameters"]["inlineUriPrefix"], DATA_URI_PREFIX);
    let mut w = created_with(|_| {});
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let r = Record::from_vector(&case["record"]);
        assert_eq!(hex(&r.hash()), case["metadataHash"], "{name}");
        let want = case["tokenUri"].as_str().expect("tokenUri");
        assert_eq!(r.mint_uri(), want, "{name}");
        assert_eq!(Some(want.len() as u64), case["tokenUriLen"].as_u64());
        let (k, mint) = if i == 0 {
            (w.k, w.mint.insecure_clone())
        } else {
            create_another(&mut w, [0x40 + i as u8; 32])
        };
        pq::attest(&mut w.env, &k, r.meta());
        let record = pq::token_meta_of(&k, r.meta());
        let sent = launch_tx(&mut w, &k, &mint, record).expect_ok(name);
        assert_launched_with(&w.env, &k, &r);
        assert_eq!(mint_metadata(&w.env, &k.mint).uri, want, "{name}");
        println!(
            "MEASURE vectors, {name}: launch {} CU (DBC {}), mint {} B",
            sent.cu,
            program_cu(&sent.logs, &DBC_PROGRAM_ID, Some(2)),
            w.env.account(&k.mint).unwrap().data.len()
        );
    }
}

/// DBC's `initialize_virtual_pool_with_token2022_transfer_hook` of `uri`,
/// called directly by `creator` on launch `k`'s DBC config (DBC lets any
/// signer create a pool on a config) for the mint `k.mint`.
fn dbc_pool_ix(
    creator: &Pubkey,
    payer: &Pubkey,
    k: &Keys,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Instruction {
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: dbc_acc::InitializeVirtualPoolWithToken2022TransferHook {
            config: k.dbc_config,
            pool_authority: DBC_POOL_AUTHORITY,
            creator: *creator,
            base_mint: k.mint,
            quote_mint: WSOL_MINT,
            pool: k.pool,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            transfer_hook_program: noised_hook::ID,
            payer: *payer,
            token_quote_program: TOKEN_PROGRAM_ID,
            token_program: TOKEN_2022_PROGRAM_ID,
            system_program: system_program::ID,
            event_authority: DBC_EVENT_AUTHORITY,
            program: DBC_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: dbc_args::InitializeVirtualPoolWithToken2022TransferHook {
            params: InitializePoolParameters {
                name: name.into(),
                symbol: symbol.into(),
                uri: uri.into(),
            },
        }
        .data(),
    }
}

/// METADATA_ONCHAIN.md §4.7: DBC creates the mint on its own 32 KiB heap
/// (its default bump allocator), holding the uri there several times, so
/// the uri DBC can take is bounded. The largest uri a record derives (an
/// inline uri of 4,125 bytes, with a 32-byte name and a 10-byte symbol)
/// must pass with a margin of at least 2x: DBC is called directly, on a
/// launch's config with the same name and symbol and growing uris, until
/// it runs out of memory. A CPI from `launch` runs DBC on a heap of its own
/// too, with the same accounts and the same data (`dbc_params` pins it to
/// Anchor's encoding), so the bound is the same. LiteSVM does not enforce
/// the wire size; a mint of 10,240 bytes or more could not be created in
/// one instruction anyway, so the search stops at a 9,800-byte uri.
#[test]
fn dbc_takes_the_largest_inline_uri_with_room_to_spare() {
    let mut w = created_with(|_| {});
    let launch = w.k;
    let name = exactly("Noised DBC Heap ", MAX_NAME_LEN);
    let symbol = exactly("PHXHEAP", MAX_SYMBOL_LEN);
    let pool = |env: &mut Env, len: usize| {
        let mint = Keypair::new();
        let k = Keys::new(&launch.creator, launch.seed, mint.pubkey());
        let creator = Keypair::new();
        let uri = format!(
            "{DATA_URI_PREFIX}{}",
            "A".repeat(len - DATA_URI_PREFIX.len())
        );
        let payer = env.payer.pubkey();
        let ix = dbc_pool_ix(&creator.pubkey(), &payer, &k, &name, &symbol, &uri);
        let result = env.send_large(&[ix], &[&creator, &mint]);
        if result.is_ok() {
            assert_eq!(mint_metadata(env, &k.mint).uri, uri);
        }
        result
    };
    let out_of_memory = |f: &Failed, len: usize| {
        let logs = f.logs.join("\n");
        assert!(
            logs.contains("memory allocation failed, out of memory"),
            "a {len}-byte uri fails otherwise:\n{logs}"
        );
        // The allocation fails in DBC itself, not in Token-2022 under it.
        let failed: Vec<_> = f.logs.iter().filter(|l| l.contains(" failed: ")).collect();
        assert!(
            failed
                .iter()
                .all(|l| l.starts_with(&format!("Program {DBC_PROGRAM_ID} failed"))),
            "{logs}"
        );
    };
    let max = MAX_INLINE_URI_LEN;
    let at_max = pool(&mut w.env, max).expect_ok("DBC at the largest inline uri");
    let mut ok = max;
    let mut bad = 9_800;
    match pool(&mut w.env, bad) {
        Ok(_) => panic!("DBC takes a {bad}-byte uri"),
        Err(f) => out_of_memory(&f, bad),
    }
    while bad - ok > 1 {
        let mid = (ok + bad) / 2;
        match pool(&mut w.env, mid) {
            Ok(_) => ok = mid,
            Err(f) => {
                out_of_memory(&f, mid);
                bad = mid;
            }
        }
    }
    println!(
        "MEASURE DBC heap: a {max}-byte uri (the largest inline uri) passes at {} DBC CU; the largest uri DBC takes is {ok} bytes, {bad} runs out of memory: {:.2}x the largest inline uri",
        program_cu(&at_max.logs, &DBC_PROGRAM_ID, Some(1)),
        ok as f64 / max as f64
    );
    assert!(ok >= 2 * max, "DBC takes at most {ok} bytes");
}

/// `launch`'s post-condition (`checks::verify_token_metadata`), pinned on
/// Token-2022's own encoding: a mint made here through the metadata
/// interface (the test keeps the update authority, which a launch mint
/// never has) with exactly a record's name, symbol and inline uri passes;
/// one entry of additional metadata, or any field Token-2022 updates to
/// another value, is `MetadataMismatch`; undone, it passes again.
#[test]
fn the_post_condition_compares_token_2022s_own_encoding() {
    let mut env = Env::new();
    let r = inline_max_record();
    let uri = r.mint_uri();
    let authority = env.funded(1);
    let a = authority.pubkey();
    let mint = Keypair::new();
    let m = mint.pubkey();
    let payer = env.payer.pubkey();
    let space = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::MetadataPointer])
        .expect("mint size");
    let ixs = [
        system_instruction::create_account(
            &payer,
            &m,
            // Rent for the largest size the updates below reach.
            env.svm.minimum_balance_for_rent_exemption(10_240),
            space as u64,
            &spl_token_2022::ID,
        ),
        metadata_pointer::instruction::initialize(&spl_token_2022::ID, &m, None, Some(m)).unwrap(),
        spl_token_2022::instruction::initialize_mint2(&spl_token_2022::ID, &m, &a, None, 6)
            .unwrap(),
        spl_token_metadata_interface::instruction::initialize(
            &spl_token_2022::ID,
            &m,
            &a,
            &m,
            &a,
            r.name.clone(),
            r.symbol.clone(),
            uri.clone(),
        ),
    ];
    env.send_large(&ixs, &[&mint, &authority])
        .expect_ok("a Token-2022 mint with the record's metadata");
    let check = |env: &Env| {
        let data = env.account(&m).unwrap().data;
        post::verify_token_metadata(&data, &r.name, &r.symbol, uri.as_bytes())
    };
    let passes = |env: &Env, what: &str| {
        assert_eq!(check(env).expect(what), checks::METADATA_ONCHAIN, "{what}")
    };
    let refused = |env: &Env, what: &str| {
        assert_eq!(
            check(env).expect_err(what),
            E::MetadataMismatch.into(),
            "{what}"
        )
    };
    passes(&env, "exactly the record");
    let data = env.account(&m).unwrap().data;
    assert_compares_exactly(&data, &r.name, &r.symbol, &uri);

    let update = |env: &mut Env, field: Field, value: &str| {
        let ix = spl_token_metadata_interface::instruction::update_field(
            &spl_token_2022::ID,
            &m,
            &a,
            field,
            value.to_string(),
        );
        env.send_large(&[ix], &[&authority])
            .expect_ok("update_field");
    };
    update(&mut env, Field::Key("description".into()), "rugged");
    refused(&env, "an entry of additional metadata");
    let remove = spl_token_metadata_interface::instruction::remove_key(
        &spl_token_2022::ID,
        &m,
        &a,
        "description".into(),
        false,
    );
    env.send_large(&[remove], &[&authority])
        .expect_ok("remove_key");
    passes(&env, "the entry removed");
    for (field, other, original) in [
        (Field::Uri, format!("{uri}x"), uri.clone()),
        (Field::Uri, String::new(), uri.clone()),
        (Field::Name, "Rugged".to_string(), r.name.clone()),
        (Field::Symbol, "RUG".to_string(), r.symbol.clone()),
    ] {
        update(&mut env, field.clone(), &other);
        refused(&env, &format!("{field:?} updated to {} bytes", other.len()));
        update(&mut env, field, &original);
        passes(&env, "the field restored");
    }
}

/// `launch` checks the record's own fields, not only its address (the seeds
/// name it by the attestation's hash) and its owner and discriminator:
/// rewritten in the ledger (address, owner and size unchanged) to another
/// version, another launch or another hash, the record is refused
/// (`AttestationMismatch`), with another bump it is not at its address
/// (`ConstraintSeeds`); with another discriminator or owner Anchor refuses
/// it. Restored, the launch goes live and the certificate names it.
#[test]
fn launch_checks_each_record_field_itself() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let (other, _) = create_another(&mut w, [0x0B; 32]);
    pq::attest(&mut w.env, &k, META);
    let record = pq::token_meta_of(&k, META);
    let original = w.env.account(&record).unwrap();
    let stored: TokenMeta = w.env.anchor(&record);
    let edited = |edit: &dyn Fn(&mut TokenMeta)| {
        let mut t = stored.clone();
        edit(&mut t);
        let mut data = Vec::new();
        t.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), original.data.len());
        data
    };
    let mismatch = (code(E::AttestationMismatch), "AttestationMismatch");
    let seeds = (CONSTRAINT_SEEDS, "ConstraintSeeds");
    let mut other_discriminator = original.data.clone();
    other_discriminator[0] ^= 1;
    for (what, data, owner, (error, name)) in [
        (
            "a record of version 0",
            edited(&|t| t.version = 0),
            noised_launchpad::ID,
            mismatch,
        ),
        (
            "a record of version 2",
            edited(&|t| t.version = 2),
            noised_launchpad::ID,
            mismatch,
        ),
        (
            "a record naming another launch",
            edited(&|t| t.launch = other.launch),
            noised_launchpad::ID,
            mismatch,
        ),
        (
            "a record naming another hash",
            edited(&|t| t.metadata_hash = pq::metadata_hash(("Rugged", SYMBOL, URI))),
            noised_launchpad::ID,
            mismatch,
        ),
        (
            "a record with another bump",
            edited(&|t| t.bump = t.bump.wrapping_sub(1)),
            noised_launchpad::ID,
            seeds,
        ),
        (
            "a record with another discriminator",
            other_discriminator,
            noised_launchpad::ID,
            (
                ACCOUNT_DISCRIMINATOR_MISMATCH,
                "AccountDiscriminatorMismatch",
            ),
        ),
        (
            "a record owned by the System program",
            original.data.clone(),
            system_program::ID,
            (ACCOUNT_OWNED_BY_WRONG_PROGRAM, "AccountOwnedByWrongProgram"),
        ),
    ] {
        let forged = Account {
            data,
            owner,
            ..original.clone()
        };
        w.env.svm.set_account(record, forged).unwrap();
        let f = launch_tx(&mut w, &k, &mint, record).fails_with(error, name, what);
        assert!(
            f.logs
                .iter()
                .any(|l| l.contains("caused by account: token_meta"))
                || error == code(E::AttestationMismatch),
            "{what}"
        );
    }
    assert_eq!(
        w.env.anchor::<Launch>(&k.launch).status,
        LaunchStatus::Configured
    );
    w.env.svm.set_account(record, original).unwrap();
    launch_tx(&mut w, &k, &mint, record).expect_ok("launch with the record restored");
    assert_eq!(w.env.anchor::<Certificate>(&k.certificate).metadata, record);
}

/// METADATA_ONCHAIN.md §4.11: anyone can send lamports to a record's
/// address before it is published, and a client may sign before it is
/// published (a race). Until then a valid signature over the record's hash
/// lands and only burns its leaf: a system account there is no record. A
/// record-shaped account the launchpad does not own (only a forged ledger
/// can hold one) attests nothing either. `publish_metadata` takes the
/// pre-funded address over, rent-exempt; the next signature attests and the
/// launch goes live.
#[test]
fn a_prefunded_record_address_blocks_nothing() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let meta: pq::Meta = META.into();
    let record = pq::token_meta_of(&k, meta);
    let mallory = w.env.funded(1);
    w.env
        .send(
            &[system_instruction::transfer(
                &mallory.pubkey(),
                &record,
                1_000_000,
            )],
            &[&mallory],
        )
        .expect_ok("pre-fund the record's address");
    assert_eq!(w.env.account(&record).unwrap().owner, system_program::ID);
    let burns_only = |w: &mut World, what: &str| {
        let signed = sign_next(&w.env, &k, meta, Terms::now(&w.env));
        let sent = pq::send_attestation(&mut w.env, &k, &signed, meta).expect_ok(what);
        assert_eq!(u32::from(one_event::<PqLeafConsumed>(&sent).leaf), signed.q);
        assert!(events::<LaunchAttested>(&sent.logs).is_empty(), "{what}");
        let empty: Attestation = w.env.anchor(&k.attestation);
        assert_eq!(empty.launch, Pubkey::default(), "{what}");
    };
    burns_only(&mut w, "a signature over a pre-funded, unpublished record");

    let rent = w
        .env
        .svm
        .minimum_balance_for_rent_exemption(TokenMeta::space(
            NAME.len(),
            SYMBOL.len(),
            URI.len(),
            0,
        ));
    assert!(rent > 1_000_000);
    pq::publish(&mut w.env, &k, meta);
    let published = w.env.account(&record).unwrap();
    assert_eq!(
        (published.owner, published.lamports),
        (noised_launchpad::ID, rent)
    );

    // The same bytes under another owner: not a record.
    w.env
        .svm
        .set_account(
            record,
            Account {
                owner: noised_vault::ID,
                ..published.clone()
            },
        )
        .unwrap();
    burns_only(
        &mut w,
        "a signature over a record the launchpad does not own",
    );
    w.env.svm.set_account(record, published).unwrap();

    pq::attest(&mut w.env, &k, meta);
    let attestation: Attestation = w.env.anchor(&k.attestation);
    assert_eq!(attestation.launch, k.launch);
    launch_tx(&mut w, &k, &mint, record).expect_ok("launch");
    assert_launched_with(
        &w.env,
        &k,
        &Record {
            name: NAME.into(),
            symbol: SYMBOL.into(),
            flags: META_FLAG_EXTERNAL_URI,
            uri: URI.into(),
            doc: String::new(),
        },
    );
}

/// The adversarial review of the metadata change: `attest_launch`'s record
/// account is the one address the signed hash names, so whoever relays a
/// creator's signature cannot choose what it does. The creator publishes
/// the record, then sends its attestation; Mallory, who sees it before it
/// lands (a leader, an RPC node, a relayer), copies it and names another
/// account as the record: the launch, the System program, a random key,
/// another record of the launch, the same record under another launch, or
/// the record's exact bytes at another address. Each copy fails
/// (`ConstraintSeeds` on `token_meta`) and burns nothing, so it cannot land
/// first and burn the leaf (which left the launch unattested and the
/// creator's own transaction failing `PqLeafUsed`, at every retry). The
/// creator's transaction, with the same signature, then attests and the
/// launch goes live.
#[test]
fn a_relayer_cannot_turn_an_attesting_signature_into_a_burn() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let (other, _) = create_another(&mut w, [0x0B; 32]);
    let meta: pq::Meta = META.into();
    let junk: pq::Meta = (NAME, SYMBOL, "").into();
    // The SDK's order: the record is published (and confirmed) first.
    pq::publish(&mut w.env, &k, meta);
    pq::publish(&mut w.env, &k, junk);
    pq::publish(&mut w.env, &other, meta);
    let record = pq::token_meta_of(&k, meta);
    let copy = Pubkey::new_unique();
    let published = w.env.account(&record).unwrap();
    w.env.svm.set_account(copy, published).unwrap();
    let decoys = [
        ("the launch", k.launch),
        ("the System program", system_program::ID),
        ("a random key", Pubkey::new_unique()),
        ("another record of the launch", pq::token_meta_of(&k, junk)),
        (
            "the same record under another launch",
            pq::token_meta_of(&other, meta),
        ),
        ("the record's bytes at another address", copy),
    ];

    let signed = sign_next(&w.env, &k, meta, Terms::now(&w.env));
    let creator_payer = pq::throwaway_payer(&mut w.env);
    let honest = pq::attest_launch_ix(
        &creator_payer.pubkey(),
        &k,
        signed.pk,
        signed.sig.clone(),
        meta,
        &signed.terms,
    );
    assert_eq!(honest.accounts[4].pubkey, record);
    let mallory = w.env.funded(1);
    let id = pq::identity_id();
    for (what, decoy) in decoys {
        let mut copy = honest.clone();
        copy.accounts[0] = solana_instruction::AccountMeta::new(mallory.pubkey(), true);
        copy.accounts[4] = solana_instruction::AccountMeta::new_readonly(decoy, false);
        let f = w
            .env
            .send_v1(&mallory, &[copy], &[], pq::attest_config())
            .fails_with(CONSTRAINT_SEEDS, "ConstraintSeeds", what);
        assert!(
            f.logs
                .iter()
                .any(|l| l.contains("caused by account: token_meta")),
            "{what}"
        );
        // Nothing burned or written: no identity or attestation account yet.
        assert!(pq::identity_account(&w.env, &id).is_none(), "{what}");
        assert!(w.env.account(&k.attestation).is_none(), "{what}");
    }

    let sent = w
        .env
        .send_v1(&creator_payer, &[honest], &[], pq::attest_config())
        .expect_ok("the creator's attestation");
    let e: LaunchAttested = one_event(&sent);
    assert_eq!(
        (u32::from(e.leaf), e.metadata_hash),
        (signed.q, pq::metadata_hash(meta))
    );
    let identity = pq::identity_account(&w.env, &id).unwrap();
    assert_eq!(identity.used_count, 1);
    assert!(pq::leaf_used(&identity, signed.q));
    println!(
        "MEASURE attest_launch after six refused copies: {} CU, {} B",
        sent.cu, sent.size
    );
    launch_tx(&mut w, &k, &mint, record).expect_ok("launch");
    assert_eq!(w.env.anchor::<Certificate>(&k.certificate).metadata, record);
}

/// The whole life of the largest metadata mints, past what the batch tests
/// reach (from the adversarial review, which ran it once): the inline uri of
/// the largest document (a 4,553-byte mint) and the largest record with its
/// 200-byte external uri, each attested and launched as the SDK does, then
/// the batch, a buy that completes the curve, the surplus and trading fees,
/// migration to DAMM v2, a sell and a buy there, the LP fees and
/// `distribute` (which burns the base tokens). The mint keeps exactly the
/// record's metadata throughout. Prints `MEASURE` lines.
#[test]
fn the_largest_metadata_mints_live_through_migration_to_damm_v2() {
    for (label, r) in [
        ("inline uri 4,125", inline_max_record()),
        ("external uri 200, document 3,072", external_record()),
    ] {
        lifecycle_of(label, &r);
    }
}

fn lifecycle_of(label: &str, r: &Record) {
    let mut w = created_with(|p| {
        p.max_buy_bps = 0;
        p.max_wallet_bps = 0;
        p.p2p_locked = false;
    });
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::attest(&mut w.env, &k, r.meta());
    let record = pq::token_meta_of(&k, r.meta());
    let launched = launch_tx(&mut w, &k, &mint, record).expect_ok(label);
    assert_launched_with(&w.env, &k, r);
    let mint_len = w.env.account(&k.mint).unwrap().data.len();

    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let alice = env.funded(10);
    let carol = env.funded(40);
    env.send(&wrap_sol(&alice.pubkey(), 2 * LAMPORTS_PER_SOL), &[&alice])
        .expect_ok("wrap");
    env.send(&wrap_sol(&carol.pubkey(), 30 * LAMPORTS_PER_SOL), &[&carol])
        .expect_ok("wrap");
    env.send(
        &[create_ata(
            &carol.pubkey(),
            &carol.pubkey(),
            &k.mint,
            &spl_token_2022::ID,
        )],
        &[&carol],
    )
    .expect_ok("the buyer's base-token account");
    env.send(
        &[commit(&alice.pubkey(), &k, 2 * LAMPORTS_PER_SOL)],
        &[&alice],
    )
    .expect_ok("commit");
    env.set_time(l.commit_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.send(&[claim(&payer, &k, &alice.pubkey(), true, true)], &[])
        .expect_ok("claim");
    env.set_time(l.execute_end_ts);
    env.send(
        &[dbc_swap_mode(
            &carol.pubkey(),
            &k,
            true,
            20 * LAMPORTS_PER_SOL,
            1,
            true,
        )],
        &[&carol],
    )
    .expect_ok("a buy that completes the curve");
    env.send(&[claim_surplus(&payer, &k)], &[])
        .expect_ok("claim_surplus");
    env.send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    let (d, [nft, _], migrated) = migrate_to_damm_v2(env, &k);
    let carol_tokens = env.token_amount(&base_ata(&carol.pubkey(), &k.mint));
    assert!(carol_tokens > 0);
    env.send(
        &[damm_swap(&carol.pubkey(), &k, &d, true, carol_tokens / 4)],
        &[&carol],
    )
    .expect_ok("a DAMM v2 sell");
    env.send(
        &[damm_swap(&carol.pubkey(), &k, &d, false, LAMPORTS_PER_SOL)],
        &[&carol],
    )
    .expect_ok("a DAMM v2 buy");
    env.send(&[claim_lp_fees(&payer, &k, &d, &nft)], &[])
        .expect_ok("claim_lp_fees");
    env.send(&[distribute(&payer, &k, &w.treasury, &w.recipients)], &[])
        .expect_ok("distribute");
    let md = mint_metadata(&w.env, &k.mint);
    assert_eq!(
        (md.name.as_str(), md.symbol.as_str(), md.uri.as_str()),
        (r.name.as_str(), r.symbol.as_str(), r.mint_uri().as_str()),
        "{label}: the mint's metadata after migration"
    );
    println!(
        "MEASURE lifecycle, {label}: launch {} CU, {} B, mint {mint_len} B | migration_damm_v2 {} CU, {} B",
        launched.cu, launched.size, migrated.cu, migrated.size
    );
}
