'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/app/frontend/hooks/useChat';
import type { GothamRevealPayload, ConfigId } from '@/app/frontend/hooks/useChat';
import { CONFIG_LABELS } from '@/app/theme/ford-brand';

// ─── TYPES ───────────────────────────────────────────────────────────────────
type Screen = 'landing' | 'intro' | 'chat' | 'reveal' | 'capture' | 'share';

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
  for (const src of liveSources) { try { src.onended = null; src.stop(); } catch { /* already ended */ } }
  liveSources = [];
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis?.cancel();
}

// Play a streamed 16-bit little-endian PCM body, scheduling chunks as they land.
async function playPcmStream(res: Response, token: number, onEnd?: () => void) {
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
    src.connect(ctx.destination);

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
  if (token !== speechToken) return;
  _onSpeakEnd?.();
  if (onEnd) setTimeout(onEnd, 700);
}

// Web Speech API fallback (used when GCP TTS route is unavailable locally)
function speakFallback(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Upbeat, energetic male delivery to match the Cloud TTS "Puck" voice.
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

// Primary: /api/tts. That route streams raw PCM from Gemini native audio, or
// returns a whole Cloud TTS clip as JSON if the live path is unavailable — both
// shapes are handled here. Last resort is the browser's own Web Speech API.
async function speak(text: string, onEnd?: () => void) {
  if (typeof window === 'undefined') return;
  stopSpeech();
  const token = speechToken;
  _onSpeakStart?.();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('TTS unavailable');
    if (token !== speechToken) return; // a newer utterance already took over

    // Streaming Gemini path — play chunks as they arrive
    if (res.headers.get('Content-Type')?.startsWith('audio/')) {
      await playPcmStream(res, token, onEnd);
      return;
    }

    // Cloud TTS path — one complete clip
    const { audio, mime } = await res.json();
    if (token !== speechToken) return;
    currentAudio = new Audio(`data:${mime || 'audio/ogg'};base64,${audio}`);
    currentAudio.addEventListener('ended', () => { _onSpeakEnd?.(); if (onEnd) setTimeout(onEnd, 700); }, { once: true });
    await currentAudio.play();
  } catch {
    if (token !== speechToken) return;
    _onSpeakEnd?.();
    speakFallback(text);
    if (onEnd) setTimeout(onEnd, Math.max(2800, text.split(' ').length * 380));
  }
}

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
const UI_GLOW  = '/ui/glow-orb.svg';         // 46:372 — loading-screen radial glow
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

// Reveal plates are 604x388 loops; the social-card plates are transparent PNGs
// that let the card's own gradient read through as sky and glow.
const REVEAL_PLATE: Record<PlateTheme, string> = {
  warm: '/reveal/truck-sunrise.gif',
  cool: '/reveal/reveal-cool.gif',
};
const CARD_PLATE: Record<PlateTheme, string> = {
  warm: '/reveal/card-warm.png',
  cool: '/reveal/plate-cool.png',
};

const themeFor = (config: ConfigId | null): PlateTheme =>
  config ? CONFIG_THEME[config] : 'warm';

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="gd-back" onClick={onClick} aria-label="Back">
      <img src={UI_BACK} alt="" aria-hidden="true" />
    </button>
  );
}

// ─── INTRO / LOADING SCREEN (Figma 41:550) ───────────────────────────────────
const INTRO_SPEECH = "Take a breath. This is a moment just for you — no products, no pitch. Tell me a little about who you are and who you're becoming, and I'll show you the vehicle built to take you there.";

