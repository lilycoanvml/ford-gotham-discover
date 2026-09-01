import { NextRequest, NextResponse } from 'next/server';
import { contactKind, maskContact } from '@/app/lib/contact';

export async function POST(req: NextRequest) {
  try {
    // `phone` is still read so an older client in a stale tab keeps working.
    const body = (await req.json()) as { contact?: string; phone?: string };
    const raw = (body.contact ?? body.phone ?? '').trim();

    const kind = contactKind(raw);
    if (!kind) {
      return NextResponse.json(
        { ok: false, error: 'Invalid phone number or email' },
        { status: 400 },
      );
    }

    // TODO: wire to real ESP/CRM (e.g. Salesforce Marketing Cloud / a Ford-approved
    // service). Do NOT persist PII beyond the request lifecycle until that exists.
    // For the prototype we only acknowledge — nothing is stored, and the log line
    // is masked so a real number or address never reaches Cloud Logging.
    console.log('[subscribe] interest captured (not stored):', kind, maskContact(raw));

    return NextResponse.json({ ok: true, kind });
  } catch (err) {
    console.error('subscribe error:', err);
    return NextResponse.json({ ok: false, error: 'Something went wrong' }, { status: 500 });
  }
}
