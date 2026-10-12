//! Shield lifecycle against the mainnet Token-2022 v11 program: creation,
//! zToken configuration, wrap/unwrap accounting and griefing resistance.

mod common;

use anchor_lang::{solana_program::system_instruction, AccountDeserialize};
use anchor_spl::token_2022::spl_token_2022::instruction as t22_ix;
use common::*;
use noised_shield::{error::ShieldError, state::Shield, ShieldCreated, Unwrapped, Wrapped};
use solana_signer::Signer;

fn create(env: &mut Env, s: &ShieldKeys) -> u64 {
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, s)], &[])
}

#[test]
fn create_shield_for_an_spl_token_mint() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let payer = env.payer.pubkey();
    let meta = env.send(&[create_shield_ix(&payer, &s)], &[]).unwrap();
    eprintln!(
        "create_shield (SPL Token base): {} CU",
        meta.compute_units_consumed
    );

    // No Token-2022 metadata: generic name and symbol from the mint address.
    let b58 = base.to_string();
    let (name, symbol) = (format!("Shielded {}", &b58[..8]), format!("z{}", &b58[..4]));
    assert_z_mint(&env, &s, 6, &name, &symbol, "");

    let shield = Shield::try_deserialize(&mut env.data(&s.shield).as_slice()).unwrap();
    assert_eq!(shield.version, Shield::VERSION);
    assert_eq!(shield.base_mint, base);
    assert_eq!(shield.base_token_program, SPL);
    assert_eq!(shield.z_mint, s.z_mint);
    assert_eq!(shield.escrow, s.escrow);
    assert_eq!(shield.decimals, 6);
    assert_eq!(env.owner(&s.escrow), SPL);
    assert_eq!(env.balance(&s.escrow), 0);
    assert_exactly_backed(&env, &s);

    let ev: ShieldCreated = event(&meta.logs).expect("ShieldCreated event");
    assert_eq!(
        (ev.base_mint, ev.z_mint, ev.escrow, ev.payer),
        (base, s.z_mint, s.escrow, payer)
    );
    assert_eq!((ev.name, ev.symbol, ev.uri), (name, symbol, String::new()));
}

#[test]
fn create_shield_for_a_token_2022_metadata_mint() {
    let mut env = Env::new();
    let uri = "https://noised.example/phx.json";
    let base = env.create_t22_mint(
        9,
        &[Ext::Metadata {
            name: "Noised Test Token".into(),
            symbol: "PHX".into(),
            uri: uri.into(),
        }],
    );
    let s = ShieldKeys::new(base, T22);
    let cu = create(&mut env, &s);
    eprintln!("create_shield (Token-2022 metadata base): {cu} CU");
    assert_z_mint(&env, &s, 9, "Shielded Noised Test Token", "zPHX", uri);
    assert_eq!(env.owner(&s.escrow), T22);
    assert_exactly_backed(&env, &s);
}

#[test]
fn second_create_fails() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    create(&mut env, &s);
    let before = (env.data(&s.shield), env.data(&s.z_mint));
    let payer = env.payer.pubkey();
    assert_fails(env.send(&[create_shield_ix(&payer, &s)], &[]));
    // Another payer cannot re-create it either.
    let other = env.user();
    assert_fails(env.send(&[create_shield_ix(&other.pubkey(), &s)], &[&other]));
    assert_eq!(before, (env.data(&s.shield), env.data(&s.z_mint)));
}

