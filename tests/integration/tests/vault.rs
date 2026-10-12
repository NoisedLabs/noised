//! PQ vault v4 (`noised_vault`) against the mainnet token programs.
//!
//! Signatures are real LM-OTS signatures (`noised-lmots`, deterministic
//! randomizer) over messages built from SPEC §3, with keys derived per vault
//! `account` and `sequence` (SPEC §3.10), and withdrawals go out as v1
//! transactions, the only format a 2176-byte signature fits in. A
//! withdrawal only reserves the amount and rotates the key; `release`
//! (anyone, to the recipient's canonical ATA) or `release_to` (signed by the
//! recipient, to any token account of the mint) delivers it. Events are
//! decoded from the logs by their documented layouts.
//!
//! The tests named `v1a_` … `v5_` replay the attacks of the audit findings
//! V1 to V5 against v4 (each doc comment names the finding and the attack).

mod common;

use anchor_lang::{error::ErrorCode as AnchorError, Space};
use anchor_spl::{
    associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent,
    token_2022::spl_token_2022::{
        error::TokenError,
        instruction::{self as token_ix, AuthorityType},
    },
};
use common::{
    anchor_discriminator,
    hook::{PolicySpec, HOOK_ID},
    relay::relay_ix,
    svm::{
        anchor_events, program_cu, report, v1_wire_per_spec, wire_size, Sent, TxExpect, TxResult,
        MAX_CU_LIMIT, PACKET_DATA_SIZE, V1_MAX_TRANSACTION_SIZE,
    },
    token::{ata, MintExt},
    vault::{
        self, master_seed, open_vault_ix, payout_pda, release_ix, release_to_ix, sign_withdraw,
        vault_pda, withdraw_message, PayoutRef, PqKey, MEMO_PROGRAM_ID, VAULT_ID,
        WITHDRAW_CU_LIMIT, WITHDRAW_IX_DATA_LEN, WITHDRAW_LOADED_ACCOUNTS_DATA_LIMIT,
        WITHDRAW_MESSAGE_LEN,
    },
    AccountMeta, Harness, Instruction, Keypair, Pubkey, Signer, LAMPORTS_PER_SOL,
    SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use noised_hook::HookError;
use noised_vault::{
    error::VaultError,
    state::{Payout, Vault, PAYOUT_SEED, VAULT_SEED},
    WithdrawArgs,
};
use spl_transfer_hook_interface::error::TransferHookError;

const DECIMALS: u8 = 6;
const DEPOSIT: u64 = 1_000_000;
/// What a client funds its throwaway fee payer with (0.01 SOL).
const RELAYER_LAMPORTS: u64 = 10_000_000;
/// Launch Guard timing of the hooked-mint tests.
const SHIELD_SECS: i64 = 40;
const GUARD_SECS: i64 = 3_600;

/// A mint, a PQ recovery seed, a depositor and a recipient.
struct Env {
    h: Harness,
    mint: Pubkey,
    token_program: Pubkey,
    master: [u8; 64],
    /// Holds 100 deposits' worth and deposits them.
    alice: Keypair,
    alice_ata: Pubkey,
    /// The usual recipient: has SOL for its own account changes, no ATA.
    bob: Keypair,
}

impl Env {
    fn new(token_program: Pubkey) -> Self {
        let mut h = Harness::new();
        let mint = h.create_mint(token_program, DECIMALS, None);
        Self::with_mint(h, mint)
    }

    /// `mint` (either token program, any extensions) in `h`.
    fn with_mint(mut h: Harness, mint: Pubkey) -> Self {
        let token_program = h.token_program_of(&mint);
        let alice = h.funded_keypair(10);
        let alice_ata = h.create_ata(&alice.pubkey(), &mint);
        h.mint_to(&mint, &alice_ata, 100 * DEPOSIT);
        let bob = h.funded_keypair(1);
        Self {
            h,
            mint,
            token_program,
            master: master_seed("vault-tests"),
            alice,
            alice_ata,
            bob,
        }
    }

    /// The key of vault account 0 at `sequence` (the vault [`Env::open`] opens).
    fn key(&self, sequence: u32) -> PqKey {
        self.account_key(0, sequence)
    }

    /// The key of vault `account` at `sequence` (SPEC §3.10).
    fn account_key(&self, account: u32, sequence: u32) -> PqKey {
        PqKey::derive(&self.master, &self.mint, account, sequence)
    }

    /// Open vault account 0 (its sequence-0 key).
    fn open(&mut self) -> Pubkey {
        let genesis = self.key(0);
        self.open_with(&genesis)
    }

    fn open_with(&mut self, genesis: &PqKey) -> Pubkey {
        let payer = self.h.payer.pubkey();
        let ix = open_vault_ix(
            &payer,
            &self.mint,
            &self.token_program,
            genesis.key_id,
            genesis.vault_key(),
        );
        self.h.send(&[ix], &[]).expect_ok("open_vault");
        genesis.vault(&self.mint)
    }

    fn vault_ata(&self, vault: &Pubkey) -> Pubkey {
        ata(vault, &self.mint, &self.token_program)
    }

    /// Anyone can deposit with a plain token transfer; alice does here.
    fn deposit(&mut self, vault: &Pubkey, amount: u64) {
        let to = self.vault_ata(vault);
        self.h
            .transfer(&self.mint, &self.alice_ata, &to, &self.alice, amount)
            .expect_ok("deposit");
    }

    /// Mint straight into the vault (no transfer, so no transfer hook).
    fn fund(&mut self, vault: &Pubkey, amount: u64) {
        let to = self.vault_ata(vault);
        let mint = self.mint;
        self.h.mint_to(&mint, &to, amount);
    }

    fn held(&self, vault: &Pubkey) -> u64 {
        self.h.balance(&self.vault_ata(vault))
    }

    fn state(&self, vault: &Pubkey) -> Vault {
        self.h.vault_state(vault)
    }

    /// Balance of `owner`'s canonical ATA, 0 if it does not exist.
    fn received(&self, owner: &Pubkey) -> u64 {
        let account = ata(owner, &self.mint, &self.token_program);
        self.h
            .account(&account)
            .map_or(0, |_| self.h.balance(&account))
    }

    /// Vault account 0's key at its current sequence signs a withdrawal that
    /// hands the vault to the key at the next sequence.
    fn sign(
        &self,
        vault: &Pubkey,
        destination_owner: &Pubkey,
        max_amount: u64,
    ) -> (u64, WithdrawArgs) {
        self.sign_as(0, vault, destination_owner, max_amount)
    }

    /// [`Env::sign`] for the vault of `account`.
    fn sign_as(
        &self,
        account: u32,
        vault: &Pubkey,
        destination_owner: &Pubkey,
        max_amount: u64,
    ) -> (u64, WithdrawArgs) {
        let sequence = self.state(vault).sequence;
        let index = u32::try_from(sequence).expect("the SDK refuses sequence >= 2^32");
        // The next key's index is its position (`withdraw` checks it); no
        // index follows u32::MAX, so a client refuses to sign there.
        let next_index = index
            .checked_add(1)
            .expect("no key index after u32::MAX: the SDK refuses to sign");
        let (key, next) = (
            self.account_key(account, index),
            self.account_key(account, next_index),
        );
        assert_eq!(
            key.key_id,
            self.state(vault).key_id,
            "the client signs only with the vault's current key"
        );
        let args = sign_withdraw(
            &key,
            &next,
            vault,
            &self.mint,
            sequence,
            destination_owner,
            max_amount,
        );
        (sequence, args)
    }

    fn withdraw_ix(&self, vault: &Pubkey, sequence: u64, args: &WithdrawArgs) -> Instruction {
        let payer = self.h.payer.pubkey();
        vault::withdraw_ix(
            &payer,
            &self.mint,
            &self.token_program,
            vault,
            sequence,
            args,
        )
    }

    /// Send a signed withdrawal for `sequence` in a v1 transaction.
    fn withdraw(&mut self, vault: &Pubkey, sequence: u64, args: &WithdrawArgs) -> TxResult {
        let ix = self.withdraw_ix(vault, sequence, args);
        self.h.send_v1(&[ix], &[])
    }

    /// Sign and execute the next withdrawal; returns its sequence.
    fn pay(&mut self, vault: &Pubkey, destination_owner: &Pubkey, max_amount: u64) -> u64 {
        let (sequence, args) = self.sign(vault, destination_owner, max_amount);
        self.withdraw(vault, sequence, &args).expect_ok("withdraw");
        sequence
    }

    fn payout(&self, vault: &Pubkey, sequence: u64) -> PayoutRef {
        self.h.payout_ref(vault, sequence)
    }

    fn payout_amount(&self, vault: &Pubkey, sequence: u64) -> u64 {
        self.h.payout_state(&payout_pda(vault, sequence)).amount
    }

    /// Transfer-hook accounts of a payment from the vault into `destination`
    /// (none without a hook).
    fn hook_extra(&self, vault: &Pubkey, destination: &Pubkey) -> Vec<AccountMeta> {
        self.h
            .hook_extra_metas(&self.mint, &self.vault_ata(vault), destination, vault, 1)
    }

    /// `release` by the harness payer into the canonical ATA.
    fn release(&mut self, vault: &Pubkey, sequence: u64) -> TxResult {
        let p = self.payout(vault, sequence);
        let destination = p.canonical_destination();
        let ix = release_ix(
            &self.h.payer.pubkey(),
            &p,
            &destination,
            &self.hook_extra(vault, &destination),
        );
        self.h.send(&[ix], &[])
    }

    /// `release_to` `destination`, signed by the recipient `owner`.
    fn release_to(
        &mut self,
        vault: &Pubkey,
        sequence: u64,
        owner: &Keypair,
        destination: &Pubkey,
    ) -> TxResult {
        let p = self.payout(vault, sequence);
        let ix = release_to_ix(&p, destination, &self.hook_extra(vault, destination));
        self.h.send(&[ix], &[owner])
    }

    /// Reserved == the sum of the open payouts, and never over the balance.
    fn assert_backed(&self, vault: &Pubkey, open: &[u64]) {
        let reserved = self.state(vault).reserved;
        let sum: u64 = open.iter().map(|s| self.payout_amount(vault, *s)).sum();
        assert_eq!(reserved, sum, "reserved is the sum of the open payouts");
        assert!(
            reserved <= self.held(vault),
            "reserved {reserved} > balance {}",
            self.held(vault)
        );
    }
}

/// A Token-2022 mint with the Launch Guard hook and an injected policy
/// (shield 40 s, guard 1 h, no caps), launched now. Returns the launch time.
fn hooked_env(p2p_locked: bool) -> (Env, i64) {
    hooked_env_with(p2p_locked, vec![])
}

/// `hooked_env` with these creator rules (PXR1 bytes) in the policy.
fn hooked_env_with(p2p_locked: bool, rules: Vec<u8>) -> (Env, i64) {
    let mut h = Harness::new();
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
    h.init_meta_list(&mint);
    let pool_authority = Keypair::new();
    let base_vault = h.create_ata(&pool_authority.pubkey(), &mint);
    let launch_ts = h.now();
    h.inject_policy(
        &PolicySpec {
            mint,
            pool: Pubkey::new_unique(),
            base_vault,
            launch_ts,
            shield_secs: SHIELD_SECS,
            guard_secs: GUARD_SECS,
            max_wallet: 0,
            max_buy: 0,
            p2p_locked,
            exempt: vec![],
            rules,
        }
        .to_policy(),
    );
    (Env::with_mint(h, mint), launch_ts)
}

fn fixed_fee() -> MintExt {
    MintExt::TransferFee {
        config_authority: None,
        withdraw_authority: None,
        basis_points: 100,
        maximum_fee: u64::MAX,
    }
}

/// Borsh fields of an event payload, read in the documented order.
struct Fields<'a>(&'a [u8]);

impl Fields<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        assert!(self.0.len() >= N, "event payload too short");
        let (head, rest) = self.0.split_at(N);
        self.0 = rest;
        head.try_into().expect("N bytes")
    }

    fn pubkey(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.take())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }

    fn end(self, event: &str) {
        assert!(
            self.0.is_empty(),
            "{event}: {} bytes left over",
            self.0.len()
        );
    }
}

/// The single event `name` a transaction emitted.
fn single_event(sent: &Sent, name: &str) -> Vec<u8> {
    let events = anchor_events(&sent.logs, name);
    assert_eq!(events.len(), 1, "exactly one {name}\n{:#?}", sent.logs);
    events.into_iter().next().expect("one event")
}

/// SPEC §3.3 `VaultOpened {vault, mint, key_id}`.
#[derive(Debug, PartialEq)]
struct Opened {
    vault: Pubkey,
    mint: Pubkey,
    key_id: [u8; 32],
}

fn opened(sent: &Sent) -> Opened {
    let data = single_event(sent, "VaultOpened");
    let mut f = Fields(&data);
    let event = Opened {
        vault: f.pubkey(),
        mint: f.pubkey(),
        key_id: f.take(),
    };
    f.end("VaultOpened");
    event
}

