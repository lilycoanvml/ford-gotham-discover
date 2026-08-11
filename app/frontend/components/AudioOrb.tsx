'use client';

import { useEffect, useRef } from 'react';

/*
 * ─── AudioOrb ───────────────────────────────────────────────────────────────
 * The discovery screen's only subject. Ported from the AudioCaptureBlob
 * reference in public/ui/orbReference: a canvas blob whose perimeter is
 * distorted by Perlin noise, filled as concentric gradient rings, and lit by a
 * lens flare — then softened by a CSS blur. The whole thing is driven by the
 * coach's live audio level.
 *
 * Differences from the reference, all deliberate:
 *   • Three palette gradients (terra / sage / steel), one per question, cross-
 *     faded through the reference's own stop-interpolation path.
 *   • No bottom-align mode — this orb only ever sits centred in its stage.
 *   • A calmer size boost, because the orb lives inside a stage rather than
 *     taking over the whole viewport.
 */

export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking';

interface GradientStop { position: number; r: number; g: number; b: number; a: number }

/*
 * Each set runs light tint (core) → the palette colour (body) → a darkened
 * edge, with alpha falling off outward, matching the reference's stop shape.
 * Order is terra → sage → steel: the Find / Your / Fathom chips, and the order
 * the three questions are asked in.
 */
const PALETTE_STOPS: GradientStop[][] = [
  [ // terra #DC997E
    { position: 0,    r: 252, g: 228, b: 216, a: 0.75 },
    { position: 0.35, r: 220, g: 153, b: 126, a: 0.25 },
    { position: 1,    r: 110, g: 66,  b: 48,  a: 0.15 },
  ],
  [ // sage #B3C3A9
    { position: 0,    r: 238, g: 245, b: 231, a: 0.75 },
    { position: 0.35, r: 179, g: 195, b: 169, a: 0.25 },
    { position: 1,    r: 84,  g: 96,  b: 76,  a: 0.15 },
  ],
  [ // steel #89A0B1
    { position: 0,    r: 220, g: 234, b: 243, a: 0.75 },
    { position: 0.35, r: 137, g: 160, b: 177, a: 0.25 },
    { position: 1,    r: 58,  g: 76,  b: 90,  a: 0.15 },
  ],
];

const config = {
  // Canvas refresh rate (fps)
  targetFps: 30,

  // Base translation speed when idle
  idleAnimationSpeed: 0.015,
  // Additional speed added at full audio intensity
  maxAnimationSpeedBoost: 0.016,

  // Base shape-change rate when idle
  idleMorphSpeed: 0.5,
  // Additional morph speed at full intensity
  maxMorphSpeedBoost: 0.25,

  // Blob size as fraction of shorter canvas dimension
  baseSize: 0.20,
  // Concentric rings for gradient fill (higher = smoother color bands)
  radialRings: 16,
  // Perimeter polygon segments (higher = smoother silhouette)
  angularSegments: 40,

  // Idle pulse (fades out as intensity increases)
  pulseSpeed: 0.7,
  idlePulseAmount: 0.125,

  // Perlin noise frequency for shape distortion
  idleNoiseScale: 0.6,
  // Negative = smoother shape at peak intensity
  maxNoiseScaleBoost: -0.3,

  // Idle floor — never goes below this.
  // The reference runs 0.8, which lets the radius swing 0.2x–1.8x and reads as
  // an amorphous cloud once calmness hits 0. This orb has to stay legibly an
  // orb, so the swing is roughly halved.
  idleMorphIntensity: 0.45,
  idleSizeMultiplier: 1.0,
  idleFlareIntensity: 0.2,

  // Max boost at intensity = 1 (added to idle). The reference grows 4x because
  // it takes over the viewport; here the orb stays inside its stage.
  maxMorphIntensityBoost: 0.045,
  maxSizeMultiplierBoost: 0.55,
  maxFlareIntensityBoost: 1.5,

  // Lens flare effect on blob surface
  flare: {
    enabled: true,
    // Flare diameter relative to blob radius
    size: 0.4,
    // Center offset (negative = top-left bias). Pulled in from the reference's
    // -0.25 so the hotspot stays inside the body instead of reading as a comet.
    offset: { x: -0.16, y: -0.18 },
    // Near-neutral white so it reads as light on all three palette colours
    color: { r: 255, g: 248, b: 240 },
    // Concentric flare rings
    rings: 10,
    // Angular segments per ring
    segments: 28,
    // Concentric layers with opacity gradient (outer → inner)
    layers: [
      { sizeMultiplier: 1.0, opacity: 0.4 },
      { sizeMultiplier: 0.6, opacity: 0.7 },
      { sizeMultiplier: 0.2, opacity: 1.0 },
    ],
    // Secondary flare for additional light scatter
    secondary: {
      enabled: true,
      offsetMultiplier: -0.6,
      sizeMultiplier: 0.5,
      opacityMultiplier: 0.3,
    },
    shimmer: {
      speed: 1.5,
      amount: 0.15,
    },
  },
};

