use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
}

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub dbc_config: Pubkey,
    pub params_hash: [u8; 32],
    pub platform_fee_bps: u16,
    pub pq_identity: [u8; 32],
}

/// `publish_metadata` created a metadata record (not emitted when the record
/// already existed).
#[event]
pub struct MetadataPublished {
    pub launch: Pubkey,
    /// `["metadata", launch, metadata_hash]`.
    pub token_meta: Pubkey,
    pub metadata_hash: [u8; 32],
    pub flags: u8,
    /// Bytes of the record's uri and document.
    pub uri_len: u16,
    pub doc_len: u16,
}

/// `publish_rules` created a rules record (not emitted when the record
/// already existed).
#[event]
pub struct RulesPublished {
    pub launch: Pubkey,
    /// `["rules", launch, rules_hash]`.
    pub rules: Pubkey,
    pub rules_hash: [u8; 32],
    /// Bytes of the PXR1 rule set.
    pub len: u16,
}

/// `attest_launch` recorded the launch's post-quantum attestation (the
/// first one, or one replacing an attestation whose window ended while the
/// launch was Configured).
#[event]
pub struct LaunchAttested {
    pub launch: Pubkey,
    pub pq_identity: [u8; 32],
    pub leaf: u16,
    /// Names the attested `TokenMeta` (`["metadata", launch, metadata_hash]`).
    pub metadata_hash: [u8; 32],
    /// Names the attested `LaunchRules` (`["rules", launch, rules_hash]`);
    /// all zero for none.
    pub rules_hash: [u8; 32],
    pub slot: u64,
    /// The window `launch` may run in (unix seconds, inclusive).
    pub not_before: i64,
    pub not_after: i64,
}

/// `attest_launch` landed a valid signature that does not attest the launch:
/// the launch is attested and its window has not ended (or it is Live), or
/// the signing identity is not the one the launch names, or no metadata
/// record (or no rules record, for a non-zero rules hash) exists at the
/// address the signed hash names, or the signed window is one `launch`
/// could not use (not even a minute of it left). Or `pq_authorize` landed a
/// valid signature that does not authorize: another identity's, or a
/// second one of an authorization already written. Its leaf (of the
/// identity `pq_identity` that signed) is now used and can never sign
/// again.
#[event]
pub struct PqLeafConsumed {
    pub pq_identity: [u8; 32],
    pub leaf: u16,
    pub launch: Pubkey,
}

/// `pq_authorize` wrote an authorization by the launch's identity.
#[event]
pub struct Authorized {
    pub launch: Pubkey,
    /// `["auth", launch, [kind], payload_hash]`.
    pub authorization: Pubkey,
    pub pq_identity: [u8; 32],
    pub kind: u8,
    pub payload_hash: [u8; 32],
    pub leaf: u16,
    pub unix_time: i64,
    pub slot: u64,
}

#[event]
pub struct Launched {
    pub launch: Pubkey,
    pub base_mint: Pubkey,
    pub pool: Pubkey,
    pub certificate: Pubkey,
    pub initial_supply: u64,
    pub launch_ts: i64,
    pub commit_end_ts: i64,
    pub execute_end_ts: i64,
    pub guard_end_ts: i64,
    pub pq_identity: [u8; 32],
    pub pq_leaf: u16,
}

#[event]
pub struct Committed {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub owner_total: u64,
    pub total_committed: u64,
    pub token_owner: Pubkey,
    pub refund_owner: Pubkey,
}

#[event]
pub struct BatchExecuted {
    pub launch: Pubkey,
    pub total_committed: u64,
    pub quote_spent: u64,
    pub tokens_out: u64,
}

#[event]
pub struct BatchClaimed {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub tokens: u64,
    pub refund: u64,
    pub expired: bool,
    /// Where the tokens went (the canonical base-token ATA of this owner).
    pub token_owner: Pubkey,
    /// Where the refund went (the canonical wSOL ATA of this owner).
    pub refund_owner: Pubkey,
}

#[event]
pub struct FeesClaimed {
    pub launch: Pubkey,
    /// wSOL that arrived in the launch authority's account.
    pub quote_amount: u64,
    /// true for DBC surplus withdrawals, false for trading fees.
    pub surplus: bool,
}

#[event]
pub struct LpFeesClaimed {
    pub launch: Pubkey,
    pub position: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[event]
pub struct Distributed {
    pub launch: Pubkey,
    pub platform_amount: u64,
    pub recipients_amount: u64,
    pub base_burned: u64,
}
