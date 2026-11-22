import { createHash, randomBytes } from 'node:crypto';
import { db } from '@tleehealth/db';
import { createSealer, parseTtl, randomBytes as sealedRandom, wipe, UnlockStore } from '@profullstack/sealed-secrets';
import { config } from './config.js';
import * as c0 from './c0mpute.js';
import { extractText } from './doc-text.js';
import { CATEGORIES, detail } from './records.js';

/**
 * "Ask AI about my records": a patient (or a practice user, on records the
 * patient shared with that practice) asks a question; we pick the relevant
 * imported records, send excerpts to c0mpute's house lane, and return the
 * answer with citations. Paid by the asker's own c0mpute.com balance.
 *
 * Nothing about the question or answer is stored here. The audit log records
 * who asked about whose records, which records were sent, and the model.
 */

export class AskError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new AskError(status, message, extra);
};

/* ---------------------------------------------------- c0mpute connection -- */
// The c0k_ key spends the person's balance, so it is sealed unlock-on-use like
// portal tokens (fleet rule 2026-10-28): the data key lives only in this
// process for the TTL the person picked. A restart or the TTL locks it.

export const DEFAULT_TTL_SECONDS = 24 * 3600;
const STATE_TTL_MIN = 10;
const sealer = createSealer({ app: 'tleehealth', scope: 'c0mpute_connection' });
let sessions = new UnlockStore();
export function _useSessions(s) {
  sessions = s ?? new UnlockStore();
}
const ttlSeconds = (v) => (v == null || v === '' ? DEFAULT_TTL_SECONDS : typeof v === 'number' ? v : parseTtl(String(v)));
export const redirectUri = () => `${config.siteUrl}/connect/c0mpute/callback`;

async function sealToken(connId, userId, token, ttl) {
  const dek = sealedRandom(32);
  try {
    const blob = await sealer.sealJson(dek, { token }, userId, connId);
    const status = sessions.unlock(connId, dek, ttl);
    return { blob, status };
  } finally {
    wipe(dek);
  }
}

async function openToken(conn) {
  const dek = sessions.get(conn.id);
  if (!dek || !conn.token_sealed) return null;
  try {
    const t = await sealer.unsealJson(dek, typeof conn.token_sealed === 'string' ? JSON.parse(conn.token_sealed) : conn.token_sealed, conn.user_id, conn.id);
    return t?.token ?? null;
  } catch {
    return null;
  }
}

/** Start the OAuth sign-in at c0mpute. Browser only (the caller checks). */
/** Where to land after connecting: the records page, or a chart in the practice app. */
const safeReturn = (v) => (typeof v === 'string' && /^\/(portal\/records|app\/patients\/[0-9a-f-]{36})$/.test(v) ? v : '/portal/records');

export async function startConnect(user, { unlock_ttl, return_to } = {}) {
  const ruri = redirectUri();
  const clientId = await c0.clientIdFor(ruri);
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const sql = db();
  await sql`delete from c0mpute_connect_states where expires_at < now()`;
  await sql`insert into c0mpute_connect_states (state, user_id, verifier, client_id, redirect_uri, unlock_ttl, return_to, expires_at)
            values (${state}, ${user.id}, ${verifier}, ${clientId}, ${ruri}, ${ttlSeconds(unlock_ttl)}, ${safeReturn(return_to)}, now() + make_interval(mins => ${STATE_TTL_MIN}))`;
  const url = await c0.authorizeUrl({ clientId, redirectUri: ruri, state, challenge: createHash('sha256').update(verifier).digest('base64url') });
  return { authorize_url: url };
}

