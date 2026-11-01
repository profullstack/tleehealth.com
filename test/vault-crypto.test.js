import { describe, expect, test } from 'bun:test';
import {
  createVault,
  decryptObject,
  encryptObject,
  lockVault,
  packFile,
  rewrapVaultKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unpackFile,
  validateVaultEnvelope,
} from '../packages/cli/src/vault-crypto.js';

const userId = '24c6dd3b-39dc-43e6-b531-a1632aa53bc1';
const objectId = 'd275a073-30ca-4b04-8b99-0bc705736b3a';

describe('personal record vault cryptography', () => {
  test('wraps a random vault key, encrypts file bytes and unlocks from passphrase or recovery key', async () => {
    const { envelope, recoveryKey, handle } = await createVault(userId, 'a-long-test-passphrase');
    expect(validateVaultEnvelope(envelope)).toEqual(envelope);
    expect(recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const packed = packFile(
      { name: 'visit.pdf', type: 'application/pdf', size: 4, category: 'summaries' },
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    const sealed = await encryptObject(handle, userId, objectId, packed);
    expect(sealed.byteLength).toBe(packed.byteLength + 28);

    const unlocked = await unlockWithPassphrase(userId, 'a-long-test-passphrase', envelope);
    const plain = await decryptObject(unlocked, userId, objectId, sealed);
    const unpacked = unpackFile(plain);
    expect(unpacked.metadata).toMatchObject({ name: 'visit.pdf', type: 'application/pdf', category: 'summaries' });
    expect([...unpacked.bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);

    const recovered = await unlockWithRecoveryKey(userId, recoveryKey, envelope);
    expect([...await decryptObject(recovered, userId, objectId, sealed)]).toEqual([...packed]);

    const changed = await rewrapVaultKey(userId, recovered, 'a-different-test-passphrase');
    const unlockedAgain = await unlockWithPassphrase(userId, 'a-different-test-passphrase', changed.envelope);
    expect([...await decryptObject(unlockedAgain, userId, objectId, sealed)]).toEqual([...packed]);

    await expect(unlockWithPassphrase(userId, 'an incorrect test passphrase', envelope)).rejects.toThrow('could not unlock');
    await expect(decryptObject(unlocked, '11111111-1111-4111-8111-111111111111', objectId, sealed)).rejects.toThrow();

    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptObject(unlocked, userId, objectId, tampered)).rejects.toThrow('could not be decrypted');

    lockVault(handle);
    await expect(encryptObject(handle, userId, objectId, packed)).rejects.toThrow('Vault is locked');
    lockVault(unlocked);
    lockVault(recovered);
    lockVault(unlockedAgain);
  });

  test('rejects weak passphrases and malformed key envelopes', async () => {
    await expect(createVault(userId, 'too short')).rejects.toThrow('at least 16 characters');
    expect(() => validateVaultEnvelope({ version: 1, cipher: 'AES-ECB' })).toThrow('invalid vault key envelope');
  });
});
