import { NextRequest, NextResponse } from 'next/server';
import { isEmail, isPhone, maskContact } from '@/app/lib/contact';

export async function POST(req: NextRequest) {
  try {
    /*
     * The screen posts both fields and either one alone is enough, so this
     * accepts whatever arrived and rejects only when nothing usable did.
     * `contact` is still read so a client from an older deploy sitting in a
     * stale tab keeps working.
     */
    const body = (await req.json()) as {
      email?: string; phone?: string; contact?: string;
    };

    const email = (body.email ?? '').trim();
    const phone = (body.phone ?? '').trim();
    const legacy = (body.contact ?? '').trim();

    const captured: string[] = [];
    if (isEmail(email)) captured.push(`email ${maskContact(email)}`);
    if (isPhone(phone)) captured.push(`phone ${maskContact(phone)}`);
    if (!captured.length && legacy && (isEmail(legacy) || isPhone(legacy))) {
      captured.push(maskContact(legacy));
    }

    if (!captured.length) {
      return NextResponse.json(
        { ok: false, error: 'Enter a valid email or phone number' },
        { status: 400 },
      );
    }

    // TODO: wire to real ESP/CRM (e.g. Salesforce Marketing Cloud / a Ford-approved
    // service). Do NOT persist PII beyond the request lifecycle until that exists.
    // For the prototype we only acknowledge — nothing is stored, and the log line
    // is masked so a real number or address never reaches Cloud Logging.
    console.log('[subscribe] interest captured (not stored):', captured.join(', '));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('subscribe error:', err);
    return NextResponse.json({ ok: false, error: 'Something went wrong' }, { status: 500 });
  }
}
