'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/app/frontend/hooks/useChat';
import type { GothamRevealPayload, ConfigId } from '@/app/frontend/hooks/useChat';
import { CONFIG_LABELS } from '@/app/theme/ford-brand';
import AudioOrb from '@/app/frontend/components/AudioOrb';
import type { OrbMode } from '@/app/frontend/components/AudioOrb';
import { QUESTIONS } from '@/app/lib/script';

// ─── TYPES ───────────────────────────────────────────────────────────────────
type Screen = 'landing' | 'chat' | 'reveal' | 'capture' | 'share';

// Validate the model's config_id against the five known shapes; fall back safely.
const KNOWN_CONFIGS = Object.keys(CONFIG_LABELS) as ConfigId[];
function safeConfig(id: string | undefined): ConfigId | null {
  if (id && (KNOWN_CONFIGS as string[]).includes(id)) return id as ConfigId;
  if (id) console.warn(`[reveal] unknown config_id "${id}" — silhouette will use neutral_base`);
  return null;
}

// ─── TTS ─────────────────────────────────────────────────────────────────────
let voiceCache: SpeechSynthesisVoice[] = [];
let currentAudio: HTMLAudioElement | null = null;

// Web Audio is used for the streaming Gemini path: the coach's line arrives as
// raw PCM chunks and each is scheduled back-to-back so playback starts ~750ms
// in rather than waiting out the whole ~10s generation.
let audioCtx: AudioContext | null = null;
let liveSources: AudioBufferSourceNode[] = [];
let speechToken = 0; // bumped on every new utterance so stale streams self-cancel

// Every playback path is routed through this analyser so the orb can render the
// coach's actual waveform rather than a canned animation.
let analyser: AnalyserNode | null = null;
let analyserData: Uint8Array<ArrayBuffer> | null = null;
// The Web Speech fallback has no node graph to tap; the orb runs on a synthetic
// envelope for that path only, so it never freezes mid-sentence.
let syntheticSpeech = false;

// A smooth, speech-ish envelope in [0,1]. Two detuned sines beat against each
// other, which reads as syllables rather than a metronome.
function syntheticEnvelope(): number {
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  const v = Math.abs(Math.sin(t * 6.1)) * 0.6 + Math.abs(Math.sin(t * 2.7)) * 0.4;
  return Math.min(1, v);
}

// Current output loudness in [0,1] — RMS of the time-domain buffer.
function audioLevel(): number {
  if (syntheticSpeech) return syntheticEnvelope();
  if (!analyser || !analyserData) return 0;
  analyser.getByteTimeDomainData(analyserData);
  let sum = 0;
  for (let i = 0; i < analyserData.length; i++) {
    const v = (analyserData[i] - 128) / 128;
    sum += v * v;
  }
  // Speech RMS sits well below 1.0, so scale up before clamping.
  return Math.min(1, Math.sqrt(sum / analyserData.length) * 3.4);
}

function primeVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const load = () => { voiceCache = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.addEventListener('voiceschanged', load);
}

// Create/resume the AudioContext from inside a real tap — iOS Safari will not
// start one otherwise, and every later coach line depends on it.
function primeAudio() {
  if (typeof window === 'undefined') return;
  try {
    const Ctor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.72;
      analyser.connect(audioCtx.destination);
      analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* fall back to the <audio> path */ }
}

// Warm up the TTS endpoint so the first real call isn't slowed by cold start.
async function prewarmTTS() {
  if (typeof window === 'undefined') return;
  try {
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warm: true }),
      keepalive: true,
    });
  } catch { /* silent — best-effort */ }
}

// Stop every playback path at once: streamed PCM, <audio> element, Web Speech.
function stopSpeech() {
  if (typeof window === 'undefined') return;
  speechToken++;
  syntheticSpeech = false;
  for (const src of liveSources) { try { src.onended = null; src.stop(); } catch { /* already ended */ } }
  liveSources = [];
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis?.cancel();
}

// Play a streamed 16-bit little-endian PCM body, scheduling chunks as they land.
// Resolves when the last chunk finishes; firing the end-of-turn callbacks is
// speakParts' job, since a turn can be several segments long.
async function playPcmStream(res: Response, token: number) {
  primeAudio();
  const ctx = audioCtx;
  if (!ctx || !res.body) throw new Error('Web Audio unavailable');
  if (ctx.state === 'suspended') await ctx.resume();

  const rate = Number(res.headers.get('X-Audio-Rate')) || 24000;
  const reader = res.body.getReader();
  let playhead = 0;
  let tail: AudioBufferSourceNode | null = null;
  let carry = new Uint8Array(0); // odd trailing byte of a chunk waits for the next

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (token !== speechToken) { await reader.cancel(); return; } // interrupted

    // Stitch the carried byte onto this chunk, then keep a whole number of samples
    const buf = carry.length ? new Uint8Array([...carry, ...value]) : value;
    const usable = buf.length - (buf.length % 2);
    carry = usable === buf.length ? new Uint8Array(0) : buf.subarray(usable);
    if (!usable) continue;

    const view = new DataView(buf.buffer, buf.byteOffset, usable);
    const samples = new Float32Array(usable / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    const audioBuffer = ctx.createBuffer(1, samples.length, rate);
    audioBuffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(analyser ?? ctx.destination);

    // 120ms of lead-in absorbs network jitter without a noticeable delay
    playhead = Math.max(playhead, ctx.currentTime + 0.12);
    src.start(playhead);
    playhead += audioBuffer.duration;

    liveSources.push(src);
    src.onended = () => { liveSources = liveSources.filter(s => s !== src); };
    tail = src;
  }

  if (token !== speechToken) return;
  if (!tail) throw new Error('no audio in stream');

  // The last scheduled chunk finishing is the end of the utterance
  await new Promise<void>(resolve => {
    tail!.onended = () => { liveSources = liveSources.filter(s => s !== tail); resolve(); };
  });
}

