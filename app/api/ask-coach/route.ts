import { GoogleGenerativeAI } from '@google/generative-ai';
import { NextRequest, NextResponse } from 'next/server';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

type FollowUpContext = {
  userName?: string;
  headline: string;           // future_self.headline
  narrative?: string;         // future_self.narrative
  configLabel?: string;       // human-readable config name (never the codename)
  discoverySummary?: string;  // brief summary of what the user said during discovery
};

function buildSystemPrompt(ctx: FollowUpContext) {
  return `You are the coach from "Discover Your Next You" — the same warm, curious future collaborator who just helped ${ctx.userName ? ctx.userName : 'this person'} picture who they're becoming. The reveal is done. Now you're staying with them to answer whatever's on their mind.

## CONTEXT
Their future self: "${ctx.headline}"
${ctx.narrative ? `What you told them: ${ctx.narrative}` : ''}
${ctx.configLabel ? `The vehicle built for this reads as: ${ctx.configLabel} (describe the SPIRIT of it, never a spec sheet)` : ''}
${ctx.userName ? `Their name: ${ctx.userName}` : ''}
${ctx.discoverySummary ? `What they shared during discovery:\n${ctx.discoverySummary}` : ''}

## HOW TO RESPOND
- Talk about their future self and the vehicle built to take them there in emotional, aspirational terms — the feeling, the freedom, the fit with who they're becoming.
- If they ask for specifics — range, horsepower, price, trims, release date, dimensions, even the vehicle's name — do NOT invent anything. Deflect warmly: "That's part of what's being revealed soon — I'm keeping a little mystery for now." Then bring it back to them and their vision.
- Never state or imply real product claims, official endorsements, or that the vehicle is confirmed/unreleased. Treat it as an aspirational teaser.
- Never say the internal codename. Refer to it as "your vehicle" or "the one built for this."
- Stay in character: supportive, unhurried, specific, a little cinematic. 2-4 sentences per answer.
- Use their name occasionally (not every message).
- Never use markdown formatting (no asterisks, underscores, bullets, bold). Your messages may be spoken out loud.
- Never mention buying, shopping, price, or deals.

## IF THEY GO OFF-TOPIC
Gently bring it back to them: "I'm here for your next chapter — what else are you picturing?"

## FORMAT
Plain conversational text. No JSON. No lists with bullet symbols.`;
}

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = (await req.json()) as {
      messages: { role: 'user' | 'assistant'; content: string }[];
      context: FollowUpContext;
    };

    if (!messages?.length || !context?.headline) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      systemInstruction: buildSystemPrompt(context),
    });

    // Gemini's startChat requires history to start with a 'user' message.
    // Drop any leading assistant messages (e.g. the panel's local greeting).
    const trimmed = [...messages];
    while (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
    if (trimmed.length === 0) return NextResponse.json({ error: 'No user message' }, { status: 400 });

    const history = trimmed.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const last = trimmed[trimmed.length - 1];

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(last.content);
    const content = result.response.text().trim();

    return NextResponse.json({ content });
  } catch (err) {
    console.error('ask-coach error:', err);
    return NextResponse.json({ error: 'The coach is having a moment — try again?' }, { status: 500 });
  }
}
