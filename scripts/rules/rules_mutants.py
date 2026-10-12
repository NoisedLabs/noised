"""Mutation check for crates/noised-rules (verifiers, evaluators, due-ness).

Each mutant is applied to a scratch copy of the crate (outside the repository)
and must make `cargo test -p noised-rules` fail; every mutant must be killed.
The repository is never written.

  python -I scripts/rules/rules_mutants.py [--check] [label ...]

--check only verifies that every pattern matches exactly once (no cargo).
Environment: NOISED_RULES_MUTANTS_DIR (scratch dir outside the repository,
default <NOISED_BUILD_ROOT>/mutants/rules, else
<system temp>/noised-mutants/rules) and NOISED_ENV_SCRIPT (optional
PowerShell build environment dot-sourced before cargo, default
<NOISED_BUILD_ROOT>/env.ps1 when set). Windows PowerShell runs cargo with
CARGO_BUILD_JOBS=2. If a pattern no longer matches exactly once,
the script stops: update the mutant instead of dropping it.

Not mutated (equivalent by construction, see the notes at the end of the
list): the `take(...).ok_or(BadLength)` fallbacks after the exact-length
check, the reader's zero fallback for fixed records, and after_acyclic's step
bound (any bound >= n - 1 finds every cycle; removing it would hang).
"""
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


WORK = os.path.abspath(os.environ.get("NOISED_RULES_MUTANTS_DIR", os.environ.get("PHALANX_RULES_MUTANTS_DIR", default_scratch("rules"))))
ENV_SCRIPT = os.environ.get("NOISED_ENV_SCRIPT", os.environ.get("PHALANX_ENV_SCRIPT", os.path.join(BUILD_ROOT, "env.ps1") if BUILD_ROOT else ""))
WS = os.path.join(WORK, "ws")
CRATE = os.path.join(WS, "noised-rules")

L, V, R, G = "src/lib.rs", "src/vm.rs", "src/rules.rs", "src/graph.rs"

