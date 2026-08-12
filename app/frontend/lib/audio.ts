'use client';

/*
 * ─── AUDIO ENGINE ────────────────────────────────────────────────────────────
 *
 * One AudioContext and one analyser for the whole app. Every playback path is
 * routed through that analyser so the orb renders the coach's actual waveform
 * rather than a canned animation.
 *
 * Extracted from page.tsx because the live session needs the same graph: Miles'
 * voice now arrives as PCM over a WebSocket while the three fixed questions
 * still come out of the clip cache, and both have to land in the same analyser
 * and honour the same interrupt token — otherwise the orb goes flat on half the
 * turns and a cancelled line keeps playing under the next one.
 */

// ─── shared graph ────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let analyserData: Uint8Array<ArrayBuffer> | null = null;
let liveSources: AudioBufferSourceNode[] = [];
let currentAudio: HTMLAudioElement | null = null;
let voiceCache: SpeechSynthesisVoice[] = [];

// Bumped on every new utterance so stale streams self-cancel.
let speechToken = 0;

// The Web Speech fallback has no node graph to tap; the orb runs on a synthetic
// envelope for that path only, so it never freezes mid-sentence.
let syntheticSpeech = false;

export function primeVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const load = () => { voiceCache = window.speechSynthesis.getVoices(); };
  load();
  window.speechSynthesis.addEventListener('voiceschanged', load);
}

/*
 * Create/resume the AudioContext from inside a real tap — iOS Safari will not
 * start one otherwise, and every later coach line depends on it.
 */
