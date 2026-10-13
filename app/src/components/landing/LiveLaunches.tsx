/**
 * Live launches (directly under the hero's three numbers): up to six glass cards (the token's pixel icon, plain
 * status, SOL raised, a segmented progress bar), most interesting first, and "View all" for the rest; the grid
 * resolves in from noise. Reads the page's launch list (one fetch for the whole page).
 */
import { ArrowRight } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { LAUNCHES_SOON } from "../../app/brand";
import type { AsyncState } from "../../app/hooks";
import { useLaunchesState } from "../../app/network";
import type { LaunchAccount, LaunchPhase } from "../../lib/noised";
import { LaunchCard, LaunchCardSkeleton } from "../launch";
import { Alert, Button } from "../ui";
import { useNoiseReveal } from "../../fx/noise";
import { SectionHead, useReveal } from "./glass";

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
  const soon = useLaunchesState() === "soon";
  const more = sorted.length > SHOWN;

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

      {loaded && sorted.length === 0 && !launches.error ? (
        soon ? (
          <div className="glass hm-live-empty">
            <h3 className="t-card-title hm-card-title">{LAUNCHES_SOON.title}.</h3>
            <p className="hm-card-text">{LAUNCHES_SOON.meanwhile}</p>
            <Link to="/vault" className="btn btn-primary btn-noglyph">
              Open your vault
            </Link>
          </div>
        ) : (
          <div className="glass hm-live-empty">
            <h3 className="t-card-title hm-card-title">No launches yet.</h3>
            <p className="hm-card-text">The first one could be yours.</p>
            <Link to="/create" className="btn btn-primary btn-noglyph">
              Launch a token
            </Link>
          </div>
        )
      ) : null}
    </section>
  );
}
