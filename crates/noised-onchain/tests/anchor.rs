//! The framework parts against anchor-lang 1.2.1 itself: the error table
//! and Anchor's log lines, discriminators and events, dispatch, Borsh
//! argument decoding / encoding, and the rent and clock sysvars.

use anchor_lang::{
    error::ErrorCode, prelude::Pubkey, AnchorDeserialize, AnchorSerialize, Discriminator, Event,
};
use noised_onchain::{
    args::{self, Reader, Writer},
    error::{self, anchor::*, fail, fail_keys, fail_values, raise, ANCHOR_ERRORS},
    event,
    host::{self, fuzz::Rng, take_log_lines},
    sysvar::{Clock, Rent, CLOCK_ID, INSTRUCTIONS_ID, RENT_ID},
    Address, ErrorTable, Program, ProgramError,
};

anchor_lang::declare_id!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");

noised_onchain::custom_errors! {
    /// Errors of the test program.
    pub enum TestError {
        /// 6000
        First = "The first error",
        /// 6001
        Second = "The second error",
    }
}

noised_onchain::custom_errors! {
    offset = 7000;
    pub enum OffsetError {
        Only = "Numbered from 7000",
    }
}

/// A program with a few framework errors and its own.
struct TestProgram;

impl Program for TestProgram {
    const ID: Address = ID;
    const ERRORS: ErrorTable = noised_onchain::error_table![
        INSTRUCTION_FALLBACK_NOT_FOUND,
        INSTRUCTION_DID_NOT_DESERIALIZE,
        EVENT_INSTRUCTION_STUB,
        DECLARED_PROGRAM_ID_MISMATCH,
        CONSTRAINT_SEEDS,
        CONSTRAINT_SPACE,
        ACCOUNT_NOT_SIGNER;
        TestError::ERRORS
    ];
}

fn every_error_code() -> Vec<ErrorCode> {
    vec![
        ErrorCode::InstructionMissing,
        ErrorCode::InstructionFallbackNotFound,
        ErrorCode::InstructionDidNotDeserialize,
        ErrorCode::InstructionDidNotSerialize,
        ErrorCode::IdlInstructionStub,
        ErrorCode::IdlInstructionInvalidProgram,
        ErrorCode::IdlAccountNotEmpty,
        ErrorCode::EventInstructionStub,
        ErrorCode::ConstraintMut,
        ErrorCode::ConstraintHasOne,
        ErrorCode::ConstraintSigner,
        ErrorCode::ConstraintRaw,
        ErrorCode::ConstraintOwner,
        ErrorCode::ConstraintRentExempt,
        ErrorCode::ConstraintSeeds,
        ErrorCode::ConstraintExecutable,
        ErrorCode::ConstraintState,
        ErrorCode::ConstraintAssociated,
        ErrorCode::ConstraintAssociatedInit,
        ErrorCode::ConstraintClose,
        ErrorCode::ConstraintAddress,
        ErrorCode::ConstraintZero,
        ErrorCode::ConstraintTokenMint,
        ErrorCode::ConstraintTokenOwner,
        ErrorCode::ConstraintMintMintAuthority,
        ErrorCode::ConstraintMintFreezeAuthority,
        ErrorCode::ConstraintMintDecimals,
        ErrorCode::ConstraintSpace,
        ErrorCode::ConstraintAccountIsNone,
        ErrorCode::ConstraintTokenTokenProgram,
        ErrorCode::ConstraintMintTokenProgram,
        ErrorCode::ConstraintAssociatedTokenTokenProgram,
        ErrorCode::ConstraintMintGroupPointerExtension,
        ErrorCode::ConstraintMintGroupPointerExtensionAuthority,
        ErrorCode::ConstraintMintGroupPointerExtensionGroupAddress,
        ErrorCode::ConstraintMintGroupMemberPointerExtension,
        ErrorCode::ConstraintMintGroupMemberPointerExtensionAuthority,
        ErrorCode::ConstraintMintGroupMemberPointerExtensionMemberAddress,
        ErrorCode::ConstraintMintMetadataPointerExtension,
        ErrorCode::ConstraintMintMetadataPointerExtensionAuthority,
        ErrorCode::ConstraintMintMetadataPointerExtensionMetadataAddress,
        ErrorCode::ConstraintMintCloseAuthorityExtension,
        ErrorCode::ConstraintMintCloseAuthorityExtensionAuthority,
        ErrorCode::ConstraintMintPermanentDelegateExtension,
        ErrorCode::ConstraintMintPermanentDelegateExtensionDelegate,
        ErrorCode::ConstraintMintTransferHookExtension,
        ErrorCode::ConstraintMintTransferHookExtensionAuthority,
        ErrorCode::ConstraintMintTransferHookExtensionProgramId,
        ErrorCode::ConstraintDuplicateMutableAccount,
        ErrorCode::AccountAlreadyMigrated,
        ErrorCode::AccountNotMigrated,
        ErrorCode::ConstraintMintPausableExtension,
        ErrorCode::ConstraintMintPausableAuthority,
        ErrorCode::RequireViolated,
        ErrorCode::RequireEqViolated,
        ErrorCode::RequireKeysEqViolated,
        ErrorCode::RequireNeqViolated,
        ErrorCode::RequireKeysNeqViolated,
        ErrorCode::RequireGtViolated,
        ErrorCode::RequireGteViolated,
        ErrorCode::AccountDiscriminatorAlreadySet,
        ErrorCode::AccountDiscriminatorNotFound,
        ErrorCode::AccountDiscriminatorMismatch,
        ErrorCode::AccountDidNotDeserialize,
        ErrorCode::AccountDidNotSerialize,
        ErrorCode::AccountNotEnoughKeys,
        ErrorCode::AccountNotMutable,
        ErrorCode::AccountOwnedByWrongProgram,
        ErrorCode::InvalidProgramId,
        ErrorCode::InvalidProgramExecutable,
        ErrorCode::AccountNotSigner,
        ErrorCode::AccountNotSystemOwned,
        ErrorCode::AccountNotInitialized,
        ErrorCode::AccountNotProgramData,
        ErrorCode::AccountNotAssociatedTokenAccount,
        ErrorCode::AccountSysvarMismatch,
        ErrorCode::AccountReallocExceedsLimit,
        ErrorCode::AccountDuplicateReallocs,
        ErrorCode::DeclaredProgramIdMismatch,
        ErrorCode::TryingToInitPayerAsProgramAccount,
        ErrorCode::InvalidNumericConversion,
        ErrorCode::Deprecated,
    ]
}

