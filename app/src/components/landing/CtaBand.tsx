/**
 * The closing call to action: "Launch something that lasts." on a large graphite glass slab that resolves in from
 * noise, under a row of hexagonal shields formed of dots (the hero wall's cells, standing together; static falls on
 * them and bounces off), over a very faint dot field. Decorative layers are aria-hidden; they stop off screen, under
 * reduced motion and with motion switched off.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router";

import { launchCtaLabel, useLaunchesState } from "../../app/network";
import { NoiseArt, NoiseReveal, ResolveText, useNoiseReveal } from "../../fx/noise";
import { sfx } from "../../fx/sfx";
import { SectionField, useReveal } from "./glass";
import { ctaScene } from "./noise/cta";

export function CtaBand(): ReactNode {
  const [ref, shown] = useReveal<HTMLElement>();
  const slab = useRef<HTMLDivElement>(null);
  useNoiseReveal(slab, { duration: 820 });
  const scene = useMemo(() => ctaScene(), []);
  const launches = useLaunchesState();
  return (
    <section ref={ref} id="start" className="hm-section hm-end" aria-labelledby="cta-title" data-in={shown ? "" : undefined}>
      <SectionField fade="radial" seed={29} />
      <div className="hm-cta-stage">
        <div ref={slab} className="glass hm-cta">
          <span className="hm-cta-hex" aria-hidden="true" />
          <div className="hm-cta-art" aria-hidden="true">
            <NoiseArt scene={scene} host={slab} />
          </div>
          {/* Each word sits in its own unbreakable box; the first two words share a line where it fits and stack on
              narrow screens. */}
          <h2 id="cta-title" className="hm-cta-title">
            <span className="hm-cta-line hm-cta-line-pair">
              <span className="hm-cta-word">
                <ResolveText text="Launch" durationMs={640} delay={250} />
              </span>{" "}
              <span className="hm-cta-word">
                <ResolveText text="something" durationMs={700} delay={380} />
              </span>
            </span>
            <span className="hm-cta-line">
              <ResolveText text="that " durationMs={520} delay={520} />
              <ResolveText text="lasts." className="hm-accent" durationMs={640} delay={640} />
            </span>
          </h2>
          <NoiseReveal as="p" className="t-sub hm-lead hm-cta-lead" sweep="right" duration={620} delay={600}>
            Fair for everyone, signed with keys built for quantum computers, and locked for good.
          </NoiseReveal>
          <div className="hm-cta-actions">
            <Link to="/create" className="btn btn-primary btn-lg btn-noglyph" onClick={() => sfx.play("click")}>
              {launchCtaLabel(launches)}
              <span className="btn-arrow" data-dir="right" aria-hidden="true">
                →
              </span>
            </Link>
            <Link to="/verify" className="btn btn-secondary btn-lg btn-noglyph" onClick={() => sfx.play("click")}>
              Verify a token
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
