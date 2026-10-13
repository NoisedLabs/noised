//! Off-chain helpers for clients and tests (`not(target_os = "solana")`,
//! never in a program binary): Anchor's discriminators, account decoding
//! (`AccountDeserialize`-style), accounts laid out as the runtime lays them
//! out ([`HostAccount`]) and the log lines the runtime would print for what
//! a program logged ([`render`]).

use alloc::{format, string::String, vec::Vec};

pub use crate::sys::{set_sysvar, take_cpis, take_logs, Cpi, HostAccount};
use crate::{accounts::ProgramAccount, sys::Log, Address};

/// Anchor's discriminator `sha256("<namespace>:<name>")[..8]`: namespace
/// `global` with the snake_case instruction name, `account` / `event` with
/// the type name.
pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let hash = crate::hashv(&[namespace.as_bytes(), b":", name.as_bytes()]);
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

/// Why account data does not decode as `T` ([`deserialize`]), with
/// anchor-lang's error number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Shorter than 8 bytes (`AccountDiscriminatorNotFound`, 3001).
    DiscriminatorNotFound,
    /// Another type's discriminator (`AccountDiscriminatorMismatch`, 3002).
    DiscriminatorMismatch,
    /// The fields do not decode (`AccountDidNotDeserialize`, 3003).
    DidNotDeserialize,
}

/// `AccountDeserialize::try_deserialize` of a program account's data: the
/// discriminator, then the fields.
pub fn deserialize<T: ProgramAccount>(data: &[u8]) -> Result<T, DecodeError> {
    let given = data
        .first_chunk::<8>()
        .ok_or(DecodeError::DiscriminatorNotFound)?;
    if *given != T::ACCOUNT_DISCRIMINATOR {
        return Err(DecodeError::DiscriminatorMismatch);
    }
    T::try_read(data).ok_or(DecodeError::DidNotDeserialize)
}

