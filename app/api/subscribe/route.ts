import { NextRequest, NextResponse } from 'next/server';

// Lightweight email-shape check. Intentionally permissive — real validation
// happens at the ESP/CRM. We only guard against obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const { email } = (await req.json()) as { email?: string };

    if (!email || !EMAIL_RE.test(email.trim())) {
      return NextResponse.json({ ok: false, error: 'Invalid email' }, { status: 400 });
    }

    // TODO: wire to real ESP/CRM (e.g. Salesforce Marketing Cloud / a Ford-approved
    // service). Do NOT persist PII beyond the request lifecycle until that exists.
    // For the prototype we only acknowledge — nothing is stored.
    console.log('[subscribe] interest captured (not stored):', email.trim().replace(/(^.).*(@.*$)/, '$1***$2'));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('subscribe error:', err);
    return NextResponse.json({ ok: false, error: 'Something went wrong' }, { status: 500 });
  }
}
