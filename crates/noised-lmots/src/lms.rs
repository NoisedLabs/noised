//! LMS hash-based signatures (RFC 8554 section 5), parameter set
//! `LMS_SHA256_M32_H10` (typecode 6) over `LMOTS_SHA256_N32_W4` (typecode 3):
//! one 56-byte public key for 1,024 one-time leaves. A Noised creator
//! identity is one LMS key; on-chain it is named by [`identity_id`].
//!
//! Byte formats (u32str is big-endian, as in the RFC):
//!
//! ```text
//! public key = u32str(6) || u32str(3) || I (16) || T[1] (32)                      56 bytes
//! signature  = u32str(q) || u32str(3) || C (32) || y[0] .. y[66] (67 * 32)
//!              || u32str(6) || path[0] .. path[9] (10 * 32)                      2,508 bytes
//!   offsets:   q 0..4 | LM-OTS type 4..8 | C 8..40 | y 40..2184 | LMS type 2184..2188 | path 2188..2508
//! leaf       T[r] = SHA256(I || u32str(r) || 0x8282 || K_q)                  r = 1024 + q
//! interior   T[r] = SHA256(I || u32str(r) || 0x8383 || T[2r] || T[2r+1])   1 <= r < 1024
//! identity   identity_id = SHA256(0x21 || public key)
//! ```
//!
//! `K_q` is the LM-OTS public key hash of leaf `q`: the crate's LM-OTS
//! `PrivateKey` with the tree's `I` and `SEED` and leaf index `q` (RFC 8554
//! Appendix A). `path[0]` is the sibling of the leaf and
//! `path[9]` the child of the root that is not on the leaf's path.
//!
//! # Use
//!
//! On-chain (no features), with the program's `sol_sha256` backend:
//!
//! ```text
//! struct SolSha256;
//! impl noised_lmots::Sha256 for SolSha256 {
//!     fn hashv(parts: &[&[u8]]) -> [u8; 32] { solana_sha256_hasher::hashv(parts).to_bytes() }
//! }
//! // lms_pk: [u8; 56], lms_sig: Vec<u8> (2,508 bytes), message: the signed bytes
//! require!(identity_id::<SolSha256>(&lms_pk) == launch.pq_identity, ...);
//! let q: u32 = lms_verify::<SolSha256>(&lms_pk, &message, &lms_sig).ok_or(...)?; // q < 1024
//! ```
//!
//! Off-chain (features `signer` and `sha2-backend`):
//!
//! ```
//! # #[cfg(all(feature = "signer", feature = "sha2-backend"))] {
//! use noised_lmots::{identity_id, lms_verify, LmsPrivateKey, LmsSignature, Sha2};
//!
//! let master = [7u8; 64]; // the PQ recovery phrase's BIP-39 seed
//! let key = LmsPrivateKey::derive_identity::<Sha2>(&master, 2, 0).unwrap(); // localnet, identity 0
//! let pair = key.keygen::<Sha2>(); // the whole tree: about 1.14M SHA-256 compressions
//! let pk: [u8; 56] = pair.public_key().to_bytes();
//! let pq_identity = identity_id::<Sha2>(&pk);
//! assert_eq!(pq_identity, pair.identity_id::<Sha2>());
//!
//! // Leaf 5 signs this message and nothing else, ever.
//! let sig = pair.sign_deterministic::<Sha2>(5, b"message").unwrap();
//! assert_eq!(sig.len(), 2508);
//! assert_eq!(LmsSignature::parse(&sig).unwrap().q, 5);
//! assert_eq!(lms_verify::<Sha2>(&pk, b"message", &sig), Some(5));
//! assert_eq!(lms_verify::<Sha2>(&pk, b"another message", &sig), None);
//! # }
//! ```
//!
//! # Verification
//!
//! [`lms_verify`] is RFC 8554 Algorithms 6 and 6a with every length and
//! typecode fixed: the public key must be types 6/3, the signature exactly
//! 2,508 bytes with types 3 (at 4..8) and 6 (at 2184..2188), and
//! `q < 1024`. It recomputes the LM-OTS key `Kc` from `C`, `y` and the
//! message, hashes it into leaf `1024 + q`, climbs the path and compares the
//! result with `T[1]` in constant time. It returns the leaf `q`, which is
//! read from the signature only: no function takes a separate leaf index, so
//! a caller cannot record one leaf while the signature used another.
//!
//! # One message per leaf, ever
//!
//! LMS is stateful. Two signatures of different messages (or of one message
//! under two randomizers) from the same leaf let anyone forge signatures
//! from that leaf. Nothing in this crate tracks used leaves: the launchpad's
//! on-chain bitmap records the leaves whose signatures LANDED, and a signer
//! must also keep durable records of every signature it has revealed (sent,
//! simulated or stored), because a revealed signature that never landed
//! still uses its leaf. `LmsKeyPair::sign_deterministic` makes retries
//! safe: signing the same message at the same leaf reproduces the same
//! bytes. A signature is self-verified before it is returned.
//!
//! # Domain separation
//!
//! Every SHA-256 input in this crate starts with one of:
//!
//! | prefix | hash |
//! |---|---|
//! | `I` (16 bytes), then `u32str(q or r)` | the RFC 8554 hashes: secret `x` (`u16str(i) \|\| 0xff`), chain step (`u16str(i) \|\| u8str(j)`), `Q` (`0x8181`), `K` (`0x8080`), leaf (`0x8282`), interior (`0x8383`) |
//! | `0x20` | [`key_id`](crate::key_id) of an LM-OTS public key (vault keys) |
//! | `0x21` | [`identity_id`] of an LMS public key (creator identities) |
//! | an ASCII tag `phalanx/pq/...` | client-side key derivation and the HMAC randomizer |
//!
//! The RFC tags 0x80..0x83 occur only inside the RFC hashes, after `I`.
//! New Noised domain bytes take the next free value (0x22, ...).
//!
//! # Cost
//!
//! Verification hashes `Q`, one chain step per remaining Winternitz digit
//! (`sum(15 - digit)` over the 67 chains: about 506 on average, 600 at the
//! 99th percentile and 990 at most), `K`, the leaf and 10 interior nodes.
//! Under the `sol_sha256` syscall pricing (85 CU per call plus, per input
//! slice, max(10, len / 2)), for a 173-byte message that is
//! `3,005 + 112 * steps` CU of syscalls (about 60k on average, 114k at
//! most; `tests/lms.rs` pins this model). Measured on SBF (SBPF v3 release
//! build, LiteSVM 0.17 with Agave 4.3's cost model, 129 signatures of
//! 173-byte messages), a whole `lms_verify` costs `8,674 + 137 * steps` CU
//! (largest residual 14 CU): about 78k on average, 91k at the 99th
//! percentile and 144k for the worst digest any signature can have; RFC 8554
//! Test Case 2 (525 steps, 56-byte message) took 80,563 CU.
//! Signing walks the other part of each chain (about 500 steps plus 67
//! secrets) and self-verifies. Key generation is about 1.14 million SHA-256
//! compressions. On a Ryzen 7 5800X with the `sha2` backend (release build,
//! SHA extensions) `examples/lms_bench.rs` measured: key generation 62 ms,
//! signing 65 us (with the self-verification), verification 31 us; over
//! 1,024 signatures of 173-byte messages the verification syscalls cost
//! 43k-74k CU (mean 59.6k, 99th percentile 70.2k). (The launchpad's
//! attestation message grew to 221 bytes, with the metadata document's hash
//! and the launch window: hashing `Q` costs 24 CU more.)