/// SPEC §3.3 `VaultWithdrawn {vault, mint, sequence, destination_owner,
/// amount, payout, next_key_id}`.
#[derive(Debug, PartialEq)]
struct Withdrawn {
    vault: Pubkey,
    mint: Pubkey,
    sequence: u64,
    destination_owner: Pubkey,
    amount: u64,
    payout: Pubkey,
    next_key_id: [u8; 32],
}

fn withdrawn(sent: &Sent) -> Withdrawn {
    let data = single_event(sent, "VaultWithdrawn");
    let mut f = Fields(&data);
    let event = Withdrawn {
        vault: f.pubkey(),
        mint: f.pubkey(),
        sequence: f.u64(),
        destination_owner: f.pubkey(),
        amount: f.u64(),
        payout: f.pubkey(),
        next_key_id: f.take(),
    };
    f.end("VaultWithdrawn");
    event
}

/// SPEC §3.3 `PayoutReleased {vault, payout, sequence, destination_owner,
/// destination, amount}`.
#[derive(Debug, PartialEq)]
struct Released {
    vault: Pubkey,
    payout: Pubkey,
    sequence: u64,
    destination_owner: Pubkey,
    destination: Pubkey,
    amount: u64,
}

fn released(sent: &Sent) -> Released {
    let data = single_event(sent, "PayoutReleased");
    let mut f = Fields(&data);
    let event = Released {
        vault: f.pubkey(),
        payout: f.pubkey(),
        sequence: f.u64(),
        destination_owner: f.pubkey(),
        destination: f.pubkey(),
        amount: f.u64(),
    };
    f.end("PayoutReleased");
    event
}

#[test]
fn message_key_id_and_pdas_match_spec_and_crates() {
    let mint = Pubkey::new_unique();
    let master = master_seed("format");
    let key = PqKey::derive(&master, &mint, 0, 0);
    let next = PqKey::derive(&master, &mint, 0, 1);
    // key_id from SPEC §3 == the LM-OTS crate == the program's own helper.
    assert_eq!(
        key.key_id,
        noised_lmots::key_id::<noised_lmots::Sha2>(&key.pk)
    );
    assert_eq!(key.key_id, noised_vault::state::key_id(&key.pk));
    assert_eq!((key.pk.q, next.pk.q), (0, 1), "q is the sequence");

    // SPEC §3.10 path: cluster | mint | u32le(account) | u32le(sequence).
    let path = vault::derivation_path(vault::CLUSTER_DEVNET, &mint, 0x0102_0304, 0x0a0b_0c0d);
    assert_eq!(path.len(), 41);
    assert_eq!(path[0], 1);
    assert_eq!(&path[1..33], mint.as_ref());
    assert_eq!(path[33..], [4, 3, 2, 1, 0x0d, 0x0c, 0x0b, 0x0a]);
    // Every (cluster, mint, account, sequence) gives its own key: neither
    // field can stand in for another, so keys never repeat across vaults.
    let ids = [
        key.key_id,
        next.key_id,
        PqKey::derive(&master, &mint, 1, 0).key_id,
        PqKey::derive(&master, &mint, 1, 1).key_id,
        PqKey::derive(&master, &mint, 0x0100, 0).key_id,
        PqKey::derive(&master, &mint, 0, 0x0100).key_id,
        PqKey::derive(&master, &Pubkey::new_unique(), 0, 0).key_id,
        PqKey::derive_on(vault::CLUSTER_MAINNET, &master, &mint, 0, 0).key_id,
        PqKey::derive_on(vault::CLUSTER_DEVNET, &master, &mint, 0, 0).key_id,
        PqKey::derive(&master_seed("another phrase"), &mint, 0, 0).key_id,
    ];
    for (i, a) in ids.iter().enumerate() {
        assert!(ids[i + 1..].iter().all(|b| b != a), "key {i} repeats");
    }
    let other_account = PqKey::derive(&master, &mint, 1, 7);
    assert_eq!(
        (
            other_account.account,
            other_account.sequence,
            other_account.pk.q
        ),
        (1, 7, 7)
    );
    assert_ne!(
        key.vault(&mint),
        PqKey::derive(&master, &mint, 1, 0).vault(&mint),
        "one vault per account"
    );

    // The documented seeds are the program crate's.
    let vault = key.vault(&mint);
    let seeds: [&[u8]; 3] = [VAULT_SEED, mint.as_ref(), &key.key_id];
    assert_eq!(vault, Pubkey::find_program_address(&seeds, &VAULT_ID).0);
    for sequence in [0, 1, 255, 256, u64::MAX] {
        let seeds: [&[u8]; 3] = [PAYOUT_SEED, vault.as_ref(), &sequence.to_le_bytes()];
        assert_eq!(
            payout_pda(&vault, sequence),
            Pubkey::find_program_address(&seeds, &VAULT_ID).0
        );
    }

    let destination_owner = Pubkey::new_unique();
    assert_eq!(
        WITHDRAW_MESSAGE_LEN,
        noised_vault::message::WITHDRAW_MESSAGE_LEN
    );
    assert_eq!(vault::MESSAGE_TAG, noised_vault::message::MESSAGE_TAG);
    for (sequence, max_amount) in [(0u64, 42u64), (7, u64::MAX), (0x0102_0304_0506_0708, 0)] {
        let msg = withdraw_message(
            &vault,
            &mint,
            sequence,
            &destination_owner,
            max_amount,
            &next.key_id,
        );
        let program_msg = noised_vault::message::withdraw_message(
            &VAULT_ID,
            &vault,
            &mint,
            sequence,
            &destination_owner,
            max_amount,
            &next.key_id,
        );
        assert_eq!(
            msg.as_slice(),
            program_msg.as_slice(),
            "spec message == program message"
        );
        assert_eq!(&msg[..9], b"PHX-PQV4\x01");
        assert_eq!(&msg[9..41], VAULT_ID.as_ref());
        assert_eq!(&msg[41..73], vault.as_ref());
        assert_eq!(&msg[73..105], mint.as_ref());
        assert_eq!(msg[105..113], sequence.to_le_bytes());
        assert_eq!(&msg[113..145], destination_owner.as_ref());
        assert_eq!(msg[145..153], max_amount.to_le_bytes());
        assert_eq!(msg[153..185], next.key_id);
    }

    // Signing is deterministic: re-signing a withdrawal reproduces its
    // signature instead of revealing a second one.
    let msg = withdraw_message(&vault, &mint, 0, &destination_owner, 42, &next.key_id);
    let sig = key.sign(&msg);
    assert_eq!(sig.len(), noised_lmots::SIG_LEN);
    assert_eq!(sig, key.sign(&msg), "same message, same signature");
    // C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" | I | u32be(q) | msg): the
    // crate's randomizer is the documented construction, written out here.
    let c = vault::randomizer(&key.sk, &msg);
    assert_eq!(
        c,
        vault::spec_randomizer(&key.sk.seed, &key.sk.id, key.sk.q, &msg)
    );
    assert_eq!(sig[..32], c, "the signature carries its randomizer");
    assert_eq!(sig, key.sign_with_randomizer(&msg, &c));
    let other = withdraw_message(&vault, &mint, 0, &destination_owner, 43, &next.key_id);
    assert_ne!(
        key.sign(&other)[..32],
        sig[..32],
        "another message, another randomizer"
    );
    assert_ne!(
        next.sign(&msg)[..32],
        sig[..32],
        "another key, another randomizer"
    );
    assert!(noised_lmots::verify::<noised_lmots::Sha2>(
        &key.pk, &msg, &sig
    ));
    // The published known answer (also checked by noised-lmots and the SDK).
    let kat = noised_lmots::PrivateKey {
        id: [0x22; 16],
        q: 7,
        seed: [0x11; 32],
    };
    let expected = "efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3";
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    assert_eq!(hex(&vault::randomizer(&kat, b"phalanx")), expected);
    assert_eq!(
        hex(&vault::spec_randomizer(
            &kat.seed, &kat.id, kat.q, b"phalanx"
        )),
        expected
    );
}

#[test]
fn open_deposit_withdraw_then_anyone_releases_to_the_canonical_ata() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let (k0, k1, k2) = (e.key(0), e.key(1), e.key(2));
    let v = e.open();
    let (_, bump) =
        Pubkey::find_program_address(&[VAULT_SEED, e.mint.as_ref(), &k0.key_id], &VAULT_ID);
    let s = e.state(&v);
    assert_eq!(
        (s.version, s.bump, s.mint, s.genesis_key_id, s.sequence),
        (4, bump, e.mint, k0.key_id, 0)
    );
    assert_eq!(
        (s.key_id, s.key_ident, s.key_q, s.key_k, s.reserved),
        (k0.key_id, k0.pk.id, 0, k0.pk.k, 0)
    );
    assert_eq!(
        e.h.account(&v).expect("vault").data.len(),
        8 + Vault::INIT_SPACE
    );
    assert_eq!(e.h.token_account(&e.vault_ata(&v)).owner, v);
    e.deposit(&v, DEPOSIT);
    assert_eq!(e.held(&v), DEPOSIT);

    // k0 signs once: "reserve up to 300_000 for bob's wallet, then k1 holds the vault".
    let bob = e.bob.pubkey();
    let bob_ata = ata(&bob, &e.mint, &TOKEN_PROGRAM_ID);
    let args = sign_withdraw(&k0, &k1, &v, &e.mint, 0, &bob, 300_000);
    // A throwaway relayer pays the fee and the payout's rent. It signs the
    // transaction but has no authority over the vault, and nothing it
    // controls is in the signed message.
    let relayer = Keypair::new();
    e.h.airdrop(&relayer.pubkey(), RELAYER_LAMPORTS);
    let ix = vault::withdraw_ix(&relayer.pubkey(), &e.mint, &TOKEN_PROGRAM_ID, &v, 0, &args);
    assert_eq!(ix.data.len(), WITHDRAW_IX_DATA_LEN);
    assert_eq!(ix.data[..8], anchor_discriminator("global", "withdraw"));
    assert!(
        ix.accounts
            .iter()
            .all(|m| m.pubkey != bob && m.pubkey != bob_ata),
        "no account of the recipient takes part"
    );

    // Sent as the SDK sends it: a v1 transaction with the SDK's config words,
    // encoded exactly as SPEC §3 describes. Its instruction data alone is
    // larger than a whole legacy transaction may be.
    let tx = e.h.v1_tx_with(
        &relayer,
        std::slice::from_ref(&ix),
        &[],
        vault::withdraw_tx_config(),
    );
    let wire = wincode::serialize(&tx).expect("serialize v1 transaction");
    assert_eq!(wire, v1_wire_per_spec(&tx), "v1 encoding per SPEC §3");
    assert!(wire.len() <= V1_MAX_TRANSACTION_SIZE);
    assert!(ix.data.len() > PACKET_DATA_SIZE);
    let legacy = wire_size(&e.h.legacy_tx(&[ix], &[&relayer], None));
    assert!(legacy > PACKET_DATA_SIZE);
    // The loaded-data limit also covers what mainnet meters (programdata included).
    let loaded = e.h.loaded_accounts_data_size(&tx);
    assert!(
        loaded <= u64::from(WITHDRAW_LOADED_ACCOUNTS_DATA_LIMIT),
        "loaded {loaded}"
    );
    let sent = e.h.submit(tx).expect_ok("withdraw");

    // Reserved, not moved: the balance stays, the key rotated in place.
    assert_eq!(e.held(&v), DEPOSIT);
    let s = e.state(&v);
    assert_eq!(
        (s.sequence, s.reserved, s.genesis_key_id),
        (1, 300_000, k0.key_id)
    );
    assert_eq!(
        (s.key_id, s.key_ident, s.key_q, s.key_k),
        (k1.key_id, k1.pk.id, 1, k1.pk.k)
    );
    let payout = payout_pda(&v, 0);
    let (_, payout_bump) =
        Pubkey::find_program_address(&[PAYOUT_SEED, v.as_ref(), &0u64.to_le_bytes()], &VAULT_ID);
    let p = e.h.payout_state(&payout);
    assert_eq!(
        (p.version, p.bump, p.vault, p.sequence),
        (1, payout_bump, v, 0)
    );
    assert_eq!(
        (p.destination_owner, p.amount, p.rent_payer),
        (bob, 300_000, relayer.pubkey())
    );
    assert!(
        e.h.account(&bob_ata).is_none(),
        "withdraw creates nothing for the recipient"
    );
    let payout_rent = e.h.rent_exempt(8 + Payout::INIT_SPACE);
    assert_eq!(e.h.lamports(&payout), payout_rent);
    assert_eq!(sent.fee, 5_000, "one signature, no priority fee");
    assert_eq!(
        e.h.lamports(&relayer.pubkey()),
        RELAYER_LAMPORTS - sent.fee - payout_rent
    );

    // Anyone delivers. A cranker pays for bob's missing ATA; the payout's
    // rent goes back to the relayer.
    let cranker = e.h.funded_keypair(1);
    let before = e.h.lamports(&cranker.pubkey());
    let rel = release_ix(&cranker.pubkey(), &e.payout(&v, 0), &bob_ata, &[]);
    let released =
        e.h.send(&[rel], &[&cranker])
            .expect_ok("release by a third party");
    assert_eq!(e.received(&bob), 300_000);
    assert_eq!(e.h.token_account(&bob_ata).owner, bob);
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 300_000, 0));
    assert!(e.h.account(&payout).is_none(), "the payout closed");
    assert_eq!(
        e.h.lamports(&relayer.pubkey()),
        RELAYER_LAMPORTS - sent.fee,
        "rent refunded"
    );
    assert_eq!(
        e.h.lamports(&cranker.pubkey()),
        before - e.h.rent_exempt(165),
        "the cranker paid the ATA"
    );

    let program = program_cu(&sent.logs, &VAULT_ID);
    report("vault withdraw (SPL Token): vault program CU", program);
    report("vault withdraw (SPL Token): transaction CU", sent.cu);
    report(
        "vault withdraw (SPL Token): v1 transaction bytes",
        sent.size,
    );
    report(
        "vault withdraw (SPL Token): legacy encoding bytes (not sendable)",
        legacy,
    );
    report(
        "vault withdraw (SPL Token): loaded accounts data, SIMD-0186 (limit 4 MiB)",
        loaded,
    );
    report(
        "vault withdraw: relayer cost, lamports (fee; the payout rent comes back)",
        sent.fee,
    );
    report(
        "vault release (SPL Token, ATA created): vault program CU",
        program_cu(&released.logs, &VAULT_ID),
    );
    assert!(
        program <= sent.cu
            && sent.cu < u64::from(WITHDRAW_CU_LIMIT)
            && WITHDRAW_CU_LIMIT < MAX_CU_LIMIT,
        "withdraw CU {}",
        sent.cu
    );

    // k1 signs "up to u64::MAX" for alice: min(max_amount, unreserved balance).
    let alice = e.alice.pubkey();
    let before = e.received(&alice);
    let args = sign_withdraw(&k1, &k2, &v, &e.mint, 1, &alice, u64::MAX);
    e.withdraw(&v, 1, &args)
        .expect_ok("withdraw with the rotated key");
    assert_eq!(e.state(&v).reserved, DEPOSIT - 300_000);
    e.release(&v, 1)
        .expect_ok("release to alice's existing ATA");
    assert_eq!(e.received(&alice), before + DEPOSIT - 300_000);
    let s = e.state(&v);
    assert_eq!(
        (e.held(&v), s.reserved, s.sequence, s.key_id),
        (0, 0, 2, k2.key_id)
    );
}

