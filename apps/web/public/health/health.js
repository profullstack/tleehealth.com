import * as vaultCrypto from '/assets/vault-crypto.js';

const sessionResponse = await fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
if (!sessionResponse?.ok) {
  location.replace('/signin?next=%2Fhealth%2F');
  throw new Error('Sign in required to use the health tracker.');
}

const DB_NAME = 'tleehealth-health-tracker';
const DB_VERSION = 2;
const RECORDS = 'readings';
const VAULT = 'vault';
const BACKUP_FORMAT = 'tleehealth-health-tracker-encrypted';
const IDLE_MS = 15 * 60_000;
const LABELS = {
  'blood-pressure': { name: 'Blood pressure', unit: 'mmHg', placeholder: '120/80' },
  weight: { name: 'Weight', unit: 'kg', placeholder: '70.5' },
  glucose: { name: 'Blood glucose', unit: 'mg/dL', placeholder: '100' },
  'heart-rate': { name: 'Heart rate', unit: 'bpm', placeholder: '72' },
  temperature: { name: 'Temperature', unit: '°C', placeholder: '36.8' },
  oxygen: { name: 'Oxygen saturation', unit: '%', placeholder: '98' },
};

const vaultCard = document.getElementById('vault-card');
const vaultScreen = document.getElementById('vault-screen');
const tracker = document.getElementById('tracker');
const form = document.getElementById('entry-form');
const kind = document.getElementById('kind');
const value = document.getElementById('value');
const takenAt = document.getElementById('taken-at');
const rows = document.getElementById('rows');
const empty = document.getElementById('empty');
const table = document.getElementById('table');
const status = document.getElementById('form-status');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
let vaultHandle = null;
let vaultUserId = null;
let lockTimer = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(VAULT)) db.createObjectStore(VAULT, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Browser storage is unavailable.'));
  });
}

async function transact(storeName, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = operation(tx.objectStore(storeName));
    tx.oncomplete = () => { db.close(); resolve(result?.result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('Browser storage failed.')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Browser storage failed.')); };
  });
}

const getAllSealed = () => transact(RECORDS, 'readonly', (store) => store.getAll());
const putSealed = (record) => transact(RECORDS, 'readwrite', (store) => store.put(record));
const removeSealed = (id) => transact(RECORDS, 'readwrite', (store) => store.delete(id));
const clearSealed = () => transact(RECORDS, 'readwrite', (store) => store.clear());
const getVault = () => transact(VAULT, 'readonly', (store) => store.get('config'));
const putVault = (config) => transact(VAULT, 'readwrite', (store) => store.put({ ...config, id: 'config' }));
const makeId = () => globalThis.crypto.randomUUID();

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid encrypted backup.');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function updateKind() {
  const spec = LABELS[kind.value];
  document.getElementById('unit').textContent = spec.unit + (kind.value === 'blood-pressure' ? ' (systolic/diastolic)' : '');
  value.placeholder = spec.placeholder;
  value.inputMode = kind.value === 'blood-pressure' ? 'text' : 'decimal';
}