#[cfg(feature = "signer")]
use crate::PrivateKey;
use crate::{candidate_public_key, constant_time_eq, Sha256, ID_LEN, N, SIG_LEN, TYPECODE};
#[cfg(feature = "signer")]
use alloc::{vec, vec::Vec};

/// RFC 8554 typecode of `LMS_SHA256_M32_H10`.
pub const LMS_TYPE: u32 = 6;
/// LM-OTS typecode of the leaves (`LMOTS_SHA256_N32_W4`).
pub const LMS_OTS_TYPE: u32 = TYPECODE;
/// Tree height `h`.
pub const LMS_HEIGHT: u32 = 10;
/// One-time leaves per key (2^h).
pub const LMS_LEAVES: u32 = 1 << LMS_HEIGHT;
/// Nodes `T[1] .. T[2^(h+1) - 1]` of the tree.
pub const LMS_TREE_NODES: usize = 2 * LMS_LEAVES as usize - 1;
/// `u32str(type) || u32str(otstype) || I || T[1]`.
pub const LMS_PUBLIC_KEY_LEN: usize = 4 + 4 + ID_LEN + N;
/// `u32str(q) || u32str(otstype) || C || y || u32str(type) || path`.
pub const LMS_SIG_LEN: usize = 4 + 4 + SIG_LEN + 4 + LMS_HEIGHT as usize * N;
/// Leaf-node hash tag.
pub const D_LEAF: [u8; 2] = [0x82, 0x82];
/// Interior-node hash tag.
pub const D_INTR: [u8; 2] = [0x83, 0x83];
/// Domain byte of [`identity_id`] (0x20 is [`key_id`](crate::key_id)).
pub const DOMAIN_IDENTITY_ID: u8 = 0x21;

