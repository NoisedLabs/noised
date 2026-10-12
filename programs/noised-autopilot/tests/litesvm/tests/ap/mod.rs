//! The autopilot as a client uses it: PDAs, instruction builders, the
//! launchpad `Authorization` written by hand in the layout `pq_authorize`
//! writes (with a chosen slot), and a launch made, graduated and migrated by the launchpad
//! with the autopilot's treasury as one of its fee recipients (and the
//! autopilot bound to the migrated pool).
#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey, system_program, AnchorSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token_interface::spl_token_2022;
use noised_autopilot::{
    accounts as acc,
    constants::{AUTOPILOT_SEED, GRAPH_SEED, OBS_MIN_SPAN_SECS, TREASURY_SEED, WSOL_MINT},
    instruction as ix,
    launchpad::authorization,
    state::{Autopilot, GraphRecord},
};
use noised_launchpad::{
    constants::{DAMM_V2_EVENT_AUTHORITY, DAMM_V2_POOL_AUTHORITY, DAMM_V2_PROGRAM_ID},
    state::Launch,
};
use noised_rules::{graph::Graph, graph_hash, GraphProgram, Sha2};
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::common::{
    launch::{
        base_ata, claim_fees, create_ata, dbc_swap_mode, distribute, wrap_sol, wsol_ata, Keys,
    },
    lifecycle::{claim_surplus, migrate_to_damm_v2, Damm},
    pq,
    world::{launched_with, World},
    Env, Expect, Failed, Sent, ATA_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
};

pub const AP: Pubkey = noised_autopilot::ID;
const BPF_LOADER_UPGRADEABLE: Pubkey =
    anchor_lang::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// Anchor error number of an autopilot error.
pub fn ap_code(e: noised_autopilot::error::AutopilotError) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

/// Load our SBPF v3 build of the autopilot.
pub fn load_autopilot(env: &mut Env) {
    let path = crate::common::program_so("noised_autopilot");
    let bytes = std::fs::read(&path).expect("read autopilot");
    env.svm
        .add_program_with_loader(AP, &bytes, BPF_LOADER_UPGRADEABLE)
        .unwrap_or_else(|e| panic!("load {}: {e:?}", path.display()));
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

/// The autopilot's addresses for one launch.
#[derive(Clone, Copy, Debug)]
pub struct ApKeys {
    pub launch: Pubkey,
    pub autopilot: Pubkey,
    pub treasury: Pubkey,
    pub treasury_wsol: Pubkey,
    pub mint: Pubkey,
    pub treasury_token: Pubkey,
}

impl ApKeys {
    pub fn new(launch: &Pubkey, mint: &Pubkey) -> Self {
        let treasury = treasury_of(launch);
        ApKeys {
            launch: *launch,
            autopilot: pda(&[AUTOPILOT_SEED, launch.as_ref()], &AP),
            treasury,
            treasury_wsol: wsol_ata(&treasury),
            mint: *mint,
            treasury_token: base_ata(&treasury, mint),
        }
    }

    pub fn graph(&self, hash: &[u8; 32]) -> Pubkey {
        pda(&[GRAPH_SEED, self.launch.as_ref(), hash], &AP)
    }
}

/// `["treasury", launch]`: known before the launch exists.
pub fn treasury_of(launch: &Pubkey) -> Pubkey {
    pda(&[TREASURY_SEED, launch.as_ref()], &AP)
}

pub fn hash(bytes: &[u8]) -> [u8; 32] {
    graph_hash::<Sha2>(bytes)
}

pub fn init_autopilot(payer: &Pubkey, k: &Keys) -> Instruction {
    init_autopilot_with(payer, k.launch, k.dbc_config)
}

pub fn init_autopilot_with(payer: &Pubkey, launch: Pubkey, dbc_config: Pubkey) -> Instruction {
    let treasury = treasury_of(&launch);
    Instruction {
        program_id: AP,
        accounts: acc::InitAutopilot {
            payer: *payer,
            launch,
            dbc_config,
            autopilot: pda(&[AUTOPILOT_SEED, launch.as_ref()], &AP),
            treasury,
            wsol_mint: WSOL_MINT,
            treasury_wsol: wsol_ata(&treasury),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::InitAutopilot {}.data(),
    }
}

pub fn bind_mint(payer: &Pubkey, k: &Keys, a: &ApKeys) -> Instruction {
    bind_mint_with(payer, a, k.mint, k.certificate)
}

pub fn bind_mint_with(
    payer: &Pubkey,
    a: &ApKeys,
    mint: Pubkey,
    certificate: Pubkey,
) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::BindMint {
            payer: *payer,
            autopilot: a.autopilot,
            launch: a.launch,
            certificate,
            mint,
            treasury: a.treasury,
            treasury_token: base_ata(&a.treasury, &mint),
            token_2022_program: TOKEN_2022_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::BindMint {}.data(),
    }
}

/// `bind_pool` with the DAMM v2 config DBC migrated through and its pool.
pub fn bind_pool(a: &ApKeys, damm_config: &Pubkey, damm_pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::BindPool {
            autopilot: a.autopilot,
            damm_config: *damm_config,
            damm_pool: *damm_pool,
        }
        .to_account_metas(None),
        data: ix::BindPool {}.data(),
    }
}

