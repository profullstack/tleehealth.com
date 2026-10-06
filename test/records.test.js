// Health-record import end to end against a fake SMART on FHIR server that
// behaves like Epic where it matters: PKCE, a patient in the token response,
// paging, Observation refusing a search without a category, Binary files.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { configured, close } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import * as records from '../apps/web/src/records.js';
import { crc32, zip } from '../apps/web/src/zip.js';

describe('records units', () => {
  test('seal and unseal round-trip, and sealing is randomized', () => {
    const a = records.seal('secret-token');
    expect(records.unseal(a)).toBe('secret-token');
    expect(Buffer.compare(a, records.seal('secret-token'))).not.toBe(0);
  });

  test('crc32 matches the known check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('zip writes a readable archive', () => {
    const z = zip([{ name: 'a/b.txt', data: 'hello' }]);
    expect(String.fromCharCode(z[0], z[1])).toBe('PK');
    expect(Buffer.from(z).includes(Buffer.from('a/b.txt'))).toBe(true);
  });

  test('private and plain-http FHIR addresses are refused', async () => {
    const prev = process.env.HEALTH_ALLOW_PRIVATE_URLS;
    delete process.env.HEALTH_ALLOW_PRIVATE_URLS;
    await expect(records.assertPublicUrl('https://127.0.0.1/fhir')).rejects.toThrow('public internet');
    await expect(records.assertPublicUrl('https://[::1]/fhir')).rejects.toThrow('public internet');
    await expect(records.assertPublicUrl('https://10.1.2.3/fhir')).rejects.toThrow('public internet');
    await expect(records.assertPublicUrl('http://example.com/fhir')).rejects.toThrow('https');
    if (prev !== undefined) process.env.HEALTH_ALLOW_PRIVATE_URLS = prev;
  });

  test('classify sorts summaries, notes, labs and imaging apart', () => {
    const avs = { resourceType: 'DocumentReference', id: '1', type: { text: 'After Visit Summary' }, date: '2026-01-02T10:00:00Z' };
    expect(records.classify(avs)).toEqual({ category: 'summaries', title: 'After Visit Summary', recorded_on: '2026-01-02' });
    expect(records.classify({ resourceType: 'DocumentReference', id: '2', type: { text: 'Progress Note' } }).category).toBe('notes');
    expect(records.classify({ resourceType: 'DiagnosticReport', id: '3', category: [{ coding: [{ code: 'RAD' }] }], code: { text: 'Chest X-ray' } }).category).toBe('imaging');
    expect(records.classify({ resourceType: 'Observation', id: '4', category: [{ coding: [{ code: 'laboratory' }] }], code: { text: 'A1c' } }).category).toBe('labs');
    expect(records.classify({ resourceType: 'Observation', id: '5', category: [{ coding: [{ code: 'vital-signs' }] }], code: { text: 'BP' } }).category).toBe('vitals');
  });

  test('vendor detection and client registration', () => {
    expect(records.vendorOf('https://fhir.example.org/api/FHIR/R4')).toBe('epic');
    expect(records.vendorOf('https://fhir-myrecord.cerner.com/r4/abc')).toBe('cerner');
    expect(records.vendorOf(records.SANDBOX_BASE)).toBe('sandbox');
    expect(records.vendorOf('https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4')).toBe('epic-sandbox');
    process.env.EPIC_SANDBOX_CLIENT_ID = 'nonprod-id';
    process.env.EPIC_CLIENT_ID = 'prod-id';
    expect(records.clientFor('epic-sandbox').id).toBe('nonprod-id');
    expect(records.clientFor('epic').id).toBe('prod-id');
    delete process.env.EPIC_SANDBOX_CLIENT_ID;
    delete process.env.EPIC_CLIENT_ID;
    expect(records.clientFor('sandbox').id).toBe('tleehealth');
  });

  test('profileOf flattens demographics and identifiers', () => {
    const p = records.profileOf({
      resourceType: 'Patient',
      name: [{ use: 'official', given: ['Ada'], family: 'Lin' }],
      birthDate: '1980-02-03',
      telecom: [{ system: 'phone', value: '555-0100', use: 'home' }, { system: 'email', value: 'ada@example.com' }],
      address: [{ line: ['1 Main St'], city: 'Oakland', state: 'CA', postalCode: '94607' }],
      identifier: [{ type: { text: 'MRN' }, value: 'E12345' }],
    });
    expect(p.name).toBe('Ada Lin');
    expect(p.phones).toEqual(['555-0100 (home)']);
    expect(p.addresses).toEqual(['1 Main St, Oakland, CA, 94607']);
    expect(p.identifiers).toEqual([{ type: 'MRN', value: 'E12345' }]);
  });
});

