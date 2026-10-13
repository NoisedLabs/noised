//! zToken name, symbol and URI: a deterministic function of the base mint.
//!
//! The base mint's metadata is attacker-controlled input, so it is read
//! without allocating (only the three leading strings, never the unbounded
//! additional-metadata list), stripped of invisible characters that could
//! disguise a name in wallets, and cut at UTF-8 character boundaries.
//!
//! The results are fixed-capacity [`Text`] buffers (no allocation, no
//! formatting code on-chain); `tests/abi.rs` checks [`derive`] and
//! [`read_base_metadata`] against the Anchor build's `String` version
//! (`anchor/metadata.rs`) on random inputs.

use crate::Pubkey;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
/// Longer base URIs are dropped rather than cut: a truncated link is broken.
pub const MAX_URI_LEN: usize = 200;
pub const NAME_PREFIX: &str = "Shielded ";
pub const SYMBOL_PREFIX: &str = "z";
/// Base58 characters of the base mint address used when it has no metadata,
/// so zTokens of different mints stay distinguishable in wallets.
pub const GENERIC_NAME_CHARS: usize = 8;
pub const GENERIC_SYMBOL_CHARS: usize = 4;
/// Bytes of a base name or symbol that are ever looked at (bounds compute).
const SCAN_LIMIT: usize = 128;

/// UTF-8 text of at most `N` bytes, held inline. Only whole characters are
/// ever written into it, so its bytes are always valid UTF-8.
#[derive(Clone, Copy)]
pub struct Text<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Default for Text<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> Text<N> {
    /// The empty text.
    pub const fn new() -> Self {
        Self {
            bytes: [0; N],
            len: 0,
        }
    }

    /// `s` if it fits in `N` bytes.
    pub fn try_new(s: &str) -> Option<Self> {
        let mut text = Self::new();
        (s.len() <= N).then(|| {
            text.len = copy_str(s, &mut text.bytes);
            text
        })
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.bytes.get(..self.len).unwrap_or(&[])
    }

    pub fn as_str(&self) -> &str {
        core::str::from_utf8(self.as_bytes()).unwrap_or("")
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl<const N: usize> PartialEq for Text<N> {
    fn eq(&self, other: &Self) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

impl<const N: usize> Eq for Text<N> {}

impl<const N: usize> core::fmt::Debug for Text<N> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        core::fmt::Debug::fmt(self.as_str(), f)
    }
}

#[cfg(not(target_os = "solana"))]
impl<const N: usize> core::fmt::Display for Text<N> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl<const N: usize> PartialEq<&str> for Text<N> {
    fn eq(&self, other: &&str) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

impl<const N: usize> PartialEq<str> for Text<N> {
    fn eq(&self, other: &str) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

#[cfg(not(target_os = "solana"))]
impl<const N: usize> PartialEq<String> for Text<N> {
    fn eq(&self, other: &String) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

/// Strings read from a base mint's Token-2022 `TokenMetadata`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseMetadata<'a> {
    pub name: &'a str,
    pub symbol: &'a str,
    /// Empty when the base URI is longer than [`MAX_URI_LEN`] or not UTF-8.
    pub uri: &'a str,
}

/// The zToken's name, symbol and uri.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZMetadata {
    pub name: Text<MAX_NAME_LEN>,
    pub symbol: Text<MAX_SYMBOL_LEN>,
    pub uri: Text<MAX_URI_LEN>,
}

/// Derive the zToken metadata. `base` is `None` when the base mint has no
/// canonical Token-2022 metadata; each field falls back separately.
pub fn derive(base: Option<BaseMetadata<'_>>, base_mint: &Pubkey) -> ZMetadata {
    let mut z = ZMetadata {
        name: Text::new(),
        symbol: Text::new(),
        uri: Text::new(),
    };
    // Visible characters of the base name and symbol, trimmed, at most the
    // field's length (which then also bounds the prefixed result).
    let mut name = Text::<MAX_NAME_LEN>::new();
    let mut symbol = Text::<MAX_SYMBOL_LEN>::new();
    if let Some(b) = base {
        name.len = clean(b.name, &mut name.bytes);
        symbol.len = clean(b.symbol, &mut symbol.bytes);
        // The uri, whole or not at all.
        if b.uri.len() <= MAX_URI_LEN && !b.uri.chars().any(is_hidden) {
            z.uri.len = copy_str(b.uri, &mut z.uri.bytes);
        }
    }
    // Empty fields fall back to the base mint address, field by field.
    if name.is_empty() || symbol.is_empty() {
        let address = base58(base_mint);
        let address = address.as_str();
        if name.is_empty() {
            let generic = address.get(..GENERIC_NAME_CHARS).unwrap_or("");
            name.len = copy_str(generic, &mut name.bytes);
        }
        if symbol.is_empty() {
            let generic = address.get(..GENERIC_SYMBOL_CHARS).unwrap_or("");
            symbol.len = copy_str(generic, &mut symbol.bytes);
        }
    }
    z.name.len = prefixed(NAME_PREFIX, name.as_str(), &mut z.name.bytes);
    z.symbol.len = prefixed(SYMBOL_PREFIX, symbol.as_str(), &mut z.symbol.bytes);
    z
}

/// Read name, symbol and uri from a `TokenMetadata` TLV value (borsh:
/// update_authority[32] | mint[32] | name | symbol | uri | additional...).
/// `None` when malformed or when the metadata names a different mint.
pub fn read_base_metadata<'a>(value: &'a [u8], mint: &Pubkey) -> Option<BaseMetadata<'a>> {
    if value.get(32..64)? != mint.as_ref() {
        return None;
    }
    let mut offset = 64;
    let name = read_borsh_bytes(value, &mut offset)?;
    let symbol = read_borsh_bytes(value, &mut offset)?;
    let uri = read_borsh_bytes(value, &mut offset)?;
    Some(BaseMetadata {
        name: utf8_prefix(name, SCAN_LIMIT),
        symbol: utf8_prefix(symbol, SCAN_LIMIT),
        uri: if uri.len() <= MAX_URI_LEN {
            core::str::from_utf8(uri).unwrap_or("")
        } else {
            ""
        },
    })
}

