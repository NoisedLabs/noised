//! `pubkey!("<base58>")`: an address constant decoded at compile time (as
//! Anchor's `pubkey!` / `declare_id!` did), so the sources keep the
//! readable form and the binary only the 32 bytes.

const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// The 32 bytes a base58 string encodes. Compile-time only (`const`):
/// an invalid character, or a value that is not exactly 32 bytes, fails the
/// build.
pub const fn decode(text: &str) -> [u8; 32] {
    let text = text.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < text.len() {
        let mut digit = 0usize;
        while digit < 58 && ALPHABET[digit] != text[i] {
            digit += 1;
        }
        assert!(digit < 58, "not a base58 character");
        // out = out * 58 + digit, big-endian.
        let mut carry = digit as u32;
        let mut j = 32;
        while j > 0 {
            j -= 1;
            carry += 58 * out[j] as u32;
            out[j] = (carry & 0xff) as u8;
            carry >>= 8;
        }
        assert!(carry == 0, "more than 32 bytes");
        i += 1;
    }
    // Leading '1's are leading zero bytes: the encoding of 32 bytes has as
    // many as the value has leading zero bytes.
    let mut ones = 0;
    while ones < text.len() && text[ones] == b'1' {
        ones += 1;
    }
    let mut zeros = 0;
    while zeros < 32 && out[zeros] == 0 {
        zeros += 1;
    }
    assert!(ones == zeros, "not a 32-byte encoding");
    out
}

/// An address from its base58 text, decoded at compile time.
macro_rules! pubkey {
    ($text:literal) => {
        $crate::Pubkey::new_from_array(const { $crate::pubkey::decode($text) })
    };
}
pub(crate) use pubkey;
