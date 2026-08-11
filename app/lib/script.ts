/*
 * The fixed half of the conversation.
 *
 * Miles' turns are two pieces: a short reaction the model writes fresh, and a
 * question that never changes. Keeping the questions here — rather than trusting
 * the model to reproduce them verbatim — does three things:
 *   • guarantees the wording instead of hoping the prompt holds
 *   • lets their audio be synthesised ahead of time and played instantly
 *   • cuts what the model has to generate per turn to one sentence
 *
 * Imported by both the client (to compose and pre-fetch) and the chat route
 * (to build the prompt), so the two can never drift apart.
 */

// Spoken locally the moment the chat screen mounts — no model call.
export const OPENING_LINE =
  "Hey there — I'm Miles, and I'm here to help you find your Fathom. Change starts with a name. What's yours?";

export const QUESTIONS = [
  'What does a perfect Saturday look like for you?',
  "What's something you've always wanted to do, but haven't gotten around to yet?",
  'Now picture yourself doing it. What would the perfect vehicle for that adventure be like?',
] as const;

/** How many user answers arrive before the reveal: the name, then one per question. */
export const ANSWERS_BEFORE_REVEAL = QUESTIONS.length + 1;
