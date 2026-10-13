/**
 * The token's logo: drop or choose a picture, frame it (drag to move, a zoom slider; arrow keys and + / - on the
 * frame), and see exactly the icon that will be stored while you frame it: a smooth picture, up to 64 x 64, made as
 * good as the room next to the token's other details allows (./logoIcon.ts; never pixel art). "Use this logo" keeps
 * it; it is stored on Solana with the token's details (as a small PNG the quantum key signs with them).
 * "Make one for me" draws a pixel icon from the name; the pixel editor is one fold away.
 *
 * Canvas drawing and data: images only (no markup injection, no runtime styles: positions are CSSOM properties set by
 * React).
 */
import { ImageUp, Sparkles } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { Button } from "../../components/ui";
import { sfx } from "../../fx/sfx";
import { Details } from "../inner/kit";
import { LOGO_NO_ROOM, LOGO_TOO_DETAILED, type StoredIcon, type TokenMetaDraft } from "./draft";
import { CENTRED, cropSquare, cropToLogo, MAX_ZOOM, MIN_ZOOM, openPicture, panCrop, type Crop, type Picture } from "./logo";
import { LogoImage } from "./LogoImage";
import { LOGO_VARIANTS, type LogoFitter, type LogoIcon } from "./logoIcon";
import { IconCanvas, PixelIconEditor } from "./PixelIconEditor";
import { generateIcon, isBlank, seedOf, type IconDraft } from "./pixelIcon";

/** The frame's size on screen (CSS pixels). */
const VIEW = 224;

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether a logo's stored icon is less than the best (a smaller size or fewer colours, to fit). */
const simplified = (icon: LogoIcon): boolean => icon.variant !== LOGO_VARIANTS[0];

/** The stored icon in a few words (review rows). */
export function iconSummary(stored: StoredIcon | undefined): string {
  if (stored === undefined) return "Preparing…";
  if (stored.kind === "none") return "None (its address pattern is shown)";
  if (stored.kind === "pixel") return "32 x 32 pixel art";
  return stored.fits ? `Your picture, ${stored.logo.side} x ${stored.logo.side}` : "Your picture (it does not fit yet)";
}

