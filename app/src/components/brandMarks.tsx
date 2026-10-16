/**
 * Monochrome marks for the links to other sites: npm, GitHub and X (the shapes of their official simple marks, after
 * Simple Icons, CC0), and a document for the whitepaper. Inline SVG filled with currentColor, so they take the ink of
 * the theme (Paper or Graphite) and load nothing from elsewhere (the CSP forbids it). Always decorative: the link
 * around a mark carries its name.
 *
 *   <XMark className="phx-brand-icon" />
 */
import type { ReactNode } from "react";

interface MarkProps {
  className?: string;
}

function Mark({ className, children }: MarkProps & { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** npm: the square "n" mark. */
export const NpmMark = (p: MarkProps): ReactNode => (
  <Mark {...p}>
    <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
  </Mark>
);

/** GitHub: the Invertocat. */
export const GitHubMark = (p: MarkProps): ReactNode => (
  <Mark {...p}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </Mark>
);

/** X (formerly Twitter): the X logo. */
export const XMark = (p: MarkProps): ReactNode => (
  <Mark {...p}>
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </Mark>
);

/** A page with a folded corner and two lines of text (the whitepaper). */
export const DocMark = (p: MarkProps): ReactNode => (
  <Mark {...p}>
    <path fillRule="evenodd" d="M4.5 1h10L20 6.5V23H4.5ZM13 2.6V8h5.4ZM8 12h8.5v1.8H8Zm0 4h8.5v1.8H8Z" />
  </Mark>
);
