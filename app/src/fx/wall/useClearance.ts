import { useLayoutEffect, useState } from "react";

/**
 * Space the fixed site header really takes at the top of the page, in px, when
 * it is taller than the --nav-offset token (for example while the network
 * banner shows under the navbar). Null when the token is enough. Measured at
 * the top of the page only (the navbar condenses on scroll) and never shrinks,
 * so the hero does not jump while the page scrolls.
 */
export function useHeaderClearance(): number | null {
  const [clearance, setClearance] = useState<number | null>(null);
  useLayoutEffect(() => {
    const header = [...document.querySelectorAll("header")].find((h) => getComputedStyle(h).position === "fixed");
    if (!header) return;
    const update = (): void => {
      if (window.scrollY > 30) return;
      const token = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nav-offset")) || 112;
      const needed = Math.ceil(header.getBoundingClientRect().bottom + 12);
      setClearance((prev) => (needed > token && needed > (prev ?? 0) ? needed : prev));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  return clearance;
}
