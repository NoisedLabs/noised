/**
 * One requestAnimationFrame loop for every noise effect on the page. Effects add a task while they should move (on
 * screen, playing, motion on) and remove it when they should not; the loop runs only while at least one task is in
 * and the tab is visible, so an idle page costs nothing. Time does not run while the tab is hidden: the first frame
 * after it comes back gets a small dt, never the whole time away.
 *
 *   const off = scheduler.add({ fps: 30, frame: (dt, now) => draw(dt) });   // dt in seconds
 *   off();
 *
 * `createScheduler` takes the frame and visibility hooks so tests can drive it without a browser.
 */

export interface FrameTask {
  /** Called once per frame (or at most `fps` times a second) with the seconds since its previous call. */
  frame(dt: number, now: number): void;
  /** Cap (default: every display frame). */
  fps?: number;
}

export interface SchedulerEnv {
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  /** True while the page is visible. */
  visible(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onVisibility(cb: () => void): () => void;
}

export interface Scheduler {
  add(task: FrameTask): () => void;
  /** True while a frame is pending (some task is in and the page is visible). */
  readonly running: boolean;
  /** Tasks currently in. */
  readonly size: number;
}

/** Longest dt handed to a task (a slow frame or a stall never makes an animation jump). */
const MAX_DT = 1 / 15;

interface Entry {
  task: FrameTask;
  acc: number;
}

export function createScheduler(env: SchedulerEnv): Scheduler {
  const entries = new Set<Entry>();
  let id = 0;
  let pending = false;
  let last = -1;
  let unsubscribe: (() => void) | null = null;

  const tick = (now: number): void => {
    pending = false;
    if (entries.size === 0 || !env.visible()) {
      last = -1;
      return;
    }
    const dt = last < 0 ? 1 / 60 : Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    for (const e of [...entries]) {
      if (!entries.has(e)) continue;
      const fps = e.task.fps ?? 0;
      if (fps > 0) {
        e.acc += dt;
        // A little slack so a 30 fps task on a 60 Hz screen runs every other frame, not unevenly.
        if (e.acc + 0.004 < 1 / fps) continue;
        const step = Math.min(MAX_DT * 2, e.acc);
        e.acc = 0;
        e.task.frame(step, now);
      } else {
        e.task.frame(dt, now);
      }
    }
    schedule();
  };

  const schedule = (): void => {
    if (pending || entries.size === 0 || !env.visible()) return;
    pending = true;
    id = env.requestFrame(tick);
  };

  const stop = (): void => {
    if (pending) env.cancelFrame(id);
    pending = false;
    last = -1;
  };

  const onVisibility = (): void => {
    if (env.visible()) schedule();
    else stop();
  };

  return {
    add(task) {
      const entry: Entry = { task, acc: 0 };
      entries.add(entry);
      if (!unsubscribe) unsubscribe = env.onVisibility(onVisibility);
      schedule();
      return () => {
        entries.delete(entry);
        if (entries.size === 0) {
          stop();
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
    get running() {
      return pending;
    },
    get size() {
      return entries.size;
    },
  };
}

function browserEnv(): SchedulerEnv {
  return {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (n) => cancelAnimationFrame(n),
    visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    onVisibility: (cb) => {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
  };
}

let shared: Scheduler | null = null;

/** The page's one noise scheduler (created on first use). */
export function noiseScheduler(): Scheduler {
  shared ??= createScheduler(browserEnv());
  return shared;
}
