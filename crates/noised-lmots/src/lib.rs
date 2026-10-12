//! LM-OTS one-time signatures (RFC 8554 section 4), parameter set
//! `LMOTS_SHA256_N32_W4` (typecode 3): n = 32, w = 4, p = 67, ls = 4. The
//! [`lms`] module builds LMS (RFC 8554 section 5, `LMS_SHA256_M32_H10`) on
//! top of it: 1,024 of these one-time keys under one 56-byte public key.
//!
//! Both parameter sets are defined in RFC 8554 and also listed in NIST
//! SP 800-208. Noised's use is outside SP 800-208's requirements: its keys
//! are software keys derived from a recovery phrase (or a passkey secret),
//! which may be exported and copied, and `I`, `SEED` and `C` are derived
//! with SHA-256/HMAC rather than drawn from an approved random bit
//! generator, whereas SP 800-208 requires key generation and signing inside
//! non-exporting FIPS 140 Level 3 hardware modules, and approves LM-OTS only
//! as a component of LMS/HSS (the vault uses standalone LM-OTS keys). Nothing
//! here carries a NIST approval.
//!
//! Hash-based signatures rest only on SHA-256: a quantum computer gains at
//! most Grover's square-root speed-up against them, so this parameter set
//! keeps about 128-bit generic security against quantum attackers. It is the
//! standardized Winternitz scheme: interoperable, with published test vectors
//! (checked in `tests/lmots.rs` and `tests/lms.rs` against RFC 8554
//! Appendix F).
//!
//! Every hash is tweaked with the key identifier `I` (16 bytes), the leaf
//! index `q` and the chain/step position, which rules out multi-target
//! attacks. The randomizer `C` is unpredictable to anyone without the key,
//! so even messages an adversary helped shape cannot be attacked through
//! digest collisions. `PrivateKey::sign_deterministic` (feature `signer`)
//! derives it as
//! `HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || message)`
//! (the construction FIPS 205 uses for SLH-DSA's `PRF_msg`), so signing the
//! same message again reproduces the same signature.
//!
//! A key MUST produce at most one signature. Re-broadcasting that signature
//! is fine; a second signature, even of the same message under another `C`,
//! leaks enough chain values for forgeries.
//!
//! Byte layout (u32str/u16str are big-endian as in the RFC):
//!
//! ```text
//! x[i]  = SHA256(I || u32str(q) || u16str(i) || 0xff || SEED)          (Appendix A, signer only)
//! step  = SHA256(I || u32str(q) || u16str(i) || u8str(j) || tmp)       (55 bytes)
//! Q     = SHA256(I || u32str(q) || 0x8181 || C || message)
//! K     = SHA256(I || u32str(q) || 0x8080 || z[0] || ... || z[66])
//! sig   = C || y[0] || ... || y[66]                                     (2176 bytes; typecode implied)
//! ```
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::vec;

pub mod lms;

pub use lms::{
    identity_id, lms_verify, LmsPublicKey, LmsSignature, DOMAIN_IDENTITY_ID, D_INTR, D_LEAF,
    LMS_HEIGHT, LMS_LEAVES, LMS_OTS_TYPE, LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN, LMS_TREE_NODES,
    LMS_TYPE,
};
#[cfg(feature = "signer")]
pub use lms::{LmsKeyPair, LmsPrivateKey};

/// SHA-256 backend: the `sol_sha256` syscall on-chain, any SHA-256 off-chain.
pub trait Sha256 {
    /// SHA-256 of the concatenation of `parts`.
    fn hashv(parts: &[&[u8]]) -> [u8; 32];
}

/// RFC 8554 typecode of `LMOTS_SHA256_N32_W4`.
pub const TYPECODE: u32 = 3;
/// Hash output length.
pub const N: usize = 32;
/// Winternitz width in bits.
pub const W: usize = 4;
/// Number of chains: 64 message digits + 3 checksum digits.
pub const P: usize = 67;
/// Checksum left shift.
pub const LS: u32 = 4;
/// Last position on a chain (2^w - 1).
pub const CHAIN_END: u8 = 15;
/// Key identifier length.
pub const ID_LEN: usize = 16;
/// `C || y[0..p]`; the typecode is fixed by the verifier and not transmitted.
pub const SIG_LEN: usize = N + P * N;
/// Encoded public key: u32str(type) || I || u32str(q) || K.
pub const PUBLIC_KEY_LEN: usize = 4 + ID_LEN + 4 + N;

pub const D_PBLC: [u8; 2] = [0x80, 0x80];
pub const D_MESG: [u8; 2] = [0x81, 0x81];
/// Domain tag for [`key_id`] (outside the RFC's 0x80..0x83 range; the
/// registry of domain bytes is in the [`lms`] module documentation).
pub const DOMAIN_KEY_ID: u8 = 0x20;

