//! The account checks on accounts laid out as the runtime lays them out
//! (`HostAccount`): each Anchor account type and constraint returns
//! Anchor's error number and logs Anchor's line, in Anchor's order; `init`
//! makes the system program CPIs Anchor makes.

use anchor_lang::{error::ErrorCode, solana_program::system_instruction};
use noised_onchain::{
    accounts::{self, Accounts, ProgramAccount},
    error::anchor::*,
    host::{take_cpis, take_log_lines, HostAccount},
    ids::*,
    pda,
    sysvar::Rent,
    token, AccountView, Address, ErrorTable, Program, ProgramError, Seed, Signer,
};

const ID: Address = Address::new_from_array([42; 32]);

struct P;

impl Program for P {
    const ID: Address = ID;
    const ERRORS: ErrorTable = noised_onchain::error_table![
        CONSTRAINT_MUT,
        CONSTRAINT_HAS_ONE,
        CONSTRAINT_SIGNER,
        CONSTRAINT_RAW,
        CONSTRAINT_OWNER,
        CONSTRAINT_RENT_EXEMPT,
        CONSTRAINT_SEEDS,
        CONSTRAINT_EXECUTABLE,
        CONSTRAINT_ASSOCIATED,
        CONSTRAINT_CLOSE,
        CONSTRAINT_ADDRESS,
        CONSTRAINT_TOKEN_MINT,
        CONSTRAINT_TOKEN_OWNER,
        CONSTRAINT_SPACE,
        CONSTRAINT_TOKEN_TOKEN_PROGRAM,
        CONSTRAINT_MINT_TOKEN_PROGRAM,
        CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
        CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
        ACCOUNT_DISCRIMINATOR_NOT_FOUND,
        ACCOUNT_DISCRIMINATOR_MISMATCH,
        ACCOUNT_DID_NOT_DESERIALIZE,
        ACCOUNT_DID_NOT_SERIALIZE,
        ACCOUNT_NOT_ENOUGH_KEYS,
        ACCOUNT_OWNED_BY_WRONG_PROGRAM,
        INVALID_PROGRAM_ID,
        INVALID_PROGRAM_EXECUTABLE,
        ACCOUNT_NOT_SIGNER,
        ACCOUNT_NOT_SYSTEM_OWNED,
        ACCOUNT_NOT_INITIALIZED,
        TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
    ];
}

/// A program account: discriminator, then one `u64`.
#[derive(Debug, PartialEq)]
struct Counter(u64);

const COUNTER_DISCRIMINATOR: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

impl ProgramAccount for Counter {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = COUNTER_DISCRIMINATOR;
    fn try_read(data: &[u8]) -> Option<Self> {
        let v = data.get(8..16)?;
        Some(Self(u64::from_le_bytes(v.try_into().ok()?)))
    }
}

fn key(b: u8) -> Address {
    Address::new_from_array([b; 32])
}

struct Acc {
    address: Address,
    owner: Address,
    lamports: u64,
    data: Vec<u8>,
    signer: bool,
    writable: bool,
    executable: bool,
}

impl Acc {
    fn new(address: Address) -> Self {
        Self {
            address,
            owner: SYSTEM_PROGRAM_ID,
            lamports: 1_000_000,
            data: vec![],
            signer: false,
            writable: false,
            executable: false,
        }
    }
    fn owner(mut self, owner: Address) -> Self {
        self.owner = owner;
        self
    }
    fn lamports(mut self, lamports: u64) -> Self {
        self.lamports = lamports;
        self
    }
    fn data(mut self, data: &[u8]) -> Self {
        self.data = data.to_vec();
        self
    }
    fn signer(mut self) -> Self {
        self.signer = true;
        self
    }
    fn writable(mut self) -> Self {
        self.writable = true;
        self
    }
    fn executable(mut self) -> Self {
        self.executable = true;
        self
    }
    fn build(self) -> HostAccount {
        HostAccount::new(
            self.address,
            self.owner,
            self.lamports,
            &self.data,
            self.signer,
            self.writable,
            self.executable,
        )
    }
}

