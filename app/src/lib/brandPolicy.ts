/**
 * Brand protection on this site: the ONE place to update.
 *
 * The launchpad has no admin key, so anyone can launch any name on Solana and nobody can delete a launch. What this
 * site shows is ours to decide: a launch that pretends to be Noised, or one we were told to hide, is left out of every
 * list on the site, and its own page warns people and offers no way to buy (selling stays possible, so nobody is
 * trapped). This is an app policy only: the SDK still lists every launch as it is.
 *
 * How the lists are used: ./brandGuard.ts.
 */

/**
 * Names nobody but the team may launch under. A launch's name or ticker matches when, after folding case, look-alike
 * letters (0 for o, 1 or l for i, Cyrillic and Greek letters, …), spaces, punctuation and invisible characters, it
 * contains one of these. Write them in plain lowercase a-z.
 */
export const RESERVED_BRANDS: readonly string[] = ["noised", "noisd"];

/** The team's own tokens: the only launches allowed to use a reserved name. */
export interface OfficialToken {
  /** The token's mint address. */
  mint: string;
  /** Its Launch account, if it is ever launched through Noised: lets the launch show before it opens. */
  launch?: string;
  /** How the site names it ("$NOISED"). */
  label: string;
}

/** Where to buy it, see its chart and look it up: plain links, each opened in a new tab (the site fetches none). */
export interface OfficialTokenLinks {
  /** Jupiter's swap page, SOL to the token. */
  buy: string;
  /** Its pool on DEX Screener. */
  chart: string;
  /** Its mint on Solscan. */
  explorer: string;
}

/**
 * The official Noised token, $NOISED: a classic SPL token (6 decimals, 1,000,000,000 supply, mint and freeze authority
 * revoked) launched on Meteora's dynamic bonding curve, not through the Noised launchpad. So it is not a QSL-1 token:
 * the site never says it is quantum-signed. The home page features it (components/landing/OfficialToken.tsx) and the
 * "Not affiliated" warning points to it.
 */
export const OFFICIAL_NOISED = {
  mint: "5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd",
  label: "$NOISED",
  name: "Noised",
  symbol: "NOISED",
  /** Its Meteora pool (where it trades). */
  pool: "7Xj1J43rn5VndyxjPmTjdX4yWUY8wmWm4szr3YKLr3QA",
  links: {
    buy: "https://jup.ag/swap/SOL-5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd",
    chart: "https://dexscreener.com/solana/7xj1j43rn5vndyxjpmtjdx4ywuy8wmwm4szr3yklr3qa",
    explorer: "https://solscan.io/token/5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd",
  },
} as const satisfies OfficialToken & { name: string; symbol: string; pool: string; links: OfficialTokenLinks };

/** "5oZbhx…noisd": the first six and the last five characters of the official mint (the warning's short form). */
export const OFFICIAL_NOISED_SHORT = `${OFFICIAL_NOISED.mint.slice(0, 6)}…${OFFICIAL_NOISED.mint.slice(-5)}`;

export const OFFICIAL_TOKENS: readonly OfficialToken[] = [
  // $NOISED (a vanity mint ending in "noisd"): live, launched outside the launchpad (above).
  { mint: OFFICIAL_NOISED.mint, label: OFFICIAL_NOISED.label },
];

/** Why a launch is hidden: it pretends to be Noised, or it was reported for something else. */
export type HiddenReason = "impersonation" | "reported";

/** A launch hidden from the site: listed by its Launch account, its mint, or both (either one is enough). */
export interface HiddenLaunch {
  launch?: string;
  mint?: string;
  reason: HiddenReason;
  /** For the team: what it is and when it was added. Never shown on the site. */
  note: string;
}

export const HIDDEN_LAUNCHES: readonly HiddenLaunch[] = [
  {
    launch: "977MBgvsevQKREoRWzh2NW6T9qxmmcqnzqVQikCyTfWb",
    mint: "DXdARQwZ4u1ymMeUbGwciuZrhwGqi2h191LSEd3uMqWf",
    reason: "impersonation",
    note: 'Mainnet, 2026-10-16: named "Noised" ($NOISED) by creator B2XFZS1oF95pMZRvFAFFYgDEG3SQHXh2C4XHK2ACryzp. Not the team\'s token.',
  },
];
