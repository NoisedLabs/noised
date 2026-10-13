/**
 * Framing an uploaded logo: any picture, cropped to a square and shrunk smoothly to a square master the token's icon
 * is made from (./logoIcon.ts turns it into the best smooth picture that fits on Solana, up to 64 x 64; never pixel art).
 *
 * `cropSquare` and `panCrop` are pure (tested); `cropToLogo` draws on a canvas (browser only). No markup injection:
 * canvases only.
 */
import { LogoFitter, LOGO_SIDES } from "./logoIcon";

/** Zoom bounds of the crop (1 = the largest square that fits the picture). */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Where the crop is: its centre as a fraction of the picture (0..1 each way) and its zoom. */
export interface Crop {
  cx: number;
  cy: number;
  zoom: number;
}

export const CENTRED: Crop = { cx: 0.5, cy: 0.5, zoom: 1 };

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The square of the picture a crop takes, in picture pixels: side = the shorter edge / zoom, centred on (cx, cy) and
 * kept inside the picture (the centre is moved in if the square would stick out).
 */
export function cropSquare(w: number, h: number, c: Crop): { sx: number; sy: number; side: number; crop: Crop } {
  if (!(w > 0 && h > 0)) return { sx: 0, sy: 0, side: 0, crop: CENTRED };
  const zoom = clamp(Number.isFinite(c.zoom) ? c.zoom : 1, MIN_ZOOM, MAX_ZOOM);
  const side = Math.min(w, h) / zoom;
  const half = side / 2;
  const x = clamp((Number.isFinite(c.cx) ? c.cx : 0.5) * w, half, w - half);
  const y = clamp((Number.isFinite(c.cy) ? c.cy : 0.5) * h, half, h - half);
  return { sx: x - half, sy: y - half, side, crop: { cx: x / w, cy: y / h, zoom } };
}

/** The crop moved by (dx, dy) screen pixels of a `view`-pixel square preview (dragging the picture moves it the other way). */
export function panCrop(w: number, h: number, c: Crop, dx: number, dy: number, view: number): Crop {
  const { side } = cropSquare(w, h, c);
  if (!(view > 0) || side === 0) return c;
  const k = side / view;
  return cropSquare(w, h, { ...c, cx: c.cx - (dx * k) / w, cy: c.cy - (dy * k) / h }).crop;
}

export type Picture = CanvasImageSource & { width: number; height: number };

/** The master's side: 4x the largest icon, so every icon size is an average of several picture pixels. */
export const MASTER_SIDE = 256;

/**
 * The cropped square of `img` as a logo: shrunk in halves (the browser's high-quality smoothing, which works on
 * premultiplied colours, so transparent edges stay clean) to a square master of MASTER_SIDE pixels (or the crop's own
 * size when it is smaller, but at least the largest icon), ready to be fitted (./logoIcon.ts).
 */
export function cropToLogo(img: Picture, c: Crop): LogoFitter {
  const { sx, sy, side } = cropSquare(img.width, img.height, c);
  const largest = Math.max(...LOGO_SIDES);
  const target = Math.max(largest, Math.min(MASTER_SIDE, Math.round(side)));
  let src: CanvasImageSource = img;
  let x = sx;
  let y = sy;
  let s = side;
  // Halve until one more halving would go below twice the master (a box filter each time: no aliasing).
  while (s / 2 >= target * 2) {
    const n = Math.max(1, Math.round(s / 2));
    const c2 = document.createElement("canvas");
    c2.width = n;
    c2.height = n;
    const cx = c2.getContext("2d");
    if (!cx) break;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(src, x, y, s, s, 0, 0, n, n);
    src = c2;
    x = 0;
    y = 0;
    s = n;
  }
  const out = document.createElement("canvas");
  out.width = target;
  out.height = target;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot shrink images.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, x, y, s, s, 0, 0, target, target);
  const data = ctx.getImageData(0, 0, target, target).data;
  return new LogoFitter({ rgba: new Uint8Array(data.buffer, data.byteOffset, data.length), side: target });
}

const MAX_UPLOAD = 8 * 1024 * 1024;

/** Opens a picture the person chose (PNG, JPEG, GIF or WebP, under 8 MB). */
export async function openPicture(file: File): Promise<Picture> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
  if (file.size > MAX_UPLOAD) throw new Error("Choose an image under 8 MB.");
  if (typeof createImageBitmap === "function") {
    try {
      const b = await createImageBitmap(file);
      if (b.width > 0 && b.height > 0) return b;
    } catch {
      // Some browsers refuse GIF or WebP bitmaps: the data: image below.
    }
  }
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => (typeof fr.result === "string" ? resolve(fr.result) : reject(new Error("Could not read the image.")));
    fr.onerror = () => reject(new Error("Could not read the image."));
    fr.readAsDataURL(file);
  });
  return await new Promise<Picture>((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.width > 0 && img.height > 0 ? resolve(img) : reject(new Error("This image is empty.")));
    img.onerror = () => reject(new Error("This image could not be opened."));
    img.src = url;
  });
}
