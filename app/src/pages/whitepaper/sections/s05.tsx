/** Section 5: post-quantum creator identity, launch attestation and the token's on-chain metadata. */
import type { ReactNode } from "react";

import { DEdge, Diagram, DNode, DText } from "../../../components/charts";
import { FINAL_SIZES } from "../model/perf";
import { Aside, C, Eq, Figure, H3, Proof, SecRef, Section, Table, Tag, Thm, XRef } from "../paper";
import { Cite, Fn } from "../refs";
import { M } from "../tex";

function Bitmap({ x, y, used }: { x: number; y: number; used: readonly number[] }): ReactNode {
  const cols = 128;
  const cell = 4;
  const set = new Set(used);
  const cells: ReactNode[] = [];
  for (let q = 0; q < 1024; q++) {
    const cx = x + (q % cols) * (cell + 0.5);
    const cy = y + Math.floor(q / cols) * (cell + 0.5);
    cells.push(<rect key={q} x={cx} y={cy} width={cell} height={cell} className={set.has(q) ? "bm-on" : "bm-off"} />);
  }
  return <g shapeRendering="crispEdges">{cells}</g>;
}

function IdentityFigure(): ReactNode {
  return (
    <Figure
      id="fig-identity"
      title="Identity lifecycle."
      caption={
        <>
          The identity's secret comes from a passkey or a dedicated phrase, never from a wallet. Its hash, <C>pq_identity</C>, is a launch
          parameter; the token's metadata record is published at the address of its own hash; one leaf signs the launch's attestation message,
          which names that hash; <C>attest_launch</C> verifies it on-chain and sets the leaf's bit in the identity's 1,024-bit map (three leaves
          used in the drawing); <C>launch</C> refuses to run without that attestation and gives the mint exactly the record.
        </>
      }
      wide
    >
      <Diagram w={900} h={392} minWidth={680} label="Lifecycle of a Noised post-quantum creator identity">
        <DNode x={14} y={14} w={172} h={52} title="Passkey" lines={["WebAuthn PRF / hmac-secret"]} step={0} />
        <DNode x={14} y={80} w={172} h={52} title="PQ recovery phrase" lines={["24 words, separate"]} step={0} />
        <DNode x={224} y={46} w={130} h={54} title="master" lines={["64 bytes"]} kind="strong" step={1} />
        <DNode x={392} y={40} w={168} h={66} title="SEED, I" lines={["tagged SHA-256 of master", "and cluster ‖ index"]} step={2} />
        <DNode x={598} y={40} w={136} h={66} title="LMS tree" lines={["1,024 leaves", "1.1M hashes"]} step={3} />
        <DNode x={772} y={40} w={116} h={66} title="pq_identity" lines={["SHA256(0x21 ‖ pk)"]} kind="strong" step={4} />
        <DEdge points={[[186, 40], [205, 40], [205, 64], [224, 64]]} step={1} />
        <DEdge points={[[186, 106], [205, 106], [205, 82], [224, 82]]} step={1} />
        <DEdge points={[[354, 73], [392, 73]]} step={2} />
        <DEdge points={[[560, 73], [598, 73]]} step={3} />
        <DEdge points={[[734, 73], [772, 73]]} step={4} />

        <DNode x={14} y={206} w={190} h={66} title="create_launch" lines={["params ∋ pq_identity", "then publish_metadata"]} step={5} />
        <DNode x={240} y={206} w={190} h={66} title="sign at leaf q" lines={["189-byte message v2", "reserved in the ledger first"]} step={6} />
        <DNode x={466} y={206} w={212} h={66} title="attest_launch (v1 tx)" lines={["LMS verify on-chain", "set bit q, write attestation"]} kind="strong" step={7} />
        <DNode x={714} y={206} w={174} h={66} title="launch, certificate" lines={["only inside the window", "identity, leaf, record"]} kind="strong" step={8} />
        <DEdge points={[[830, 106], [830, 150], [109, 150], [109, 206]]} label="named in the launch parameters" labelAt={[470, 144, "middle"]} step={5} />
        <DEdge points={[[204, 239], [240, 239]]} step={6} />
        <DEdge points={[[430, 239], [466, 239]]} label="relay" labelAt={[448, 231, "middle"]} step={7} />
        <DEdge points={[[678, 239], [714, 239]]} step={8} />
        <DEdge points={[[572, 272], [572, 312]]} dash="dash" step={9} />
        <DText x={240} y={306} kind="small">
          used-leaf bitmap: 1,024 bits (128 bytes) in ["identity", pq_identity]
        </DText>
        <Bitmap x={240} y={316} used={[0, 1, 2]} />
        <DText x={240} y={372} kind="faint">
          a leaf whose signature lands is burned forever, whether or not it attested
        </DText>
      </Diagram>
    </Figure>
  );
}