// --------------------------------------------------------------- errors

/// `ANCHOR_ERRORS` and the `anchor` constants are anchor-lang 1.2.1's
/// `ErrorCode`: every variant, its number, name and message.
#[test]
fn the_framework_table_is_anchors() {
    let all = every_error_code();
    assert_eq!(all.len(), ANCHOR_ERRORS.len());
    for (e, (code, name, message)) in all.iter().zip(ANCHOR_ERRORS) {
        assert_eq!(u32::from(*e), code, "{e:?}");
        assert_eq!(e.name(), name, "{e:?}");
        assert_eq!(e.to_string(), message, "{e:?}");
        assert_eq!(error::anchor_entry(code), (code, name, message));
    }
    // A few constants by name.
    for (ours, theirs) in [
        (CONSTRAINT_SEEDS, ErrorCode::ConstraintSeeds),
        (ACCOUNT_NOT_INITIALIZED, ErrorCode::AccountNotInitialized),
        (
            CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
            ErrorCode::ConstraintDuplicateMutableAccount,
        ),
        (ACCOUNT_NOT_ENOUGH_KEYS, ErrorCode::AccountNotEnoughKeys),
        (
            TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
            ErrorCode::TryingToInitPayerAsProgramAccount,
        ),
        (ACCOUNT_NOT_SYSTEM_OWNED, ErrorCode::AccountNotSystemOwned),
        (CONSTRAINT_SPACE, ErrorCode::ConstraintSpace),
        (CONSTRAINT_OWNER, ErrorCode::ConstraintOwner),
        (CONSTRAINT_EXECUTABLE, ErrorCode::ConstraintExecutable),
        (CONSTRAINT_RAW, ErrorCode::ConstraintRaw),
        (CONSTRAINT_SIGNER, ErrorCode::ConstraintSigner),
        (REQUIRE_KEYS_EQ_VIOLATED, ErrorCode::RequireKeysEqViolated),
    ] {
        assert_eq!(ours, u32::from(theirs));
    }
    assert_eq!(
        error::ERROR_CODE_OFFSET,
        anchor_lang::error::ERROR_CODE_OFFSET
    );
}

