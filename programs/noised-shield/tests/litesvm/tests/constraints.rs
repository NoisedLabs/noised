//! Every account check of `create_shield`, `wrap` and `unwrap`, one by one:
//! the error number and the account Anchor's log line names, as the Anchor
//! 1.2.1 build returned and logged them (the framework-free program keeps
//! them; `programs/noised-shield/anchor/` is the reference). Accounts no
//! instruction can produce (a corrupted `Shield`, a foreign account at the
//! escrow address) are written into the ledger directly: each check must
//! hold on its own.

mod common;

use anchor_lang::{
    error::ErrorCode,
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    AccountDeserialize, AccountSerialize, InstructionData,
};
use common::*;
use litesvm::types::TransactionResult;
use noised_shield::{error::ShieldError, state::Shield};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// `code` and Anchor's log line for it: caused by account `name`, or none.
#[track_caller]
fn expect(result: TransactionResult, code: u32, name: Option<&str>) {
    let logs = match &result {
        Err(f) => f.meta.logs.join("\n"),
        Ok(meta) => panic!(
            "expected error {code}, transaction succeeded\n{}",
            meta.pretty_logs()
        ),
    };
    assert_eq!(custom_error(&result), Some(code), "{logs}");
    // With no account, the Anchor build logged errors it raised itself
    // (`require!`, `err!`) as `thrown in <file>:<line>`; the line is
    // otherwise the same.
    let origins: Vec<String> = match name {
        Some(name) => vec![format!("AnchorError caused by account: {name}. ")],
        None => vec![
            "AnchorError occurred. ".into(),
            "AnchorError thrown in ".into(),
        ],
    };
    let number = format!(". Error Number: {code}. ");
    assert!(
        logs.lines().any(|l| origins
            .iter()
            .any(|o| l.starts_with(&format!("Program log: {o}")))
            && l.contains(&number)),
        "missing `{origins:?}... {code}` in\n{logs}"
    );
}

fn anchor(e: ErrorCode) -> u32 {
    e.into()
}

fn shield(e: ShieldError) -> u32 {
    e.into()
}

fn ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: noised_shield::ID,
        accounts,
        data,
    }
}

