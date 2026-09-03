'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GothamRevealPayload, ConfigId } from '@/app/frontend/types/conversation';
import { useLiveSession } from '@/app/frontend/hooks/useLiveSession';
import { CONFIG_LABELS } from '@/app/theme/ford-brand';
import AudioOrb from '@/app/frontend/components/AudioOrb';
import type { OrbMode } from '@/app/frontend/components/AudioOrb';
import {
  audioLevel, micLevel, syntheticEnvelope, primeAudio, primeVoices, prewarmTTS,
  speak, stopSpeech,
} from '@/app/frontend/lib/audio';
import { REVEAL_FOLLOW_UP } from '@/app/lib/script';
import { isEmail, isPhone } from '@/app/lib/contact';
import { firstName } from '@/app/lib/name';
import DiscoveryBoard from '@/app/frontend/components/DiscoveryBoard';
import {
  emptyBoard, ensureMinimumImages, fetchFills, slotsForAnswer, takenSlugs, tileFor,
} from '@/app/frontend/lib/board';
import type { BoardState } from '@/app/frontend/lib/board';

// ─── TYPES ───────────────────────────────────────────────────────────────────
type Screen = 'landing' | 'chat' | 'capture' | 'share';

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

/*
 * Spoken on the invite screen if the model's vehiclePitch is missing or looks
 * like template text. It names the vehicle and stops — it cannot say why the
 * truck suits THEM, because there is no payload to read their answers from.
 */
const PITCH_FALLBACK =
  "Here's the Ford Fathom. All electric, with a steel bed, a front trunk, and enough power onboard to run your gear wherever you take it.";

function sanitizeVehiclePitch(msg: string | undefined): string {
  if (!msg || msg.startsWith('[') || msg.length > 400) return PITCH_FALLBACK;
  return msg.replace(/\[.*?\]/g, '').trim() || PITCH_FALLBACK;
}

/*
 * The gap between the vehicle pitch and the ask that follows it.
 *
 * He introduces the truck, then leaves a real gap before asking for their
 * details, so the two land as separate thoughts rather than one pitch running
 * straight into a request. Nothing is listening here — the live session has
 * closed by this screen — so the pause is room to take it in, not to answer.
 */
const FOLLOW_UP_BEAT_MS = 2600;


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

/* The card's vehicle silhouettes — Figma 37:302 (warm) and 37:305 (cool), the
   plate fills from Social Card 1 / 2. Transparent PNGs at the plate's own 4:3,
   so they drop in full-bleed and the card's gradient becomes the glow behind
   them. Same object the reveal plates 25:268 / 33:287 show. */
const UI_CAR_WARM = '/reveal/card-warm.png';
const UI_CAR_COOL = '/reveal/plate-cool.png';

/* Figma 46:19 — the Fathom at the beach, the invite screen's hero. Downscaled
   from app/"Fathom w surfboard mobile.png" (928x1152, 1.7MB) to something a
   phone should actually download. */
const UI_FATHOM_PHOTO = '/reveal/fathom-surfboard.jpg';

// Intro frame, from the newer file ntdaHrZCrRGdtT6VcTYh9x (node 1:7). The lockup
// here is a different cut from UI_FATHOM above — taller cap height, and it
// carries the ™ — so the two are not interchangeable.
const UI_KITE   = '/ui/intro/kite-circle.png'; // 1:124 — kite in a sky circle
const UI_SUMMIT = '/ui/intro/summit-pill.png'; // 1:136 — summit photo pill
const UI_LOCKUP = '/brand/fathom-lockup.png';  // 1:134 — FATHOM™ lockup

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

