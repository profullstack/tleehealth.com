// Shared tracker readings and the provider directory. The format and directory
// tests need nothing; the API tests run against a real Postgres (DATABASE_URL).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configured, close, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import {
  buildSharePayload, fromBase64Url, generatePasskey, normalizePasskey, openShare, sealShare, shareIdFrom,
  toBase64Url, toCsv, toFhirBundle, toText,
} from '../packages/cli/src/share-format.js';
import { getProvider, searchProviders, validNpi } from '../apps/web/src/providers.js';
import { rateLimit } from '../apps/web/src/health-shares.js';

const { app } = configured() ? await import('../apps/web/src/app.js') : { app: null };
const auth = configured() ? await import('../apps/web/src/auth.js') : null;

const READINGS = [
  { id: 'a', kind: 'blood-pressure', value: '128 / 82', takenAt: '2026-11-20T15:00:00.000Z', note: 'before breakfast' },
  { id: 'b', kind: 'weight', value: '154.3', unit: 'lb', takenAt: '2026-11-21T15:00:00.000Z', note: '' },
  { id: 'c', kind: 'weight', value: '70', takenAt: '2026-11-19T15:00:00.000Z', note: '' }, // saved before units: metric
  { id: 'd', kind: 'temperature', value: '98.6', unit: '°F', takenAt: '2026-11-18T15:00:00.000Z', note: '=HYPERLINK("http://x")' },
  { id: 'e', kind: 'glucose', value: '104', takenAt: '2026-11-17T15:00:00.000Z', note: 'fasting, "home" meter' },
];
const SHARE_ID = '2f1c9b1e-7a44-4f0e-9d63-0c5e8f1a2b3c';

