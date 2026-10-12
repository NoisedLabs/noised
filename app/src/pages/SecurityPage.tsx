/**
 * Security (GLASS_V51 / SIMPLE_V4 §4: the honest technical page): what
 * protects a launch and what still depends on others, how to check a token,
 * the programs this site may call, this website itself, the connection, the
 * Content-Security-Policy, every party a launch still trusts and how to verify
 * all of it without this site. Plain English here (docs/SECURITY_GUARANTEES.md
 * in other words); deeper material lives in the docs and the whitepaper.
 * Also the 404 page.
 */
import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { chainClockOffset, useNow } from "../app/hooks";
import { useNetwork } from "../app/network";
import { CSP, CLUSTER, RPC_ENDPOINTS, useSettings } from "../app/settings";
import { openCommandPalette } from "../components/CommandPalette";
import { PROGRAM_ROWS, ProgramIdList } from "../components/ProgramIds";
import { Alert, Button } from "../components/ui";
import { ADAPTER_MODE, CLUSTERS, TRUSTED_PARTIES } from "../lib/noised";
import { CheckLine, Checks, Chip, CodeBlock, Comment, Compare, Details, Feats, Fold, Grad, LinkCards, Metric, PageHead, Panel, Readout, Row, Tiles, type CompareColumn, type FeatItem } from "./inner/kit";
import { PageArt } from "./inner/art";
import { DotGlyph } from "./inner/glyphs";
import { TrustFold } from "./inner/readouts";

/** What a launch's guarantees rest on: code and hash-based keys (left), people and classical keys (right). */
export const PROTECTION: readonly CompareColumn[] = [
  {
    title: "Protected by code",
    mark: "check",
    items: [
      { k: "Launch roles", v: "Held by program addresses. There is no private key to steal." },
      { k: "Token powers", v: "Nobody can mint more, freeze a holder or rename the token. These powers are switched off at launch and checked by the program." },
      { k: "Token details", v: "Name, symbol, picture and description are stored on Solana itself, signed by the creator. No link that could break or change." },
      { k: "Creator signature", v: "A launch goes live only after the creator's quantum key signs it. The program checks that signature itself." },
      { k: "Liquidity", v: "100% of graduated liquidity is locked forever under a program address." },
      { k: "Quantum vault", v: "Withdrawals need a one-time quantum-safe signature. There is no curve for a quantum computer to break." },
    ],
  },
  {
    title: "You still trust",
    mark: "alert",
    items: [
      { k: "Solana itself", v: "The network's validators decide the order of transactions, and their keys are not quantum-safe." },
      { k: "Solana's token programs", v: "Their maintainers can upgrade them." },
      { k: "Meteora's trading pools", v: "A group of 4 out of 7 people can upgrade them, and their operators set some fees." },
      { k: "Your wallet", v: "An ordinary wallet key is not quantum-safe. Keep long-term holdings in a quantum vault." },
      { k: "Your passkey's provider", v: "If you use a synced passkey for your quantum key, the company that syncs it." },
      { k: "Other tokens in your vault", v: "If a token has a freeze or pause power, its owner can delay your withdrawal, but never take it." },
      { k: "A token's Autopilot helpers", v: "If its creator named an operator, that wallet decides when its steps run, and how much, inside fixed limits. It can never move funds anywhere else." },
      { k: "Our upgrade key, for now", v: "Until the programs are made permanent, whoever holds it could replace them." },
      { k: "This site and your connection", v: "Check launches yourself before you commit." },
    ],
  },
];

/** How anyone checks a token, in three steps (the token page, the creator's signature, then without this site). */
export const CHECK_STEPS: readonly FeatItem[] = [
  {
    title: "Open the token's page",
    text: "Every check runs live against the chain. Green means it holds right now; one red check means stop.",
    icon: <DotGlyph name="book" />,
  },
  {
    title: "Look for the creator's signature",
    text: `Look for "Signed by the creator's quantum key" and "Metadata stored on-chain". Anyone can copy a name and a picture; nobody can copy that signature.`,
    icon: <DotGlyph name="key" />,
  },
  {
    title: "Check without this site",
    text: "Run the open-source SDK or the Solana command line yourself, against two different connections. An answer is only as honest as the server that gives it.",
    icon: <DotGlyph name="paper" />,
  },
];

/** The SDK's package name (kept out of the source's import lines: this page only shows the snippet). */
const SDK_PACKAGE = "@noisedlabs/sdk";

const SDK_SNIPPET = `import { PublicKey } from "@solana/web3.js";
import { verifyLaunch } from "${SDK_PACKAGE}";

// connection: a @solana/web3.js Connection to an RPC endpoint you choose
const report = await verifyLaunch(connection, new PublicKey(mint));
// reads the certificate at the launchpad PDA ["certificate", mint], then re-checks the live
// mint, DBC config, hook policy, metadata record and the creator's post-quantum signature
console.log(report.overall); // "pass" | "warn" | "fail"
for (const c of report.checks) console.log(c.status, c.label);
console.log(report.pqOrigin?.verified, report.metadata?.verified); // true, true`;

