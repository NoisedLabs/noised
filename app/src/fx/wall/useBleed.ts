import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Geometry for a backdrop that spans the whole viewport width (without the
 * scrollbar, so it never causes horizontal scrolling) whatever container the
 * section sits in. Applied through the style prop (CSSOM), which the CSP allows.
 */
export function useBleed(ref: RefObject<HTMLElement | null>): CSSProperties | undefined {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      const next = { left: -r.left, width: document.documentElement.clientWidth };
      setBox((prev) => (prev && Math.abs(prev.left - next.left) < 0.5 && prev.width === next.width ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref]);
  return box ? { left: box.left, width: box.width, right: "auto" } : undefined;
}