describe('share format', () => {
  test('a passkey is 100 bits in four readable groups and survives sloppy typing', () => {
    const passkey = generatePasskey();
    expect(passkey).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(generatePasskey()).not.toBe(passkey);
    expect(normalizePasskey(` ${passkey.toLowerCase().replace(/-/g, ' ')} `)).toBe(passkey);
    expect(normalizePasskey('OIL00-00000-00000-0000U')).toBe('01100-00000-00000-0000V');
    expect(() => normalizePasskey('ABCDE-ABCDE')).toThrow(/full share passkey/);
  });

  test('the payload is cleaned, sorted newest first and keeps each reading in its own unit', () => {
    const payload = buildSharePayload({ readings: READINGS, from: '  Ada Lovelace ', message: 'home readings' });
    expect(payload.from).toBe('Ada Lovelace');
    expect(payload.readings.map((r) => r.kind)).toEqual(['weight', 'blood-pressure', 'weight', 'temperature', 'glucose']);
    expect(payload.readings[0]).toEqual({ kind: 'weight', value: '154.3', unit: 'lb', takenAt: '2026-11-21T15:00:00.000Z', note: '' });
    expect(payload.readings[1].value).toBe('128/82');
    expect(payload.readings[2].unit).toBe('kg');
    expect(payload.readings[0].id).toBeUndefined();
    expect(() => buildSharePayload({ readings: [] })).toThrow(/no readings/);
    expect(() => buildSharePayload({ readings: [{ kind: 'weight', value: 'heavy', takenAt: '2026-11-21' }] })).toThrow(/invalid value/);
    expect(() => buildSharePayload({ readings: [{ kind: 'mood', value: '5', takenAt: '2026-11-21' }] })).toThrow(/unknown measurement/);
  });

  test('only the passkey opens a share, and only for the share it was sealed for', async () => {
    const passkey = generatePasskey();
    const payload = buildSharePayload({ readings: READINGS, from: 'Ada' });
    const { envelope, ciphertext } = await sealShare(SHARE_ID, passkey, payload);
    expect(new TextDecoder().decode(ciphertext)).not.toContain('blood-pressure');
    expect(JSON.stringify(envelope)).not.toContain(passkey);

    const wire = fromBase64Url(toBase64Url(ciphertext));
    const opened = await openShare(SHARE_ID, passkey.toLowerCase(), envelope, wire);
    expect(opened.readings).toEqual(payload.readings);
    expect(opened.from).toBe('Ada');

    await expect(openShare(SHARE_ID, generatePasskey(), envelope, wire)).rejects.toThrow(/does not open this share/);
    await expect(openShare('9f1c9b1e-7a44-4f0e-9d63-0c5e8f1a2b3c', passkey, envelope, wire)).rejects.toThrow();
    const tampered = wire.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(openShare(SHARE_ID, passkey, envelope, tampered)).rejects.toThrow();
  }, 30_000);

  test('the share id comes out of a link or a bare id', () => {
    expect(shareIdFrom(`https://tleehealth.pwa.pit.world/share/${SHARE_ID.toUpperCase()}`)).toBe(SHARE_ID);
    expect(shareIdFrom(SHARE_ID)).toBe(SHARE_ID);
    expect(() => shareIdFrom('https://example.com/share/nope')).toThrow(/not a tleehealth share link/);
  });

  test('CSV splits blood pressure, quotes text and defuses spreadsheet formulas', () => {
    const lines = toCsv(buildSharePayload({ readings: READINGS })).trimEnd().split('\r\n');
    expect(lines[0]).toBe('measurement,value,unit,systolic,diastolic,taken_at,note,loinc');
    expect(lines[2]).toBe('Blood pressure,128/82,mmHg,128,82,2026-11-20T15:00:00.000Z,before breakfast,85354-9');
    expect(lines[4]).toContain('"\'=HYPERLINK(""http://x"")"');
    expect(lines[5]).toContain('"fasting, ""home"" meter"');
  });

  test('the FHIR bundle is R4 Observations with LOINC codes and UCUM units', () => {
    const bundle = toFhirBundle(buildSharePayload({ readings: READINGS, from: 'Ada' }));
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('collection');
    expect(bundle.entry).toHaveLength(5);
    const [weight, pressure, , temperature, glucose] = bundle.entry.map((e) => e.resource);
    expect(weight.code.coding[0]).toMatchObject({ system: 'http://loinc.org', code: '29463-7' });
    expect(weight.valueQuantity).toEqual({ value: 154.3, unit: 'lb', system: 'http://unitsofmeasure.org', code: '[lb_av]' });
    expect(pressure.valueQuantity).toBeUndefined();
    expect(pressure.component.map((c) => [c.code.coding[0].code, c.valueQuantity.value, c.valueQuantity.code])).toEqual([
      ['8480-6', 128, 'mm[Hg]'], ['8462-4', 82, 'mm[Hg]'],
    ]);
    expect(pressure.note).toEqual([{ text: 'before breakfast' }]);
    expect(temperature.valueQuantity.code).toBe('[degF]');
    expect(glucose.category[0].coding[0].code).toBe('laboratory');
    expect(weight.category[0].coding[0].code).toBe('vital-signs');
    for (const e of bundle.entry) expect(e.fullUrl).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}$/);
    expect(new Set(bundle.entry.map((e) => e.fullUrl)).size).toBe(5);
    expect(toText(buildSharePayload({ readings: READINGS, from: 'Ada' }))).toContain('Shared by: Ada');
  });
});

