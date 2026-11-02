const ENVELOPE_VERSION = 1;
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const handles = new WeakMap();

function webcrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto is unavailable; use a current browser or Node.js 20+');
  }
  return globalThis.crypto;
}

function randomBytes(length) {
  return webcrypto().getRandomValues(new Uint8Array(length));
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid vault envelope');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function join(...parts) {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('invalid account id');
  }
}

function assertPassphrase(passphrase, minLength = 16) {
  if (typeof passphrase !== 'string' || passphrase.normalize('NFC').length < minLength) {
    throw new Error(`Use a passphrase with at least ${minLength} characters.`);
  }
  if (passphrase.length > 1024) throw new Error('Passphrase is too long.');
}

function aadForKey(userId, method) {
  assertUserId(userId);
  return encoder.encode(`tleehealth:record-vault:key:v${ENVELOPE_VERSION}:${userId}:${method}`);
}

function aadForObject(userId, objectId) {
  assertUserId(userId);
  if (typeof objectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(objectId)) throw new Error('invalid vault object id');
  return encoder.encode(`tleehealth:record-vault:object:v${FORMAT_VERSION}:${userId}:${objectId}`);
}

async function derivePassphraseKey(passphrase, salt, minLength = 16) {
  assertPassphrase(passphrase, minLength);
  const crypto = webcrypto();
  const passphraseBytes = encoder.encode(passphrase.normalize('NFC'));
  try {
    const material = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

async function importAesKey(bytes) {
  return webcrypto().subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function makeKeyCheck(rawKey, userId) {
  const key = await webcrypto().subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const proof = new Uint8Array(await webcrypto().subtle.sign(
    'HMAC', key, encoder.encode(`tleehealth:record-vault:key-check:v${ENVELOPE_VERSION}:${userId}`),
  ));
  return toBase64Url(proof);
}

async function wrap(rawKey, wrappingKey, additionalData) {
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await webcrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, wrappingKey, rawKey,
  ));
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

async function unwrap(part, wrappingKey, additionalData) {
  const nonce = fromBase64Url(part.nonce);
  const ciphertext = fromBase64Url(part.ciphertext);
  if (nonce.byteLength !== 12 || ciphertext.byteLength !== 48) throw new Error('invalid vault envelope');
  return new Uint8Array(await webcrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 }, wrappingKey, ciphertext,
  ));
}

function makeHandle(rawKey) {
  const handle = Object.freeze({});
  handles.set(handle, { rawKey, key: null });
  return handle;
}

async function keyFor(handle) {
  const state = handles.get(handle);
  if (!state) throw new Error('Vault is locked. Unlock it to continue.');
  state.key ??= await importAesKey(state.rawKey);
  return state.key;
}

export function lockVault(handle) {
  const state = handles.get(handle);
  if (!state) return;
  state.rawKey.fill(0);
  handles.delete(handle);
}

export async function createVault(userId, passphrase, { minLength = 16 } = {}) {
  assertUserId(userId);
  assertPassphrase(passphrase, minLength);
  const rawKey = randomBytes(32);
  const salt = randomBytes(16);
  const recoveryBytes = randomBytes(32);
  try {
    const keyCheck = await makeKeyCheck(rawKey, userId);
    const [passphraseWrap, recoveryWrap] = await Promise.all([
      wrap(rawKey, await derivePassphraseKey(passphrase, salt, minLength), aadForKey(userId, 'passphrase')),
      wrap(rawKey, await importAesKey(recoveryBytes), aadForKey(userId, 'recovery')),
    ]);
    return {
      handle: makeHandle(rawKey.slice()),
      recoveryKey: toBase64Url(recoveryBytes),
      envelope: {
        format: 'tleehealth-record-vault-key',
        version: ENVELOPE_VERSION,
        cipher: 'AES-256-GCM',
        keyCheck,
        passphrase: {
          kdf: 'PBKDF2-SHA256',
          iterations: PBKDF2_ITERATIONS,
          salt: toBase64Url(salt),
          ...passphraseWrap,
        },
        recovery: {
          kdf: 'random-256',
          ...recoveryWrap,
        },
      },
    };
  } finally {
    rawKey.fill(0);
    recoveryBytes.fill(0);
  }
}

export function validateVaultEnvelope(envelope) {
  if (
    !envelope || envelope.format !== 'tleehealth-record-vault-key' || envelope.version !== ENVELOPE_VERSION
    || envelope.cipher !== 'AES-256-GCM' || envelope.passphrase?.kdf !== 'PBKDF2-SHA256'
    || envelope.passphrase?.iterations !== PBKDF2_ITERATIONS || envelope.recovery?.kdf !== 'random-256'
  ) throw new Error('unsupported or invalid vault key envelope');
  const salt = fromBase64Url(envelope.passphrase.salt);
  if (salt.byteLength !== 16) throw new Error('invalid vault key envelope');
  return envelope;
}

