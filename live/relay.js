/*
 * ─── LIVE AUDIO RELAY ────────────────────────────────────────────────────────
 *
 * One browser WebSocket ⇄ one Gemini Live session, for the whole conversation.
 *
 * Why a relay at all: the browser cannot hold the credential. Gemini's ephemeral
 * auth tokens are the sanctioned way around that, but this project's API key
 * mints tokens the Live socket then refuses ("Method doesn't allow unregistered
 * callers", close 1008) — verified against the real endpoint. So the key stays
 * here and the audio takes one extra hop.
 *
 * Everything transport-specific is confined to this file and to connect() in
 * useLiveSession.ts. If a key that mints working tokens shows up later, the
 * browser can dial Gemini directly and this file is deleted — the wire protocol
 * below is deliberately close to Gemini's own message shapes so that swap is
 * mostly subtraction.
 *
 * ─── WIRE PROTOCOL (browser ⇄ relay) ────────────────────────────────────────
 *   browser → relay
 *     binary frame                  raw 16kHz mono PCM s16le from the mic
 *     { type: 'activity', state }   'start' | 'end' — turn boundaries from the
 *                                   client's VAD, since this model's own never
 *                                   fires (see setup below)
 *     { type: 'inject', text }      record a question as already asked, silently
 *     { type: 'text',   text }      send a user turn as text (typed fallback)
 *   relay → browser
 *     binary frame                  raw 24kHz mono PCM s16le of Miles' voice
 *     { type: 'ready' }             upstream setup complete, safe to talk
 *     { type: 'heard',      text }  incremental transcript of the USER
 *     { type: 'said',       text }  incremental transcript of MILES
 *     { type: 'turnEnd' }           Miles finished his turn
 *     { type: 'interrupted' }       Gemini dropped its own output (barge-in)
 *     { type: 'error', message }    fatal; socket closes after this
 *
 * Audio rides as binary frames rather than base64 JSON — it is ~95% of the
 * bytes on this link, and base64 would add a third to every packet in both
 * directions on what is already a latency-sensitive path.
 */
const WebSocket = require('ws');
const { LIVE_PROMPT } = require('./prompt');

const GEMINI_WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const MODEL = process.env.GEMINI_LIVE_MODEL || process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE = process.env.GEMINI_TTS_VOICE || 'Charon';

// Gemini expects 16kHz in and returns 24kHz out. Both are fixed by the API.
const INPUT_RATE = 16000;

// If setup never completes, the user is staring at a dead orb. Fail fast enough
// that the screen can say so and offer the typed fallback.
const SETUP_TIMEOUT_MS = 10000;

// Prefixed to every injected question. See the 'inject' case for why this is
// framed as a user-side note rather than a model turn.
const INJECT_NOTE =
  '[System note — the app has just spoken this question aloud in your voice. ' +
  'Treat it as already asked by you. Do not repeat it, do not answer it, do ' +
  'not ask anything. Wait for the reply.]';

