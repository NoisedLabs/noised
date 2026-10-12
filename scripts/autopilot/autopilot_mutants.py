"""Mutation check for programs/noised-autopilot (every guard).

Each mutant is applied to a scratch copy of the workspace (outside the
repository; the repository is never written) and must make a test fail:

  1. the program's host tests (`cargo test -p noised-autopilot`), then, if
     they all pass and the mutant names LiteSVM tests,
  2. the LiteSVM suites, pinned: the test binaries built from the unmutated
     sources (`--svm-bins`, from `cargo test --no-run` of
     programs/noised-autopilot/tests/litesvm: autopilot, invariants,
     review_fixes and audit4) run against an SBPF v3 build of the mutated
     program (the binaries link the program only for its instruction
     builders and account types; what they execute is the .so).

  python -I scripts/autopilot/autopilot_mutants.py [--check] [--svm-bins DIR] [label ...]

--check only verifies that every pattern matches exactly once (no cargo).
Environment: NOISED_AP_MUTANTS_DIR (scratch dir outside the repository,
default <NOISED_BUILD_ROOT>/mutants/ap, else <system temp>/noised-mutants/ap),
NOISED_ENV_SCRIPT (optional PowerShell build environment, default
<NOISED_BUILD_ROOT>/env.ps1 when set), NOISED_SBF_DIR (the unmutated
launchpad, hook and vault builds, default <NOISED_BUILD_ROOT or
repo/target>/target-sbf/deploy, the layout of scripts/test-all.ps1),
NOISED_FIXTURES_DIR. Cargo runs with CARGO_BUILD_JOBS=2.

Mutants marked EQUIVALENT are listed for the record and not run: each is a
second check of something another check (ours or DAMM v2's / Token-2022's)
already enforces, so no test can tell it apart; the reason is given.
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Machine-local locations come from the environment; nothing is hard-coded.
# NOISED_BUILD_ROOT: base for build output and scratch dirs (optional).
BUILD_ROOT = os.environ.get("NOISED_BUILD_ROOT", os.environ.get("PHALANX_BUILD_ROOT", ""))


def default_scratch(name):
    """Scratch dir outside the repository: <NOISED_BUILD_ROOT>/mutants/<name>, else the system temp dir."""
    base = os.path.join(BUILD_ROOT, "mutants") if BUILD_ROOT else os.path.join(tempfile.gettempdir(), "noised-mutants")
    return os.path.join(base, name)


WORK = os.path.abspath(os.environ.get("NOISED_AP_MUTANTS_DIR", os.environ.get("PHALANX_AP_MUTANTS_DIR", default_scratch("ap"))))
ENV_SCRIPT = os.environ.get("NOISED_ENV_SCRIPT", os.environ.get("PHALANX_ENV_SCRIPT", os.path.join(BUILD_ROOT, "env.ps1") if BUILD_ROOT else ""))
SBF_DIR = os.environ.get("NOISED_SBF_DIR", os.environ.get("PHALANX_SBF_DIR", os.path.join(BUILD_ROOT or os.path.join(REPO, "target"), "target-sbf", "deploy")))
WS = os.path.join(WORK, "ws")
PROGRAM = os.path.join(WS, "programs", "noised-autopilot")

P = "src/"
LOGIC, PRICE, LP, EXT, CONST, REF = P + "logic.rs", P + "price.rs", P + "launchpad.rs", P + "external.rs", P + "constants.rs", P + "reference.rs"
RUN, GOV, INIT, BIND, BINDP, PUB, UPD = (
    P + "instructions/run.rs",
    P + "instructions/governance.rs",
    P + "instructions/init_autopilot.rs",
    P + "instructions/bind_mint.rs",
    P + "instructions/bind_pool.rs",
    P + "instructions/publish_graph.rs",
    P + "instructions/update_price.rs",
)

# LiteSVM test name filters (tests/autopilot.rs, tests/review_fixes.rs).
E2E = "buyback_burn_and_distribute_end_to_end"
REFUSALS = "runs_refuse_when_not_due_condition_budget_or_run_limit"
EARLY = "nothing_runs_before_activation_or_graduation"
PREMIUM = "buyback_refuses_above_the_premium_until_the_reference_follows"
SANDWICH = "a_sandwich_gains_at_most_the_premium"
OPERATOR = "operator_gated_nodes_and_revocation"
GOVERN = "graph_changes_need_the_identity_and_the_timelock"
INITB = "init_bind_and_publish_rules"
WRONG = "wrong_accounts_are_refused"
DIST = "distribute_pays_only_recipients_with_an_account"
TIPS = "tips_are_capped_per_day_and_come_only_from_the_treasury"
REFCOND = "ref_price_conditions_read_the_reference_not_spot"
F1A = "f1a_a_fall_anyone_observed_bounds_every_buyback"
STALE = "f1a_a_stale_observation_expires_with_its_window"
F1B = "f1b_an_atomic_walk_moves_nothing"
F1B2 = "f1b_a_two_step_walk_is_stopped_by_one_honest_observation"
F2 = "f2_any_dbc_migration_config_binds_and_no_other_pool_does"
F3A = "f3_a_newer_activation_does_not_void_a_revocation"
F3B = "f3_authorizations_only_void_what_they_could_undo"
FIRST = "a_queued_first_graph_is_replaced_only_after_the_timelock"
F4 = "f4_a_keeper_shrinks_a_buyback_the_pool_cannot_take"
F5 = "f5_dust_burns_earn_no_tips"
POOLFMT = "a_pool_the_program_cannot_read_stops_only_buybacks"
# Audit round 4 (tests/audit4.rs).
A42 = "a4_2_a_partial_buyback_does_not_use_up_the_daily_run"
A42B = "a4_2_partial_runs_never_move_more_than_the_run"
A42C = "a4_2_a_new_graph_starts_with_no_partial_runs"
A43 = "a4_3_a_reappointed_operator_is_revoked_again"
A4S = "a4_s_the_running_graphs_activation_is_kept"
A44 = "a4_4_burns_earn_no_tips_before_graduation"
A44B = "a4_4_burns_after_graduation_are_valued_at_the_lowest_observed_price"
M4 = "m4_recipients_without_accounts_are_skipped_and_cost_keepers_nothing"
M4Z = "m4_a_share_of_nothing_is_no_skip"

# (file, original, mutant, label, LiteSVM filters or None for host only)
MUTANTS = [
    # ---- logic: graph changes and authorizations
    (LOGIC, "    require!(!frozen, AutopilotError::Frozen);\n    if *active", "    if *active", "activation ignores the freeze", None),
    (LOGIC, "require!(activate_at >= now, AutopilotError::ActivationInPast);", "require!(activate_at + 1 >= now, AutopilotError::ActivationInPast);", "first graph a second in the past", None),
    (LOGIC, "    if *active == [0; 32] && *pending == [0; 32] {", "    if *active == [0; 32] {", "queued first graph replaced at once", [FIRST]),
    (LOGIC, "        let earliest = now\n            .max(auth_unix_time)", "        let earliest = now\n            .min(auth_unix_time)", "timelock from the earlier time", None),
    (LOGIC, "        let earliest = now\n            .max(auth_unix_time)", "        let earliest = auth_unix_time\n            .max(auth_unix_time)", "timelock from the authorization only", None),
    (LOGIC, "require!(activate_at >= earliest, AutopilotError::TimelockTooShort);", "require!(activate_at + 1 >= earliest, AutopilotError::TimelockTooShort);", "timelock a second short", None),
    (LOGIC, "    (a.slot, a.key) > (b.slot, b.key)", "    (a.slot, a.key) >= (b.slot, b.key)", "authorization replay", [GOVERN]),
    (LOGIC, "    (a.slot, a.key) > (b.slot, b.key)", "    a.slot > b.slot", "same-slot authorizations unordered", None),
    (LOGIC, "        kind::GRAPH_ACTIVATE => &[kind::GRAPH_ACTIVATE, kind::OPERATOR_REVOKE],", "        kind::GRAPH_ACTIVATE => &[kind::GRAPH_ACTIVATE],", "activation predating a revocation", [F3B]),
    (LOGIC, "        kind::GRAPH_FREEZE => &[kind::GRAPH_FREEZE, kind::GRAPH_ACTIVATE],", "        kind::GRAPH_FREEZE => &[kind::GRAPH_FREEZE],", "freeze predating an activation", [F3B]),
    (LOGIC, "        kind::OPERATOR_REVOKE => &[kind::OPERATOR_REVOKE],", "        kind::OPERATOR_REVOKE => &[kind::OPERATOR_REVOKE, kind::GRAPH_ACTIVATE],", "revocation voided by a newer activation", [F3A]),
    (LOGIC, "        kind::OPERATOR_REVOKE => &[kind::OPERATOR_REVOKE],", "        kind::OPERATOR_REVOKE => &[],", "revocation replay", None),
    (LOGIC, "        kind::GRAPH_FREEZE => Ok(1),", "        kind::GRAPH_FREEZE => Ok(0),", "kinds share a mark", None),
    (LOGIC, "    require!(!frozen, AutopilotError::Frozen);\n    require!(*pending", "    require!(*pending", "apply ignores the freeze", None),
    (LOGIC, "require!(now >= activate_at, AutopilotError::UpdateNotDue);", "require!(now + 1 >= activate_at, AutopilotError::UpdateNotDue);", "apply a second early", None),
    (LOGIC, "NotDue::MaxRunsReached => AutopilotError::MaxRunsReached,", "NotDue::MaxRunsReached => AutopilotError::BudgetSpent,", "max runs error", None),
    # ---- logic: amounts and gating
    (LOGIC, "require!(amount > 0 && amount <= limit, AutopilotError::InvalidAmount);", "require!(amount <= limit, AutopilotError::InvalidAmount);", "operator amount zero", None),
    (LOGIC, "    let limit = cap.min(available);", "    let limit = cap;", "amount ignores the treasury", None),
    (LOGIC, "            let floor = keeper_floor.ok_or(AutopilotError::AmountNotAllowed)?;", "            let floor = keeper_floor.unwrap_or(0);", "keeper amounts on any node", [F4]),
    (LOGIC, "                amount >= floor.min(limit).max(1),", "                amount >= 1,", "keeper amount below the floor", [F4]),
    (LOGIC, "                amount >= floor.min(limit).max(1),", "                amount >= floor.min(limit),", "keeper amount of zero", None),
    (LOGIC, "                amount >= floor.min(limit).max(1),", "                amount >= floor.max(1),", "keeper floor above the cap", None),
    (LOGIC, "            require!(amount <= limit, AutopilotError::InvalidAmount);\n", "", "keeper amount above the cap", [F4]),
    (LOGIC, "            require!(limit > 0, AutopilotError::NothingToDo);\n            require!(amount <= limit", "            require!(amount <= limit", "keeper amount on an empty treasury", None),
    (LOGIC, "            require!(limit > 0, AutopilotError::NothingToDo);\n            Ok(limit)", "            Ok(limit)", "empty run", None),
    (LOGIC, "            input.operator != Pubkey::default(),", "            true,", "revoked operator runs", None),
    (LOGIC, "            input.operator_signer == Some(input.operator),", "            true,", "anyone runs gated nodes", None),
    (LOGIC, "    let gated = node.operator_gated == 1;", "    let gated = false;", "gating ignored", None),
    (LOGIC, "        sqrt_price: input.reference,", "        sqrt_price: input.spot.unwrap_or(input.reference),", "conditions read spot", [REFCOND]),
    (LOGIC, "        graduated: input.graduated,", "        graduated: true,", "always graduated", [EARLY]),
    (LOGIC, "            require!(input.graduated, AutopilotError::NotGraduated);\n", "", "buyback without graduation", None),
    (LOGIC, "            let spot = input.spot.ok_or(AutopilotError::InvalidPool)?;", "            let spot = input.spot.unwrap_or(0);", "buyback without the pool price", None),
    (LOGIC, "            let bound = reference::buyback_cap(input.reference, input.seen)\n                .ok_or(AutopilotError::PriceNotObserved)?;", "            let bound = input.reference;", "buyback priced from the reference alone", [F1A]),
    (LOGIC, "                price::within_premium(spot, bound, node.p2),", "                true,", "no premium check", [SANDWICH]),
    (LOGIC, "                .ok_or(AutopilotError::InvalidDammAccounts)?;", "                .unwrap_or(u64::MAX);", "buyback without the pool reserve", None),
    (LOGIC, "                .filter(|m| *m > 0)\n", "", "zero minimum out", None),
    (LOGIC, "                input.treasury_sol,\n                Some(keeper_floor(quote)),", "                input.treasury_token,\n                Some(keeper_floor(quote)),", "buyback sized by tokens", None),
    (LOGIC, "let amount = run_amount(gated, input.amount, cap, input.treasury_token, None)?;", "let amount = run_amount(gated, input.amount, cap, input.treasury_sol, None)?;", "burn sized by SOL", None),
    (LOGIC, "let amount = run_amount(gated, input.amount, cap, input.treasury_sol, None)?;", "let amount = run_amount(gated, input.amount, cap, input.treasury_sol, Some(0))?;", "keepers size distributions", None),
    (LOGIC, "            require!(total > 0, AutopilotError::NothingToDo);\n", "", "distribute nothing", None),
    (LOGIC, "    let cap = g\n        .run_cap(input.node, state, input.now)\n        .min(", "    let cap = node\n        .p1\n        .min(", "cap ignores the budget", None),
    (LOGIC, "    (u128::from(pool_quote) * u128::from(KEEPER_MIN_POOL_BPS) / u128::from(BPS_DENOMINATOR)) as u64", "    (u128::from(pool_quote) * u128::from(KEEPER_MIN_POOL_BPS) / u128::from(BPS_DENOMINATOR / 2)) as u64", "keeper floor doubled", None),
    # ---- logic: run records and tips
    (LOGIC, "    node.runs_in_epoch = epoch\n        .runs\n        .checked_add(1)", "    node.runs_in_epoch = epoch\n        .runs\n        .checked_add(0)", "runs not counted", None),
    (LOGIC, "    node.spent_in_epoch = epoch\n        .spent\n        .checked_add(spent)", "    node.spent_in_epoch = epoch\n        .spent\n        .checked_add(0)", "spend not counted", None),
    (LOGIC, "    node.last_run = now;\n", "", "last run not recorded", None),
    (LOGIC, "    node.last_seq = *seq;\n", "", "sequence not recorded", None),
    (LOGIC, "    node.epoch_start = epoch.start;\n", "", "epoch not rolled", None),
    (LOGIC, "    if start > *epoch_start {", "    if start != *epoch_start {", "tip epoch goes back", None),
    (LOGIC, "        .min(TIP_EPOCH_CAP.saturating_sub(*in_epoch))\n", "", "no daily tip cap", None),
    (LOGIC, "        .min(treasury_sol)\n        .min(share);", "        .min(share);", "tip beyond the treasury", None),
    (LOGIC, "        .min(treasury_sol)\n        .min(share);", "        .min(treasury_sol);", "tip beyond a tenth of the run", [F5]),
    (LOGIC, "    *in_epoch = in_epoch.saturating_add(tip);\n", "", "tips not counted", None),
    (LOGIC, "            Plan::Burn { amount } => price::token_value(amount, burn_price),", "            Plan::Burn { amount } => amount,", "burns valued in raw units", None),
    # ---- the reference price and the observations
    (REF, "    if spot == 0 {\n        return;\n    }\n", "", "a zero price observed", None),
    (REF, "        current.min = current.min.min(spot);", "        current.min = spot;", "an observation replaces the lowest", [F1A]),
    (REF, "        current.max = current.max.max(spot);", "        current.max = spot;", "an observation replaces the highest", None),
    (REF, "        current.max = current.max.max(spot);\n        return;", "        current.max = current.max.max(spot);\n        current.first_at = now;\n        return;", "the span restarts with each observation", None),
    (REF, "    if !current.is_empty() && index <= current.index {", "    if !current.is_empty() && index == current.index {", "a clock stepping back starts a bucket", None),
    (REF, "    *previous = if !current.is_empty() && current.index.checked_add(1) == Some(index) {\n        *current", "    *previous = if !current.is_empty() && current.index.checked_add(1) == Some(index) {\n        ObsBucket::default()", "the previous bucket forgotten", None),
    (REF, "current.index.checked_add(1) == Some(index)", "current.index.checked_add(1) <= Some(index)", "a bucket kept across a gap", None),
    (REF, "    let oldest_counted = bucket_of(now).saturating_sub(1);\n    let mut window", "    let oldest_counted = bucket_of(now);\n    let mut window", "the window is one bucket", None),
    (REF, "    let oldest_counted = bucket_of(now).saturating_sub(1);\n    let mut window", "    let oldest_counted = bucket_of(now).saturating_sub(2);\n    let mut window", "the window is three buckets", [STALE]),
    (REF, "                    min: s.min.min(b.min),", "                    min: s.min,", "the window's lowest from one bucket", None),
    (REF, "                    max: s.max.max(b.max),", "                    max: s.max,", "the window's highest from one bucket", None),
    (REF, "                first.min(b.first_at),", "                first.max(b.first_at),", "the span from the later bucket", None),
    (REF, "    (now.saturating_sub(first) >= OBS_MIN_SPAN_SECS).then_some(s)", "    Some(s)", "a window of one transaction", [E2E]),
    (REF, "    (now.saturating_sub(first) >= OBS_MIN_SPAN_SECS).then_some(s)", "    (now.saturating_sub(first) >= OBS_MIN_SPAN_SECS - 1).then_some(s)", "a span a second short", None),
    (REF, "    seen.map(|s| reference.min(s.min))", "    seen.map(|_| reference)", "the bound ignores the observations", [F1A]),
    (REF, "    seen.map(|s| reference.min(s.min))", "    seen.map(|s| s.min)", "the bound ignores the reference", None),
    (REF, "    if now <= p.allowance_at {\n        return;\n    }\n", "", "the allowance accrues backwards", None),
    (REF, "        .min(REF_ALLOWANCE_MAX);", ";", "the allowance uncapped", None),
    (REF, "    p.allowance_at = now;\n}", "}", "the allowance accrues twice", None),
    (REF, "        p.allowance = p.allowance.saturating_sub(cost);\n", "", "a rise spends nothing", None),
    (REF, "        let new = s.min.min(r.saturating_add(step / REF_ALLOWANCE_SCALE));", "        let new = s.min;", "a rise without limit", [PREMIUM]),
    (REF, "    } else if s.max < r {", "    } else if s.min < r {", "a fall without every observation", None),
    (REF, "        s.max\n    } else {", "        s.min\n    } else {", "a fall to the lowest", None),
    (REF, "        let cost = u64::try_from(cost.div_ceil(r)).unwrap_or(u64::MAX);", "        let cost = u64::try_from(cost / r).unwrap_or(u64::MAX);", "a rise's cost rounded down", None),
    # ---- price math
    (PRICE, "    lhs <= rhs\n", "    lhs < rhs\n", "premium boundary", None),
    (PRICE, "        / (u128::from(BPS_DENOMINATOR) + u128::from(premium_bps));", "        / u128::from(BPS_DENOMINATOR);", "premium ignored in min out", None),
    (PRICE, "    let at_reference = (u128::from(amount_in) << 64) / reference;", "    let at_reference = (u128::from(amount_in) << 63) / reference;", "min out halved", None),
    (PRICE, "    let high = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);", "    let high = p11 + (p01 >> 64) + (p10 >> 64);", "mul_wide carry", None),
    (PRICE, "    if high >> 64 != 0 {", "    if high >> 65 != 0 {", "price range", None),
    (PRICE, "    if reference == 0 {\n        return None;\n    }\n", "", "zero reference price", None),
    (PRICE, "    let Some(price) = price_q64(sqrt_price) else {\n        return 0;\n    };", "    let Some(price) = price_q64(sqrt_price) else {\n        return u64::MAX;\n    };", "an out of range price values tokens", None),
    (PRICE, "    u64::try_from((high << 64) | (low >> 64)).unwrap_or(u64::MAX)", "    u64::try_from((high << 64) | (low >> 63)).unwrap_or(u64::MAX)", "token value doubled", None),
    # ---- constants
    (CONST, "pub const UPDATE_TIMELOCK_SECS: i64 = 259_200;", "pub const UPDATE_TIMELOCK_SECS: i64 = 259_199;", "timelock constant", None),
    (CONST, "pub const TIP_EPOCH_CAP: u64 = 5_000_000;", "pub const TIP_EPOCH_CAP: u64 = 5_100_000;", "tip cap constant", None),
    (CONST, "pub const TIP_MAX_SHARE_BPS: u64 = 1_000;", "pub const TIP_MAX_SHARE_BPS: u64 = 1_100;", "tip share constant", None),
    (CONST, "pub const OBS_BUCKET_SECS: i64 = 900;", "pub const OBS_BUCKET_SECS: i64 = 1_800;", "bucket length", None),
    (CONST, "pub const OBS_MIN_SPAN_SECS: i64 = 60;", "pub const OBS_MIN_SPAN_SECS: i64 = 59;", "span constant", None),
    (CONST, "pub const REF_UP_SQRT_BPS_PER_HOUR: u64 = 243;", "pub const REF_UP_SQRT_BPS_PER_HOUR: u64 = 246;", "rise rate", None),
    (CONST, "pub const KEEPER_MIN_POOL_BPS: u64 = 100;", "pub const KEEPER_MIN_POOL_BPS: u64 = 99;", "keeper floor constant", None),
    # ---- launchpad layouts
    (LP, "    require_keys_eq!(*owner, LAUNCHPAD_PROGRAM_ID, AutopilotError::NotALaunch);\n", "", "launch of any owner", None),
    (LP, "        (launch::MIN_VERSION..=launch::MAX_VERSION).contains(&version),", "        version <= launch::MAX_VERSION,", "launch version", None),
    (LP, "        (launch::MIN_VERSION..=launch::MAX_VERSION).contains(&version),", "        version >= launch::MIN_VERSION,", "launch version above the known ones (review 4, R6b)", None),
    (LP, "    pub const MAX_VERSION: u8 = 2;\n", "    pub const MAX_VERSION: u8 = 3;\n", "launch version 3 read as 2", None),
    (LP, "        data.len() >= launch::MIN_LEN", "        data.len() >= launch::MIN_LEN - 1", "launch length", None),
    (LP, "        live: read_u8(data, launch::STATUS_OFFSET)? == launch::STATUS_LIVE,", "        live: read_u8(data, launch::STATUS_OFFSET)? != 0xFF,", "always live", None),
    (LP, "    pub const PQ_IDENTITY_OFFSET: usize = 553;", "    pub const PQ_IDENTITY_OFFSET: usize = 552;", "launch identity offset", None),
    (LP, "    require_keys_eq!(\n        *owner,\n        LAUNCHPAD_PROGRAM_ID,\n        AutopilotError::InvalidCertificate\n    );\n", "", "certificate of any owner", None),
    (LP, "        (certificate::MIN_VERSION..=certificate::MAX_VERSION).contains(&version),", "        version >= certificate::MIN_VERSION,", "certificate version", None),
    (LP, "launch_key.to_bytes()\n            && bytes32(data, certificate::BASE_MINT_OFFSET)? == mint.to_bytes(),", "launch_key.to_bytes(),", "certificate of another mint", None),
    (LP, "        bytes32(data, certificate::LAUNCH_OFFSET)? == launch_key.to_bytes()\n", "        true\n", "certificate of another launch", None),
    (LP, "        checks & certificate::CHECKS_ALL == certificate::CHECKS_ALL,", "        checks != 0,", "certificate checks", None),
    (LP, "    require_keys_eq!(\n        *owner,\n        LAUNCHPAD_PROGRAM_ID,\n        AutopilotError::InvalidAuthorization\n    );\n", "", "authorization of any owner", [GOVERN]),
    (LP, "a::DISCRIMINATOR\n            && data[a::VERSION_OFFSET] == a::VERSION,", "a::DISCRIMINATOR,", "authorization version", None),
    (LP, "        data.len() == a::LEN\n", "        data.len() >= a::LEN\n", "authorization length", None),
    (LP, "    require_keys_eq!(*key, expected, AutopilotError::InvalidAuthorization);\n", "", "authorization at any address", [GOVERN, OPERATOR]),
    (LP, "        bytes32(data, a::LAUNCH_OFFSET)? == launch_key.to_bytes()\n", "        true\n", "authorization for another launch", None),
    (LP, "            && bytes32(data, a::PQ_IDENTITY_OFFSET)? == *pq_identity\n", "", "authorization by any identity", [GOVERN]),
    (LP, "            && read_u8(data, a::KIND_OFFSET)? == kind\n", "", "authorization of any kind", None),
    (LP, "            && bytes32(data, a::PAYLOAD_HASH_OFFSET)? == *payload_hash\n", "", "authorization of any payload", None),
    (LP, "*payload_hash\n            && read_u32(data, a::SIG_LEN_OFFSET)? as usize == a::SIG_LEN,", "*payload_hash,", "authorization without a signature", None),
    (LP, "        &activate_at.to_le_bytes(),", "        &activate_at.to_be_bytes(),", "activation payload encoding", None),
    (LP, "        authorization::FREEZE_DOMAIN,\n        autopilot.as_ref(),", "        authorization::ACTIVATE_DOMAIN,\n        autopilot.as_ref(),", "freeze payload domain", None),
    (LP, "    pub const FREEZE_DOMAIN: &[u8; 16] = b\"PHX-GRAPH-FRZ-V2\";", "    pub const FREEZE_DOMAIN: &[u8; 16] = b\"PHX-GRAPH-FRZ-V1\";", "freeze payload version 1 domain (review 4, R5)", None),
    (LP, "        graph_hash,\n        &not_after.to_le_bytes(),\n", "        graph_hash,\n", "freeze payload without its not_after", [GOVERN]),
    (LP, "        &not_after.to_le_bytes(),\n", "        &not_after.to_be_bytes(),\n", "freeze payload not_after encoding", None),
    (LP, "        authorization::REVOKE_DOMAIN,\n        autopilot.as_ref(),\n        graph_hash,\n", "        authorization::REVOKE_DOMAIN,\n        autopilot.as_ref(),\n", "revocation names no graph", [OPERATOR]),
    # ---- Meteora layouts
    (EXT, "    require_keys_eq!(*owner, DBC_PROGRAM_ID, AutopilotError::InvalidDbcConfig);\n", "", "config of any owner", None),
    (EXT, "        bytes32(data, dbc_config::QUOTE_MINT_OFFSET)? == WSOL_MINT.to_bytes(),", "        true,", "config of another quote", None),
    (EXT, "    require!(price > 0, AutopilotError::InvalidDbcConfig);\n", "", "zero migration price", None),
    (EXT, "    require_keys_eq!(\n        *owner,\n        DAMM_V2_PROGRAM_ID,\n        AutopilotError::InvalidDammConfig\n    );\n", "", "a DAMM config of any owner", None),
    (EXT, "        data.len() == damm_config::LEN && data[..8] == damm_config::DISCRIMINATOR,", "        data.len() >= damm_config::LEN && data[..8] == damm_config::DISCRIMINATOR,", "a DAMM config of any size", None),
    (EXT, "        data.len() == damm_config::LEN && data[..8] == damm_config::DISCRIMINATOR,", "        data.len() == damm_config::LEN,", "a DAMM config of any kind", None),
    (EXT, "        bytes32(data, damm_config::POOL_CREATOR_AUTHORITY_OFFSET)? == DBC_POOL_AUTHORITY.to_bytes(),", "        true,", "a DAMM config of any pool creator", [F2]),
    (EXT, "    let (hi, lo) = if *mint > WSOL_MINT {", "    let (hi, lo) = if *mint < WSOL_MINT {", "pool seed order", [E2E]),
    (EXT, "        require!(data.is_empty(), AutopilotError::InvalidPool);\n", "", "non-DAMM pool data", None),
    (EXT, "mint.to_bytes()\n            && bytes32(data, damm_pool::TOKEN_B_MINT_OFFSET)? == WSOL_MINT.to_bytes(),", "mint.to_bytes(),", "pool of another quote", None),
    (EXT, "    pub const SQRT_PRICE_OFFSET: usize = 456;", "    pub const SQRT_PRICE_OFFSET: usize = 440;", "pool price offset", None),
    # ---- run
    (RUN, "        ap.pending_graph == [0; 32] || now < ap.pending_activate_at,", "        true,", "runs after an update is due", [GOVERN]),
    (RUN, "        *pool_authority.key == DAMM_V2_POOL_AUTHORITY\n            && ", "        ", "any pool authority", [WRONG]),
    (RUN, "            && *vault_a.key == pool.token_a_vault\n", "\n", "any vault A", [WRONG]),
    (RUN, "            && *vault_b.key == pool.token_b_vault\n", "\n", "any vault B", [WRONG]),
    (RUN, "            && *event_authority.key == DAMM_V2_EVENT_AUTHORITY\n", "\n", "any event authority", [WRONG]),
    (RUN, "            && *program.key == DAMM_V2_PROGRAM_ID\n", "\n", "any swap program", [WRONG]),
    (RUN, "        rest.len() == BUYBACK_ACCOUNTS,", "        rest.len() >= BUYBACK_ACCOUNTS,", "extra DAMM accounts", [WRONG]),
    (RUN, "    token_amount(vault_b)\n", "    token_amount(vault_a)\n", "the keeper floor from the token vault", [F4]),
    (RUN, "            input: &a.treasury_wsol.to_account_info(),\n            output: &a.treasury_token.to_account_info(),", "            input: &a.treasury_token.to_account_info(),\n            output: &a.treasury_wsol.to_account_info(),", "the treasury sells", [E2E]),
    (RUN, "        bought,\n        a.mint.decimals,", "        bought / 2,\n        a.mint.decimals,", "half the purchase burned", [E2E]),
    (RUN, "            *ata.key == expected && ata.is_writable,", "            ata.is_writable,", "any recipient account", [WRONG]),
    (RUN, "            *ata.key == expected && ata.is_writable,", "            *ata.key == expected,", "read-only recipient account", [WRONG]),
    (RUN, "        rest.len() == graph.recipient_count(),", "        rest.len() <= graph.recipient_count(),", "missing recipient accounts", [WRONG]),
    (RUN, "        let share = shares.get(i).copied().unwrap_or(0);", "        let share = shares.first().copied().unwrap_or(0);", "every recipient gets the first share", [E2E]),
    (RUN, "            require!(\n                ctx.remaining_accounts.is_empty(),\n                AutopilotError::UnexpectedAccounts\n            );\n", "", "accounts on a burn", [WRONG]),
    (RUN, "    logic::record_run(\n        slot,\n        open,\n        &mut ap.seq,\n        gnode.epoch_secs,\n        now,\n        plan.spent(),\n        plan.partial(),\n    )?;", "    let _ = (slot, open);", "run not recorded", [E2E]),
    (RUN, "    ap.set_price_state(&price);\n", "", "a run's observation not kept", [E2E]),
    (RUN, "    if let Some(p) = pool {\n        reference::observe(", "    if let Some(p) = pool.filter(|_| false) {\n        reference::observe(", "runs observe nothing", [E2E]),
    (RUN, "        if is_buyback {\n            Some(read?", "        if true {\n            Some(read?", "every action needs a readable pool", [POOLFMT]),
    (RUN, "    let graduated = ap.damm_pool != Pubkey::default();", "    let graduated = ap.damm_pool != Pubkey::default() && ctx.accounts.damm_pool.is_some();", "a missing pool reads as not graduated", [WRONG]),
    (RUN, "            &a.tip_account.to_account_info(),", "            &a.treasury_wsol.to_account_info(),", "tip kept", [E2E]),
    (RUN, "        now,\n        treasury_sol,\n        plan.value(burn_price, kept),", "        now,\n        u64::MAX,\n        plan.value(burn_price, kept),", "tip beyond what the action left", [DIST]),
    (RUN, "        plan.value(burn_price, kept),", "        u64::MAX,", "tip regardless of what the run moved", [F5]),
    (RUN, "        constraint = autopilot.active_graph != [0; 32] @ AutopilotError::NoActiveGraph,\n", "", "run without a graph", [EARLY]),
    (RUN, "    #[account(address = autopilot.damm_pool @ AutopilotError::InvalidPool)]\n    pub damm_pool: Option<UncheckedAccount<'info>>,", "    pub damm_pool: Option<UncheckedAccount<'info>>,", "run with any pool", [WRONG]),
    # ---- governance
    (GOV, "    autopilot.auth_marks[logic::mark_index(kind)?] = mark;\n", "", "used authorization not recorded", [GOVERN]),
    (GOV, "    logic::check_activation(\n        &ap.active_graph,\n        &ap.pending_graph,\n        ap.frozen,\n        now,\n        activate_at,\n        auth.unix_time,\n    )?;\n", "    let _ = (now, auth);\n", "activation without the rules", [GOVERN]),
    (GOV, "    ap.pending_operator = operator;\n    emit!(GraphQueued", "    emit!(GraphQueued", "queued graph without its operator", [OPERATOR]),
    (GOV, "    ap.nodes = [NodeRecord::default(); MAX_NODES];\n", "", "node states kept across graphs", [GOVERN]),
    (GOV, "    ap.operator = operator;\n    ap.nodes", "    ap.nodes", "operator not taken from the queued graph", [OPERATOR]),
    (GOV, "    ap.active_graph = ap.pending_graph;\n", "", "applied graph not activated", [GOVERN]),
    (GOV, "    require!(!ap.frozen, AutopilotError::Frozen);\n    require!(ap.active_graph", "    require!(ap.active_graph", "freeze twice", [GOVERN]),
    (GOV, "    require!(ap.active_graph != [0; 32], AutopilotError::NoActiveGraph);\n", "", "freeze without a graph", [GOVERN]),
    (GOV, "    ap.frozen = true;\n", "", "freeze does not freeze", [GOVERN]),
    (GOV, "    ap.frozen = true;\n    ap.pending_graph = [0; 32];\n", "    ap.frozen = true;\n", "freeze keeps the update", [GOVERN]),
    (GOV, "    ap.pending_activate_at = 0;\n    ap.pending_operator = Pubkey::default();\n    emit!(GraphFrozen", "    ap.pending_activate_at = 0;\n    emit!(GraphFrozen", "freeze keeps the queued operator", [F3B]),
    (GOV, "    require!(operator != Pubkey::default(), AutopilotError::NoOperator);\n", "", "revoke without an operator", [OPERATOR]),
    (GOV, "    ap.operator = Pubkey::default();\n    let pending_cleared", "    let pending_cleared", "revoke does not revoke", [OPERATOR]),
    (GOV, "    if pending_cleared {\n        ap.pending_operator = Pubkey::default();\n    }\n", "", "the queued graph keeps a revoked operator", [F3B]),
    (GOV, "launchpad::revoke_payload(&autopilot_key, &ap.active_graph, &operator, &ap.active_auth)", "launchpad::revoke_payload(&autopilot_key, &[0; 32], &operator, &ap.active_auth)", "revocation of another graph", [OPERATOR]),
    (GOV, "        kind::GRAPH_FREEZE,", "        kind::GRAPH_ACTIVATE,", "freeze with an activation", [GOVERN]),
    (GOV, "    logic::check_freeze_window(now, not_after)?;\n", "", "freeze after its not_after (review 4, R5)", [GOVERN]),
    (GOV, "launchpad::freeze_payload(&autopilot_key, &ap.active_graph, not_after)", "launchpad::freeze_payload(&autopilot_key, &ap.active_graph, now)", "freeze payload with the clock as not_after", [GOVERN, F3B]),
    (LOGIC, "    require!(now <= not_after, AutopilotError::FreezeExpired);", "    require!(now < not_after, AutopilotError::FreezeExpired);", "freeze window ends a second early", [GOVERN]),
    (LOGIC, "    require!(now <= not_after, AutopilotError::FreezeExpired);", "    require!(now <= not_after.saturating_add(1), AutopilotError::FreezeExpired);", "freeze window ends a second late", [GOVERN]),
    # ---- audit 4, A4-2: a keeper's partial buyback leaves the run open
    (LOGIC, "        .min(node.p1.saturating_sub(input.partial_spent));", ";", "cap ignores the partial runs (audit 4, A4-2)", [A42B]),
    (LOGIC, "                partial: !gated && input.amount.is_some() && amount_in < cap,", "                partial: false,", "partial buybacks are runs (audit 4, A4-2)", [A42]),
    (LOGIC, "                partial: !gated && input.amount.is_some() && amount_in < cap,", "                partial: input.amount.is_some() && amount_in < cap,", "operator amounts are partial (audit 4, A4-2)", None),
    (LOGIC, "                partial: !gated && input.amount.is_some() && amount_in < cap,", "                partial: !gated && input.amount.is_some(),", "a keeper's whole amount is partial (audit 4, A4-2)", None),
    (LOGIC, "                partial: !gated && input.amount.is_some() && amount_in < cap,", "                partial: !gated && amount_in < cap,", "a short treasury makes a partial run (audit 4, A4-2)", None),
    (LOGIC, "            require!(\n                amount == cap || cap - amount >= floor,\n                AutopilotError::RemainderTooSmall\n            );\n", "", "a partial run leaves any remainder (audit 4, A4-2)", [A42]),
    (LOGIC, "                amount == cap || cap - amount >= floor,", "                amount == cap || cap - amount + 1 >= floor,", "a remainder a lamport short (audit 4, A4-2)", None),
    (LOGIC, "    if partial {\n        node.runs_in_epoch = epoch.runs;", "    if false {\n        node.runs_in_epoch = epoch.runs;", "a partial run recorded as a run (audit 4, A4-2)", [A42]),
    (LOGIC, "        node.runs_in_epoch = epoch.runs;\n", "        node.runs_in_epoch = epoch.runs.saturating_add(1);\n", "a partial run counted (audit 4, A4-2)", None),
    (LOGIC, "        *partial_spent = partial_spent\n            .checked_add(spent)", "        *partial_spent = partial_spent\n            .checked_add(0)", "a partial run's spend not kept (audit 4, A4-2)", [A42B]),
    (LOGIC, "    node.last_seq = *seq;\n    *partial_spent = 0;\n", "    node.last_seq = *seq;\n", "a run keeps its partial parts (audit 4, A4-2)", [A42]),
    (LOGIC, "                (u128::from(TIP_LAMPORTS) * u128::from(amount_in) / u128::from(p1.max(1))) as u64", "                TIP_LAMPORTS", "a partial run's full tip (audit 4, A4-2)", [A42]),
    (LOGIC, "        .min(max_tip)\n", "", "a tip ignores its limit (audit 4, A4-2)", [A42]),
    (RUN, "    let partial_spent = ap.partial_spent.get(index).copied().unwrap_or(0);", "    let partial_spent = 0;", "the partial runs not read (audit 4, A4-2)", [A42B]),
    (RUN, "        plan.spent(),\n        plan.partial(),\n    )?;", "        plan.spent(),\n        false,\n    )?;", "a partial run recorded as a run, on-chain (audit 4, A4-2)", [A42]),
    (RUN, "        plan.max_tip(gnode.p1),", "        TIP_LAMPORTS,", "a partial run's full tip, on-chain (audit 4, A4-2)", [A42]),
    (RUN, "        partial: plan.partial(),", "        partial: false,", "a partial run reported as a run (audit 4, A4-2)", [A42]),
    (GOV, "    ap.partial_spent = [0; MAX_NODES];\n", "", "partial runs kept across graphs (audit 4, A4-2)", [A42C]),
    # ---- audit 4, A4-3 and A4-S: a revocation names the activation it revokes
    (LP, "        operator.as_ref(),\n        active_auth.as_ref(),\n", "        operator.as_ref(),\n", "revocation names no activation (audit 4, A4-3)", [A43]),
    (LP, "    pub const REVOKE_DOMAIN: &[u8; 16] = b\"PHX-OP-REVOKE-V3\";", "    pub const REVOKE_DOMAIN: &[u8; 16] = b\"PHX-OP-REVOKE-V2\";", "revocation payload version 2 domain (audit 4, A4-3)", None),
    (GOV, "&operator, &ap.active_auth)", "&operator, &Pubkey::default())", "revocation of any activation (audit 4, A4-3)", [A43]),
    (GOV, "    ap.active_auth = ap.auth_marks[logic::mark_index(kind::GRAPH_ACTIVATE)?].key;\n", "", "the activation not kept (audit 4, A4-S)", [A43, A4S]),
    (GOV, "    ap.active_auth = ap.auth_marks[logic::mark_index(kind::GRAPH_ACTIVATE)?].key;", "    ap.active_auth = ap.auth_marks[logic::mark_index(kind::GRAPH_FREEZE)?].key;", "the freeze kept as the activation (audit 4, A4-S)", [A43, A4S]),
    (GOV, "    ap.active_activate_at = ap.pending_activate_at;\n", "", "the activation's time not kept (audit 4, A4-S)", [A4S]),
    # ---- audit 4, A4-4: burns earn no tip before graduation, then at the lowest price
    (LOGIC, "    if !graduated {\n        return 0;\n    }\n    lowest", "    lowest", "burns valued before graduation (audit 4, A4-4)", [A44]),
    (LOGIC, "    lowest.map_or(reference, |l| reference.min(l))", "    lowest.map_or(reference, |_| reference)", "burns valued at the reference (audit 4, A4-4)", [A44B]),
    (LOGIC, "    lowest.map_or(reference, |l| reference.min(l))", "    lowest.unwrap_or(reference)", "burns valued at the lowest price only (audit 4, A4-4)", None),
    (RUN, "    let burn_price = logic::burn_price(\n        graduated,", "    let burn_price = logic::burn_price(\n        true,", "burns valued as graduated, on-chain (audit 4, A4-4)", [A44]),
    (RUN, "        reference::lowest(&price.observations, now),", "        None,", "burns valued without the observations (audit 4, A4-4)", [A44B]),
    (REF, "    let oldest_counted = bucket_of(now).saturating_sub(1);\n    observations", "    let oldest_counted = bucket_of(now);\n    observations", "the lowest price from one bucket (audit 4, A4-4)", None),
    (REF, "    let oldest_counted = bucket_of(now).saturating_sub(1);\n    observations", "    let oldest_counted = bucket_of(now).saturating_sub(2);\n    observations", "the lowest price from three buckets (audit 4, A4-4)", None),
    (REF, "        .filter(|b| !b.is_empty() && b.index >= oldest_counted)", "        .filter(|b| b.index >= oldest_counted)", "the lowest price of an empty bucket (audit 4, A4-4)", None),
    (REF, "        .map(|b| b.min)\n        .min()", "        .map(|b| b.max)\n        .min()", "the lowest price from the highest (audit 4, A4-4)", None),
    # ---- audit 4, M4: a recipient without a wSOL account is skipped
    (RUN, "        if !is_wsol_account_of(ata, &owner) {", "        if false {", "recipients are never skipped (audit 4, M4)", [M4]),
    (RUN, "            skipped |= 1 << i;\n", "", "skipped recipients not listed (audit 4, M4)", [M4]),
    (RUN, "            kept = kept\n                .checked_add(share)", "            kept = kept\n                .checked_add(0)", "skipped shares not counted (audit 4, M4)", [M4]),
    (RUN, "        if share == 0 {\n            continue;\n        }\n", "", "a zero share is skipped (audit 4, M4)", [M4Z]),
    (RUN, "    require!(paid > 0, AutopilotError::NoRecipientAccount);\n", "", "a run that pays nobody (audit 4, M4)", [DIST]),
    (RUN, "        paid = paid\n            .checked_add(share)", "        paid = paid\n            .checked_add(0)", "payments not counted (audit 4, M4)", [E2E]),
    (RUN, "        plan.value(burn_price, kept),", "        plan.value(burn_price, 0),", "tips of the skipped shares (audit 4, M4)", [M4]),
    (RUN, "        && state.base.owner == *owner\n", "\n", "skip check of any owner (audit 4, M4)", [M4]),
    (LOGIC, "            Plan::Distribute { total, .. } => total.saturating_sub(kept),", "            Plan::Distribute { total, .. } => total,", "a distribution valued with its kept shares (audit 4, M4)", None),
    # ---- init, bind, publish, update_price
    (INIT, "    require_keys_eq!(\n        dbc_config.key(),\n        launch.dbc_config,\n        AutopilotError::InvalidDbcConfig\n    );\n", "", "another launch's config", [INITB]),
    (INIT, "    ap.ref_sqrt_price = ref_sqrt_price;\n", "", "reference not seeded", [E2E]),
    (BIND, "    require!(launch.live, AutopilotError::LaunchNotLive);\n", "", "bind before live", [INITB]),
    (BIND, "    ap.mint = mint;\n", "", "mint not bound", [E2E]),
    (BINDP, "    external::check_migration_config(config.owner, &config.try_borrow_data()?)?;\n", "", "bind a pool of any config", [F2]),
    (BINDP, "    require_keys_eq!(\n        pool.key(),\n        external::pool_address(&config.key(), &mint),\n        AutopilotError::InvalidPool\n    );\n", "", "bind any pool address", [F2]),
    (BINDP, "    external::read_pool(pool.owner, &pool.try_borrow_data()?, &mint)?\n        .ok_or(AutopilotError::NotGraduated)?;", "    external::read_pool(pool.owner, &pool.try_borrow_data()?, &mint)?;", "bind a pool that does not exist", [EARLY]),
    (BINDP, "        constraint = autopilot.damm_pool == Pubkey::default() @ AutopilotError::PoolAlreadyBound,\n", "", "bind the pool twice", [INITB]),
    (BINDP, "        constraint = autopilot.mint != Pubkey::default() @ AutopilotError::MintNotBound,\n", "", "bind a pool before the mint", [INITB]),
    (BINDP, "    ap.damm_pool = damm_pool;\n", "", "pool not bound", [E2E]),
    (PUB, "    if let Err(e) = Graph::verify(&bytes) {", "    if let Err(e) = Graph::parse(&bytes) {", "graphs published unverified", [INITB]),
    (PUB, "    launchpad::read_launch(&ctx.accounts.launch)?;\n    if let Err", "    if let Err", "graphs under any account", [INITB]),
    (PUB, "    if record.version != 0 {\n        return Ok(());\n    }\n", "", "publish rewrites", [INITB]),
    (UPD, "        constraint = autopilot.damm_pool != Pubkey::default() @ AutopilotError::NotGraduated,\n", "", "price update before graduation", [EARLY]),
    (UPD, "    #[account(address = autopilot.damm_pool @ AutopilotError::InvalidPool)]\n", "", "price from any pool", [F2]),
    (UPD, "    reference::observe(&mut price.observations, now, spot);\n", "", "update_price observes nothing", [E2E]),
    (UPD, "    ap.set_price_state(&price);\n", "", "update_price keeps nothing", [E2E]),
]

# Equivalent mutants (not run): (file, original, mutant, label, reason).
EQUIVALENT = [
    (RUN, "        token::mint = wsol_mint,\n", "", "tip account of any mint",
     "the tip is a transfer_checked of wSOL: SPL Token refuses any other account, and with no tip nothing is sent to it"),
    (RUN, "            && program.executable,", "", "swap program not executable",
     "the key is DAMM v2's program id, which is executable; a non-executable account cannot have it"),
    (RUN, "sol_before.checked_sub(sol_after) == Some(amount_in) && bought >= min_out,", "true,", "swap result unchecked",
     "DAMM v2's exact-in swap takes exactly amount_in and refuses less than minimum_amount_out itself; ours is a second check"),
    (RUN, "        token_amount(&a.treasury_token.to_account_info())? == tokens_before,", "        true,", "burn result unchecked",
     "Token-2022 burns exactly `bought`, which the swap added: the balance is tokens_before by construction"),
    (BIND, "    require_keys_eq!(mint, launch.base_mint, AutopilotError::InvalidCertificate);\n", "", "bind another mint",
     "the certificate at [\"certificate\", mint] must name this launch, and a launch has one mint: check_certificate already refuses"),
    (BIND, "    launchpad::check_certificate(", "    let _ = (", "bind without the certificate",
     "a live launch's base mint always has its certificate (written by the same `launch`): with the live and mint checks, the read is defense in depth"),
    (RUN, "        constraint = autopilot.mint != Pubkey::default() @ AutopilotError::MintNotBound,\n", "", "run before bind (constraint)",
     "`mint`'s address constraint (address = autopilot.mint, the default) refuses with the same error"),
    (REF, "    let target = if s.min > r {", "    let target = if s.max > r {", "a rise without every observation",
     "the rise goes toward the window's lowest price and stops at once if that is no rise: with an observation at or below the reference nothing moves either way"),
    (RUN, "        if is_buyback {\n            Some(read?", "        if false {\n            Some(read?", "a buyback reads the pool leniently",
     "a buyback whose pool cannot be read has no spot price, which `plan_run` refuses with the same InvalidPool"),
    (RUN, "    if *info.owner != token::ID {\n        return false;\n    }\n", "", "a recipient account of any program (audit 4, M4)",
     "the canonical ATA address is a PDA of the ATA program, which only ever assigns it to the token program of its seeds; any other account there is a system account without data, which does not unpack"),
    (RUN, "    state.base.mint == WSOL_MINT\n        && ", "    ", "a recipient account of any mint (audit 4, M4)",
     "the ATA program initializes the account at the canonical address with the mint of its seeds (wSOL), and a token account's mint never changes"),
    (RUN, "\n        && state.base.state == spl_token_2022::state::AccountState::Initialized", "", "a frozen recipient account (audit 4, M4)",
     "wSOL has no freeze authority, so no wSOL account is ever frozen, and an account that unpacks is initialized"),
]

def sync():
    if WORK.lower().startswith(REPO.lower()):
        raise SystemExit("NOISED_AP_MUTANTS_DIR must be outside the repository")
    if os.path.exists(WS):
        shutil.rmtree(WS)
    os.makedirs(WS)
    for f in ("Cargo.toml", "Cargo.lock"):
        shutil.copy(os.path.join(REPO, f), WS)
    # The launchpad (a dev-dependency: layout pins) needs the IDLs.
    for d in ("crates", "programs", "idls"):
        shutil.copytree(
            os.path.join(REPO, d),
            os.path.join(WS, d),
            copy_function=shutil.copy,
            ignore=shutil.ignore_patterns("target", "litesvm"),
        )


def ps(cmd, timeout=3600):
    full = (
        f"if ('{ENV_SCRIPT}' -and (Test-Path '{ENV_SCRIPT}')) {{ . '{ENV_SCRIPT}' }}; $env:CARGO_BUILD_JOBS='2'; $env:CARGO_NET_OFFLINE='true'; "
        + cmd
    )
    p = subprocess.run(["powershell", "-NoProfile", "-Command", full], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def host_tests():
    return ps(
        f"$env:CARGO_TARGET_DIR='{WORK}\\target-host'; Set-Location '{WS}'; "
        "cargo test --no-fail-fast -p noised-autopilot --lib 2>&1 | Out-String; exit $LASTEXITCODE"
    )


def sbf_build():
    return ps(
        f"$env:CARGO_TARGET_DIR='{WORK}\\target-sbf'; Set-Location '{WS}'; "
        "cargo-build-sbf --manifest-path programs/noised-autopilot/Cargo.toml --arch v3 2>&1 | Out-String; exit $LASTEXITCODE"
    )


def svm_tests(bins, filters):
    deploy = os.path.join(WORK, "deploy")
    os.makedirs(deploy, exist_ok=True)
    for name in ("noised_launchpad", "noised_hook", "noised_vault"):
        shutil.copy(os.path.join(SBF_DIR, name + ".so"), deploy)
    shutil.copy(os.path.join(WORK, "target-sbf", "deploy", "noised_autopilot.so"), deploy)
    out = ""
    for exe in bins:
        for f in filters:
            env = dict(os.environ, NOISED_SBF_DIR=deploy)
            p = subprocess.run([exe, f, "--exact", "--test-threads=1"], capture_output=True, text=True, env=env, timeout=3600)
            out += p.stdout + p.stderr
            if "running 1 test" in p.stdout and p.returncode != 0:
                return 1, out
    return 0, out


def check_patterns():
    bad = []
    labels = set()
    for path, old, new, label, *_ in MUTANTS + EQUIVALENT:
        if label in labels:
            bad.append(f"duplicate label '{label}'")
        labels.add(label)
        src = open(os.path.join(REPO, "programs", "noised-autopilot", path.replace("/", os.sep)), encoding="utf-8").read()
        if src.count(old) != 1:
            bad.append(f"'{label}': pattern matches {src.count(old)} times")
    for b in bad:
        print(b)
    print(f"{len(MUTANTS)} mutants (+{len(EQUIVALENT)} equivalent), {len(bad)} problem(s)")
    return not bad


def main():
    args = sys.argv[1:]
    if "--check" in args:
        raise SystemExit(0 if check_patterns() else 1)
    bins = []
    if "--svm-bins" in args:
        i = args.index("--svm-bins")
        bins_dir = args[i + 1]
        del args[i : i + 2]
        bins = sorted(
            p for p in glob.glob(os.path.join(bins_dir, "*.exe"))
            if os.path.basename(p).startswith(("autopilot-", "invariants-", "review_fixes-", "audit4-"))
        )
        if not bins:
            raise SystemExit(f"no LiteSVM test binaries in {bins_dir}")
    if not check_patterns():
        raise SystemExit("fix the patterns first")
    only = set(args)
    sync()
    code, out = host_tests()
    if code != 0:
        print(out[-4000:])
        raise SystemExit("baseline fails")
    if bins:
        # The pinned LiteSVM binaries must pass against the unmutated build,
        # or a broken environment would count as kills.
        code, out = sbf_build()
        if code != 0:
            raise SystemExit(f"baseline SBF build fails\n{out[-3000:]}")
        filters = sorted({f for *_, svm in MUTANTS if svm for f in svm})
        code, out = svm_tests(bins, filters)
        ran = out.count("test result: ok. 1 passed")
        if code != 0 or ran != len(filters):
            print(out[-4000:])
            raise SystemExit(f"LiteSVM baseline fails ({ran} of {len(filters)} tests passed)")
    print("baseline passes", flush=True)
    survivors, killed = [], 0
    for path, old, new, label, svm in MUTANTS:
        if only and label not in only:
            continue
        full = os.path.join(PROGRAM, path.replace("/", os.sep))
        src = open(full, encoding="utf-8").read()
        open(full, "w", encoding="utf-8", newline="\n").write(src.replace(old, new))
        try:
            code, out = host_tests()
            how = None
            if code != 0:
                if "could not compile" in out:
                    # A mutant must compile: anything else is a broken mutant.
                    errors = [l.strip() for l in out.splitlines() if l.strip().startswith("error")]
                    raise SystemExit(f"mutant '{label}' does not compile: {errors[:3]}")
                else:
                    failed = [l.split()[1] for l in out.splitlines() if l.strip().startswith("test ") and l.strip().endswith("FAILED")]
                    how = f"host: {len(failed)} failing, e.g. {', '.join(failed[:3])}"
            elif svm and bins:
                code, out = sbf_build()
                if code != 0:
                    raise SystemExit(f"mutant '{label}': SBF build failed\n{out[-3000:]}")
                code, out = svm_tests(bins, svm)
                if code != 0:
                    failed = [l for l in out.splitlines() if "panicked at" in l or "FAILED" in l]
                    how = f"LiteSVM: {failed[0].strip() if failed else 'failed'}"
            if how:
                killed += 1
                print(f"killed    {label}  ({how})", flush=True)
            else:
                survivors.append(label)
                print(f"SURVIVED  {label}", flush=True)
        finally:
            open(full, "w", encoding="utf-8", newline="\n").write(src)
    for _, _, _, label, why in EQUIVALENT:
        print(f"equivalent {label}: {why}")
    print(f"killed {killed} of {killed + len(survivors)}")
    print(f"{len(survivors)} survivor(s) {survivors}")
    if survivors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
