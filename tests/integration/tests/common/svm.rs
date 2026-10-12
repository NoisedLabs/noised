//! The LiteSVM test environment: programs, clock, transactions, reporting.

use std::{collections::HashSet, fmt::Display, path::Path, str::FromStr};

use anchor_lang::AccountDeserialize;
use base64::Engine as _;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address_lookup_table_interface::instruction::{
    create_lookup_table, extend_lookup_table,
};
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::{v0, v1, AddressLookupTableAccount, Message, VersionedMessage};
use solana_sdk_ids::{bpf_loader, bpf_loader_upgradeable, sysvar};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

use super::{
    paths, Pubkey, ATA_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};

/// Max compute units a transaction may request.
pub const MAX_CU_LIMIT: u32 = 1_400_000;
/// Max account data a transaction may load (the runtime's 64 MiB cap).
pub const MAX_LOADED_ACCOUNTS_DATA: u32 = 64 * 1024 * 1024;
/// Max wire size of a legacy or v0 transaction (`PACKET_DATA_SIZE`).
pub const PACKET_DATA_SIZE: usize = 1232;
/// Max wire size of a v1 transaction (SIMD-0385).
pub const V1_MAX_TRANSACTION_SIZE: usize = v1::MAX_TRANSACTION_SIZE;
/// Bytes charged per loaded account on top of its data (SIMD-0186).
pub const TRANSACTION_ACCOUNT_BASE_SIZE: u64 = 64;
/// 2026-01-01T00:00:00Z. LiteSVM starts at unix time 0; launches and policies
/// should see a realistic clock.
pub const GENESIS_UNIX_TS: i64 = 1_767_225_600;
/// Slots advance with time at mainnet's ~400 ms target.
const MS_PER_SLOT: i64 = 400;

/// A LiteSVM instance with mainnet programs and features, plus a funded fee payer.
pub struct Harness {
    pub svm: LiteSVM,
    /// Fee payer (and first signer) of every transaction the harness sends.
    pub payer: Keypair,
}

/// Programs and accounts to load. `Harness::new()` loads both of our
/// finished programs; DBC / DAMM v2 tests add Meteora's dumps.
pub struct HarnessBuilder {
    ours: Vec<(Pubkey, &'static str)>,
    fixture_programs: Vec<(Pubkey, String)>,
    fixture_accounts: Vec<String>,
}

impl Default for HarnessBuilder {
    fn default() -> Self {
        Self {
            ours: vec![
                (noised_vault::ID, "noised_vault"),
                (noised_hook::ID, "noised_hook"),
            ],
            fixture_programs: Vec::new(),
            fixture_accounts: Vec::new(),
        }
    }
}

impl HarnessBuilder {
    /// Load one of our programs from `<so_name>.so` (see [`paths::program_so`]).
    pub fn program(mut self, id: Pubkey, so_name: &'static str) -> Self {
        self.ours.push((id, so_name));
        self
    }

    /// Load a mainnet program dump (e.g. `dbc.so`) at `id` (upgradeable loader).
    pub fn fixture_program(mut self, id: Pubkey, file: &str) -> Self {
        self.fixture_programs.push((id, file.to_string()));
        self
    }

    /// Clone a mainnet account from `accounts/<pubkey>.json`
    /// (`solana account --output json-compact`).
    pub fn fixture_account(mut self, file: &str) -> Self {
        self.fixture_accounts.push(file.to_string());
        self
    }