function connectSession(client) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    send(client, { type: 'error', message: 'GEMINI_API_KEY is not set' });
    client.close();
    return;
  }

  const upstream = new WebSocket(`${GEMINI_WS}?key=${key}`);
  let ready = false;
  let closed = false;

  // Mic audio that arrives before setup completes. The user can start talking
  // the instant the screen appears, and dropping that opening syllable makes
  // Miles mishear the name — which is the first thing he says back.
  const backlog = [];

  const setupTimer = setTimeout(() => {
    if (!ready) {
      console.warn('[live] upstream setup timed out');
      send(client, { type: 'error', message: 'Live session did not start' });
      shutdown();
    }
  }, SETUP_TIMEOUT_MS);

  function shutdown() {
    if (closed) return;
    closed = true;
    clearTimeout(setupTimer);
    try { upstream.close(); } catch { /* already closing */ }
    try { client.close(); } catch { /* already closing */ }
  }

  // Any throw inside a socket handler escapes as an uncaughtException and takes
  // the whole server down with it, so every send is guarded.
  function toGemini(payload) {
    if (upstream.readyState !== WebSocket.OPEN) return;
    try { upstream.send(JSON.stringify(payload)); }
    catch (err) {
      console.warn('[live] upstream send failed:', err.message);
      shutdown();
    }
  }

  function sendAudio(buf) {
    toGemini({
      realtimeInput: {
        audio: { data: buf.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_RATE}` },
      },
    });
  }

  // ─── upstream: Gemini → browser ───────────────────────────────────────────
  upstream.on('open', () => {
    toGemini({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          // A one-sentence reaction is an instruction-following job, not a
          // creative one. At the default temperature Miles drifts into adding
          // his own follow-up question — which collides with the fixed question
          // the app plays a beat later, so the customer hears two in a row.
          temperature: 0.5,
        },
        systemInstruction: { parts: [{ text: LIVE_PROMPT }] },
        // Both directions transcribed: the user's words drive the reveal prompt
        // and the saved transcript, Miles' words drive the on-screen caption.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        /*
         * Server-side VAD is off because on this model it never fires. Streaming
         * real speech at healthy levels (75% peak) produced no transcript, no
         * response and no error — the audio was simply consumed. The identical
         * audio bracketed by manual activityStart/activityEnd came back
         * correctly transcribed, so turn boundaries are the client's job and
         * arrive as 'activity' messages from the worklet's VAD.
         */
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
  });

  upstream.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.setupComplete) {
      ready = true;
      clearTimeout(setupTimer);
      for (const chunk of backlog) sendAudio(chunk);
      backlog.length = 0;
      send(client, { type: 'ready' });
      return;
    }

    if (msg.error) {
      const message = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
      console.warn('[live] upstream error:', message.slice(0, 300));
      send(client, { type: 'error', message: 'Live session failed' });
      shutdown();
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // Gemini decided the user cut in. The browser has audio queued ahead of the
    // playhead that must be dropped, or Miles talks over himself.
    if (sc.interrupted) send(client, { type: 'interrupted' });

    if (sc.inputTranscription?.text)  send(client, { type: 'heard', text: sc.inputTranscription.text });
    if (sc.outputTranscription?.text) send(client, { type: 'said',  text: sc.outputTranscription.text });

    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      if (client.readyState === WebSocket.OPEN) client.send(Buffer.from(data, 'base64'));
    }

    if (sc.turnComplete) send(client, { type: 'turnEnd' });
  });

  upstream.on('error', (err) => {
    console.warn('[live] upstream socket error:', err.message);
    send(client, { type: 'error', message: 'Live session dropped' });
    shutdown();
  });

  upstream.on('close', () => {
    if (!closed) send(client, { type: 'error', message: 'Live session ended' });
    shutdown();
  });

  // ─── downstream: browser → Gemini ─────────────────────────────────────────
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!ready) {
        // Bound the backlog so a client that streams into a stalled upstream
        // cannot grow the heap without limit — ~10s of 16kHz audio.
        if (backlog.length < 400) backlog.push(buf);
        return;
      }
      sendAudio(buf);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'inject':
        /*
         * The app just played a fixed question out of cache; the session has to
         * know it was asked.
         *
         * The obvious shape — a model-role turn with turnComplete:false — is
         * wrong, and quietly so. It leaves one of Miles' own turns open, and he
         * finishes it: the next reaction comes back with an invented question
         * spliced into the middle of it ("Pancakes after a long hike sounds
         * like aWhat's one thing you'd love to learn? perfect morning"). Setting
         * turnComplete:true instead makes him speak the injection out loud.
         *
         * Framing it as a note on the USER's side leaves no model turn dangling,
         * so there is nothing to continue. Measured over repeated runs of the
         * real sequence: model-role 0/3 clean, this shape 3/3 clean.
         */
        if (typeof msg.text === 'string' && msg.text.trim()) {
          toGemini({
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{ text: `${INJECT_NOTE}\n"${msg.text}"` }],
              }],
              turnComplete: false,
            },
          });
        }
        break;

      case 'text':
        // Typed-input fallback: same session, same Miles, no mic.
        if (typeof msg.text === 'string' && msg.text.trim()) {
          toGemini({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: msg.text }] }],
              turnComplete: true,
            },
          });
        }
        break;

      case 'activity':
        // Turn boundaries from the client's VAD. 'start' also serves as
        // barge-in: Gemini drops its own output when a turn opens under it.
        if (msg.state === 'start')    toGemini({ realtimeInput: { activityStart: {} } });
        else if (msg.state === 'end') toGemini({ realtimeInput: { activityEnd: {} } });
        break;

      default:
        break;
    }
  });

  client.on('close', shutdown);
  client.on('error', shutdown);
}

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* client vanished */ }
}

/** Attach the relay to an existing HTTP server at /api/live. */
function attachLiveRelay(server, path = '/api/live') {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }

    // Next's dev server runs its own HMR socket over this same server; only
    // claim our own path and leave every other upgrade alone.
    if (pathname !== path) return;

    wss.handleUpgrade(req, socket, head, (ws) => connectSession(ws));
  });

  console.log(`[live] relay listening on ${path} → ${MODEL} (${VOICE})`);
  return wss;
}

module.exports = { attachLiveRelay };
