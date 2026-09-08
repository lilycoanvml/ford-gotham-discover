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

/*
 * Anti-aliasing cutoff, below the 8kHz Nyquist of the target rate.
 *
 * Decimating 48k to 16k throws away two of every three samples, and anything
 * above 8kHz in the input folds back down into the band as inharmonic,
 * metallic content. Linear interpolation alone is a two-tap filter — it barely
 * touches those frequencies. So this ran unfiltered, and the fold-back did two
 * kinds of damage: the model heard a harsh ringing version of the voice, and
 * the folded energy inflated the RMS the VAD measures, which made Miles' own
 * leakage through echo cancellation look like speech and trip a barge-in in the
 * middle of his sentence.
 */
const LP_CUTOFF = 6800;

// ~20ms per message. Small enough that end-of-speech detection stays snappy,
// large enough that we are not posting thousands of tiny messages a second.
const FRAME_SAMPLES = 320;

// Speech has to hold for this long before we call it a turn — stops a cough or
// a door closing from opening a turn Gemini then has to answer.
const ONSET_FRAMES = 3;      // 60ms

/*
 * And this long while Miles is talking.
 *
 * Interrupting him sends activityStart upstream, which makes Gemini abandon the
 * sentence it is speaking — so a false trigger here is not cosmetic, it cuts him
 * off. 60ms of leakage cleared the old bar; a person who actually means to
 * interrupt keeps talking for far longer than 300ms, and a burst of echo does
 * not.
 */
const ONSET_FRAMES_STRICT = 15;  // 300ms

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

    /*
     * Two cascaded biquads (RBJ cookbook low-pass, Q=0.7071) give a 4th-order
     * roll-off for eight multiplies a sample — cheap enough for the audio
     * thread, steep enough that what folds back is far below the speech it
     * would otherwise smear. Coefficients are computed once here; `sampleRate`
     * is the worklet global for the context's real rate.
     */
    const w0 = (2 * Math.PI * Math.min(LP_CUTOFF, sampleRate / 2 - 500)) / sampleRate;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * 0.70710678);
    const a0 = 1 + alpha;
    this._b0 = ((1 - cosW) / 2) / a0;
    this._b1 = (1 - cosW) / a0;
    this._b2 = this._b0;
    this._a1 = (-2 * cosW) / a0;
    this._a2 = (1 - alpha) / a0;
    // Direct Form I state, one set per cascaded stage.
    this._s1 = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this._s2 = { x1: 0, x2: 0, y1: 0, y2: 0 };
    // Filtered copy of the current block. Allocated once; blocks are 128 frames.
    this._f = new Float32Array(256);

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

  // One biquad stage, Direct Form I. No allocation, cannot throw.
  _stage(st, x) {
    const y = this._b0 * x + this._b1 * st.x1 + this._b2 * st.x2
            - this._a1 * st.y1 - this._a2 * st.y2;
    st.x2 = st.x1; st.x1 = x;
    st.y2 = st.y1; st.y1 = y;
    return y;
  }

  // One decision per emitted frame, on the resampled signal.
  _vad(rms) {
    const k = this._strict ? 2.2 : 1.0;
    const onsetNeeded = this._strict ? ONSET_FRAMES_STRICT : ONSET_FRAMES;
    const startAt = Math.max(MIN_START * k, this._noiseFloor * 3.5 * k);
    const endAt   = Math.max(MIN_END, this._noiseFloor * 2.0);

    if (!this._speaking) {
      // Track the room only while nobody is talking, so the floor doesn't
      // creep up to swallow the speech it is supposed to detect.
      this._noiseFloor = this._noiseFloor * 0.995 + rms * 0.005;
      if (rms > startAt) {
        if (++this._onset >= onsetNeeded) {
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
    if (this._muted) {
      this._pos = 0;
      this._tail = 0;
      // Drop the filter's memory too, so the first block back does not ring
      // with whatever was in flight when the mic was cut.
      this._s1.x1 = this._s1.x2 = this._s1.y1 = this._s1.y2 = 0;
      this._s2.x1 = this._s2.x2 = this._s2.y1 = this._s2.y2 = 0;
      return true;
    }

    /*
     * Band-limit BEFORE decimating. This is the step that was missing: the read
     * head below skips two of every three samples, so anything left above 8kHz
     * folds back into the band instead of being discarded.
     */
    const len = ch.length;
    if (this._f.length < len) this._f = new Float32Array(len);
    const f = this._f;
    for (let j = 0; j < len; j++) {
      f[j] = this._stage(this._s2, this._stage(this._s1, ch[j]));
    }

    // Linear interpolation across the block boundary: `_pos` carries the
    // fractional offset between blocks so the resampled stream has no seam.
    while (this._pos < len) {
      const i = Math.floor(this._pos);
      const frac = this._pos - i;
      const a = i === 0 ? this._tail : f[i - 1];
      const b = f[i];
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

    this._pos -= len;
    this._tail = f[len - 1];
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
