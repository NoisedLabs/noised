//! Creator launch rules (PXR1) end to end against mainnet DBC and
//! Token-2022: `publish_rules` (the exact record, idempotence, refusals),
//! attestation message v3 binding the rules (unpublished or junk rules only
//! burn the leaf), `launch` installing them in the hook policy and
//! certifying them (certificate v4, `RULES_BOUND`), and the hook deciding
//! real DBC buys and wallet-to-wallet transfers with them: DENY,
//! CAP_AMOUNT, CAP_DEST_BALANCE (absolute and in basis points of the
//! supply), time windows, the top-level program and instruction count, key
//! lists. Sells, claims, the batch and everything after the guard are never
//! affected; random verified rule sets decide real transfers exactly as the
//! reference evaluator does; compute at the largest rule set.

mod common;

#[path = "../../../../../crates/noised-rules/tests/common/mod.rs"]
mod rules_gen;

use anchor_lang::AccountSerialize;
use common::{launch::*, pq, world::*, *};
use noised_hook::{state::HookPolicy, HookError};
use noised_launchpad::{
    constants::*,
    error::LaunchpadError as E,
    events::{LaunchAttested, PqLeafConsumed, RulesPublished},
    state::{checks, Attestation, Certificate, Launch, LaunchParams, LaunchRules},
};
use noised_rules::{
    op, rules::effect, Node, Rule, RuleSet, RulesProgram, TransferCtx, Violation, BPS_FLAG,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// The guard of every launch here (`params().guard_secs`).
const GUARD: u32 = 3_600;
const TRUE: Node = Node::new(op::TRUE, 0, 0);
const AND: Node = Node::new(op::AND, 0, 0);
const OR: Node = Node::new(op::OR, 0, 0);
const NOT: Node = Node::new(op::NOT, 0, 0);

fn leaf(op: u8, a: u8, arg: u64) -> Node {
    Node::new(op, a, arg)
}

/// One rule: window `[from, to)` after the launch, effect, code, argument
/// and condition.
type R<'a> = (u32, u32, u8, u8, u64, &'a [Node]);

/// The PXR1 bytes of these rules over these keys, conditions back to back
/// (not verified).
fn encode(keys: &[Pubkey], rs: &[R]) -> Vec<u8> {
    let (mut rules, mut nodes) = (Vec::new(), Vec::new());
    for &(from, to, effect, code, arg, cond) in rs {
        rules.push(Rule {
            from_rel: from,
            to_rel: to,
            cond_off: nodes.len() as u8,
            cond_len: cond.len() as u8,
            effect,
            code,
            arg,
        });
        nodes.extend_from_slice(cond);
    }
    RulesProgram {
        keys: keys.iter().map(|k| k.to_bytes()).collect(),
        rules,
        nodes,
    }
    .encode()
    .unwrap()
}

/// `encode`, verified for the launches' guard.
fn rules(keys: &[Pubkey], rs: &[R]) -> Vec<u8> {
    let bytes = encode(keys, rs);
    RuleSet::verify(&bytes, GUARD).unwrap_or_else(|e| panic!("{e:?}"));
    bytes
}

/// The largest rule set (1,228 bytes: 8 keys, 16 rules, 64 nodes), every
/// rule active for the whole guard and a DENY, so a transfer evaluates
/// every node; no condition holds for the transfers here (`NOT (count > 0
/// OR <owner or program in a key>)`, and the keys are fresh).
fn largest_rules() -> Vec<u8> {
    let keys: Vec<Pubkey> = (0..8).map(|_| Pubkey::new_unique()).collect();
    let leaves = [
        op::rules::DEST_OWNER_IN,
        op::rules::SRC_OWNER_IN,
        op::rules::TOP_PROGRAM_IN,
    ];
    let conds: Vec<[Node; 4]> = (0..16)
        .map(|i| {
            [
                leaf(op::rules::TX_IX_COUNT_GT, 0, 0),
                leaf(leaves[i % 3], 1 << (i % 8), 0),
                OR,
                NOT,
            ]
        })
        .collect();
    let rs: Vec<R> = conds
        .iter()
        .enumerate()
        .map(|(i, c)| (0, GUARD, effect::DENY, i as u8, 0, &c[..]))
        .collect();
    let bytes = rules(&keys, &rs);
    assert_eq!(bytes.len(), 1_228);
    bytes
}

/// Launch parameters without built-in caps or lock: the rules alone decide
/// buys and wallet-to-wallet transfers.
fn open(p: &mut LaunchParams) {
    p.p2p_locked = false;
    p.max_buy_bps = 0;
    p.max_wallet_bps = 0;
}

/// The single event `T` of a transaction.
#[track_caller]
fn one_event<T: anchor_lang::Event>(sent: &Sent) -> T {
    let mut all = events::<T>(&sent.logs);
    assert_eq!(all.len(), 1, "{}", sent.logs.join("\n"));
    all.remove(0)
}

/// Refused by the hook's rule `rule` with `code`, logged as such.
#[track_caller]
fn denied(r: Result<Sent, Failed>, rule: u8, code: u8, what: &str) {
    let f = r.fails_with(hook_code(HookError::RuleDenied), "RuleDenied", what);
    let line = format!("Launch rule {rule} (code {code}) refused the transfer");
    assert!(
        f.logs.iter().any(|l| l.contains(&line)),
        "{what}: no `{line}`\n{}",
        f.logs.join("\n")
    );
}

