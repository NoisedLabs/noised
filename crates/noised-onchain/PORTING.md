# Porting an Anchor 1.2.1 program to `noised-onchain`

How to rewrite one of the Noised programs without Anchor, on `pinocchio` and
this crate, so that its **ABI stays byte for byte the Anchor build's**:
program id, instruction discriminators, account order and signer/writable
flags, Borsh arguments, account discriminators and layouts, PDA seeds and
bumps, events, and error numbers (the framework's included). The SDK, the
app and every test suite then keep working unchanged.

`programs/noised-vault` is the reference port (commit history: the pilot
`388854a`, then the switch to this crate). Read its `src/processor.rs` next
to its Anchor source, kept verbatim in `programs/noised-vault/anchor/`,
before starting. Every check there carries an `[A]` comment naming the
Anchor constraint it implements.

Contents: 1. Layout of a port · 2. Keeping the host API · 3. Anchor's
evaluation order · 4. Attribute and type → helper → error · 5. Errors and
log lines · 6. Handlers, CPIs and exit · 7. The IDL and the ABI tests ·
8. Binary size · 9. Pitfalls · 10. Tests, mutants and freshness ·
11. Checklist.

---

## 1. Layout of a port

```text
programs/<name>/
  anchor/             the Anchor source, verbatim (the reference; docs and SDK tests may read it)
  src/lib.rs          id, `program::<Name>` (+ `Program` impl), discriminators, arg structs, events, entrypoint
  src/processor.rs    process_instruction + one fn per instruction: accounts, constraints, handler, exit
  src/state.rs        account types: layout, read/write, `ProgramAccount` impl
  src/error.rs        `custom_errors!` enum, the `ERRORS` table, thin `fail` wrappers
  src/client.rs       host only: `accounts`, `instruction` (Anchor client API)
  tests/abi.rs        ABI tests against the IDL, Anchor's serialization and the anchor-lang error table
```

`Cargo.toml` (see `programs/noised-vault/Cargo.toml`):

```toml
[lib]
crate-type = ["cdylib", "lib"]

[features]
no-entrypoint = []
cpi = ["no-entrypoint"]
no-log-ix-name = []           # keep Anchor's feature if the program had it

[dependencies]
noised-onchain = { workspace = true }
pinocchio = { workspace = true }
# + the program's own crates (noised-lmots, noised-rules, ...), no features

[target.'cfg(not(target_os = "solana"))'.dependencies]
anchor-lang = { workspace = true }   # host-only client API, never in the binary
```

`lib.rs` skeleton:

```rust
extern crate alloc;

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

#[cfg(not(target_os = "solana"))]
mod client;
pub mod error;
pub mod processor;
pub mod state;

#[cfg(not(target_os = "solana"))]
pub use client::{accounts, instruction};

#[cfg(not(feature = "no-entrypoint"))]
noised_onchain::entrypoint!(crate::processor::process_instruction);

pub type Pubkey = pinocchio::Address;      // Anchor's Pubkey is the same type
pub const ID: Pubkey = Pubkey::new_from_array([/* declare_id! bytes */]);

pub mod program {
    #[derive(Clone)]
    pub struct NoisedFoo;
    impl noised_onchain::Program for NoisedFoo {
        const ID: crate::Pubkey = crate::ID;
        const ERRORS: noised_onchain::ErrorTable = crate::error::ERRORS;
    }
    #[cfg(not(target_os = "solana"))]
    impl anchor_lang::Id for NoisedFoo {
        fn id() -> crate::Pubkey { crate::ID }
    }
}
```

In `processor.rs`, alias the program and the account list once:

```rust
type P = crate::program::NoisedFoo;
type Accounts<'a> = noised_onchain::accounts::Accounts<'a, P>;
```

Every generic helper takes `P` (`check_mut::<P>(..)`): it compiles to the
program's own id and error table, with nothing looked up at run time.

---

## 2. Keeping the host API

Test suites build instructions and read accounts with Anchor's client API.
Keep it, off-chain only, so they compile unchanged:

* **`accounts::<Ix>`** structs with `ToAccountMetas` (field order, signer and
  writable flags exactly as Anchor generated them: `Signer` → signer;
  `mut` / `init` → writable; `Option` fields as Anchor does). See
  `programs/noised-vault/src/client.rs`.
* **`instruction::<Ix>`** structs deriving `AnchorSerialize` /
  `AnchorDeserialize`, with `Discriminator` (`sha256("global:<snake>")[..8]`)
  and `InstructionData`.
* **`program::<Name>`** with `anchor_lang::Id` (and `noised_onchain::Program`).
* **Account types**: annotate the plain struct with
  `#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]` and
  `#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]`;
  the host then gets `AccountDeserialize`, `AccountSerialize`,
  `Discriminator`, `Owner`, `INIT_SPACE` exactly as before. On-chain the type
  is plain: implement `read` / `write` (fixed offsets, see `state.rs`) and
  `noised_onchain::accounts::ProgramAccount` (`ACCOUNT_DISCRIMINATOR`,
  `try_read`). The trait constant is deliberately not called
  `DISCRIMINATOR`: Anchor's macro-generated code refers to
  `Self::DISCRIMINATOR` and would become ambiguous.
* **Events**: `#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]`
  on the struct; on-chain build the payload yourself (fixed array as the
  vault's `event_data`, or `args::Writer::with_discriminator`) and emit it
  with `event::emit` / `sys::log_data`. Test `event.data() ==` your payload.
* **Argument structs** used by `instruction::*`:
  `#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]`.
  On-chain, decode in place (`args::Reader`, or `split_first_chunk` as the
  vault's `WithdrawArgsRef`) without allocating.
* **Errors**: `error::<Enum>` keeps its path, variants, `Debug`, `Into<u32>`;
  `custom_errors!` gives all of them, plus `name()`, `message()`, `Display`
  off-chain.
* Constants, seeds and helper functions other crates import keep their
  paths (grep the test workspaces and the launchpad for `<crate>::`).

`noised_onchain::host` has the off-chain helpers: `discriminator`,
`deserialize::<T: ProgramAccount>` (`try_deserialize` semantics),
`HostAccount` (accounts laid out as the runtime lays them out),
`take_log_lines` / `take_cpis` (what a helper logged / invoked), and
`fuzz` (deterministic RNG, random valid and malformed mints and token
accounts).

---

## 3. Anchor's evaluation order

Everything fails (or succeeds) the same way only if the checks run in this
order. Per instruction:

1. **`entry` / `try_entry`**: program id ≠ declared id →
   `DeclaredProgramIdMismatch` (4100). `args::instruction::<P>`.
2. **`dispatch`**: the first 8 bytes against each instruction's
   discriminator (data shorter than 8 bytes matches none); then the
   event-CPI tag (`EventInstructionStub` 1500 without `event-cpi`); else
   `InstructionFallbackNotFound` (101). `args::unknown::<P>(tag)`.
3. **Handler prologue**: `msg!("Instruction: <PascalName>")` unless
   `no-log-ix-name`, *before* anything else (the vault's
   `log_instruction`).
4. **Arguments**: Borsh from the data after the discriminator; trailing
   bytes ignored; any failure → `InstructionDidNotDeserialize` (102),
   logged with no account: `args::decode::<P, _>(args, |r| ..)` with a
   `Reader`, or the program's own in-place parser (the vault's
   `WithdrawArgsRef`). With `#[instruction(..)]`, `try_accounts` decodes
   the declared prefix again: same rule.
5. **`try_accounts`, deserialization**: each field in declaration order,
   checked by its *type* (table §4). A missing account is
   `AccountNotEnoughKeys` (3005) named after the field — except `init` /
   `zero` fields, which are taken raw and whose missing account names no
   field. Errors of these type checks name the field.
6. **`init` / `init_if_needed` fields**, in declaration order (§4, init).
7. **Duplicate mutable accounts**: the writable `Account` /
   `InterfaceAccount` (/ `LazyAccount`, `Migration`) fields, excluding
   `dup` and plain `init` (but including `init_if_needed`), in field order:
   a repeat is `ConstraintDuplicateMutableAccount` (2040) naming the later
   field. `UncheckedAccount`, `Signer`, `SystemAccount`, `AccountLoader`,
   `Program` never take part. `accounts::check_distinct::<P>`.
8. **Every other field's constraints**, field by field in declaration
   order; within a field, in this order (anchor-syn `linearize`):
   `zero`, `init`, `realloc`, `seeds`, `associated_token`, `mut`, `dup`,
   `signer`, `has_one` (in attribute order), raw `constraint` (in attribute
   order), `owner`, `rent_exempt`, `executable`, `close`, `address`,
   `token::*` (authority, mint, token_program), `mint::*` (decimals,
   mint_authority, freeze_authority, token_program, extensions).
9. **Handler body.**
10. **Exit**, in field order: a `close` field is closed to its target
    (`accounts::close`); every other writable `Account` is serialized back
    (`accounts::write_back`; skipped when the account was closed in the
    handler, i.e. system-owned with no data; `AccountDidNotSerialize` 3004
    when the data is shorter than the fields). Exit runs after every CPI of
    the handler.

---

## 4. Attribute and type → helper → error

`name` is the field name (Anchor's `with_account_name`). "keys" means the
error is followed by `Left:` / `Right:` and the two pubkeys
(`fail_keys`), "values" by `Left: n` / `Right: m` (`fail_values`).

### Account types (step 5)

| Anchor field type | Helper | Errors, in order |
|---|---|---|
| any (missing account) | `Accounts::next(Some(name))` | 3005 (named; `next(None)` for init/zero fields) |
| `UncheckedAccount` / `AccountInfo` | `Accounts::unchecked(name)` | — |
| `Signer` | `Accounts::signer(name)` | 3010 `AccountNotSigner` |
| `SystemAccount` | `Accounts::system_account(name)` | 3011 `AccountNotSystemOwned` |
| `Program<T>` | `Accounts::program(&T_ID, name)` | 3008 `InvalidProgramId` (keys: given, expected), 3009 `InvalidProgramExecutable` |
| `Interface<TokenInterface>` | `Accounts::token_program(name)` | 3008 (no keys), 3009 |
| `Account<T>` | `Accounts::account::<T>(name)` | 3012 `AccountNotInitialized` (system-owned and 0 lamports), 3007 `AccountOwnedByWrongProgram` (keys: owner, program id), 3001 `AccountDiscriminatorNotFound` (< 8 bytes), 3002 `AccountDiscriminatorMismatch`, 3003 `AccountDidNotDeserialize` (`try_read` → `None`) |
| `InterfaceAccount<Mint>` | `Accounts::mint(name)` (decimals) / `mint_with(name, \|m\| ..)` | 3012, 3007 (no keys; owner not SPL Token / Token-2022), then the SPL unpack error **unchanged and unlogged** (`InvalidAccountData`, `UninitializedAccount`) |
| `InterfaceAccount<TokenAccount>` | `Accounts::token_account(name)` (mint, owner, amount) / `token_account_with(name, \|t\| ..)` | as the mint |
| `Option<T>` | `Accounts::optional(Some(name))`, then the type's checks on `Some` | the program id in the account's place is `None` |
| `remaining_accounts` | `Accounts::remaining()` | — |
| `Box<..>` | as the unboxed type | — |

Not provided (write them in the program, or add them here with a
differential test): `AccountLoader` / zero-copy, `LazyAccount`, `Migration`,
`Sysvar<T>` accounts (address check `AccountSysvarMismatch` 3015 then
bincode), `Account<'info, ProgramData>` (owner = BPF upgradeable loader,
`AccountNotProgramData` 3013), `zero` (`ConstraintZero` 2013 / 3003 named,
then `Account::try_from_unchecked`), `realloc` (needs pinocchio's
`account-resize` feature, which adds entrypoint overhead; Anchor:
`AccountDuplicateReallocs` 3017, `AccountReallocExceedsLimit` 3016, payer
top-up or refund, then resize). None of the five programs uses `zero`,
`realloc` or zero-copy today.

### `init` / `init_if_needed` (step 6)

| Anchor | Helper | Notes and errors |
|---|---|---|
| `init, seeds = [..], bump` | `pda::check_seeds::<P>(acc, seeds, &ID, name)` → bump, then `accounts::init_program_account::<P>(payer, acc, space, &rent, &[Signer::from(&seeds_with_bump)], name)` | 2006 (keys) if not the PDA; then `create_account_or_fund_allocate_assign`: 0 lamports → `create_account`; else payer = account → 4101 `TryingToInitPayerAsProgramAccount` (keys, **no account named**), top up to `max(min_balance, 1)`, `allocate`, `assign` (PDA signs `allocate` / `assign` / `create_account`, never the top-up). Then `Account::try_from_unchecked`, its errors **named** (anchor-syn wraps the call in `with_account_name(field)`: 3012, 3007 keys, 3003), then `mut` (2000). |
| `init, seeds, bump = b` | `pda::check_seeds_canonical_bump::<P>` | 2006 keys, or 2006 values (found bump, given) |
| `init` (keypair account) | `init_program_account` with `signers = &[]` | the account signs the transaction |
| `init_if_needed` (program account) | `accounts::init_if_needed_program_account::<P, T>` → `Option<T>` (`None` = created) | system-owned → created as above; otherwise `Account::try_from` (its errors named, as above), then `ConstraintSpace` 2019 (values: space, data_len), `ConstraintOwner` 2004 (keys), `ConstraintRentExempt` 2005, each named; then `mut`. Anyone may have created it first: never assume it is new. |
| `init(_if_needed), associated_token::mint/authority/token_program` | `token::init_associated_token_account::<P, IF_NEEDED>(&AssociatedToken {..}, &rent, name)` → mint/owner/amount | ATA `Create` (instruction 0) when system-owned (always for plain `init`); the instruction **names the derived address**, so another account fails in the runtime (`MissingAccount`), not with an Anchor error. Then `InterfaceAccount::try_from_unchecked` (3012, 3007 named; the SPL unpack error unchanged). If needed: 2014 keys, 2015 keys, 2023 keys, 3014 (named). Then 2000, 2005. |
| `init, token::mint/authority` | not provided | `create_account_or_fund_allocate_assign` with `owner = token program` and the account size of `get_required_init_account_extensions`, then `InitializeAccount3`; if needed 2014/2015/2021 keys |
| `init, mint::decimals/authority/freeze_authority (+ extensions::*)` | `cpi::create_account_or_fund_allocate_assign::<P>` (owner = token program, space = base + extensions), then `token::initialize_mint_extension` for each extension in **Anchor's order** (group pointer, group member pointer, metadata pointer, close authority, transfer hook, non-transferable, permanent delegate, pausable), then `token::initialize_mint2` | if needed: 2016, 2017, 2018 (values), 2022 (keys). Compute the space as `find_mint_account_size` does (add a test against it). |
| `rent_exempt = enforce` (implied by every `init`) | `accounts::check_rent_exempt::<P>` | 2005 named; runs in the constraint order (after raw constraints) |
| `Rent::get()` | `sysvar::Rent::get()` | `minimum_balance` is solana-rent 3.1's, tested |

### Constraints (step 8)

| Anchor | Helper | Error |
|---|---|---|
| `mut` | `accounts::check_mut::<P>(acc, name)` | 2000 named |
| `signer` (constraint) | `accounts::check_signer::<P>` | 2002 named |
| `has_one = target` | `accounts::check_has_one::<P>(&state.target, target, name)` | 2001 named, keys (field value, target key) |
| `has_one = target @ E` | `accounts::check_keys::<P>(&state.target, target.address(), E.code(), name)` | E named, keys |
| `constraint = cond` | `accounts::check_constraint::<P>(cond, CONSTRAINT_RAW, name)` | 2003 named |
| `constraint = cond @ E` | `accounts::check_constraint::<P>(cond, E.code(), name)` | E **named** (custom errors on constraints carry the account name) |
| `owner = o` | `accounts::check_owner::<P>(acc, &o, name)` | 2004 named, keys (owner, expected) |
| `executable` | `accounts::check_executable::<P>` | 2007 named |
| `close = target` | `accounts::check_close::<P>(acc, target, name)` now, `accounts::close(acc, target)` at exit | 2011 named if closed to itself |
| `address = a` | `accounts::check_address::<P>(acc, &a, name)` | 2012 named, keys (given, expected) |
| `address = a @ E` | `accounts::check_keys::<P>(acc.address(), &a, E.code(), name)` | E named, keys |
| `seeds = [..], bump = stored` | `pda::check_seeds_with_bump::<P>(acc, &[.., &[bump]], &program, name)` | invalid seeds → 2006 named (no keys); other address → 2006 keys |
| `seeds = [..], bump` | `pda::check_seeds::<P>` (returns `ctx.bumps.<field>`) | 2006 keys |
| `seeds::program = p` | pass `p` instead of `&ID` | |
| `associated_token::*` (existing) | `token::check_associated_token_account::<P>(acc, &state, authority, mint, token_program, name)` | 2023 (**no account, no keys**; only with `associated_token::token_program`), 2015 keys, 2009 keys. The mint is not compared (Anchor does not). |
| `token::authority = a` | `token::check_token_authority::<P>` | 2015 keys |
| `token::mint = m` | `token::check_token_mint::<P>` | 2014 keys |
| `token::token_program = t` | `token::check_token_token_program::<P>` | 2021 keys (owner, token program) |
| `mint::token_program = t` | `token::check_mint_token_program::<P>` | 2022, **no account named, no keys** |
| `mint::decimals = d` | `if decimals != d` → `fail::<P>(CONSTRAINT_MINT_DECIMALS, None)` | 2018 (no name: Anchor's `.into()`) |
| `mint::authority` / `freeze_authority` | compare `Mint::mint_authority()` / `freeze_authority()` | 2016 / 2017, no name |
| `dup` | leave the field out of `check_distinct` | |
| `Option` field used by a constraint | `ConstraintAccountIsNone` (2020) named after the *referenced* field | not provided as a helper |

---

## 5. Errors and log lines

* **The table.** `error.rs` declares the program's errors with
  `noised_onchain::custom_errors!` (6000 + index; `offset = N;` for
  `#[error_code(offset = N)]`) and packs one table:

  ```rust
  pub const ERRORS: ErrorTable = {
      use noised_onchain::error::anchor::*;
      noised_onchain::error_table![INSTRUCTION_FALLBACK_NOT_FOUND, /* every framework number the program can return */; MyError::ERRORS]
  };
  ```

  List **every** framework number the helpers you call can return (the
  tables in §3–4); a number missing from the table is logged with an empty
  name, number and message (the error number itself is still right). A
  number listed twice, or one anchor-lang does not define, fails to
  compile. Only the listed entries reach the binary. The ABI test compares
  the table with the anchor-lang numbers you expect plus the IDL's errors
  (see the vault's `error_table_matches_anchor_and_the_idl`).
* **Raising.** Wrap the generic functions once in `error.rs`
  (`#[inline(always)] fn fail(code, account) -> ProgramError {
  noised_onchain::error::fail::<P>(code, account) }`, same for `fail_keys`)
  so call sites stay short. Then:
  * `err!(E)`, `require!(c, E)`, `.ok_or(E)?`, `return Err(E.into())` →
    `error::raise::<P>(E.code())` (`AnchorError occurred. ...`).
  * `require_keys_eq!(a, b, E)` / `require_keys_neq!` → `fail_keys::<P>(E.code(), None, &a, &b)`.
  * `require_keys_eq!(a, b)` without an error → `REQUIRE_KEYS_EQ_VIOLATED`
    (2502) with keys; `require_eq!` / `require_gt!` etc. → 2501 / 2505 ...
    with **values** (`fail_values`) when Anchor logs them.
  * an error on a field (constraint, type check) → `fail::<P>(code, Some(name))`.
* **Not reproduced** (log text only; numbers are exact and nothing relies
  on the text): `require!` / `err!` / `error!` log `AnchorError thrown in
  <file>:<line>` under Anchor (source locations of a deleted file); here
  `AnchorError occurred`. `ProgramError`s (SPL unpack errors, the runtime's,
  `ArithmeticOverflow`) are logged by Anchor as `ProgramError occurred.
  Error Code: <Debug>...`; here they are returned unchanged and not logged.
  Test suites match `Error Code: <Name>. Error Number: <n>.` of
  `AnchorError` lines only: keep it that way.
* **Logs are static strings**: no `format!`, no `core::fmt` on-chain
  (`fail` assembles the line from the packed table; `fail_values` prints
  decimals by hand). Off-chain the `Display` impls exist for tests.

---

## 6. Handlers, CPIs and exit

* **CPIs**: `cpi::invoke(program_id, metas, data, infos, signers)` (as
  solana-cpi's `invoke_signed`: `AccountBorrowFailed` before the call when
  an instruction account's data is still borrowed — any borrow for a
  writable meta, a mutable one for a read-only meta; a failing callee
  aborts the transaction).
  System: `cpi::{create_account, transfer, allocate, assign}`. Token:
  `token::{transfer_checked, mint_to_checked, burn_checked,
  initialize_mint2, initialize_mint_extension, memo,
  create_associated_token_account}`; the `*_data` builders give the bytes
  (tested against the SPL builders). Anything else: build the instruction
  bytes, add a test against the SPL builder in `tests/spl.rs`.
* **`transfer_checked` with a transfer hook**: `token::transfer_checked(..,
  signers, extra)` resolves the hook's accounts from `extra` (usually
  `accounts.remaining()`) exactly as
  `spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi`
  (errors unchanged). A program that maps the resolution error to its own
  (the launchpad's `InvalidHookAccounts`) calls `token::hook::
  add_extra_accounts_for_execute_cpi` itself and maps the error.
* **Memo-required destinations**: `token::destination_requires_memo(acc)?`
  then `token::memo(memo_program, bytes)` right before the transfer.
* **Borrows across CPIs**: never hold a `Ref` / `RefMut` (or a slice from
  one) of any account's data across `invoke`: read what you need into
  locals first (all helpers here drop their borrows before returning).
  `invoke` refuses a live `Ref` / `RefMut` of an instruction account
  (`AccountBorrowFailed`, as solana-cpi), but cannot see a plain slice kept
  from a dropped one. `AccountView` is `Copy`; `write_back` borrows mutably
  only at exit, after every CPI. The transfer-hook resolution checks the
  borrow state of each account it reads (`AccountBorrowFailed`, as the SPL
  resolver's `try_borrow_data`), then reads without taking a borrow
  (`HookAccount::data` is an `unsafe fn`: safe code cannot call it).
* **Events**: `event::emit(&payload)`; `emit_cpi!` → `event::emit_cpi::<P>(
  event_authority, bump, &payload)` and the program must dispatch the
  event tag to `event::event_dispatch::<P>(accounts, &EVENT_AUTHORITY)`
  instead of `args::unknown` (the event authority is
  `find_program_address(&[b"__event_authority"], &ID)`; hard-code it as a
  constant and test it).
* **Clock**: `sysvar::Clock::get()`. Rent: `sysvar::Rent::get()`.
* **Exit order**: write back / close in field order, after the handler
  (and its CPIs). A field both written and closed only closes.

---

## 7. The IDL and the ABI tests

The IDL (`idls/<name>.json`) can no longer be generated: keep the Anchor
build's IDL as is and maintain it by hand. Before deleting the Anchor
build, keep its source verbatim in `programs/<name>/anchor/` (the vault's
precedent; the app's docs generator and the SDK's source-parity tests may
read it — check `app/scripts/gen-docs-reference.mjs`,
`app/test/docs.test.ts`, `sdk/test/sources.test.ts` for the program's
paths before moving files).

`tests/abi.rs` (copy the vault's and adapt) checks:

* program id = IDL `address` = `anchor_lang::Id`;
* every instruction / account / event discriminator = `sha256(..)[..8]` =
  the client's `Discriminator` = the IDL's;
* `accounts::<Ix>::to_account_metas` = the IDL's account order and flags;
* every account and event layout = the IDL's field offsets and sizes;
  `write` = Anchor's `try_serialize`, `read` = `try_deserialize` (random
  values; longer data too);
* the on-chain argument decoder = Borsh `deserialize` on valid, truncated,
  extended and random data;
* the `ERRORS` table = the IDL's errors + the anchor-lang numbers you
  expect, with anchor-lang's names and messages;
* any policy written over SPL state (mint checks) against the SPL crates,
  with `noised_onchain::host::fuzz` inputs.

The generic parts are already tested in `crates/noised-onchain/tests`
(`anchor.rs`: the whole anchor-lang error table, log lines, dispatch,
discriminators, events, Borsh, rent, clock; `spl.rs`: Token-2022 parsing,
extensions, hook resolution, every CPI's bytes; `accounts.rs`: the account
types and constraints on runtime-layout accounts). Add a test there for
anything you add to the crate.

---

## 8. Binary size

Measured on the vault (SBPF v3, `cargo-build-sbf --arch v3`): Anchor build
279,600 bytes; pilot without Anchor 60,768; on this crate 61,216.

* **Link `std`** (no `#![no_std]`): with platform-tools v1.57, a `no_std`
  program that uses `alloc` fails to link (its sysroot `liballoc` lacks the
  default allocation-error handler). `std` costs a few hundred bytes, no
  formatting code.
* **Keep the workspace profile** (`opt-level` default 3, `lto = "fat"`,
  `codegen-units = 1`, `overflow-checks = true`): `opt-level = "z"` / `"s"`
  made the vault *bigger*.
* **No `core::fmt` on-chain**: one `format!` / `{}` / `{:?}` pulls in
  kilobytes. `panic!` with a message, `unwrap`/`expect` on-chain do too
  (location strings): return errors instead. Check with
  `llvm-readelf -s --demangle` on `target/sbpfv3-solana-solana/release/<name>.so`
  (the unstripped one) for `core::fmt`.
* **Inlining across crates** decides most of the size. Non-generic helpers
  in this crate carry `#[inline]` (so they inline as if they were in the
  program, as in the pilot); big shared ones are `#[inline(never)]`
  (`sys` CPI call with its borrow checks, `find_program_address`,
  unpacking, `fail`). A helper that returns `ProgramResult` but is always
  `Ok` must be inlinable, or every caller keeps its error checks.
  Compile-time flags are const generics (`IF_NEEDED`).
* **Measure**: build, then compare function sizes (`llvm-readelf -s -W
  --demangle`, sort by size) against the previous build; a jump usually
  means one helper got inlined at many sites or stopped being inlined.
* Allocations are cheap (bump allocator) but each `Vec` adds code; prefer
  arrays for fixed account lists.

---

## 9. Pitfalls

* **Missing account of an `init` field** names no account (3005 occurred).
* **`init` errors after the CPI name the field** too: anchor-syn wraps
  `try_from_unchecked` (and `init_if_needed`'s `try_from`) in
  `with_account_name(field)`, like every other load; only the payer check
  (4101) and a missing `init` account (3005) name none.
* **`TryingToInitPayerAsProgramAccount`** only on the pre-funded path; a
  pre-funded PDA is topped up to `max(minimum_balance, 1)` by the payer,
  then allocated and assigned — the PDA must sign `allocate` / `assign`.
* **`init_if_needed`**: "needed" means *owned by the system program*, not
  "empty". Anyone can create an ATA or a PDA-funded account first; the
  instruction must still work (the vault's `open_vault` test). The
  if-needed checks run on existing accounts.
* **ATA creation names the derived address**: passing another account at
  that position fails in the runtime (`MissingAccount`), before any
  Anchor-format log. Keep it that way.
* **`has_one` keys order** is (the account's field, the target's key);
  **`address`** is (given, expected); **`owner`** is (actual owner,
  expected).
* **`Interface<TokenInterface>`** logs no keys for 3008, **`Program<T>`**
  does.
* **`mint::token_program`** and **`associated_token::token_program`** on an
  existing account fail with no account named (Anchor's `.into()`), unlike
  `token::token_program`.
* **Account loading errors** of `Account<T>` and `InterfaceAccount<T>` name
  the field; `InterfaceAccount`'s 3007 has no keys, `Account`'s has.
* **SPL errors** inside `InterfaceAccount` unpacking come back as plain
  `ProgramError`s (`InvalidAccountData` ...), as Anchor returns them.
* **Token-2022 extension lookups** (`token::get_extension` /
  `get_extension_bytes`) take the base state the TLV belongs to
  (`ACCOUNT_TYPE_MINT` / `ACCOUNT_TYPE_ACCOUNT`) and refuse an extension
  type of the other base, or of none, with `InvalidAccountData` before
  reading anything: SPL's base-type check (`get_extension_bytes::<S, V>`).
  The walk itself is deliberately lenient: like spl-token-2022-interface
  2.1.0's `get_extension_indices` (which compares the raw `u16`; the
  differential test feeds unknown types too), it steps over entries of
  any other type, including types 2.1.0 does not know, where the strict
  pass (`ExtensionTypes` / `for_each_extension_type`, SPL's
  `get_extension_types`) fails with `InvalidAccountData`. Kept on purpose:
  the programs will be immutable, and a lookup must keep working if
  Token-2022 later adds account or mint extensions. The rule that goes
  with it: **every decision that accepts or refuses a mint by its
  extensions runs the strict pass over the whole TLV first** (the vault's
  mint policy, the shield's allowlist and zToken check, the launchpad's
  `inspect_mint`, whose result the later metadata re-read relies on). The
  lenient lookups that decide nothing about a mint are routing reads: the
  hook program (`hook_program_id`, found as Token-2022 itself finds the
  hook it calls: the hook's own `WrongHookProgram` check uses it too) and
  the memo requirement (`requires_memo`).
* **Discriminators**: instructions `global:<snake_case>`, accounts
  `account:<TypeName>`, events `event:<TypeName>`; check them against the
  IDL, never hand-type them without a test.
* **Borsh**: trailing bytes are ignored; `bool` must be 0/1; `Option`
  tag 0/1; `String` must be UTF-8; `Vec` length is a `u32`; enums a `u8`.
  Reading a `Vec<T>` of non-bytes: loop `vec_len()` times.
* **`find_program_address` panics** (as Anchor's does) when no bump works.
* **`close`** credits the target with `checked_add` (`ArithmeticOverflow`
  on overflow, as anchor-lang 1.2.1's `common::close` returns it through
  `add_lamports`), then zeroes lamports, assigns to the system program and
  sets the data length to 0 (pinocchio `AccountView::close`).
* **Duplicate accounts**: the runtime passes the same account twice as
  two views of one account (the entrypoint copies the view); writing one
  is visible in the other, as in Anchor.
* **`remaining_accounts`** is everything after the declared fields
  (`Accounts::remaining()`), including accounts past a missing `Option`.
* **Host builds compile the processor too** (it is `pub` for tests):
  everything must compile off-chain; syscalls are no-ops there and logs /
  CPIs are recorded per thread.
* **Unsafe code** lives only in `noised-onchain/src/sys.rs` and the
  transfer-hook resolution's data reads (`token/hook.rs`), each block with
  its safety argument; programs need none of their own (the
  `entrypoint!` expansion contains pinocchio's entrypoint, allocator and
  panic handler, so do not `deny(unsafe_code)` at the program's root).

---

## 10. Tests, mutants and freshness

* Build: `. F:\secure-build\env.ps1`, then
  `cargo-build-sbf --manifest-path programs/<name>/Cargo.toml --arch v3`
  into its own `CARGO_TARGET_DIR`; each test workspace (`tests/integration`,
  `programs/*/tests/litesvm`) in its own target dir, with `NOISED_SBF_DIR`
  pointing at the SBF `deploy` dir (`scripts/test-all.ps1` runs them all).
* The integration tests refuse a `.so` older than its sources:
  `tests/integration/tests/common/paths.rs` lists each program's source
  trees — add `crates/noised-onchain` (and the program's `anchor/` stays out:
  it is not compiled).
* `tests/integration/mutants.ps1`: mutants that edit this crate name the
  file from the repository root (`crates\noised-onchain\src\...`); the
  crate is in the scratch workspace's members. After porting, re-target the
  program's mutants to the new source (each pattern must match exactly
  once) and run `-Only '<prefix>*'`: every mutant must still be killed.
* The LiteSVM test workspaces have their own `Cargo.lock`; the first build
  after adding `noised-onchain` updates them (commit the change).

---

## 11. Checklist

1. Copy the Anchor source to `programs/<name>/anchor/`; keep the IDL.
2. `lib.rs`, `program::<Name>` with `Program`, `error.rs` with the table.
3. One `fn` per instruction, following §3 exactly, each check with an
   `[A]` comment; types and constraints from §4.
4. `state.rs`: layouts, `read` / `write`, `ProgramAccount`, Anchor
   `#[account]` off-chain.
5. `client.rs`: `accounts`, `instruction` (host only).
6. `tests/abi.rs` (§7); `cargo test -p <crate>`; clippy `-D warnings`.
7. SBF build; size; no `core::fmt` symbols.
8. Every test suite that loads the program, then its mutants.
9. Update `programs/README.md` (source list, crates) and the freshness
   paths.
