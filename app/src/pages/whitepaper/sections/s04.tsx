/** Section 4: hash-based signatures (Winternitz chains, LM-OTS, the randomizer, one-time-ness, LMS, NIST status). */
import type { ReactNode } from "react";

import { ChainFigure, ForgeryFigure, LiveSignatureFigure, StepsFigure, TreeFigure } from "../figures/hbs";
import { C, Eq, EqRef, H3, Proof, SecRef, Section, Table, Tag, Thm, XRef } from "../paper";
import { Cite } from "../refs";
import { M } from "../tex";

export function S04(): ReactNode {
  return (
    <Section id="hbs">
      <p>
        Both post-quantum components of Noised use the Leighton-Micali schemes of RFC 8554 <Cite k="rfc8554" />: the one-time signature LM-OTS
        with parameter set <C>LMOTS_SHA256_N32_W4</C> for vault keys, and the many-time tree LMS <C>LMS_SHA256_M32_H10</C> over it for creator
        identities. Their only assumption is SHA-256; their verification uses only the <C>sol_sha256</C> syscall. This section derives the
        parameters, proves the combinatorial core of their security, and quantifies why a one-time key must sign once.
      </p>

      <H3 id="hbs-chains" n="4.1">
        Winternitz chains
      </H3>
      <p>
        Fix a key identifier <M>{"I"}</M> (16 bytes) and a leaf index <M>{"q"}</M>. Every hash is tweaked with its position, so work spent
        against one key, chain or step never helps against another:
      </p>
      <Eq n="4.1">{"H_{i,j}(x) = \\mathrm{SHA256}\\big(I \\,\\|\\, u32(q) \\,\\|\\, u16(i) \\,\\|\\, u8(j) \\,\\|\\, x\\big), \\qquad c_i^{\\,a \\to b}(x) = H_{i,b-1} \\circ \\cdots \\circ H_{i,a}(x)."}</Eq>
      <p>
        With hash length <M>{"n = 32"}</M> bytes and Winternitz width <M>{"w = 4"}</M> bits, RFC 8554 §4.1 gives the number of message digits{" "}
        <M>{"u"}</M>, checksum digits <M>{"v"}</M>, the checksum shift <M>{"ls"}</M> and the chain count <M>{"p"}</M>:
      </p>
      <Eq n="4.2">
        {"\\begin{aligned} u &= \\left\\lceil \\frac{8n}{w} \\right\\rceil = 64, \\qquad v = \\left\\lceil \\frac{\\lfloor \\log_2\\big(u(2^w - 1)\\big) \\rfloor + 1}{w} \\right\\rceil = \\left\\lceil \\frac{\\lfloor \\log_2 960 \\rfloor + 1}{4} \\right\\rceil = 3, \\\\ ls &= 16 - vw = 4, \\qquad p = u + v = 67. \\end{aligned}"}
      </Eq>
      <p>
        Key generation draws 67 secrets <M>{"x_i = \\mathrm{SHA256}(I \\| u32(q) \\| u16(i) \\| \\texttt{0xff} \\| \\mathit{SEED})"}</M> (RFC 8554
        Appendix A), walks each chain to its end <M>{"z_i = c_i^{0 \\to 15}(x_i)"}</M>, and publishes{" "}
        <M>{"K = \\mathrm{SHA256}(I \\| u32(q) \\| \\texttt{0x8080} \\| z_0 \\| \\cdots \\| z_{66})"}</M>. To sign a message <M>{"M"}</M> with
        randomizer <M>{"C"}</M> the signer hashes
      </p>
      <Eq n="4.3">{"Q = \\mathrm{SHA256}(I \\,\\|\\, u32(q) \\,\\|\\, \\texttt{0x8181} \\,\\|\\, C \\,\\|\\, M), \\qquad S(Q) = \\sum_{i=0}^{63} \\big(15 - a_i\\big) \\in [0, 960],"}</Eq>
      <p>
        where <M>{"a_0, \\dots, a_{63}"}</M> are the base-16 digits of <M>{"Q"}</M>, most significant first, and the checksum digits{" "}
        <M>{"a_{64}, a_{65}, a_{66}"}</M> are the top three nibbles of the 16-bit word <M>{"S \\ll ls"}</M>. Since{" "}
        <M>{"S \\le 960 < 2^{12}"}</M>, these are exactly the three hexadecimal digits of <M>{"S"}</M>. The signature is{" "}
        <M>{"(C, y_0, \\dots, y_{66})"}</M> with <M>{"y_i = c_i^{0 \\to a_i}(x_i)"}</M>, which is <M>{"32 + 67 \\cdot 32 = 2{,}176"}</M> bytes. The
        verifier recomputes <M>{"Q"}</M>, continues every chain to its end, <M>{"z'_i = c_i^{a_i \\to 15}(y_i)"}</M>, and accepts if and only if{" "}
        <M>{"\\mathrm{SHA256}(I \\| u32(q) \\| \\texttt{0x8080} \\| z'_0 \\| \\cdots \\| z'_{66}) = K"}</M>, compared in constant time.
      </p>
      <ChainFigure />
      <Thm kind="Lemma" n="4.1" title="dominance">
        <p>
          Let <M>{"a \\in \\{0,\\dots,15\\}^{67}"}</M> be the digit vector (message digits and checksum digits) of a digest <M>{"Q"}</M>, and{" "}
          <M>{"b"}</M> that of a digest <M>{"Q'"}</M>. If <M>{"b_i \\ge a_i"}</M> for all 67 indices, then <M>{"b = a"}</M>, and therefore{" "}
          <M>{"Q' = Q"}</M>.
        </p>
      </Thm>
      <Proof>
        <p>
          From <M>{"b_i \\ge a_i"}</M> on the 64 message digits, <M>{"S(Q') = \\sum (15 - b_i) \\le \\sum (15 - a_i) = S(Q)"}</M>. The checksum digits
          are the hexadecimal digits of <M>{"S"}</M>, and a three-digit number whose every digit is at least the corresponding digit of another is at
          least that number, so <M>{"S(Q') \\ge S(Q)"}</M>. Hence <M>{"S(Q') = S(Q)"}</M>, i.e. <M>{"\\sum_{i<64} (b_i - a_i) = 0"}</M> with every
          term non-negative, so <M>{"b_i = a_i"}</M> for every message digit, and the checksum digits agree because the checksums do. The 64 message
          digits are all 256 bits of the digest, so <M>{"Q' = Q"}</M>.
        </p>
      </Proof>
      <p>
        A forger that holds one signature knows chain <M>{"i"}</M> at position <M>{"a_i"}</M> and can compute any later position by hashing
        forward. By Lemma 4.1 the only digests it can sign this way are those equal to <M>{"Q"}</M>: it must either find{" "}
        <M>{"(C', M') \\ne (C, M)"}</M> with the same 256-bit tweaked digest (a second-preimage search, success probability{" "}
        <M>{"2^{-256}"}</M> per attempt classically, about <M>{"2^{128}"}</M> Grover iterations), or step a chain backwards (a preimage of SHA-256).
        Katz gives the full reduction of LM-OTS's security to these properties of the hash in the random-oracle model <Cite k="katz" />; the lemma is
        its combinatorial core and the reason the checksum exists. <XRef to="fig-digits" /> computes a real signature over any text you type.
      </p>
      <LiveSignatureFigure />
      <p>
        The verifier's work is <M>{"T = \\sum_{i<67}(15 - a_i) = S + \\sum_{j<3}(15 - c_j(S))"}</M> chain steps. For a uniformly random digest{" "}
        <M>{"S"}</M> is a sum of 64 independent uniform variables on <M>{"\\{0, \\dots, 15\\}"}</M>:
      </p>
      <Eq n="4.4">{"\\mathbb{E}[S] = 64 \\cdot 7.5 = 480, \\qquad \\mathrm{Var}[S] = 64 \\cdot \\frac{16^2 - 1}{12} = 1360, \\qquad \\sigma_S \\approx 36.9,"}</Eq>
      <p>
        and the exact distribution of <M>{"T"}</M> (<XRef to="fig-steps" />) follows by convolution. The worst case is the all-zero digest:{" "}
        <M>{"S = 960 = \\texttt{0x3C0}"}</M>, checksum digits <M>{"(3, 12, 0)"}</M>, so <M>{"T = 960 + 12 + 3 + 15 = 990"}</M>. Each step hashes
        55 bytes, which the <C>sol_sha256</C> syscall prices at <M>{"85 + \\lfloor 55/2 \\rfloor = 112"}</M> CU; the measured cost of a whole LMS
        verification on SBF is <M>{"8{,}674 + 137\\,T"}</M> CU <Tag kind="measured" />.
      </p>
      <Thm kind="Lemma" n="4.3" title="the work is a multiple of 15">
        <p>
          For every digest, <M>{"T \\equiv 0 \\pmod{15}"}</M>.
        </p>
      </Thm>
      <Proof>
        <p>
          <M>{"T = S + 45 - (c_0 + c_1 + c_2)"}</M> and <M>{"S = 256\\,c_0 + 16\\,c_1 + c_2"}</M>. Since <M>{"16 \\equiv 1 \\pmod{15}"}</M>,{" "}
          <M>{"S \\equiv c_0 + c_1 + c_2"}</M>, so <M>{"T \\equiv 45 \\equiv 0 \\pmod{15}"}</M>. The mean 505.9, median 510, 99th percentile 600 and
          maximum 990 are consistent with it; only the mean, an average, is not itself a multiple of 15.
        </p>
      </Proof>
      <StepsFigure />

      <H3 id="hbs-randomizer" n="4.2">
        The deterministic randomizer
      </H3>
      <p>
        RFC 8554 has the signer draw <M>{"C"}</M> at random. Its purpose is to make <M>{"Q"}</M> unpredictable until the message is fixed, so that
        an attacker who influences part of a signed message cannot prepare colliding messages in advance. Noised derives it instead, with HMAC{" "}
        <Cite k="rfc2104" /> keyed by the key's secret seed, as FIPS 205 does for SLH-DSA's <M>{"\\mathrm{PRF}_{msg}"}</M> <Cite k="fips205" />:
      </p>
      <Eq n="4.5">{"C = \\mathrm{HMAC\\text{-}SHA256}\\big(\\mathit{SEED},\\; \\texttt{\"phalanx/pq/lmots/C\"} \\,\\|\\, I \\,\\|\\, u32(q) \\,\\|\\, M\\big)."}</Eq>
      <Thm kind="Proposition" n="4.2" title="idempotent signing">
        <p>
          Under <EqRef n="4.5" />, signing the same message twice with the same key yields byte-identical signatures and reveals no chain value
          beyond the first signature. If HMAC-SHA256 is a pseudorandom function, <M>{"C"}</M> is as unpredictable to anyone without{" "}
          <M>{"\\mathit{SEED}"}</M> as a random draw.
        </p>
      </Thm>
      <Proof>
        <p>
          <M>{"C"}</M> is a function of <M>{"(\\mathit{SEED}, I, q, M)"}</M> only, so <M>{"Q"}</M>, the digits and every <M>{"y_i"}</M> are too. The
          second claim is the PRF definition applied to an adversary that sees <M>{"(I, q, M)"}</M> but not the key.
        </p>
      </Proof>
      <p>
        This matters operationally. A wallet that loses a record of a signature it already broadcast, a second device, or a restarted process may
        sign the same withdrawal again. With a random <M>{"C"}</M> that produces a second, different digest under the same key, which is exactly the
        case <XRef to="fig-forge" /> shows to be dangerous; with <EqRef n="4.5" /> it reproduces the first signature. Every Noised signer must
        reproduce the known answer <M>{"\\mathit{SEED} = \\texttt{0x11}^{32}"}</M>, <M>{"I = \\texttt{0x22}^{16}"}</M>, <M>{"q = 7"}</M>,{" "}
        <M>{"M = \\texttt{\"noised\"}"}</M>, giving <C>C = efff9f33…9d79d3</C> (SPEC §3.10).
      </p>

      <H3 id="hbs-onetime" n="4.3">
        Why a second signature leaks
      </H3>
      <p>
        Suppose a key has signed <M>{"k"}</M> digests with digit vectors <M>{"a^{(1)}, \\dots, a^{(k)}"}</M>. The forger knows chain{" "}
        <M>{"i"}</M> from position <M>{"m_i = \\min_j a^{(j)}_i"}</M> on, and a fresh digest with digits <M>{"b"}</M> is forgeable exactly when{" "}
        <M>{"b_i \\ge m_i"}</M> for all 67 chains. The message digits of a random digest are independent and uniform; conditioned on{" "}
        <M>{"b_i \\ge m_i"}</M>, each <M>{"15 - b_i"}</M> is uniform on <M>{"\\{0, \\dots, 15 - m_i\\}"}</M>. So the success probability of one
        attempt is
      </p>
      <Eq n="4.6">{"\\rho(m) = \\prod_{i=0}^{63} \\frac{16 - m_i}{16} \\;\\cdot\\; \\Pr\\Big[\\, c_j\\big(S'\\big) \\ge m_{64+j},\\; j = 0,1,2 \\Big], \\qquad S' = \\sum_{i=0}^{63} U_i,\\; U_i \\sim \\mathcal{U}\\{0, \\dots, 15 - m_i\\},"}</Eq>
      <p>
        which we evaluate exactly by convolving the 64 uniform distributions (all terms non-negative, so even probabilities near{" "}
        <M>{"2^{-256}"}</M> keep full precision) and summing over the checksums whose digits clear <M>{"m_{64}, m_{65}, m_{66}"}</M>. The expected
        classical work is <M>{"1/\\rho"}</M> digest evaluations, and Grover's search needs about <M>{"(\\pi/4)\\rho^{-1/2}"}</M> iterations.{" "}
        <XRef to="fig-forge" /> shows the result: from <M>{"2^{256}"}</M> at <M>{"k = 1"}</M> to a feasible search at <M>{"k = 2"}</M> for a large
        fraction of key pairs. The forger may choose the message freely (in a vault withdrawal: its own recipient, the whole balance, its own next
        key), and the randomizer gives it unlimited attempts, so <M>{"\\rho"}</M> is the right measure. A one-time key must sign once; Noised
        enforces this on-chain for both schemes (<SecRef to="identity" />, <SecRef to="vault" />).
      </p>
      <ForgeryFigure />

      <H3 id="hbs-lms" n="4.4">
        LMS trees
      </H3>
      <p>
        An LMS key of height <M>{"h = 10"}</M> authenticates <M>{"2^{10} = 1{,}024"}</M> LM-OTS leaf keys under one 32-byte root{" "}
        <Cite k={["rfc8554", "merkle"]} />. With <M>{"K_q"}</M> the LM-OTS public key of leaf <M>{"q"}</M> and node numbers <M>{"r"}</M> (root{" "}
        <M>{"r = 1"}</M>, leaves <M>{"r = 2^h + q"}</M>):
      </p>
      <Eq n="4.7">
        {"T[r] = \\begin{cases} \\mathrm{SHA256}\\big(I \\| u32(r) \\| \\texttt{0x8282} \\| K_{r - 2^h}\\big) & r \\ge 2^h \\\\ \\mathrm{SHA256}\\big(I \\| u32(r) \\| \\texttt{0x8383} \\| T[2r] \\| T[2r+1]\\big) & 1 \\le r < 2^h \\end{cases}"}
      </Eq>
      <p>
        The public key is <M>{"u32(6) \\| u32(3) \\| I \\| T[1]"}</M> (56 bytes) and a signature is{" "}
        <M>{"u32(q) \\| \\sigma_{\\mathrm{OTS}} \\| u32(6) \\| \\mathrm{path}_0 \\| \\cdots \\| \\mathrm{path}_9"}</M>,{" "}
        <M>{"4 + 4 + 2{,}176 + 4 + 320 = 2{,}508"}</M> bytes. The verifier computes the candidate <M>{"K_c"}</M> from the one-time signature, hashes
        it into leaf <M>{"r = 2^h + q"}</M>, and climbs: at each level it hashes its node with the next path element on the correct side and halves{" "}
        <M>{"r"}</M>, ten times, then compares with <M>{"T[1]"}</M> in constant time (<XRef to="fig-tree" />). Noised's verifier fixes every
        length and typecode and returns the leaf index read from the signature itself, so no caller can record one leaf while the signature used
        another. Key generation costs{" "}
        <M>{"1{,}024 \\times (67 + 67 \\cdot 15 + 1) + 2{,}047 = 1{,}100{,}799"}</M> SHA-256 calls (about 1.14 million compressions); a Ryzen 7
        5800X does it in 62 ms natively <Tag kind="measured" />.
      </p>
      <TreeFigure />
      <Table id="tab-params" title="Parameters of the two schemes.">
        <thead>
          <tr>
            <th>Quantity</th>
            <th>LM-OTS (vault keys)</th>
            <th>LMS (creator identities)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>RFC 8554 typecode</td>
            <td className="mono">LMOTS_SHA256_N32_W4 = 3</td>
            <td className="mono">LMS_SHA256_M32_H10 = 6 (over type 3)</td>
          </tr>
          <tr>
            <td>Hash, output</td>
            <td>SHA-256, n = 32</td>
            <td>SHA-256, m = 32</td>
          </tr>
          <tr>
            <td>Chains / height</td>
            <td>p = 67 (64 + 3), 16 positions each</td>
            <td>h = 10, 1,024 one-time leaves</td>
          </tr>
          <tr>
            <td>Public key</td>
            <td>I, q, K: 52 bytes (key id = SHA256(0x20 ‖ u32(3) ‖ I ‖ u32(q) ‖ K))</td>
            <td>56 bytes (identity id = SHA256(0x21 ‖ pk))</td>
          </tr>
          <tr>
            <td>Signature</td>
            <td className="num">2,176 bytes</td>
            <td className="num">2,508 bytes</td>
          </tr>
          <tr>
            <td>Verification</td>
            <td>T chain steps + 2 hashes (mean T ≈ 506, max 990)</td>
            <td>T + 13 hashes; 8,674 + 137 T CU measured</td>
          </tr>
          <tr>
            <td>State</td>
            <td>vault sequence number, on-chain</td>
            <td>1,024-bit used-leaf bitmap, on-chain</td>
          </tr>
          <tr>
            <td>Generic security</td>
            <td colSpan={2}>about 256 bits classical, 128 bits quantum (a Grover search over 256 bits)</td>
          </tr>
        </tbody>
      </Table>

      <H3 id="hbs-nist" n="4.5">
        Standards status
      </H3>
      <p>
        NIST SP 800-208 <Cite k="sp800208" /> approves LMS (with HSS) and XMSS as stateful hash-based signature schemes, and both parameter sets
        Noised uses are among those it lists. Two of its conditions are worth stating precisely, because they bound what "standard" means here.
        First, the standard is explicit that stateful schemes are not suited to general use: a signer that ever uses a one-time key twice loses
        its security, so they are intended for settings where state can be managed reliably. Second, it requires key generation and signing to
        happen inside hardware cryptographic modules that do not export secret keying material. Noised clients generate keys in software (from a
        passkey secret or a recovery phrase) and sign in the browser or on an offline machine. Noised therefore uses <em>SP 800-208 parameter
        sets</em>; it is not an SP 800-208-conformant deployment, and we do not claim it is. Its answer to the state problem is different from the
        standard's: the state that matters is kept and enforced on-chain (the vault's sequence, the identity's bitmap), clients reserve every one-time
        key in a durable ledger before it signs, signatures are idempotent
        (Proposition 4.2), and every revealed signature can always land so that its key is consumed. FIPS 205 (SLH-DSA) is stateless but its
        smallest signatures, about 7.9 KB, do not fit one Solana transaction (<SecRef to="limitations" />).
      </p>
    </Section>
  );
}
