//! Host unit tests for the pure parts of the program: safety policy, payout
//! math, fee schedule math, mint/config post-conditions, the metadata record
//! and fixed values.

mod checks_tests;
mod math_tests;
mod metadata_tests;
mod params_tests;
mod policy_tests;
mod pq_tests;
mod rules_auth_tests;
mod schedule_tests;

use anchor_lang::prelude::Pubkey;

use crate::state::{BaseFeeParams, CurvePoint, FeeRecipient, LaunchParams};

pub fn key(b: u8) -> Pubkey {
    Pubkey::new_from_array([b; 32])
}

/// Deterministic pseudo-random stream for property checks.
pub struct Lcg(pub u64);

impl Lcg {
    pub fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A launch every bound accepts: 1% floor fee reached after 10s, 60s open
/// delay (the shortest), no batch caps.
pub fn good_params() -> LaunchParams {
    LaunchParams {
        token_decimal: 6,
        sqrt_start_price: 1u128 << 60,
        curve: vec![
            CurvePoint {
                sqrt_price: 1u128 << 62,
                liquidity: 1u128 << 90,
            },
            CurvePoint {
                sqrt_price: 1u128 << 63,
                liquidity: 1u128 << 89,
            },
        ],
        migration_quote_threshold: 85 * crate::constants::LAMPORTS_PER_SOL,
        base_fee: BaseFeeParams {
            cliff_fee_numerator: 500_000_000,
            first_factor: 10,
            second_factor: 1,
            third_factor: 49_000_000,
            base_fee_mode: 0,
        },
        dynamic_fee: None,
        migration_fee_option: 2,
        open_delay_secs: 60,
        guard_secs: 3_600,
        max_wallet_bps: 100,
        max_buy_bps: 50,
        p2p_locked: false,
        batch_wallet_cap: 0,
        batch_total_cap: 0,
        recipients: vec![
            FeeRecipient {
                wallet: key(7),
                bps: 7_000,
            },
            FeeRecipient {
                wallet: key(8),
                bps: 3_000,
            },
        ],
        pq_identity: [0x1D; 32],
    }
}
