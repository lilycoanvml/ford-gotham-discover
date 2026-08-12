/*
 * Mic → 16kHz mono PCM s16le, plus voice-activity detection.
 *
 * 16kHz is the only input format the Gemini Live API accepts, and the
 * AudioContext runs at whatever the hardware gives us (44.1k on most Macs, 48k
 * on most Android), so every frame gets resampled here.
 *
 * The VAD is not optional. This model's server-side automatic activity
 * detection never fires — verified by streaming real speech at healthy levels
 * and getting back no transcript, no response, and no error, while the same
 * audio bracketed by manual activityStart/activityEnd was transcribed
 * correctly. So the client has to decide where speech starts and stops.
 *
 * This runs on the audio thread. A dropped frame is an audible gap in what
 * Miles hears, so there is no allocation in the hot path beyond the outgoing
 * chunk itself, and nothing here can throw.
 *
 * Why a worklet and not a ScriptProcessor: ScriptProcessorNode runs on the main
 * thread, and this app animates an orb at 60fps on that same thread. Under load
 * the mic would stutter exactly when the visuals got busy.
 */
const TARGET_RATE = 16000;

// ~20ms per message. Small enough that end-of-speech detection stays snappy,
// large enough that we are not posting thousands of tiny messages a second.
const FRAME_SAMPLES = 320;

// Speech has to hold for this long before we call it a turn — stops a cough or
// a door closing from opening a turn Gemini then has to answer.
const ONSET_FRAMES = 3;      // 60ms

// How long the user can pause mid-thought before we call the turn finished.
// Natural turn-taking gaps run ~200ms; people mid-sentence pause longer than
// that, and cutting them off reads as rude, so this sits well above it.
const HANGOVER_FRAMES = 45;  // 900ms

// Absolute floors, so a silent room with a near-zero noise floor doesn't end up
// with a threshold low enough to trigger on the noise itself.
const MIN_START = 0.012;
const MIN_END   = 0.008;

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_RATE; // e.g. 48000/16000 = 3
    this._pos = 0;                          // fractional read head into the input
    this._out = new Int16Array(FRAME_SAMPLES);
    this._n = 0;
    this._muted = false;
    this._tail = 0;                         // last sample of the previous block

    // VAD state
    this._speaking = false;
    this._onset = 0;
    this._quiet = 0;
    this._noiseFloor = 0.01;
    // Raised while Miles is talking: his voice leaks through imperfect echo
    // cancellation, and a false trigger there cuts him off mid-sentence.
    this._strict = false;
    this._sumSq = 0;
    this._sumN = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (typeof d.muted === 'boolean') {
        this._muted = d.muted;
        if (d.muted) this._reset();
      }
      if (typeof d.strict === 'boolean') this._strict = d.strict;
    };
  }

  _reset() {
    if (this._speaking) this.port.postMessage({ vad: 'end' });
    this._speaking = false;
    this._onset = 0;
    this._quiet = 0;
  }

  // One decision per emitted frame, on the resampled signal.
  _vad(rms) {
    const k = this._strict ? 2.2 : 1.0;
    const startAt = Math.max(MIN_START * k, this._noiseFloor * 3.5 * k);
    const endAt   = Math.max(MIN_END, this._noiseFloor * 2.0);

    if (!this._speaking) {
      // Track the room only while nobody is talking, so the floor doesn't
      // creep up to swallow the speech it is supposed to detect.
      this._noiseFloor = this._noiseFloor * 0.995 + rms * 0.005;
      if (rms > startAt) {
        if (++this._onset >= ONSET_FRAMES) {
          this._speaking = true;
          this._quiet = 0;
          this.port.postMessage({ vad: 'start' });
        }
      } else if (this._onset > 0) this._onset--;
      return;
    }

    if (rms < endAt) {
      if (++this._quiet >= HANGOVER_FRAMES) {
        this._speaking = false;
        this._onset = 0;
        this.port.postMessage({ vad: 'end' });
      }
    } else this._quiet = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];

    // No mic yet, or gated while a cached question plays through the speakers.
    if (!ch || ch.length === 0) return true;
    if (this._muted) { this._pos = 0; this._tail = ch[ch.length - 1]; return true; }

    // Linear interpolation across the block boundary: `_pos` carries the
    // fractional offset between blocks so the resampled stream has no seam.
    while (this._pos < ch.length) {
      const i = Math.floor(this._pos);
      const frac = this._pos - i;
      const a = i === 0 ? this._tail : ch[i - 1];
      const b = ch[i];
      const s = a + (b - a) * frac;

      this._sumSq += s * s;
      this._sumN++;

      // Clamp before the int16 cast — a sample above 1.0 wraps to a loud click.
      this._out[this._n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));

      if (this._n === FRAME_SAMPLES) {
        this._vad(Math.sqrt(this._sumSq / this._sumN));
        this._sumSq = 0;
        this._sumN = 0;

        // Transfer rather than copy; the buffer is dead to us either way.
        const buf = this._out.buffer;
        this.port.postMessage(buf, [buf]);
        this._out = new Int16Array(FRAME_SAMPLES);
        this._n = 0;
      }
      this._pos += this._ratio;
    }

    this._pos -= ch.length;
    this._tail = ch[ch.length - 1];
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
