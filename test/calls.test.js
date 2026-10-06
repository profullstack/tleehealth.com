// AI calls end to end against a real Postgres, with Telnyx replaced by a fake fetch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { close, configured, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

const calls = await import('../apps/web/src/calls.js');

describe('call helpers', () => {
  test('e164 normalises US numbers and rejects junk', () => {
    expect(calls.e164('(415) 555-0101')).toBe('+14155550101');
    expect(calls.e164('1-415-555-0101')).toBe('+14155550101');
    expect(calls.e164('+44 20 7946 0958')).toBe('+442079460958');
    expect(calls.e164('555-0101')).toBeNull();
    expect(calls.e164('')).toBeNull();
  });
  test('calling window is checked in the location time zone', () => {
    const t = new Date('2030-01-02T17:00:00Z'); // 9:00 in Los Angeles
    expect(calls.insideWindow(t, 'America/Los_Angeles', 9, 19)).toBe(true);
    expect(calls.insideWindow(t, 'America/New_York', 9, 12)).toBe(false); // noon there
    const open = calls.nextWindowOpen(new Date('2030-01-02T04:00:00Z'), 'America/Los_Angeles', 9);
    expect(open.toISOString()).toBe('2030-01-02T17:00:00.000Z');
  });
  test('the agent always says it is automated and never gives medical advice', () => {
    const c = { kind: 'reminder', patient_name: 'Jin Park', org_name: 'Lin Family', mode: 'video', starts_at: '2030-01-02T17:00:00Z', tz: 'America/Los_Angeles', provider: 'Dr. Lin' };
    expect(calls.greeting(c)).toContain('automated assistant for Lin Family');
    expect(calls.instructions(c)).toContain('Never give medical advice');
    expect(calls.outcomeSchema(c).properties.decision.enum).toContain('reschedule');
    expect(calls.outcomeSchema({ ...c, kind: 'followup', appt_status: 'completed' }).properties.feeling).toBeTruthy();
  });
});

