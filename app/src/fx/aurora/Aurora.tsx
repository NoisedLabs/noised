/**
 * The living background (GLASS_V51 section 1): graphite with 2-3 quiet, slowly drifting white / gray light pools
 * (WebGL, fx/aurora/renderer.ts) and a fine grain. Fixed behind the whole app; the glass UI blurs it.
 *
 *   <Aurora />   // once, in Layout
 *
 * Without WebGL the static CSS aurora (aurora.css) stays. Reduced motion / animations off: one still frame.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAmbientMotion } from "../../components/AmbientMotion";
import "./aurora.css";
import { installGlassPointer } from "./glassPointer";
import { createAurora, type AuroraRenderer } from "./renderer";

export function Aurora(): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<AuroraRenderer | null>(null);
  const { still } = useAmbientMotion();
  const stillRef = useRef(still);
  stillRef.current = still;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const r = createAurora(el, { onReady: () => setReady(true) });
    renderer.current = r;
    r?.setStill(stillRef.current);
    return () => {
      r?.destroy();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    renderer.current?.setStill(still);
  }, [still]);

  useEffect(() => installGlassPointer(), []);

  return (
    <div className="phx-aurora" data-ready={ready ? "true" : "false"} aria-hidden="true">
      <canvas ref={canvas} className="phx-aurora-canvas" />
      <div className="phx-aurora-grain" />
    </div>
  );
}
