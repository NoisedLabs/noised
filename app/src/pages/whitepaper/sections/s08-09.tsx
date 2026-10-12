/** Sections 8 (Launch Guard and the transfer hook) and 9 (liquidity and fees). */
import type { ReactNode } from "react";

import { CurveFigure, FeeFigure, HookFigure } from "../figures/market";
import { MIGRATION_FEE_TIERS_BPS } from "../model/fees";
import { C, Eq, H3, Proof, SecRef, Section, Table, Tag, Thm, XRef } from "../paper";
import { Cite } from "../refs";
import { M } from "../tex";

export function S08(): ReactNode {
  return (
    <Section id="guard">
      <p>
        Token-2022 calls a mint's transfer-hook program on every transfer <Cite k="token2022" />. Meteora DBC lets a pool's mint carry a hook and
        revokes it, program and authority, in the swap that completes the curve, so a hook exists only during the bonding-curve phase{" "}
        <Cite k="dbc" />. Noised's hook, Launch Guard, uses that phase for the snipe shield and bounded anti-sniping rules, and is built so that it
        can never become a honeypot.
      </p>
      <H3 id="guard-order" n="8.1">
        Decision order
      </H3>
      <p>
        A transfer is a <em>buy</em> when its source is the pool's base vault, whatever its destination, and a <em>sell</em> when its destination is
        the base vault and its source is any other account. <XRef to="fig-hook" /> gives the order in which <C>rules::evaluate</C> decides, after
        <C>execute</C> has checked that the policy belongs to the mint (step 1). The function is pure, total and allocation-free.
      </p>
      <HookFigure />
      <Thm kind="Theorem" n="8.1" title="no honeypot">
        <p>
          For every policy and every transfer: a sell is allowed; any transfer at or after <M>{"t_{\\mathrm{guard}}"}</M> is allowed; a mint without a
          Noised policy is never restricted. Moreover <M>{"t_{\\mathrm{guard}} - t_{\\mathrm{launch}} \\le 72"}</M> h for every policy the hook
          accepts, and the hook ceases to exist when the curve completes.
        </p>
      </Thm>
      <Proof>
        <p>
          In <C>evaluate</C>, the sell test (step 2) and the expiry test (step 3) return before the first statement that can refuse; step 1 allows
          mints without a policy. <C>create_policy</C> accepts only a policy signed by the launchpad's hook-authority PDA whose guard is at most{" "}
          <M>{"72 \\cdot 3600"}</M> s and whose shield is at most 3,600 s, independently of the launchpad's own (stricter) validation. Revocation at
          completion is DBC 0.2.1 behaviour (FACTS #25). The first two claims are also property tests over 200,000 random transfers each in the
          host suite, and all three are LiteSVM tests against mainnet Token-2022.
        </p>
      </Proof>
      <p>
        One caveat is structural, not a rule: Token-2022 fails a transfer whose hook accounts are missing, so a client must pass the four accounts
        (meta list, policy, instructions sysvar, hook program). They depend only on the mint, the meta list is created in the same transaction as
        the mint, and it can never change, so any client can always derive them. A sell can be made to fail only by the seller's own client.
      </p>
      <H3 id="guard-batch" n="8.2">
        Recognizing the batch buy
      </H3>
      <p>
        During the shield the hook must pass exactly one buy. It reads the instructions sysvar: the transaction's <em>currently executing top-level
        instruction</em> must belong to the launchpad and start with <C>execute_batch</C>'s 8-byte discriminator. This is sound because the sysvar
        lists only top-level instructions with the program each one really invokes, the runtime keeps its current index at the top-level
        instruction during CPIs, and the sysvar accessors refuse any account that is not the real sysvar. A program that CPIs into the launchpad
        appears as itself, so a CPI'd <C>execute_batch</C> is refused. The shield is checked before the zero-amount and exemption passes: the
        review found that a buy into an account owned by an exempt PDA (finding L2), or a buy whose output rounds to zero (round 1b), still moved
        DBC's price and volatility accumulator, and so the fee the batch paid. The independent first-swap check of <SecRef to="batch" /> backs the
        hook up.
      </p>
      <H3 id="guard-bounds" n="8.3">
        Bounds
      </H3>
      <Table id="tab-guard" title="Launch Guard bounds, enforced twice.">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Launchpad policy (create_launch)</th>
            <th>Hook (create_policy)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Snipe shield</td>
            <td>commit window 60-1,800 s + execution window 600 s; ended early by the batch</td>
            <td className="num">≤ 3,600 s</td>
          </tr>
          <tr>
            <td>Guard (caps, lock)</td>
            <td>from the shield's end, at most 72 h after launch</td>
            <td className="num">≤ 72 h</td>
          </tr>
          <tr>
            <td>Max wallet</td>
            <td>off, or 10-10,000 bps of the initial supply</td>
            <td className="num">≥ supply / 1,000</td>
          </tr>
          <tr>
            <td>Max buy</td>
            <td>off, or 1-10,000 bps</td>
            <td className="num">≥ supply / 10,000</td>
          </tr>
          <tr>
            <td>Wallet-to-wallet lock</td>
            <td>optional, never applies to buys or sells</td>
            <td>during the guard only</td>
          </tr>
          <tr>
            <td>Trading fee</td>
            <td>floor base fee + largest dynamic fee ≤ 10%</td>
            <td className="muted">not a hook rule</td>
          </tr>
        </tbody>
      </Table>
      <p>
        Caps are per transfer and per token account, so Sybil wallets get around them; they slow naive concentration during the first hours and
        are documented as such. Max wallet also applies to accounts many people pay into: a holder of about the cap can fill the shield's one
        escrow for the mint, or top up someone's associated token account, and further wraps or payouts into it fail until the guard ends
        (round 3, R3-5; griefing only, at most 72 h).
      </p>
      <p>
        <strong>Owners that cannot change.</strong> The hook sees transfers, not ownership. Round 3 showed that a buyer could buy into a hand-made
        token account without Token-2022's <C>ImmutableOwner</C> extension and then hand the account to another wallet with{" "}
        <C>SetAuthority</C>, which moves no tokens, so the wallet-to-wallet lock was bypassed and one owner could gather many accounts each near
        the cap (R3-4). Fix F2 adds one refusal to <C>evaluate</C>: while the guard is on, after an exempt destination
        is allowed and before an exempt source is, a receiving account without <C>ImmutableOwner</C> is refused (<C>MutableOwner</C>, hook error
        6010). Associated token accounts always carry the extension, so buys, claims, vault <C>release</C> payouts and shield wraps are
        unaffected, and sells never reach the rule. With F2 the lock stops token transfers and consolidation by owner reassignment during the
        guard; it cannot stop several people sharing control of one wallet (a multisig or a smart wallet), which needs no transfer at all. Launch Guard's own work is small: one policy read, two fixed-size account reads, the sysvar read only for buys
        during the shield, and a loop over at most four exempt keys. Measured, the hook's <C>execute</C> costs 2,262-4,404 CU and a whole hooked
        Token-2022 transfer 15,878-23,378 CU <Tag kind="docs" />.
      </p>
    </Section>
  );
}

export function S09(): ReactNode {
  return (
    <Section id="liquidity">
      <p>
        The launchpad fixes every Meteora DBC configuration field a creator could use against holders and lets the creator choose only the curve,
        fees within bounds, the batch and guard parameters, and up to four fee recipients. Among the fixed values: quote mint wSOL; the mint's
        metadata immutable; 100% of migrated liquidity permanently locked under the launch-authority PDA; no migration fee; no creator allocation
        or vesting (creators buy in the batch like everyone else); unsold base tokens burned at migration. After <C>launch</C>, the program checks
        the fresh mint's post-conditions (no mint, freeze or metadata authority; exactly the expected extensions; the hook is Launch Guard) and
        aborts if any fails.
      </p>
      <H3 id="liq-curve" n="9.1">
        Bonding curve and graduation
      </H3>
      <p>
        A curve is up to eight segments <M>{"(s_k, L_k)"}</M> of constant liquidity between square-root prices. Integrating the segment formulas
        of <SecRef to="batch" /> from the start price, after <M>{"q"}</M> lamports have entered the curve its square-root price and the base it has
        released are
      </p>
      <Eq n="9.1">{"s(q) = s_0 + \\frac{q}{L}, \\qquad x(q) = L \\left( \\frac{1}{s_0} - \\frac{1}{s(q)} \\right), \\qquad p(q) = s(q)^2 \\quad \\text{(one segment, DBC units)}."}</Eq>
      <p>
        When the curve holds the migration threshold, anyone can call DBC's permissionless migration to DAMM v2. Since <C>partner_permanent_locked_liquidity_percentage</C>{" "}
        is 100, the whole position is permanently locked, and DAMM v2's permanent lock is irreversible; the launch authority keeps only the right
        to claim the position's fees. <XRef to="fig-curve" /> draws the three presets.
      </p>
      <CurveFigure />
      <H3 id="liq-fees" n="9.2">
        Fees and their routing
      </H3>
      <p>
        Every DBC trade pays a base fee plus an optional dynamic (volatility) fee, both in the quote token. DBC keeps 20% as its protocol share; the
        rest accrues to the partner, which is the launch-authority PDA (the creator's own trading-fee share is fixed at 0). The policy requires any
        decaying base-fee schedule to end within the commit window, so the batch pays the floor (<XRef to="fig-fees" />). Anyone may call{" "}
        <C>claim_fees</C> and then <C>distribute</C>, which splits the launch authority's whole wSOL balance <M>{"W"}</M>:
      </p>
      <Eq n="9.2">{"\\mathit{platform} = \\left\\lfloor \\frac{W\\, b_{\\mathrm{p}}}{10^4} \\right\\rfloor, \\qquad \\mathit{pay}_j = \\left\\lfloor \\frac{(W - \\mathit{platform})\\, b_j}{10^4} \\right\\rfloor \\;(j < r), \\qquad \\mathit{pay}_r = W - \\mathit{platform} - \\sum_{j<r} \\mathit{pay}_j,"}</Eq>
      <p>
        with the platform share <M>{"b_{\\mathrm{p}} \\le 5{,}000"}</M> bps snapshotted from the immutable <C>Protocol</C> account at creation, and
        recipient shares <M>{"b_j"}</M> summing to 10,000, fixed at <C>create_launch</C> forever. The split always sums to <M>{"W"}</M>. After
        graduation, <C>claim_lp_fees</C> collects the locked position's fees: wSOL is distributed the same way, and launch tokens are burned, never
        sold. Recipients may be wSOL PQ vaults, and the treasury must be one (<SecRef to="vault" />), so fees accrue under post-quantum custody.
        Because <C>distribute</C> pays <M>{"\\mathrm{ATA}(\\mathit{recipient}, \\mathrm{wSOL})"}</M> and the legacy <C>create_launch</C> has no
        room to inspect recipient accounts, a PQ vault of <em>another</em> mint named as a recipient would strand its whole share; the SDK and
        the app refuse such recipients before the creator signs (round 3, F3, a client check). The graduated pool's fee tier is one of DAMM v2's fixed options,{" "}
        {MIGRATION_FEE_TIERS_BPS.map((b) => `${(b / 100).toLocaleString("en-US")}%`).join(", ")}; DAMM v2's operators can later raise a pool's
        base fee to at most 10%, which <SecRef to="evaluation" /> lists among the trusted parties.
      </p>
      <FeeFigure />
    </Section>
  );
}
