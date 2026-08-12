'use client';

/*
 * ─── LIVE SESSION ────────────────────────────────────────────────────────────
 *
 * The discovery conversation, as one continuous audio session.
 *
 * Miles hears the user directly — no speech-to-text in front of him — and
 * answers in his own voice. What he never does is ask the questions: those are
 * fixed brand copy, so they play from cached audio and are then injected into
 * the session as his own prior turn (see 'inject' in live/relay.js). He knows
 * what he asked without having generated it, and the wording is guaranteed.
 *
 * Turn shape, repeated four times:
 *   user speaks  →  Gemini VAD closes the turn  →  Miles reacts (~1 sentence)
 *   →  cached question plays  →  question injected  →  mic reopens
 *
 * The fourth answer has no question after it; it starts the reveal instead,
 * fired the moment the user stops talking so it generates underneath Miles'
 * closing reaction rather than after it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { OPENING_LINE, QUESTIONS, ANSWERS_BEFORE_REVEAL } from '@/app/lib/script';
import {
  primeAudio, prefetchSpeech, speakCached, stopSpeech, currentToken, isStale,
  LivePlayer, speakFallback, getAudioContext, attachMicAnalyser, detachMicAnalyser,
} from '@/app/frontend/lib/audio';
import type { ChatMessage, GothamRevealPayload } from '@/app/frontend/types/conversation';

export type LivePhase =
  | 'idle'        // not started
  | 'connecting'  // socket opening, mic warming
  | 'speaking'    // Miles is talking (his reaction, or a fixed question)
  | 'listening'   // mic is open, waiting on the user
  | 'thinking'    // user finished, Miles has not started yet
  | 'revealing'   // last answer in, waiting on the reveal payload
  | 'error';

// Neutral kickoff so the reveal model's history starts on a user turn, which
// Gemini's startChat requires. Never spoken, never shown.
const KICKOFF = 'Hi, I want to discover my next self.';

/*
 * Miles' own voice is echo-cancelled by the browser, so the user can cut in
 * over him and Gemini's VAD will hear it. The fixed question clips are not in
 * that cancellation path, so the mic is hard-gated while they play — otherwise
 * the model hears its own question and answers it as though the user had.
 */
const ALLOW_BARGE_IN = true;

// A beat between Miles finishing and the question starting, so the turn reads
// as a remark followed by a question rather than one run-on sentence.
const BEAT_MS = 260;

export interface LiveSessionOptions {
  onComplete: (
    reveal: GothamRevealPayload,
    transcript: { role: 'user' | 'assistant'; content: string }[],
  ) => void;
}

