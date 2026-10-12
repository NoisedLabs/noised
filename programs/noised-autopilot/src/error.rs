use anchor_lang::prelude::*;

#[error_code]
pub enum AutopilotError {
    #[msg("Account is not a Noised launchpad launch")]
    NotALaunch,
    #[msg("The launch is not live yet")]
    LaunchNotLive,
    #[msg("Certificate is not the launchpad's for this launch and mint, or lacks a safety check")]
    InvalidCertificate,
    #[msg("DBC config is not the launch's (wSOL quote, migration price)")]
    InvalidDbcConfig,
    #[msg("The autopilot's mint is already bound")]
    MintAlreadyBound,
    #[msg("The autopilot's mint is not bound yet (bind_mint once the launch is live)")]
    MintNotBound,
    #[msg("Graph bytes do not verify as PXG1")]
    InvalidGraph,
    #[msg("Graph record is not the one this autopilot names")]
    GraphMismatch,
    #[msg("Authorization is not the launch identity's authorization of this action")]
    InvalidAuthorization,
    #[msg("Authorization landed before one already used")]
    StaleAuthorization,
    #[msg("The graph is frozen forever")]
    Frozen,
    #[msg("No graph is active")]
    NoActiveGraph,
    #[msg("No graph update is pending")]
    NoPendingUpdate,
    #[msg("A first graph must activate now or later")]
    ActivationInPast,
    #[msg("A graph update must take effect at least 72 hours after it is queued")]
    TimelockTooShort,
    #[msg("The pending graph update is not due yet")]
    UpdateNotDue,
    #[msg("A graph update is due: apply it first")]
    PendingUpdateDue,
    #[msg("There is no operator")]
    NoOperator,
    #[msg("No such node in the active graph")]
    NoSuchNode,
    #[msg("The node is not due")]
    NodeNotDue,
    #[msg("The token has not graduated to its DAMM v2 pool")]
    NotGraduated,
    #[msg("The node ran as often as allowed this epoch")]
    MaxRunsReached,
    #[msg("The node spent its budget for this epoch")]
    BudgetSpent,
    #[msg("The node's condition does not hold")]
    ConditionFalse,
    #[msg("Only the graph's operator can run this node")]
    WrongOperator,
    #[msg("Only operator-gated nodes and buybacks take an amount")]
    AmountNotAllowed,
    #[msg("The amount must be above zero and within the node's cap and the treasury")]
    InvalidAmount,
    #[msg("The treasury holds nothing this node could move")]
    NothingToDo,
    #[msg("The pool price is above the reference price plus the node's premium")]
    PremiumExceeded,
    #[msg("The reference price is out of range for this swap")]
    PriceOutOfRange,
    #[msg("The swap did not take exactly the amount in or returned less than the minimum")]
    SwapShortfall,
    #[msg("Pool is not the launch's DAMM v2 pool")]
    InvalidPool,
    #[msg("DAMM v2 accounts are missing or wrong")]
    InvalidDammAccounts,
    #[msg("Recipient accounts are missing or wrong")]
    InvalidRecipientAccounts,
    #[msg("Observe the pool price first (update_price), then run at least a minute later")]
    PriceNotObserved,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("This action takes no remaining accounts")]
    UnexpectedAccounts,
    #[msg(
        "A keeper's buyback must move at least 1% of the pool's SOL (or the node's whole amount)"
    )]
    AmountTooSmall,
    #[msg("DAMM v2 config is not one DBC migrates through")]
    InvalidDammConfig,
    #[msg("The autopilot's pool is already bound")]
    PoolAlreadyBound,
    #[msg("The freeze authorization is past its not_after")]
    FreezeExpired,
    #[msg(
        "A keeper's partial buyback must leave at least 1% of the pool's SOL of the node's amount (or move all of it)"
    )]
    RemainderTooSmall,
    #[msg("No recipient of a share has a wSOL account to receive it")]
    NoRecipientAccount,
}
