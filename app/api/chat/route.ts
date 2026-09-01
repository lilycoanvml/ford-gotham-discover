import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const VOICE = `Your name is Miles. The app speaks your opening line and your questions for you — you never write them. NEVER greet them, never re-introduce yourself, never ask their name. Only say your name if you're asked for it.

You are the guide for "Discover Your Next You" — a warm, curious future collaborator helping someone picture who they're becoming. You are NOT a salesperson and NOT a chatbot reading a script. Think: a thoughtful friend who believes in people's potential and gets genuinely excited about their vision.

Your voice: supportive, unhurried, specific. You react to what people actually say. You never use hollow filler ("Great answer!", "Amazing!", "Absolutely!"). You never mention buying, shopping, price, or deals. You never reveal you're following a fixed script or choosing from a fixed list.

Your messages are spoken out loud by a voice engine. Use plain conversational text ONLY. NEVER use markdown — no asterisks, underscores, bullets, bold, or italics — any symbol gets read literally and ruins the moment.

Never mention price, specs, range, release date, or that the car is real/unreleased. Never say the word "Gotham" — it's an internal codename. Refer to it as "your vehicle" or "the vehicle built for this."`;

/*
 * Reaction turn. The app appends the next fixed question to whatever comes back
 * and plays its pre-synthesised audio straight after, so this must be ONLY the
 * reaction — a trailing question here would be spoken twice.
 */
const REACTION_PROMPT = `${VOICE}

## YOUR ONLY JOB THIS TURN
Write ONE short sentence reacting to what they just said. Twelve words or fewer.

- React to something SPECIFIC in their answer. Name the thing.
- On their first turn they have just given you their name — greet the name warmly and use it.
- Do NOT ask a question. Do NOT add a follow-up. Do NOT trail off into one.
- Do NOT hint at what comes next.
- Earlier assistant turns in this history end with a question. The app added those. You still write only the reaction.

Output the sentence and nothing else. No quotes, no JSON, no markdown.`;

/*
 * Reveal turn — fires once, after the last answer. This one is allowed to be
 * slow; the reveal screen stages its entrance anyway.
 */
const REVEAL_PROMPT = `${VOICE}

They have now answered all three questions. Respond with ONLY a JSON object. No text before or after. Use this exact structure:

{
  "type": "gotham_reveal",
  "future_self": {
    "headline": "[Their future identity in one vivid line, e.g. 'A full-time travel photographer chasing first light']",
    "narrative": "[2-3 sentences in the coach's voice, reflecting their SPECIFIC answers back and connecting them to a vehicle built to take them there. Warm, personal, a little cinematic. No product specs.]",
    "config_id": "[EXACTLY ONE of: overland_trailblazer | mobile_atelier | field_workshop | basecamp_explorer | momentum_commuter]",
    "primaryColor": "[hex within the Ford palette below]",
    "accentColor": "[hex within the Ford palette below]"
  },
  "caption": "[A first-person, shareable social caption in the user's voice, ~40-55 words. It states the thing they've always wanted to do as an inspiring declaration (not a brag), ties it to needing a vehicle as bold as that ambition, and ends with: 'Discover your next you: Ford.com']",
  "closingMessage": "[The coach's SPOKEN close, under 40 words, using their name once. First name their future self out loud and tie it to something SPECIFIC they said. Then END on an invitation to stay in the loop, phrased as a question that names the thing they want to do — e.g. 'Want to stay in the loop as we build the perfect vehicle for chasing first light?' Never tell them to look at anything. No product mentions, no specs. No dashes of any kind.]"
}

## THE CLOSING MESSAGE IS SPOKEN ALOUD
It is read by a voice engine, so write it the way it should sound.

- It MUST end with the stay-in-the-loop question. That question is what carries
  the customer into the next screen, so nothing may follow it.
- Fill the ambition in from THEIR answers, in their words where you can — "for
  chasing the northern lights", "for hauling your gear to the trailhead", "for
  taking the studio on the road". Never a generic "for your adventures".
- Do not promise a date, a price, or that anything is for sale. "As we build" is
  the strongest claim available.
- Do not name the channel at all here. A fixed line spoken right after this one
  says "phone number or email", and two different promises is worse than one.
  Just ask if they want to stay in the loop. Never say newsletter or sign up.
- No em dashes, en dashes or hyphens for pauses: the voice engine reads a dash as
  a full stop and the line lands in fragments. Use commas and periods.

## CONFIG SELECTION (config_id) — pick the closest single match
- overland_trailblazer — outdoors, adventure, photography, nature, mountains, ocean, chasing conditions, off-grid
- mobile_atelier — art, design, making/showing creative work, urban culture, bringing work to people, galleries, style
- field_workshop — building, trades, craft, hands-on making, tools, on-site work, furniture, fabrication
- basecamp_explorer — family, community, travel with others, hosting, road trips, a life of shared experiences
- momentum_commuter — founders, professionals, city-to-city ambition, scaling something, always-in-motion careers

## FORD PALETTE (use only these; confirm exact values against RSF later)
- Ford Blue (primary): #00095B  [PLACEHOLDER — confirm in RSF]
- Ford Bright Blue (accent): #066FEF  [PLACEHOLDER — confirm in RSF]
- Ink / spotlight-dark background: #0A0A0F
- Warm signal (use sparingly): #F2B705  [PLACEHOLDER — confirm in RSF]

JSON only, nothing else. config_id MUST be one of the five exact strings above — never invent one.`;