/// What a client sends, measured: a withdrawal alone, a release alone, and
/// withdraw + release in one v1 transaction (SDK config words, throwaway
/// fee payer), on SPL Token and on Token-2022 with the Launch Guard (after
/// the guard). Run with `--nocapture` for the report.
#[test]
fn withdraw_and_release_sizes_and_compute() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    measure(&mut e, &v, "SPL Token");

    let (mut e, launch_ts) = hooked_env(true);
    let v = e.open();
    e.fund(&v, DEPOSIT);
    e.h.set_time(launch_ts + GUARD_SECS);
    measure(&mut e, &v, "Token-2022 + Launch Guard");
}

/// Send `ixs` as a client does (v1, SDK config words, `relayer` pays) and
/// report the transaction's size, compute and loaded data.
fn send_measured(
    e: &mut Env,
    relayer: &Keypair,
    ixs: &[Instruction],
    label: &str,
    what: &str,
) -> Sent {
    let tx =
        e.h.v1_tx_with(relayer, ixs, &[], vault::withdraw_tx_config());
    let loaded = e.h.loaded_accounts_data_size(&tx);
    assert!(
        loaded <= u64::from(WITHDRAW_LOADED_ACCOUNTS_DATA_LIMIT),
        "{label}, {what}: loaded {loaded}"
    );
    let sent = e.h.submit(tx).expect_ok(what);
    assert!(
        sent.cu < u64::from(WITHDRAW_CU_LIMIT),
        "{label}, {what}: {} CU",
        sent.cu
    );
    let program = program_cu(&sent.logs, &VAULT_ID);
    report(
        &format!("{label}, {what}: transaction CU / vault program CU"),
        format!("{} / {program}", sent.cu),
    );
    report(&format!("{label}, {what}: v1 transaction bytes"), sent.size);
    report(
        &format!("{label}, {what}: loaded accounts data, SIMD-0186"),
        loaded,
    );
    sent
}

fn measure(e: &mut Env, v: &Pubkey, label: &str) {
    let relayer = Keypair::new();
    e.h.airdrop(&relayer.pubkey(), RELAYER_LAMPORTS);
    // A withdrawal alone, then its release into an ATA that does not exist yet.
    let carol = Pubkey::new_unique();
    let (seq, args) = e.sign(v, &carol, 1_000);
    let withdraw = vault::withdraw_ix(&relayer.pubkey(), &e.mint, &e.token_program, v, seq, &args);
    send_measured(e, &relayer, &[withdraw], label, "withdraw");
    let p = e.payout(v, seq);
    let destination = p.canonical_destination();
    let release = release_ix(
        &relayer.pubkey(),
        &p,
        &destination,
        &e.hook_extra(v, &destination),
    );
    send_measured(e, &relayer, &[release], label, "release creating the ATA");
    assert_eq!(e.received(&carol), 1_000);

    // Withdraw + release in one transaction: the payout opens and closes in
    // it, so the relayer pays only the fee and the new ATA.
    let dave = Pubkey::new_unique();
    let (seq, args) = e.sign(v, &dave, 1_000);
    let withdraw = vault::withdraw_ix(&relayer.pubkey(), &e.mint, &e.token_program, v, seq, &args);
    let p = PayoutRef {
        mint: e.mint,
        token_program: e.token_program,
        vault: *v,
        payout: payout_pda(v, seq),
        rent_payer: relayer.pubkey(),
        destination_owner: dave,
    };
    let destination = p.canonical_destination();
    let release = release_ix(
        &relayer.pubkey(),
        &p,
        &destination,
        &e.hook_extra(v, &destination),
    );
    let before = e.h.lamports(&relayer.pubkey());
    let sent = send_measured(
        e,
        &relayer,
        &[withdraw, release],
        label,
        "withdraw + release",
    );
    assert!(e.h.account(&p.payout).is_none());
    assert_eq!(e.received(&dave), 1_000);
    let ata_rent =
        e.h.rent_exempt(e.h.account(&destination).expect("ATA").data.len());
    assert_eq!(
        e.h.lamports(&relayer.pubkey()),
        before - sent.fee - ata_rent
    );
    assert_eq!(e.state(v).reserved, 0);
}

/// The events clients and indexers read (SPEC §3.3), decoded field by field
/// from the documented layouts: `VaultOpened`; `VaultWithdrawn` with the
/// amount actually reserved (not `max_amount`), its payout and the next key;
/// `PayoutReleased` with the account actually paid, for `release` (the
/// canonical ATA), `release_to` (the account the recipient chose) and an
/// empty payout.
#[test]
fn events_report_what_each_instruction_did() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let (k0, k1, k2, k3) = (e.key(0), e.key(1), e.key(2), e.key(3));
    let (mint, payer) = (e.mint, e.h.payer.pubkey());
    let ix = open_vault_ix(&payer, &mint, &TOKEN_PROGRAM_ID, k0.key_id, k0.vault_key());
    let sent = e.h.send(&[ix], &[]).expect_ok("open_vault");
    let v = k0.vault(&mint);
    assert_eq!(
        opened(&sent),
        Opened {
            vault: v,
            mint,
            key_id: k0.key_id
        }
    );
    e.deposit(&v, DEPOSIT);

    // 600_000 of 1M; then "everything", which is the 400_000 left; then nothing is left.
    let (bob, carol, dave) = (e.bob.pubkey(), e.h.funded_keypair(1), Pubkey::new_unique());
    let withdraw = |e: &mut Env, to: &Pubkey, max_amount: u64| {
        let (seq, args) = e.sign(&v, to, max_amount);
        withdrawn(&e.withdraw(&v, seq, &args).expect_ok("withdraw"))
    };
    let expected =
        |sequence: u64, destination_owner: Pubkey, amount: u64, next: &PqKey| Withdrawn {
            vault: v,
            mint,
            sequence,
            destination_owner,
            amount,
            payout: payout_pda(&v, sequence),
            next_key_id: next.key_id,
        };
    assert_eq!(
        withdraw(&mut e, &bob, 600_000),
        expected(0, bob, 600_000, &k1)
    );
    assert_eq!(
        withdraw(&mut e, &carol.pubkey(), u64::MAX),
        expected(1, carol.pubkey(), 400_000, &k2)
    );
    assert_eq!(withdraw(&mut e, &dave, 5), expected(2, dave, 0, &k3));

    let release_event =
        |sequence: u64, destination_owner: Pubkey, destination: Pubkey, amount: u64| Released {
            vault: v,
            payout: payout_pda(&v, sequence),
            sequence,
            destination_owner,
            destination,
            amount,
        };
    let sent = e.release(&v, 0).expect_ok("release");
    let bob_ata = ata(&bob, &mint, &TOKEN_PROGRAM_ID);
    assert_eq!(released(&sent), release_event(0, bob, bob_ata, 600_000));
    let carol_account = e.h.create_token_account(&carol.pubkey(), &mint);
    let sent = e
        .release_to(&v, 1, &carol, &carol_account)
        .expect_ok("release_to");
    assert_eq!(
        released(&sent),
        release_event(1, carol.pubkey(), carol_account, 400_000)
    );
    // An empty payout moves nothing; the event names the account passed in.
    let anywhere = Pubkey::new_unique();
    let ix = release_ix(&payer, &e.payout(&v, 2), &anywhere, &[]);
    let sent = e.h.send(&[ix], &[]).expect_ok("release the empty payout");
    assert_eq!(released(&sent), release_event(2, dave, anywhere, 0));
    assert_eq!(
        (e.received(&bob), e.h.balance(&carol_account), e.held(&v)),
        (600_000, 400_000, 0)
    );
}

/// The recipient can take its payout into any token account of the mint
/// by signing `release_to`; nobody else can redirect it.
#[test]
fn release_to_pays_any_account_the_recipient_signs_for() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let s0 = e.pay(&v, &bob.pubkey(), 250);
    let s1 = e.pay(&v, &bob.pubkey(), 750);
    let p = e.payout(&v, s0);
    let bob_other = e.h.create_token_account(&bob.pubkey(), &e.mint);

    // Without bob: no signature, another signer, an account of another mint.
    let mut unsigned = release_to_ix(&p, &bob_other, &[]);
    unsigned.accounts[0].is_signer = false;
    e.h.send(&[unsigned], &[])
        .expect_error(AnchorError::AccountNotSigner, "the recipient did not sign");
    let mallory = e.h.funded_keypair(1);
    let mallory_account = e.h.create_token_account(&mallory.pubkey(), &e.mint);
    let mut forged = release_to_ix(&p, &mallory_account, &[]);
    forged.accounts[0].pubkey = mallory.pubkey();
    e.h.send(&[forged], &[&mallory])
        .expect_error(AnchorError::ConstraintHasOne, "signed by someone else");
    let other_mint = e.h.create_mint(TOKEN_PROGRAM_ID, DECIMALS, None);
    let wrong_mint = e.h.create_token_account(&bob.pubkey(), &other_mint);
    e.release_to(&v, s0, &bob, &wrong_mint).expect_error(
        AnchorError::ConstraintTokenMint,
        "an account of another mint",
    );
    // Not even bob can name the vault's own token account (Anchor refuses the
    // duplicate writable account); the payout just waits for another choice.
    let vault_account = e.vault_ata(&v);
    e.release_to(&v, s0, &bob, &vault_account).expect_error(
        AnchorError::ConstraintDuplicateMutableAccount,
        "the vault's own token account",
    );
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT, 1_000));

    // Bob takes the first payout into a non-ATA account of his...
    e.release_to(&v, s0, &bob, &bob_other)
        .expect_ok("release_to bob's other account");
    assert_eq!(e.h.balance(&bob_other), 250);
    // ...and the second into carol's account: his choice, signed by him.
    let carol_account = e.h.create_token_account(&Pubkey::new_unique(), &e.mint);
    e.release_to(&v, s1, &bob, &carol_account)
        .expect_ok("release_to an account bob does not own");
    assert_eq!(e.h.balance(&carol_account), 750);
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 1_000, 0));
    for s in [s0, s1] {
        assert!(e.h.account(&payout_pda(&v, s)).is_none());
    }
    assert_eq!(e.received(&bob.pubkey()), 0, "bob's ATA was never needed");
}

