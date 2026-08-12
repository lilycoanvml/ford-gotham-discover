'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { interpolate } from 'flubber';
import type { ConfigId } from '@/app/frontend/types/conversation';

/*
 * ─── MorphSilhouette ────────────────────────────────────────────────────────
 * The signature visual. A dark vehicle silhouette sits under a spotlight and
 * morphs in real time as the user speaks, resolving to the chosen config at the
 * reveal. The morph is driven client-side (keyword scoring of the live speech
 * transcript) so it stays responsive without waiting on the LLM. At the reveal,
 * `resolvedConfigId` is authoritative and overrides any live guess.
 */

// ── PLACEHOLDER SILHOUETTES — replace with official Gotham art per RSF/design ──
// All paths share a compatible structure (single closed side-profile body shell
// in a 0 0 240 120 viewBox, front bumper at ~x24 / rear at ~x216, flat underside
// at y90). Wheels are drawn separately and do not morph. flubber safely
// interpolates between them even where point counts differ.
const PATHS: Record<'neutral_base' | ConfigId, string> = {
  // Ambiguous EV pod — a smooth, low, unreadable dome. The starting state.
  neutral_base:
    'M24,90 L24,74 C24,58 60,44 120,44 C180,44 216,58 216,74 L216,90 Z',

  // Tall, squared-off, rugged — high roofline, stepped shoulders (SUV energy).
  overland_trailblazer:
    'M24,90 L24,64 L40,64 L44,50 L66,44 L176,44 L198,52 L200,64 L216,64 L216,90 Z',

  // Long, low, elegant roof carried the full length (wagon / creative hauler).
  mobile_atelier:
    'M24,90 L24,72 C24,60 48,52 96,50 L168,50 C196,52 214,60 216,72 L216,90 Z',

  // Cab up front, open bed behind — the roofline drops to a low bed wall (truck).
  field_workshop:
    'M24,90 L24,70 L36,70 C42,52 58,46 88,46 L112,46 L120,66 L198,66 L198,70 L216,70 L216,90 Z',

  // Big, tall, flat-roofed box carried end to end (van / long family hauler).
  basecamp_explorer:
    'M24,90 L24,60 C24,50 34,44 52,44 L196,44 C210,44 216,50 216,60 L216,90 Z',

  // Low, fast, tapered roofline (sleek always-in-motion coupe/sedan).
  momentum_commuter:
    'M24,90 L28,78 C44,68 72,66 98,58 C118,52 146,50 178,60 C198,66 210,72 216,80 L216,90 Z',
};

// Live morph driver: keyword scorer over the running transcript. Extend as needed.
const CONFIG_KEYWORDS: Record<ConfigId, string[]> = {
  overland_trailblazer: ['mountain', 'hike', 'trail', 'camera', 'photo', 'sunrise', 'wild', 'outdoors', 'ocean', 'surf', 'off grid', 'national geographic', 'backcountry', 'camp', 'nature'],
  mobile_atelier:       ['art', 'artist', 'design', 'gallery', 'studio', 'create', 'paint', 'fashion', 'street', 'urban', 'exhibit', 'show my work', 'music', 'film'],
  field_workshop:       ['build', 'builder', 'wood', 'furniture', 'craft', 'tools', 'workshop', 'fabricate', 'make', 'on site', 'contractor', 'maker', 'restore'],
  basecamp_explorer:    ['family', 'kids', 'friends', 'road trip', 'travel', 'together', 'community', 'host', 'weekend', 'adventure with', 'people'],
  momentum_commuter:    ['company', 'startup', 'founder', 'business', 'scale', 'city', 'clients', 'launch', 'grow', 'ceo', 'pitch', 'meetings', 'career'],
};

// Exported so static consumers (e.g. the share card, which is rasterized by
// html2canvas) can render a resolved shape without the animated gradient stack.
export const SILHOUETTE_PATHS = PATHS;

const CONFIG_IDS = Object.keys(CONFIG_KEYWORDS) as ConfigId[];

