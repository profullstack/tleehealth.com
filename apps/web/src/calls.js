import { db } from '@tleehealth/db';
import * as telnyx from './telnyx.js';

/**
 * AI phone calls on every appointment: a reminder before it, a follow-up after it.
 *
 * Lifecycle of a `calls` row:
 *   queued -> dialing -> in_progress -> completed | voicemail | no_answer | failed
 *   queued -> skipped (no consent, no phone, opted out, calls off) | cancelled (visit cancelled)
 *   no_answer -> dialing again at next_attempt_at, up to max_attempts
 *
 * The scheduler only ever dials inside the practice's calling window, in the
 * appointment location's time zone. Nothing clinical is answered by the agent:
 * it is captured, the call is flagged, and a human follows up.
 */

const DEFAULT_TZ = 'America/Los_Angeles';

/** Whether this server can place calls at all (Telnyx key, connection, number). */
export const configured = () => telnyx.enabled();
// The healthcare exemption allows at most one automated call a day and three a
// week per patient, so a missed call is retried the next day, not the next hour.
const RETRY_MINUTES = 24 * 60;
const MAX_PER_DAY = 1;
const MAX_PER_WEEK = 3;

export async function settingsFor(orgId) {
  const [s] = await db()`select * from org_call_settings where org_id = ${orgId}`;
  return (
    s ?? {
      org_id: orgId,
      enabled: true,
      reminder_hours_before: 24,
      followup_hours_after: 24,
      call_window_start: 9,
      call_window_end: 19,
      max_attempts: 2,
    }
  );
}

/** Create or move the reminder and follow-up for one appointment. Idempotent. */
export async function syncAppointmentCalls(appointmentId) {
  const sql = db();
  const [a] = await sql`select * from appointments where id = ${appointmentId}`;
  if (!a) return;
  if (['cancelled'].includes(a.status)) {
    await sql`update calls set status = 'cancelled', updated_at = now()
              where appointment_id = ${a.id} and status in ('queued', 'no_answer')`;
    return;
  }
  const s = await settingsFor(a.org_id);
  const start = new Date(a.starts_at).getTime();
  const end = start + a.minutes * 60_000;
  let reminderDue = new Date(start - s.reminder_hours_before * 3600_000);
  // Booked inside the reminder window: call soon, unless the visit is under 2 hours away.
  if (reminderDue < new Date()) reminderDue = start - Date.now() > 2 * 3600_000 ? new Date() : null;
  const followupDue = new Date(end + s.followup_hours_after * 3600_000);

  for (const [kind, due] of [
    ['reminder', reminderDue],
    ['followup', followupDue],
  ]) {
    if (!due) {
      await sql`update calls set status = 'skipped', skip_reason = 'booked too close to the visit', updated_at = now()
                where appointment_id = ${a.id} and kind = ${kind} and status = 'queued'`;
      continue;
    }
    await sql`
      insert into calls (org_id, appointment_id, patient_id, kind, due_at)
      values (${a.org_id}, ${a.id}, ${a.patient_id}, ${kind}, ${due})
      on conflict (appointment_id, kind) do update
        set due_at = excluded.due_at, patient_id = excluded.patient_id,
            status = case when calls.status in ('cancelled', 'skipped') then 'queued' else calls.status end,
            skip_reason = case when calls.status in ('cancelled', 'skipped') then null else calls.skip_reason end,
            updated_at = now()
        where calls.status in ('queued', 'cancelled', 'skipped', 'no_answer')`;
  }
}

/* -------------------------------------------------------------- scheduler -- */

/** The hour (0-23) and a Date for the next window opening, in a time zone. */
function localHour(date, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(date));
}

export function insideWindow(date, tz, startHour, endHour) {
  const h = localHour(date, tz);
  return h >= startHour && h < endHour;
}

/** Next time (on the hour) the window opens, searching up to two days ahead. */
export function nextWindowOpen(from, tz, startHour) {
  const t = new Date(from);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (localHour(t, tz) === startHour) return new Date(t);
  }
  return new Date(from.getTime() + 12 * 3600_000);
}

