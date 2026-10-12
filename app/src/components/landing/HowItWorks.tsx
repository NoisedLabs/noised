/**
 * How it works: a big screen of drifting dots forms four glyphs in turn (create, fair launch, trading, graduate;
 * fx/noise, noise/how.ts) next to the four steps in plain words; the playing step's name sits in its corner.
 *
 * Wide screens: the screen (about 60% of the width) stays pinned while the steps scroll past it; the step in the
 * middle of the window is the one playing (its frame loops), so scrolling tells the story. Picking a step brings it
 * to the middle. Narrow screens: the frames play one after another under the screen; picking a step jumps to it and
 * holds there. Pause / play stops the animation either way. Reduced motion or motion off: the screen shows a still
 * of the picked step and nothing advances by itself.
 */
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { useAmbientMotion } from "../AmbientMotion";
import { NoiseArt, useNoiseReveal } from "../../fx/noise";
import { SectionField, SectionHead, useReveal } from "./glass";
import { HOW_STEP, HOW_STILL_AT, howScene } from "./noise/how";

const STEPS: { title: string; text: string }[] = [
  { title: "Create", text: "Pick a name, draw an icon, and choose a price curve and a few simple rules." },
  { title: "Fair launch", text: "Everyone joins one opening batch and pays the same price. No one gets in first." },
  { title: "Trading opens", text: "Anyone can buy and sell, with early limits so no one grabs too much." },
  { title: "Graduates", text: "At its goal, liquidity moves to a bigger pool and is locked forever." },
];

const WIDE = "(min-width: 981px)";

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const mq = window.matchMedia(WIDE);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(WIDE).matches,
    () => false,
  );
}

export function HowItWorks(): ReactNode {
  const [ref, shown] = useReveal<HTMLElement>();
  const grid = useRef<HTMLDivElement>(null);
  useNoiseReveal(grid, { duration: 620, sweep: "right" });
  const { still } = useAmbientMotion();
  const wide = useWide();
  // Scroll-driven on wide screens with motion on; a self-playing sequence otherwise.
  const scrollMode = wide && !still;
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seek, setSeek] = useState<number | undefined>(undefined);
  const stepRef = useRef(step);
  stepRef.current = step;
  const modeRef = useRef(scrollMode);
  modeRef.current = scrollMode;
  const items = useRef<(HTMLLIElement | null)[]>([]);

  // The art reports the step it is playing (once per change). In scroll mode the active step loops: when the
  // sequence runs into the next step it jumps back to the start of the active one (plain noise, so it is seamless).
  const scene = useMemo(() => howScene(), []);
  const onStep = useCallback((s: number) => {
    if (!modeRef.current) {
      setStep(s);
      return;
    }
    if (s !== stepRef.current) setSeek(stepRef.current * HOW_STEP + Math.random() * 0.001);
  }, []);

  // Scroll mode: the step crossing the middle of the window is the active one.
  useEffect(() => {
    if (!scrollMode || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = items.current.indexOf(e.target as HTMLLIElement);
          if (i < 0 || i === stepRef.current) continue;
          setStep(i);
          setSeek(i * HOW_STEP + Math.random() * 0.001);
        }
      },
      { rootMargin: "-46% 0px -46% 0px", threshold: 0 },
    );
    for (const el of items.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [scrollMode]);

  const pick = useCallback(
    (i: number) => {
      setStep(i);
      if (modeRef.current) {
        // Bring the step to the middle: the observer keeps it active, and the frame starts from the top.
        setSeek(i * HOW_STEP + Math.random() * 0.001);
        items.current[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      setPaused(true);
      // Land on the moment of each frame that tells its story; a tiny offset makes every pick a new seek.
      setSeek(i * HOW_STEP + (HOW_STILL_AT[i] ?? 2.6) + Math.random() * 0.001);
    },
    [],
  );
  const playing = shown && !paused;

  return (
    <section
      ref={ref}
      id="how-it-works"
      className="hm-section hm-how"
      aria-labelledby="how-title"
      data-in={shown ? "" : undefined}
      data-scroll={scrollMode ? "" : undefined}
    >
      <SectionField fade="right" seed={17} />
      <SectionHead id="how-title" title="How it" accent="works" lead="From idea to locked liquidity, in four simple steps." align="center" />
      <div ref={grid} className="hm-how-grid">
        <div className="hm-how-pin">
          <div className="glass hm-how-screen">
            <div className="hm-how-art" aria-hidden="true">
              <NoiseArt scene={scene} playing={playing} seekTo={seek} onStep={onStep} />
            </div>
            <span className="hm-how-cap" aria-hidden="true">
              <b>{String(step + 1).padStart(2, "0")}</b>
              {STEPS[step]?.title}
            </span>
          </div>
          {still ? null : (
            <button
              type="button"
              className="hm-how-play"
              onClick={() => {
                setPaused((p) => !p);
                setSeek(undefined);
              }}
            >
              {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {paused ? "Play" : "Pause"}
            </button>
          )}
        </div>
        <div className="hm-how-side">
          <ol className="hm-how-steps">
            {STEPS.map((s, i) => (
              <li
                key={s.title}
                ref={(el) => {
                  items.current[i] = el;
                }}
              >
                <button
                  type="button"
                  className="hm-how-step"
                  aria-pressed={step === i}
                  data-active={step === i ? "" : undefined}
                  data-playing={step === i && playing && !still ? "" : undefined}
                  onClick={() => pick(i)}
                >
                  <span className="hm-how-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="hm-how-copy">
                    <span className="hm-how-title">{s.title}</span>
                    <span className="hm-how-text">{s.text}</span>
                  </span>
                  <span className="hm-how-bar" aria-hidden="true" style={{ ["--dur" as string]: `${HOW_STEP}s` } as CSSProperties}>
                    <i />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
