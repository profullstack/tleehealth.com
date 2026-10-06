import { db, orgs } from '@tleehealth/db';
import { createCheckout, paymentsEnabled, settleWebhook, verifyWebhook } from '@tleehealth/payments';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import * as auth from './auth.js';
import { config, monthlyCents } from './config.js';
import { sendAddedToOrg, sendLoginLink } from './mail.js';
import * as calls from './calls.js';
import * as nav from './navigation.js';
import * as records from './records.js';

/**
 * /api/v1: the only thing any client talks to. The browser app, the CLI, the TUI
 * and the MCP server all use these routes, with a session cookie or an API key.
 */
export const api = new Hono();

const TEAM = ['owner', 'org_manager', 'provider', 'staff', 'advocate'];
const ADMIN = ['owner', 'org_manager'];
const CLINICIAN = ['owner', 'provider'];
// Who sees the superbill: the people who sign or submit claims.
const BILLERS = ['owner', 'org_manager', 'provider'];
const TYPES = ['owner', 'org_manager', 'provider', 'staff', 'advocate', 'patient', 'lead'];
const TRIAL_DAYS = 14;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

api.onError((err, c) => {
  if (err instanceof HttpError || err instanceof records.RecordsError) return c.json({ error: err.message }, err.status);
  if (err?.code === '23505') return c.json({ error: 'that already exists' }, 409);
  if (err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') return c.json({ error: 'invalid value' }, 400);
  if (err?.code === '23514') return c.json({ error: 'a value is out of range' }, 400);
  console.error('[api]', err);
  return c.json({ error: 'internal error' }, 500);
});

async function body(c) {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}
const str = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v, what = 'id') => {
  if (!UUID.test(String(v ?? ''))) fail(400, `${what} must be a uuid`);
  return v;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ who -- */

async function currentUser(c) {
  const bearer = c.req.header('authorization');
  if (bearer) return auth.userFromApiKey(bearer);
  return auth.userFromSession(getCookie(c, config.session.cookie));
}

async function requireUser(c) {
  const u = await currentUser(c);
  if (!u) fail(401, 'sign in first');
  return u;
}

/** The caller's row in this org, enforcing a user type. */
async function member(c, orgId, allowed = TEAM) {
  const user = await requireUser(c);
  uuid(orgId, 'org');
  const [me] = await db()`
    select p.*, o.name as org_name, o.created_at as org_created_at
    from org_people p join organizations o on o.id = p.org_id
    where p.org_id = ${orgId} and p.user_id = ${user.id} and p.status = 'active'`;
  if (!me) fail(404, 'no such practice');
  if (!allowed.includes(me.user_type)) fail(403, `needs ${allowed.join(' or ')}`);
  return { user, me };
}

/** Writes need the org paid up or inside its trial; reads never lapse. */
async function requireActive(orgId) {
  const [b] = await db()`
    select coalesce(b.paid_through > now(), false) as paid,
           o.created_at > now() - make_interval(days => ${TRIAL_DAYS}) as trial
    from organizations o left join org_billing b on b.org_id = o.id where o.id = ${orgId}`;
  if (!b?.paid && !b?.trial) fail(402, 'this practice is unpaid; the owner can pay under Billing');
}

async function audit(orgId, userId, action, subject = null) {
  await db()`insert into audit_log (org_id, user_id, action, subject) values (${orgId}, ${userId}, ${action}, ${subject})`;
}

/** A person in this org of an allowed type, or a 404/400. */
async function personIn(orgId, id, types, what = 'person') {
  uuid(id, what);
  const [p] = await db()`select * from org_people where id = ${id} and org_id = ${orgId} and status = 'active'`;
  if (!p) fail(404, `no such ${what}`);
  if (types && !types.includes(p.user_type)) fail(400, `${what} must be ${types.join(' or ')}`);
  return p;
}

/* ----------------------------------------------------------------- sign-in -- */

api.post('/auth/link', async (c) => {
  const { email } = await body(c);
  const e = str(email, 254)?.toLowerCase();
  if (!e || !EMAIL.test(e)) return c.json({ error: 'enter a valid email address' }, 400);
  // Same answer whether or not the address has an account.
  try {
    await sendLoginLink({ email: e, url: await auth.createLoginLink(e) });
  } catch (err) {
    console.error(`[auth] could not send link: ${err?.message ?? err}`);
  }
  return c.json({ ok: true, sent: true });
});

api.post('/auth/signout', async (c) => {
  await auth.endSession(getCookie(c, config.session.cookie));
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return c.json({ ok: true });
});

api.post('/auth/passkey/register/options', async (c) => {
  const user = await requireUser(c);
  return c.json(await auth.passkeyRegistrationOptions(user));
});
api.post('/auth/passkey/register/verify', async (c) => {
  const user = await requireUser(c);
  const { response, challengeId } = await body(c);
  try {
    const ok = await auth.verifyPasskeyRegistration({ user, response, challengeId });
    return ok ? c.json({ ok: true }) : c.json({ error: 'passkey was not saved' }, 400);
  } catch (err) {
    return c.json({ error: `passkey was not saved: ${err.message}` }, 400);
  }
});
api.post('/auth/passkey/login/options', async (c) => c.json(await auth.passkeyAuthenticationOptions()));
api.post('/auth/passkey/login/verify', async (c) => {
  const { response, challengeId } = await body(c);
  let s = null;
  try {
    s = await auth.verifyPasskeyAuthentication({ response, challengeId, userAgent: c.req.header('user-agent') });
  } catch (err) {
    console.error('[auth] passkey', err.message);
  }
  if (!s) return c.json({ error: 'that passkey did not work; use an email link' }, 401);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- account -- */

api.get('/me', async (c) => {
  const user = await requireUser(c);
  const memberships = await db()`
    select o.id, o.name, o.slug, p.user_type, p.id as person_id
    from org_people p join organizations o on o.id = p.org_id
    where p.user_id = ${user.id} and p.status = 'active'
    order by o.name`;
  const [{ n }] = await db()`select count(*)::int as n from passkeys where user_id = ${user.id}`;
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    passkeys: n,
    orgs: memberships.filter((m) => TEAM.includes(m.user_type)),
    patient_of: memberships.filter((m) => m.user_type === 'patient'),
  });
});

api.patch('/me', async (c) => {
  const user = await requireUser(c);
  const { name } = await body(c);
  await db()`update users set name = ${str(name, 120)} where id = ${user.id}`;
  return c.json({ ok: true });
});

api.get('/keys', async (c) => {
  const user = await requireUser(c);
  return c.json({
    keys: await db()`select id, name, prefix, created_at, last_used_at from api_keys
                     where user_id = ${user.id} and revoked_at is null order by created_at desc`,
  });
});
api.post('/keys', async (c) => {
  const user = await requireUser(c);
  const { name } = await body(c);
  return c.json(await auth.createApiKey({ userId: user.id, name: str(name, 60) ?? 'default' }), 201);
});
api.delete('/keys/:id', async (c) => {
  const user = await requireUser(c);
  await db()`update api_keys set revoked_at = now() where id = ${uuid(c.req.param('id'))} and user_id = ${user.id}`;
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------- orgs -- */

api.post('/orgs', async (c) => {
  const user = await requireUser(c);
  const b = await body(c);
  const name = str(b.name, 120);
  if (!name) return c.json({ error: 'name your practice' }, 400);
  const sql = db();
  const org = await orgs.createOrg(sql, { name, userId: user.id });
  await sql.begin(async (tx) => {
    await tx`insert into org_people (org_id, user_id, user_type, name, email)
             values (${org.id}, ${user.id}, 'owner', ${user.name}, ${user.email})`;
    await tx`insert into org_billing (org_id, billing_user) values (${org.id}, ${user.id})`;
    const loc = str(b.location, 120);
    if (loc) await tx`insert into locations (org_id, name, booking_slug, timezone)
                      values (${org.id}, ${loc}, ${slug(loc)}, ${str(b.timezone, 60) ?? 'America/Los_Angeles'})`;
  });
  await audit(org.id, user.id, 'org.create', org.id);
  return c.json({ org: { id: org.id, name: org.name, slug: org.slug } }, 201);
});

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'office';

api.get('/orgs/:org', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const sql = db();
  const [o] = await sql`select id, name, slug, created_at from organizations where id = ${me.org_id}`;
  const locations = await sql`select * from locations where org_id = ${me.org_id} order by name`;
  return c.json({ org: o, me: { person_id: me.id, user_type: me.user_type }, locations, billing: await billing(me.org_id) });
});

api.patch('/orgs/:org', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  const name = str((await body(c)).name, 120);
  if (!name) return c.json({ error: 'name required' }, 400);
  await orgs.updateOrg(db(), me.org_id, { name });
  await audit(me.org_id, user.id, 'org.rename');
  return c.json({ ok: true });
});

/* -------------------------------------------------------------- locations -- */

api.get('/orgs/:org/locations', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  return c.json({ locations: await db()`select * from locations where org_id = ${me.org_id} order by name` });
});