/// Writes an account into the ledger (rent-exempt), as no instruction would.
fn put(env: &mut Env, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
    let account = solana_account::Account {
        lamports,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(key, account).unwrap();
}

/// SPL Token account bytes (initialized or frozen).
fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

/// A shield of an SPL Token mint, and a user holding base tokens and
/// zTokens.
fn shield_with_user(env: &mut Env) -> (ShieldKeys, Keypair, Pubkey, Pubkey) {
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (user, user_base, user_z) = env.funded_user(&s, 10_000);
    let u = user.pubkey();
    env.ok(
        &[wrap_ix(&u, &s, &user_base, &user_z, 1_000, &[])],
        &[&user],
    );
    (s, user, user_base, user_z)
}

#[test]
fn dispatch_and_arguments() {
    let mut env = Env::new();
    let (s, user, user_base, user_z) = shield_with_user(&mut env);
    let u = user.pubkey();
    let metas = wrap_ix(&u, &s, &user_base, &user_z, 1, &[]).accounts;
    let fallback = anchor(ErrorCode::InstructionFallbackNotFound);
    for data in [vec![], vec![1; 7], vec![1; 8]] {
        let result = env.send(&[ix(metas.clone(), data)], &[&user]);
        expect(result, fallback, None);
    }
    let event_tag = [228, 69, 165, 46, 81, 203, 154, 29].to_vec();
    let result = env.send(&[ix(metas.clone(), event_tag)], &[&user]);
    expect(result, anchor(ErrorCode::EventInstructionStub), None);
    for data in [
        noised_shield::instruction::Wrap { amount: 1 }.data(),
        noised_shield::instruction::Unwrap { amount: 1 }.data(),
    ] {
        let result = env.send(&[ix(metas.clone(), data[..15].to_vec())], &[&user]);
        expect(
            result,
            anchor(ErrorCode::InstructionDidNotDeserialize),
            None,
        );
    }
    // Trailing bytes after the amount are ignored.
    let mut data = noised_shield::instruction::Wrap { amount: 5 }.data();
    data.extend([9, 9, 9]);
    env.ok(&[ix(metas, data)], &[&user]);
}

#[test]
fn create_shield_account_checks() {
    let mut env = Env::new();
    let payer = env.payer.pubkey();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let data = noised_shield::instruction::CreateShield {}.data();
    let metas = create_shield_ix(&payer, &s).accounts;
    let not_enough = anchor(ErrorCode::AccountNotEnoughKeys);
    // payer, base_mint, (shield: init), shield_authority, z_mint, (escrow:
    // init_if_needed), the four programs.
    let names = [
        Some("payer"),
        Some("base_mint"),
        None,
        Some("shield_authority"),
        Some("z_mint"),
        None,
        Some("base_token_program"),
        Some("token_2022_program"),
        Some("associated_token_program"),
        Some("system_program"),
    ];
    for (n, name) in names.iter().enumerate() {
        let result = env.send(&[ix(metas[..n].to_vec(), data.clone())], &[]);
        expect(result, not_enough, *name);
    }

    let other = env.user();
    let o = other.pubkey();
    let with = |i: usize, f: &dyn Fn(&mut AccountMeta)| {
        let mut m = create_shield_ix(&payer, &s).accounts;
        f(&mut m[i]);
        ix(m, noised_shield::instruction::CreateShield {}.data())
    };
    let mut not_signer = create_shield_ix(&o, &s);
    not_signer.accounts[0].is_signer = false;
    expect(
        env.send(&[not_signer], &[]),
        anchor(ErrorCode::AccountNotSigner),
        Some("payer"),
    );
    expect(
        env.send(&[with(1, &|m| m.pubkey = o)], &[]),
        anchor(ErrorCode::AccountOwnedByWrongProgram),
        Some("base_mint"),
    );
    expect(
        env.send(&[with(2, &|m| m.pubkey = o)], &[]),
        anchor(ErrorCode::ConstraintSeeds),
        Some("shield"),
    );
    expect(
        env.send(&[with(4, &|m| m.pubkey = o)], &[]),
        anchor(ErrorCode::ConstraintSeeds),
        Some("z_mint"),
    );
    expect(
        env.send(&[with(4, &|m| m.is_writable = false)], &[]),
        anchor(ErrorCode::ConstraintMut),
        Some("z_mint"),
    );
    let program_checks = [
        (6, SYSTEM, "base_token_program"),
        (7, SPL, "token_2022_program"),
        (8, SPL, "associated_token_program"),
        (9, SPL, "system_program"),
    ];
    for (i, key, name) in program_checks {
        expect(
            env.send(&[with(i, &|m| m.pubkey = key)], &[]),
            anchor(ErrorCode::InvalidProgramId),
            Some(name),
        );
    }

    // An escrow someone else created: only an associated token account of
    // the shield authority for the base mint and its token program.
    let plain = {
        let kp = Keypair::new();
        let space = 165u64;
        let lamports = env.svm.minimum_balance_for_rent_exemption(165);
        let create = anchor_lang::solana_program::system_instruction::create_account(
            &payer,
            &kp.pubkey(),
            lamports,
            space,
            &SPL,
        );
        let init = anchor_spl::token::spl_token::instruction::initialize_account3(
            &SPL,
            &kp.pubkey(),
            &base,
            &s.authority,
        )
        .unwrap();
        env.ok(&[create, init], &[&kp]);
        kp.pubkey()
    };
    expect(
        env.send(&[with(5, &|m| m.pubkey = plain)], &[]),
        anchor(ErrorCode::AccountNotAssociatedTokenAccount),
        Some("escrow"),
    );
    let other_mint = env.create_spl_mint(6);
    for (owner, data, code) in [
        (
            SPL,
            token_account(&other_mint, &s.authority, 0),
            ErrorCode::ConstraintTokenMint,
        ),
        (
            SPL,
            token_account(&base, &o, 0),
            ErrorCode::ConstraintTokenOwner,
        ),
        (
            T22,
            token_account(&base, &s.authority, 0),
            ErrorCode::ConstraintAssociatedTokenTokenProgram,
        ),
    ] {
        put(&mut env, s.escrow, owner, data);
        expect(
            env.send(&[create_shield_ix(&payer, &s)], &[]),
            anchor(code),
            Some("escrow"),
        );
    }
    env.svm
        .set_account(s.escrow, solana_account::Account::default())
        .unwrap();
    // A token account at the address another token program would give the
    // escrow (none could be created there): the base mint's own token
    // program is still required.
    let mut wrong = s;
    wrong.base_token_program = T22;
    wrong.escrow = anchor_spl::associated_token::get_associated_token_address_with_program_id(
        &s.authority,
        &base,
        &T22,
    );
    put(
        &mut env,
        wrong.escrow,
        T22,
        token_account(&base, &s.authority, 0),
    );
    expect(
        env.send(&[create_shield_ix(&payer, &wrong)], &[]),
        anchor(ErrorCode::ConstraintMintTokenProgram),
        None,
    );

    // The zToken address must hold no account (lamports alone are fine).
    let in_use = shield(ShieldError::ZMintInUse);
    for (owner, data) in [(SYSTEM, vec![1, 2, 3]), (T22, vec![])] {
        put(&mut env, s.z_mint, owner, data);
        expect(env.send(&[create_shield_ix(&payer, &s)], &[]), in_use, None);
    }
    env.svm
        .set_account(s.z_mint, solana_account::Account::default())
        .unwrap();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
}

#[test]
fn refused_base_mints_are_logged() {
    let mut env = Env::new();
    let payer = env.payer.pubkey();
    for (exts, line) in [
        (
            vec![Ext::PermanentDelegate],
            "Program log: Base mint extension not accepted: PermanentDelegate",
        ),
        (
            vec![Ext::TransferFee { bps: 1, max: 1 }, Ext::ScaledUiAmount],
            "Program log: Base mint extension not accepted: ScaledUiAmount",
        ),
        (
            vec![Ext::PermissionedBurn],
            "Program log: Base mint has an extension type this program does not know",
        ),
    ] {
        let base = env.create_t22_mint(6, &exts);
        let s = ShieldKeys::new(base, T22);
        let result = env.send(&[create_shield_ix(&payer, &s)], &[]);
        let logs = match &result {
            Err(f) => f.meta.logs.clone(),
            Ok(_) => vec![],
        };
        expect(result, shield(ShieldError::UnsupportedExtension), None);
        assert!(logs.iter().any(|l| l == line), "{exts:?}: {logs:#?}");
    }
}

/// `wrap` and `unwrap` with one account or one `Shield` field changed.
#[test]
fn wrap_and_unwrap_account_checks() {
    let mut env = Env::new();
    let (s, user, user_base, user_z) = shield_with_user(&mut env);
    let u = user.pubkey();
    let other = env.create_spl_mint(6);
    let other_keys = ShieldKeys::new(other, SPL);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &other_keys)], &[]);
    let real_shield = env.svm.get_account(&s.shield).unwrap();
    let state = Shield::try_deserialize(&mut real_shield.data.as_slice()).unwrap();
    let encode = |v: &Shield| {
        let mut d = Vec::new();
        v.try_serialize(&mut d).unwrap();
        d
    };

    type Build = fn(&Pubkey, &ShieldKeys, &Pubkey, &Pubkey, u64, &[AccountMeta]) -> Instruction;
    for build in [wrap_ix as Build, unwrap_ix as Build] {
        let x = |k: &ShieldKeys, base: &Pubkey, z: &Pubkey| build(&u, k, base, z, 7, &[]);

        // Missing accounts, named after their fields.
        let names = [
            "user",
            "shield",
            "shield_authority",
            "base_mint",
            "z_mint",
            "escrow",
            "user_base",
            "user_z",
            "base_token_program",
            "token_2022_program",
        ];
        for (n, name) in names.iter().enumerate() {
            let mut i = x(&s, &user_base, &user_z);
            i.accounts.truncate(n);
            let signers: &[&Keypair] = if n == 0 { &[] } else { &[&user] };
            expect(
                env.send(&[i], signers),
                anchor(ErrorCode::AccountNotEnoughKeys),
                Some(name),
            );
        }

        let mut i = x(&s, &user_base, &user_z);
        i.accounts[0].is_signer = false;
        expect(
            env.send(&[i], &[]),
            anchor(ErrorCode::AccountNotSigner),
            Some("user"),
        );
        expect(
            env.send(&[build(&u, &s, &user_base, &user_z, 0, &[])], &[&user]),
            shield(ShieldError::ZeroAmount),
            None,
        );

        // The shield account: absent, foreign, and malformed.
        let mut absent = s;
        absent.shield = Pubkey::new_unique();
        expect(
            env.send(&[x(&absent, &user_base, &user_z)], &[&user]),
            anchor(ErrorCode::AccountNotInitialized),
            Some("shield"),
        );
        let mut foreign = s;
        foreign.shield = s.base_mint;
        expect(
            env.send(&[x(&foreign, &user_base, &user_z)], &[&user]),
            anchor(ErrorCode::AccountOwnedByWrongProgram),
            Some("shield"),
        );
        for (data, code) in [
            (vec![], ErrorCode::AccountDiscriminatorNotFound),
            (vec![1; 149], ErrorCode::AccountDiscriminatorMismatch),
            (
                encode(&state)[..148].to_vec(),
                ErrorCode::AccountDidNotDeserialize,
            ),
        ] {
            put(&mut env, s.shield, noised_shield::ID, data);
            expect(
                env.send(&[x(&s, &user_base, &user_z)], &[&user]),
                anchor(code),
                Some("shield"),
            );
        }

        // Shield fields no instruction writes: each constraint holds alone.
        let mut v = state.clone();
        v.bump = v.bump.wrapping_sub(1);
        put(&mut env, s.shield, noised_shield::ID, encode(&v));
        expect(
            env.send(&[x(&s, &user_base, &user_z)], &[&user]),
            anchor(ErrorCode::ConstraintSeeds),
            Some("shield"),
        );
        let mut v = state.clone();
        v.authority_bump = v.authority_bump.wrapping_sub(1);
        put(&mut env, s.shield, noised_shield::ID, encode(&v));
        expect(
            env.send(&[x(&s, &user_base, &user_z)], &[&user]),
            anchor(ErrorCode::ConstraintSeeds),
            Some("shield_authority"),
        );
        let fake_escrow = Pubkey::new_unique();
        let mut v = state.clone();
        v.escrow = fake_escrow;
        put(&mut env, s.shield, noised_shield::ID, encode(&v));
        let mut k = s;
        k.escrow = fake_escrow;
        for (owner, data, code) in [
            (
                SPL,
                token_account(&s.base_mint, &u, 0),
                ErrorCode::ConstraintTokenOwner,
            ),
            (
                SPL,
                token_account(&other, &s.authority, 0),
                ErrorCode::ConstraintTokenMint,
            ),
            (
                T22,
                token_account(&s.base_mint, &s.authority, 0),
                ErrorCode::ConstraintTokenTokenProgram,
            ),
        ] {
            put(&mut env, fake_escrow, owner, data);
            expect(
                env.send(&[x(&k, &user_base, &user_z)], &[&user]),
                anchor(code),
                Some("escrow"),
            );
        }
        let mut v = state.clone();
        v.z_mint = s.base_mint;
        put(&mut env, s.shield, noised_shield::ID, encode(&v));
        let mut k = s;
        k.z_mint = s.base_mint;
        let i = x(&k, &user_base, &user_z);
        expect(
            env.send(&[i], &[&user]),
            anchor(ErrorCode::ConstraintMintTokenProgram),
            None,
        );
        env.svm.set_account(s.shield, real_shield.clone()).unwrap();

        // has_one: the shield's own accounts only.
        for (k, name) in [
            (
                ShieldKeys {
                    base_token_program: T22,
                    ..s
                },
                "base_token_program",
            ),
            (
                ShieldKeys {
                    z_mint: other_keys.z_mint,
                    ..s
                },
                "z_mint",
            ),
            (
                ShieldKeys {
                    escrow: other_keys.escrow,
                    ..s
                },
                "escrow",
            ),
        ] {
            let result = env.send(&[x(&k, &user_base, &user_z)], &[&user]);
            let logs = match &result {
                Err(f) => f.meta.logs.join("\n"),
                Ok(_) => String::new(),
            };
            expect(result, anchor(ErrorCode::ConstraintHasOne), Some("shield"));
            assert!(logs.contains("Program log: Left:"), "{name}: {logs}");
        }
        expect(
            env.send(
                &[x(
                    &ShieldKeys {
                        base_mint: other,
                        ..s
                    },
                    &user_base,
                    &user_z,
                )],
                &[&user],
            ),
            anchor(ErrorCode::ConstraintSeeds),
            Some("shield"),
        );
        expect(
            env.send(
                &[x(&ShieldKeys { authority: u, ..s }, &user_base, &user_z)],
                &[&user],
            ),
            anchor(ErrorCode::ConstraintSeeds),
            Some("shield_authority"),
        );
        expect(
            env.send(
                &[x(
                    &ShieldKeys {
                        base_token_program: SYSTEM,
                        ..s
                    },
                    &user_base,
                    &user_z,
                )],
                &[&user],
            ),
            anchor(ErrorCode::InvalidProgramId),
            Some("base_token_program"),
        );
        let mut i = x(&s, &user_base, &user_z);
        i.accounts[9].pubkey = SPL;
        expect(
            env.send(&[i], &[&user]),
            anchor(ErrorCode::InvalidProgramId),
            Some("token_2022_program"),
        );

        // Writable accounts must be writable and distinct.
        for (i, name) in [
            (4, "z_mint"),
            (5, "escrow"),
            (6, "user_base"),
            (7, "user_z"),
        ] {
            let mut ix = x(&s, &user_base, &user_z);
            ix.accounts[i].is_writable = false;
            expect(
                env.send(&[ix], &[&user]),
                anchor(ErrorCode::ConstraintMut),
                Some(name),
            );
        }
        let duplicate = anchor(ErrorCode::ConstraintDuplicateMutableAccount);
        expect(
            env.send(&[x(&s, &s.escrow, &user_z)], &[&user]),
            duplicate,
            Some("user_base"),
        );
        expect(
            env.send(&[x(&s, &user_base, &user_base)], &[&user]),
            duplicate,
            Some("user_z"),
        );
        expect(
            env.send(&[x(&s, &user_z, &user_z)], &[&user]),
            duplicate,
            Some("user_z"),
        );

        // The user's token accounts: of the right mint and token program.
        expect(
            env.send(&[x(&s, &user_z, &user_base)], &[&user]),
            anchor(ErrorCode::ConstraintTokenMint),
            Some("user_base"),
        );
        let fake = Pubkey::new_unique();
        put(&mut env, fake, SPL, token_account(&s.base_mint, &u, 100));
        expect(
            env.send(&[x(&s, &user_base, &fake)], &[&user]),
            anchor(ErrorCode::ConstraintTokenMint),
            Some("user_z"),
        );
        put(&mut env, fake, T22, token_account(&s.base_mint, &u, 100));
        expect(
            env.send(&[x(&s, &fake, &user_z)], &[&user]),
            anchor(ErrorCode::ConstraintTokenTokenProgram),
            Some("user_base"),
        );
        put(&mut env, fake, SPL, token_account(&s.z_mint, &u, 100));
        expect(
            env.send(&[x(&s, &user_base, &fake)], &[&user]),
            anchor(ErrorCode::ConstraintTokenTokenProgram),
            Some("user_z"),
        );
    }

    // The escrow must hold the zToken supply after every instruction.
    let real_escrow = env.svm.get_account(&s.escrow).unwrap();
    put(
        &mut env,
        s.escrow,
        SPL,
        token_account(&s.base_mint, &s.authority, 0),
    );
    expect(
        env.send(&[wrap_ix(&u, &s, &user_base, &user_z, 3, &[])], &[&user]),
        shield(ShieldError::Undercollateralized),
        None,
    );
    env.svm.set_account(s.escrow, real_escrow).unwrap();
    env.ok(
        &[unwrap_ix(&u, &s, &user_base, &user_z, 1_000, &[])],
        &[&user],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 0);
}