/// A program's table holds exactly the selected numbers, each with its
/// name, decimal number and message; nothing else.
#[test]
fn a_program_table_packs_its_selection() {
    let table = TestProgram::ERRORS;
    let numbers: Vec<u32> = table.numbers().collect();
    assert_eq!(
        numbers,
        [101, 102, 1500, 4100, 2006, 2019, 3010, 6000, 6001]
    );
    for code in table.numbers() {
        let [name, number, message] = table.describe(code);
        assert_eq!(number, code.to_string().as_bytes());
        let (n, m) = table.name_and_message(code);
        assert_eq!((name, message), (n.as_bytes(), m.as_bytes()));
        if code < 6000 {
            let (_, an, am) = error::anchor_entry(code);
            assert_eq!((n, m), (an, am));
        }
    }
    assert_eq!(table.describe(2000), [b"" as &[u8]; 3]);
    assert_eq!(table.name_and_message(6001), ("Second", "The second error"));
}

#[test]
fn custom_errors_number_from_their_offset() {
    assert_eq!(TestError::First.code(), 6000);
    assert_eq!(u32::from(TestError::Second), 6001);
    assert_eq!(TestError::Second.name(), "Second");
    assert_eq!(TestError::Second.message(), "The second error");
    assert_eq!(TestError::First.to_string(), "The first error");
    assert_eq!(format!("{:?}", TestError::First), "First");
    assert_eq!(
        TestError::ERRORS,
        [
            (6000, "First", "The first error"),
            (6001, "Second", "The second error")
        ]
    );
    assert_eq!(OffsetError::Only.code(), 7000);
    assert_eq!(OffsetError::OFFSET, 7000);
}

/// The log lines are anchor-lang's `AnchorError::log` lines, byte for byte:
/// with and without an account, and the compared pubkeys or values.
#[test]
fn log_lines_are_anchors() {
    let _ = take_log_lines();
    let anchor_line = |origin: &str, e: ErrorCode| {
        format!(
            "Program log: AnchorError {origin}. Error Code: {}. Error Number: {}. Error Message: {}.",
            e.name(),
            u32::from(e),
            e
        )
    };

    let err = fail::<TestProgram>(CONSTRAINT_SEEDS, Some("vault"));
    assert_eq!(err, ProgramError::Custom(2006));
    assert_eq!(
        take_log_lines(),
        [anchor_line(
            "caused by account: vault",
            ErrorCode::ConstraintSeeds
        )]
    );

    assert_eq!(
        raise::<TestProgram>(INSTRUCTION_FALLBACK_NOT_FOUND),
        ProgramError::Custom(101)
    );
    assert_eq!(
        take_log_lines(),
        [anchor_line(
            "occurred",
            ErrorCode::InstructionFallbackNotFound
        )]
    );

    let (left, right) = (Pubkey::new_unique(), Pubkey::new_unique());
    fail_keys::<TestProgram>(ACCOUNT_NOT_SIGNER, Some("payer"), &left, &right);
    assert_eq!(
        take_log_lines(),
        [
            anchor_line("caused by account: payer", ErrorCode::AccountNotSigner),
            "Program log: Left:".to_string(),
            format!("Program log: {left}"),
            "Program log: Right:".to_string(),
            format!("Program log: {right}"),
        ]
    );

    fail_values::<TestProgram>(CONSTRAINT_SPACE, Some("record"), 0, u64::MAX);
    assert_eq!(
        take_log_lines(),
        [
            anchor_line("caused by account: record", ErrorCode::ConstraintSpace),
            "Program log: Left: 0".to_string(),
            format!("Program log: Right: {}", u64::MAX),
        ]
    );

    raise::<TestProgram>(TestError::Second.code());
    assert_eq!(
        take_log_lines(),
        ["Program log: AnchorError occurred. Error Code: Second. Error Number: 6001. Error Message: The second error."]
    );
}

