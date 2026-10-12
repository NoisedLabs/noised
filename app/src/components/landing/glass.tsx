/**
 * Home section atoms (on GLASS_V5 section 4), built on the shared noise effects (fx/noise):
 *
 *   <SectionField fade="left" />            an extremely quiet field of drifting dots, the full window wide
 *   <SectionHead id="why-title" title="Why" accent="Noised" lead="..." />
 *       the title resolves in from noise, left to right (fx/noise ResolveText), then the lead (NoiseReveal)
 *   const [ref, shown] = useReveal<HTMLElement>();   // data-in on the section once it has been seen
 *   const grid = useRef<HTMLUListElement>(null); useNoiseReveal(grid);
 *
 * Reduced motion or motion switched off: everything simply shows (the shared effects check it).
 */
import { useRef, type ReactNode, type RefObject } from "react";

import { useInViewOnce } from "../../fx/inview";
import { NoiseGrain, NoiseReveal, ResolveText, type GrainFade } from "../../fx/noise";

/** True once the section has scrolled into view (and immediately under reduced motion). */
export function useReveal<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const shown = useInViewOnce(ref, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
  return [ref, shown];
}

/** A very faint field of drifting dots behind a section (the full window width, under the section's content). */
export function SectionField({ fade = "radial", seed = 7 }: { fade?: GrainFade; seed?: number }): ReactNode {
  return (
    <div className="hm-field" aria-hidden="true">
      <NoiseGrain fade={fade} seed={seed} />
    </div>
  );
}

/** The title (plain words + one silver accent word) and lead of a section. `align="center"` centres them. */
export function SectionHead({
  id,
  title,
  accent,
  lead,
  align = "start",
  aside,
}: {
  id: string;
  title: string;
  accent?: string;
  lead?: string;
  align?: "start" | "center";
  aside?: ReactNode;
}): ReactNode {
  return (
    <header className="hm-head" data-align={align}>
      <div className="hm-head-text">
        <h2 id={id} className="t-title hm-title">
          <ResolveText text={accent ? `${title} ` : title} durationMs={700} />
          {accent ? <ResolveText text={accent} className="hm-accent" durationMs={700} delay={140} /> : null}
        </h2>
        {lead ? (
          <NoiseReveal as="p" className="t-sub hm-lead" duration={620} delay={220} sweep="right">
            {lead}
          </NoiseReveal>
        ) : null}
      </div>
      {aside ? <div className="hm-head-aside">{aside}</div> : null}
    </header>
  );
}