const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Base58 (as the runtime prints addresses).
pub fn base58(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::new();
    for &byte in bytes {
        let mut carry = u32::from(byte);
        for digit in digits.iter_mut() {
            carry += u32::from(*digit) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(core::iter::repeat_n('1', zeros));
    out.extend(digits.iter().rev().map(|d| BASE58[usize::from(*d)] as char));
    out
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (as the runtime prints `sol_log_data`).
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The line the runtime prints for a recorded log (`Program log: ...`,
/// `Program data: ...`).
pub fn render(log: &Log) -> String {
    match log {
        Log::Message(message) => format!("Program log: {message}"),
        Log::Pubkey(key) => format!("Program log: {}", base58(key.as_ref())),
        Log::Data(slices) => {
            let parts: Vec<String> = slices.iter().map(|s| base64(s)).collect();
            format!("Program data: {}", parts.join(" "))
        }
    }
}

/// The lines logged on this thread since the last call ([`take_logs`]),
/// rendered.
pub fn take_log_lines() -> Vec<String> {
    take_logs().iter().map(render).collect()
}

/// An address from its base58 text (panics on a malformed one; tests and
/// constants only).
pub fn address(text: &str) -> Address {
    Address::from_str_const(text)
}

/// Random inputs for differential tests: a deterministic stream, and SPL
/// Token / Token-2022 account data that is often valid and often malformed
/// in every way `StateWithExtensions::unpack` checks.
pub mod fuzz {
    use alloc::{vec, vec::Vec};

    use crate::{token, Address};

    /// Deterministic pseudo-random stream.
    pub struct Rng(pub u64);

    impl Rng {
        #[allow(clippy::should_implement_trait)]
        pub fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 ^ (self.0 >> 29)
        }

        pub fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        pub fn chance(&mut self, percent: u64) -> bool {
            self.below(100) < percent
        }

        pub fn byte(&mut self) -> u8 {
            self.next() as u8
        }

        pub fn bytes(&mut self, len: usize) -> Vec<u8> {
            (0..len).map(|_| self.byte()).collect()
        }

        /// Fewer than `max` random bytes.
        pub fn some_bytes(&mut self, max: u64) -> Vec<u8> {
            let len = self.below(max) as usize;
            self.bytes(len)
        }

        pub fn array<const L: usize>(&mut self) -> [u8; L] {
            core::array::from_fn(|_| self.byte())
        }

        pub fn key(&mut self) -> Address {
            Address::new_from_array(self.array())
        }

        pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
            items[self.below(items.len() as u64) as usize]
        }
    }

    /// A TLV area: random entries (known and unknown types, right and wrong
    /// lengths), sometimes followed by zero padding or junk.
    pub fn random_tlv(r: &mut Rng, for_mint: bool) -> Vec<u8> {
        let mut tlv = Vec::new();
        for _ in 0..r.below(6) {
            let (ty, len): (u16, usize) = match r.below(11) {
                0 => (token::EXT_MINT_CLOSE_AUTHORITY, 32),
                1 => (token::EXT_TRANSFER_FEE_CONFIG, 108),
                2 => (token::EXT_TRANSFER_HOOK, 64),
                3 => (token::EXT_MEMO_TRANSFER, 1),
                4 => (
                    r.pick(&[token::EXT_NON_TRANSFERABLE, token::EXT_PERMANENT_DELEGATE]),
                    r.pick(&[0, 32]),
                ),
                5 => (
                    r.below(u64::from(token::EXTENSION_TYPE_MAX) + 1) as u16,
                    r.below(80) as usize,
                ),
                6 => (r.below(40) as u16, r.below(40) as usize),
                7 => (
                    r.pick(&[
                        token::EXT_MINT_CLOSE_AUTHORITY,
                        token::EXT_TRANSFER_HOOK,
                        token::EXT_MEMO_TRANSFER,
                    ]),
                    r.below(70) as usize,
                ),
                8 => (
                    r.pick(&[
                        token::EXT_METADATA_POINTER,
                        token::EXT_PERMANENT_DELEGATE,
                        token::EXT_DEFAULT_ACCOUNT_STATE,
                        token::EXT_PAUSABLE,
                        token::EXT_TOKEN_METADATA,
                    ]),
                    r.pick(&[1, 32, 33, 64, 90]),
                ),
                _ => (if for_mint { 18 } else { 7 }, r.below(50) as usize),
            };
            tlv.extend_from_slice(&ty.to_le_bytes());
            tlv.extend_from_slice(&(len as u16).to_le_bytes());
            let mut value = r.bytes(len);
            // Authorities are often absent (all zero).
            if r.chance(50) {
                for b in value.iter_mut().take(64) {
                    *b = 0;
                }
            }
            tlv.extend(value);
        }
        match r.below(6) {
            0 => tlv.extend(vec![0; r.below(6) as usize]),
            1 => tlv.extend(r.some_bytes(5)),
            2 => {
                // A declared length past the end.
                tlv.extend_from_slice(&(r.below(28) as u16).to_le_bytes());
                tlv.extend_from_slice(&(r.below(500) as u16).to_le_bytes());
            }
            _ => {}
        }
        tlv
    }

    /// A `COption` tag, sometimes malformed.
    pub fn coption(r: &mut Rng) -> [u8; 4] {
        match r.below(10) {
            0 => [r.byte(), r.byte(), 0, 0],
            1..=5 => [0, 0, 0, 0],
            _ => [1, 0, 0, 0],
        }
    }

    /// Mint data: valid or malformed base, with or without extensions.
    pub fn random_mint(r: &mut Rng) -> Vec<u8> {
        let mut data = r.bytes(82);
        data[0..4].copy_from_slice(&coption(r));
        data[45] = r.pick(&[0, 1, 1, 1, 1, 2]);
        data[46..50].copy_from_slice(&coption(r));
        match r.below(8) {
            0 => {}
            1 => data.truncate(r.below(83) as usize),
            2 => data.extend(r.some_bytes(120)),
            3 => data.resize(355, 0),
            _ => {
                let mut rest = vec![0u8; 83];
                if r.chance(5) {
                    rest[r.below(83) as usize] = 1;
                }
                data.extend(rest);
                data.push(r.pick(&[1, 1, 1, 0, 2, 3]));
                data.extend(random_tlv(r, true));
            }
        }
        data
    }

    /// Token account data: valid or malformed base, with or without
    /// extensions.
    pub fn random_token_account(r: &mut Rng) -> Vec<u8> {
        let mut data = r.bytes(165);
        data[72..76].copy_from_slice(&coption(r));
        data[108] = r.pick(&[0, 1, 1, 1, 2, 3]);
        data[109..113].copy_from_slice(&coption(r));
        data[129..133].copy_from_slice(&coption(r));
        match r.below(8) {
            0 => {}
            1 => data.truncate(r.below(166) as usize),
            2 => data.resize(355, 0),
            _ => {
                data.push(r.pick(&[2, 2, 2, 1, 0, 9]));
                data.extend(random_tlv(r, false));
            }
        }
        data
    }
}