function localDateInput() {
  const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function validValue(entry) {
  if (typeof entry.value !== 'string' || entry.value.length > 32 || !entry.value.trim()) return false;
  if (!LABELS[entry.kind]) return false;
  if (entry.kind === 'blood-pressure') return /^\s*\d{2,3}\s*\/\s*\d{2,3}\s*$/.test(entry.value);
  return /^\s*\d{1,3}(?:\.\d{1,2})?\s*$/.test(entry.value);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function appendCell(row, text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

async function renderEntries() {
  const sealed = await getAllSealed();
  const entries = [];
  for (const record of sealed) {
    const clear = await vaultCrypto.decryptObject(vaultHandle, vaultUserId, record.id, record.ciphertext);
    const entry = JSON.parse(decoder.decode(clear));
    if (entry.id !== record.id || !validValue(entry) || !Number.isFinite(Date.parse(entry.takenAt))) throw new Error('A saved reading could not be opened. Check the recovery key or restore a backup.');
    entries.push(entry);
  }
  entries.sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
  rows.replaceChildren();
  empty.hidden = entries.length > 0;
  table.hidden = entries.length === 0;
  for (const entry of entries) {
    const row = document.createElement('tr');
    appendCell(row, LABELS[entry.kind].name, 'measure');
    appendCell(row, `${entry.value} ${LABELS[entry.kind].unit}`, 'reading');
    appendCell(row, formatDate(entry.takenAt), 'date');
    appendCell(row, entry.note, 'note');
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Delete';
    button.setAttribute('aria-label', `Delete ${LABELS[entry.kind].name} from ${formatDate(entry.takenAt)}`);
    button.addEventListener('click', async () => {
      await removeSealed(entry.id);
      await renderEntries();
    });
    action.append(button);
    row.append(action);
    rows.append(row);
  }
}

function resetIdleTimer() {
  clearTimeout(lockTimer);
  if (vaultHandle) lockTimer = setTimeout(lockTracker, IDLE_MS);
}

function lockTracker() {
  clearTimeout(lockTimer);
  lockTimer = null;
  if (vaultHandle) vaultCrypto.lockVault(vaultHandle);
  vaultHandle = null;
  vaultUserId = null;
  rows.replaceChildren();
  table.hidden = true;
  form.reset();
  tracker.hidden = true;
  vaultCard.hidden = false;
  showGate().catch(() => renderStorageError());
}

function activateVault(handle, userId) {
  vaultHandle = handle;
  vaultUserId = userId;
  vaultCard.hidden = true;
  tracker.hidden = false;
  takenAt.value = localDateInput();
  updateKind();
  resetIdleTimer();
  renderEntries().catch((err) => { status.textContent = err.message || 'Could not open the encrypted readings.'; });
}

function renderStorageError() {
  vaultCard.hidden = false;
  tracker.hidden = true;
  vaultScreen.textContent = 'This browser could not open encrypted local storage. Readings were not saved.';
}

async function showGate(message = '') {
  const config = await getVault();
  vaultScreen.replaceChildren();
  if (!config) {
    vaultScreen.innerHTML = `
      <p class="eyebrow">First visit</p><h2>Create your encrypted tracker</h2>
      <p>Choose a passphrase with at least 6 characters. The tracker encrypts every reading in your browser before saving it.</p>
      <form id="setup-form" class="gate-form">
        <label>Passphrase<input name="passphrase" type="password" autocomplete="new-password" minlength="6" required></label>
        <label>Confirm passphrase<input name="confirm" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="primary" type="submit">Create private tracker</button><p class="hint" id="gate-message" role="status">${message}</p>
      </form>
      <label class="import">Import encrypted backup<input id="gate-import" type="file" accept="application/json,.json"></label>`;
    document.getElementById('setup-form').addEventListener('submit', createLocalVault);
  } else {
    vaultScreen.innerHTML = `
      <p class="eyebrow">Private tracker locked</p><h2>Unlock your readings</h2>
      <form id="unlock-form" class="gate-form">
        <label>Passphrase<input name="passphrase" type="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Unlock</button><p class="hint" id="gate-message" role="status">${message}</p>
      </form>
      <button type="button" class="link" id="show-recovery">Use a recovery key</button>
      <form id="recovery-form" class="gate-form" hidden>
        <label>Recovery key<input name="recoveryKey" type="text" autocomplete="off" spellcheck="false" required></label>
        <button type="submit">Unlock with recovery key</button>
      </form>
      <label class="import">Import encrypted backup<input id="gate-import" type="file" accept="application/json,.json"></label>`;
    document.getElementById('unlock-form').addEventListener('submit', unlockWithPassphrase);
    document.getElementById('show-recovery').addEventListener('click', () => {
      document.getElementById('recovery-form').hidden = false;
      document.getElementById('show-recovery').hidden = true;
    });
    document.getElementById('recovery-form').addEventListener('submit', unlockWithRecoveryKey);
  }
  document.getElementById('gate-import').addEventListener('change', handleImport);
}

function showRecoveryKey(recoveryKey) {
  vaultScreen.innerHTML = `
    <p class="eyebrow">One-time recovery key</p><h2>Save this key somewhere safe</h2>
    <p>This key can unlock the tracker if you forget your passphrase. It is shown only once and is not in your backup.</p>
    <code class="recovery-key" id="recovery-key"></code>
    <div class="actions recovery-actions"><button type="button" id="copy-recovery">Copy key</button><label class="saved-label"><input type="checkbox" id="saved-recovery"> I saved my recovery key</label><button type="button" class="primary" id="continue-tracker" disabled>Continue</button></div>`;
  document.getElementById('recovery-key').textContent = recoveryKey;
  const saved = document.getElementById('saved-recovery');
  const proceed = document.getElementById('continue-tracker');
  saved.addEventListener('change', () => { proceed.disabled = !saved.checked; });
  document.getElementById('copy-recovery').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      document.getElementById('copy-recovery').textContent = 'Copied';
    } catch {
      document.getElementById('copy-recovery').textContent = 'Select and copy the key above';
    }
  });
  proceed.addEventListener('click', () => activateVault(vaultHandle, vaultUserId));
}

