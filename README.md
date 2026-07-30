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
| Vehicle wordmark **"FATHOM"** | `ford-brand.ts` (`vehicleWordmarkText`) — read off the Figma social card (node `46:360`) | Confirm the public-facing name and swap for the licensed lockup art |
| Favicon | `app/icon.svg` | Replace oval stand-in with licensed art |

Do not treat any brand value as final, and do not imply official endorsement.

---

## Design source

Every screen is implemented from Figma **"Ford Gotham Discovery"**
(file `Uj1ncN31RmfCDZnJxyoEly`). The node ids are recorded against each block in
`app/globals.css`, so a re-export can be diffed against the right frame:

| Screen (`Screen` type) | Figma frame | Node |
|---|---|---|
| `landing` | Intro | `41:548` |
| `intro` | Loading Screen | `41:550` |
| `chat` | Chat | `41:513` |
| `reveal` | Personality 1 / Personality 2 | `24:264` / `33:282` |
| `capture` | Sign Up | `41:398` |
| `share` | Social Card 1 | `41:335` |

**Mobile-first, one layout.** The Figma frames are 1440x1024. Rather than a
separate phone breakpoint, every dimension is the desktop reference wrapped in a
`clamp()`, so the same ratios hold from 320px up to 1440px. Two consequences
worth knowing:

- The landing chip row (`who / will you / be?`) is sized in `em` off its own
  type scale, so all three stay on one line at any width instead of wrapping.
- The social card sizes its contents in `cqw` against a container query on the
  card itself. `.share-card-inner` exists because an element cannot use its own
  container units for its own padding — without the split, percentage padding
  resolves against the surrounding flex row (~1400px on desktop), not the 383px
  card.

**Where the two reveal frames disagree:** Personality 1 overlaps its title box
into the plate by -32px; Personality 2 leaves a 20px gap. The gap is
authoritative here — the overlap only works for a single-line title, and most
config names wrap to two lines at 45px with 0.30em tracking.

### Palette

The three pastels are a set: they label the question on the landing screen, then
return **in the same order** as the user's three chat bubbles.

| Token | Value | Used for |
|---|---|---|
| `--gd-steel` | `#89A0B1` | primary pill, `who`, 3rd user bubble, italic accents |
| `--gd-terra` | `#DC997E` | `will you`, 1st user bubble |
| `--gd-sage` | `#B3C3A9` | `be?`, 2nd user bubble |
| `--gd-surface` | `#14141D` | guide bubbles, back button, inputs |
| `--gd-grey` | `#8A8A8A` | secondary copy, ghost buttons |

Caps labels are tracked `0.32em` (4.8px at 15px) throughout.

---

## The Experience

1. **Landing** — "In five years, *who will you be?*" with the three pastel chips
   and a steel `BEGIN` pill.
2. **Loading** — a radial glow behind *"Discover your next you"* while the coach
   speaks its opening line.
3. **Discovery** — the coach asks your **name + two questions** (where you are
   now, where you're going). Voice-first, with a text fallback.
4. **Reveal** — the config name in tracked caps above an animated sunrise plate,
   the identity headline, a short cinematic narrative, then `CONTINUE` /
   `START OVER`. The coach speaks a personalized closing as the card resolves.
   **No specs, no pricing, no release date.**
5. **Stay updated** *(skippable)* — optional email capture (a stub — nothing is stored).
6. **Share** — the social card ("I'm becoming…") rasterised client-side by
   html2canvas.

The reveal resolves to one of five configurations: Overland Trailblazer,
Mobile Atelier, Field Workshop, Basecamp Explorer, or Momentum Commuter.

### Not in the Figma frames

- **Ask the coach** — the floating post-reveal panel. Palette-matched to the
  redesign. On mobile it collapses to a bare orb and each post-reveal screen
  reserves its footprint, so it never covers a control; its coach-mark is
  desktop-only (there is no room above a corner FAB on a phone).
- **The chat dock** — the Figma chat frame shows only bubbles and the header, but
  the voice loop it implies ("Speaking…") still needs its mic / voice-text toggle.
- **The `Desktop`/`Mobile` toggle** on the landing screen — a demo affordance for
  presenting the phone layout on a laptop, drawn as a faint ghost chip.
- The previous **light ("sand") theme** was removed: the redesign is black-only,
  so the toggle would have produced an off-design screen.

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

### Design assets

| File | Figma node | Notes |
|---|---|---|
| `public/reveal/truck-sunrise.gif` | `25:268` | The sunrise plate — 105 frames at 30ms (~3.1s). Used on the reveal and the social card. |
| `public/ui/glow-orb.svg` | `46:372` | Loading-screen radial glow, `#63A1CE` → transparent. |
| `public/ui/back-circle.svg` | `41:681` | 61px `#14141D` circle + steel arrow. |

The GIF's Netscape looping extension has been **stripped** so browsers play it
once and hold the lit final frame — left looping, the card flashes back to black
every ~3s. It is 4.2MB, so `ChatScreen` preloads it while the user is still
answering. Re-exporting from Figma means re-stripping that extension.

**Known asset gaps** (the Figma MCP call limit was reached mid-session):

- Each personality has its own plate in Figma — Personality 2 (`33:287`) is a
  blue/teal glow with a different vehicle. All five configs currently share the
  Field Workshop sunrise. Fetching the other four is a `get_design_context` call
  per frame plus a per-config lookup beside `REVEAL_ART`.
- The social card's vehicle lockup (`46:360`) and dark Ford oval (`41:327`) are
  rendered as text/placeholder rather than the exported art.

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