/// LM-OTS public key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicKey {
    /// Key identifier `I`.
    pub id: [u8; ID_LEN],
    /// Leaf index `q`.
    pub q: u32,
    /// Public key hash `K`.
    pub k: [u8; N],
}

impl PublicKey {
    /// RFC 8554 encoding: u32str(type) || I || u32str(q) || K.
    pub fn to_bytes(&self) -> [u8; PUBLIC_KEY_LEN] {
        let mut out = [0u8; PUBLIC_KEY_LEN];
        out[0..4].copy_from_slice(&TYPECODE.to_be_bytes());
        out[4..20].copy_from_slice(&self.id);
        out[20..24].copy_from_slice(&self.q.to_be_bytes());
        out[24..56].copy_from_slice(&self.k);
        out
    }
}

/// Stable 32-byte identifier of a public key (used as a PDA seed).
pub fn key_id<H: Sha256>(pk: &PublicKey) -> [u8; 32] {
    H::hashv(&[&[DOMAIN_KEY_ID], &pk.to_bytes()])
}

/// Digit `i` of `Q || Cksm(Q)` for w = 4: high nibble first.
fn coef(v: &[u8; N + 2], i: usize) -> u8 {
    let byte = v[i / 2];
    if i.is_multiple_of(2) {
        byte >> 4
    } else {
        byte & 0x0f
    }
}

/// RFC 8554 Cksm: sum of (2^w - 1 - digit) over the n*8/w digits, shifted by ls.
fn checksum(q: &[u8; N]) -> u16 {
    let mut sum: u16 = 0;
    for byte in q {
        sum += (CHAIN_END - (byte >> 4)) as u16;
        sum += (CHAIN_END - (byte & 0x0f)) as u16;
    }
    sum << LS
}

/// `Q || Cksm(Q)` for a message under key (I, q) and randomizer C.
fn digest<H: Sha256>(id: &[u8; ID_LEN], q: u32, c: &[u8], msg: &[u8]) -> [u8; N + 2] {
    let q_hash = H::hashv(&[id, &q.to_be_bytes(), &D_MESG, c, msg]);
    let mut v = [0u8; N + 2];
    v[..N].copy_from_slice(&q_hash);
    v[N..].copy_from_slice(&checksum(&q_hash).to_be_bytes());
    v
}

/// Apply the chain step for j in `start..end` to `value` on chain `i`.
fn walk<H: Sha256>(id: &[u8; ID_LEN], q: u32, i: u16, start: u8, end: u8, value: &[u8]) -> [u8; N] {
    // One contiguous 55-byte buffer keeps each syscall to a single slice.
    let mut buf = [0u8; ID_LEN + 4 + 2 + 1 + N];
    buf[..16].copy_from_slice(id);
    buf[16..20].copy_from_slice(&q.to_be_bytes());
    buf[20..22].copy_from_slice(&i.to_be_bytes());
    buf[23..55].copy_from_slice(value);
    for j in start..end {
        buf[22] = j;
        let h = H::hashv(&[&buf]);
        buf[23..55].copy_from_slice(&h);
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&buf[23..55]);
    out
}

/// RFC 8554 Algorithm 4b: the public key hash `Kc` a signature implies, or
/// `None` if the signature has the wrong length.
pub fn candidate_public_key<H: Sha256>(
    id: &[u8; ID_LEN],
    q: u32,
    msg: &[u8],
    sig: &[u8],
) -> Option<[u8; N]> {
    if sig.len() != SIG_LEN {
        return None;
    }
    let (c, ys) = sig.split_at(N);
    let v = digest::<H>(id, q, c, msg);
    let mut z = vec![0u8; P * N];
    for i in 0..P {
        let start = coef(&v, i);
        let end = walk::<H>(id, q, i as u16, start, CHAIN_END, &ys[i * N..(i + 1) * N]);
        z[i * N..(i + 1) * N].copy_from_slice(&end);
    }
    Some(H::hashv(&[id, &q.to_be_bytes(), &D_PBLC, &z]))
}

/// Verify `sig` over `msg` under `pk`.
pub fn verify<H: Sha256>(pk: &PublicKey, msg: &[u8], sig: &[u8]) -> bool {
    match candidate_public_key::<H>(&pk.id, pk.q, msg, sig) {
        Some(k) => constant_time_eq(&k, &pk.k),
        None => false,
    }
}

/// Comparison whose timing does not depend on where the inputs differ.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Domain tag of the deterministic randomizer (see `PrivateKey::randomizer`).
pub const RANDOMIZER_TAG: &[u8] = b"phalanx/pq/lmots/C"; // protocol constant: kept from the original name; changing it changes signatures

