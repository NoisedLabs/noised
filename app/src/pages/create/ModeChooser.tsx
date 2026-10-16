/**
 * The launch's first choice (owner's request, 2026-10-11): "Quick launch", the simplest (one short screen), or
 * "Custom launch" (the full wizard: price curve, fees, launch rules, Autopilot). Two big cards, a radio group, each
 * with a small scene of dots coalescing out of noise (a coin minted in one go; a little graph of steps); both promise
 * the same three things in plain words.
 */
import type { ReactNode } from "react";

import { cardScene } from "../../components/art/scenes";
import { NoiseArt } from "../../fx/noise";
import { sfx } from "../../fx/sfx";

export type LaunchMode = "quick" | "custom";

const CARDS: { id: LaunchMode; title: string; badge: string; lede: string; points: readonly string[] }[] = [
  {
    id: "quick",
    title: "Quick launch",
    badge: "The simplest",
    lede: "One short screen: a name, a ticker, a logo, your trading fee and where it goes.",
    points: ["Name, ticker and logo", "Links to X and your website (optional)", "Your trading fee: to your wallet, or back into the token as automatic buyback and burn"],
  },
  {
    id: "custom",
    title: "Custom launch",
    badge: "Every option",
    lede: "Shape everything: the price curve, fees, launch rules with blocks or code, and an Autopilot graph.",
    points: ["Price curve and fee schedule", "Launch rules gallery, blocks and code", "Autopilot: a graph of buybacks, burns and payouts, AI-operated if you want"],
  },
];

/** The promises every launch keeps, whichever way it is made. */
export const PROMISES: readonly string[] = ["Signed with your quantum key", "Checked on-chain by anyone", "No admin key"];

export function ModeChooser({ mode, onPick }: { mode: LaunchMode; onPick: (m: LaunchMode) => void }): ReactNode {
  return (
    <div className="mc" role="radiogroup" aria-label="How do you want to launch?">
      {CARDS.map((c) => {
        const on = mode === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={on}
            className="mc-card glass"
            data-mode={c.id}
            data-on={on ? "" : undefined}
            onClick={() => {
              if (!on) sfx.play("toggle");
              onPick(c.id);
            }}
          >
            <span className="mc-art" aria-hidden="true">
              <NoiseArt scene={cardScene(c.id)} />
            </span>
            <span className="mc-body">
              <span className="mc-top">
                <span className="mc-title">{c.title}</span>
                <span className="mc-badge">{c.badge}</span>
                <span className="mc-radio" aria-hidden="true" />
              </span>
              <span className="mc-lede">{c.lede}</span>
              <span className="mc-points">
                {c.points.map((p) => (
                  <span key={p} className="mc-point">
                    {p}
                  </span>
                ))}
              </span>
              <span className="mc-promises" aria-label="Every launch">
                {PROMISES.map((p) => (
                  <span key={p} className="mc-promise">
                    {p}
                  </span>
                ))}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
