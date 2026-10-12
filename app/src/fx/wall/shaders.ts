/**
 * Shield-wall shaders (GLSL ES 1.00, so they run in WebGL 1 and 2 contexts).
 * Monochrome (v5.1): every colour comes in as a uniform, and the engine only
 * ever passes neutral greys (silver dots and white light on Graphite,
 * graphite on Paper).
 *
 * Everything moves in the vertex shader; the buffers never change:
 *   - the wall: domed hex shields made of dots that breathe (a slow wave of
 *     lift and tilt travels along the wall), lit by a gently swinging key
 *     light with a glint, a soft under-light on the lower lip of every dome
 *     and occlusion under the rim of the shield in front;
 *   - depth: far shields sink into a fog of the page colour and go out of
 *     focus (each dot grows into a soft bokeh disc), near dust drifts past;
 *   - the cursor: the shield under it lifts toward the viewer, nearby dots
 *     part around it and brighten;
 *   - shots: a white streak with a short fading trail flies in (a faint glint
 *     marks the target), the hit lands in one brief burst, sparks spray off
 *     along the wall and cool to silver, and the wall answers with a soft
 *     ripple: a ring through the dots plus a honeycomb wave that lifts whole
 *     shields as it passes their centres. The bigger shot (uEvC.x = 1) has a
 *     thicker streak and a larger burst, and shatters into glinting shards.
 *     On Paper the burst is a thin graphite ring;
 *   - the intro: shields fly in from behind and lock into formation.
 * The fragment shader draws a round dot, a soft glow, a bokeh disc or a ring.
 * Output is premultiplied alpha.
 */
import { MAX_EVENTS } from "./geometry";

