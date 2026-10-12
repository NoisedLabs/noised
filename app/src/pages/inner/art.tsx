/**
 * Header illustrations for the inner pages: a cloud of fine drifting dots that coalesces into each page's idea,
 * holds it, and dissolves back into noise (fx/noise; the scenes are in components/art/scenes.ts). Drawn in the
 * theme's ink only; decorative (the page's words say the same thing); paused off screen and in hidden tabs; the
 * formed still frame under reduced motion.
 *
 *   Create   a coin turning slowly over a hairline pad
 *   Vault    a vault door whose dial turns, then the bolts slide out
 *   Privacy  a balance that dissolves into noise and comes back as four dots
 *   Security programs checked one by one, then a shield with a check
 *   Verify   a coin with a hairline scan passing over it, then a check
 */
import type { PublicKey } from "@solana/web3.js";
import { useMemo, type ReactNode } from "react";

import { pageScene, tokenCoinScene, type PageScene } from "../../components/art/scenes";
import { identiconCells } from "../../components/Identicon";
import { NoiseArt } from "../../fx/noise";

export type ArtScene = PageScene;

/** A header illustration (decorative). */
export function PageArt({ scene, className = "" }: { scene: ArtScene; className?: string | undefined }): ReactNode {
  return (
    <div className={`pg-art ${className}`} data-scene={scene} aria-hidden="true">
      <NoiseArt scene={pageScene(scene)} />
    </div>
  );
}

/**
 * A launch's mark on its own page (when it has no icon of its own): the address's 7 x 7 identicon (the same one as on
 * the launch cards), as dots on a coin that turns now and then. Decorative.
 */
export function TokenCoin({ address, className = "" }: { address: PublicKey; className?: string | undefined }): ReactNode {
  const key = address.toBase58();
  const scene = useMemo(() => tokenCoinScene(key, identiconCells(address).cells), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`pg-coin ${className}`} aria-hidden="true">
      <NoiseArt scene={scene} />
    </div>
  );
}