/// The line Anchor logs for `e` caused by account `name` (or none).
fn line(e: ErrorCode, name: Option<&str>) -> String {
    let origin = match name {
        Some(name) => format!("caused by account: {name}"),
        None => "occurred".to_string(),
    };
    format!(
        "Program log: AnchorError {origin}. Error Code: {}. Error Number: {}. Error Message: {}.",
        e.name(),
        u32::from(e),
        e
    )
}

fn keys(left: &Address, right: &Address) -> [String; 4] {
    [
        "Program log: Left:".to_string(),
        format!("Program log: {left}"),
        "Program log: Right:".to_string(),
        format!("Program log: {right}"),
    ]
}

fn views(accounts: &[HostAccount]) -> Vec<AccountView> {
    accounts.iter().map(HostAccount::view).collect()
}

/// `Signer`, `Program`, `Interface<TokenInterface>`, `SystemAccount`,
/// `UncheckedAccount` and the missing account, each with Anchor's error and
/// line.
#[test]
fn account_types_check_as_anchor_does() {
    let _ = take_log_lines();
    let accounts = [
        Acc::new(key(1)).signer().build(),
        Acc::new(SYSTEM_PROGRAM_ID).executable().build(),
        Acc::new(TOKEN_2022_PROGRAM_ID).executable().build(),
        Acc::new(key(4)).build(),
    ];
    let v = views(&accounts);
    let mut a = Accounts::<P>::new(&v);
    a.signer("payer").unwrap();
    a.program(&SYSTEM_PROGRAM_ID, "system_program").unwrap();
    a.token_program("token_program").unwrap();
    a.system_account("wallet").unwrap();
    assert_eq!(a.remaining().len(), 0);
    assert_eq!(
        a.unchecked("extra"),
        Err(ProgramError::Custom(ACCOUNT_NOT_ENOUGH_KEYS))
    );
    assert_eq!(a.next(None), Err(ProgramError::Custom(3005)));
    assert_eq!(
        take_log_lines(),
        [
            line(ErrorCode::AccountNotEnoughKeys, Some("extra")),
            line(ErrorCode::AccountNotEnoughKeys, None)
        ]
    );

    // Failures, one per type.
    let bad = [
        Acc::new(key(1)).build(),
        Acc::new(key(2)).executable().build(),
        Acc::new(SYSTEM_PROGRAM_ID).build(),
        Acc::new(key(3)).executable().build(),
        Acc::new(TOKEN_PROGRAM_ID).build(),
        Acc::new(key(5)).owner(ID).build(),
    ];
    let v = views(&bad);
    let mut a = Accounts::<P>::new(&v);
    assert_eq!(a.signer("payer"), Err(ProgramError::Custom(3010)));
    assert_eq!(
        a.program(&SYSTEM_PROGRAM_ID, "system_program"),
        Err(ProgramError::Custom(3008))
    );
    assert_eq!(
        a.program(&SYSTEM_PROGRAM_ID, "system_program"),
        Err(ProgramError::Custom(3009))
    );
    assert_eq!(
        a.token_program("token_program"),
        Err(ProgramError::Custom(3008))
    );
    assert_eq!(
        a.token_program("token_program"),
        Err(ProgramError::Custom(3009))
    );
    assert_eq!(a.system_account("wallet"), Err(ProgramError::Custom(3011)));
    let mut expected = vec![
        line(ErrorCode::AccountNotSigner, Some("payer")),
        line(ErrorCode::InvalidProgramId, Some("system_program")),
    ];
    expected.extend(keys(&key(2), &SYSTEM_PROGRAM_ID));
    expected.extend([
        line(ErrorCode::InvalidProgramExecutable, Some("system_program")),
        line(ErrorCode::InvalidProgramId, Some("token_program")),
        line(ErrorCode::InvalidProgramExecutable, Some("token_program")),
        line(ErrorCode::AccountNotSystemOwned, Some("wallet")),
    ]);
    assert_eq!(take_log_lines(), expected);

    // `Option<T>`: the program id means None.
    let optional = [Acc::new(ID).build(), Acc::new(key(9)).build()];
    let v = views(&optional);
    let mut a = Accounts::<P>::new(&v);
    assert!(a.optional(Some("a")).unwrap().is_none());
    assert!(a.optional(Some("b")).unwrap().is_some());
}

