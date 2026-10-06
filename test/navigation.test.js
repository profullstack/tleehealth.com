// Care plans, care-management programs, time logging and the superbill.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { blockers, monthRange, superbillCsv, superbillRow, unitsFor } from '../apps/web/src/navigation.js';
import { configured, close, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

describe('units', () => {
  test('PIN under full time: G0023 at 60, a G0024 per 30 more', () => {
    expect(unitsFor('pin', 59)).toEqual({ lines: [], next: 1 });
    expect(unitsFor('pin', 60)).toEqual({ lines: [{ code: 'G0023', units: 1 }], next: 30 });
    expect(unitsFor('pin', 89).lines).toEqual([{ code: 'G0023', units: 1 }]);
    expect(unitsFor('pin', 90).lines).toEqual([{ code: 'G0023', units: 1 }, { code: 'G0024', units: 1 }]);
    expect(unitsFor('pin', 150).lines[1]).toEqual({ code: 'G0024', units: 3 });
  });

  test('no rounding up: 31 minutes of PIN bills nothing, 76 bills no add-on (CMS, 88 FR 78941)', () => {
    expect(unitsFor('pin', 31)).toEqual({ lines: [], next: 29 });
    expect(unitsFor('pin', 76).lines).toEqual([{ code: 'G0023', units: 1 }]);
    expect(unitsFor('chi', 59).lines).toEqual([]);
  });

  test('CCM needs its full 20 minutes, and 99439 caps at two', () => {
    expect(unitsFor('ccm', 19).lines).toEqual([]);
    expect(unitsFor('ccm', 20).lines).toEqual([{ code: '99490', units: 1 }]);
    expect(unitsFor('ccm', 40).lines[1]).toEqual({ code: '99439', units: 1 });
    expect(unitsFor('ccm', 200)).toEqual({ lines: [{ code: '99490', units: 1 }, { code: '99439', units: 2 }], next: null });
  });

  test('CHI and peer support bill their own codes', () => {
    expect(unitsFor('chi', 95).lines.map((l) => l.code)).toEqual(['G0019', 'G0022']);
    expect(unitsFor('pin_ps', 60).lines[0].code).toBe('G0140');
  });

  test('months', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
    expect(() => monthRange('2026-13')).toThrow();
  });
});

describe('blockers', () => {
  const ready = {
    program: 'pin',
    condition: 'Stage III colon cancer',
    consent_at: new Date('2026-03-01T12:00:00Z'),
    initiating_visit_on: '2026-02-20',
    billing_provider_id: 'x',
    billing_npi: '1234567893',
    started_on: '2026-03-01',
    status: 'active',
  };

  test('a complete enrollment is ready', () => {
    expect(blockers(ready, '2026-10')).toEqual([]);
  });

  test('PIN consent lapses after a year', () => {
    expect(blockers(ready, '2027-03')).toContain('consent is over a year old; renew it');
    expect(blockers(ready, '2027-02')).toEqual([]);
  });

  test('each missing fact is named', () => {
    const b = blockers({ program: 'ccm', started_on: '2026-01-01', status: 'active' }, '2026-10');
    expect(b).toEqual([
      'no consent on file',
      'no initiating visit with the billing practitioner',
      'no billing practitioner',
      'no condition recorded',
      'needs a care plan',
    ]);
  });

  test('consent or a visit after the month does not count for it', () => {
    expect(blockers({ ...ready, consent_at: '2026-11-02T00:00:00Z' }, '2026-10')).toContain('consent was recorded after this month');
    expect(blockers({ ...ready, initiating_visit_on: '2026-11-01' }, '2026-10')).toContain('the initiating visit is after this month');
  });

  test('the CSV escapes spreadsheet formulas and quotes', () => {
    const row = superbillRow({ ...ready, id: 'p', patient: '=HYPERLINK("x")', dob: '1950-01-01' }, 95, '2026-10', 'full');
    const csv = superbillCsv([row], { month: '2026-10', practice: 'Lin, MD' });
    expect(csv.split('\n')[1]).toStartWith('2026-10,"Lin, MD","\'=HYPERLINK(""x"")",1950-01-01,PIN');
    expect(csv).toContain(',G0023,1,95,ready');
    expect(csv).toContain(',G0024,1,95,ready');
  });
});

const { app } = configured() ? await import('../apps/web/src/app.js') : { app: null };
const auth = configured() ? await import('../apps/web/src/auth.js') : null;

async function signIn(email) {
  const url = new URL(await auth.createLoginLink(email));
  const res = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
  return res.headers.get('set-cookie').split(';')[0];
}