/// Offset of the LM-OTS typecode in a signature.
const OTS_TYPE_AT: usize = 4;
/// Offset of `C || y` (the LM-OTS signature without its typecode).
const OTS_SIG_AT: usize = 8;
/// Offset of the LMS typecode.
const LMS_TYPE_AT: usize = OTS_SIG_AT + SIG_LEN;
/// Offset of `path[0]`.
const PATH_AT: usize = LMS_TYPE_AT + 4;

const _: () = assert!(LMS_PUBLIC_KEY_LEN == 56);
const _: () = assert!(LMS_SIG_LEN == 2508);
const _: () = assert!(LMS_TYPE_AT == 2184 && PATH_AT == 2188);
const _: () = assert!(PATH_AT + LMS_HEIGHT as usize * N == LMS_SIG_LEN);
const _: () = assert!(LMS_TREE_NODES == 2047);

/// Big-endian u32 at `at` (callers have checked the length).
fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// A parsed LMS public key of this parameter set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LmsPublicKey {
    /// Key identifier `I`.
    pub id: [u8; ID_LEN],
    /// Root `T[1]`.
    pub root: [u8; N],
}

impl LmsPublicKey {
    /// Strict parse: exactly 56 bytes with typecodes 6 (`LMS_SHA256_M32_H10`)
    /// and 3 (`LMOTS_SHA256_N32_W4`); anything else is `None`.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != LMS_PUBLIC_KEY_LEN
            || be32(bytes, 0) != LMS_TYPE
            || be32(bytes, 4) != LMS_OTS_TYPE
        {
            return None;
        }
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(&bytes[8..8 + ID_LEN]);
        let mut root = [0u8; N];
        root.copy_from_slice(&bytes[8 + ID_LEN..]);
        Some(Self { id, root })
    }

    /// RFC 8554 encoding: `u32str(6) || u32str(3) || I || T[1]`.
    pub fn to_bytes(&self) -> [u8; LMS_PUBLIC_KEY_LEN] {
        let mut out = [0u8; LMS_PUBLIC_KEY_LEN];
        out[0..4].copy_from_slice(&LMS_TYPE.to_be_bytes());
        out[4..8].copy_from_slice(&LMS_OTS_TYPE.to_be_bytes());
        out[8..8 + ID_LEN].copy_from_slice(&self.id);
        out[8 + ID_LEN..].copy_from_slice(&self.root);
        out
    }
}

/// A parsed LMS signature of this parameter set (borrows the input bytes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LmsSignature<'a> {
    /// Leaf index `q` (< 1024).
    pub q: u32,
    /// `C || y[0] || ... || y[66]` (2,176 bytes): the LM-OTS signature
    /// without its typecode, as [`candidate_public_key`] takes it.
    pub ots_signature: &'a [u8],
    /// `path[0] || ... || path[9]` (320 bytes), from the leaf's sibling up.
    pub path: &'a [u8],
}

impl<'a> LmsSignature<'a> {
    /// Strict parse: exactly 2,508 bytes, LM-OTS typecode 3 at 4..8, LMS
    /// typecode 6 at 2184..2188 and `q < 1024`; anything else is `None`.
    pub fn parse(sig: &'a [u8]) -> Option<Self> {
        if sig.len() != LMS_SIG_LEN
            || be32(sig, OTS_TYPE_AT) != LMS_OTS_TYPE
            || be32(sig, LMS_TYPE_AT) != LMS_TYPE
        {
            return None;
        }
        let q = be32(sig, 0);
        if q >= LMS_LEAVES {
            return None;
        }
        Some(Self {
            q,
            ots_signature: &sig[OTS_SIG_AT..LMS_TYPE_AT],
            path: &sig[PATH_AT..],
        })
    }
}

