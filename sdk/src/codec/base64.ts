/**
 * Standard base64 (RFC 4648 §4: the `A-Z a-z 0-9 + /` alphabet, `=`
 * padding), as the launchpad writes an inline uri (`base64.rs`) and as a
 * metadata document carries its icon. Decoding is strict: only canonical
 * input (padded, no whitespace, zero pad bits) decodes, so one byte string
 * has exactly one text form.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

/** Padded standard base64 of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Length of the padded base64 of `n` bytes: 4 characters per started group of 3. */
export function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4;
}

/**
 * The bytes of canonical padded base64 `text`, or `null` for anything else
 * (a character outside the alphabet, missing or extra padding, a length that
 * is not a multiple of 4, non-zero pad bits).
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const c = [0, 1, 2, 3].map((k) => (last && k >= 4 - pad ? 0 : VALUES.get(text[i + k]!)));
    if (c.some((v) => v === undefined)) return null;
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
    // Canonical: the bits the padding drops are zero.
    if (last && pad === 2 && (n & 0xffff) !== 0) return null;
    if (last && pad === 1 && (n & 0xff) !== 0) return null;
  }
  return out;
}