/// `Account<T>`: missing, wrong owner (with both keys), no discriminator,
/// another discriminator, fields that do not decode, then the fields.
#[test]
fn program_accounts_load_as_anchor_does() {
    let _ = take_log_lines();
    let mut good = COUNTER_DISCRIMINATOR.to_vec();
    good.extend_from_slice(&77u64.to_le_bytes());
    good.extend_from_slice(&[9; 3]); // ignored, as Borsh from a slice
    let mut other = good.clone();
    other[0] ^= 1;
    let cases: [(Acc, Result<u64, u32>); 6] = [
        (Acc::new(key(1)).lamports(0), Err(3012)),
        (Acc::new(key(1)).owner(key(7)).data(&good), Err(3007)),
        (Acc::new(key(1)).owner(ID).data(&good[..7]), Err(3001)),
        (Acc::new(key(1)).owner(ID).data(&other), Err(3002)),
        (Acc::new(key(1)).owner(ID).data(&good[..12]), Err(3003)),
        (Acc::new(key(1)).owner(ID).data(&good), Ok(77)),
    ];
    for (acc, want) in cases {
        let account = [acc.build()];
        let v = views(&account);
        let mut a = Accounts::<P>::new(&v);
        let got = a
            .account::<Counter>("counter")
            .map(|(_, c)| c.0)
            .map_err(|e| match e {
                ProgramError::Custom(n) => n,
                e => panic!("{e:?}"),
            });
        assert_eq!(got, want);
    }
    let logs = take_log_lines();
    assert_eq!(
        logs[0],
        line(ErrorCode::AccountNotInitialized, Some("counter"))
    );
    assert_eq!(
        logs[1],
        line(ErrorCode::AccountOwnedByWrongProgram, Some("counter"))
    );
    assert_eq!(logs[2..6], keys(&key(7), &ID));
    assert_eq!(
        logs[6..],
        [
            line(ErrorCode::AccountDiscriminatorNotFound, Some("counter")),
            line(ErrorCode::AccountDiscriminatorMismatch, Some("counter")),
            line(ErrorCode::AccountDidNotDeserialize, Some("counter")),
        ]
    );
}

/// The constraints: error number, line and compared keys or values.
#[test]
fn constraints_fail_as_anchor_does() {
    let _ = take_log_lines();
    let accounts = [
        Acc::new(key(1)).lamports(1).build(),
        Acc::new(key(2)).writable().signer().executable().build(),
    ];
    let v = views(&accounts);
    let (x, y) = (&v[0], &v[1]);
    let rent = Rent::new(3480, 2.0);
    let c = |r: Result<(), ProgramError>| match r {
        Err(ProgramError::Custom(n)) => n,
        other => panic!("{other:?}"),
    };
    assert_eq!(c(accounts::check_mut::<P>(x, "x")), 2000);
    assert_eq!(c(accounts::check_signer::<P>(x, "x")), 2002);
    assert_eq!(c(accounts::check_has_one::<P>(&key(9), y, "x")), 2001);
    assert_eq!(
        c(accounts::check_constraint::<P>(false, CONSTRAINT_RAW, "x")),
        2003
    );
    assert_eq!(c(accounts::check_owner::<P>(x, &ID, "x")), 2004);
    assert_eq!(c(accounts::check_rent_exempt::<P>(x, &rent, "x")), 2005);
    assert_eq!(c(accounts::check_executable::<P>(x, "x")), 2007);
    assert_eq!(c(accounts::check_close::<P>(x, x, "x")), 2011);
    assert_eq!(c(accounts::check_address::<P>(x, &key(8), "x")), 2012);
    assert_eq!(
        c(accounts::check_distinct::<P>(&[
            (x, "a"),
            (y, "b"),
            (x, "c")
        ])),
        2040
    );
    let mut expected = vec![
        line(ErrorCode::ConstraintMut, Some("x")),
        line(ErrorCode::ConstraintSigner, Some("x")),
        line(ErrorCode::ConstraintHasOne, Some("x")),
    ];
    expected.extend(keys(&key(9), &key(2)));
    expected.push(line(ErrorCode::ConstraintRaw, Some("x")));
    expected.push(line(ErrorCode::ConstraintOwner, Some("x")));
    expected.extend(keys(&SYSTEM_PROGRAM_ID, &ID));
    expected.extend([
        line(ErrorCode::ConstraintRentExempt, Some("x")),
        line(ErrorCode::ConstraintExecutable, Some("x")),
        line(ErrorCode::ConstraintClose, Some("x")),
        line(ErrorCode::ConstraintAddress, Some("x")),
    ]);
    expected.extend(keys(&key(1), &key(8)));
    expected.push(line(
        ErrorCode::ConstraintDuplicateMutableAccount,
        Some("c"),
    ));
    assert_eq!(take_log_lines(), expected);

    // Passing checks log nothing.
    accounts::check_mut::<P>(y, "y").unwrap();
    accounts::check_signer::<P>(y, "y").unwrap();
    accounts::check_has_one::<P>(&key(2), y, "y").unwrap();
    accounts::check_executable::<P>(y, "y").unwrap();
    accounts::check_close::<P>(x, y, "x").unwrap();
    accounts::check_distinct::<P>(&[(x, "a"), (y, "b")]).unwrap();
    assert!(take_log_lines().is_empty());
}

