// End to end through /api/v1 against a real Postgres (DATABASE_URL; CI provides one).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configured, close, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

const { app } = configured() ? await import('../apps/web/src/app.js') : { app: null };
const auth = configured() ? await import('../apps/web/src/auth.js') : null;

/** Sign in through the real magic-link route and return a cookie for requests. */
async function signIn(email) {
  const url = new URL(await auth.createLoginLink(email));
  const res = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
  expect(res.status).toBe(302);
  return res.headers.get('set-cookie').split(';')[0];
}

function client(cookie) {
  const call = async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

describe.skipIf(!configured())('api', () => {
  const tag = Date.now();
  const ownerEmail = `owner${tag}@example.com`;
  const staffEmail = `staff${tag}@example.com`;
  const patientEmail = `patient${tag}@example.com`;
  let owner, staff, patient, orgId, locId, patientId, staffId, apptId, medId;

  beforeAll(async () => {
    await migrate({ log: () => {} });
    owner = client(await signIn(ownerEmail));
  });
  afterAll(() => close());

  test('signed out is 401', async () => {
    expect((await client('').get('/me')).status).toBe(401);
  });

  test('an expired or reused link goes back to sign-in', async () => {
    const res = await app.request('/auth/magic?t=nope');
    expect(res.headers.get('location')).toBe('/signin?error=expired');
  });

  test('owner creates a practice with a location', async () => {
    const r = await owner.post('/orgs', { name: `Lin Family Practice ${tag}`, location: 'Mission St' });
    expect(r.status).toBe(201);
    orgId = r.body.org.id;
    const me = await owner.get('/me');
    expect(me.body.orgs.find((o) => o.id === orgId).user_type).toBe('owner');
    const org = await owner.get(`/orgs/${orgId}`);
    expect(org.body.locations).toHaveLength(1);
    locId = org.body.locations[0].id;
    expect(org.body.billing.seats).toBe(1);
    expect(org.body.billing.monthly_cents).toBe(1000);
    expect(org.body.billing.active).toBe(true); // trial
  });

  test('one account can own several practices', async () => {
    const r = await owner.post('/orgs', { name: `Second Practice ${tag}` });
    expect(r.status).toBe(201);
    expect((await owner.get('/me')).body.orgs.length).toBeGreaterThanOrEqual(2);
  });

  test('owner adds a location', async () => {
    const r = await owner.post(`/orgs/${orgId}/locations`, { name: 'Valencia', timezone: 'America/Los_Angeles' });
    expect(r.status).toBe(201);
  });

  test('owner adds staff; they are billed and get in on sign-in', async () => {
    const r = await owner.post(`/orgs/${orgId}/people`, { user_type: 'staff', name: 'Front Desk', email: staffEmail });
    expect(r.status).toBe(201);
    staffId = r.body.person.id;
    staff = client(await signIn(staffEmail));
    const me = await staff.get('/me');
    expect(me.body.orgs.map((o) => o.id)).toContain(orgId);
    expect((await owner.get(`/orgs/${orgId}`)).body.billing.seats).toBe(2);
  });

  test('staff cannot add team or prescribe', async () => {
    expect((await staff.post(`/orgs/${orgId}/people`, { user_type: 'provider', email: `x${tag}@example.com` })).status).toBe(403);
  });

  test('staff adds a lead and a patient; neither is billed', async () => {
    const lead = await staff.post(`/orgs/${orgId}/people`, { user_type: 'lead', name: 'Sam Weller', phone: '+15555550100', source: 'newsletter' });
    expect(lead.status).toBe(201);
    const p = await staff.post(`/orgs/${orgId}/people`, { user_type: 'patient', name: 'Jin Park', email: patientEmail, dob: '1980-04-02' });
    expect(p.status).toBe(201);
    patientId = p.body.person.id;
    expect((await owner.get(`/orgs/${orgId}`)).body.billing.seats).toBe(2);
    const dup = await staff.post(`/orgs/${orgId}/people`, { user_type: 'patient', email: patientEmail });
    expect(dup.status).toBe(409);
  });

  test('booking a lead turns them into a patient', async () => {
    const leads = (await staff.get(`/orgs/${orgId}/people?type=lead`)).body.people;
    const lead = leads.find((l) => l.name === 'Sam Weller');
    const r = await staff.post(`/orgs/${orgId}/appointments`, {
      patient_id: lead.id,
      location_id: locId,
      starts_at: '2030-01-02T18:00:00Z',
      mode: 'video',
      reason: 'New patient',
    });
    expect(r.status).toBe(201);
    const pts = (await staff.get(`/orgs/${orgId}/people?type=patient`)).body.people;
    expect(pts.map((p) => p.id)).toContain(lead.id);
  });

  test('schedule, reschedule and status changes', async () => {
    const r = await staff.post(`/orgs/${orgId}/appointments`, {
      patient_id: patientId,
      location_id: locId,
      starts_at: '2030-01-02T17:00:00Z',
      minutes: 20,
      reason: 'Diabetes follow-up',
    });
    expect(r.status).toBe(201);
    apptId = r.body.appointment.id;
    const day = await staff.get(`/orgs/${orgId}/appointments?date=2030-01-02`);
    expect(day.body.appointments.map((a) => a.id)).toContain(apptId);
    expect(day.body.appointments[0].patient).toBeTruthy();
    expect((await staff.patch(`/orgs/${orgId}/appointments/${apptId}`, { status: 'confirmed' })).body.appointment.status).toBe('confirmed');
    expect((await staff.patch(`/orgs/${orgId}/appointments/${apptId}`, { status: 'bogus' })).status).toBe(400);
    const sched = await staff.get(`/schedule?date=2030-01-02&org=${orgId}`);
    expect(sched.body.appointments.length).toBe(2);
  });

  test('owner prescribes; patient requests a refill in the portal; owner approves', async () => {
    const m = await owner.post(`/orgs/${orgId}/patients/${patientId}/medications`, { name: 'Metformin', dose: '500 mg', directions: 'twice daily', refills: 2 });
    expect(m.status).toBe(201);
    medId = m.body.medication.id;
    expect((await staff.post(`/orgs/${orgId}/patients/${patientId}/medications`, { name: 'X' })).status).toBe(403);

    patient = client(await signIn(patientEmail));
    const portal = await patient.get('/portal');
    expect(portal.body.practices).toHaveLength(1);
    expect(portal.body.practices[0].medications[0].name).toBe('Metformin');
    const rr = await patient.post('/portal/refills', { medication_id: medId });
    expect(rr.status).toBe(201);
    // A second tap is the same request.
    expect((await patient.post('/portal/refills', { medication_id: medId })).body.refill.id).toBe(rr.body.refill.id);

    const queue = await staff.get(`/orgs/${orgId}/refills`);
    expect(queue.body.refills).toHaveLength(1);
    expect((await staff.post(`/orgs/${orgId}/refills/${rr.body.refill.id}/approve`)).status).toBe(403);
    expect((await owner.post(`/orgs/${orgId}/refills/${rr.body.refill.id}/approve`)).body.refill.status).toBe('approved');
    const chart = await owner.get(`/orgs/${orgId}/patients/${patientId}`);
    expect(chart.body.medications[0].refills_left).toBe(1);
  });

  test('labs are flagged, hidden until released, then shown to the patient', async () => {
    const l = await staff.post(`/orgs/${orgId}/patients/${patientId}/labs`, { test_name: 'A1C', value: '7.9', unit: '%', ref_high: '5.7' });
    expect(l.status).toBe(201);
    expect(l.body.lab.flag).toBe('high');
    expect((await patient.get('/portal')).body.practices[0].labs).toHaveLength(0);
    expect((await owner.post(`/orgs/${orgId}/labs/${l.body.lab.id}/release`)).status).toBe(200);
    expect((await patient.get('/portal')).body.practices[0].labs[0].flag).toBe('high');
  });

  test('a visit summary is drafted, signed, locked and shown to the patient', async () => {
    const s = await owner.put(`/orgs/${orgId}/appointments/${apptId}/summary`, { diagnosis: 'Type 2 diabetes', instructions: 'Walk daily', follow_up_on: '2030-04-01' });
    expect(s.status).toBe(200);
    const today = await owner.get(`/orgs/${orgId}/today?date=2030-01-02`);
    expect(today.body.needs.summaries.length).toBe(1);
    expect((await owner.post(`/orgs/${orgId}/summaries/${s.body.summary.id}/sign`)).body.summary.status).toBe('signed');
    expect((await owner.put(`/orgs/${orgId}/appointments/${apptId}/summary`, { diagnosis: 'changed' })).status).toBe(409);
    const portal = await patient.get('/portal');
    expect(portal.body.practices[0].summaries[0].diagnosis).toBe('Type 2 diabetes');
    const chart = await owner.get(`/orgs/${orgId}/patients/${patientId}`);
    expect(chart.body.appointments.find((a) => a.id === apptId).status).toBe('completed');
  });

  test('patients cannot reach the practice side, and outsiders see nothing', async () => {
    expect((await patient.get(`/orgs/${orgId}/people`)).status).toBe(403);
    const stranger = client(await signIn(`stranger${tag}@example.com`));
    expect((await stranger.get(`/orgs/${orgId}`)).status).toBe(404);
    expect((await stranger.get('/portal')).body.practices).toHaveLength(0);
  });

  test('chart reads are audit-logged', async () => {
    const [{ n }] = await db()`select count(*)::int as n from audit_log where org_id = ${orgId} and action = 'patient.read'`;
    expect(n).toBeGreaterThan(0);
  });

  test('an unpaid practice past its trial is read-only', async () => {
    await db()`update organizations set created_at = now() - interval '30 days' where id = ${orgId}`;
    expect((await staff.post(`/orgs/${orgId}/people`, { user_type: 'lead', name: 'Late' })).status).toBe(402);
    expect((await staff.get(`/orgs/${orgId}/people`)).status).toBe(200);
    await db()`update org_billing set paid_through = now() + interval '1 month' where org_id = ${orgId}`;
    expect((await staff.post(`/orgs/${orgId}/people`, { user_type: 'lead', name: 'Paid' })).status).toBe(201);
  });

  test('a signed CoinPay webhook adds one month, once', async () => {
    const { createHmac } = await import('node:crypto');
    const { configurePayments } = await import('../packages/payments/src/index.js');
    configurePayments({ sql: db(), coinpay: { enabled: true, webhookSecret: 'whsec_test' }, siteUrl: 'http://x' });
    const [u] = await db()`select id from users where lower(email) = ${ownerEmail}`;
    const ref = `pay_${tag}`;
    await db()`insert into payments (user_id, provider, provider_ref, amount_cents, status) values (${u.id}, 'coinpay', ${ref}, 2000, 'pending')`;
    await db()`update org_billing set paid_through = null where org_id = ${orgId}`;
    // CoinPay's real shape: the top-level id is the EVENT; the payment is under data.
    const body = JSON.stringify({
      id: `evt_${ref}_1`,
      type: 'payment.confirmed',
      data: { payment_id: ref, status: 'confirmed', amount: 20, metadata: { org_id: orgId, user_id: u.id } },
    });
    const send = (raw, secret = 'whsec_test') => {
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
      return app.request('/webhooks/coinpay', { method: 'POST', body: raw, headers: { 'x-coinpay-signature': `t=${t},v1=${v1}` } });
    };
    expect((await send(body, 'wrong')).status).toBe(401);
    expect((await send(body)).status).toBe(200);
    const [a] = await db()`select paid_through from org_billing where org_id = ${orgId}`;
    expect(new Date(a.paid_through) > new Date(Date.now() + 25 * 86400_000)).toBe(true);
    await send(body); // CoinPay re-delivers
    const [b] = await db()`select paid_through from org_billing where org_id = ${orgId}`;
    expect(new Date(b.paid_through).getTime()).toBe(new Date(a.paid_through).getTime());
  });

  test('api keys work as bearer auth', async () => {
    const k = await owner.post('/keys', { name: 'cli' });
    expect(k.body.key).toMatch(/^th_live_/);
    const res = await app.request('/api/v1/me', { headers: { authorization: `Bearer ${k.body.key}` } });
    expect((await res.json()).user.email).toBe(ownerEmail);
  });
});
