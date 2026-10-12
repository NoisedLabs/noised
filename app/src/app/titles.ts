/**
 * Browser tab titles (LAYER_V1 §B.1): every route names its page and the layer. The docs set their own title per page
 * and the token page names its token, so those routes return null here.
 */
import { SITE_TITLE } from "./brand";

export { SITE_TITLE };

const ROUTES: readonly (readonly [RegExp, string])[] = [
  [/^\/create\/?$/, "Launch a token"],
  [/^\/vault\/?$/, "Vault"],
  [/^\/shield\/?$/, "Shield: private balances"],
  [/^\/verify\/?$/, "Verify a token"],
  [/^\/security\/?$/, "Security"],
  [/^\/autopilot\/?$/, "Autopilot"],
  [/^\/whitepaper\/?$/, "Whitepaper"],
];

/** The title for a route, or null where the page sets its own (docs, token pages, a token on Verify). */
export function pageTitle(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return SITE_TITLE;
  if (/^\/docs(\/|$)/.test(pathname) || /^\/token\//.test(pathname) || /^\/verify\/./.test(pathname)) return null;
  const hit = ROUTES.find(([re]) => re.test(pathname));
  return hit ? `${hit[1]} · Noised` : "Not found · Noised";
}

/** A page's own title: "AEGS · Noised". */
export const ownTitle = (name: string): string => `${name} · Noised`;