// Web Speech API fallback (used when GCP TTS route is unavailable locally)
function speakFallback(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Warm, grounded male delivery to match the Cloud TTS "Charon" voice.
  utterance.rate = 1.05; utterance.pitch = 0.92; utterance.volume = 1;
  const voices = voiceCache.length > 0 ? voiceCache : window.speechSynthesis.getVoices();
  const preferred =
    voices.find(v => v.name === 'Google UK English Male')   ||
    voices.find(v => v.name === 'Daniel')                   ||
    voices.find(v => v.name === 'Alex')                     ||
    voices.find(v => v.name === 'Fred')                     ||
    voices.find(v => v.lang.startsWith('en') && v.name.toLowerCase().includes('male')) ||
    voices.find(v => v.lang.startsWith('en'));
  if (preferred) utterance.voice = preferred;
  // No audio graph on this path — drive the orb from the synthetic envelope.
  syntheticSpeech = true;
  const done = () => { syntheticSpeech = false; };
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}

// Module-level callbacks so screens can show speaking state on the orb
let _onSpeakStart: (() => void) | null = null;
let _onSpeakEnd: (() => void) | null = null;

// Sanitize closingMessage — Gemini occasionally returns template text instead of
// actual content (square-bracket instructions). Strip it to a safe fallback.
function sanitizeClosingMsg(msg: string): string {
  if (!msg || msg.startsWith('[') || msg.length > 350) {
    return "Here's who you're becoming — and the vehicle built to take you there. Take a look.";
  }
  return msg.replace(/\[.*?\]/g, '').trim() || "Take a look at who you're becoming.";
}

/*
 * Speech cache. The three questions never change, so their audio is fetched
 * during the previous turn and played from memory — the expensive part of a
 * turn (synthesising ~10s of speech) stops being on the critical path, and only
 * the short reaction is generated live.
 */
type Clip = { samples: Float32Array<ArrayBuffer>; rate: number };
const ttsCache = new Map<string, Clip>();
const ttsInflight = new Map<string, Promise<void>>();

/*
 * How long the mic keeps listening after the user stops making sound before
 * Miles takes his turn. Natural turn-taking gaps run ~200ms; this was 2500ms,
 * which was the single largest slice of dead air in the loop.
 */
const SILENCE_MS = 1000;

// How long after Miles stops before the mic reopens. Was 700ms + a 250ms
// hand-off; conversational gaps are far shorter than that.
const POST_SPEECH_MS = 250;

