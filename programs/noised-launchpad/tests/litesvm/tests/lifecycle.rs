//! The whole life of a launch against mainnet DBC and DAMM v2: fair-open
//! batch, curve completion (DBC revokes the hook), surplus and trading-fee
//! claims, migration to DAMM v2 with the LP permanently locked under the
//! launch authority, LP fee claims, fee routing and the burn of base tokens
//! held by the launch authority.

mod common;

use anchor_spl::token_interface::spl_token_2022::{
    self,
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};
use common::{launch::*, lifecycle::*, world::*, *};
use noised_launchpad::{
    cp_amm::accounts::Position, dynamic_bonding_curve::accounts::TransferHookPool,
    error::LaunchpadError as E, state::Launch,
};
use solana_signer::Signer;

fn mint_state(env: &Env, mint: &Pubkey) -> (u64, Option<Pubkey>, Option<Pubkey>) {
    let account = env.account(mint).unwrap();
    let state = StateWithExtensions::<Mint>::unpack(&account.data).unwrap();
    let hook = state.get_extension::<TransferHook>().unwrap();
    (
        state.base.supply,
        hook.program_id.into(),
        hook.authority.into(),
    )
}

fn token_owner(env: &Env, account: &Pubkey) -> Pubkey {
    let a = env.account(account).unwrap();
    StateWithExtensions::<TokenAccount>::unpack(&a.data)
        .unwrap()
        .base
        .owner
}