/// `seeds`: canonical bump by `find_program_address`, a stored bump by
/// `create_program_address`, an invalid bump, a wrong canonical bump.
#[test]
fn seeds_check_as_anchor_does() {
    let _ = take_log_lines();
    let seeds: [&[u8]; 2] = [b"counter", &[5; 32]];
    let (pda, bump) = Address::find_program_address(&seeds, &ID);
    let accounts = [Acc::new(pda).build(), Acc::new(key(3)).build()];
    let v = views(&accounts);
    assert_eq!(pda::check_seeds::<P>(&v[0], &seeds, &ID, "c"), Ok(bump));
    assert_eq!(
        pda::check_seeds_with_bump::<P>(&v[0], &[b"counter", &[5; 32], &[bump]], &ID, "c"),
        Ok(())
    );
    assert!(take_log_lines().is_empty());
    assert_eq!(
        pda::check_seeds::<P>(&v[1], &seeds, &ID, "c"),
        Err(ProgramError::Custom(2006))
    );
    let mut expected = vec![line(ErrorCode::ConstraintSeeds, Some("c"))];
    expected.extend(keys(&key(3), &pda));
    assert_eq!(take_log_lines(), expected);
    assert_eq!(
        pda::check_seeds_canonical_bump::<P>(&v[0], &seeds, &ID, bump.wrapping_sub(1), "c"),
        Err(ProgramError::Custom(2006))
    );
    assert_eq!(
        take_log_lines(),
        [
            line(ErrorCode::ConstraintSeeds, Some("c")),
            format!("Program log: Left: {bump}"),
            format!("Program log: Right: {}", bump.wrapping_sub(1)),
        ]
    );
    // A bump whose address is on the curve, if this one is (often): no keys.
    let invalid = (0..=255u8)
        .find(|b| Address::create_program_address(&[b"counter", &[5; 32], &[*b]], &ID).is_err());
    if let Some(b) = invalid {
        assert_eq!(
            pda::check_seeds_with_bump::<P>(&v[0], &[b"counter", &[5; 32], &[b]], &ID, "c"),
            Err(ProgramError::Custom(2006))
        );
        assert_eq!(
            take_log_lines(),
            [line(ErrorCode::ConstraintSeeds, Some("c"))]
        );
    }
}

