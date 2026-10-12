/**
 * The background light's fragment shader (GLASS_V51 section 1): up to four huge, soft light pools (white and grays,
 * colours and peak strengths from CSS: --aurora-1..4 / --aurora-alpha) on graphite. Their centres drift on slow
 * Lissajous paths (40-80 s periods), a low-frequency warp bends them gently, scrolling the page turns the
 * composition and the pointer leans it. A pool with strength 0 costs nothing visible (v5.1 uses three).
 * Drawn at a fraction of the viewport resolution: the fields are smooth, so the bilinear upscale is invisible.
 * v6 (PIXEL_V6): with uDither = 1 each pool is quantised into uLevels steps through a 4x4 Bayer matrix (ordered
 * dithering) and the canvas is shown with image-rendering: pixelated at an integer scale, so the light reads as
 * a 1-bit print made of square pixels that drift. uDither = 0 restores the smooth light.
 */

export const AURORA_VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const AURORA_FRAG = `
precision mediump float;

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPointer;
uniform float uScroll;
uniform vec3 uBg;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uAlpha;
uniform float uVignette;
uniform float uDither;
uniform float uLevels;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

// 4x4 Bayer threshold in (0, 1) for the canvas pixel p: B4 = 4 * B2(low bits) + B2(high bits), B2(x, y) = (2x + 3y) mod 4.
float b2(vec2 a) {
  return mod(2.0 * a.x + 3.0 * a.y, 4.0);
}
float bayer4(vec2 p) {
  vec2 c = mod(floor(p), 4.0);
  return (4.0 * b2(mod(c, 2.0)) + b2(floor(c * 0.5)) + 0.5) / 16.0;
}
// Ordered-dither a 0..1 amount into uLevels steps (or pass it through when dithering is off).
float dq(float m, float th) {
  if (uDither < 0.5) return m;
  return clamp(floor(m * uLevels + th) / uLevels, 0.0, 1.0);
}

float field(vec2 p, vec2 c, vec2 r) {
  vec2 d = (p - c) / r;
  return exp(-dot(d, d));
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = gl_FragCoord.xy / uRes.y;
  p.y = 1.0 - p.y;
  float t = uTime;
  float s = uScroll;

  // Liquid warp: a slow, low-frequency bend of the whole plane.
  vec2 w = vec2(
    fbm(p * 1.3 + vec2(t * 0.012, -t * 0.010 + s * 0.15)),
    fbm(p * 1.3 + vec2(-t * 0.008 + 7.3, t * 0.014 + 3.1))
  ) - 0.5;
  vec2 q = p + w * 0.42;
  vec2 lean = uPointer * vec2(0.06, 0.04);

  // Field centres (x in 0..aspect, y in 0..1 from the top). Periods: 60, 74, 52, 80 s; scrolling turns the phase.
  vec2 c0 = vec2(aspect * (0.20 + 0.10 * sin(t * 0.1047 + s * 0.9)), 0.08 + 0.10 * cos(t * 0.0849 + s * 1.1)) + lean;
  vec2 c1 = vec2(aspect * (0.80 + 0.08 * cos(t * 0.0849 - s * 0.7)), 0.02 + 0.14 * sin(t * 0.1208 + s * 0.8)) - lean;
  vec2 c2 = vec2(aspect * (0.34 + 0.16 * sin(t * 0.0785 + 1.7 - s * 0.6)), 0.92 + 0.10 * cos(t * 0.1047 + s * 1.3)) + lean * 0.6;
  vec2 c3 = vec2(aspect * (0.88 + 0.07 * sin(t * 0.1396 + 0.6 + s * 0.5)), 0.78 + 0.12 * sin(t * 0.0942 - s)) - lean * 0.5;

  float f0 = field(q, c0, vec2(0.62 * max(aspect, 1.0) * 0.6, 0.40));
  float f1 = field(q, c1, vec2(0.80 * max(aspect, 1.0) * 0.6, 0.46));
  float f2 = field(q, c2, vec2(0.70 * max(aspect, 1.0) * 0.6, 0.44));
  float f3 = field(q, c3, vec2(0.50 * max(aspect, 1.0) * 0.6, 0.32));

  float th = bayer4(gl_FragCoord.xy);
  vec3 col = uBg;
  col = mix(col, uC1, dq(clamp(f1, 0.0, 1.0), th) * uAlpha.y);
  col = mix(col, uC2, dq(clamp(f2, 0.0, 1.0), fract(th + 0.25)) * uAlpha.z);
  col = mix(col, uC0, dq(clamp(f0, 0.0, 1.0), fract(th + 0.5)) * uAlpha.x);
  col = mix(col, uC3, dq(clamp(f3, 0.0, 1.0), fract(th + 0.75)) * uAlpha.w);

  // Soft vignette towards the corners (dark theme); a little darker at the very top keeps the navbar calm.
  vec2 v = gl_FragCoord.xy / uRes - 0.5;
  float vig = smoothstep(0.35, 0.95, length(v * vec2(1.0, 1.15)));
  col = mix(col, uBg * 0.6, dq(vig, th) * uVignette);

  // Smooth mode only: a 1/255 noise breaks 8-bit banding in the dark gradients.
  if (uDither < 0.5) col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