# (file, original, mutant, label)
MUTANTS = [
    # ---- shared helpers (lib.rs)
    (L, "    value > threshold(arg, supply)", "    value >= threshold(arg, supply)", "exceeds strict"),
    (L, "    if arg & BPS_FLAG == 0 {\n        return arg;", "    if arg & (BPS_FLAG >> 1) == 0 {\n        return arg;", "threshold flag bit"),
    (L, "    let q = supply.checked_div(BPS_DENOMINATOR).unwrap_or(0);", "    let q = supply.checked_div(BPS_DENOMINATOR + 1).unwrap_or(0);", "threshold quotient"),
    (L, "    let r = supply.checked_rem(BPS_DENOMINATOR).unwrap_or(0);", "    let r: u64 = 0;", "threshold remainder"),
    (L, "        .checked_div(BPS_DENOMINATOR)\n        .unwrap_or(0);\n    q.saturating_mul", "        .checked_div(BPS_DENOMINATOR + 1)\n        .unwrap_or(0);\n    q.saturating_mul", "threshold low part"),
    (L, "    q.saturating_mul(bps).saturating_add(low)", "    q.saturating_mul(bps)", "threshold sum"),
    # Saturation is only reachable with unverified bps above 10,000; the SDK
    # mirrors it and tests/differential.rs pins it (thresholds, CAP rules).
    (L, "    q.saturating_mul(bps).saturating_add(low)", "    q.wrapping_mul(bps).wrapping_add(low)", "threshold saturates"),
    (L, "if arg & !(BPS_FLAG | BPS_MASK) != 0 || bps == 0", "if bps == 0", "bps stray bits"),
    (L, "|| bps == 0 || bps > BPS_DENOMINATOR", "|| bps > BPS_DENOMINATOR", "bps zero"),
    (L, "|| bps > BPS_DENOMINATOR {", "|| bps > BPS_DENOMINATOR + 1 {", "bps max"),
    (L, "        Ok(n) => n < arg,", "        Ok(n) => n <= arg,", "time_lt strict"),
    (L, "        Err(_) => true,", "        Err(_) => false,", "time_lt negative clock"),
    # ---- VM verification
    (V, "depth = depth.checked_sub(pops).ok_or(Error::StackUnderflow)?;", "depth = depth.saturating_sub(pops);", "verify underflow"),
    (V, "        if depth >= MAX_STACK {\n            return Err(Error::StackOverflow);", "        if depth > MAX_STACK {\n            return Err(Error::StackOverflow);", "verify overflow bound"),
    (V, "    if depth == 1 {\n        Ok(())", "    if depth >= 1 {\n        Ok(())", "verify leftover values"),
    (V, "    if node.a != 0 || node.arg != 0 {\n        return Err(Error::NonZeroOperand);", "    if node.arg != 0 {\n        return Err(Error::NonZeroOperand);", "combinator a operand"),
    (V, "    if node.a != 0 || node.arg != 0 {\n        return Err(Error::NonZeroOperand);", "    if node.a != 0 {\n        return Err(Error::NonZeroOperand);", "combinator arg operand"),
    (V, "                require_no_operands(&node)?;\n                2", "                require_no_operands(&node)?;\n                1", "verify AND/OR pops"),
    (V, "            op::NOT => {\n                require_no_operands(&node)?;\n                1", "            op::NOT => {\n                require_no_operands(&node)?;\n                0", "verify NOT pops"),
    (V, "            op::TRUE | op::FALSE => {\n                require_no_operands(&node)?;", "            op::TRUE | op::FALSE => {", "constants operands"),
    # ---- VM evaluation
    (V, "                    x & y\n", "                    x | y\n", "eval AND"),
    (V, "                    x | y\n", "                    x ^ y\n", "eval OR"),
    (V, "                x ^ 1\n", "                x\n", "eval NOT"),
    (V, "let y = (stack >> 1) & 1;", "let y = stack & 1;", "eval second operand"),
    (V, "                stack >>= 2;", "                stack >>= 1;", "eval binary pop"),
    (V, "                stack >>= 1;\n                x ^ 1", "                x ^ 1", "eval NOT pop"),
    (V, "depth = depth.checked_sub(2)?;", "depth = depth.saturating_sub(2);", "eval binary underflow"),
    (V, "depth = depth.checked_sub(1)?;", "depth = depth.saturating_sub(1);", "eval NOT underflow"),
    (V, "        if depth >= MAX_STACK {\n            return None;", "        if depth > MAX_STACK {\n            return None;", "eval overflow bound"),
    (V, "    if depth == 1 {\n        Some(stack & 1 == 1)", "    if depth >= 1 {\n        Some(stack & 1 == 1)", "eval leftover values"),
    (V, "            op::TRUE => 1,\n            op::FALSE => 0,", "            op::TRUE => 1,\n            op::FALSE => 1,", "eval FALSE"),
    (V, "        arg: u64::from_le_bytes([b0, b1, b2, b3, b4, b5, b6, b7]),", "        arg: u64::from_be_bytes([b0, b1, b2, b3, b4, b5, b6, b7]),", "node arg endianness"),
    # ---- PXR1 layout
    (R, "        if [m0, m1, m2, m3] != MAGIC {", "        if [m0, m1, m2, 0x31] != MAGIC {", "rules magic"),
    (R, "        if version != VERSION {", "        if version > VERSION {", "rules version"),
    (R, "        if [r0, r1, r2, r3] != [0; 4] {", "        if [r0, r1, r2, 0] != [0; 4] {", "rules reserved"),
    (R, "        if n_keys > MAX_KEYS {", "        if n_keys > MAX_KEYS + 1 {", "max keys"),
    (R, "        if n_rules == 0 {", "        if false {", "no rules"),
    (R, "        if n_rules > MAX_RULES {", "        if n_rules > MAX_RULES + 1 {", "max rules"),
    (R, "        if n_nodes > MAX_NODES {", "        if n_nodes > MAX_NODES + 1 {", "max nodes"),
    (R, "        if bytes.len() != encoded_len(n_keys, n_rules, n_nodes) {", "        if bytes.len() < encoded_len(n_keys, n_rules, n_nodes) {", "rules exact length"),
    (R, "            cond_off: r.u8(),\n            cond_len: r.u8(),", "            cond_len: r.u8(),\n            cond_off: r.u8(),", "rule field order"),
    # ---- PXR1 verification
    (R, "            if *key == [0; KEY_LEN] {", "            if false {", "zero key"),
    (R, "            if set.keys.iter().take(i).any(|k| k == key) {", "            if set.keys.iter().take(0).any(|k| k == key) {", "duplicate key"),
    (R, "        let guard = guard_secs.min(MAX_GUARD_SECS);", "        let guard = guard_secs;", "72-hour cap"),
    (R, "            if rule.from_rel >= rule.to_rel {", "            if rule.from_rel > rule.to_rel {", "empty window"),
    (R, "            if rule.to_rel > guard {", "            if rule.to_rel > guard.saturating_add(1) {", "window past guard"),
    (R, "            if rule.code > MAX_CODE {", "            if rule.code > MAX_CODE + 1 {", "code bound"),
    (R, "                    if rule.arg != 0 {\n                        return Err(Error::DenyArgNonZero);", "                    if false {\n                        return Err(Error::DenyArgNonZero);", "deny argument"),
    (R, "                        check_bps_arg(rule.arg)?;", "", "cap bps check"),
    (R, "                    } else if rule.arg == 0 {", "                    } else if false {", "zero cap"),
    (R, "                _ => return Err(Error::UnknownEffect),", "                _ => {}", "unknown effect"),
    (R, "            if rule.cond_len == 0 {\n                return Err(Error::EmptyCondition);", "            if false {\n                return Err(Error::EmptyCondition);", "empty condition"),
    (R, "            if usize::from(rule.cond_off) != next {", "            if false {", "rules contiguity"),
    (R, "            let end = next.saturating_add(usize::from(rule.cond_len));", "            let end = next.saturating_add(usize::from(rule.cond_len)).min(set.nodes.len());", "rules condition range"),
    (R, "            vm::verify(cond, &mut leaves)?;\n            next = end;", "            vm::verify(cond, &mut leaves)?;", "rules next offset"),
    (R, "            vm::verify(cond, &mut leaves)?;", "            let _ = vm::verify(cond, &mut leaves);", "rules condition verified"),
    (R, "        if next != set.nodes.len() {", "        if false {", "unreferenced node"),
    (R, "        if leaves.used_keys != all_keys {", "        if false {", "unused key"),
    (R, "    for _ in 0..n.min(usize::from(MAX_KEYS)) {", "    for _ in 1..n.min(usize::from(MAX_KEYS)) {", "all-keys mask"),
    (R, "        if key == who {", "        if key != who {", "owner match"),
    (R, "        if node.a == 0 || node.a & !self.all_keys != 0 {", "        if node.a & !self.all_keys != 0 {", "empty key mask"),
    (R, "        if node.a == 0 || node.a & !self.all_keys != 0 {", "        if node.a == 0 {", "key mask range"),
    (R, "        self.used_keys |= node.a;", "", "used keys"),
    (R, "    fn key_mask(&mut self, node: &Node) -> Result<(), Error> {\n        if node.arg != 0 {", "    fn key_mask(&mut self, node: &Node) -> Result<(), Error> {\n        if false {", "key mask arg"),
    (R, "            op::rules::IS_BUY | op::rules::IS_P2P => {\n                if node.a != 0 || node.arg != 0 {", "            op::rules::IS_BUY | op::rules::IS_P2P => {\n                if false {", "flag leaf operands"),
    (R, "            op::rules::TIME_LT | op::rules::TIME_GE => {\n                if node.a != 0 {", "            op::rules::TIME_LT | op::rules::TIME_GE => {\n                if false {", "time leaf a"),
    (R, "                if node.arg > u64::from(self.guard) {", "                if node.arg > u64::from(self.guard) + 1 {", "time leaf bound"),
    (R, "            op::rules::AMOUNT_GT | op::rules::DEST_BAL_AFTER_GT => {\n                if node.a != 0 {", "            op::rules::AMOUNT_GT | op::rules::DEST_BAL_AFTER_GT => {\n                if false {", "amount leaf a"),
    (R, "                    check_bps_arg(node.arg)?;", "", "leaf bps check"),
    (R, "            op::rules::TX_IX_COUNT_GT => {\n                if node.a != 0 {", "            op::rules::TX_IX_COUNT_GT => {\n                if false {", "ix leaf a"),
    (R, "            _ => return Err(Error::UnknownOp),", "            _ => {}", "rules unknown op"),
    # ---- PXR1 evaluation
    (R, "            if !rule.active_at(ctx.now_rel) {", "            if false {", "window check"),
    (R, "        i64::from(self.from_rel) <= now_rel && now_rel < i64::from(self.to_rel)", "        i64::from(self.from_rel) < now_rel && now_rel < i64::from(self.to_rel)", "window start inclusive"),
    (R, "        i64::from(self.from_rel) <= now_rel && now_rel < i64::from(self.to_rel)", "        i64::from(self.from_rel) <= now_rel && now_rel <= i64::from(self.to_rel)", "window end exclusive"),
    (R, "                effect::DENY => true,", "                effect::DENY => false,", "deny effect"),
    (R, "                effect::CAP_AMOUNT => exceeds(ctx.amount, rule.arg, ctx.supply),", "                effect::CAP_AMOUNT => exceeds(ctx.dest_balance_after, rule.arg, ctx.supply),", "cap amount field"),
    (R, "                effect::CAP_DEST_BALANCE => exceeds(ctx.dest_balance_after, rule.arg, ctx.supply),", "                effect::CAP_DEST_BALANCE => exceeds(ctx.amount, rule.arg, ctx.supply),", "cap balance field"),
    (R, "                _ => return Err(malformed),", "                _ => false,", "unknown effect fails closed"),
    (R, "            if !would_reject {\n                continue;\n            }", "", "cap compared first"),
    (R, "            match vm::eval(cond, eval) {", "            match vm::eval(cond, eval).map(|b| !b) {", "condition polarity"),
    (R, "            match vm::eval(cond, eval) {", "            match vm::eval(cond, eval).map(|_| true) {", "condition ignored"),
    (R, "                Some(false) => {}\n                None => return Err(malformed),", "                Some(false) | None => {}", "malformed condition fails closed"),
    (R, "                        code: rule.code,", "                        code: rule.code ^ 1,", "violation code"),
    (R, "            op::rules::IS_BUY => c.is_buy,", "            op::rules::IS_BUY => c.is_p2p,", "IS_BUY"),
    (R, "            op::rules::IS_P2P => c.is_p2p,", "            op::rules::IS_P2P => c.is_buy,", "IS_P2P"),
    (R, "            op::rules::TIME_LT => time_lt(c.now_rel, node.arg),", "            op::rules::TIME_LT => !time_lt(c.now_rel, node.arg),", "TIME_LT"),
    (R, "            op::rules::TIME_GE => !time_lt(c.now_rel, node.arg),", "            op::rules::TIME_GE => time_lt(c.now_rel, node.arg),", "TIME_GE"),
    (R, "            op::rules::AMOUNT_GT => exceeds(c.amount, node.arg, c.supply),", "            op::rules::AMOUNT_GT => exceeds(c.dest_balance_after, node.arg, c.supply),", "AMOUNT_GT"),
    (R, "            op::rules::DEST_BAL_AFTER_GT => exceeds(c.dest_balance_after, node.arg, c.supply),", "            op::rules::DEST_BAL_AFTER_GT => exceeds(c.amount, node.arg, c.supply),", "DEST_BAL_AFTER_GT"),
    (R, "            op::rules::DEST_OWNER_IN => self.dest & node.a != 0,", "            op::rules::DEST_OWNER_IN => self.src & node.a != 0,", "DEST_OWNER_IN"),
    (R, "            op::rules::SRC_OWNER_IN => self.src & node.a != 0,", "            op::rules::SRC_OWNER_IN => self.dest & node.a != 0,", "SRC_OWNER_IN"),
    (R, "            op::rules::TOP_PROGRAM_IN => self.top & node.a != 0,", "            op::rules::TOP_PROGRAM_IN => self.dest & node.a != 0,", "TOP_PROGRAM_IN"),
    (R, "            top: mask_of(keys, &ctx.top_program),", "            top: mask_of(keys, &ctx.src_owner),", "top program mask"),
    (R, "            op::rules::TX_IX_COUNT_GT => u64::from(c.tx_ix_count) > node.arg,", "            op::rules::TX_IX_COUNT_GT => u64::from(c.tx_ix_count) >= node.arg,", "TX_IX_COUNT_GT"),
    (R, "    H::hashv(&[HASH_DOMAIN, bytes])", "    H::hashv(&[bytes])", "rules hash domain"),
    (R, 'pub const HASH_DOMAIN: &[u8; 12] = b"PHX-RULES-V1";', 'pub const HASH_DOMAIN: &[u8; 12] = b"PHX-RULES-V2";', "rules domain string"),
    # ---- PXG1 layout
    (G, "        if [m0, m1, m2, m3] != MAGIC {", "        if [m0, m1, m2, 0x31] != MAGIC {", "graph magic"),
    (G, "        if version != VERSION {", "        if version > VERSION {", "graph version"),
    (G, "        if flags & !FLAG_HAS_OPERATOR != 0 {", "        if false {", "unknown flags"),
    (G, "        if [r0, r1, r2] != [0; 3] {", "        if [r0, r1, 0] != [0; 3] {", "graph reserved"),
    (G, "        if n_recipients > MAX_RECIPIENTS {", "        if n_recipients > MAX_RECIPIENTS + 1 {", "max recipients"),
    (G, "        if n_nodes == 0 {", "        if false {", "no graph nodes"),
    (G, "        if n_nodes > MAX_GRAPH_NODES {", "        if n_nodes > MAX_GRAPH_NODES + 1 {", "max graph nodes"),
    (G, "        if n_cond > MAX_COND_NODES {", "        if n_cond > MAX_COND_NODES + 1 {", "max condition nodes"),
    (G, "        if bytes.len() != encoded_len(n_recipients, n_nodes, n_cond) {", "        if bytes.len() < encoded_len(n_recipients, n_nodes, n_cond) {", "graph exact length"),
    (G, "            p1: r.u64(),\n            p2: r.u64(),", "            p2: r.u64(),\n            p1: r.u64(),", "gnode field order"),
    # ---- PXG1 verification
    (G, "        if has_operator && zero_operator {", "        if false {", "missing operator"),
    (G, "        if !has_operator && !zero_operator {", "        if false {", "unexpected operator"),
    (G, "            if r.key == [0; 32] {", "            if false {", "zero recipient"),
    (G, "                .take(i)\n                .any(|o| Recipient::from_bytes(o).key == r.key)", "                .take(0)\n                .any(|o| Recipient::from_bytes(o).key == r.key)", "duplicate recipient"),
    (G, "            if r.bps == 0 {", "            if false {", "zero recipient bps"),
    (G, "            bps_sum = bps_sum.saturating_add(u32::from(r.bps));", "            bps_sum = u32::from(u16::try_from(bps_sum).unwrap_or(0).wrapping_add(r.bps));", "bps sum width"),
    (G, "        if !g.recipients.is_empty() && u64::from(bps_sum) != BPS_DENOMINATOR {", "        if false {", "bps sum"),
    (G, "            if node.reserved != [0; 5] {", "            if false {", "node reserved"),
    (G, "                    if node.trigger_arg < MIN_EVERY_SECS {", "                    if node.trigger_arg < MIN_EVERY_SECS - 1 {", "every bound"),
    (G, "                    Ok(p) if p < n => {", "                    Ok(p) if p <= n => {", "after range"),
    (G, "                        if p == i {", "                        if false {", "after itself"),
    (G, "                    if node.trigger_arg != 0 {\n                        return Err(Error::TriggerArgNonZero);", "                    if false {\n                        return Err(Error::TriggerArgNonZero);", "trigger arg zero"),
    (G, "                    if node.trigger == trigger::WHEN && node.cond_len == 0 {", "                    if false {", "when needs a condition"),
    (G, "                _ => return Err(Error::UnknownTrigger),", "                _ => {}", "unknown trigger"),
    (G, "                    return Err(Error::ReservedAction)", "                    {}", "reserved action"),
    (G, "                _ => return Err(Error::UnknownAction),", "                _ => {}", "unknown action"),
    (G, "            if node.p1 == 0 {", "            if false {", "zero p1"),
    (G, "                if node.p2 > MAX_PREMIUM_BPS {", "                if node.p2 > MAX_PREMIUM_BPS + 1 {", "premium bound"),
    (G, "            } else if node.p2 != 0 {", "            } else if false {", "p2 unused"),
    (G, "                if g.recipients.is_empty() {\n                    return Err(Error::NoRecipients);", "                if false {\n                    return Err(Error::NoRecipients);", "distribute needs recipients"),
    (G, "                any_distribute = true;", "", "distribute uses recipients"),
    (G, "                    if !has_operator {\n                        return Err(Error::GatedWithoutOperator);", "                    if false {\n                        return Err(Error::GatedWithoutOperator);", "gated needs operator"),
    (G, "                    any_gated = true;", "", "gated uses operator"),
    (G, "                _ => return Err(Error::BadOperatorGated),", "                _ => {}", "operator_gated values"),
    (G, "            if node.epoch_secs < MIN_EPOCH_SECS {", "            if node.epoch_secs < MIN_EPOCH_SECS - 1 {", "epoch bound"),
    (G, "            if node.budget_per_epoch == 0 {", "            if false {", "zero budget"),
    (G, "            if node.max_runs_per_epoch == 0 {", "            if false {", "zero max runs"),
    (G, "                if node.cond_off != 0 {", "                if false {", "empty condition offset"),
    (G, "                if usize::from(node.cond_off) != next {", "                if false {", "graph contiguity"),
    (G, "                let end = next.saturating_add(usize::from(node.cond_len));\n                let cond = g.cond", "                let end = next.saturating_add(usize::from(node.cond_len)).min(g.cond.len());\n                let cond = g.cond", "graph condition range"),
    (G, "                vm::verify(cond, &mut leaves)?;\n                next = end;", "                vm::verify(cond, &mut leaves)?;", "graph next offset"),
    (G, "                vm::verify(cond, &mut leaves)?;", "                let _ = vm::verify(cond, &mut leaves);", "graph condition verified"),
    (G, "        if next != g.cond.len() {", "        if false {", "graph unreferenced node"),
    (G, "        if !after_acyclic(n, |i| g.node(i).and_then(|node| node.after_parent())) {", "        if false {", "acyclic check"),
    (G, "        if has_operator && !any_gated {", "        if false {", "operator unused"),
    (G, "        if !g.recipients.is_empty() && !any_distribute {", "        if false {", "recipients unused"),
    (G, "            if p >= n || steps >= n {", "            if p > n || steps >= n {", "acyclic range"),
    (G, "            node = p;", "            node = start;", "acyclic follow"),
    (G, "            | op::graph::PRICE_GTE => {\n                if node.a != 0 {", "            | op::graph::PRICE_GTE => {\n                if false {", "value leaf a"),
    (G, "            op::graph::GRADUATED => {\n                if node.a != 0 || node.arg != 0 {", "            op::graph::GRADUATED => {\n                if node.a != 0 {", "graduated arg"),
    (G, "            op::graph::TIME_GE | op::graph::TIME_LT => {\n                if node.a != 0 {", "            op::graph::TIME_GE | op::graph::TIME_LT => {\n                if false {", "graph time a"),
    (G, "                if i64::try_from(node.arg).is_err() {", "                if false {", "graph time bound"),
    (G, "                if usize::from(node.a) >= self.n_nodes {", "                if usize::from(node.a) > self.n_nodes {", "runs node ref"),
    (G, "            _ => return Err(Error::UnknownOp),", "            _ => {}", "graph unknown op"),
    # ---- PXG1 evaluation and scheduling
    (G, "            op::graph::TREASURY_SOL_GTE => c.treasury_sol >= node.arg,", "            op::graph::TREASURY_SOL_GTE => c.treasury_sol > node.arg,", "TREASURY_SOL_GTE"),
    (G, "            op::graph::TREASURY_TOKEN_GTE => c.treasury_token >= node.arg,", "            op::graph::TREASURY_TOKEN_GTE => c.treasury_sol >= node.arg,", "TREASURY_TOKEN_GTE"),
    (G, "            op::graph::GRADUATED => c.graduated,", "            op::graph::GRADUATED => !c.graduated,", "GRADUATED"),
    (G, "            op::graph::PRICE_LTE => c.sqrt_price <= u128::from(node.arg),", "            op::graph::PRICE_LTE => c.sqrt_price < u128::from(node.arg),", "PRICE_LTE"),
    (G, "            op::graph::PRICE_GTE => c.sqrt_price >= u128::from(node.arg),", "            op::graph::PRICE_GTE => c.sqrt_price > u128::from(node.arg),", "PRICE_GTE"),
    (G, "            op::graph::TIME_GE => !time_lt(c.now, node.arg),", "            op::graph::TIME_GE => time_lt(c.now, node.arg),", "graph TIME_GE"),
    (G, "            op::graph::TIME_LT => time_lt(c.now, node.arg),", "            op::graph::TIME_LT => !time_lt(c.now, node.arg),", "graph TIME_LT"),
    (G, "                u64::from(*c.runs_in_epoch.get(usize::from(node.a))?) < node.arg", "                u64::from(*c.runs_in_epoch.get(usize::from(node.a))?) <= node.arg", "RUNS_IN_EPOCH_LT"),
    (G, "                u64::from(*c.runs_in_epoch.get(usize::from(node.a))?) < node.arg", "                u64::from(*c.runs_in_epoch.first()?) < node.arg", "RUNS_IN_EPOCH_LT node"),
    (G, "        if node.cond_len == 0 {\n            return Some(true);", "        if node.cond_len == 0 {\n            return Some(false);", "no condition holds"),
    (G, "    if now < state.epoch_start {\n        return stored;", "    if false {\n        return stored;", "epoch clock before start"),
    (G, "    if elapsed < len {", "    if elapsed <= len {", "epoch length"),
    (G, "        start: now.saturating_sub(into),", "        start: now,", "epoch alignment"),
    (G, "        runs: 0,\n        spent: 0,", "        runs: state.runs_in_epoch,\n        spent: 0,", "epoch resets runs"),
    (G, "        runs: 0,\n        spent: 0,", "        runs: 0,\n        spent: state.spent_in_epoch,", "epoch resets spent"),
    (G, "                if i128::from(now) < due_at {", "                if i128::from(now) <= due_at {", "every due"),
    (G, "                if parent.last_seq <= state.last_seq {", "                if parent.last_seq < state.last_seq {", "after due"),
    (G, "                if state.last_seq != 0 {\n                    return Err(NotDue::AlreadyRan);", "                if false {\n                    return Err(NotDue::AlreadyRan);", "on-graduated once"),
    (G, "                if !graduated {\n                    return Err(NotDue::NotGraduated);", "                if false {\n                    return Err(NotDue::NotGraduated);", "on-graduated after graduation"),
    (G, "            _ => return Err(NotDue::Malformed),", "            _ => {}", "unknown trigger not due"),
    (G, "        if epoch.runs >= node.max_runs_per_epoch {", "        if epoch.runs > node.max_runs_per_epoch {", "run limit"),
    (G, "        if epoch.spent >= node.budget_per_epoch {", "        if epoch.spent > node.budget_per_epoch {", "budget limit"),
    (G, "            Some(false) => Err(NotDue::ConditionFalse),", "            Some(false) => Ok(()),", "runnable condition"),
    (G, "            .saturating_sub(epoch.spent)\n            .min(node.p1)", "            .saturating_sub(epoch.spent)", "run cap p1"),
    (G, "            .saturating_sub(epoch.spent)\n            .min(node.p1)", "            .min(node.p1)", "run cap budget"),
    (G, "            *slot = current_epoch(GNode::from_bytes(raw).epoch_secs, state, now).runs;", "            *slot = state.runs_in_epoch;", "runs rolled over"),
    (G, "                .checked_div(u128::from(BPS_DENOMINATOR))", "                .checked_div(u128::from(BPS_DENOMINATOR - 1))", "shares denominator"),
    # Only unverified recipients (bps above 10,000) overflow: pinned by
    # tests/differential.rs (shares of parse-only graphs) and mirrored by the SDK.
    (G, "            *slot = u64::try_from(share).unwrap_or(0);", "            *slot = u64::try_from(share).unwrap_or(u64::MAX);", "shares overflow pays nothing"),
    (G, "        if self.flags & FLAG_HAS_OPERATOR != 0 {\n            Some(self.operator)", "        if true {\n            Some(self.operator)", "operator accessor"),
    (G, "    H::hashv(&[HASH_DOMAIN, bytes])", "    H::hashv(&[bytes])", "graph hash domain"),
]