#[test]
fn wrap_unwrap_round_trip_keeps_supply_equal_to_escrow() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    create(&mut env, &s);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 1_000_000);
    let (bob, bob_base, bob_z) = env.funded_user(&s, 250);

    let tx = env
        .send(
            &[wrap_ix(
                &alice.pubkey(),
                &s,
                &alice_base,
                &alice_z,
                600_000,
                &[],
            )],
            &[&alice],
        )
        .unwrap();
    eprintln!("wrap (SPL Token base): {} CU", tx.compute_units_consumed);
    let ev: Wrapped = event(&tx.logs).expect("Wrapped event");
    assert_eq!(
        (ev.user, ev.amount, ev.minted),
        (alice.pubkey(), 600_000, 600_000)
    );
    assert_eq!((ev.z_supply, ev.escrow_balance), (600_000, 600_000));
    assert_eq!(assert_exactly_backed(&env, &s), 600_000);

    env.ok(
        &[wrap_ix(&bob.pubkey(), &s, &bob_base, &bob_z, 250, &[])],
        &[&bob],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 600_250);
    assert_eq!((env.balance(&alice_z), env.balance(&bob_z)), (600_000, 250));
    assert_eq!(
        (env.balance(&alice_base), env.balance(&bob_base)),
        (400_000, 0)
    );

    // zTokens are ordinary Token-2022 tokens: Alice pays Bob 100.
    let pay = t22_ix::transfer_checked(
        &T22,
        &alice_z,
        &s.z_mint,
        &bob_z,
        &alice.pubkey(),
        &[],
        100,
        6,
    )
    .unwrap();
    env.ok(&[pay], &[&alice]);

    let tx = env
        .send(
            &[unwrap_ix(
                &alice.pubkey(),
                &s,
                &alice_base,
                &alice_z,
                400_000,
                &[],
            )],
            &[&alice],
        )
        .unwrap();
    eprintln!("unwrap (SPL Token base): {} CU", tx.compute_units_consumed);
    let ev: Unwrapped = event(&tx.logs).expect("Unwrapped event");
    assert_eq!(
        (ev.amount, ev.z_supply, ev.escrow_balance),
        (400_000, 200_250, 200_250)
    );
    assert_eq!(assert_exactly_backed(&env, &s), 200_250);

    // Bob unwraps everything he holds, into any base account (Alice's here).
    env.ok(
        &[unwrap_ix(&bob.pubkey(), &s, &alice_base, &bob_z, 350, &[])],
        &[&bob],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 199_900);
    // More than he holds fails; nothing changes.
    assert_fails(env.send(
        &[unwrap_ix(&bob.pubkey(), &s, &bob_base, &bob_z, 1, &[])],
        &[&bob],
    ));
    env.ok(
        &[unwrap_ix(
            &alice.pubkey(),
            &s,
            &alice_base,
            &alice_z,
            199_900,
            &[],
        )],
        &[&alice],
    );

    assert_eq!(assert_exactly_backed(&env, &s), 0);
    assert_eq!(env.balance(&alice_base) + env.balance(&bob_base), 1_000_250);
}

#[test]
fn rejects_zero_amounts_foreign_accounts_and_wrong_signers() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    create(&mut env, &s);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 1_000);
    env.ok(
        &[wrap_ix(
            &alice.pubkey(),
            &s,
            &alice_base,
            &alice_z,
            1_000,
            &[],
        )],
        &[&alice],
    );
    let a = alice.pubkey();

    let result = env.send(&[wrap_ix(&a, &s, &alice_base, &alice_z, 0, &[])], &[&alice]);
    assert_error(result, ShieldError::ZeroAmount);
    let result = env.send(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 0, &[])],
        &[&alice],
    );
    assert_error(result, ShieldError::ZeroAmount);
    // Releasing the escrow into itself: Anchor's duplicate-mutable-account
    // check fires before the program's own `SameAccount` constraint.
    assert_error(
        env.send(
            &[unwrap_ix(&a, &s, &s.escrow, &alice_z, 10, &[])],
            &[&alice],
        ),
        anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount,
    );
    assert_error(
        env.send(&[wrap_ix(&a, &s, &s.escrow, &alice_z, 10, &[])], &[&alice]),
        anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount,
    );

    // A fake escrow owned by the attacker, a foreign zToken mint, a fake
    // authority and the wrong token program are all refused.
    let (mallory, mallory_base, mallory_z) = env.funded_user(&s, 0);
    let m = mallory.pubkey();
    let accomplice = env.user();
    let mut fake = s;
    fake.escrow = env.create_ata(&accomplice.pubkey(), &base, &SPL);
    env.mint_to(&base, &SPL, &fake.escrow, 10);
    assert_error(
        env.send(
            &[unwrap_ix(&m, &fake, &mallory_base, &mallory_z, 10, &[])],
            &[&mallory],
        ),
        anchor_lang::error::ErrorCode::ConstraintHasOne,
    );
    let other_base = env.create_spl_mint(6);
    let other = ShieldKeys::new(other_base, SPL);
    create(&mut env, &other);
    let mut fake = s;
    fake.z_mint = other.z_mint;
    assert_fails(env.send(
        &[wrap_ix(&a, &fake, &alice_base, &alice_z, 10, &[])],
        &[&alice],
    ));
    let mut fake = s;
    fake.authority = m;
    let ix = unwrap_ix(&m, &fake, &mallory_base, &mallory_z, 10, &[]);
    assert_fails(env.send(&[ix], &[&mallory]));
    let mut fake = s;
    fake.base_token_program = T22;
    assert_fails(env.send(
        &[wrap_ix(&a, &fake, &alice_base, &alice_z, 10, &[])],
        &[&alice],
    ));

    // Mallory cannot burn Alice's zTokens to release base tokens to herself.
    assert_fails(env.send(
        &[unwrap_ix(&m, &s, &mallory_base, &alice_z, 10, &[])],
        &[&mallory],
    ));
    // Mallory cannot mint zTokens: the mint authority is the shield PDA.
    let mint = t22_ix::mint_to(&T22, &s.z_mint, &mallory_z, &m, &[], 10).unwrap();
    assert_fails(env.send(&[mint], &[&mallory]));

    assert_eq!((env.balance(&alice_z), env.balance(&mallory_z)), (1_000, 0));
    assert_eq!(assert_exactly_backed(&env, &s), 1_000);
}