/// RFC 8554 Algorithm 6a step 4 for a tree of height `path.len() / N`: the
/// root implied by leaf `q`'s LM-OTS public key hash `kc` and its
/// authentication path. Callers guarantee `q < 2^height` and whole nodes.
fn root_from_path<H: Sha256>(id: &[u8; ID_LEN], q: u32, kc: &[u8; N], path: &[u8]) -> [u8; N] {
    let mut node = (1u32 << (path.len() / N)) + q;
    let mut tmp = H::hashv(&[id, &node.to_be_bytes(), &D_LEAF, kc]);
    for sibling in path.as_chunks::<N>().0 {
        let parent = (node / 2).to_be_bytes();
        tmp = if node.is_multiple_of(2) {
            H::hashv(&[id, &parent, &D_INTR, &tmp, sibling])
        } else {
            H::hashv(&[id, &parent, &D_INTR, sibling, &tmp])
        };
        node /= 2;
    }
    tmp
}

/// Verify an LMS signature (RFC 8554 Algorithms 6 and 6a) and return the leaf
/// `q` it used, or `None` if the key or signature is malformed (see
/// [`LmsPublicKey::from_bytes`] and [`LmsSignature::parse`]) or the
/// signature does not verify. The leaf comes from the signature only.
#[must_use]
pub fn lms_verify<H: Sha256>(pk: &[u8; LMS_PUBLIC_KEY_LEN], msg: &[u8], sig: &[u8]) -> Option<u32> {
    let pk = LmsPublicKey::from_bytes(pk)?;
    let sig = LmsSignature::parse(sig)?;
    let kc = candidate_public_key::<H>(&pk.id, sig.q, msg, sig.ots_signature)?;
    let root = root_from_path::<H>(&pk.id, sig.q, &kc, sig.path);
    if constant_time_eq(&root, &pk.root) {
        Some(sig.q)
    } else {
        None
    }
}

/// Stable 32-byte name of an LMS public key: `SHA256(0x21 || pk)`. This is a
/// launch's `pq_identity` and the seed of its identity account.
pub fn identity_id<H: Sha256>(pk: &[u8; LMS_PUBLIC_KEY_LEN]) -> [u8; 32] {
    H::hashv(&[&[DOMAIN_IDENTITY_ID], pk])
}

/// Domain tag of an identity's `SEED` (see [`LmsPrivateKey::derive_identity`]).
#[cfg(feature = "signer")]
pub const IDENTITY_SEED_TAG: &[u8] = b"phalanx/pq/identity/v1/seed"; // protocol constants (both identity tags): kept from the original name; changing them changes every key derived from a phrase or passkey
/// Domain tag of an identity's `I` (see [`LmsPrivateKey::derive_identity`]).
#[cfg(feature = "signer")]
pub const IDENTITY_ID_TAG: &[u8] = b"phalanx/pq/identity/v1/id";
/// Largest cluster byte of the identity derivation (0 mainnet, 1 devnet,
/// 2 localnet).
#[cfg(feature = "signer")]
pub const MAX_IDENTITY_CLUSTER: u8 = 2;

/// LMS private key: `SEED` and `I`. Leaf `q` is the LM-OTS key
/// `PrivateKey { id: I, q, seed: SEED }` (RFC 8554 Appendix A).
#[cfg(feature = "signer")]
pub struct LmsPrivateKey {
    pub seed: [u8; N],
    pub id: [u8; ID_LEN],
}

#[cfg(feature = "signer")]
impl LmsPrivateKey {
    /// Creator identity key number `identity_index` of a PQ recovery phrase on
    /// a cluster (`master` is the phrase's 64-byte BIP-39 seed):
    ///
    /// ```text
    /// path = cluster (0 mainnet, 1 devnet, 2 localnet) || u32le(identity_index)
    /// SEED = SHA256("phalanx/pq/identity/v1/seed" || master || path)
    /// I    = SHA256("phalanx/pq/identity/v1/id"   || master || path)[..16]
    /// ```
    ///
    /// The cluster keeps each cluster's leaves apart (the program cannot see
    /// which cluster it runs on). `None` for a cluster above 2 or an all-zero
    /// master (no phrase has it, and every key derived from it is public).
    pub fn derive_identity<H: Sha256>(
        master: &[u8; 64],
        cluster: u8,
        identity_index: u32,
    ) -> Option<Self> {
        if cluster > MAX_IDENTITY_CLUSTER || master.iter().all(|&b| b == 0) {
            return None;
        }
        let mut path = [0u8; 5];
        path[0] = cluster;
        path[1..].copy_from_slice(&identity_index.to_le_bytes());
        let seed = H::hashv(&[IDENTITY_SEED_TAG, master, &path]);
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(&H::hashv(&[IDENTITY_ID_TAG, master, &path])[..ID_LEN]);
        Some(Self { seed, id })
    }

