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
| Ford Oval | `public/brand/ford-oval.svg`, recomposed from the Figma component (node `41:320`) | Validate against RSF; `ford-oval-PLACEHOLDER.svg` is no longer used |
| Ford wordmark | `ford-brand.ts` (`wordmarkText: 'FORD'`) | Replace with the licensed wordmark asset |
| Vehicle wordmark **"FATHOM"** | `public/brand/fathom-wordmark.svg`, exported from the Figma social card (node `46:360`) | Confirm the public-facing name is cleared for external use |
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
| `share` card art | Social Card warm / cool | `41:334` / `41:333` |
| `capture` | Sign Up | `41:398` |
| `share` | Social Card 1 | `41:335` |

**Mobile-first, one layout.** The Figma frames are 1440x1024. Rather than a
separate phone breakpoint, every dimension is the desktop reference wrapped in a
`clamp()`, so the same ratios hold from 320px up to 1440px. Two consequences
worth knowing:

- The landing chip row (`who / will you / be?`) is sized in `em` off its own
  type scale, so all three stay on one line at any width instead of wrapping.
- **`#era-app` is a query container and all screen sizing is in `cqw`, not `vw`.**
  This matters: in mobile-frame demo mode the app is a 390px box inside a wide
  window, and `vw` sized type off the *window* — the landing chips rendered at
  their full 90px desktop size and blew straight out of the frame.
- The social card sizes its contents in `cqw` against a container query on the
  card itself. `.share-card-inner` exists because an element cannot use its own
  container units for its own layout — without the split, percentage padding
  resolves against the surrounding flex row (~1400px on desktop), not the 383px
  card. For the same reason the card's own `border-radius` is a fixed `36px`:
  `cqw` there silently falls back to the small-viewport size.
- The landing headline and chips share one `--gd-hero-size`. Both are 90px in
  Figma and read as one sentence, so the scale is derived from the **chip row**
  (the binding constraint at ~9.1em wide), leaving ~20% of the column as margin.

**Where the two reveal frames disagree:** Personality 1 overlaps its title box
into the plate by -32px; Personality 2 leaves a 20px gap. The gap is
authoritative here — the overlap only works for a single-line title, and most
config names wrap to two lines at 45px with 0.30em tracking.

### Personality themes

Figma ships two dressings of the reveal + social card, and they are a matched
pair. Each config picks whichever reads truer to the life the user described,
and the reveal and share card always agree:

| Theme | Look | Configs |
|---|---|---|
| `warm` | orange sunrise, truck carrying a board | Field Workshop, Mobile Atelier, Momentum Commuter |
| `cool` | blue-green dawn, wagon carrying bikes | Overland Trailblazer, Basecamp Explorer |

The mapping is `CONFIG_THEME` in `app/page.tsx`; the card gradient is selected by
`[data-theme]` in CSS. The card's background gradient *is* the artwork — the
plate PNG on top is transparent above and below the vehicle so the gradient
reads through it as sky and glow, which is why the plate must be placed at its
natural aspect and never cover-cropped.

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
3. **Discovery** — the coach asks your **name + three questions**. This is a true
   audio-to-audio conversation: Miles hears the microphone directly and answers
   in his own voice, with no speech-to-text in front of him and no text
   synthesis behind him. A typed fallback stays available.
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
- The conversation is **audio to audio** over the Gemini Live API and needs only
  `GEMINI_API_KEY`. Google Cloud Text-to-Speech credentials
  (`GOOGLE_APPLICATION_CREDENTIALS`) are an optional lower tier; with neither, the
  app falls back to the browser's Web Speech voice automatically.
- A **microphone** and a browser with `AudioWorklet` (all current browsers). Serve
  over `localhost` or HTTPS — `getUserMedia` is blocked on plain HTTP origins.
- `npm run dev` starts `gateway.js`, which runs Next behind it. Running
  `next dev` directly (`npm run dev:next`) gives you the app **without**
  `/api/live`, so the conversation falls back to the typed REST path.

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
| `GEMINI_LIVE_MODEL` | No | Audio-to-audio conversation model (default: `gemini-3.1-flash-live-preview`) |
| `GEMINI_TTS_MODEL` | No | Reader for the fixed lines (default: `gemini-3.1-flash-live-preview`) |
| `GEMINI_REACTION_MODEL` | No | Fallback reaction model (default: `gemini-3.5-flash-lite`) |
| `GEMINI_TTS_VOICE` | No | Prebuilt voice name (default: `Charon`, deeper male) |
| `INTERNAL_PORT` | No | Port the Next child listens on behind the gateway (default: `PORT+1`) |
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
- **`gateway.js`** — owns the public port. Cloud Run gives one, and the app needs
  two servers on it: Next for pages and API routes, and a WebSocket at
  `/api/live` that the App Router cannot serve. Runs Next as a child on
  `INTERNAL_PORT` and forwards everything except the live socket.