pub fn publish_graph(payer: &Pubkey, a: &ApKeys, bytes: &[u8]) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::PublishGraph {
            payer: *payer,
            launch: a.launch,
            graph: a.graph(&hash(bytes)),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::PublishGraph {
            bytes: bytes.to_vec(),
        }
        .data(),
    }
}

pub fn activate(
    a: &ApKeys,
    graph: &[u8; 32],
    authorization: &Pubkey,
    activate_at: i64,
) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::Activate {
            autopilot: a.autopilot,
            launch: a.launch,
            graph: a.graph(graph),
            authorization: *authorization,
        }
        .to_account_metas(None),
        data: ix::Activate { activate_at }.data(),
    }
}

pub fn apply_pending(a: &ApKeys, graph: &[u8; 32]) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::ApplyPending {
            autopilot: a.autopilot,
            graph: a.graph(graph),
        }
        .to_account_metas(None),
        data: ix::ApplyPending {}.data(),
    }
}

/// `freeze` with the `not_after` its authorization signed (review 4, R5).
pub fn freeze(a: &ApKeys, authorization: &Pubkey, not_after: i64) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::Govern {
            autopilot: a.autopilot,
            launch: a.launch,
            authorization: *authorization,
        }
        .to_account_metas(None),
        data: ix::Freeze { not_after }.data(),
    }
}

pub fn revoke_operator(a: &ApKeys, authorization: &Pubkey) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::Govern {
            autopilot: a.autopilot,
            launch: a.launch,
            authorization: *authorization,
        }
        .to_account_metas(None),
        data: ix::RevokeOperator {}.data(),
    }
}

pub fn update_price(a: &ApKeys, pool: &Pubkey) -> Instruction {
    Instruction {
        program_id: AP,
        accounts: acc::UpdatePrice {
            autopilot: a.autopilot,
            damm_pool: *pool,
        }
        .to_account_metas(None),
        data: ix::UpdatePrice {}.data(),
    }
}

/// What a run's remaining accounts are.
#[derive(Clone, Debug)]
pub enum Extra {
    None,
    /// DAMM v2's pool authority, token A and B vaults, event authority,
    /// program.
    Buyback(Damm),
    /// The recipients' wSOL ATAs, in the graph's order.
    Distribute(Vec<Pubkey>),
    /// Exactly these accounts.
    Raw(Vec<AccountMeta>),
}

/// `run`'s named accounts for this autopilot (the pool read-only; `None`
/// before `bind_pool`).
pub fn run_accounts(
    a: &ApKeys,
    caller: &Pubkey,
    operator: Option<Pubkey>,
    graph: &[u8; 32],
    pool: Option<Pubkey>,
    tip_account: &Pubkey,
) -> acc::Run {
    acc::Run {
        caller: *caller,
        operator,
        autopilot: a.autopilot,
        graph: a.graph(graph),
        treasury: a.treasury,
        treasury_wsol: a.treasury_wsol,
        treasury_token: a.treasury_token,
        mint: a.mint,
        wsol_mint: WSOL_MINT,
        damm_pool: pool,
        tip_account: *tip_account,
        token_program: TOKEN_PROGRAM_ID,
        token_2022_program: TOKEN_2022_PROGRAM_ID,
    }
}

