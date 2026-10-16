/**
 * The red "Not affiliated with Noised" warning, at the top of the page of a launch the site hides (lib/brandGuard.ts):
 * one that uses the Noised name without being the team's, or one on the hidden list. Its last sentence follows the
 * team's own token (lib/brandPolicy.ts): "Noised hasn't launched a token yet" until a live launch has the official
 * mint, then a link to it.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { useAsync } from "../app/hooks";
import type { BrandFlag } from "../lib/brandGuard";
import { OFFICIAL_TOKENS, type OfficialToken } from "../lib/brandPolicy";
import { fetchLaunchByMint } from "../lib/noised";
import "./brandWarning.css";

/** The team's token when one of the official mints has a live launch; null when none has; undefined while reading. */
export function useOfficialToken(): OfficialToken | null | undefined {
  const { connection } = useConnection();
  const r = useAsync(
    async () => {
      for (const o of OFFICIAL_TOKENS) {
        const launch = await fetchLaunchByMint(connection, new PublicKey(o.mint));
        if (launch !== null && launch.status === "live") return o;
      }
      return null;
    },
    [connection],
    { watchChain: false },
  );
  return r.error ? null : r.data;
}

/** The sentence about the team's own token. */
function Official(): ReactNode {
  const official = useOfficialToken();
  if (official === undefined) return null;
  if (official === null) return <> Noised hasn&apos;t launched a token yet.</>;
  return (
    <>
      {" "}
      The official Noised token is{" "}
      <Link to={`/token/${official.mint}`} className="link">
        {official.label}
      </Link>
      .
    </>
  );
}

/**
 * Nothing when `flag` is null. `trading`: say that buying is off on this site and selling still works (the token
 * page); off where nothing can be bought (Verify).
 */
export function BrandWarning({ flag, trading = false }: { flag: BrandFlag | null; trading?: boolean }): ReactNode {
  if (flag === null) return null;
  const impersonation = flag.reason === "impersonation";
  return (
    <div className="brand-warn" role="alert" data-reason={flag.reason}>
      <ShieldAlert className="brand-warn-icon" aria-hidden="true" />
      <div className="brand-warn-body">
        <p className="brand-warn-title">{impersonation ? "Not affiliated with Noised." : "Hidden on Noised."}</p>
        <p className="brand-warn-text">
          {impersonation ? (
            <>
              This token uses the Noised name but wasn&apos;t launched by the Noised team.
              <Official />
            </>
          ) : (
            "This token was reported to the Noised team, so it is hidden from this site's lists. Noised doesn't stand behind it."
          )}
        </p>
        {trading ? <p className="brand-warn-text">Buying is turned off here. If you already hold it, you can still sell it.</p> : null}
      </div>
    </div>
  );
}