/// `try_entry` / `dispatch`: the declared id, the discriminator, the
/// event-CPI stub and the fallback.
#[test]
fn dispatch_is_anchors() {
    let _ = take_log_lines();
    let other = Address::new_from_array([7; 32]);
    assert_eq!(
        args::instruction::<TestProgram>(&other, &[0; 8]).unwrap_err(),
        ProgramError::Custom(4100)
    );
    assert_eq!(
        args::instruction::<TestProgram>(&ID, &[1, 2, 3]).unwrap_err(),
        ProgramError::Custom(101)
    );
    let data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let (tag, rest) = args::instruction::<TestProgram>(&ID, &data).unwrap();
    assert_eq!((tag, rest), (&[1, 2, 3, 4, 5, 6, 7, 8], &[9u8, 10][..]));
    assert_eq!(
        args::unknown::<TestProgram>(&event::EVENT_IX_TAG_LE),
        ProgramError::Custom(1500)
    );
    assert_eq!(
        args::unknown::<TestProgram>(&[0; 8]),
        ProgramError::Custom(101)
    );
    assert_eq!(event::EVENT_IX_TAG_LE, anchor_lang::event::EVENT_IX_TAG_LE);
    assert_eq!(take_log_lines().len(), 4);
    // Arguments: `None` is InstructionDidNotDeserialize, no account named.
    assert_eq!(
        args::decode::<TestProgram, _>(&[1, 2, 3, 4, 9], |r| r.u32()),
        Ok(0x0403_0201)
    );
    assert_eq!(
        args::decode::<TestProgram, _>(&[1, 2], |r| r.u32()),
        Err(ProgramError::Custom(102))
    );
    assert_eq!(
        take_log_lines(),
        ["Program log: AnchorError occurred. Error Code: InstructionDidNotDeserialize. Error Number: 102. Error Message: The program could not deserialize the given instruction."]
    );
}

// ------------------------------------------------- discriminators, events

/// An account type as Anchor declares it.
#[anchor_lang::account]
pub struct SampleAccount {
    pub owner: Pubkey,
    pub amount: u64,
}

/// An event as Anchor declares it.
#[anchor_lang::event]
pub struct SampleEvent {
    pub owner: Pubkey,
    pub amount: u64,
    pub flag: bool,
    pub memo: String,
    pub extra: Option<u32>,
}

#[test]
fn discriminators_and_events_are_anchors() {
    assert_eq!(
        host::discriminator("account", "SampleAccount"),
        SampleAccount::DISCRIMINATOR
    );
    assert_eq!(
        host::discriminator("event", "SampleEvent"),
        SampleEvent::DISCRIMINATOR
    );
    let mut r = Rng(9);
    for _ in 0..1_000 {
        let e = SampleEvent {
            owner: r.key(),
            amount: r.next(),
            flag: r.chance(50),
            memo: "x".repeat(r.below(20) as usize),
            extra: r.chance(50).then(|| r.next() as u32),
        };
        let mut w = Writer::with_discriminator(&host::discriminator("event", "SampleEvent"), 64);
        w.address(&e.owner)
            .u64(e.amount)
            .bool(e.flag)
            .bytes(e.memo.as_bytes())
            .option_tag(e.extra.is_some());
        if let Some(x) = e.extra {
            w.u32(x);
        }
        assert_eq!(w.as_slice(), e.data());
        let _ = take_log_lines();
        event::emit(w.as_slice());
        assert_eq!(
            take_log_lines(),
            [format!("Program data: {}", host::base64(&e.data()))]
        );
    }
}

/// `host::deserialize` is `AccountDeserialize::try_deserialize`.
#[test]
fn host_deserialize_is_anchors() {
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    struct Ours(SampleAccount);
    impl noised_onchain::accounts::ProgramAccount for Ours {
        const ACCOUNT_DISCRIMINATOR: [u8; 8] = match SampleAccount::DISCRIMINATOR {
            [a, b, c, d, e, f, g, h] => [*a, *b, *c, *d, *e, *f, *g, *h],
            _ => panic!("8 bytes"),
        };
        fn try_read(data: &[u8]) -> Option<Self> {
            let mut r = Reader::new(data.get(8..)?);
            Some(Self(SampleAccount {
                owner: r.address()?,
                amount: r.u64()?,
            }))
        }
    }
    let mut r = Rng(10);
    for _ in 0..1_000 {
        let account = SampleAccount {
            owner: r.key(),
            amount: r.next(),
        };
        let mut data = Vec::new();
        account.try_serialize(&mut data).unwrap();
        match r.below(4) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data[r.below(8) as usize] ^= 1,
            2 => data.extend(r.some_bytes(9)),
            _ => {}
        }
        let theirs = SampleAccount::try_deserialize(&mut &data[..]);
        let ours = host::deserialize::<Ours>(&data);
        match (theirs, ours) {
            (Ok(t), Ok(o)) => assert_eq!((t.owner, t.amount), (o.0.owner, o.0.amount)),
            (Err(t), Err(o)) => {
                let code = match o {
                    host::DecodeError::DiscriminatorNotFound => 3001,
                    host::DecodeError::DiscriminatorMismatch => 3002,
                    host::DecodeError::DidNotDeserialize => 3003,
                };
                assert_eq!(ProgramError::from(t), ProgramError::Custom(code));
            }
            (t, o) => panic!("{:?} vs {:?}", t.is_ok(), o.is_ok()),
        }
    }
}

