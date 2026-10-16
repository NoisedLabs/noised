/**
 * The official Noised token, $NOISED (lib/brandPolicy.ts `OFFICIAL_NOISED`): its full contract address with a copy
 * button, and three plain links (Buy on Jupiter, its chart on DEX Screener, its page on Solscan), each opened in a new
 * tab without an opener or a referrer. Nothing is fetched: the mark is the site's own image, the links are only links.
 * No price, no market cap, no promises.
 *
 *   <OfficialTokenBar ref={token} />        // the home hero, above the headline
 *   <OfficialTokenActions compact />        // the "Not affiliated" warning: the address, copy and the links
 *
 * $NOISED was launched on Meteora, not through the Noised launchpad: nothing here calls it quantum-signed or QSL-1.
 */
import { ArrowUpRight, BadgeCheck, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { BRAND_MARK } from "../app/brand";
import { sfx } from "../fx/sfx";
import { OFFICIAL_NOISED } from "../lib/brandPolicy";
import { copyText, manualCopyHint, selectContents } from "../lib/clipboard";
import "./officialToken.css";

/** The three links, in order: what each says, and what a screen reader hears after it. */
export const OFFICIAL_LINKS = [
  { id: "buy", label: "Buy", more: `${OFFICIAL_NOISED.label} on Jupiter, opens in a new tab`, href: OFFICIAL_NOISED.links.buy },
  { id: "chart", label: "Chart", more: "on DEX Screener, opens in a new tab", href: OFFICIAL_NOISED.links.chart },
  { id: "explorer", label: "Explorer", more: "Solscan, opens in a new tab", href: OFFICIAL_NOISED.links.explorer },
] as const;

/** The home hero's "Official token" bar: the mark, "$NOISED · Official token", the address with Copy, and the links. */
export function OfficialTokenBar({ ref }: { ref?: Ref<HTMLDivElement> }): ReactNode {
  return (
    <div ref={ref} className="ot" role="group" aria-labelledby="ot-name">
      <p className="ot-id" id="ot-name">
        <OfficialMark />
        <strong className="ot-symbol">{OFFICIAL_NOISED.label}</strong>
        <span className="ot-sep" aria-hidden="true">
          ·
        </span>
        <span className="ot-badge">
          <BadgeCheck className="ot-badge-icon" aria-hidden="true" />
          Official token
        </span>
      </p>
      <OfficialTokenActions />
    </div>
  );
}

/** The full address with its copy button, then Buy, Chart and Explorer. `compact`: smaller, for the warning box. */
export function OfficialTokenActions({ compact = false }: { compact?: boolean }): ReactNode {
  return (
    <div className="ot-actions" data-compact={compact ? "" : undefined}>
      <CopyAddress />
      <ul className="ot-links" aria-label={`${OFFICIAL_NOISED.label} links`}>
        {OFFICIAL_LINKS.map((l) => (
          <li key={l.id}>
            <a className="ot-link" href={l.href} target="_blank" rel="noopener noreferrer" data-link={l.id} onClick={() => sfx.play("click")}>
              <span>{l.label}</span>
              <span className="sr-only"> ({l.more})</span>
              <ArrowUpRight className="ot-link-icon" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type CopyState = "idle" | "copied" | "manual";

/**
 * What the Copy button does: puts the full official mint on the clipboard ("copied"), or, when the browser refuses,
 * selects the address on the page for the visitor to copy ("manual").
 */
export async function copyOfficialMint(select: () => void): Promise<CopyState> {
  if (await copyText(OFFICIAL_NOISED.mint)) return "copied";
  select();
  return "manual";
}

/** The mint in Geist Mono and a Copy button. If the browser refuses to copy, the address is selected instead. */
function CopyAddress(): ReactNode {
  const code = useRef<HTMLElement>(null);
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), state === "copied" ? 1800 : 5000);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async (): Promise<void> => {
    const next = await copyOfficialMint(() => selectContents(code.current));
    if (next === "copied") sfx.play("click");
    setState(next);
  };
  return (
    <div className="ot-ca">
      <span className="sr-only">Contract address: </span>
      <code ref={code} className="ot-addr" translate="no">
        {OFFICIAL_NOISED.mint}
      </code>
      <button
        type="button"
        className="ot-copy"
        data-state={state}
        onClick={() => void copy()}
        aria-label={state === "copied" ? `Copied the ${OFFICIAL_NOISED.label} address` : `Copy the ${OFFICIAL_NOISED.label} address`}
      >
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span className="ot-copy-label" aria-hidden="true">
          {state === "copied" ? "Copied" : "Copy"}
        </span>
      </button>
      <p className="ot-hint" role="status" aria-live="polite">
        {state === "manual" ? <span className="ot-hint-text">{manualCopyHint()}</span> : state === "copied" ? <span className="sr-only">Copied to the clipboard.</span> : null}
      </p>
    </div>
  );
}

/** The Noised mark (the site's own files, one per theme), as the token's picture. Decorative: the text names it. */
function OfficialMark(): ReactNode {
  return (
    <span className="ot-mark" aria-hidden="true">
      {(["light", "dark"] as const).map((tone) => (
        <img
          key={tone}
          className="ot-mark-img"
          data-tone={tone}
          src={BRAND_MARK[tone][0]}
          srcSet={BRAND_MARK[tone].map((f, i) => `${f} ${i + 1}x`).join(", ")}
          width={BRAND_MARK.size}
          height={BRAND_MARK.size}
          alt=""
          decoding="async"
          draggable={false}
        />
      ))}
    </span>
  );
}