/// `release` delivers a payout exactly as recorded: from its own vault, to
/// its recipient's canonical ATA, with the rent to its rent payer.
#[test]
fn release_checks_every_account_against_the_payout() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    // The same user's second vault for this mint (account 1).
    let w = e.open_with(&e.account_key(1, 0));
    e.deposit(&w, DEPOSIT);
    let bob = e.bob.pubkey();
    let seq = e.pay(&v, &bob, 400);
    let p = e.payout(&v, seq);
    let bob_ata = p.canonical_destination();
    let carol = Pubkey::new_unique();
    let carol_ata = ata(&carol, &e.mint, &TOKEN_PROGRAM_ID);
    let bob_other = e.h.create_token_account(&bob, &e.mint);
    let payer = e.h.payer.pubkey();
    let send = |e: &mut Env, p: PayoutRef, destination: Pubkey| {
        e.h.send(&[release_ix(&payer, &p, &destination, &[])], &[])
    };

    send(&mut e, PayoutRef { vault: w, ..p }, bob_ata)
        .expect_error(AnchorError::ConstraintSeeds, "the payout of another vault");
    send(
        &mut e,
        PayoutRef {
            destination_owner: carol,
            ..p
        },
        carol_ata,
    )
    .expect_error(AnchorError::ConstraintHasOne, "another recipient");
    send(
        &mut e,
        PayoutRef {
            rent_payer: carol,
            ..p
        },
        bob_ata,
    )
    .expect_error(AnchorError::ConstraintHasOne, "another rent payer");
    send(
        &mut e,
        PayoutRef {
            payout: payout_pda(&v, seq + 1),
            ..p
        },
        bob_ata,
    )
    .expect_error(
        AnchorError::AccountNotInitialized,
        "no payout at that sequence",
    );
    for (what, destination) in [
        ("bob's non-canonical account", bob_other),
        ("carol's ATA", carol_ata),
        (
            "bob's ATA under the other token program",
            ata(&bob, &e.mint, &TOKEN_2022_PROGRAM_ID),
        ),
    ] {
        send(&mut e, p, destination).expect_error(VaultError::InvalidDestination, what);
    }
    let mut ix = release_ix(&payer, &p, &bob_ata, &[]);
    ix.accounts[3].pubkey = e.alice_ata;
    e.h.send(&[ix], &[]).expect_error(
        AnchorError::ConstraintTokenOwner,
        "another token account as the vault's",
    );
    assert_eq!(
        (
            e.held(&v),
            e.held(&w),
            e.state(&v).reserved,
            e.received(&bob)
        ),
        (DEPOSIT, DEPOSIT, 400, 0)
    );

    e.release(&v, seq).expect_ok("release");
    assert_eq!(e.received(&bob), 400);
    send(&mut e, p, bob_ata).expect_error(AnchorError::AccountNotInitialized, "release twice");
    assert_eq!(
        (e.held(&v), e.held(&w), e.state(&v).reserved),
        (DEPOSIT - 400, DEPOSIT, 0)
    );
}

/// `withdraw` reads the balance of the vault's own token account only.
#[test]
fn withdraw_reads_only_the_vault_token_account() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, 100);
    let bob = e.bob.pubkey();
    let (seq, args) = e.sign(&v, &bob, u64::MAX);
    let mut ix = e.withdraw_ix(&v, seq, &args);
    ix.accounts[3].pubkey = e.alice_ata;
    e.h.send_v1(&[ix], &[]).expect_error(
        AnchorError::ConstraintTokenOwner,
        "a richer account of the same mint",
    );
    let vault_owned = e.h.create_token_account(&v, &e.mint);
    let mut ix = e.withdraw_ix(&v, seq, &args);
    ix.accounts[3].pubkey = vault_owned;
    e.h.send_v1(&[ix], &[]).expect_error(
        AnchorError::ConstraintAssociated,
        "an account of the vault that is not its ATA",
    );
    e.withdraw(&v, seq, &args).expect_ok("the vault's ATA");
    assert_eq!(e.state(&v).reserved, 100);
}

/// A withdrawal reserves `min(max_amount, balance - reserved)`: never more
/// than the vault holds, however many payouts still wait.
#[test]
fn reservations_never_exceed_the_balance() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let (bob, carol, dave, erin) = (
        e.bob.pubkey(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    let s0 = e.pay(&v, &bob, 600_000);
    e.assert_backed(&v, &[s0]);
    let s1 = e.pay(&v, &carol, 600_000);
    assert_eq!(
        e.payout_amount(&v, s1),
        400_000,
        "only what is not reserved"
    );
    let s2 = e.pay(&v, &dave, u64::MAX);
    assert_eq!(e.payout_amount(&v, s2), 0, "nothing is left");
    e.assert_backed(&v, &[s0, s1, s2]);
    assert_eq!((e.state(&v).reserved, e.held(&v)), (DEPOSIT, DEPOSIT));

    // Delivered in any order.
    e.release(&v, s1).expect_ok("carol");
    e.assert_backed(&v, &[s0, s2]);
    e.release(&v, s2).expect_ok("dave's empty payout");
    assert!(
        e.h.account(&ata(&dave, &e.mint, &TOKEN_PROGRAM_ID))
            .is_none(),
        "an empty payout creates no account"
    );
    e.assert_backed(&v, &[s0]);
    e.release(&v, s0).expect_ok("bob");
    assert_eq!((e.received(&bob), e.received(&carol)), (600_000, 400_000));
    assert_eq!((e.held(&v), e.state(&v).reserved), (0, 0));

    // A later deposit is the current key's to spend.
    e.deposit(&v, 50_000);
    let s3 = e.pay(&v, &erin, u64::MAX);
    e.assert_backed(&v, &[s3]);
    e.release(&v, s3).expect_ok("erin");
    let s = e.state(&v);
    assert_eq!(
        (e.received(&erin), e.held(&v), s.reserved, s.sequence),
        (50_000, 0, 0, 4)
    );
}

/// `max_amount = 0` only rotates the key. Its payout holds nothing; it
/// closes on `release` (whose destination is then ignored) or `release_to`.
#[test]
fn rotate_only_withdrawals_and_empty_payouts() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let pending = e.pay(&v, &bob.pubkey(), 1_000);
    let s1 = e.pay(&v, &bob.pubkey(), 0);
    let s2 = e.pay(&v, &bob.pubkey(), 0);
    let s = e.state(&v);
    assert_eq!(
        (s.sequence, s.key_id, s.reserved, e.held(&v)),
        (3, e.key(3).key_id, 1_000, DEPOSIT)
    );
    assert_eq!((e.payout_amount(&v, s1), e.payout_amount(&v, s2)), (0, 0));

    let p = e.payout(&v, s1);
    let ix = release_ix(&e.h.payer.pubkey(), &p, &Pubkey::new_unique(), &[]);
    e.h.send(&[ix], &[]).expect_ok("release an empty payout");
    assert!(e.h.account(&payout_pda(&v, s1)).is_none());
    assert!(
        e.h.account(&p.canonical_destination()).is_none(),
        "no ATA created"
    );
    let bob_account = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.release_to(&v, s2, &bob, &bob_account)
        .expect_ok("release_to an empty payout");
    assert!(e.h.account(&payout_pda(&v, s2)).is_none());
    assert_eq!(e.h.balance(&bob_account), 0);
    assert_eq!(
        (e.held(&v), e.state(&v).reserved),
        (DEPOSIT, 1_000),
        "the pending payout waits"
    );
    e.release(&v, pending).expect_ok("the pending payout");
    assert_eq!(e.received(&bob.pubkey()), 1_000);
}

/// A signature is good for one sequence of one vault: replaying it after
/// the rotation fails, however the relayer fills in the accounts.
#[test]
fn a_replayed_signature_is_rejected_after_the_rotation() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.pubkey();
    let (seq, args) = e.sign(&v, &bob, 300_000);
    e.withdraw(&v, seq, &args).expect_ok("withdraw");

    // The same instruction again (a new transaction): the vault's sequence,
    // not the client, decides the payout address.
    e.withdraw(&v, seq, &args).expect_error(
        AnchorError::ConstraintSeeds,
        "replay with the same accounts",
    );
    // At the next sequence the replayed message names the current key (k1)
    // as the next one, which is refused before the signature is checked.
    e.withdraw(&v, seq + 1, &args).expect_error(
        VaultError::InvalidNextKey,
        "replay right after the rotation",
    );
    // Once k2 holds the vault, k0's message fails the signature check.
    let rotation = e.pay(&v, &bob, 0);
    e.withdraw(&v, rotation + 1, &args)
        .expect_error(VaultError::InvalidSignature, "replay two rotations later");
    e.release(&v, seq).expect_ok("release");
    e.deposit(&v, 50_000);
    e.withdraw(&v, rotation + 1, &args).expect_error(
        VaultError::InvalidSignature,
        "replay after the release and a late deposit",
    );
    e.withdraw(&v, seq, &args).expect_error(
        AnchorError::ConstraintSeeds,
        "replay into the closed payout's address",
    );
    let s = e.state(&v);
    assert_eq!((s.sequence, s.key_id, s.reserved), (2, e.key(2).key_id, 0));
    assert_eq!(
        (e.received(&bob), e.held(&v)),
        (300_000, DEPOSIT - 300_000 + 50_000)
    );
}

/// The sequence is signed: a message for another position fails, and a
/// withdrawal the next key signs ahead of time executes only at its own.
#[test]
fn a_signature_executes_only_at_its_sequence() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let (k0, k1, k2) = (e.key(0), e.key(1), e.key(2));
    let (mint, bob) = (e.mint, e.bob.pubkey());
    let ahead = sign_withdraw(&k1, &k2, &v, &mint, 1, &bob, 200);
    e.withdraw(&v, 0, &ahead).expect_error(
        VaultError::InvalidSignature,
        "k1's message while k0 holds the vault",
    );
    let wrong = sign_withdraw(&k0, &k1, &v, &mint, 1, &bob, 100);
    e.withdraw(&v, 0, &wrong)
        .expect_error(VaultError::InvalidSignature, "k0 signed sequence 1");
    assert_eq!(e.state(&v).sequence, 0);
    e.withdraw(&v, 0, &sign_withdraw(&k0, &k1, &v, &mint, 0, &bob, 100))
        .expect_ok("sequence 0");
    e.withdraw(&v, 1, &ahead)
        .expect_ok("the withdrawal signed ahead, at sequence 1");
    let s = e.state(&v);
    assert_eq!((s.sequence, s.key_id, s.reserved), (2, k2.key_id, 300));
}

#[test]
fn withdraw_rejects_forged_or_tampered_signatures() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let (k0, k1, k2) = (e.key(0), e.key(1), e.key(2));
    let (mint, bob, alice) = (e.mint, e.bob.pubkey(), e.alice.pubkey());
    let good = sign_withdraw(&k0, &k1, &v, &mint, 0, &bob, 300_000);
    let tweak = |f: &dyn Fn(&mut WithdrawArgs)| {
        let mut a = good.clone();
        f(&mut a);
        a
    };
    // k0's valid signature over the message with one field changed.
    let message = || withdraw_message(&v, &mint, 0, &bob, 300_000, &k1.key_id);
    let signed_over = |change: &dyn Fn(&mut Vec<u8>)| {
        let mut m = message();
        change(&mut m);
        tweak(&|a| a.signature = k0.sign(&m))
    };
    let other = Pubkey::new_unique();
    let twin = vault_pda(&other, &k0.key_id);
    let cases: Vec<(&str, WithdrawArgs)> = vec![
        (
            "flipped bit in a chain value",
            tweak(&|a| a.signature[1000] ^= 1),
        ),
        ("changed randomizer C", tweak(&|a| a.signature[0] ^= 0x80)),
        (
            "truncated signature",
            tweak(&|a| {
                a.signature.pop();
            }),
        ),
        ("overlong signature", tweak(&|a| a.signature.push(0))),
        ("empty signature", tweak(&|a| a.signature.clear())),
        (
            "different recipient wallet",
            tweak(&|a| a.destination_owner = alice),
        ),
        ("larger max_amount", tweak(&|a| a.max_amount += 1)),
        ("smaller max_amount", tweak(&|a| a.max_amount -= 1)),
        (
            "different next key",
            tweak(&|a| {
                a.next_key_id = k2.key_id;
                a.next_key = k2.vault_key();
            }),
        ),
        (
            "same message, another key's signature",
            tweak(&|a| a.signature = k2.sign(&message())),
        ),
        (
            "signed with the v3 tag",
            signed_over(&|m| m[..8].copy_from_slice(b"PHX-PQV3")),
        ),
        ("signed as another operation", signed_over(&|m| m[8] = 2)),
        (
            "signed for another program",
            signed_over(&|m| m[9..41].copy_from_slice(other.as_ref())),
        ),
        (
            "signed for the twin vault on another mint",
            signed_over(&|m| m[41..73].copy_from_slice(twin.as_ref())),
        ),
        (
            "signed for another mint",
            signed_over(&|m| m[73..105].copy_from_slice(other.as_ref())),
        ),
        ("signed for sequence 1", signed_over(&|m| m[105] = 1)),
        (
            "signed for another recipient",
            signed_over(&|m| m[113..145].copy_from_slice(alice.as_ref())),
        ),
        ("signed for another amount", signed_over(&|m| m[145] ^= 1)),
        (
            "signed for another next key",
            signed_over(&|m| m[153..185].copy_from_slice(&k2.key_id)),
        ),
    ];
    for (what, args) in &cases {
        e.withdraw(&v, 0, args)
            .expect_error(VaultError::InvalidSignature, what);
        let s = e.state(&v);
        assert_eq!(
            (s.sequence, s.key_id, s.reserved, e.held(&v)),
            (0, k0.key_id, 0, DEPOSIT),
            "{what}"
        );
    }

    // The genuine signature still executes after all of that.
    e.withdraw(&v, 0, &good).expect_ok("genuine withdrawal");
    assert_eq!((e.state(&v).sequence, e.state(&v).reserved), (1, 300_000));
}