/* ------------------------------------------------------------ fake server -- */

const PDF = Buffer.from('%PDF-1.4\n% after visit summary\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PID = 'pat-1';

function fakeFhir() {
  const codes = new Map();
  const tokens = new Set();
  let base = '';
  const bundle = (resources, next) => ({
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
    link: next ? [{ relation: 'next', url: next }] : [],
  });
  const labs = Array.from({ length: 3 }, (_, i) => ({
    resourceType: 'Observation', id: `lab-${i}`, status: 'final',
    category: [{ coding: [{ code: 'laboratory' }] }], code: { text: ['A1c', 'LDL', 'TSH'][i] },
    valueQuantity: { value: [6.1, 130, 2.2][i], unit: ['%', 'mg/dL', 'mIU/L'][i] }, effectiveDateTime: '2026-09-01',
    referenceRange: [{ low: { value: 4 }, high: { value: 5.6 } }],
  }));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      if (p === '/fhir/.well-known/smart-configuration')
        return Response.json({ authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, capabilities: ['launch-standalone', 'permission-v1'] });
      if (p === '/auth/authorize') {
        const code = `code-${Math.random()}`;
        codes.set(code, u.searchParams.get('code_challenge'));
        const back = new URL(u.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state'));
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (p === '/auth/token') {
        const f = new URLSearchParams(await req.text());
        const challenge = codes.get(f.get('code'));
        if (!challenge || createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== challenge)
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        codes.delete(f.get('code'));
        const t = `tok-${Math.random()}`;
        tokens.add(t);
        return Response.json({ access_token: t, token_type: 'Bearer', expires_in: 3600, scope: f.get('scope') ?? 'patient/*.read', patient: PID, refresh_token: 'r1' });
      }
      if (!tokens.has((req.headers.get('authorization') ?? '').replace('Bearer ', ''))) return new Response('no', { status: 401 });
      const pat = u.searchParams.get('patient');
      const json = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/fhir+json' } });
      if (p === `/fhir/Patient/${PID}`)
        return json({
          resourceType: 'Patient', id: PID, name: [{ use: 'official', given: ['Ada'], family: 'Lin' }], birthDate: '1980-02-03', gender: 'female',
          telecom: [{ system: 'phone', value: '555-0100' }], identifier: [{ type: { text: 'MRN' }, value: 'E12345' }],
          address: [{ line: ['1 Main St'], city: 'Oakland', state: 'CA' }],
        });
      if (p === '/fhir/Binary/avs-1') return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
      if (p === '/fhir/Binary/img-1') return json({ resourceType: 'Binary', contentType: 'image/png', data: PNG.toString('base64') });
      if (p === '/fhir/Medication/m1') return json({ resourceType: 'Medication', id: 'm1', code: { text: 'Lisinopril 10 mg' } });
      if (pat !== PID) return json(bundle([]));
      if (p === '/fhir/Observation') {
        // Like Epic: a search without a category is refused.
        const cat = u.searchParams.get('category');
        if (!cat) return new Response('{"resourceType":"OperationOutcome"}', { status: 400 });
        if (cat !== 'laboratory') return json(bundle([]));
        // Two pages.
        return u.searchParams.get('page') === '2'
          ? json(bundle(labs.slice(2)))
          : json(bundle(labs.slice(0, 2), `${base}/fhir/Observation?patient=${PID}&category=laboratory&page=2`));
      }
      if (p === '/fhir/Encounter')
        return json(bundle([{ resourceType: 'Encounter', id: 'enc-1', status: 'finished', type: [{ text: 'Office Visit' }], period: { start: '2026-09-01T09:00:00Z' } }]));
      if (p === '/fhir/DocumentReference')
        return json(bundle([
          { resourceType: 'DocumentReference', id: 'doc-avs', type: { text: 'After Visit Summary' }, date: '2026-09-01T10:00:00Z', content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/avs-1', title: 'AVS' } }] },
          { resourceType: 'DocumentReference', id: 'doc-note', type: { text: 'Progress Note' }, date: '2026-09-01T10:00:00Z', content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Patient doing well.').toString('base64') } }] },
          // A file on another host is never fetched: the token stays with the provider.
          { resourceType: 'DocumentReference', id: 'doc-ext', type: { text: 'Letter' }, content: [{ attachment: { contentType: 'application/pdf', url: 'https://elsewhere.example/x.pdf' } }] },
        ]));
      if (p === '/fhir/DiagnosticReport')
        return json(bundle([{ resourceType: 'DiagnosticReport', id: 'rad-1', status: 'final', category: [{ coding: [{ code: 'RAD' }] }], code: { text: 'Chest X-ray' }, effectiveDateTime: '2026-08-15', conclusion: 'No acute findings.', presentedForm: [{ contentType: 'application/pdf', data: PDF.toString('base64'), title: 'Radiology report' }] }]));
      if (p === '/fhir/Media')
        return json(bundle([{ resourceType: 'Media', id: 'media-1', status: 'completed', content: { contentType: 'image/png', url: `${base}/fhir/Binary/img-1`, title: 'Rash photo' }, createdDateTime: '2026-08-20' }]));
      if (p === '/fhir/MedicationRequest')
        return json(bundle([{ resourceType: 'MedicationRequest', id: 'med-1', status: 'active', medicationCodeableConcept: { text: 'Metformin 500 mg' }, authoredOn: '2026-01-01', dosageInstruction: [{ text: 'twice daily' }] },
          { resourceType: 'MedicationRequest', id: 'med-2', status: 'active', medicationReference: { reference: 'Medication/m1' }, authoredOn: '2026-02-01' }]));
      if (p === '/fhir/Condition') return json(bundle([{ resourceType: 'Condition', id: 'cond-1', code: { text: 'Prediabetes' }, recordedDate: '2026-01-01' }]));
      if (p === '/fhir/AllergyIntolerance') return json(bundle([{ resourceType: 'AllergyIntolerance', id: 'all-1', code: { text: 'Penicillin' } }]));
      if (p === '/fhir/Immunization') return json(bundle([{ resourceType: 'Immunization', id: 'imm-1', vaccineCode: { text: 'Influenza' }, occurrenceDateTime: '2025-10-01' }]));
      // Not offered at all: a 404 is recorded and the sync goes on.
      if (p === '/fhir/Device') return new Response('nope', { status: 404 });
      return json(bundle([]));
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  return { server, base: `${base}/fhir` };
}

/* --------------------------------------------------------------- the flow -- */

describe.skipIf(!configured())('records api', () => {
  let app, auth, fhir, patient, owner, orgId, patientId, connId;
  const tag = Date.now();

  async function signIn(email) {
    const url = new URL(await auth.createLoginLink(email));
    const res = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
    return res.headers.get('set-cookie').split(';')[0];
  }
  const client = (cookie) => async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };

  beforeAll(async () => {
    process.env.HEALTH_ALLOW_PRIVATE_URLS = '1';
    process.env.SMART_CLIENT_ID = 'tleehealth-test';
    await migrate({ log: () => {} });
    ({ app } = await import('../apps/web/src/app.js'));
    auth = await import('../apps/web/src/auth.js');
    fhir = fakeFhir();
    owner = client(await signIn(`rec-owner${tag}@example.com`));
    patient = client(await signIn(`rec-patient${tag}@example.com`));
    orgId = (await owner('POST', '/orgs', { name: `Records Practice ${tag}`, location: 'Main' })).body.org.id;
    patientId = (await owner('POST', `/orgs/${orgId}/people`, { user_type: 'patient', name: 'Ada Lin', email: `rec-patient${tag}@example.com` })).body.person.id;
  });
  afterAll(async () => {
    fhir?.server.stop(true);
    await close();
  });

  test('the provider directory always offers the sandbox', async () => {
    const r = await patient('GET', '/records/providers?q=sandbox');
    expect(r.status).toBe(200);
    expect(r.body.providers[0]).toMatchObject({ id: 'sandbox', ready: true });
  });

  test('connect, sign in at the provider, come back, import everything', async () => {
    const start = await patient('POST', '/records/connect', { fhir_base: fhir.base, name: 'Lin Clinic MyChart' });
    expect(start.status).toBe(201);
    connId = start.body.connection_id;
    const authorize = new URL(start.body.authorize_url);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('aud')).toBe(fhir.base);
    expect(authorize.searchParams.get('scope')).toContain('patient/*.read');

    const atProvider = await fetch(authorize, { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location'));
    const cb = await app.request(`/connect/callback${back.search}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`/portal/records?connected=${connId}`);

    // The callback started the import in the background; wait for it.
    let conn;
    for (let i = 0; i < 100; i++) {
      conn = (await patient('GET', `/records/connections/${connId}`)).body.connection;
      if (conn.status !== 'syncing' && conn.last_synced_at) break;
      await Bun.sleep(50);
    }
    expect(conn.status).toBe('active');
    expect(conn.records).toBe(16);
    expect(conn.files).toBe(4); // AVS pdf, inline note, inline radiology pdf, image
  });

  test('a reused state is refused', async () => {
    const r = await app.request('/connect/callback?state=nope&code=x');
    expect(r.headers.get('location')).toContain('error=');
  });

  test('the overview has personal information and every category', async () => {
    const r = await patient('GET', '/records');
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({ name: 'Ada Lin', birth_date: '1980-02-03', identifiers: [{ type: 'MRN', value: 'E12345' }] });
    const cats = Object.fromEntries(r.body.categories.map((c) => [c.key, c.count]));
    expect(cats).toMatchObject({ profile: 1, visits: 1, summaries: 1, notes: 2, labs: 3, imaging: 2, medications: 2, conditions: 1, allergies: 1, immunizations: 1 });
    expect(r.body.connections[0]).toMatchObject({ provider_name: 'Lin Clinic MyChart', status: 'active' });
    expect(r.body.practices).toEqual([{ org_id: orgId, org_name: `Records Practice ${tag}` }]);
  });

  test('labs came through the category fallback and both pages', async () => {
    const r = await patient('GET', '/records/items?category=labs');
    expect(r.body.items.map((i) => i.title).sort()).toEqual(['A1c', 'LDL', 'TSH']);
    expect(r.body.items.find((i) => i.title === 'A1c').detail).toBe('6.1 %');
  });

  test('a prescription that names its drug by reference gets the drug name', async () => {
    const meds = (await patient('GET', '/records/items?category=medications')).body.items.map((i) => i.title).sort();
    expect(meds).toEqual(['Lisinopril 10 mg', 'Metformin 500 mg']);
  });

  test('the after-visit summary PDF downloads byte for byte', async () => {
    const [avs] = (await patient('GET', '/records/items?category=summaries')).body.items;
    expect(avs.files).toHaveLength(1);
    const f = await patient('GET', `/records/files/${avs.files[0].id}`);
    expect(f.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(f.body).equals(PDF)).toBe(true);
  });

  test('an image served as a FHIR Binary resource is decoded', async () => {
    const items = (await patient('GET', '/records/items?category=imaging')).body.items;
    const media = items.find((i) => i.resource_type === 'Media');
    const f = await patient('GET', `/records/files/${media.files[0].id}`);
    expect(f.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(f.body).equals(PNG)).toBe(true);
  });

  test('another account cannot see these records', async () => {
    const other = client(await signIn(`rec-other${tag}@example.com`));
    expect((await other('GET', '/records')).body.total).toBe(0);
    expect((await other('GET', `/records/connections/${connId}`)).status).toBe(404);
    const [avs] = (await patient('GET', '/records/items?category=summaries')).body.items;
    expect((await other('GET', `/records/files/${avs.files[0].id}`)).status).toBe(404);
  });

  test('download everything: a zip with readable files and the raw FHIR', async () => {
    const r = await patient('GET', '/records/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    const z = Buffer.from(r.body);
    expect(z.subarray(0, 2).toString()).toBe('PK');
    for (const name of ['README.txt', 'fhir-bundle.json', 'Lin Clinic MyChart/patient.txt', 'Lin Clinic MyChart/labs.csv', 'Lin Clinic MyChart/records.md', 'Lin Clinic MyChart/fhir/labs.json', 'files/summaries/2026-09-01 AVS.pdf', 'files/imaging/2026-08-20 Rash photo.png'])
      expect(z.includes(Buffer.from(name))).toBe(true);
    expect(z.includes(PDF)).toBe(true);
    expect(z.includes(Buffer.from('E12345'))).toBe(true); // the MRN, in patient.txt
  });

  test('download everything as one FHIR Bundle with the files inlined', async () => {
    const r = await patient('GET', '/records/export?format=bundle');
    const b = r.body;
    expect(b.resourceType).toBe('Bundle');
    expect(b.entry.filter((e) => e.resource.resourceType === 'Binary')).toHaveLength(4);
    expect(b.entry.some((e) => e.resource.resourceType === 'Patient')).toBe(true);
  });

  test('the practice sees nothing until the patient shares, then sees it all', async () => {
    expect((await owner('GET', `/orgs/${orgId}/patients/${patientId}/records`)).body.total).toBe(0);
    const s = await patient('PUT', `/records/connections/${connId}/share`, { org_id: orgId, shared: true });
    expect(s.status).toBe(200);
    const r = await owner('GET', `/orgs/${orgId}/patients/${patientId}/records`);
    expect(r.body.total).toBe(16);
    expect(r.body.profile.name).toBe('Ada Lin');
    expect(r.body.connections[0].provider_name).toBe('Lin Clinic MyChart');
    const avs = r.body.items.find((i) => i.category === 'summaries');
    const f = await owner('GET', `/orgs/${orgId}/patients/${patientId}/records/files/${avs.files[0].id}`);
    expect(Buffer.from(f.body).equals(PDF)).toBe(true);
    const z = await owner('GET', `/orgs/${orgId}/patients/${patientId}/records/export`);
    expect(z.headers.get('content-type')).toBe('application/zip');

    const log = (await patient('GET', '/records/access')).body.access;
    expect(log.map((a) => a.action)).toEqual(expect.arrayContaining(['records.share', 'records.read', 'records.file', 'records.export']));
    expect(log.find((a) => a.action === 'records.read')).toMatchObject({ org_name: `Records Practice ${tag}`, you: false });

    await patient('PUT', `/records/connections/${connId}/share`, { org_id: orgId, shared: false });
    expect((await owner('GET', `/orgs/${orgId}/patients/${patientId}/records`)).body.total).toBe(0);
  });

  test('sharing with a practice you are not a patient of is refused', async () => {
    const other = (await owner('POST', '/orgs', { name: `Other ${tag}`, location: 'X' })).body.org.id;
    expect((await patient('PUT', `/records/connections/${connId}/share`, { org_id: other, shared: true })).status).toBe(404);
  });

  test('syncing again is idempotent', async () => {
    const r = await patient('POST', `/records/connections/${connId}/sync?wait=1`);
    expect(r.status).toBe(200);
    expect(r.body.files).toBe(0); // nothing new to fetch
    const conn = (await patient('GET', `/records/connections/${connId}`)).body.connection;
    expect(conn.records).toBe(16);
    expect(conn.files).toBe(4);
  });

  test('disconnecting deletes the connection and everything it imported', async () => {
    expect((await patient('DELETE', `/records/connections/${connId}`)).status).toBe(200);
    const r = await patient('GET', '/records');
    expect(r.body.total).toBe(0);
    expect(r.body.connections).toEqual([]);
  });
});
