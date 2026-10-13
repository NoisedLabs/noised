/**
 * What the Launch page shows instead of the launch forms while no launch can be created on this network
 * (app/network.tsx `LaunchesState`):
 *   - "soon": the launchpad's one-time setup has not run yet (no `Protocol` account), so every `create_launch` would
 *     fail. A plain "Launches open soon", and what already works without it (the vault, the Shield, Verify);
 *   - "checking": a short wait while that is read;
 *   - "unknown": the network could not be reached; "Try again" reads it again.
 * Plain words only (no protocol, account or RPC names). Nothing here signs or sends anything.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

import { LAUNCHES_SOON } from "../../app/brand";
import type { LaunchesState } from "../../app/network";
import { Button } from "../../components/ui";
import { DotSpinner } from "../../fx/noise";
import { Panel } from "../inner/kit";

export function LaunchGate({ state, onRetry }: { state: Exclude<LaunchesState, "open">; onRetry: () => void }): ReactNode {
  if (state === "checking") {
    return (
      <Panel className="cr-gate">
        <div className="pg-row">
          <DotSpinner size={24} label="Checking if launches are open" />
          <span>One moment…</span>
        </div>
      </Panel>
    );
  }
  if (state === "unknown") {
    return (
      <Panel className="cr-gate" title="Can't reach Solana right now" description="We couldn't check if launches are open. Nothing was signed or sent.">
        <div className="pg-btns">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </Panel>
    );
  }
  return (
    <Panel className="cr-gate" title={LAUNCHES_SOON.title} description={LAUNCHES_SOON.text}>
      <div className="pg-stack-sm">
        <p>{LAUNCHES_SOON.meanwhile}</p>
        <div className="pg-btns">
          <Link to="/vault" className="btn btn-primary btn-noglyph">
            Open your vault
          </Link>
          <Link to="/verify" className="btn btn-secondary btn-noglyph">
            Verify a token
          </Link>
        </div>
      </div>
    </Panel>
  );
}