#[test]
fn the_next_key_must_match_its_id_and_differ_from_the_current_key() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let (k0, k1, k2) = (e.key(0), e.key(1), e.key(2));
    let (mint, bob) = (e.mint, e.bob.pubkey());
    // The relayer swaps in another public key: its id no longer matches the signed one.
    let signed = sign_withdraw(&k0, &k1, &v, &mint, 0, &bob, 1);
    let mut swapped = signed.clone();
    swapped.next_key = k2.vault_key();
    e.withdraw(&v, 0, &swapped)
        .expect_error(VaultError::KeyIdMismatch, "next key swapped");
    let mut wrong_id = signed.clone();
    wrong_id.next_key_id = k2.key_id;
    e.withdraw(&v, 0, &wrong_id)
        .expect_error(VaultError::KeyIdMismatch, "next key id swapped");
    // A key cannot hand the vault to itself, even with a valid signature.
    let to_itself = sign_withdraw(&k0, &k0, &v, &mint, 0, &bob, 1);
    e.withdraw(&v, 0, &to_itself)
        .expect_error(VaultError::InvalidNextKey, "next key == current key");
    let s = e.state(&v);
    assert_eq!((s.sequence, s.key_id, s.reserved), (0, k0.key_id, 0));
    e.withdraw(&v, 0, &signed).expect_ok("the signed next key");
    assert_eq!(e.state(&v).key_id, k1.key_id);
}

/// Audit round 2: `InvalidNextKey` only compared the next key with the
/// current one, so a valid withdrawal could hand the vault back to a key it
/// had already spent (the genesis key, the previous key). That key's next
/// withdrawal would be a second signature by a one-time key whose first is
/// public, which is what a forgery needs, contrary to guarantee V2. Every key
/// is now bound to its position by its LM-OTS index: `withdraw` installs only
/// `q = sequence + 1` (`InvalidKeyIndex`), so no key ever comes back.
#[test]
fn a_spent_key_can_never_be_installed_again() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.pubkey();
    e.pay(&v, &bob, 100);
    e.pay(&v, &bob, 100);
    let (k0, k1, k2, k3) = (e.key(0), e.key(1), e.key(2), e.key(3));
    assert_eq!(e.state(&v).key_id, k2.key_id);

    // k2 signs, validly, withdrawals that install a key of another position.
    let mint = e.mint;
    for (what, next) in [
        ("the spent genesis key k0", k0),
        ("the spent key k1", k1),
        ("the key of position 4", e.key(4)),
        ("another vault account's genesis key", e.account_key(1, 0)),
        ("index u32::MAX", e.key(u32::MAX)),
    ] {
        let args = sign_withdraw(&k2, &next, &v, &mint, 2, &bob, 100);
        let msg = withdraw_message(&v, &mint, 2, &bob, 100, &next.key_id);
        assert!(
            noised_lmots::verify::<noised_lmots::Sha2>(&k2.pk, &msg, &args.signature),
            "{what}"
        );
        e.withdraw(&v, 2, &args)
            .expect_error(VaultError::InvalidKeyIndex, what);
        let s = e.state(&v);
        assert_eq!(
            (s.sequence, s.key_id, s.key_q, s.reserved),
            (2, k2.key_id, 2, 200),
            "{what}"
        );
        assert!(
            e.h.account(&payout_pda(&v, 2)).is_none(),
            "{what}: no payout"
        );
    }
    // The index is checked after the signature: a signature that does not
    // verify fails `InvalidSignature` whatever key it names.
    let mut forged = sign_withdraw(&k2, &e.key(0), &v, &mint, 2, &bob, 100);
    forged.signature[1000] ^= 1;
    e.withdraw(&v, 2, &forged)
        .expect_error(VaultError::InvalidSignature, "a forged signature naming k0");
    // The key of the next position is installed, and the chain goes on.
    assert_eq!(e.pay(&v, &bob, 100), 2);
    let s = e.state(&v);
    assert_eq!(
        (s.sequence, s.key_id, s.key_q, s.reserved),
        (3, k3.key_id, 3, 300)
    );
}

/// Round 2: a vault opens only with the first key of its chain, LM-OTS index
/// `q = 0` (`InvalidKeyIndex`), so every later key's index is its position.
/// The key id must still commit to the key (`KeyIdMismatch`, an account
/// constraint checked first).
#[test]
fn open_vault_takes_only_a_key_of_index_zero() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let payer = e.h.payer.pubkey();
    for (what, key) in [
        ("q = 1", e.key(1)),
        ("q = 7", e.account_key(3, 7)),
        ("q = u32::MAX", e.key(u32::MAX)),
    ] {
        let ix = open_vault_ix(
            &payer,
            &e.mint,
            &TOKEN_PROGRAM_ID,
            key.key_id,
            key.vault_key(),
        );
        e.h.send(&[ix], &[])
            .expect_error(VaultError::InvalidKeyIndex, what);
        assert!(e.h.account(&key.vault(&e.mint)).is_none(), "{what}");
    }
    let (k0, k1) = (e.key(0), e.key(1));
    let ix = open_vault_ix(
        &payer,
        &e.mint,
        &TOKEN_PROGRAM_ID,
        k0.key_id,
        k1.vault_key(),
    );
    e.h.send(&[ix], &[]).expect_error(
        VaultError::KeyIdMismatch,
        "q = 1 under the genesis key's id",
    );
    assert_eq!(k0.pk.q, 0);
    let sent =
        e.h.send(
            &[open_vault_ix(
                &payer,
                &e.mint,
                &TOKEN_PROGRAM_ID,
                k0.key_id,
                k0.vault_key(),
            )],
            &[],
        )
        .expect_ok("q = 0");
    assert_eq!(opened(&sent).key_id, k0.key_id);
    let s = e.state(&k0.vault(&e.mint));
    assert_eq!((s.sequence, s.key_q, s.key_id), (0, 0, k0.key_id));
}

/// Round 2: key indices are `u32`, so a vault supports `u32::MAX`
/// withdrawals. The vault is moved to sequence `u32::MAX - 1` by writing its
/// account; the withdrawal there installs the key of index `u32::MAX`, after
/// which no next index exists: every withdrawal is refused (the wrap to the
/// genesis index and another key of index `u32::MAX` included), and the
/// last payout is still delivered.
#[test]
fn a_vault_supports_u32_max_withdrawals() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let near_end = e.key(u32::MAX - 1);
    let mut state = e.state(&v);
    state.sequence = u64::from(u32::MAX - 1);
    state.key_id = near_end.key_id;
    let key = near_end.vault_key();
    (state.key_ident, state.key_q, state.key_k) = (key.id, key.q, key.k);
    let mut account = e.h.account(&v).expect("vault");
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&state, &mut data).expect("serialize Vault");
    assert_eq!(data.len(), account.data.len());
    account.data = data;
    e.h.set_account(v, account);

    let bob = e.bob.pubkey();
    let last = e.pay(&v, &bob, 100);
    assert_eq!(last, u64::from(u32::MAX - 1));
    let top = e.key(u32::MAX);
    let s = e.state(&v);
    assert_eq!(
        (s.sequence, s.key_id, s.key_q, s.reserved),
        (u64::from(u32::MAX), top.key_id, u32::MAX, 100)
    );

    let (mint, seq) = (e.mint, u64::from(u32::MAX));
    for (what, next) in [
        ("wrapping to the genesis index", e.key(0)),
        ("index u32::MAX - 1", e.key(u32::MAX - 1)),
        ("another vault account's index 0", e.account_key(1, 0)),
        (
            "another key of index u32::MAX: no index follows it",
            e.account_key(1, u32::MAX),
        ),
    ] {
        let args = sign_withdraw(&top, &next, &v, &mint, seq, &bob, 1);
        e.withdraw(&v, seq, &args)
            .expect_error(VaultError::InvalidKeyIndex, what);
        let s = e.state(&v);
        assert_eq!(
            (s.sequence, s.key_id, s.reserved),
            (seq, top.key_id, 100),
            "{what}"
        );
    }
    let to_itself = sign_withdraw(&top, &top, &v, &mint, seq, &bob, 1);
    e.withdraw(&v, seq, &to_itself)
        .expect_error(VaultError::InvalidNextKey, "the current key");
    e.release(&v, last).expect_ok("release the last payout");
    assert_eq!((e.received(&bob), e.held(&v)), (100, DEPOSIT - 100));
    let s = e.state(&v);
    assert_eq!((s.sequence, s.key_q, s.reserved), (seq, u32::MAX, 0));
}

#[test]
fn signature_for_one_vault_does_not_open_another() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let (k0, k1) = (e.key(0), e.key(1));
    let va = e.open();
    e.deposit(&va, DEPOSIT);

    // open_vault is permissionless: anyone can open a twin vault for the same
    // genesis key on another mint. A signature for vault A must not drain it.
    let mint_b = e.h.create_mint(TOKEN_PROGRAM_ID, DECIMALS, None);
    let payer = e.h.payer.pubkey();
    let ix = open_vault_ix(
        &payer,
        &mint_b,
        &TOKEN_PROGRAM_ID,
        k0.key_id,
        k0.vault_key(),
    );
    e.h.send(&[ix], &[]).expect_ok("open twin vault");
    let vb = vault_pda(&mint_b, &k0.key_id);
    let vb_ata = ata(&vb, &mint_b, &TOKEN_PROGRAM_ID);
    e.h.mint_to(&mint_b, &vb_ata, DEPOSIT);
    let bob = e.bob.pubkey();

    let args = sign_withdraw(&k0, &k1, &va, &e.mint, 0, &bob, DEPOSIT);
    let ix = vault::withdraw_ix(&payer, &mint_b, &TOKEN_PROGRAM_ID, &vb, 0, &args);
    e.h.send_v1(&[ix], &[]).expect_error(
        VaultError::InvalidSignature,
        "vault A's signature on vault B",
    );
    assert_eq!(
        (e.h.balance(&vb_ata), e.h.vault_state(&vb).sequence),
        (DEPOSIT, 0)
    );

    e.withdraw(&va, 0, &args)
        .expect_ok("the signature on its own vault");
    e.release(&va, 0).expect_ok("release");
    assert_eq!(e.received(&bob), DEPOSIT);
}

/// One recovery phrase holds several vaults per (cluster, mint), numbered by
/// `account` (SPEC §3.10): each has its own address and key chain, and a
/// key of one account never signs for another, even at the same sequence.
#[test]
fn each_vault_account_has_its_own_key_chain() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v0 = e.open();
    let v1 = e.open_with(&e.account_key(1, 0));
    assert_ne!(v0, v1);
    assert_eq!(v1, vault_pda(&e.mint, &e.account_key(1, 0).key_id));
    e.deposit(&v0, DEPOSIT);
    e.deposit(&v1, 2 * DEPOSIT);
    let (mint, bob) = (e.mint, e.bob.pubkey());

    // Account 0's keys, validly signed over vault 1's message, are refused.
    let wrong = sign_withdraw(&e.key(0), &e.key(1), &v1, &mint, 0, &bob, 100);
    e.withdraw(&v1, 0, &wrong)
        .expect_error(VaultError::InvalidSignature, "account 0's key on vault 1");
    // Each vault moves along its own chain.
    let (s1, args) = e.sign_as(1, &v1, &bob, 300);
    e.withdraw(&v1, s1, &args).expect_ok("vault 1, sequence 0");
    let s0 = e.pay(&v0, &bob, 100);
    assert_eq!((s0, s1), (0, 0));
    let (st0, st1) = (e.state(&v0), e.state(&v1));
    assert_eq!(
        (st0.sequence, st0.key_id, st0.key_q),
        (1, e.key(1).key_id, 1)
    );
    assert_eq!(
        (st1.sequence, st1.key_id, st1.key_q),
        (1, e.account_key(1, 1).key_id, 1)
    );
    e.release(&v1, s1).expect_ok("release from vault 1");
    e.release(&v0, s0).expect_ok("release from vault 0");
    assert_eq!(
        (e.received(&bob), e.held(&v0), e.held(&v1)),
        (400, DEPOSIT - 100, 2 * DEPOSIT - 300)
    );
}

#[test]
fn a_genesis_key_opens_one_vault_per_mint_once() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let k0 = e.key(0);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let payer = e.h.payer.pubkey();
    let reopen = |e: &mut Env, what: &str| {
        let ix = open_vault_ix(
            &payer,
            &e.mint,
            &TOKEN_PROGRAM_ID,
            k0.key_id,
            k0.vault_key(),
        );
        let f = e.h.send(&[ix], &[]).expect_custom(0u32, what); // SystemError::AccountAlreadyInUse
        assert!(f.logs_contain("already in use"), "{what}: {:?}", f.logs);
    };
    reopen(&mut e, "reopen the genesis key");
    let bob = e.bob.pubkey();
    e.pay(&v, &bob, 1);
    reopen(&mut e, "reopen after the key rotated away");
    let s = e.state(&v);
    assert_eq!(
        (s.sequence, s.genesis_key_id, s.key_id, s.reserved),
        (1, k0.key_id, e.key(1).key_id, 1)
    );
    assert_eq!(e.held(&v), DEPOSIT);
}

