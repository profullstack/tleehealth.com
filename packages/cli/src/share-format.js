// Shared health tracker readings: the one module the tracker, the public share
// page and the CLI all use to seal, open and convert a share.
//
// A share is a snapshot of readings encrypted under a one-time share passkey.
// The passkey wraps a random data key (PBKDF2-SHA-256, 600,000 iterations,
// AES-256-GCM) with the same envelope the record vault uses, bound to the
// share id. The server stores the envelope and ciphertext and never sees the
// passkey, so only someone holding both the link and the passkey can read it.

import * as vaultCrypto from './vault-crypto.js';

export const SHARE_FORMAT = 'tleehealth-shared-readings';
export const SHARE_VERSION = 1;
export const MAX_READINGS = 10_000;
export const EXPIRY_DAYS = [1, 7, 30, 90];

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Crockford base32: no I, L, O or U, so a passkey read over the phone survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PASSKEY_CHARS = 20; // 100 bits

/** LOINC code, default unit and UCUM units for each kind of reading. */
export const KINDS = {
  'blood-pressure': { name: 'Blood pressure', unit: 'mmHg', loinc: '85354-9', display: 'Blood pressure panel with all children optional' },
  weight: { name: 'Weight', unit: 'kg', loinc: '29463-7', display: 'Body weight' },
  glucose: { name: 'Blood glucose', unit: 'mg/dL', loinc: '2339-0', display: 'Glucose [Mass/volume] in Blood' },
  'heart-rate': { name: 'Heart rate', unit: 'bpm', loinc: '8867-4', display: 'Heart rate' },
  temperature: { name: 'Temperature', unit: '°C', loinc: '8310-5', display: 'Body temperature' },
  oxygen: { name: 'Oxygen saturation', unit: '%', loinc: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry' },
};
const UCUM = { mmHg: 'mm[Hg]', kg: 'kg', lb: '[lb_av]', 'mg/dL': 'mg/dL', bpm: '/min', '°C': 'Cel', '°F': '[degF]', '%': '%' };
const ALLOWED_UNITS = {
  'blood-pressure': ['mmHg'], weight: ['kg', 'lb'], glucose: ['mg/dL'], 'heart-rate': ['bpm'], temperature: ['°C', '°F'], oxygen: ['%'],
};

/** A fresh share passkey: 20 characters in four groups, 100 bits of entropy. */
export function generatePasskey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PASSKEY_CHARS));
  let out = '';
  for (let i = 0; i < PASSKEY_CHARS; i += 1) {
    if (i && i % 5 === 0) out += '-';
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}

/** Forgive spaces, dashes, case and the letters people misread. */
export function normalizePasskey(input) {
  const cleaned = String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  if (cleaned.length !== PASSKEY_CHARS || [...cleaned].some((ch) => !ALPHABET.includes(ch))) {
    throw new Error('Enter the full share passkey: four groups of five characters.');
  }
  return cleaned.replace(/(.{5})(?=.)/g, '$1-');
}

/** The share id inside a share link, or the id itself. */
export function shareIdFrom(input) {
  const text = String(input ?? '').trim();
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error('That is not a tleehealth share link.');
  return match[0].toLowerCase();
}

function cleanReading(entry) {
  const spec = KINDS[entry?.kind];
  if (!spec) throw new Error('A shared reading has an unknown measurement.');
  const value = String(entry.value ?? '').trim();
  const ok = entry.kind === 'blood-pressure'
    ? /^\d{2,3}\s*\/\s*\d{2,3}$/.test(value)
    : /^\d{1,3}(?:\.\d{1,2})?$/.test(value);
  if (!ok) throw new Error('A shared reading has an invalid value.');
  const takenAt = new Date(entry.takenAt);
  if (Number.isNaN(takenAt.getTime())) throw new Error('A shared reading has an invalid date.');
  const unit = ALLOWED_UNITS[entry.kind].includes(entry.unit) ? entry.unit : spec.unit;
  return {
    kind: entry.kind,
    value: value.replace(/\s+/g, ''),
    unit,
    takenAt: takenAt.toISOString(),
    note: String(entry.note ?? '').slice(0, 500),
  };
}

/** The plaintext snapshot that gets sealed. Throws on anything malformed. */
export function buildSharePayload({ readings, from = '', message = '', sharedAt = new Date() }) {
  if (!Array.isArray(readings) || !readings.length) throw new Error('There are no readings to share.');
  if (readings.length > MAX_READINGS) throw new Error('Too many readings to share at once.');
  const cleaned = readings.map(cleanReading).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    sharedAt: new Date(sharedAt).toISOString(),
    from: String(from ?? '').trim().slice(0, 120),
    message: String(message ?? '').trim().slice(0, 500),
    readings: cleaned,
  };
}