#[test]
fn donations_and_direct_burns_cannot_block_or_brick_a_shield() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let payer = env.payer.pubkey();

    // Before creation: lamports sent to the zToken PDA (the smallest amount
    // the runtime accepts for a new account), and the escrow ATA created by a
    // third party holding a donation.
    let dust = env.svm.minimum_balance_for_rent_exemption(0);
    let poke = system_instruction::transfer(&payer, &s.z_mint, dust);
    env.ok(&[poke], &[]);
    let escrow = env.create_ata(&s.authority, &base, &SPL);
    assert_eq!(escrow, s.escrow);
    env.mint_to(&base, &SPL, &s.escrow, 77);

    create(&mut env, &s);
    let data_len = env.data(&s.z_mint).len();
    assert_eq!(
        env.lamports(&s.z_mint),
        env.svm.minimum_balance_for_rent_exemption(data_len)
    );
    assert_eq!((env.supply(&s.z_mint), env.balance(&s.escrow)), (0, 77));

    let (alice, alice_base, alice_z) = env.funded_user(&s, 2_000);
    let a = alice.pubkey();
    env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &[])],
        &[&alice],
    );
    // The donation is surplus: Alice gets exactly what she deposited.
    assert_eq!(env.balance(&alice_z), 1_000);
    assert_eq!(
        (env.supply(&s.z_mint), env.balance(&s.escrow)),
        (1_000, 1_077)
    );

    // After creation: another donation and a direct Token-2022 burn.
    let gift = t22_ix::transfer_checked(&SPL, &alice_base, &base, &s.escrow, &a, &[], 5, 6);
    let burn = t22_ix::burn_checked(&T22, &alice_z, &s.z_mint, &a, &[], 100, 6);
    let (gift, burn) = (gift.unwrap(), burn.unwrap());
    env.ok(&[gift, burn], &[&alice]);
    assert_eq!(
        (env.supply(&s.z_mint), env.balance(&s.escrow)),
        (900, 1_082)
    );

    // Both directions keep working and stay exactly 1:1.
    env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 995, &[])],
        &[&alice],
    );
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 1_895, &[])],
        &[&alice],
    );
    assert_eq!((env.supply(&s.z_mint), env.balance(&s.escrow)), (0, 182));
    assert_eq!(env.balance(&alice_base), 2_000 - 5 - 100);
    // The surplus is never paid out.
    assert_fails(env.send(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 1, &[])],
        &[&alice],
    ));
}

#[test]
fn an_overfunded_ztoken_address_does_not_block_creation() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let payer = env.payer.pubkey();
    let poke = system_instruction::transfer(&payer, &s.z_mint, 10_000_000_000);
    env.ok(&[poke], &[]);
    create(&mut env, &s);
    let b58 = base.to_string();
    assert_z_mint(
        &env,
        &s,
        6,
        &format!("Shielded {}", &b58[..8]),
        &format!("z{}", &b58[..4]),
        "",
    );
    assert_eq!(env.lamports(&s.z_mint), 10_000_000_000);
}
