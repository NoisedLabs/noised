//! Events: `sol_log_data` of one slice, the event's discriminator
//! (`sha256("event:<Name>")[..8]`) followed by its fields in Borsh, as
//! Anchor's `emit!` logged them. Each event's `emit` builds that payload;
//! off-chain the Anchor attribute gives clients and tests `Event::data` and
//! the Borsh decoders (the ABI tests check that both payloads are equal).

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

use crate::{discriminator, Pubkey};

/// Logs `discriminator ++ fields` as one `sol_log_data` slice.
#[inline(never)]
fn emit_fields(discriminator: &[u8; 8], fields: &[&[u8]]) {
    let mut payload = [0u8; 256];
    payload[..8].copy_from_slice(discriminator);
    let mut len = 8;
    for field in fields {
        let end = len + field.len();
        if let Some(slot) = payload.get_mut(len..end) {
            slot.copy_from_slice(field);
            len = end;
        }
    }
    noised_onchain::sys::log_data(payload.get(..len).unwrap_or(&[]));
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolInitialized {
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
}

impl ProtocolInitialized {
    pub fn emit(&self) {
        Self::log(&self.treasury, self.platform_fee_bps)
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(treasury: &Pubkey, platform_fee_bps: u16) {
        emit_fields(
            &discriminator::PROTOCOL_INITIALIZED,
            &[treasury.as_ref(), &platform_fee_bps.to_le_bytes()],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub dbc_config: Pubkey,
    pub params_hash: [u8; 32],
    pub platform_fee_bps: u16,
    pub pq_identity: [u8; 32],
}

impl LaunchCreated {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.creator,
            &self.dbc_config,
            &self.params_hash,
            self.platform_fee_bps,
            &self.pq_identity,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(
        launch: &Pubkey,
        creator: &Pubkey,
        dbc_config: &Pubkey,
        params_hash: &[u8; 32],
        platform_fee_bps: u16,
        pq_identity: &[u8; 32],
    ) {
        emit_fields(
            &discriminator::LAUNCH_CREATED,
            &[
                launch.as_ref(),
                creator.as_ref(),
                dbc_config.as_ref(),
                params_hash,
                &platform_fee_bps.to_le_bytes(),
                pq_identity,
            ],
        )
    }
}

/// `publish_metadata` created a metadata record (not emitted when the record
/// already existed).
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl MetadataPublished {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.token_meta,
            &self.metadata_hash,
            self.flags,
            self.uri_len,
            self.doc_len,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(
        launch: &Pubkey,
        token_meta: &Pubkey,
        metadata_hash: &[u8; 32],
        flags: u8,
        uri_len: u16,
        doc_len: u16,
    ) {
        emit_fields(
            &discriminator::METADATA_PUBLISHED,
            &[
                launch.as_ref(),
                token_meta.as_ref(),
                metadata_hash,
                &[flags],
                &uri_len.to_le_bytes(),
                &doc_len.to_le_bytes(),
            ],
        )
    }
}

/// `publish_rules` created a rules record (not emitted when the record
/// already existed).
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RulesPublished {
    pub launch: Pubkey,
    /// `["rules", launch, rules_hash]`.
    pub rules: Pubkey,
    pub rules_hash: [u8; 32],
    /// Bytes of the PXR1 rule set.
    pub len: u16,
}

impl RulesPublished {
    pub fn emit(&self) {
        Self::log(&self.launch, &self.rules, &self.rules_hash, self.len)
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(launch: &Pubkey, rules: &Pubkey, rules_hash: &[u8; 32], len: u16) {
        emit_fields(
            &discriminator::RULES_PUBLISHED,
            &[
                launch.as_ref(),
                rules.as_ref(),
                rules_hash,
                &len.to_le_bytes(),
            ],
        )
    }
}

/// `attest_launch` recorded the launch's post-quantum attestation (the
/// first one, or one replacing an attestation whose window ended while the
/// launch was Configured).
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl LaunchAttested {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.pq_identity,
            self.leaf,
            &self.metadata_hash,
            &self.rules_hash,
            self.slot,
            self.not_before,
            self.not_after,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn log(
        launch: &Pubkey,
        pq_identity: &[u8; 32],
        leaf: u16,
        metadata_hash: &[u8; 32],
        rules_hash: &[u8; 32],
        slot: u64,
        not_before: i64,
        not_after: i64,
    ) {
        emit_fields(
            &discriminator::LAUNCH_ATTESTED,
            &[
                launch.as_ref(),
                pq_identity,
                &leaf.to_le_bytes(),
                metadata_hash,
                rules_hash,
                &slot.to_le_bytes(),
                &not_before.to_le_bytes(),
                &not_after.to_le_bytes(),
            ],
        )
    }
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
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PqLeafConsumed {
    pub pq_identity: [u8; 32],
    pub leaf: u16,
    pub launch: Pubkey,
}

impl PqLeafConsumed {
    pub fn emit(&self) {
        Self::log(&self.pq_identity, self.leaf, &self.launch)
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(pq_identity: &[u8; 32], leaf: u16, launch: &Pubkey) {
        emit_fields(
            &discriminator::PQ_LEAF_CONSUMED,
            &[pq_identity, &leaf.to_le_bytes(), launch.as_ref()],
        )
    }
}

/// `pq_authorize` wrote an authorization by the launch's identity.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl Authorized {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.authorization,
            &self.pq_identity,
            self.kind,
            &self.payload_hash,
            self.leaf,
            self.unix_time,
            self.slot,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn log(
        launch: &Pubkey,
        authorization: &Pubkey,
        pq_identity: &[u8; 32],
        kind: u8,
        payload_hash: &[u8; 32],
        leaf: u16,
        unix_time: i64,
        slot: u64,
    ) {
        emit_fields(
            &discriminator::AUTHORIZED,
            &[
                launch.as_ref(),
                authorization.as_ref(),
                pq_identity,
                &[kind],
                payload_hash,
                &leaf.to_le_bytes(),
                &unix_time.to_le_bytes(),
                &slot.to_le_bytes(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl Launched {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.base_mint,
            &self.pool,
            &self.certificate,
            self.initial_supply,
            self.launch_ts,
            self.commit_end_ts,
            self.execute_end_ts,
            self.guard_end_ts,
            &self.pq_identity,
            self.pq_leaf,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub fn log(
        launch: &Pubkey,
        base_mint: &Pubkey,
        pool: &Pubkey,
        certificate: &Pubkey,
        initial_supply: u64,
        launch_ts: i64,
        commit_end_ts: i64,
        execute_end_ts: i64,
        guard_end_ts: i64,
        pq_identity: &[u8; 32],
        pq_leaf: u16,
    ) {
        emit_fields(
            &discriminator::LAUNCHED,
            &[
                launch.as_ref(),
                base_mint.as_ref(),
                pool.as_ref(),
                certificate.as_ref(),
                &initial_supply.to_le_bytes(),
                &launch_ts.to_le_bytes(),
                &commit_end_ts.to_le_bytes(),
                &execute_end_ts.to_le_bytes(),
                &guard_end_ts.to_le_bytes(),
                pq_identity,
                &pq_leaf.to_le_bytes(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub owner_total: u64,
    pub total_committed: u64,
    pub token_owner: Pubkey,
    pub refund_owner: Pubkey,
}

impl Committed {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.owner,
            self.amount,
            self.owner_total,
            self.total_committed,
            &self.token_owner,
            &self.refund_owner,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(
        launch: &Pubkey,
        owner: &Pubkey,
        amount: u64,
        owner_total: u64,
        total_committed: u64,
        token_owner: &Pubkey,
        refund_owner: &Pubkey,
    ) {
        emit_fields(
            &discriminator::COMMITTED,
            &[
                launch.as_ref(),
                owner.as_ref(),
                &amount.to_le_bytes(),
                &owner_total.to_le_bytes(),
                &total_committed.to_le_bytes(),
                token_owner.as_ref(),
                refund_owner.as_ref(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchExecuted {
    pub launch: Pubkey,
    pub total_committed: u64,
    pub quote_spent: u64,
    pub tokens_out: u64,
}

impl BatchExecuted {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            self.total_committed,
            self.quote_spent,
            self.tokens_out,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(launch: &Pubkey, total_committed: u64, quote_spent: u64, tokens_out: u64) {
        emit_fields(
            &discriminator::BATCH_EXECUTED,
            &[
                launch.as_ref(),
                &total_committed.to_le_bytes(),
                &quote_spent.to_le_bytes(),
                &tokens_out.to_le_bytes(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl BatchClaimed {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.owner,
            self.tokens,
            self.refund,
            self.expired,
            &self.token_owner,
            &self.refund_owner,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(
        launch: &Pubkey,
        owner: &Pubkey,
        tokens: u64,
        refund: u64,
        expired: bool,
        token_owner: &Pubkey,
        refund_owner: &Pubkey,
    ) {
        emit_fields(
            &discriminator::BATCH_CLAIMED,
            &[
                launch.as_ref(),
                owner.as_ref(),
                &tokens.to_le_bytes(),
                &refund.to_le_bytes(),
                &[u8::from(expired)],
                token_owner.as_ref(),
                refund_owner.as_ref(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeesClaimed {
    pub launch: Pubkey,
    /// wSOL that arrived in the launch authority's account.
    pub quote_amount: u64,
    /// true for DBC surplus withdrawals, false for trading fees.
    pub surplus: bool,
}

impl FeesClaimed {
    pub fn emit(&self) {
        Self::log(&self.launch, self.quote_amount, self.surplus)
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(launch: &Pubkey, quote_amount: u64, surplus: bool) {
        emit_fields(
            &discriminator::FEES_CLAIMED,
            &[
                launch.as_ref(),
                &quote_amount.to_le_bytes(),
                &[u8::from(surplus)],
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpFeesClaimed {
    pub launch: Pubkey,
    pub position: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
}

impl LpFeesClaimed {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            &self.position,
            self.base_amount,
            self.quote_amount,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(launch: &Pubkey, position: &Pubkey, base_amount: u64, quote_amount: u64) {
        emit_fields(
            &discriminator::LP_FEES_CLAIMED,
            &[
                launch.as_ref(),
                position.as_ref(),
                &base_amount.to_le_bytes(),
                &quote_amount.to_le_bytes(),
            ],
        )
    }
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Distributed {
    pub launch: Pubkey,
    pub platform_amount: u64,
    pub recipients_amount: u64,
    pub base_burned: u64,
}

impl Distributed {
    pub fn emit(&self) {
        Self::log(
            &self.launch,
            self.platform_amount,
            self.recipients_amount,
            self.base_burned,
        )
    }

    /// Logs this event with these fields (in order) without building it.
    #[inline(always)]
    pub fn log(launch: &Pubkey, platform_amount: u64, recipients_amount: u64, base_burned: u64) {
        emit_fields(
            &discriminator::DISTRIBUTED,
            &[
                launch.as_ref(),
                &platform_amount.to_le_bytes(),
                &recipients_amount.to_le_bytes(),
                &base_burned.to_le_bytes(),
            ],
        )
    }
}