export const VERTEX_SHADER = `
precision highp float;

attribute vec4 aPos;
attribute vec4 aShield;
attribute vec4 aInfo;

uniform mat4 uMVP;
uniform vec2 uSize;
uniform float uDpr;
uniform float uFocal;
uniform float uTime;
uniform float uIntro;
uniform vec3 uCursor;
uniform vec2 uShift;
uniform vec4 uMask;
uniform vec4 uEvA[${MAX_EVENTS}];
uniform vec4 uEvB[${MAX_EVENTS}];
uniform vec4 uEvC[${MAX_EVENTS}];
uniform vec3 uInk;
uniform vec3 uIce;
uniform vec3 uDeep;
uniform vec3 uShot;
uniform vec3 uHot;
uniform vec3 uQuant;
uniform vec4 uLook;   // x: alpha gain, y: size gain, z: calm floor behind the headline, w: glow gain
uniform vec4 uGrid;   // cols, rows, shield radius, curvature
uniform vec2 uFog;
uniform vec3 uKeyDir;
uniform vec3 uRimDir;
uniform vec3 uCamPos;
uniform vec4 uSpot;
uniform vec3 uScan;
uniform vec3 uDust;
uniform vec4 uFocus;  // focus distance (clip w), depth of field (clip w), max blur (css px), fog tint
uniform vec4 uFade;   // top fade from, to (css px), bottom fade from, to (css px)
uniform float uTheme; // 0: Graphite (light adds up), 1: Paper (graphite ink over paper)

varying vec4 vColor;
varying float vSoft;
varying float vBokeh;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 rotX(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

vec3 rotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

vec2 toScreen(vec2 ndc) {
  return (ndc * vec2(0.5, -0.5) + 0.5) * uSize;
}

vec2 toNdc(vec2 px) {
  return (px / uSize - 0.5) * vec2(2.0, -2.0);
}

void main() {
  float kind = aInfo.y;
  vec3 p = vec3(0.0);
  vec3 color = uInk;
  float alpha = 0.0;
  float size = 1.0;
  float soft = 0.0;
  float raise = 0.0;
  // Emissive light (scan, impacts, ripple, intro flash, cursor): not dimmed by the light pool.
  float glow = 0.0;

  if (kind < 0.5) {
    // ------------------------------------------------------------ wall ---
    vec2 c = aShield.xy;
    float col = aShield.z;
    float row = aShield.w;
    float R = uGrid.z;
    vec2 u = aPos.xy - c;
    float h1 = hash(vec2(col + 0.31, row + 0.77));
    float h2 = hash(vec2(row + 3.1, col + 1.7));
    float h3 = hash(vec2(col * 1.3 + 5.0, row * 2.1 + 0.4));

    // Intro: shields fly in from behind, near end first, and lock with a flash.
    float delay = (1.0 - col / max(uGrid.x - 1.0, 1.0)) * 0.9 + row * 0.04 + h1 * 0.28;
    float k = clamp((uIntro - delay) / 0.85, 0.0, 1.0);
    float ke = 1.0 - pow(1.0 - k, 4.0);
    float lockFlash = smoothstep(0.7, 1.0, k) * (1.0 - smoothstep(0.0, 0.55, uIntro - delay - 0.85));

    // Breathing: a slow wave of lift and tilt travels along the wall.
    float ph = col * 0.52 - row * 0.74 + h1 * 1.7;
    float w = uTime * 0.78 - ph;
    float tiltX = -0.24 + 0.075 * cos(w) + (h2 - 0.5) * 0.1;
    float tiltY = 0.085 * sin(uTime * 0.51 - ph * 0.8) + (h3 - 0.5) * 0.12;
    float lift = 0.85 * sin(w);

    // Domed shield in its own frame, then tilted.
    float rr = dot(u, u) / (R * R);
    float domeH = 3.2;
    vec3 local = vec3(u, domeH * (1.0 - rr));
    vec3 nrm = vec3(2.0 * domeH * u / (R * R), 1.0);
    local = rotY(rotX(local, tiltX), tiltY);
    nrm = normalize(rotY(rotX(nrm, tiltX), tiltY));

    // The shield nearest the cursor lifts toward the viewer.
    vec4 cc = uMVP * vec4(c, row * 0.9 + 2.0, 1.0);
    if (cc.w > 1.0) {
      vec2 cs = toScreen(cc.xy / cc.w + uShift);
      vec2 cdv = cs - uCursor.xy;
      raise = exp(-dot(cdv, cdv) / 7000.0) * uCursor.z * ke;
    }

    p = vec3(c, row * 0.9) + local;
    p.z += lift + raise * 4.5;

    // Shots: a faint glint on the target, then the hit: the dots give way (dent),
    // a soft ring runs out through them, a gentle honeycomb wave lifts whole
    // shields as it passes their centres, and the hit shield glows and cools.
    float heat = 0.0;
    float ring = 0.0;
    float comb = 0.0;
    float flash = 0.0;
    float dent = 0.0;
    float aim = 0.0;
    for (int i = 0; i < ${MAX_EVENTS}; i++) {
      vec4 A = uEvA[i];
      vec4 B = uEvB[i];
      vec4 C = uEvC[i];
      if (A.w < 0.0) continue;
      float q = C.x;
      float tau = uTime - (A.w + B.w);
      vec2 dv = aPos.xy - A.xy;
      float d2 = dot(dv, dv);
      if (tau < 0.0) {
        float pre = clamp((uTime - A.w) / B.w, 0.0, 1.0);
        aim += exp(-d2 * 0.5) * pre * pre * pre;
      } else if (tau < 3.8) {
        float d = sqrt(d2);
        float ringR = tau * 25.0 * (1.0 + q * 0.3);
        float rg = exp(-pow((d - ringR) / (2.4 + q * 1.2), 2.0)) * exp(-tau * (1.9 - q * 0.5));
        float core = exp(-d2 / (9.0 + q * 10.0)) * exp(-tau * 3.6);
        dent += rg * (1.2 + q * 0.8) + exp(-d2 / (16.0 + q * 14.0)) * exp(-tau * 2.4) * (4.0 + q * 2.5);
        heat += core * (1.0 + q * 0.5);
        ring += rg;
        // Honeycomb: whole shields answer as the wave front passes their centres.
        float dc = length(c - A.xy);
        float front = tau * 28.0 * (1.0 + q * 0.3);
        float reach = 1.0 - smoothstep(R * (2.4 + q * 2.2), R * (4.6 + q * 3.6), dc);
        comb += exp(-pow((dc - front) / (R * 0.8), 2.0)) * exp(-tau * (1.0 - q * 0.3)) * reach;
        flash += (1.0 - smoothstep(R * 0.4, R * 1.05, dc)) * exp(-tau * 2.8) * (1.0 + q * 0.5);
      }
    }
    p.z -= dent;
    p.z += comb * 1.4;
    p.z -= uGrid.w * p.x * p.x;
    p.z -= (1.0 - ke) * 110.0;
    p.y += (1.0 - ke) * (h2 - 0.5) * 26.0;

    // Light: white key from the top left (diffuse + a glint that slides over
    // each dome as the shields breathe), ice under-light from below, and
    // occlusion under the rim of the shield in front.
    vec3 V = normalize(uCamPos - p);
    float diff = max(dot(nrm, uKeyDir), 0.0);
    float spec = pow(max(dot(nrm, normalize(uKeyDir + V)), 0.0), 56.0);
    float under = clamp(-nrm.y * 2.6 - 0.12, 0.0, 1.0);
    float rimL = under * under * (0.55 + 0.45 * max(dot(nrm, uRimDir), 0.0));
    float occ = aPos.w;

    float flag = aInfo.w;
    float isRim = 1.0 - step(0.5, abs(flag - 1.0));
    float isBoss = 1.0 - step(0.5, abs(flag - 2.0));
    float isRing = 1.0 - step(0.5, abs(flag - 3.0));
    float face = 1.0 - max(isRim, isBoss);

    // A soft band of light that now and then runs along the wall.
    float sx = (aPos.x - uScan.x) / uScan.y;
    float scan = exp(-sx * sx) * uScan.z;

    // Faces stay dark (negative space); rims, bosses and glints carry the form.
    float I = 0.03 + 0.4 * diff * diff + 1.6 * spec;
    I += isRim * (0.32 + 0.6 * diff) + isBoss * (0.38 + 0.5 * diff) + isRing * 0.08 * diff;
    I += rimL * 0.42;
    I *= 1.0 - 0.85 * occ * face;
    I *= 0.8 + 0.4 * aInfo.z;

    float rip = ring * 0.62 + comb * (0.07 + isRim * 0.85 + isRing * 0.36 + isBoss * 0.5);
    float emit = scan * (0.1 + isRim * 0.75 + isBoss * 0.45);
    emit += raise * 0.3 + flash * (0.12 + isRim * 0.42 + isBoss * 0.3) + heat * 0.7 + rip * 0.75 + lockFlash * 0.55 + aim * 0.7;

    // Silver ink; the light of the wall (under-light, scan, cursor, its answer to a hit) is white.
    float iceK = clamp(rimL * 0.85 + scan * 0.8 + raise * 0.6 + rip * 1.4 + flash * 0.7 + lockFlash, 0.0, 1.0);
    color = mix(uInk, uIce, iceK);
    color = mix(color, uShot, clamp(aim * 1.6, 0.0, 1.0));
    color = mix(color, uHot, clamp(heat * 0.9 + spec * 0.35, 0.0, 1.0) * 0.85);
    alpha = I * ke;
    glow = emit * ke * uLook.w;
    size = 0.66 + isRim * 0.46 + isBoss * 0.62 + spec * 0.55 + scan * 0.3 + raise * 0.45 + heat * 0.55 + rip * 0.45 + aim * 0.5;
  } else if (kind > 3.5) {
    // ------------------------------------------------------------ dust ---
    // Motes drifting up through the light in front of the wall.
    float speed = aShield.x;
    float ph = aShield.z;
    float span = uDust.y;
    float y = uDust.x + mod(aPos.y - uDust.x + uTime * speed, span);
    float yk = (y - uDust.x) / span;
    p = vec3(aPos.x + sin(uTime * 0.23 + ph) * 2.2, y, aPos.z + cos(uTime * 0.19 + ph * 1.7) * 1.6);
    float edge = smoothstep(0.0, 0.14, yk) * (1.0 - smoothstep(0.86, 1.0, yk));
    float twinkle = 0.55 + 0.45 * sin(uTime * (1.1 + aInfo.z) + ph * 5.0);
    alpha = uDust.z * edge * twinkle * (0.35 + aInfo.z) * clamp(uIntro - 0.8, 0.0, 1.0);
    color = mix(uInk, uIce, step(0.7, aInfo.z) * 0.85);
    size = aShield.y;
    soft = 1.0;
  } else {
    // --------------------------------------------------------- effects ---
    vec4 A = vec4(0.0, 0.0, 0.0, -1.0);
    vec4 B = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 C = vec4(0.0);
    for (int i = 0; i < ${MAX_EVENTS}; i++) {
      if (abs(float(i) - aShield.x) < 0.5) {
        A = uEvA[i];
        B = uEvB[i];
        C = uEvC[i];
      }
    }
    float q = C.x;
    vec3 shot = mix(uShot, uQuant, q);
    vec3 sd = A.xyz - B.xyz;
    if (kind < 1.5) {
      // Streak: a white-hot head and a short trail that thins and fades out
      // (the bigger shot: thicker, brighter, a little longer). The trail drains
      // into the impact point after the hit.
      float s = aShield.y;
      float head = (uTime - A.w) / B.w;
      float uk = head - s * (0.2 + q * 0.1);
      float vis = step(0.0, A.w) * step(0.0, uk) * step(uk, 1.0);
      p = B.xyz + sd * uk + aPos.xyz * (0.03 + s * 0.3) * (1.0 + q * 1.4);
      color = mix(uHot, shot, smoothstep(0.0, 0.4, s));
      alpha = vis * pow(1.0 - s, 2.0) * (1.3 + q * 0.4);
      size = mix(2.3, 0.5, sqrt(s)) * (1.0 + q * 0.95);
      soft = 0.8;
    } else if (kind < 2.5) {
      // Sparks: white, they spray off the shield, slow down, drop a little and
      // cool to silver. The bigger shot shatters (every spark, farther, with
      // shards that glint as they tumble).
      float speed = aShield.y;
      float life = aShield.z * (0.75 + q * 0.55);
      float tau = uTime - (A.w + B.w);
      float used = step(aInfo.z, 0.4 + q * 0.28);
      float vis = used * step(0.0, A.w) * step(0.0, tau) * step(tau, life);
      vec3 refl = reflect(normalize(sd), vec3(0.0, 0.0, 1.0));
      vec3 dir = normalize(vec3(aPos.xy * (1.25 + q * 0.3), abs(aPos.z) * 0.45 + 0.2) + refl * (0.35 - q * 0.1) + vec3(0.0, 0.2, 0.0));
      float reach = speed * (19.0 + q * 17.0) * (1.0 - exp(-4.2 * tau));
      p = A.xyz + dir * reach;
      p.y -= 6.5 * tau * tau;
      p.z = max(p.z, A.z + 0.3);
      float lk = tau / max(life, 0.01);
      color = mix(uHot, shot, smoothstep(0.0, 0.3, lk));
      color = mix(color, shot * 0.55, smoothstep(0.5, 1.0, lk));
      float shard = q * step(0.5, aInfo.z) * step(aInfo.z, 0.68);
      color = mix(color, uIce, shard * (0.5 + 0.5 * sin(tau * 14.0 + aInfo.z * 40.0)));
      alpha = vis * pow(1.0 - lk, 1.6) * 1.2;
      size = mix(1.9, 0.6, lk) * (1.0 + q * 0.15 + shard * 0.3);
      soft = 0.4;
    } else {
      // Impact: one brief white burst with a soft halo (the bigger shot: larger, a moment longer).
      // On Paper a burst of ink would read as a blot: a thin graphite ring opens out and fades instead.
      float tau = uTime - (A.w + B.w);
      float vis = step(0.0, A.w) * step(0.0, tau) * step(tau, 0.6);
      p = A.xyz + vec3(0.0, 0.0, 0.6);
      color = uHot;
      if (uTheme > 0.5) {
        alpha = vis * exp(-tau * (5.5 - q * 1.5)) * (0.5 + q * 0.15);
        size = (5.0 + q * 5.0) * (0.5 + tau * 7.0);
        soft = 2.0;
      } else {
        alpha = vis * exp(-tau * (15.0 - q * 6.5)) * (0.8 + q * 0.2);
        size = (7.5 + q * 8.5) * (0.6 + tau * 3.2);
        soft = 1.0;
      }
    }
  }

  vec4 clip = uMVP * vec4(p, 1.0);
  if (clip.w < 1.0 || alpha + glow <= 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vSoft = 0.0;
    vBokeh = 0.0;
    return;
  }
  vec2 ndc = clip.xy / clip.w + uShift;
  vec2 sp = toScreen(ndc);
  float px = size * 0.42 * uFocal / clip.w * uLook.y;
  float fogK = smoothstep(uFog.x, uFog.y, clip.w);

  if (kind < 0.5) {
    float fog = 1.0 - fogK;
    // A pool of light on the wall; the rest falls off into the dark.
    vec2 ds = sp - uSpot.xy;
    float shade = fog * mix(uSpot.w, 1.0, exp(-dot(ds, ds) / (uSpot.z * uSpot.z)));
    float emissive = mix(fog, 1.0, 0.5);
    // Cursor: dots part around the pointer and glow ice.
    vec2 dc = sp - uCursor.xy;
    float dd = length(dc);
    float cf = exp(-dd * dd / 9000.0) * uCursor.z;
    sp += dc / max(dd, 1.0) * cf * 20.0;
    color = mix(color, uIce, cf * 0.8);
    shade *= 1.0 + cf * 0.6;
    px *= 1.0 + cf * 0.5;
    alpha = alpha * shade + glow * emissive;
  }
  // Depth fog: the far end sinks into indigo.
  color = mix(color, uDeep, fogK * uFocus.w);
  if (kind < 0.5 || kind > 3.5) {
    // Calmer behind the headline.
    vec2 mq = (toNdc(sp) - uMask.xy) / max(uMask.zw, vec2(0.001));
    alpha *= mix(uLook.z, 1.0, smoothstep(0.6, 1.2, length(mq)));
  }
  // Fade in under the navbar and out toward the bottom of the hero (here, not with a CSS mask:
  // a mask on a canvas that redraws every frame costs the compositor).
  alpha *= smoothstep(uFade.x, uFade.y, sp.y) * (1.0 - smoothstep(uFade.z, uFade.w, sp.y));
  ndc = toNdc(sp);

  // Depth of field: out-of-focus dots spread into soft discs (same light, larger, dimmer).
  float dz = abs(clip.w - uFocus.x) / max(uFocus.y, 1.0);
  float coc = uFocus.z * clamp(dz - 0.25, 0.0, 1.6) * (kind > 0.5 && kind < 3.5 ? 0.35 : 1.0);
  float pxB = sqrt(px * px + coc * coc);
  float bokeh = 0.0;
  if (coc > 0.05) {
    alpha *= pow(px * px / (pxB * pxB), 0.72);
    bokeh = clamp(coc / pxB, 0.0, 1.0);
    px = pxB;
  }

  alpha = clamp(alpha * uLook.x, 0.0, 1.0);
  float dev = px * uDpr;
  if (dev < 1.0) {
    alpha *= max(dev, 0.0);
    dev = 1.0;
  }
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = min(dev, 96.0);
  vColor = vec4(color * alpha, alpha);
  vSoft = soft;
  vBokeh = bokeh;
}
`;

export const FRAGMENT_SHADER = `
precision mediump float;

varying vec4 vColor;
varying float vSoft;
varying float vBokeh;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float crisp = 1.0 - smoothstep(0.42, 1.0, r2);
  float glow = exp(-r2 * 4.2);
  // A lens-blur disc: flat, with a soft edge and a faint brighter rim.
  float disc = (1.0 - smoothstep(0.62, 1.0, r2)) * (0.82 + 0.25 * smoothstep(0.3, 0.8, r2));
  // vSoft 2: a thin ring (the impact mark on Paper).
  float ring = smoothstep(0.6, 0.8, r2) * (1.0 - smoothstep(0.84, 1.0, r2));
  float shape = vSoft > 1.5 ? ring : mix(mix(crisp, glow, vSoft), disc, vBokeh);
  gl_FragColor = vColor * shape;
}
`;