/** E.164 for US numbers typed any way; null when it cannot be a phone number. */
export function e164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * Dial whatever is due. Runs every minute in each web process; the advisory lock
 * means only one process dials at a time, and the status update to `dialing` is
 * conditional, so a row is never dialled twice.
 */
export async function tick({ now = new Date(), log = console.log } = {}) {
  const sql = db();
  // A session-level lock must be taken and released on the SAME connection; through
  // the pool the unlock can land elsewhere and the lock leaks, silently stopping
  // every later tick. So the lock lives on a reserved connection.
  const lockConn = await sql.reserve();
  const [{ locked }] = await lockConn`select pg_try_advisory_lock(7351002) as locked`;
  if (!locked) {
    lockConn.release();
    return 0;
  }
  let dialled = 0;
  try {
    const due = await sql`
      select c.*, a.starts_at, a.minutes, a.mode, a.status as appt_status, a.reason,
             p.name as patient_name, p.phone, p.call_consent_at, p.call_opt_out_at, p.status as person_status,
             l.name as location, l.address, coalesce(l.timezone, ${DEFAULT_TZ}) as tz,
             pr.name as provider, o.name as org_name
      from calls c
      join appointments a on a.id = c.appointment_id
      join org_people p on p.id = c.patient_id
      join organizations o on o.id = c.org_id
      left join locations l on l.id = a.location_id
      left join org_people pr on pr.id = a.provider_id
      where (c.status = 'queued' and c.due_at <= ${now})
         or (c.status = 'no_answer' and c.next_attempt_at <= ${now})
      order by coalesce(c.next_attempt_at, c.due_at)
      limit 25`;
    for (const c of due) {
      const s = await settingsFor(c.org_id);
      const skip = (reason) =>
        sql`update calls set status = 'skipped', skip_reason = ${reason}, updated_at = now() where id = ${c.id}`;

      if (!s.enabled) { await skip('AI calls are off for this practice'); continue; }
      if (c.appt_status === 'cancelled') {
        await sql`update calls set status = 'cancelled', updated_at = now() where id = ${c.id}`;
        continue;
      }
      if (c.kind === 'reminder' && new Date(c.starts_at) <= now) { await skip('the visit already started'); continue; }
      if (c.kind === 'reminder' && ['completed', 'checked_in', 'no_show'].includes(c.appt_status)) { await skip(`visit is ${c.appt_status}`); continue; }
      if (c.kind === 'followup' && !['completed', 'no_show', 'checked_in'].includes(c.appt_status)) {
        // The visit is not marked done yet; look again in an hour, for up to two days.
        if (now - new Date(c.due_at) > 48 * 3600_000) { await skip('visit never marked completed'); continue; }
        await sql`update calls set status = 'queued', due_at = ${new Date(now.getTime() + 3600_000)}, updated_at = now() where id = ${c.id}`;
        continue;
      }
      if (c.person_status !== 'active') { await skip('patient archived'); continue; }
      if (c.call_opt_out_at) { await skip('patient opted out of calls'); continue; }
      if (!c.call_consent_at) { await skip('no consent to automated calls on file'); continue; }
      const to = e164(c.phone);
      if (!to) { await skip('no valid phone number'); continue; }
      if (!insideWindow(now, c.tz, s.call_window_start, s.call_window_end)) {
        await sql`update calls set next_attempt_at = ${nextWindowOpen(now, c.tz, s.call_window_start)},
                  status = case when status = 'queued' then 'no_answer' else status end, updated_at = now()
                  where id = ${c.id}`;
        // Parked until the window opens; it does not count as an attempt.
        continue;
      }
      if (!telnyx.enabled()) { await skip('calling is not configured on the server'); continue; }
      const [{ day, week, last }] = await sql`
        select count(*) filter (where at > ${now}::timestamptz - interval '24 hours')::int as day,
               count(*) filter (where at > ${now}::timestamptz - interval '7 days')::int as week, max(at) as last
        from call_attempts where patient_id = ${c.patient_id}`;
      if (day >= MAX_PER_DAY || week >= MAX_PER_WEEK) {
        // Called already today (or 3 times this week): next window a day after the last call.
        const after = new Date(Math.max(now.getTime(), new Date(last).getTime() + (week >= MAX_PER_WEEK ? 7 : 1) * 86400_000));
        const at = insideWindow(after, c.tz, s.call_window_start, s.call_window_end) ? after : nextWindowOpen(after, c.tz, s.call_window_start);
        if (c.kind === 'reminder' && at >= new Date(c.starts_at)) { await skip('patient already called within the daily/weekly limit'); continue; }
        await sql`update calls set next_attempt_at = ${at}, status = case when status = 'queued' then 'no_answer' else status end,
                  summary = 'Waiting: patient was already called recently', updated_at = now() where id = ${c.id}`;
        continue;
      }

      const [claimed] = await sql`
        update calls set status = 'dialing', attempts = attempts + 1, to_number = ${to},
               started_at = coalesce(started_at, now()), next_attempt_at = null, updated_at = now()
        where id = ${c.id} and status in ('queued', 'no_answer') returning id, attempts`;
      if (!claimed) continue;
      await sql`insert into call_attempts (call_id, patient_id, at) values (${c.id}, ${c.patient_id}, ${now})`;
      try {
        const callControlId = await telnyx.dial({ to, clientState: { call_id: c.id } });
        await sql`update calls set call_control_id = ${callControlId}, updated_at = now() where id = ${c.id}`;
        dialled++;
        log(`[calls] dialling ${c.kind} ${c.id}`);
      } catch (err) {
        await failOrRetry(c.id, `dial failed: ${err.message}`);
      }
    }
  } finally {
    await lockConn`select pg_advisory_unlock(7351002)`;
    lockConn.release();
  }
  return dialled;
}

