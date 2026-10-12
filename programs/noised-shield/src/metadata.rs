//! zToken name, symbol and URI: a deterministic function of the base mint.
//!
//! The base mint's metadata is attacker-controlled input, so it is read
//! without allocating (only the three leading strings, never the unbounded
//! additional-metadata list), stripped of invisible characters that could
//! disguise a name in wallets, and cut at UTF-8 character boundaries.

use anchor_lang::prelude::Pubkey;

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

/// Strings read from a base mint's Token-2022 `TokenMetadata`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BaseMetadata<'a> {
    pub name: &'a str,
    pub symbol: &'a str,
    /// Empty when the base URI is longer than [`MAX_URI_LEN`] or not UTF-8.
    pub uri: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZMetadata {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Derive the zToken metadata. `base` is `None` when the base mint has no
/// canonical Token-2022 metadata; each field falls back separately.
pub fn derive(base: Option<BaseMetadata<'_>>, base_mint: &Pubkey) -> ZMetadata {
    let fallback = |chars: usize| -> String { base_mint.to_string().chars().take(chars).collect() };
    let name = base
        .map(|b| clean(b.name, MAX_NAME_LEN))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback(GENERIC_NAME_CHARS));
    let symbol = base
        .map(|b| clean(b.symbol, MAX_SYMBOL_LEN))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback(GENERIC_SYMBOL_CHARS));
    let uri = base
        .map(|b| b.uri)
        .filter(|u| u.len() <= MAX_URI_LEN && !u.chars().any(is_hidden))
        .unwrap_or_default();
    ZMetadata {
        name: prefixed(NAME_PREFIX, &name, MAX_NAME_LEN),
        symbol: prefixed(SYMBOL_PREFIX, &symbol, MAX_SYMBOL_LEN),
        uri: uri.to_string(),
    }
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
    let bytes = &bytes[..bytes.len().min(max)];
    match core::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => core::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or(""),
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

/// Visible characters of `s`, trimmed, at most `max` bytes.
fn clean(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars().filter(|c| !is_hidden(*c)) {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// `prefix + body`, cut to at most `max` bytes on a character boundary.
fn prefixed(prefix: &str, body: &str, max: usize) -> String {
    let mut out = String::with_capacity(max);
    out.push_str(prefix);
    for c in body.chars() {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out.truncate(out.trim_end().len());
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
                assert!(z.name.starts_with(NAME_PREFIX) && z.symbol.starts_with(SYMBOL_PREFIX));
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
}
