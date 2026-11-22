// "Ask AI about my records": retrieval, the c0mpute client (house lane only),
// OAuth state handling, sealing, and who may ask about whose records.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { configured, close, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import * as c0 from '../apps/web/src/c0mpute.js';
import { extractText } from '../apps/web/src/doc-text.js';
import * as ask from '../apps/web/src/ask.js';
import { UnlockStore } from '../apps/web/src/token-vault.js';

/* ------------------------------------------------------- a fake c0mpute -- */

function fakeC0mpute() {
  const st = {
    mode: 'ok', // ok | 402 | 503 | 401 | nohouse | json
    nextAccount: { id: 'acct-1', name: 'Ada on c0mpute' },
    codes: new Map(),
    tokens: new Map(),
    revoked: [],
    asks: [],
    registered: 0,
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;
      const p = u.pathname;
      if (p === '/.well-known/oauth-authorization-server')
        return Response.json({ authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/api/oauth/token`, registration_endpoint: `${base}/api/oauth/register` });
      if (p === '/api/oauth/register') {
        const b = await req.json();
        if (b.token_endpoint_auth_method !== 'none') return Response.json({ error: 'public only' }, { status: 400 });
        st.registered++;
        return Response.json({ client_id: `c0c_test${st.registered}`, redirect_uris: b.redirect_uris }, { status: 201 });
      }
      if (p === '/oauth/authorize') {
        if (u.searchParams.get('scope') !== 'inference' || u.searchParams.get('code_challenge_method') !== 'S256') return new Response('bad', { status: 400 });
        const code = `c0a_${Math.random().toString(36).slice(2)}`;
        st.codes.set(code, { challenge: u.searchParams.get('code_challenge'), account: st.nextAccount });
        const back = new URL(u.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', u.searchParams.get('state'));
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (p === '/api/oauth/token') {
        const f = new URLSearchParams(await req.text());
        const c = st.codes.get(f.get('code'));
        const hash = new Bun.CryptoHasher('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!c || hash !== c.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        st.codes.delete(f.get('code'));
        const token = `c0k_${Math.random().toString(36).slice(2)}secret`;
        st.tokens.set(token, c.account);
        return Response.json({ access_token: token, token_type: 'Bearer', scope: 'inference' });
      }
      if (p === '/api/oauth/revoke') {
        const t = new URLSearchParams(await req.text()).get('token');
        st.revoked.push(t);
        st.tokens.delete(t);
        return new Response(null, { status: 200 });
      }
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const account = st.tokens.get(token);
      if (p === '/api/v1/me') {
        if (!account || st.mode === '401') return Response.json({ error: 'unauthorized' }, { status: 401 });
        return Response.json({ id: account.id, name: account.name, balance: { spendable_usd: '1.230000' } });
      }
      if (p === '/v1/chat/completions') {
        if (!account || st.mode === '401') return Response.json({ error: { message: 'bad key', code: 401 } }, { status: 401 });
        const body = await req.json();
        st.asks.push({ body, lane: req.headers.get('x-c0mpute-lane') });
        if (req.headers.get('x-c0mpute-lane') !== 'house' || body.c0mpute?.lane !== 'house') return Response.json({ error: { message: 'house only in this fake' } }, { status: 400 });
        if (st.mode === '402') return Response.json({ error: { message: 'balance', code: 402, reason: 'balance_required', top_up: 'https://c0mpute.com/checkout' } }, { status: 402 });
        if (st.mode === '503') return Response.json({ error: { message: 'house down', code: 503, reason: 'house_lane_unavailable' } }, { status: 503 });
        const tags = [...body.messages[1].content.matchAll(/\[(R\d+)\]/g)].map((m) => m[1]);
        const answer = `Your last A1c was 6.1 %, a little above the 4.0-5.6 range [${tags[0]}]. Ask your clinician what it means for you [R999].`;
        if (st.mode === 'json')
          return Response.json({ model: 'house-model', choices: [{ message: { content: answer } }] }, { headers: { 'x-c0mpute-lane': 'house' } });
        const sse = [
          ': keepalive',
          `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}`,
          ': status {"queued":true}',
          `data: ${JSON.stringify({ model: 'house-model', choices: [{ delta: { content: answer.slice(0, 20) } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(20) } }] })}`,
          `data: ${JSON.stringify({ object: 'c0mpute.house', x_c0mpute: { lane: 'house', model: 'qwen-house', operator: 'Profullstack', estimated_cost_usd: 0.0012 } })}`,
          'data: [DONE]',
          '',
        ].join('\n\n');
        const headers = { 'content-type': 'text/event-stream' };
        if (st.mode !== 'nohouse') headers['x-c0mpute-lane'] = 'house';
        return new Response(sse, { headers });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { st, server, base: `http://127.0.0.1:${server.port}` };
}

/* ----------------------------------------------------------------- units -- */

const rec = (id, category, title, recorded_on, resource = {}) => ({ id, category, title, recorded_on, resource_type: resource.resourceType ?? 'Observation', resource });

describe('ask units', () => {
  const rows = [
    rec('a1c-old', 'labs', 'Hemoglobin A1c', '2023-01-02', { resourceType: 'Observation', valueQuantity: { value: 5.9, unit: '%' } }),
    rec('a1c-new', 'labs', 'Hemoglobin A1c', '2026-03-02', { resourceType: 'Observation', valueQuantity: { value: 6.1, unit: '%' }, referenceRange: [{ low: { value: 4 }, high: { value: 5.6, unit: '%' } }] }),
    rec('ldl', 'labs', 'LDL cholesterol', '2026-03-02', { resourceType: 'Observation', valueQuantity: { value: 99, unit: 'mg/dL' } }),
    rec('met', 'medications', 'Metformin 500 mg', '2026-01-01', { resourceType: 'MedicationRequest', status: 'active', dosageInstruction: [{ text: 'twice daily' }] }),
    rec('pen', 'allergies', 'Penicillin', null, { resourceType: 'AllergyIntolerance' }),
    rec('flu', 'immunizations', 'Influenza', '2025-10-01', { resourceType: 'Immunization' }),
    rec('pre', 'conditions', 'Prediabetes', '2026-01-01', { resourceType: 'Condition' }),
  ];
  for (const r of rows) r._summary = ask.summarize(r);

  test('terms and intents', () => {
    expect(ask.terms('What was my last A1c?')).toEqual(['a1c']);
    expect(ask.intents('what medications am I taking')).toEqual(['medications']);
    expect(ask.intents('my blood pressure and cholesterol')).toEqual(expect.arrayContaining(['labs', 'vitals']));
  });

  test('a lab question ranks the newest matching lab first and leaves unrelated records out', () => {
    const picked = ask.select(rows, 'What was my latest A1c?');
    expect(picked[0].id).toBe('a1c-new');
    expect(picked.map((r) => r.id)).toContain('a1c-old');
    expect(picked.map((r) => r.id)).not.toContain('flu');
    expect(picked.map((r) => r.id)).not.toContain('pen');
  });

  test('a medication question selects medications', () => {
    const picked = ask.select(rows, 'Which medications am I on?');
    expect(picked[0].id).toBe('met');
    expect(picked.map((r) => r.id)).not.toContain('flu');
  });

  test('a general question gets a balanced overview', () => {
    const ids = ask.select(rows, 'Give me an overview').map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['pre', 'met', 'pen', 'a1c-new']));
  });

  test('the context is capped', () => {
    const many = Array.from({ length: 2000 }, (_, i) => {
      const r = rec(`x${i}`, 'labs', `Glucose ${i}`, '2026-01-01', { resourceType: 'Observation', valueQuantity: { value: i, unit: 'mg/dL' } });
      r._summary = ask.summarize(r);
      return r;
    });
    const picked = ask.select(many, 'glucose results', { maxChars: 5000 });
    expect(picked.reduce((n, r) => n + r._summary.length + 12, 0)).toBeLessThanOrEqual(5000);
    expect(picked.length).toBeGreaterThan(10);
  });

  test('summaries carry the value and reference range, and no identifiers', () => {
    const s = ask.summarize(rows[1]);
    expect(s).toContain('6.1 %');
    expect(s).toContain('reference range 4 to 5.6 %');
    const p = ask.summarize({ category: 'profile', title: 'Ada Lin', resource: { resourceType: 'Patient', gender: 'female', birthDate: '1980-02-03', name: [{ text: 'Ada Lin' }], identifier: [{ value: 'MRN1' }] } });
    expect(p).not.toContain('Ada');
    expect(p).not.toContain('MRN1');
  });

  test('citations the model invented are removed', () => {
    const r = ask.checkCitations('Value [R1]. Made up [R9]. Both [R2, R7].<think>x</think>', ['R1', 'R2']);
    expect(r.text).toBe('Value [R1]. Made up. Both [R2].');
    expect(r.cited).toEqual(['R1', 'R2']);
  });

  test('the system prompt keeps the safety rules', () => {
    for (const s of ['ONLY from the provided records', 'Never diagnose', '911', '988', 'clinician', 'not medical advice'])
      expect(ask.SYSTEM_PROMPT.toLowerCase()).toContain(s.toLowerCase());
  });

  test('text out of files: PDF (plain, Flate, ToUnicode), HTML, images skipped', () => {
    const content = 'BT /F1 12 Tf 72 700 Td (Hemoglobin A1c 6.1 %) Tj 0 -14 Td [(Glucose) -300 (101 mg/dL)] TJ ET';
    const pdf = (len, extra = '') =>
      Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page /Resources << /Font << /F1 3 0 R >> >> /Contents 2 0 R >> endobj\n2 0 obj << /Length ${len}${extra} >>\nstream\n`, 'latin1');
    const plain = Buffer.concat([pdf(content.length), Buffer.from(`${content}\nendstream\nendobj\n3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n%%EOF\n`)]);
    expect(extractText(plain, 'application/pdf').text).toContain('Hemoglobin A1c 6.1 %\nGlucose 101 mg/dL');

    const z = deflateSync(Buffer.from(content));
    const flate = Buffer.concat([pdf(z.length, ' /Filter /FlateDecode'), z, Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
    expect(extractText(flate, 'application/pdf').text).toContain('Glucose 101 mg/dL');

    // A Type0 font with a ToUnicode map: glyph ids 0001.. map to letters.
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0041> <0002> <0031> endbfchar 1 beginbfrange <0003> <0005> <0063> endbfrange endcmap end end';
    const body = 'BT /F2 10 Tf <00010002000300040005> Tj ET';
    const cid = Buffer.from(
      `%PDF-1.5\n1 0 obj << /Resources << /Font << /F2 4 0 R >> >> /Contents 2 0 R >> endobj\n2 0 obj << /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n` +
        `4 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 5 0 R >> endobj\n5 0 obj << /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n%%EOF\n`,
      'latin1',
    );
    expect(extractText(cid, 'application/pdf').text).toBe('A1cde');

    expect(extractText(Buffer.from('<p>LDL <b>99</b></p><script>x()</script>'), 'text/html').text).toBe('LDL 99');
    expect(extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toEqual({ text: null, reason: 'image (not read)' });
    expect(extractText(Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf').text).toBeNull();
  });
});

/* ------------------------------------------------------ c0mpute client -- */

describe('c0mpute client: house lane only', () => {
  let fake;
  const prev = process.env.C0MPUTE_URL;
  beforeAll(() => {
    fake = fakeC0mpute();
    process.env.C0MPUTE_URL = fake.base;
    fake.st.tokens.set('c0k_unit', { id: 'acct-unit', name: 'unit' });
  });
  afterAll(() => {
    fake.server.stop(true);
    if (prev === undefined) delete process.env.C0MPUTE_URL;
    else process.env.C0MPUTE_URL = prev;
  });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'Records:\n[R1] lab\nQuestion: q' }];

  test('streams the answer, ignores comment lines, keeps the house meta', async () => {
    fake.st.mode = 'ok';
    const r = await c0.askHouse('c0k_unit', msgs);
    expect(r.text).toContain('Your last A1c was 6.1 %');
    expect(r.meta).toMatchObject({ lane: 'house', model: 'qwen-house' });
    const sent = fake.st.asks.at(-1);
    expect(sent.lane).toBe('house');
    expect(sent.body).toMatchObject({ stream: true, temperature: 0.2, c0mpute: { lane: 'house' } });
    expect(sent.body.model).toBeUndefined();
  });

  test('a non-streamed house answer is accepted', async () => {
    fake.st.mode = 'json';
    expect((await c0.askHouse('c0k_unit', msgs)).text).toContain('6.1 %');
  });

  test('402 means add funds, with the top-up link (no free tier)', async () => {
    fake.st.mode = '402';
    const e = await c0.askHouse('c0k_unit', msgs).catch((x) => x);
    expect(e).toBeInstanceOf(c0.C0mputeError);
    expect(e).toMatchObject({ status: 402, reason: 'balance_required', top_up: 'https://c0mpute.com/checkout' });
  });

  test('503 fails closed: no retry anywhere else', async () => {
    fake.st.mode = '503';
    const before = fake.st.asks.length;
    const e = await c0.askHouse('c0k_unit', msgs).catch((x) => x);
    expect(e).toMatchObject({ status: 503, reason: 'house_lane_unavailable' });
    expect(fake.st.asks.length).toBe(before + 1);
  });

  test('a 200 without the house-lane header is refused', async () => {
    fake.st.mode = 'nohouse';
    expect(await c0.askHouse('c0k_unit', msgs).catch((x) => x)).toMatchObject({ status: 502, reason: 'not_house' });
  });

  test('401 means the connection is no longer valid', async () => {
    fake.st.mode = '401';
    expect(await c0.askHouse('c0k_unit', msgs).catch((x) => x)).toMatchObject({ status: 401, reason: 'invalid_token' });
    fake.st.mode = 'ok';
  });
});

/* --------------------------------------------------------- through the API -- */

describe.skipIf(!configured())('ask api', () => {
  let app, auth, fake;
  const tag = Date.now();
  const prevUrl = process.env.C0MPUTE_URL;

  async function signIn(email) {
    const url = new URL(await auth.createLoginLink(email));
    const res = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
    return res.headers.get('set-cookie').split(';')[0];
  }
  const client = (cookie, extra = {}) => async (method, path, body) => {
    const isForm = body instanceof FormData;
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...extra, ...(!isForm ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    expect(text).not.toContain('c0k_'); // the key never leaves the server
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  /** Connect c0mpute as this person through the real routes and the fake c0mpute. */
  async function connectAs(cookie, account) {
    fake.st.nextAccount = account;
    const start = await client(cookie)('POST', '/c0mpute/connect', { unlock_ttl: '1h' });
    expect(start.status).toBe(200);
    const authz = await fetch(start.body.authorize_url, { redirect: 'manual' });
    const back = new URL(authz.headers.get('location'));
    const cb = await app.request(`${back.pathname}${back.search}`, { headers: { cookie } });
    return { location: cb.headers.get('location'), callback: `${back.pathname}${back.search}` };
  }

  let patientCookie, ownerCookie, patient, owner, orgId, patientPersonId, connId, ownerUserId;

  beforeAll(async () => {
    fake = fakeC0mpute();
    process.env.C0MPUTE_URL = fake.base;
    c0._resetDiscovery();
    ask._useSessions(new UnlockStore({ useTimers: false }));
    await migrate({ log: () => {} });
    ({ app } = await import('../apps/web/src/app.js'));
    auth = await import('../apps/web/src/auth.js');
    patientCookie = await signIn(`ask-patient${tag}@example.com`);
    ownerCookie = await signIn(`ask-owner${tag}@example.com`);
    patient = client(patientCookie);
    owner = client(ownerCookie);
    ownerUserId = (await owner('GET', '/me')).body.user.id;
    orgId = (await owner('POST', '/orgs', { name: `Ask Practice ${tag}`, location: 'Main' })).body.org.id;
    patientPersonId = (await owner('POST', `/orgs/${orgId}/people`, { user_type: 'patient', name: 'Ada Lin', email: `ask-patient${tag}@example.com` })).body.person.id;
    const form = new FormData();
    form.append('files', new File(['Lab report\nHemoglobin A1c 6.1 % (ref 4.0-5.6)\nCollected 2026-03-02'], 'A1c-lab.txt', { type: 'text/plain' }));
    form.append('files', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'rash-photo.png', { type: 'image/png' }));
    const up = await patient('POST', '/records/import', form);
    expect(up.status).toBe(201);
    connId = up.body.connection_id;
  }, 30_000);
  afterAll(async () => {
    ask._useSessions(null);
    fake.server.stop(true);
    if (prevUrl === undefined) delete process.env.C0MPUTE_URL;
    else process.env.C0MPUTE_URL = prevUrl;
    await close();
  });

  test('asking before connecting c0mpute says to connect', async () => {
    const r = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('c0mpute_not_connected');
    expect((await patient('GET', '/c0mpute')).body).toMatchObject({ connected: false, status: 'none', top_up: 'https://c0mpute.com/checkout' });
  });

  test('connecting is browser-only: an API key cannot start it', async () => {
    const r = await client('', { authorization: 'Bearer th_live_nope' })('POST', '/c0mpute/connect', {});
    expect(r.status).toBe(403);
  });

  test('connect: PKCE at c0mpute, bound to the c0mpute account id; the state is single use', async () => {
    const { location, callback } = await connectAs(patientCookie, { id: `acct-patient-${tag}`, name: 'Ada on c0mpute' });
    expect(location).toBe('/portal/records?c0mpute=connected');
    const replay = await app.request(callback, { headers: { cookie: patientCookie } });
    expect(replay.headers.get('location')).toContain('c0mpute_error=');
    const s = (await patient('GET', '/c0mpute')).body;
    expect(s).toMatchObject({ connected: true, status: 'active', name: 'Ada on c0mpute', account_id: `acct-patient-${tag}`, balance: { spendable_usd: '1.230000' } });
    const [row] = await db()`select token_sealed from c0mpute_connections where account_id = ${`acct-patient-${tag}`}`;
    expect(JSON.stringify(row.token_sealed)).not.toContain('c0k_');
    expect(fake.st.registered).toBe(1);
  });

  test('a state started by one account cannot be finished by another', async () => {
    fake.st.nextAccount = { id: `acct-x-${tag}`, name: 'x' };
    const start = await patient('POST', '/c0mpute/connect', {});
    const back = new URL((await fetch(start.body.authorize_url, { redirect: 'manual' })).headers.get('location'));
    const cb = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: ownerCookie } });
    expect(cb.headers.get('location')).toContain('c0mpute_error=');
    expect((await owner('GET', '/c0mpute')).body.connected).toBe(false);
  });

  test('the patient asks: answer from the records, cited, only valid tags, audited without the text', async () => {
    fake.st.mode = 'ok';
    const r = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(r.status).toBe(200);
    expect(r.body.answer).toContain('6.1 %');
    expect(r.body.answer).not.toContain('R999');
    expect(r.body.citations).toHaveLength(1);
    expect(r.body.citations[0]).toMatchObject({ tag: 'R1', title: 'A1c-lab.txt', category: 'labs' });
    expect(r.body.citations[0].href).toBe(`/portal/records?record=${r.body.citations[0].record_id}`);
    expect(r.body).toMatchObject({ lane: 'house', model: 'qwen-house', cost_usd: 0.0012 });
    expect(r.body.disclaimer).toContain('Not medical advice');
    // The file text reached the house lane; the image was listed as not read.
    const sent = fake.st.asks.at(-1).body.messages[1].content;
    expect(sent).toContain('Hemoglobin A1c 6.1 %');
    expect(fake.st.asks.at(-1).body.messages[0].content).toContain('Answer ONLY from the provided records');
    const [a] = await db()`select * from audit_log where action = 'records.ask.self' order by id desc limit 1`;
    expect(a.detail.records).toContain(r.body.citations[0].record_id);
    expect(a.detail).toMatchObject({ lane: 'house', outcome: 'answered', model: 'qwen-house' });
    expect(JSON.stringify(a)).not.toContain('A1c');
  });

  test('an empty balance is a 402 with the top-up link; the house node down is a 503', async () => {
    fake.st.mode = '402';
    const p = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(p.status).toBe(402);
    expect(p.body).toMatchObject({ reason: 'balance_required', top_up: 'https://c0mpute.com/checkout' });
    fake.st.mode = '503';
    const d = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(d.status).toBe(503);
    expect(d.body.reason).toBe('house_lane_unavailable');
    fake.st.mode = 'nohouse';
    expect((await patient('POST', '/records/ask', { question: 'What was my last A1c?' })).status).toBe(502);
    fake.st.mode = 'ok';
  });

  test('a practice sees nothing without a share (403), and another practice is refused', async () => {
    await connectAs(ownerCookie, { id: `acct-owner-${tag}`, name: 'Owner on c0mpute' });
    const r = await owner('POST', '/records/ask', { question: 'What was the last A1c?', patient_id: patientPersonId });
    expect(r.status).toBe(403);
    const strangerCookie = await signIn(`ask-stranger${tag}@example.com`);
    const stranger = client(strangerCookie);
    await stranger('POST', '/orgs', { name: `Other Practice ${tag}`, location: 'Main' });
    const s = await stranger('POST', '/records/ask', { question: 'What was the last A1c?', patient_id: patientPersonId });
    expect([403, 404]).toContain(s.status);
    // The patient record is not theirs either way.
    expect(s.body.answer).toBeUndefined();
  });

  test('after the patient shares, the practice asks with ITS OWN c0mpute; the patient sees it in access', async () => {
    expect((await patient('PUT', `/records/connections/${connId}/share`, { org_id: orgId, shared: true })).status).toBe(200);
    const before = fake.st.asks.length;
    const r = await owner('POST', '/records/ask', { question: 'What was the last A1c?', patient_id: patientPersonId });
    expect(r.status).toBe(200);
    expect(r.body.citations[0].href).toBe(`/app/patients/${patientPersonId}`);
    expect(fake.st.asks.length).toBe(before + 1);
    const [a] = await db()`select * from audit_log where action = 'records.ask' order by id desc limit 1`;
    expect(a).toMatchObject({ org_id: orgId, user_id: ownerUserId, subject: patientPersonId });
    expect(a.detail.c0mpute_account).toBe(`acct-owner-${tag}`);
    const access = (await patient('GET', '/records/access')).body.access;
    expect(access.some((x) => x.action === 'records.ask')).toBe(true);
  });

  test('one c0mpute account cannot be bound to two tleehealth accounts', async () => {
    const otherCookie = await signIn(`ask-other${tag}@example.com`);
    const { location } = await connectAs(otherCookie, { id: `acct-patient-${tag}`, name: 'Ada on c0mpute' });
    expect(new URL(location, 'http://x').searchParams.get('c0mpute_error')).toContain('already connected to another tleehealth account');
    expect(fake.st.revoked.length).toBeGreaterThan(0);
  });

  test('a restart locks the key: reconnect to unlock', async () => {
    ask._useSessions(new UnlockStore({ useTimers: false }));
    expect((await patient('GET', '/c0mpute')).body.status).toBe('locked');
    const r = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(r.status).toBe(423);
    expect(r.body.reason).toBe('c0mpute_locked');
    await connectAs(patientCookie, { id: `acct-patient-${tag}`, name: 'Ada on c0mpute' });
    expect((await patient('GET', '/c0mpute')).body.status).toBe('active');
  });

  test('a key c0mpute no longer accepts marks the connection invalid', async () => {
    fake.st.mode = '401';
    const r = await patient('POST', '/records/ask', { question: 'What was my last A1c?' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('c0mpute_reconnect');
    fake.st.mode = 'ok';
    expect((await patient('GET', '/c0mpute')).body.status).toBe('invalid');
  });

  test('disconnect revokes at c0mpute and deletes the key', async () => {
    await connectAs(patientCookie, { id: `acct-patient-${tag}`, name: 'Ada on c0mpute' });
    const n = fake.st.revoked.length;
    expect((await patient('DELETE', '/c0mpute')).status).toBe(200);
    expect(fake.st.revoked.length).toBe(n + 1);
    expect((await patient('GET', '/c0mpute')).body.connected).toBe(false);
    const rows = await db()`select 1 from c0mpute_connections where account_id = ${`acct-patient-${tag}`}`;
    expect(rows).toHaveLength(0);
  });
});
