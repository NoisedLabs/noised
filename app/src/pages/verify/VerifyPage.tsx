/**
 * Verify (LAYER_V1 §B.1, §B.3): paste any token's address and see, in plain words, what QSL-1 guarantees for it,
 * checked on Solana right now (`checkQsl1`). The address lives in the route (/verify/<mint>), so a result can be
 * shared. Without one: the two levels, the "programmable" tag (not a level) and a few live launches to try.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ArrowRight } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { useAsync } from "../../app/hooks";
import { ownTitle } from "../../app/titles";
import { QslMark } from "../../components/qsl/QslBadge";
import { sfx } from "../../fx/sfx";
import { shortKey } from "../../lib/format";
import { checkQsl1, fetchLaunchByMint, listLaunches } from "../../lib/noised";
import { LEVELS, PROGRAMMABLE_MEANS } from "../../lib/qsl";
import { PageArt } from "../inner/art";
import { Grad, PageHead, Panel } from "../inner/kit";
import { TrustFold } from "../inner/readouts";
import { QslReport, scrollToId } from "./QslReport";
import "../../components/qsl/qsl.css";
import "./verify.css";

export function VerifyPage(): ReactNode {
  const { address = "" } = useParams();
  let mint: PublicKey | null = null;
  try {
    mint = address === "" ? null : new PublicKey(address);
  } catch {
    mint = null;
  }
  return (
    <div className="pg vf">
      <PageHead
        art={<PageArt scene="verify" />}
        eyebrow="Verify"
        title={
          <>
            Check any <Grad>token</Grad>
          </>
        }
        lede="Paste a token's address. Noised checks it on Solana right now against QSL-1, an open safety standard, and tells you in plain words what is guaranteed and what is not."
      />
      <VerifyForm initial={address} invalid={address !== "" && mint === null} />
      {mint !== null ? <VerifyResult key={mint.toBase58()} mint={mint} /> : <VerifyIntro />}
    </div>
  );
}

function VerifyForm({ initial, invalid }: { initial: string; invalid: boolean }): ReactNode {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(invalid ? "That doesn't look like a token address." : null);
  useEffect(() => setValue(initial), [initial]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    try {
      const key = new PublicKey(value.trim());
      setError(null);
      sfx.play("click");
      navigate(`/verify/${key.toBase58()}`);
    } catch {
      sfx.play("error");
      setError("That doesn't look like a token address. Copy it from the token's page or your wallet and try again.");
    }
  };
  return (
    <form className="vf-form glass" role="search" onSubmit={submit} data-invalid={error !== null ? "" : undefined}>
      <label htmlFor="vf-input" className="sr-only">
        Token address
      </label>
      <svg className="vf-form-icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </svg>
      <input
        id="vf-input"
        className="vf-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder="Paste a token address"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? "vf-error" : undefined}
      />
      <button type="submit" className="btn btn-primary vf-go" disabled={value.trim() === ""}>
        Check
      </button>
      {error !== null ? (
        <p id="vf-error" className="vf-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function VerifyResult({ mint }: { mint: PublicKey }): ReactNode {
  const { connection } = useConnection();
  const verdict = useAsync(() => checkQsl1(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  const launch = useAsync(() => fetchLaunchByMint(connection, mint), [connection, mint.toBase58()], { watchChain: false });
  const name = launch.data?.market?.name ?? null;
  const symbol = launch.data?.market?.symbol ?? null;
  useEffect(() => {
    document.title = ownTitle(`Verify ${symbol ?? shortKey(mint.toBase58(), 4)}`);
  }, [symbol, mint]);
  // "read its rules" from a badge elsewhere (/verify/<mint>#rules): the rules and their warnings, once checked.
  const { hash } = useLocation();
  const hasRules = verdict.data?.programmable != null;
  useEffect(() => {
    if (hash === "#rules" && hasRules) scrollToId("qsl-rules");
  }, [hash, hasRules]);
  return (
    <div className="pg-stack-lg vf-result">
      {launch.data ? (
        <div className="vf-token">
          <span className="vf-token-t">
            {name ?? "This token"}
            {symbol !== null ? <span className="vf-token-sym">{symbol}</span> : null}
          </span>
          <Link to={`/token/${mint.toBase58()}`} className="btn btn-secondary btn-noglyph vf-token-go">
            Open the token
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      ) : null}
      <QslReport verdict={verdict.data} loading={verdict.loading} error={verdict.error} onRefresh={verdict.reload} />
      {verdict.data?.certified ? <TrustFold parties={verdict.data.trusted} /> : null}
    </div>
  );
}

/** No address yet: the two levels, the programmable tag, and live launches to try. */
function VerifyIntro(): ReactNode {
  const { connection } = useConnection();
  const launches = useAsync(() => listLaunches(connection), [connection], { watchChain: false });
  const live = (launches.data ?? []).filter((l) => l.status === "live").slice(0, 6);
  return (
    <div className="pg-stack-lg">
      <ol className="vf-levels" aria-label="QSL-1 levels">
        {LEVELS.map((l) => (
          <li key={l.level} className="glass vf-level">
            <QslMark pips={l.level} tone={l.level === 2 ? "attested" : "norug"} size={5} />
            <p className="vf-level-n">Level {l.level}</p>
            <h2 className="vf-level-name">{l.name}</h2>
            <p className="vf-level-line">{l.line}</p>
          </li>
        ))}
        {/* Not a level: a tag next to one, when the creator added launch rules or automation. */}
        <li className="glass vf-level vf-level-tag" aria-label="Not a level: the programmable tag">
          <span className="qsl-tag" data-tone="neutral">
            programmable
          </span>
          <p className="vf-level-n">A tag, not a level</p>
          <h2 className="vf-level-name">Programmable</h2>
          <p className="vf-level-line">{PROGRAMMABLE_MEANS} The check lists every rule in plain words, with warnings.</p>
        </li>
      </ol>
      {live.length > 0 ? (
        <Panel title="Try one" description="Live launches on this network. Each check reads Solana directly.">
          <ul className="vf-try">
            {live.map((l) => (
              <li key={l.baseMint.toBase58()}>
                <Link to={`/verify/${l.baseMint.toBase58()}`} className="vf-try-a">
                  <span>{l.market?.symbol ?? shortKey(l.baseMint, 4)}</span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <p className="vf-foot">
        QSL-1 is open: anyone can check a token the same way, without this site.{" "}
        <Link to="/docs/standard/qsl-1" className="link">
          Read the standard
        </Link>
        .
      </p>
    </div>
  );
}