export function LogoUpload({
  meta,
  stored,
  budget,
  onIcon,
  onLogo,
  name,
  symbol,
}: {
  meta: Pick<TokenMetaDraft, "icon" | "logo" | "description">;
  /** The icon the record stores now (the last one made). */
  stored: StoredIcon | undefined;
  /** Bytes the icon may take next to the token's other details (the logo is fitted to it). */
  budget: number;
  /** Pixel art, drawn or made for you (replaces an uploaded logo). */
  onIcon: (icon: IconDraft) => void;
  /** An uploaded picture (replaces the pixel art). */
  onLogo: (logo: LogoFitter) => void;
  name: string;
  symbol: string;
}): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fileRef = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop>(CENTRED);
  const [framed, setFramed] = useState<LogoFitter | null>(null);
  const [preview, setPreview] = useState<{ fitter: LogoFitter; icon: LogoIcon; fits: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const close = (): void => {
    setPicture(null);
    setFramed(null);
    setPreview(null);
  };

  const choose = (file: File | undefined): void => {
    if (!file) return;
    setBusy(true);
    setError(null);
    openPicture(file)
      .then((p) => {
        setPicture(p);
        setCrop(CENTRED);
        setFramed(null);
        setPreview(null);
        sfx.play("toggle");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "This image could not be used."))
      .finally(() => setBusy(false));
  };

  // The framed picture follows the frame (a short pause while it is being dragged)...
  useEffect(() => {
    if (picture === null) return;
    const t = window.setTimeout(() => {
      try {
        setFramed(cropToLogo(picture, crop));
      } catch (e) {
        setError(e instanceof Error ? e.message : "This image could not be used.");
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [picture, crop]);

  // ...and the preview is the icon it would be stored as, for the room there is now.
  useEffect(() => {
    if (framed === null) return;
    let alive = true;
    void (async () => {
      const fit = await framed.fit(budget);
      const icon = fit ?? (await framed.smallest());
      if (alive) setPreview({ fitter: framed, icon, fits: fit !== null });
    })().catch(() => {
      if (alive) setError("This image could not be used.");
    });
    return () => {
      alive = false;
    };
  }, [framed, budget]);

  const use = (): void => {
    if (preview === null) return;
    onLogo(preview.fitter);
    close();
    sfx.play("success");
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  const words = meta.description.trim() !== "";
  const blank = stored === undefined ? meta.logo === null && isBlank(meta.icon.pixels) : stored.kind === "none";
  const tag = `${symbol.trim() || "Token"} logo`;
  let face: ReactNode = <ImageUp aria-hidden="true" />;
  let line = "Drop a picture here, or choose one. You frame it next.";
  if (stored?.kind === "logo") {
    face = <LogoImage icon={stored.logo} size={96} label={`${tag}, ${stored.logo.side} by ${stored.logo.side} pixels`} />;
    line = stored.fits
      ? `Stored on Solana with your token, as a ${stored.logo.side} x ${stored.logo.side} picture${simplified(stored.logo) ? ", simplified a little so it fits" : ""}.`
      : "It does not fit on Solana next to your token's details yet (see below).";
  } else if (stored?.kind === "pixel") {
    face = <IconCanvas icon={meta.icon} size={96} label={`${tag}, 32 by 32 pixel art`} />;
    line = "Stored on Solana with your token, as 32 x 32 pixel art.";
  }
  return (
    <div className="lu" data-cropping={picture !== null ? "" : undefined}>
      <input
        ref={fileRef}
        id={`${id}-file`}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {picture === null ? (
        <div
          className="lu-drop px-corners"
          data-over={over ? "" : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="lu-icon" data-blank={blank ? "" : undefined}>
            {face}
          </span>
          <span className="lu-drop-text">
            <b>{blank ? "Add a logo" : "Your logo"}</b>
            <span>{line}</span>
          </span>
          <span className="lu-drop-btns">
            <Button size="sm" variant={blank ? "primary" : "secondary"} loading={busy} onClick={() => fileRef.current?.click()}>
              <ImageUp aria-hidden="true" /> {blank ? "Upload a logo" : "Change it"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onIcon(generateIcon(seedOf(`${name}#${symbol}#${Date.now()}`)));
                sfx.play("toggle");
              }}
            >
              <Sparkles aria-hidden="true" /> Make one for me
            </Button>
          </span>
        </div>
      ) : (
        <Cropper picture={picture} crop={crop} onCrop={setCrop} preview={preview} words={words} onUse={use} onCancel={close} onOther={() => fileRef.current?.click()} />
      )}
      {error !== null ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <Details summary="Or draw a pixel icon" className="lu-draw">
        <PixelIconEditor icon={meta.icon} onChange={onIcon} name={name} symbol={symbol} />
      </Details>
    </div>
  );
}

/** The frame: the picture's square at its zoom, draggable, with the icon it makes beside it (exactly as stored). */
function Cropper({
  picture,
  crop,
  onCrop,
  preview,
  words,
  onUse,
  onCancel,
  onOther,
}: {
  picture: Picture;
  crop: Crop;
  onCrop: (c: Crop) => void;
  preview: { icon: LogoIcon; fits: boolean } | null;
  /** The token has a description (what to shorten when the logo does not fit). */
  words: boolean;
  onUse: () => void;
  onCancel: () => void;
  onOther: () => void;
}): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);

  useLayoutEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(VIEW * dpr);
    if (c.width !== px) {
      c.width = px;
      c.height = px;
    }
    const { sx, sy, side } = cropSquare(picture.width, picture.height, crop);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(picture, sx, sy, side, side, 0, 0, px, px);
  }, [picture, crop]);

  const zoomTo = (z: number): void => onCrop(cropSquare(picture.width, picture.height, { ...crop, zoom: z }).crop);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 24 : 6;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      onCrop(panCrop(picture.width, picture.height, crop, m[0], m[1], VIEW));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomTo(Math.min(MAX_ZOOM, crop.zoom + 0.25));
    } else if (e.key === "-") {
      e.preventDefault();
      zoomTo(Math.max(MIN_ZOOM, crop.zoom - 0.25));
    } else if (e.key === "Enter") {
      e.preventDefault();
      onUse();
    }
  };
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    onCrop(panCrop(picture.width, picture.height, crop, dx, dy, VIEW));
  };
  const up = (): void => {
    drag.current = null;
  };

  const icon = preview?.icon ?? null;
  let note = "Your logo is kept on Solana itself, signed with your token's details.";
  if (preview !== null && icon !== null) {
    if (!preview.fits) note = `${capital(words ? LOGO_NO_ROOM : LOGO_TOO_DETAILED)}.`;
    else if (simplified(icon)) note = `Kept on Solana as a ${icon.side} x ${icon.side} picture, exactly as shown: simplified a little so it fits.`;
    else note = `Kept on Solana as a ${icon.side} x ${icon.side} picture, exactly as shown.`;
  }
  return (
    <div className="lu-crop glass">
      <div className="lu-frame-col">
        <div
          className="lu-frame px-corners"
          role="group"
          tabIndex={0}
          aria-label="Frame your logo: drag the picture or use the arrow keys to move it, + and - to zoom, Enter to use it"
          onKeyDown={onKey}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <canvas ref={canvas} className="lu-frame-img" aria-hidden="true" />
        </div>
        <label className="sl-label lu-zoom-label" htmlFor={`${id}-zoom`}>
          Zoom
        </label>
        <input
          id={`${id}-zoom`}
          className="lu-zoom"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={crop.zoom}
          aria-valuetext={`${crop.zoom.toFixed(2)} times`}
          onChange={(e) => zoomTo(Number(e.target.value))}
        />
      </div>
      <div className="lu-preview">
        <p className="pg-label">As your token&apos;s icon</p>
        <div className="lu-sizes" aria-hidden={icon === null ? "true" : undefined}>
          {icon !== null ? (
            <>
              <LogoImage icon={icon} size={128} className="lu-big" label={`Your logo as stored: ${icon.side} by ${icon.side} pixels`} />
              <LogoImage icon={icon} size={64} />
              <LogoImage icon={icon} size={32} />
            </>
          ) : (
            <span className="lu-wait">Preparing…</span>
          )}
        </div>
        <p className="lu-note" data-tone={preview !== null && !preview.fits ? "fail" : undefined} aria-live="polite">
          {note}
        </p>
        <div className="pg-btns">
          <Button size="sm" variant="primary" disabled={preview === null} onClick={onUse}>
            Use this logo
          </Button>
          <Button size="sm" variant="ghost" onClick={onOther}>
            Choose another
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
