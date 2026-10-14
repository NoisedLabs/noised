/**
 * Nothing on a page stays hidden behind a "resolve from noise" reveal (fx/noise, fx/inview): an element several
 * windows tall still counts as seen once a fair part of the window shows it, the page printing shows everything that
 * waits, a reveal the frame loop cannot finish (a stalled or hidden tab) ends on a timer, and with motion off a
 * waiting element simply shows.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { observeSeen } from "../src/fx/inview";
import { playResolve, REVEAL_FAILSAFE_MS } from "../src/fx/noise/reveal";

const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** Just enough of an element for the reveal: a style declaration it masks and clears. */
function fakeElement(): HTMLElement & { props: Map<string, string> } {
  const props = new Map<string, string>();
  const style = {
    setProperty: (k: string, v: string) => void props.set(k, v),
    removeProperty: (k: string) => {
      const v = props.get(k) ?? "";
      props.delete(k);
      return v;
    },
    getPropertyValue: (k: string) => props.get(k) ?? "",
  };
  return { style, props } as unknown as HTMLElement & { props: Map<string, string> };
}

type Entry = Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio"> & { intersectionRect: { height: number }; rootBounds: { height: number } | null };

/** A stand-in IntersectionObserver whose callback the test drives; a window with listeners (beforeprint). */
function stubObserver(): { push: (e: Entry) => void; options: () => IntersectionObserverInit | undefined; disconnected: () => boolean; print: () => void } {
  let cb: ((entries: Entry[]) => void) | null = null;
  let opts: IntersectionObserverInit | undefined;
  let disconnected = false;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Entry[]) => void, options?: IntersectionObserverInit) {
        cb = callback;
        opts = options;
      }
      observe(): void {}
      disconnect(): void {
        disconnected = true;
      }
    },
  );
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("window", {
    innerHeight: 800,
    addEventListener: (t: string, f: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)?.add(f);
    },
    removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
  });
  return {
    push: (e) => cb?.([e]),
    options: () => opts,
    disconnected: () => disconnected,
    print: () => {
      for (const f of [...(listeners.get("beforeprint") ?? [])]) f();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a reveal never leaves content hidden", () => {
  it("counts an element as seen once its share of itself or of the window is on screen", () => {
    const io = stubObserver();
    const seen = vi.fn();
    observeSeen({} as Element, seen, { threshold: 0.12 });
    // Fine steps: a tall element reports progress long before 12% of itself shows.
    expect((io.options()?.threshold as number[]).filter((t) => t > 0 && t < 0.12).length).toBeGreaterThanOrEqual(3);
    io.push({ isIntersecting: true, intersectionRatio: 0.02, intersectionRect: { height: 40 }, rootBounds: { height: 800 } });
    expect(seen).not.toHaveBeenCalled();
    // An element 10 windows tall can only ever show 10% of itself: 20% of the window showing it is enough.
    io.push({ isIntersecting: true, intersectionRatio: 0.02, intersectionRect: { height: 160 }, rootBounds: { height: 800 } });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(io.disconnected()).toBe(true);
    // Once only.
    io.push({ isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 800 }, rootBounds: { height: 800 } });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("counts a small element as seen at its threshold, and a fully visible one always", () => {
    const io = stubObserver();
    const seen = vi.fn();
    observeSeen({} as Element, seen, { threshold: 0.5 });
    io.push({ isIntersecting: true, intersectionRatio: 0.3, intersectionRect: { height: 30 }, rootBounds: { height: 800 } });
    expect(seen).not.toHaveBeenCalled();
    io.push({ isIntersecting: false, intersectionRatio: 0, intersectionRect: { height: 0 }, rootBounds: { height: 800 } });
    expect(seen).not.toHaveBeenCalled();
    io.push({ isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 60 }, rootBounds: { height: 800 } });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("shows everything still waiting when the page prints", () => {
    const io = stubObserver();
    const seen = vi.fn();
    observeSeen({} as Element, seen);
    io.print();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(io.disconnected()).toBe(true);
    io.print();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("with motion off, playing a reveal shows the element and clears the mask it waited behind", () => {
    // No document in this test environment: motion counts as off.
    const el = fakeElement();
    el.style.setProperty("opacity", "0.150");
    el.style.setProperty("mask-image", "radial-gradient(circle, #000 0px, transparent 1.4px)");
    el.style.setProperty("-webkit-mask-image", "radial-gradient(circle, #000 0px, transparent 1.4px)");
    const done = vi.fn();
    playResolve(el, { onDone: done });
    expect([...el.props.keys()]).toEqual([]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("finishes on a timer when the frame loop never runs (a stalled or hidden tab)", () => {
    vi.useFakeTimers();
    // Motion on, a visible page, and a frame loop that never calls back.
    vi.stubGlobal("document", { documentElement: { dataset: {} }, visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const el = fakeElement();
    const done = vi.fn();
    playResolve(el, { duration: 700, delay: 100, onDone: done });
    expect(el.props.get("opacity")).toBe("0.150");
    vi.advanceTimersByTime(100 + 700 + REVEAL_FAILSAFE_MS - 1);
    expect(el.props.has("opacity")).toBe(true);
    vi.advanceTimersByTime(1);
    expect([...el.props.keys()]).toEqual([]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("every reveal shows its element when motion is switched off while it waits", () => {
    for (const file of ["fx/noise/reveal.ts", "fx/noise/ResolveText.tsx"]) {
      const code = src(file);
      expect(code, file).toContain("onMotionChange(");
      expect(code, file).toContain("observeSeen(");
      // No private observer that could wait forever on a threshold a tall element never reaches.
      expect(code, file).not.toContain("new IntersectionObserver(");
    }
    expect(src("fx/inview.ts")).toContain('addEventListener("beforeprint"');
  });
});