async function createLocalVault(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const passphrase = String(data.get('passphrase'));
  const confirm = String(data.get('confirm'));
  const message = document.getElementById('gate-message');
  if (passphrase !== confirm) { message.textContent = 'The passphrases do not match.'; return; }
  try {
    const userId = makeId();
    const created = await vaultCrypto.createVault(userId, passphrase, { minLength: 6 });
    await putVault({ userId, envelope: created.envelope });
    vaultHandle = created.handle;
    vaultUserId = userId;
    showRecoveryKey(created.recoveryKey);
  } catch (err) {
    message.textContent = err.message || 'Could not create the encrypted tracker.';
  }
}

async function unlockWithPassphrase(event) {
  event.preventDefault();
  const unlockForm = event.currentTarget;
  const passphrase = String(new FormData(unlockForm).get('passphrase'));
  const message = document.getElementById('gate-message');
  try {
    const config = await getVault();
    const handle = await vaultCrypto.unlockWithPassphrase(config.userId, passphrase, config.envelope, { minLength: 6 });
    unlockForm.reset();
    activateVault(handle, config.userId);
  } catch (err) {
    message.textContent = err.message || 'Could not unlock the tracker.';
  }
}

async function unlockWithRecoveryKey(event) {
  event.preventDefault();
  const recoveryForm = event.currentTarget;
  const recoveryKey = String(new FormData(recoveryForm).get('recoveryKey')).trim();
  const message = document.getElementById('gate-message');
  try {
    const config = await getVault();
    const handle = await vaultCrypto.unlockWithRecoveryKey(config.userId, recoveryKey, config.envelope);
    recoveryForm.reset();
    activateVault(handle, config.userId);
  } catch (err) {
    message.textContent = err.message || 'Could not unlock the tracker.';
  }
}

async function encryptedBackup() {
  const config = await getVault();
  const records = await getAllSealed();
  const backup = {
    format: BACKUP_FORMAT,
    version: 1,
    userId: vaultUserId,
    envelope: config.envelope,
    records: records.map(({ id, ciphertext }) => ({ id, ciphertext: base64Url(ciphertext) })),
  };
  return backup;
}