/** c0mpute sent the person back: code -> key, bound to their c0mpute account id. */
export async function finishConnect(user, { state, code, error, error_description }) {
  const sql = db();
  // Single use: deleted on first read, whatever happens next.
  const [s] = state ? await sql`delete from c0mpute_connect_states where state = ${String(state)} and expires_at > now() returning *` : [];
  if (!s) fail(400, 'this c0mpute sign-in expired; start again');
  if (!user || s.user_id !== user.id) fail(403, 'this c0mpute sign-in was started by another account', { return_to: s.return_to });
  if (error || !code) fail(400, `c0mpute did not connect: ${String(error_description || error || 'no code').slice(0, 200)}`, { return_to: s.return_to });
  const { token } = await c0.exchangeCode({ code: String(code), clientId: s.client_id, redirectUri: s.redirect_uri, verifier: s.verifier });
  let account;
  try {
    account = await c0.me(token);
  } catch (err) {
    await c0.revoke(token);
    throw err;
  }
  const [taken] = await sql`select user_id from c0mpute_connections where account_id = ${account.id}`;
  if (taken && taken.user_id !== user.id) {
    await c0.revoke(token);
    fail(409, 'that c0mpute account is already connected to another tleehealth account');
  }
  // One connection per person: a reconnect replaces the old key.
  const [old] = await sql`select * from c0mpute_connections where user_id = ${user.id}`;
  if (old) {
    const prev = await openToken(old);
    if (prev && prev !== token) await c0.revoke(prev);
    sessions.lock(old.id);
    await sql`delete from c0mpute_connections where id = ${old.id}`;
  }
  const [conn] = await sql`
    insert into c0mpute_connections (user_id, account_id, account_name, base_url, status)
    values (${user.id}, ${account.id}, ${account.name}, ${c0.base()}, 'active') returning *`;
  const { blob } = await sealToken(conn.id, user.id, token, s.unlock_ttl ?? DEFAULT_TTL_SECONDS);
  await sql`update c0mpute_connections set token_sealed = ${sql.json(blob)}, updated_at = now() where id = ${conn.id}`;
  return { name: account.name, return_to: s.return_to };
}

/** What the person sees: never the key. */
export async function status(user, { balance = true } = {}) {
  const [conn] = await db()`select * from c0mpute_connections where user_id = ${user.id}`;
  if (!conn) return { connected: false, status: 'none', top_up: c0.TOP_UP_URL };
  const s = sessions.status(conn.id);
  const out = {
    connected: true,
    status: conn.status === 'invalid' ? 'invalid' : s.unlocked ? 'active' : 'locked',
    name: conn.account_name,
    account_id: conn.account_id,
    unlocked_until: s.unlocked ? s.expiresAt : null,
    connected_at: conn.created_at,
    balance: null,
    top_up: c0.TOP_UP_URL,
  };
  if (balance && out.status === 'active') {
    const token = await openToken(conn);
    if (token) {
      try {
        const a = await c0.me(token);
        out.balance = a.balance ? { spendable_usd: a.balance.spendable_usd ?? '0.000000' } : { spendable_usd: '0.000000' };
      } catch (err) {
        if (err.reason === 'invalid_token') {
          await markInvalid(conn.id);
          out.status = 'invalid';
        }
      }
    }
  }
  return out;
}

async function markInvalid(connId) {
  sessions.lock(connId);
  await db()`update c0mpute_connections set status = 'invalid', token_sealed = null, updated_at = now() where id = ${connId}`;
}

/** Revoke at c0mpute (best effort) and delete the key here. */
export async function disconnect(user) {
  const sql = db();
  const [conn] = await sql`select * from c0mpute_connections where user_id = ${user.id}`;
  if (!conn) return { ok: true, connected: false };
  const token = await openToken(conn);
  if (token) await c0.revoke(token);
  sessions.lock(conn.id);
  await sql`delete from c0mpute_connections where id = ${conn.id}`;
  return { ok: true, connected: false };
}

