import { NextRequest, NextResponse } from 'next/server';

// Lightweight phone-shape check. Intentionally permissive — real validation
// happens at the ESP/CRM. We only guard against obvious junk.
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

function validPhone(raw: string) {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  return PHONE_CHARS_RE.test(trimmed) && digits.length >= 10 && digits.length <= 15;
}

export async function POST(req: NextRequest) {
  try {
    const { phone } = (await req.json()) as { phone?: string };

    if (!phone || !validPhone(phone)) {
      return NextResponse.json({ ok: false, error: 'Invalid phone number' }, { status: 400 });
    }

    // TODO: wire to real ESP/CRM (e.g. Salesforce Marketing Cloud / a Ford-approved
    // service). Do NOT persist PII beyond the request lifecycle until that exists.
    // For the prototype we only acknowledge — nothing is stored.
    const digits = phone.trim().replace(/\D/g, '');
    console.log('[subscribe] interest captured (not stored):', `***${digits.slice(-4)}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('subscribe error:', err);
    return NextResponse.json({ ok: false, error: 'Something went wrong' }, { status: 500 });
  }
}
