//! A small LiteSVM environment: mainnet Token-2022 / SPL Token / ATA / DBC
//! dumps, our SBF builds, a realistic clock, and transaction helpers.
#![allow(dead_code)]

pub mod launch;
pub mod lifecycle;
pub mod pq;
pub mod presets;
pub mod vault;
pub mod world;

use std::{
    env,
    path::{Path, PathBuf},
    str::FromStr,
};

use anchor_lang::AccountDeserialize;
use anchor_spl::token_interface::spl_token_2022::{self, extension::StateWithExtensions};
use base64::Engine as _;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_message::{v1, Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

pub use anchor_lang::prelude::Pubkey;

pub use noised_launchpad::constants::LAMPORTS_PER_SOL;
pub const TOKEN_PROGRAM_ID: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022_PROGRAM_ID: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_PROGRAM_ID: Pubkey = anchor_spl::associated_token::ID;
/// Max wire size of a legacy transaction.
pub const PACKET_DATA_SIZE: usize = 1232;
/// Max wire size of a v1 transaction (SIMD-0385).
pub const V1_MAX_TRANSACTION_SIZE: usize = v1::MAX_TRANSACTION_SIZE;
/// 2026-01-01T00:00:00Z.
pub const GENESIS_UNIX_TS: i64 = 1_767_225_600;
const BPF_LOADER_UPGRADEABLE: Pubkey =
    anchor_lang::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
const BPF_LOADER: Pubkey = anchor_lang::pubkey!("BPFLoader2111111111111111111111111111111111");

/// `NOISED_FIXTURES_DIR`, else `<repo>/fixtures` (gitignored; written by
/// `scripts/fetch-fixtures.*`). Every crate that includes this module sits
/// four levels below the repository root (`programs/<program>/tests/litesvm`).
fn fixtures_dir() -> PathBuf {
    env::var_os("NOISED_FIXTURES_DIR")
        .or_else(|| env::var_os("PHALANX_FIXTURES_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../fixtures"))
}

pub fn fixture(relative: &str) -> PathBuf {
    let path = fixtures_dir().join(relative);
    assert!(
        path.is_file(),
        "missing fixture {} (set NOISED_FIXTURES_DIR)",
        path.display()
    );
    path
}

/// Our `cargo-build-sbf --arch v3` output: `NOISED_SBF_DIR`, else the
/// `deploy` dir of the target dir this test was built in.
pub fn program_so(name: &str) -> PathBuf {
    let mut dirs = Vec::new();
    if let Some(d) = env::var_os("NOISED_SBF_DIR").or_else(|| env::var_os("PHALANX_SBF_DIR")) {
        dirs.push(PathBuf::from(d));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(target) = exe.ancestors().nth(3) {
            dirs.push(target.join("deploy"));
        }
    }
    if let Some(d) = env::var_os("CARGO_TARGET_DIR") {
        dirs.push(PathBuf::from(d).join("deploy"));
    }
    let file = format!("{name}.so");
    let path = dirs
        .iter()
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
        .unwrap_or_else(|| {
            panic!("{file} not found in {dirs:?}; build it with cargo-build-sbf --arch v3")
        });
    let bytes = std::fs::read(&path).expect("read .so");
    assert_eq!(
        u32::from_le_bytes(bytes[48..52].try_into().unwrap()),
        3,
        "{} is not an SBPF v3 build",
        path.display()
    );
    path
}

pub struct Sent {
    pub cu: u64,
    pub size: usize,
    pub logs: Vec<String>,
}

/// The Anchor events `T` (`emit!`, at any CPI depth) in a transaction's
/// logs, decoded: every `Program data: <base64>` line whose bytes start with
/// `T`'s discriminator.
pub fn events<T: anchor_lang::Event>(logs: &[String]) -> Vec<T> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(|data| {
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap_or_else(|e| panic!("`Program data: {data}`: {e}"))
        })
        .filter(|bytes| bytes.starts_with(T::DISCRIMINATOR))
        .map(|bytes| T::deserialize(&mut &bytes[T::DISCRIMINATOR.len()..]).expect("event payload"))
        .collect()
}

/// One program invocation in a transaction's logs.
#[derive(Clone, Debug)]
pub struct Invocation {
    pub program: Pubkey,
    /// 1 for a top-level instruction, 2 for the CPIs it makes, and so on.
    pub depth: usize,
    /// Compute units the invocation used, its own CPIs included (`None` for
    /// builtins such as the System program, which do not log it).
    pub consumed: Option<u64>,
}

