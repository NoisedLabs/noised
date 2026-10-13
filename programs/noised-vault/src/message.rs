use crate::Pubkey;

/// Domain tag of every vault message; versioned so formats never collide.
pub const MESSAGE_TAG: &[u8; 8] = b"PHX-PQV4";
pub const OP_WITHDRAW: u8 = 1;
pub const WITHDRAW_MESSAGE_LEN: usize = 8 + 1 + 32 * 3 + 8 + 32 + 8 + 32;

/// The exact bytes a vault key signs to authorize a withdrawal.
///
/// ```text
/// "PHX-PQV4" | op=1 | program_id | vault | mint | sequence (u64 LE)
///            | destination_owner | max_amount (u64 LE) | next_key_id
/// ```
///
/// `sequence` is the vault's withdrawal counter: the message can only ever
/// execute once, at that position, even if a key were reused. The recipient
/// is a wallet, never a token account, so nothing in the message depends on
/// account state the recipient can change.
///
/// Nothing time-dependent is included, so a dropped transaction can be
/// re-broadcast with the same signature (re-signing would reuse the key).
pub fn withdraw_message(
    program_id: &Pubkey,
    vault: &Pubkey,
    mint: &Pubkey,
    sequence: u64,
    destination_owner: &Pubkey,
    max_amount: u64,
    next_key_id: &[u8; 32],
) -> [u8; WITHDRAW_MESSAGE_LEN] {
    let mut m = [0u8; WITHDRAW_MESSAGE_LEN];
    m[0..8].copy_from_slice(MESSAGE_TAG);
    m[8] = OP_WITHDRAW;
    m[9..41].copy_from_slice(program_id.as_ref());
    m[41..73].copy_from_slice(vault.as_ref());
    m[73..105].copy_from_slice(mint.as_ref());
    m[105..113].copy_from_slice(&sequence.to_le_bytes());
    m[113..145].copy_from_slice(destination_owner.as_ref());
    m[145..153].copy_from_slice(&max_amount.to_le_bytes());
    m[153..185].copy_from_slice(next_key_id);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_fixed() {
        assert_eq!(WITHDRAW_MESSAGE_LEN, 185);
        let k = |b: u8| Pubkey::new_from_array([b; 32]);
        let m = withdraw_message(&k(1), &k(2), &k(3), 0x0102, &k(4), 0x0a0b, &[5u8; 32]);
        assert_eq!(&m[0..9], b"PHX-PQV4\x01");
        assert_eq!(m[9], 1);
        assert_eq!(m[41], 2);
        assert_eq!(m[73], 3);
        assert_eq!(&m[105..113], &[0x02, 0x01, 0, 0, 0, 0, 0, 0]);
        assert_eq!(m[113], 4);
        assert_eq!(&m[145..153], &[0x0b, 0x0a, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&m[153..185], &[5u8; 32]);
    }
}
