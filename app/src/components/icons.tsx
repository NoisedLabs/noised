/**
 * Inline SVG icons (stroke = currentColor), TERMINAL v2 geometry: square caps,
 * mitred joins, no rounded corners, 1.6px stroke on a 24 grid. Decorative
 * unless a title is given. Same export names as before.
 */
import type { ReactNode } from "react";

interface IconProps {
  className?: string;
  title?: string;
}

function Svg({ className, title, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className ?? "h-4 w-4"}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : "img"}
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

export const ShieldIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />
  </Svg>
);
export const CheckIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="m5 12.5 4.2 4.2L19 7" />
  </Svg>
);
export const WarnIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M12 4 2.8 19.5h18.4L12 4Z" />
    <path d="M12 10v4M12 17v.5" />
  </Svg>
);
export const FailIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 4h16v16H4z" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </Svg>
);
export const InfoIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 4h16v16H4z" />
    <path d="M12 11v5M12 8v.5" />
  </Svg>
);
export const CopyIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M9 9h10.5v10.5H9z" />
    <path d="M15 9V4.5H4.5V15H9" />
  </Svg>
);
export const ExternalIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v6H4V7h6" />
  </Svg>
);
export const SunIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M8 8h8v8H8z" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Svg>
);
export const MoonIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Svg>
);
export const WalletIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 7.5V5h14v3" />
    <path d="M4 8h16.5v11H4z" />
    <path d="M16 13.5h.5" />
  </Svg>
);
export const ClockIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const LockIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M5 10.5h14V20H5z" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
export const KeyIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="3.5" />
    <path d="m10.5 12.5 8-8M16 7l2.5 2.5M14 9l1.8 1.8" />
  </Svg>
);
export const MenuIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
);
export const CloseIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const RefreshIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
  </Svg>
);
export const ArrowRightIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const EyeIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <path d="M10 10h4v4h-4z" />
  </Svg>
);
export const EyeOffIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.6 6.6C3.9 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
export const LayersIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16 12 20.5 20.5 16" />
  </Svg>
);
export const PlusIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const TrashIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
  </Svg>
);
/** ">_" prompt glyph as an icon (terminal actions). */
export const PromptIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="m5 7 5 5-5 5M12 17h7" />
  </Svg>
);
/** Crosshair "+" mark. */
export const CrossIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M12 6v12M6 12h12" />
  </Svg>
);
