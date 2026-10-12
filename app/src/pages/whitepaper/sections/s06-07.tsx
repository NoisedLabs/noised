/** Sections 6 (the fair-open batch) and 7 (contention and liveness). */
import type { ReactNode } from "react";

import { ContentionFigure, FillFigure, PriceFigure, TimelineFigure } from "../figures/batch";
import { Aside, C, Eq, EqRef, H3, Proof, SecRef, Section, Tag, Thm, XRef } from "../paper";
import { Cite, Fn } from "../refs";
import { M } from "../tex";

export function S06(): ReactNode {
  return (
    <Section id="batch">
      <p>
        On a bonding curve the price rises with every purchase, so whoever buys first buys cheapest. On most launchpads that race is won by bots,
        bundlers and the creator itself, often inside the token's creation transaction. Noised replaces the race with a batch: during a commit
        window anyone deposits wSOL; one swap then buys for everyone at once; tokens and unspent wSOL are shared in proportion to what each
        committed.
      </p>
      <H3 id="batch-model" n="6.1">
        Model
      </H3>
      <p>
        Let commits <M>{"c_1, \\dots, c_n > 0"}</M> total <M>{"C = \\sum_i c_i"}</M>, and let <M>{"K"}</M> be the batch's total cap (the
        migration threshold when the creator sets none; otherwise at least a tenth of it). <C>execute_batch</C> swaps{" "}
        <M>{"A = \\min(C, K)"}</M> in partial-fill mode with minimum output zero, measures from escrow balance differences the quote actually spent{" "}
        <M>{"S \\le A"}</M> and the tokens received <M>{"T > 0"}</M>, and each commit is later paid
      </p>
      <Eq n="6.1">{"\\mathit{tokens}_i = \\left\\lfloor \\frac{T\\, c_i}{C} \\right\\rfloor, \\qquad \\mathit{refund}_i = \\left\\lfloor \\frac{(C - S)\\, c_i}{C} \\right\\rfloor,"}</Eq>
      <p>
        computed in 128-bit integers. A batch that nobody executes in its window, or that cannot execute (the pool already traded, or nothing could
        be bought), <em>expires</em>, and every commit is refunded in full.
      </p>
      <Thm kind="Proposition" n="6.1" title="payouts are bounded">
        <p>
          <M>{"\\sum_i \\mathit{tokens}_i \\le T"}</M> and <M>{"\\sum_i \\mathit{refund}_i \\le C - S"}</M>; the escrows keep less than{" "}
          <M>{"n"}</M> base units and <M>{"n"}</M> lamports of rounding dust<Fn k="dust" />.
        </p>
      </Thm>
      <Proof>
        <p>
          <M>{"\\sum_i \\lfloor T c_i / C \\rfloor \\le \\sum_i T c_i / C = T"}</M>, and each floor loses less than 1. The same holds for the refunds
          with <M>{"C - S \\ge 0"}</M>, which the program checks (<M>{"S \\le A \\le C"}</M>).
        </p>
      </Proof>
      <Thm kind="Proposition" n="6.2" title="one price">
        <p>
          Up to rounding, every committer pays the same average price <M>{"S / T"}</M> per token:{" "}
          <M>{"(c_i - \\mathit{refund}_i)/\\mathit{tokens}_i \\approx \\big(c_i - (C - S)c_i/C\\big) / (T c_i / C) = S/T"}</M>.
        </p>
      </Thm>
      <Thm kind="Proposition" n="6.3" title="no gain from splitting, timing or order">
        <p>
          Splitting a commit <M>{"c = c' + c''"}</M> across wallets never increases what it receives:{" "}
          <M>{"\\lfloor T c'/C \\rfloor + \\lfloor T c''/C \\rfloor \\le \\lfloor T c/C \\rfloor"}</M>, and likewise for refunds. The time and order of
          commits do not appear in <EqRef n="6.1" />.
        </p>
      </Thm>
      <Proof>
        <p>
          <M>{"\\lfloor x \\rfloor + \\lfloor y \\rfloor \\le \\lfloor x + y \\rfloor"}</M> for all real <M>{"x, y"}</M>. Only <M>{"c_i"}</M>,{" "}
          <M>{"C"}</M>, <M>{"S"}</M> and <M>{"T"}</M> enter the formula. The property is pinned in the host tests (
          <C>splitting_across_wallets_gives_no_advantage</C>) and in LiteSVM against mainnet DBC: a creator whose commit inside the launch
          transaction is 80% of the total receives exactly 80% of the batch.
        </p>
      </Proof>
      <p>
        Capital still counts: a participant who commits more gets proportionally more, which is the intended meaning of fair. A per-wallet cap{" "}
        <C>batch_wallet_cap</C> exists, at least <M>{"K/200"}</M> when set, but anyone can split across wallets, so it limits only naive
        concentration (<SecRef to="evaluation" />).
      </p>
      <p>
        <strong>Payout owners.</strong> A participant's first commit fixes where its payouts go: the tokens to <C>token_owner</C> and the unspent
        wSOL to <C>refund_owner</C>, each the committer or a Noised PQ vault of the paid mint, so the batch can pay straight into post-quantum
        custody and no key, Ed25519 or other, can redirect it afterwards. Claims are exempt from the Launch Guard, so a vault named by several
        committers could otherwise gather guard-exempt shares in one account (the PQ v2 review's proof of concept reached 62 times the max-wallet
        cap in one vault); <C>["payout-vault", L, vault]</C> therefore adds up every commit naming a vault and holds the total to one wallet's
        cap. The residual (round 3, R3-2): anyone may fill a vault's quota by naming it, which only donates that commit's tokens to the vault.
      </p>
      <H3 id="batch-over" n="6.2">
        Oversubscription
      </H3>
      <p>
        Round 1 of the review found that a first-come-first-served cap let the creator fill the batch in the launch transaction itself (finding
        L1). The cap now never refuses a commit; it bounds what the swap spends. With <M>{"C > K"}</M>,
      </p>
      <Eq n="6.2">{"\\frac{c_i - \\mathit{refund}_i}{c_i} \\;\\approx\\; \\frac{S}{C} \\;\\le\\; \\frac{K}{C}, \\qquad \\frac{\\mathit{refund}_i}{c_i} \\;\\approx\\; 1 - \\frac{S}{C},"}</Eq>
      <p>
        the same fractions for every commit (<XRef to="fig-fill" />). The cap floors of protocol v2 (<M>{"K \\ge \\mathit{threshold}/10"}</M>, a
        non-zero wallet cap at least <M>{"K/200"}</M>) keep a creator from shrinking the fair open to dust while every other check passes.
      </p>
      <FillFigure />
      <H3 id="batch-curve" n="6.3">
        The price the batch pays
      </H3>
      <p>
        Meteora DBC prices with concentrated-liquidity segments: on a segment with liquidity <M>{"L"}</M>, moving the square-root price from{" "}
        <M>{"s_a"}</M> to <M>{"s_b"}</M> absorbs <M>{"\\Delta q = L(s_b - s_a)"}</M> of quote and releases{" "}
        <M>{"\\Delta x = L(s_b - s_a)/(s_a s_b)"}</M> of base (in DBC's Q64.64 units the quote carries a factor <M>{"2^{-128}"}</M>).
      </p>
      <Thm kind="Lemma" n="6.4" title="the batch pays the geometric mean">
        <p>
          A purchase that moves the price from <M>{"p_a = s_a^2"}</M> to <M>{"p_b = s_b^2"}</M> within one segment pays an average price of{" "}
          <M>{"\\sqrt{p_a\\, p_b}"}</M>.
        </p>
      </Thm>
      <Proof>
        <p>
          <M>{"\\Delta q / \\Delta x = L(s_b - s_a) \\cdot s_a s_b / \\big(L (s_b - s_a)\\big) = s_a s_b = \\sqrt{p_a p_b}"}</M>.
        </p>
      </Proof>
      <p>
        <XRef to="fig-price" /> applies the lemma to the Fair preset: the batch turns a race from the first lamport's price to the last one's into a
        single price between them. Because the batch is the pool's first swap, that price starts from the curve's opening price. The hook makes
        that so (<SecRef to="guard" />), and the launchpad checks it independently: <C>execute_batch</C> refuses to run when DBC's{" "}
        <C>has_swap</C> flag is set (<C>PoolAlreadyTraded</C>), so a batch whose pool was ever traded first can only expire and refund. This is why
        the swap may safely use a minimum output of zero.
      </p>
      <PriceFigure />
      <H3 id="batch-shield" n="6.4">
        The snipe shield
      </H3>
      <p>
        From the launch until the batch executes, or its execution window ends, nobody can buy (<XRef to="fig-timeline" />). Holding the shield
        for the whole window would delay public trading by up to ten minutes; instead <C>execute_batch</C> ends it immediately through the hook's{" "}
        <C>end_snipe_shield</C>, which only the launchpad's hook-authority PDA may call and which can only move the end earlier:
      </p>
      <Eq n="6.3">{"t_{\\mathrm{shield}} \\leftarrow \\min(t_{\\mathrm{shield}},\\, t_{\\mathrm{now}}) \\quad \\text{at the batch.}"}</Eq>
      <TimelineFigure />
    </Section>
  );
}