function client(cookie) {
  const call = async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

describe.skipIf(!configured())('navigation api', () => {
  const tag = `${Date.now()}n`;
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  let owner, advocate, patient, orgId, ownerPersonId, advocateId, patientId, programId;

  beforeAll(async () => {
    await migrate({ log: () => {} });
    owner = client(await signIn(`nowner${tag}@example.com`));
    orgId = (await owner.post('/orgs', { name: `Navigation Practice ${tag}` })).body.org.id;
    ownerPersonId = (await owner.get(`/orgs/${orgId}`)).body.me.person_id;
  });
  afterAll(() => close());

  test('an advocate is a billed team seat', async () => {
    const r = await owner.post(`/orgs/${orgId}/people`, { user_type: 'advocate', name: 'Ana Ruiz', email: `adv${tag}@example.com` });
    expect(r.status).toBe(201);
    advocateId = r.body.person.id;
    expect((await owner.get(`/orgs/${orgId}`)).body.billing.seats).toBe(2);
    advocate = client(await signIn(`adv${tag}@example.com`));
    expect((await advocate.get('/me')).body.orgs.find((o) => o.id === orgId).user_type).toBe('advocate');
    const p = await advocate.post(`/orgs/${orgId}/people`, { user_type: 'patient', name: 'Rosa Diaz', email: `npat${tag}@example.com`, dob: '1951-07-04' });
    expect(p.status).toBe(201);
    patientId = p.body.person.id;
  });

  test('the owner records an NPI; a bad one is refused', async () => {
    expect((await owner.patch(`/orgs/${orgId}/people/${ownerPersonId}`, { npi: '12345' })).status).toBe(400);
    expect((await owner.patch(`/orgs/${orgId}/people/${ownerPersonId}`, { npi: '1234567893' })).body.person.npi).toBe('1234567893');
    expect((await owner.patch(`/orgs/${orgId}/people/${patientId}`, { npi: '1234567893' })).status).toBe(400);
  });

  test('the advocate builds a care plan; it reaches the portal only once shared', async () => {
    const plan = await advocate.put(`/orgs/${orgId}/patients/${patientId}/care-plan`, { title: 'Colon cancer treatment', summary: 'Get through chemo on schedule.' });
    expect(plan.status).toBe(200);
    expect(plan.body.care_plan.owner).toBe('Ana Ruiz');
    const goal = await advocate.post(`/orgs/${orgId}/patients/${patientId}/care-plan/items`, { kind: 'goal', text: 'Finish 6 cycles of FOLFOX' });
    expect(goal.status).toBe(201);
    const task = await advocate.post(`/orgs/${orgId}/patients/${patientId}/care-plan/items`, { text: 'Get prior auth for the port placement', owner_id: advocateId, due_on: '2000-01-01' });
    expect(task.body.item.owner_id).toBe(advocateId);
    const mine = await advocate.post(`/orgs/${orgId}/patients/${patientId}/care-plan/items`, { text: 'Bring your insurance card', owner_id: 'patient' });
    expect(mine.body.item.owner_id).toBeNull();
    expect((await advocate.patch(`/orgs/${orgId}/care-plan-items/${mine.body.item.id}`, { status: 'done' })).body.item.done_at).toBeTruthy();

    patient = client(await signIn(`npat${tag}@example.com`));
    expect((await patient.get('/portal')).body.practices[0].care_plan).toBeNull();
    await advocate.put(`/orgs/${orgId}/patients/${patientId}/care-plan`, { shared: true });
    const shared = (await patient.get('/portal')).body.practices[0].care_plan;
    expect(shared.title).toBe('Colon cancer treatment');
    expect(shared.items.map((i) => i.text)).toContain('Bring your insurance card');
    expect(shared.items.find((i) => i.text === 'Bring your insurance card').owner).toBe('You');
    expect(shared.id).toBeUndefined();
  });

  test('enrolling in PIN fills the initiating visit from the last completed visit', async () => {
    const a = await owner.post(`/orgs/${orgId}/appointments`, { patient_id: patientId, provider_id: ownerPersonId, starts_at: `${month}-01T17:00:00Z` });
    await owner.patch(`/orgs/${orgId}/appointments/${a.body.appointment.id}`, { status: 'completed' });
    const bad = await advocate.post(`/orgs/${orgId}/patients/${patientId}/programs`, { program: 'pin', billing_provider_id: advocateId });
    expect(bad.status).toBe(400); // an advocate cannot be the billing practitioner
    const r = await advocate.post(`/orgs/${orgId}/patients/${patientId}/programs`, {
      program: 'pin',
      condition: 'Stage III colon cancer',
      billing_provider_id: ownerPersonId,
      started_on: `${month}-01`,
    });
    expect(r.status).toBe(201);
    programId = r.body.program.id;
    expect(String(r.body.program.initiating_visit_on).slice(0, 7)).toBe(month);
    expect(r.body.program.navigator_id).toBe(advocateId);
    expect((await advocate.post(`/orgs/${orgId}/patients/${patientId}/programs`, { program: 'pin' })).status).toBe(409);
  });

  test('time adds up toward G0023, and the superbill holds it until consent', async () => {
    expect((await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 0 })).status).toBe(400);
    expect((await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 10, activity: 'gossip' })).status).toBe(400);
    expect((await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 10, performed_on: '2999-01-01' })).status).toBe(400);
    const t1 = await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 40, activity: 'prior_auth', performed_on: today, note: 'Called Aetna' });
    expect(t1.status).toBe(201);
    expect(t1.body.program.minutes).toBe(40);
    expect(t1.body.program.next_unit_in).toBe(20);
    const t2 = await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 25, activity: 'scheduling', performed_on: today });
    expect(t2.body.program.lines).toEqual([{ code: 'G0023', units: 1 }]);

    const caseload = await advocate.get(`/orgs/${orgId}/caseload`);
    expect(caseload.body.mine).toBe(true);
    const row = caseload.body.caseload.find((r) => r.program_id === programId);
    expect(row.minutes).toBe(65);
    expect(row.open_tasks).toBe(1);
    expect(row.overdue_tasks).toBe(1);

    expect((await advocate.get(`/orgs/${orgId}/superbill?month=${month}`)).status).toBe(403);
    const held = await owner.get(`/orgs/${orgId}/superbill?month=${month}`);
    expect(held.body.held).toBe(1);
    expect(held.body.rows[0].blockers).toEqual(['no consent on file']);
    expect(held.body.totals).toEqual({});
  });

  test('with consent it is ready, and the CSV lists the codes', async () => {
    expect((await advocate.patch(`/orgs/${orgId}/programs/${programId}`, { consent: true })).body.program.consent_at).toBeTruthy();
    const sb = await owner.get(`/orgs/${orgId}/superbill?month=${month}`);
    expect(sb.body.ready).toBe(1);
    expect(sb.body.totals).toEqual({ G0023: 1 });
    expect(sb.body.rows[0].billing_npi).toBe('1234567893');
    expect(sb.body.rows[0].next_unit_in).toBe(25); // G0024 at 90
    const csv = await owner.get(`/orgs/${orgId}/superbill?month=${month}&format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.body).toContain('Rosa Diaz,1951-07-04,PIN,Stage III colon cancer');
    expect(csv.body).toContain(',1234567893,G0023,1,65,ready');
  });

  test('the chart carries the plan and this month\'s program time', async () => {
    const chart = await owner.get(`/orgs/${orgId}/patients/${patientId}`);
    expect(chart.body.care_plan.items.length).toBe(3);
    expect(chart.body.programs[0].minutes).toBe(65);
    const time = await owner.get(`/orgs/${orgId}/programs/${programId}/time?month=${month}`);
    expect(time.body.time.map((t) => t.by)).toEqual(['Ana Ruiz', 'Ana Ruiz']);
  });

  test('only the author or an admin deletes time; an ended program takes no more', async () => {
    const t = await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 5 });
    const staff = await owner.post(`/orgs/${orgId}/people`, { user_type: 'staff', name: 'Desk', email: `ndesk${tag}@example.com` });
    expect(staff.status).toBe(201);
    const desk = client(await signIn(`ndesk${tag}@example.com`));
    expect((await desk.del(`/orgs/${orgId}/time/${t.body.time.id}`)).status).toBe(404);
    expect((await advocate.del(`/orgs/${orgId}/time/${t.body.time.id}`)).status).toBe(200);
    await owner.patch(`/orgs/${orgId}/programs/${programId}`, { status: 'ended' });
    expect((await advocate.post(`/orgs/${orgId}/programs/${programId}/time`, { minutes: 5 })).status).toBe(409);
    // Ended this month, so its time still bills this month.
    expect((await owner.get(`/orgs/${orgId}/superbill?month=${month}`)).body.ready).toBe(1);
  });

  test('navigation writes are audit-logged', async () => {
    const rows = await db()`select distinct action from audit_log where org_id = ${orgId} and action like 'program.%'`;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['program.enroll.pin', 'program.time', 'program.consent.true', 'program.end']));
  });
});