// ─── LANDING SCREEN (Figma 1:7) ──────────────────────────────────────────────
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
        {/* Six tiles on Figma's two-column split. The words read "Find your
            FATHOM" down the wide column; the kite, the summit and the Ford oval
            fill the narrow one, so the headline and the picture of where it
            takes you are the same object. The oval and the summit are brand and
            mood furniture rather than words, so they stay out of the heading
            text — a screen reader gets "Find your Fathom". */}
        <h1 className="landing-bento">
          <span className="landing-tile landing-find">Find</span>
          <img className="landing-tile landing-kite" src={UI_KITE} alt="" aria-hidden="true" />
          <span className="landing-tile landing-your">your</span>
          <span className="landing-tile landing-lockup">
            <img src={UI_LOCKUP} alt="Fathom" />
          </span>
          <img className="landing-tile landing-summit" src={UI_SUMMIT} alt="" aria-hidden="true" />
          <span className="landing-tile landing-oval">
            <img src={UI_OVAL} alt="" aria-hidden="true" />
          </span>
        </h1>
      </div>

      <div className="landing-cta-area">
        <button className="gd-pill landing-cta" onClick={onStart}>Begin</button>
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
function ChatScreen({ onComplete, onBack, board, setBoard }: {
  onComplete: (reveal: GothamRevealPayload, discoveryMsgs: { role: 'user' | 'assistant'; content: string }[]) => void;
  onBack: () => void;
  board: BoardState;
  setBoard: React.Dispatch<React.SetStateAction<BoardState>>;
}) {
  /*
   * Each committed answer puts one or two tiles on the board.
   *
   * The board is read through a ref rather than the prop so the matcher always
   * sees the slugs already placed — two answers can be in flight at once when
   * someone answers quickly, and passing a stale `taken` list is how the same
   * photo ends up in two slots.
   *
   * Nothing here is awaited by the conversation. A slow or failed match leaves
   * its slots empty and Miles carries on; the board is the one part of this
   * screen allowed to be late.
   */
  const boardRef = useRef(board);
  boardRef.current = board;

  const handleAnswer = useCallback(async (text: string, n: number) => {
    if (n === 1) {
      const name = firstName(text);
      if (name) setBoard(b => ({ ...b, name }));
      return;
    }

    const slots = slotsForAnswer(n);
    if (!slots.length) return;

    const fills = await fetchFills(text, slots.length, takenSlugs(boardRef.current));
    if (!fills.length) return;

    setBoard(b => {
      const tiles = { ...b.tiles };
      slots.forEach((slot, i) => {
        const fill = fills[i];
        // Only paint over an empty slot — a late match must never displace a
        // tile a later answer already filled.
        if (fill && tiles[slot].kind === 'empty') tiles[slot] = tileFor(fill);
      });
      return { ...b, tiles };
    });
  }, [setBoard]);

  const {
    phase, messages, answers, error, degraded,
    start, stop, sendText, bargeIn,
  } = useLiveSession({ onComplete, onAnswer: handleAnswer });

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
  // matching the order of the Fathom / Your / Future chips on the landing screen.
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

      {/* The orb carries the name question; from the first answer on, the board
          takes the same box and fills as the conversation goes. Same stage, so
          the header and the dock never move.

          Keyed off the answer count, not off board.name: an answer that carries
          no readable name ("hey there!") leaves the chip empty, and keying on
          the name would have stranded the orb there for the rest of the run
          while the tiles filled behind it. */}
      {answers < 1 ? (
        <div className="orb-stage">
          <AudioOrb colorIndex={orbColor} mode={orbMode} getLevel={getOrbLevel} />

          {/* Screen readers get the question; the screen itself stays wordless. */}
          <div className="gd-sr-only" aria-live="polite" aria-atomic="true">{spokenLine}</div>

          {error && <div className="orb-error">{error}</div>}
        </div>
      ) : (
        <div className="board-stage">
          <DiscoveryBoard board={board} />
          <div className="gd-sr-only" aria-live="polite" aria-atomic="true">{spokenLine}</div>
          {error && <div className="orb-error">{error}</div>}
        </div>
      )}

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

// ─── CAPTURE / SIGN UP SCREEN (Figma 41:398) — phone number, skippable ────────
function CaptureScreen({ reveal, onNext }: {
  reveal: GothamRevealPayload; onNext: () => void;
}) {
  /*
   * Miles introduces the truck over its photograph. Same staging as the reveal:
   * a beat after the screen lands so the image is up before he starts, and the
   * guard sits INSIDE the timer so StrictMode's mount/cleanup/mount does not
   * clear the first timer and short-circuit the second.
   */
  const pitched = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (pitched.current) return;
      pitched.current = true;
      speak(sanitizeVehiclePitch(reveal.vehiclePitch), () => {
        setTimeout(() => speak(REVEAL_FOLLOW_UP), FOLLOW_UP_BEAT_MS);
      });
    }, 650);
    return () => { clearTimeout(t); stopSpeech(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle');

  /*
   * Two fields, but the copy says "email or phone number" — so either one on
   * its own is enough, and whichever they DO fill has to be a real one. The
   * rules live in app/lib/contact.ts so this and /api/subscribe cannot drift
   * apart about what counts as valid.
   */
  const hasEmail = email.trim().length > 0;
  const hasPhone = phone.trim().length > 0;
  const emailOk = hasEmail && isEmail(email);
  const phoneOk = hasPhone && isPhone(phone);
  const valid = (emailOk || phoneOk) && (!hasEmail || emailOk) && (!hasPhone || phoneOk);

  // Name the field that is actually wrong rather than making them guess.
  const errorMsg =
      hasEmail && !emailOk ? 'Please enter a valid email.'
    : hasPhone && !phoneOk ? 'Please enter a valid phone number.'
    : 'Enter an email or a phone number.';

  const submit = async () => {
    if (!valid) { setStatus('error'); return; }
    setStatus('sending');
    try {
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim() }),
      });
    } catch { /* stub — proceed regardless */ }
    onNext();
  };

  return (
    <div className="era-screen capture-screen">
      {/* No back button: the conversation is behind this screen and there is
          nothing to return to. "Skip for now" is the way past it. */}
      <div className="capture-inner">
        {/* Figma 46:19 — the vehicle, at the content column's width and its own
            aspect, which is the height the frame draws. */}
        <img
          className="capture-hero"
          src={UI_FATHOM_PHOTO}
          alt="The Ford Fathom parked by the beach, surfboards on the roof rack"
        />

        <h2 className="capture-title">Get the Invite</h2>
        <p className="capture-sub">
          Give us your email or phone number and we&apos;ll put you on the pre-order
          list. No obligation. You&apos;ll get all the latest info
        </p>

        {/* Split back into two fields, which lets each one ask for the right
            keyboard and offer the right autofill — a single combined field could
            do neither. */}
        <div className="capture-field">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={e => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Email"
            aria-label="Email"
          />
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={e => { setPhone(e.target.value); if (status === 'error') setStatus('idle'); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Phone number"
            aria-label="Phone number"
          />
          {status === 'error' && <div className="capture-error">{errorMsg}</div>}
        </div>

        <div className="capture-ctas">
          <button
            className="gd-pill capture-keep"
            onClick={submit}
            disabled={status === 'sending' || (!hasEmail && !hasPhone)}
          >
            {status === 'sending' ? 'One moment…' : 'Share with Friends'}
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
            <img
              src={theme === 'warm' ? UI_CAR_WARM : UI_CAR_COOL}
              alt="" aria-hidden="true" className="share-card-vehicle"
            />
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
  /*
   * The board lives here, above both screens, because it is ONE board: the
   * thing the customer watched fill during the conversation is the thing the
   * reveal lands on. Rebuilding it at the reveal would throw away the tiles
   * they already watched arrive.
   */
  const [board,        setBoard]        = useState<BoardState>(emptyBoard);

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
    setBoard(emptyBoard());
    go('landing');
  };

  const handleChatComplete = (r: GothamRevealPayload) => {
    /*
     * Close the board out and go straight to the invite. There is no reveal
     * screen between them now: the board completed on the last answer, under
     * Miles' reaction to it, and the next thing he does is introduce the
     * vehicle over its photograph.
     */
    setBoard(ensureMinimumImages);
    setReveal(r);
    go('capture');
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
            board={board}
            setBoard={setBoard}
          />
        )}
        {screen === 'capture' && reveal && (
          <CaptureScreen reveal={reveal} onNext={() => go('share')} />
        )}
        {screen === 'share' && reveal && (
          <ShareScreen reveal={reveal} onRestart={restart} onBack={() => go('capture')} />
        )}
      </div>

    </div>
  );
}
