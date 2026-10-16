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
  /** Its Launch account, once created: lets the launch show before it opens (when it has no mint yet). */
  launch?: string;
  /** How the site names it in the "not affiliated" warning ("$NOISED"). */
  label: string;
}

export const OFFICIAL_TOKENS: readonly OfficialToken[] = [
  // The team's $NOISED mint (a vanity address ending in "noisd"). Not launched yet: until a live launch has this mint,
  // the warning says that Noised has not launched a token.
  { mint: "5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd", label: "$NOISED" },
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