async function liveToken(user) {
  const [conn] = await db()`select * from c0mpute_connections where user_id = ${user.id}`;
  if (!conn) fail(409, 'Connect your c0mpute.com account first: questions are paid from your c0mpute balance.', { reason: 'c0mpute_not_connected' });
  if (conn.status === 'invalid') fail(409, 'c0mpute no longer accepts this connection; reconnect c0mpute.', { reason: 'c0mpute_reconnect' });
  const token = await openToken(conn);
  if (!token) fail(423, 'Your c0mpute connection is locked (it is kept only in memory for the time you chose). Reconnect c0mpute to unlock it.', { reason: 'c0mpute_locked' });
  return { conn, token };
}

/* ------------------------------------------------------------- retrieval -- */

const STOP = new Set(
  'a an and are as at be been by can could did do does for from had has have how i if in into is it its last latest me my of on or our recent show should tell than that the their them then there these this to was were what when where which who why will with would you your about any all been ever much many most please explain mean means'.split(' '),
);

/** Question words that point at a category. */
const INTENTS = [
  ['labs', /\b(labs?|tests?|results?|blood ?work|panel|a1c|hba1c|cholesterol|ldl|hdl|triglycerides?|glucose|sugar|cbc|hemoglobin|platelets?|wbc|creatinine|egfr|kidney|liver|alt|ast|tsh|thyroid|vitamin|potassium|sodium|psa|urine|urinalysis|ferritin|iron|lipid)\b/],
  ['medications', /\b(meds?|medications?|medicines?|drugs?|prescriptions?|prescribed|pills?|dose|doses|dosage|taking|refills?|rx)\b/],
  ['allergies', /\b(allerg\w*|reactions?|intoleran\w*)\b/],
  ['conditions', /\b(conditions?|diagnos\w*|problems?|diseases?|disorders?|history)\b/],
  ['visits', /\b(visits?|appointments?|encounters?|saw|seen|hospital\w*|admi\w+|er|emergency)\b/],
  ['immunizations', /\b(vaccin\w*|immuni\w*|shots?|boosters?|flu|covid|tetanus)\b/],
  ['procedures', /\b(procedures?|surger\w*|operations?|biops\w*|colonoscop\w*)\b/],
  ['vitals', /\b(vitals?|blood pressure|bp|weight|bmi|heart rate|pulse|temperature|height|oxygen|spo2)\b/],
  ['imaging', /\b(imaging|x-?rays?|mri|ct|cat scan|ultrasound|scan|mammogram|radiology)\b/],
  ['summaries', /\b(summar\w*|discharge|after.visit|avs|instructions?)\b/],
  ['notes', /\b(notes?|doctor said|clinician said|wrote)\b/],
  ['care_plans', /\b(care ?plans?|goals?|plan)\b/],
  ['insurance', /\b(insurance|coverage|payer|plan id|member id)\b/],
];
const DOC_TYPES = new Set(['DocumentReference', 'DiagnosticReport', 'Composition']);
const MAX_CONTEXT_CHARS = 24_000;
const MAX_FILE_EXCERPT = 3_000;
const MAX_FILES_READ = 8;
const MAX_RECORDS_SCANNED = 5_000;

export function terms(question) {
  return [
    ...new Set(
      String(question)
        .toLowerCase()
        .replace(/[^a-z0-9.%\s-]/g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/^[-.]+|[-.]+$/g, ''))
        .filter((w) => w.length > 1 && !STOP.has(w))
        .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
    ),
  ];
}

export function intents(question) {
  const q = String(question).toLowerCase();
  return INTENTS.filter(([, re]) => re.test(q)).map(([k]) => k);
}

const cc = (c) => c?.text || c?.coding?.find((x) => x.display)?.display || c?.coding?.[0]?.code || null;
const qty = (q) => (q && q.value != null ? `${q.value}${q.unit ? ` ${q.unit}` : q.code ? ` ${q.code}` : ''}` : null);