// Exponential smoothing for audio level transitions.
// Attack outruns release so the orb answers a syllable immediately but settles
// slowly — a symmetric curve reads as lag on the way up and twitch on the way down.
const smoothing = { attack: 0.28, release: 0.09 };

// Duration of gradient color interpolation between stop sets
const COLOR_FADE_DURATION_SECS = 1.2;

// How much of the idle motion each mode keeps. 1 = almost still.
const CALMNESS: Record<OrbMode, number> = {
  idle: 0.72,
  thinking: 0.32,
  listening: 0.12,
  speaking: 0,
};

// ─── Perlin noise ────────────────────────────────────────────────────────────
// Deterministic permutation table (no random seed needed).
const permutation = new Uint8Array(512);
for (let i = 0; i < 256; i++) {
  permutation[i] = permutation[i + 256] = (i * 167 + 53) & 255;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

// Returns a value in roughly [-1, 1].
function noise(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;

  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);

  const u = fade(x);
  const v = fade(y);
  const w = fade(z);

  const A = permutation[X]! + Y;
  const AA = permutation[A]! + Z;
  const AB = permutation[A + 1]! + Z;
  const B = permutation[X + 1]! + Y;
  const BA = permutation[B]! + Z;
  const BB = permutation[B + 1]! + Z;

  return lerp(w,
    lerp(v,
      lerp(u, grad(permutation[AA]!, x, y, z), grad(permutation[BA]!, x - 1, y, z)),
      lerp(u, grad(permutation[AB]!, x, y - 1, z), grad(permutation[BB]!, x - 1, y - 1, z))),
    lerp(v,
      lerp(u, grad(permutation[AA + 1]!, x, y, z - 1), grad(permutation[BA + 1]!, x - 1, y, z - 1)),
      lerp(u, grad(permutation[AB + 1]!, x, y - 1, z - 1), grad(permutation[BB + 1]!, x - 1, y - 1, z - 1))));
}

// Pre-computed trig tables for the blob perimeter polygon.
const maxSegments = Math.max(config.angularSegments, config.flare.segments);
const cosTable = new Float32Array(maxSegments + 1);
const sinTable = new Float32Array(maxSegments + 1);

for (let i = 0; i <= maxSegments; i++) {
  const angle = (i / maxSegments) * Math.PI * 2;
  cosTable[i] = Math.cos(angle);
  sinTable[i] = Math.sin(angle);
}

function getMorphedRadius(
  cosAngle: number, sinAngle: number, baseRadius: number,
  timeX: number, timeY: number, noiseOffset: number,
  morphIntensity: number, noiseScale: number,
): number {
  const noiseValue = noise(
    cosAngle * noiseScale + noiseOffset + timeX,
    sinAngle * noiseScale + noiseOffset + timeY,
    0,
  );
  return baseRadius * (1 + noiseValue * morphIntensity);
}

