/**
 * The quick launch's logo: any picture, cropped to a square, shrunk to the token's 32 x 32, 16-colour icon (the same
 * icon pipeline as the pixel editor: pixelIcon.ts quantizes it, and the SDK's deterministic encoder makes the PNG that
 * is stored on Solana with the token's details).
 *
 * `cropSquare` is pure (tested); `cropToIcon` draws on a canvas (browser only). No markup injection: canvases only.
 */
import { ICON_MAX_COLORS, ICON_SIZE, quantizeRgba, withFullPalette, type IconDraft } from "./pixelIcon";

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

/** The cropped square of `img`, smoothly shrunk (in halves) and quantized to the 32 x 32, 16-colour icon. */
export function cropToIcon(img: Picture, c: Crop): IconDraft {
  const { sx, sy, side } = cropSquare(img.width, img.height, c);
  let src: CanvasImageSource = img;
  let x = sx;
  let y = sy;
  let s = side;
  // Halve until one more halving would go below twice the icon (a box filter each time: no aliasing).
  while (s / 2 >= ICON_SIZE * 2) {
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
  out.width = ICON_SIZE;
  out.height = ICON_SIZE;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot shrink images.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, x, y, s, s, 0, 0, ICON_SIZE, ICON_SIZE);
  return withFullPalette(quantizeRgba(ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data, ICON_MAX_COLORS));
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