async function handleImport(event) {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  const message = document.getElementById('gate-message') ?? status;
  if (file.size > 10_000_000) { message.textContent = 'Backup is too large to import.'; return; }
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== BACKUP_FORMAT || backup.version !== 1 || !Array.isArray(backup.records) || backup.records.length > 10_000) throw new Error('Invalid encrypted backup.');
    vaultCrypto.validateVaultEnvelope(backup.envelope);
    if (typeof backup.userId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(backup.userId)) throw new Error('Invalid encrypted backup.');
    const records = backup.records.map((record) => {
      if (typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.id)) throw new Error('Invalid encrypted backup.');
      const ciphertext = fromBase64Url(record.ciphertext);
      if (ciphertext.byteLength < 28 || ciphertext.byteLength > 20_000) throw new Error('Invalid encrypted backup.');
      return { id: record.id, ciphertext };
    });
    const current = await getVault();
    if (current && current.userId !== backup.userId) throw new Error('This backup belongs to a different tracker. Delete the current local tracker before importing it.');
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([VAULT, RECORDS], 'readwrite');
      if (!current) tx.objectStore(VAULT).put({ id: 'config', userId: backup.userId, envelope: backup.envelope });
      for (const record of records) tx.objectStore(RECORDS).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error ?? new Error('Backup import failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Backup import failed.'));
    });
    db.close();
    if (vaultHandle) lockTracker();
    else if (!current) await showGate('Encrypted backup imported. Unlock it with its passphrase or recovery key.');
    else message.textContent = `${records.length} encrypted reading${records.length === 1 ? '' : 's'} imported. Existing readings were kept.`;
  } catch (err) {
    message.textContent = err.message || 'This file is not a valid encrypted tracker backup.';
  }
}

kind.addEventListener('change', updateKind);
takenAt.value = localDateInput();
updateKind();
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const entry = {
    id: makeId(),
    kind: kind.value,
    value: value.value.trim(),
    takenAt: new Date(takenAt.value).toISOString(),
    note: String(new FormData(form).get('note') ?? '').trim().slice(0, 500),
  };
  if (!validValue(entry)) {
    status.textContent = kind.value === 'blood-pressure' ? 'Enter blood pressure as systolic/diastolic, such as 120/80.' : 'Enter a number for this measurement.';
    value.focus();
    return;
  }
  try {
    const ciphertext = await vaultCrypto.encryptObject(vaultHandle, vaultUserId, entry.id, encoder.encode(JSON.stringify(entry)));
    await putSealed({ id: entry.id, ciphertext });
    form.reset();
    takenAt.value = localDateInput();
    updateKind();
    status.textContent = 'Reading encrypted and saved on this device.';
    await renderEntries();
    value.focus();
    resetIdleTimer();
  } catch {
    status.textContent = 'Browser storage is unavailable. Your reading was not saved.';
  }
});

document.getElementById('export').addEventListener('click', async () => {
  try {
    const data = await encryptedBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `tleehealth-encrypted-readings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    status.textContent = 'Could not create the encrypted backup.';
  }
});

document.getElementById('import').addEventListener('change', handleImport);
document.getElementById('clear').addEventListener('click', async () => {
  const entries = await getAllSealed();
  if (!entries.length || !confirm(`Delete all ${entries.length} encrypted reading${entries.length === 1 ? '' : 's'} from this browser? This cannot be undone.`)) return;
  await clearSealed();
  status.textContent = 'All readings deleted from this browser.';
  await renderEntries();
});
document.getElementById('lock').addEventListener('click', lockTracker);

window.addEventListener('pointerdown', resetIdleTimer, { passive: true });
window.addEventListener('keydown', resetIdleTimer);
async function checkAccountSession() {
  try {
    const response = await fetch('/api/v1/me', { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) return;
  } catch {}
  lockTracker();
  location.replace('/signin?next=%2Fhealth%2F');
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    lockTracker();
    return;
  }
  checkAccountSession();
});
setInterval(() => {
  if (document.visibilityState === 'visible') checkAccountSession();
}, 60_000);
window.addEventListener('pagehide', () => {
  if (vaultHandle) vaultCrypto.lockVault(vaultHandle);
  vaultHandle = null;
  vaultUserId = null;
  clearTimeout(lockTimer);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) lockTracker();
});

showGate().catch(renderStorageError);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/health/sw.js', { scope: '/health/' }).catch(() => {});