function getGradientColor(normalizedRadius: number, stops: GradientStop[]): string {
  const clampedPos = Math.max(0, Math.min(1, normalizedRadius));

  let stop1 = stops[0]!;
  let stop2 = stops[stops.length - 1]!;

  for (let i = 0; i < stops.length - 1; i++) {
    if (clampedPos >= stops[i]!.position && clampedPos <= stops[i + 1]!.position) {
      stop1 = stops[i]!;
      stop2 = stops[i + 1]!;
      break;
    }
  }

  const range = stop2.position - stop1.position;
  const factor = range === 0 ? 0 : (clampedPos - stop1.position) / range;

  const r = (stop1.r + (stop2.r - stop1.r) * factor) | 0;
  const g = (stop1.g + (stop2.g - stop1.g) * factor) | 0;
  const b = (stop1.b + (stop2.b - stop1.b) * factor) | 0;
  const a = stop1.a + (stop2.a - stop1.a) * factor;

  return `rgba(${r},${g},${b},${a})`;
}

function getFlareColor(normalizedRadius: number, layerOpacity: number, shimmerFactor: number, flareIntensity: number): string {
  const { color } = config.flare;
  const v = 1 - normalizedRadius;
  // pow(v, 2.5) approximation
  const falloff = v * v * Math.sqrt(v);
  const alpha = falloff * layerOpacity * flareIntensity * (1 + shimmerFactor);
  return `rgba(${color.r},${color.g},${color.b},${Math.min(1, alpha)})`;
}