export function validateSharePayload(payload) {
  if (payload?.format !== SHARE_FORMAT || payload.version !== SHARE_VERSION) throw new Error('This share uses a format this app cannot read.');
  return buildSharePayload({ readings: payload.readings, from: payload.from, message: payload.message, sharedAt: payload.sharedAt });
}

/** Encrypt a payload under a passkey. Returns what the server stores. */
export async function sealShare(shareId, passkey, payload) {
  if (!UUID.test(String(shareId))) throw new Error('invalid share id');
  const created = await vaultCrypto.createVault(shareId, normalizePasskey(passkey));
  try {
    const ciphertext = await vaultCrypto.encryptObject(created.handle, shareId, shareId, encoder.encode(JSON.stringify(payload)));
    return { envelope: created.envelope, ciphertext };
  } finally {
    vaultCrypto.lockVault(created.handle);
  }
}

/** Decrypt a share with its passkey. Throws a plain message on a wrong passkey. */
export async function openShare(shareId, passkey, envelope, ciphertext) {
  if (!UUID.test(String(shareId))) throw new Error('invalid share id');
  let handle;
  try {
    handle = await vaultCrypto.unlockWithPassphrase(shareId, normalizePasskey(passkey), envelope);
  } catch (err) {
    if (/full share passkey/.test(err.message)) throw err;
    throw new Error('That passkey does not open this share.');
  }
  try {
    const clear = await vaultCrypto.decryptObject(handle, shareId, shareId, ciphertext);
    return validateSharePayload(JSON.parse(decoder.decode(clear)));
  } finally {
    vaultCrypto.lockVault(handle);
  }
}

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid share data');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
}

/* ------------------------------------------------------------- exports -- */

// A cell starting with = + - @ runs as a formula in spreadsheets; quote it inert.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per reading; blood pressure also gets systolic and diastolic columns. */
export function toCsv(payload) {
  const rows = [['measurement', 'value', 'unit', 'systolic', 'diastolic', 'taken_at', 'note', 'loinc']];
  for (const r of payload.readings) {
    const [systolic, diastolic] = r.kind === 'blood-pressure' ? r.value.split('/') : ['', ''];
    rows.push([KINDS[r.kind].name, r.value, r.unit, systolic, diastolic, r.takenAt, r.note, KINDS[r.kind].loinc]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const quantity = (value, unit) => ({ value: Number(value), unit, system: 'http://unitsofmeasure.org', code: UCUM[unit] });

/**
 * A FHIR R4 collection Bundle of vital-sign Observations, the format EHRs and
 * health apps import. Readings are patient-reported, so they carry no subject
 * reference: the importing system attaches them to its own patient.
 */
export function toFhirBundle(payload) {
  const entry = payload.readings.map((r, i) => {
    const spec = KINDS[r.kind];
    const resource = {
      resourceType: 'Observation',
      id: `reading-${i + 1}`,
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          code: r.kind === 'glucose' ? 'laboratory' : 'vital-signs',
          display: r.kind === 'glucose' ? 'Laboratory' : 'Vital Signs',
        }],
      }],
      code: { coding: [{ system: 'http://loinc.org', code: spec.loinc, display: spec.display }], text: spec.name },
      effectiveDateTime: r.takenAt,
      method: { text: 'Self-reported by the patient' },
    };
    if (r.kind === 'blood-pressure') {
      const [systolic, diastolic] = r.value.split('/');
      resource.component = [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: quantity(systolic, 'mmHg') },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: quantity(diastolic, 'mmHg') },
      ];
    } else {
      resource.valueQuantity = quantity(r.value, r.unit);
    }
    if (r.note) resource.note = [{ text: r.note }];
    return { fullUrl: `urn:uuid:${uuidFromIndex(payload.sharedAt, i)}`, resource };
  });
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: payload.sharedAt,
    meta: { tag: [{ system: 'https://tleehealth.pwa.pit.world/fhir/tag', code: 'patient-shared-readings', display: payload.from ? `Shared by ${payload.from}` : 'Shared from tleehealth' }] },
    entry,
  };
}

// Stable, well-formed fullUrl ids without needing a hash: time + position.
function uuidFromIndex(sharedAt, i) {
  const t = new Date(sharedAt).getTime().toString(16).padStart(12, '0').slice(-12);
  const n = i.toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-4000-8000-${n}`;
}

/** Plain text for the terminal or a printout. */
export function toText(payload) {
  const lines = [];
  if (payload.from) lines.push(`Shared by: ${payload.from}`);
  lines.push(`Shared at: ${payload.sharedAt}`);
  if (payload.message) lines.push(`Message:   ${payload.message}`);
  lines.push('');
  for (const r of payload.readings) {
    lines.push(`${r.takenAt}  ${KINDS[r.kind].name.padEnd(18)} ${`${r.value} ${r.unit}`.padEnd(14)} ${r.note}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}