export function useLiveSession({ onComplete }: LiveSessionOptions) {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [answers, setAnswers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // True when audio is impossible (mic denied, socket dead) and the screen
  // should offer the typed path instead.
  const [degraded, setDegraded] = useState(false);

  const wsRef       = useRef<WebSocket | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const workletRef  = useRef<AudioWorkletNode | null>(null);
  const playerRef   = useRef<LivePlayer | null>(null);
  const startedRef  = useRef(false);
  const doneRef     = useRef(false);

  // Transcript accumulators for the turn in flight.
  const heardRef    = useRef('');   // what the user is saying
  const saidRef     = useRef('');   // what Miles is saying
  const answersRef  = useRef(0);
  const askedRef    = useRef(0);     // how many fixed questions have been played
  const turnOpenRef = useRef(false); // has this user turn been committed yet

  // The reveal is requested before Miles finishes his last line, so both the
  // payload and the end of that line have to land before the screen moves.
  const revealRef     = useRef<GothamRevealPayload | null>(null);
  const revealWaitRef = useRef(false);

  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const push = useCallback((role: 'user' | 'assistant', content: string) => {
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role, content, timestamp: new Date(),
    };
    setMessages(prev => [...prev, msg]);
    messagesRef.current = [...messagesRef.current, msg];
    return msg;
  }, []);

  const setMicMuted = useCallback((muted: boolean) => {
    workletRef.current?.port.postMessage({ muted });
  }, []);

  /*
   * Raises the VAD's trigger threshold while Miles is talking. Echo
   * cancellation removes most of his voice from the mic, but not all of it on
   * speakers — and a false trigger there cuts him off mid-sentence.
   */
  const setMicStrict = useCallback((strict: boolean) => {
    workletRef.current?.port.postMessage({ strict });
  }, []);

  const sendJson = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  // ─── the reveal ────────────────────────────────────────────────────────────
  const buildTranscript = useCallback(() => {
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: KICKOFF },
    ];
    for (const m of messagesRef.current) history.push({ role: m.role, content: m.content });
    return history;
  }, []);

  const finishIfReady = useCallback(() => {
    if (doneRef.current) return;
    const payload = revealRef.current;
    if (!payload) return;
    const player = playerRef.current;
    if (player?.speaking) return;      // never cut Miles off mid-sentence
    doneRef.current = true;
    const transcript = buildTranscript();
    setTimeout(() => onComplete(payload, transcript), 400);
  }, [buildTranscript, onComplete]);

  const requestReveal = useCallback(async () => {
    revealWaitRef.current = true;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: buildTranscript(), stage: 'reveal' }),
      });
      if (!res.ok) throw new Error('reveal failed');
      const data = await res.json();
      if (data.type !== 'gotham_reveal') throw new Error('unexpected reveal shape');
      revealRef.current = data.data;
      finishIfReady();
    } catch (err) {
      console.error('[live] reveal failed', err);
      setError('Something went wrong bringing it into focus.');
      setPhase('error');
    }
  }, [buildTranscript, finishIfReady]);

  // ─── asking a fixed question ───────────────────────────────────────────────
  const askQuestion = useCallback(async (index: number) => {
    const question = QUESTIONS[index];
    if (!question) return;

    setPhase('speaking');
    setMicMuted(true);                       // this clip is not echo-cancelled
    const token = currentToken();
    try {
      await new Promise(r => setTimeout(r, BEAT_MS));
      if (isStale(token)) return;
      await speakCached(question, token);
    } catch {
      speakFallback(question);
      await new Promise(r => setTimeout(r, Math.max(2800, question.split(' ').length * 380)));
    }
    if (isStale(token)) return;

    // Tell the session it just asked this, without making it speak.
    sendJson({ type: 'inject', text: question });
    push('assistant', question);

    prefetchSpeech(QUESTIONS[index + 1]);    // stay one question ahead
    setMicMuted(false);
    setPhase('listening');
  }, [push, sendJson, setMicMuted]);

  // ─── turn boundaries ───────────────────────────────────────────────────────
  /*
   * The user's turn closes the instant Miles starts responding — that is
   * Gemini's VAD telling us it heard a complete thought. Committing here rather
   * than at turnEnd is what lets the reveal start generating while Miles is
   * still delivering his closing line.
   */
  const closeUserTurn = useCallback(() => {
    if (!turnOpenRef.current) return;
    turnOpenRef.current = false;

    const heard = heardRef.current.trim();
    heardRef.current = '';

    /*
     * A turn that produced no words was a false trigger — a cough, a door, a
     * bit of Miles leaking past echo cancellation. It must not advance the
     * script, or the customer loses a question they never got asked.
     */
    if (!heard) return;

    push('user', heard);
    const n = answersRef.current + 1;
    answersRef.current = n;
    setAnswers(n);

    if (n >= ANSWERS_BEFORE_REVEAL) void requestReveal();
  }, [push, requestReveal]);

  const onTurnEnd = useCallback(async () => {
    const said = saidRef.current.trim();
    saidRef.current = '';
    if (said) push('assistant', said);

    // turnEnd means Gemini stopped generating, not that the speakers are quiet.
    const player = playerRef.current;
    while (player?.speaking) await new Promise(r => setTimeout(r, 80));
    setMicStrict(false);

    if (revealWaitRef.current) { setPhase('revealing'); finishIfReady(); return; }

    /*
     * Ask the next question only if this turn actually produced an answer.
     * Tracking what has been asked separately from the answer count means a
     * turn Miles fielded without an answer (a false trigger, or the user asking
     * him something) returns the floor instead of re-asking or skipping ahead.
     */
    const n = answersRef.current;
    if (n > askedRef.current && askedRef.current < QUESTIONS.length) {
      const index = askedRef.current;
      askedRef.current = index + 1;
      await askQuestion(index);
      return;
    }
    setPhase('listening');
  }, [askQuestion, finishIfReady, push]);

  // ─── socket ────────────────────────────────────────────────────────────────
  const openSocket = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/live`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const player = new LivePlayer(24000, () => {
      // Ran dry: either Miles finished, or barge-in flushed the queue.
      if (revealWaitRef.current) finishIfReady();
    });
    playerRef.current = player;

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (turnOpenRef.current) { closeUserTurn(); setPhase('speaking'); }
        setMicStrict(true);
        player.push(ev.data);
        return;
      }
      let msg: { type?: string; text?: string; message?: string };
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'ready':
          void greet();
          break;
        case 'heard':
          // The VAD normally opens the turn first; this covers the typed path
          // and any transcript that arrives without one.
          turnOpenRef.current = true;
          heardRef.current += msg.text ?? '';
          break;
        case 'said':
          if (turnOpenRef.current) closeUserTurn();
          saidRef.current += msg.text ?? '';
          break;
        case 'interrupted':
          player.flush();
          saidRef.current = '';
          setPhase('listening');
          break;
        case 'turnEnd':
          void onTurnEnd();
          break;
        case 'error':
          console.warn('[live]', msg.message);
          setError('The voice connection dropped.');
          setDegraded(true);
          setPhase('error');
          break;
      }
    };

    ws.onerror = () => { setError('Could not reach the voice service.'); setDegraded(true); setPhase('error'); };
    ws.onclose  = () => { if (!doneRef.current && !revealWaitRef.current) setDegraded(true); };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeUserTurn, finishIfReady, onTurnEnd]);

  // ─── the opening line ──────────────────────────────────────────────────────
  const greet = useCallback(async () => {
    setPhase('speaking');
    setMicMuted(true);
    const token = currentToken();
    try {
      await speakCached(OPENING_LINE, token);
    } catch {
      speakFallback(OPENING_LINE);
      await new Promise(r => setTimeout(r, 4200));
    }
    if (isStale(token)) return;
    sendJson({ type: 'inject', text: OPENING_LINE });
    push('assistant', OPENING_LINE);
    setMicMuted(false);
    setPhase('listening');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, sendJson, setMicMuted]);

  // ─── mic ───────────────────────────────────────────────────────────────────
  const openMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Without AEC the model hears itself through the speakers and derails.
        // This is also what makes barge-in survivable on a kiosk.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    streamRef.current = stream;

    primeAudio();
    const ctx = getAudioContext();
    if (!ctx) throw new Error('no audio context');
    if (ctx.state === 'suspended') await ctx.resume();

    await ctx.audioWorklet.addModule('/worklets/pcm-recorder.js');
    const node = new AudioWorkletNode(ctx, 'pcm-recorder');
    node.port.onmessage = (e) => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;

      // Raw PCM rides as binary; VAD transitions come through as objects.
      if (e.data instanceof ArrayBuffer) { ws.send(e.data); return; }

      const vad = (e.data as { vad?: 'start' | 'end' }).vad;
      if (!vad) return;
      if (vad === 'start') {
        // The turn opens here, not when the first transcript arrives — those
        // can land after Miles has already started replying, and a turn that
        // opened late would never be committed.
        turnOpenRef.current = true;
        // Opening a turn under Miles is how barge-in happens: Gemini drops its
        // own output and the queued audio here has to go with it.
        if (playerRef.current?.speaking) {
          playerRef.current.flush();
          saidRef.current = '';
        }
        setPhase('listening');
      }
      ws.send(JSON.stringify({ type: 'activity', state: vad }));
      if (vad === 'end') setPhase('thinking');
    };
    // Start gated — the opening line plays before the user's first turn.
    node.port.postMessage({ muted: true });

    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);
    // Not connected to the destination: routing the mic to the speakers would
    // be a feedback loop. The worklet is a sink, which is enough to pull audio.
    attachMicAnalyser(src);   // lets the orb move to the user's real voice
    workletRef.current = node;
  }, []);

  // ─── lifecycle ─────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPhase('connecting');

    // Both of these are needed before the first turn; warm them together.
    prefetchSpeech(OPENING_LINE);
    prefetchSpeech(QUESTIONS[0]);

    primeAudio();
    try {
      await openMic();
    } catch (err) {
      // No mic is not the end of the session — Miles can still speak, the user
      // just types. Falling through to the socket keeps his real voice rather
      // than dropping all the way to the REST path.
      console.warn('[live] mic unavailable, continuing in typed mode', err);
      setError('No microphone — you can type your answers instead.');
      setDegraded(true);
    }
    openSocket();
  }, [openMic, openSocket]);

  /*
   * Last-resort turn, used only when the relay is unreachable. Falls all the
   * way back to the pre-live pipeline: /api/chat writes a short reaction, the
   * TTS route speaks it, and the fixed question follows from cache. Slower and
   * less alive than the live session, but the demo still completes instead of
   * dead-ending on a closed socket.
   */
  const restTurn = useCallback(async (text: string) => {
    push('user', text);
    const n = answersRef.current + 1;
    answersRef.current = n;
    setAnswers(n);
    setPhase('thinking');

    // Fire the reveal first so it generates under the reaction, as the live
    // path does — this is the same overlap, just driven from the client.
    if (n >= ANSWERS_BEFORE_REVEAL) void requestReveal();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: buildTranscript(), stage: 'reaction' }),
      });
      if (res.ok) {
        const data = await res.json();
        const reaction = String(data.content ?? '')
          .replace(/[^.!?]*\?/g, '')   // never leave a dangling question here
          .replace(/\s+/g, ' ')
          .trim();
        if (reaction) {
          setPhase('speaking');
          const token = currentToken();
          try { await speakCached(reaction, token); }
          catch { speakFallback(reaction); }
          push('assistant', reaction);
        }
      }
    } catch (err) {
      console.warn('[live] rest reaction failed', err);
    }

    if (n >= ANSWERS_BEFORE_REVEAL) { setPhase('revealing'); finishIfReady(); return; }
    if (n > askedRef.current && askedRef.current < QUESTIONS.length) {
      const index = askedRef.current;
      askedRef.current = index + 1;
      await askQuestion(index);
      return;
    }
    setPhase('listening');
  }, [askQuestion, buildTranscript, finishIfReady, push, requestReveal]);

  /** Typed fallback — same session, same Miles, no mic. */
  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;

    // No live session to talk to — take the REST path instead of posting into
    // a closed socket and hanging on a turn that will never come back.
    if (wsRef.current?.readyState !== WebSocket.OPEN) { void restTurn(t); return; }

    push('user', t);
    const n = answersRef.current + 1;
    answersRef.current = n;
    setAnswers(n);
    turnOpenRef.current = false;
    setPhase('thinking');
    sendJson({ type: 'text', text: t });
    if (n >= ANSWERS_BEFORE_REVEAL) void requestReveal();
  }, [push, requestReveal, restTurn, sendJson]);

  /*
   * User tapped to cut Miles off. Speaking over him already works on its own —
   * the VAD opens a turn and Gemini drops its output — so this only has to stop
   * the audio already queued locally and hand the floor back.
   */
  const bargeIn = useCallback(() => {
    if (!ALLOW_BARGE_IN) return;
    playerRef.current?.flush();
    saidRef.current = '';
    setMicStrict(false);
    setPhase('listening');
  }, [setMicStrict]);

  const stop = useCallback(() => {
    stopSpeech();
    playerRef.current?.flush();
    detachMicAnalyser();
    try { wsRef.current?.close(); } catch { /* already closed */ }
    streamRef.current?.getTracks().forEach(t => t.stop());
    try { workletRef.current?.disconnect(); } catch { /* not connected */ }
    wsRef.current = null;
    streamRef.current = null;
    workletRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  return {
    phase, messages, answers, error, degraded,
    start, stop, sendText, bargeIn,
    isSpeaking: phase === 'speaking',
    isListening: phase === 'listening',
  };
}
