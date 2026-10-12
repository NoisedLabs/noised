use anchor_lang::prelude::*;

#[error_code]
pub enum LaunchpadError {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Platform fee is above the maximum or the treasury is not a wSOL PQ vault")]
    InvalidProtocolParams,
    #[msg("Token decimals must be 6..=9")]
    InvalidDecimals,
    #[msg("Migration threshold must be 1..=100_000 SOL")]
    InvalidThreshold,
    #[msg("Start price or curve is outside DBC's rules (1..=8 increasing points, liquidity > 0)")]
    InvalidCurve,
    #[msg("Base fee must be a linear or exponential scheduler within DBC's bounds")]
    InvalidBaseFee,
    #[msg("Fee schedule must end before the batch executes (duration <= open delay)")]
    FeeScheduleTooLong,
    #[msg("Dynamic fee parameters are outside DBC's bounds")]
    InvalidDynamicFee,
    #[msg("Fee after the schedule (base + max dynamic) exceeds the safety ceiling")]
    FeeTooHigh,
    #[msg("Migration fee option must be 0..=5 (fixed DAMM v2 fee tiers)")]
    InvalidMigrationFeeOption,
    #[msg("Open delay must be 60..=1800 seconds")]
    InvalidOpenDelay,
    #[msg("Guard must cover the open delay plus the execution window and last at most 72h")]
    InvalidGuard,
    #[msg("Max wallet must be 0 (off) or 10..=10_000 bps")]
    InvalidMaxWallet,
    #[msg("Max buy must be 0 (off) or 1..=10_000 bps")]
    InvalidMaxBuy,
    #[msg("Batch caps: total 0 or 10%..=100% of the threshold; per wallet 0 or at least 1/200 of the total")]
    InvalidBatchCap,
    #[msg("Recipients: 1..=4 distinct, non-default wallets with bps > 0 summing to 10_000")]
    InvalidRecipients,
    #[msg("Name (1..=32 bytes) or symbol (1..=10) is out of bounds, or the external uri is not https:// in printable ASCII")]
    InvalidMetadata,
    #[msg("Only the launch creator can do this")]
    WrongCreator,
    #[msg("Launch is not in the required state")]
    WrongLaunchState,
    #[msg("Account does not match the launch")]
    AccountMismatch,
    #[msg("Freshly created mint failed a safety post-condition")]
    UnsafeMint,
    #[msg("DBC config or pool does not hold the expected safe values")]
    UnsafeConfig,
    #[msg("Hook policy does not hold the expected values")]
    UnsafePolicy,
    #[msg("Commits are only accepted during the commit window")]
    NotCommitWindow,
    #[msg("The batch can only execute during the execution window")]
    NotExecuteWindow,
    #[msg("The batch has already executed")]
    AlreadyExecuted,
    #[msg("Nothing was committed to the batch")]
    EmptyBatch,
    #[msg("Batch swap returned no tokens")]
    EmptySwap,
    #[msg("Commit has already been claimed")]
    AlreadyClaimed,
    #[msg("The batch has not executed or expired yet")]
    BatchPending,
    #[msg("Commit or batch cap exceeded")]
    CapExceeded,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Payout would exceed what the escrow holds for this launch")]
    PayoutExceedsEscrow,
    #[msg("Transfer-hook accounts are missing or wrong")]
    InvalidHookAccounts,
    #[msg("Recipient accounts are missing or wrong")]
    InvalidRecipientAccounts,
    #[msg("Nothing to claim or distribute")]
    NothingToDo,
    #[msg("Position is not a launch-authority LP position of this launch's DAMM v2 pool")]
    InvalidPosition,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("The pool was traded before the batch; the batch can only refund")]
    PoolAlreadyTraded,
    #[msg("Post-quantum identity is missing or does not match the launch")]
    InvalidPqIdentity,
    #[msg("LMS signature is malformed or does not verify over the launch's attestation message")]
    InvalidPqSignature,
    #[msg("This one-time leaf of the post-quantum identity has already signed")]
    PqLeafUsed,
    #[msg("Attestation does not match the launch, its identity or its metadata")]
    AttestationMismatch,
    #[msg("Payout owner must be the committer or a PQ vault of the paid mint (one commit per vault), and never changes")]
    InvalidPayoutOwner,
    #[msg("The launch can only go live inside the window its attestation signed")]
    NotLaunchWindow,
    #[msg("Metadata flags: an unknown bit or both uri modes, a uri without the external-uri flag, or an inline uri without a document")]
    InvalidMetadataFlags,
    #[msg("Metadata document is over 3,072 bytes or the uri is over 200")]
    MetadataTooLong,
    #[msg("The mint's metadata does not equal the attested on-chain record")]
    MetadataMismatch,
    #[msg("Launch rules do not verify (PXR1) for this launch's guard")]
    InvalidRules,
}
