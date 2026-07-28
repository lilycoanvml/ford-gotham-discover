'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/app/frontend/hooks/useChat';
import type { GothamRevealPayload, ConfigId } from '@/app/frontend/hooks/useChat';
import MorphSilhouette, { SILHOUETTE_PATHS } from '@/app/frontend/components/MorphSilhouette';
import { fordBrand, CONFIG_LABELS } from '@/app/theme/ford-brand';

// ─── TYPES ───────────────────────────────────────────────────────────────────
type Screen = 'landing' | 'intro' | 'chat' | 'reveal' | 'capture' | 'share';

// ─── BRAND DEFAULTS ──────────────────────────────────────────────────────────
const DEFAULT_PRIMARY = fordBrand.colorFordBrightBlue; // #066FEF
const DEFAULT_ACCENT  = '#4B9BFF';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const safeHex = (v: string | undefined, fallback: string) => (v && HEX_RE.test(v) ? v : fallback);

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

function primeVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const load = () => { voiceCache = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.addEventListener('voiceschanged', load);
}

// Warm up the TTS endpoint so the first real call isn't slowed by cold start.
async function prewarmTTS() {
  if (typeof window === 'undefined') return;
  try {
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
      keepalive: true,
    });
  } catch { /* silent — best-effort */ }
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

// Primary: Google Cloud TTS. Falls back to Web Speech API if the route is down.
async function speak(text: string, onEnd?: () => void) {
  if (typeof window === 'undefined') return;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis?.cancel();
  _onSpeakStart?.();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('TTS unavailable');
    const { audio } = await res.json();
    currentAudio = new Audio(`data:audio/ogg;base64,${audio}`);
    currentAudio.addEventListener('ended', () => { _onSpeakEnd?.(); if (onEnd) setTimeout(onEnd, 700); }, { once: true });
    await currentAudio.play();
  } catch {
    _onSpeakEnd?.();
    speakFallback(text);
    if (onEnd) setTimeout(onEnd, Math.max(2800, text.split(' ').length * 380));
  }
}

// ─── ICONS ───────────────────────────────────────────────────────────────────
function ChevronLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M11 4l-5 5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M7 4l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
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

// ─── INTRO SCREEN ────────────────────────────────────────────────────────────
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
      <div className="intro-ring intro-ring-1" />
      <div className="intro-ring intro-ring-2" />
      <div className="intro-ring intro-ring-3" />
      <div className="intro-dot intro-dot-1" />
      <div className="intro-dot intro-dot-2" />

      <div className="intro-orb-wrap">
        <CoachOrb size={200} state="speaking" />
      </div>

      <div className="intro-text-area">
        <div className="intro-greeting">Discover your <em>next you</em></div>
        <div className="intro-tagline">A guided moment of self-discovery</div>
      </div>
    </div>
  );
}

