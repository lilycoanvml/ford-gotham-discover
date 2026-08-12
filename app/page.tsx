'use client';

import { useEffect, useRef, useState } from 'react';
import type { GothamRevealPayload, ConfigId } from '@/app/frontend/types/conversation';
import { useLiveSession } from '@/app/frontend/hooks/useLiveSession';
import { CONFIG_LABELS } from '@/app/theme/ford-brand';
import AudioOrb from '@/app/frontend/components/AudioOrb';
import type { OrbMode } from '@/app/frontend/components/AudioOrb';
import {
  audioLevel, micLevel, syntheticEnvelope, primeAudio, primeVoices, prewarmTTS,
  speak, stopSpeech,
} from '@/app/frontend/lib/audio';

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
// The audio engine (context, analyser, clip cache, PCM playback) moved to
// app/frontend/lib/audio.ts so the live session can share the same graph.

// Sanitize closingMessage — Gemini occasionally returns template text instead of
// actual content (square-bracket instructions). Strip it to a safe fallback.
function sanitizeClosingMsg(msg: string): string {
  if (!msg || msg.startsWith('[') || msg.length > 350) {
    return "Here's who you're becoming — and the vehicle built to take you there. Take a look.";
  }
  return msg.replace(/\[.*?\]/g, '').trim() || "Take a look at who you're becoming.";
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

// The orb reads whichever level its current mode implies: the coach's real
// waveform while speaking, a synthetic envelope while the user talks (speech
// recognition owns the mic, so there's no second stream to analyse), and a
// slow drift otherwise.
function levelForMode(mode: OrbMode): number {
  const t = performance.now();
  if (mode === 'speaking')  return audioLevel();
  // The live session owns the mic, so this is the user's real voice. It falls
  // back to the synthetic envelope before the stream exists (and on the typed
  // path), so the orb never freezes.
  if (mode === 'listening') {
    const mic = micLevel();
    return mic === null ? 0.22 + syntheticEnvelope() * 0.42 : 0.18 + mic * 0.62;
  }
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
          Let&apos;s keep you in the loop with the new Ford vehicle coming for a situation just like yours.
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
/*
 * The conversation is one continuous audio session now (useLiveSession), so
 * this screen no longer drives turn-taking — it reflects it. Miles hears the
 * user directly and Gemini's own VAD decides when a turn ends; there is no
 * speech-recognition object, no silence timer, and no auto-listen handoff to
 * schedule. What is left here is the mic gate, the typed fallback, and the orb.
 */
function ChatScreen({ onComplete, onBack }: {
  onComplete: (reveal: GothamRevealPayload, discoveryMsgs: { role: 'user' | 'assistant'; content: string }[]) => void;
  onBack: () => void;
}) {
  const {
    phase, messages, answers, error, degraded,
    start, stop, sendText, bargeIn,
  } = useLiveSession({ onComplete });

  const [textInput, setTextInput] = useState('');
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prewarmTTS();
    void start();
  }, [start]);

  // Mic trouble or a dead socket leaves only one way to answer.
  useEffect(() => {
    if (degraded) setInputMode('text');
  }, [degraded]);

  const handleTextSend = () => {
    if (!textInput.trim()) return;
    if (phase === 'thinking' || phase === 'revealing') return;
    sendText(textInput.trim());
    setTextInput('');
  };

  // 4 dots = name + 3 questions
  const progressCount = Math.min(4, answers);
  const isSpeaking  = phase === 'speaking';
  const isListening = phase === 'listening';
  const isBusy      = phase === 'thinking' || phase === 'revealing' || phase === 'connecting';

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

  const statusLine =
      phase === 'connecting' ? 'Connecting…'
    : phase === 'revealing'  ? 'Bringing it into focus…'
    : phase === 'thinking'   ? 'Thinking…'
    : isListening            ? 'Listening…'
    : isSpeaking             ? 'Speaking…'
    : 'Discover Your Next You';

  return (
    <div className="era-screen chat-screen">
      <div className="chat-header">
        <BackButton onClick={() => { stop(); onBack(); }} />
        <div className={`chat-avatar${
          isBusy ? ' thinking'
          : isListening ? ' listening'
          : isSpeaking ? ' speaking'
          : ''
        }`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="chat-ali-label">Miles</div>
          <div className="chat-ali-sub">{statusLine}</div>
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

        {error && <div className="orb-error">{error}</div>}
      </div>

      <div className="chat-dock" style={{ paddingBottom: 28 }}>
        {isListening && inputMode === 'voice' && <Waveform />}

        {!degraded && (
          <div className="input-mode-toggle">
            <button
              className={`input-mode-btn${inputMode === 'voice' ? ' active' : ''}`}
              onClick={() => setInputMode('voice')}
              aria-label="Use voice"
            >
              <MicIcon size={14} color="currentColor" />
              Voice
            </button>
            <button
              className={`input-mode-btn${inputMode === 'text' ? ' active' : ''}`}
              onClick={() => setInputMode('text')}
              aria-label="Type your response"
            >
              <KeyboardIcon size={14} color="currentColor" />
              Type
            </button>
          </div>
        )}

        {inputMode === 'voice' && !degraded ? (
          <>
            {/*
              * The mic is always open while Miles is quiet — the model decides
              * when a turn ends, so there is nothing to start. The button is
              * how the user cuts him off mid-sentence instead.
              */}
            <button
              onClick={bargeIn}
              disabled={!isSpeaking}
              aria-label={isSpeaking ? 'Interrupt Miles' : 'Listening'}
              style={{
                width: 74, height: 74, borderRadius: '50%', border: 'none',
                cursor: isSpeaking ? 'pointer' : 'default',
                background: isListening ? 'var(--accent)' : isBusy ? 'var(--card)' : 'var(--ink)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                boxShadow: isListening ? 'none' : '0 6px 24px var(--shadow)',
                transform: isListening ? 'scale(0.94)' : 'scale(1)',
                transition: 'all 0.3s',
                opacity: isBusy ? 0.45 : 1,
                flexShrink: 0,
              }}
            >
              {isListening && (
                <span style={{ position: 'absolute', inset: -7, borderRadius: '50%', border: '2px solid var(--accent)', opacity: 0.4, animation: 'ring 2s ease-out infinite' }} />
              )}
              <MicIcon size={28} color={isBusy ? 'var(--ink-soft)' : '#fff'} />
            </button>
            <div className="chat-dock-hint">
              {phase === 'connecting' ? 'Getting Miles on the line…'
                : isListening ? 'Listening — just talk'
                : isSpeaking ? 'Miles is talking — tap to jump in'
                : phase === 'thinking' ? 'Thinking…'
                : phase === 'revealing' ? 'Bringing it into focus…'
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
            <span className="share-card-hashtags">Ford.com</span>
            <img src={UI_OVAL} alt="Ford" className="share-card-oval" />
          </div>
        </div>
      </div>

      <div className="share-actions">
        <button className="share-action-btn share-action-fill" onClick={handleShare}>
          Share
        </button>
        <button className="share-action-btn share-action-outline" onClick={handleSave} disabled={saving}>
          {saving ? '…' : 'Save'}
        </button>
      </div>

      <button className="share-discover" onClick={onRestart}>Discover another you</button>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────────────────
export default function DiscoverApp() {
  const [screen,       setScreen]       = useState<Screen>('landing');
  const [flowKey,      setFlowKey]      = useState(0);
  const [reveal,       setReveal]       = useState<GothamRevealPayload | null>(null);
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
    go('landing');
  };

  const handleChatComplete = (r: GothamRevealPayload) => {
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

    </div>
  );
}
