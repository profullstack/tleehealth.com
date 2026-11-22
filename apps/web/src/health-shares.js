import { db } from '@tleehealth/db';
import { validateVaultEnvelope } from '@profullstack/tleehealth/vault';

/**
 * Shared health tracker readings. The browser encrypts a snapshot under a
 * one-time share passkey and uploads only ciphertext. This module stores and
 * returns those opaque bytes; it has no way to decrypt them.
 */
export const MAX_SHARE_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_SHARES = 25;
export const EXPIRY_DAYS = [1, 7, 30, 90];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export class HealthShareError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HealthShareError(status, message);
};

function bytesFrom(value, what, min, max) {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length > Math.ceil(max * 4 / 3) + 4) fail(400, `invalid ${what}`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength < min) fail(400, `invalid ${what}`);
  if (bytes.byteLength > max) fail(413, `${what} is too large`);
  return bytes;
}

function checkEnvelope(envelope) {
  try {
    validateVaultEnvelope(envelope);
    if (typeof envelope.keyCheck !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.keyCheck)) throw new Error('missing key proof');
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 16 * 1024) throw new Error('too large');
    return envelope;
  } catch {
    fail(400, 'invalid share key envelope');
  }
}

const shareId = (id) => {
  if (!UUID.test(String(id ?? ''))) fail(404, 'no such share');
  return String(id).toLowerCase();
};

const purgeExpired = () => db()`delete from health_shares where expires_at <= now()`;

const summary = (row) => ({
  id: row.id,
  created_at: row.created_at,
  expires_at: row.expires_at,
  views: row.views,
  last_viewed_at: row.last_viewed_at,
  size: row.size,
  label: row.label_sealed ? Buffer.from(row.label_sealed).toString('base64url') : null,
});

export async function createShare(userId, input) {
  const id = shareId(input?.id);
  const days = Number(input?.expires_days);
  if (!EXPIRY_DAYS.includes(days)) fail(400, `expires_days must be one of ${EXPIRY_DAYS.join(', ')}`);
  const envelope = checkEnvelope(input?.envelope);
  const ciphertext = bytesFrom(input?.ciphertext, 'share ciphertext', 28, MAX_SHARE_BYTES);
  const label = input?.label == null ? null : bytesFrom(input.label, 'share label', 28, 1024);
  await purgeExpired();
  const [{ n }] = await db()`select count(*)::int as n from health_shares where user_id = ${userId}`;
  if (n >= MAX_ACTIVE_SHARES) fail(409, `you have ${MAX_ACTIVE_SHARES} active shares; revoke one first`);
  const [row] = await db()`
    insert into health_shares (id, user_id, key_envelope, ciphertext, label_sealed, expires_at)
    values (${id}, ${userId}, ${db().json(envelope)}, ${ciphertext}, ${label}, now() + make_interval(days => ${days}))
    returning id, created_at, expires_at, views, last_viewed_at, size, label_sealed`;
  return summary(row);
}

export async function listShares(userId) {
  const rows = await db()`
    select id, created_at, expires_at, views, last_viewed_at, size, label_sealed
    from health_shares where user_id = ${userId} and expires_at > now()
    order by created_at desc`;
  return rows.map(summary);
}

/** Revoking deletes the ciphertext: a revoked link has nothing left to open. */
export async function revokeShare(userId, id) {
  const rows = await db()`delete from health_shares where id = ${shareId(id)} and user_id = ${userId} returning id`;
  if (!rows.length) fail(404, 'no such share');
}

/** What a link holder gets: opaque bytes that only the passkey can open. */
export async function fetchShare(id) {
  const [row] = await db()`
    update health_shares set views = views + 1, last_viewed_at = now()
    where id = ${shareId(id)} and expires_at > now()
    returning id, key_envelope, ciphertext, created_at, expires_at`;
  if (!row) fail(404, 'This share link has expired or was revoked.');
  return {
    id: row.id,
    format: 'tleehealth-shared-readings',
    version: 1,
    envelope: row.key_envelope,
    ciphertext: Buffer.from(row.ciphertext).toString('base64url'),
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/* A small fixed-window limiter for the two public endpoints. In-memory is
   enough: one web process serves the site, and a restart only resets counts. */
const windows = new Map();
export function rateLimit(key, max, windowMs, now = Date.now()) {
  const hit = windows.get(key);
  if (!hit || now - hit.start >= windowMs) {
    if (windows.size > 20_000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  hit.count += 1;
  return hit.count <= max;
}

export const clientAddress = (c) =>
  c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