- **`live/relay.js`** — one browser WebSocket ⇄ one Gemini Live session. Holds the
  API key, pipes mic PCM up and Charon audio down. See "Audio to audio" below.
- **`app/frontend/hooks/useLiveSession.ts`** — the conversation: mic capture, turn
  state, question injection, and the hand-off to the reveal.
- **`app/frontend/lib/audio.ts`** — one AudioContext and one analyser for the whole
  app, so the orb sees every playback path.
- **`app/api/chat/route.ts`** — now only the **reveal** (`gemini-3.6-flash`), fed by
  the live session's transcript. Its `stage:'reaction'` path survives as the
  last-resort fallback when the relay is unreachable.
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

### Audio to audio

The discovery conversation is one continuous Gemini Live session. The browser
streams 16kHz mono PCM up; Charon's 24kHz audio comes back down and plays through
the same analyser the orb reads. Miles hears tone, pacing and hesitation — the
things a transcript throws away.

**The questions are still fixed.** They are brand copy, so they play from
pre-synthesised audio and are then recorded into the session as already asked.
Miles improvises only the one-sentence reaction between them.

Three things about the Live API cost real time to find. All were verified
against the live endpoint, and the app depends on each:

1. **This model's server-side VAD never fires.** Streaming real speech at healthy
   levels (75% peak) produced no transcript, no response, and no error — the
   audio was simply consumed. The identical audio bracketed by manual
   `activityStart` / `activityEnd` came back correctly transcribed. So
   `automaticActivityDetection` is **disabled**, and the VAD lives in
   `public/worklets/pcm-recorder.js`, which sends the turn boundaries.

2. **Recording a question as a model turn corrupts the next reply.** The obvious
   shape — `role:'model'` with `turnComplete:false` — leaves one of Miles' own
   turns open, and he finishes it. The next reaction comes back with an invented
   question spliced into the middle of it:
   `"Pancakes after a long hike sounds like aWhat's one thing you'd love to learn? perfect morning"`.
   Setting `turnComplete:true` instead makes him read the injection out loud.
   Framing it as a note on the **user** side leaves no model turn dangling.
   Measured over repeated runs of the real sequence: model-role 0/3 clean,
   user-note 3/3 clean.

3. **Ephemeral tokens do not work with this API key.** `POST /v1alpha/auth_tokens`
   (snake_case — the camelCase path 404s) returns 200 and a real token, but the
   Live socket rejects it in every presentation: `access_token=` closes 1008
   *"unregistered callers"*, `key=` closes 1007 *"API key not valid"*. That is
   why there is a relay holding the key instead of the browser dialing Google
   directly. If a key that mints working tokens turns up, `live/relay.js` and
   `connect()` in `useLiveSession.ts` are the only two places that change.

**Fallbacks**, in order: live session → typed input on the same live session (no
mic) → `/api/chat` reaction + cached question audio (no relay) → Cloud TTS Chirp 3
HD → the browser's Web Speech voice.

### Design assets

| File | Figma node | Notes |
|---|---|---|
| `public/reveal/truck-sunrise.gif` | `25:268` | Warm reveal plate — 105 frames at 30ms (~3.1s), 1200x1200 so it needs the Figma crop. |
| `public/reveal/reveal-cool.gif` | `33:287` | Cool reveal plate — 105 frames, exported at 1196x764, i.e. the 604/388 box's own aspect, so no crop. |
| `public/reveal/card-warm.png` | `37:302` | Warm card plate — **transparent** PNG over the card gradient. |
| `public/reveal/plate-cool.png` | `37:305` | Cool card plate — transparent; mirrored on the card per Figma's transform. |
| `public/brand/ford-oval.svg` | `41:320` | Ford oval, dark variant. Recomposed from the Figma component's 4 layers (body + ring + 2 script glyphs). |
| `public/brand/fathom-wordmark.svg` | `46:360` | Vehicle lockup, 196x8. |
| `public/ui/glow-orb.svg` | `46:372` | Loading-screen radial glow, `#63A1CE` → transparent. |
| `public/ui/back-circle.svg` | `41:681` | 61px `#14141D` circle + steel arrow. |

Both reveal GIFs have their Netscape looping extension **stripped** so browsers
play them once and hold the lit final frame — left looping, the card flashes back
to black every ~3s. They are ~4.2MB each, so `ChatScreen` preloads both while the
user is still answering (the theme isn't known until the reveal lands).
Re-exporting from Figma means re-stripping that extension.

The Ford oval and FATHOM lockup now come from the Ford design-system components in
the project's own Figma file rather than from stand-in art. Still confirm both
against the official RSF before any external use.

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