describe('provider directory', () => {
  const person = {
    number: '1093626848', enumeration_type: 'NPI-1',
    basic: { first_name: 'JANE', middle_name: 'QUINN', last_name: "O'NEIL-SMITH", credential: 'M.D.', status: 'A' },
    taxonomies: [{ desc: 'Nurse Practitioner', primary: false }, { desc: 'Internal Medicine, Cardiovascular Disease', primary: true }],
    addresses: [
      { address_purpose: 'MAILING', address_1: '1 HOME ST', city: 'RENO', state: 'NV', postal_code: '895011234', telephone_number: '775-555-0100' },
      { address_purpose: 'LOCATION', address_1: '9 PRIVATE RD', city: 'SAN FRANCISCO', state: 'CA', postal_code: '941101234', telephone_number: '415-555-0101' },
    ],
  };
  const org = {
    number: '1234567893', enumeration_type: 'NPI-2',
    basic: { organization_name: 'MERCY HEART CLINIC', status: 'A' },
    taxonomies: [{ desc: 'Clinic/Center, Urgent Care', primary: true }],
    addresses: [{ address_purpose: 'LOCATION', address_1: '500 MAIN ST', address_2: 'STE 2', city: 'OAKLAND', state: 'CA', postal_code: '94607', telephone_number: '510-555-0102' }],
  };
  const registry = (answer) => {
    const calls = [];
    const fetchImpl = async (url) => {
      const params = Object.fromEntries(new URL(url).searchParams);
      calls.push(params);
      return { ok: true, json: async () => (typeof answer === 'function' ? answer(params) : answer) };
    };
    return { calls, fetchImpl };
  };

  test('NPI numbers are checked with the registry check digit', () => {
    expect(validNpi('1093626848')).toBe(true);
    expect(validNpi('1234567893')).toBe(true);
    expect(validNpi('1093626849')).toBe(false);
    expect(validNpi('109362684')).toBe(false);
    expect(validNpi('3093626848')).toBe(false);
  });

  test('a name searches people and organizations and lists a person by city only', async () => {
    const { calls, fetchImpl } = registry((p) => ({ results: p.enumeration_type === 'NPI-1' ? [person] : [org] }));
    const found = await searchProviders({ q: 'jane smith', state: 'ca', specialty: 'cardiology' }, { fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ version: '2.1', enumeration_type: 'NPI-1', first_name: 'jane*', last_name: 'smith*', state: 'CA', taxonomy_description: 'Cardiovascular Disease' });
    expect(calls[1]).toMatchObject({ enumeration_type: 'NPI-2', organization_name: 'jane smith*' });
    const [p, o] = found.results;
    expect(p).toMatchObject({
      npi: '1093626848', type: 'individual', name: "Jane Q O'Neil-Smith", credential: 'M.D.',
      specialty: 'Internal Medicine, Cardiovascular Disease', city: 'San Francisco', state: 'CA', postal_code: '94110', active: true,
    });
    expect(p.address).toBeUndefined();
    expect(p.phone).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('Private Rd');
    expect(o).toMatchObject({ type: 'organization', name: 'Mercy Heart Clinic', address: '500 Main St, Ste 2', phone: '510-555-0102', city: 'Oakland' });
    expect(found.source.dataset).toBe('https://nichedb.dev/f/providers');
  });

  test('a specialty alone browses, and searches need something to go on', async () => {
    const { calls, fetchImpl } = registry({ results: [] });
    await searchProviders({ specialty: 'pharmacy', zip: '94110', type: 'organization', page: '3' }, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taxonomy_description: 'Pharmacy', postal_code: '94110', enumeration_type: 'NPI-2', skip: '40', limit: '20' });
    await expect(searchProviders({ state: 'CA' }, { fetchImpl })).rejects.toThrow(/Enter a name/);
    await expect(searchProviders({ q: 'x' }, { fetchImpl })).rejects.toThrow(/two letters/);
    await expect(searchProviders({ q: 'smith', state: 'ZZ' }, { fetchImpl })).rejects.toThrow(/two-letter/);
    await expect(searchProviders({ specialty: 'wizardry' }, { fetchImpl })).rejects.toThrow(/unknown specialty/);
    await expect(getProvider('12345', { fetchImpl })).rejects.toThrow(/not a valid NPI/);
  });

  test('a registry failure is a clear 502, not a crash', async () => {
    const fetchImpl = async () => { throw new Error('socket hang up'); };
    const err = await searchProviders({ q: 'outage test' }, { fetchImpl }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/did not answer/);
  });
});

test('the public rate limit counts a fixed window per key', () => {
  const key = `test:${Math.random()}`;
  expect(rateLimit(key, 2, 1000, 0)).toBe(true);
  expect(rateLimit(key, 2, 1000, 10)).toBe(true);
  expect(rateLimit(key, 2, 1000, 20)).toBe(false);
  expect(rateLimit(key, 2, 1000, 1001)).toBe(true);
});

