import { db } from '@tleehealth/db';
import { validateVaultEnvelope } from '@profullstack/tleehealth-vault';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
// Metadata is inside the ciphertext (64 KiB plus framing); AES-GCM adds a nonce and tag.
export const MAX_OBJECT_BYTES = MAX_FILE_BYTES + 64 * 1024 + 32;
export const MAX_VAULT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_LIST_LIMIT = 500;
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export class RecordVaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new RecordVaultError(status, message);
};

export function validateObjectId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    fail(400, 'vault object id must be a uuid');
  }
  return id;
}

export function validateKeyEnvelope(envelope) {
  try {
    validateVaultEnvelope(envelope);
    if (typeof envelope.keyCheck !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.keyCheck)) throw new Error('missing key proof');
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 16 * 1024) throw new Error('too large');
    return envelope;
  } catch {
    fail(400, 'invalid vault key envelope');
  }
}

export async function status(userId) {
  const [key] = await db()`select key_envelope, created_at, updated_at from record_vault_keys where user_id = ${userId}`;
  if (!key) return { configured: false, objects: 0, bytes: 0 };
  const [usage] = await db()`
    select count(*)::int as objects, coalesce(sum(size), 0)::bigint as bytes
    from record_vault_objects where user_id = ${userId}`;
  return {
    configured: true,
    envelope: key.key_envelope,
    created_at: key.created_at,
    updated_at: key.updated_at,
    objects: usage.objects,
    bytes: Number(usage.bytes),
    max_file_bytes: MAX_FILE_BYTES,
    max_object_bytes: MAX_OBJECT_BYTES,
    max_vault_bytes: MAX_VAULT_BYTES,
  };
}

/** The server stores the encrypted key envelope, never the key or passphrase. */
export async function saveKeyEnvelope(userId, envelope) {
  validateKeyEnvelope(envelope);
  const { keyCheck, ...keyEnvelope } = envelope;
  return db().begin(async (tx) => {
    const [row] = await tx`
      insert into record_vault_keys (user_id, key_envelope, key_check, format_version)
      values (${userId}, ${keyEnvelope}, ${keyCheck}, 1)
      on conflict (user_id) do update set key_envelope = excluded.key_envelope, updated_at = now()
      where record_vault_keys.key_check = excluded.key_check
      returning created_at, updated_at`;
    if (!row) fail(409, 'vault key proof failed; unlock the vault before changing its passphrase');
    return { configured: true, ...row };
  });
}

export async function listObjects(userId, { limit = 100, offset = 0 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), MAX_LIST_LIMIT);
  const skip = Math.max(Number(offset) || 0, 0);
  return db()`
    select id, format_version, size, created_at
    from record_vault_objects where user_id = ${userId}
    order by created_at desc, id desc limit ${n} offset ${skip}`;
}

/** Inserts opaque bytes and enforces per-object and per-account storage limits. */
export async function saveObject(userId, id, ciphertext) {
  validateObjectId(id);
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 28) fail(400, 'invalid encrypted vault object');
  if (ciphertext.byteLength > MAX_OBJECT_BYTES) fail(413, 'each encrypted file must be 100 MB or smaller');

  await db().begin(async (tx) => {
    const [key] = await tx`select user_id from record_vault_keys where user_id = ${userId} for update`;
    if (!key) fail(409, 'set up the encrypted vault before uploading files');
    const [usage] = await tx`select coalesce(sum(size), 0)::bigint as bytes from record_vault_objects where user_id = ${userId}`;
    if (Number(usage.bytes) + ciphertext.byteLength > MAX_VAULT_BYTES) fail(413, 'the encrypted vault is full (2 GB limit)');
    await tx`
      insert into record_vault_objects (id, user_id, format_version, ciphertext)
      values (${id}, ${userId}, 1, ${Buffer.from(ciphertext)})`;
  });
  return { id, size: ciphertext.byteLength };
}

export async function getObject(userId, id) {
  validateObjectId(id);
  const [row] = await db()`
    select id, format_version, size, ciphertext, created_at
    from record_vault_objects where user_id = ${userId} and id = ${id}`;
  if (!row) fail(404, 'no such vault object');
  return row;
}

export async function getManifest(userId) {
  const [row] = await db()`
    select revision, format_version, size, ciphertext, updated_at
    from record_vault_manifests where user_id = ${userId}`;
  return row ?? { revision: 0, format_version: 1, size: 0, ciphertext: null, updated_at: null };
}

/** Optimistic revision checks prevent two devices overwriting each other's index. */
export async function saveManifest(userId, expectedRevision, ciphertext) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(400, 'invalid vault manifest revision');
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 28) fail(400, 'invalid encrypted vault manifest');
  if (ciphertext.byteLength > MAX_MANIFEST_BYTES) fail(413, 'the encrypted vault index is too large');

  return db().begin(async (tx) => {
    const [key] = await tx`select user_id from record_vault_keys where user_id = ${userId} for update`;
    if (!key) fail(409, 'set up the encrypted vault before saving its index');
    const [row] = await tx`
      insert into record_vault_manifests (user_id, revision, format_version, ciphertext)
      values (${userId}, ${expectedRevision + 1}, 1, ${Buffer.from(ciphertext)})
      on conflict (user_id) do update set
        revision = record_vault_manifests.revision + 1,
        format_version = excluded.format_version,
        ciphertext = excluded.ciphertext,
        updated_at = now()
      where record_vault_manifests.revision = ${expectedRevision}
      returning revision`;
    if (!row) fail(409, 'the encrypted vault changed on another device; reload and try again');
    return { revision: Number(row.revision) };
  });
}

export async function deleteObject(userId, id) {
  validateObjectId(id);
  const rows = await db()`delete from record_vault_objects where user_id = ${userId} and id = ${id} returning id`;
  if (!rows.length) fail(404, 'no such vault object');
  return { ok: true };
}

export async function deleteVault(userId) {
  await db()`delete from record_vault_keys where user_id = ${userId}`;
  return { ok: true };
}