/** One line about a record: what it is and its key facts, no identifiers. */
export function summarize(rec) {
  const r = rec.resource ?? {};
  const bits = [];
  const label = CATEGORIES.find(([k]) => k === rec.category)?.[1] ?? rec.category;
  const d = detail(r);
  if (d) bits.push(d);
  if (r.resourceType === 'Observation') {
    const rr = r.referenceRange?.[0];
    if (rr) {
      const range = rr.text || [qty(rr.low), qty(rr.high)].filter(Boolean).join(' to ');
      if (range) bits.push(`reference range ${range}`);
    }
    if (r.interpretation?.[0] && !d.includes('(')) bits.push(`flag ${cc(r.interpretation[0])}`);
    if (r.status && r.status !== 'final') bits.push(r.status);
  }
  if (r.resourceType === 'Condition') {
    if (cc(r.verificationStatus)) bits.push(cc(r.verificationStatus));
    if (r.abatementDateTime) bits.push(`resolved ${String(r.abatementDateTime).slice(0, 10)}`);
  }
  if (r.resourceType === 'MedicationRequest' || r.resourceType === 'MedicationStatement') {
    const dose = r.dosageInstruction?.[0] ?? r.dosage?.[0];
    if (dose?.text && !d.includes(dose.text)) bits.push(dose.text);
    if (r.resourceType === 'MedicationStatement' && r.status) bits.push(r.status);
    if (r.reasonCode?.[0]) bits.push(`for ${cc(r.reasonCode[0])}`);
  }
  if (r.resourceType === 'AllergyIntolerance') {
    if (cc(r.clinicalStatus)) bits.push(cc(r.clinicalStatus));
    const sev = r.reaction?.[0]?.severity;
    if (sev) bits.push(`severity ${sev}`);
  }
  if (r.resourceType === 'Encounter') {
    if (r.reasonCode?.[0]) bits.push(`reason ${cc(r.reasonCode[0])}`);
    if (r.hospitalization?.dischargeDisposition) bits.push(`discharge ${cc(r.hospitalization.dischargeDisposition)}`);
  }
  if (r.resourceType === 'Procedure' && r.status) bits.push(r.status);
  if (r.resourceType === 'Immunization' && r.status) bits.push(r.status);
  if (r.resourceType === 'DiagnosticReport' && r.conclusion && !d.includes(r.conclusion.slice(0, 40))) bits.push(r.conclusion.slice(0, 300));
  if (r.resourceType === 'Patient') {
    return `${label}: sex ${r.gender ?? 'unknown'}, born ${r.birthDate ?? 'unknown'}`;
  }
  if (r.note?.[0]?.text) bits.push(`note: ${String(r.note[0].text).slice(0, 200)}`);
  return [rec.recorded_on ? String(rec.recorded_on).slice(0, 10) : 'undated', label, rec.title ?? r.resourceType, ...bits]
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}

/** Text carried inside the resource itself: inline attachments, narrative. */
function inlineText(r) {
  const out = [];
  const atts = [
    ...(r.content ?? []).map((c) => c.attachment),
    ...(r.presentedForm ?? []),
  ].filter(Boolean);
  for (const a of atts) {
    if (!a.data) continue;
    const t = extractText(Buffer.from(String(a.data), 'base64'), a.contentType, a.title);
    if (t.text) out.push(t.text);
  }
  if (r.text?.div && !out.length) {
    const t = extractText(Buffer.from(r.text.div), 'text/html');
    if (t.text) out.push(t.text);
  }
  return out.join('\n');
}

/**
 * Score every record against the question. Pure: takes rows, returns them
 * ranked with the score. Exported for tests.
 */