/// HMAC-SHA256 (RFC 2104) over the concatenation of `parts`, for keys of at
/// most one block (64 bytes).
#[cfg(feature = "signer")]
pub fn hmac_sha256<H: Sha256>(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    const BLOCK: usize = 64;
    assert!(key.len() <= BLOCK, "HMAC key longer than one block");
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for (i, b) in key.iter().enumerate() {
        ipad[i] ^= b;
        opad[i] ^= b;
    }
    let mut inner_parts: alloc::vec::Vec<&[u8]> = alloc::vec::Vec::with_capacity(parts.len() + 1);
    inner_parts.push(&ipad);
    inner_parts.extend_from_slice(parts);
    let inner = H::hashv(&inner_parts);
    H::hashv(&[&opad, &inner])
}

/// LM-OTS private key with RFC 8554 Appendix A pseudorandom chain secrets.
#[cfg(feature = "signer")]
pub struct PrivateKey {
    pub id: [u8; ID_LEN],
    pub q: u32,
    pub seed: [u8; N],
}

#[cfg(feature = "signer")]
impl PrivateKey {
    fn secret<H: Sha256>(&self, i: u16) -> [u8; N] {
        H::hashv(&[
            &self.id,
            &self.q.to_be_bytes(),
            &i.to_be_bytes(),
            &[0xff],
            &self.seed,
        ])
    }

    /// RFC 8554 Algorithm 1.
    pub fn public_key<H: Sha256>(&self) -> PublicKey {
        let mut y = vec![0u8; P * N];
        for i in 0..P {
            let end = walk::<H>(
                &self.id,
                self.q,
                i as u16,
                0,
                CHAIN_END,
                &self.secret::<H>(i as u16),
            );
            y[i * N..(i + 1) * N].copy_from_slice(&end);
        }
        PublicKey {
            id: self.id,
            q: self.q,
            k: H::hashv(&[&self.id, &self.q.to_be_bytes(), &D_PBLC, &y]),
        }
    }

    /// Deterministic, secret-keyed randomizer for `msg`:
    /// `HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || msg)`.
    /// Nobody without SEED can predict it, and it is the same every time the
    /// same message is signed.
    pub fn randomizer<H: Sha256>(&self, msg: &[u8]) -> [u8; N] {
        hmac_sha256::<H>(
            &self.seed,
            &[RANDOMIZER_TAG, &self.id, &self.q.to_be_bytes(), msg],
        )
    }

    /// [`sign`](Self::sign) with [`randomizer`](Self::randomizer): signing the
    /// same message twice yields the identical signature, so a retry can never
    /// become a second one-time signature.
    pub fn sign_deterministic<H: Sha256>(&self, msg: &[u8], out: &mut [u8]) -> bool {
        let c = self.randomizer::<H>(msg);
        self.sign::<H>(msg, &c, out)
    }

    /// RFC 8554 Algorithm 3 with caller-supplied randomizer `c` (unpredictable
    /// to others; prefer [`sign_deterministic`](Self::sign_deterministic)).
    /// Writes `C || y` into `out`.
    pub fn sign<H: Sha256>(&self, msg: &[u8], c: &[u8; N], out: &mut [u8]) -> bool {
        if out.len() != SIG_LEN {
            return false;
        }
        let v = digest::<H>(&self.id, self.q, c, msg);
        out[..N].copy_from_slice(c);
        for i in 0..P {
            let a = coef(&v, i);
            let y = walk::<H>(
                &self.id,
                self.q,
                i as u16,
                0,
                a,
                &self.secret::<H>(i as u16),
            );
            out[N + i * N..N + (i + 1) * N].copy_from_slice(&y);
        }
        true
    }
}

/// SHA-256 via the `sha2` crate, for clients and tests.
#[cfg(feature = "sha2-backend")]
pub struct Sha2;

#[cfg(feature = "sha2-backend")]
impl Sha256 for Sha2 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_bounds() {
        // All-zero digest: every digit contributes 15 -> 64 * 15 = 960, shifted by 4.
        assert_eq!(checksum(&[0u8; 32]), 960 << 4);
        assert_eq!(checksum(&[0xffu8; 32]), 0);
        // The 3 checksum digits (12 bits) cover the maximum 960 (< 4096),
        // so no checksum information is lost to the ls = 4 shift.
    }

    #[test]
    fn coef_reads_high_nibble_first() {
        let mut v = [0u8; 34];
        v[0] = 0xab;
        v[33] = 0xc0;
        assert_eq!(coef(&v, 0), 0xa);
        assert_eq!(coef(&v, 1), 0xb);
        assert_eq!(coef(&v, 66), 0xc);
    }
}
