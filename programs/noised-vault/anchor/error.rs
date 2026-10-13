use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Key id does not match the LM-OTS public key")]
    KeyIdMismatch,
    #[msg("Invalid post-quantum signature")]
    InvalidSignature,
    #[msg("The next key must differ from the current key")]
    InvalidNextKey,
    #[msg("Mint cannot be held in a vault")]
    UnsupportedMint,
    #[msg("Destination is not the recipient's associated token account for this mint")]
    InvalidDestination,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key")]
    InvalidKeyIndex,
}

#[cfg(test)]
mod tests {
    use super::VaultError;

    /// Clients map error numbers to messages, so they never move: round 2
    /// appended `InvalidKeyIndex` after the existing variants.
    #[test]
    fn error_numbers_are_stable() {
        let pinned = [
            (VaultError::KeyIdMismatch, 6000),
            (VaultError::InvalidSignature, 6001),
            (VaultError::InvalidNextKey, 6002),
            (VaultError::UnsupportedMint, 6003),
            (VaultError::InvalidDestination, 6004),
            (VaultError::MathOverflow, 6005),
            (VaultError::InvalidKeyIndex, 6006),
        ];
        for (error, number) in pinned {
            assert_eq!(u32::from(error), number, "{error:?}");
        }
    }
}