#[test]
fn open_rejects_a_key_id_that_does_not_commit_to_the_key() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let (k0, k1) = (e.key(0), e.key(1));
    let payer = e.h.payer.pubkey();
    let ix = open_vault_ix(
        &payer,
        &e.mint,
        &TOKEN_PROGRAM_ID,
        k1.key_id,
        k0.vault_key(),
    );
    e.h.send(&[ix], &[])
        .expect_error(VaultError::KeyIdMismatch, "key id of another key");
    assert!(e.h.account(&k1.vault(&e.mint)).is_none());
    assert!(e.h.account(&k0.vault(&e.mint)).is_none());
}

/// Liveness: the vault, its token account and every payout address are
/// known in advance, and anyone can create the ATA or send lamports to the
/// PDAs first. None of that blocks opening, withdrawing or releasing.
#[test]
fn addresses_known_in_advance_cannot_be_squatted() {
    for token_program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        let mut e = Env::new(token_program);
        let v = e.key(0).vault(&e.mint);
        let griefer = e.h.funded_keypair(1);
        let g = griefer.pubkey();
        let create_ata =
            create_associated_token_account_idempotent(&g, &v, &e.mint, &token_program);
        let fund = |to: Pubkey| solana_system_interface::instruction::transfer(&g, &to, 1_000_000);
        let ixs = [
            create_ata,
            fund(v),
            fund(payout_pda(&v, 0)),
            fund(payout_pda(&v, 1)),
        ];
        e.h.send(&ixs, &[&griefer]).expect_ok("front-run");
        assert_eq!(e.h.token_account(&e.vault_ata(&v)).owner, v);

        assert_eq!(e.open(), v);
        e.deposit(&v, DEPOSIT);
        let bob = e.bob.pubkey();
        let s0 = e.pay(&v, &bob, 10);
        let s1 = e.pay(&v, &bob, 20);
        e.release(&v, s0).expect_ok("release 0");
        e.release(&v, s1).expect_ok("release 1");
        assert_eq!((e.received(&bob), e.held(&v)), (30, DEPOSIT - 30));
    }
}

/// Liveness on the recipient's side (review): anyone can send lamports to
/// the recipient's canonical ATA address before `release`, leaving a
/// system account with no data there. Only the ATA program can allocate
/// that address, and it still creates the token account on top of the
/// lamports, so the release goes through; its payer adds only the rent that
/// is missing (none when the griefer sent more than the minimum).
#[test]
fn a_prefunded_recipient_ata_address_does_not_block_release() {
    for token_program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        // Less than, then more than, the rent-exempt minimum of an ATA.
        for griefed in [1_000_000, 10_000_000] {
            let what = format!("{token_program}, {griefed} lamports");
            let mut e = Env::new(token_program);
            let v = e.open();
            e.deposit(&v, DEPOSIT);
            let carol = Pubkey::new_unique();
            let seq = e.pay(&v, &carol, 1_000);
            let carol_ata = ata(&carol, &e.mint, &token_program);
            e.h.airdrop(&carol_ata, griefed);
            let squatted =
                e.h.account(&carol_ata)
                    .expect("lamports at the ATA address");
            assert_eq!(
                (squatted.owner, squatted.data.len()),
                (SYSTEM_PROGRAM_ID, 0),
                "{what}"
            );

            let cranker = e.h.funded_keypair(1);
            let before = e.h.lamports(&cranker.pubkey());
            let ix = release_ix(&cranker.pubkey(), &e.payout(&v, seq), &carol_ata, &[]);
            e.h.send(&[ix], &[&cranker]).expect_ok(&what);
            let created = e.h.account(&carol_ata).expect("token account");
            assert_eq!(created.owner, token_program, "{what}");
            assert_eq!(e.h.token_account(&carol_ata).owner, carol, "{what}");
            assert_eq!(
                (e.received(&carol), e.held(&v), e.state(&v).reserved),
                (1_000, DEPOSIT - 1_000, 0),
                "{what}"
            );
            let rent = e.h.rent_exempt(created.data.len());
            assert_eq!(created.lamports, rent.max(griefed), "{what}");
            assert_eq!(
                e.h.lamports(&cranker.pubkey()),
                before - rent.saturating_sub(griefed),
                "{what}"
            );
        }
    }
}

/// The payout's rent goes back to whoever paid it at withdrawal time, not
/// to whoever releases.
#[test]
fn payout_rent_returns_to_the_rent_payer() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let relayer = e.h.funded_keypair(1);
    let rent = e.h.rent_exempt(8 + Payout::INIT_SPACE);
    let withdraw_by_relayer = |e: &mut Env, max: u64| -> u64 {
        let (seq, args) = e.sign(&v, &bob.pubkey(), max);
        let ix = vault::withdraw_ix(&relayer.pubkey(), &e.mint, &e.token_program, &v, seq, &args);
        e.h.send_v1(&[ix], &[&relayer])
            .expect_ok("withdraw paid by the relayer");
        seq
    };
    let before = e.h.lamports(&relayer.pubkey());
    let s0 = withdraw_by_relayer(&mut e, 100);
    let s1 = withdraw_by_relayer(&mut e, 200);
    assert_eq!(
        e.h.lamports(&relayer.pubkey()),
        before - 2 * rent,
        "the harness payer pays the fees"
    );

    let cranker = e.h.funded_keypair(1);
    let p = e.payout(&v, s0);
    let ix = release_ix(&cranker.pubkey(), &p, &p.canonical_destination(), &[]);
    e.h.send(&[ix], &[&cranker]).expect_ok("a cranker releases");
    assert_eq!(e.h.lamports(&relayer.pubkey()), before - rent);
    let bob_account = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.release_to(&v, s1, &bob, &bob_account)
        .expect_ok("bob releases");
    assert_eq!(e.h.lamports(&relayer.pubkey()), before);
}

/// The rent payer is the relayer's own throwaway key, which may be gone by
/// the time anyone releases (review). A relayer that emptied its account
/// gets the payout's rent back as a new system account, rent-exempt on its
/// own; one that handed its account to another program is credited all the
/// same (crediting lamports needs no owner's consent). Either way the
/// release goes through.
#[test]
fn the_rent_refund_reaches_a_rent_payer_that_emptied_its_account() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.pubkey();
    let rent = e.h.rent_exempt(8 + Payout::INIT_SPACE);
    let withdraw_by = |e: &mut Env, relayer: &Keypair, amount: u64| -> u64 {
        let (seq, args) = e.sign(&v, &bob, amount);
        let ix = vault::withdraw_ix(&relayer.pubkey(), &e.mint, &e.token_program, &v, seq, &args);
        e.h.send_v1(&[ix], &[relayer])
            .expect_ok("withdraw paid by the relayer");
        seq
    };

    let emptied = e.h.funded_keypair(1);
    let s0 = withdraw_by(&mut e, &emptied, 100);
    let all = e.h.lamports(&emptied.pubkey());
    let drain = solana_system_interface::instruction::transfer(
        &emptied.pubkey(),
        &Pubkey::new_unique(),
        all,
    );
    e.h.send(&[drain], &[&emptied])
        .expect_ok("the relayer empties its account");
    assert!(e.h.account(&emptied.pubkey()).is_none());
    e.release(&v, s0)
        .expect_ok("release refunds an account that no longer exists");
    let refunded =
        e.h.account(&emptied.pubkey())
            .expect("re-created by the refund");
    assert_eq!(
        (refunded.lamports, refunded.owner, refunded.data.len()),
        (rent, SYSTEM_PROGRAM_ID, 0)
    );
    assert!(rent >= e.h.rent_exempt(0), "rent-exempt on its own");

    let reassigned = e.h.funded_keypair(1);
    let s1 = withdraw_by(&mut e, &reassigned, 200);
    let program = Pubkey::new_unique();
    let assign = solana_system_interface::instruction::assign(&reassigned.pubkey(), &program);
    e.h.send(&[assign], &[&reassigned])
        .expect_ok("the relayer hands its account to another program");
    let before = e.h.lamports(&reassigned.pubkey());
    e.release(&v, s1)
        .expect_ok("release refunds an account another program owns");
    let refunded = e.h.account(&reassigned.pubkey()).expect("still there");
    assert_eq!(
        (refunded.lamports, refunded.owner),
        (before + rent, program)
    );

    assert_eq!(
        (e.received(&bob), e.held(&v), e.state(&v).reserved),
        (300, DEPOSIT - 300, 0)
    );
    for seq in [s0, s1] {
        assert!(e.h.account(&payout_pda(&v, seq)).is_none());
    }
}

/// The vault address and its token account (the deposit address) never
/// change: deposits made after any number of rotations belong to the
/// current key, and keys spent earlier cannot touch them.
#[test]
fn deposits_after_rotations_land_in_the_same_account() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    let deposit_address = e.vault_ata(&v);
    let bob = e.bob.pubkey();
    for _ in 0..3 {
        e.pay(&v, &bob, 0);
    }
    let s = e.state(&v);
    assert_eq!((s.sequence, s.key_id, s.key_q), (3, e.key(3).key_id, 3));
    assert_eq!(
        v,
        vault_pda(&e.mint, &e.key(0).key_id),
        "still the genesis key's address"
    );
    e.deposit(&v, DEPOSIT);
    assert_eq!(e.h.balance(&deposit_address), DEPOSIT);

    let old = sign_withdraw(&e.key(1), &e.key(4), &v, &e.mint, 3, &bob, DEPOSIT);
    e.withdraw(&v, 3, &old)
        .expect_error(VaultError::InvalidSignature, "a key spent earlier");
    let seq = e.pay(&v, &bob, u64::MAX);
    e.release(&v, seq).expect_ok("release");
    assert_eq!((e.received(&bob), e.held(&v)), (DEPOSIT, 0));
}

/// `open_vault` refuses mints whose tokens could never leave, or that leave
/// an Ed25519 path to the vault's tokens (V4 has its own test).
#[test]
fn open_refuses_mints_an_ed25519_key_could_take_or_that_never_transfer() {
    let authority = Pubkey::new_unique();
    let fee = |config_authority, withdraw_authority| MintExt::TransferFee {
        config_authority,
        withdraw_authority,
        basis_points: 100,
        maximum_fee: u64::MAX,
    };
    let refused = [
        ("non-transferable", MintExt::NonTransferable),
        ("permanent delegate", MintExt::PermanentDelegate(authority)),
        (
            "transfer fee with a config authority",
            fee(Some(authority), None),
        ),
        (
            "transfer fee with a withdraw authority",
            fee(None, Some(authority)),
        ),
        (
            "close authority",
            MintExt::MintCloseAuthority(Some(authority)),
        ),
    ];
    for (what, ext) in refused {
        let mut h = Harness::new();
        let mint = h.create_mint_with(TOKEN_2022_PROGRAM_ID, DECIMALS, &[ext]);
        let key = PqKey::derive(&master_seed(what), &mint, 0, 0);
        let ix = open_vault_ix(
            &h.payer.pubkey(),
            &mint,
            &TOKEN_2022_PROGRAM_ID,
            key.key_id,
            key.vault_key(),
        );
        h.send(&[ix], &[])
            .expect_error(VaultError::UnsupportedMint, what);
        assert!(h.account(&key.vault(&mint)).is_none(), "{what}");
    }
}

/// Mints whose extensions give no key power over the vault's tokens are
/// accepted, and a full withdraw + release works on them.
#[test]
fn open_accepts_mints_without_such_an_authority() {
    let accepted: [(&str, Vec<MintExt>); 4] = [
        (
            "close authority None",
            vec![MintExt::MintCloseAuthority(None)],
        ),
        ("fixed transfer fee", vec![fixed_fee()]),
        (
            "close authority None and a fixed fee",
            vec![MintExt::MintCloseAuthority(None), fixed_fee()],
        ),
        (
            "confidential transfers",
            vec![MintExt::ConfidentialTransfer { authority: None }],
        ),
    ];
    for (what, extensions) in accepted {
        let mut h = Harness::new();
        let mint = h.create_mint_with(TOKEN_2022_PROGRAM_ID, DECIMALS, &extensions);
        let mut e = Env::with_mint(h, mint);
        let v = e.open();
        e.deposit(&v, DEPOSIT);
        let held = e.held(&v);
        let bob = e.bob.pubkey();
        let seq = e.pay(&v, &bob, 10_000);
        e.release(&v, seq).expect_ok(what);
        assert_eq!(e.held(&v), held - 10_000, "{what}");
        assert!(e.received(&bob) > 0, "{what}");
    }
}

