import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';
import { BOARD_IMAGES, isBoardImage } from '@/app/lib/boardImages';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

/*
 * One answer in, one or two tile fills out.
 *
 * This runs while Miles is still reacting to the same answer, so it is on the
 * lite model with no thinking budget — the board is meant to fill *as he
 * speaks*, and a 4-5s reasoning turn would land the tile after he had moved on.
 *
 * Each fill carries three things rather than one:
 *   image     — a slug ONLY when a photo genuinely depicts what they said
 *   imageAlt  — the closest slug regardless, even if it is a stretch
 *   word      — one or two words naming the thing, always present
 *
 * The client picks `image` when it is there and `word` otherwise, which is what
 * produces the mix of photos and words the design calls for. `imageAlt` is the
 * reserve: the board must end on at least three photos, and if honest matches
 * did not get there, word tiles are promoted to their alternate rather than
 * leaving the reveal looking like a word list.
 */
const MATCH_PROMPT = `You match what someone says about their life to photographs from a fixed library.

## THE LIBRARY
Each entry is named for what it shows. These are the ONLY valid image values:
${BOARD_IMAGES.join('\n')}

## YOUR JOB
You are given one thing a person just said. Return ONLY a JSON array — no prose, no markdown, no code fences — of exactly {{COUNT}} objects:

[{ "image": "ExactSlugOrNull", "imageAlt": "ExactSlug", "word": "One Or Two Words" }]

- "image": the slug of a photo that genuinely shows what they described. If nothing in the library honestly depicts it, use null. Do NOT stretch — a person who says they want to learn piano is not "TwoPeopleDJing".
- "imageAlt": the closest slug in the library even when it is an imperfect match. NEVER null. Used only as a reserve.
- "word": one or two words in Title Case naming the specific thing they said — "Surfing", "Trail Running", "Rescue Dog", "Vinyl Sets". Never a full sentence, never generic ("Fun", "Adventure", "Life").

## RULES
- Every slug you output MUST appear in the library above, character for character.
- Return {{COUNT}} objects. If they said only one thing, invent a second angle on it rather than repeating — for a surfer: "Surfing" and "Sunrise Swells".
- Each object must be about a DIFFERENT facet. Never repeat a slug within your answer.
- These slugs are already used elsewhere on the board — never return them: {{TAKEN}}
- Name what THEY said, not what you infer they are like.

JSON array only.`;

export async function POST(req: NextRequest) {
  try {
    const { answer, count, taken } = await req.json();

    if (typeof answer !== 'string' || !answer.trim()) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const wanted = Math.max(1, Math.min(3, Number(count) || 1));
    const takenList: string[] = Array.isArray(taken) ? taken.filter(isBoardImage) : [];

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_REACTION_MODEL || 'gemini-3.5-flash-lite',
      systemInstruction: MATCH_PROMPT
        .replace(/\{\{COUNT\}\}/g, String(wanted))
        .replace('{{TAKEN}}', takenList.length ? takenList.join(', ') : '(none yet)'),
    });

    const result = await model.generateContent(answer);
    const raw = result.response.text();

    // The lite model still fences JSON now and then; take the outermost array.
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      console.error('[board] no JSON array in response:', raw.slice(0, 200));
      return NextResponse.json({ fills: [] });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (parseErr) {
      console.error('[board] parse error', parseErr);
      return NextResponse.json({ fills: [] });
    }

    if (!Array.isArray(parsed)) return NextResponse.json({ fills: [] });

    /*
     * Validate every slug against the generated manifest. A hallucinated
     * filename would render as a broken tile on the reveal, so an unknown slug
     * is dropped to null and the tile falls back to its word.
     */
    const fills = parsed.slice(0, wanted).map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const word = typeof o.word === 'string' ? o.word.trim().slice(0, 24) : '';
      return {
        image: isBoardImage(o.image) ? o.image : null,
        imageAlt: isBoardImage(o.imageAlt) ? o.imageAlt : null,
        word: word || 'Yours',
      };
    });

    return NextResponse.json({ fills });
  } catch (err) {
    console.error('[board] error', err);
    // A failed match must never break the conversation — the board just keeps
    // that tile empty and Miles carries on.
    return NextResponse.json({ fills: [] });
  }
}
