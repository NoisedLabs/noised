//! Standard base64 (RFC 4648 §4: the `A-Z a-z 0-9 + /` alphabet, `=`
//! padding), encoding only: `launch` writes an inline uri,
//! `"data:application/json;base64," + base64(doc)`, into the mint.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Length of the encoding of `n` bytes: 4 characters per started group of 3.
pub const fn encoded_len(n: usize) -> usize {
    n.div_ceil(3) * 4
}

/// The character of the 6 bits of `bits` at `shift`.
fn symbol(bits: u32, shift: u32) -> u8 {
    ALPHABET[((bits >> shift) & 0x3f) as usize]
}

/// Append the padded base64 of `input` to `out`.
pub fn encode_into(input: &[u8], out: &mut Vec<u8>) {
    let start = out.len();
    out.resize(start + encoded_len(input.len()), 0);
    // One 4-character chunk per started group of 3 bytes.
    let (chars, _) = out[start..].as_chunks_mut::<4>();
    let (groups, rest) = input.as_chunks::<3>();
    for (&[b0, b1, b2], dst) in groups.iter().zip(chars.iter_mut()) {
        let bits = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        *dst = [
            symbol(bits, 18),
            symbol(bits, 12),
            symbol(bits, 6),
            symbol(bits, 0),
        ];
    }
    // The last 1 or 2 bytes, padded: the last chunk.
    if let (false, Some(dst)) = (rest.is_empty(), chars.last_mut()) {
        let byte = |i: usize| rest.get(i).map_or(0, |&b| u32::from(b));
        let bits = (byte(0) << 16) | (byte(1) << 8);
        let third = if rest.len() > 1 {
            symbol(bits, 6)
        } else {
            b'='
        };
        *dst = [symbol(bits, 18), symbol(bits, 12), third, b'='];
    }
}