def sync():
    if WORK.lower().startswith(REPO.lower()):
        raise SystemExit("NOISED_RULES_MUTANTS_DIR must be outside the repository")
    if os.path.exists(WS):
        shutil.rmtree(WS)
    os.makedirs(WS)
    shutil.copy(os.path.join(REPO, "Cargo.lock"), WS)
    with open(os.path.join(WS, "Cargo.toml"), "w", newline="\n") as f:
        f.write(
            '[workspace]\nmembers = ["noised-rules"]\nresolver = "2"\n\n'
            '[workspace.package]\nedition = "2021"\nlicense = "Apache-2.0"\n\n'
            "[workspace.lints.rust]\n"
            "unexpected_cfgs = { level = \"warn\", check-cfg = ['cfg(target_os, values(\"solana\"))'] }\n\n"
            "[profile.dev.package.noised-rules]\nopt-level = 1\n"
        )
    # shutil.copy, not copy2: fresh mtimes, so cargo never reuses a build of a
    # previous mutant.
    shutil.copytree(os.path.join(REPO, "crates", "noised-rules"), CRATE, copy_function=shutil.copy)


def run_tests():
    cmd = (
        f"if ('{ENV_SCRIPT}' -and (Test-Path '{ENV_SCRIPT}')) {{ . '{ENV_SCRIPT}' }}; $env:CARGO_BUILD_JOBS='2'; $env:CARGO_NET_OFFLINE='true'; "
        f"$env:CARGO_TARGET_DIR='{WORK}\\target'; Set-Location '{WS}'; "
        "cargo test --no-fail-fast -p noised-rules 2>&1 | Out-String; exit $LASTEXITCODE"
    )
    p = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=1800)
    return p.returncode, p.stdout + p.stderr


