---
title: Liquidity lock & fees
nav: Liquidity & fees
summary: How the raise becomes permanently locked DAMM v2 liquidity, which fees exist, and the immutable rules that route them.
---

## The bonding curve

Until graduation a launch trades on Meteora's Dynamic Bonding Curve (DBC 0.2.1, `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`). The creator chooses the curve inside bounds: a start price and 1 to 8 points of increasing square-root price with non-zero liquidity, and a migration threshold between 1 and 100,000 SOL. The quote token is always wSOL. Supply is dynamic: base tokens that the curve never sells are burned at migration, so nobody receives leftover tokens.

## Graduation and the lock

When the quote reserve reaches `migration_quote_threshold`, the curve completes and DBC removes the transfer hook in that same swap. Anyone then calls DBC `migration_damm_v2`. The launch's config fixes the outcome:

| DBC config field | Fixed value | Effect |
|---|---|---|
| `partner_permanent_locked_liquidity_percentage` | 100 | 100% of the migrated LP is permanently locked |
| partner and creator liquidity, creator locked liquidity | 0 | no withdrawable LP for anyone |
| liquidity vesting | all zero | no vesting LP |
| `migration_fee` | 0 / 0 | the whole raise goes into the pool |
| `migration_option` | DAMM v2 | the only supported target |

At migration DBC calls DAMM v2 `permanent_lock_position`, which cannot be undone. The position NFT is owned by the launch-authority PDA `["authority", launch]`, and the launchpad has no instruction that removes liquidity or moves the NFT. Graduation needs nobody's permission, but it needs Meteora's DAMM v2 migration config for the launch's fee tier.

:::note What Meteora keeps
Meteora keeps 0.2% of migrated liquidity. Quote above the threshold (surplus) goes 80% to the launch authority, which distributes it like fees, and 20% to Meteora.
:::

## Fees

All trading fees on the curve are collected in wSOL (`collect_fee_mode = 0`), so base tokens leave the DBC vault only through swaps and the hook never sees a fee transfer.

- **Base fee schedule.** A linear or exponential decay from a cliff fee. The whole schedule must end within the commit window (`FeeScheduleTooLong`), so the batch always pays the floor fee, never the cliff.
- **Dynamic fee.** Optional volatility fee, passed through to DBC's validation.
- **Ceiling.** Once the schedule has ended, floor fee + the largest possible dynamic fee is at most **10%** (`MAX_TRADING_FEE_BPS = 1,000`; `FeeTooHigh`). DBC itself would allow 99%, which would turn every sell into a honeypot.
- **After graduation.** The DAMM v2 pool fee is the tier chosen at launch (`migration_fee_option` 0 to 5: 0.25%, 0.3%, 1%, 2%, 4%, 6%). DAMM v2 operators can still raise a pool's base fee to 10% and change its dynamic fee; the verifier warns when the live fee differs from the chosen tier.

## Routing

Every fee path is permissionless: anyone may crank it, and funds only go where the rules fixed at `create_launch` say.

::figure fees

| Instruction | When | What it does |
|---|---|---|
| `claim_fees` | before migration | DBC `claim_trading_fee2` into the launch authority's wSOL account |
| `claim_surplus` | after the curve completes | partner and creator surplus (both roles are the launch authority) into its wSOL account |
| `claim_lp_fees` | after migration | DAMM v2 `claim_position_fee` for a launch-authority position in the (base, wSOL) pool: base tokens and wSOL into the launch authority's accounts |
| `distribute` | any time | splits the launch authority's whole wSOL balance, then burns its whole base-token balance |

`distribute` pays `platform = ⌊balance · platform_fee_bps / 10,000⌋` to the treasury's wSOL account, then the rest to the 1 to 4 recipients by their bps (rounded down; the last recipient takes the remainder of the creator share). Each recipient account is the canonical wSOL ATA of the stored wallet, created if missing. Fees paid in the launched token (DAMM v2 LP fees in the base token) are **burned**, never sold.

- Recipients and their shares never change after `create_launch`; there is no update instruction.
- The platform share is at most 50% (`MAX_PLATFORM_FEE_BPS = 5,000`), written once into `Protocol` by `initialize_protocol` and snapshotted into each launch.
- The treasury must be an existing Noised **PQ vault of wSOL**: `distribute` pays the vault's own token account, which only the vault's hash-based signature can move (`InvalidProtocolParams` otherwise).
- A fee recipient may itself be a **PQ vault of wSOL**, so the creator's share lands in post-quantum custody (`prepareFeeVault`, `vaultFeeRecipients`).
- **Check recipients before signing.** The program does not look at recipient accounts (the legacy `create_launch` has no room for them), and `distribute` pays ATA(recipient, wSOL). A PQ vault of **another** mint named as a recipient could never move that account, so its whole share would be stranded (audit round 3, F3). The SDK refuses such recipients and any other vault-program account, and warns about other program-owned recipients: `checkFeeRecipients` as each recipient is entered, and `buildCreateLaunchTx` again before the wallet signs (the app builds with it). The identity attests the recipients, so a mistake cannot be undone.

## What can still go wrong

- A DAMM v2 operator can disable a pool. Trading stops, and the locked liquidity can then never be withdrawn by anyone.
- Operators can close migration configs, which stalls graduation until a config exists again (swaps revert between completion and migration).
- Someone has to call the fee instructions; fees accumulate safely until they do.
- Meteora's programs are upgradeable by a 4-of-7 multisig with no timelock. See [Security](/docs/security#who-you-still-trust).