    /// The LM-OTS private key of leaf `q`, or `None` if `q >= 1024`.
    pub fn leaf(&self, q: u32) -> Option<PrivateKey> {
        if q >= LMS_LEAVES {
            return None;
        }
        Some(PrivateKey {
            id: self.id,
            q,
            seed: self.seed,
        })
    }

    /// Build the whole tree (RFC 8554 sections 5.2 and 5.3): all 1,024
    /// LM-OTS public keys and the 2,047 node hashes, about 1.14 million
    /// SHA-256 compressions.
    pub fn keygen<H: Sha256>(&self) -> LmsKeyPair {
        let leaves: Vec<[u8; N]> = (0..LMS_LEAVES)
            .map(|q| {
                PrivateKey {
                    id: self.id,
                    q,
                    seed: self.seed,
                }
                .public_key::<H>()
                .k
            })
            .collect();
        LmsKeyPair {
            private_key: LmsPrivateKey {
                seed: self.seed,
                id: self.id,
            },
            nodes: build_tree::<H>(&self.id, &leaves),
        }
    }
}

/// An LMS private key with its tree: everything needed to sign at any leaf.
/// The node hashes are public (they appear in authentication paths).
#[cfg(feature = "signer")]
pub struct LmsKeyPair {
    private_key: LmsPrivateKey,
    /// `T[r]` at index `r` for 1 <= r < 2048 (index 0 is unused).
    nodes: Vec<[u8; N]>,
}

#[cfg(feature = "signer")]
impl LmsKeyPair {
    pub fn private_key(&self) -> &LmsPrivateKey {
        &self.private_key
    }

    /// The public key (`I` and the root `T[1]`); `.to_bytes()` encodes it.
    pub fn public_key(&self) -> LmsPublicKey {
        LmsPublicKey {
            id: self.private_key.id,
            root: self.nodes[1],
        }
    }

    /// [`identity_id`] of the public key.
    pub fn identity_id<H: Sha256>(&self) -> [u8; 32] {
        identity_id::<H>(&self.public_key().to_bytes())
    }

    /// The 2,047 node hashes `T[1] .. T[2047]` (`nodes()[r - 1]` is `T[r]`;
    /// leaf `q` is `T[1024 + q]`).
    pub fn nodes(&self) -> &[[u8; N]] {
        &self.nodes[1..]
    }

    /// Authentication path of leaf `q` (RFC 8554 Appendix D), or `None` if
    /// `q >= 1024`.
    pub fn auth_path(&self, q: u32) -> Option<[[u8; N]; LMS_HEIGHT as usize]> {
        if q >= LMS_LEAVES {
            return None;
        }
        let mut path = [[0u8; N]; LMS_HEIGHT as usize];
        fill_auth_path(&self.nodes, q, &mut path);
        Some(path)
    }

    /// Sign `msg` at leaf `q` with randomizer `c` (RFC 8554 section 5.4.1),
    /// returning the 2,508-byte signature, or `None` if `q >= 1024` or the
    /// result does not verify against [`public_key`](Self::public_key)
    /// (nothing is returned then). Each leaf may sign ONE message, ever; prefer
    /// [`sign_deterministic`](Self::sign_deterministic).
    pub fn sign<H: Sha256>(&self, q: u32, msg: &[u8], c: &[u8; N]) -> Option<Vec<u8>> {
        let leaf = self.private_key.leaf(q)?;
        let path = self.auth_path(q)?;
        let mut sig = vec![0u8; LMS_SIG_LEN];
        sig[..OTS_TYPE_AT].copy_from_slice(&q.to_be_bytes());
        sig[OTS_TYPE_AT..OTS_SIG_AT].copy_from_slice(&LMS_OTS_TYPE.to_be_bytes());
        if !leaf.sign::<H>(msg, c, &mut sig[OTS_SIG_AT..LMS_TYPE_AT]) {
            return None;
        }
        sig[LMS_TYPE_AT..PATH_AT].copy_from_slice(&LMS_TYPE.to_be_bytes());
        for (out, node) in sig[PATH_AT..].as_chunks_mut::<N>().0.iter_mut().zip(&path) {
            *out = *node;
        }
        if lms_verify::<H>(&self.public_key().to_bytes(), msg, &sig) != Some(q) {
            return None;
        }
        Some(sig)
    }