    pub fn build(self) -> Harness {
        let mut svm = LiteSVM::new().with_log_bytes_limit(None);
        // Mainnet token programs instead of LiteSVM's bundled builds, on the
        // loaders mainnet uses (p-token replaced SPL Token under loader v3).
        let mainnet = [
            (
                TOKEN_2022_PROGRAM_ID,
                "token_2022.so",
                bpf_loader_upgradeable::ID,
            ),
            (TOKEN_PROGRAM_ID, "spl_token.so", bpf_loader_upgradeable::ID),
            (ATA_PROGRAM_ID, "associated_token.so", bpf_loader::ID),
        ];
        for (id, file, loader) in mainnet {
            let bytes = std::fs::read(paths::fixture(file)).expect("read fixture program");
            svm.add_program_with_loader(id, &bytes, loader)
                .unwrap_or_else(|e| panic!("load {file}: {e:?}"));
        }
        for (id, file) in &self.fixture_programs {
            svm.add_program_from_file(*id, paths::fixture(file))
                .unwrap_or_else(|e| panic!("load {file}: {e:?}"));
        }
        for (id, so_name) in &self.ours {
            svm.add_program_from_file(*id, paths::program_so(so_name))
                .unwrap_or_else(|e| panic!("load {so_name}.so: {e:?}"));
        }

        let mut h = Harness {
            svm,
            payer: Keypair::new(),
        };
        for file in &self.fixture_accounts {
            h.load_account_json(&paths::fixture(file));
        }
        let mut clock = h.clock();
        clock.unix_timestamp = GENESIS_UNIX_TS;
        clock.epoch_start_timestamp = GENESIS_UNIX_TS;
        h.svm.set_sysvar(&clock);
        let payer = h.payer.pubkey();
        h.airdrop(&payer, 1_000 * LAMPORTS_PER_SOL);
        h
    }
}

/// A transaction that executed successfully.
#[derive(Clone, Debug)]
pub struct Sent {
    /// Compute units consumed by the whole transaction.
    pub cu: u64,
    /// Wire size in bytes.
    pub size: usize,
    /// Lamports the fee payer paid in fees.
    pub fee: u64,
    pub logs: Vec<String>,
}

/// A transaction that failed.
#[derive(Clone, Debug)]
pub struct Failed {
    pub err: TransactionError,
    pub logs: Vec<String>,
}

impl Failed {
    /// The custom program error code (Anchor errors included), if any.
    pub fn custom_code(&self) -> Option<u32> {
        match &self.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
            _ => None,
        }
    }

    pub fn instruction_error(&self) -> Option<&InstructionError> {
        match &self.err {
            TransactionError::InstructionError(_, e) => Some(e),
            _ => None,
        }
    }

    pub fn logs_contain(&self, needle: &str) -> bool {
        self.logs.iter().any(|l| l.contains(needle))
    }
}

pub type TxResult = Result<Sent, Failed>;

/// Assertions on a [`TxResult`] that print the transaction logs on surprise.
pub trait TxExpect {
    fn expect_ok(self, what: &str) -> Sent;
    fn expect_fail(self, what: &str) -> Failed;
    /// Fails with exactly this custom program error code.
    fn expect_custom(self, code: impl Into<u32>, what: &str) -> Failed;
    /// Fails with this Anchor error (a `#[error_code]` variant or
    /// `anchor_lang::error::ErrorCode`): checks the code and Anchor's
    /// `Error Code: <Name>. Error Number: <n>.` log line. Our programs number
    /// their errors from 6000 alike, so the name is what identifies the
    /// failing program when the error comes back through CPIs.
    fn expect_error<E: Into<u32> + std::fmt::Debug + Copy>(self, error: E, what: &str) -> Failed;
    fn expect_instruction_error(self, expected: InstructionError, what: &str) -> Failed;
}

impl TxExpect for TxResult {
    fn expect_ok(self, what: &str) -> Sent {
        match self {
            Ok(sent) => sent,
            Err(f) => panic!(
                "{what}: expected success, got {:?}\n{}",
                f.err,
                f.logs.join("\n")
            ),
        }
    }

    fn expect_fail(self, what: &str) -> Failed {
        match self {
            Ok(sent) => panic!(
                "{what}: expected failure, but it succeeded\n{}",
                sent.logs.join("\n")
            ),
            Err(f) => f,
        }
    }

    fn expect_custom(self, code: impl Into<u32>, what: &str) -> Failed {
        let code = code.into();
        let f = self.expect_fail(what);
        assert_eq!(
            f.custom_code(),
            Some(code),
            "{what}: expected custom error {code}, got {:?}\n{}",
            f.err,
            f.logs.join("\n")
        );
        f
    }

