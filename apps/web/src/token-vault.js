import { createSealer, parseTtl, randomBytes, wipe, UnlockStore } from '@profullstack/sealed-secrets';

export { UnlockStore };

/**
 * Unlock-on-use for patient-portal tokens (fleet rule, 2026-10-28: nothing
 * stored on our servers may open a user's credentials).
 *
 * Connecting to a portal IS the unlock: the access + refresh tokens are sealed
 * (AES-256-GCM, AAD = user id + connection id) under a random data key that
 * lives only in this process, in an UnlockStore session with a TTL the patient
 * picks (default 8 h, max 7 d). The database holds the ciphertext only. A
 * restart, the TTL, or Lock drops the key: that connection's import pauses
 * with status "locked" until the patient reconnects. No server key, no env
 * fallback.
 */

export const DEFAULT_UNLOCK_TTL_SECONDS = 8 * 3600;

const sealer = createSealer({ app: 'tleehealth', scope: 'health_connection' });
export const sessions = new UnlockStore();

/** Tests swap the clock / store. */
let store = sessions;
export function _useSessions(s) {
  store = s ?? sessions;
}

export const ttlSeconds = (v) => (v == null || v === '' ? DEFAULT_UNLOCK_TTL_SECONDS : typeof v === 'number' ? v : parseTtl(String(v)));

/** New tokens from the portal: a fresh data key, kept in memory for `ttl`. Returns the sealed blob to store. */
export async function unlockWith(connId, userId, tokens, ttl = DEFAULT_UNLOCK_TTL_SECONDS) {
  const dek = randomBytes(32);
  try {
    const blob = await sealer.sealJson(dek, tokens, userId, connId);
    const status = store.unlock(connId, dek, ttl);
    return { blob, status };
  } finally {
    wipe(dek);
  }
}

/** Re-seal rotated tokens under the connection's current in-memory key; null when locked. */
export async function reseal(connId, userId, tokens) {
  const dek = store.get(connId);
  if (!dek) return null;
  return sealer.sealJson(dek, tokens, userId, connId);
}

/** The tokens, or null when this connection is locked. Drop the result after use. */
export async function open(connId, userId, blob) {
  const dek = store.get(connId);
  if (!dek || !blob) return null;
  return sealer.unsealJson(dek, typeof blob === 'string' ? JSON.parse(blob) : blob, userId, connId);
}

export const status = (connId) => store.status(connId);
export const isUnlocked = (connId) => store.status(connId).unlocked;
export const lock = (connId) => store.lock(connId);