/// One borsh `String`/`Vec<u8>`: u32 LE length, then the bytes.
fn read_borsh_bytes<'a>(data: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    let len_end = offset.checked_add(4)?;
    let len_bytes: [u8; 4] = data.get(*offset..len_end)?.try_into().ok()?;
    let end = len_end.checked_add(usize::try_from(u32::from_le_bytes(len_bytes)).ok()?)?;
    let bytes = data.get(len_end..end)?;
    *offset = end;
    Some(bytes)
}

/// Longest valid UTF-8 prefix of at most `max` bytes.
fn utf8_prefix(bytes: &[u8], max: usize) -> &str {
    let bytes = bytes.get(..bytes.len().min(max)).unwrap_or(&[]);
    match core::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => core::str::from_utf8(bytes.get(..e.valid_up_to()).unwrap_or(&[])).unwrap_or(""),
    }
}

/// Characters that render invisibly or reorder text: control characters,
/// bidirectional overrides/isolates and zero-width characters.
pub fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// `s` into `out` if it fits (else nothing); the length.
#[inline(never)]
fn copy_str(s: &str, out: &mut [u8]) -> usize {
    match out.get_mut(..s.len()) {
        Some(dst) => {
            dst.copy_from_slice(s.as_bytes());
            s.len()
        }
        None => 0,
    }
}

/// Writes the characters of `parts` into `out` from the start, whole
/// characters only and while they fit (the hidden ones dropped when
/// `visible_only`); returns the byte offset of the first non-whitespace
/// character written (`usize::MAX` if none) and the end of the last one.
/// One non-generic routine for every field, so the program carries it once.
#[inline(never)]
fn write_chars(out: &mut [u8], parts: &[&str], visible_only: bool) -> (usize, usize) {
    let (mut first, mut last, mut len) = (usize::MAX, 0, 0);
    for part in parts {
        for c in part.chars() {
            if visible_only && is_hidden(c) {
                continue;
            }
            // Encoded into a 4-byte buffer first: `encode_utf8` into a
            // slice it cannot prove large enough would link a formatted
            // panic.
            let mut utf8 = [0u8; 4];
            let encoded = c.encode_utf8(&mut utf8).as_bytes();
            let n = encoded.len();
            let Some(dst) = out.get_mut(len..len + n) else {
                return (first, last);
            };
            dst.copy_from_slice(encoded);
            if !c.is_whitespace() {
                first = first.min(len);
                last = len + n;
            }
            len += n;
        }
    }
    (first, last)
}

/// Visible characters of `s`, trimmed, at most `out.len()` bytes, into
/// `out`; the length.
#[inline(never)]
fn clean(s: &str, out: &mut [u8]) -> usize {
    match write_chars(out, &[s], true) {
        (usize::MAX, _) => 0,
        (first, last) => {
            // out.copy_within(first..last, 0), without its panic paths.
            for (to, from) in (first..last).enumerate() {
                if let Some(byte) = out.get(from).copied() {
                    if let Some(slot) = out.get_mut(to) {
                        *slot = byte;
                    }
                }
            }
            last - first
        }
    }
}