function scoreTranscript(transcript: string): ConfigId | null {
  const t = transcript.toLowerCase();
  if (!t.trim()) return null;
  let best: ConfigId | null = null;
  let bestScore = 0;
  for (const id of CONFIG_IDS) {
    let score = 0;
    for (const kw of CONFIG_KEYWORDS[id]) {
      if (t.includes(kw)) score += kw.includes(' ') ? 2 : 1; // phrases weigh more
    }
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return bestScore > 0 ? best : null;
}

function resolvePath(id: ConfigId | null | undefined): string {
  if (!id) return PATHS.neutral_base;
  if (!(id in PATHS)) {
    console.warn(`[MorphSilhouette] unknown config_id "${id}" — falling back to neutral_base`);
    return PATHS.neutral_base;
  }
  return PATHS[id];
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// A live guess is a PARTIAL morph toward the archetype — alive but unresolved.
const LIVE_BLEND = 0.72;
const partialCache = new Map<ConfigId, string>();
function partialPath(id: ConfigId): string {
  const cached = partialCache.get(id);
  if (cached) return cached;
  const d = interpolate(PATHS.neutral_base, PATHS[id], { maxSegmentLength: 3 })(LIVE_BLEND);
  partialCache.set(id, d);
  return d;
}

interface Props {
  transcript?: string;
  resolvedConfigId?: ConfigId | null;
  illuminate?: boolean;
  primaryColor?: string;
  accentColor?: string;
  variant?: 'ambient' | 'hero';
  className?: string;
  style?: React.CSSProperties;
}

export default function MorphSilhouette({
  transcript = '',
  resolvedConfigId = null,
  illuminate = false,
  primaryColor = '#066FEF',
  accentColor = '#4B9BFF',
  variant = 'ambient',
  className = '',
  style,
}: Props) {
  const [d, setD] = useState<string>(PATHS.neutral_base);
  const currentD = useRef<string>(PATHS.neutral_base);
  const rafRef = useRef<number | null>(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }, []);

  // Target shape: resolved config wins; otherwise a partial live guess; else neutral.
  const liveGuess = useMemo(() => scoreTranscript(transcript), [transcript]);
  const targetD = useMemo(() => {
    if (resolvedConfigId) return resolvePath(resolvedConfigId); // authoritative, full resolve
    if (reducedMotion.current) return PATHS.neutral_base;        // no live morphing when reduced
    return liveGuess ? partialPath(liveGuess) : PATHS.neutral_base;
  }, [resolvedConfigId, liveGuess]);

  useEffect(() => {
    if (targetD === currentD.current) return;

    // Reduced motion (or already resolved under reduced motion): cut instantly.
    if (reducedMotion.current) {
      currentD.current = targetD;
      setD(targetD);
      return;
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const from = currentD.current;
    const to = targetD;
    const interp = interpolate(from, to, { maxSegmentLength: 3 });
    const duration = resolvedConfigId ? 900 : 650; // reveal eases a touch slower
    const start = performance.now();

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = easeInOut(p);
      setD(interp(eased));
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        currentD.current = to;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [targetD, resolvedConfigId]);

  return (
    <div
      className={`morph-silhouette morph-${variant}${illuminate ? ' illuminate' : ''}${className ? ' ' + className : ''}`}
      style={style}
      aria-hidden="true"
    >
      {/* Spotlight cone behind the shape */}
      <div className="morph-spotlight" style={{ background: `radial-gradient(ellipse 60% 80% at 50% 0%, ${accentColor}44, transparent 70%)` }} />
      <svg viewBox="0 0 240 128" className="morph-svg" preserveAspectRatio="xMidYMax meet">
        <defs>
          <linearGradient id="morphBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accentColor} stopOpacity="0.35" />
            <stop offset="55%" stopColor={primaryColor} stopOpacity="0.9" />
            <stop offset="100%" stopColor="#05060B" stopOpacity="1" />
          </linearGradient>
          <radialGradient id="morphFloor" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={accentColor} stopOpacity="0.5" />
            <stop offset="100%" stopColor={accentColor} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ground glow */}
        <ellipse cx="120" cy="112" rx="104" ry="10" fill="url(#morphFloor)" />

        {/* Body shell (morphs) */}
        <path d={d} fill="url(#morphBody)" stroke={accentColor} strokeOpacity="0.55" strokeWidth="1.2" strokeLinejoin="round" />

        {/* Wheels — static, ground the shape while the body morphs */}
        <g fill="#05060B" stroke={accentColor} strokeOpacity="0.5" strokeWidth="1.2">
          <circle cx="66" cy="94" r="16" />
          <circle cx="174" cy="94" r="16" />
        </g>
        <g fill={accentColor} fillOpacity="0.25">
          <circle cx="66" cy="94" r="6" />
          <circle cx="174" cy="94" r="6" />
        </g>
      </svg>
    </div>
  );
}