export async function unlockWithPassphrase(userId, passphrase, untrustedEnvelope, { minLength = 16 } = {}) {
  const envelope = validateVaultEnvelope(untrustedEnvelope);
  let rawKey;
  try {
    rawKey = await unwrap(
      envelope.passphrase,
      await derivePassphraseKey(passphrase, fromBase64Url(envelope.passphrase.salt), minLength),
      aadForKey(userId, 'passphrase'),
    );
    return makeHandle(rawKey);
  } catch {
    rawKey?.fill(0);
    throw new Error('That passphrase could not unlock this vault.');
  }
}

export async function unlockWithRecoveryKey(userId, recoveryKey, untrustedEnvelope) {
  const envelope = validateVaultEnvelope(untrustedEnvelope);
  let recoveryBytes;
  let rawKey;
  try {
    recoveryBytes = fromBase64Url(String(recoveryKey).trim());
    if (recoveryBytes.byteLength !== 32) throw new Error('invalid recovery key');
    rawKey = await unwrap(envelope.recovery, await importAesKey(recoveryBytes), aadForKey(userId, 'recovery'));
    return makeHandle(rawKey);
  } catch {
    rawKey?.fill(0);
    throw new Error('That recovery key could not unlock this vault.');
  } finally {
    recoveryBytes?.fill(0);
  }
}

export async function rewrapVaultKey(userId, handle, passphrase) {
  assertUserId(userId);
  assertPassphrase(passphrase);
  const state = handles.get(handle);
  if (!state) throw new Error('Vault is locked. Unlock it to continue.');
  const salt = randomBytes(16);
  const recoveryBytes = randomBytes(32);
  try {
    const keyCheck = await makeKeyCheck(state.rawKey, userId);
    const [passphraseWrap, recoveryWrap] = await Promise.all([
      wrap(state.rawKey, await derivePassphraseKey(passphrase, salt), aadForKey(userId, 'passphrase')),
      wrap(state.rawKey, await importAesKey(recoveryBytes), aadForKey(userId, 'recovery')),
    ]);
    return {
      recoveryKey: toBase64Url(recoveryBytes),
      envelope: {
        format: 'tleehealth-record-vault-key',
        version: ENVELOPE_VERSION,
        cipher: 'AES-256-GCM',
        keyCheck,
        passphrase: { kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toBase64Url(salt), ...passphraseWrap },
        recovery: { kdf: 'random-256', ...recoveryWrap },
      },
    };
  } finally {
    recoveryBytes.fill(0);
  }
}

export async function encryptObject(handle, userId, objectId, clearBytes) {
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(await webcrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadForObject(userId, objectId), tagLength: 128 },
    await keyFor(handle),
    clearBytes,
  ));
  return join(nonce, ciphertext);
}

export async function decryptObject(handle, userId, objectId, sealedBytes) {
  const bytes = sealedBytes instanceof Uint8Array ? sealedBytes : new Uint8Array(sealedBytes);
  if (bytes.byteLength < 28) throw new Error('invalid encrypted vault object');
  try {
    return new Uint8Array(await webcrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: aadForObject(userId, objectId), tagLength: 128 },
      await keyFor(handle),
      bytes.subarray(12),
    ));
  } catch {
    throw new Error('This vault item could not be decrypted. It may be corrupted or belong to another account.');
  }
}

export function packFile(metadata, fileBytes) {
  const json = encoder.encode(JSON.stringify({ ...metadata, version: FORMAT_VERSION }));
  if (json.byteLength > 64 * 1024) throw new Error('vault file metadata is too large');
  const content = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  const out = new Uint8Array(4 + json.byteLength + content.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, false);
  out.set(json, 4);
  out.set(content, 4 + json.byteLength);
  return out;
}

export function unpackFile(clearBytes) {
  const bytes = clearBytes instanceof Uint8Array ? clearBytes : new Uint8Array(clearBytes);
  if (bytes.byteLength < 4) throw new Error('invalid vault file');
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (metadataLength === 0 || metadataLength > 64 * 1024 || 4 + metadataLength > bytes.byteLength) {
    throw new Error('invalid vault file metadata');
  }
  const metadata = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metadataLength)));
  if (metadata.version !== FORMAT_VERSION || typeof metadata.name !== 'string') throw new Error('unsupported vault file');
  return { metadata, bytes: bytes.slice(4 + metadataLength) };
}

export const vaultFormat = Object.freeze({
  envelopeVersion: ENVELOPE_VERSION,
  objectVersion: FORMAT_VERSION,
  kdf: 'PBKDF2-SHA256',
  iterations: PBKDF2_ITERATIONS,
  cipher: 'AES-256-GCM',
});