api.post('/orgs/:org/locations', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  await requireActive(me.org_id);
  const b = await body(c);
  const name = str(b.name, 120);
  if (!name) return c.json({ error: 'name the location' }, 400);
  const [loc] = await db()`
    insert into locations (org_id, name, address, phone, timezone, booking_slug)
    values (${me.org_id}, ${name}, ${str(b.address)}, ${str(b.phone, 40)},
            ${str(b.timezone, 60) ?? 'America/Los_Angeles'}, ${slug(str(b.booking_slug, 40) ?? name)})
    returning *`;
  await audit(me.org_id, user.id, 'location.create', loc.id);
  return c.json({ location: loc }, 201);
});

api.patch('/orgs/:org/locations/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  const b = await body(c);
  const [loc] = await db()`
    update locations set
      name = coalesce(${str(b.name, 120)}, name), address = coalesce(${str(b.address)}, address),
      phone = coalesce(${str(b.phone, 40)}, phone), timezone = coalesce(${str(b.timezone, 60)}, timezone)
    where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!loc) return c.json({ error: 'no such location' }, 404);
  await audit(me.org_id, user.id, 'location.update', loc.id);
  return c.json({ location: loc });
});

api.delete('/orgs/:org/locations/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  await db()`delete from locations where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id}`;
  await audit(me.org_id, user.id, 'location.delete', c.req.param('id'));
  return c.json({ ok: true });
});

/* ----------------------------------------------------------------- people -- */
// Team, patients and leads are all org_people with a user type.

api.get('/orgs/:org/people', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const type = c.req.query('type');
  const types = type === 'team' ? TEAM : type ? type.split(',').filter((t) => TYPES.includes(t)) : TYPES;
  const q = str(c.req.query('q'), 80);
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const people = await db()`
    select id, user_type, name, email, phone, dob, source, npi, user_id is not null as has_account, created_at
    from org_people
    where org_id = ${me.org_id} and status = 'active' and user_type::text = any(${types})
      ${like ? db()`and (name ilike ${like} or email ilike ${like} or phone ilike ${like})` : db()``}
    order by user_type, name nulls last limit 500`;
  return c.json({ people });
});

api.post('/orgs/:org/people', async (c) => {
  const b = await body(c);
  const type = str(b.user_type, 20);
  if (!TYPES.includes(type) || type === 'owner') return c.json({ error: 'user_type must be org_manager, provider, staff, advocate, patient or lead' }, 400);
  // Adding team needs an admin; any team member can add patients and leads.
  const { me, user } = await member(c, c.req.param('org'), TEAM.includes(type) ? ADMIN : TEAM);
  await requireActive(me.org_id);
  const email = str(b.email, 254)?.toLowerCase() ?? null;
  if (email && !EMAIL.test(email)) return c.json({ error: 'email is not valid' }, 400);
  if (TEAM.includes(type) && !email) return c.json({ error: 'team members need an email to sign in' }, 400);
  const name = str(b.name, 120);
  if (!name && !email) return c.json({ error: 'give a name or an email' }, 400);

  const sql = db();
  if (email) {
    const [dup] = await sql`select id from org_people where org_id = ${me.org_id} and lower(email) = ${email} and status = 'active'`;
    if (dup) return c.json({ error: 'someone with that email is already in this practice', id: dup.id }, 409);
  }
  const [p] = await sql`
    insert into org_people (org_id, user_type, name, email, phone, dob, source, notes, call_consent_at)
    values (${me.org_id}, ${type}, ${name}, ${email}, ${str(b.phone, 40)}, ${str(b.dob, 10)},
            ${str(b.source, 80)}, ${str(b.notes, 2000)}, ${b.call_consent === true ? new Date() : null})
    returning *`;
  if (Array.isArray(b.location_ids))
    for (const lid of b.location_ids.filter((x) => UUID.test(x)))
      await sql`insert into org_person_locations (person_id, location_id)
                select ${p.id}, id from locations where id = ${lid} and org_id = ${me.org_id} on conflict do nothing`;

  // An existing account with this email is linked now; otherwise on first sign-in.
  if (email) {
    const [existing] = await sql`select * from users where lower(email) = ${email}`;
    if (existing) await auth.linkPeople(existing);
    if (type !== 'lead' && b.notify !== false)
      sendAddedToOrg({ email, orgName: me.org_name, userType: type, url: `${config.siteUrl}/signin?email=${encodeURIComponent(email)}` }).catch(
        (err) => console.error('[mail]', err.message),
      );
  }
  await audit(me.org_id, user.id, `person.create.${type}`, p.id);
  return c.json({ person: p }, 201);
});

api.patch('/orgs/:org/people/:id', async (c) => {
  const b = await body(c);
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), null);
  const isAdmin = ADMIN.includes(me.user_type);
  if (TEAM.includes(p.user_type) && !isAdmin) fail(403, 'only an owner or org manager edits the team');
  let type = p.user_type;
  if (b.user_type && b.user_type !== p.user_type) {
    // Converting a lead to a patient is a front-desk job; changing team roles is not.
    const leadToPatient = p.user_type === 'lead' && b.user_type === 'patient';
    if (!leadToPatient && !isAdmin) fail(403, 'only an owner or org manager changes user types');
    if (p.user_type === 'owner' || b.user_type === 'owner') fail(400, 'ownership cannot be changed here');
    if (!TYPES.includes(b.user_type)) fail(400, 'unknown user type');
    type = b.user_type;
  }
  let npi;
  if (b.npi !== undefined) {
    if (!TEAM.includes(p.user_type)) fail(400, 'only team members have an NPI');
    npi = str(b.npi, 10);
    if (npi && !/^\d{10}$/.test(npi)) fail(400, 'an NPI is 10 digits');
  }
  const [row] = await db()`
    update org_people set user_type = ${type},
      name = coalesce(${str(b.name, 120)}, name), phone = coalesce(${str(b.phone, 40)}, phone),
      dob = coalesce(${str(b.dob, 10)}, dob), notes = coalesce(${str(b.notes, 2000)}, notes),
      npi = case when ${npi !== undefined} then ${npi ?? null} else npi end,
      call_consent_at = case when ${b.call_consent === true} then coalesce(call_consent_at, now())
                             when ${b.call_consent === false} then null else call_consent_at end,
      call_opt_out_at = case when ${b.call_consent === true} then null else call_opt_out_at end
    where id = ${p.id} returning *`;
  if (b.call_consent !== undefined) {
    const upcoming = await db()`select id from appointments where patient_id = ${p.id} and starts_at > now() - interval '3 days'`;
    for (const a of upcoming) await calls.syncAppointmentCalls(a.id);
  }
  await audit(me.org_id, user.id, 'person.update', p.id);
  return c.json({ person: row });
});

api.delete('/orgs/:org/people/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), null);
  if (p.user_type === 'owner') fail(400, 'the owner cannot be removed');
  if (TEAM.includes(p.user_type) && !ADMIN.includes(me.user_type)) fail(403, 'only an owner or org manager removes team');
  await db()`update org_people set status = 'archived' where id = ${p.id}`;
  if (p.user_id && TEAM.includes(p.user_type)) await orgs.removeMember(db(), { orgId: me.org_id, userId: p.user_id }).catch(() => {});
  await audit(me.org_id, user.id, 'person.archive', p.id);
  return c.json({ ok: true });
});

/* --------------------------------------------------------- patient chart -- */

api.get('/orgs/:org/patients/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), ['patient', 'lead'], 'patient');
  const sql = db();
  const [appointments, medications, labs, summaries, refills] = await Promise.all([
    sql`select a.*, l.name as location, pr.name as provider from appointments a
        left join locations l on l.id = a.location_id left join org_people pr on pr.id = a.provider_id
        where a.patient_id = ${p.id} order by a.starts_at desc limit 100`,
    sql`select m.*, pr.name as prescriber from medications m left join org_people pr on pr.id = m.prescriber_id
        where m.patient_id = ${p.id} order by m.status, m.created_at desc`,
    sql`select * from lab_results where patient_id = ${p.id} order by collected_at desc, test_name`,
    sql`select s.*, pr.name as provider from visit_summaries s left join org_people pr on pr.id = s.provider_id
        where s.patient_id = ${p.id} order by s.created_at desc`,
    sql`select r.*, m.name as medication from refill_requests r join medications m on m.id = r.medication_id
        where r.patient_id = ${p.id} order by r.requested_at desc limit 50`,
  ]);
  const callRows = await sql`select id, appointment_id, kind, status, due_at, summary, flagged, flag_reason, resolved_at,
                                    skip_reason, attempts, ended_at, transcript is not null as has_transcript
                             from calls where patient_id = ${p.id} order by coalesce(ended_at, due_at) desc limit 50`;
  const month = nav.thisMonth();
  const programs = await programRows(me.org_id, { ...nav.monthRange(month), month }, (sql) => sql`and cp.patient_id = ${p.id} and cp.status = 'active'`);
  await audit(me.org_id, user.id, 'patient.read', p.id);
  return c.json({
    patient: p, appointments, medications, labs, summaries, refills, calls: callRows,
    care_plan: await carePlan(p.id), programs, month,
  });
});

/* ------------------------------------------------------------ scheduling -- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function dayAppointments(orgId, { date, tz, locationId }) {
  return db()`
    select a.*, p.name as patient, p.phone as patient_phone, pr.name as provider, l.name as location,
           s.id as summary_id, s.status as summary_status
    from appointments a
    join org_people p on p.id = a.patient_id
    left join org_people pr on pr.id = a.provider_id
    left join locations l on l.id = a.location_id
    left join visit_summaries s on s.appointment_id = a.id
    where a.org_id = ${orgId}
      and a.starts_at >= (${date}::date)::timestamp at time zone ${tz}
      and a.starts_at <  (${date}::date + 1)::timestamp at time zone ${tz}
      ${locationId ? db()`and a.location_id = ${locationId}` : db()``}
    order by a.starts_at`;
}

api.get('/orgs/:org/appointments', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  const tz = str(c.req.query('tz'), 60) ?? 'America/Los_Angeles';
  const loc = c.req.query('location');
  return c.json({ date, appointments: await dayAppointments(me.org_id, { date, tz, locationId: loc ? uuid(loc, 'location') : null }) });
});

api.post('/orgs/:org/appointments', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const b = await body(c);
  const patient = await personIn(me.org_id, b.patient_id, ['patient', 'lead'], 'patient');
  const provider = b.provider_id ? await personIn(me.org_id, b.provider_id, CLINICIAN, 'provider') : null;
  let locationId = null;
  if (b.location_id) {
    const [l] = await db()`select id from locations where id = ${uuid(b.location_id, 'location')} and org_id = ${me.org_id}`;
    if (!l) fail(404, 'no such location');
    locationId = l.id;
  }
  const starts = new Date(b.starts_at);
  if (Number.isNaN(starts.getTime())) fail(400, 'starts_at must be a date-time');
  const sql = db();
  const [a] = await sql.begin(async (tx) => {
    // Booking a lead makes them a patient.
    if (patient.user_type === 'lead') await tx`update org_people set user_type = 'patient' where id = ${patient.id}`;
    // The front desk asks at booking; a yes is recorded with its time.
    if (b.call_consent === true)
      await tx`update org_people set call_consent_at = coalesce(call_consent_at, now()), call_opt_out_at = null where id = ${patient.id}`;
    return tx`
      insert into appointments (org_id, location_id, provider_id, patient_id, starts_at, minutes, mode, reason, created_by)
      values (${me.org_id}, ${locationId}, ${provider?.id ?? null}, ${patient.id}, ${starts},
              ${Number(b.minutes) || 30}, ${b.mode === 'video' ? 'video' : 'in_person'}, ${str(b.reason, 200)}, ${user.id})
      returning *`;
  });
  await audit(me.org_id, user.id, 'appointment.create', a.id);
  await calls.syncAppointmentCalls(a.id);
  return c.json({ appointment: a }, 201);
});

api.patch('/orgs/:org/appointments/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const b = await body(c);
  const STATUS = ['scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'];
  if (b.status && !STATUS.includes(b.status)) fail(400, `status must be one of ${STATUS.join(', ')}`);
  let starts = null;
  if (b.starts_at) {
    starts = new Date(b.starts_at);
    if (Number.isNaN(starts.getTime())) fail(400, 'starts_at must be a date-time');
  }
  if (b.provider_id) await personIn(me.org_id, b.provider_id, CLINICIAN, 'provider');
  const [a] = await db()`
    update appointments set
      status = coalesce(${b.status ?? null}, status),
      starts_at = coalesce(${starts}, starts_at),
      minutes = coalesce(${b.minutes ? Number(b.minutes) : null}, minutes),
      mode = coalesce(${b.mode === 'video' || b.mode === 'in_person' ? b.mode : null}, mode),
      provider_id = coalesce(${b.provider_id ?? null}, provider_id),
      reason = coalesce(${str(b.reason, 200)}, reason),
      updated_at = now()
    where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!a) return c.json({ error: 'no such appointment' }, 404);
  await audit(me.org_id, user.id, `appointment.update${b.status ? `.${b.status}` : ''}`, a.id);
  await calls.syncAppointmentCalls(a.id);
  return c.json({ appointment: a });
});