#[test]
fn full_lifecycle_through_damm_v2() {
    // No caps, so one buyer can complete the curve during the guard.
    let mut w = launched_with(|p| {
        p.max_buy_bps = 0;
        p.max_wallet_bps = 0;
        p.p2p_locked = false;
    });
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let alice = env.funded(10);
    let bob = env.funded(10);
    let carol = env.funded(40);
    env.send(&wrap_sol(&alice.pubkey(), 2 * LAMPORTS_PER_SOL), &[&alice])
        .expect_ok("wrap");
    env.send(&wrap_sol(&bob.pubkey(), LAMPORTS_PER_SOL), &[&bob])
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
    .expect_ok("carol base ATA");

    env.send(
        &[commit(&alice.pubkey(), &k, 2 * LAMPORTS_PER_SOL)],
        &[&alice],
    )
    .expect_ok("commit");
    env.send(&[commit(&bob.pubkey(), &k, LAMPORTS_PER_SOL)], &[&bob])
        .expect_ok("commit");
    env.set_time(l.commit_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.send(&[claim(&payer, &k, &alice.pubkey(), true, true)], &[])
        .expect_ok("claim");

    // Carol completes the curve; partial fill returns what the curve cannot take.
    env.set_time(l.execute_end_ts);
    let carol_wsol = env.token_amount(&wsol_ata(&carol.pubkey()));
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
    .expect_ok("buy to completion");
    let spent = carol_wsol - env.token_amount(&wsol_ata(&carol.pubkey()));
    assert!(
        spent > 0 && spent < 20 * LAMPORTS_PER_SOL,
        "partial fill spent {spent}"
    );
    let pool: TransferHookPool = env.anchor(&k.pool);
    assert!(pool.pool_state.quote_reserve >= 10 * LAMPORTS_PER_SOL);
    // DBC revoked the hook (program and authority) in the completing swap.
    let (supply_at_completion, hook_program, hook_authority) = mint_state(env, &k.mint);
    assert_eq!((hook_program, hook_authority), (None, None));

    // Claims after the revocation need no hook accounts; the pro-rata share is unchanged.
    env.send(&[claim(&payer, &k, &bob.pubkey(), true, false)], &[])
        .expect_ok("claim after completion");
    let batch: Launch = env.anchor(&k.launch);
    assert_eq!(
        env.token_amount(&base_ata(&bob.pubkey(), &k.mint)),
        (u128::from(batch.tokens_out) / 3) as u64
    );
    assert_eq!(
        batch.tokens_claimed,
        env.token_amount(&base_ata(&alice.pubkey(), &k.mint))
            + env.token_amount(&base_ata(&bob.pubkey(), &k.mint))
    );

    // Surplus and trading fees flow to the launch authority.
    env.send(&[claim_surplus(&payer, &k)], &[])
        .expect_ok("claim_surplus");
    env.send(&[claim_surplus(&payer, &k)], &[]).fails_with(
        code(E::NothingToDo),
        "NothingToDo",
        "surplus withdrawn twice",
    );
    env.send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    let fees_before_lp = env.token_amount(&wsol_ata(&k.launch_authority));
    assert!(fees_before_lp > 0);

    // Anyone migrates; DBC creates the DAMM v2 pool with mainnet's config.
    let (d, [nft1, nft2], sent) = migrate_to_damm_v2(env, &k);
    println!("migration_damm_v2: {} CU, {} bytes", sent.cu, sent.size);

    // All liquidity sits in positions whose NFTs the launch authority holds;
    // the main position is permanently locked.
    let main: Position = env.anchor(&Damm::position(&nft1));
    assert!(main.permanent_locked_liquidity > 0);
    assert_eq!((main.unlocked_liquidity, main.vested_liquidity), (0, 0));
    assert_eq!(
        token_owner(env, &Damm::nft_account(&nft1)),
        k.launch_authority
    );
    if env.account(&Damm::position(&nft2)).is_some() {
        assert_eq!(
            token_owner(env, &Damm::nft_account(&nft2)),
            k.launch_authority
        );
    }
    let (supply_after_migration, _, _) = mint_state(env, &k.mint);
    assert!(
        supply_after_migration <= supply_at_completion,
        "unsold supply is burned at migration"
    );

    // Trading on DAMM v2 earns the locked position fees, claimable by anyone.
    let carol_tokens = env.token_amount(&base_ata(&carol.pubkey(), &k.mint));
    env.send(
        &[damm_swap(&carol.pubkey(), &k, &d, true, carol_tokens / 4)],
        &[&carol],
    )
    .expect_ok("DAMM sell");
    env.send(
        &[damm_swap(&carol.pubkey(), &k, &d, false, LAMPORTS_PER_SOL)],
        &[&carol],
    )
    .expect_ok("DAMM buy");
    let base_before = env.token_amount(&base_ata(&k.launch_authority, &k.mint));
    let sent = env
        .send(&[claim_lp_fees(&payer, &k, &d, &nft1)], &[])
        .expect_ok("claim_lp_fees");
    println!("claim_lp_fees: {} CU, {} bytes", sent.cu, sent.size);
    let quote_from_lp = env.token_amount(&wsol_ata(&k.launch_authority)) - fees_before_lp;
    let base_from_lp = env.token_amount(&base_ata(&k.launch_authority, &k.mint)) - base_before;
    assert!(quote_from_lp > 0 || base_from_lp > 0);
    println!("LP fees: {quote_from_lp} lamports, {base_from_lp} base units");

    // Base tokens that reach the launch authority are burned, never sold.
    let gift = carol_tokens / 10;
    let transfer = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &base_ata(&carol.pubkey(), &k.mint),
        &k.mint,
        &base_ata(&k.launch_authority, &k.mint),
        &carol.pubkey(),
        &[],
        gift,
        6,
    )
    .unwrap();
    env.send(&[transfer], &[&carol])
        .expect_ok("send base to the launch authority");
    let to_burn = env.token_amount(&base_ata(&k.launch_authority, &k.mint));
    assert!(to_burn >= gift);
    let quote = env.token_amount(&wsol_ata(&k.launch_authority));
    let (supply_before_burn, _, _) = mint_state(env, &k.mint);
    env.send(&[distribute(&payer, &k, &w.treasury, &w.recipients)], &[])
        .expect_ok("distribute");
    let (supply_after_burn, _, _) = mint_state(env, &k.mint);
    assert_eq!(supply_before_burn - supply_after_burn, to_burn);
    assert_eq!(env.token_amount(&base_ata(&k.launch_authority, &k.mint)), 0);
    assert_eq!(env.token_amount(&wsol_ata(&k.launch_authority)), 0);
    let platform = quote * 2_000 / 10_000;
    let r0 = (quote - platform) * 7_000 / 10_000;
    assert_eq!(env.token_amount(&wsol_ata(&w.treasury)), platform);
    assert_eq!(env.token_amount(&wsol_ata(&w.recipients[0])), r0);
    assert_eq!(
        env.token_amount(&wsol_ata(&w.recipients[1])),
        quote - platform - r0
    );
}