/// Every program invocation in a transaction's logs, in the order they
/// started (`Program <id> invoke [<depth>]` ... `consumed <n> of <m> compute
/// units` ... `success` / `failed`).
pub fn invocations(logs: &[String]) -> Vec<Invocation> {
    let mut out: Vec<Invocation> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for line in logs {
        let mut words = match line.strip_prefix("Program ") {
            Some(rest) => rest.split(' '),
            None => continue,
        };
        // `Program log:`, `Program data:` and `Program return:` lines name no program.
        let (Some(Ok(program)), Some(verb)) = (words.next().map(Pubkey::from_str), words.next())
        else {
            continue;
        };
        match verb {
            "invoke" => {
                let depth = words
                    .next()
                    .and_then(|d| d.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
                    .unwrap_or_else(|| panic!("unparsed log line `{line}`"));
                open.push(out.len());
                out.push(Invocation {
                    program,
                    depth,
                    consumed: None,
                });
            }
            "consumed" => {
                let i = *open
                    .last()
                    .unwrap_or_else(|| panic!("no open invocation: `{line}`"));
                assert_eq!(out[i].program, program, "`{line}`");
                out[i].consumed = words.next().and_then(|n| n.parse().ok());
            }
            "success" | "failed:" => {
                let i = open
                    .pop()
                    .unwrap_or_else(|| panic!("no open invocation: `{line}`"));
                assert_eq!(out[i].program, program, "`{line}`");
            }
            _ => {}
        }
    }
    out
}

/// The first top-level instruction of `program` in a transaction's logs:
/// its invocation, then every invocation under it, in order.
pub fn top_level(logs: &[String], program: &Pubkey) -> Vec<Invocation> {
    let all = invocations(logs);
    let start = all
        .iter()
        .position(|i| i.depth == 1 && i.program == *program)
        .unwrap_or_else(|| panic!("{program} has no top-level instruction"));
    let end = all[start + 1..]
        .iter()
        .position(|i| i.depth == 1)
        .map_or(all.len(), |n| start + 1 + n);
    all[start..end].to_vec()
}

/// Whether `program` was invoked, at any depth, in a transaction's logs.
pub fn invoked(logs: &[String], program: &Pubkey) -> bool {
    invocations(logs).iter().any(|i| i.program == *program)
}

/// Compute units `program` used in a transaction: the sum over its
/// invocations at `depth` (any depth if `None`).
pub fn program_cu(logs: &[String], program: &Pubkey, depth: Option<usize>) -> u64 {
    invocations(logs)
        .iter()
        .filter(|i| i.program == *program && depth.is_none_or(|d| d == i.depth))
        .filter_map(|i| i.consumed)
        .sum()
}

pub struct Failed {
    pub err: TransactionError,
    pub logs: Vec<String>,
}

impl Failed {
    pub fn custom_code(&self) -> Option<u32> {
        match &self.err {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        }
    }
}

pub trait Expect {
    fn expect_ok(self, what: &str) -> Sent;
    /// Fails with this Anchor error number and name (as logged by Anchor).
    fn fails_with(self, code: u32, name: &str, what: &str) -> Failed;
}

impl Expect for Result<Sent, Failed> {
    fn expect_ok(self, what: &str) -> Sent {
        match self {
            Ok(s) => s,
            Err(f) => panic!(
                "{what}: expected success, got {:?}\n{}",
                f.err,
                f.logs.join("\n")
            ),
        }
    }

    fn fails_with(self, code: u32, name: &str, what: &str) -> Failed {
        let f = match self {
            Ok(s) => panic!(
                "{what}: expected failure, got success\n{}",
                s.logs.join("\n")
            ),
            Err(f) => f,
        };
        assert_eq!(
            f.custom_code(),
            Some(code),
            "{what}: {:?}\n{}",
            f.err,
            f.logs.join("\n")
        );
        let line = format!("Error Code: {name}. Error Number: {code}.");
        assert!(
            f.logs.iter().any(|l| l.contains(&line)),
            "{what}: no `{line}` in logs\n{}",
            f.logs.join("\n")
        );
        f
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
}

impl Env {
    /// Mainnet Token-2022 / SPL Token / ATA / DBC, our hook, launchpad and
    /// vault, the mainnet wSOL mint, and a funded payer at a realistic time.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_log_bytes_limit(None);
        let programs = [
            (
                TOKEN_2022_PROGRAM_ID,
                fixture("token_2022.so"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (
                TOKEN_PROGRAM_ID,
                fixture("spl_token.so"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (ATA_PROGRAM_ID, fixture("associated_token.so"), BPF_LOADER),
            (
                noised_launchpad::constants::DBC_PROGRAM_ID,
                fixture("dbc.so"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (
                noised_launchpad::constants::DAMM_V2_PROGRAM_ID,
                fixture("damm_v2.so"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (
                noised_hook::ID,
                program_so("noised_hook"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (
                noised_launchpad::ID,
                program_so("noised_launchpad"),
                BPF_LOADER_UPGRADEABLE,
            ),
            (
                noised_vault::ID,
                program_so("noised_vault"),
                BPF_LOADER_UPGRADEABLE,
            ),
        ];
        for (id, path, loader) in programs {
            let bytes = std::fs::read(&path).expect("read program");
            svm.add_program_with_loader(id, &bytes, loader)
                .unwrap_or_else(|e| panic!("load {}: {e:?}", path.display()));
        }
        let mut env = Env {
            svm,
            payer: Keypair::new(),
        };
        env.load_account_json(&fixture(
            "accounts/So11111111111111111111111111111111111111112.json",
        ));
        env.set_time(GENESIS_UNIX_TS);
        let payer = env.payer.pubkey();
        env.airdrop(&payer, 1_000 * LAMPORTS_PER_SOL);
        env
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn set_time(&mut self, unix_ts: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        if unix_ts > clock.unix_timestamp {
            clock.slot += ((unix_ts - clock.unix_timestamp) as u64) * 5 / 2;
        }
        clock.unix_timestamp = unix_ts;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn airdrop(&mut self, to: &Pubkey, lamports: u64) {
        self.svm
            .airdrop(to, lamports)
            .unwrap_or_else(|f| panic!("airdrop: {:?}", f.err));
    }

    pub fn funded(&mut self, sol: u64) -> Keypair {
        let kp = Keypair::new();
        self.airdrop(&kp.pubkey(), sol * LAMPORTS_PER_SOL);
        kp
    }

    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(key).filter(|a| a.lamports > 0)
    }

    pub fn anchor<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let a = self
            .account(key)
            .unwrap_or_else(|| panic!("no account {key}"));
        T::try_deserialize(&mut a.data.as_slice()).unwrap_or_else(|e| panic!("{key}: {e:?}"))
    }

    /// Token amount of an SPL Token or Token-2022 account (0 if missing).
    pub fn token_amount(&self, key: &Pubkey) -> u64 {
        self.account(key).map_or(0, |a| {
            StateWithExtensions::<spl_token_2022::state::Account>::unpack(&a.data)
                .expect("token account")
                .base
                .amount
        })
    }

    /// The owner field of an existing SPL Token or Token-2022 account.
    pub fn token_owner(&self, key: &Pubkey) -> Pubkey {
        let a = self
            .account(key)
            .unwrap_or_else(|| panic!("no token account {key}"));
        StateWithExtensions::<spl_token_2022::state::Account>::unpack(&a.data)
            .expect("token account")
            .base
            .owner
    }

    pub fn load_account_json(&mut self, path: &Path) -> Pubkey {
        let text = std::fs::read_to_string(path).expect("read account json");
        let v: serde_json::Value = serde_json::from_str(&text).expect("json");
        let a = &v["account"];
        let key = Pubkey::from_str(v["pubkey"].as_str().unwrap()).unwrap();
        let data = base64::engine::general_purpose::STANDARD
            .decode(a["data"][0].as_str().unwrap())
            .unwrap();
        let account = Account {
            lamports: a["lamports"].as_u64().unwrap(),
            data,
            owner: Pubkey::from_str(a["owner"].as_str().unwrap()).unwrap(),
            executable: a["executable"].as_bool().unwrap(),
            rent_epoch: a["rentEpoch"].as_u64().unwrap_or(u64::MAX),
        };
        self.svm.set_account(key, account).expect("set account");
        key
    }

    /// Make `authority` the upgrade authority of `program` (LiteSVM deploys
    /// programs without one).
    pub fn set_upgrade_authority(&mut self, program: &Pubkey, authority: &Pubkey) {
        let (programdata, _) =
            Pubkey::find_program_address(&[program.as_ref()], &BPF_LOADER_UPGRADEABLE);
        let mut account = self.account(&programdata).expect("programdata");
        // ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> } after a u32 tag.
        assert_eq!(u32::from_le_bytes(account.data[..4].try_into().unwrap()), 3);
        account.data[12] = 1;
        account.data[13..45].copy_from_slice(authority.as_ref());
        self.svm
            .set_account(programdata, account)
            .expect("set programdata");
    }

    pub fn programdata(program: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[program.as_ref()], &BPF_LOADER_UPGRADEABLE).0
    }

    /// Legacy transaction with a 1.4M CU limit, paid by `self.payer`; checks
    /// the 1232-byte wire limit before sending.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<Sent, Failed> {
        let payer = self.payer.pubkey();
        self.send_with(&payer, ixs, signers, true)
    }

    /// Like `send`, without the wire-size check: for third-party transactions
    /// (DBC migration) that real clients send through an address lookup table.
    pub fn send_large(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<Sent, Failed> {
        let payer = self.payer.pubkey();
        self.send_with(&payer, ixs, signers, false)
    }

    /// A v1 transaction (SIMD-0385, up to 4,096 bytes) paid by `fee_payer`,
    /// with its compute budget in `config` (v1 has no ComputeBudget
    /// instructions; an unset word means a limit of 0). Signed by
    /// `fee_payer` and `signers`; checks the v1 size limit before sending.
    pub fn send_v1(
        &mut self,
        fee_payer: &Keypair,
        ixs: &[Instruction],
        signers: &[&Keypair],
        config: v1::TransactionConfig,
    ) -> Result<Sent, Failed> {
        let tx = self.v1_tx_with(fee_payer, ixs, signers, config);
        self.submit(tx)
    }

    /// The signed v1 transaction `send_v1` sends (ported from
    /// `tests/integration`'s harness).
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
        let keys: Vec<&Keypair> = required
            .iter()
            .map(|k| {
                std::iter::once(fee_payer)
                    .chain(signers.iter().copied())
                    .find(|kp| kp.pubkey() == *k)
                    .unwrap_or_else(|| panic!("no keypair for signer {k}"))
            })
            .collect();
        VersionedTransaction::try_new(VersionedMessage::V1(msg), &keys).expect("sign v1 tx")
    }

    /// Loaded-accounts data size of `tx` as mainnet meters it against the
    /// transaction's limit (SIMD-0186): 64 bytes plus the data of every
    /// distinct existing account, plus the programdata of every loader-v3
    /// program (LiteSVM's own meter leaves programdata out). Ported from
    /// `tests/integration`'s harness.
    pub fn loaded_accounts_data_size(&self, tx: &VersionedTransaction) -> u64 {
        const TRANSACTION_ACCOUNT_BASE_SIZE: u64 = 64;
        let mut counted = std::collections::HashSet::new();
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
                && account.owner == BPF_LOADER_UPGRADEABLE
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

    /// Send an already signed transaction (any version) as it is: its wire
    /// size must fit its version's limit.
    pub fn submit(&mut self, tx: VersionedTransaction) -> Result<Sent, Failed> {
        let size = wincode::serialize(&tx).expect("serialize").len();
        let limit = match tx.message {
            VersionedMessage::V1(_) => V1_MAX_TRANSACTION_SIZE,
            _ => PACKET_DATA_SIZE,
        };
        assert!(size <= limit, "transaction is {size} bytes (> {limit})");
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => Ok(Sent {
                cu: meta.compute_units_consumed,
                size,
                logs: meta.logs,
            }),
            Err(f) => Err(Failed {
                err: f.err,
                logs: f.meta.logs,
            }),
        }
    }

    /// `fee_payer` must be `self.payer` or one of `signers`.
    pub fn send_with(
        &mut self,
        fee_payer: &Pubkey,
        ixs: &[Instruction],
        signers: &[&Keypair],
        check_size: bool,
    ) -> Result<Sent, Failed> {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        let msg = Message::new_with_blockhash(&all, Some(fee_payer), &self.svm.latest_blockhash());
        let required = &msg.account_keys[..msg.header.num_required_signatures as usize];
        let keys: Vec<&Keypair> = required
            .iter()
            .map(|k| {
                std::iter::once(&self.payer)
                    .chain(signers.iter().copied())
                    .find(|kp| kp.pubkey() == *k)
                    .unwrap_or_else(|| panic!("no keypair for signer {k}"))
            })
            .collect();
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &keys).expect("sign");
        let size = wincode::serialize(&tx).expect("serialize").len();
        assert!(
            !check_size || size <= PACKET_DATA_SIZE,
            "transaction is {size} bytes (> {PACKET_DATA_SIZE})"
        );
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match result {
            Ok(meta) => Ok(Sent {
                cu: meta.compute_units_consumed,
                size,
                logs: meta.logs,
            }),
            Err(f) => Err(Failed {
                err: f.err,
                logs: f.meta.logs,
            }),
        }
    }
}
