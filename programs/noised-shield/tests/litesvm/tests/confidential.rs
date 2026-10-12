//! A zToken really is a Confidential Balances token on mainnet Token-2022 v11
//! with the mainnet feature set (ZK ElGamal proof program re-enabled):
//! accounts are approved without any authority, balances move between public
//! and encrypted form with plain Token-2022 instructions, and only the public
//! balance can be unwrapped.
//!
//! Proofs are generated with zk-sdk 7, whose Fiat-Shamir transcript the
//! re-enabled proof program verifies (zk-sdk 4 proofs, as bundled by
//! spl-token-2022-interface 2.1, are rejected). Proof byte layouts and proof
//! instruction tags did not change, so the bytes are re-typed for the
//! interface's instruction builders.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        confidential_transfer::{
            instruction as ct, ConfidentialTransferAccount, DecryptableBalance,
        },
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Account as TokenAccountState,
};
use common::*;
use solana_signer::Signer;
use solana_zk_sdk_v7::{
    encryption::{
        auth_encryption::{AeCiphertext, AeKey},
        elgamal::{ElGamalCiphertext, ElGamalKeypair},
        pedersen::{Pedersen, PedersenOpening},
    },
    zk_elgamal_proof_program::{
        build_batched_range_proof_u64_data, build_ciphertext_commitment_equality_proof_data,
        build_pubkey_validity_proof_data,
    },
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

/// Same bytes, the other crate version's type (sizes must match exactly).
fn retype<A: bytemuck::Pod, B: bytemuck::Pod>(value: &A) -> B {
    assert_eq!(
        std::mem::size_of::<A>(),
        std::mem::size_of::<B>(),
        "layout changed"
    );
    bytemuck::pod_read_unaligned(bytemuck::bytes_of(value))
}

fn decryptable(ae: &AeKey, amount: u64) -> DecryptableBalance {
    bytemuck::pod_read_unaligned(&ae.encrypt(amount).to_bytes())
}

/// `SetComputeUnitLimit(units)`: range-proof verification alone costs ~110k CU.
fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        accounts: Vec::<AccountMeta>::new(),
        data,
    }
}

fn confidential_state(env: &Env, account: &Pubkey) -> ConfidentialTransferAccount {
    let data = env.data(account);
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data).unwrap();
    *state
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap()
}

#[test]
fn ztokens_move_between_public_and_confidential_balances() {
    let mut env = Env::new();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 1_000);
    let a = alice.pubkey();
    env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &[])],
        &[&alice],
    );

    // Configure the zToken account for confidential transfers. No mint
    // authority approves it: the zToken auto-approves and has no authority.
    let elgamal = ElGamalKeypair::new_rand();
    let ae = AeKey::new_rand();
    let realloc = spl_token_2022::instruction::reallocate(
        &T22,
        &alice_z,
        &payer,
        &a,
        &[],
        &[ExtensionType::ConfidentialTransferAccount],
    )
    .unwrap();
    let validity: ct::PubkeyValidityProofData =
        retype(&build_pubkey_validity_proof_data(&elgamal).unwrap());
    let mut ixs = vec![realloc];
    ixs.extend(
        ct::configure_account(
            &T22,
            &alice_z,
            &s.z_mint,
            &decryptable(&ae, 0),
            65_536,
            &a,
            &[],
            ProofLocation::InstructionOffset(1.try_into().unwrap(), &validity),
        )
        .unwrap(),
    );
    env.ok(&ixs, &[&alice]);
    assert!(
        bool::from(confidential_state(&env, &alice_z).approved),
        "auto-approved"
    );

    // Public -> pending -> available (encrypted): only 400 stay public.
    let deposit = ct::deposit(&T22, &alice_z, &s.z_mint, 600, 6, &a, &[]).unwrap();
    let apply =
        ct::apply_pending_balance(&T22, &alice_z, 1, &decryptable(&ae, 600), &a, &[]).unwrap();
    env.ok(&[deposit, apply], &[&alice]);
    assert_eq!(env.balance(&alice_z), 400);
    let cta = confidential_state(&env, &alice_z);
    let available = bytemuck::bytes_of(&cta.available_balance);
    let available = ElGamalCiphertext::from_bytes(available).unwrap();
    assert_eq!(
        available.decrypt_u32(elgamal.secret()),
        Some(600),
        "owner can decrypt"
    );
    let hint = bytemuck::bytes_of(&cta.decryptable_available_balance);
    let hint = AeCiphertext::from_bytes(hint).unwrap();
    assert_eq!(ae.decrypt(&hint), Some(600));
    // Encrypted tokens are still backed: supply counts them, escrow holds them.
    assert_eq!(assert_exactly_backed(&env, &s), 1_000);

    // Only the public balance can be unwrapped.
    assert_fails(env.send(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 401, &[])],
        &[&alice],
    ));
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 400, &[])],
        &[&alice],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 600);

    // Withdraw the encrypted 600 back to public: the remaining balance (0)
    // gets an equality proof and a range proof. LiteSVM does not enforce the
    // 1232-byte packet limit; on mainnet clients put these proofs in
    // context-state accounts first.
    let (commitment, opening) = Pedersen::new(0u64);
    let withdrawn = elgamal
        .pubkey()
        .encrypt_with_u64(600, &PedersenOpening::default());
    let remaining = available - withdrawn;
    let equality = build_ciphertext_commitment_equality_proof_data(
        &elgamal,
        &remaining,
        &commitment,
        &opening,
        0,
    )
    .unwrap();
    let equality: ct::CiphertextCommitmentEqualityProofData = retype(&equality);
    let range: ct::BatchedRangeProofU64Data = retype(
        &build_batched_range_proof_u64_data(vec![&commitment], vec![0], vec![64], vec![&opening])
            .unwrap(),
    );
    let mut ixs = vec![compute_limit(1_400_000)];
    ixs.extend(
        ct::withdraw(
            &T22,
            &alice_z,
            &s.z_mint,
            600,
            6,
            &decryptable(&ae, 0),
            &a,
            &[],
            ProofLocation::InstructionOffset(1.try_into().unwrap(), &equality),
            ProofLocation::InstructionOffset(2.try_into().unwrap(), &range),
        )
        .unwrap(),
    );
    env.ok(&ixs, &[&alice]);
    assert_eq!(env.balance(&alice_z), 600);
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 600, &[])],
        &[&alice],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 0);
    assert_eq!(env.balance(&alice_base), 1_000);
}
