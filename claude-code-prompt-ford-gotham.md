# Claude Code Task: Transform the Dell "Eras" prototype into Ford "Discover Your Next You" (Gotham reveal)

You are working inside a copy of a Next.js voice-chat prototype (originally "Find Your Next Era" for Dell). Your job is to iterate it into a teaser experience for an **unreleased, secret Ford EV, codenamed "Gotham."** Keep the working engine; change the concept, copy, data model, brand, and add one net-new visual.

Read this entire brief before touching code. Do not start from scratch — you are reskinning and reprompting an app that already works.

---

## 0. Ground truth about this codebase (do not trust the README)

The README and `docs/` describe a 9-agent Claude architecture. **That is aspirational fiction.** The real running app is:

- **`app/page.tsx` (~1,390 lines)** — the entire experience. A screen state machine: `type Screen = 'landing' | 'intro' | 'chat' | 'reveal' | 'recs' | 'share'`. It contains the voice loop, the reveal rendering, and the html2canvas share-card generator.
- **`app/api/chat/route.ts`** — a **single Google Gemini call** (`gemini-2.5-flash`, `GEMINI_API_KEY`) with one large `SYSTEM_PROMPT`. Returns `{type:'message', content}` during Q&A, and `{type:'era_reveal', data}` (pure JSON) after the last question. The route detects the reveal by checking `rawContent.includes('"era_reveal"')`.
- **`app/api/tts/route.ts`** — Google Cloud Text-to-Speech (`en-US-Chirp3-HD-Aoede`) for the coach's voice.
- **`app/api/ask-ali/route.ts`** — post-reveal follow-up chat (also Gemini).
- Voice input uses the browser Web Speech API (`SpeechRecognition`) with a text fallback (`inputMode: 'voice' | 'text'`). Interim transcript is already tracked as `interimText` / `interim`.
- Share card = client-side **html2canvas** → `navigator.share` on mobile, PNG download on desktop.
- The `agents/`, `app/orchestration/`, `app/backend/`, and `tools/` folders are **NOT imported by the running app.** They are decorative. Do not wire them in; you may leave them or delete them, but do not spend time on them.

**Keep the stack as-is: Gemini + voice.** Do not switch model providers. Do not remove the voice loop.

---

## 1. The new concept

**Campaign:** "Discover Your Next You."
**Premise:** Not a product pitch — a guided moment of self-discovery. The user tells the coach who they are now and who they want to become in 5 years; the experience reveals a personalized "next self" alongside a Ford Gotham silhouette configured to match that future, then hands them a shareable social graphic.

**The AI persona ("the coach"):** a supportive, genuinely curious "future collaborator." Warm, encouraging, unhurried. NOT salesy, NOT corporate, NOT a hype-man. Replaces Dell's "Ali."

**The hook (landing copy):** "In five years, who will you be? Tell us your vision, and we'll show you the vehicle built to take you there."

**Critical framing / guardrails (do not violate):**
- Gotham is a **secret, unreleased vehicle.** Do NOT state or invent specs, range, horsepower, price, trims, or a release date. No pricing anywhere (remove all Black Friday pricing from the Dell version).
- The silhouette is deliberately **mysterious** — a dark shape under a spotlight that resolves but never shows full production detail.
- This is an aspirational teaser. Do not imply official endorsement or make product claims.
- Treat all Ford trademarks (the Oval, wordmark, typeface) as **placeholder assets the user will replace with licensed files.** Use clearly-labeled placeholders; never hard-code brand claims as fact.

---

## 2. Conversation flow (name + 2 questions, then reveal)

Shorter than Dell's name+4. The full flow is: **opening → get name → Q1 → Q2 → reveal.**

Rewrite the `SYSTEM_PROMPT` in `app/api/chat/route.ts` to exactly the following (adjust only if a bug requires it):