def check_patterns():
    bad = []
    labels = set()
    for path, old, new, label in MUTANTS:
        if label in labels:
            bad.append(f"duplicate label '{label}'")
        labels.add(label)
        src = open(os.path.join(REPO, "crates", "noised-rules", path.replace("/", os.sep)), encoding="utf-8").read()
        if src.count(old) != 1:
            bad.append(f"'{label}': pattern matches {src.count(old)} times")
    for b in bad:
        print(b)
    print(f"{len(MUTANTS)} mutants, {len(bad)} problem(s)")
    return not bad


def main():
    args = sys.argv[1:]
    if "--check" in args:
        raise SystemExit(0 if check_patterns() else 1)
    if not check_patterns():
        raise SystemExit("fix the patterns first")
    only = set(args)
    sync()
    code, out = run_tests()
    if code != 0:
        print(out[-4000:])
        raise SystemExit("baseline fails")
    print("baseline passes", flush=True)
    survivors = []
    killed = 0
    for path, old, new, label in MUTANTS:
        if only and label not in only:
            continue
        full = os.path.join(CRATE, path.replace("/", os.sep))
        src = open(full, encoding="utf-8").read()
        if src.count(old) != 1:
            raise SystemExit(f"mutant '{label}': pattern matches {src.count(old)} times")
        open(full, "w", encoding="utf-8", newline="\n").write(src.replace(old, new))
        code, out = run_tests()
        open(full, "w", encoding="utf-8", newline="\n").write(src)
        failed = [l.split()[1] for l in out.splitlines() if l.strip().startswith("test ") and l.strip().endswith("FAILED")]
        if code == 0:
            survivors.append(label)
            print(f"SURVIVED  {label}", flush=True)
        elif "could not compile" in out:
            # Only a rustc error in the mutated crate counts; a linker or
            # file-lock failure is an infrastructure error, not a kill.
            errors = [l.strip() for l in out.splitlines() if l.strip().startswith("error[") or l.strip().startswith("error:")]
            first = next((e for e in errors if "could not compile" not in e), "?")
            if first.startswith("error[E") or "mismatched" in first or "non-exhaustive" in first:
                killed += 1
                print(f"killed    {label}  (compile error: {first})", flush=True)
            else:
                raise SystemExit(f"mutant '{label}': build failed without a compile error: {first}\n{out[-3000:]}")
        else:
            killed += 1
            print(f"killed    {label}  ({len(failed)} failing, e.g. {', '.join(failed[:3])})", flush=True)
    print(f"killed {killed} of {killed + len(survivors)}")
    print(f"{len(survivors)} survivor(s) {survivors}")
    if survivors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
