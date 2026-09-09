/*
 * The fixed half of the conversation.
 *
 * Miles' turns are two pieces: a reaction he now improvises natively in the live
 * audio session, and a question that never changes. Keeping the questions fixed
 * — rather than trusting the model to reproduce them verbatim — does three things:
 *   • guarantees the wording instead of hoping the prompt holds
 *   • lets their audio be synthesised ahead of time and played instantly
 *   • keeps every run of the demo saying the same three things to the customer
 *
 * The wording lives in shared/script.json because the live relay (plain CJS,
 * outside the Next build) needs the identical strings to tell Miles what he
 * just asked. One file, both sides, no drift.
 */
import script from '@/shared/script.json';

// Spoken from cached audio the moment the chat screen mounts — no model call.
export const OPENING_LINE: string = script.openingLine;

export const QUESTIONS = script.questions as readonly string[];

/*
 * Spoken a beat after Miles introduces the vehicle on the invite screen. His
 * pitch is written by the model and deliberately asks for nothing; this is the
 * ask, and it is fixed so the promise about what we collect never varies.
 *
 * Fixed rather than model-written on purpose — it is the one line that makes a
 * promise about what we collect, so it must name both options the capture screen
 * accepts, every single time. Keep it in step with app/lib/contact.ts.
 */
export const REVEAL_FOLLOW_UP: string = script.revealFollowUp;

/*
 * Spoken on the invite screen if the model's vehiclePitch is missing or came
 * back as template text. It names the vehicle and stops — with no payload it
 * cannot say why the truck suits this particular person.
 */
const PITCH_FALLBACK =
  "Here's the Ford Fathom. All electric, with a steel bed, a front trunk, and the range to get you where you're going.";

function sanitizePitch(msg: string | undefined): string {
  if (!msg || msg.startsWith('[') || msg.length > 500) return PITCH_FALLBACK;
  return msg.replace(/\[.*?\]/g, '').trim() || PITCH_FALLBACK;
}

/*
 * The whole invite-screen line, pitch and ask together, as ONE utterance.
 *
 * It used to be two `speak` calls with a beat between them, and the beat read
 * as Miles trailing off and then remembering something. Concatenating means one
 * synthesis, one playback, and no seam. It is streamed rather than prefetched —
 * see requestReveal for why buffering a clip this long only adds silence.
 */
export const revealSpeech = (vehiclePitch: string | undefined): string =>
  `${sanitizePitch(vehiclePitch)} ${REVEAL_FOLLOW_UP}`;

/** How many user answers arrive before the reveal: the name, then one per question. */
export const ANSWERS_BEFORE_REVEAL = QUESTIONS.length + 1;