/* ---------------------------------------------------- medications + refills -- */

api.post('/orgs/:org/patients/:id/medications', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  const name = str(b.name, 120);
  if (!name) fail(400, 'medication name required');
  const [m] = await db()`
    insert into medications (org_id, patient_id, name, dose, directions, refills_left, prescriber_id)
    values (${me.org_id}, ${p.id}, ${name}, ${str(b.dose, 60)}, ${str(b.directions, 300)},
            ${Math.max(0, Number(b.refills) || 0)}, ${me.id})
    returning *`;
  await audit(me.org_id, user.id, 'medication.create', m.id);
  return c.json({ medication: m }, 201);
});

api.patch('/orgs/:org/medications/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  const b = await body(c);
  const stop = b.status === 'stopped';
  const [m] = await db()`
    update medications set
      dose = coalesce(${str(b.dose, 60)}, dose), directions = coalesce(${str(b.directions, 300)}, directions),
      refills_left = coalesce(${b.refills != null ? Math.max(0, Number(b.refills) || 0) : null}, refills_left),
      status = case when ${stop} then 'stopped' else status end,
      stopped_at = case when ${stop} then now() else stopped_at end
    where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!m) return c.json({ error: 'no such medication' }, 404);
  await audit(me.org_id, user.id, stop ? 'medication.stop' : 'medication.update', m.id);
  return c.json({ medication: m });
});

api.get('/orgs/:org/refills', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const status = ['pending', 'approved', 'denied'].includes(c.req.query('status')) ? c.req.query('status') : 'pending';
  return c.json({
    refills: await db()`
      select r.*, m.name as medication, m.dose, m.refills_left, p.name as patient
      from refill_requests r join medications m on m.id = r.medication_id join org_people p on p.id = r.patient_id
      where r.org_id = ${me.org_id} and r.status = ${status} order by r.requested_at limit 200`,
  });
});

api.post('/orgs/:org/patients/:id/refills', async (c) => {
  // Staff can file a refill request on a patient's behalf (phone call, the agent).
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  const r = await fileRefill(me.org_id, p.id, b.medication_id, str(b.note, 300));
  await audit(me.org_id, user.id, 'refill.request', r.id);
  return c.json({ refill: r }, 201);
});

async function fileRefill(orgId, patientId, medicationId, note) {
  const [m] = await db()`select id from medications where id = ${uuid(medicationId, 'medication')}
                         and patient_id = ${patientId} and org_id = ${orgId} and status = 'active'`;
  if (!m) fail(404, 'no such active medication');
  const [r] = await db()`
    insert into refill_requests (org_id, medication_id, patient_id, note)
    values (${orgId}, ${m.id}, ${patientId}, ${note})
    on conflict (medication_id) where status = 'pending' do update set note = coalesce(excluded.note, refill_requests.note)
    returning *`;
  return r;
}

api.post('/orgs/:org/refills/:id/:decision{approve|deny}', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  await requireActive(me.org_id);
  const approve = c.req.param('decision') === 'approve';
  const sql = db();
  const r = await sql.begin(async (tx) => {
    const [r] = await tx`
      update refill_requests set status = ${approve ? 'approved' : 'denied'}, decided_by = ${me.id}, decided_at = now()
      where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} and status = 'pending' returning *`;
    if (!r) fail(404, 'no such pending refill');
    if (approve) await tx`update medications set refills_left = greatest(refills_left - 1, 0) where id = ${r.medication_id}`;
    return r;
  });
  await audit(me.org_id, user.id, `refill.${approve ? 'approve' : 'deny'}`, r.id);
  return c.json({ refill: r });
});

/* ------------------------------------------------------------------- labs -- */

api.post('/orgs/:org/patients/:id/labs', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  const test = str(b.test_name, 120);
  if (!test) fail(400, 'test name required');
  const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  const value = num(b.value);
  const valueText = value === null ? str(b.value, 200) : null;
  if (value === null && !valueText) fail(400, 'a result value is required');
  const [l] = await db()`
    insert into lab_results (org_id, patient_id, test_name, value, value_text, unit, ref_low, ref_high, collected_at, notes, entered_by)
    values (${me.org_id}, ${p.id}, ${test}, ${value}, ${valueText}, ${str(b.unit, 20)}, ${num(b.ref_low)}, ${num(b.ref_high)},
            ${str(b.collected_at, 10) ?? new Date().toISOString().slice(0, 10)}, ${str(b.notes, 1000)}, ${me.id})
    returning *`;
  await audit(me.org_id, user.id, 'lab.create', l.id);
  return c.json({ lab: l }, 201);
});

api.get('/orgs/:org/labs', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  return c.json({
    labs: await db()`
      select l.*, p.name as patient from lab_results l join org_people p on p.id = l.patient_id
      where l.org_id = ${me.org_id} and l.released_at is null order by l.collected_at desc limit 200`,
  });
});

api.post('/orgs/:org/labs/:id/release', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  const [l] = await db()`update lab_results set released_at = coalesce(released_at, now())
                         where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!l) return c.json({ error: 'no such result' }, 404);
  await audit(me.org_id, user.id, 'lab.release', l.id);
  return c.json({ lab: l });
});