function drawFlareLayer(
  ctx: CanvasRenderingContext2D, centerX: number, centerY: number, baseRadius: number,
  timeX: number, timeY: number, noiseOffset: number,
  sizeMultiplier: number, layerOpacity: number, shimmerFactor: number,
  flareIntensity: number, morphIntensity: number, noiseScale: number,
) {
  const { rings, segments } = config.flare;
  const layerRadius = baseRadius * sizeMultiplier;
  const flareMorphIntensity = morphIntensity * 0.7;
  const segmentRatio = maxSegments / segments;

  for (let ring = rings; ring >= 0; ring--) {
    const normalizedRadius = ring / rings;
    const ringRadius = layerRadius * normalizedRadius;
    const color = getFlareColor(normalizedRadius, layerOpacity, shimmerFactor, flareIntensity);

    ctx.beginPath();

    for (let i = 0; i <= segments; i++) {
      const cacheIndex = (i * segmentRatio) | 0;
      const cosAngle = cosTable[cacheIndex]!;
      const sinAngle = sinTable[cacheIndex]!;

      const morphedRadius = getMorphedRadius(cosAngle, sinAngle, ringRadius, timeX, timeY, noiseOffset, flareMorphIntensity, noiseScale);
      const x = centerX + cosAngle * morphedRadius;
      const y = centerY + sinAngle * morphedRadius;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawLensFlare(
  ctx: CanvasRenderingContext2D, blobCenterX: number, blobCenterY: number,
  blobRadius: number, timeX: number, timeY: number, noiseOffset: number,
  time: number, flareIntensity: number, morphIntensity: number, noiseScale: number,
) {
  if (!config.flare.enabled) return;

  const { offset, size, layers, secondary, shimmer } = config.flare;
  const shimmerFactor = Math.sin(time * shimmer.speed) * shimmer.amount;

  const flareOffsetX = blobRadius * offset.x;
  const flareOffsetY = blobRadius * offset.y;
  const flareCenterX = blobCenterX + flareOffsetX;
  const flareCenterY = blobCenterY + flareOffsetY;
  const flareBaseRadius = blobRadius * size;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const layer of layers) {
    drawFlareLayer(
      ctx, flareCenterX, flareCenterY, flareBaseRadius,
      timeX, timeY, noiseOffset,
      layer.sizeMultiplier, layer.opacity, shimmerFactor,
      flareIntensity, morphIntensity, noiseScale,
    );
  }

  if (secondary.enabled) {
    const secondaryX = blobCenterX + flareOffsetX * secondary.offsetMultiplier;
    const secondaryY = blobCenterY + flareOffsetY * secondary.offsetMultiplier;
    const secondaryRadius = flareBaseRadius * secondary.sizeMultiplier;

    for (const layer of layers) {
      drawFlareLayer(
        ctx, secondaryX, secondaryY, secondaryRadius,
        timeX, timeY, noiseOffset + 50,
        layer.sizeMultiplier, layer.opacity * secondary.opacityMultiplier, shimmerFactor * 0.5,
        flareIntensity, morphIntensity, noiseScale,
      );
    }
  }

  ctx.restore();
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function AudioOrb({ colorIndex, mode, getLevel }: {
  colorIndex: number;
  mode: OrbMode;
  /** Current loudness in [0,1]. Read every frame; never re-renders the orb. */
  getLevel: () => number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest props for the render loop to read — the loop is set up once, so
  // changing mode or colour must not tear it down and reset the animation.
  const live = useRef({ colorIndex, mode, getLevel });
  live.current = { colorIndex, mode, getLevel };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let displayWidth = 0;
    let displayHeight = 0;
    let time = 0;
    let morphPhase = 0;
    let smoothedIntensity = 0;
    const noiseOffset = Math.random() * 1000;

    let activeIndex = ((live.current.colorIndex % 3) + 3) % 3;
    let currentStops: GradientStop[] = [...PALETTE_STOPS[activeIndex]!];
    let nextStops: GradientStop[] | null = null;
    let colorFadeProgress = 1;

    // Lerps between currentStops and nextStops based on colorFadeProgress.
    function resolvedStops(): GradientStop[] {
      if (!nextStops || colorFadeProgress >= 1) return currentStops;

      const t = colorFadeProgress;
      const len = Math.max(currentStops.length, nextStops.length);
      const resolved: GradientStop[] = [];

      for (let i = 0; i < len; i++) {
        const a = currentStops[Math.min(i, currentStops.length - 1)]!;
        const b = nextStops[Math.min(i, nextStops.length - 1)]!;
        resolved.push({
          position: a.position + (b.position - a.position) * t,
          r: a.r + (b.r - a.r) * t,
          g: a.g + (b.g - a.g) * t,
          b: a.b + (b.b - a.b) * t,
          a: a.a + (b.a - a.a) * t,
        });
      }

      return resolved;
    }

    // Uses offsetWidth/offsetHeight instead of getBoundingClientRect so CSS
    // transforms don't cause 0×0 initialization.
    function updateCanvasSize() {
      if (!canvas || !ctx) return;
      displayWidth = canvas.offsetWidth;
      displayHeight = canvas.offsetHeight;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = displayWidth * dpr;
      canvas.height = displayHeight * dpr;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }

    function drawBlob(
      pulsedRadius: number, timeX: number, timeY: number,
      morphIntensity: number, noiseScale: number, flareIntensity: number,
      stops: GradientStop[],
    ) {
      if (!ctx) return;
      const centerX = displayWidth / 2;
      const centerY = displayHeight / 2;
      const segmentRatio = maxSegments / config.angularSegments;

      ctx.save();

      // Back to front: the widest, faintest ring first, building density inward.
      for (let ring = config.radialRings; ring >= 0; ring--) {
        const normalizedRadius = ring / config.radialRings;
        const ringRadius = pulsedRadius * normalizedRadius;
        const color = getGradientColor(normalizedRadius, stops);

        ctx.beginPath();

        for (let i = 0; i <= config.angularSegments; i++) {
          const cacheIndex = (i * segmentRatio) | 0;
          const cosAngle = cosTable[cacheIndex]!;
          const sinAngle = sinTable[cacheIndex]!;

          const morphedRadius = getMorphedRadius(cosAngle, sinAngle, ringRadius, timeX, timeY, noiseOffset, morphIntensity, noiseScale);
          const x = centerX + cosAngle * morphedRadius;
          const y = centerY + sinAngle * morphedRadius;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }

      drawLensFlare(ctx, centerX, centerY, pulsedRadius, timeX, timeY, noiseOffset, time, flareIntensity, morphIntensity, noiseScale);

      ctx.restore();
    }

    function renderFrame(elapsedSecs: number) {
      if (!ctx) return;

      const { colorIndex: idx, mode: m, getLevel: level } = live.current;

      // Colour hand-off — start a cross-fade the frame the question changes.
      const wanted = ((idx % 3) + 3) % 3;
      if (wanted !== activeIndex) {
        activeIndex = wanted;
        currentStops = resolvedStops();
        nextStops = [...PALETTE_STOPS[wanted]!];
        colorFadeProgress = 0;
      }

      if (nextStops && colorFadeProgress < 1) {
        colorFadeProgress = Math.min(1, colorFadeProgress + elapsedSecs / COLOR_FADE_DURATION_SECS);
        if (colorFadeProgress >= 1) {
          currentStops = [...nextStops];
          nextStops = null;
        }
      }

      const stops = resolvedStops();

      const target = Math.max(0, Math.min(1, level()));
      const factor = target > smoothedIntensity ? smoothing.attack : smoothing.release;
      smoothedIntensity += (target - smoothedIntensity) * factor;

      const boost = smoothedIntensity;
      // calm = 1 reduces idle animation to ~10% of its default values
      const calm = 1 - CALMNESS[m] * 0.9;
      const animationSpeed = config.idleAnimationSpeed * calm + boost * config.maxAnimationSpeedBoost;
      const morphSpeed = config.idleMorphSpeed * calm + boost * config.maxMorphSpeedBoost;
      const morphIntensity = config.idleMorphIntensity * calm + boost * config.maxMorphIntensityBoost;
      const noiseScale = config.idleNoiseScale + boost * config.maxNoiseScaleBoost;
      const sizeMultiplier = config.idleSizeMultiplier + boost * config.maxSizeMultiplierBoost;
      const flareIntensity = config.idleFlareIntensity + boost * config.maxFlareIntensityBoost;

      time += animationSpeed;
      morphPhase += animationSpeed * morphSpeed;

      ctx.clearRect(0, 0, displayWidth, displayHeight);

      const baseRadius = Math.min(displayWidth, displayHeight) * config.baseSize * sizeMultiplier;
      const idlePulse = Math.sin(time * config.pulseSpeed) * config.idlePulseAmount * calm * (1 - boost);
      const pulsedRadius = baseRadius * (1 + idlePulse);

      const loopRadius = 2.0;
      const timeX = Math.cos(morphPhase) * loopRadius;
      const timeY = Math.sin(morphPhase) * loopRadius;

      drawBlob(pulsedRadius, timeX, timeY, morphIntensity, noiseScale, flareIntensity, stops);
    }

    updateCanvasSize();

    const resizeObserver = new ResizeObserver(() => updateCanvasSize());
    resizeObserver.observe(canvas);

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    // Reduced motion gets a single static frame — the shape and colour still
    // read, nothing moves.
    if (reduceMotion?.matches) {
      renderFrame(0);
      return () => resizeObserver.disconnect();
    }

    const frameInterval = 1000 / config.targetFps;
    let lastFrameTime = performance.now();
    let raf = requestAnimationFrame(function animate(timestamp: number) {
      raf = requestAnimationFrame(animate);

      // Nothing to draw behind a hidden tab; rAF is already throttled there,
      // but this keeps the animation from lurching on return.
      if (document.hidden) { lastFrameTime = timestamp; return; }

      const elapsed = timestamp - lastFrameTime;
      if (elapsed < frameInterval) return;
      lastFrameTime = timestamp - (elapsed % frameInterval);

      renderFrame(elapsed / 1000);
    });

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div className="fathom-orb" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
