/**
 * Why Noised: three graphite glass cards, each topped by a field of drifting dots that coalesces into one idea
 * (fx/noise, noise/why.ts): a shield that noise bounces off (launches signed with a quantum key), a padlock whose
 * shackle drops shut inside a closing loop (the vault), columns of dots rising to a line they never cross (Autopilot's
 * hard limits). The dots part around the pointer.
 * Over a very faint dot field; the cards resolve in from noise. The scenes play only on screen and show their
 * formed still under reduced motion or with motion off.
 */
import { ArrowRight } from "lucide-react";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router";

import { NoiseArt, useNoiseReveal, type NoiseScene } from "../../fx/noise";
import { SectionField, SectionHead, useReveal } from "./glass";
import { limitScene, lockScene, shieldScene } from "./noise/why";

const CARDS: { scene: () => NoiseScene; title: string; text: string }[] = [
  {
    scene: shieldScene,
    title: "Safe from quantum computers",
    text: "Every launch is signed with a quantum key that never comes from your wallet.",
  },
  {
    scene: lockScene,
    title: "A vault no ordinary key opens",
    text: "Keep coins in a vault only your quantum key can open. A stolen wallet key is not enough.",
  },
  {
    scene: limitScene,
    title: "Autopilot with hard limits",
    text: "Buybacks, burns and payouts run themselves, inside limits your quantum key signed. Not even an AI agent can cross them.",
  },
];

export const WhyNoised = memo(function WhyNoised(): ReactNode {
  const [ref, shown] = useReveal<HTMLElement>();
  const grid = useRef<HTMLUListElement>(null);
  useNoiseReveal(grid, { duration: 760 });
  return (
    <section ref={ref} id="why" className="hm-section hm-why" aria-labelledby="why-title" data-in={shown ? "" : undefined}>
      <SectionField fade="left" seed={11} />
      <SectionHead id="why-title" title="Why" accent="Noised" lead="Three promises, kept by code instead of people." align="center" />
      <ul ref={grid} className="hm-why-grid" role="list">
        {CARDS.map((c) => (
          <WhyCard key={c.title} {...c} />
        ))}
      </ul>
      <div className="hm-why-foot">
        <Link to="/security" className="btn btn-secondary hm-more">
          How we verify it
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
});

function WhyCard({ scene, title, text }: { scene: () => NoiseScene; title: string; text: string }): ReactNode {
  const card = useRef<HTMLLIElement>(null);
  const art = useMemo(() => scene(), [scene]);
  return (
    <li ref={card} className="glass hm-why-card">
      <div className="hm-why-art" aria-hidden="true">
        <NoiseArt scene={art} host={card} />
      </div>
      <h3 className="t-card-title hm-card-title">{title}</h3>
      <p className="hm-card-text">{text}</p>
    </li>
  );
}