// ---------------------------------------------------------------- Borsh

/// Arguments as Anchor's instruction structs derive them.
#[derive(AnchorSerialize, AnchorDeserialize, Debug, PartialEq)]
struct Args {
    a: u8,
    b: u16,
    c: u32,
    d: u64,
    e: u128,
    f: i64,
    g: bool,
    h: Pubkey,
    i: Vec<u8>,
    j: String,
    k: Option<u32>,
    l: [u8; 5],
    m: i8,
    n: i16,
    o: i32,
    p: i128,
}

fn read(data: &[u8]) -> Option<Args> {
    let mut r = Reader::new(data);
    Some(Args {
        a: r.u8()?,
        b: r.u16()?,
        c: r.u32()?,
        d: r.u64()?,
        e: r.u128()?,
        f: r.i64()?,
        g: r.bool()?,
        h: r.address()?,
        i: r.bytes()?.to_vec(),
        j: r.str()?.to_string(),
        k: r.option(|r| r.u32())?,
        l: *r.array::<5>()?,
        m: r.i8()?,
        n: r.i16()?,
        o: r.i32()?,
        p: r.i128()?,
    })
}

/// `Reader` decodes as Borsh does from a slice (trailing bytes ignored, any
/// malformed or short input fails), and `Writer` encodes as Borsh.
#[test]
fn borsh_reader_and_writer_match_borsh() {
    let mut r = Rng(12);
    let (mut ok, mut failed) = (0, 0);
    for round in 0..50_000 {
        let args = Args {
            a: r.byte(),
            b: r.next() as u16,
            c: r.next() as u32,
            d: r.next(),
            e: u128::from(r.next()) << 64 | u128::from(r.next()),
            f: r.next() as i64,
            g: r.chance(50),
            h: r.key(),
            i: r.some_bytes(20),
            j: "é".repeat(r.below(5) as usize),
            k: r.chance(50).then(|| r.next() as u32),
            l: r.array(),
            m: r.byte() as i8,
            n: r.next() as i16,
            o: r.next() as i32,
            p: r.next() as i128,
        };
        let mut data = Vec::new();
        args.serialize(&mut data).unwrap();
        let mut w = Writer::default();
        w.u8(args.a)
            .u16(args.b)
            .u32(args.c)
            .u64(args.d)
            .u128(args.e)
            .i64(args.f)
            .bool(args.g)
            .address(&args.h)
            .bytes(&args.i)
            .bytes(args.j.as_bytes())
            .option_tag(args.k.is_some());
        if let Some(k) = args.k {
            w.u32(k);
        }
        w.put(&args.l)
            .u8(args.m as u8)
            .u16(args.n as u16)
            .u32(args.o as u32)
            .u128(args.p as u128);
        assert_eq!(w.as_slice(), data, "round {round}");
        match r.below(5) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(10)),
            2 => {
                let i = r.below(data.len() as u64) as usize;
                data[i] = r.byte();
            }
            3 => data = r.some_bytes(200),
            _ => {}
        }
        let theirs = Args::deserialize(&mut &data[..]).ok();
        let ours = read(&data);
        assert_eq!(ours, theirs, "round {round}");
        if ours.is_some() {
            ok += 1;
        } else {
            failed += 1;
        }
    }
    assert!(ok > 10_000 && failed > 10_000, "{ok} {failed}");
}

// -------------------------------------------------------------- sysvars