/// `init`: `create_account` for an empty address; for a pre-funded one,
/// the payer check (4101, both keys), top-up, `allocate` and `assign`.
#[test]
fn init_makes_anchors_system_cpis() {
    let _ = take_log_lines();
    let _ = take_cpis();
    let rent = Rent::new(3480, 2.0);
    let space = 16;
    let payer = Acc::new(key(1)).signer().writable().build();
    let fresh = Acc::new(key(2)).lamports(0).writable().build();
    let (p, f) = (payer.view(), fresh.view());
    let seeds = [Seed::from(b"x".as_ref())];
    let signers = [Signer::from(&seeds)];
    // The runtime would create the account; on the host it stays empty,
    // which the checks after the CPI report (no account named).
    assert_eq!(
        accounts::init_program_account::<P>(&p, &f, space, &rent, &signers, "c"),
        Err(ProgramError::Custom(3012))
    );
    let cpis = take_cpis();
    assert_eq!(cpis.len(), 1);
    let ix = system_instruction::create_account(
        &key(1),
        &key(2),
        rent.minimum_balance(space),
        space as u64,
        &ID,
    );
    assert_eq!(cpis[0].data, ix.data);
    assert_eq!(cpis[0].signers, 1);
    assert_eq!(
        take_log_lines(),
        [line(ErrorCode::AccountNotInitialized, None)]
    );

    // Pre-funded with 1 lamport.
    let funded = Acc::new(key(3)).lamports(1).writable().build();
    let fv = funded.view();
    let _ = accounts::init_program_account::<P>(&p, &fv, space, &rent, &signers, "c");
    let cpis = take_cpis();
    let expected = [
        system_instruction::transfer(&key(1), &key(3), rent.minimum_balance(space) - 1),
        system_instruction::allocate(&key(3), space as u64),
        system_instruction::assign(&key(3), &ID),
    ];
    assert_eq!(cpis.len(), 3);
    for (cpi, ix) in cpis.iter().zip(&expected) {
        assert_eq!(cpi.data, ix.data);
        let metas: Vec<(Address, bool, bool)> = ix
            .accounts
            .iter()
            .map(|m| (m.pubkey, m.is_signer, m.is_writable))
            .collect();
        assert_eq!(cpi.accounts, metas);
    }
    assert_eq!(
        [cpis[0].signers, cpis[1].signers, cpis[2].signers],
        [0, 1, 1]
    );
    let _ = take_log_lines();

    // The payer as the account: 4101 with both keys, no CPI.
    assert_eq!(
        accounts::init_program_account::<P>(&p, &p, space, &rent, &signers, "c"),
        Err(ProgramError::Custom(4101))
    );
    assert!(take_cpis().is_empty());
    let mut want = vec![line(ErrorCode::TryingToInitPayerAsProgramAccount, None)];
    want.extend(keys(&key(1), &key(1)));
    assert_eq!(take_log_lines(), want);

    // Already created (as the runtime leaves it): then `mut`.
    let created = Acc::new(key(4))
        .owner(ID)
        .lamports(rent.minimum_balance(space))
        .data(&[0; 16])
        .build();
    let cv = created.view();
    // An account with lamports that the program owns already: the CPIs
    // would fail on-chain; here they are recorded and the checks pass up
    // to `mut`.
    assert_eq!(
        accounts::init_program_account::<P>(&p, &cv, space, &rent, &signers, "c"),
        Err(ProgramError::Custom(2000))
    );
    assert_eq!(
        take_log_lines(),
        [line(ErrorCode::ConstraintMut, Some("c"))]
    );
}

/// `init_if_needed`: an existing account is loaded (no account named),
/// then space (values), owner and rent are checked, each named.
#[test]
fn init_if_needed_checks_an_existing_account() {
    let _ = take_log_lines();
    let _ = take_cpis();
    let rent = Rent::new(3480, 2.0);
    let payer = Acc::new(key(1)).signer().writable().build();
    let mut data = COUNTER_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&5u64.to_le_bytes());
    let ok = Acc::new(key(2))
        .owner(ID)
        .writable()
        .lamports(rent.minimum_balance(16))
        .data(&data)
        .build();
    let got = accounts::init_if_needed_program_account::<P, Counter>(
        &payer.view(),
        &ok.view(),
        16,
        &rent,
        &[],
        "c",
    );
    assert_eq!(got, Ok(Some(Counter(5))));
    assert!(take_cpis().is_empty() && take_log_lines().is_empty());

    let wrong_space = accounts::init_if_needed_program_account::<P, Counter>(
        &payer.view(),
        &ok.view(),
        24,
        &rent,
        &[],
        "c",
    );
    assert_eq!(wrong_space, Err(ProgramError::Custom(2019)));
    assert_eq!(
        take_log_lines(),
        [
            line(ErrorCode::ConstraintSpace, Some("c")),
            "Program log: Left: 24".to_string(),
            "Program log: Right: 16".to_string(),
        ]
    );

    let poor = Acc::new(key(3))
        .owner(ID)
        .writable()
        .lamports(1)
        .data(&data)
        .build();
    assert_eq!(
        accounts::init_if_needed_program_account::<P, Counter>(
            &payer.view(),
            &poor.view(),
            16,
            &rent,
            &[],
            "c"
        ),
        Err(ProgramError::Custom(2005))
    );
    let foreign = Acc::new(key(4))
        .owner(key(8))
        .writable()
        .data(&data)
        .build();
    assert_eq!(
        accounts::init_if_needed_program_account::<P, Counter>(
            &payer.view(),
            &foreign.view(),
            16,
            &rent,
            &[],
            "c"
        ),
        Err(ProgramError::Custom(3007))
    );
    let logs = take_log_lines();
    assert_eq!(logs[0], line(ErrorCode::ConstraintRentExempt, Some("c")));
    assert_eq!(logs[1], line(ErrorCode::AccountOwnedByWrongProgram, None));
}