/* ------------------------------------------------------- visit summaries -- */

api.put('/orgs/:org/appointments/:id/summary', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  await requireActive(me.org_id);
  const [a] = await db()`select * from appointments where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id}`;
  if (!a) fail(404, 'no such appointment');
  const b = await body(c);
  const [s] = await db()`
    insert into visit_summaries (org_id, appointment_id, patient_id, provider_id, diagnosis, instructions, med_changes, follow_up_on)
    values (${me.org_id}, ${a.id}, ${a.patient_id}, ${a.provider_id ?? me.id}, ${str(b.diagnosis, 2000)},
            ${str(b.instructions, 5000)}, ${str(b.med_changes, 2000)}, ${str(b.follow_up_on, 10)})
    on conflict (appointment_id) do update set
      diagnosis = excluded.diagnosis, instructions = excluded.instructions, med_changes = excluded.med_changes,
      follow_up_on = excluded.follow_up_on, updated_at = now()
    where visit_summaries.status = 'draft'
    returning *`;
  if (!s) fail(409, 'that summary is signed and can no longer change');
  await audit(me.org_id, user.id, 'summary.save', s.id);
  return c.json({ summary: s });
});

api.get('/orgs/:org/summaries', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  return c.json({
    summaries: await db()`
      select s.*, p.name as patient, a.starts_at from visit_summaries s
      join org_people p on p.id = s.patient_id left join appointments a on a.id = s.appointment_id
      where s.org_id = ${me.org_id} and s.status = 'draft' order by s.updated_at desc limit 200`,
  });
});

api.post('/orgs/:org/summaries/:id/sign', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  const sql = db();
  const s = await sql.begin(async (tx) => {
    const [s] = await tx`update visit_summaries set status = 'signed', signed_at = now(), provider_id = coalesce(provider_id, ${me.id})
                         where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} and status = 'draft' returning *`;
    if (!s) fail(404, 'no such draft summary');
    if (s.appointment_id) await tx`update appointments set status = 'completed', updated_at = now()
                                   where id = ${s.appointment_id} and status not in ('cancelled', 'no_show')`;
    return s;
  });
  await audit(me.org_id, user.id, 'summary.sign', s.id);
  return c.json({ summary: s });
});

/* ------------------------------------------------- care plans + navigation -- */
// The advocate's work: a care plan per patient, enrollment in a care-management
// program (PIN, CHI, CCM), minutes logged against it, and the month's superbill.

const day = (v, what) => {
  const s = str(v, 10);
  if (s && !DATE.test(s)) fail(400, `${what} must be YYYY-MM-DD`);
  return s;
};
const monthOf = (c) => {
  const m = c.req.query('month') ?? nav.thisMonth();
  try {
    return { month: m, ...nav.monthRange(m) };
  } catch (err) {
    fail(400, err.message);
  }
};

async function carePlan(patientId) {
  const [plan] = await db()`
    select pl.*, o.name as owner from care_plans pl left join org_people o on o.id = pl.owner_id
    where pl.patient_id = ${patientId} and pl.status = 'active'`;
  if (!plan) return null;
  const items = await db()`
    select i.*, o.name as owner from care_plan_items i left join org_people o on o.id = i.owner_id
    where i.plan_id = ${plan.id} and i.status <> 'dropped'
    order by i.kind, i.status desc, i.due_on nulls last, i.created_at`;
  return { ...plan, items };
}

/** Enrollments with their minutes in a month, decorated with codes and blockers. */
async function programRows(orgId, { start, end, month }, filter) {
  const sql = db();
  const rows = await sql`
    select cp.*, p.name as patient, p.dob, bp.name as billing_provider, bp.npi as billing_npi, nv.name as navigator,
           exists(select 1 from care_plans pl where pl.patient_id = cp.patient_id and pl.status = 'active') as has_care_plan,
           coalesce((select sum(t.minutes) from care_time t where t.program_id = cp.id
                     and t.performed_on >= ${start} and t.performed_on < ${end}), 0)::int as minutes
    from care_programs cp join org_people p on p.id = cp.patient_id
    left join org_people bp on bp.id = cp.billing_provider_id left join org_people nv on nv.id = cp.navigator_id
    where cp.org_id = ${orgId} ${filter(sql)}
    order by p.name nulls last, cp.program`;
  return rows.map((r) => ({
    ...nav.superbillRow(r, r.minutes, month),
    status: r.status,
    navigator_id: r.navigator_id,
    billing_provider_id: r.billing_provider_id,
    consent_at: r.consent_at,
    initiating_visit_on: nav.ymd(r.initiating_visit_on),
    started_on: nav.ymd(r.started_on),
  }));
}

api.get('/navigation/programs', (c) => c.json({ programs: nav.PROGRAMS, activities: nav.ACTIVITIES }));

api.get('/orgs/:org/patients/:id/care-plan', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  await audit(me.org_id, user.id, 'care_plan.read', p.id);
  return c.json({ care_plan: await carePlan(p.id) });
});

api.put('/orgs/:org/patients/:id/care-plan', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  const owner = b.owner_id ? await personIn(me.org_id, b.owner_id, TEAM, 'owner') : null;
  const shared = b.shared === undefined ? null : Boolean(b.shared);
  const [plan] = await db()`
    insert into care_plans (org_id, patient_id, title, summary, owner_id, shared)
    values (${me.org_id}, ${p.id}, ${str(b.title, 120) ?? 'Care plan'}, ${str(b.summary, 5000)}, ${owner?.id ?? me.id}, ${shared ?? false})
    on conflict (patient_id) where status = 'active' do update set
      title = coalesce(${str(b.title, 120)}, care_plans.title),
      summary = coalesce(${str(b.summary, 5000)}, care_plans.summary),
      owner_id = coalesce(${owner?.id ?? null}::uuid, care_plans.owner_id),
      shared = coalesce(${shared}::boolean, care_plans.shared),
      updated_at = now()
    returning id`;
  await audit(me.org_id, user.id, 'care_plan.save', plan.id);
  return c.json({ care_plan: await carePlan(p.id) });
});

api.post('/orgs/:org/patients/:id/care-plan/close', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const [plan] = await db()`update care_plans set status = 'closed', updated_at = now()
                            where patient_id = ${p.id} and status = 'active' returning id`;
  if (!plan) fail(404, 'no active care plan');
  await audit(me.org_id, user.id, 'care_plan.close', plan.id);
  return c.json({ ok: true });
});