    fn expect_error<E: Into<u32> + std::fmt::Debug + Copy>(self, error: E, what: &str) -> Failed {
        let code: u32 = error.into();
        let f = self.expect_custom(code, what);
        let line = format!("Error Code: {error:?}. Error Number: {code}.");
        assert!(
            f.logs_contain(&line),
            "{what}: no `{line}` log line\n{}",
            f.logs.join("\n")
        );
        f
    }

    fn expect_instruction_error(self, expected: InstructionError, what: &str) -> Failed {
        let f = self.expect_fail(what);
        assert_eq!(
            f.instruction_error(),
            Some(&expected),
            "{what}: expected {expected:?}, got {:?}\n{}",
            f.err,
            f.logs.join("\n")
        );
        f
    }
}

impl Harness {
    pub fn new() -> Self {
        HarnessBuilder::default().build()
    }

    pub fn builder() -> HarnessBuilder {
        HarnessBuilder::default()
    }

    // ---------------------------------------------------------------- clock

    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar::<Clock>()
    }

    pub fn now(&self) -> i64 {
        self.clock().unix_timestamp
    }

    /// Set the wall clock (slots only move forward, at ~400 ms per second warped).
    pub fn set_time(&mut self, unix_ts: i64) {
        let mut clock = self.clock();
        let dt = unix_ts - clock.unix_timestamp;
        if dt > 0 {
            clock.slot += (dt * 1000 / MS_PER_SLOT) as u64;
        }
        clock.unix_timestamp = unix_ts;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    /// Move the wall clock by `secs` (may be negative).
    pub fn warp(&mut self, secs: i64) {
        self.set_time(self.now() + secs);
    }

    // ------------------------------------------------------------- accounts

    /// The account at `key`, if it exists (holds lamports).
    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(key).filter(|a| a.lamports > 0)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.account(key).map_or(0, |a| a.lamports)
    }

    pub fn set_account(&mut self, key: Pubkey, account: Account) {
        self.svm.set_account(key, account).expect("set_account");
    }

    pub fn rent_exempt(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn airdrop(&mut self, to: &Pubkey, lamports: u64) {
        self.svm
            .airdrop(to, lamports)
            .unwrap_or_else(|f| panic!("airdrop: {:?}", f.err));
    }

    /// A new keypair holding `sol` SOL.
    pub fn funded_keypair(&mut self, sol: u64) -> Keypair {
        let kp = Keypair::new();
        self.airdrop(&kp.pubkey(), sol * LAMPORTS_PER_SOL);
        kp
    }

    /// Deserialize an Anchor account (checks owner-agnostic discriminator).
    pub fn anchor_account<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self
            .account(key)
            .unwrap_or_else(|| panic!("account {key} does not exist"));
        T::try_deserialize(&mut account.data.as_slice())
            .unwrap_or_else(|e| panic!("account {key}: {e:?}"))
    }

    /// Load a `solana account --output json-compact` dump; returns its address.
    pub fn load_account_json(&mut self, path: &Path) -> Pubkey {
        let text = std::fs::read_to_string(path).expect("read account json");
        let v: serde_json::Value = serde_json::from_str(&text).expect("account json");
        let a = &v["account"];
        let key = Pubkey::from_str(v["pubkey"].as_str().expect("pubkey")).expect("pubkey");
        assert_eq!(
            a["data"][1].as_str(),
            Some("base64"),
            "{}: data must be base64",
            path.display()
        );
        let data = base64::engine::general_purpose::STANDARD
            .decode(a["data"][0].as_str().expect("data"))
            .expect("base64 data");
        let account = Account {
            lamports: a["lamports"].as_u64().expect("lamports"),
            data,
            owner: Pubkey::from_str(a["owner"].as_str().expect("owner")).expect("owner"),
            executable: a["executable"].as_bool().expect("executable"),
            rent_epoch: a["rentEpoch"].as_u64().unwrap_or(u64::MAX),
        };
        self.set_account(key, account);
        key
    }

    // --------------------------------------------------------- transactions

    /// Legacy transaction `[SetComputeUnitLimit(1.4M), ixs..]` paid by `payer`.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let tx = self.legacy_tx(ixs, signers, Some(MAX_CU_LIMIT));
        self.submit(tx)
    }

    /// v0 transaction resolving accounts through `tables`.
    pub fn send_v0(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        tables: &[AddressLookupTableAccount],
    ) -> TxResult {
        let tx = self.v0_tx(ixs, signers, tables, Some(MAX_CU_LIMIT));
        self.submit(tx)
    }

    /// v1 transaction (SIMD-0385, up to 4096 bytes) with the 1.4M CU limit.
    pub fn send_v1(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let tx = self.v1_tx(ixs, signers, MAX_CU_LIMIT);
        self.submit(tx)
    }

    fn with_budget(ixs: &[Instruction], cu_limit: Option<u32>) -> Vec<Instruction> {
        let mut all = Vec::with_capacity(ixs.len() + 1);
        if let Some(limit) = cu_limit {
            all.push(ComputeBudgetInstruction::set_compute_unit_limit(limit));
        }
        all.extend_from_slice(ixs);
        all
    }

    /// Picks exactly the keypairs the message needs, in message order.
    fn signers_for<'a>(&'a self, required: &[Pubkey], extra: &[&'a Keypair]) -> Vec<&'a Keypair> {
        required
            .iter()
            .map(|key| {
                std::iter::once(&self.payer)
                    .chain(extra.iter().copied())
                    .find(|kp| kp.pubkey() == *key)
                    .unwrap_or_else(|| panic!("no keypair for required signer {key}"))
            })
            .collect()
    }

    pub fn legacy_tx(
        &self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        cu_limit: Option<u32>,
    ) -> VersionedTransaction {
        let ixs = Self::with_budget(ixs, cu_limit);
        let msg = Message::new_with_blockhash(
            &ixs,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let keys = self.signers_for(required, signers);
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &keys).expect("sign legacy tx")
    }

    pub fn v0_tx(
        &self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        tables: &[AddressLookupTableAccount],
        cu_limit: Option<u32>,
    ) -> VersionedTransaction {
        let ixs = Self::with_budget(ixs, cu_limit);
        let msg = v0::Message::try_compile(
            &self.payer.pubkey(),
            &ixs,
            tables,
            self.svm.latest_blockhash(),
        )
        .expect("compile v0 message");
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let keys = self.signers_for(required, signers);
        VersionedTransaction::try_new(VersionedMessage::V0(msg), &keys).expect("sign v0 tx")
    }

    /// v1 messages carry the compute budget in config words instead of
    /// ComputeBudget instructions; unset words mean 0, so both are set.
    pub fn v1_tx(
        &self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        cu_limit: u32,
    ) -> VersionedTransaction {
        let config = v1::TransactionConfig::empty()
            .with_compute_unit_limit(cu_limit)
            .with_loaded_accounts_data_size_limit(MAX_LOADED_ACCOUNTS_DATA);
        let msg = v1::Message::try_compile_with_config(
            &self.payer.pubkey(),
            ixs,
            self.svm.latest_blockhash(),
            config,
        )
        .expect("compile v1 message");
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let keys = self.signers_for(required, signers);
        VersionedTransaction::try_new(VersionedMessage::V1(msg), &keys).expect("sign v1 tx")
    }

    /// v1 transaction paid by `fee_payer` with an explicit `config` (the
    /// limits a client sets), signed by `fee_payer` and `signers`.
    pub fn v1_tx_with(
        &self,
        fee_payer: &Keypair,
        ixs: &[Instruction],
        signers: &[&Keypair],
        config: v1::TransactionConfig,
    ) -> VersionedTransaction {
        let msg = v1::Message::try_compile_with_config(
            &fee_payer.pubkey(),
            ixs,
            self.svm.latest_blockhash(),
            config,
        )
        .expect("compile v1 message");
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let mut all = vec![fee_payer];
        all.extend_from_slice(signers);
        let keys = self.signers_for(required, &all);
        VersionedTransaction::try_new(VersionedMessage::V1(msg), &keys).expect("sign v1 tx")
    }

    /// Legacy transaction in which every required signer the harness holds
    /// no keypair for carries an all-zero signature, executed with signature
    /// verification switched off for this one transaction.
    ///
    /// A callee only ever sees `is_signer` on an account, so this is how a
    /// test stands in for the `invoke_signed` PDA signature of a program
    /// that is not under test (the launchpad's `hook-authority`, DBC's pool
    /// authority). Every other transaction is fully signature-verified.
    pub fn send_with_unverified_signers(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> TxResult {
        let ixs = Self::with_budget(ixs, Some(MAX_CU_LIMIT));
        let msg = Message::new_with_blockhash(
            &ixs,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let message = VersionedMessage::Legacy(msg);
        let bytes = message.serialize();
        let required = usize::from(message.header().num_required_signatures);
        let signatures = message.static_account_keys()[..required]
            .iter()
            .map(|key| {
                std::iter::once(&self.payer)
                    .chain(signers.iter().copied())
                    .find(|kp| kp.pubkey() == *key)
                    .map_or_else(Signature::default, |kp| kp.sign_message(&bytes))
            })
            .collect();
        let tx = VersionedTransaction {
            signatures,
            message,
        };
        self.set_sigverify(false);
        let result = self.submit(tx);
        self.set_sigverify(true);
        result
    }

    fn set_sigverify(&mut self, on: bool) {
        let svm = std::mem::take(&mut self.svm);
        self.svm = svm.with_sigverify(on);
    }

    /// Execute `tx` whatever its recent blockhash: the age check is off for
    /// this one transaction, every signature is still verified. This is how
    /// a test runs the exact wire bytes of an SDK vector, whose blockhash is
    /// fixed. The same bytes a second time fail `AlreadyProcessed` (the
    /// runtime's signature dedup), as on a cluster.
    pub fn submit_any_blockhash(&mut self, tx: VersionedTransaction) -> TxResult {
        self.set_blockhash_check(false);
        let result = self.submit(tx);
        self.set_blockhash_check(true);
        result
    }

    fn set_blockhash_check(&mut self, on: bool) {
        let svm = std::mem::take(&mut self.svm);
        self.svm = svm.with_blockhash_check(on);
    }

    /// Loaded-accounts data size of `tx` as mainnet meters it against the
    /// transaction's limit (SIMD-0186): 64 bytes plus the data length of
    /// every distinct account, plus the programdata account of every
    /// loader-v3 program. LiteSVM's own meter leaves programdata out, so a
    /// v1 limit that passes here is also checked against this number.
    pub fn loaded_accounts_data_size(&self, tx: &VersionedTransaction) -> u64 {
        let mut counted = HashSet::new();
        let mut total = 0u64;
        for key in tx.message.static_account_keys() {
            let Some(account) = self.svm.get_account(key) else {
                continue;
            };
            if counted.insert(*key) {
                total += TRANSACTION_ACCOUNT_BASE_SIZE + account.data.len() as u64;
            }
            // UpgradeableLoaderState::Program: u32 tag 2, then the programdata address.
            let is_v3_program = account.executable
                && account.owner == bpf_loader_upgradeable::ID
                && account.data.len() >= 36
                && account.data[..4] == 2u32.to_le_bytes();
            if is_v3_program {
                let programdata =
                    Pubkey::new_from_array(account.data[4..36].try_into().expect("32 bytes"));
                if counted.insert(programdata) {
                    let programdata = self.svm.get_account(&programdata).expect("programdata");
                    total += TRANSACTION_ACCOUNT_BASE_SIZE + programdata.data.len() as u64;
                }
            }
        }
        total
    }

    /// Execute a signed transaction.
    ///
    /// LiteSVM does not enforce the wire-size limits, so this does: a test
    /// must not pass with a transaction no cluster would accept. Every
    /// transaction also gets a fresh blockhash afterwards, so re-sending
    /// identical instructions is a new transaction and replay protection
    /// under test is the program's, not the runtime's signature dedup.
    pub fn submit(&mut self, tx: VersionedTransaction) -> TxResult {
        let size = wire_size(&tx);
        let limit = size_limit(&tx);
        assert!(
            size <= limit,
            "transaction is {size} bytes, over the {limit}-byte limit for its format"
        );
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => Ok(Sent {
                cu: meta.compute_units_consumed,
                size,
                fee: meta.fee,
                logs: meta.logs,
            }),
            Err(f) => Err(Failed {
                err: f.err,
                logs: f.meta.logs,
            }),
        }
    }

    // ---------------------------------------------------- lookup tables

    /// Create and activate an address lookup table holding `addresses`.
    pub fn create_lookup_table(&mut self, addresses: &[Pubkey]) -> AddressLookupTableAccount {
        // The table address derives from (authority, recent slot): a fresh
        // authority per table avoids collisions within one slot.
        let authority = Keypair::new();
        let (create, table) =
            create_lookup_table(authority.pubkey(), self.payer.pubkey(), self.recent_slot());
        self.send(&[create], &[&authority])
            .expect_ok("create lookup table");
        for chunk in addresses.chunks(20) {
            let extend = extend_lookup_table(
                table,
                authority.pubkey(),
                Some(self.payer.pubkey()),
                chunk.to_vec(),
            );
            self.send(&[extend], &[&authority])
                .expect_ok("extend lookup table");
        }
        // Entries become usable in the slot after they were added.
        let slot = self.clock().slot;
        self.svm.warp_to_slot(slot + 1);
        AddressLookupTableAccount {
            key: table,
            addresses: addresses.to_vec(),
        }
    }

    /// Newest slot in the SlotHashes sysvar (what lookup-table creation checks).
    fn recent_slot(&self) -> u64 {
        let data = self
            .svm
            .get_account(&sysvar::slot_hashes::ID)
            .expect("SlotHashes sysvar")
            .data;
        // u64 entry count, then (slot u64, hash [u8; 32]) newest first.
        assert!(
            data.len() >= 16 && data[..8] != [0u8; 8],
            "SlotHashes is empty"
        );
        u64::from_le_bytes(data[8..16].try_into().expect("8 bytes"))
    }
}

/// Exact wire size of a transaction (legacy, v0 or v1).
pub fn wire_size(tx: &VersionedTransaction) -> usize {
    wincode::serialize(tx).expect("serialize transaction").len()
}

/// A transaction from its wire bytes (legacy, v0 or v1), as a validator
/// reads them; they must be exactly one transaction.
pub fn tx_from_wire(wire: &[u8]) -> VersionedTransaction {
    parse_tx(wire).expect("the bytes are exactly one transaction")
}

/// `wire` parsed as one transaction, or `None` if it does not parse or has
/// bytes left over.
pub fn parse_tx(wire: &[u8]) -> Option<VersionedTransaction> {
    let tx: VersionedTransaction = wincode::deserialize(wire).ok()?;
    (wincode::serialize(&tx).ok()? == wire).then_some(tx)
}

/// The cluster's size limit for the transaction's format.
pub fn size_limit(tx: &VersionedTransaction) -> usize {
    match tx.message {
        VersionedMessage::V1(_) => V1_MAX_TRANSACTION_SIZE,
        _ => PACKET_DATA_SIZE,
    }
}

/// The v1 wire bytes of `tx`, written field by field from docs/SPEC.md §3
/// instead of by `solana-message`. Comparing the two pins the SPEC text,
/// which the SDK's own serializer follows, to what validators parse.
pub fn v1_wire_per_spec(tx: &VersionedTransaction) -> Vec<u8> {
    let VersionedMessage::V1(m) = &tx.message else {
        panic!("not a v1 transaction");
    };
    // message = 0x81 || header || config_mask || blockhash || n_ix || n_addr || addresses
    let mut out = vec![
        0x80 | 1,
        m.header.num_required_signatures,
        m.header.num_readonly_signed_accounts,
        m.header.num_readonly_unsigned_accounts,
    ];
    let c = &m.config;
    let mut mask = 0u32;
    if c.priority_fee.is_some() {
        mask |= 0b11; // bits 0 and 1 together
    }
    if c.compute_unit_limit.is_some() {
        mask |= 1 << 2;
    }
    if c.loaded_accounts_data_size_limit.is_some() {
        mask |= 1 << 3;
    }
    if c.heap_size.is_some() {
        mask |= 1 << 4;
    }
    out.extend_from_slice(&mask.to_le_bytes());
    out.extend_from_slice(m.lifetime_specifier.as_ref());
    out.push(u8::try_from(m.instructions.len()).expect("at most 64 instructions"));
    out.push(u8::try_from(m.account_keys.len()).expect("at most 64 addresses"));
    for key in &m.account_keys {
        out.extend_from_slice(key.as_ref());
    }
    // || config values, in mask-bit order, only for the bits that are set
    if let Some(fee) = c.priority_fee {
        out.extend_from_slice(&fee.to_le_bytes());
    }
    if let Some(limit) = c.compute_unit_limit {
        out.extend_from_slice(&limit.to_le_bytes());
    }
    if let Some(limit) = c.loaded_accounts_data_size_limit {
        out.extend_from_slice(&limit.to_le_bytes());
    }
    if let Some(heap) = c.heap_size {
        out.extend_from_slice(&heap.to_le_bytes());
    }
    // || all instruction headers || all instruction payloads
    for ix in &m.instructions {
        out.push(ix.program_id_index);
        out.push(u8::try_from(ix.accounts.len()).expect("at most 255 accounts"));
        let data_len = u16::try_from(ix.data.len()).expect("at most 65535 bytes");
        out.extend_from_slice(&data_len.to_le_bytes());
    }
    for ix in &m.instructions {
        out.extend_from_slice(&ix.accounts);
        out.extend_from_slice(&ix.data);
    }
    // transaction = message || signatures: a fixed count, no length prefix
    for sig in &tx.signatures {
        out.extend_from_slice(sig.as_ref());
    }
    out
}

/// Compute units consumed by the top-level invocations of `program`, from the
/// runtime's `Program <id> consumed <n> of <m> compute units` log lines.
pub fn program_cu(logs: &[String], program: &Pubkey) -> u64 {
    let id = program.to_string();
    let mut depth = 0usize;
    let mut total = 0u64;
    for line in logs {
        let Some((who, what)) = line
            .strip_prefix("Program ")
            .and_then(|r| r.split_once(' '))
        else {
            continue;
        };
        // "Program log:", "Program data:", "Program return:" carry program output.
        if who.ends_with(':') {
            continue;
        }
        if let Some(d) = what.strip_prefix("invoke [") {
            depth = d.trim_end_matches(']').parse().unwrap_or(depth + 1);
        } else if let Some(rest) = what.strip_prefix("consumed ") {
            if who == id && depth == 1 {
                total += rest
                    .split(' ')
                    .next()
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0);
            }
        } else if what == "success" || what.starts_with("failed:") {
            depth = depth.saturating_sub(1);
        }
    }
    total
}

/// Compute units of every invocation of `program`, at any CPI depth (for a
/// leaf program such as a transfer hook this is its own cost per call).
pub fn invocations_cu(logs: &[String], program: &Pubkey) -> Vec<u64> {
    let consumed = format!("Program {program} consumed ");
    logs.iter()
        .filter_map(|l| l.strip_prefix(&consumed))
        .filter_map(|rest| rest.split(' ').next().and_then(|n| n.parse().ok()))
        .collect()
}

/// Payloads of the Anchor event `name` (`emit!`) in `logs`, in order: every
/// `Program data: <base64>` line whose bytes start with the discriminator
/// `sha256("event:<name>")[..8]`, without it.
pub fn anchor_events(logs: &[String], name: &str) -> Vec<Vec<u8>> {
    let discriminator = super::anchor_discriminator("event", name);
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(|data| {
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap_or_else(|e| panic!("`Program data: {data}`: {e}"))
        })
        .filter(|bytes| bytes.starts_with(&discriminator))
        .map(|bytes| bytes[8..].to_vec())
        .collect()
}

/// One line of the measurement report (shown with `cargo test -- --nocapture`).
pub fn report(label: &str, value: impl Display) {
    println!("[report] {label}: {value}");
}
