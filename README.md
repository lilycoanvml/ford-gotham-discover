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
| Ford Oval | `public/brand/ford-oval-PLACEHOLDER.svg` | Replace with the **licensed** oval asset |
| Ford wordmark | `ford-brand.ts` (`wordmarkText: 'FORD'`) | Replace with the licensed wordmark asset |
| Favicon | `app/icon.svg` | Replace oval stand-in with licensed art |

Do not treat any brand value as final, and do not imply official endorsement.

---

## The Experience

1. **Landing** — "In five years, who will you be?" One CTA invites you in.
2. **Discovery** — the coach asks your **name + two questions** (where you are now,
   where you're going). Voice-first, with a text fallback.
3. **Reveal** — a dark vehicle silhouette resolves under a spotlight to match your
   future self; the coach speaks a personalized closing. Shows a headline + a short
   cinematic narrative. **No specs, no pricing, no release date.**
4. **Stay updated** *(skippable)* — optional email capture (a stub — nothing is stored).
5. **Share** — a Ford-branded social graphic ("I'm becoming…") generated client-side.

The silhouette resolves to one of five configurations: Overland Trailblazer,
Mobile Atelier, Field Workshop, Basecamp Explorer, or Momentum Commuter.

---

## Quick Start

### Prerequisites
- Node.js 18+
- A Google **Gemini API key** ([aistudio.google.com](https://aistudio.google.com/app/apikey))
- For the natural TTS voice: Google Cloud Text-to-Speech credentials
  (`GOOGLE_APPLICATION_CREDENTIALS`). Without them the app falls back to the
  browser's Web Speech voice automatically.

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
| `GEMINI_MODEL` | No | Override model (default: `gemini-2.5-flash`) |
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
- **`app/api/tts/route.ts`** — Google Cloud Text-to-Speech for the coach's voice.
- **`app/api/ask-coach/route.ts`** — post-reveal follow-up chat (Gemini), re-personaed
  to the coach; deflects any spec/price questions warmly.
- **`app/api/subscribe/route.ts`** — email-capture **stub** (validates shape, returns
  `{ok:true}`, stores nothing). `// TODO: wire to real ESP/CRM`.

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