api.post('/orgs/:org/patients/:id/care-plan/items', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  const text = str(b.text, 500);
  if (!text) fail(400, 'say what the goal or task is');
  // No owner, or "patient": the patient's own to do. Otherwise someone on the team.
  const owner = b.owner_id && b.owner_id !== 'patient' ? await personIn(me.org_id, b.owner_id, TEAM, 'owner') : null;
  const sql = db();
  const [plan] = await sql`
    insert into care_plans (org_id, patient_id, owner_id) values (${me.org_id}, ${p.id}, ${me.id})
    on conflict (patient_id) where status = 'active' do update set updated_at = now()
    returning id`;
  const [item] = await sql`
    insert into care_plan_items (plan_id, org_id, kind, text, owner_id, due_on)
    values (${plan.id}, ${me.org_id}, ${b.kind === 'goal' ? 'goal' : 'task'}, ${text}, ${owner?.id ?? null}, ${day(b.due_on, 'due_on')})
    returning *`;
  await audit(me.org_id, user.id, 'care_plan.item.create', item.id);
  return c.json({ item }, 201);
});

api.patch('/orgs/:org/care-plan-items/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const b = await body(c);
  if (b.status && !['open', 'done', 'dropped'].includes(b.status)) fail(400, 'status must be open, done or dropped');
  const owner = b.owner_id && b.owner_id !== 'patient' ? await personIn(me.org_id, b.owner_id, TEAM, 'owner') : null;
  const [item] = await db()`
    update care_plan_items set
      text = coalesce(${str(b.text, 500)}, text),
      due_on = case when ${b.due_on !== undefined} then ${day(b.due_on, 'due_on')}::date else due_on end,
      owner_id = case when ${b.owner_id !== undefined} then ${owner?.id ?? null}::uuid else owner_id end,
      status = coalesce(${b.status ?? null}, status),
      done_at = case when ${b.status === 'done'} then coalesce(done_at, now()) when ${b.status != null} then null else done_at end
    where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!item) return c.json({ error: 'no such item' }, 404);
  await audit(me.org_id, user.id, `care_plan.item.${b.status ?? 'update'}`, item.id);
  return c.json({ item });
});

api.post('/orgs/:org/patients/:id/programs', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const b = await body(c);
  if (!nav.PROGRAMS[b.program]) fail(400, `program must be one of ${Object.keys(nav.PROGRAMS).join(', ')}`);
  const navigator = b.navigator_id ? await personIn(me.org_id, b.navigator_id, TEAM, 'navigator') : me;
  const biller = b.billing_provider_id ? await personIn(me.org_id, b.billing_provider_id, CLINICIAN, 'billing provider') : null;
  let visit = day(b.initiating_visit_on, 'initiating_visit_on');
  if (!visit && biller) {
    // Default to the patient's last completed visit with the billing practitioner.
    const [last] = await db()`
      select to_char(starts_at, 'YYYY-MM-DD') as on from appointments
      where patient_id = ${p.id} and provider_id = ${biller.id} and status = 'completed'
      order by starts_at desc limit 1`;
    visit = last?.on ?? null;
  }
  const [row] = await db()`
    insert into care_programs (org_id, patient_id, program, condition, navigator_id, billing_provider_id,
                               consent_at, consent_by, initiating_visit_on, started_on)
    values (${me.org_id}, ${p.id}, ${b.program}, ${str(b.condition, 300)}, ${navigator.id}, ${biller?.id ?? null},
            ${b.consent === true ? new Date() : null}, ${b.consent === true ? me.id : null}, ${visit},
            ${day(b.started_on, 'started_on') ?? new Date().toISOString().slice(0, 10)})
    returning *`;
  await audit(me.org_id, user.id, `program.enroll.${b.program}`, row.id);
  return c.json({ program: row }, 201);
});

api.patch('/orgs/:org/programs/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const b = await body(c);
  const navigator = b.navigator_id ? await personIn(me.org_id, b.navigator_id, TEAM, 'navigator') : null;
  const biller = b.billing_provider_id ? await personIn(me.org_id, b.billing_provider_id, CLINICIAN, 'billing provider') : null;
  const end = b.status === 'ended';
  const [row] = await db()`
    update care_programs set
      condition = coalesce(${str(b.condition, 300)}, condition),
      navigator_id = coalesce(${navigator?.id ?? null}::uuid, navigator_id),
      billing_provider_id = coalesce(${biller?.id ?? null}::uuid, billing_provider_id),
      initiating_visit_on = coalesce(${day(b.initiating_visit_on, 'initiating_visit_on')}::date, initiating_visit_on),
      consent_at = case when ${b.consent === true} then now() when ${b.consent === false} then null else consent_at end,
      consent_by = case when ${b.consent === true} then ${me.id}::uuid when ${b.consent === false} then null else consent_by end,
      status = case when ${end} then 'ended' else status end,
      ended_on = case when ${end} then current_date else ended_on end,
      updated_at = now()
    where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning *`;
  if (!row) return c.json({ error: 'no such program' }, 404);
  // Consent again renews it (PIN and CHI need it yearly); false withdraws it.
  await audit(me.org_id, user.id, end ? 'program.end' : b.consent !== undefined ? `program.consent.${b.consent}` : 'program.update', row.id);
  return c.json({ program: row });
});

api.post('/orgs/:org/programs/:id/time', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const b = await body(c);
  const minutes = Math.round(Number(b.minutes));
  if (!(minutes >= 1 && minutes <= 240)) fail(400, 'minutes must be 1 to 240');
  const activity = b.activity ?? 'coordination';
  if (!nav.ACTIVITIES.includes(activity)) fail(400, `activity must be one of ${nav.ACTIVITIES.join(', ')}`);
  const on = day(b.performed_on, 'performed_on') ?? new Date().toISOString().slice(0, 10);
  // A day of slack for time zones ahead of UTC.
  if (on > new Date(Date.now() + 86400_000).toISOString().slice(0, 10)) fail(400, 'time cannot be logged in the future');
  const [prog] = await db()`select * from care_programs where id = ${uuid(c.req.param('id'), 'program')} and org_id = ${me.org_id}`;
  if (!prog) fail(404, 'no such program');
  if (prog.status !== 'active') fail(409, 'that program has ended');
  const [t] = await db()`
    insert into care_time (org_id, program_id, patient_id, person_id, minutes, performed_on, activity, note, created_by)
    values (${me.org_id}, ${prog.id}, ${prog.patient_id}, ${me.id}, ${minutes}, ${on}, ${activity}, ${str(b.note, 1000)}, ${user.id})
    returning *`;
  await audit(me.org_id, user.id, 'program.time', t.id);
  const month = on.slice(0, 7);
  const [r] = await programRows(me.org_id, { ...nav.monthRange(month), month }, (sql) => sql`and cp.id = ${prog.id}`);
  return c.json({ time: t, program: r }, 201);
});

api.get('/orgs/:org/programs/:id/time', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const m = monthOf(c);
  const id = uuid(c.req.param('id'), 'program');
  const time = await db()`
    select t.*, p.name as by from care_time t left join org_people p on p.id = t.person_id
    where t.program_id = ${id} and t.org_id = ${me.org_id}
      and t.performed_on >= ${m.start} and t.performed_on < ${m.end}
    order by t.performed_on desc, t.created_at desc`;
  await audit(me.org_id, user.id, 'program.time.read', id);
  return c.json({ month: m.month, time });
});

api.delete('/orgs/:org/time/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const admin = ADMIN.includes(me.user_type);
  const [t] = await db()`
    delete from care_time where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id}
      and (${admin} or created_by = ${user.id}) returning id`;
  if (!t) return c.json({ error: 'no such entry of yours' }, 404);
  await audit(me.org_id, user.id, 'program.time.delete', t.id);
  return c.json({ ok: true });
});

/** The advocate's queue: active enrollments, this month's minutes, open tasks. */
api.get('/orgs/:org/caseload', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const m = monthOf(c);
  // Advocates see their own patients unless they ask for everyone; others the reverse.
  const mine = c.req.query('mine') === '1' || (me.user_type === 'advocate' && c.req.query('all') !== '1');
  const rows = await programRows(
    me.org_id,
    m,
    (sql) => sql`and cp.status = 'active' ${mine ? sql`and cp.navigator_id = ${me.id}` : sql``}`,
  );
  const ids = [...new Set(rows.map((r) => r.patient_id))];
  const tasks = ids.length
    ? await db()`select pl.patient_id, count(*)::int as open,
                        count(*) filter (where i.due_on < current_date)::int as overdue
                 from care_plan_items i join care_plans pl on pl.id = i.plan_id
                 where pl.patient_id = any(${ids}) and pl.status = 'active' and i.status = 'open' and i.kind = 'task'
                 group by pl.patient_id`
    : [];
  for (const r of rows) {
    const t = tasks.find((x) => x.patient_id === r.patient_id);
    r.open_tasks = t?.open ?? 0;
    r.overdue_tasks = t?.overdue ?? 0;
  }
  return c.json({ month: m.month, mine, caseload: rows });
});

/** Everything billable in a month. ?format=csv. Units need their full time (see navigation.js). */
api.get('/orgs/:org/superbill', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), BILLERS);
  const m = monthOf(c);
  // Every enrollment that overlapped the month and has time in it.
  const rows = (
    await programRows(
      me.org_id,
      m,
      (sql) => sql`and cp.started_on < ${m.end} and (cp.ended_on is null or cp.ended_on >= ${m.start})`,
    )
  ).filter((r) => r.minutes > 0);
  rows.sort((a, b) => Number(b.ready) - Number(a.ready));
  await audit(me.org_id, user.id, 'superbill.read', m.month);
  if (c.req.query('format') === 'csv')
    return c.body(nav.superbillCsv(rows, { month: m.month, practice: me.org_name }), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="superbill-${m.month}.csv"`,
      'cache-control': 'no-store',
    });
  const totals = {};
  for (const r of rows) if (r.ready) for (const l of r.lines) totals[l.code] = (totals[l.code] ?? 0) + l.units;
  return c.json({
    month: m.month,
    rows,
    totals,
    ready: rows.filter((r) => r.ready).length,
    held: rows.filter((r) => !r.ready && r.lines.length).length,
    under: rows.filter((r) => !r.lines.length).length,
  });
});

