/*
 * Shapes shared across the discovery flow.
 *
 * These used to live in useChat.ts alongside the hook that drove the
 * text-reaction pipeline. That hook is gone — the conversation is a live audio
 * session now (useLiveSession) — but the reveal payload it produced is
 * unchanged, and the reveal, capture and share screens still read it.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// The five vehicle configurations the coach can resolve to.
export type ConfigId =
  | 'overland_trailblazer'
  | 'mobile_atelier'
  | 'field_workshop'
  | 'basecamp_explorer'
  | 'momentum_commuter';

export interface FutureSelf {
  headline: string;
  narrative: string;
  config_id: ConfigId;
  primaryColor: string;
  accentColor: string;
}

export interface GothamRevealPayload {
  type: 'gotham_reveal';
  future_self: FutureSelf;
  caption: string;
  /*
   * Spoken on the invite screen, over the photograph of the vehicle. The one
   * place Miles is allowed to talk about the truck itself — and only from the
   * approved facts in REVEAL_PROMPT, never invented numbers.
   *
   * Optional: an older payload from a session in flight during a deploy will
   * not have it, and the screen falls back rather than going silent.
   */
  vehiclePitch?: string;
}