```
You are the guide for "Discover Your Next You" — a warm, curious future collaborator helping someone picture who they're becoming. You are NOT a salesperson and NOT a chatbot reading a script. Think: a thoughtful friend who believes in people's potential and gets genuinely excited about their vision.

Your voice: supportive, unhurried, specific. You react to what people actually say. You never use hollow filler ("Great answer!", "Amazing!", "Absolutely!"). You never mention buying, shopping, price, or deals. You never reveal you're following a fixed script or choosing from a fixed list.

Your messages are spoken out loud by a voice engine. Use plain conversational text ONLY. NEVER use markdown — no asterisks, underscores, bullets, bold, or italics — any symbol gets read literally and ruins the moment.

## FLOW — exactly 3 exchanges before the reveal

### Opening (ask for their name)
A short, warm hello, then ask their name. Under 15 words. Example: "Welcome. Before we look ahead — what should I call you?"

### After they give their name — Q1 (where they are now)
React warmly using their name once, then ask: what they do when they have free time that makes them feel most like themselves. Keep it to 2 short sentences. Example energy: "There's a version of you that shows up when nobody's asking anything of you. When you've got a free Saturday, what's the thing you reach for?"

### After Q1 — Q2 (where they're going)
React to something specific they said (2 short sentences max), then ask them to imagine 5 years out with no limits on time, money, or place — what does their life look like. Example energy: "If you took that and gave it room to grow — five years out, no limits on time or money or where you live — what does your life actually look like?"

### After Q2 — THE REVEAL
Respond with ONLY a JSON object. No text before or after. Use this exact structure:

{
  "type": "gotham_reveal",
  "future_self": {
    "headline": "[Their future identity in one vivid line, e.g. 'A full-time travel photographer chasing first light']",
    "narrative": "[2-3 sentences in the coach's voice, reflecting their SPECIFIC answers back and connecting them to a vehicle built to take them there. Warm, personal, a little cinematic. No product specs.]",
    "config_id": "[EXACTLY ONE of: overland_trailblazer | mobile_atelier | field_workshop | basecamp_explorer | momentum_commuter]",
    "primaryColor": "[hex within the Ford palette below]",
    "accentColor": "[hex within the Ford palette below]"
  },
  "caption": "[A first-person, shareable social caption in the user's voice, ~40-55 words. It states their 5-year vision as an inspiring declaration (not a brag), ties it to needing a vehicle as bold as their ambition, and ends with: 'Discover your next you: [Link] #DiscoverYourNextYou #Ford']",
  "closingMessage": "[The coach's SPOKEN reveal, under 45 words, using their name once. Name their future self out loud and tie it to something specific they said. Then invite them to see it. No product mentions, no specs.]"
}

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

## HARD RULES
- Q1 and Q2 replies: plain text, 2 short sentences max, no JSON, no markdown.
- After Q2: JSON only, nothing else.
- config_id MUST be one of the five exact strings above. Never invent a config.
- Never mention price, specs, range, release date, or that the car is real/unreleased.
- Never say the word "Gotham" to the user — it's an internal codename. Refer to it as "your vehicle" or "the vehicle built for this."
```

Then update the **detection string** in `route.ts`: change every check for `'"era_reveal"'` / `parsed?.type === 'era_reveal'` to `'"gotham_reveal"'` / `parsed?.type === 'gotham_reveal'`, and return `{ type: 'gotham_reveal', data: parsed }`. Update the frontend to read `type === 'gotham_reveal'` accordingly.

---

## 3. NET-NEW: the live-morphing silhouette

This is the signature visual and the main new build. The dark Gotham silhouette sits under a spotlight and **morphs in real time as the user speaks**, resolving to the chosen config at the reveal.

**Architecture (keep the morph responsive without waiting on the LLM):**
1. Create a new component `app/frontend/components/MorphSilhouette.tsx`.
2. Define **6 SVG silhouette paths** as string constants: `neutral_base` (the starting ambiguous EV shape) plus one per config (`overland_trailblazer`, `mobile_atelier`, `field_workshop`, `basecamp_explorer`, `momentum_commuter`). Author them as **placeholder** side-profile silhouettes — clearly a rugged/roof-racked profile vs. a sleek low profile vs. a boxy utility profile, etc. Leave a comment block: `// PLACEHOLDER SILHOUETTES — replace with official Gotham art per RSF/design`.
   - All six paths MUST share a **compatible structure for interpolation.** Use the `flubber` library (`npm i flubber`) to interpolate between arbitrary paths safely; do not rely on framer-motion's raw `d` animation for dissimilar paths.
