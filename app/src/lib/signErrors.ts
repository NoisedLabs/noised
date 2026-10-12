/**
 * Why the quantum key did not sign, in plain words (SDK 0.9.0, audit 4). Every
 * one of these refuses BEFORE anything is reserved or signed, so nothing is
 * lost by stopping:
 *
 *   - `UnknownLeavesError`: the key's record on Solana shows one-time
 *     signatures this browser never made. Another device or app holds this
 *     key, and a signature it made that has not landed yet is invisible here:
 *     signing again could meet it at the same one-time key, and two
 *     signatures of one one-time key can be forged. The fix is to bring that
 *     device's records in (the existing key-records import). Only for a SMALL
 *     count (`UNKNOWN_LEAVES_CONFIRM_MAX`), after the record was read again
 *     through a second network connection when the build has one, may the
 *     person confirm in writing (`CONFIRM_PHRASE`) that nothing unsent is left
 *     elsewhere; a large count is never confirmable here (a lying network
 *     connection would show exactly that);
 *   - `ClockSkewError`: this device's clock and the network's disagree, so a
 *     time the key signs could be one the person never chose. Nothing to
 *     confirm: fix the clock or use another network connection;
 *   - `SignatureCapError`: three earlier signatures never landed. One more
 *     needs an explicit confirmation (`acknowledgeExtraSignatures`).
 */
import { errorMessage } from "./format";
import { ClockSkewError, SignatureCapError, UnknownLeavesError, unixToIso, unixToUtcText } from "./noised";

/** The most unknown signatures the app ever lets the person confirm away (more is refused: import, or use a new key). */
export const UNKNOWN_LEAVES_CONFIRM_MAX = 3;

/** What the person types to confirm that no unsent signature of this key is left on another device. */
export const CONFIRM_PHRASE = "I have no unsent signatures elsewhere";

/** The one plain line the key screen shows about devices. */
export const ONE_DEVICE_LINE = "Use one device per quantum key unless you import its records.";

/** The plain explanation of `UnknownLeavesError`. */
export const UNKNOWN_LEAVES_TEXT = "This quantum key was used on another device or app. Import that device's records before signing again.";

/** A quantum signature the SDK refused, as the UI handles it. */
export type SignRefusal =
  | {
      kind: "unknown-leaves";
      /** Signatures on Solana that this browser's records do not know. */
      count: number;
      /** The identity (hex): the import and the confirmation are for it. */
      identityIdHex: string;
      message: string;
    }
  | { kind: "clock"; skewSecs: number; message: string }
  | { kind: "cap"; count: number; message: string };

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** "Your device clock and the network disagree by N seconds — fix your clock or try another network connection." */
export function clockSkewText(skewSecs: number | bigint): string {
  const n = Number(skewSecs);
  return `Your device clock and the network disagree by ${n.toLocaleString("en-US")} second${n === 1 ? "" : "s"} — fix your clock or try another network connection.`;
}

/** "N signatures this device doesn't know". */
export function unknownCountText(count: number): string {
  return `${count.toLocaleString("en-US")} signature${count === 1 ? "" : "s"} this device doesn't know`;
}

/** What `SignatureCapError` says, in plain words. */
export function signatureCapText(count: number): string {
  return `${count} earlier signature${count === 1 ? "" : "s"} of this launch never landed. Each one could still be sent by whoever holds it, so your key stops here unless you confirm one more.`;
}

/** The refusal behind `e` (null: not one of these). */
export function signRefusalOf(e: unknown): SignRefusal | null {
  if (e instanceof UnknownLeavesError) {
    return { kind: "unknown-leaves", count: e.unknownCount, identityIdHex: hex(e.identityId), message: `${UNKNOWN_LEAVES_TEXT} (${unknownCountText(e.unknownCount)}.)` };
  }
  if (e instanceof ClockSkewError) return { kind: "clock", skewSecs: Number(e.skewSecs), message: clockSkewText(e.skewSecs) };
  if (e instanceof SignatureCapError) return { kind: "cap", count: e.count, message: signatureCapText(e.count) };
  return null;
}

/** Plain words for any error of a signing path: the refusals above in their own words, anything else as it is. */
export function signErrorText(e: unknown): string {
  return signRefusalOf(e)?.message ?? errorMessage(e);
}

/** Whether the person may confirm `count` unknown signatures here (never more than `UNKNOWN_LEAVES_CONFIRM_MAX`). */
export const confirmable = (count: number): boolean => Number.isInteger(count) && count > 0 && count <= UNKNOWN_LEAVES_CONFIRM_MAX;

/** Whether the typed text is exactly the confirmation (spaces at the ends and letter case aside). */
export const confirmationMatches = (typed: string): boolean => typed.trim().toLowerCase() === CONFIRM_PHRASE.toLowerCase();

/** "2027-01-15 08:00 UTC" for unix seconds (the SDK's `unixToUtcText`). */
export const utcText = (secs: number | bigint): string => unixToUtcText(BigInt(Math.floor(Number(secs))));

/** "2027-01-15T08:00:00Z" for unix seconds (the SDK's `unixToIso`): a `<time dateTime>`. */
export const isoOf = (secs: number | bigint): string => unixToIso(BigInt(Math.floor(Number(secs))));
