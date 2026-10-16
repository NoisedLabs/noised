/**
 * Brand protection (an app policy; the lists live in ./brandPolicy.ts):
 *   - `matchesReservedBrand`: whether a name or ticker reads as "Noised" once case, look-alike letters, spaces,
 *     punctuation and invisible characters are folded away ("N0ISED", "Nоіsеd" in Cyrillic, "$NOISD", "OfficialNoised");
 *   - `brandFlag`: whether a launch is hidden on this site (the hidden list, or a reserved name on a mint that is not
 *     the team's);
 *   - `listListedLaunches`: every launch the site may list (the SDK's `listLaunches`, without the flagged ones).
 *     Every page that lists launches reads this, never `listLaunches` itself (test/brand-guard.test.ts checks it);
 *   - `reservedNameErrors`: the create forms' refusal of a reserved name or ticker.
 * The SDK is untouched: it still lists and reads every launch as it is on Solana.
 */
import type { Connection, PublicKey } from "@solana/web3.js";

import { HIDDEN_LAUNCHES, OFFICIAL_TOKENS, RESERVED_BRANDS, type HiddenReason, type OfficialToken } from "./brandPolicy";
import { fetchLaunchByMint, listLaunches, type LaunchAccount } from "./noised";

/** An address as the lists hold it (a PublicKey or its base58 text). */
type AddressLike = { toBase58(): string } | string | null | undefined;

const text = (a: AddressLike): string | null => (a === null || a === undefined ? null : typeof a === "string" ? a : a.toBase58());

// ----------------------------------------------------------- normalising ---

/**
 * Letters and digits that read as a Latin letter: Cyrillic, Greek, Armenian, Cherokee, Lisu, small capitals, IPA and
 * digits. Applied after Unicode compatibility folding (which already turns fullwidth, bold, circled and superscript
 * letters into plain ones) and after accents are dropped.
 */
const LOOKALIKES: Record<string, string> = {};
const fold = (to: string, from: string): void => {
  for (const ch of from) LOOKALIKES[ch] = to;
};
fold("a", "аАαΑɑ@4");
fold("c", "сСϲℂ");
fold("d", "ԁɗđĐɖðÐᴅꓓᎠᗪᑯ");
fold("e", "еЕєЄεΕɛҽᴇꓰᎬꭼ℮əәɘǝ3€");
fold("i", "іІιΙӏӀɪɩıǀꓲᎥꙇl1|¡!");
fold("n", "ΝνηɴոռИꓠƝɲƞŋᥒᑎ");
fold("o", "оОοΟσօөӨɵøØᴏⲟⲞꓳ0°○◯〇ዐᴑ๐০୦౦೦൦०٥");
fold("s", "ѕЅꜱʂƽꓢᏚꮪ5$§");
/** Symbols that also read as letters: mapped in one reading ("NOI$ED"), dropped in the other ("$NOISED"). */
const SYMBOLS = new Set([..."@€$§|¡!°○◯"]);

/** Letters drawn in a box, a circle or as flags (no compatibility form): 🅽🅾🅸🆂🅴🅳, 🅝, 🇳🇴. */
const LETTER_BLOCKS: readonly [number, number][] = [
  [0x1f150, 0x1f169], // negative circled A-Z
  [0x1f170, 0x1f189], // negative squared A-Z
  [0x1f1e6, 0x1f1ff], // regional indicators A-Z
];

function blockLetter(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [from, to] of LETTER_BLOCKS) if (cp >= from && cp <= to) return String.fromCharCode(97 + cp - from);
  return null;
}

/**
 * The readings of a name to compare with the reserved brands: plain lowercase a-z only. Two readings (symbols mapped
 * to the letters they look like, or dropped), each also with a "cl" that ends a word read as "d" ("Noisecl").
 */
export function brandReadings(raw: string): string[] {
  // Compatibility folding (fullwidth, bold, circled, superscript, ligatures), then accents and other marks dropped.
  const base = raw.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "");
  const out = new Set<string>();
  for (const src of [base, base.replace(/c[l1|Iӏ](?![a-z])/g, "d")]) {
    for (const mapSymbols of [true, false]) {
      let s = "";
      for (const ch of src) {
        if (!mapSymbols && SYMBOLS.has(ch)) continue;
        const block = blockLetter(ch);
        const mapped = block ?? LOOKALIKES[ch] ?? LOOKALIKES[ch.toLowerCase()] ?? ch.toLowerCase();
        // Spaces, punctuation, emoji and invisible characters (zero-width, joiners, direction marks, fillers) go.
        s += mapped.replace(/[^a-z]/g, "");
      }
      out.add(s);
    }
  }
  return [...out];
}

