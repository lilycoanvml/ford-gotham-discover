/*
 * What counts as a way to reach someone.
 *
 * The capture screen takes a phone number OR an email in one field, so the
 * check lives here rather than in either place that needs it — the screen
 * disables its button on this, and /api/subscribe rejects on this, and the two
 * must not be allowed to drift apart and start disagreeing about what is valid.
 *
 * Both checks are deliberately permissive. Real validation happens at the
 * ESP/CRM; this only guards against obvious junk, and being strict here means
 * turning away a real customer over a format quibble.
 */

/** Digits, spaces, dashes, parens, optional leading +. */
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

/* Something@something.tld. Not RFC 5322 — that regex is famously unreadable and
   still wrong, and the confirmation step is what actually proves an address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export function isPhone(raw: string): boolean {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  return PHONE_CHARS_RE.test(trimmed) && digits.length >= 10 && digits.length <= 15;
}

export type ContactKind = 'email' | 'phone';

/** Which of the two this is, or null when it is neither. */
export function contactKind(raw: string): ContactKind | null {
  if (isEmail(raw)) return 'email';
  if (isPhone(raw)) return 'phone';
  return null;
}

export const isValidContact = (raw: string): boolean => contactKind(raw) !== null;

/*
 * A logging-safe rendering. Nothing is stored in the prototype, but the route
 * still logs that a capture happened, and a raw address or number must not end
 * up in Cloud Logging.
 */
export function maskContact(raw: string): string {
  const trimmed = raw.trim();
  if (isEmail(trimmed)) {
    const [user, domain] = trimmed.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  return `***${trimmed.replace(/\D/g, '').slice(-4)}`;
}