function decodePcm(buf: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buf);
  const out = new Float32Array(new ArrayBuffer(Math.floor(buf.byteLength / 2) * 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

async function fetchTTS(text: string): Promise<Response> {
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Synthesise ahead of time and hold it. Idempotent; failures are silent. */
function prefetchSpeech(text?: string) {
  if (typeof window === 'undefined') return;
  if (!text || ttsCache.has(text) || ttsInflight.has(text)) return;
  const job = (async () => {
    const res = await fetchTTS(text);
    if (!res.ok) throw new Error('prefetch failed');
    // Only the streaming Gemini path is cacheable; the Cloud TTS fallback
    // returns a whole clip that the live path already handles fine.
    if (!res.headers.get('Content-Type')?.startsWith('audio/')) return;
    const rate = Number(res.headers.get('X-Audio-Rate')) || 24000;
    ttsCache.set(text, { samples: decodePcm(await res.arrayBuffer()), rate });
  })().catch(() => { /* fall back to live synthesis at play time */ })
    .finally(() => { ttsInflight.delete(text); });
  ttsInflight.set(text, job);
}

/** Play an already-synthesised clip. Resolves when it finishes. */
async function playClip(clip: Clip, token: number): Promise<void> {
  primeAudio();
  const ctx = audioCtx;
  if (!ctx) throw new Error('Web Audio unavailable');
  if (ctx.state === 'suspended') await ctx.resume();

  const buffer = ctx.createBuffer(1, clip.samples.length, clip.rate);
  buffer.copyToChannel(clip.samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser ?? ctx.destination);
  src.start(ctx.currentTime + 0.02);
  liveSources.push(src);

  await new Promise<void>(resolve => {
    src.onended = () => { liveSources = liveSources.filter(s => s !== src); resolve(); };
  });
  if (token !== speechToken) return;
}

/** Cloud TTS fallback shape: one complete clip through an <audio> element. */
async function playJsonClip(res: Response, token: number): Promise<void> {
  const { audio, mime } = await res.json();
  if (token !== speechToken) return;
  const el = new Audio(`data:${mime || 'audio/ogg'};base64,${audio}`);
  currentAudio = el;
  // Tap into the same analyser so the orb reacts on this path too.
  primeAudio();
  if (audioCtx && analyser) {
    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      audioCtx.createMediaElementSource(el).connect(analyser);
    } catch { /* untapped — the clip still plays, the orb just breathes */ }
  }
  const done = new Promise<void>(resolve => {
    el.addEventListener('ended', () => resolve(), { once: true });
  });
  await el.play();
  await done;
}

/*
 * Speak a turn, one segment at a time. A reaction+question turn is two
 * segments: the reaction is synthesised live, the question comes straight out
 * of the cache, so it lands right behind it with only a scheduling gap — which
 * reads as the natural beat between a remark and a question.
 */
async function speakParts(parts: string[], onEnd?: () => void) {
  if (typeof window === 'undefined') return;
  stopSpeech();
  const token = speechToken;
  _onSpeakStart?.();

  const segments = parts.map(p => p?.trim()).filter(Boolean) as string[];
  try {
    for (const segment of segments) {
      if (token !== speechToken) return;

      const inflight = ttsInflight.get(segment);
      if (inflight) await inflight;           // prefetch still landing — ride it
      const cached = ttsCache.get(segment);
      if (cached) { await playClip(cached, token); continue; }

      const res = await fetchTTS(segment);
      if (!res.ok) throw new Error('TTS unavailable');
      if (token !== speechToken) return;
      if (res.headers.get('Content-Type')?.startsWith('audio/')) await playPcmStream(res, token);
      else await playJsonClip(res, token);
    }
    if (token !== speechToken) return;
    _onSpeakEnd?.();
    if (onEnd) setTimeout(onEnd, POST_SPEECH_MS);
  } catch {
    if (token !== speechToken) return;
    const text = segments.join(' ');
    speakFallback(text);
    // Web Speech gives no reliable end event across browsers, so hold the
    // speaking state (and the orb's motion) for a word-count estimate.
    const est = Math.max(2800, text.split(' ').length * 380);
    setTimeout(() => { if (token === speechToken) _onSpeakEnd?.(); }, est);
    if (onEnd) setTimeout(onEnd, est);
  }
}

const speak = (text: string, onEnd?: () => void) => speakParts([text], onEnd);

// ─── ICONS ───────────────────────────────────────────────────────────────────
function MicIcon({ size = 22, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2.5" width="6" height="12" rx="3" fill={color} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M12 17.5V21M8.5 21h7" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function KeyboardIcon({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2.5" y="6" width="19" height="13" rx="2.2" stroke={color} strokeWidth="1.8" />
      <path d="M6 10h0.5M9 10h0.5M12 10h0.5M15 10h0.5M18 10h0.5M6 13h0.5M9 13h0.5M12 13h0.5M15 13h0.5M18 13h0.5M8 16h8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function SendIcon({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 12L20 4L13 20L11 13L4 12Z" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

// ─── COACH ORB ───────────────────────────────────────────────────────────────
// Luminous blue presence standing in for the coach. Visual only.
function CoachOrb({ size, state = 'idle' }: { size: number; state?: 'idle' | 'listening' | 'thinking' | 'speaking' }) {
  const anim =
    state === 'listening' ? 'orbListen 1.3s ease-in-out infinite'
    : state === 'thinking' ? 'orbThink 2.4s ease-in-out infinite'
    : 'orbIdle 4.5s ease-in-out infinite';
  const haloSize = size * 1.9;
  const haloOffset = -(haloSize - size) / 2;
  return (
    <div className="ali-orb" style={{ width: size, height: size }}>
      <div className="ali-orb-halo" style={{ width: haloSize, height: haloSize, top: haloOffset, left: haloOffset, animation: anim }} />
      <div className="ali-orb-core" style={{ animation: anim }} />
      <div className="ali-orb-shine" style={{ inset: size * 0.14 }} />
    </div>
  );
}

// The orb reads whichever level its current mode implies: the coach's real
// waveform while speaking, a synthetic envelope while the user talks (speech
// recognition owns the mic, so there's no second stream to analyse), and a
// slow drift otherwise.
function levelForMode(mode: OrbMode): number {
  const t = performance.now();
  if (mode === 'speaking')  return audioLevel();
  if (mode === 'listening') return 0.22 + syntheticEnvelope() * 0.42;
  if (mode === 'thinking')  return 0.14 + Math.abs(Math.sin(t / 420)) * 0.14;
  return 0.08 + Math.abs(Math.sin(t / 1100)) * 0.06;
}

// ─── WAVEFORM ────────────────────────────────────────────────────────────────
function Waveform() {
  const bars = 22;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, height: 26, width: 160, flexShrink: 0 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const d = Math.abs(i - bars / 2);
        return (
          <div key={i} style={{
            width: 3, borderRadius: 3,
            background: 'var(--accent)',
            height: '100%',
            opacity: 0.55 + (1 - d / (bars / 2)) * 0.45,
            transformOrigin: 'center',
            animation: `wave 0.9s ease-in-out ${i * 0.045}s infinite`,
            transform: 'scaleY(0.22)',
          }} />
        );
      })}
    </div>
  );
}

// ─── SHARED FIGMA ASSETS ─────────────────────────────────────────────────────
// Exported from "Ford Gotham Discovery". See README → "Design assets".
const UI_BACK  = '/ui/back-circle.svg';      // 41:681 — 61px circle + steel arrow
const UI_OVAL  = '/brand/ford-oval.svg';     // 41:320 — Ford oval, dark variant
const UI_FATHOM = '/brand/fathom-wordmark.svg'; // 46:360 — vehicle lockup

// ─── PERSONALITY THEMES ──────────────────────────────────────────────────────
// Figma ships two dressings of the reveal + social card, and they are a matched
// pair: Personality 1 (Field Workshop) is a WARM sunrise behind a truck carrying
// a board, Personality 2 (Overland Trailblazer) is a COOL blue-green dawn behind
// a wagon carrying bikes. Each config picks whichever reads truer to the life
// the user just described, and the reveal and share card always agree.
type PlateTheme = 'warm' | 'cool';

const CONFIG_THEME: Record<ConfigId, PlateTheme> = {
  field_workshop:       'warm', // hands-on maker, garage-to-jobsite
  mobile_atelier:       'warm', // creative practice, city light
  momentum_commuter:    'warm', // early starts, city-to-city
  overland_trailblazer: 'cool', // trails, crags, high country
  basecamp_explorer:    'cool', // shared expeditions, open country
};

// The reveal used to play a 604x388 loop with the vehicle silhouetted against
// the glow. The vehicle is gone, and the glow it stood in front of was baked
// into the same frames — so the glow is now drawn in CSS from colours sampled
// off those loops (see .reveal-glow in globals.css). Nothing to preload.
const themeFor = (config: ConfigId | null): PlateTheme =>
  config ? CONFIG_THEME[config] : 'warm';

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="gd-back" onClick={onClick} aria-label="Back">
      <img src={UI_BACK} alt="" aria-hidden="true" />
    </button>
  );
}