export function S05(): ReactNode {
  return (
    <Section id="identity">
      <p>
        After an elliptic-curve break, any wallet can be impersonated. A launchpad whose notion of "who launched this" rests on a wallet signature
        then has no notion of origin at all. Protocol v2 gives every launch a post-quantum origin: the creator holds an LMS key (
        <SecRef to="hbs" />), the launch names it, and the launchpad refuses to make the launch live until that key has signed the launch's exact
        terms. Safety policy 3 extends the signature to the token's face: its name, symbol, description and icon are a record on-chain whose
        hash the identity signs. The verification, the one-time state and the record all live on-chain.
      </p>

      <H3 id="id-keys" n="5.1">
        Keys
      </H3>
      <p>
        An identity is derived from a 64-byte <M>{"\\mathit{master}"}</M> secret, a cluster byte and an identity index:
      </p>
      <Eq n="5.1">
        {"\\begin{aligned} \\mathit{path} &= \\mathit{cluster} \\,\\|\\, u32_{le}(\\mathit{index}) \\\\ \\mathit{SEED} &= \\mathrm{SHA256}(\\texttt{\"phalanx/pq/identity/v1/seed\"} \\,\\|\\, \\mathit{master} \\,\\|\\, \\mathit{path}) \\\\ I &= \\mathrm{SHA256}(\\texttt{\"phalanx/pq/identity/v1/id\"} \\,\\|\\, \\mathit{master} \\,\\|\\, \\mathit{path})[0..16) \\\\ \\mathit{pq\\_identity} &= \\mathrm{SHA256}(\\texttt{0x21} \\,\\|\\, u32(6) \\,\\|\\, u32(3) \\,\\|\\, I \\,\\|\\, T[1]) \\end{aligned}"}
      </Eq>
      <p>
        The domain bytes are disjoint by construction: <C>0x20</C> names vault keys, <C>0x21</C> identities, the RFC's <C>0x80</C>-<C>0x83</C> occur
        only after <M>{"I"}</M> inside RFC hashes, and ASCII tags <C>phalanx/pq/…</C> start every client-side derivation (they keep the project's original name: they
        are fixed protocol constants, and renaming them would change every key). The cluster byte keeps a
        devnet identity from ever being a mainnet one, and every signer first checks the RPC's genesis hash. Two sources of{" "}
        <M>{"\\mathit{master}"}</M> are supported:
      </p>
      <ul className="wp-list">
        <li>
          <strong>A dedicated recovery phrase</strong>: 24 BIP-39 words (256 bits of entropy) <Cite k="bip39" />, the BIP-39 seed being{" "}
          <M>{"\\mathit{master}"}</M>. It is the same phrase that controls the user's vaults, with a different derivation path.
        </li>
        <li>
          <strong>A passkey</strong>, through the WebAuthn PRF extension (CTAP2 <C>hmac-secret</C>) <Cite k="webauthn" />, with user
          verification: the authenticator returns{" "}
          <M>{"\\mathit{prf} = \\mathrm{HMAC\\text{-}SHA256}(\\mathit{CredRandom}, \\mathrm{SHA256}(\\texttt{\"WebAuthn PRF\"} \\| \\texttt{0x00} \\| \\mathit{salt}))"}</M>,
          computed inside the authenticator from a per-credential secret, and the client takes{" "}
          <M>{"\\mathit{entropy} = \\mathrm{HKDF\\text{-}SHA256}(\\mathit{prf}, \\texttt{\"phalanx/pq/passkey/v1\"}, \\texttt{\"…/bip39-entropy\"}, 32)"}</M>{" "}
          as the 24 words' entropy, so the derived <M>{"\\mathit{master}"}</M> can be exported as words for backup. It is a symmetric computation:
          a quantum computer gains only Grover's square root against it. The user trusts the authenticator, and for synced passkeys the provider
          that syncs them; the PRF secret reaches roaming authenticators over classical channels; and the credential is scoped to the app's exact
          host (its relying-party identifier), so the same passkey does not work from another origin.
        </li>
      </ul>
      <p>
        The SDK (0.4) ships both paths in the browser: key generation of the 1,024 leaves runs in time slices with progress (about 0.6 s in Node
        on a desktop CPU), and an authenticated cache of the tree lets an identity load in milliseconds afterwards.
      </p>

      <H3 id="id-wallet" n="5.2">
        Why the identity is never derived from a wallet
      </H3>
      <p>
        A tempting design derives the post-quantum secret from the user's existing wallet ("no new seed phrase"). Wallets do not reveal private
        keys, so such a derivation must hash a wallet <em>signature</em> on a fixed message. The argument against it is often stated as "a quantum
        computer recovers the wallet key and recomputes the signature". That is imprecise, and the precise version is both more subtle and more
        damning.
      </p>
      <Thm kind="Definition" n="5.1" title="wallet-derived secret">
        <p>
          <M>{"s = F(\\sigma^*)"}</M> for a public function <M>{"F"}</M>, where <M>{"\\sigma^* = \\mathrm{Sign}_k(m^*)"}</M> is the wallet's
          RFC 8032 Ed25519 signature on a fixed message <M>{"m^*"}</M> under secret key <M>{"k"}</M> with public key <M>{"A"}</M>.
        </p>
      </Thm>
      <Thm kind="Proposition" n="5.2">
        <p>
          (i) Any party that obtains <M>{"\\sigma^*"}</M> obtains <M>{"s"}</M>; a wallet returns <M>{"\\sigma^*"}</M> to any application the user
          approves one message-signing request for, today, with no quantum computer. (ii) Shor's algorithm applied to <M>{"A"}</M> does not by
          itself yield <M>{"s"}</M>. (iii) Every step that binds the identity to a creator through an Ed25519 signature is forgeable by{" "}
          <M>{"\\mathcal{A}_{\\mathrm{q}}"}</M>.
        </p>
      </Thm>
      <Proof>
        <p>
          (i) is the definition plus the wallet interface. For (ii), RFC 8032 §5.1.6 signs with{" "}
          <M>{"r = \\mathrm{SHA512}(\\mathit{prefix} \\,\\|\\, m) \\bmod \\ell"}</M>, <M>{"R = [r]B"}</M>,{" "}
          <M>{"S = (r + \\mathrm{SHA512}(R \\| A \\| m)\\, a) \\bmod \\ell"}</M>, where <M>{"a"}</M> and <M>{"\\mathit{prefix}"}</M> are the two
          halves of <M>{"\\mathrm{SHA512}(k)"}</M>. Shor returns <M>{"a \\bmod \\ell"}</M> from <M>{"A"}</M>, which suffices to forge any{" "}
          <em>new</em> signature, but the deterministic <M>{"\\sigma^*"}</M> also needs <M>{"\\mathit{prefix}"}</M>, which is not a function of{" "}
          <M>{"A"}</M>: recovering it is a SHA-512 preimage search<Fn k="shor-rfc8032" />. (iii) follows from (2.1): with <M>{"a"}</M>, every
          Ed25519 statement "wallet <M>{"A"}</M> vouches for identity <M>{"X"}</M>" can be produced for any <M>{"X"}</M>, including the
          attacker's.
        </p>
      </Proof>
      <p>
        So the honest objection is not that Shor recomputes the identity. It is that a wallet-derived identity is a secret held by an oracle that
        answers on request (i), and that whatever ties it to its owner is classical (iii); a derivation that touches the scalar <M>{"a"}</M>{" "}
        directly, as some key-derivation schemes do, is broken outright. Noised's design therefore requires: (R1) the identity's secret is
        independent of every Ed25519 key and of everything a wallet can be asked to sign; (R2) the program verifies the hash-based signature
        itself before the launch can go live; (R3) one-time state lives on-chain; (R4) the signed message binds everything the launch is,
        its metadata included. The creator's wallet still pays for and signs <C>create_launch</C>, and the certificate records it, but as
        information only: it has no power, and after an elliptic-curve break it proves nothing.
      </p>

      <H3 id="id-attest" n="5.3">
        The attestation
      </H3>
      <p>The identity signs a 189-byte message (version 2) that the program rebuilds from the <C>Launch</C> account and the signed terms:</p>
      <Eq n="5.2">
        {"\\begin{aligned} m_{\\mathrm{att}} = {} & \\texttt{\"PHX-ATTEST-V2\"} \\,\\|\\, \\pi_{\\mathrm{lp}} \\,\\|\\, L \\,\\|\\, h_{\\mathrm{params}} \\,\\|\\, \\mathit{creator} \\\\ & \\|\\, h_{\\mathrm{meta}} \\,\\|\\, i64_{le}(t_{\\mathrm{nb}}) \\,\\|\\, i64_{le}(t_{\\mathrm{na}}) \\end{aligned}"}
      </Eq>
      <p>
        with <M>{"13 + 5 \\cdot 32 + 2 \\cdot 8 = 189"}</M> bytes, where <M>{"\\pi_{\\mathrm{lp}}"}</M> is the launchpad's program id,{" "}
        <M>{"L"}</M> the launch address, <M>{"h_{\\mathrm{params}}"}</M> the SHA-256 of every creator choice (including <C>pq_identity</C> itself),{" "}
        <M>{"h_{\\mathrm{meta}}"}</M> the hash of the token's metadata record (5.5), and <M>{"[t_{\\mathrm{nb}}, t_{\\mathrm{na}}]"}</M> the window
        in which <C>launch</C> may run. The first version of this message bound the name, symbol and uri plus a SHA-256 of an off-chain document;
        that document's availability then depended on DNS, TLS or a pinning service, which is why the record moved on-chain.
      </p>
      <p>
        <C>attest_launch</C> is permissionless and is relayed by a throwaway fee payer in a version-1 transaction <Cite k="simd0385" /> of a
        constant {FINAL_SIZES.attestTx.toLocaleString("en-US")} bytes for every record <Tag kind="final" />. It derives the identity account from
        the public key it receives, verifies the LMS signature over <M>{"m_{\\mathrm{att}}"}</M>, reads the leaf <M>{"q"}</M> from the signature
        and sets bit{" "}
        <M>{"\\mathit{used}_{\\lfloor q/8 \\rfloor} \\leftarrow \\mathit{used}_{\\lfloor q/8 \\rfloor} \\lor 2^{\\,q \\bmod 8}"}</M>, refusing a bit
        already set (<C>PqLeafUsed</C>). Only then does it decide whether the signature also <em>attests</em>: the identity must be the one the
        launch names, the record <C>["metadata", L, h_meta]</C> must exist, the window must be valid, and the attestation slot must be free. If
        so it writes <C>["attestation", L]</C> with the full signature; otherwise the leaf is simply burned (event <C>PqLeafConsumed</C>). This
        ordering is deliberate: every valid signature at an unused leaf lands, whatever it signed, so a signature that was revealed but never
        used can always be landed to consume its leaf. Over all 1,024 leaves of one identity <C>attest_launch</C> costs 79,772 to 114,476 CU
        (mean 95,439); the worst possible digest is projected at 169,882 CU, inside the 300,000 the SDK requests <Tag kind="final" />.
      </p>
      <p>A window is valid when it is between one minute and one hour long, has not ended, opens at most a week ahead, and (since audit round 3's F1) still has a minute left when the attestation lands:</p>
      <Eq n="5.3">
        {"60 \\le t_{\\mathrm{na}} - t_{\\mathrm{nb}} \\le 3{,}600, \\qquad t_{\\mathrm{nb}} \\le t_{\\mathrm{now}} + 604{,}800, \\qquad \\max(t_{\\mathrm{now}},\\, t_{\\mathrm{nb}}) + 60 \\le t_{\\mathrm{na}}."}
      </Eq>
      <p>
        The slot is free when no attestation was written yet, or, with F1, when the launch is still <C>Configured</C> and its attestation's window
        passed unused (<M>{"t_{\\mathrm{now}} > t_{\\mathrm{na}}"}</M>); a replacement overwrites every field of the old one. An unexpired
        attestation, and that of a launch already live, are never replaced. Before F1 a launch nobody opened in its window could never go live,
        and an attestation landed in its window's last second fixed a window nobody could use (round 3's finding R3-1).
      </p>
      <p>
        <strong>Relaying.</strong> Every account of <C>attest_launch</C> except the payer is fixed by the signed data: the launch by the message,
        the identity by the key, the attestation by the launch, the record by the launch and the signed hash. The metadata review found that a
        relayer naming another record account could turn an attesting signature into a burn, again at every retry; now any other account fails
        the whole transaction (<C>ConstraintSeeds</C>), nothing is written and the leaf is not burned, so the same bytes are simply sent again. A
        relayer can therefore land a signature or hold it back, but not change what it does. The client checks the attestation after every landing
        and stops re-signing after two burn-only landings for one launch, since each new signature spends one of 1,024 leaves.
      </p>
      <Thm kind="Proposition" n="5.3" title="attested origin">
        <p>
          Assume LMS is existentially unforgeable when each leaf signs at most one message, and SHA-256 is second-preimage resistant. Then no
          adversary, including <M>{"\\mathcal{A}_{\\mathrm{q}}"}</M>, can make a launch live whose certificate names identity <M>{"X"}</M> unless{" "}
          <M>{"X"}</M>'s holder signed that launch's <M>{"m_{\\mathrm{att}}"}</M>; no attestation by <M>{"X"}</M> can be moved to another launch,
          other parameters, another metadata record or another window; and the mint shows exactly the record <M>{"X"}</M> signed.
        </p>
      </Thm>
      <Proof>
        <p>
          <C>launch</C> requires the account <C>["attestation", L]</C> with matching launch and identity, runs only inside its window, and loads
          only the record at <C>["metadata", L, h_meta]</C> for the attestation's <M>{"h_{\\mathrm{meta}}"}</M>. The attestation is written only by{" "}
          <C>attest_launch</C>, only after <M>{"\\mathrm{LMS.Verify}(pk_X, m_{\\mathrm{att}}, \\sigma) = q"}</M> with{" "}
          <M>{"\\mathrm{SHA256}(\\texttt{0x21} \\| pk_X)"}</M> equal to the launch's <C>pq_identity</C>, which <M>{"h_{\\mathrm{params}}"}</M> also
          covers. A valid <M>{"\\sigma"}</M> on <M>{"m_{\\mathrm{att}}"}</M> is either one <M>{"X"}</M> produced or a forgery. The message contains{" "}
          <M>{"L"}</M>, <M>{"h_{\\mathrm{params}}"}</M>, <M>{"h_{\\mathrm{meta}}"}</M> and the window, so a signature for one tuple does not
          verify for another. The record at the signed address holds bytes that hash to <M>{"h_{\\mathrm{meta}}"}</M> (5.5), and{" "}
          <C>launch</C> re-reads the mint's metadata and requires exactly those bytes. The bitmap prevents a second landed signature per leaf;
          the deterministic randomizer and the client's leaf ledger prevent a second revealed one.
        </p>
      </Proof>
      <p>
        Under <M>{"\\mathcal{A}_{\\mathrm{q}}"}</M>, an attacker can still create launches that <em>name</em> any identity, since{" "}
        <C>create_launch</C> is signed by an Ed25519 wallet; such a launch simply never goes live (the integration suite pins this:{" "}
        <C>a5_a_launch_naming_another_creators_identity_never_goes_live</C>). It can also launch under its <em>own</em> identity with any name and
        ticker. Origin is cryptographic, not reputational: users learn which identity a project uses the way they learn any public key.
      </p>
      <IdentityFigure />

      <H3 id="id-leaves" n="5.4">
        Leaves: the on-chain bitmap and the client's ledger
      </H3>
      <p>
        The bitmap records signatures that <em>landed</em>. A signature that was revealed (simulated, dropped, sent in a transaction that failed)
        leaves its bit clear, yet a second message at that leaf would hand an observer two signatures of one one-time key. The client therefore
        keeps a durable leaf ledger on a store with an atomic insert: the leaf is reserved for its message before the signature exists, the
        signature is recorded before it is returned, and recorded signatures are re-broadcast, never re-signed. The first leaf a message tries is
        fixed by the message itself, <M>{"\\mathit{start} = u16_{be}(\\mathrm{SHA256}(\\texttt{\"phalanx/pq/identity/leaf\"} \\| I \\| m)[0..2]) \\bmod 1024"}</M>,
        so a retry of the same message lands at the same leaf and two different messages rarely meet. One residual remains: two devices using one
        identity with two unshared ledgers put two messages on one leaf about once in 1,024 messages; the SDK's authenticated export and import of
        records narrows that window, and a single shared ledger closes it.
      </p>

      <H3 id="id-meta" n="5.5">
        The token's metadata, on-chain
      </H3>
      <p>
        A token's name, symbol, uri mode and document (description, a small PNG icon, links) are one record, <C>TokenMeta</C>, written whole by
        the permissionless <C>publish_metadata</C> while the launch is <C>Configured</C>, at the address of its own content's hash:
      </p>
      <Eq n="5.4">
        {"h_{\\mathrm{meta}} = \\mathrm{SHA256}(\\texttt{\"PHX-META-V2\"} \\,\\|\\, \\langle \\mathit{name} \\rangle \\,\\|\\, \\langle \\mathit{symbol} \\rangle \\,\\|\\, \\mathit{flags} \\,\\|\\, \\langle \\mathit{uri} \\rangle \\,\\|\\, \\langle \\mathit{doc} \\rangle)"}
      </Eq>
      <p>
        where <M>{"\\langle x \\rangle = u32_{le}(|x|) \\,\\|\\, x"}</M> over UTF-8 bytes, and the record lives at the launchpad address{" "}
        <M>{"\\mathrm{PDA}(\\texttt{\"metadata\"} \\| L \\| h_{\\mathrm{meta}})"}</M>. It is never modified or closed, and its size is exactly 91
        bytes plus the four strings' lengths, from 93 to 3,405 bytes, with the document at most 3,072 bytes. Publishing is idempotent (an existing record already holds exactly these
        bytes) and takes over an address someone pre-funded. Anyone may publish other records under a launch, each at its own address; they are
        inert, because <C>attest_launch</C> and <C>launch</C> only ever use the hash the identity signed, and readers must resolve a record the
        same way: through <C>Attestation.metadata_hash</C> before launch or <C>Certificate.metadata</C> after, never by searching a launch's
        records. A typical record of 1,244 bytes (a 672-byte PNG icon) costs 6,969,760 lamports of rent at mainnet's rate<Fn k="rent" />, published
        in a 1,460-byte version-1 transaction <Tag kind="final" />.
      </p>
      <Thm kind="Proposition" n="5.4" title="content addressing">
        <p>
          Nobody can place bytes other than those the identity signed at a signed record's address, except by finding a SHA-256 second preimage of
          the record's encoding.
        </p>
      </Thm>
      <Proof>
        <p>
          <C>publish_metadata</C> computes the address from the bytes it writes; the program rejects any other address for them. A record with
          different bytes at the signed address would need <M>{"\\mathrm{SHA256}(\\texttt{\"PHX-META-V2\"} \\| e') = h_{\\mathrm{meta}}"}</M> for an
          encoding <M>{"e' \\ne e"}</M>. The length prefixes make the encoding injective, so two different records never share an encoding.
        </p>
      </Proof>
      <p>
        The signed <C>flags</C> byte chooses what <C>launch</C> writes into the mint's Token-2022 <C>uri</C>: nothing by default, the document
        inline as a <C>data:</C> uri (RFC 4648 base64 <Cite k="rfc4648" />), or an <C>https</C> link of the creator's choosing (<XRef to="tab-meta" />).
        The mint holds the name and symbol itself, which every wallet and indexer shows. Icons in third-party wallets, however, come today from
        https-hosted JSON or from those wallets' own registries: no Solana token with a <C>data:</C> uri was found displaying anywhere, and the
        open-source DAS indexer stores uris in a <C>varchar(200)</C> column, so a longer uri may make it drop the token entirely <Cite k="das" />.
        The empty uri is the one value that indexer skips by design. Noised therefore defaults to it, the app shows the icon and description
        from the record (rendered only as an image of a PNG <Cite k="png" /> of at most 64 × 64 pixels and as text, never fetched), and the
        inline mode stays out of the app until a wallet and indexer check on mainnet shows such tokens listed everywhere ordinary ones are. That is
        a limit of the ecosystem, not of the record: the bytes are on-chain and signed either way.
      </p>
      <Table id="tab-meta" title="What the signed uri mode writes into the mint, and who shows the icon.">
        <thead>
          <tr>
            <th>Mode (flags)</th>
            <th>Mint uri</th>
            <th>Name and symbol</th>
            <th>Icon and description</th>
            <th>Depends on</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>none (0), the default</td>
            <td className="mono">""</td>
            <td>every wallet and indexer</td>
            <td>the Noised app, the SDK, any reader of the record</td>
            <td>nothing off-chain</td>
          </tr>
          <tr>
            <td>INLINE_URI (1)</td>
            <td className="mono">data:application/json;base64,… (≤ 4,125 B)</td>
            <td>wallets that list the token; an indexer with a 200-character column may not</td>
            <td>no wallet known to show it</td>
            <td>nothing off-chain; not offered by the app</td>
          </tr>
          <tr>
            <td>EXTERNAL_URI (2)</td>
            <td className="mono">https://… (9 to 200 B, printable ASCII)</td>
            <td>every wallet and indexer</td>
            <td>wallets that fetch the link</td>
            <td>DNS, TLS and a server; the content can change; not offered by the app</td>
          </tr>
        </tbody>
      </Table>
      <p>
        <C>launch</C> takes no arguments: it loads the record the attestation names, passes its name, symbol and derived uri to DBC, then re-reads
        the mint's metadata and requires exactly those values and no additional field (<C>MetadataMismatch</C>, which an honest DBC never
        triggers; it guards against an upgrade that altered the strings). The certificate sets bit 2048 (<C>METADATA_ONCHAIN</C>; all twelve
        checks are 4,095) and records the record's address.
      </p>
      <Table id="tab-identity" title="Proofs of origin compared.">
        <thead>
          <tr>
            <th />
            <th>Wallet-derived PQ identity</th>
            <th>Signature in off-chain metadata</th>
            <th>Noised identity</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Secret comes from</td>
            <td>A signature the wallet produces on request</td>
            <td>Any key, stored with the token's metadata</td>
            <td>Passkey PRF or a dedicated 24-word phrase; never a wallet</td>
          </tr>
          <tr>
            <td>Who else can get it</td>
            <td>Every app the user approves one signing request for</td>
            <td>Not secret: it is a published claim</td>
            <td>No one without the authenticator or phrase</td>
          </tr>
          <tr>
            <td>Checked by</td>
            <td>Client software</td>
            <td>Client software, if anyone</td>
            <td>The launchpad program, before the launch can go live</td>
          </tr>
          <tr>
            <td>After an elliptic-curve break</td>
            <td>Binding to the creator forgeable (Prop. 5.2 iii)</td>
            <td>Proves nothing on-chain; the token's keys and pool stay classical</td>
            <td>Unaffected: hash-based check on-chain; the wallet field has no power</td>
          </tr>
          <tr>
            <td>One-time state</td>
            <td>Client-side; a lost or forked state reuses a leaf</td>
            <td>Not applicable</td>
            <td>On-chain bitmap plus a durable client ledger; idempotent re-signing</td>
          </tr>
          <tr>
            <td>What it binds</td>
            <td>Whatever the client signs</td>
            <td>A document, available while hosted</td>
            <td>Launch, all parameters, the metadata record's every byte, window</td>
          </tr>
          <tr>
            <td>Where the proof lives</td>
            <td>Off-chain</td>
            <td>IPFS or another store</td>
            <td>On-chain, forever: attestation, record and certificate</td>
          </tr>
        </tbody>
      </Table>
      <Aside title="In one line">
        <p>
          A launch on Noised goes live only after a hash-based key, which no quantum computer can derive from public data, signs its exact terms
          and the hash of its on-chain metadata, and the chain itself checks that signature. <XRef to="tab-identity" /> is the comparison in full.
        </p>
      </Aside>
    </Section>
  );
}
