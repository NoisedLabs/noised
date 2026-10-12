/**
 * Sound (TERMINAL_V2 spec section 10): synthesized with Web Audio, no audio
 * files (the CSP has media-src 'none'). The AudioContext is created lazily on
 * the first pointerdown/keydown, so nothing plays before a user gesture and
 * nothing ever plays on page load.
 *
 * Mute is persistent (localStorage "noised.sound" = "on" | "off"). Default
 * ON, or OFF when the OS asks for reduced motion. Master gain is -14 dB with
 * a limiter; rate limits keep it calm (the same sound at most every 60 ms,
 * at most 8 sounds per second; "key" ticks have their own budget).
 *
 *   import { sfx, useSound } from "../fx/sfx";
 *   sfx.play("success");
 *   const { muted, setMuted, toggle, play } = useSound();
 */
import { useSyncExternalStore } from "react";

export type SoundName =
  | "boot" // two-note square chime 440 -> 660 Hz
  | "key" // 6 ms noise tick (typewriter / scramble)
  | "click" // 12 ms square blip, 1.2 kHz
  | "hover" // 4 ms 2.4 kHz tick, nav only, -32 dB
  | "toggle" // two blips
  | "success" // rising three-note square arpeggio, lowpassed
  | "error" // 110 Hz square buzz, 180 ms
  | "commit" // low thunk + bright click: a shield locking
  | "open" // short down-sweep (command palette)
  | "warn"
  | "execute"
  | "sign";

const STORAGE_KEY = "noised.sound";
/** -14 dBFS. */
const MASTER_GAIN = 0.2;
const SAME_SOUND_GAP_MS = 60;
const MAX_PER_SECOND = 8;
const KEY_GAP_MS = 28;

function readPref(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePref(value: "on" | "off"): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

let muted: boolean = (() => {
  const saved = readPref();
  if (saved === "on") return false;
  if (saved === "off") return true;
  return prefersReducedMotion();
})();
let gestured = false;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
const listeners = new Set<() => void>();
const lastPlayed = new Map<SoundName, number>();
const recent: number[] = [];

function context(): AudioContext | null {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  }
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext as typeof AudioContext | undefined;
  if (!Ctor) return null;
  try {
    ctx = new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 6;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(limiter);
  limiter.connect(ctx.destination);
  return ctx;
}

function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise = buf;
  return buf;
}

/** Exponential attack/decay envelope. */
function envelope(c: AudioContext, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

interface Filter {
  type: BiquadFilterType;
  freq: number;
  q?: number;
}

interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  freqEnd?: number;
  glide?: number;
  t: number;
  attack?: number;
  decay: number;
  gain: number;
  filter?: Filter;
}

function tone(c: AudioContext, out: AudioNode, o: ToneOpts): void {
  const attack = o.attack ?? 0.003;
  const osc = c.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, o.t + (o.glide ?? attack + o.decay));
  const env = envelope(c, o.t, o.gain, attack, o.decay);
  if (o.filter) {
    const f = c.createBiquadFilter();
    f.type = o.filter.type;
    f.frequency.value = o.filter.freq;
    f.Q.value = o.filter.q ?? 0.7;
    osc.connect(f);
    f.connect(env);
  } else {
    osc.connect(env);
  }
  env.connect(out);
  osc.start(o.t);
  osc.stop(o.t + attack + o.decay + 0.05);
}

function burst(c: AudioContext, out: AudioNode, o: { t: number; decay: number; gain: number; freq: number; q: number; type?: BiquadFilterType }): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const f = c.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.value = o.freq;
  f.Q.value = o.q;
  const env = envelope(c, o.t, o.gain, 0.0008, o.decay);
  src.connect(f);
  f.connect(env);
  env.connect(out);
  src.start(o.t, Math.random() * 0.3);
  src.stop(o.t + o.decay + 0.05);
}

const LP = (freq: number): Filter => ({ type: "lowpass", freq, q: 0.8 });