export function S07(): ReactNode {
  return (
    <Section id="liveness">
      <p>
        Safety does not depend on anyone acting; liveness does. A batch executes only if someone sends <C>execute_batch</C> inside its window, and
        commits land only if they are included. Solana schedules transactions per block under compute limits, which gives a well-funded adversary
        a way to keep honest transactions out: write-lock the launch's accounts and fill their budget.
      </p>
      <H3 id="live-model" n="7.1">
        A cost model for write-lock contention
      </H3>
      <p>
        Agave 4.3.0 caps the compute units charged to any one writable account per block at <M>{"B = 24{,}000{,}000"}</M> (with a 60M-CU block
        limit) <Cite k="agave" />. A transaction can request at most <M>{"C_{\\max} = 1{,}400{,}000"}</M> CU and pays <M>{"f_0 = 5{,}000"}</M>{" "}
        lamports per signature plus its compute-unit price <M>{"\\pi"}</M> (micro-lamports per CU) times the CU it requests. Leaders order by
        price, so to exclude honest transactions paying <M>{"\\pi_h"}</M> the attacker fills <M>{"B"}</M> in every block of a window of{" "}
        <M>{"W"}</M> seconds at price <M>{"\\pi_h + 1"}</M>. With slot time <M>{"\\tau \\approx 0.4"}</M> s:
      </p>
      <Eq n="7.1">{"\\mathrm{Cost}(W, \\pi_h) \\;=\\; \\frac{W}{\\tau} \\left( \\left\\lceil \\frac{B}{C_{\\max}} \\right\\rceil f_0 \\;+\\; \\frac{B\\,(\\pi_h + 1)}{10^6} \\right) \\text{ lamports}, \\qquad \\left\\lceil \\frac{B}{C_{\\max}} \\right\\rceil = 18."}</Eq>
      <p>
        An honest commit, by contrast, pays <M>{"f_0 + c\\,\\pi_h / 10^6"}</M> with a tight compute limit <M>{"c \\approx 50{,}000"}</M> CU (a
        commit measured 43,977 CU <Tag kind="v2" />): per block, the attacker's marginal cost is about <M>{"B / c = 480"}</M> times the honest one.{" "}
        <XRef to="fig-contention" /> plots <EqRef n="7.1" /> <Tag kind="model" />.
      </p>
      <ContentionFigure />
      <H3 id="live-windows" n="7.2">
        Windows chosen from the model
      </H3>
      <ul className="wp-list">
        <li>
          <strong>Commit window, at least 60 s</strong> (<C>MIN_OPEN_DELAY</C>): a window of seconds could be blocked for a fraction of a cent; a
          minute costs about 0.014 SOL even when nobody pays a priority fee, and the cost grows linearly with length and with honest priority.
        </li>
        <li>
          <strong>Execution window, 600 s</strong> (<C>EXECUTION_GRACE_SECS</C>, raised from 30 s in round 2): forcing a batch to expire costs ten
          minutes of contention, 0.14 SOL at zero priority and about 36 SOL against keepers paying 1 lamport per CU. Because the batch ends the
          shield (6.3), the long window costs honest users nothing when a keeper is prompt.
        </li>
        <li>
          <strong>Launch window, 60 s to 1 h, chosen and signed by the creator</strong>: every <C>launch</C> writes the <C>Launch</C> account, so
          the same contention can keep it out of a window while someone pays for it. The creator picks a longer window where contention is
          expected. A window that passes unused costs one leaf: since round 3's F1 the identity signs a new opening time, which replaces
          the expired attestation; before F1 such a launch could never go live.
        </li>
        <li>
          <strong>Keepers</strong>: <C>launch</C> (inside its window), <C>execute_batch</C>, <C>claim</C>, <C>claim_fees</C> and{" "}
          <C>distribute</C> are permissionless. The app, any
          participant and independent keepers can send them; <C>execute_batch</C> must be a top-level instruction and fits a legacy transaction.
        </li>
      </ul>
      <Aside title="Honest scope" tone="warn">
        <p>
          The model raises the price of exclusion linearly; it does not remove it. It also assumes leaders follow fee priority: leaders and the
          ordering gateways in front of most of them (about 62% of leader slots) can delay or drop transactions for free. Noised's answer is that
          every timed step fails safe. A batch that does not execute expires and <C>claim</C>, which reads no DBC account, refunds every commit in
          full; a launch window that passes unused is signed again; a vault withdrawal or an attestation has no expiry of its own and is simply
          re-broadcast. Censorship can deny or delay a fair open; it cannot take funds or change what anyone signed.
        </p>
      </Aside>
    </Section>
  );
}
