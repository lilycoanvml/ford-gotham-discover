# Discover Your Next You
### Ford × "Gotham" reveal — teaser experience

A guided, voice-first moment of self-discovery. You tell a warm AI coach who you
are now and who you want to become in five years; the experience reveals a
personalized "next self" alongside a mysterious Ford vehicle silhouette that
morphs as you speak, then hands you a shareable social graphic.

> **"Gotham"** is an internal codename for an unreleased, secret vehicle. It never
> appears in user-facing copy, and the experience states no specs, range, price,
> trims, or release date.

---

## ⚠️ PLACEHOLDERS — you MUST swap these before any external use

Every brand value is a **placeholder** pending confirmation against the official
Ford RSF / Brand Design System. They live in one place: `app/theme/ford-brand.ts`
(mirrored as CSS variables in `app/globals.css` and Tailwind tokens in
`tailwind.config.ts` — keep the three in sync).

| Placeholder | Where | Action |
|---|---|---|
| Ford Blue `#00095B` | `ford-brand.ts` / `globals.css` / `tailwind.config.ts` | Confirm exact value in RSF |
| Ford Bright Blue `#066FEF` | same | Confirm exact value in RSF |
| Warm signal `#F2B705` | same | Confirm value; use sparingly |
| Typeface **"Ford Antenna"** | `app/layout.tsx` (loads Archivo as a stand-in) | Load the **licensed** Antenna webfont |
| Typeface **"American Grotesk"** | first in `--font-display` (`globals.css`) — the face used in the Figma reveal frame, not bundled | Load it (or confirm Antenna is the intended face) |
| Ford Oval | `public/brand/ford-oval-PLACEHOLDER.svg` | Replace with the **licensed** oval asset |
| Ford wordmark | `ford-brand.ts` (`wordmarkText: 'FORD'`) | Replace with the licensed wordmark asset |
| Favicon | `app/icon.svg` | Replace oval stand-in with licensed art |

Do not treat any brand value as final, and do not imply official endorsement.

---

## The Experience

1. **Landing** — "In five years, who will you be?" One CTA invites you in.
2. **Discovery** — the coach asks your **name + two questions** (where you are now,
   where you're going). Voice-first, with a text fallback.
3. **Reveal** — the card from Figma *Ford Gotham Discovery* → **Frame 1 (node `24:264`)**:
   black canvas, the config name in tracked caps over an animated sunrise plate, the
   identity headline, a short cinematic narrative, then a steel `CONTINUE` pill and a
   ghost `START OVER`. The coach speaks a personalized closing as the card resolves.
   **No specs, no pricing, no release date.**
4. **Stay updated** *(skippable)* — optional email capture (a stub — nothing is stored).
5. **Share** — a Ford-branded social graphic ("I'm becoming…") generated client-side.

The silhouette resolves to one of five configurations: Overland Trailblazer,
Mobile Atelier, Field Workshop, Basecamp Explorer, or Momentum Commuter.

---

## Quick Start

### Prerequisites
- Node.js 18+
- A Google **Gemini API key** ([aistudio.google.com](https://aistudio.google.com/app/apikey))
- The coach's voice uses **Gemini native audio** over the Live API and needs only
  `GEMINI_API_KEY`. Google Cloud Text-to-Speech credentials
  (`GOOGLE_APPLICATION_CREDENTIALS`) are an optional second tier; with neither, the
  app falls back to the browser's Web Speech voice automatically.

### Setup

```bash
npm install
cp .env.example .env      # add your GEMINI_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `GEMINI_MODEL` | No | Conversation model (default: `gemini-3.6-flash`) |
| `GEMINI_TTS_MODEL` | No | Voice model (default: `gemini-3.1-flash-live-preview`) |
| `GEMINI_TTS_VOICE` | No | Prebuilt voice name (default: `Puck`, upbeat male) |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | GCP creds for Cloud TTS (falls back to Web Speech) |
| `NEXT_PUBLIC_APP_ENV` | No | `development` or `production` |

---

## Architecture (the real running app)

- **`app/page.tsx`** — the whole experience: a screen state machine
  (`landing → intro → chat → reveal → capture → share`), the voice loop, the reveal,
  and the html2canvas share card.
- **`app/frontend/components/MorphSilhouette.tsx`** — the signature visual. Six
  placeholder SVG silhouettes interpolated with `flubber`, driven live by a
  client-side keyword scorer over the speech transcript, resolving to the model's
  chosen config at the reveal. Honors `prefers-reduced-motion`.
- **`app/api/chat/route.ts`** — a single Google Gemini call with one system prompt.
  Returns `{type:'message'}` during Q&A and `{type:'gotham_reveal', data}` after Q2.
- **`app/api/tts/route.ts`** — the coach's voice, in three tiers:
  1. **Gemini native audio** (`gemini-3.1-flash-live-preview`) over the Live API
     WebSocket. Native audio carries real prosody, so the read sounds human rather
     than narrated. It generates at ~1x realtime but the first chunk lands in
     ~750ms-1.2s, so the route **streams raw PCM** (`audio/pcm`, `X-Audio-Rate`) and
     the client plays chunks as they arrive — waiting for the full clip would put
     ~10s of dead air in front of every coach line.
  2. **Cloud TTS Chirp 3 HD** (`Puck`) if the live socket fails — returns the whole
     clip as JSON `{audio, mime}`. The client handles both response shapes.
  3. The browser's **Web Speech** voice if the route is unreachable.

  `ws` is listed in `serverExternalPackages` (see `next.config.ts`) — webpack
  bundling breaks its optional native addons.
- **`app/api/ask-coach/route.ts`** — post-reveal follow-up chat (Gemini), re-personaed
  to the coach; deflects any spec/price questions warmly.
- **`app/api/subscribe/route.ts`** — email-capture **stub** (validates shape, returns
  `{ok:true}`, stores nothing). `// TODO: wire to real ESP/CRM`.

### Reveal artwork

`public/reveal/truck-sunrise.gif` is exported from the Figma frame: 105 frames at
30ms (~3.1s) of the sun rising behind the silhouette. Its Netscape looping
extension has been **stripped** so browsers play it once and hold the lit final
frame — left looping, the card would flash back to black every ~3s. It is 4.2MB, so
`ChatScreen` preloads it while the user is still answering questions. Re-exporting
from Figma means re-stripping that extension.

> Note: the `agents/`, `app/orchestration/`, `app/backend/`, and `tools/` folders are
> **not imported by the running app** — they are decorative scaffolding from the
> original prototype and can be ignored or removed.

---

## Deploy

Deploys to Google Cloud Run in project **`vml-map-xd-ford`** as the **new** service
`ford-gotham-discover` (fresh Artifact Registry repo of the same name). This copy is
not attached to any previous repository or deployment.

```bash
./deploy.sh                    # defaults to project vml-map-xd-ford, region us-central1
./deploy.sh vml-map-xd-ford us-central1
```

The Gemini key is read from Secret Manager (`gemini-api-key`) in the target project.
# ford-gotham-discover
# ford-gotham-discover