function IntroScreen({ onDone }: { onDone: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      speak(INTRO_SPEECH, () => {
        setExiting(true);
        setTimeout(onDone, 520);
      });
    }, 1000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`intro-screen${exiting ? ' exiting' : ''}`}>
      {/* 591px radial glow — Figma 46:372 */}
      <div className="intro-glow">
        <img src={UI_GLOW} alt="" aria-hidden="true" />
      </div>

      <div className="intro-text-area">
        <div className="intro-greeting">Discover your <em>next you</em></div>
        <div className="intro-tagline">A guided moment of self-discovery</div>
      </div>
    </div>
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
        <h1 className="landing-headline">In five years,</h1>

        {/* The three pastels label the question, then return as the user's
            chat bubbles in the same order. */}
        <div className="landing-chips" aria-label="who will you be?">
          <span className="landing-chip landing-chip-who">who</span>
          <span className="landing-chip landing-chip-will">will you</span>
          <span className="landing-chip landing-chip-be">be?</span>
        </div>

        <p className="landing-sub">
          Tell us your vision, and we&apos;ll show you the vehicle built to take you there.
        </p>

        <div className="landing-cta-area">
          <button className="gd-pill landing-cta" onClick={onStart}>Begin</button>
          <div className="landing-status">
            Your name and two questions • about 60 seconds
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
  const { messages, state, reveal, error, sendMessage, startConversation } = useChat();
  const [isListening, setIsListening]   = useState(false);
  const [interimText, setInterimText]   = useState('');
  const [hasSpeech,   setHasSpeech]     = useState(true);
  const [isSpeaking,  setIsSpeaking]    = useState(false);
  const [textInput,   setTextInput]     = useState('');
  const [inputMode,   setInputMode]     = useState<'voice' | 'text'>('voice');
  const [userPaused,  setUserPaused]    = useState(false);
  const userPausedRef = useRef(false);
  useEffect(() => { userPausedRef.current = userPaused; }, [userPaused]);
  const recognitionRef = useRef<EventTarget & { start(): void; stop(): void } | null>(null);
  const spokenIds      = useRef<Set<string>>(new Set());
  const scrollRef      = useRef<HTMLDivElement>(null);
  const started        = useRef(false);
  const handedOff      = useRef(false);

  useEffect(() => {
    _onSpeakStart = () => setIsSpeaking(true);
    _onSpeakEnd   = () => setIsSpeaking(false);
    return () => { _onSpeakStart = null; _onSpeakEnd = null; };
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prewarmTTS();
    // Warm both reveal plates while the user is still talking — they're heavy
    // loops and we don't know which theme the reveal will land on yet.
    for (const src of Object.values(REVEAL_PLATE)) {
      const preload = new Image();
      preload.src = src;
    }
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
    speak(last.content, () => maybeAutoListen());
  }, [messages]);

  // Hand off to the reveal as soon as the payload arrives (the reveal screen
  // stages the spotlight + spoken closing message itself).
  useEffect(() => {
    if (!reveal || handedOff.current) return;
    handedOff.current = true;
    // brief resolving beat before transitioning
    const t = setTimeout(() => onComplete(reveal, messages.map(m => ({ role: m.role, content: m.content }))), 900);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight + 400;
  }, [messages, state, isListening, interimText]);

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
    rec.onspeechstart = () => { speechStarted = true; setTimer(2500); };
    rec.onresult = (e: { resultIndex: number; results: SpeechRecognitionResultList }) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      setInterimText(final || interim);
      if (speechStarted) setTimer(2500);
    };
    rec.onspeechend = () => setTimer(2500);
    rec.onerror = () => { stopTimer(); setIsListening(false); setInterimText(''); };
    rec.onend = () => {
      stopTimer();
      setIsListening(false);
      setInterimText('');
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
    }, 250);
  };

  const handleTextSend = () => {
    if (!textInput.trim() || state !== 'idle') return;
    sendMessage(textInput.trim());
    setTextInput('');
  };

  // Hide the auto-generated kickoff user message (index 0)
  const visibleMsgs = messages.filter((m, i) => !(m.role === 'user' && i === 0));
  // Subtract 1 to exclude the hidden kickoff; 3 dots = name + 2 questions
  const progressCount = Math.max(0, messages.filter(m => m.role === 'user').length - 1);
  const isBusy = state === 'loading' || state === 'revealed';

  // Each user answer takes the next colour in the palette (terra → sage → steel),
  // matching the order of the who / will you / be? chips on the landing screen.
  const userTurn = new Map<string, number>();
  visibleMsgs.filter(m => m.role === 'user').forEach((m, i) => userTurn.set(m.id, i % 3));
  const nextUserTurn = userTurn.size % 3;

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
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`chat-progress-dot ${i < progressCount ? 'done' : i === progressCount ? 'active' : 'inactive'}`} />
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="chat-messages">
        {visibleMsgs.map(m => (
          <div key={m.id} className={`chat-bubble-wrap ${m.role === 'assistant' ? 'ali' : 'user'}`}>
            <div className={`chat-bubble ${m.role === 'assistant' ? 'ali' : `user turn-${userTurn.get(m.id) ?? 0}`}`}>{m.content}</div>
          </div>
        ))}

        {isListening && interimText && (
          <div className="chat-bubble-wrap user" style={{ opacity: 0.55 }}>
            <div className={`chat-bubble user turn-${nextUserTurn}`}>{interimText}</div>
          </div>
        )}

        {state === 'loading' && (
          <div className="chat-thinking">
            {[0, 1, 2].map(i => (
              <div key={i} className="chat-thinking-dot" style={{ animation: `blink 1.2s ${i * 0.18}s ease-in-out infinite` }} />
            ))}
          </div>
        )}

        {state === 'revealed' && (
          <div className="chat-bubble-wrap ali">
            <div className="chat-bubble ali" style={{ fontStyle: 'italic', opacity: 0.85 }}>Bringing it into focus…</div>
          </div>
        )}

        {error && (
          <div className="chat-bubble-wrap ali">
            <div className="chat-bubble ali" style={{ fontSize: 13, opacity: 0.7 }}>
              Something went wrong — tap the mic and try again.
            </div>
          </div>
        )}
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
                : visibleMsgs.length > 0
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
            <img src={REVEAL_PLATE[theme]} alt="" aria-hidden="true" />
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

// ─── CAPTURE / SIGN UP SCREEN (Figma 41:398) — email, skippable ───────────────
function CaptureScreen({ onNext, onBack }: {
  onNext: () => void; onBack: () => void;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!valid) { setStatus('error'); return; }
    setStatus('sending');
    try {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
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
        <h2 className="capture-title">Be the first to see the vehicle built for this</h2>
        <p className="capture-sub">
          We&apos;ll let you know when there&apos;s more to show. No spam — just the moment it&apos;s ready.
        </p>

        <div className="capture-field">
          <input
            type="email"
            inputMode="email"
            value={email}
            onChange={e => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="you@email.com"
            aria-label="Email address"
          />
          {status === 'error' && <div className="capture-error">Please enter a valid email.</div>}
        </div>

        <div className="capture-ctas">
          <button
            className="gd-pill capture-keep"
            onClick={submit}
            disabled={status === 'sending' || !email.trim()}
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
          {/* Transparent plate over the card gradient; footer band overlays it */}
          <div className="share-card-plate">
            <img src={CARD_PLATE[theme]} alt="" aria-hidden="true" className="share-card-plate-img" />
            <img src={UI_FATHOM} alt="" aria-hidden="true" className="share-card-vehicle" />
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
      setTimer(2500);
    };
    rec.onspeechend = () => setTimer(2500);
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
            onStart={() => { primeAudio(); go('intro'); }}
          />
        )}
        {screen === 'intro' && (
          <IntroScreen onDone={() => go('chat')} />
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