/// Audit finding V1 (SPL Token): after the withdrawal was signed, the
/// recipient reassigns the owner field of its own ATA. In v3, Anchor's ATA
/// owner check then refused every relay of the revealed one-time signature
/// and froze the whole vault. In v4 `withdraw` touches no recipient account,
/// and `release` pays the canonical ATA address without comparing its owner
/// field: only the wallet can reassign it, so that is where it chose its
/// funds to go. The rest of the vault is untouched and the next key spends it.
#[test]
fn v1a_a_reassigned_spl_ata_owner_cannot_block_a_signed_withdrawal() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    let (seq, args) = e.sign(&v, &bob.pubkey(), 250);
    let mallory = Pubkey::new_unique();
    e.h.reassign_owner(&bob_ata, &bob, &mallory);
    assert_eq!(e.h.token_account(&bob_ata).owner, mallory);

    e.withdraw(&v, seq, &args)
        .expect_ok("the signed withdrawal executes");
    let s = e.state(&v);
    assert_eq!(
        (e.held(&v), s.reserved, s.sequence, s.key_id),
        (DEPOSIT, 250, 1, e.key(1).key_id)
    );
    e.release(&v, seq)
        .expect_ok("anyone delivers to the canonical address");
    assert_eq!(e.h.balance(&bob_ata), 250);
    assert_eq!(
        (e.held(&v), e.state(&v).reserved),
        (DEPOSIT - 250, 0),
        "only the payout left"
    );

    let carol = Pubkey::new_unique();
    let seq = e.pay(&v, &carol, u64::MAX);
    e.release(&v, seq).expect_ok("the next key spends the rest");
    assert_eq!((e.received(&carol), e.held(&v)), (DEPOSIT - 250, 0));
}

/// Audit finding V1, one step further (review): the recipient hands its
/// SPL Token ATA to mallory, who empties and closes it before the release.
/// The canonical address is free again, so `release` re-creates the ATA for
/// the wallet the payout names and pays it. Token-2022 ATAs cannot be
/// reassigned (ImmutableOwner); the recipient closing its own is the same case.
#[test]
fn a_reassigned_then_closed_ata_is_recreated_for_the_wallet() {
    for token_program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        let mut e = Env::new(token_program);
        let v = e.open();
        e.deposit(&v, DEPOSIT);
        let bob = e.bob.insecure_clone();
        let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
        let (seq, args) = e.sign(&v, &bob.pubkey(), 250);
        let closer = if token_program == TOKEN_PROGRAM_ID {
            let mallory = e.h.funded_keypair(1);
            e.h.reassign_owner(&bob_ata, &bob, &mallory.pubkey());
            mallory
        } else {
            bob.insecure_clone()
        };
        e.withdraw(&v, seq, &args).expect_ok("withdraw");
        let close = token_ix::close_account(
            &token_program,
            &bob_ata,
            &closer.pubkey(),
            &closer.pubkey(),
            &[],
        )
        .expect("close_account");
        e.h.send(&[close], &[&closer])
            .expect_ok("the ATA's owner closes it");
        assert!(e.h.account(&bob_ata).is_none());

        e.release(&v, seq)
            .expect_ok("release re-creates the canonical ATA");
        assert_eq!(
            e.h.token_account(&bob_ata).owner,
            bob.pubkey(),
            "{token_program}"
        );
        assert_eq!(e.h.balance(&bob_ata), 250);
        assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 250, 0));
    }
}

/// Audit finding V1 (Token-2022): after the withdrawal was signed, the
/// recipient enables RequiredMemoTransfers on its ATA. The v3 vault's
/// transfer carried no memo, so Token-2022 refused every relay of the
/// revealed signature. In v4 the withdrawal does not touch that account,
/// and both `release` (permissionless) and `release_to` call SPL Memo right
/// before the transfer, as Token-2022 requires of a CPI.
#[test]
fn v1b_a_memo_required_recipient_is_paid_with_a_memo() {
    let mut e = Env::new(TOKEN_2022_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    let (seq, args) = e.sign(&v, &bob.pubkey(), 250);
    e.h.require_memos(&bob_ata, &bob);
    e.h.transfer(&e.mint, &e.alice_ata, &bob_ata, &e.alice, 1)
        .expect_custom(TokenError::NoMemo as u32, "a plain transfer into bob's ATA");

    e.withdraw(&v, seq, &args).expect_ok("withdraw");
    let sent = e
        .release(&v, seq)
        .expect_ok("permissionless release with a memo");
    assert_eq!(e.h.balance(&bob_ata), 250);
    // vault -> Memo, then vault -> Token-2022: siblings at depth 2.
    let position = |program: Pubkey| {
        let line = format!("Program {program} invoke [2]");
        sent.logs
            .iter()
            .position(|l| *l == line)
            .unwrap_or_else(|| panic!("no CPI to {program}"))
    };
    assert!(
        position(MEMO_PROGRAM_ID) < position(TOKEN_2022_PROGRAM_ID),
        "{:#?}",
        sent.logs
    );
    assert!(
        sent.logs.iter().any(|l| l.contains("noised-vault payout")),
        "{:#?}",
        sent.logs
    );

    let bob_other = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.h.require_memos(&bob_other, &bob);
    let seq = e.pay(&v, &bob.pubkey(), 750);
    e.release_to(&v, seq, &bob, &bob_other)
        .expect_ok("release_to with a memo");
    assert_eq!(e.h.balance(&bob_other), 750);
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 1_000, 0));
}

/// V1b on a Launch Guard mint (review), the main Token-2022 case for the
/// vault: a launch token whose recipient requires memos. The vault CPIs SPL
/// Memo, then `transfer_checked`, which itself CPIs the hook, so the memo
/// stays the transfer's previous sibling: Memo [2], Token-2022 [2], hook
/// [3]. Both `release` and `release_to`, during the guard (p2p lock off).
/// While the guard is on, `release_to` pays only an account whose owner
/// can never change (audit 3: ImmutableOwner, as every ATA has); into any
/// other the hook refuses it (`MutableOwner`) and the payout stays reserved.
#[test]
fn v1b_a_memo_required_recipient_on_a_launch_guard_mint_is_paid_with_a_memo() {
    let (mut e, launch_ts) = hooked_env(false);
    let v = e.open();
    e.fund(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    let bob_other =
        e.h.create_immutable_owner_token_account(&bob.pubkey(), &e.mint);
    let bob_plain = e.h.create_token_account(&bob.pubkey(), &e.mint);
    for account in [bob_ata, bob_other, bob_plain] {
        e.h.require_memos(&account, &bob);
    }
    e.h.set_time(launch_ts + SHIELD_SECS);
    let s0 = e.pay(&v, &bob.pubkey(), 250);
    let s1 = e.pay(&v, &bob.pubkey(), 750);

    let sent = e
        .release(&v, s0)
        .expect_ok("release: memo, then the hooked transfer");
    assert_memo_then_hooked_transfer(&sent.logs);
    e.release_to(&v, s1, &bob, &bob_plain).expect_error(
        HookError::MutableOwner,
        "release_to an account whose owner can change",
    );
    assert_eq!(e.state(&v).reserved, 750);
    let sent = e
        .release_to(&v, s1, &bob, &bob_other)
        .expect_ok("release_to: memo, then the hooked transfer");
    assert_memo_then_hooked_transfer(&sent.logs);
    assert_eq!((e.h.balance(&bob_ata), e.h.balance(&bob_other)), (250, 750));
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 1_000, 0));
    assert!(e.h.now() < launch_ts + GUARD_SECS, "paid during the guard");
}

/// The invocations after the vault's: the payout memo, then the transfer
/// and the transfer's hook, and nothing else.
fn assert_memo_then_hooked_transfer(logs: &[String]) {
    let vault = format!("Program {VAULT_ID} invoke [1]");
    let start = logs
        .iter()
        .position(|l| *l == vault)
        .expect("the vault runs");
    let invocations: Vec<&str> = logs[start + 1..]
        .iter()
        .filter(|l| l.contains(" invoke ["))
        .map(String::as_str)
        .collect();
    let expected = [
        format!("Program {MEMO_PROGRAM_ID} invoke [2]"),
        format!("Program {TOKEN_2022_PROGRAM_ID} invoke [2]"),
        format!("Program {HOOK_ID} invoke [3]"),
    ];
    assert_eq!(invocations, expected, "{logs:#?}");
    assert!(
        logs.iter().any(|l| l.contains("noised-vault payout")),
        "{logs:#?}"
    );
}

/// Audit finding V1 (confidential transfers): after the withdrawal was
/// signed, the recipient configures its ATA for confidential balances and
/// turns off non-confidential credits, so it refuses every public transfer.
/// Only that recipient's own payout waits: the withdrawal executes,
/// `release` fails while the recipient keeps the setting, `release_to`
/// (signed by the recipient) delivers into another of its accounts, and
/// meanwhile the vault keeps paying everyone else.
#[test]
fn v1c_a_recipient_account_that_refuses_credits_delays_only_its_own_payout() {
    let mut h = Harness::new();
    let mint = h.create_mint_with(
        TOKEN_2022_PROGRAM_ID,
        DECIMALS,
        &[MintExt::ConfidentialTransfer { authority: None }],
    );
    let mut e = Env::with_mint(h, mint);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    let (seq, args) = e.sign(&v, &bob.pubkey(), 250);
    e.h.refuse_public_credits(&bob_ata, &bob);

    e.withdraw(&v, seq, &args)
        .expect_ok("the signed withdrawal executes");
    e.release(&v, seq).expect_custom(
        TokenError::NonConfidentialTransfersDisabled as u32,
        "bob's ATA refuses public credits",
    );
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT, 250));

    let carol = Pubkey::new_unique();
    let s1 = e.pay(&v, &carol, 1_000);
    e.release(&v, s1).expect_ok("the vault keeps paying others");
    assert_eq!(e.received(&carol), 1_000);

    let bob_other = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.release_to(&v, seq, &bob, &bob_other)
        .expect_ok("bob takes it elsewhere");
    assert_eq!((e.h.balance(&bob_other), e.h.balance(&bob_ata)), (250, 0));
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 1_250, 0));
}

/// Audit finding V1, with a frozen recipient account (a mint with a freeze
/// authority): the same outcome. A frozen *vault* account blocks every
/// release until it is thawed, but never a withdrawal: freezing can delay
/// payouts, not take them.
#[test]
fn v1c_frozen_accounts_delay_payouts_but_never_a_withdrawal() {
    let mut h = Harness::new();
    let mint = h.create_freezable_mint(TOKEN_PROGRAM_ID, DECIMALS, &[]);
    let mut e = Env::with_mint(h, mint);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    e.h.freeze(&bob_ata);
    let seq = e.pay(&v, &bob.pubkey(), 250);
    e.release(&v, seq)
        .expect_custom(TokenError::AccountFrozen as u32, "frozen recipient ATA");
    let bob_other = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.release_to(&v, seq, &bob, &bob_other)
        .expect_ok("release_to an account that is not frozen");
    assert_eq!(e.h.balance(&bob_other), 250);

    let vault_ata = e.vault_ata(&v);
    e.h.freeze(&vault_ata);
    let carol = Pubkey::new_unique();
    let s1 = e.pay(&v, &carol, 1_000);
    e.release(&v, s1)
        .expect_custom(TokenError::AccountFrozen as u32, "frozen vault account");
    assert_eq!((e.state(&v).sequence, e.state(&v).reserved), (2, 1_000));
    e.h.thaw(&vault_ata);
    e.release(&v, s1).expect_ok("after the thaw");
    assert_eq!(
        (e.received(&carol), e.held(&v), e.state(&v).reserved),
        (1_000, DEPOSIT - 1_250, 0)
    );
}

/// Audit finding V2: a withdrawal whose recipient was the vault PDA (or, in
/// v3, its successor) could be signed but never executed (Anchor's
/// duplicate-mutable-account check), stranding the vault behind a revealed
/// one-time signature. In v4 it executes on both token programs: paying
/// the vault itself reserves nothing, and the empty payout closes. Paying
/// another vault is a deposit into it.
#[test]
fn v2_a_withdrawal_to_the_vault_itself_executes_and_reserves_nothing() {
    for token_program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        let mut e = Env::new(token_program);
        let v = e.open();
        e.deposit(&v, DEPOSIT);
        let seq = e.pay(&v, &v, DEPOSIT);
        let s = e.state(&v);
        assert_eq!((s.sequence, s.key_id, s.reserved), (1, e.key(1).key_id, 0));
        assert_eq!(e.payout_amount(&v, seq), 0);
        // Its canonical destination is the vault's own token account.
        assert_eq!(e.payout(&v, seq).canonical_destination(), e.vault_ata(&v));
        e.release(&v, seq).expect_ok("close the empty payout");
        assert!(e.h.account(&payout_pda(&v, seq)).is_none());
        assert_eq!(e.held(&v), DEPOSIT);

        let w = e.open_with(&e.account_key(1, 0));
        let seq = e.pay(&v, &w, 300);
        e.release(&v, seq).expect_ok("pay another vault");
        assert_eq!((e.held(&v), e.held(&w)), (DEPOSIT - 300, 300));
        let bob = e.bob.pubkey();
        let seq = e.pay(&v, &bob, u64::MAX);
        e.release(&v, seq).expect_ok("the rest");
        assert_eq!((e.received(&bob), e.held(&v)), (DEPOSIT - 300, 0));
    }
}