/* ----------------------------------------------------------- front desk -- */
// Today's work in one call: the dashboard, the CLI's `schedule`, the TUI and the
// MCP get_schedule tool all read this.

api.get('/orgs/:org/today', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  const tz = str(c.req.query('tz'), 60) ?? 'America/Los_Angeles';
  const sql = db();
  const [appointments, refills, labs, summaries] = await Promise.all([
    dayAppointments(me.org_id, { date, tz }),
    sql`select r.id, r.requested_at, m.name as medication, m.dose, p.name as patient, p.id as patient_id
        from refill_requests r join medications m on m.id = r.medication_id join org_people p on p.id = r.patient_id
        where r.org_id = ${me.org_id} and r.status = 'pending' order by r.requested_at limit 50`,
    sql`select l.id, l.test_name, l.value, l.value_text, l.unit, l.flag, p.name as patient, p.id as patient_id
        from lab_results l join org_people p on p.id = l.patient_id
        where l.org_id = ${me.org_id} and l.released_at is null order by l.created_at desc limit 50`,
    sql`select s.id, s.appointment_id, p.name as patient, p.id as patient_id from visit_summaries s join org_people p on p.id = s.patient_id
        where s.org_id = ${me.org_id} and s.status = 'draft' order by s.updated_at desc limit 50`,
  ]);
  const ids = appointments.map((a) => a.id);
  const dayCalls = ids.length
    ? await sql`select id, appointment_id, kind, status, due_at, next_attempt_at, summary, flagged, skip_reason
                from calls where appointment_id = any(${ids})`
    : [];
  for (const a of appointments) a.calls = dayCalls.filter((x) => x.appointment_id === a.id);
  const flagged = await sql`
    select c.id, c.kind, c.summary, c.flag_reason, c.ended_at, p.name as patient, p.id as patient_id, p.phone
    from calls c join org_people p on p.id = c.patient_id
    where c.org_id = ${me.org_id} and c.flagged and c.resolved_at is null order by c.ended_at desc limit 50`;
  return c.json({ date, appointments, needs: { calls: flagged, refills, labs, summaries } });
});

/** The CLI/TUI/MCP shape: ?org= or the caller's first practice. */
api.get('/schedule', async (c) => {
  const user = await requireUser(c);
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  let orgId = c.req.query('org');
  if (!orgId) {
    const [first] = await db()`select org_id from org_people where user_id = ${user.id} and status = 'active'
                               and user_type::text = any(${TEAM}) order by created_at limit 1`;
    if (!first) return c.json({ error: 'you are not on a practice team yet' }, 404);
    orgId = first.org_id;
  }
  const { me } = await member(c, orgId);
  const tz = str(c.req.query('tz'), 60) ?? 'America/Los_Angeles';
  const rows = await dayAppointments(me.org_id, { date, tz });
  const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  // Every field a string, so terminal clients can pad and print without checks.
  return c.json({
    date,
    tz,
    org: { id: me.org_id, name: me.org_name },
    appointments: rows.map((a) => ({
      id: a.id,
      start: a.starts_at,
      time: hhmm.format(new Date(a.starts_at)),
      minutes: a.minutes,
      location: a.mode === 'video' ? 'video' : (a.location ?? ''),
      provider: a.provider ?? 'unassigned',
      patient: a.patient ?? '',
      type: a.reason ?? '',
      mode: a.mode === 'video' ? 'video' : 'in person',
      status: a.status.replace('_', ' '),
    })),
  });
});

/* --------------------------------------------------------- health records -- */
// A patient's imported records from other providers (MyChart and any SMART on
// FHIR portal). They belong to the account; a practice sees a connection only
// once the patient shares it.

const recordsScope = (c) => {
  const id = c.req.query('connection');
  return id ? { connectionId: uuid(id, 'connection') } : {};
};
const CATEGORY_KEYS = records.CATEGORIES.map(([k]) => k);
const categoryParam = (v) => {
  if (!v) return null;
  if (!CATEGORY_KEYS.includes(v)) fail(400, `category is one of ${CATEGORY_KEYS.join(', ')}`);
  return v;
};
const download = (c, f) =>
  c.body(new Uint8Array(f.data), 200, {
    'content-type': f.content_type || 'application/octet-stream',
    'content-disposition': `${c.req.query('inline') ? 'inline' : 'attachment'}; filename="${String(f.title || 'file').replace(/[^\w .-]+/g, '_').slice(0, 80)}"`,
    'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, no-store',
  });

api.get('/records/providers', async (c) => {
  await requireUser(c);
  return c.json({ providers: await records.searchProviders(c.req.query('q') ?? '') });
});

api.get('/records', async (c) => {
  const user = await requireUser(c);
  const [connections, summary, practices] = await Promise.all([
    records.connections(user.id),
    records.overview(user.id, recordsScope(c)),
    myPatientRows(user),
  ]);
  return c.json({ connections, ...summary, practices: practices.map((p) => ({ org_id: p.org_id, org_name: p.org_name })) });
});

api.get('/records/items', async (c) => {
  const user = await requireUser(c);
  const q = c.req.query();
  return c.json({ items: await records.items(user.id, { category: categoryParam(q.category), q: str(q.q, 100), limit: q.limit, offset: q.offset, ...recordsScope(c) }) });
});

api.get('/records/items/:id', async (c) => {
  const user = await requireUser(c);
  return c.json({ item: await records.item(user.id, uuid(c.req.param('id'))) });
});

api.get('/records/files/:id', async (c) => {
  const user = await requireUser(c);
  return download(c, await records.file(user.id, uuid(c.req.param('id'))));
});

api.post('/records/connect', async (c) => {
  const user = await requireUser(c);
  const b = await body(c);
  const r = await records.start(user, { provider_id: str(b.provider_id, 200), fhir_base: str(b.fhir_base, 500), name: str(b.name, 200), return_to: b.return_to });
  return c.json({ connection_id: r.connection.id, provider_name: r.connection.provider_name, authorize_url: r.authorize_url }, 201);
});

api.get('/records/connections/:id', async (c) => {
  const user = await requireUser(c);
  const conn = await records.connectionFor(user.id, uuid(c.req.param('id'), 'connection'));
  const [row] = (await records.connections(user.id)).filter((x) => x.id === conn.id);
  return c.json({ connection: row ?? { id: conn.id, provider_name: conn.provider_name, status: conn.status, last_error: conn.last_error } });
});

api.post('/records/connections/:id/sync', async (c) => {
  const user = await requireUser(c);
  const conn = await records.connectionFor(user.id, uuid(c.req.param('id'), 'connection'));
  if (['pending', 'expired', 'revoked'].includes(conn.status)) fail(409, `${conn.provider_name}: reconnect first`);
  if (c.req.query('wait')) return c.json(await records.sync(conn.id));
  records.syncInBackground(conn.id);
  return c.json({ ok: true, started: true }, 202);
});