/// `prefix + body`, cut to at most `out.len()` bytes on a character
/// boundary, with no trailing whitespace, into `out`; the length.
#[inline(never)]
fn prefixed(prefix: &str, body: &str, out: &mut [u8]) -> usize {
    write_chars(out, &[prefix, body], false).1
}

/// The base58 alphabet (Bitcoin's, as Solana prints addresses).
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Longest base58 text of 32 bytes.
pub const BASE58_MAX_LEN: usize = 44;

/// `address.to_string()`: the address in base58 (each leading zero byte is
/// a `1`), without formatting code.
#[inline(never)]
pub fn base58(address: &Pubkey) -> Text<BASE58_MAX_LEN> {
    // The address as a slice whose length the optimizer does not see, so
    // the loops below stay loops (unrolled for 32 bytes they are kilobytes).
    let bytes: &[u8] = core::hint::black_box(address.as_ref());
    // Base-58 digits of the number, least significant first.
    let mut digits = [0u8; BASE58_MAX_LEN];
    let mut count = 0usize;
    for byte in bytes {
        let mut carry = u32::from(*byte);
        for digit in digits.iter_mut().take(count) {
            carry += u32::from(*digit) << 8;
            *digit = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            match digits.get_mut(count) {
                Some(digit) => *digit = (carry % 58) as u8,
                None => break,
            }
            count += 1;
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = Text::<BASE58_MAX_LEN>::new();
    let text = core::iter::repeat_n(b'1', zeros).chain(
        digits
            .iter()
            .take(count)
            .rev()
            .map(|digit| BASE58_ALPHABET[usize::from(*digit) % 58]),
    );
    for (slot, c) in out.bytes.iter_mut().zip(text) {
        *slot = c;
        out.len += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;
    use anchor_spl::token_2022_extensions::{
        spl_pod::optional_keys::OptionalNonZeroPubkey,
        spl_token_metadata_interface::state::TokenMetadata,
    };

    fn base<'a>(name: &'a str, symbol: &'a str, uri: &'a str) -> Option<BaseMetadata<'a>> {
        Some(BaseMetadata { name, symbol, uri })
    }

    fn mint() -> Pubkey {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            .parse()
            .unwrap()
    }

    #[test]
    fn derives_from_base_metadata() {
        let z = derive(
            base("Noised Test Token", "PHX", "https://a.example/x.json"),
            &mint(),
        );
        assert_eq!(z.name, "Shielded Noised Test Token");
        assert_eq!(z.symbol, "zPHX");
        assert_eq!(z.uri, "https://a.example/x.json");
    }

    #[test]
    fn generic_names_use_the_mint_address() {
        let z = derive(None, &mint());
        assert_eq!(z.name, "Shielded EPjFWdd5");
        assert_eq!(z.symbol, "zEPjF");
        assert_eq!(z.uri, "");
        // Empty or invisible-only base fields fall back field by field.
        let z = derive(base("\u{202E}\u{200B} ", "SOL", ""), &mint());
        assert_eq!(
            (z.name.as_str(), z.symbol.as_str()),
            ("Shielded EPjFWdd5", "zSOL")
        );
        let z = derive(base("Token", "", ""), &mint());
        assert_eq!(
            (z.name.as_str(), z.symbol.as_str()),
            ("Shielded Token", "zEPjF")
        );
    }

    #[test]
    fn truncates_to_token_metadata_limits() {
        let long = "A".repeat(100);
        let z = derive(base(&long, &long, ""), &mint());
        assert_eq!(z.name.len(), MAX_NAME_LEN);
        assert_eq!(z.name, format!("Shielded {}", "A".repeat(23)));
        assert_eq!(z.symbol, format!("z{}", "A".repeat(9)));
    }

    #[test]
    fn truncation_respects_utf8_boundaries() {
        // 'é' is 2 bytes, '🛡' is 4 bytes: cut points fall inside characters.
        for name in ["éééééééééééééééééééé", "🛡🛡🛡🛡🛡🛡🛡🛡", "aé🛡aé🛡aé🛡aé🛡aé🛡aé🛡"]
        {
            for symbol in ["ééééééé", "🛡🛡🛡", "a🛡🛡"] {
                let z = derive(base(name, symbol, ""), &mint());
                assert!(z.name.len() <= MAX_NAME_LEN && z.symbol.len() <= MAX_SYMBOL_LEN);
                assert!(
                    z.name.as_str().starts_with(NAME_PREFIX)
                        && z.symbol.as_str().starts_with(SYMBOL_PREFIX)
                );
                // Nothing that fits was dropped.
                let next = name[z.name.len() - NAME_PREFIX.len()..]
                    .chars()
                    .next()
                    .unwrap();
                assert!(z.name.len() + next.len_utf8() > MAX_NAME_LEN);
            }
        }
        assert_eq!(derive(base("🛡🛡🛡", "🛡🛡🛡", ""), &mint()).symbol, "z🛡🛡");
    }

    #[test]
    fn strips_invisible_and_reordering_characters() {
        let z = derive(
            base("\u{202E}USDC\u{0000}\u{200B}", " \tSOL\n", ""),
            &mint(),
        );
        assert_eq!(z.name, "Shielded USDC");
        assert_eq!(z.symbol, "zSOL");
        for c in [
            '\u{0007}', '\u{061C}', '\u{200F}', '\u{202A}', '\u{2066}', '\u{FEFF}',
        ] {
            assert!(is_hidden(c), "{c:?}");
        }
        assert!(!is_hidden('é') && !is_hidden(' ') && !is_hidden('🛡'));
        // Names never end in whitespace after truncation.
        let z = derive(base(&format!("{} B", "A".repeat(22)), "S", ""), &mint());
        assert_eq!(z.name, format!("Shielded {}", "A".repeat(22)));
    }

    #[test]
    fn uri_is_copied_only_when_short_and_clean() {
        let ok = format!("https://a.example/{}", "x".repeat(MAX_URI_LEN - 18));
        assert_eq!(ok.len(), MAX_URI_LEN);
        assert_eq!(derive(base("A", "B", &ok), &mint()).uri, ok);
        let too_long = format!("{ok}x");
        assert_eq!(derive(base("A", "B", &too_long), &mint()).uri, "");
        assert_eq!(
            derive(base("A", "B", "https://a.example/\u{202E}gpj.exe"), &mint()).uri,
            ""
        );
    }

    fn encode(meta: &TokenMetadata) -> Vec<u8> {
        let mut v = Vec::new();
        meta.serialize(&mut v).unwrap();
        v
    }

    fn token_metadata(mint: Pubkey, name: &str, uri: &str) -> TokenMetadata {
        TokenMetadata {
            update_authority: OptionalNonZeroPubkey::try_from(Some(Pubkey::new_unique())).unwrap(),
            mint,
            name: name.into(),
            symbol: "SYM".into(),
            uri: uri.into(),
            additional_metadata: vec![("k".into(), "v".repeat(5000))],
        }
    }

    #[test]
    fn reads_borsh_token_metadata_without_the_extra_fields() {
        let m = mint();
        let data = encode(&token_metadata(m, "Name", "https://u"));
        assert_eq!(
            read_base_metadata(&data, &m),
            base("Name", "SYM", "https://u")
        );
        // Metadata of another mint is ignored.
        assert_eq!(read_base_metadata(&data, &Pubkey::new_unique()), None);
        // Over-long URIs are dropped, long names are only scanned partially.
        let long_uri = "u".repeat(MAX_URI_LEN + 1);
        let long_name = "N".repeat(10_000);
        let data = encode(&token_metadata(m, &long_name, &long_uri));
        let got = read_base_metadata(&data, &m).unwrap();
        assert_eq!((got.name.len(), got.uri), (SCAN_LIMIT, ""));
    }

    #[test]
    fn malformed_metadata_is_ignored() {
        let m = mint();
        let data = encode(&token_metadata(m, "Name", "https://u"));
        for cut in [0, 31, 64, 66, 70, 75, 80] {
            assert_eq!(read_base_metadata(&data[..cut], &m), None, "cut at {cut}");
        }
        // A length prefix pointing past the end.
        let mut bad = data.clone();
        bad[64..68].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(read_base_metadata(&bad, &m), None);
        // Invalid UTF-8 keeps only the valid prefix.
        let mut bad = data;
        bad[70] = 0xFF; // third byte of "Name"
        assert_eq!(read_base_metadata(&bad, &m).unwrap().name, "Na");
    }

    #[test]
    fn base58_is_the_address_text() {
        for key in [
            mint(),
            Pubkey::new_from_array([0; 32]),
            Pubkey::new_from_array([255; 32]),
            Pubkey::new_from_array({
                let mut k = [0u8; 32];
                k[3] = 1;
                k
            }),
            Pubkey::new_unique(),
        ] {
            assert_eq!(base58(&key), key.to_string());
        }
    }
}
