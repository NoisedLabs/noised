/**
 * Small animated glyphs for the step, link and empty-state cards of the inner pages: a few hundred dots that
 * coalesce out of noise into a clear silhouette in the theme's ink (fx/noise; the scenes are in
 * components/art/scenes.ts). Paused off screen; the formed still under reduced motion. Decorative: the card's words
 * say the same thing.
 *
 *   phrase   a sheet whose lines are written one after another (your 24 words)
 *   deposit  a safe whose dial turns
 *   key      a key
 *   wrap     a coin, then the same coin inside a box (a private copy)
 *   hide     an eye, then four dots (the amount, hidden)
 *   unwrap   the boxed coin, then the plain coin
 *   book     an open book
 *   paper    a page with a folded corner
 *   letter   an envelope
 *   courier  a parcel edging towards an arrow (deliver a payout)
 *   agent    a small agent inside a fence a dot runs around (the limits the chain enforces)
 */
import type { ReactNode } from "react";

import { glyphScene, type GlyphName } from "../../components/art/scenes";
import { NoiseArt } from "../../fx/noise";

export type { GlyphName };

/** An animated glyph of dots (decorative); its box (.pg-glyph) sets the size. */
export function DotGlyph({ name, className = "" }: { name: GlyphName; className?: string | undefined }): ReactNode {
  return (
    <span className={`pg-glyph ${className}`} aria-hidden="true">
      <NoiseArt scene={glyphScene(name)} />
    </span>
  );
}