// ─── LANDING SCREEN (Figma 41:548) ───────────────────────────────────────────
function LandingScreen({ mobileFrame, onToggleFrame, onStart }: {
  mobileFrame: boolean;
  onToggleFrame: () => void;
  onStart: () => void;
}) {
  return (
    <div className="era-screen landing-screen">
      {/* Demo-only — not part of the Figma frame */}
      <button className="gd-demo-toggle" onClick={onToggleFrame} aria-label="Toggle mobile frame">
        {mobileFrame ? 'Mobile' : 'Desktop'}
      </button>

      <div className="landing-hero">
        {/* The wordmark IS the chip row — the three pastels then return in the
            same order as the orb's colours, one per question. */}
        <h1 className="landing-chips">
          <span className="landing-chip landing-chip-1">Find</span>
          <span className="landing-chip landing-chip-2">Your</span>
          <span className="landing-chip landing-chip-3">Fathom</span>
        </h1>

        <p className="landing-sub">
          Tell us your vision, and we&apos;ll show you the vehicle built to take you there.
        </p>

        <div className="landing-cta-area">
          <button className="gd-pill landing-cta" onClick={onStart}>Begin</button>
          <div className="landing-status">
            Your name and three questions • about 60 seconds
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── CHAT SCREEN ─────────────────────────────────────────────────────────────
function ChatScreen({ onComplete, onBack }: {
  onComplete: (reveal: GothamRevealPayload, discoveryMsgs: { role: 'user' | 'assistant'; content: string }[]) => void;
  onBack: () => void;
}) {
  const { messages, state, reveal, error, bridging, sendMessage, startConversation } = useChat();
  const [isListening, setIsListening]   = useState(false);
  const [hasSpeech,   setHasSpeech]     = useState(true);
  const [isSpeaking,  setIsSpeaking]    = useState(false);
  const [textInput,   setTextInput]     = useState('');
  const [inputMode,   setInputMode]     = useState<'voice' | 'text'>('voice');
  const [userPaused,  setUserPaused]    = useState(false);
  const userPausedRef = useRef(false);
  useEffect(() => { userPausedRef.current = userPaused; }, [userPaused]);
  const recognitionRef = useRef<EventTarget & { start(): void; stop(): void } | null>(null);
  const spokenIds      = useRef<Set<string>>(new Set());
  const started        = useRef(false);
  const handedOff      = useRef(false);
  // false while a coach line is mid-flight or mid-sentence
  const speechSettled  = useRef(true);
  const revealRef      = useRef<GothamRevealPayload | null>(null);
  const bridgingRef    = useRef(false);
  const messagesRef    = useRef<typeof messages>([]);

  useEffect(() => {
    _onSpeakStart = () => setIsSpeaking(true);
    _onSpeakEnd   = () => setIsSpeaking(false);
    return () => { _onSpeakStart = null; _onSpeakEnd = null; };
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prewarmTTS();
    startConversation();
    const SRA = (window as typeof window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
             || (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SRA) { setHasSpeech(false); setInputMode('text'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speak new coach messages as they arrive
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (spokenIds.current.has(last.id)) return;
    spokenIds.current.add(last.id);
    speechSettled.current = false;
    speakParts(last.parts ?? [last.content], () => {
      speechSettled.current = true;
      // After the final answer this line is the bridge into the reveal, so it
      // hands over instead of reopening the mic.
      if (revealRef.current) tryHandoff();
      else maybeAutoListen();
    });
  }, [messages]);

  // Keep one question ahead: synthesise the next fixed question while the user
  // is still answering the current one, so it plays from memory when it lands.
  useEffect(() => {
    const asked = messages.filter(m => m.role === 'assistant' && m.parts).length;
    prefetchSpeech(QUESTIONS[asked]);
  }, [messages]);

  /*
   * Hand off to the reveal — but never mid-sentence. The final turn speaks a
   * bridging reaction while the reveal is still generating, so the transition
   * waits on three things: the payload, the bridge line having arrived, and
   * Miles having finished saying it. Whichever lands last calls this; the
   * reveal screen stages the spotlight and its own closing line from there.
   */
  revealRef.current = reveal;
  bridgingRef.current = bridging;
  messagesRef.current = messages;

  const tryHandoff = () => {
    if (handedOff.current) return;
    const payload = revealRef.current;
    if (!payload) return;
    if (bridgingRef.current || !speechSettled.current) return;
    handedOff.current = true;
    const transcript = messagesRef.current.map(m => ({ role: m.role, content: m.content }));
    setTimeout(() => onComplete(payload, transcript), 400);
  };

  useEffect(() => { tryHandoff(); });

  const startListening = () => {
    if (state !== 'idle' || isListening) return;
    const SRA = (window as typeof window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
             || (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SRA) return;
    stopSpeech();
    setUserPaused(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new (SRA as any)();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    let final = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let speechStarted = false;

    const stopTimer = () => { if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; } };
    const setTimer = (ms: number) => { stopTimer(); silenceTimer = setTimeout(() => rec.stop(), ms); };

    rec.onstart = () => setIsListening(true);
    rec.onspeechstart = () => { speechStarted = true; setTimer(SILENCE_MS); };
    // Interim results are no longer drawn anywhere — they only keep the
    // silence timer alive while the user is still mid-sentence.
    rec.onresult = (e: { resultIndex: number; results: SpeechRecognitionResultList }) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
      }
      if (speechStarted) setTimer(SILENCE_MS);
    };
    rec.onspeechend = () => setTimer(SILENCE_MS);
    rec.onerror = () => { stopTimer(); setIsListening(false); };
    rec.onend = () => {
      stopTimer();
      setIsListening(false);
      if (final.trim()) sendMessage(final.trim());
    };
    recognitionRef.current = rec;
    rec.start();
    setTimer(15000);
  };

  const stopListening = () => {
    setUserPaused(true);
    recognitionRef.current?.stop();
  };

  const maybeAutoListen = () => {
    if (userPausedRef.current) return;
    if (inputMode !== 'voice') return;
    if (!hasSpeech) return;
    setTimeout(() => {
      if (!userPausedRef.current && inputMode === 'voice') startListening();
    }, 120);
  };

  const handleTextSend = () => {
    if (!textInput.trim() || state !== 'idle') return;
    sendMessage(textInput.trim());
    setTextInput('');
  };

  // Subtract 1 to exclude the hidden kickoff; 4 dots = name + 3 questions
  const progressCount = Math.max(0, messages.filter(m => m.role === 'user').length - 1);
  const isBusy = state === 'loading' || state === 'revealed';
  const hasStarted = messages.some(m => m.role === 'assistant');

  // The orb takes the next palette colour per question (terra → sage → steel),
  // matching the order of the Find / Your / Fathom chips on the landing screen.
  // The name prompt shares Q1's colour, so each of the three questions gets one.
  const orbColor = Math.min(2, Math.max(0, progressCount - 1));
  const orbMode: OrbMode =
      isBusy      ? 'thinking'
    : isListening ? 'listening'
    : isSpeaking  ? 'speaking'
    : 'idle';
  // Re-created each render, which is what keeps it reading the current mode —
  // the orb re-reads this reference every frame rather than closing over it.
  const getOrbLevel = () => levelForMode(orbMode);

  // Nothing is drawn as text on this screen, so the coach's spoken line is
  // mirrored to assistive tech instead.
  const spokenLine = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? '';

  return (
    <div className="era-screen chat-screen">
      <div className="chat-header">
        <BackButton onClick={onBack} />
        <div className={`chat-avatar${
          state === 'loading' ? ' thinking'
          : isListening ? ' listening'
          : isSpeaking ? ' speaking'
          : ''
        }`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="chat-ali-label">Your guide</div>
          <div className="chat-ali-sub">
            {state === 'loading' ? 'Thinking…'
             : isListening ? 'Listening…'
             : isSpeaking ? 'Speaking…'
             : 'Discover Your Next You'}
          </div>
        </div>
        <div className="chat-progress">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`chat-progress-dot ${i < progressCount ? 'done' : i === progressCount ? 'active' : 'inactive'}`} />
          ))}
        </div>
      </div>

      <div className="orb-stage">
        <AudioOrb colorIndex={orbColor} mode={orbMode} getLevel={getOrbLevel} />

        {/* Screen readers get the question; the screen itself stays wordless. */}
        <div className="gd-sr-only" aria-live="polite" aria-atomic="true">{spokenLine}</div>

        {error && <div className="orb-error">Something went wrong — tap the mic and try again.</div>}
      </div>

      <div className="chat-dock" style={{ paddingBottom: 28 }}>
        {isListening && inputMode === 'voice' && <Waveform />}

        {hasSpeech && (
          <div className="input-mode-toggle">
            <button
              className={`input-mode-btn${inputMode === 'voice' ? ' active' : ''}`}
              onClick={() => { setInputMode('voice'); setUserPaused(false); }}
              disabled={isBusy || isListening}
              aria-label="Use voice"
            >
              <MicIcon size={14} color="currentColor" />
              Voice
            </button>
            <button
              className={`input-mode-btn${inputMode === 'text' ? ' active' : ''}`}
              onClick={() => { setInputMode('text'); if (isListening) stopListening(); }}
              disabled={isBusy}
              aria-label="Type your response"
            >
              <KeyboardIcon size={14} color="currentColor" />
              Type
            </button>
          </div>
        )}

        {inputMode === 'voice' && hasSpeech ? (
          <>
            <button
              onClick={isListening ? stopListening : startListening}
              disabled={isBusy}
              aria-label={isListening ? 'Stop listening' : 'Start speaking'}
              style={{
                width: 74, height: 74, borderRadius: '50%', border: 'none',
                cursor: isBusy ? 'default' : 'pointer',
                background: isListening ? 'var(--accent)' : isBusy ? 'var(--card)' : 'var(--ink)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                boxShadow: !isListening && !isBusy ? '0 6px 24px var(--shadow)' : 'none',
                transform: isListening ? 'scale(0.94)' : 'scale(1)',
                transition: 'all 0.3s',
                opacity: isBusy ? 0.45 : 1,
                flexShrink: 0,
              }}
            >
              {!isListening && !isBusy && (
                <span style={{ position: 'absolute', inset: -7, borderRadius: '50%', border: '2px solid var(--accent)', opacity: 0.4, animation: 'ring 2s ease-out infinite' }} />
              )}
              <MicIcon size={28} color={isBusy ? 'var(--ink-soft)' : '#fff'} />
            </button>
            <div className="chat-dock-hint">
              {isListening
                ? 'Listening… tap to pause'
                : isSpeaking
                ? 'Your guide is talking…'
                : state === 'loading'
                ? 'Thinking…'
                : state === 'revealed'
                ? 'Bringing it into focus…'
                : userPaused
                ? 'Tap to resume'
                : hasStarted
                ? 'Listening will start automatically…'
                : ''}
            </div>
          </>
        ) : (
          <div className="chat-text-input">
            <input
              value={textInput}
              onChange={e => setTextInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleTextSend()}
              placeholder={isBusy ? 'One moment…' : 'Type your answer…'}
              disabled={isBusy}
              autoFocus={inputMode === 'text'}
            />
            <button
              onClick={handleTextSend}
              disabled={!textInput.trim() || isBusy}
              aria-label="Send message"
            >
              <SendIcon size={18} color="#fff" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── REVEAL SCREEN ───────────────────────────────────────────────────────────
// Design source: Figma "Ford Gotham Discovery" → Frame 1 (node 24:264).
// Black canvas; tracked-caps config title overlapping the sunrise plate; bold
// identity headline; narrative; steel CONTINUE pill; ghost START OVER.
function RevealScreen({ reveal, onNext, onRestart }: {
  reveal: GothamRevealPayload; onNext: () => void; onRestart: () => void;
}) {
  const fs = reveal.future_self;
  const config = safeConfig(fs.config_id);
  const theme = themeFor(config);
  const spoken = useRef(false);

  // The card's staged fade-in is pure CSS (see .reveal-* animations); this only
  // starts the spoken closing line, timed to land with it. The guard sits inside
  // the timer, not around it — StrictMode's mount/cleanup/mount would otherwise
  // clear the first timer and short-circuit the second, so nothing ever spoke.
  useEffect(() => {
    const t = setTimeout(() => {
      if (spoken.current) return;
      spoken.current = true;
      speak(sanitizeClosingMsg(reveal.closingMessage));
    }, 700);
    return () => { clearTimeout(t); stopSpeech(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The config name is the hero title in this design (the chip is gone).
  const configTitle = config ? CONFIG_LABELS[config] : 'Your next you';

  return (
    <div className="era-screen reveal-screen">
      <div className="reveal-inner">
        <div className="reveal-hero-stack">
          <h1 className="reveal-config-title">{configTitle}</h1>
          <div className="reveal-hero-art" data-theme={theme}>
            <div className="reveal-glow" aria-hidden="true" />
          </div>
        </div>

        <div className="reveal-copy">
          <h2 className="reveal-headline">{fs.headline}</h2>
          <p className="reveal-narrative">{fs.narrative}</p>

          <div className="reveal-ctas">
            <button className="gd-pill reveal-continue" onClick={onNext}>Continue</button>
            <button className="gd-ghost reveal-startover" onClick={onRestart}>Start over</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── CAPTURE / SIGN UP SCREEN (Figma 41:398) — phone number, skippable ────────
function CaptureScreen({ onNext, onBack }: {
  onNext: () => void; onBack: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  // Permissive: allow spaces, dashes, parens, a leading +. 10-15 digits.
  const digits = phone.replace(/\D/g, '');
  const valid = /^\+?[\d\s().-]+$/.test(phone.trim()) && digits.length >= 10 && digits.length <= 15;

  const submit = async () => {
    if (!valid) { setStatus('error'); return; }
    setStatus('sending');
    try {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
    } catch { /* stub — proceed regardless */ }
    onNext();
  };

  return (
    <div className="era-screen capture-screen">
      <div className="gd-topbar">
        <BackButton onClick={onBack} />
      </div>

      <div className="capture-inner">
        <div className="capture-label">The reveal is coming</div>
        <h2 className="capture-title">Be the first to see it.</h2>
        <p className="capture-sub">
          Enter your phone number for updates.
        </p>

        <div className="capture-field">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={e => { setPhone(e.target.value); if (status === 'error') setStatus('idle'); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="(555) 123-4567"
            aria-label="Phone number"
          />
          {status === 'error' && <div className="capture-error">Please enter a valid phone number.</div>}
        </div>

        <div className="capture-ctas">
          <button
            className="gd-pill capture-keep"
            onClick={submit}
            disabled={status === 'sending' || !phone.trim()}
          >
            {status === 'sending' ? 'One moment…' : 'Keep me updated'}
          </button>
          <button className="gd-ghost" onClick={onNext}>Skip for now</button>
        </div>
      </div>
    </div>
  );
}

// ─── SHARE / SOCIAL CARD SCREEN (Figma 41:335) ───────────────────────────────
function ShareScreen({ reveal, onRestart, onBack }: {
  reveal: GothamRevealPayload; onRestart: () => void; onBack: () => void;
}) {
  const fs = reveal.future_self;
  const config = safeConfig(fs.config_id);
  const configTitle = config ? CONFIG_LABELS[config] : 'Your next you';
  const theme = themeFor(config);
  const cardRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const FILENAME = 'discover-your-next-you.png';
  const SHARE_TITLE = 'Discover Your Next You';

  const captureCard = async () => {
    if (!cardRef.current) return null;
    const { default: html2canvas } = await import('html2canvas');
    return html2canvas(cardRef.current, {
      scale: 3, useCORS: true, allowTaint: true, backgroundColor: null, logging: false,
    });
  };

  const handleShare = async () => {
    const canvas = await captureCard();
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], FILENAME, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: SHARE_TITLE, text: reveal.caption }).catch(() => {});
      } else {
        const a = Object.assign(document.createElement('a'), { href: canvas.toDataURL('image/png'), download: FILENAME });
        a.click();
      }
    }, 'image/png');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reveal.caption);
    } catch {
      const el = Object.assign(document.createElement('textarea'), { value: reveal.caption });
      document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const handleSave = async () => {
    setSaving(true);
    const canvas = await captureCard();
    if (canvas) {
      const a = Object.assign(document.createElement('a'), { href: canvas.toDataURL('image/png'), download: FILENAME });
      a.click();
    }
    setSaving(false);
  };

  return (
    <div className="era-screen share-screen">
      <div className="gd-topbar">
        <BackButton onClick={onBack} />
      </div>

      <div className="share-card-area">
        <div ref={cardRef} className="share-card-outer" data-theme={theme}>
          {/* The glow window. It carries no art of its own — it's a rounded
              cutout that lets the card's gradient read as light, with the
              wordmark centred on it. Figma 41:335 / 41:361. */}
          <div className="share-card-plate">
            <img src={UI_FATHOM} alt="" aria-hidden="true" className="share-card-wordmark" />
          </div>

          <div className="share-card-inner">
            <div className="share-card-eyebrow">{configTitle}</div>
            <div className="share-card-body">
              <div className="share-card-pre">I&apos;m becoming…</div>
              <div className="share-card-name">{fs.headline}</div>
            </div>
          </div>

          <div className="share-card-footer">
            <span className="share-card-hashtags">#DiscoverYourNextYou #Ford</span>
            <img src={UI_OVAL} alt="Ford" className="share-card-oval" />
          </div>
        </div>
      </div>

      <div className="share-actions">
        <button className="share-action-btn share-action-fill" onClick={handleShare}>
          Share
        </button>
        <button className="share-action-btn share-action-outline" onClick={handleCopy}>
          {copied ? 'Caption copied ✓' : 'Copy caption'}
        </button>
        <button className="share-action-btn share-action-outline" onClick={handleSave} disabled={saving}>
          {saving ? '…' : 'Save'}
        </button>
      </div>

      <button className="share-discover" onClick={onRestart}>Discover another you</button>
    </div>
  );
}

// ─── ASK THE COACH PANEL ───────────────────────────────────────────────────────
type AskMsg = { id: number; role: 'user' | 'assistant'; content: string };

function AskCoachPanel({ reveal, userName, discoverySummary, onClose }: {
  reveal: GothamRevealPayload;
  userName?: string;
  discoverySummary?: string;
  onClose: () => void;
}) {
  const fs = reveal.future_self;
  const config = safeConfig(fs.config_id);
  const [msgs,       setMsgs]       = useState<AskMsg[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [textInput,  setTextInput]  = useState('');
  const [mode,       setMode]       = useState<'voice' | 'text'>('text');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking,  setIsSpeaking] = useState(false);
  const [interim,    setInterim]    = useState('');
  const scrollRef    = useRef<HTMLDivElement>(null);
  const recRef       = useRef<EventTarget & { start(): void; stop(): void } | null>(null);
  const nextId       = useRef(0);

  useEffect(() => {
    const opener = userName
      ? `I'm still here, ${userName}. If you're curious about your next chapter or the vehicle built for it, ask me anything.`
      : `I'm still here. If you're curious about your next chapter or the vehicle built for it, ask me anything.`;
    setMsgs([{ id: nextId.current++, role: 'assistant', content: opener }]);
    setIsSpeaking(true);
    speak(opener, () => setIsSpeaking(false));
    return () => {
      stopSpeech();
      recRef.current?.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight + 400;
  }, [msgs, loading, interim]);

  const send = async (text: string) => {
    if (!text.trim() || loading) return;
    const userMsg = { id: nextId.current++, role: 'user' as const, content: text.trim() };
    const next    = [...msgs, userMsg];
    setMsgs(next);
    setTextInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/ask-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.map(m => ({ role: m.role, content: m.content })),
          context: {
            userName,
            headline: fs.headline,
            narrative: fs.narrative,
            configLabel: config ? CONFIG_LABELS[config] : undefined,
            discoverySummary,
          },
        }),
      });
      const data = await res.json();
      const reply = data.content || data.error || "Hmm — try asking that again?";
      setMsgs(m => [...m, { id: nextId.current++, role: 'assistant', content: reply }]);
      setIsSpeaking(true);
      speak(reply, () => setIsSpeaking(false));
    } catch {
      setMsgs(m => [...m, { id: nextId.current++, role: 'assistant', content: "Something glitched. Try again?" }]);
    } finally {
      setLoading(false);
    }
  };

  const startVoice = () => {
    if (isListening || loading) return;
    const SRA = (window as typeof window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
             || (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SRA) return;
    stopSpeech();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new (SRA as any)();
    rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
    let finalText = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const setTimer = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => rec.stop(), ms); };

    rec.onstart = () => setIsListening(true);
    rec.onspeechstart = () => setTimer(2500);
    rec.onresult = (e: { resultIndex: number; results: SpeechRecognitionResultList }) => {
      let int = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else int += e.results[i][0].transcript;
      }
      setInterim(finalText || int);
      setTimer(SILENCE_MS);
    };
    rec.onspeechend = () => setTimer(SILENCE_MS);
    rec.onend = () => { if (timer) clearTimeout(timer); setIsListening(false); setInterim(''); if (finalText.trim()) send(finalText.trim()); };
    rec.onerror = () => { if (timer) clearTimeout(timer); setIsListening(false); setInterim(''); };
    recRef.current = rec;
    rec.start();
    setTimer(12000);
  };

  return (
    <div className="ask-ali-overlay" onClick={onClose}>
      <div className="ask-ali-panel" onClick={e => e.stopPropagation()}>
        <div className="ask-ali-header">
          <CoachOrb size={36} state={isSpeaking ? 'speaking' : isListening ? 'listening' : loading ? 'thinking' : 'idle'} />
          <div style={{ flex: 1 }}>
            <div className="chat-ali-label">Your guide</div>
            <div className="chat-ali-sub">
              {loading ? 'Thinking…' : isListening ? 'Listening…' : isSpeaking ? 'Speaking…' : 'Ask about your next you'}
            </div>
          </div>
          <button className="era-icon-btn" onClick={onClose} aria-label="Close">
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div ref={scrollRef} className="ask-ali-messages">
          {msgs.map(m => (
            <div key={m.id} className={`chat-bubble-wrap ${m.role === 'assistant' ? 'ali' : 'user'}`}>
              <div className={`chat-bubble ${m.role === 'assistant' ? 'ali' : 'user'}`}>{m.content}</div>
            </div>
          ))}
          {isListening && interim && (
            <div className="chat-bubble-wrap user" style={{ opacity: 0.55 }}>
              <div className="chat-bubble user">{interim}</div>
            </div>
          )}
          {loading && (
            <div className="chat-thinking">
              {[0, 1, 2].map(i => (
                <div key={i} className="chat-thinking-dot" style={{ animation: `blink 1.2s ${i * 0.18}s ease-in-out infinite` }} />
              ))}
            </div>
          )}
        </div>

        <div className="ask-ali-dock">
          <div className="input-mode-toggle">
            <button
              className={`input-mode-btn${mode === 'voice' ? ' active' : ''}`}
              onClick={() => setMode('voice')}
              disabled={loading || isListening}
            >
              <MicIcon size={14} color="currentColor" /> Voice
            </button>
            <button
              className={`input-mode-btn${mode === 'text' ? ' active' : ''}`}
              onClick={() => { setMode('text'); recRef.current?.stop(); }}
              disabled={loading}
            >
              <KeyboardIcon size={14} color="currentColor" /> Type
            </button>
          </div>

          {mode === 'text' ? (
            <div className="chat-text-input">
              <input
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && send(textInput)}
                placeholder={loading ? 'One moment…' : 'Ask about your next you…'}
                disabled={loading}
                autoFocus
              />
              <button onClick={() => send(textInput)} disabled={!textInput.trim() || loading} aria-label="Send">
                <SendIcon size={18} color="#fff" />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <button
                onClick={isListening ? () => recRef.current?.stop() : startVoice}
                disabled={loading || isSpeaking}
                aria-label={isListening ? 'Stop listening' : 'Start speaking'}
                style={{
                  width: 62, height: 62, borderRadius: '50%', border: 'none',
                  background: isListening ? 'var(--accent)' : 'var(--ink)', color: '#fff',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: !isListening ? '0 6px 20px var(--shadow)' : 'none',
                  transition: 'all 0.3s', opacity: loading || isSpeaking ? 0.5 : 1,
                }}
              >
                <MicIcon size={24} color="#fff" />
              </button>
              <div className="chat-dock-hint">
                {isListening ? 'Listening… tap to stop' : isSpeaking ? 'Your guide is talking…' : 'Tap to speak'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────────────────
export default function DiscoverApp() {
  const [screen,       setScreen]       = useState<Screen>('landing');
  const [flowKey,      setFlowKey]      = useState(0);
  const [reveal,       setReveal]       = useState<GothamRevealPayload | null>(null);
  const [discoveryCtx, setDiscoveryCtx] = useState<{ userName?: string; summary?: string } | null>(null);
  const [askOpen,      setAskOpen]      = useState(false);
  const [hintShown,    setHintShown]    = useState(false);
  const [showHint,     setShowHint]     = useState(false);
  const [mobileFrame,  setMobileFrame]  = useState(false);

  useEffect(() => {
    setMobileFrame(localStorage.getItem('dyny-mobile-frame') === '1');
    primeVoices();
    prewarmTTS();
  }, []);

  const toggleMobileFrame = () => {
    setMobileFrame(prev => {
      const next = !prev;
      localStorage.setItem('dyny-mobile-frame', next ? '1' : '0');
      return next;
    });
  };

  const go = (s: Screen) => setScreen(s);

  const restart = () => {
    stopSpeech();
    setFlowKey(k => k + 1);
    setReveal(null);
    setDiscoveryCtx(null);
    setAskOpen(false);
    setHintShown(false);
    setShowHint(false);
    go('landing');
  };

  // First time on the reveal, introduce the "Ask the coach" button.
  useEffect(() => {
    if (screen !== 'reveal' || hintShown || !reveal) return;
    setHintShown(true);
    const introTimer = setTimeout(() => {
      setShowHint(true);
      setTimeout(() => setShowHint(false), 6000);
    }, 4200);
    return () => clearTimeout(introTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, reveal]);

  useEffect(() => { if (askOpen) setShowHint(false); }, [askOpen]);

  const handleChatComplete = (r: GothamRevealPayload, msgs: { role: 'user' | 'assistant'; content: string }[]) => {
    const userMsgs = msgs.filter(m => m.role === 'user').slice(1); // drop hidden kickoff
    const firstReply = userMsgs[0]?.content.trim() || '';
    const nameMatch = firstReply.match(/(?:^|i'?m |i am |it'?s |this is |call me |my name is )?([A-Za-z][A-Za-z\-']{1,24})/i);
    const userName = nameMatch ? nameMatch[1].replace(/[.!?,]$/, '') : undefined;
    const summary = userMsgs.slice(1).map((m, i) => `Q${i + 1}: ${m.content}`).join('\n');
    setDiscoveryCtx({ userName, summary });
    setReveal(r);
    go('reveal');
  };

  return (
    <div id="era-app" className={mobileFrame ? 'mobile-frame' : ''}>
      <div key={screen} style={{ position: 'absolute', inset: 0 }}>
        {screen === 'landing' && (
          <LandingScreen
            mobileFrame={mobileFrame}
            onToggleFrame={toggleMobileFrame}
            onStart={() => { primeAudio(); go('chat'); }}
          />
        )}
        {screen === 'chat' && (
          <ChatScreen
            key={flowKey}
            onComplete={handleChatComplete}
            onBack={() => go('landing')}
          />
        )}
        {screen === 'reveal' && reveal && (
          <RevealScreen reveal={reveal} onNext={() => go('capture')} onRestart={restart} />
        )}
        {screen === 'capture' && reveal && (
          <CaptureScreen onNext={() => go('share')} onBack={() => go('reveal')} />
        )}
        {screen === 'share' && reveal && (
          <ShareScreen reveal={reveal} onRestart={restart} onBack={() => go('capture')} />
        )}
      </div>

      {/* Persistent "Ask the coach" floating button on post-reveal screens */}
      {reveal && (screen === 'reveal' || screen === 'capture' || screen === 'share') && !askOpen && (
        <>
          {showHint && (
            <div className="ask-ali-hint">
              <div className="ask-ali-hint-note">
                Right here whenever<br />you need me <span style={{ fontSize: 18 }}>✦</span>
              </div>
              <svg className="ask-ali-hint-arrow" width="24" height="56" viewBox="0 0 24 56" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 4 L 12 46" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
                <path d="M4 38 L 12 50 L 20 38" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </div>
          )}
          <button
            className={`ask-ali-fab${showHint ? ' pulsing' : ''}`}
            onClick={() => setAskOpen(true)}
            aria-label="Ask the coach"
          >
            <CoachOrb size={36} state={showHint ? 'speaking' : 'idle'} />
            <span className="ask-ali-fab-label">Ask the coach</span>
          </button>
        </>
      )}

      {askOpen && reveal && (
        <AskCoachPanel
          reveal={reveal}
          userName={discoveryCtx?.userName}
          discoverySummary={discoveryCtx?.summary}
          onClose={() => setAskOpen(false)}
        />
      )}
    </div>
  );
}