/// Audit finding V3: on a mint with a fixed transfer fee (both fee
/// authorities None, accepted by `open_vault`), v3 moved the whole
/// remainder to a successor at every withdrawal and paid the fee on it
/// each time. In v4 the balance never moves: a withdrawal of X lowers the
/// vault balance by exactly X, the fee applies to X only, and rotations
/// cost nothing.
#[test]
fn v3_a_fixed_transfer_fee_applies_only_to_the_paid_amount() {
    let fee = |x: u64| (x * 100).div_ceil(10_000);
    let mut h = Harness::new();
    let mint = h.create_mint_with(TOKEN_2022_PROGRAM_ID, DECIMALS, &[fixed_fee()]);
    let mut e = Env::with_mint(h, mint);
    let v = e.open();
    e.deposit(&v, 1_010_102);
    let start = e.held(&v);
    assert_eq!(
        start,
        1_010_102 - fee(1_010_102),
        "the deposit paid 1% on the way in"
    );
    let bob = e.bob.pubkey();
    for _ in 0..5 {
        e.pay(&v, &bob, 0);
    }
    assert_eq!(e.held(&v), start, "rotations move nothing");

    let (mut paid, mut expected) = (0, 0);
    for x in [10_000u64, 1_000, 99_999] {
        let seq = e.pay(&v, &bob, x);
        assert_eq!(e.held(&v), start - paid, "withdraw moves nothing");
        e.release(&v, seq).expect_ok("release");
        paid += x;
        expected += x - fee(x);
        assert_eq!(e.held(&v), start - paid, "the vault pays exactly X");
    }
    assert_eq!(
        e.received(&bob),
        expected,
        "the recipient pays the fee on X only"
    );
    assert_eq!(e.state(&v).reserved, 0);
}

/// Audit finding V4: `open_vault` accepted Token-2022 mints with a close
/// authority. At zero supply such a mint can be closed and re-created at
/// the same address with a PermanentDelegate, whose Ed25519 key then drains
/// any vault opened before. Now the close authority must be None, and None
/// can never be set or used later, so no vault can be opened on a mint that
/// could turn into a drainable one.
#[test]
fn v4_mints_with_a_close_authority_are_refused() {
    let mut h = Harness::new();
    let attacker = h.funded_keypair(5);
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let close_authority = MintExt::MintCloseAuthority(Some(attacker.pubkey()));
    h.create_mint_at(
        &mint_kp,
        TOKEN_2022_PROGRAM_ID,
        DECIMALS,
        &[close_authority],
        None,
    );
    let key = PqKey::derive(&master_seed("v4"), &mint, 0, 0);
    let open = open_vault_ix(
        &h.payer.pubkey(),
        &mint,
        &TOKEN_2022_PROGRAM_ID,
        key.key_id,
        key.vault_key(),
    );
    h.send(std::slice::from_ref(&open), &[])
        .expect_error(VaultError::UnsupportedMint, "a close authority is set");
    assert!(h.account(&key.vault(&mint)).is_none());

    // The attack the refusal prevents: close the empty mint, re-create it at
    // the same address with a permanent delegate.
    let close = token_ix::close_account(
        &TOKEN_2022_PROGRAM_ID,
        &mint,
        &attacker.pubkey(),
        &attacker.pubkey(),
        &[],
    )
    .expect("close_account");
    h.send(&[close], &[&attacker])
        .expect_ok("close the empty mint");
    let delegate = MintExt::PermanentDelegate(attacker.pubkey());
    h.create_mint_at(&mint_kp, TOKEN_2022_PROGRAM_ID, DECIMALS, &[delegate], None);
    h.send(&[open], &[])
        .expect_error(VaultError::UnsupportedMint, "the re-created mint");

    // With a close authority of None, nobody can set one or close the mint.
    let mut h = Harness::new();
    let mint = h.create_mint_with(
        TOKEN_2022_PROGRAM_ID,
        DECIMALS,
        &[MintExt::MintCloseAuthority(None)],
    );
    let authority = h.payer.pubkey();
    let set = token_ix::set_authority(
        &TOKEN_2022_PROGRAM_ID,
        &mint,
        Some(&attacker.pubkey()),
        AuthorityType::CloseMint,
        &authority,
        &[],
    )
    .expect("set_authority");
    h.send(&[set], &[]).expect_custom(
        TokenError::AuthorityTypeNotSupported as u32,
        "set a close authority later",
    );
    let close = token_ix::close_account(&TOKEN_2022_PROGRAM_ID, &mint, &authority, &authority, &[])
        .expect("close");
    h.send(&[close], &[]).expect_custom(
        TokenError::AuthorityTypeNotSupported as u32,
        "close the mint",
    );
    let mut e = Env::with_mint(h, mint);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let bob = e.bob.pubkey();
    let seq = e.pay(&v, &bob, 1_000);
    e.release(&v, seq)
        .expect_ok("a vault on a mint that can never be closed");
    assert_eq!(e.received(&bob), 1_000);
}

/// Audit finding V5 (a documented limitation, not fixed on-chain): SOL or
/// tokens of another mint sent to the vault PDA stay there. Every
/// instruction is bound to the vault's own mint, and none moves lamports
/// out of the vault account, so clients show ATA(vault, mint) as the
/// deposit address, never the vault PDA.
#[test]
fn v5_sol_and_other_mints_sent_to_the_vault_address_stay_there() {
    let mut e = Env::new(TOKEN_PROGRAM_ID);
    let v = e.open();
    e.deposit(&v, DEPOSIT);
    let lamports = e.h.lamports(&v);
    e.h.airdrop(&v, LAMPORTS_PER_SOL);
    let other_mint = e.h.create_mint(TOKEN_PROGRAM_ID, DECIMALS, None);
    let stray = e.h.create_ata(&v, &other_mint);
    e.h.mint_to(&other_mint, &stray, 5_000);

    let bob = e.bob.pubkey();
    let (seq, args) = e.sign(&v, &bob, u64::MAX);
    let payer = e.h.payer.pubkey();
    let ix = vault::withdraw_ix(&payer, &other_mint, &TOKEN_PROGRAM_ID, &v, seq, &args);
    e.h.send_v1(&[ix], &[]).expect_error(
        AnchorError::ConstraintSeeds,
        "a withdrawal of the other mint",
    );
    e.withdraw(&v, seq, &args)
        .expect_ok("a withdrawal of the vault's mint");
    e.release(&v, seq).expect_ok("release");
    assert_eq!((e.received(&bob), e.held(&v)), (DEPOSIT, 0));
    assert_eq!(
        (e.h.balance(&stray), e.h.lamports(&v)),
        (5_000, lamports + LAMPORTS_PER_SOL)
    );
}

/// A Launch Guard mint with the p2p lock on: `release` is a
/// wallet-to-wallet transfer, so the hook refuses it (TransfersLocked)
/// until `guard_end_ts`, atomically. `withdraw` makes no transfer and
/// executes during the guard. Without the hook accounts `release` fails
/// closed; with them it succeeds once the guard ends.
#[test]
fn hooked_mint_release_waits_for_the_launch_guard_but_withdraw_does_not() {
    let (mut e, launch_ts) = hooked_env(true);
    let v = e.open();
    e.fund(&v, DEPOSIT);
    let bob = e.bob.pubkey();
    let bob_ata = ata(&bob, &e.mint, &TOKEN_2022_PROGRAM_ID);
    let seq = e.pay(&v, &bob, 250_000);
    assert_eq!(
        e.hook_extra(&v, &bob_ata).len(),
        4,
        "policy PDA, instructions sysvar, hook program, meta list"
    );
    e.release(&v, seq)
        .expect_error(HookError::TransfersLocked, "release during the guard");
    assert_eq!(
        (e.held(&v), e.state(&v).reserved, e.received(&bob)),
        (DEPOSIT, 250_000, 0)
    );
    assert!(
        e.h.account(&payout_pda(&v, seq)).is_some(),
        "the payout waits"
    );
    let s1 = e.pay(&v, &bob, 0);

    e.h.set_time(launch_ts + GUARD_SECS - 1);
    e.release(&v, seq)
        .expect_error(HookError::TransfersLocked, "last second of the guard");
    e.h.set_time(launch_ts + GUARD_SECS);
    let without_hook_accounts = release_ix(&e.h.payer.pubkey(), &e.payout(&v, seq), &bob_ata, &[]);
    let f = e.h.send(&[without_hook_accounts], &[]).expect_custom(
        TransferHookError::IncorrectAccount as u32,
        "release without the hook accounts",
    );
    assert!(
        f.logs_contain(&format!("Program {VAULT_ID} failed")),
        "{:#?}",
        f.logs
    );
    let sent = e.release(&v, seq).expect_ok("release after the guard");
    // vault -> Token-2022 -> hook, once.
    let hook_runs = sent
        .logs
        .iter()
        .filter(|l| **l == format!("Program {HOOK_ID} invoke [3]"))
        .count();
    assert_eq!(hook_runs, 1, "{:#?}", sent.logs);
    e.release(&v, s1).expect_ok("the empty payout");
    assert_eq!(
        (e.received(&bob), e.held(&v), e.state(&v).reserved),
        (250_000, DEPOSIT - 250_000, 0)
    );
    report(
        "vault release (Token-2022 + Launch Guard, ATA created): vault program CU",
        program_cu(&sent.logs, &VAULT_ID),
    );
}

/// PXR1 bytes, written from the documented layout, of one rule over the
/// whole guard (code 7): DENY whenever the transfer is wallet to wallet
/// (`IS_P2P`, op 0x11).
fn deny_every_wallet_transfer() -> Vec<u8> {
    let mut b = b"PXR1".to_vec();
    b.extend_from_slice(&[1, 0, 1, 1, 0, 0, 0, 0]);
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&(GUARD_SECS as u32).to_le_bytes());
    b.extend_from_slice(&[0, 1, 1, 7]);
    b.extend_from_slice(&0u64.to_le_bytes());
    b.extend_from_slice(&[0x11, 0]);
    b.extend_from_slice(&0u64.to_le_bytes());
    assert_eq!(b.len(), 12 + 20 + 10);
    b
}

/// Review 4, R1: creator rules never hold a holder's post-quantum custody
/// exit. Under a rule that refuses every wallet-to-wallet transfer for the
/// whole guard (p2p lock off), the vault's `release` and `release_to` (the
/// vault is the top-level instruction) pay during the guard, through its
/// last second; the same tokens sent by a wallet are refused by the rule
/// (`RuleDenied`), and so is the vault's release when another program makes
/// it by CPI (that program is the top-level instruction). The built-in
/// checks still apply to the vault: the immutable-owner rule
/// (`MutableOwner`) and, with the lock on, the p2p lock (`TransfersLocked`).
/// The hook's vault id is the vault crate's.
#[test]
fn creator_rules_never_hold_a_vault_release() {
    assert_eq!(noised_hook::VAULT_PROGRAM_ID, VAULT_ID);
    assert_eq!(VAULT_ID, noised_vault::ID);
    let (mut e, launch_ts) = hooked_env_with(false, deny_every_wallet_transfer());
    let v = e.open();
    e.fund(&v, DEPOSIT);
    let bob = e.bob.insecure_clone();
    let bob_ata = e.h.create_ata(&bob.pubkey(), &e.mint);
    let bob_plain = e.h.create_token_account(&bob.pubkey(), &e.mint);
    e.h.set_time(launch_ts + SHIELD_SECS);
    let (mint, alice_ata) = (e.mint, e.alice_ata);
    let alice = e.alice.insecure_clone();
    e.h.transfer(&mint, &alice_ata, &bob_ata, &alice, 10)
        .expect_error(HookError::RuleDenied, "a wallet transfer");
    let s0 = e.pay(&v, &bob.pubkey(), 100);
    let s1 = e.pay(&v, &bob.pubkey(), 200);
    let s2 = e.pay(&v, &bob.pubkey(), 300);
    e.release(&v, s0).expect_ok("release during the guard");
    // Made by another program's CPI: that program is the top-level
    // instruction, and the rules apply.
    let wrapper = Pubkey::new_unique();
    e.h.add_relay(wrapper);
    let p = e.payout(&v, s1);
    let inner = release_ix(
        &e.h.payer.pubkey(),
        &p,
        &bob_ata,
        &e.hook_extra(&v, &bob_ata),
    );
    e.h.send(
        &[relay_ix(
            &wrapper,
            anchor_discriminator("global", "any"),
            &inner,
        )],
        &[],
    )
    .expect_error(
        HookError::RuleDenied,
        "the vault's release inside another program",
    );
    e.release_to(&v, s1, &bob, &bob_plain).expect_error(
        HookError::MutableOwner,
        "release_to an account whose owner can change",
    );
    e.h.set_time(launch_ts + GUARD_SECS - 1);
    e.release_to(&v, s1, &bob, &bob_ata)
        .expect_ok("release_to in the guard's last second");
    assert_eq!(e.h.balance(&bob_ata), 300);
    // With the p2p lock on, the lock refuses it: only the rules step is
    // skipped.
    let mut locked = e.h.policy(&mint).expect("policy");
    locked.p2p_locked = true;
    e.h.inject_policy(&locked);
    e.release(&v, s2)
        .expect_error(HookError::TransfersLocked, "release under the p2p lock");
    e.h.set_time(launch_ts + GUARD_SECS);
    e.release(&v, s2).expect_ok("release after the guard");
    assert_eq!(e.h.balance(&bob_ata), 600);
    assert_eq!((e.held(&v), e.state(&v).reserved), (DEPOSIT - 600, 0));
}
