//! A protocol, one created and launched token, and the people involved.

use noised_hook::HookError;
use noised_launchpad::{
    constants::WSOL_MINT,
    error::LaunchpadError as E,
    state::{BaseFeeParams, Launch, LaunchParams, LaunchStatus, Protocol},
};
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::{
    launch::*,
    pq,
    vault::{open_vault, TestVault},
    Env, Expect, Pubkey, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};

/// Anchor error number of a launchpad error.
pub fn code(e: E) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

/// Anchor error number of a Launch Guard error.
pub fn hook_code(e: HookError) -> u32 {
    e as u32 + anchor_lang::error::ERROR_CODE_OFFSET
}

/// Anchor's own error numbers.
pub const CONSTRAINT_SEEDS: u32 = 2_006;
pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3_002;
pub const ACCOUNT_NOT_INITIALIZED: u32 = 3_012;

pub const NAME: &str = "Noised Smoke Test";
pub const SYMBOL: &str = "PHXST";
pub const URI: &str = "https://example.org/noised/smoke-test-token-metadata.json";
/// The metadata every test launch is attested and launched with.
pub const META: (&str, &str, &str) = (NAME, SYMBOL, URI);

pub struct World {
    pub env: Env,
    pub creator: Keypair,
    /// The base mint keypair (signs `launch`).
    pub mint: Keypair,
    /// The treasury: a PQ vault of wSOL, whose token account (its canonical
    /// wSOL ATA) receives the platform share.
    pub treasury: Pubkey,
    pub treasury_vault: TestVault,
    pub recipients: [Pubkey; 2],
    pub params: LaunchParams,
    pub k: Keys,
}

/// Protocol initialized (20% platform share, a wSOL PQ vault as treasury)
/// and a launch created with `params()` adjusted by `tweak`, not attested
/// or launched yet.
pub fn created_with(tweak: impl FnOnce(&mut LaunchParams)) -> World {
    let mut env = Env::new();
    let admin = env.funded(5);
    env.set_upgrade_authority(&noised_launchpad::ID, &admin.pubkey());
    let treasury_vault = open_vault(&mut env, &admin, &WSOL_MINT, &TOKEN_PROGRAM_ID, "treasury");
    let treasury = treasury_vault.address;

    let stranger = env.funded(1);
    env.send(
        &[initialize_protocol(&stranger.pubkey(), treasury, 2_000)],
        &[&stranger],
    )
    .fails_with(
        code(E::NotUpgradeAuthority),
        "NotUpgradeAuthority",
        "init by a non-authority",
    );
    env.send(
        &[initialize_protocol(&admin.pubkey(), treasury, 2_000)],
        &[&admin],
    )
    .expect_ok("initialize_protocol");
    assert!(
        env.send(
            &[initialize_protocol(&admin.pubkey(), treasury, 100)],
            &[&admin]
        )
        .is_err(),
        "protocol can only be initialized once"
    );
    let protocol: Protocol = env.anchor(&protocol());
    assert_eq!(
        (protocol.treasury, protocol.platform_fee_bps),
        (treasury, 2_000)
    );

    let creator = env.funded(20);
    let mint = Keypair::new();
    let k = Keys::new(&creator.pubkey(), [7; 32], mint.pubkey());
    let recipients = [Keypair::new().pubkey(), Keypair::new().pubkey()];
    let mut params = params(&[(recipients[0], 7_000), (recipients[1], 3_000)]);
    tweak(&mut params);

    // A rejected bound is refused by the policy, before DBC is involved: a
    // fee schedule of 10 periods of one commit window each (50% falling to
    // 1%) outlasts the window.
    let mut bad = params.clone();
    bad.base_fee = BaseFeeParams {
        cliff_fee_numerator: 500_000_000,
        first_factor: 10,
        second_factor: u64::from(bad.open_delay_secs),
        third_factor: 49_000_000,
        base_fee_mode: 0,
    };
    env.send(&[create_launch(&creator.pubkey(), &k, bad)], &[&creator])
        .fails_with(
            code(E::FeeScheduleTooLong),
            "FeeScheduleTooLong",
            "schedule longer than open delay",
        );

    let sent = env
        .send(
            &[create_launch(&creator.pubkey(), &k, params.clone())],
            &[&creator],
        )
        .expect_ok("create_launch");
    println!("create_launch: {} CU, {} bytes", sent.cu, sent.size);
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.status, LaunchStatus::Configured);
    assert_eq!(l.pq_identity, params.pq_identity);

    World {
        env,
        creator,
        mint,
        treasury,
        treasury_vault,
        recipients,
        params,
        k,
    }
}

