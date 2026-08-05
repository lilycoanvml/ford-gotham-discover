import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

/*
 * ─── VOICE ──────────────────────────────────────────────────────────────────
 * Primary: Gemini native audio over the Live API (bidiGenerateContent). Native
 * audio carries real prosody and takes a delivery direction, so the coach reads
 * like a person instead of a narrator.
 *
 * The Live API generates at roughly 1x realtime — a 9s line takes ~9s to
 * finish, but the FIRST chunk lands in ~750ms. So this route streams raw PCM
 * back as it arrives and the client plays it progressively. Waiting for the
 * whole clip would put ~10s of dead air in front of every coach turn.
 *
 * Fallback: Google Cloud TTS Chirp 3 HD (the previous behaviour), used when the
 * Live socket errors or produces no audio. That path still returns the original
 * JSON body, so the client supports both shapes.
 *
 * Contract: POST { text } →
 *   • audio/pcm stream  + X-Audio-Rate / X-Audio-Format headers   (Gemini)
 *   • application/json  { audio: base64, mime }                   (Cloud TTS)
 */

const LIVE_MODEL   = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-live-preview';
const LIVE_VOICE   = process.env.GEMINI_TTS_VOICE || 'Charon'; // deeper male
const LIVE_WS_URL  = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const FIRST_CHUNK_TIMEOUT_MS = 9000; // give up and fall back to Cloud TTS

// The Live model is a dialog model by default — this pins it to "read this out".
const SPEECH_DIRECTION =
  'You are a speech engine, not a conversation partner. Speak the user message back ' +
  'VERBATIM, word for word. Never answer it, never add or drop words, never comment. ' +
  'Delivery: a warm, upbeat guide talking to one person face to face — natural ' +
  'conversational pacing, genuine energy, light breaths between thoughts. Not an ' +
  'announcer, not a narrator, no reading-aloud cadence.';

const cloudTTS = new TextToSpeechClient();