    /// [`sign`](Self::sign) with leaf `q`'s deterministic randomizer
    /// `C = HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32str(q) || msg)`
    /// ([`PrivateKey::randomizer`]): signing the same message at the same leaf
    /// again yields the identical signature, so a retry is never a second
    /// one-time signature.
    pub fn sign_deterministic<H: Sha256>(&self, q: u32, msg: &[u8]) -> Option<Vec<u8>> {
        let c = self.private_key.leaf(q)?.randomizer::<H>(msg);
        self.sign::<H>(q, msg, &c)
    }
}

/// RFC 8554 section 5.3 for a tree of height `log2(leaves.len())` over the
/// LM-OTS public key hashes `leaves`: `T[r]` at index `r` for
/// `1 <= r < 2 * leaves.len()` (index 0 is unused).
#[cfg(feature = "signer")]
fn build_tree<H: Sha256>(id: &[u8; ID_LEN], leaves: &[[u8; N]]) -> Vec<[u8; N]> {
    let width = leaves.len();
    debug_assert!(width.is_power_of_two() && width >= 2);
    let mut nodes = vec![[0u8; N]; 2 * width];
    for (i, k) in leaves.iter().enumerate() {
        let r = width + i;
        nodes[r] = H::hashv(&[id, &(r as u32).to_be_bytes(), &D_LEAF, k]);
    }
    for r in (1..width).rev() {
        nodes[r] = H::hashv(&[
            id,
            &(r as u32).to_be_bytes(),
            &D_INTR,
            &nodes[2 * r],
            &nodes[2 * r + 1],
        ]);
    }
    nodes
}

/// RFC 8554 Appendix D for a tree of height `path.len()` (`nodes` as built by
/// [`build_tree`]): `path[i] = T[((2^h + q) >> i) xor 1]`.
#[cfg(feature = "signer")]
fn fill_auth_path(nodes: &[[u8; N]], q: u32, path: &mut [[u8; N]]) {
    let mut r = (1u32 << path.len()) + q;
    for node in path.iter_mut() {
        *node = nodes[(r ^ 1) as usize];
        r /= 2;
    }
}

#[cfg(test)]
mod tests {
    //! The height-generic tree code against every LMS level of RFC 8554
    //! Appendix F. Test Case 1 (both levels) and Test Case 2's second level
    //! are `LMS_SHA256_M32_H5` over `LMOTS_SHA256_N32_W8`, which the crate
    //! does not implement (and `lms_verify` rejects); this module recomputes
    //! their W8 leaf keys independently so that `root_from_path`,
    //! `build_tree` and `fill_auth_path` are checked at h = 5 as well as 10.
    use super::*;
    use alloc::vec::Vec;

    struct TestSha;

    impl Sha256 for TestSha {
        fn hashv(parts: &[&[u8]]) -> [u8; 32] {
            use sha2::Digest;
            let mut h = sha2::Sha256::new();
            for p in parts {
                h.update(p);
            }
            h.finalize().into()
        }
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn appendix_f() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/rfc8554_appendix_f.json")).unwrap()
    }

    /// Chain count `p` of the LM-OTS typecodes in Appendix F (n = 32).
    fn ots_params(ots_type: u32) -> usize {
        match ots_type {
            3 => 67,
            4 => 34,
            t => panic!("unexpected LM-OTS type {t}"),
        }
    }

    fn lms_height(lms_type: u32) -> usize {
        match lms_type {
            5 => 5,
            6 => 10,
            t => panic!("unexpected LMS type {t}"),
        }
    }

    /// One LMS level of an HSS public key or signature, split per RFC 8554.
    struct Level {
        pk: Vec<u8>,
        msg: Vec<u8>,
        sig: Vec<u8>,
    }

    fn lms_sig_len(sig: &[u8]) -> usize {
        let p = ots_params(be32(sig, 4));
        let h = lms_height(be32(sig, 8 + N * (p + 1)));
        12 + N * (p + 1) + N * h
    }

    /// Both levels of a two-level HSS test case: `(top pk, pub[1], sig[0])`
    /// and `(pub[1], message, sig[1])`.
    fn levels(tc: &serde_json::Value) -> [Level; 2] {
        let pk = unhex(tc["hss_public_key"].as_str().unwrap());
        let msg = unhex(tc["message"].as_str().unwrap());
        let sig = unhex(tc["hss_signature"].as_str().unwrap());
        assert_eq!(be32(&pk, 0), 2, "two levels");
        assert_eq!(be32(&sig, 0), 1, "Nspk");
        let len0 = lms_sig_len(&sig[4..]);
        let pub1 = sig[4 + len0..4 + len0 + 56].to_vec();
        let sig1 = sig[4 + len0 + 56..].to_vec();
        assert_eq!(sig1.len(), lms_sig_len(&sig1));
        [
            Level {
                pk: pk[4..].to_vec(),
                msg: pub1.clone(),
                sig: sig[4..4 + len0].to_vec(),
            },
            Level {
                pk: pub1,
                msg,
                sig: sig1,
            },
        ]
    }

