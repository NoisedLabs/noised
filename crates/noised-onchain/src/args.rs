//! Instruction dispatch and Borsh, as Anchor's generated `entry` /
//! `dispatch` and argument structs use them.
//!
//! * [`instruction`]: `try_entry` (the declared program id) and the 8-byte
//!   discriminator; [`unknown`]: the end of `dispatch`.
//! * [`Reader`]: Borsh decoding of the arguments after the discriminator,
//!   from a slice: trailing bytes are ignored (as `deserialize(&mut &data[..])`
//!   ignores them) and any failure is `None`, which the handler reports as
//!   `InstructionDidNotDeserialize` (102).
//! * [`Writer`]: Borsh encoding (events, account data).

use alloc::vec::Vec;

use pinocchio::{error::ProgramError, Address};

use crate::{
    error::{anchor, fail},
    event::EVENT_IX_TAG_LE,
    same, Program,
};

/// [A] `try_entry` and the start of `dispatch`: the program id must be the
/// declared one (`DeclaredProgramIdMismatch`), and the data must hold an
/// 8-byte discriminator (shorter data matches no instruction:
/// `InstructionFallbackNotFound`). Returns the discriminator and the
/// arguments after it.
#[inline(always)]
pub fn instruction<'d, P: Program>(
    program_id: &Address,
    data: &'d [u8],
) -> Result<(&'d [u8; 8], &'d [u8]), ProgramError> {
    if !same(program_id, &P::ID) {
        return Err(fail::<P>(anchor::DECLARED_PROGRAM_ID_MISMATCH, None));
    }
    data.split_first_chunk::<8>()
        .ok_or_else(|| fail::<P>(anchor::INSTRUCTION_FALLBACK_NOT_FOUND, None))
}

/// [A] the end of `dispatch`, for a discriminator no instruction has: the
/// event-CPI tag is `EventInstructionStub` (a program built without
/// `event-cpi`; with it, call [`crate::event::event_dispatch`] for that tag
/// instead), anything else `InstructionFallbackNotFound`.
#[inline(always)]
pub fn unknown<P: Program>(tag: &[u8; 8]) -> ProgramError {
    if *tag == EVENT_IX_TAG_LE {
        fail::<P>(anchor::EVENT_INSTRUCTION_STUB, None)
    } else {
        fail::<P>(anchor::INSTRUCTION_FALLBACK_NOT_FOUND, None)
    }
}

/// [A] the arguments of an instruction: `read` decodes them from the data
/// after the discriminator ([`Reader`]; trailing bytes ignored); `None` is
/// `InstructionDidNotDeserialize` (102), logged with no account.
#[inline(always)]
pub fn decode<P: Program, T>(
    data: &[u8],
    read: impl FnOnce(&mut Reader) -> Option<T>,
) -> Result<T, ProgramError> {
    read(&mut Reader::new(data))
        .ok_or_else(|| fail::<P>(anchor::INSTRUCTION_DID_NOT_DESERIALIZE, None))
}

/// Borsh decoding from a slice (borsh 1.x rules): integers little-endian,
/// `bool` 0 or 1, `Option` tag 0 or 1, `Vec` / `String` / bytes a `u32`
/// length then the items, `String` valid UTF-8, enums a `u8` variant index.
/// Every method returns `None` (and may have consumed input) when the data
/// does not decode.
#[derive(Clone, Copy, Debug)]
pub struct Reader<'a> {
    data: &'a [u8],
}

