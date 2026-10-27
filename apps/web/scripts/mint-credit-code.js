#!/usr/bin/env bun
// Mint a tleehealth credit code (staff only; there is no minting API).
//
//   docker exec <container> bun apps/web/scripts/mint-credit-code.js --days 30 [--max 1] [--expires-days 90] [--label "for Dr Lin"]
//   ... --list            every code (hashes only; codes are never stored)
//   ... --revoke crd_...  revoke one
//
// The code is printed once. It grants pro_days, applied to a practice's paid period.
import { close } from '@tleehealth/db';
import { getCredits, UNIT } from '../src/credits.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const c = getCredits();
try {
  if (args.includes('--list')) {
    for (const k of await c.list())
      console.log(`${k.id}\t${k.grant.amount} ${k.grant.unit}\t${k.redemptions}/${k.maxRedemptions}\t${k.revokedAt ? 'revoked' : 'live'}\t${k.label}`);
  } else if (opt('revoke')) {
    await c.revoke(opt('revoke'));
    console.log('revoked');
  } else {
    const days = Number(opt('days'));
    if (!Number.isInteger(days) || days < 1) throw new Error('--days N is required');
    const expires = Number(opt('expires-days') ?? 0);
    const m = await c.mint({
      grant: { unit: UNIT, amount: days },
      maxRedemptions: Number(opt('max') ?? 1),
      expiresAt: expires ? Date.now() + expires * 86400_000 : null,
      label: opt('label') ?? '',
      createdBy: 'staff-script',
    });
    console.log(JSON.stringify({ code: m.code, id: m.id, days, max: m.maxRedemptions, expires_at: m.expiresAt }));
  }
} finally {
  await close();
}