    fn w8_digit_checksum(q_hash: &[u8; 32]) -> [u8; 34] {
        let mut v = [0u8; 34];
        v[..32].copy_from_slice(q_hash);
        let sum: u16 = q_hash.iter().map(|&b| 255 - b as u16).sum();
        v[32..].copy_from_slice(&sum.to_be_bytes()); // ls = 0 for w = 8
        v
    }

    fn w8_chain(id: &[u8], q: u32, i: u16, from: u8, to: u8, start: &[u8]) -> [u8; 32] {
        let mut tmp: [u8; 32] = start.try_into().unwrap();
        for j in from..to {
            tmp = TestSha::hashv(&[id, &q.to_be_bytes(), &i.to_be_bytes(), &[j], &tmp]);
        }
        tmp
    }

    /// RFC 8554 Algorithm 4b for `LMOTS_SHA256_N32_W8` (p = 34, ls = 0).
    fn w8_candidate(id: &[u8; ID_LEN], q: u32, msg: &[u8], c_y: &[u8]) -> [u8; N] {
        let (c, ys) = c_y.split_at(N);
        let q_hash = TestSha::hashv(&[id, &q.to_be_bytes(), &crate::D_MESG, c, msg]);
        let v = w8_digit_checksum(&q_hash);
        let mut z = Vec::new();
        for (i, y) in ys.as_chunks::<N>().0.iter().enumerate() {
            z.extend_from_slice(&w8_chain(id, q, i as u16, v[i], 255, y));
        }
        assert_eq!(z.len(), 34 * N);
        TestSha::hashv(&[id, &q.to_be_bytes(), &crate::D_PBLC, &z])
    }

    /// The root an Appendix F level's signature implies, through the
    /// crate's height-generic `root_from_path`.
    fn implied_root(level: &Level) -> [u8; N] {
        let id: [u8; ID_LEN] = level.pk[8..24].try_into().unwrap();
        let sig = &level.sig;
        let q = be32(sig, 0);
        let ots_type = be32(sig, 4);
        assert_eq!(ots_type, be32(&level.pk, 4));
        let p = ots_params(ots_type);
        let ots = &sig[8..8 + N * (p + 1)];
        let kc = match ots_type {
            3 => candidate_public_key::<TestSha>(&id, q, &level.msg, ots).unwrap(),
            _ => w8_candidate(&id, q, &level.msg, ots),
        };
        let lms_type = be32(sig, 8 + N * (p + 1));
        assert_eq!(lms_type, be32(&level.pk, 0));
        let path = &sig[12 + N * (p + 1)..];
        assert_eq!(path.len(), lms_height(lms_type) * N);
        root_from_path::<TestSha>(&id, q, &kc, path)
    }

    #[test]
    fn root_from_path_reproduces_every_appendix_f_root() {
        let v = appendix_f();
        let mut heights = Vec::new();
        for tc in ["test_case_1", "test_case_2"] {
            for (n, level) in levels(&v[tc]).iter().enumerate() {
                assert_eq!(
                    implied_root(level).as_slice(),
                    &level.pk[24..56],
                    "{tc} level {n}"
                );
                heights.push(lms_height(be32(&level.pk, 0)));
            }
        }
        // Three H5 levels and Test Case 2's H10 top level.
        assert_eq!(heights, [5, 5, 10, 5]);
    }

    #[test]
    fn strict_parsers_refuse_every_h5_w8_level() {
        let v = appendix_f();
        for tc in ["test_case_1", "test_case_2"] {
            for level in levels(&v[tc]) {
                if be32(&level.pk, 0) == LMS_TYPE {
                    assert!(LmsPublicKey::from_bytes(&level.pk).is_some());
                    assert!(LmsSignature::parse(&level.sig).is_some());
                    continue;
                }
                assert_eq!(&level.pk[..8], &[0, 0, 0, 5, 0, 0, 0, 4]);
                assert!(LmsPublicKey::from_bytes(&level.pk).is_none());
                assert!(LmsSignature::parse(&level.sig).is_none());
                let pk: [u8; LMS_PUBLIC_KEY_LEN] = level.pk.clone().try_into().unwrap();
                assert_eq!(lms_verify::<TestSha>(&pk, &level.msg, &level.sig), None);
            }
        }
    }

