/**
 * Word-by-word blur-in reveal (GLASS_V5 section 1): each word goes blur 12px -> 0, opacity 0 -> 1, y 8 -> 0,
 * 50 ms apart.
 *
 *   <BlurText as="h1" className="t-hero" id="hx-title">
 *     <span className="t-line t-frost">Quantum-proof</span>
 *     <span className="t-line t-grad">token launches.</span>
 *   </BlurText>
 *   <BlurText as="p" className="t-sub" text="One plain sentence." delay={0.3} />
 *
 * Markup stays yours: strings anywhere inside `children` are split into words; elements keep their tags and
 * classes. Words inside a gradient line (.t-grad) keep one continuous gradient (each word is measured and
 * offset). Screen readers get the whole text once (a visually hidden copy; the animated words are aria-hidden).
 * Starts when scrolled into view (trigger="inview", default) or on mount (trigger="mount"). Reduced motion or
 * animations off: the text simply shows. CSP: keyframes live in styles.css; only custom properties go through
 * React style props / CSSOM.
 */
import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

import { useAmbientMotion } from "./AmbientMotion";

type Tag = "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div" | "strong" | "em" | "li";

export interface BlurTextProps {
  /** Element to render (default "span"). */
  as?: Tag;
  /** The text (alternative to children). */
  text?: string;
  children?: ReactNode;
  className?: string;
  id?: string;
  style?: CSSProperties;
  /** Seconds before the first word starts (default 0). */
  delay?: number;
  /** Seconds between words (default 0.05). */
  step?: number;
  /** Seconds per word (default 0.7). */
  duration?: number;
  /** "inview" (default): when it scrolls into view. "mount": right away. */
  trigger?: "inview" | "mount";
}

interface Split {
  node: ReactNode;
  count: number;
}

/** Split every string in `node` into word spans (index counted from `start`), keeping elements and whitespace. */
function splitWords(node: ReactNode, start: number): Split {
  let n = start;
  const walk = (child: ReactNode, key: string): ReactNode => {
    if (typeof child === "string" || typeof child === "number") {
      const parts = String(child).split(/(\s+)/);
      return parts.map((part, i) => {
        if (part === "") return null;
        if (/^\s+$/.test(part)) return part;
        const index = n++;
        return (
          <span key={`${key}-${i}`} className="bt-w" aria-hidden="true" style={{ ["--i" as string]: index } as CSSProperties}>
            {part}
          </span>
        );
      });
    }
    if (Array.isArray(child)) return child.map((c, i) => walk(c, `${key}.${i}`));
    if (isValidElement(child)) {
      const el = child as ReactElement<{ children?: ReactNode }>;
      if (el.props.children === undefined) return el;
      const inner = Children.toArray(el.props.children).map((c, i) => walk(c, `${key}.${i}`));
      return cloneElement(el, undefined, ...inner);
    }
    return child;
  };
  const out = walk(node, "w");
  return { node: out, count: n - start };
}

/** The plain text of `node` (elements joined with a space, whitespace collapsed). */
function plainText(node: ReactNode): string {
  const parts: string[] = [];
  const walk = (child: ReactNode): void => {
    if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    else if (Array.isArray(child)) child.forEach(walk);
    else if (isValidElement(child)) {
      parts.push(" ");
      walk((child as ReactElement<{ children?: ReactNode }>).props.children);
      parts.push(" ");
    }
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Words inside a gradient line: give each one the line's gradient box and its own offset in it. */
function placeGradients(root: HTMLElement): void {
  const words = root.querySelectorAll<HTMLElement>(".t-grad .bt-w");
  if (words.length === 0) return;
  for (const w of words) {
    const line = w.closest<HTMLElement>(".t-grad");
    if (!line) continue;
    const g = line.getBoundingClientRect();
    const r = w.getBoundingClientRect();
    w.style.setProperty("--bt-bw", `${g.width.toFixed(1)}px`);
    w.style.setProperty("--bt-bh", `${g.height.toFixed(1)}px`);
    w.style.setProperty("--bt-bx", `${(r.left - g.left).toFixed(1)}px`);
    w.style.setProperty("--bt-by", `${(r.top - g.top).toFixed(1)}px`);
  }
}

export function BlurText({
  as = "span",
  text,
  children,
  className = "",
  id,
  style,
  delay = 0,
  step = 0.05,
  duration = 0.7,
  trigger = "inview",
}: BlurTextProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const { still } = useAmbientMotion();
  const [play, setPlay] = useState(false);
  const source = text ?? children;

  // Gradient words: measure before the first paint, and again whenever the box changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    placeGradients(el);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => placeGradients(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  useEffect(() => {
    if (still) {
      setPlay(true);
      return;
    }
    const el = ref.current;
    if (trigger === "mount" || !el || typeof IntersectionObserver === "undefined") {
      setPlay(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPlay(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [still, trigger]);

  const split = splitWords(source, 0);
  const vars = {
    ...style,
    ["--bt-delay" as string]: `${delay}s`,
    ["--bt-step" as string]: `${step}s`,
    ["--bt-dur" as string]: `${duration}s`,
  } as CSSProperties;

  return createElement(
    as,
    {
      ref,
      id,
      className: `bt-run ${className}`.trim(),
      style: vars,
      // "still": no animation at all (the words just show).
      "data-play": still ? undefined : play ? "true" : "false",
    },
    <span className="sr-only">{plainText(source)}</span>,
    split.node,
  );
}
