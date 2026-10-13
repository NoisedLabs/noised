/**
 * How a token's own icon is drawn: an icon of at most 32 x 32 pixels is pixel art (drawn with the pixel editor, or an
 * older token's icon) and keeps its square pixels when it is scaled up; a bigger one (an uploaded logo, up to 64 x 64)
 * is a picture and scales smoothly. Owner's request, 2026-10-13: a logo must never look pixelated.
 */

/** The largest icon drawn pixel-crisp; anything bigger is smooth. */
export const PIXEL_ART_MAX_SIDE = 32;

const PNG_PREFIX = "data:image/png;base64,";

/**
 * The width of the PNG in a `data:image/png;base64,…` URI, from its header (IHDR), or null when it is not one. Decodes
 * only the first 24 bytes.
 */
export function pngDataUriWidth(uri: string): number | null {
  if (!uri.startsWith(PNG_PREFIX)) return null;
  try {
    const head = atob(uri.slice(PNG_PREFIX.length, PNG_PREFIX.length + 32));
    if (head.length < 24 || head.slice(12, 16) !== "IHDR") return null;
    return ((head.charCodeAt(16) << 24) | (head.charCodeAt(17) << 16) | (head.charCodeAt(18) << 8) | head.charCodeAt(19)) >>> 0;
  } catch {
    return null;
  }
}

/** Whether an icon this wide is pixel art (drawn crisp). Unknown widths are drawn smoothly. */
export const isPixelArt = (width: number | null): boolean => width !== null && width > 0 && width <= PIXEL_ART_MAX_SIDE;