// ─── LANDING SCREEN ──────────────────────────────────────────────────────────
function LandingScreen({ mood, onToggleMood, mobileFrame, onToggleFrame, onStart }: {
  mood: string;
  onToggleMood: () => void;
  mobileFrame: boolean;
  onToggleFrame: () => void;
  onStart: () => void;
}) {
  return (
    <div className="era-screen landing-screen">
      {/* Ambient silhouette drifting behind the hero */}
      <MorphSilhouette variant="ambient" className="landing-silhouette" primaryColor={DEFAULT_PRIMARY} accentColor={DEFAULT_ACCENT} />

      <div className="era-topbar">
        <div className="era-brand">
          {/* PLACEHOLDER brand lockup — swap for licensed Ford oval + wordmark */}
          <strong>{fordBrand.wordmarkText}</strong><br />Discover Your Next You
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="era-mood-toggle" onClick={onToggleFrame} aria-label="Toggle mobile frame">
            {mobileFrame ? (
              <svg width="11" height="14" viewBox="0 0 11 14" fill="none">
                <rect x="0.6" y="0.6" width="9.8" height="12.8" rx="1.8" stroke="currentColor" strokeWidth="1.2" />
                <rect x="4.3" y="11" width="2.4" height="0.6" rx="0.3" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
                <rect x="0.6" y="0.6" width="12.8" height="8.8" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
                <rect x="4.5" y="10.4" width="5" height="0.8" rx="0.4" fill="currentColor" />
              </svg>
            )}
            <span>{mobileFrame ? 'Mobile' : 'Desktop'}</span>
          </button>
          <button className="era-mood-toggle" onClick={onToggleMood}>
            <div className="era-mood-dot" />
            <span>{mood === 'sage' ? 'Light' : 'Dark'}</span>
          </button>
          <div className="era-bf-tag"><div className="era-bf-dot" />Teaser · placeholder brand</div>
        </div>
      </div>

      <div className="landing-hero">
        <h1 className="landing-headline">
          In five years,<br /><em>who will you be?</em>
        </h1>
        <p className="landing-sub">
          Tell us your vision, and we&apos;ll show you the vehicle built to take you there.
        </p>
      </div>

      <div className="landing-cta-area">
        <button className="landing-cta" onClick={onStart}>
          <MicIcon size={18} color="currentColor" />
          Begin
        </button>
        <div className="landing-status">
          <div className="live-dot" />
          Your name and two questions · about 60 seconds
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
    window.speechSynthesis?.cancel();
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

  // Running transcript drives the live silhouette morph (user's words + interim)
  const liveTranscript =
    visibleMsgs.filter(m => m.role === 'user').map(m => m.content).join(' ') + ' ' + interimText;

  return (
    <div className="era-screen chat-screen" style={{ overflow: 'hidden' }}>
      {/* Ambient morphing silhouette behind the conversation */}
      <MorphSilhouette variant="ambient" className="chat-silhouette" transcript={liveTranscript} primaryColor={DEFAULT_PRIMARY} accentColor={DEFAULT_ACCENT} />

      <div className="chat-header">
        <button className="era-icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={16} />
        </button>
        <CoachOrb size={32} state={
          state === 'loading' ? 'thinking'
          : isListening ? 'listening'
          : isSpeaking ? 'speaking'
          : 'idle'
        } />
        <div style={{ flex: 1 }}>
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
            <div className={`chat-bubble ${m.role === 'assistant' ? 'ali' : 'user'}`}>{m.content}</div>
          </div>
        ))}

        {isListening && interimText && (
          <div className="chat-bubble-wrap user" style={{ opacity: 0.55 }}>
            <div className="chat-bubble user">{interimText}</div>
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
function RevealScreen({ reveal, onNext, onRestart }: {
  reveal: GothamRevealPayload; onNext: () => void; onRestart: () => void;
}) {
  const fs = reveal.future_self;
  const primary = safeHex(fs.primaryColor, DEFAULT_PRIMARY);
  const accent  = safeHex(fs.accentColor, DEFAULT_ACCENT);
  const config  = safeConfig(fs.config_id);
  const [illuminate, setIlluminate] = useState(false);
  const spoken = useRef(false);

  useEffect(() => {
    if (spoken.current) return;
    spoken.current = true;
    const t = setTimeout(() => {
      setIlluminate(true);
      speak(sanitizeClosingMsg(reveal.closingMessage));
    }, 700);
    return () => { clearTimeout(t); window.speechSynthesis?.cancel(); if (currentAudio) { currentAudio.pause(); currentAudio = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="era-screen reveal-screen">
      <div className="reveal-inner">
        <div className="reveal-label">Your next you</div>

        <MorphSilhouette
          variant="hero"
          resolvedConfigId={config}
          illuminate={illuminate}
          primaryColor={primary}
          accentColor={accent}
          className="reveal-silhouette"
        />

        <h1 className="reveal-era-name" style={{ color: primary }}>
          {fs.headline}
        </h1>

        <p className="reveal-blurb">{fs.narrative}</p>

        <div className="reveal-config-chip" style={{ color: accent, borderColor: `${accent}55`, background: `${accent}14` }}>
          {config ? CONFIG_LABELS[config] : 'The vehicle built for this'}
        </div>

        <div className="reveal-ctas">
          <button className="btn-primary-era" onClick={onNext} style={{ background: primary }}>
            Continue <ChevronRight size={14} />
          </button>
          <button className="btn-ghost-era" onClick={onRestart}>
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CAPTURE SCREEN (email, skippable) ─────────────────────────────────────────
function CaptureScreen({ reveal, onNext, onBack }: {
  reveal: GothamRevealPayload; onNext: () => void; onBack: () => void;
}) {
  const fs = reveal.future_self;
  const primary = safeHex(fs.primaryColor, DEFAULT_PRIMARY);
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
      <div className="chat-header">
        <button className="era-icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={16} />
        </button>
        <div className="chat-ali-label" style={{ flex: 1 }}>Stay close to it</div>
      </div>

      <div className="capture-inner">
        <div className="capture-label">The real reveal is coming</div>
        <h2 className="capture-title">
          Be the first to see<br /><em style={{ color: primary }}>the vehicle built for this</em>
        </h2>
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
            className="btn-primary-era"
            onClick={submit}
            disabled={status === 'sending' || !email.trim()}
            style={{ background: primary }}
          >
            {status === 'sending' ? 'One moment…' : 'Keep me updated'}
          </button>
          <button className="btn-ghost-era" onClick={onNext}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SHARE SCREEN ────────────────────────────────────────────────────────────
function StaticSilhouette({ configId, primary, accent }: { configId: ConfigId | null; primary: string; accent: string }) {
  // Solid-fill, resolved shape — reliable under html2canvas (no gradient refs).
  const d = SILHOUETTE_PATHS[configId ?? 'neutral_base'];
  return (
    <svg viewBox="0 0 240 128" width="100%" height="100%" preserveAspectRatio="xMidYMax meet">
      <ellipse cx="120" cy="112" rx="100" ry="9" fill={accent} opacity="0.22" />
      <path d={d} fill={primary} stroke={accent} strokeWidth="1.4" strokeLinejoin="round" />
      <g fill="#05060B" stroke={accent} strokeWidth="1.4">
        <circle cx="66" cy="94" r="16" />
        <circle cx="174" cy="94" r="16" />
      </g>
    </svg>
  );
}

function ShareScreen({ reveal, onRestart, onBack }: {
  reveal: GothamRevealPayload; onRestart: () => void; onBack: () => void;
}) {
  const fs = reveal.future_self;
  const primary = safeHex(fs.primaryColor, DEFAULT_PRIMARY);
  const accent  = safeHex(fs.accentColor, DEFAULT_ACCENT);
  const config  = safeConfig(fs.config_id);
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
      <div className="chat-header">
        <button className="era-icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={16} />
        </button>
        <div className="chat-ali-label" style={{ flex: 1 }}>Share your next you</div>
      </div>

      <div className="share-card-area">
        <div
          ref={cardRef}
          className="share-card-outer"
          style={{
            background: `linear-gradient(160deg, ${primary} 0%, #05060B 78%)`,
            boxShadow: `0 24px 60px ${primary}55`,
          }}
        >
          <div className="share-card-glow" style={{ background: `radial-gradient(circle, ${accent}55, transparent 65%)` }} />

          <div className="share-card-top">
            {/* PLACEHOLDER Ford lockup — swap for licensed oval + wordmark */}
            <img src={fordBrand.logoOvalSrc} alt="" className="share-card-oval" crossOrigin="anonymous" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <div className="share-card-wordmark">{fordBrand.wordmarkText}</div>
          </div>

          <div className="share-card-body">
            <div className="share-card-pre">I&apos;m becoming…</div>
            <div className="share-card-name">{fs.headline}</div>
            <div className="share-card-silhouette">
              <StaticSilhouette configId={config} primary={accent} accent="#ffffff" />
            </div>
          </div>

          <div className="share-card-footer">
            <span className="share-card-hashtags">#DiscoverYourNextYou #Ford</span>
          </div>
        </div>
      </div>

      <div className="share-actions">
        <button className="share-action-btn share-action-fill" onClick={handleShare} style={{ background: primary }}>
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
      window.speechSynthesis?.cancel();
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
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
    window.speechSynthesis?.cancel();
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }

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
  const [mood,         setMood]         = useState('sage');
  const [mobileFrame,  setMobileFrame]  = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('dyny-mood') || 'sage';
    setMood(saved);
    setMobileFrame(localStorage.getItem('dyny-mobile-frame') === '1');
    primeVoices();
    prewarmTTS();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-mood', mood);
  }, [mood]);

  const toggleMood = () => {
    const next = mood === 'sage' ? 'sand' : 'sage';
    setMood(next);
    localStorage.setItem('dyny-mood', next);
  };

  const toggleMobileFrame = () => {
    setMobileFrame(prev => {
      const next = !prev;
      localStorage.setItem('dyny-mobile-frame', next ? '1' : '0');
      return next;
    });
  };

  const go = (s: Screen) => setScreen(s);

  const restart = () => {
    if (typeof window !== 'undefined') {
      window.speechSynthesis?.cancel();
      if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    }
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
            mood={mood}
            onToggleMood={toggleMood}
            mobileFrame={mobileFrame}
            onToggleFrame={toggleMobileFrame}
            onStart={() => go('intro')}
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
          <CaptureScreen reveal={reveal} onNext={() => go('share')} onBack={() => go('reveal')} />
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
