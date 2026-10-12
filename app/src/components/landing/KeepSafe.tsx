/**
 * Keep it safe (LAYER_V1 products): two large graphite glass cards, Vault and Shield (private balances), each topped
 * by a field of drifting dots (fx/noise, noise/safe.ts): a combination dial formed of dots that turns and stops, and
 * a balance that dissolves into noise and comes back as four dots (the amount, hidden). Over a very faint dot field.
 * The scenes play only on screen and show their formed still under reduced motion or with motion switched off.
 */
import { ArrowRight } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router";

import { NoiseArt, useNoiseReveal, type NoiseScene } from "../../fx/noise";
import { SectionField, SectionHead, useReveal } from "./glass";
import { privateScene, vaultScene } from "./noise/safe";

const CARDS: { scene: () => NoiseScene; title: string; text: string; to: string; cta: string }[] = [
  { scene: vaultScene, title: "Vault", text: "Store tokens behind your quantum key: no wallet key can take them out.", to: "/vault", cta: "Open your vault" },
  { scene: privateScene, title: "Shield", text: "Private balances: hold and send without showing your amounts.", to: "/shield", cta: "Use Shield" },
];

export function KeepSafe(): ReactNode {
  const [ref, shown] = useReveal<HTMLElement>();
  const grid = useRef<HTMLDivElement>(null);
  useNoiseReveal(grid, { duration: 700 });
  const [vault, priv] = CARDS as [Card, Card];
  return (
    <section ref={ref} id="keep-safe" className="hm-section hm-safe" aria-labelledby="safe-title" data-in={shown ? "" : undefined}>
      <SectionField fade="left" seed={23} />
      {/* Asymmetric: the title and the private-balances card on the left, the vault (bigger, its door bleeding past
          the card's edge) on the right. Reading order: title, vault, private. */}
      <div ref={grid} className="hm-safe-layout">
        <SectionHead id="safe-title" title="Keep it" accent="safe" lead="Vault and Shield: two quiet tools for what you already hold." />
        <SafeCard {...vault} kind="vault" />
        <SafeCard {...priv} kind="private" />
      </div>
    </section>
  );
}

type Card = (typeof CARDS)[number];

function SafeCard({ scene, title, text, to, cta, kind }: Card & { kind: "vault" | "private" }): ReactNode {
  const card = useRef<HTMLElement>(null);
  const art = useMemo(() => scene(), [scene]);
  return (
    <article ref={card} className="glass hm-safe-card" data-kind={kind} aria-labelledby={`safe-${kind}`}>
      <div className="hm-safe-art" aria-hidden="true">
        <NoiseArt scene={art} host={card} />
      </div>
      <div className="hm-safe-body">
        <h3 id={`safe-${kind}`} className="hm-safe-title">
          {title}
        </h3>
        <p className="hm-card-text">{text}</p>
        <Link to={to} className="btn btn-secondary btn-noglyph hm-safe-btn">
          {cta}
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}
