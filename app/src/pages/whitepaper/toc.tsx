/**
 * Table of contents with reading progress: a sticky glass panel on wide screens, a disclosure at the top of the
 * paper on narrow ones, plus a 2px progress line fixed to the top of the viewport. The active section follows the
 * scroll position (one passive scroll listener, coalesced into one rAF per frame).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { jump, SECTIONS } from "./paper";

function useReading(): { progress: number; active: string } {
  const [state, setState] = useState({ progress: 0, active: SECTIONS[0].id as string });
  const frame = useRef(0);
  useEffect(() => {
    const measure = (): void => {
      frame.current = 0;
      const article = document.getElementById("wp-article");
      if (!article) return;
      const rect = article.getBoundingClientRect();
      const total = Math.max(1, rect.height - window.innerHeight * 0.6);
      const progress = Math.min(1, Math.max(0, -rect.top / total));
      let active: string = SECTIONS[0].id;
      const line = window.innerHeight * 0.3;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) active = s.id;
      }
      setState((prev) => (Math.abs(prev.progress - progress) > 0.001 || prev.active !== active ? { progress, active } : prev));
    };
    const onScroll = (): void => {
      if (frame.current === 0) frame.current = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
    };
  }, []);
  return state;
}

function TocList({ active, onPick }: { active: string; onPick?: (() => void) | undefined }): ReactNode {
  return (
    <ol className="wp-toc-list">
      {SECTIONS.map((s) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            className="wp-toc-link"
            aria-current={active === s.id ? "location" : undefined}
            onClick={(e) => {
              jump(e, s.id);
              onPick?.();
            }}
          >
            <span className="wp-toc-n">{String(s.n).padStart(2, "0")}</span>
            <span className="wp-toc-t">{s.short}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

export function Toc(): ReactNode {
  const { progress, active } = useReading();
  const [open, setOpen] = useState(false);
  const pct = Math.round(progress * 100);
  return (
    <>
      <div className="wp-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress.toFixed(4)})` }} />
      </div>
      <nav className="wp-toc" aria-label="Whitepaper contents">
        <div className="wp-toc-sticky">
        <div className="wp-toc-panel wp-panel px-corners px-frame">
          <div className="wp-toc-head">
            <span className="wp-toc-label">Contents</span>
            <span className="wp-toc-pct" aria-label={`${pct}% read`}>{`${pct}%`}</span>
          </div>
          <div className="wp-toc-bar" role="progressbar" aria-label="Reading progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            {SECTIONS.map((s, i) => {
              const at = progress * SECTIONS.length - i;
              return <span key={s.id} data-on={at >= 1 ? "true" : at > 0 ? "part" : "false"} />;
            })}
          </div>
          <TocList active={active} />
        </div>
        </div>
      </nav>
      <div className="wp-toc-mobile wp-panel px-corners px-frame">
        <button type="button" className="wp-toc-toggle" aria-expanded={open} aria-controls="wp-toc-mobile-list" onClick={() => setOpen((o) => !o)}>
          <span>Contents</span>
          <span className="wp-toc-pct">{`${pct}% read`}</span>
        </button>
        <div id="wp-toc-mobile-list" hidden={!open}>
          <TocList active={active} onPick={() => setOpen(false)} />
        </div>
      </div>
    </>
  );
}