export function SecurityPage(): ReactNode {
  const directives = CSP.split("; ").map((d) => {
    const [name, ...values] = d.split(" ");
    return { name: name ?? "", values: values.join(" ") };
  });
  return (
    <div className="pg pg-security">
      <PageHead
        art={<PageArt scene="security" />}
        eyebrow="Security"
        title={
          <>
            Don't trust. <Grad>Verify.</Grad>
          </>
        }
        lede="What protects every Noised launch, what still depends on others, and how to check all of it yourself, without this site."
      >
        <div className="pg-btns">
          <Link to="/docs" className="btn btn-primary">
            Read the docs
            <span className="btn-arrow" data-dir="right" aria-hidden="true">
              →
            </span>
          </Link>
          <Link to="/whitepaper" className="btn btn-secondary">
            Read the whitepaper
          </Link>
        </div>
      </PageHead>

      <Tiles label="This site and its launches at a glance">
        <Metric label="Admin keys" value="0" hint="every launch role is held by a program" tone="ok" />
        <Metric label="Trackers" value="0" hint="no analytics of any kind" tone="ok" />
        <Metric label="Third-party code" value="0" hint="no outside scripts, styles, fonts or images" tone="ok" />
        <Metric label="Programs it can call" value={String(PROGRAM_ROWS.length)} hint="anything else is refused" />
      </Tiles>

      <Panel
        title="What protects a launch"
        description="Some guarantees come from math and code. Others still depend on people and older cryptography. We list both, because honesty is part of security."
      >
        <Compare columns={PROTECTION} />
      </Panel>

      <Panel
        id="check"
        title="How to check a token"
        description="Anyone can make a token with the same name and picture. Only the real one passes these checks."
      >
        <Feats items={CHECK_STEPS} label="How to check a token, in three steps" />
      </Panel>

      <Panel
        id="programs"
        title="Programs this site can call"
        description={`Before you sign, every transaction is simulated and its programs are listed. A transaction that calls any other program is refused. ${CLUSTERS[CLUSTER].label} build.`}
        status={<Chip tone={ADAPTER_MODE === "mock" ? "muted" : "ok"}>{ADAPTER_MODE === "mock" ? "Simulated chain" : CLUSTERS[CLUSTER].label}</Chip>}
      >
        <ProgramIdList full status />
        <Details summary="Check a program yourself">
          <CodeBlock title="Solana CLI" label="Show a program's upgrade authority">
            <pre>solana program show &lt;program id&gt;</pre>
          </CodeBlock>
          <Comment>It prints the program's upgrade authority: "none" means nobody can ever change the program.</Comment>
        </Details>
      </Panel>

      <div className="pg-cols">
        <Panel title="This website" description="A static bundle with a strict Content-Security-Policy.">
          <Checks label="What this website does and does not do">
            <CheckLine i={0} status="pass">
              No analytics, no third-party scripts, styles, fonts or images. Token pictures are read from the chain itself; nothing is fetched from a link.
            </CheckLine>
            <CheckLine i={1} status="pass">
              The page can connect only to the RPC endpoints listed here (the policy's connect-src is generated from them at build time).
            </CheckLine>
            <CheckLine i={2} status="pass">
              It never asks your wallet to sign a message, only transactions, each simulated and reviewed first.
            </CheckLine>
            <CheckLine i={3} status="pass">
              Your quantum key (recovery phrase or passkey) stays in memory and is never stored or sent. This browser keeps a record of every one-time key it used, so it never signs twice with one.
            </CheckLine>
            <CheckLine i={4} status="warn">
              Still, this site, its DNS and its hosting are trusted parties: verify launches independently (SDK or Solana CLI) before committing real money.
            </CheckLine>
          </Checks>
          {ADAPTER_MODE === "mock" ? <Alert tone="info">Demo mode: reads and transactions run against a simulated chain in this browser.</Alert> : null}
        </Panel>

        <Panel title="Connection" description="The RPC endpoint this page reads from and sends through.">
          <NetworkFacts />
        </Panel>
      </div>

      <Fold label="Content-Security-Policy" status={`${directives.length} directives`} id="csp">
        <Comment>What the browser lets this page load and connect to. Everything not listed is blocked.</Comment>
        <CodeBlock title="index.html · meta http-equiv=Content-Security-Policy" label="Content-Security-Policy">
          <dl className="pg-csp">
            {directives.map((d) => (
              <div key={d.name}>
                <dt>{d.name}</dt>
                <dd>{d.values}</dd>
              </div>
            ))}
          </dl>
        </CodeBlock>
      </Fold>

      <TrustFold parties={TRUSTED_PARTIES} />

      <Panel
        id="verify"
        title="Verify without this site"
        description="A launch's guarantees live on-chain. Anyone can re-check them with the open-source SDK or the Solana CLI."
      >
        <CodeBlock title="TypeScript · @noisedlabs/sdk" label="Verify a launch with the SDK">
          <pre>
            <CodeLines text={SDK_SNIPPET} />
          </pre>
        </CodeBlock>
        <p className="pg-text">
          A launch's certificate is written once, at launch, at the launchpad address <code>["certificate", mint]</code>. <code>verifyLaunch</code> does
          not take it on trust: it re-checks every claim against the live chain. The{" "}
          <Link to="/" className="link">
            launch list
          </Link>{" "}
          and every token page run the same report.
        </p>
      </Panel>

      <LinkCards
        label="Go deeper"
        items={[
          {
            to: "/docs",
            title: "Developer docs",
            text: "Install the SDK, verify any mint, launch a token, run a keeper, and read every program instruction.",
            icon: <DotGlyph name="book" />,
            cta: "Open the docs",
          },
          {
            to: "/whitepaper",
            title: "The whitepaper",
            text: "The threat model, hash-based signatures, the fair batch and every invariant, with the math and the measurements.",
            icon: <DotGlyph name="paper" />,
            cta: "Read the whitepaper",
          },
        ]}
      />
    </div>
  );
}

/** A code sample with its `//` comments dimmed (plain text; no HTML is ever parsed). */
function CodeLines({ text }: { text: string }): ReactNode {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const at = line.indexOf("//");
        return (
          <Fragment key={i}>
            {i > 0 ? "\n" : null}
            {at < 0 ? (
              line
            ) : (
              <>
                {line.slice(0, at)}
                <span className="pg-code-c">{line.slice(at)}</span>
              </>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** What this page knows about the selected endpoint: its cluster (genesis hash) and its clock; the endpoints this build allows. */
function NetworkFacts(): ReactNode {
  const { cluster, recheck } = useNetwork();
  const { endpoint, endpointIndex, setEndpointIndex } = useSettings();
  useNow();
  const offset = chainClockOffset();
  return (
    <>
      <Readout label="Selected endpoint">
        <Row k="Endpoint" wide>
          <span className="pg-strong">{endpoint.label}</span> <code className="pg-break">{endpoint.url}</code>
        </Row>
        <Row k="Network" wide tone={cluster === null ? undefined : cluster.state === "match" ? "ok" : cluster.state === "mismatch" ? "danger" : cluster.state === "unverified" ? undefined : "warn"}>
          {cluster === null
            ? "Checking…"
            : cluster.state === "match"
              ? "Verified by its genesis hash"
              : cluster.state === "mismatch"
                ? "WRONG CLUSTER: transactions are disabled"
                : cluster.state === "unverified"
                  ? "Not verifiable (local cluster or demo)"
                  : "Endpoint unreachable"}
          {cluster ? <span className="pg-small pg-net-detail">{cluster.detail}</span> : null}
        </Row>
        <Row k="Clock" wide>
          {offset === 0
            ? "This device's clock matches the network's."
            : `This device's clock is ${Math.abs(offset)} s ${offset > 0 ? "behind" : "ahead of"} the network's; countdowns and time windows on this site follow the network.`}
        </Row>
      </Readout>
      <div className="pg-btns">
        <Button size="sm" variant="secondary" onClick={recheck}>
          Check the network again
        </Button>
      </div>
      {RPC_ENDPOINTS.length > 1 ? (
        <div>
          <label className="label" htmlFor="rpc-endpoint">
            RPC endpoint
          </label>
          <select id="rpc-endpoint" className="select" value={endpointIndex} onChange={(e) => setEndpointIndex(Number(e.target.value))}>
            {RPC_ENDPOINTS.map((e, i) => (
              <option key={e.url} value={i}>
                {e.label}: {e.url}
              </option>
            ))}
          </select>
          <p className="help">This build can connect only to these endpoints. Pick one that keeps the full history if a vault search needs it.</p>
        </div>
      ) : (
        <Comment>
          This build allows one endpoint: <code>{RPC_ENDPOINTS[0]?.url ?? endpoint.url}</code>.
        </Comment>
      )}
    </>
  );
}

export function NotFoundPage(): ReactNode {
  const { pathname } = useLocation();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className="pg pg-notfound">
      <div className="pg-404">
        <PageHead
          eyebrow="Not found"
          title="This page doesn't exist"
          lede={
            <>
              Nothing lives at <code className="pg-404-path">#{pathname}</code>. The link may be old, or have a typo.
            </>
          }
        >
          <div className="pg-btns">
            <Link to="/" className="btn btn-primary">
              Back to launches
              <span className="btn-arrow" data-dir="right" aria-hidden="true">
                →
              </span>
            </Link>
            <Button variant="secondary" onClick={() => openCommandPalette()}>
              Search ({mac ? "⌘K" : "Ctrl K"})
            </Button>
            <Link to="/security" className="btn btn-ghost">
              Security
            </Link>
          </div>
        </PageHead>
        <span className="pg-404-num" aria-hidden="true">
          404
        </span>
      </div>
    </div>
  );
}