/** Whether a name or ticker reads as a reserved brand ("Noised", "NOISD", "N0ISED", "OfficialNoised", …). */
export function matchesReservedBrand(name: string | null | undefined): boolean {
  if (name === null || name === undefined || name === "") return false;
  return brandReadings(name).some((r) => RESERVED_BRANDS.some((b) => r.includes(b)));
}

// ----------------------------------------------------------------- flags ---

/** The hidden-list entry for a launch or mint address, if any. */
export function hiddenEntry(...addresses: AddressLike[]): { reason: HiddenReason } | null {
  const ids = addresses.map(text).filter((a): a is string => a !== null);
  return HIDDEN_LAUNCHES.find((h) => ids.some((id) => id === h.launch || id === h.mint)) ?? null;
}

/** The team's token with this launch or mint address, if it is one. */
export function officialToken(...addresses: AddressLike[]): OfficialToken | null {
  const ids = addresses.map(text).filter((a): a is string => a !== null);
  return OFFICIAL_TOKENS.find((o) => ids.some((id) => id === o.mint || (o.launch !== undefined && id === o.launch))) ?? null;
}

/** Why the site hides a launch: it uses the Noised name without being the team's, or it is on the hidden list. */
export interface BrandFlag {
  reason: HiddenReason;
}

/** What a launch is known by: its addresses and, when read, its name and ticker. */
export interface BrandSubject {
  launch?: AddressLike;
  mint?: AddressLike;
  name?: string | null | undefined;
  symbol?: string | null | undefined;
}

/**
 * Null when the site may show the launch as usual. A hidden-list entry always counts; a reserved name counts unless
 * the launch or its mint is the team's own.
 */
export function brandFlag(s: BrandSubject): BrandFlag | null {
  const hidden = hiddenEntry(s.launch, s.mint);
  if (hidden !== null) return { reason: hidden.reason };
  if (officialToken(s.launch, s.mint) !== null) return null;
  if (matchesReservedBrand(s.name) || matchesReservedBrand(s.symbol)) return { reason: "impersonation" };
  return null;
}

/** A launch's flag from what the list read of it (its pool's name and ticker). */
export function launchBrandFlag(l: LaunchAccount, meta?: { name: string; symbol: string } | null): BrandFlag | null {
  return (
    brandFlag({
      launch: l.publicKey,
      mint: l.baseMint,
      name: l.market?.name,
      symbol: l.market?.symbol,
    }) ??
    (meta === null || meta === undefined
      ? null
      : brandFlag({
          launch: l.publicKey,
          mint: l.baseMint,
          name: meta.name,
          symbol: meta.symbol,
        }))
  );
}

/** The launches the site may list: everything but the flagged ones. */
export function filterListed<T extends LaunchAccount>(launches: readonly T[]): T[] {
  return launches.filter((l) => launchBrandFlag(l) === null);
}

/** Every launch on this network the site may list (the SDK's `listLaunches`, without the flagged ones). */
export async function listListedLaunches(conn: Connection): Promise<LaunchAccount[]> {
  return filterListed(await listLaunches(conn));
}

/** A mint's flag, read from Solana when its address is not on the lists (its launch's name and ticker). */
export async function mintBrandFlag(conn: Connection, mint: PublicKey): Promise<BrandFlag | null> {
  const hidden = hiddenEntry(mint);
  if (hidden !== null) return { reason: hidden.reason };
  const launch = await fetchLaunchByMint(conn, mint);
  return launch === null ? null : launchBrandFlag(launch);
}

// ---------------------------------------------------------------- create ---

export const RESERVED_NAME_MESSAGE = "Noised is reserved for the official token. Pick another name.";
export const RESERVED_TICKER_MESSAGE = "Noised is reserved for the official token. Pick another ticker.";

/** The create forms' refusal, as validator errors ("name: …", "symbol: …"). There is no override on the site. */
export function reservedNameErrors(m: { name: string; symbol: string }): string[] {
  return [
    ...(matchesReservedBrand(m.name) ? [`name: ${RESERVED_NAME_MESSAGE}`] : []),
    ...(matchesReservedBrand(m.symbol) ? [`symbol: ${RESERVED_TICKER_MESSAGE}`] : []),
  ];
}