// Disconnecting deletes the tokens AND everything imported through them.
api.delete('/records/connections/:id', async (c) => {
  const user = await requireUser(c);
  const conn = await records.connectionFor(user.id, uuid(c.req.param('id'), 'connection'));
  await db()`delete from health_connections where id = ${conn.id}`;
  return c.json({ ok: true });
});

api.put('/records/connections/:id/share', async (c) => {
  const user = await requireUser(c);
  const conn = await records.connectionFor(user.id, uuid(c.req.param('id'), 'connection'));
  const { org_id, shared } = await body(c);
  uuid(org_id, 'org');
  const [p] = (await myPatientRows(user)).filter((x) => x.org_id === org_id);
  if (!p) fail(404, 'you are not a patient of that practice');
  if (shared) {
    await db()`insert into health_connection_shares (connection_id, org_id, patient_id) values (${conn.id}, ${org_id}, ${p.id})
               on conflict (connection_id, org_id) do update set patient_id = excluded.patient_id`;
  } else {
    await db()`delete from health_connection_shares where connection_id = ${conn.id} and org_id = ${org_id}`;
  }
  await audit(org_id, user.id, shared ? 'records.share' : 'records.unshare', p.id);
  return c.json({ ok: true, shared: Boolean(shared) });
});

api.get('/records/export', async (c) => {
  const user = await requireUser(c);
  const scope = recordsScope(c);
  if (c.req.query('format') === 'bundle') {
    const bundle = await records.exportBundle(user.id, scope);
    return c.body(JSON.stringify(bundle), 200, {
      'content-type': 'application/fhir+json',
      'content-disposition': `attachment; filename="tleehealth-records-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }
  const z = await records.exportZip(user.id, scope);
  return c.body(z.bytes, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${z.filename}"`,
    'x-records': String(z.records),
    'x-files': String(z.files),
  });
});

// Who has looked at the records you shared: every practice read, file and export,
// with the person and the practice, from the audit log.
const ACCESS_ACTIONS = ['records.read', 'records.file', 'records.export', 'records.share', 'records.unshare'];
api.get('/records/access', async (c) => {
  const user = await requireUser(c);
  const ids = (await myPatientRows(user)).map((p) => p.id);
  const rows = ids.length
    ? await db()`
        select a.at, a.action, o.name as org_name, coalesce(u.name, u.email) as who, (a.user_id = ${user.id}) as you
        from audit_log a join organizations o on o.id = a.org_id left join users u on u.id = a.user_id
        where a.subject = any(${ids.map(String)}) and a.action = any(${ACCESS_ACTIONS})
        order by a.at desc limit 500`
    : [];
  return c.json({ access: rows });
});

// The team's view: only connections this patient shared with this practice.
api.get('/orgs/:org/patients/:id/records', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const scope = { orgId: me.org_id, patientId: p.id };
  const [summary, list, shared] = await Promise.all([
    records.overview(null, scope),
    records.items(null, { ...scope, category: categoryParam(c.req.query('category')), limit: c.req.query('limit') ?? 200 }),
    db()`select c.provider_name, c.last_synced_at, s.shared_at from health_connection_shares s
         join health_connections c on c.id = s.connection_id where s.org_id = ${me.org_id} and s.patient_id = ${p.id}`,
  ]);
  await audit(me.org_id, user.id, 'records.read', p.id);
  return c.json({ connections: shared, ...summary, items: list });
});

api.get('/orgs/:org/patients/:id/records/export', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), CLINICIAN);
  const p = await personIn(me.org_id, c.req.param('id'), ['patient'], 'patient');
  const z = await records.exportZip(null, { orgId: me.org_id, patientId: p.id });
  await audit(me.org_id, user.id, 'records.export', p.id);
  return c.body(z.bytes, 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${z.filename}"` });
});

api.get('/orgs/:org/patients/:pid/records/files/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const p = await personIn(me.org_id, c.req.param('pid'), ['patient'], 'patient');
  const f = await records.file(null, uuid(c.req.param('id')), { orgId: me.org_id, patientId: p.id });
  await audit(me.org_id, user.id, 'records.file', p.id);
  return download(c, f);
});

/* ---------------------------------------------------------------- portal -- */
// What a signed-in patient sees, across every practice they are a patient of.

async function myPatientRows(user) {
  return db()`select p.*, o.name as org_name from org_people p join organizations o on o.id = p.org_id
              where p.user_id = ${user.id} and p.user_type = 'patient' and p.status = 'active'`;
}

api.get('/portal', async (c) => {
  const user = await requireUser(c);
  const sql = db();
  const practices = [];
  for (const p of await myPatientRows(user)) {
    const [appointments, medications, labs, summaries] = await Promise.all([
      sql`select a.id, a.starts_at, a.minutes, a.mode, a.status, a.reason, l.name as location, l.address, pr.name as provider
          from appointments a left join locations l on l.id = a.location_id left join org_people pr on pr.id = a.provider_id
          where a.patient_id = ${p.id} and a.starts_at > now() - interval '1 day' and a.status <> 'cancelled'
          order by a.starts_at limit 20`,
      sql`select m.id, m.name, m.dose, m.directions, m.refills_left,
                 exists(select 1 from refill_requests r where r.medication_id = m.id and r.status = 'pending') as refill_pending
          from medications m where m.patient_id = ${p.id} and m.status = 'active' order by m.name`,
      sql`select id, test_name, value, value_text, unit, ref_low, ref_high, flag, collected_at
          from lab_results where patient_id = ${p.id} and released_at is not null order by collected_at desc limit 100`,
      sql`select s.id, s.diagnosis, s.instructions, s.med_changes, s.follow_up_on, s.signed_at, pr.name as provider
          from visit_summaries s left join org_people pr on pr.id = s.provider_id
          where s.patient_id = ${p.id} and s.status = 'signed' order by s.signed_at desc limit 20`,
    ]);
    // A care plan shows once the team shares it, without internal fields.
    const plan = await carePlan(p.id);
    const care_plan = plan?.shared
      ? {
          title: plan.title,
          summary: plan.summary,
          owner: plan.owner,
          updated_at: plan.updated_at,
          items: plan.items.map((i) => ({ kind: i.kind, text: i.text, owner: i.owner ?? 'You', due_on: i.due_on, status: i.status })),
        }
      : null;
    await audit(p.org_id, user.id, 'portal.read', p.id);
    practices.push({
      care_plan,
      org: { id: p.org_id, name: p.org_name },
      patient_id: p.id,
      calls_ok: Boolean(p.call_consent_at && !p.call_opt_out_at),
      appointments,
      medications,
      labs,
      summaries,
    });
  }
  return c.json({ practices });
});

api.post('/portal/calls', async (c) => {
  const user = await requireUser(c);
  const b = await body(c);
  const mine = (await myPatientRows(user)).find((p) => p.org_id === b.org_id);
  if (!mine) return c.json({ error: 'no such practice' }, 404);
  const sql = db();
  if (b.calls_ok) await sql`update org_people set call_consent_at = coalesce(call_consent_at, now()), call_opt_out_at = null where id = ${mine.id}`;
  else {
    await sql`update org_people set call_opt_out_at = now() where id = ${mine.id}`;
    await sql`update calls set status = 'skipped', skip_reason = 'patient opted out of calls', updated_at = now()
              where patient_id = ${mine.id} and status in ('queued', 'no_answer')`;
  }
  await audit(mine.org_id, user.id, b.calls_ok ? 'portal.calls.opt_in' : 'portal.calls.opt_out', mine.id);
  return c.json({ calls_ok: Boolean(b.calls_ok) });
});

api.post('/portal/refills', async (c) => {
  const user = await requireUser(c);
  const b = await body(c);
  const [m] = await db()`select org_id, patient_id from medications where id = ${uuid(b.medication_id, 'medication')}`;
  const mine = m && (await myPatientRows(user)).find((p) => p.id === m.patient_id);
  if (!mine) return c.json({ error: 'no such medication' }, 404);
  const r = await fileRefill(mine.org_id, mine.id, b.medication_id, str(b.note, 300));
  await audit(mine.org_id, user.id, 'portal.refill', r.id);
  return c.json({ refill: r }, 201);
});

