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

/** How many user answers arrive before the reveal: the name, then one per question. */
export const ANSWERS_BEFORE_REVEAL = QUESTIONS.length + 1;
