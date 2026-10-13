/**
 * An uploaded logo as it is stored: drawn from the exact PNG that goes into the token's record, scaled smoothly (it is
 * a picture, not pixel art). A data: image (img-src data: under the CSP); never fetched.
 */
import type { ReactNode } from "react";

import { pngDataUri, type LogoIcon } from "./logoIcon";

export function LogoImage({ icon, size, className = "", label }: { icon: LogoIcon; size: number; className?: string; label?: string }): ReactNode {
  return (
    <img
      className={`lu-img ${className}`}
      src={pngDataUri(icon.png)}
      width={size}
      height={size}
      alt={label ?? ""}
      {...(label === undefined ? { "aria-hidden": true } : {})}
      decoding="async"
      draggable={false}
    />
  );
}
