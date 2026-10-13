import type { PublicKey } from "@solana/web3.js";
import { useMemo, type CSSProperties, type ReactNode } from "react";

import { TRANSPARENT, type PixelIcon } from "../fx/pixel/quantize";
import { isPixelArt, pngDataUriWidth } from "./iconLook";

import "./landing/tokens.css";
import "./landing/board.css";
import "./tokenMeta.css";

/** Terminal palette the tiles draw from (CSS tokens, so both themes work). */
const INKS = ["--ld-signal", "--ld-phosphor", "--ld-amber", "--ld-violet", "--ld-ice", "--ld-rose", "--ld-text"] as const;

interface Cell {
  x: number;
  y: number;
  dim: boolean;
}

/** The mirrored 7x7 cells of an address (the same algorithm everywhere, so a mint looks the same on every page). */
export function identiconCells(address: PublicKey): { cells: Cell[]; ink: string } {
  const b = address.toBytes();
  const out: Cell[] = [];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 4; col++) {
      const byte = b[row * 4 + col] ?? 0;
      if ((byte & 3) === 0) continue;
      const dim = (byte & 4) !== 0;
      out.push({ x: col, y: row, dim });
      if (col < 3) out.push({ x: 6 - col, y: row, dim });
    }
  }
  // Never draw an empty tile.
  if (out.length < 4) out.push({ x: 3, y: 2, dim: false }, { x: 3, y: 3, dim: false }, { x: 3, y: 4, dim: false }, { x: 2, y: 3, dim: true }, { x: 4, y: 3, dim: true });
  return { cells: out, ink: INKS[(b[31] ?? 0) % INKS.length] ?? "--ld-signal" };
}

/**
 * A mirrored 7x7 pixel identicon drawn from an address: one ink from the
 * terminal palette, a dimmer second tone and a dark tile with crisp edges.
 * Token images from metadata URIs are never fetched (that would be a
 * third-party request), so this is how tokens are told apart at a glance;
 * it is not a trust signal.
 */
export function Identicon({
  address,
  size = 40,
  className = "",
  ink: forcedInk,
}: {
  address: PublicKey;
  size?: number;
  className?: string;
  /** Force the ink (a CSS custom property name, e.g. "--text-muted") instead of the address-derived one. */
  ink?: string | undefined;
}): ReactNode {
  const { cells, ink: derivedInk } = useMemo(() => identiconCells(address), [address]);
  const ink = forcedInk ?? derivedInk;
  return (
    <svg
      viewBox="0 0 9 9"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={`ld-identicon ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x + 1} y={c.y + 1} width="1" height="1" style={{ fill: `var(${ink})`, fillOpacity: c.dim ? 0.42 : 1 }} />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------ token icon ---

const HEX = /^#[0-9a-f]{6}$/i;

/** One SVG path per colour: a unit square per pixel. */
function pathsOf(cells: readonly { x: number; y: number; k: string }[]): { k: string; d: string }[] {
  const by = new Map<string, string[]>();
  for (const c of cells) {
    const list = by.get(c.k) ?? [];
    list.push(`M${c.x} ${c.y}h1v1h-1z`);
    by.set(c.k, list);
  }
  return [...by].map(([k, d]) => ({ k, d: d.join("") }));
}

/** The pixel coin: a 15 x 15 grid, a rim, a faint face and the address's 7x7 identicon in the middle. */
function coinPaths(address: PublicKey): { k: string; d: string }[] {
  const cells: { x: number; y: number; k: string }[] = [];
  const C = 7;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const d = Math.hypot(x - C, y - C);
      if (d > 7.35) continue;
      if (d > 6.2) cells.push({ x, y, k: x + y < 13 ? "rim-hi" : "rim" });
      else if (d > 5.3) cells.push({ x, y, k: "bevel" });
      else cells.push({ x, y, k: "body" });
    }
  }
  const { cells: ic } = identiconCells(address);
  for (const c of ic) cells.push({ x: c.x + 4, y: c.y + 4, k: c.dim ? "mark-dim" : "mark" });
  // Later cells win: drop face cells covered by the mark.
  const seen = new Map<string, { x: number; y: number; k: string }>();
  for (const c of cells) seen.set(`${c.x},${c.y}`, c);
  return pathsOf([...seen.values()]);
}

/** A token's own icon (fx/pixel PixelIcon: up to 32 x 32, <= 16 "#rrggbb" colours, TRANSPARENT = empty). */
function iconPaths(icon: PixelIcon): { k: string; d: string }[] | null {
  const n = icon.size;
  if (n < 1 || n > 32 || icon.pixels.length !== n * n || icon.palette.length > 16) return null;
  const cells: { x: number; y: number; k: string }[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = icon.pixels[y * n + x] ?? TRANSPARENT;
      const k = i === TRANSPARENT ? undefined : icon.palette[i];
      if (k && HEX.test(k)) cells.push({ x, y, k });
    }
  }
  return cells.length ? pathsOf(cells) : null;
}

/**
 * A launch's icon: its own icon when it has one (`image`: the PNG of its on-chain metadata record, as the data URI the
 * SDK's parser returns; or a `PixelIcon`, e.g. the demo's), else a pixel coin carrying its identicon. An uploaded logo
 * (bigger than 32 x 32) scales smoothly; pixel art (up to 32 x 32), the demo's icons and the coin stay crisp at any
 * whole size (./iconLook.ts; shape-rendering: crispEdges; image-rendering: pixelated). With `voxel`, the coin gets edge
 * layers so a CSS 3D spin (sections.css, on card hover) shows a solid voxel coin. Decorative (aria-hidden).
 */
export function TokenIcon({
  address,
  icon,
  image = null,
  size = 40,
  voxel = false,
  className = "",
}: {
  address: PublicKey;
  icon?: PixelIcon | null | undefined;
  /** `data:image/png;base64,…` from the token's record (never a remote URL). */
  image?: string | null | undefined;
  size?: number;
  voxel?: boolean;
  className?: string;
}): ReactNode {
  const own = image !== null && image.startsWith("data:image/png;base64,") ? image : null;
  const pixel = useMemo(() => (own === null ? false : isPixelArt(pngDataUriWidth(own))), [own]);
  const custom = useMemo(() => (own === null && icon ? iconPaths(icon) : null), [own, icon]);
  const coin = useMemo(() => (own !== null || custom ? null : coinPaths(address)), [own, custom, address]);
  const view = custom && icon ? `0 0 ${icon.size} ${icon.size}` : "0 0 15 15";
  const face =
    own !== null ? (
      <img className="tk-face tk-img" data-pixel={pixel ? "" : undefined} src={own} width={size} height={size} alt="" aria-hidden="true" decoding="async" draggable={false} />
    ) : (
      <svg viewBox={view} width={size} height={size} shapeRendering="crispEdges" className="tk-face" aria-hidden="true" focusable="false">
        {(custom ?? coin ?? []).map((p) => (
          <path key={p.k} d={p.d} className={custom ? undefined : `tk-${p.k}`} fill={custom ? p.k : undefined} />
        ))}
      </svg>
    );
  if (!voxel) return <span className={`tk ${className}`}>{face}</span>;
  return (
    <span className={`tk tk-voxel ${className}`} data-shape={own !== null || custom ? "square" : "coin"} style={{ ["--tk-size" as string]: `${size}px` } as CSSProperties}>
      <span className="tk-spin">
        <span className="tk-edge" />
        <span className="tk-edge" />
        <span className="tk-edge" />
        <span className="tk-side tk-front">{face}</span>
        <span className="tk-side tk-back">{face}</span>
      </span>
    </span>
  );
}
