/*
 * The fixed half of the conversation.
 *
 * Miles' turns are two pieces: a reaction he now improvises natively in the live
 * audio session, and a question that never changes. Keeping the questions fixed
 * — rather than trusting the model to reproduce them verbatim — does three things:
 *   • guarantees the wording instead of hoping the prompt holds
 *   • lets their audio be synthesised ahead of time and played instantly
 *   • keeps every run of the demo asking the customer the same things
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
 * The one sentence the pitch must always contain.
 *
 * The last two questions ask how far they drive in a day and whether they can
 * charge at home, and a question Miles never answers reads as a question that
 * was not listened to. He is barred from quoting a range figure — the number is
 * not in the order guide — so this is the answer: the reassurance, no number.
 *
 * The reveal prompt asks the model to place it inside the pitch, where it sits
 * in context. `sanitizePitch` below is the guarantee: if the model paraphrased
 * it, dropped it, or never ran at all, the line is appended anyway. It is the
 * response to two questions the customer actually answered, so "usually" is not
 * good enough.
 */
export const RANGE_ASSURANCE =
  'The Fathom offers the range you need to get where we want to go.';

/*
 * Loose enough to recognise the model's own punctuation and casing, tight
 * enough that it cannot match an unrelated sentence: the distinctive middle of
 * the line, with any whitespace between the words.
 */
const RANGE_ASSURANCE_RE = /the\s+range\s+you\s+need\s+to\s+get\s+where\s+we\s+want\s+to\s+go/i;

/*
 * Spoken on the invite screen if the model's vehiclePitch is missing or came
 * back as template text. It names the vehicle and stops — with no payload it
 * cannot say why the truck suits this particular person.
 */
const PITCH_FALLBACK =
  "Here's the Ford Fathom. All electric, with a steel bed and a front trunk.";

function sanitizePitch(msg: string | undefined): string {
  const base =
    !msg || msg.startsWith('[') || msg.length > 600
      ? PITCH_FALLBACK
      : msg.replace(/\[.*?\]/g, '').trim() || PITCH_FALLBACK;

  if (RANGE_ASSURANCE_RE.test(base)) return base;
  // No sentence-ending punctuation means the two lines would run together as
  // one breath, so give the voice engine the full stop it needs.
  return /[.!?]$/.test(base) ? `${base} ${RANGE_ASSURANCE}` : `${base}. ${RANGE_ASSURANCE}`;
}

/*
 * The whole invite-screen line, pitch and ask together, as ONE utterance.
 *
 * It used to be two `speak` calls with a beat between them, and the beat read
 * as Miles trailing off and then remembering something. Concatenating means one
 * synthesis, one playback, and no seam — and because the string is built here,
 * the session can prefetch the exact same text the screen will later speak, so
 * it plays from cache instead of synthesising while the customer waits.
 */
export const revealSpeech = (vehiclePitch: string | undefined): string =>
  `${sanitizePitch(vehiclePitch)} ${REVEAL_FOLLOW_UP}`;

/** How many user answers arrive before the reveal: the name, then one per question. */
export const ANSWERS_BEFORE_REVEAL = QUESTIONS.length + 1;