    #[test]
    fn signature_layout_offsets() {
        assert_eq!(
            (OTS_TYPE_AT, OTS_SIG_AT, LMS_TYPE_AT, PATH_AT),
            (4, 8, 2184, 2188)
        );
        assert_eq!(LMS_SIG_LEN, 4 + 4 + 32 + 67 * 32 + 4 + 10 * 32);
        assert_eq!(LMS_LEAVES, 1024);
    }

    #[cfg(feature = "signer")]
    fn w8_public_key(id: &[u8; ID_LEN], q: u32, seed: &[u8]) -> [u8; N] {
        let mut z = Vec::new();
        for i in 0..34u16 {
            let x = TestSha::hashv(&[id, &q.to_be_bytes(), &i.to_be_bytes(), &[0xff], seed]);
            z.extend_from_slice(&w8_chain(id, q, i, 0, 255, &x));
        }
        TestSha::hashv(&[id, &q.to_be_bytes(), &crate::D_PBLC, &z])
    }

    #[cfg(feature = "signer")]
    #[test]
    fn build_tree_and_paths_reproduce_test_case_2_second_level() {
        // Test Case 2 publishes SEED and I of its H5/W8 second level: rebuild
        // that tree with the height-generic code and check the root and the
        // path of the final signature.
        let v = appendix_f();
        let tc = &v["test_case_2"];
        let seed = unhex(tc["second_level_seed"].as_str().unwrap());
        let id: [u8; ID_LEN] = unhex(tc["second_level_i"].as_str().unwrap())
            .try_into()
            .unwrap();
        let [_, level] = levels(tc);
        assert_eq!(&level.pk[8..24], &id);
        let leaves: Vec<[u8; N]> = (0..32).map(|q| w8_public_key(&id, q, &seed)).collect();
        let nodes = build_tree::<TestSha>(&id, &leaves);
        assert_eq!(nodes.len(), 64);
        assert_eq!(nodes[1].as_slice(), &level.pk[24..56], "H5 root");
        let q = be32(&level.sig, 0);
        let mut path = [[0u8; N]; 5];
        fill_auth_path(&nodes, q, &mut path);
        assert_eq!(
            path.concat(),
            &level.sig[level.sig.len() - 5 * N..],
            "H5 path"
        );
    }

    #[cfg(feature = "signer")]
    #[test]
    fn sign_releases_nothing_that_does_not_verify() {
        // A stored tree that is not the key's tree (here all zero): the
        // LM-OTS part is computed from the secret, but the signature cannot
        // verify against the stored root, so it is withheld.
        let kp = LmsKeyPair {
            private_key: LmsPrivateKey {
                seed: [1; N],
                id: [2; ID_LEN],
            },
            nodes: alloc::vec![[0u8; N]; 2 * LMS_LEAVES as usize],
        };
        assert!(kp.sign::<TestSha>(5, b"message", &[3; N]).is_none());
        assert!(kp.sign_deterministic::<TestSha>(5, b"message").is_none());
    }

    #[cfg(feature = "signer")]
    #[test]
    fn every_auth_path_climbs_to_the_root_at_several_heights() {
        let id = [0x5au8; ID_LEN];
        for height in [1u32, 2, 3, 5, 10] {
            let leaves: Vec<[u8; N]> = (0..1u32 << height)
                .map(|q| TestSha::hashv(&[b"leaf", &height.to_be_bytes(), &q.to_be_bytes()]))
                .collect();
            let nodes = build_tree::<TestSha>(&id, &leaves);
            let mut path = alloc::vec![[0u8; N]; height as usize];
            for (q, k) in leaves.iter().enumerate() {
                fill_auth_path(&nodes, q as u32, &mut path);
                assert_eq!(
                    root_from_path::<TestSha>(&id, q as u32, k, &path.concat()),
                    nodes[1],
                    "height {height}, leaf {q}"
                );
                // The path of a neighbouring leaf does not fit.
                let other = (q as u32) ^ 1;
                assert_ne!(
                    root_from_path::<TestSha>(&id, other, k, &path.concat()),
                    nodes[1],
                    "height {height}, leaf {q} as {other}"
                );
            }
        }
    }
}