impl<'a> Reader<'a> {
    #[inline]
    pub fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    /// What has not been read (Anchor ignores it).
    #[inline]
    pub fn rest(&self) -> &'a [u8] {
        self.data
    }

    /// The next `len` bytes.
    #[inline]
    pub fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.data.split_at_checked(len)?;
        self.data = rest;
        Some(head)
    }

    /// The next `N` bytes (`[u8; N]`).
    #[inline]
    pub fn array<const N: usize>(&mut self) -> Option<&'a [u8; N]> {
        let (head, rest) = self.data.split_first_chunk::<N>()?;
        self.data = rest;
        Some(head)
    }

    #[inline]
    pub fn u8(&mut self) -> Option<u8> {
        self.array::<1>().map(|b| b[0])
    }

    #[inline]
    pub fn u16(&mut self) -> Option<u16> {
        self.array().map(|b| u16::from_le_bytes(*b))
    }

    #[inline]
    pub fn u32(&mut self) -> Option<u32> {
        self.array().map(|b| u32::from_le_bytes(*b))
    }

    #[inline]
    pub fn u64(&mut self) -> Option<u64> {
        self.array().map(|b| u64::from_le_bytes(*b))
    }

    #[inline]
    pub fn u128(&mut self) -> Option<u128> {
        self.array().map(|b| u128::from_le_bytes(*b))
    }

    #[inline]
    pub fn i8(&mut self) -> Option<i8> {
        self.u8().map(|b| b as i8)
    }

    #[inline]
    pub fn i16(&mut self) -> Option<i16> {
        self.array().map(|b| i16::from_le_bytes(*b))
    }

    #[inline]
    pub fn i32(&mut self) -> Option<i32> {
        self.array().map(|b| i32::from_le_bytes(*b))
    }

    #[inline]
    pub fn i64(&mut self) -> Option<i64> {
        self.array().map(|b| i64::from_le_bytes(*b))
    }

    #[inline]
    pub fn i128(&mut self) -> Option<i128> {
        self.array().map(|b| i128::from_le_bytes(*b))
    }

    /// `bool`: 0 or 1, anything else fails.
    #[inline]
    pub fn bool(&mut self) -> Option<bool> {
        match self.u8()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }

    /// `Pubkey`.
    #[inline]
    pub fn address(&mut self) -> Option<Address> {
        self.array::<32>().map(|b| Address::new_from_array(*b))
    }

    /// A `u32` length (of a `Vec`, `String` or bytes).
    #[inline]
    pub fn vec_len(&mut self) -> Option<usize> {
        self.u32().map(|n| n as usize)
    }

    /// `Vec<u8>` / `bytes`: a `u32` length, then the bytes (borrowed).
    #[inline]
    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.vec_len()?;
        self.take(len)
    }

    /// `String`: [`Reader::bytes`] that are valid UTF-8.
    #[inline]
    pub fn str(&mut self) -> Option<&'a str> {
        core::str::from_utf8(self.bytes()?).ok()
    }

    /// `Option<T>`: tag 0 (`None`) or 1 (then `T`), anything else fails.
    #[inline]
    pub fn option<T>(&mut self, read: impl FnOnce(&mut Self) -> Option<T>) -> Option<Option<T>> {
        match self.u8()? {
            0 => Some(None),
            1 => read(self).map(Some),
            _ => None,
        }
    }
}

/// Borsh encoding into a growable buffer (events, account data, CPI data).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Writer {
    data: Vec<u8>,
}

impl Writer {
    /// An empty buffer with room for `capacity` bytes.
    #[inline]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            data: Vec::with_capacity(capacity),
        }
    }

    /// A buffer that starts with an 8-byte discriminator (an event's, an
    /// account's or an instruction's).
    #[inline]
    pub fn with_discriminator(discriminator: &[u8; 8], capacity: usize) -> Self {
        let mut w = Self::with_capacity(8 + capacity);
        w.put(discriminator);
        w
    }

    /// Raw bytes (a `[u8; N]` field, or anything already encoded).
    #[inline]
    pub fn put(&mut self, bytes: &[u8]) -> &mut Self {
        self.data.extend_from_slice(bytes);
        self
    }

    #[inline]
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.put(&[v])
    }

    #[inline]
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.put(&v.to_le_bytes())
    }

    #[inline]
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.put(&v.to_le_bytes())
    }

    #[inline]
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.put(&v.to_le_bytes())
    }

    #[inline]
    pub fn u128(&mut self, v: u128) -> &mut Self {
        self.put(&v.to_le_bytes())
    }

    #[inline]
    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.put(&v.to_le_bytes())
    }

    #[inline]
    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.u8(u8::from(v))
    }

    #[inline]
    pub fn address(&mut self, v: &Address) -> &mut Self {
        self.put(v.as_ref())
    }

    /// `Vec<u8>` / `String`: a `u32` length, then the bytes.
    #[inline]
    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.u32(v.len() as u32).put(v)
    }

    /// The tag of an `Option` (then write the value if `Some`).
    #[inline]
    pub fn option_tag(&mut self, is_some: bool) -> &mut Self {
        self.u8(u8::from(is_some))
    }

    #[inline]
    pub fn as_slice(&self) -> &[u8] {
        &self.data
    }

    #[inline]
    pub fn into_vec(self) -> Vec<u8> {
        self.data
    }
}
