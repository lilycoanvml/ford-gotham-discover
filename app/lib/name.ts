/*
 * Pulling a first name out of the answer to "what's yours?".
 *
 * People do not answer with a bare name. They answer with a sentence, and very
 * often they greet the coach first — "Hey Miles, my name is Anne". An earlier
 * version scanned for the first word that was not filler, which on that input
 * stopped at "Miles" and put HIS name on the chip.
 *
 * So the introduction marker drives it now: when someone says "my name is",
 * "I'm", "it's" or "call me", the name is whatever follows. Only with no marker
 * present does it fall back to the first non-filler word. "Miles" is in the
 * filler list either way — he is the one name that is never the answer.
 *
 * Deliberately local and instant rather than another model call: the chip is
 * the first thing that fills, and it should land while they are still speaking.
 * A wrong guess shows one wrong word on a pastel pill, which is recoverable; a
 * two-second wait for the very first tile is not.
 */

/*
 * An explicit introduction. Word-bounded — matching "im" loosely found it
 * inside "swim" and took the next word as the name.
 */
const INTRO_RE =
  /\b(?:my names|my name's|my name is|my name|names|name's|name is|call me|i'm|i am|im|it's|it is|its|this is)\b\s+/gi;

/*
 * Never the answer: the coach's own name, greetings, and filler. Apostrophes
 * and hyphens are stripped before lookup so "it's" and "its" both land here.
 */
const SKIP = new Set([
  'miles',
  'im', 'i', 'am', 'my', 'name', 'names', 'is', 'its', 'it', 'this', 'that',
  'hi', 'hey', 'hello', 'howdy', 'yo', 'greetings',
  'call', 'me', 'the', 'a', 'an',
  'well', 'so', 'uh', 'um', 'erm', 'like', 'just', 'actually',
  'sure', 'yeah', 'yep', 'yes', 'ok', 'okay', 'oh', 'ah',
  'thanks', 'thank', 'you', 'and', 'but',
  'good', 'morning', 'afternoon', 'evening', 'nice', 'meet',
  'to', 'there', 'here', 'of', 'for', 'with', 'be',
]);

const norm = (w: string) => w.toLowerCase().replace(/['’-]/g, '');

/** First word that is not filler, or undefined when they are all filler. */
function firstMeaningful(words: string[]): string | undefined {
  return words.find(w => w.length > 0 && !SKIP.has(norm(w)));
}

/**
 * The name to put on the chip, Title Case, or '' when the answer carried none
 * ("hey there!"). Callers must treat '' as "no name yet" rather than showing it.
 */
export function firstName(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  /*
   * Take the LAST introduction marker, not the first. "I'm here, and my name is
   * Anne" has two; the one nearest the name is the one that means it.
   */
  let tail = '';
  INTRO_RE.lastIndex = 0;
  for (let m = INTRO_RE.exec(cleaned); m !== null; m = INTRO_RE.exec(cleaned)) {
    tail = cleaned.slice(m.index + m[0].length);
  }

  const pick =
    (tail ? firstMeaningful(tail.split(' ')) : undefined) ??
    firstMeaningful(cleaned.split(' '));

  // No name in there at all. Better to show nothing than to show "Hey".
  if (!pick) return '';

  const name = pick.slice(0, 14);
  return name[0].toUpperCase() + name.slice(1).toLowerCase();
}
