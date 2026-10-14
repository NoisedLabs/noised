/**
 * Live launches (directly under the hero's three numbers): up to six glass cards (the token's pixel icon, plain
 * status, SOL raised, a segmented progress bar), most interesting first, and "View all" for the rest; the grid
 * resolves in from noise. Reads the page's launch list (one fetch for the whole page).
 *
 * No launches yet (mainnet until launches open): one compact band instead of an empty board, saying launches open
 * soon and pointing to what already works (Vault, Verify), or, once launches are open, inviting the first one.
 */
import { ArrowRight } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { LAUNCHES_SOON } from "../../app/brand";
import type { AsyncState } from "../../app/hooks";
import { useLaunchesState, type LaunchesState } from "../../app/network";
import type { LaunchAccount, LaunchPhase } from "../../lib/noised";
import { LaunchCard, LaunchCardSkeleton } from "../launch";
import { Alert, Button } from "../ui";
import { NoiseArt, useNoiseReveal } from "../../fx/noise";
import { SectionHead, useReveal } from "./glass";
import { launchesIcon } from "./noise/stats";

const SHOWN = 6;
/** Most interesting first: open batches, then trading, then the rest. */
const ORDER: LaunchPhase[] = ["commit", "execute", "guarded", "open", "graduated", "configured"];

type Row = { launch: LaunchAccount; phase: LaunchPhase };

export function LiveLaunches({ launches, rows }: { launches: AsyncState<LaunchAccount[]>; rows: readonly Row[] }): ReactNode {
  const [all, setAll] = useState(false);
  const [ref, shown] = useReveal<HTMLElement>();
  const grid = useRef<HTMLUListElement>(null);
  useNoiseReveal(grid, { duration: 720, sweep: "down" });
  const loaded = launches.data !== undefined;
  const sorted = [...rows].sort((a, b) => {
    const byPhase = ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase);
    if (byPhase !== 0) return byPhase;
    return a.launch.launchTs === b.launch.launchTs ? 0 : a.launch.launchTs > b.launch.launchTs ? -1 : 1;
  });
  const visible = all ? sorted : sorted.slice(0, SHOWN);
  const state = useLaunchesState();
  const more = sorted.length > SHOWN;
  const empty = loaded && sorted.length === 0 && !launches.error;

  if (empty) {
    return (
      <section ref={ref} id="launches" className="hm-section hm-live" aria-labelledby="launches-title" data-empty="" data-in={shown ? "" : undefined}>
        <LaunchesEmpty state={state} />
      </section>
    );
  }

  return (
    <section ref={ref} id="launches" className="hm-section hm-live" aria-labelledby="launches-title" data-in={shown ? "" : undefined}>
      <SectionHead
        id="launches-title"
        title="Live"
        accent="launches"
        lead="Open any token to check it on-chain, right now."
        aside={
          more ? (
            <button type="button" className="btn btn-secondary hm-more" aria-expanded={all} aria-controls="launch-cards" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `View all ${sorted.length}`}
              <ArrowRight aria-hidden="true" />
            </button>
          ) : null
        }
      />

      {launches.error ? (
        <div className="hm-live-error">
          <Alert tone="warn" title="Launches couldn't load">
            {launches.error}
            <Button size="sm" onClick={launches.reload}>
              Try again
            </Button>
          </Alert>
        </div>
      ) : null}

      <ul ref={grid} id="launch-cards" className="hm-lc-grid" role="list" aria-label="Launches" aria-busy={!loaded && !launches.error}>
        {visible.map(({ launch, phase }, i) => (
          <LaunchCard key={launch.publicKey.toBase58()} launch={launch} phase={phase} index={i} />
        ))}
        {!loaded && !launches.error ? [0, 1, 2].map((i) => <LaunchCardSkeleton key={i} />) : null}
      </ul>
    </section>
  );
}

/**
 * The band shown while there is no launch: "Launches open soon" with Vault and Verify (until launches open, and while
 * that is being checked), or "No launches yet" with the way to start one. Its title names the section.
 */
export function LaunchesEmpty({ state }: { state: LaunchesState }): ReactNode {
  const band = useRef<HTMLDivElement>(null);
  useNoiseReveal(band, { duration: 700, sweep: "right" });
  const art = useMemo(() => launchesIcon(), []);
  const open = state === "open";
  return (
    <div ref={band} className="glass hm-soon" data-state={open ? "open" : "soon"}>
      <span className="hm-soon-art" aria-hidden="true">
        <NoiseArt scene={art} host={band} />
      </span>
      <div className="hm-soon-copy">
        <span className="hm-chip" data-tone="dim">
          <i className="ld-dot" aria-hidden="true" />
          Live launches
        </span>
        <h2 id="launches-title" className="hm-soon-title">
          {open ? "No launches yet." : `${LAUNCHES_SOON.title}.`}
        </h2>
        <p className="hm-card-text hm-soon-text">{open ? "The first one could be yours." : LAUNCHES_SOON.meanwhile}</p>
      </div>
      <div className="hm-soon-actions">
        {open ? (
          <Link to="/create" className="btn btn-primary btn-noglyph hm-more">
            Launch a token
            <ArrowRight aria-hidden="true" />
          </Link>
        ) : (
          <>
            <Link to="/vault" className="btn btn-primary btn-noglyph hm-more">
              Open your vault
              <ArrowRight aria-hidden="true" />
            </Link>
            <Link to="/verify" className="btn btn-secondary btn-noglyph">
              Verify a token
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