describe.skipIf(!configured())('calls', () => {
  const tag = Date.now();
  const { app } = { app: null };
  let web, auth, orgId, cookie, patientId, noConsentId, apptId;
  const sent = []; // Telnyx commands the code issued
  let dials = 0;
  const realFetch = globalThis.fetch;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

  async function signIn(email) {
    const url = new URL(await auth.createLoginLink(email));
    const res = await web.request(`/auth/magic?t=${url.searchParams.get('t')}`);
    return res.headers.get('set-cookie').split(';')[0];
  }
  const api = async (method, path, body) => {
    const res = await web.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  /** Deliver a Telnyx event the way Telnyx does: signed, raw body. */
  async function deliver(event_type, payload, { badSig = false } = {}) {
    const raw = JSON.stringify({ data: { record_type: 'event', event_type, id: crypto.randomUUID(), payload } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64');
    return web.request('/webhooks/telnyx', {
      method: 'POST',
      body: raw,
      headers: { 'telnyx-signature-ed25519': badSig ? sig.replace(/^./, 'A') : sig, 'telnyx-timestamp': ts },
    });
  }
  const cs = (callId) => Buffer.from(JSON.stringify({ call_id: callId })).toString('base64');

  beforeAll(async () => {
    Object.assign(process.env, {
      TELNYX_API_KEY: 'KEY_test',
      TELNYX_CONNECTION_ID: 'conn_test',
      TELNYX_FROM_NUMBER: '+14155550000',
      TELNYX_PUBLIC_KEY: rawPub,
    });
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith('https://api.telnyx.com/')) {
        const body = init.body ? JSON.parse(init.body) : {};
        sent.push({ path: String(url).replace('https://api.telnyx.com/v2', ''), body });
        const data = String(url).endsWith('/calls') ? { call_control_id: `v3:cc_${++dials}` } : { result: 'ok' };
        return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    };
    await migrate({ log: () => {} });
    web = (await import('../apps/web/src/app.js')).app;
    auth = await import('../apps/web/src/auth.js');
    cookie = await signIn(`calls${tag}@example.com`);
    orgId = (await api('POST', '/orgs', { name: `Calls Practice ${tag}`, location: 'Mission St' })).body.org.id;
    // Calls allowed around the clock so the test does not depend on the hour it runs.
    expect((await api('PUT', `/orgs/${orgId}/call-settings`, { call_window_start: 0, call_window_end: 24 })).status).toBe(200);
    patientId = (await api('POST', `/orgs/${orgId}/people`, { user_type: 'patient', name: 'Jin Park', phone: '(415) 555-0101', call_consent: true })).body.person.id;
    noConsentId = (await api('POST', `/orgs/${orgId}/people`, { user_type: 'patient', name: 'No Consent', phone: '415-555-0199' })).body.person.id;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await close();
  });

  test('booking queues a reminder and a follow-up; cancelling cancels them', async () => {
    const starts = new Date(Date.now() + 3 * 86400_000).toISOString();
    const a = await api('POST', `/orgs/${orgId}/appointments`, { patient_id: patientId, starts_at: starts, reason: 'Check-up' });
    const rows = await db()`select kind, status, due_at from calls where appointment_id = ${a.body.appointment.id} order by kind`;
    expect(rows.map((r) => r.kind)).toEqual(['followup', 'reminder']);
    expect(new Date(rows[1].due_at).getTime()).toBe(new Date(starts).getTime() - 24 * 3600_000);
    await api('PATCH', `/orgs/${orgId}/appointments/${a.body.appointment.id}`, { status: 'cancelled' });
    const after = await db()`select status from calls where appointment_id = ${a.body.appointment.id}`;
    expect(after.every((r) => r.status === 'cancelled')).toBe(true);
  });

  test('no consent on file means no call', async () => {
    const a = await api('POST', `/orgs/${orgId}/appointments`, { patient_id: noConsentId, starts_at: new Date(Date.now() + 6 * 3600_000).toISOString() });
    await db()`update calls set due_at = now() - interval '1 minute' where appointment_id = ${a.body.appointment.id} and kind = 'reminder'`;
    await calls.tick({ log: () => {} });
    const [r] = await db()`select status, skip_reason from calls where appointment_id = ${a.body.appointment.id} and kind = 'reminder'`;
    expect(r.status).toBe('skipped');
    expect(r.skip_reason).toContain('consent');
  });

  test('a due reminder is dialled once, with machine detection', async () => {
    const a = await api('POST', `/orgs/${orgId}/appointments`, { patient_id: patientId, starts_at: new Date(Date.now() + 6 * 3600_000).toISOString(), mode: 'video', reason: 'Diabetes follow-up' });
    apptId = a.body.appointment.id;
    sent.length = 0;
    expect(await calls.tick({ log: () => {} })).toBe(1);
    expect(await calls.tick({ log: () => {} })).toBe(0); // not twice
    const dial = sent.find((s) => s.path === '/calls');
    expect(dial.body.to).toBe('+14155550101');
    expect(dial.body.connection_id).toBe('conn_test');
    expect(dial.body.answering_machine_detection).toBe('premium');
    const [r] = await db()`select status, attempts, call_control_id from calls where appointment_id = ${apptId} and kind = 'reminder'`;
    expect(r).toMatchObject({ status: 'dialing', attempts: 1 });
  });

  test('a forged webhook is refused', async () => {
    expect((await deliver('call.answered', {}, { badSig: true })).status).toBe(401);
  });

  test('a person answers, confirms, and the visit is confirmed', async () => {
    const [r] = await db()`select id, call_control_id from calls where appointment_id = ${apptId} and kind = 'reminder'`;
    const base = { call_control_id: r.call_control_id, client_state: cs(r.id) };
    sent.length = 0;
    await deliver('call.answered', base);
    await deliver('call.machine.premium.detection.ended', { ...base, result: 'human_residence' });
    const gather = sent.find((s) => s.path.endsWith('/actions/gather_using_ai'));
    expect(gather.body.greeting).toContain('automated assistant');
    expect(gather.body.parameters.properties.decision).toBeTruthy();
    expect(gather.body.voice).toStartWith('Telnyx.');

    await deliver('call.ai_gather.ended', {
      ...base,
      status: 'valid',
      result: { reached_patient: true, decision: 'confirm', question_for_staff: '' },
      message_history: [
        { role: 'assistant', content: 'Will you be able to make it?' },
        { role: 'user', content: 'Yes I will' },
      ],
    });
    const [after] = await db()`select status, summary, flagged, transcript from calls where id = ${r.id}`;
    expect(after.status).toBe('completed');
    expect(after.summary).toContain('Confirmed');
    expect(after.flagged).toBe(false);
    expect(after.transcript).toHaveLength(2);
    const [appt] = await db()`select status from appointments where id = ${apptId}`;
    expect(appt.status).toBe('confirmed');
    expect(sent.some((s) => s.path.endsWith('/actions/speak'))).toBe(true);
    // A re-delivered gather event changes nothing.
    await deliver('call.ai_gather.ended', { ...base, status: 'valid', result: { decision: 'cancel' } });
    expect((await db()`select status from appointments where id = ${apptId}`)[0].status).toBe('confirmed');
  });

  test('a clinical question and an opt-out are flagged for staff', async () => {
    await db()`update appointments set status = 'completed' where id = ${apptId}`;
    await db()`delete from call_attempts where patient_id = ${patientId}`; // pretend a day passed
    await db()`update calls set due_at = now() - interval '1 minute' where appointment_id = ${apptId} and kind = 'followup'`;
    sent.length = 0;
    expect(await calls.tick({ log: () => {} })).toBe(1);
    const [r] = await db()`select id, call_control_id from calls where appointment_id = ${apptId} and kind = 'followup'`;
    const base = { call_control_id: r.call_control_id, client_state: cs(r.id) };
    await deliver('call.machine.premium.detection.ended', { ...base, result: 'human_business' });
    await deliver('call.ai_gather.ended', {
      ...base,
      status: 'valid',
      result: { reached_patient: true, feeling: 'worse', question_for_staff: 'Can I take ibuprofen with metformin?', do_not_call: true },
      message_history: [],
    });
    const today = await api('GET', `/orgs/${orgId}/today`);
    const flagged = today.body.needs.calls.find((x) => x.id === r.id);
    expect(flagged.flag_reason).toContain('ibuprofen');
    expect(flagged.flag_reason).toContain('worse');
    const [p] = await db()`select call_opt_out_at from org_people where id = ${patientId}`;
    expect(p.call_opt_out_at).toBeTruthy();
    expect((await api('POST', `/orgs/${orgId}/calls/${r.id}/resolve`)).status).toBe(200);
    expect((await api('GET', `/orgs/${orgId}/today`)).body.needs.calls.find((x) => x.id === r.id)).toBeUndefined();
    const detail = await api('GET', `/orgs/${orgId}/calls/${r.id}`);
    expect(detail.body.call.outcome.question_for_staff).toContain('ibuprofen');
  });

  test('no answer is retried the next day, never twice in one day', async () => {
    await api('PATCH', `/orgs/${orgId}/people/${patientId}`, { call_consent: true }); // opts back in
    await db()`delete from call_attempts where patient_id = ${patientId}`;
    const a = await api('POST', `/orgs/${orgId}/appointments`, { patient_id: patientId, starts_at: new Date(Date.now() + 3 * 86400_000).toISOString() });
    await db()`update calls set due_at = now() - interval '1 minute' where appointment_id = ${a.body.appointment.id} and kind = 'reminder'`;
    expect(await calls.tick({ log: () => {} })).toBe(1);
    const [r] = await db()`select id, call_control_id from calls where appointment_id = ${a.body.appointment.id} and kind = 'reminder'`;
    await deliver('call.hangup', { call_control_id: r.call_control_id, client_state: cs(r.id), hangup_cause: 'timeout' });
    const [after] = await db()`select status, next_attempt_at from calls where id = ${r.id}`;
    expect(after.status).toBe('no_answer');
    expect(new Date(after.next_attempt_at) - Date.now()).toBeGreaterThan(23 * 3600_000);
    // "Call now" the same day is held by the one-call-a-day limit.
    const now = await api('POST', `/orgs/${orgId}/appointments/${a.body.appointment.id}/call`, { kind: 'reminder' });
    expect(now.body.call.status).toBe('no_answer');
  });

  test('the chart lists the calls', async () => {
    const chart = await api('GET', `/orgs/${orgId}/patients/${patientId}`);
    expect(chart.body.calls.length).toBeGreaterThanOrEqual(3);
  });
});
