use anchor_lang::prelude::*;

#[error_code]
pub enum ShieldError {
    #[msg("Base mint has a Token-2022 extension the shield does not accept")]
    UnsupportedExtension,
    #[msg("Base mint's Token-2022 data could not be parsed")]
    MalformedBaseMint,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The escrow received no tokens (the transfer fee took everything)")]
    NothingReceived,
    #[msg("zToken supply exceeds the escrow balance")]
    Undercollateralized,
    #[msg("Minted or burned zTokens do not match the escrow balance change")]
    AccountingMismatch,
    #[msg("zToken mint address is already in use")]
    ZMintInUse,
    #[msg("zToken mint failed its post-creation checks")]
    ZMintMisconfigured,
    #[msg("Source and destination token accounts must differ")]
    SameAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