export function primeAudio() {
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

export function getAudioContext() { return audioCtx; }
export function getAnalyser() { return analyser; }

// A smooth, speech-ish envelope in [0,1]. Two detuned sines beat against each
// other, which reads as syllables rather than a metronome.
export function syntheticEnvelope(): number {
  const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  const v = Math.abs(Math.sin(t * 6.1)) * 0.6 + Math.abs(Math.sin(t * 2.7)) * 0.4;
  return Math.min(1, v);
}

/** Current output loudness in [0,1] — RMS of the time-domain buffer. */
export function audioLevel(): number {
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

// ─── mic level ───────────────────────────────────────────────────────────────
/*
 * The live session holds the mic stream itself, so while Miles is listening the
 * orb can move to the user's actual voice instead of a canned envelope — which
 * is what the old speech-recognition path was stuck with, since the recognition
 * object owned the mic and left no second stream to analyse.
 */
let micAnalyser: AnalyserNode | null = null;
let micData: Uint8Array<ArrayBuffer> | null = null;

export function attachMicAnalyser(source: AudioNode) {
  const ctx = audioCtx;
  if (!ctx) return;
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  micAnalyser.smoothingTimeConstant = 0.78;
  micData = new Uint8Array(new ArrayBuffer(micAnalyser.fftSize));
  // Analyser only — never connected to the destination, which would be a
  // feedback loop straight back into the mic.
  source.connect(micAnalyser);
}

export function detachMicAnalyser() {
  try { micAnalyser?.disconnect(); } catch { /* already gone */ }
  micAnalyser = null;
  micData = null;
}

/** Current input loudness in [0,1], or null when there's no live mic. */
export function micLevel(): number | null {
  if (!micAnalyser || !micData) return null;
  micAnalyser.getByteTimeDomainData(micData);
  let sum = 0;
  for (let i = 0; i < micData.length; i++) {
    const v = (micData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / micData.length) * 4.2);
}

// ─── interruption ────────────────────────────────────────────────────────────
export function currentToken() { return speechToken; }
export function isStale(token: number) { return token !== speechToken; }

/** Stop every playback path at once: streamed PCM, <audio> element, Web Speech. */
export function stopSpeech() {
  if (typeof window === 'undefined') return;
  speechToken++;
  syntheticSpeech = false;
  for (const src of liveSources) { try { src.onended = null; src.stop(); } catch { /* already ended */ } }
  liveSources = [];
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  window.speechSynthesis?.cancel();
}

// ─── clip cache ──────────────────────────────────────────────────────────────
/*
 * The three questions never change, so their audio is fetched during the
 * previous turn and played from memory — the expensive part of a turn stops
 * being on the critical path.
 */
export type Clip = { samples: Float32Array<ArrayBuffer>; rate: number };
const ttsCache = new Map<string, Clip>();
const ttsInflight = new Map<string, Promise<void>>();

export function decodePcm(buf: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buf);
  const out = new Float32Array(new ArrayBuffer(Math.floor(buf.byteLength / 2) * 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function fetchTTS(text: string): Promise<Response> {
  return fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Warm the TTS endpoint so the first real call isn't slowed by cold start. */
export function prewarmTTS() {
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

/** Synthesise ahead of time and hold it. Idempotent; failures are silent. */
export function prefetchSpeech(text?: string) {
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
export async function playClip(clip: Clip, token: number): Promise<void> {
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
}

/*
 * Speak one fixed line, preferring the cache. Used for the opening line and the
 * three questions — the parts of the script whose wording is guaranteed.
 * Resolves when the audio has finished playing.
 */
export async function speakCached(text: string, token: number): Promise<void> {
  const inflight = ttsInflight.get(text);
  if (inflight) await inflight;            // prefetch still landing — ride it
  if (isStale(token)) return;

  const cached = ttsCache.get(text);
  if (cached) { await playClip(cached, token); return; }

  const res = await fetchTTS(text);
  if (!res.ok) throw new Error('TTS unavailable');
  if (isStale(token)) return;
  if (res.headers.get('Content-Type')?.startsWith('audio/')) await playPcmStream(res, token);
  else await playJsonClip(res, token);
}

// ─── streamed playback ───────────────────────────────────────────────────────
/*
 * Play a streamed 16-bit little-endian PCM body, scheduling chunks as they
 * land. Used by the Cloud TTS fallback path; the live session has its own
 * scheduler below because its audio arrives over a socket, not a Response.
 */
export async function playPcmStream(res: Response, token: number) {
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
    if (isStale(token)) { await reader.cancel(); return; }

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

  if (isStale(token)) return;
  if (!tail) throw new Error('no audio in stream');

  await new Promise<void>(resolve => {
    tail!.onended = () => { liveSources = liveSources.filter(s => s !== tail); resolve(); };
  });
}

/** Cloud TTS fallback shape: one complete clip through an <audio> element. */
export async function playJsonClip(res: Response, token: number): Promise<void> {
  const { audio, mime } = await res.json();
  if (isStale(token)) return;
  const el = new Audio(`data:${mime || 'audio/ogg'};base64,${audio}`);
  currentAudio = el;
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

// ─── live socket playback ────────────────────────────────────────────────────
/*
 * Miles' own voice arrives chunk by chunk over the relay with no known length,
 * so playback is a rolling scheduler rather than a stream reader: each chunk is
 * queued at the running playhead, and "he stopped talking" is the playhead
 * passing the last chunk.
 */
export class LivePlayer {
  private playhead = 0;
  private sources: AudioBufferSourceNode[] = [];
  private rate: number;
  private onIdle?: () => void;

  constructor(rate = 24000, onIdle?: () => void) {
    this.rate = rate;
    this.onIdle = onIdle;
  }

  /** True while audio is queued at or ahead of the context clock. */
  get speaking(): boolean {
    const ctx = getAudioContext();
    return !!ctx && this.playhead > ctx.currentTime + 0.02;
  }

  /** Seconds until the queued audio runs out. */
  get remaining(): number {
    const ctx = getAudioContext();
    if (!ctx) return 0;
    return Math.max(0, this.playhead - ctx.currentTime);
  }

  push(pcm: ArrayBuffer) {
    primeAudio();
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();

    const samples = decodePcm(pcm);
    if (!samples.length) return;

    const buffer = ctx.createBuffer(1, samples.length, this.rate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(getAnalyser() ?? ctx.destination);

    // 140ms of lead-in on the first chunk of an utterance absorbs socket
    // jitter; after that the playhead is already ahead of the clock.
    this.playhead = Math.max(this.playhead, ctx.currentTime + 0.14);
    src.start(this.playhead);
    this.playhead += buffer.duration;

    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter(s => s !== src);
      if (this.sources.length === 0) this.onIdle?.();
    };
  }

  /** Barge-in: drop everything queued but not yet heard. */
  flush() {
    for (const src of this.sources) { try { src.onended = null; src.stop(); } catch { /* ended */ } }
    this.sources = [];
    const ctx = getAudioContext();
    this.playhead = ctx ? ctx.currentTime : 0;
  }
}

// ─── one-shot lines ──────────────────────────────────────────────────────────
/*
 * Speaking state is published through module-level callbacks rather than React
 * state because playback is driven from outside the tree (the reveal screen's
 * closing line, the live session's clips) and the orb has to react to all of it.
 */
let onSpeakStart: (() => void) | null = null;
let onSpeakEnd: (() => void) | null = null;
export function setSpeakHandlers(start: (() => void) | null, end: (() => void) | null) {
  onSpeakStart = start;
  onSpeakEnd = end;
}
export function notifySpeakStart() { onSpeakStart?.(); }
export function notifySpeakEnd() { onSpeakEnd?.(); }

/*
 * Speak a single line and report when it finishes. Used for the reveal's
 * closing message — the one place left that synthesises text outside the live
 * session, because it is generated by the reveal model rather than spoken by
 * Miles in-session.
 */
export async function speak(text: string, onEnd?: () => void) {
  if (typeof window === 'undefined') return;
  stopSpeech();
  const token = currentToken();
  onSpeakStart?.();
  try {
    await speakCached(text, token);
    if (isStale(token)) return;
    onSpeakEnd?.();
    onEnd?.();
  } catch {
    if (isStale(token)) return;
    speakFallback(text);
    // Web Speech gives no reliable end event across browsers, so hold the
    // speaking state (and the orb's motion) for a word-count estimate.
    const est = Math.max(2800, text.split(' ').length * 380);
    setTimeout(() => { if (!isStale(token)) onSpeakEnd?.(); }, est);
    if (onEnd) setTimeout(onEnd, est);
  }
}

// ─── Web Speech fallback ─────────────────────────────────────────────────────
/** Used only when the relay and the TTS route are both unavailable. */
export function speakFallback(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Warm, grounded male delivery to match the Charon voice.
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
  syntheticSpeech = true;
  const done = () => { syntheticSpeech = false; };
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}
