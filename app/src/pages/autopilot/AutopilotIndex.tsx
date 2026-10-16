/**
 * #/autopilot: every launch and its Autopilot at a glance (running, a change
 * scheduled, frozen, or not set up), with steps anyone can run now.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";

import { useAsync } from "../../app/hooks";
import { ownTitle } from "../../app/titles";
import { Alert } from "../../components/ui";
import { DotSpinner } from "../../fx/noise";
import { formatSol } from "../../lib/amounts";
import { listListedLaunches } from "../../lib/brandGuard";
import { fetchAutopilot, findDueSteps, PROGRAMMABLE_AVAILABLE, type AutopilotInfo, type LaunchAccount } from "../../lib/noised";
import { Chip, Grad, PageHead } from "../inner/kit";
import { statusOf } from "./AutopilotPage";
import { NodeGlyph } from "./GraphCanvas";
import "./autopilot.css";
import "./autopilot-page.css";

interface Row {
  launch: LaunchAccount;
  info: AutopilotInfo | null;
  due: number;
}



export function AutopilotIndex(): ReactNode {
  const { connection } = useConnection();
  useEffect(() => {
    document.title = ownTitle("Autopilot");
  }, []);
  const rows = useAsync(async (): Promise<Row[]> => {
    const launches = await listListedLaunches(connection);
    return Promise.all(
      launches.map(async (launch) => {
        const info = await fetchAutopilot(connection, launch.publicKey);
        const due = info?.graphHash ? (await findDueSteps(connection, launch.publicKey)).length : 0;
        return { launch, info, due };
      }),
    );
  }, [connection]);
  const list = rows.data ?? [];
  const on = list.filter((r) => r.info !== null);
  const off = list.filter((r) => r.info === null);
  return (
    <div className="pg ap">
      <PageHead
        eyebrow="Autopilot"
        title={
          <>
            Tokens that <Grad>run themselves</Grad>
          </>
        }
        lede="Automatic buybacks, burns and payouts from a token's treasury, signed by its creator's quantum key. Anyone can run a step that is due and earn a small tip. An autopilot can never sell the token, touch the locked liquidity or mint."
      />
      {!PROGRAMMABLE_AVAILABLE ? (
        <Alert tone="info" title="Coming soon on this network">
          Autopilot is not live here yet. You can open any token's Autopilot to pick its jobs and try them in the simulation; the demo shows the whole flow.
        </Alert>
      ) : null}
      {rows.error ? <Alert tone="fail">Could not load the launches: {rows.error}</Alert> : null}
      {rows.data === undefined && !rows.error ? (
        <div className="pg-loading">
          <DotSpinner size={40} decorative />
          <p className="pg-wait" role="status">
            Reading the launches…
          </p>
        </div>
      ) : null}
      {on.length > 0 ? (
        <section aria-labelledby="ap-idx-on">
          <h2 id="ap-idx-on" className="ap-idx-h">
            With an autopilot
          </h2>
          <ul className="ap-idx">
            {on.map((r) => (
              <Card key={r.launch.publicKey.toBase58()} row={r} />
            ))}
          </ul>
        </section>
      ) : null}
      {off.length > 0 ? (
        <section aria-labelledby="ap-idx-off">
          <h2 id="ap-idx-off" className="ap-idx-h">
            No autopilot yet
          </h2>
          <ul className="ap-idx">
            {off.map((r) => (
              <Card key={r.launch.publicKey.toBase58()} row={r} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Card({ row }: { row: Row }): ReactNode {
  const { launch, info, due } = row;
  const symbol = launch.market?.symbol ?? "Not launched";
  const name = launch.market?.name ?? "Configured launch";
  const s = statusOf(info);
  const to = `/token/${(launch.status === "live" ? launch.baseMint : launch.publicKey).toBase58()}/autopilot`;
  return (
    <li>
      <Link to={to} className="ap-idx-card glass">
        <span className="ap-idx-top">
          <span className="ap-idx-sym">{symbol}</span>
          <Chip tone={s.tone} pulse={s.label === "Running"}>
            {s.label}
          </Chip>
        </span>
        <span className="ap-idx-name">{name}</span>
        <span className="ap-idx-facts">
          {info ? (
            <>
              <span>
                <NodeGlyph kind="buyback" /> Treasury {formatSol(info.treasurySol, 2)}
              </span>
              <span>
                <NodeGlyph kind="burn" /> {(Number(info.totalBurned) / 10 ** launch.tokenDecimal).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })} burned
              </span>
              {due > 0 ? <span className="ap-idx-due">{due} step{due === 1 ? "" : "s"} due: run it for a tip</span> : null}
            </>
          ) : (
            <span>Set one up →</span>
          )}
        </span>
      </Link>
    </li>
  );
}