/// A launch with these rules whose batch (alice's commit) executed and was
/// claimed: rules never touch either.
struct Ruled {
    w: World,
    k: Keys,
    alice: Keypair,
    launch_ts: i64,
    guard_end_ts: i64,
}

/// `w`'s batch (alice commits 1 SOL) executed at the end of the commit
/// window; not claimed yet.
fn batched(mut w: World) -> Ruled {
    let k = w.k;
    let alice = committer(&mut w.env, LAMPORTS_PER_SOL);
    w.env
        .send(&[commit(&alice.pubkey(), &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("commit");
    let l: Launch = w.env.anchor(&k.launch);
    w.env.set_time(l.commit_end_ts);
    let payer = w.env.payer.pubkey();
    w.env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("the batch buy: never affected by rules");
    Ruled {
        w,
        k,
        alice,
        launch_ts: l.launch_ts,
        guard_end_ts: l.guard_end_ts,
    }
}

/// A launch with these rules (and no built-in caps or lock), batched and
/// claimed.
fn ruled(bytes: &[u8]) -> Ruled {
    let mut r = batched(launched_with_rules(open, bytes));
    r.claim_alice()
        .expect_ok("the claim: never affected by rules");
    assert!(r.balance(&r.alice.pubkey()) > 0);
    r
}

impl Ruled {
    fn env(&mut self) -> &mut Env {
        &mut self.w.env
    }

    fn claim_alice(&mut self) -> Result<Sent, Failed> {
        let (k, payer, alice) = (self.k, self.w.env.payer.pubkey(), self.alice.pubkey());
        self.w
            .env
            .send(&[claim(&payer, &k, &alice, true, true)], &[])
    }

    /// `rel` seconds after the launch.
    fn at(&mut self, rel: i64) {
        let t = self.launch_ts + rel;
        self.w.env.set_time(t);
    }

    fn supply(&self) -> u64 {
        let a = self.w.env.account(&self.k.mint).unwrap();
        anchor_spl::token_interface::spl_token_2022::extension::StateWithExtensions::<
            anchor_spl::token_interface::spl_token_2022::state::Mint,
        >::unpack(&a.data)
        .unwrap()
        .base
        .supply
    }

    fn balance(&self, owner: &Pubkey) -> u64 {
        self.w.env.token_amount(&base_ata(owner, &self.k.mint))
    }

    /// A new wallet with 1 SOL of wSOL and an empty base-token ATA.
    fn buyer(&mut self) -> Keypair {
        let k = self.k;
        buyer(self.env(), &k)
    }

    /// `who` buys exactly `tokens` from the pool (DBC exact out), with
    /// `extra` top-level instructions before the swap.
    fn buy_with(
        &mut self,
        who: &Keypair,
        tokens: u64,
        extra: &[solana_instruction::Instruction],
    ) -> Result<Sent, Failed> {
        let mut ixs = extra.to_vec();
        ixs.push(dbc_buy_exact_out(
            &who.pubkey(),
            &self.k,
            tokens,
            LAMPORTS_PER_SOL / 2,
        ));
        self.w.env.send(&ixs, &[who])
    }

    fn buy(&mut self, who: &Keypair, tokens: u64) -> Result<Sent, Failed> {
        self.buy_with(who, tokens, &[])
    }

    fn sell(&mut self, who: &Keypair, tokens: u64) -> Result<Sent, Failed> {
        let ix = dbc_swap(&who.pubkey(), &self.k, false, tokens);
        self.w.env.send(&[ix], &[who])
    }

    /// `from` sends `amount` to `to`'s ATA (created first, outside the
    /// transfer's transaction).
    fn send_tokens(&mut self, from: &Keypair, to: &Pubkey, amount: u64) -> Result<Sent, Failed> {
        let (k, payer) = (self.k, self.w.env.payer.pubkey());
        self.w
            .env
            .send(
                &[create_ata(&payer, to, &k.mint, &TOKEN_2022_PROGRAM_ID)],
                &[],
            )
            .expect_ok("ATA");
        self.w
            .env
            .send(&[hooked_transfer(&k, &from.pubkey(), to, amount)], &[from])
    }

    /// Give `to` `amount` of alice's tokens (wallet to wallet: only when the
    /// rules let it through).
    fn alice_sends(&mut self, to: &Pubkey, amount: u64) -> Result<Sent, Failed> {
        let alice = self.alice.insecure_clone();
        self.send_tokens(&alice, to, amount)
    }
}

#[test]
fn publish_rules_writes_the_exact_record_once() {
    let mut w = created_with(open);
    let k = w.k;
    let env = &mut w.env;
    let bytes = rules(
        &[],
        &[(0, 600, effect::DENY, 3, 0, &[leaf(op::rules::IS_BUY, 0, 0)])],
    );
    let hash = pq::rules_hash(&bytes);
    let address = pq::rules_pda(&k.launch, &hash);
    let sent = pq::publish_rules(env, &k, &bytes);
    println!(
        "publish_rules ({} B): {} CU, {} bytes",
        bytes.len(),
        sent.cu,
        sent.size
    );
    let e: RulesPublished = one_event(&sent);
    assert_eq!(
        (e.launch, e.rules, e.rules_hash, usize::from(e.len)),
        (k.launch, address, hash, bytes.len())
    );
    // Exactly the record: version 1, the canonical bump, the launch, the
    // hash and the bytes, at exactly their size.
    let (_, bump) = Pubkey::find_program_address(
        &[RULES_SEED, k.launch.as_ref(), &hash],
        &noised_launchpad::ID,
    );
    let mut want = Vec::new();
    LaunchRules {
        version: 1,
        bump,
        launch: k.launch,
        rules_hash: hash,
        bytes: bytes.clone(),
    }
    .try_serialize(&mut want)
    .unwrap();
    let account = env.account(&address).unwrap();
    assert_eq!(account.owner, noised_launchpad::ID);
    assert_eq!(account.data, want);
    assert_eq!(account.data.len(), LaunchRules::space(bytes.len()));
    assert_eq!(
        account.lamports,
        env.svm.minimum_balance_for_rent_exemption(want.len())
    );

    // Idempotent: the same bytes again succeed and write nothing.
    let again = pq::publish_rules(env, &k, &bytes);
    assert!(events::<RulesPublished>(&again.logs).is_empty());
    assert_eq!(env.account(&address).unwrap(), account);

    // Rules that do not verify for this launch's guard (3,600 s): a window
    // past it (valid for a 72-hour guard), and bytes that are no rule set.
    let past = encode(
        &[],
        &[(
            0,
            GUARD + 1,
            effect::DENY,
            3,
            0,
            &[leaf(op::rules::IS_BUY, 0, 0)],
        )],
    );
    RuleSet::verify(&past, 72 * 3_600).unwrap();
    for (what, junk) in [
        ("a window past the guard", past),
        ("not a rule set", b"PXR1 junk".to_vec()),
        ("empty", vec![]),
    ] {
        pq::try_publish_rules(env, &k, &junk).fails_with(
            code(E::InvalidRules),
            "InvalidRules",
            what,
        );
        assert!(
            pq::rules_account(env, &pq::rules_pda(&k.launch, &pq::rules_hash(&junk))).is_none()
        );
    }
    // Only the address the bytes hash to.
    let other = rules(&[], &[(0, 60, effect::DENY, 4, 0, &[TRUE])]);
    let payer = env.funded(1);
    let mut ix = pq::publish_rules_ix(&payer.pubkey(), &k, &other);
    ix.accounts[2].pubkey = address;
    env.send(&[ix], &[&payer]).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "another hash's address",
    );
    // An address funded beforehand by anyone is taken over.
    let other_address = pq::rules_pda(&k.launch, &pq::rules_hash(&other));
    env.airdrop(&other_address, 1_000_000);
    pq::publish_rules(env, &k, &other);
    assert_eq!(pq::rules_account(env, &other_address).unwrap().bytes, other);

    // The largest rule set fits a v1 transaction.
    let largest = largest_rules();
    let sent = pq::publish_rules(env, &k, &largest);
    println!(
        "MEASURE publish_rules (largest, {} B): {} CU, {} bytes (v1 limit {V1_MAX_TRANSACTION_SIZE})",
        largest.len(),
        sent.cu,
        sent.size
    );
    assert!(sent.size <= V1_MAX_TRANSACTION_SIZE);

    // Only while the launch is configured.
    pq::attest(env, &k, META);
    let c = w.creator.pubkey();
    w.env
        .send(&[launch(&c, &k, NAME, SYMBOL, URI)], &[&w.creator, &w.mint])
        .expect_ok("launch");
    let late = rules(&[], &[(0, 60, effect::DENY, 5, 0, &[TRUE])]);
    pq::try_publish_rules(&mut w.env, &k, &late).fails_with(
        code(E::WrongLaunchState),
        "WrongLaunchState",
        "rules for a live launch",
    );
}

/// The attestation (message v3) binds the rules record: it attests only if
/// the record its hash names exists; any other valid signature (rules never
/// published, a hash that names no rule set) lands and only burns its leaf.
/// The rules account is fixed by the signed hash, so a relayer can land a
/// signature or not, never change what it does.
#[test]
fn attestation_v3_binds_the_published_rules() {
    let mut w = created_with(open);
    let k = w.k;
    let env = &mut w.env;
    pq::publish(env, &k, META);
    let published = rules(&[], &[(0, 600, effect::DENY, 1, 0, &[TRUE])]);
    let unpublished = rules(&[], &[(0, 900, effect::DENY, 2, 0, &[TRUE])]);
    pq::publish_rules(env, &k, &published);
    let identity_used =
        |env: &Env| pq::identity_account(env, &pq::identity_id()).map_or(0, |id| id.used_count);

    // Rules never published, and a hash no rule set has: burn only.
    for (what, hash) in [
        ("unpublished rules", pq::rules_hash(&unpublished)),
        ("a junk rules hash", [0x5A; 32]),
    ] {
        let terms = pq::Terms::now(env).with_rules(hash);
        let msg = pq::message(env, &k, META, &terms);
        let q = pq::next_free_leaf(env, pq::identity(), &msg);
        let signed = pq::sign_with(env, pq::identity(), q, &k, META, terms);
        let used = identity_used(env);
        let sent = pq::send_attestation(env, &k, &signed, META).expect_ok(what);
        let e: PqLeafConsumed = one_event(&sent);
        assert_eq!((u32::from(e.leaf), e.launch), (q, k.launch), "{what}");
        assert!(events::<LaunchAttested>(&sent.logs).is_empty(), "{what}");
        assert_eq!(identity_used(env), used + 1, "{what}");
        let a: Attestation = env.anchor(&k.attestation);
        assert_eq!((a.version, a.launch), (0, Pubkey::default()), "{what}");
    }

    // A relayer cannot change the rules account: none for a non-zero hash,
    // another record, or a record for the zero hash all fail (the signature
    // is not landed, its leaf stays free).
    let hash = pq::rules_hash(&published);
    let terms = pq::Terms::now(env).with_rules(hash);
    let msg = pq::message(env, &k, META, &terms);
    let q = pq::next_free_leaf(env, pq::identity(), &msg);
    let signed = pq::sign_with(env, pq::identity(), q, &k, META, terms);
    let other_record = pq::rules_pda(&k.launch, &pq::rules_hash(&unpublished));
    let relayer = env.funded(1);
    let honest = pq::attest_launch_ix(
        &relayer.pubkey(),
        &k,
        signed.pk,
        signed.sig.clone(),
        META,
        &terms,
    );
    assert_eq!(honest.accounts[6].pubkey, pq::rules_pda(&k.launch, &hash));
    for (what, slot) in [
        ("no rules account", noised_launchpad::ID),
        ("another rules record", other_record),
        ("the metadata record", pq::token_meta_of(&k, META)),
    ] {
        let mut ix = honest.clone();
        ix.accounts[6].pubkey = slot;
        let f = env
            .send_v1(&relayer, &[ix], &[], pq::attest_config())
            .fails_with(CONSTRAINT_SEEDS, "ConstraintSeeds", what);
        assert!(
            f.logs
                .iter()
                .any(|l| l.contains("caused by account: rules")),
            "{what}"
        );
    }
    // A signature over the zero hash takes no rules account.
    let zero = pq::Terms::now(env);
    let zmsg = pq::message(env, &k, META, &zero);
    let zq = pq::next_free_leaf(env, pq::identity(), &zmsg);
    let zsigned = pq::sign_with(env, pq::identity(), zq, &k, META, zero);
    let mut ix = pq::attest_launch_ix(
        &relayer.pubkey(),
        &k,
        zsigned.pk,
        zsigned.sig.clone(),
        META,
        &zero,
    );
    assert_eq!(ix.accounts[6].pubkey, noised_launchpad::ID);
    ix.accounts[6].pubkey = pq::rules_pda(&k.launch, &hash);
    env.send_v1(&relayer, &[ix], &[], pq::attest_config())
        .fails_with(
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            "a rules record for the zero hash",
        );
    assert!(!pq::leaf_used(
        &pq::identity_account(env, &pq::identity_id()).unwrap(),
        q
    ));

    // The honest landing attests, with the rules hash.
    let sent = pq::send_attestation(env, &k, &signed, META).expect_ok("attest with rules");
    println!(
        "attest_launch (v3, with rules): {} CU, {} bytes",
        sent.cu, sent.size
    );
    let e: LaunchAttested = one_event(&sent);
    assert_eq!(e.rules_hash, hash);
    let a: Attestation = env.anchor(&k.attestation);
    assert_eq!((a.version, a.rules_hash, u32::from(a.leaf)), (3, hash, q));
    assert_eq!(a.message_hash, pq::sha256(&[&msg]));
    assert_eq!(msg.len(), 221);
    assert_eq!(&msg[13 + 5 * 32..13 + 6 * 32], &hash);

    // An unused window that passed is replaced by an attestation of other
    // rules (audit 3), which `launch` then installs.
    let now = env.now();
    env.set_time(a.not_after + 1);
    pq::publish_rules(env, &k, &unpublished);
    let other_hash = pq::rules_hash(&unpublished);
    pq::attest_with(env, &k, META, pq::Terms::now(env).with_rules(other_hash));
    let replaced: Attestation = env.anchor(&k.attestation);
    assert_eq!(replaced.rules_hash, other_hash);
    assert!(replaced.slot > a.slot && now < env.now());
    let c = w.creator.pubkey();
    w.env
        .send(
            &[launch_with_rules(&c, &k, META, &other_hash)],
            &[&w.creator, &w.mint],
        )
        .expect_ok("launch with the replacing attestation's rules");
    let policy: HookPolicy = w.env.anchor(&k.policy);
    assert_eq!(policy.rules, unpublished);
}

/// `launch` gives the hook policy exactly the attested rules and certifies
/// them: certificate version 4 names their hash and sets the informational
/// `RULES_BOUND` on top of the 4,095 it requires. It takes only the attested
/// record, and only with the attested bytes.
#[test]
fn launch_installs_the_attested_rules_and_certifies_them() {
    let bytes = largest_rules();
    let hash = pq::rules_hash(&bytes);
    let mut w = created_with(open);
    let k = w.k;
    pq::attest_rules(&mut w.env, &k, META, &bytes);
    let other = rules(&[], &[(0, 60, effect::DENY, 9, 0, &[TRUE])]);
    pq::publish_rules(&mut w.env, &k, &other);
    let c = w.creator.pubkey();
    let send = |w: &mut World, ix| {
        let (creator, mint) = (w.creator.insecure_clone(), w.mint.insecure_clone());
        w.env.send(&[ix], &[&creator, &mint])
    };
    // Without the rules account, or with another rules record of the launch.
    send(&mut w, launch_with_rules(&c, &k, META, &[0; 32])).fails_with(
        code(E::AttestationMismatch),
        "AttestationMismatch",
        "launch without the attested rules",
    );
    let f = send(
        &mut w,
        launch_with_rules(&c, &k, META, &pq::rules_hash(&other)),
    )
    .fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "launch with other rules",
    );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: rules")));
    // Review 4, R6a: at the attested address, a record whose bytes are not
    // the attested ones (no instruction writes one; placed here, holding
    // other rules that verify) is refused: `launch` hashes the bytes again.
    let address = pq::rules_pda(&k.launch, &hash);
    let original = w.env.account(&address).unwrap();
    let mut forged = original.clone();
    forged.data.clear();
    LaunchRules {
        bytes: other.clone(),
        ..w.env.anchor::<LaunchRules>(&address)
    }
    .try_serialize(&mut forged.data)
    .unwrap();
    w.env.svm.set_account(address, forged).unwrap();
    send(&mut w, launch_with_rules(&c, &k, META, &hash)).fails_with(
        code(E::AttestationMismatch),
        "AttestationMismatch",
        "a record at the attested address holding other bytes",
    );
    w.env.svm.set_account(address, original).unwrap();
    let sent = send(&mut w, launch_with_rules(&c, &k, META, &hash)).expect_ok("launch with rules");
    println!(
        "MEASURE launch with the largest rule set: {} CU, {} bytes (legacy; hook {} CU)",
        sent.cu,
        sent.size,
        program_cu(&sent.logs, &noised_hook::ID, None)
    );
    assert!(sent.size <= PACKET_DATA_SIZE);

    let policy_account = w.env.account(&k.policy).unwrap();
    assert_eq!(policy_account.data.len(), HookPolicy::space(bytes.len()));
    let policy: HookPolicy = w.env.anchor(&k.policy);
    assert_eq!((policy.version, &policy.rules), (2, &bytes));
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(cert.version, 4);
    assert_eq!(cert.rules_hash, hash);
    assert_eq!(cert.checks, checks::ALL | checks::RULES_BOUND);
    assert_eq!(cert.checks, 8_191);
    let a: Attestation = w.env.anchor(&k.attestation);
    assert_eq!(a.rules_hash, hash);
}

/// A rule that refuses everything for the whole guard: buys and
/// wallet-to-wallet transfers are refused (`RuleDenied`, the rule's index
/// and code logged), while the batch buy and the claim (in `ruled`), sells,
/// and everything after the guard pass.
#[test]
fn rules_never_touch_sells_claims_the_batch_or_after_the_guard() {
    let mut r = ruled(&rules(&[], &[(0, GUARD, effect::DENY, 7, 0, &[TRUE])]));
    let bob = r.buyer();
    let carol = Pubkey::new_unique();
    denied(r.buy(&bob, 1_000_000), 0, 7, "a buy");
    let alice = r.alice.insecure_clone();
    denied(
        r.send_tokens(&alice, &carol, 1_000),
        0,
        7,
        "a wallet transfer",
    );
    let held = r.balance(&alice.pubkey());
    r.sell(&alice, held / 2).expect_ok("a sell");
    assert_eq!(r.balance(&alice.pubkey()), held - held / 2);
    // The guard's last second, then its end.
    r.at(i64::from(GUARD) - 1);
    denied(
        r.buy(&bob, 1_000_000),
        0,
        7,
        "a buy in the guard's last second",
    );
    let end = r.guard_end_ts;
    r.env().set_time(end);
    r.buy(&bob, 1_000_000).expect_ok("a buy after the guard");
    r.send_tokens(&alice, &carol, 1_000)
        .expect_ok("a wallet transfer after the guard");
    assert_eq!(r.balance(&carol), 1_000);
}

/// The rules come after every built-in refusal: with the default caps and
/// lock, a buy over max-buy is still `MaxBuy` and a wallet transfer
/// `TransfersLocked` under a rule that refuses everything; a buy within the
/// caps reaches the rule.
#[test]
fn built_in_refusals_keep_their_reasons_under_rules() {
    let deny_all = rules(&[], &[(0, GUARD, effect::DENY, 7, 0, &[TRUE])]);
    let mut r = batched(launched_with_rules(|_| {}, &deny_all));
    r.claim_alice().expect_ok("the claim");
    let (bob, k) = (r.buyer(), r.k);
    r.env()
        .send(
            &[dbc_swap(&bob.pubkey(), &k, true, LAMPORTS_PER_SOL)],
            &[&bob],
        )
        .fails_with(hook_code(HookError::MaxBuy), "MaxBuy", "a buy over max-buy");
    denied(r.buy(&bob, 1_000_000), 0, 7, "a buy within the caps");
    let alice = r.alice.insecure_clone();
    r.send_tokens(&alice, &Pubkey::new_unique(), 1_000)
        .fails_with(
            hook_code(HookError::TransfersLocked),
            "TransfersLocked",
            "a wallet transfer while locked",
        );
}

/// Time windows and caps on real DBC buys and transfers: no buys in the
/// first 15 minutes, then at most 0.1% of the supply per buy, and no
/// account above 0.2% of the supply; caps absolute and in basis points.
#[test]
fn time_windows_and_caps_in_basis_points_of_the_supply() {
    let is_buy = [leaf(op::rules::IS_BUY, 0, 0)];
    let mut r = ruled(&rules(
        &[],
        &[
            (0, 900, effect::DENY, 1, 0, &is_buy),
            (900, GUARD, effect::CAP_AMOUNT, 2, BPS_FLAG | 10, &is_buy),
            (
                0,
                GUARD,
                effect::CAP_DEST_BALANCE,
                3,
                BPS_FLAG | 20,
                &[TRUE],
            ),
        ],
    ));
    let supply = r.supply();
    // floor(supply * bps / 10,000) for 10 and 20 bps.
    let (cap, held_cap) = (supply / 1_000, supply / 500);
    let bob = r.buyer();
    // The batch time (60 s after the launch), and the window's last second.
    denied(r.buy(&bob, 1_000), 0, 1, "a buy at the open");
    r.at(899);
    denied(
        r.buy(&bob, 1_000),
        0,
        1,
        "a buy in the window's last second",
    );
    r.at(900);
    denied(r.buy(&bob, cap + 1), 1, 2, "a buy over 0.1% of the supply");
    r.buy(&bob, cap).expect_ok("a buy of exactly 0.1%");
    r.buy(&bob, cap).expect_ok("a second");
    assert_eq!(r.balance(&bob.pubkey()), 2 * cap);
    let room = held_cap - 2 * cap;
    denied(r.buy(&bob, room + 1), 2, 3, "a buy past 0.2% held");
    // The balance cap applies to wallet transfers too.
    let carol = Pubkey::new_unique();
    denied(
        r.alice_sends(&carol, held_cap + 1),
        2,
        3,
        "a transfer past 0.2%",
    );
    r.alice_sends(&carol, held_cap)
        .expect_ok("a transfer to exactly 0.2%");
    // Absolute caps: a second launch.
    let mut r = ruled(&rules(
        &[],
        &[(0, GUARD, effect::CAP_AMOUNT, 4, 5_000_000, &[TRUE])],
    ));
    let bob = r.buyer();
    denied(r.buy(&bob, 5_000_001), 0, 4, "a buy over the absolute cap");
    r.buy(&bob, 5_000_000)
        .expect_ok("a buy at the absolute cap");
    let carol = Pubkey::new_unique();
    denied(r.alice_sends(&carol, 5_000_001), 0, 4, "a transfer over it");
    r.alice_sends(&carol, 5_000_000)
        .expect_ok("a transfer at it");
}

/// The top-level program and instruction count (anti-bundle), and key
/// lists: the team's wallet can neither buy nor send while the guard runs,
/// but sells.
#[test]
fn programs_instruction_counts_and_key_lists() {
    let team = Keypair::new();
    let keys = [team.pubkey(), DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    let (team_k, dbc_k, t22_k) = (1u8, 2u8, 4u8);
    let is_buy = leaf(op::rules::IS_BUY, 0, 0);
    let is_p2p = leaf(op::rules::IS_P2P, 0, 0);
    let mut r = ruled(&rules(
        &keys,
        &[
            // No buy in a transaction of more than 2 top-level instructions.
            (
                0,
                GUARD,
                effect::DENY,
                10,
                0,
                &[is_buy, leaf(op::rules::TX_IX_COUNT_GT, 0, 2), AND],
            ),
            // The team cannot buy, nor send to anyone.
            (
                0,
                GUARD,
                effect::DENY,
                11,
                0,
                &[is_buy, leaf(op::rules::DEST_OWNER_IN, team_k, 0), AND],
            ),
            (
                0,
                GUARD,
                effect::DENY,
                12,
                0,
                &[is_p2p, leaf(op::rules::SRC_OWNER_IN, team_k, 0), AND],
            ),
            // Wallet transfers only as top-level Token-2022 instructions,
            // and from 30 minutes on no direct DBC buys.
            (
                0,
                GUARD,
                effect::DENY,
                13,
                0,
                &[is_p2p, leaf(op::rules::TOP_PROGRAM_IN, t22_k, 0), NOT, AND],
            ),
            (
                1_800,
                GUARD,
                effect::DENY,
                14,
                0,
                &[is_buy, leaf(op::rules::TOP_PROGRAM_IN, dbc_k, 0), AND],
            ),
        ],
    ));
    let bob = r.buyer();
    // `env.send` adds a compute-budget instruction: [budget, swap] is 2.
    r.buy(&bob, 1_000_000)
        .expect_ok("a buy in 2 top-level instructions");
    let k = r.k;
    let padding = create_ata(
        &bob.pubkey(),
        &bob.pubkey(),
        &k.mint,
        &TOKEN_2022_PROGRAM_ID,
    );
    denied(
        r.buy_with(&bob, 1_000_000, &[padding]),
        0,
        10,
        "a buy in 3 top-level instructions",
    );
    // The team receives (its ATA created), but cannot buy or send.
    r.env().airdrop(&team.pubkey(), 2 * LAMPORTS_PER_SOL);
    let wrap = wrap_sol(&team.pubkey(), LAMPORTS_PER_SOL);
    r.env().send(&wrap, &[&team]).expect_ok("wrap");
    r.alice_sends(&team.pubkey(), 1_000_000)
        .expect_ok("the team receives");
    denied(r.buy(&team, 1_000_000), 1, 11, "the team buys");
    denied(
        r.send_tokens(&team, &bob.pubkey(), 1),
        2,
        12,
        "the team sends",
    );
    r.sell(&team, 500_000).expect_ok("the team sells");
    assert_eq!(r.balance(&team.pubkey()), 500_000);
    // Direct transfers are top-level Token-2022 instructions.
    let carol = Pubkey::new_unique();
    r.alice_sends(&carol, 7).expect_ok("a direct transfer");
    // From 30 minutes on, direct DBC buys are refused.
    r.at(1_800);
    denied(
        r.buy(&bob, 1_000_000),
        4,
        14,
        "a direct DBC buy after 30 minutes",
    );
    r.alice_sends(&carol, 7)
        .expect_ok("a direct transfer after 30 minutes");
}

/// What the hook decides for a transfer that reaches the rules (no built-in
/// caps or lock, accounts with ImmutableOwner, owners not exempt): the
/// reference evaluator on the transfer's context, written from the spec.
#[allow(clippy::too_many_arguments)]
fn reference(
    set: &RuleSet,
    r: &Ruled,
    is_buy: bool,
    amount: u64,
    dest_owner: &Pubkey,
    src_owner: &Pubkey,
    top_program: &Pubkey,
    tx_ix_count: u16,
) -> Result<(), Violation> {
    set.evaluate(&TransferCtx {
        now_rel: r.w.env.now() - r.launch_ts,
        is_buy,
        is_p2p: !is_buy,
        amount,
        dest_balance_after: r.balance(dest_owner) + amount,
        supply: r.supply(),
        dest_owner: dest_owner.to_bytes(),
        src_owner: src_owner.to_bytes(),
        top_program: top_program.to_bytes(),
        tx_ix_count,
    })
}

/// The outcome matches the reference decision.
#[track_caller]
fn matches(got: Result<Sent, Failed>, want: Result<(), Violation>, what: &str) -> bool {
    match want {
        Ok(()) => {
            got.expect_ok(what);
            true
        }
        Err(v) => {
            denied(got, v.rule, v.code, what);
            false
        }
    }
}

/// Random verified rule sets (the rules crate's generator, its keys
/// replaced by the wallets and programs of the transfers here) on real DBC
/// buys and wallet transfers at random times: every outcome is the
/// reference evaluator's, and the batch, the claim, sells and everything
/// after the guard always pass.
#[test]
fn random_rule_sets_decide_real_transfers_as_the_reference() {
    let mut rng = rules_gen::Rng::new(0x9E37_0005);
    let (mut refused, mut passed) = (0, 0);
    for round in 0..12 {
        let bob = Keypair::new();
        let carol = Keypair::new();
        let mut program = rules_gen::gen_rules(&mut rng, GUARD);
        // Keys the transfers here involve: bob, carol, DBC, Token-2022, the
        // pool authority (the source owner of a buy) and fresh ones.
        let pool: Vec<Pubkey> = vec![
            bob.pubkey(),
            carol.pubkey(),
            DBC_PROGRAM_ID,
            TOKEN_2022_PROGRAM_ID,
            DBC_POOL_AUTHORITY,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        for (i, key) in program.keys.iter_mut().enumerate() {
            *key = pool[(i + round) % pool.len()].to_bytes();
        }
        let bytes = program.encode().unwrap();
        let set_bytes = bytes.clone();
        let set = RuleSet::verify(&set_bytes, GUARD).expect("generated rule set verifies");
        let mut r = ruled(&bytes);
        let k = r.k;
        // Bob and carol: wSOL and base-token ATAs.
        for who in [&bob, &carol] {
            r.env().airdrop(&who.pubkey(), 2 * LAMPORTS_PER_SOL);
            let mut ixs = wrap_sol(&who.pubkey(), LAMPORTS_PER_SOL);
            ixs.push(create_ata(
                &who.pubkey(),
                &who.pubkey(),
                &k.mint,
                &TOKEN_2022_PROGRAM_ID,
            ));
            r.env()
                .send(&ixs, &[who])
                .expect_ok("bob's and carol's accounts");
        }
        let mut times: Vec<i64> = (0..6)
            .map(|_| 60 + rng.below(u64::from(GUARD) - 60) as i64)
            .collect();
        times.sort();
        for t in times {
            r.at(t);
            // A buy by bob or carol.
            let buyer = if rng.coin() { &bob } else { &carol };
            let tokens = 1 + rng.below(r.supply() / 500);
            let want = reference(
                &set,
                &r,
                true,
                tokens,
                &buyer.pubkey(),
                &DBC_POOL_AUTHORITY,
                &DBC_PROGRAM_ID,
                2,
            );
            let got = r.buy(buyer, tokens);
            if matches(got, want, &format!("round {round}: buy of {tokens} at {t}")) {
                passed += 1;
            } else {
                refused += 1;
            }
            // A wallet transfer from alice.
            let to = if rng.coin() { &bob } else { &carol };
            let amount = 1 + rng.below(r.supply() / 500);
            let want = reference(
                &set,
                &r,
                false,
                amount,
                &to.pubkey(),
                &r.alice.pubkey(),
                &TOKEN_2022_PROGRAM_ID,
                2,
            );
            let alice = r.alice.insecure_clone();
            let got = r.w.env.send(
                &[hooked_transfer(&k, &alice.pubkey(), &to.pubkey(), amount)],
                &[&alice],
            );
            if matches(
                got,
                want,
                &format!("round {round}: transfer of {amount} at {t}"),
            ) {
                passed += 1;
            } else {
                refused += 1;
            }
            // A sell always passes.
            let held = r.balance(&alice.pubkey());
            r.sell(&alice, held / 100).expect_ok("a sell");
        }
        // After the guard everything passes.
        let end = r.guard_end_ts;
        r.env().set_time(end);
        r.buy(&bob, 1_000).expect_ok("a buy after the guard");
        let alice = r.alice.insecure_clone();
        r.w.env
            .send(
                &[hooked_transfer(&k, &alice.pubkey(), &carol.pubkey(), 1_000)],
                &[&alice],
            )
            .expect_ok("a transfer after the guard");
    }
    println!("random rule sets: {passed} transfers passed, {refused} refused");
    assert!(passed > 20 && refused > 20, "{passed} {refused}");
}

/// The hook's compute per transfer with the largest rule set (every rule
/// active, every node evaluated, the instructions sysvar read) against the
/// same transfers without rules: the budget is 15,000 extra per transfer.
#[test]
fn compute_at_the_largest_rule_set() {
    let measure = |w: World| -> [u64; 4] {
        let mut r = batched(w);
        let hook = |s: &Sent| program_cu(&s.logs, &noised_hook::ID, None);
        let claim = r.claim_alice().expect_ok("claim");
        let bob = r.buyer();
        let buy = r.buy(&bob, 1_000_000).expect_ok("buy");
        let p2p = r.alice_sends(&bob.pubkey(), 1_000).expect_ok("transfer");
        let alice = r.alice.insecure_clone();
        let sell = r.sell(&alice, 1_000).expect_ok("sell");
        [hook(&buy), hook(&p2p), hook(&sell), hook(&claim)]
    };
    let bare = measure(launched_with(open));
    let largest = largest_rules();
    let ruled_cu = measure(launched_with_rules(open, &largest));
    let names = ["buy", "wallet transfer", "sell", "claim"];
    for i in 0..4 {
        let extra = ruled_cu[i] as i64 - bare[i] as i64;
        println!(
            "MEASURE hook CU per {}: {} without rules, {} with the largest rule set ({extra:+})",
            names[i], bare[i], ruled_cu[i]
        );
        assert!(extra <= 15_000, "{}: {extra}", names[i]);
    }
}

/// The heaviest `launch`: the largest inline uri (a 3,072-byte document,
/// a 4,125-byte uri) and the largest rule set at once. The launchpad, DBC
/// and the hook keep both within their heaps and compute.
#[test]
fn the_largest_metadata_and_rules_launch_together() {
    let rules = largest_rules();
    let name = "N".repeat(MAX_NAME_LEN);
    let symbol = "S".repeat(MAX_SYMBOL_LEN);
    let doc = format!("{{{}}}", "d".repeat(MAX_DOC_LEN - 2));
    let meta = pq::Meta {
        name: name.as_bytes(),
        symbol: symbol.as_bytes(),
        flags: META_FLAG_INLINE_URI,
        uri: b"",
        doc: doc.as_bytes(),
    };
    let mut w = created_with(open);
    let k = w.k;
    pq::publish(&mut w.env, &k, meta);
    pq::attest_rules(&mut w.env, &k, meta, &rules);
    let c = w.creator.pubkey();
    let ix = launch_with_accounts(
        &c,
        &k,
        pq::token_meta_of(&k, meta),
        pq::rules_of(&k.launch, &pq::rules_hash(&rules)),
    );
    let sent = w
        .env
        .send(&[ix], &[&w.creator, &w.mint])
        .expect_ok("the heaviest launch");
    println!(
        "MEASURE launch, the largest inline uri and the largest rule set: {} CU, {} bytes",
        sent.cu, sent.size
    );
    let policy: HookPolicy = w.env.anchor(&k.policy);
    assert_eq!(policy.rules, rules);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(cert.checks, checks::ALL | checks::RULES_BOUND);
}
