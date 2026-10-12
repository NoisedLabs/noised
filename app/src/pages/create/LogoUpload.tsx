/**
 * The quick launch's logo: drop or choose a picture, frame it (drag to move, a zoom slider; arrow keys and + / - on
 * the frame), and see it as the token's 32 x 32 pixel icon at real sizes while you frame it. "Use this logo" keeps the
 * icon; it is stored on Solana with the token's details (as a small PNG the quantum key signs with them).
 * "Make one for me" draws one from the name; the full pixel editor is one fold away.
 *
 * Canvas drawing only (no markup injection, no runtime styles: positions are CSSOM properties set by React).
 */
import { ImageUp, Sparkles } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { Button } from "../../components/ui";
import { sfx } from "../../fx/sfx";
import { Details } from "../inner/kit";
import { CENTRED, cropSquare, cropToIcon, MAX_ZOOM, MIN_ZOOM, openPicture, panCrop, type Crop, type Picture } from "./logo";
import { IconCanvas, PixelIconEditor } from "./PixelIconEditor";
import { generateIcon, isBlank, seedOf, type IconDraft } from "./pixelIcon";

/** The frame's size on screen (CSS pixels). */
const VIEW = 224;

export function LogoUpload({ icon, onChange, name, symbol }: { icon: IconDraft; onChange: (icon: IconDraft) => void; name: string; symbol: string }): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fileRef = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [crop, setCrop] = useState<Crop>(CENTRED);
  const [preview, setPreview] = useState<IconDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const choose = (file: File | undefined): void => {
    if (!file) return;
    setBusy(true);
    setError(null);
    openPicture(file)
      .then((p) => {
        setPicture(p);
        setCrop(CENTRED);
        sfx.play("toggle");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "This image could not be used."))
      .finally(() => setBusy(false));
  };

  // The pixel preview follows the frame (a short pause while it is being dragged).
  useEffect(() => {
    if (picture === null) return;
    const t = window.setTimeout(() => {
      try {
        setPreview(cropToIcon(picture, crop));
      } catch (e) {
        setError(e instanceof Error ? e.message : "This image could not be used.");
      }
    }, 90);
    return () => window.clearTimeout(t);
  }, [picture, crop]);

  const use = (): void => {
    if (preview === null) return;
    onChange(preview);
    setPicture(null);
    setPreview(null);
    sfx.play("success");
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  const blank = isBlank(icon.pixels);
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
            {blank ? <ImageUp aria-hidden="true" /> : <IconCanvas icon={icon} size={96} label={`${symbol.trim() || "Token"} logo, 32 by 32 pixels`} />}
          </span>
          <span className="lu-drop-text">
            <b>{blank ? "Add a logo" : "Your logo"}</b>
            <span>{blank ? "Drop a picture here, or choose one. You frame it next." : "Stored on Solana with your token, as 32 x 32 pixels."}</span>
          </span>
          <span className="lu-drop-btns">
            <Button size="sm" variant={blank ? "primary" : "secondary"} loading={busy} onClick={() => fileRef.current?.click()}>
              <ImageUp aria-hidden="true" /> {blank ? "Upload a logo" : "Change it"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange(generateIcon(seedOf(`${name}#${symbol}#${Date.now()}`)));
                sfx.play("toggle");
              }}
            >
              <Sparkles aria-hidden="true" /> Make one for me
            </Button>
          </span>
        </div>
      ) : (
        <Cropper picture={picture} crop={crop} onCrop={setCrop} preview={preview} onUse={use} onCancel={() => setPicture(null)} onOther={() => fileRef.current?.click()} />
      )}
      {error !== null ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <Details summary="Or draw it pixel by pixel" className="lu-draw">
        <PixelIconEditor icon={icon} onChange={onChange} name={name} symbol={symbol} />
      </Details>
    </div>
  );
}

/** The frame: the picture's square at its zoom, draggable, with the pixel icon it makes beside it. */
function Cropper({
  picture,
  crop,
  onCrop,
  preview,
  onUse,
  onCancel,
  onOther,
}: {
  picture: Picture;
  crop: Crop;
  onCrop: (c: Crop) => void;
  preview: IconDraft | null;
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
          <span className="lu-frame-grid" aria-hidden="true" />
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
        <div className="lu-sizes" aria-hidden={preview === null ? "true" : undefined}>
          {preview !== null ? (
            <>
              <IconCanvas icon={preview} size={96} className="lu-big" label="Your logo as a 32 by 32 pixel icon" />
              <IconCanvas icon={preview} size={64} />
              <IconCanvas icon={preview} size={32} />
            </>
          ) : (
            <span className="lu-wait">Shrinking…</span>
          )}
        </div>
        <p className="lu-note">32 x 32 pixels and up to 16 colours: small enough to keep on Solana itself, signed with your token&apos;s details.</p>
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
