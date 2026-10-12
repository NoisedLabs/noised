# Privacy: Shield

Shield is Noised's **opt-in** privacy layer. It wraps any supported token 1:1 into a "zToken". A zToken is a Token-2022 mint with Confidential Balances, which can hide your balance and the amounts you send. Unwrapping gives the original token back. Noised launch tokens themselves have no privacy features. Meteora's pools cannot trade confidential tokens (FACTS #55), so privacy is a separate, reversible layer next to the tradeable token.

> **Shield is not Zcash.** It hides *how much*, not *who*. Everyone can still see which accounts transact with which. Its encryption is not post-quantum.

## 1. What is hidden and what is not

| Information | Hidden? |
|---|---|
| Your zToken balance while held confidentially | **Yes**: encrypted under your ElGamal key |
| The amount of a confidential transfer between zToken accounts | **Yes** |
| That a transfer happened, and between which token accounts and owners | No |
| Wrap and unwrap amounts (base tokens in and out of the escrow, zTokens minted and burned) | No |
| Deposit (public to confidential) and withdrawal (confidential to public) amounts | No |
| Timing, fee payers, transaction graph | No |
| Total zToken supply, and the escrow balance backing it | No |

The private part of a zToken's life is the time between a deposit into the confidential balance and a withdrawal back out. Amounts and timing at the edges are public and can be correlated: wrapping 1,234.5678 and someone unwrapping 1,234.5678 later is a visible link.

**Comparison with Zcash.** Zcash's shielded transactions hide sender, receiver *and* amount inside the shielded pool. Confidential Balances hide only balances and amounts. Accounts and owners stay public. Do not describe zTokens as Zcash-like.

## 2. How it works

Program: `programs/noised-shield` (`BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`).

| Instruction | Who | What |
|---|---|---|
| `create_shield()` | anyone, once per base mint | Creates `Shield ["shield", base_mint]`, the zToken mint `["z-mint", base_mint]` and the escrow ATA owned by `["shield-authority", base_mint]`. Rejects base mints with dangerous extensions (section 4). |
| `wrap(amount)` | holder | Moves `amount` base tokens into the escrow with `transfer_checked`, forwarding hook accounts if the base mint has a hook. Then mints zTokens equal to what the escrow **actually received**. Under a base-mint transfer fee, that is less than `amount`. |
| `unwrap(amount)` | holder | Burns `amount` zTokens from the holder's *public* zToken balance and releases `amount` base tokens. Any base-mint transfer fee is charged to the unwrapper. |
| Confidential operations | holder, client-side | Plain Token-2022 instructions: configure the account, deposit, apply the pending balance, transfer confidentially, withdraw. |

The zToken mint, as created and then re-verified on the live account by `zmint.rs::verify`:
- `ConfidentialTransferMint` with **no authority**, auto-approval of new accounts and **no auditor key**. Nobody can change these settings, approve or deny accounts, or decrypt amounts.
- `MetadataPointer` to itself with no authority. `TokenMetadata` with no update authority: name `"Shielded " + name` and symbol `"z" + symbol` (truncated), and the URI copied from the base mint's Token-2022 metadata if it has one of at most 200 bytes with no invisible character; a longer one is dropped (empty), not cut. For a Noised launch: the default empty uri and an external uri (at most 200 bytes) are copied; an inline `data:` uri is copied only for a document of at most 126 bytes, so a zToken of a mint whose document holds an icon gets an empty uri.
- Same decimals as the base mint. No freeze authority. Mint authority is the shield-authority PDA, which only `wrap` uses.

## 3. Shield's own guarantees

| Guarantee | Enforced by |
|---|---|
| Every zToken is backed: escrow balance >= zToken supply after every shield instruction | `token.rs::require_backed`. `wrap` checks minted = received. `unwrap` checks burned = released = amount. |
| Nobody controls a zToken | zToken configuration above, verified after creation |
| The escrow is released only by `unwrap`, against an equal burn | escrow owned by the shield-authority PDA |
| One shield per base mint, never modified or closed | `init` on `["shield", base_mint]`; no update or close instruction |

**Tested.** The shield's LiteSVM tests (`programs/noised-shield/tests/`) run our SBPF v3 build against the mainnet Token-2022 v11 binary with the mainnet feature set:
- `shield.rs`: creation, zToken configuration, wrap/unwrap accounting, and griefing by donations, direct burns and a pre-funded zToken address.
- `base_mints.rs`: accepted and refused base mints.
- `confidential.rs`, with the ZK ElGamal proof program enabled:
  - a zToken account is configured with no authority involved (auto-approved);
  - tokens are deposited into the encrypted balance and the pending balance is applied;
  - the owner decrypts the balance;
  - `unwrap` succeeds only up to the public balance;
  - the encrypted balance is withdrawn with an equality proof and a range proof, then unwrapped.

An account-to-account confidential transfer is plain Token-2022 and is not covered by our tests.

**Why "at least", not "equal".** SPEC §2 states the invariant as `escrow >= supply`. Equality cannot be enforced on-chain: anyone can transfer base tokens straight into the escrow, and any holder can burn zTokens with a plain Token-2022 burn. With strict equality, a one-unit donation would make every later wrap and unwrap fail and lock all escrowed funds. The program therefore checks exact deltas in each instruction and enforces `escrow >= supply` globally. Surplus stays in the escrow and is never paid out.

## 4. Which tokens can be shielded

- SPL Token mints.
- Token-2022 mints whose extensions are all in {MetadataPointer, TokenMetadata, TransferHook, TransferFeeConfig} (`policy.rs::ALLOWED_BASE_EXTENSIONS`).
- Everything else is refused: permanent delegate, pausable, default account state, non-transferable, mint close authority, confidential transfer or mint/burn, interest-bearing, scaled UI amount, and any extension type the program does not recognize. Unknown extensions fail closed.

**What a zToken inherits from its base mint.** The base mint's own authorities keep their powers over the escrow:
- a **freeze authority** (USDC has one) can freeze the escrow and strand every zToken holder
- a **transfer-hook** authority can make wraps and unwraps fail
- a **transfer-fee** authority can raise the fee charged on unwrap

Shield a token only if you accept its issuer's powers. Noised launch tokens have no mint, freeze or metadata authority, and their hook is removed at graduation.

**Launch Guard interaction.** During a launch's guard window (at most 72 h), wrap and unwrap of that launch's token are wallet-to-wallet transfers. They are refused if the launch enabled the wallet-to-wallet lock (`TransfersLocked`, even into an ATA: under a locked guard the Shield is just another wallet). They are also limited by max-buy per wrap or unwrap, and by max-wallet, which applies to the escrow as a receiving account. Since audit round 3's F2, an unwrap during the guard must also pay into a token account whose owner can never change (`MutableOwner` otherwise, until `guard_end_ts`): unwrap into your associated token account, which always qualifies. A wrap is not affected, because the hook checks only the receiving account, and the escrow is an associated token account. Shield launch tokens after the guard ends.

**Creator launch rules** (review 4, R1). A launch may also carry the creator's launch rules, which can only refuse more buys and wallet-to-wallet transfers during the guard ([HOOKS.md](HOOKS.md) §2). They never apply to wraps and unwraps: when the shield is the transaction's top-level instruction, the hook skips them, so a rule cannot hold your exit. The built-in checks above (the lock, max-buy, max-wallet, the immutable-owner rule) still apply exactly as before (`creator_rules_never_hold_a_wrap_or_an_unwrap`). The residual, stated plainly: wrap, move the zTokens (the zToken mint has no hook), then unwrap gets past creator rules that restrict wallet-to-wallet transfers or name wallets. It never gets past the built-in lock: under the lock, wrap and unwrap are refused. A call into the shield made by another program through CPI has that program as the top-level instruction, so the rules still apply to it.

**One escrow, one max-wallet** (audit round 3, info). A mint has one Shield escrow, so during the guard every Shield deposit of a launch token shares one max-wallet. Anyone holding about max-wallet tokens can fill the escrow, and every further wrap of that token, by anyone, then fails until the guard ends. Nothing is lost: the filler keeps its zTokens 1:1 and can unwrap later, and the rule ends with the guard. It also means at most max-wallet worth of zTokens can exist for that mint during the guard, so wrapping cannot get around the caps. The escrow is deliberately not exempt from the hook: an exempt escrow would let holders under a wallet-to-wallet lock move tokens to each other through wrap and unwrap. Recipients' associated token accounts are shared the same way: anyone can top one up to max-wallet, after which that account's buys and vault `release` payouts fail until the guard ends.

**What the Shield does not change about control.** The Shield is not a way around the wallet-to-wallet lock: under the lock, wrap and unwrap of the guarded token are refused, so no zTokens of it can be minted during the guard. It also adds nothing the lock could see: control of tokens can change during a guard without any transfer, through a wallet several people control, a PDA or smart-wallet owner, a PQ vault whose key is rotated to another party's key, or a delegate approval ([HOOKS.md](HOOKS.md) §9). Confidential balances hide amounts, not who controls an account.

**PQ vault interaction.** A PQ vault can hold zTokens, in its public balance only, so the vaulted amount is visible. A vault payout is an ordinary public transfer. If the recipient's zToken account refuses non-confidential credits, the withdrawal still executes and the payout waits in the vault; the recipient collects it with `release_to` into another of its zToken accounts that accepts public credits ([POST_QUANTUM.md](POST_QUANTUM.md) §5).

## 5. Not post-quantum

Confidential Balances use twisted ElGamal encryption and zero-knowledge proofs over Curve25519 (Ristretto). A future quantum computer could decrypt every ciphertext recorded on-chain today, so **amounts you hide now may become public later** ("harvest now, decrypt later"), and could also forge proofs (FACTS #58). There is a shortcut too: the ElGamal key is derived from a signature of your Ed25519 wallet, so whoever recovers the wallet key (as a quantum computer can, from its address) can re-derive the decryption key. Nothing in Solana's privacy stack is post-quantum. For post-quantum *custody* (not privacy), see [POST_QUANTUM.md](POST_QUANTUM.md).

## 6. Trust and availability

| Dependency | Risk | History |
|---|---|---|
| Token-2022 program | Upgradeable by a Squads v3 multisig, 4-of-6 (FACTS #47) | The same upgrade path switched off confidential transfers on 2025-06-11 |
| ZK ElGamal proof program | Controlled by a validator feature gate (a kill switch) | Enabled 2025-01. Disabled 2025-06-19 (slot 347,760,000) after the second forgeable-proof bug of 2025. Re-enabled 2026-06-04 (slot 424,224,000) after multiple audits (FACTS #53). **While it was disabled, confidential balances could not be withdrawn.** |
| Proof soundness | A proof bug can allow minting value out of thin air inside confidential balances | Two critical Fiat-Shamir bugs in 2025, both fixed |
| Usage and tooling | Mainnet usage has been near zero since re-enablement (low-confidence observation); wallet support varies | |

If confidential transfers are switched off again, zTokens held in *public* balances can still be unwrapped. Balances held *confidentially* may be stuck until the feature returns. Keep in the confidential balance only what you can afford to have frozen for a long time.

## 7. Practical limits

| Limit | Value |
|---|---|
| Maximum per deposit or confidential transfer | 2^48 - 1 base units (FACTS #54) |
| Incoming transfers | land in a *pending* balance that the owner must apply. The pending-credit counter defaults to 65,536 credits. |
| Cost | about 223k CU of proof verification for a transfer (about 368k with a transfer fee); a withdrawal needs a range proof of about 111k CU. A transfer spans several transactions or context-state accounts. |
| Trading | No AMM trades confidential balances. Unwrap first (FACTS #55). |
| Unwrap | Burns from the *public* zToken balance. Withdraw from the confidential balance first; that withdrawal amount is public. |

## 8. Using it

Wrap and unwrap through the app or the SDK's shield builders (`buildWrapTx`, `buildUnwrapTx`; SPEC §4.1). For confidential operations, use the SDK helpers where available, or `spl-token` 5.6 or newer. The subcommands below match `spl-token-cli` 5.6.1:

```bash
spl-token create-account <Z_MINT>                                          # your zToken account
spl-token configure-confidential-transfer-account --address <Z_ACCOUNT>   # auto-approved: no authority exists
spl-token deposit-confidential-tokens <Z_MINT> <AMOUNT> --address <Z_ACCOUNT>     # public -> confidential (amount visible)
spl-token apply-pending-balance --address <Z_ACCOUNT>
spl-token transfer <Z_MINT> <AMOUNT> <RECIPIENT> --confidential                   # amount hidden
spl-token withdraw-confidential-tokens <Z_MINT> <AMOUNT> --address <Z_ACCOUNT>    # confidential -> public (amount visible)
```

Your ElGamal and AE keys are derived from your wallet's signature. Anyone with your wallet key can read your confidential balance.

Use proof tooling released after the 2026 re-enablement. Our confidential test generates its proofs with zk-sdk 7. Its notes record that proofs from zk-sdk 4, as bundled with `spl-token-2022-interface` 2.1, are rejected by the re-enabled proof program.

A withdrawal's or transfer's proofs, together with the instruction, exceed the 1,232-byte legacy transaction limit. Our LiteSVM test does not enforce that limit. With legacy transactions, clients therefore first place the proofs in context-state or record accounts, in separate transactions. That is why a confidential transfer takes several transactions (FACTS #54).

## 9. Regulatory notes

*Information only, not legal advice. Laws differ by jurisdiction and change. Consult counsel before offering or relying on privacy features.*

- **EU, MiCA Art. 76(3).** Operators of crypto-asset trading platforms must not admit crypto-assets with an inbuilt anonymisation function unless the holders and their transaction history can be identified. Expect regulated venues to be cautious with zTokens. Shield does not change how the base token can be listed.
- **EU, AMLR (Regulation (EU) 2024/1624) Art. 79, applicable from 2027-07-10.** Crypto-asset service providers may not keep anonymous accounts, or accounts that allow anonymisation or increased obfuscation, including through anonymity-enhancing coins. Whether amount-hiding with visible parties falls under this is a legal question.
- **United States (as of 2026-10-08, FACTS #57).**
  - OFAC removed Tornado Cash from the sanctions list in March 2025.
  - The 18 U.S.C. §1960 conviction of a Tornado Cash developer stands, with a retrial on the other counts set for 2027-04-26.
  - FinCEN withdrew its 2023 mixer §311 proposal on 2026-10-06.
  - Current DOJ policy statements say non-custodial developers without criminal intent are not targeted.
- **Design posture.** Shield is non-custodial and permissionless, has no operator or relayer that moves user funds, and will be immutable after finalization. It hides amounts only, and exiting is always a public `unwrap`.