3. **Live morph driver:** as interim speech transcript streams in (the app already exposes `interimText`), run a lightweight client-side keyword scorer that nudges the silhouette toward the leading archetype. Starter keyword map (extend as needed):

```ts
const CONFIG_KEYWORDS: Record<string, string[]> = {
  overland_trailblazer: ['mountain','hike','trail','camera','photo','sunrise','wild','outdoors','ocean','surf','off grid','national geographic','backcountry'],
  mobile_atelier:       ['art','artist','design','gallery','studio','create','paint','fashion','street','urban','exhibit','show my work'],
  field_workshop:       ['build','builder','wood','furniture','craft','tools','workshop','fabricate','make','on site','contractor','maker'],
  basecamp_explorer:    ['family','kids','friends','road trip','travel','together','community','host','camp','weekend','adventure with'],
  momentum_commuter:    ['company','startup','founder','business','scale','city','clients','launch','grow','ceo','pitch','meetings'],
};
```
   - Score the running transcript, pick the top archetype, and ease the silhouette toward that target path (partial morph, e.g. 60-80%) so it feels alive but unresolved. If no keywords hit, drift back toward `neutral_base`.
4. **Resolution at reveal:** when the `gotham_reveal` payload arrives, snap/ease the silhouette fully to `future_self.config_id` (the LLM's choice is authoritative and overrides the live guess). Add a spotlight "illuminate" beat (opacity/scale/glow) synced to the `closingMessage` TTS starting.
5. Respect `prefers-reduced-motion`: if set, skip continuous morphing and just cut to the resolved config at reveal.
6. Mount the silhouette on the `intro`/`chat` screens (background, behind the transcript) and as the hero of the `reveal` screen.

---

## 4. Reveal + "recs" screens

Dell showed an era + 3 priced product cards. **Remove the product/SKU/pricing concept entirely.** Replace with:

- **Reveal screen:** the resolved silhouette (hero), `future_self.headline`, `future_self.narrative`, and the coach's spoken `closingMessage` (played via `/api/tts`, same mechanism as Dell).
- Replace the Dell "recs" screen with a single **teaser + email capture** step (see §5). There are no products to list.
- Delete/neutralize: the six-era taxonomy, all `products[]` rendering, `ProductCard.tsx` usage, Black Friday pricing, Dell.com links, and any "Black Friday" strings. `ProductCard.tsx` can be removed or repurposed as the "config detail" card if you want a small "your configuration" flourish (optional, no prices).

---

## 5. Email capture (skippable)

Per the concept, email is an invitation to "stay updated / see the real reveal," and users can skip it.

- Add a lightweight capture step between `reveal` and `share`: a single email field + primary CTA "Keep me updated" and a secondary "Skip for now."
- On submit or skip, proceed to the share screen. The share graphic is available either way.
- **Do not build a real backend for this.** POST to a stub `app/api/subscribe/route.ts` that validates the email shape and returns `{ ok: true }` (log to console only). Leave a clear `// TODO: wire to real ESP/CRM` comment. Do not store PII beyond the request lifecycle.
- Basic client-side email validation only. No third-party trackers.

---

## 6. Share card reskin (keep html2canvas)

Reuse the existing html2canvas → `navigator.share` / PNG-download logic. Restyle the card:

- Ford-branded: Ford Blue background or spotlight-dark, placeholder Ford Oval + wordmark (labeled as placeholder assets), Ford Antenna typeface (placeholder, see §7).
- Content: "I'm becoming…" + `future_self.headline`, the resolved silhouette, and the `#DiscoverYourNextYou #Ford` hashtags. Pull share text from `caption`.
- Remove the Dell wordmark, "BLACK FRIDAY '26" ribbon, and product tiles.
- Keep filename/share title dynamic, e.g. `discover-your-next-you.png` and share title "Discover Your Next You".

---

## 7. Brand theming — one file, clearly-marked placeholders

Do NOT scatter brand values through the code, and do NOT invent Ford brand rules. Create a single **`app/theme/ford-brand.ts`** (or extend `tailwind.config.ts` tokens) holding every brand token, each commented as a placeholder to confirm against the official RSF:

```ts
// FORD BRAND TOKENS — PLACEHOLDERS. Confirm every value against the official
// Ford RSF / Brand Design System before any external use. Do not treat as final.
export const fordBrand = {
  colorFordBlue:       '#00095B', // placeholder
  colorFordBrightBlue: '#066FEF', // placeholder
  colorInk:            '#0A0A0F',
  colorSignal:         '#F2B705', // placeholder — use sparingly
  fontDisplay: '"Ford Antenna", "Arial Narrow", system-ui, sans-serif', // Antenna = placeholder; load licensed webfont
  fontBody:    '"Ford Antenna", system-ui, sans-serif',                 // placeholder
  logoOvalSrc: '/brand/ford-oval-PLACEHOLDER.svg', // replace with licensed asset
  toneNotes: 'Confident, human, optimistic, plain-spoken. Bold reserved for the brand/name only, per Ford brand guidance.',
};
```

- Put placeholder brand assets in `public/brand/` with `-PLACEHOLDER` in the filename.
- Apply tokens app-wide (landing gradient, buttons, share card, silhouette spotlight).
- Add a top-of-README note listing every placeholder the user must swap (colors, typeface webfont, oval/wordmark, RSF confirmation).

---

## 8. Adapt the post-reveal follow-up (`/api/ask-ali`)

Keep the follow-up chat feature but re-persona it: rename the concept from "Ali" to "the coach," strip the Dell product/era context, and feed it the `future_self` payload (headline, narrative, config_id) instead of products. It should answer curiosity about "the vehicle built for this" **without inventing specs or price** — deflect specifics warmly ("that's part of what's being revealed soon"). Update its system prompt accordingly. Rename the file/route to `app/api/ask-coach/route.ts` if low-risk; otherwise keep the path and just change the prompt.

---

## 9. Copy & string sweep

Remove/replace every Dell-era artifact: "Dell", "Ali", "Black Friday", "era"/"Eras", the six era names, product names, prices, Dell.com URLs, "purchase/buy/shop/deal". Replace landing/intro/loading copy with "Discover Your Next You" language and the hook line from §1. Update `<title>`, meta, `app/layout.tsx`, `app/icon.svg`, and `index.html`.

---

## 10. What to KEEP untouched (don't refactor for its own sake)

- The voice loop (SpeechRecognition + interim transcript + text fallback).
- The `/api/tts` mechanism and its markdown-stripping helper.
- The Gemini call pattern and the `{message | reveal}` JSON protocol (only the signal string and schema change).
- The screen state-machine pattern in `page.tsx` (rename `recs`→`capture` if you like, but keep the pattern).
- html2canvas share mechanism.

---

## 11. Definition of done (acceptance criteria)

1. `npm install && npm run dev` runs clean; no Dell/Black Friday strings remain in shipped UI.
2. Flow works end to end by **voice**: landing → name → Q1 → Q2 → reveal → email (skippable) → share.
3. The silhouette **visibly morphs while the user speaks** and **resolves to `config_id`** at the reveal; honors `prefers-reduced-motion`.
4. Reveal shows headline + narrative and **speaks** `closingMessage` via TTS.
5. Reveal contains **no pricing, no specs, no release date**; the codename "Gotham" never appears in user-facing copy.
6. Share graphic generates (mobile share sheet + desktop PNG) with Ford placeholder branding and the `caption` text.
7. All brand values live in one theme file, each marked as a placeholder to confirm against RSF.
8. `config_id` from the model always maps to one of the five silhouettes (add a safe fallback to `neutral_base` if an unknown id ever arrives, and log it).
9. Gemini remains the model; voice remains the primary input.

---

## 12. Suggested order of work

1. String/brand sweep + theme file + Gemini system prompt swap + reveal-signal rename (fast, unblocks everything).
2. Reveal/capture/share screen rework (remove products, add email stub, reskin share card).
3. Build `MorphSilhouette.tsx` with placeholder paths + flubber + neutral base (static resolve first).
4. Wire the live keyword-driven morph to interim transcript; add reveal resolution + spotlight beat.
5. Re-persona `ask-coach`; polish motion, reduced-motion, mobile.

Work in small commits. After step 1, pause and show me the running landing + first two questions before building the silhouette.