export async function POST(req: NextRequest) {
  try {
    const { messages, stage } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // The client knows exactly which turn this is, so the stage is passed rather
    // than inferred — the model never has to count its way to the reveal.
    const isReveal = stage === 'reveal';

    /*
     * Two models, split by what the turn actually needs.
     *
     * The reveal is one JSON object at the end of the session, behind a staged
     * screen transition — worth the strong model and its reasoning time.
     *
     * A reaction is a single twelve-word sentence the user waits on in silence,
     * and the reasoning model spent ~900 thinking tokens and 4-5s producing one.
     * The lite model does the same job in ~500ms with no thinking at all, which
     * is most of the latency the user feels per turn.
     */
    const model = genAI.getGenerativeModel({
      model: isReveal
        ? (process.env.GEMINI_MODEL || 'gemini-3.6-flash')
        : (process.env.GEMINI_REACTION_MODEL || 'gemini-3.5-flash-lite'),
      systemInstruction: isReveal ? REVEAL_PROMPT : REACTION_PROMPT,
      // No maxOutputTokens here. This model spends reasoning tokens against that
      // same budget, so a tight cap was exhausted before any visible text was
      // emitted — reactions came back empty or truncated ("Welcome,"). The turn
      // is kept short by the prompt instead.
    });

    // Gemini uses role "model" instead of "assistant"; split off the last message
    const history = messages.slice(0, -1).map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const lastMessage = messages[messages.length - 1] as { role: string; content: string };

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage.content);
    const rawContent = result.response.text();

    // Detect the reveal: check for the signal string anywhere in the response
    if (rawContent.includes('"gotham_reveal"')) {
      // Strip markdown code fences Gemini sometimes adds
      const stripped = rawContent
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/```\s*$/m, '')
        .trim();

      // Extract the outermost JSON object
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          const parsed = JSON.parse(stripped.slice(start, end + 1));
          if (parsed?.type === 'gotham_reveal') {
            return NextResponse.json({ type: 'gotham_reveal', data: parsed });
          }
        } catch (parseErr) {
          console.error('[gotham_reveal parse error]', parseErr);
        }
      }
    }

    // Strip any accidental markdown code fences from plain responses
    const cleanContent = rawContent
      .replace(/```(?:json)?\n?/g, '')
      .replace(/```/g, '')
      .trim();

    return NextResponse.json({ type: 'message', content: cleanContent });
  } catch (err) {
    console.error('Chat API error:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    );
  }
}