/// `created_with`, then attested by the creator's post-quantum identity
/// (its window opens now) and launched, paid by the creator.
pub fn launched_with(tweak: impl FnOnce(&mut LaunchParams)) -> World {
    let mut w = created_with(tweak);
    let k = w.k;
    // Nothing launches before its identity attested it.
    let c = w.creator.pubkey();
    w.env
        .send(&[launch(&c, &k, NAME, SYMBOL, URI)], &[&w.creator, &w.mint])
        .fails_with(
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            "launch before the attestation",
        );
    let sent = pq::attest(&mut w.env, &k, META);
    println!("attest_launch (v1): {} CU, {} bytes", sent.cu, sent.size);
    let sent = w
        .env
        .send(
            &[launch(&w.creator.pubkey(), &k, NAME, SYMBOL, URI)],
            &[&w.creator, &w.mint],
        )
        .expect_ok("launch");
    println!("launch: {} CU, {} bytes", sent.cu, sent.size);
    w
}

pub fn launched() -> World {
    launched_with(|_| {})
}

/// `created_with(tweak)`, then the creator rules `rules` published and
/// attested with the launch, and launched (paid by the creator).
pub fn launched_with_rules(tweak: impl FnOnce(&mut LaunchParams), rules: &[u8]) -> World {
    let mut w = created_with(tweak);
    let k = w.k;
    pq::attest_rules(&mut w.env, &k, META, rules);
    let c = w.creator.pubkey();
    let sent = w
        .env
        .send(
            &[launch_with_rules(&c, &k, META, &pq::rules_hash(rules))],
            &[&w.creator, &w.mint],
        )
        .expect_ok("launch with rules");
    println!("launch with rules: {} CU, {} bytes", sent.cu, sent.size);
    w
}

impl World {
    /// Another launch by the same creator in the same ledger, at the current
    /// time: `params()` with this world's recipients, adjusted by `tweak`,
    /// created, attested (at the identity's next free leaf) and launched
    /// under `seed`.
    pub fn launch_another(
        &mut self,
        seed: [u8; 32],
        tweak: impl FnOnce(&mut LaunchParams),
    ) -> Keys {
        let mint = Keypair::new();
        let k = Keys::new(&self.creator.pubkey(), seed, mint.pubkey());
        let mut p = params(&[(self.recipients[0], 7_000), (self.recipients[1], 3_000)]);
        tweak(&mut p);
        let c = self.creator.pubkey();
        self.env
            .send(&[create_launch(&c, &k, p)], &[&self.creator])
            .expect_ok("create_launch (another launch)");
        pq::attest(&mut self.env, &k, META);
        self.env
            .send(
                &[launch(&c, &k, NAME, SYMBOL, URI)],
                &[&self.creator, &mint],
            )
            .expect_ok("launch (another launch)");
        k
    }
}

/// A new wallet holding `lamports` of wSOL in its ATA, plus SOL for fees.
pub fn committer(env: &mut Env, lamports: u64) -> Keypair {
    let kp = env.funded(lamports / LAMPORTS_PER_SOL + 2);
    env.send(&wrap_sol(&kp.pubkey(), lamports), &[&kp])
        .expect_ok("wrap SOL");
    kp
}

/// A new wallet holding 1 SOL of wSOL and an empty base-token ATA.
pub fn buyer(env: &mut Env, k: &Keys) -> Keypair {
    let kp = committer(env, LAMPORTS_PER_SOL);
    let owner = kp.pubkey();
    env.send(
        &[create_ata(&owner, &owner, &k.mint, &TOKEN_2022_PROGRAM_ID)],
        &[&kp],
    )
    .expect_ok("buyer's base ATA");
    kp
}

/// SPEC §7 invariant 4 and the escrow accounting: cumulative payouts never
/// exceed what the batch holds, and the escrows hold exactly what is owed.
#[track_caller]
pub fn assert_escrow_invariants(env: &Env, k: &Keys) {
    let l: Launch = env.anchor(&k.launch);
    let refundable = if l.executed {
        l.total_committed - l.quote_spent
    } else {
        l.total_committed
    };
    assert!(
        l.tokens_claimed <= l.tokens_out,
        "tokens_claimed {} > tokens_out {}",
        l.tokens_claimed,
        l.tokens_out
    );
    assert!(
        l.quote_refunded <= refundable,
        "quote_refunded {} > refundable {refundable}",
        l.quote_refunded
    );
    assert_eq!(
        env.token_amount(&base_ata(&k.batch_authority, &k.mint)),
        l.tokens_out - l.tokens_claimed,
        "base escrow"
    );
    assert_eq!(
        env.token_amount(&wsol_ata(&k.batch_authority)),
        refundable - l.quote_refunded,
        "quote escrow"
    );
}

/// Two 2 SOL commits executed at `commit_end_ts` on a launch whose
/// parameters are `tweak`ed `params()`: the tokens the batch buys.
pub fn batch_tokens_out(tweak: impl FnOnce(&mut LaunchParams)) -> u64 {
    let mut w = launched_with(tweak);
    let k = w.k;
    let env = &mut w.env;
    for _ in 0..2 {
        let who = committer(env, 2 * LAMPORTS_PER_SOL);
        env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&who])
            .expect_ok("commit");
    }
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.anchor::<Launch>(&k.launch).tokens_out
}
