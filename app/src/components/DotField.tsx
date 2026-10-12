import { useEffect, useRef, type ReactNode } from "react";

import "../fx/points/dotfield.css";
import { useAmbientMotion } from "./AmbientMotion";

/**
 * A living halftone sheet on a 2D canvas: the no-WebGL fallback of the hero's
 * point wall (src/fx/points). Entirely decorative; it never represents market
 * data. Reduced motion, ambient motion off (AmbientMotion) or `paused` show
 * one still frame; it also stops while off screen or in a hidden tab.
 */
export function DotField({ paused = false, className = "" }: { paused?: boolean; className?: string }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Ambient motion off (user switch or reduced motion) also stills the field.
  const { still } = useAmbientMotion();
  const stopped = paused || still;
  const pausedRef = useRef(stopped);
  const syncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    pausedRef.current = stopped;
    syncRef.current?.();
  }, [stopped]);

  useEffect(() => {
    const node = canvas.current;
    const ctx = node?.getContext("2d", { alpha: true });
    if (!node || !ctx) return;
    const host = node.parentElement!;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0,
      height = 0,
      frame = 0,
      last = 0,
      time = 0;
    let visible = true;
    let color = "",
      secondary = "",
      faint = "";
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, strength: 0, target: 0 };

    const draw = (): void => {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      const scale = Math.min(width / 620, height / 440);
      const gap = 12 * scale;
      const cols = 63,
        rows = 37;
      // Quiet registration crosses behind the moving sheet, not a boxed grid.
      ctx.strokeStyle = faint;
      ctx.lineWidth = 0.7;
      for (let x = 28; x < width; x += 68) {
        for (let y = 30; y < height - 40; y += 68) {
          ctx.globalAlpha = 0.22;
          ctx.beginPath();
          ctx.moveTo(x - 3, y);
          ctx.lineTo(x + 3, y);
          ctx.moveTo(x, y - 3);
          ctx.lineTo(x, y + 3);
          ctx.stroke();
        }
      }
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const u = col / (cols - 1),
            v = row / (rows - 1);
          // Two long waves fold a regular dot grid into a continuous, drifting sheet.
          const crest = Math.sin(u * 7.8 + v * 2.5 - time * 0.48);
          const fold = Math.cos(v * 6.4 - u * 3.8 + time * 0.31);
          const z = crest * 0.65 + fold * 0.35;
          let x = width * 0.5 + (col - cols * 0.5) * gap + Math.sin(v * 5 + time * 0.13) * 32 * scale;
          let y = height * 0.49 + (row - rows * 0.5) * gap * 0.68 + z * 80 * scale - (u - 0.5) * 92 * scale;
          const dx = x - pointer.x,
            dy = y - pointer.y;
          const distance = Math.hypot(dx, dy);
          const influence = Math.exp((-distance * distance) / (17000 * scale * scale)) * pointer.strength;
          x += dx * influence * 0.2;
          y += dy * influence * 0.2;
          const edge = Math.pow(Math.max(0, Math.sin(u * Math.PI) * Math.sin(v * Math.PI)), 0.65);
          const light = Math.pow((z + 1) * 0.5, 1.5);
          const radius = (0.65 + light * 2.05 + influence * 0.9) * scale;
          const band = Math.sin(u * 5 - v * 3 + time * 0.35) > 0.28;
          ctx.fillStyle = band ? color : secondary;
          ctx.globalAlpha = edge * (0.12 + light * 0.82);
          if (col % 6 === 0 && row % 5 === 0) {
            const arm = radius + 2.1 * scale;
            ctx.fillRect(x - arm, y - 0.5 * scale, arm * 2, scale);
            ctx.fillRect(x - 0.5 * scale, y - arm, scale, arm * 2);
          } else {
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // The reticle trails the pointer; it is a decorative interaction only.
      if (pointer.strength > 0.01) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = pointer.strength * 0.7;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, 21 + Math.sin(time) * 3, 0, Math.PI * 2);
        ctx.moveTo(pointer.x - 34, pointer.y);
        ctx.lineTo(pointer.x + 34, pointer.y);
        ctx.moveTo(pointer.x, pointer.y - 34);
        ctx.lineTo(pointer.x, pointer.y + 34);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      node.dataset.ready = "true";
    };
    const running = (): boolean => !pausedRef.current && !media.matches && visible && !document.hidden;
    const tick = (stamp: number): void => {
      frame = 0;
      // Check before painting too: media changes can arrive between animation frames.
      if (!running()) return;
      const delta = last ? Math.min((stamp - last) / 1000, 0.05) : 0;
      last = stamp;
      time += delta;
      const follow = 1 - Math.exp(-delta * 8);
      pointer.x += (pointer.tx - pointer.x) * follow;
      pointer.y += (pointer.ty - pointer.y) * follow;
      pointer.strength += (pointer.target - pointer.strength) * (1 - Math.exp(-delta * 5));
      draw();
      frame = requestAnimationFrame(tick);
    };
    const sync = (): void => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (media.matches) pointer.strength = 0;
      draw();
      if (running()) frame = requestAnimationFrame(tick);
    };
    syncRef.current = sync;
    const readColors = (): void => {
      const cs = getComputedStyle(host);
      const pick = (...names: string[]): string => {
        for (const n of names) {
          const v = cs.getPropertyValue(n).trim();
          if (v) return v;
        }
        return "";
      };
      color = pick("--signal", "--accent") || "#ff5c35";
      secondary = pick("--field-ink", "--text-muted", "--fg-muted") || "#a39f98";
      faint = pick("--text-dim", "--fg-subtle") || "#8a867f";
    };
    const resize = (): void => {
      const bounds = host.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      draw();
    };
    const recolor = (): void => {
      readColors();
      draw();
    };
    const move = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const bounds = host.getBoundingClientRect();
      pointer.tx = event.clientX - bounds.left;
      pointer.ty = event.clientY - bounds.top;
      const inside = pointer.tx >= 0 && pointer.ty >= 0 && pointer.tx <= bounds.width && pointer.ty <= bounds.height;
      if (pointer.strength < 0.01) {
        pointer.x = pointer.tx;
        pointer.y = pointer.ty;
      }
      pointer.target = inside ? 1 : 0;
    };
    const leave = (): void => {
      pointer.target = 0;
    };
    const sizeObserver = new ResizeObserver(resize);
    const themeObserver = new MutationObserver(recolor);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    sizeObserver.observe(host);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    visibilityObserver.observe(host);
    // The field usually sits behind other content (pointer-events: none), so listen on the window.
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    media.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    resize();
    sync();
    return () => {
      syncRef.current = null;
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      themeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      media.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <div className={`terminal-dot-field df ${className}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="terminal-field-corner df-corner" aria-hidden="true">
        +
      </div>
      <div className="terminal-field-caption df-caption" aria-hidden="true">
        <span>
          001 <span>/</span> CROSSFIELD
        </span>
        <span className="terminal-field-orbit df-orbit">↗</span>
      </div>
    </div>
  );
}