/** No answer, busy or an error: retry in an hour until max_attempts, then give up. */
export async function failOrRetry(callId, reason, status = 'no_answer') {
  const sql = db();
  const [c] = await sql`select c.attempts, c.org_id from calls c where c.id = ${callId}`;
  if (!c) return;
  const s = await settingsFor(c.org_id);
  const retry = c.attempts < s.max_attempts;
  await sql`
    update calls set
      status = ${retry ? 'no_answer' : status === 'no_answer' ? 'no_answer' : status},
      next_attempt_at = ${retry ? new Date(Date.now() + RETRY_MINUTES * 60_000) : null},
      last_error = ${reason}, ended_at = now(), updated_at = now(),
      summary = ${retry ? `No answer (attempt ${c.attempts}); trying again` : `No answer after ${c.attempts} attempts`}
    where id = ${callId}`;
}

/* ---------------------------------------------------------- conversation -- */

/** The full context a call needs, by call id. */
export async function callContext(callId) {
  const [c] = await db()`
    select c.*, a.starts_at, a.minutes, a.mode, a.status as appt_status, a.reason,
           p.name as patient_name, p.phone, l.name as location, l.address, l.phone as location_phone,
           coalesce(l.timezone, ${DEFAULT_TZ}) as tz, pr.name as provider, o.name as org_name,
           s.instructions as summary_instructions, s.follow_up_on
    from calls c
    join appointments a on a.id = c.appointment_id
    join org_people p on p.id = c.patient_id
    join organizations o on o.id = c.org_id
    left join locations l on l.id = a.location_id
    left join org_people pr on pr.id = a.provider_id
    left join visit_summaries s on s.appointment_id = a.id and s.status = 'signed'
    where c.id = ${callId}`;
  return c ?? null;
}

const firstName = (n) => (n ?? '').trim().split(/\s+/)[0] || 'there';
const when = (c) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: c.tz }).format(
    new Date(c.starts_at),
  );

/** What the agent says first. It always says it is an automated assistant. */
export function greeting(c) {
  const who = `the automated assistant for ${c.org_name}`;
  const where = c.mode === 'video' ? 'a video visit' : `your visit${c.location ? ` at ${c.location}` : ''}`;
  if (c.kind === 'reminder')
    return `Hi ${firstName(c.patient_name)}, this is ${who}. I'm calling to remind you about ${where}${c.provider ? ` with ${c.provider}` : ''} on ${when(c)}. Will you be able to make it?`;
  if (c.appt_status === 'no_show')
    return `Hi ${firstName(c.patient_name)}, this is ${who}. We missed you at your appointment on ${when(c)}. Would you like to reschedule?`;
  return `Hi ${firstName(c.patient_name)}, this is ${who}, following up on your visit${c.provider ? ` with ${c.provider}` : ''}. How are you feeling since your appointment?`;
}