describe.skipIf(!configured())('health shares api', () => {
  const tag = Date.now();
  let owner;
  let other;

  async function signIn(email) {
    const url = new URL(await auth.createLoginLink(email));
    const res = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
    return res.headers.get('set-cookie').split(';')[0];
  }
  const call = async (cookie, method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const uuid = () => crypto.randomUUID();

  beforeAll(async () => {
    await migrate({ log: () => {} });
    owner = await signIn(`sharer${tag}@example.com`);
    other = await signIn(`other${tag}@example.com`);
  });
  afterAll(() => close());

  test('a share round-trips as ciphertext and the passkey holder reads it', async () => {
    const id = uuid();
    const passkey = generatePasskey();
    const payload = buildSharePayload({ readings: READINGS, from: 'Ada' });
    const sealed = await sealShare(id, passkey, payload);
    const label = toBase64Url(crypto.getRandomValues(new Uint8Array(40)));

    expect((await call('', 'POST', '/health/shares', {})).status).toBe(401);
    const created = await call(owner, 'POST', '/health/shares', {
      id, expires_days: 7, envelope: sealed.envelope, ciphertext: toBase64Url(sealed.ciphertext), label,
    });
    expect(created.status).toBe(201);
    expect(created.body.share.url).toEndWith(`/share/${id}`);
    expect(created.body.share.views).toBe(0);

    // Nothing the server stored contains a reading or the passkey.
    const [row] = await db()`select key_envelope, ciphertext from health_shares where id = ${id}`;
    const stored = `${JSON.stringify(row.key_envelope)}${Buffer.from(row.ciphertext).toString('latin1')}`;
    expect(stored).not.toContain('blood-pressure');
    expect(stored).not.toContain(passkey);

    // The link holder needs no account.
    const fetched = await call('', 'GET', `/shared/${id}`);
    expect(fetched.status).toBe(200);
    expect(Object.keys(fetched.body).sort()).toEqual(['ciphertext', 'created_at', 'envelope', 'expires_at', 'format', 'id', 'version']);
    const opened = await openShare(id, passkey, fetched.body.envelope, fromBase64Url(fetched.body.ciphertext));
    expect(opened.readings).toEqual(payload.readings);

    const listed = await call(owner, 'GET', '/health/shares');
    expect(listed.body.shares).toHaveLength(1);
    expect(listed.body.shares[0]).toMatchObject({ id, views: 1, label });
    expect((await call(other, 'GET', '/health/shares')).body.shares).toHaveLength(0);

    // Only the owner revokes; revoking deletes the ciphertext.
    expect((await call(other, 'DELETE', `/health/shares/${id}`)).status).toBe(404);
    expect((await call(owner, 'DELETE', `/health/shares/${id}`)).status).toBe(200);
    expect((await call('', 'GET', `/shared/${id}`)).status).toBe(404);
    expect(await db()`select 1 from health_shares where id = ${id}`).toHaveLength(0);
  }, 30_000);

  test('bad input is refused and expired shares are gone', async () => {
    const id = uuid();
    const sealed = await sealShare(id, generatePasskey(), buildSharePayload({ readings: READINGS }));
    const good = { id, expires_days: 1, envelope: sealed.envelope, ciphertext: toBase64Url(sealed.ciphertext) };
    expect((await call(owner, 'POST', '/health/shares', { ...good, expires_days: 365 })).status).toBe(400);
    expect((await call(owner, 'POST', '/health/shares', { ...good, ciphertext: 'AAAA' })).status).toBe(400);
    expect((await call(owner, 'POST', '/health/shares', { ...good, envelope: { format: 'nope' } })).status).toBe(400);
    expect((await call(owner, 'POST', '/health/shares', { ...good, id: 'not-a-uuid' })).status).toBe(404);
    expect((await call(owner, 'POST', '/health/shares', good)).status).toBe(201);
    expect((await call(owner, 'POST', '/health/shares', good)).status).toBe(409);

    await db()`update health_shares set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = ${id}`;
    expect((await call('', 'GET', `/shared/${id}`)).status).toBe(404);
    expect((await call(owner, 'GET', '/health/shares')).body.shares).toHaveLength(0);
    expect((await call('', 'GET', '/shared/not-a-uuid')).status).toBe(404);
  }, 30_000);

  test('the share page, its scripts and the directory page are public', async () => {
    const page = await app.request(`/share/${uuid()}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Enter the share passkey');
    for (const path of ['/assets/share.js', '/assets/share-format.js', '/assets/vault-crypto.js', '/assets/tracker.css', '/assets/providers.js']) {
      expect((await app.request(path)).status).toBe(200);
    }
    const directory = await app.request('/providers');
    expect(directory.status).toBe(200);
    expect(await directory.text()).toContain('Find a doctor, clinic or hospital.');
    expect((await app.request('/providers/1093626848')).status).toBe(200);
    expect((await app.request('/providers/abc')).status).toBe(404);

    const meta = await call('', 'GET', '/providers/specialties');
    expect(meta.status).toBe(200);
    expect(meta.body.specialties.some((s) => s.id === 'cardiology')).toBe(true);
    expect((await call('', 'GET', '/providers?state=CA')).status).toBe(400);
    expect((await call('', 'GET', '/providers/123')).status).toBe(400);
  });

  test('the tracker offers sharing and no longer says readings never leave', async () => {
    const page = await (await app.request('/health/', { headers: { cookie: owner } })).text();
    expect(page).toContain('id="open-share"');
    expect(page).toContain('Import shared readings');
    expect(page).not.toContain('Readings never reach the server');
  });
});