/// Exit: write back (skipped once closed, 3004 when too short) and close.
#[test]
fn exit_writes_back_and_closes() {
    let _ = take_log_lines();
    let account = Acc::new(key(1))
        .owner(ID)
        .lamports(500)
        .data(&[0; 16])
        .build();
    let destination = Acc::new(key(2)).lamports(u64::MAX - 500).build();
    let (a, d) = (account.view(), destination.view());
    accounts::write_back::<P, 16>(&a, "c", |data| data[0] = 7).unwrap();
    assert_eq!(account.data()[0], 7);
    assert_eq!(
        accounts::write_back::<P, 17>(&a, "c", |_| {}),
        Err(ProgramError::Custom(3004))
    );
    assert_eq!(
        take_log_lines(),
        [line(ErrorCode::AccountDidNotSerialize, Some("c"))]
    );
    accounts::close(&a, &d).unwrap();
    assert_eq!((d.lamports(), a.lamports()), (u64::MAX, 0));
    assert_eq!((a.owner(), a.data_len()), (&SYSTEM_PROGRAM_ID, 0));
    // Closed: nothing written.
    accounts::write_back::<P, 16>(&a, "c", |_| panic!("written")).unwrap();
    // Overflow of the destination's balance.
    let other = Acc::new(key(3)).owner(ID).lamports(1).build();
    assert_eq!(
        accounts::close(&other.view(), &d),
        Err(ProgramError::ArithmeticOverflow)
    );
}

/// Token accounts and mints as `InterfaceAccount`s, and the `token::` /
/// `associated_token::` constraints.
#[test]
fn token_accounts_check_as_anchor_does() {
    let _ = take_log_lines();
    let mut mint = vec![0u8; 82];
    mint[44] = 6; // decimals
    mint[45] = 1; // initialized
    let wallet = key(5);
    let ata = token::associated_token_address(&wallet, &key(1), &TOKEN_PROGRAM_ID);
    let mut account = vec![0u8; 165];
    account[..32].copy_from_slice(key(1).as_ref());
    account[32..64].copy_from_slice(wallet.as_ref());
    account[64..72].copy_from_slice(&9u64.to_le_bytes());
    account[108] = 1;
    let hosts = [
        Acc::new(key(1)).owner(TOKEN_PROGRAM_ID).data(&mint).build(),
        Acc::new(ata).owner(TOKEN_PROGRAM_ID).data(&account).build(),
        Acc::new(wallet).build(),
        Acc::new(TOKEN_PROGRAM_ID).executable().build(),
        Acc::new(key(6)).lamports(0).build(),
        Acc::new(key(7)).owner(key(9)).data(&account).build(),
    ];
    let v = views(&hosts);
    let mut a = Accounts::<P>::new(&v);
    let (mint_view, decimals) = a.mint("mint").unwrap();
    assert_eq!(decimals, 6);
    let (ata_view, state) = a.token_account("ata").unwrap();
    assert_eq!(
        state,
        token::TokenAccount {
            mint: key(1),
            owner: wallet,
            amount: 9
        }
    );
    let authority = a.unchecked("authority").unwrap();
    let token_program = a.token_program("token_program").unwrap();
    token::check_mint_token_program::<P>(mint_view, token_program).unwrap();
    token::check_token_mint::<P>(&state, &key(1), "ata").unwrap();
    token::check_token_authority::<P>(&state, &wallet, "ata").unwrap();
    token::check_token_token_program::<P>(ata_view, token_program, "ata").unwrap();
    token::check_associated_token_account::<P>(
        ata_view,
        &state,
        authority,
        mint_view,
        token_program,
        "ata",
    )
    .unwrap();
    assert!(take_log_lines().is_empty());

    assert_eq!(
        a.token_account("missing").map(|_| ()),
        Err(ProgramError::Custom(3012))
    );
    assert_eq!(
        a.token_account("foreign").map(|_| ()),
        Err(ProgramError::Custom(3007))
    );
    assert_eq!(
        token::check_token_mint::<P>(&state, &key(2), "ata"),
        Err(ProgramError::Custom(2014))
    );
    assert_eq!(
        token::check_associated_token_account::<P>(
            ata_view,
            &state,
            mint_view,
            mint_view,
            token_program,
            "ata",
        ),
        Err(ProgramError::Custom(2015))
    );
    let logs = take_log_lines();
    assert_eq!(
        logs[0],
        line(ErrorCode::AccountNotInitialized, Some("missing"))
    );
    assert_eq!(
        logs[1],
        line(ErrorCode::AccountOwnedByWrongProgram, Some("foreign"))
    );
    assert_eq!(logs[2], line(ErrorCode::ConstraintTokenMint, Some("ata")));
    assert_eq!(logs[3..7], keys(&key(1), &key(2)));
    assert_eq!(logs[7], line(ErrorCode::ConstraintTokenOwner, Some("ata")));
    assert_eq!(logs[8..12], keys(&wallet, &key(1)));
}

