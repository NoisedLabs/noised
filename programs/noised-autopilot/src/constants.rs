//! Seeds, the fixed external program ids, and the bounds every run obeys
//! (spec §4). None of these can change after deployment: the program has no
//! admin and no configuration account.

use anchor_lang::prelude::*;

/// `["autopilot", launch]`: a launch's autopilot state.
pub const AUTOPILOT_SEED: &[u8] = b"autopilot";
/// `["treasury", launch]`: the treasury authority, owner of the treasury's
/// wSOL and token accounts. Derivable before the launch exists, so a creator
/// can name it as a fee recipient in `create_launch` (`distribute` then
/// pays its wSOL ATA).
pub const TREASURY_SEED: &[u8] = b"treasury";
/// `["graph", launch, graph_hash]`: a published PXG1 graph, at the address
/// its content hashes to.
pub const GRAPH_SEED: &[u8] = b"graph";

/// The Noised launchpad, whose `Launch`, `Certificate` and `Authorization`
/// accounts this program reads by layout (`launchpad.rs`).
pub const LAUNCHPAD_PROGRAM_ID: Pubkey = pubkey!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc");
/// Meteora Dynamic Bonding Curve: owner of a launch's DBC config, read once
/// for the migration price that seeds the reference price.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC's pool authority: the pool creator authority of the DAMM v2 configs
/// DBC migrates through, and a signer only in DBC's migration.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora DAMM v2 (cp_amm): the only program a buyback swaps through.
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const DAMM_V2_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_V2_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/// Wrapped SOL (SPL Token).
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// A launch's DAMM v2 pool is the one DBC created when it migrated the
/// curve: the pool `["pool", config, max(mint, wSOL), min(mint, wSOL)]` of a
/// DAMM v2 config whose pool creator authority is DBC's pool authority, the
/// only key such a config lets create a pool (`bind_pool`). DBC accepts any
/// config whose fields match the launch's migration fee option, so the
/// autopilot accepts any such config rather than a fixed list.
pub const DAMM_V2_POOL_SEED: &[u8] = b"pool";

/// Replacing an active graph takes effect at least this long after the
/// replacement became visible in the autopilot account (72 h), so holders
/// always see a change coming three days ahead.
pub const UPDATE_TIMELOCK_SECS: i64 = 259_200;

/// Paid to whoever runs a due node, in wSOL, from the treasury, after the
/// node's action.
pub const TIP_LAMPORTS: u64 = 100_000;
/// Tips are counted per UTC day (`now - now % TIP_EPOCH_SECS`).
pub const TIP_EPOCH_SECS: i64 = 86_400;
/// At most this much of the treasury goes to tips per tip epoch (50 tips).
pub const TIP_EPOCH_CAP: u64 = 5_000_000;

/// A tip is at most this share (per 10,000) of the value the run moved
/// (lamports swapped or paid; tokens burned, valued at the reference price),
/// so a run that moves dust earns dust: nobody profits from feeding the
/// treasury dust to collect tips.
pub const TIP_MAX_SHARE_BPS: u64 = 1_000;

/// Observations of the pool price (`update_price` and every run) are kept
/// as the lowest and highest price seen per bucket of this many seconds;
/// the current and the previous bucket (the last 15 to 30 minutes) are what
/// buybacks and the reference read.
pub const OBS_BUCKET_SECS: i64 = 900;
/// Those observations count only once they span at least this long (the
/// earliest is at least a minute old), so no single transaction (or
/// bundle) can be the only observation a buyback or a reference move reads.
pub const OBS_MIN_SPAN_SECS: i64 = 60;
/// The reference rises by at most this many sqrt-bps per hour, from an
/// allowance that accrues per second, is capped at one hour's worth and is
/// spent only by actual rises (so calls that move nothing cannot hold it
/// back): a rise from `r` to `r'` spends `(r' - r) / r`, at least
/// `ln(r' / r)`, so however a rise is split, it is at most
/// `e^0.0243 = 1.0246` in sqrt price per hour (`1.0246^2 = 1.0498`: 5% of
/// price). It falls at once.
pub const REF_UP_SQRT_BPS_PER_HOUR: u64 = 243;
/// The allowance in sqrt-bps-seconds: one hour's worth.
pub const REF_ALLOWANCE_MAX: u64 = REF_UP_SQRT_BPS_PER_HOUR * 3_600;
/// `BPS_DENOMINATOR * 3_600`: allowance units per unit of relative change.
pub const REF_ALLOWANCE_SCALE: u128 = 36_000_000;

/// A keeper may run a buyback for less than the most the node may move, but
/// not for less than this share (per 10,000) of the pool's wSOL (or the
/// most, if smaller): a buyback too large for the pool's depth and the
/// premium can still run in smaller steps, and nobody can waste a run on
/// dust.
pub const KEEPER_MIN_POOL_BPS: u64 = 100;

pub const BPS_DENOMINATOR: u64 = 10_000;
/// SPL Token / Token-2022 decimals of wSOL.
pub const WSOL_DECIMALS: u8 = 9;
