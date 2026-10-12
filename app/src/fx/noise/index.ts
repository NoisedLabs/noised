/**
 * fx/noise: the "signal from noise" effects (the brand is Noised). Fine monochrome dots drift in a curl-noise flow
 * and coalesce into crisp shapes, hold with a faint shimmer, then dissolve back into noise and re-form.
 *
 *   NoiseArt      a scene (shapes sampled from vector paths in code) on a canvas; parts around the pointer
 *   NoiseGrain    an extremely quiet field of dots behind a section
 *   useNoiseReveal / NoiseReveal / ResolveText    content and headlines that resolve in from noise
 *   DotSpinner    the loading mark (a ring of dots)
 *   noiseWipe     the theme switch
 *
 * Every effect: theme ink only (white / silver on graphite, graphite on paper), one shared frame loop, paused off
 * screen and in a hidden tab, devicePixelRatio <= 1.5, the formed still frame under reduced motion, aria-hidden
 * decoration, and CSP-safe (no innerHTML, no <style> injection: CSSOM only).
 */
export { NoiseArt, type NoiseArtProps } from "./NoiseArt";
export { NoiseGrain, type NoiseGrainProps, type GrainFade } from "./NoiseGrain";
export { NoiseReveal, useNoiseReveal, playResolve, resolveMask, type NoiseRevealOptions, type NoiseRevealProps, type ResolveSweep } from "./reveal";
export { ResolveText, type ResolveTextProps } from "./ResolveText";
export { DotSpinner, type DotSpinnerProps } from "./DotSpinner";
export { noiseWipe, type NoiseWipeOptions } from "./wipe";
export { motionStill } from "./env";
export {
  buildField,
  computeFrame,
  createFrame,
  loopOf,
  stepStart,
  stillTime,
  timelineAt,
  timingOf,
  type AccentPen,
  type Field,
  type FrameOut,
  type GroupTransform,
  type NoiseScene,
  type PointInfo,
  type SceneStep,
  type StepTiming,
  type StreamSpec,
} from "./field";
export { arc, circle, ellipse, hexagon, line, parsePath, polygon, rect, roundRect, sampleShape, shape, type Poly, type Shape, type ShapeBuilder, type ShapePoints } from "./shape";