/// solana-rent 3.1 (what Anchor 1.2.1 builds link) for the thresholds
/// before and after SIMD-0194 and any other value.
#[test]
fn rent_matches_solana_rent() {
    let mut r = Rng(4);
    for i in 0..50_000 {
        let lamports_per_byte_year = match i % 4 {
            0 => 3480,
            1 => 6960,
            2 => r.below(1 << 20),
            _ => r.below(1 << 40),
        };
        let threshold = match i % 5 {
            0 => 2.0,
            1 => 1.0,
            2 => 1.5,
            3 => f64::from_bits(r.next() >> 2),
            _ => r.below(1000) as f64 / 7.0,
        };
        let len = r.below(1 << 14) as usize;
        #[allow(deprecated)]
        let theirs = solana_rent::Rent {
            lamports_per_byte_year,
            exemption_threshold: threshold,
            burn_percent: 50,
        };
        let ours = Rent::new(lamports_per_byte_year, threshold);
        assert_eq!(
            ours.minimum_balance(len),
            theirs.minimum_balance(len),
            "{lamports_per_byte_year} {threshold} {len}"
        );
        let lamports = r.below(1 << 50);
        assert_eq!(
            ours.is_exempt(lamports, len),
            theirs.is_exempt(lamports, len)
        );
    }
    // Products past 2^53 take the float path, as before.
    let big = Rent::new(u64::MAX / (1 << 12), 2.0);
    #[allow(deprecated)]
    let theirs = solana_rent::Rent {
        lamports_per_byte_year: u64::MAX / (1 << 12),
        exemption_threshold: 2.0,
        burn_percent: 50,
    };
    assert_eq!(big.minimum_balance(0), theirs.minimum_balance(0));
}

/// The sysvar ids, and `get()` reads the sysvars' bincode layouts.
#[test]
fn sysvars_read_their_layouts() {
    assert_eq!(
        RENT_ID,
        anchor_lang::pubkey!("SysvarRent111111111111111111111111111111111")
    );
    assert_eq!(
        CLOCK_ID,
        anchor_lang::pubkey!("SysvarC1ock11111111111111111111111111111111")
    );
    assert_eq!(
        INSTRUCTIONS_ID,
        anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111")
    );

    assert_eq!(Rent::get(), Err(ProgramError::UnsupportedSysvar));
    let mut raw = Vec::new();
    raw.extend_from_slice(&3480u64.to_le_bytes());
    raw.extend_from_slice(&2.0f64.to_bits().to_le_bytes());
    raw.push(50);
    host::set_sysvar(&RENT_ID, &raw);
    assert_eq!(Rent::get(), Ok(Rent::new(3480, 2.0)));

    let clock = anchor_lang::solana_program::clock::Clock {
        slot: 1,
        epoch_start_timestamp: -2,
        epoch: 3,
        leader_schedule_epoch: 4,
        unix_timestamp: 1_760_000_000,
    };
    let mut raw = Vec::new();
    for word in [
        clock.slot,
        clock.epoch_start_timestamp as u64,
        clock.epoch,
        clock.leader_schedule_epoch,
        clock.unix_timestamp as u64,
    ] {
        raw.extend_from_slice(&word.to_le_bytes());
    }
    assert_eq!(raw.len(), Clock::LEN);
    host::set_sysvar(&CLOCK_ID, &raw);
    let ours = Clock::get().unwrap();
    assert_eq!(
        (
            ours.slot,
            ours.epoch_start_timestamp,
            ours.epoch,
            ours.leader_schedule_epoch,
            ours.unix_timestamp
        ),
        (
            clock.slot,
            clock.epoch_start_timestamp,
            clock.epoch,
            clock.leader_schedule_epoch,
            clock.unix_timestamp
        )
    );
}

#[test]
fn base58_and_base64_render_as_the_runtime_prints() {
    let mut r = Rng(13);
    for _ in 0..500 {
        let key: Pubkey = r.key();
        assert_eq!(host::base58(key.as_ref()), key.to_string());
    }
    assert_eq!(host::base58(&[0; 32]), "11111111111111111111111111111111");
    assert_eq!(host::base64(b""), "");
    assert_eq!(host::base64(b"f"), "Zg==");
    assert_eq!(host::base64(b"fo"), "Zm8=");
    assert_eq!(host::base64(b"foobar"), "Zm9vYmFy");
}