const SYNTHS: Record<SoundName, (c: AudioContext, out: AudioNode, t: number) => void> = {
  boot: (c, out, t) => {
    tone(c, out, { type: "square", freq: 440, t, attack: 0.004, decay: 0.12, gain: 0.22, filter: LP(1800) });
    tone(c, out, { type: "square", freq: 660, t: t + 0.12, attack: 0.004, decay: 0.16, gain: 0.22, filter: LP(2000) });
  },
  key: (c, out, t) => burst(c, out, { t, decay: 0.006, gain: 0.07, freq: 3800, q: 1.4 }),
  click: (c, out, t) => tone(c, out, { type: "square", freq: 1200, t, attack: 0.001, decay: 0.012, gain: 0.12, filter: LP(5000) }),
  hover: (c, out, t) => tone(c, out, { type: "square", freq: 2400, t, attack: 0.0008, decay: 0.004, gain: 0.025, filter: LP(6000) }),
  toggle: (c, out, t) => {
    tone(c, out, { type: "square", freq: 900, t, attack: 0.001, decay: 0.018, gain: 0.1, filter: LP(4000) });
    tone(c, out, { type: "square", freq: 1350, t: t + 0.055, attack: 0.001, decay: 0.018, gain: 0.1, filter: LP(4000) });
  },
  success: (c, out, t) => {
    [523.25, 659.25, 987.77].forEach((f, i) => tone(c, out, { type: "square", freq: f, t: t + i * 0.07, attack: 0.003, decay: 0.14 + i * 0.05, gain: 0.14, filter: LP(2400) }));
  },
  error: (c, out, t) => tone(c, out, { type: "square", freq: 110, t, attack: 0.004, decay: 0.18, gain: 0.2, filter: LP(900) }),
  commit: (c, out, t) => {
    // Low thunk (pitch-dropping sine + low noise) then a bright click: a shield locking into the wall.
    tone(c, out, { freq: 140, freqEnd: 55, glide: 0.12, t, attack: 0.002, decay: 0.2, gain: 0.5 });
    burst(c, out, { t, decay: 0.05, gain: 0.25, freq: 260, q: 1.2, type: "lowpass" });
    tone(c, out, { type: "square", freq: 2200, t: t + 0.07, attack: 0.001, decay: 0.02, gain: 0.08, filter: LP(7000) });
    burst(c, out, { t: t + 0.07, decay: 0.02, gain: 0.12, freq: 5200, q: 2 });
  },
  open: (c, out, t) => tone(c, out, { type: "triangle", freq: 1400, freqEnd: 380, glide: 0.11, t, attack: 0.002, decay: 0.12, gain: 0.16, filter: LP(3000) }),
  warn: (c, out, t) => {
    tone(c, out, { type: "square", freq: 330, t, attack: 0.003, decay: 0.07, gain: 0.12, filter: LP(1600) });
    tone(c, out, { type: "square", freq: 262, t: t + 0.09, attack: 0.003, decay: 0.1, gain: 0.12, filter: LP(1600) });
  },
  execute: (c, out, t) => {
    tone(c, out, { freq: 55, freqEnd: 110, glide: 0.35, t, attack: 0.25, decay: 0.12, gain: 0.4 });
    for (let i = 0; i < 3; i++) SYNTHS.commit(c, out, t + 0.36 + i * 0.08);
  },
  sign: (c, out, t) => {
    [880, 1046.5, 1318.5, 1760].forEach((f, i) => tone(c, out, { type: "square", freq: f, t: t + i * 0.045, attack: 0.002, decay: 0.09, gain: 0.07, filter: LP(3600) }));
  },
};

function allowed(name: SoundName, now: number): boolean {
  const last = lastPlayed.get(name);
  if (name === "key") {
    if (last !== undefined && now - last < KEY_GAP_MS) return false;
    lastPlayed.set(name, now);
    return true;
  }
  if (last !== undefined && now - last < SAME_SOUND_GAP_MS) return false;
  while (recent.length > 0 && now - (recent[0] ?? 0) > 1000) recent.shift();
  if (recent.length >= MAX_PER_SECOND) return false;
  lastPlayed.set(name, now);
  recent.push(now);
  return true;
}

function notify(): void {
  for (const l of listeners) l();
}

export const sfx = {
  /** Play a sound (no-op when muted, before the first gesture, or in a hidden tab). */
  play(name: SoundName): void {
    if (muted || !gestured) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const c = context();
    if (!c || !master) return;
    if (!allowed(name, performance.now())) return;
    try {
      SYNTHS[name](c, master, c.currentTime + 0.004);
    } catch {
      // Audio is decoration: never let it break an interaction.
    }
  },
  get muted(): boolean {
    return muted;
  },
  /** True once the user has interacted (audio may play). */
  get unlocked(): boolean {
    return gestured;
  },
  setMuted(next: boolean): void {
    muted = next;
    writePref(next ? "off" : "on");
    if (!next && gestured) context();
    notify();
    if (!next) sfx.play("toggle");
  },
  toggle(): void {
    sfx.setMuted(!muted);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * Call once at startup (main.tsx): the first pointerdown/keydown counts as the
 * user gesture that allows audio; the AudioContext is created then (if unmuted).
 */
export function installSoundUnlock(): void {
  if (typeof window === "undefined") return;
  const onGesture = (): void => {
    gestured = true;
    if (!muted) context();
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    notify();
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  // Another tab changed the mute setting.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = e.newValue === "off";
    if (next !== muted) {
      muted = next;
      notify();
    }
  });
}

/** React binding: `const { muted, toggle, play } = useSound()`. */
export function useSound(): { muted: boolean; setMuted: (m: boolean) => void; toggle: () => void; play: (name: SoundName) => void } {
  const isMuted = useSyncExternalStore(
    sfx.subscribe,
    () => muted,
    () => true,
  );
  return { muted: isMuted, setMuted: sfx.setMuted, toggle: sfx.toggle, play: sfx.play };
}