/** Instructions for the model running the conversation. */
export function instructions(c) {
  const base = [
    `You are a friendly, brief phone assistant for ${c.org_name}, a medical practice. You are an automated AI assistant and say so if asked.`,
    'Never give medical advice, diagnoses, dosing or test interpretation. If the patient asks anything clinical or describes symptoms, say a member of the care team will call them back, and record it as a question for staff.',
    'If the patient describes an emergency (chest pain, trouble breathing, thoughts of self-harm, severe bleeding), tell them to hang up and call 911 now, and record it as urgent.',
    'If the patient asks not to be called again, confirm they will not get further automated calls.',
    'Keep each turn to one or two short sentences. Do not ask for or repeat dates of birth, insurance numbers or other identifiers.',
  ];
  if (c.kind === 'reminder')
    base.push(
      `Goal: find out whether they will attend ${c.mode === 'video' ? 'the video visit' : `the visit${c.location ? ` at ${c.location}${c.address ? `, ${c.address}` : ''}` : ''}`} on ${when(c)}. Options: confirm, cancel, or ask to reschedule (capture the days and times that suit them; staff will call to book it).`,
    );
  else if (c.appt_status === 'no_show')
    base.push('Goal: the patient missed the visit. Find out whether they want to reschedule and what times suit them; staff will book it.');
  else
    base.push(
      `Goal: check how they are doing after the visit, whether they have questions for the care team, and whether they need a refill or another appointment.${
        c.summary_instructions ? ` Their provider's instructions were: "${c.summary_instructions.slice(0, 400)}". You may remind them of these, word for word, but do not add to them.` : ''
      }${c.follow_up_on ? ` A follow-up is due around ${c.follow_up_on.toISOString?.().slice(0, 10) ?? c.follow_up_on}.` : ''}`,
    );
  return base.join(' ');
}

/** The structured outcome the conversation must produce (JSON Schema). */
export function outcomeSchema(c) {
  const props = {
    reached_patient: { type: 'boolean', description: 'True if the person who answered is the patient or their caregiver.' },
    question_for_staff: { type: 'string', description: 'Any question, symptom or request the care team must follow up on, in the patient\'s words. Empty if none.' },
    urgent: { type: 'boolean', description: 'True if they described a possible emergency.' },
    do_not_call: { type: 'boolean', description: 'True if they asked not to receive automated calls.' },
  };
  if (c.kind === 'reminder' || c.appt_status === 'no_show') {
    props.decision = { type: 'string', enum: ['confirm', 'cancel', 'reschedule', 'unsure'], description: 'What the patient wants to do about the appointment.' };
    props.preferred_times = { type: 'string', description: 'Days and times that suit them for a new appointment, if rescheduling.' };
  } else {
    props.feeling = { type: 'string', enum: ['better', 'same', 'worse', 'not_said'], description: 'How they say they feel since the visit.' };
    props.needs_refill = { type: 'boolean', description: 'True if they say they need a medication refill.' };
    props.wants_appointment = { type: 'boolean', description: 'True if they want another appointment.' };
    props.preferred_times = { type: 'string', description: 'Days and times that suit them, if they want an appointment.' };
  }
  return { type: 'object', properties: props, required: ['reached_patient'] };
}

/**
 * Apply what the patient said: confirm or cancel the visit, flag anything a
 * human must handle, record opt-outs. Returns the one-line summary.
 */
export async function applyOutcome(callId, outcome, transcript) {
  const sql = db();
  const c = await callContext(callId);
  if (!c) return null;
  const o = outcome ?? {};
  const flags = [];
  const said = [];

  if (o.urgent) flags.push('URGENT: possible emergency described');
  if (o.question_for_staff?.trim()) flags.push(`Question: ${o.question_for_staff.trim()}`);

  if (o.decision === 'confirm' && c.kind === 'reminder') {
    await sql`update appointments set status = 'confirmed', updated_at = now()
              where id = ${c.appointment_id} and status = 'scheduled'`;
    said.push('Confirmed the visit');
  } else if (o.decision === 'cancel') {
    await sql`update appointments set status = 'cancelled', updated_at = now()
              where id = ${c.appointment_id} and status in ('scheduled', 'confirmed')`;
    await sql`update calls set status = 'cancelled', updated_at = now()
              where appointment_id = ${c.appointment_id} and id <> ${callId} and status in ('queued', 'no_answer')`;
    said.push('Cancelled the visit');
    flags.push('Cancelled by phone: offer to rebook');
  } else if (o.decision === 'reschedule') {
    said.push('Wants to reschedule');
    flags.push(`Reschedule${o.preferred_times ? `: ${o.preferred_times}` : ''}`);
  }
  if (c.kind === 'followup') {
    if (o.feeling && o.feeling !== 'not_said') said.push(`Feeling ${o.feeling}`);
    if (o.feeling === 'worse') flags.push('Says they feel worse since the visit');
    if (o.needs_refill) flags.push('Needs a refill');
    if (o.wants_appointment) flags.push(`Wants an appointment${o.preferred_times ? `: ${o.preferred_times}` : ''}`);
  }
  if (o.do_not_call) {
    await sql`update org_people set call_opt_out_at = now() where id = ${c.patient_id}`;
    await sql`update calls set status = 'skipped', skip_reason = 'patient opted out of calls', updated_at = now()
              where patient_id = ${c.patient_id} and id <> ${callId} and status in ('queued', 'no_answer')`;
    said.push('Asked not to be called');
  }
  if (o.reached_patient === false) said.push('Did not reach the patient');

  const summary = [...said, ...flags.filter((f) => !said.includes(f))].join(' · ') || 'Call completed';
  await sql`
    update calls set status = 'completed', outcome = ${o}, transcript = ${transcript ?? null},
      summary = ${summary}, flagged = ${flags.length > 0}, flag_reason = ${flags.join(' · ') || null},
      ended_at = now(), updated_at = now()
    where id = ${callId}`;
  await sql`insert into audit_log (org_id, action, subject) values (${c.org_id}, ${`call.${c.kind}.completed`}, ${callId})`;
  return summary;
}

/* -------------------------------------------------------------- webhooks -- */

const closing = (o, c) => {
  if (o?.urgent) return 'If this is an emergency, please hang up and call 911 now. Someone from the care team will call you back. Goodbye.';
  if (o?.do_not_call) return "Understood. You won't get any more automated calls from us. Goodbye.";
  if (o?.decision === 'confirm') return "Great, you're confirmed. We'll see you then. Goodbye.";
  if (o?.decision === 'cancel') return `Okay, I've cancelled that appointment. Someone from ${c.org_name} may call to rebook. Goodbye.`;
  if (o?.decision === 'reschedule' || o?.wants_appointment) return `Thanks. Someone from ${c.org_name} will call you to set up a time. Goodbye.`;
  if (o?.question_for_staff || o?.needs_refill || o?.feeling === 'worse') return 'Thank you. A member of the care team will follow up with you. Goodbye.';
  return 'Thank you, and take care. Goodbye.';
};