export function rank(rows, question, { now = new Date() } = {}) {
  const t = terms(question);
  const want = intents(question);
  const q = String(question).toLowerCase();
  const recent = /\b(last|latest|recent|newest|current|now|today|this year)\b/.test(q);
  const years = [...q.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  const scored = rows.map((rec) => {
    const hay = `${rec.title ?? ''} ${rec._summary ?? ''}`.toLowerCase();
    const title = String(rec.title ?? '').toLowerCase();
    let score = 0;
    for (const w of t) {
      if (title.includes(w)) score += 3;
      else if (hay.includes(w)) score += 1.5;
      else if (rec._text && rec._text.includes(w)) score += 1;
    }
    if (want.includes(rec.category)) score += 4;
    if (want.includes('labs') && rec.category === 'observations') score += 1.5;
    if (want.includes('summaries') && rec.category === 'notes') score += 1;
    if (years.length && rec.recorded_on && years.includes(String(rec.recorded_on).slice(0, 4))) score += 2;
    const age = rec.recorded_on ? (now - new Date(rec.recorded_on)) / (365.25 * 86400_000) : 10;
    score += Math.max(0, (recent ? 2 : 0.6) * (1 - Math.min(age, 10) / 10));
    if (rec.category === 'profile') score += 0.5;
    return { rec, score };
  });
  return scored.sort((a, b) => b.score - a.score || String(b.rec.recorded_on ?? '').localeCompare(String(a.rec.recorded_on ?? '')));
}

/** With no keyword or category hit, a balanced overview: active problems, meds, allergies, recent labs. */
const OVERVIEW = { profile: 1, conditions: 25, medications: 25, allergies: 15, labs: 30, vitals: 10, immunizations: 10, visits: 10, summaries: 5 };

export function select(rows, question, { maxChars = MAX_CONTEXT_CHARS } = {}) {
  const ranked = rank(rows, question);
  const t = terms(question);
  const want = intents(question);
  const focused = want.length > 0 || ranked.some((x) => t.some((w) => String(x.rec.title ?? '').toLowerCase().includes(w)));
  let order;
  if (focused) order = ranked.filter((x) => x.score >= 2 || x.rec.category === 'profile').map((x) => x.rec);
  else {
    const per = {};
    order = ranked
      .map((x) => x.rec)
      .filter((rec) => {
        const cap = OVERVIEW[rec.category] ?? 0;
        per[rec.category] = (per[rec.category] ?? 0) + 1;
        return per[rec.category] <= cap;
      });
  }
  const picked = [];
  let used = 0;
  for (const rec of order) {
    const len = (rec._summary?.length ?? 0) + 12;
    if (used + len > maxChars) continue;
    picked.push(rec);
    used += len;
    if (picked.length >= 300) break;
  }
  return picked;
}

/** The best excerpt of a long text for these terms. */
export function excerpt(text, ts, max = MAX_FILE_EXCERPT) {
  if (text.length <= max) return text;
  const low = text.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < low.length; i += Math.floor(max / 3)) {
    const win = low.slice(i, i + max);
    const s = ts.reduce((n, w) => n + (win.includes(w) ? 1 : 0), 0);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return `${best > 0 ? '… ' : ''}${text.slice(best, best + max)}${best + max < text.length ? ' …' : ''}`;
}

/** Load, extract and select. scope: { userId } or { orgId, patientId }. */
export async function buildContext(scope, question) {
  const sql = db();
  const where = scope.orgId
    ? sql`r.connection_id in (select connection_id from health_connection_shares where org_id = ${scope.orgId} and patient_id = ${scope.patientId})`
    : sql`r.user_id = ${scope.userId}`;
  const rows = await sql`
    select r.id, r.category, r.title, r.resource_type, r.recorded_on::text as recorded_on, r.resource
    from health_records r where ${where}
    order by r.recorded_on desc nulls last limit ${MAX_RECORDS_SCANNED}`;
  if (!rows.length) return { rows: 0, picked: [], lines: [], notRead: [] };
  const files = await sql`
    select f.id, f.record_id, f.title, f.content_type, f.size from health_files f
    where f.record_id in (select r.id from health_records r where ${where})`;
  const filesBy = new Map();
  for (const f of files) filesBy.set(f.record_id, [...(filesBy.get(f.record_id) ?? []), f]);
  for (const rec of rows) {
    rec._summary = summarize(rec);
    rec._files = filesBy.get(rec.id) ?? [];
    if (DOC_TYPES.has(rec.resource_type)) rec._text = inlineText(rec.resource).toLowerCase().slice(0, 50_000) || null;
  }
  const ts = terms(question);
  const picked = select(rows, question, { maxChars: MAX_CONTEXT_CHARS - 9000 });

  // Read the attachments of the picked documents (most relevant first).
  const notRead = [];
  let read = 0;
  const extra = new Map();
  for (const rec of picked) {
    const docs = rec._files;
    if (!docs.length && rec._text) {
      extra.set(rec.id, excerpt(inlineText(rec.resource), ts));
      continue;
    }
    for (const f of docs) {
      if (read >= MAX_FILES_READ) break;
      if (/^image\//.test(f.content_type ?? '') || /dicom/.test(f.content_type ?? '')) {
        notRead.push({ record_id: rec.id, file_id: f.id, title: f.title ?? rec.title, reason: 'image (not read)' });
        continue;
      }
      if (f.size > 25 * 1024 * 1024) {
        notRead.push({ record_id: rec.id, file_id: f.id, title: f.title ?? rec.title, reason: 'too large to read' });
        continue;
      }
      const [row] = await sql`select data from health_files where id = ${f.id}`;
      const t = extractText(row?.data, f.content_type, f.title);
      read++;
      if (!t.text) {
        notRead.push({ record_id: rec.id, file_id: f.id, title: f.title ?? rec.title, reason: t.reason });
        continue;
      }
      extra.set(rec.id, `${extra.get(rec.id) ? `${extra.get(rec.id)}\n` : ''}${excerpt(t.text, ts)}`);
    }
  }

  const lines = [];
  let used = 0;
  const kept = [];
  for (const rec of picked) {
    const tag = `R${kept.length + 1}`;
    let line = `[${tag}] ${rec._summary}`;
    const ex = extra.get(rec.id);
    if (ex) line += `\n    Document text: ${ex.replace(/\n+/g, ' / ')}`;
    if (used + line.length > MAX_CONTEXT_CHARS) {
      if (!ex) continue;
      line = `[${tag}] ${rec._summary}`;
      if (used + line.length > MAX_CONTEXT_CHARS) continue;
    }
    used += line.length + 1;
    lines.push(line);
    kept.push({ tag, rec });
  }
  return { rows: rows.length, picked: kept, lines, notRead };
}

/* ------------------------------------------------------------------- ask -- */

export const SYSTEM_PROMPT = [
  "You help a person understand their own health records. You are given excerpts from those records, each tagged like [R1].",
  'Rules:',
  '- Answer ONLY from the provided records. If they do not contain the answer, say plainly: "Your records here don\'t show that." Do not guess or use outside facts about this person.',
  '- Cite the tags of the records you used after each statement, like [R3]. Use only tags that appear in the records.',
  '- Explain lab values and medical terms in plain language. When a reference range is given, say whether the value is inside it.',
  '- Never diagnose. Never tell the person to start, stop or change a medication or treatment. For any decision, tell them to talk with their clinician.',
  '- If the question describes an emergency (chest pain, trouble breathing, stroke signs, severe bleeding, thoughts of self-harm), tell them to call 911 now, or 988 for a mental-health crisis, before anything else.',
  '- Be brief and clear. This is not medical advice.',
].join('\n');

export function messagesFor(question, lines) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Today is ${today}.\n\nRecords:\n${lines.join('\n') || '(no records)'}\n\nQuestion: ${question}`,
    },
  ];
}

/** Keep only [R#] tags we actually sent; return the cleaned answer and the cited tags. */
export function checkCitations(answer, tags) {
  const allowed = new Set(tags);
  const cited = new Set();
  const text = String(answer ?? '')
    .replace(/\[(R\d+(?:\s*,\s*R\d+)*)\]/g, (_, list) => {
      const keep = list.split(/\s*,\s*/).filter((t) => allowed.has(t));
      keep.forEach((t) => cited.add(t));
      return keep.length ? `[${keep.join(', ')}]` : '';
    })
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/[ \t]+([.,;:])/g, '$1')
    .trim();
  return { text, cited: tags.filter((t) => cited.has(t)) };
}

export const NOT_MEDICAL_ADVICE =
  'Not medical advice. This answer comes from an AI reading your imported records and can be wrong or incomplete. Talk with your clinician before making any decision. In an emergency call 911 (988 for a mental-health crisis).';

// Per-person pace: a question costs real money and a CPU node's time.
const recentAsks = new Map();
function pace(userId, limit = 30, windowMs = 3600_000) {
  const now = Date.now();
  const list = (recentAsks.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) fail(429, 'Too many questions this hour; try again later.', { reason: 'rate_limited' });
  list.push(now);
  recentAsks.set(userId, list);
  if (recentAsks.size > 10_000) recentAsks.delete(recentAsks.keys().next().value);
}

/**
 * Ask. asker = the signed-in user (pays). scope = whose records:
 * { userId } (their own) or { orgId, patientId } (shared with a practice; the
 * caller has already checked membership). link(rec) builds a citation href.
 */
export async function ask(asker, scope, question, { link = () => null, onSend = async () => null, onDone = async () => {}, signal } = {}) {
  const q = String(question ?? '').trim();
  if (q.length < 3) fail(400, 'ask a question about your records');
  if (q.length > 1000) fail(400, 'keep the question under 1000 characters');
  const { conn, token } = await liveToken(asker);
  const ctx = await buildContext(scope, q);
  if (!ctx.rows) fail(404, scope.orgId ? 'This patient has not shared any imported records with your practice.' : 'No imported records yet. Import your records first, then ask.', { reason: 'no_records' });
  pace(asker.id);
  // Audited before anything leaves: which records, through which lane. No question or answer text.
  const auditId = await onSend({ records: ctx.picked.map((p) => p.rec.id), lane: 'house', c0mpute_account: conn.account_id });
  let out;
  try {
    out = await c0.askHouse(token, messagesFor(q, ctx.lines), { maxTokens: 800, signal });
    await onDone(auditId, { outcome: 'answered', model: out.meta?.model ?? out.model ?? null, operator: out.meta?.operator ?? null });
  } catch (err) {
    await onDone(auditId, { outcome: `failed: ${err.reason ?? 'error'}` }).catch(() => {});
    if (err instanceof c0.C0mputeError) {
      if (err.reason === 'invalid_token') await markInvalid(conn.id);
      fail(err.reason === 'invalid_token' ? 409 : err.status, err.message, {
        reason: err.reason === 'invalid_token' ? 'c0mpute_reconnect' : err.reason,
        ...(err.top_up ? { top_up: err.top_up } : {}),
      });
    }
    throw err;
  }
  const tags = ctx.picked.map((p) => p.tag);
  const { text, cited } = checkCitations(out.text, tags);
  const byTag = new Map(ctx.picked.map((p) => [p.tag, p.rec]));
  const citations = cited.map((tag) => {
    const rec = byTag.get(tag);
    return {
      tag,
      record_id: rec.id,
      title: rec.title ?? rec.resource_type,
      category: rec.category,
      recorded_on: rec.recorded_on ? String(rec.recorded_on).slice(0, 10) : null,
      href: link(rec),
    };
  });
  const meta = out.meta ?? {};
  return {
    answer: text || "The AI did not return an answer. Try asking again.",
    citations,
    records_considered: ctx.picked.length,
    records_total: ctx.rows,
    not_read: ctx.notRead.slice(0, 20).map(({ title, reason, record_id }) => ({ title, reason, record_id })),
    model: meta.model ?? out.model ?? null,
    lane: 'house',
    operator: meta.operator ?? null,
    cost_usd: meta.estimated_cost_usd ?? null,
    disclaimer: NOT_MEDICAL_ADVICE,
  };
}