/// `run` of `node` with `named` accounts, `extra` remaining accounts; the
/// pool is writable for a buyback only.
pub fn run_ix(named: acc::Run, node: u8, amount: Option<u64>, extra: &Extra) -> Instruction {
    let pool = named.damm_pool;
    let mut accounts = named.to_account_metas(None);
    let writable_pool = matches!(extra, Extra::Buyback(_));
    for m in accounts.iter_mut() {
        if Some(m.pubkey) == pool {
            m.is_writable = writable_pool;
        }
    }
    match extra {
        Extra::None => {}
        Extra::Buyback(d) => accounts.extend([
            AccountMeta::new_readonly(DAMM_V2_POOL_AUTHORITY, false),
            AccountMeta::new(d.token_a_vault, false),
            AccountMeta::new(d.token_b_vault, false),
            AccountMeta::new_readonly(DAMM_V2_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DAMM_V2_PROGRAM_ID, false),
        ]),
        Extra::Distribute(atas) => {
            accounts.extend(atas.iter().map(|k| AccountMeta::new(*k, false)))
        }
        Extra::Raw(metas) => accounts.extend(metas.iter().cloned()),
    }
    Instruction {
        program_id: AP,
        accounts,
        data: ix::Run { node, amount }.data(),
    }
}

/// The launchpad's `Authorization`, written as `pq_authorize` writes it
/// (see `noised_autopilot::launchpad`; `cross_program.rs` uses the
/// launchpad's own): an Anchor account named `Authorization` with exactly
/// these fields (borsh after the 8-byte discriminator).
#[derive(AnchorSerialize)]
pub struct Authorization {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub pq_identity: [u8; 32],
    pub kind: u8,
    pub payload_hash: [u8; 32],
    pub message_hash: [u8; 32],
    pub unix_time: i64,
    pub slot: u64,
    pub leaf: u16,
    pub signature: Vec<u8>,
}

/// Write an authorization of `kind` over `payload` for launch `a.launch`,
/// as if `pq_authorize` landed now (unix time and slot of the clock, or
/// `slot` if given), owned by the launchpad at its canonical address.
pub fn put_authorization(
    env: &mut Env,
    a: &ApKeys,
    kind: u8,
    payload: [u8; 32],
    slot: Option<u64>,
) -> Pubkey {
    put_authorization_with(
        env,
        &a.launch,
        pq::identity_id(),
        kind,
        payload,
        slot,
        noised_launchpad::ID,
    )
}

