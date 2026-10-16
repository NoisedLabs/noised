/**
 * The red "Not affiliated with Noised" warning, at the top of the page of a launch the site hides (lib/brandGuard.ts):
 * one that uses the Noised name without being the team's, or one on the hidden list. Its last sentence points to the
 * team's own token, $NOISED (lib/brandPolicy.ts `OFFICIAL_NOISED`), with its full address, a copy button and its links.
 */
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { BrandFlag } from "../lib/brandGuard";
import { OFFICIAL_NOISED, OFFICIAL_NOISED_SHORT } from "../lib/brandPolicy";
import { OfficialTokenActions } from "./OfficialToken";
import "./brandWarning.css";

/** "The official $NOISED is 5oZbhx…noisd." */
export function OfficialSentence(): ReactNode {
  return (
    <>
      {" "}
      The official {OFFICIAL_NOISED.label} is{" "}
      <code className="brand-warn-addr" title={OFFICIAL_NOISED.mint} translate="no">
        {OFFICIAL_NOISED_SHORT}
      </code>
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
  return <BrandWarningView flag={flag} trading={trading} />;
}

/** The warning itself. */
export function BrandWarningView({ flag, trading }: { flag: BrandFlag; trading: boolean }): ReactNode {
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
              <OfficialSentence />
            </>
          ) : (
            "This token was reported to the Noised team, so it is hidden from this site's lists. Noised doesn't stand behind it."
          )}
        </p>
        {trading ? <p className="brand-warn-text">Buying is turned off here. If you already hold it, you can still sell it.</p> : null}
        {impersonation ? <OfficialTokenActions compact /> : null}
      </div>
    </div>
  );
}
