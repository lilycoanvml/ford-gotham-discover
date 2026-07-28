// FORD BRAND TOKENS — PLACEHOLDERS. Confirm every value against the official
// Ford RSF / Brand Design System before any external use. Do not treat as final.
//
// This is the single source of truth for brand values in the app. Do NOT scatter
// brand colors, fonts, or asset paths through components — import from here.
// The same values are mirrored as CSS custom properties in app/globals.css and as
// Tailwind tokens in tailwind.config.ts; keep the three in sync when you swap them.

export const fordBrand = {
  colorFordBlue:       '#00095B', // placeholder — primary brand blue
  colorFordBrightBlue: '#066FEF', // placeholder — bright/action accent blue
  colorInk:            '#0A0A0F', // spotlight-dark background (safe to keep)
  colorSignal:         '#F2B705', // placeholder — warm signal, use sparingly

  // Antenna is Ford's licensed typeface — NOT bundled here. Load the licensed
  // webfont and update these once available. Fallbacks approximate the feel only.
  fontDisplay: '"Ford Antenna", "Archivo", "Arial Narrow", system-ui, sans-serif', // placeholder
  fontBody:    '"Ford Antenna", "Archivo", system-ui, sans-serif',                 // placeholder
  fontMono:    '"Space Mono", ui-monospace, monospace',                            // technical labels only

  // Brand marks — swap for licensed assets. Files under /public/brand carry a
  // -PLACEHOLDER suffix so they are obviously not production art.
  logoOvalSrc:  '/brand/ford-oval-PLACEHOLDER.svg', // replace with licensed asset
  wordmarkText: 'FORD',                             // placeholder — replace with licensed wordmark asset

  toneNotes:
    'Confident, human, optimistic, plain-spoken. Bold reserved for the brand/name only, per Ford brand guidance.',
} as const;

// The five vehicle configurations. The silhouette + copy resolve to one of these.
// Colors default to the Ford palette; the model may override per reveal.
export const CONFIG_LABELS: Record<string, string> = {
  overland_trailblazer: 'Overland Trailblazer',
  mobile_atelier:       'Mobile Atelier',
  field_workshop:       'Field Workshop',
  basecamp_explorer:    'Basecamp Explorer',
  momentum_commuter:    'Momentum Commuter',
};

export type FordBrand = typeof fordBrand;