/** A voicemail carries no health details: the practice, who it is for, a number. */
const voicemail = (c) =>
  `Hi, this is the automated assistant for ${c.org_name} with a message for ${firstName(c.patient_name)}. Please call the office${
    c.location_phone ? ` at ${c.location_phone.split('').join(' ')}` : ''
  } when you have a moment. Thank you, goodbye.`;

const HUMAN = new Set(['human', 'human_residence', 'human_business', 'not_sure', 'silence']);

/**
 * One Telnyx webhook event. The call row is found by client_state (set when we
 * dialled) or by call_control_id. Each step is guarded on the row's status, so a
 * re-delivered event does nothing twice.
 */
export async function handleTelnyxEvent(event) {
  const sql = db();
  const type = event?.data?.event_type ?? '';
  const p = event?.data?.payload ?? {};
  const ccid = p.call_control_id;
  const state = telnyx.readClientState(p.client_state);
  const UUIDISH = /^[0-9a-f-]{36}$/i;
  const [row] = UUIDISH.test(state.call_id ?? '')
    ? await sql`select * from calls where id = ${state.call_id}`
    : ccid
      ? await sql`select * from calls where call_control_id = ${ccid}`
      : [];
  if (!row) return { ignored: `no call for ${type}` };
  if (ccid && !row.call_control_id) await sql`update calls set call_control_id = ${ccid} where id = ${row.id}`;

  switch (type) {
    case 'call.answered':
      await sql`update calls set status = 'in_progress', updated_at = now() where id = ${row.id} and status = 'dialing'`;
      return { ok: 'answered' };

    case 'call.machine.premium.detection.ended':
    case 'call.machine.detection.ended': {
      const result = String(p.result ?? '').toLowerCase();
      if (!result || HUMAN.has(result)) {
        if (row.status !== 'in_progress' && row.status !== 'dialing') return { ignored: 'not live' };
        const c = await callContext(row.id);
        await telnyx.gatherUsingAi(ccid, {
          greeting: greeting(c),
          instructions: instructions(c),
          parameters: outcomeSchema(c),
          clientState: { call_id: row.id, stage: 'talk' },
        });
        return { ok: 'talking' };
      }
      // A machine (or fax): wait for the beep before leaving a message.
      await sql`update calls set status = 'voicemail', updated_at = now() where id = ${row.id} and status in ('dialing', 'in_progress')`;
      if (result === 'fax_detected') await telnyx.hangup(ccid);
      return { ok: 'machine' };
    }

    case 'call.machine.premium.greeting.ended':
    case 'call.machine.greeting.ended':
      if (row.status === 'voicemail') await telnyx.speak(ccid, voicemail(await callContext(row.id)), { call_id: row.id, stage: 'voicemail' });
      return { ok: 'voicemail' };

    case 'call.ai_gather.ended': {
      if (row.status === 'completed') return { ignored: 'already applied' };
      const outcome = p.result ?? {};
      const history = (p.message_history ?? []).map((m) => ({ role: m.role, content: m.content ?? m.text ?? '' }));
      const c = await callContext(row.id);
      if (p.status && p.status !== 'valid') {
        // The conversation ended without the answers (hangup, timeout, unclear).
        await sql`update calls set status = 'completed', transcript = ${history}, outcome = ${outcome},
                  summary = ${`Conversation did not finish (${p.status})`}, flagged = true,
                  flag_reason = 'Call did not finish: may need a human call back', ended_at = now(), updated_at = now()
                  where id = ${row.id}`;
        await telnyx.hangup(ccid);
        return { ok: 'incomplete', status: p.status };
      }
      const summary = await applyOutcome(row.id, outcome, history);
      await telnyx.speak(ccid, closing(outcome, c), { call_id: row.id, stage: 'closing' }).catch(() => telnyx.hangup(ccid));
      return { ok: 'gathered', summary };
    }

    case 'call.speak.ended':
      if (['closing', 'voicemail'].includes(state.stage)) await telnyx.hangup(ccid);
      return { ok: 'spoke' };

    case 'call.hangup': {
      const cause = String(p.hangup_cause ?? '');
      const [cur] = await sql`select status from calls where id = ${row.id}`;
      if (cur.status === 'dialing') {
        await failOrRetry(row.id, `not answered (${cause || 'hangup'})`);
      } else if (cur.status === 'voicemail') {
        await sql`update calls set summary = 'Left a voicemail', ended_at = now(), updated_at = now() where id = ${row.id}`;
      } else if (cur.status === 'in_progress') {
        await sql`update calls set status = 'completed', summary = 'Hung up before the call finished',
                  flagged = true, flag_reason = 'Call ended early: may need a human call back', ended_at = now(), updated_at = now()
                  where id = ${row.id}`;
      }
      return { ok: 'hangup', cause };
    }

    default:
      return { ignored: type };
  }
}

/* ---------------------------------------------------------------- loop -- */

let timer = null;
export function startScheduler({ everyMs = 60_000 } = {}) {
  if (timer) return;
  const run = () => tick().catch((err) => console.error('[calls] tick', err.message));
  timer = setInterval(run, everyMs);
  setTimeout(run, 5_000);
}