api.post('/portal/appointments/:id/:action{confirm|cancel}', async (c) => {
  const user = await requireUser(c);
  const ids = (await myPatientRows(user)).map((p) => p.id);
  const status = c.req.param('action') === 'confirm' ? 'confirmed' : 'cancelled';
  const [a] = await db()`
    update appointments set status = ${status}, updated_at = now()
    where id = ${uuid(c.req.param('id'))} and patient_id = any(${ids}) and status in ('scheduled', 'confirmed')
      and starts_at > now() returning id, org_id, status`;
  if (!a) return c.json({ error: 'no such upcoming appointment' }, 404);
  await audit(a.org_id, user.id, `portal.appointment.${status}`, a.id);
  return c.json({ appointment: a });
});

/* ------------------------------------------------------------------ calls -- */

api.get('/orgs/:org/call-settings', async (c) => {
  const { me } = await member(c, c.req.param('org'));
  return c.json({ settings: await calls.settingsFor(me.org_id), calling_configured: calls.configured() });
});

api.put('/orgs/:org/call-settings', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  const b = await body(c);
  const cur = await calls.settingsFor(me.org_id);
  const int = (v, d) => (v === undefined || v === null || v === '' ? d : Math.round(Number(v)));
  const next = {
    enabled: b.enabled === undefined ? cur.enabled : Boolean(b.enabled),
    reminder_hours_before: int(b.reminder_hours_before, cur.reminder_hours_before),
    followup_hours_after: int(b.followup_hours_after, cur.followup_hours_after),
    call_window_start: int(b.call_window_start, cur.call_window_start),
    call_window_end: int(b.call_window_end, cur.call_window_end),
    max_attempts: int(b.max_attempts, cur.max_attempts),
  };
  if (next.call_window_start >= next.call_window_end) fail(400, 'the calling window must start before it ends');
  const [s] = await db()`
    insert into org_call_settings ${db()({ org_id: me.org_id, ...next })}
    on conflict (org_id) do update set enabled = excluded.enabled, reminder_hours_before = excluded.reminder_hours_before,
      followup_hours_after = excluded.followup_hours_after, call_window_start = excluded.call_window_start,
      call_window_end = excluded.call_window_end, max_attempts = excluded.max_attempts, updated_at = now()
    returning *`;
  // Re-time every queued call under the new settings.
  const upcoming = await db()`select distinct appointment_id from calls where org_id = ${me.org_id} and status in ('queued', 'no_answer')`;
  for (const r of upcoming) await calls.syncAppointmentCalls(r.appointment_id);
  await audit(me.org_id, user.id, 'calls.settings');
  return c.json({ settings: s });
});

api.get('/orgs/:org/calls/:id', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const [row] = await db()`
    select c.*, p.name as patient, a.starts_at from calls c
    join org_people p on p.id = c.patient_id join appointments a on a.id = c.appointment_id
    where c.id = ${uuid(c.req.param('id'))} and c.org_id = ${me.org_id}`;
  if (!row) return c.json({ error: 'no such call' }, 404);
  await audit(me.org_id, user.id, 'call.read', row.id);
  return c.json({ call: row });
});

api.post('/orgs/:org/calls/:id/resolve', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  const [row] = await db()`update calls set resolved_at = now(), resolved_by = ${me.id}, updated_at = now()
                           where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id} returning id`;
  if (!row) return c.json({ error: 'no such call' }, 404);
  await audit(me.org_id, user.id, 'call.resolve', row.id);
  return c.json({ ok: true });
});

/** Call now: queue this appointment's reminder (or follow-up) as due immediately. */
api.post('/orgs/:org/appointments/:id/call', async (c) => {
  const { me, user } = await member(c, c.req.param('org'));
  await requireActive(me.org_id);
  const kind = (await body(c)).kind === 'followup' ? 'followup' : 'reminder';
  const [a] = await db()`select * from appointments where id = ${uuid(c.req.param('id'))} and org_id = ${me.org_id}`;
  if (!a) return c.json({ error: 'no such appointment' }, 404);
  const [row] = await db()`
    insert into calls (org_id, appointment_id, patient_id, kind, due_at)
    values (${me.org_id}, ${a.id}, ${a.patient_id}, ${kind}, now())
    on conflict (appointment_id, kind) do update set
      status = 'queued', due_at = now(), next_attempt_at = null, attempts = 0, skip_reason = null,
      last_error = null, call_control_id = null, outcome = null, summary = null, transcript = null,
      flagged = false, flag_reason = null, resolved_at = null, started_at = null, ended_at = null, updated_at = now()
    where calls.status not in ('dialing', 'in_progress')
    returning *`;
  if (!row) return c.json({ error: 'a call for this appointment is already in progress' }, 409);
  await audit(me.org_id, user.id, `call.now.${kind}`, row.id);
  await calls.tick({ manualOrgId: me.org_id });
  const [after] = await db()`select id, status, skip_reason, last_error from calls where id = ${row.id}`;
  return c.json({ call: after });
});

/* --------------------------------------------------------------- billing -- */

async function billing(orgId) {
  const [row] = await db()`
    select coalesce(s.seats, 0)::int as seats, b.paid_through, o.created_at
    from organizations o left join org_seats s on s.org_id = o.id left join org_billing b on b.org_id = o.id
    where o.id = ${orgId}`;
  const trialEnds = new Date(new Date(row.created_at).getTime() + TRIAL_DAYS * 86400_000);
  const paid = row.paid_through && new Date(row.paid_through) > new Date();
  return {
    seats: row.seats,
    monthly_cents: monthlyCents(row.seats),
    paid_through: row.paid_through,
    trial_ends: trialEnds,
    active: Boolean(paid || trialEnds > new Date()),
    payments_enabled: paymentsEnabled(),
  };
}

api.get('/orgs/:org/billing', async (c) => {
  const { me } = await member(c, c.req.param('org'), ADMIN);
  const payments = await db()`
    select p.amount_cents, p.status, p.created_at from payments p
    where p.raw->'payment'->'metadata'->>'org_id' = ${me.org_id} or p.raw->'metadata'->>'org_id' = ${me.org_id}
    order by p.created_at desc limit 24`;
  return c.json({ billing: await billing(me.org_id), payments });
});

api.post('/orgs/:org/billing/checkout', async (c) => {
  const { me, user } = await member(c, c.req.param('org'), ADMIN);
  if (!paymentsEnabled()) return c.json({ error: 'payments are not switched on yet' }, 503);
  const b = await billing(me.org_id);
  if (b.monthly_cents === null) return c.json({ error: 'over 1,000 seats: contact us for pricing' }, 400);
  // Crypto only: Stripe banned the owner, so CoinPay's card path (which goes
  // through Stripe) must never be offered. See memory no-stripe-banned.
  let checkoutUrl;
  try {
    ({ checkoutUrl } = await createCheckout({
    user,
    amountCents: b.monthly_cents,
    description: `tleehealth: ${me.org_name}, 1 month, ${b.seats} seat${b.seats === 1 ? '' : 's'}`,
    metadata: { org_id: me.org_id, kind: 'month', seats: String(b.seats) },
    blockchain: config.coinpay.defaultChain,
    paymentMethod: 'crypto',
    successUrl: `${config.siteUrl}/app/billing?paid=1`,
    cancelUrl: `${config.siteUrl}/app/billing`,
    }));
  } catch (err) {
    console.error('[billing] checkout', err.message);
    return c.json({ error: 'CoinPay could not start the payment. Try again in a minute.' }, 502);
  }
  await audit(me.org_id, user.id, 'billing.checkout');
  return c.json({ checkout_url: checkoutUrl });
});

/** Mounted outside /api/v1 at /webhooks/coinpay. A settled payment adds one month. */
export async function coinpayWebhook(c) {
  const raw = await c.req.text();
  const ok = verifyWebhook({ rawBody: raw, signatureHeader: c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature') });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const result = await settleWebhook(payload, {
    grant: async (tx, { meta, payment }) => {
      if (!meta.org_id || !payment) return null;
      // A redelivered webhook finds its grant already recorded and adds nothing.
      const [fresh] = await tx`insert into billing_grants (payment_id, org_id) values (${payment.id}, ${meta.org_id})
                               on conflict (payment_id) do nothing returning payment_id`;
      if (!fresh) return { already: true };
      const [b] = await tx`
        insert into org_billing (org_id, paid_through) values (${meta.org_id}, now() + interval '1 month')
        on conflict (org_id) do update set paid_through = greatest(coalesce(org_billing.paid_through, now()), now()) + interval '1 month'
        returning paid_through`;
      return b;
    },
  }).catch((err) => ({ error: err.message }));
  return c.json({ ok: true, result });
}