pub fn put_authorization_with(
    env: &mut Env,
    launch: &Pubkey,
    pq_identity: [u8; 32],
    kind: u8,
    payload: [u8; 32],
    slot: Option<u64>,
    owner: Pubkey,
) -> Pubkey {
    let (address, bump) = Pubkey::find_program_address(
        &[authorization::SEED, launch.as_ref(), &[kind], &payload],
        &noised_launchpad::ID,
    );
    let clock = env.svm.get_sysvar::<Clock>();
    let account = Authorization {
        version: 1,
        bump,
        launch: *launch,
        pq_identity,
        kind,
        payload_hash: payload,
        message_hash: pq::sha256(&[b"PHX-AUTH-V1 test message", &payload]),
        unix_time: clock.unix_timestamp,
        slot: slot.unwrap_or(clock.slot),
        leaf: 0,
        signature: vec![0x5C; authorization::SIG_LEN],
    };
    // Anchor's discriminator of an account named `Authorization`.
    let mut data = pq::sha256(&[b"account:Authorization"])[..8].to_vec();
    assert_eq!(data, authorization::DISCRIMINATOR);
    account.serialize(&mut data).unwrap();
    assert_eq!(data.len(), authorization::LEN);
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    env.svm
        .set_account(
            address,
            Account {
                lamports,
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    address
}

pub fn activation_auth(
    env: &mut Env,
    a: &ApKeys,
    graph: &[u8; 32],
    activate_at: i64,
    slot: Option<u64>,
) -> Pubkey {
    let payload = noised_autopilot::launchpad::activation_payload(&a.autopilot, graph, activate_at);
    put_authorization(env, a, authorization::kind::GRAPH_ACTIVATE, payload, slot)
}

/// A freeze of `graph` usable until `not_after`.
pub fn freeze_auth(
    env: &mut Env,
    a: &ApKeys,
    graph: &[u8; 32],
    not_after: i64,
    slot: Option<u64>,
) -> Pubkey {
    let payload = noised_autopilot::launchpad::freeze_payload(&a.autopilot, graph, not_after);
    put_authorization(env, a, authorization::kind::GRAPH_FREEZE, payload, slot)
}

/// A revocation of `operator` on `graph` (the graph active when it is used),
/// naming the activation that is active now (payload v3, audit 4, A4-3).
pub fn revoke_auth(
    env: &mut Env,
    a: &ApKeys,
    graph: &[u8; 32],
    operator: &Pubkey,
    slot: Option<u64>,
) -> Pubkey {
    let active = autopilot(env, a).active_auth;
    revoke_auth_with(env, a, graph, operator, &active, slot)
}

/// A revocation of `operator` on `graph` activated by `active_auth`.
pub fn revoke_auth_with(
    env: &mut Env,
    a: &ApKeys,
    graph: &[u8; 32],
    operator: &Pubkey,
    active_auth: &Pubkey,
    slot: Option<u64>,
) -> Pubkey {
    let payload =
        noised_autopilot::launchpad::revoke_payload(&a.autopilot, graph, operator, active_auth);
    put_authorization(env, a, authorization::kind::OPERATOR_REVOKE, payload, slot)
}

/// A graph's bytes (verified) and hash.
pub fn compile(p: &GraphProgram) -> (Vec<u8>, [u8; 32]) {
    let bytes = p.encode().unwrap();
    Graph::verify(&bytes).unwrap_or_else(|e| panic!("graph: {e:?}"));
    let h = hash(&bytes);
    (bytes, h)
}

pub fn autopilot(env: &Env, a: &ApKeys) -> Autopilot {
    env.anchor(&a.autopilot)
}

pub fn graph_record(env: &Env, a: &ApKeys, h: &[u8; 32]) -> GraphRecord {
    env.anchor(&a.graph(h))
}

pub fn supply(env: &Env, mint: &Pubkey) -> u64 {
    let account = env.account(mint).unwrap();
    spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Mint>::unpack(
        &account.data,
    )
    .unwrap()
    .base
    .supply
}

/// A launched, graduated and migrated token whose fee recipients are a
/// wallet (70%) and the autopilot's treasury (30%), with the autopilot
/// initialized and bound, and the treasury funded by `distribute`.
pub struct ApWorld {
    pub w: World,
    pub k: Keys,
    pub a: ApKeys,
    pub d: Damm,
    /// Holds tokens and wSOL; trades on the pool.
    pub carol: Keypair,
    /// A keeper with a wSOL account (tips land there).
    pub keeper: Keypair,
    /// The launch's other fee recipient.
    pub fee_recipient: Pubkey,
    /// The position NFT mints of the migrated pool (default before).
    pub positions: [Pubkey; 2],
}

impl ApWorld {
    pub fn env(&mut self) -> &mut Env {
        &mut self.w.env
    }

    pub fn now(&self) -> i64 {
        self.w.env.now()
    }

    pub fn payer(&self) -> Pubkey {
        self.w.env.payer.pubkey()
    }

    pub fn keeper_tip(&self) -> Pubkey {
        wsol_ata(&self.keeper.pubkey())
    }

    /// Send `ixs` signed by the env's payer and `signers` (legacy, size
    /// checked).
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<Sent, Failed> {
        self.w.env.send(ixs, signers)
    }

    /// Publish, authorize (first activation, now) and apply a graph.
    pub fn activate_now(&mut self, p: &GraphProgram) -> [u8; 32] {
        let (bytes, h) = compile(p);
        let payer = self.payer();
        let a = self.a;
        self.send(&[publish_graph(&payer, &a, &bytes)], &[])
            .expect_ok("publish_graph");
        let now = self.now();
        let auth = activation_auth(self.env(), &a, &h, now, None);
        self.send(&[activate(&a, &h, &auth, now)], &[])
            .expect_ok("activate");
        self.send(&[apply_pending(&a, &h)], &[])
            .expect_ok("apply_pending");
        h
    }

    /// The pool the autopilot is bound to (`None` before `bind_pool`).
    pub fn bound_pool(&self) -> Option<Pubkey> {
        let p = self.state().damm_pool;
        (p != Pubkey::default()).then_some(p)
    }

    /// Run `node` as the keeper with the accounts its action needs.
    pub fn run(&mut self, h: &[u8; 32], node: u8, extra: &Extra) -> Result<Sent, Failed> {
        self.run_amount(h, node, None, extra)
    }

    /// Run `node` as the keeper, choosing `amount` (buybacks).
    pub fn run_amount(
        &mut self,
        h: &[u8; 32],
        node: u8,
        amount: Option<u64>,
        extra: &Extra,
    ) -> Result<Sent, Failed> {
        let keeper = self.keeper.insecure_clone();
        let named = run_accounts(
            &self.a,
            &keeper.pubkey(),
            None,
            h,
            self.bound_pool(),
            &self.keeper_tip(),
        );
        self.send(&[run_ix(named, node, amount, extra)], &[&keeper])
    }

    /// `update_price`: an observation of the pool's price, by anyone.
    pub fn observe(&mut self) -> Result<Sent, Failed> {
        let (a, pool) = (self.a, self.d.pool);
        self.send(&[update_price(&a, &pool)], &[])
    }

    /// An observation, then a minute: what a keeper does before a buyback.
    pub fn observe_and_wait(&mut self) {
        self.observe().expect_ok("update_price");
        let now = self.now();
        self.env().set_time(now + OBS_MIN_SPAN_SECS);
    }

    /// Run gated `node` as `operator` with `amount`.
    pub fn run_as(
        &mut self,
        operator: &Keypair,
        h: &[u8; 32],
        node: u8,
        amount: Option<u64>,
        extra: &Extra,
    ) -> Result<Sent, Failed> {
        let named = run_accounts(
            &self.a,
            &operator.pubkey(),
            Some(operator.pubkey()),
            h,
            self.bound_pool(),
            &wsol_ata(&operator.pubkey()),
        );
        self.send(&[run_ix(named, node, amount, extra)], &[operator])
    }

    pub fn buyback(&self) -> Extra {
        Extra::Buyback(self.d)
    }

    /// Give the treasury `lamports` of wSOL (a wrap and a transfer by a
    /// donor: anyone may fund it).
    pub fn fund_sol(&mut self, lamports: u64) {
        let donor = self.w.env.funded(lamports / LAMPORTS_PER_SOL + 2);
        let mut ixs = wrap_sol(&donor.pubkey(), lamports);
        ixs.push(
            spl_token_2022::instruction::transfer_checked(
                &TOKEN_PROGRAM_ID,
                &wsol_ata(&donor.pubkey()),
                &WSOL_MINT,
                &self.a.treasury_wsol,
                &donor.pubkey(),
                &[],
                lamports,
                9,
            )
            .unwrap(),
        );
        self.send(&ixs, &[&donor]).expect_ok("fund the treasury");
    }

    /// Give the treasury `amount` tokens (from carol).
    pub fn fund_tokens(&mut self, amount: u64) {
        let carol = self.carol.insecure_clone();
        let t = spl_token_2022::instruction::transfer_checked(
            &TOKEN_2022_PROGRAM_ID,
            &base_ata(&carol.pubkey(), &self.k.mint),
            &self.k.mint,
            &self.a.treasury_token,
            &carol.pubkey(),
            &[],
            amount,
            6,
        )
        .unwrap();
        self.send(&[t], &[&carol])
            .expect_ok("tokens to the treasury");
    }

    pub fn sol(&self) -> u64 {
        self.w.env.token_amount(&self.a.treasury_wsol)
    }

    pub fn tokens(&self) -> u64 {
        self.w.env.token_amount(&self.a.treasury_token)
    }

    pub fn state(&self) -> Autopilot {
        autopilot(&self.w.env, &self.a)
    }

    /// Carol trades on the pool: buys with `lamports` of wSOL, or sells
    /// `tokens`.
    pub fn carol_buys(&mut self, lamports: u64) {
        let carol = self.carol.insecure_clone();
        let ix =
            crate::common::lifecycle::damm_swap(&carol.pubkey(), &self.k, &self.d, false, lamports);
        self.send(&[ix], &[&carol]).expect_ok("carol buys");
    }

    pub fn carol_sells(&mut self, tokens: u64) {
        let carol = self.carol.insecure_clone();
        let ix =
            crate::common::lifecycle::damm_swap(&carol.pubkey(), &self.k, &self.d, true, tokens);
        self.send(&[ix], &[&carol]).expect_ok("carol sells");
    }

    pub fn pool_sqrt_price(&self) -> u128 {
        let pool: noised_launchpad::cp_amm::accounts::Pool = {
            let a = self.w.env.account(&self.d.pool).unwrap();
            anchor_lang::__private::bytemuck::pod_read_unaligned(&a.data[8..])
        };
        pool.sqrt_price
    }
}

/// See `ApWorld`. `graduate`: complete the curve and migrate to DAMM v2
/// (else the launch stays on its bonding curve, live, with the autopilot
/// bound).
pub fn ap_world(graduate: bool) -> ApWorld {
    // A first launch by the test creator (the harness's world), then the
    // launch under test, whose address (and so its treasury) is known
    // before it is created.
    let mut w = launched_with(|_| {});
    load_autopilot(&mut w.env);
    let seed = [0xA9; 32];
    let creator = w.creator.pubkey();
    let launch = pda(
        &[
            noised_launchpad::constants::LAUNCH_SEED,
            creator.as_ref(),
            &seed,
        ],
        &noised_launchpad::ID,
    );
    let treasury = treasury_of(&launch);
    let fee_recipient = w.recipients[0];
    let k = w.launch_another(seed, |p| {
        // No caps, so one buyer can complete the curve during the guard.
        p.max_buy_bps = 0;
        p.max_wallet_bps = 0;
        p.p2p_locked = false;
        p.recipients[1].wallet = treasury;
    });
    assert_eq!(k.launch, launch);
    let l: Launch = w.env.anchor(&k.launch);
    assert_eq!(
        l.recipients[1].wallet, treasury,
        "the treasury is a fee recipient"
    );
    let a = ApKeys::new(&k.launch, &k.mint);
    let payer = w.env.payer.pubkey();
    w.env
        .send(
            &[init_autopilot(&payer, &k), bind_mint(&payer, &k, &a)],
            &[],
        )
        .expect_ok("init_autopilot + bind_mint");

    let carol = w.env.funded(60);
    w.env
        .send(&wrap_sol(&carol.pubkey(), 45 * LAMPORTS_PER_SOL), &[&carol])
        .expect_ok("wrap");
    w.env
        .send(
            &[create_ata(
                &carol.pubkey(),
                &carol.pubkey(),
                &k.mint,
                &TOKEN_2022_PROGRAM_ID,
            )],
            &[&carol],
        )
        .expect_ok("carol's token account");
    let keeper = w.env.funded(2);
    w.env
        .send(
            &[create_ata(
                &keeper.pubkey(),
                &keeper.pubkey(),
                &WSOL_MINT,
                &TOKEN_PROGRAM_ID,
            )],
            &[&keeper],
        )
        .expect_ok("keeper's wSOL account");
    let config = w.env.load_account_json(&crate::common::fixture(&format!(
        "accounts/{}.json",
        crate::common::lifecycle::DAMM_CONFIG_FEE_OPTION_2
    )));
    let mut d = Damm::new(&k, config);
    let mut positions = [Pubkey::default(); 2];

    if graduate {
        // The shield ends with the execution window; carol completes the
        // curve (partial fill), fees and surplus reach the launch
        // authority, anyone migrates, and `distribute` pays the treasury.
        w.env.set_time(l.execute_end_ts);
        w.env
            .send(
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
            .expect_ok("buy to completion");
        w.env
            .send(&[claim_surplus(&payer, &k)], &[])
            .expect_ok("claim_surplus");
        w.env
            .send(&[claim_fees(&payer, &k)], &[])
            .expect_ok("claim_fees");
        let (migrated, nfts, _) = migrate_to_damm_v2(&mut w.env, &k);
        d = migrated;
        positions = nfts;
        w.env
            .send(&[bind_pool(&a, &d.config, &d.pool)], &[])
            .expect_ok("bind_pool");
        let recipients = [fee_recipient, treasury];
        w.env
            .send(&[distribute(&payer, &k, &w.treasury, &recipients)], &[])
            .expect_ok("distribute");
    }
    ApWorld {
        w,
        k,
        a,
        d,
        carol,
        keeper,
        fee_recipient,
        positions,
    }
}
