//! Host cost of LMS (LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4): key
//! generation, signing and verification time, and the `sol_sha256` syscall
//! CU that verification spends on-chain (Agave 4.3 pricing: 85 per call plus,
//! per input slice, max(10, len / 2)).
//!
//! ```text
//! cargo run --release -p noised-lmots --features signer,sha2-backend --example lms_bench
//! ```

use std::cell::Cell;
use std::time::Instant;

use noised_lmots::{lms_verify, LmsPrivateKey, Sha2, Sha256, LMS_LEAVES};

thread_local! {
    static CU: Cell<u64> = const { Cell::new(0) };
}

struct Metered;

impl Sha256 for Metered {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        let cu = 85
            + parts
                .iter()
                .map(|p| (p.len() as u64 / 2).max(10))
                .sum::<u64>();
        CU.with(|c| c.set(c.get() + cu));
        Sha2::hashv(parts)
    }
}

/// A 173-byte message shaped like the first launch attestation message (the
/// launchpad's message v2 is 189 bytes: 8 CU more to hash).
fn message(q: u32) -> Vec<u8> {
    let mut m = b"PHX-ATTEST-V1".to_vec();
    for field in 0..5u32 {
        m.extend_from_slice(&Sha2::hashv(&[&q.to_le_bytes(), &field.to_le_bytes()]));
    }
    m
}

fn main() {
    let sk = LmsPrivateKey {
        seed: Sha2::hashv(&[b"lms-bench seed"]),
        id: Sha2::hashv(&[b"lms-bench id"])[..16].try_into().unwrap(),
    };

    let runs = 3;
    let mut keygen = f64::MAX;
    let mut kp = None;
    for _ in 0..runs {
        let t = Instant::now();
        let built = sk.keygen::<Sha2>();
        keygen = keygen.min(t.elapsed().as_secs_f64());
        kp = Some(built);
    }
    let kp = kp.unwrap();
    let pk = kp.public_key().to_bytes();
    println!(
        "keygen (1,024 leaves, 2,047 nodes): {:.1} ms (best of {runs})",
        keygen * 1e3
    );

    let msgs: Vec<Vec<u8>> = (0..LMS_LEAVES).map(message).collect();
    let t = Instant::now();
    let sigs: Vec<Vec<u8>> = (0..LMS_LEAVES)
        .map(|q| kp.sign_deterministic::<Sha2>(q, &msgs[q as usize]).unwrap())
        .collect();
    let sign = t.elapsed().as_secs_f64() / f64::from(LMS_LEAVES);
    println!(
        "sign_deterministic (incl. self-verify): {:.1} us per signature",
        sign * 1e6
    );

    let t = Instant::now();
    for q in 0..LMS_LEAVES {
        assert_eq!(
            lms_verify::<Sha2>(&pk, &msgs[q as usize], &sigs[q as usize]),
            Some(q)
        );
    }
    let verify = t.elapsed().as_secs_f64() / f64::from(LMS_LEAVES);
    println!("lms_verify: {:.1} us per signature", verify * 1e6);

    let mut cus: Vec<u64> = (0..LMS_LEAVES)
        .map(|q| {
            CU.with(|c| c.set(0));
            assert_eq!(
                lms_verify::<Metered>(&pk, &msgs[q as usize], &sigs[q as usize]),
                Some(q)
            );
            CU.with(|c| c.get())
        })
        .collect();
    cus.sort_unstable();
    let mean = cus.iter().sum::<u64>() as f64 / cus.len() as f64;
    let p99 = cus[cus.len() * 99 / 100];
    // Syscall CU = 3,005 + 112 * steps for these 173-byte messages; a whole
    // verification measured 8,674 + 137 * steps CU on SBF (src/lms.rs, Cost).
    let steps = |cu: u64| (cu - 3_005) / 112;
    let sbf = |cu: u64| 8_674 + 137 * steps(cu);
    println!(
        "lms_verify sol_sha256 syscall CU over {} signatures: min {}, mean {mean:.0}, p99 {p99}, max {} \
         (worst case possible 113,885); whole verification on SBF (8,674 + 137 * steps): \
         mean {:.0}, p99 {}, max {} (worst case possible 144,304)",
        cus.len(),
        cus[0],
        cus[cus.len() - 1],
        8_674.0 + 137.0 * (mean - 3_005.0) / 112.0,
        sbf(p99),
        sbf(cus[cus.len() - 1]),
    );
}