/// `invoke` checks the borrow state of the instruction's accounts first, as
/// solana-cpi 3.1's `invoke_signed` does (review L-1): a writable account
/// must not be borrowed at all, a read-only one not mutably; otherwise
/// `AccountBorrowFailed` and no CPI. Accounts the instruction does not name
/// are not checked.
#[test]
fn invoke_refuses_borrowed_instruction_accounts() {
    use noised_onchain::{cpi, pinocchio::instruction::InstructionAccount};
    let _ = take_cpis();
    let from = Acc::new(key(1)).signer().writable().build();
    let to = Acc::new(key(2)).owner(key(9)).writable().data(&[7; 16]).build();
    let other = Acc::new(key(3)).owner(key(9)).data(&[1; 4]).build();
    let (from_v, to_v, other_v) = (from.view(), to.view(), other.view());

    // A live `Ref` of a writable account (a balance read "before" the CPI).
    let held = to_v.try_borrow().unwrap();
    assert_eq!(
        cpi::transfer(&from_v, &to_v, 1, &[]),
        Err(ProgramError::AccountBorrowFailed)
    );
    assert!(take_cpis().is_empty(), "no CPI was made");
    drop(held);
    // Through a second view of the same account (a duplicate): one state.
    let mut dup = to.view();
    let held = dup.try_borrow_mut().unwrap();
    assert_eq!(
        cpi::transfer(&from_v, &to_v, 1, &[]),
        Err(ProgramError::AccountBorrowFailed)
    );
    drop(held);
    assert_eq!(cpi::transfer(&from_v, &to_v, 1, &[]), Ok(()));
    assert_eq!(take_cpis().len(), 1);

    // A read-only account may be shared-borrowed, not mutably borrowed.
    let metas = [
        InstructionAccount::writable(to_v.address()),
        InstructionAccount::readonly(other_v.address()),
    ];
    let infos = [&to_v, &other_v];
    let shared = other_v.try_borrow().unwrap();
    assert_eq!(cpi::invoke(&key(9), &metas, &[], &infos, &[]), Ok(()));
    drop(shared);
    let mut writer = other.view();
    let held = writer.try_borrow_mut().unwrap();
    assert_eq!(
        cpi::invoke(&key(9), &metas, &[], &infos, &[]),
        Err(ProgramError::AccountBorrowFailed)
    );
    // Not an instruction account: not checked.
    assert_eq!(cpi::invoke(&key(9), &metas[..1], &[], &infos, &[]), Ok(()));
    drop(held);
    assert_eq!(take_cpis().len(), 2);
}