// Strip markdown formatting so the voice doesn't read symbols out loud
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic* / *emphasis*
    .replace(/__(.+?)__/g, '$1')       // __bold__
    .replace(/_(.+?)_/g, '$1')         // _italic_
    .replace(/`(.+?)`/g, '$1')         // `code`
    .replace(/^\s*[-*+]\s+/gm, '')     // leading bullet markers
    .replace(/\s+\*\s+/g, ' ')         // stray inline asterisks
    .replace(/[*_`#]/g, '')            // any remaining stragglers
    .replace(/\s{2,}/g, ' ')           // collapse extra spaces
    .trim();
}

type LiveStream = { stream: ReadableStream<Uint8Array>; sampleRate: number };

/*
 * Opens the Live socket and resolves only once the first audio chunk is in hand
 * — that way a dead model or bad key can still fall back to Cloud TTS before we
 * have committed to a response body. Resolves null if no audio ever arrives.
 */
function speakWithGeminiLive(spoken: string): Promise<LiveStream | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Promise.resolve(null);

  return new Promise<LiveStream | null>((resolve) => {
    const ws = new WebSocket(`${LIVE_WS_URL}?key=${key}`);

    const pending: Uint8Array[] = []; // chunks that arrive before/while we hand off
    let push: ((chunk: Uint8Array) => void) | null = null;
    let close: (() => void) | null = null;
    let sampleRate = 24000;
    let settled = false;
    let finished = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; safeClose(); resolve(null); }
    }, FIRST_CHUNK_TIMEOUT_MS);

    function safeClose() {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
    }

    // Called once the first chunk lands: hand the caller a stream that drains
    // `pending` first, then receives everything else live.
    function handOff() {
      settled = true;
      clearTimeout(timer);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of pending) controller.enqueue(c);
          pending.length = 0;
          push = (chunk) => controller.enqueue(chunk);
          close = () => { try { controller.close(); } catch { /* already closed */ } };
          if (finished) close();
        },
        cancel() { safeClose(); }, // client navigated away / interrupted the coach
      });
      resolve({ stream, sampleRate });
    }

    function finish() {
      finished = true;
      if (close) close();
      safeClose();
    }

    // A throw inside a socket handler would escape as an uncaughtException and
    // take the server down, so every send is guarded and degrades to a fallback.
    function send(payload: unknown): boolean {
      try { ws.send(JSON.stringify(payload)); return true; }
      catch (err) {
        console.warn('[tts] Live socket send failed:', err);
        if (!settled) { settled = true; safeClose(); resolve(null); } else finish();
        return false;
      }
    }

    ws.on('open', () => {
      send({
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } },
          },
          systemInstruction: { parts: [{ text: SPEECH_DIRECTION }] },
        },
      });
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, never>;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const m = msg as unknown as {
        setupComplete?: unknown;
        error?: unknown;
        serverContent?: {
          modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
          turnComplete?: boolean;
        };
      };

      if (m.setupComplete) {
        send({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: spoken }] }],
            turnComplete: true,
          },
        });
        return;
      }

      if (m.error) {
        console.warn('[tts] Live API error:', JSON.stringify(m.error).slice(0, 300));
        if (!settled) { settled = true; safeClose(); resolve(null); } else finish();
        return;
      }

      for (const part of m.serverContent?.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (!inline?.data) continue;
        const rate = inline.mimeType?.match(/rate=(\d+)/);
        if (rate) sampleRate = Number(rate[1]);
        const chunk = new Uint8Array(Buffer.from(inline.data, 'base64'));
        if (push) push(chunk);
        else {
          pending.push(chunk);
          if (!settled) handOff();
        }
      }

      if (m.serverContent?.turnComplete) finish();
    });

    ws.on('error', (err: Error) => {
      console.warn(`[tts] Live socket (${LIVE_MODEL}) failed:`, err.message);
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); } else finish();
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(null); } else finish();
    });
  });
}

async function speakWithCloudTTS(spoken: string) {
  const [response] = await cloudTTS.synthesizeSpeech({
    input: { text: spoken },
    voice: {
      languageCode: 'en-US',
      // Chirp 3 HD voices render fast and sound natural. Charon = deeper male.
      // Other male options: 'Puck' (upbeat), 'Fenrir'; 'Aoede'/'Kore' are female.
      name: 'en-US-Chirp3-HD-Charon',
    },
    audioConfig: {
      audioEncoding: 'OGG_OPUS',
      speakingRate: 1.08, // a touch brisk for an upbeat, energetic delivery
      // Chirp 3 HD doesn't support pitch — relies on voice character itself
    },
  });

  return NextResponse.json({
    audio: Buffer.from(response.audioContent as Uint8Array).toString('base64'),
    mime: 'audio/ogg',
  });
}

export async function POST(req: NextRequest) {
  try {
    const { text, warm } = await req.json();

    // Cold-start ping from the client — spins up this instance, no synthesis.
    if (warm) return new NextResponse(null, { status: 204 });

    if (!text?.trim()) return NextResponse.json({ error: 'No text' }, { status: 400 });

    const spoken = cleanForSpeech(text);

    try {
      const live = await speakWithGeminiLive(spoken);
      if (live) {
        return new NextResponse(live.stream, {
          headers: {
            'Content-Type': 'audio/pcm',
            'X-Audio-Format': 'pcm-s16le',
            'X-Audio-Rate': String(live.sampleRate),
            'X-Audio-Channels': '1',
            'Cache-Control': 'no-store',
          },
        });
      }
      console.warn('[tts] Live audio unavailable — falling back to Cloud TTS');
    } catch (err) {
      console.warn('[tts] Live audio threw, falling back to Cloud TTS:', err);
    }

    return await speakWithCloudTTS(spoken);
  } catch (err) {
    console.error('TTS error:', err);
    return NextResponse.json({ error: 'TTS unavailable' }, { status: 500 });
  }
}
