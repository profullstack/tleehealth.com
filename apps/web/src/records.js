import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db } from '@tleehealth/db';
import { config } from './config.js';
import { zip } from './zip.js';

/**
 * Health-record import: "SimpleFIN for health".
 *
 * A patient signs in to their provider's patient portal (MyChart, and any other
 * portal with a SMART on FHIR patient API, which the Cures Act makes every
 * certified EHR offer) and grants us read access. We then copy EVERYTHING that
 * API returns into health_records: demographics and identifiers, visits,
 * after-visit summaries and clinical notes, labs, imaging, medications,
 * conditions, allergies, immunizations, procedures, care plans, coverage; and
 * every file those records point at (PDF summaries, scanned notes, images) into
 * health_files. The patient can download all of it, and share it with a practice.
 *
 * The flow is the SMART App Launch "standalone patient launch":
 *   start()   discovery (.well-known/smart-configuration), PKCE, authorize URL
 *   finish()  the redirect back: code -> tokens (sealed with AES-256-GCM)
 *   sync()    every resource type, every page, then the attachments
 */

const STATE_TTL_MIN = 15;
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // per search: 5,000 resources of one kind
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_SYNC = 2000;
const FETCH_TIMEOUT_MS = 30_000;

/* ----------------------------------------------------------- token sealing -- */

const DEV_KEY = 'tleehealth-dev-only-records-key';
function key() {
  const k = process.env.HEALTH_TOKEN_KEY;
  if (!k && config.isProd) throw new Error('HEALTH_TOKEN_KEY is not set');
  return createHash('sha256').update(k || DEV_KEY).digest();
}

export function seal(text) {
  if (text == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function unseal(buf) {
  if (!buf) return null;
  const b = Buffer.from(buf);
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/* ---------------------------------------------------------------- URL guard -- */

export class RecordsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new RecordsError(status, message);
};

const allowPrivate = () => process.env.HEALTH_ALLOW_PRIVATE_URLS === '1' && !config.isProd;

function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * A FHIR URL a user typed makes this server fetch it, so it must be https and
 * resolve only to public addresses: no reaching into dev2's own network.
 */
export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(400, 'that is not a URL');
  }
  if (allowPrivate()) return u;
  if (u.protocol !== 'https:') fail(400, 'the FHIR address must be https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) fail(400, `cannot resolve ${host}`);
  if (addrs.some((a) => privateAddress(a.address))) fail(400, 'that address is not on the public internet');
  return u;
}

const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(t);
  }
}

/* ---------------------------------------------------------------- directory -- */

// The public SMART launcher: a synthetic patient, signs in without a password.
// Lets anyone see the whole flow work before they connect a real account.
const SANDBOX_PATIENT = '87a339d0-8cae-418e-89c7-8651e6aab3c6';
export const SANDBOX_BASE = `https://launch.smarthealthit.org/v/r4/sim/${Buffer.from(
  JSON.stringify([3, SANDBOX_PATIENT, '', '', 1, 1]),
).toString('base64url')}/fhir`;

const EPIC_DIRECTORY_URL = 'https://open.epic.com/Endpoints/R4';
let epicCache = { at: 0, list: [] };

/** Every organization on Epic with a patient API: the MyChart directory. */
async function epicDirectory() {
  if (Date.now() - epicCache.at < 24 * 3600_000 && epicCache.list.length) return epicCache.list;
  try {
    const res = await timedFetch(EPIC_DIRECTORY_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bundle = await res.json();
    const list = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r) => r?.resourceType === 'Endpoint' && r.status === 'active' && r.address)
      .map((r) => ({ id: `epic:${r.id}`, name: r.name, vendor: 'epic', fhir_base: r.address.replace(/\/+$/, '') }));
    if (list.length) epicCache = { at: Date.now(), list };
  } catch (err) {
    console.error(`[records] Epic directory: ${err.message}`);
  }
  return epicCache.list;
}

function builtIns() {
  const list = [{ id: 'sandbox', name: 'Demo patient (SMART Health IT sandbox)', vendor: 'sandbox', fhir_base: SANDBOX_BASE }];
  if (process.env.EPIC_SANDBOX_CLIENT_ID)
    list.push({ id: 'epic-sandbox', name: 'Epic sandbox (MyChart test patients)', vendor: 'epic-sandbox', fhir_base: EPIC_SANDBOX_BASE });
  return list;
}

/** Providers to connect to, matching q (name words, any order). */
export async function searchProviders(q = '', limit = 25) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...builtIns(), ...(await epicDirectory())];
  const hits = words.length ? all.filter((p) => words.every((w) => p.name.toLowerCase().includes(w))) : all;
  return hits.slice(0, limit).map((p) => ({ ...p, ready: Boolean(clientFor(p.vendor)) }));
}

async function providerById(id) {
  return [...builtIns(), ...(id.startsWith('epic:') ? await epicDirectory() : [])].find((p) => p.id === id) ?? null;
}

const EPIC_SANDBOX_BASE = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';

export function vendorOf(fhirBase) {
  if (fhirBase === SANDBOX_BASE || /launch\.smarthealthit\.org/.test(fhirBase)) return 'sandbox';
  // Epic's own test server takes the app's non-production client id.
  if (/^https:\/\/fhir\.epic\.com\/interconnect-fhir-oauth\//i.test(fhirBase)) return 'epic-sandbox';
  if (/\/api\/FHIR\/R4/i.test(fhirBase)) return 'epic';
  if (/cerner\.com/i.test(fhirBase)) return 'cerner';
  return 'smart';
}

/**
 * The app registration to sign in with. MyChart needs our Epic client id
 * (fhir.epic.com app 61862: EPIC_CLIENT_ID for real organizations,
 * EPIC_SANDBOX_CLIENT_ID for Epic's test server), Oracle Health a Cerner one;
 * any other SMART server takes SMART_CLIENT_ID. The SMART sandbox accepts any id.
 */
export function clientFor(vendor) {
  const env = (k) => process.env[k] || '';
  if (vendor === 'sandbox') return { id: 'tleehealth', secret: '' };
  const prefix = { epic: 'EPIC', 'epic-sandbox': 'EPIC_SANDBOX', cerner: 'CERNER' }[vendor] ?? 'SMART';
  const id = env(`${prefix}_CLIENT_ID`);
  return id ? { id, secret: env(`${prefix}_CLIENT_SECRET`) } : null;
}

/* ------------------------------------------------------------------ connect -- */

const redirectUri = () => `${config.siteUrl}/connect/callback`;

/** A server's SMART endpoints: .well-known first, the CapabilityStatement second. */
export async function discover(fhirBase) {
  const res = await timedFetch(`${fhirBase}/.well-known/smart-configuration`, { headers: { accept: 'application/json' } }).catch(() => null);
  if (res?.ok) {
    const c = await res.json().catch(() => null);
    if (c?.authorization_endpoint && c?.token_endpoint) return c;
  }
  const meta = await timedFetch(`${fhirBase}/metadata`, { headers: { accept: 'application/fhir+json' } }).catch(() => null);
  if (meta?.ok) {
    const cap = await meta.json().catch(() => null);
    const ext = cap?.rest?.[0]?.security?.extension?.find((e) => /oauth-uris/.test(e.url))?.extension ?? [];
    const pick = (n) => ext.find((e) => e.url === n)?.valueUri;
    if (pick('authorize') && pick('token')) return { authorization_endpoint: pick('authorize'), token_endpoint: pick('token'), capabilities: [] };
  }
  fail(502, 'that server does not offer patient sign-in (no SMART configuration)');
}

function scopeFor(smart) {
  const caps = smart.capabilities ?? [];
  const v2only = caps.includes('permission-v2') && !caps.includes('permission-v1');
  return `launch/patient openid fhirUser offline_access ${v2only ? 'patient/*.rs' : 'patient/*.read'}`;
}

/**
 * Begin connecting: a provider from the directory (provider_id) or any SMART
 * server's FHIR address (fhir_base). Returns the URL to send the patient to.
 */
export async function start(user, { provider_id, fhir_base, name, return_to } = {}) {
  let provider = null;
  if (provider_id) {
    provider = await providerById(String(provider_id));
    if (!provider) fail(404, 'no such provider');
  } else if (fhir_base) {
    const base = String(fhir_base).trim().replace(/\/+$/, '');
    provider = { name: String(name ?? '').trim() || new URL(base).hostname, vendor: vendorOf(base), fhir_base: base };
  } else fail(400, 'pick a provider or enter its FHIR address');
  await assertPublicUrl(provider.fhir_base);
  const client = clientFor(provider.vendor);
  if (!client)
    fail(503, provider.vendor === 'epic'
      ? 'MyChart connections are waiting on our Epic app registration; try again soon'
      : `connections to ${provider.vendor === 'cerner' ? 'Oracle Health (Cerner)' : 'this server'} are not set up yet`);
  const smart = await discover(provider.fhir_base);
  await assertPublicUrl(smart.authorization_endpoint);
  await assertPublicUrl(smart.token_endpoint);

  const sql = db();
  const [conn] = await sql`
    insert into health_connections (user_id, provider_name, vendor, fhir_base, token_endpoint, client_id)
    values (${user.id}, ${provider.name.slice(0, 200)}, ${provider.vendor}, ${provider.fhir_base}, ${smart.token_endpoint}, ${client.id})
    returning id, provider_name, vendor, status`;
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await sql`
    insert into health_connect_states (state, user_id, connection_id, verifier, return_to, expires_at)
    values (${state}, ${user.id}, ${conn.id}, ${verifier}, ${return_to === 'cli' ? 'cli' : 'portal'},
            now() + make_interval(mins => ${STATE_TTL_MIN}))`;
  await sql`delete from health_connect_states where expires_at < now()`;
  // Abandoned attempts: a pending connection nobody finished within a day.
  await sql`delete from health_connections where user_id = ${user.id} and status = 'pending' and created_at < now() - interval '1 day'`;

  const u = new URL(smart.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: client.id,
    redirect_uri: redirectUri(),
    scope: scopeFor(smart),
    state,
    aud: provider.fhir_base,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return { connection: conn, authorize_url: u.toString() };
}

/* --------------------------------------------- JWT client authentication -- */
// Epic's preferred confidential-client auth: we sign a short-lived assertion
// with our private key (vault CLIENT_JWT_PRIVATE_KEY, PEM) and Epic checks it
// against the public half at /.well-known/jwks.json. No secret is shared.

const JWT_KID = 'tleehealth-1';
let jwtKey = null;
function privateKey() {
  const pem = process.env.CLIENT_JWT_PRIVATE_KEY;
  if (!pem) return null;
  if (!jwtKey || jwtKey.pem !== pem) jwtKey = { pem, key: createPrivateKey(pem.replace(/\\n/g, '\n')) };
  return jwtKey.key;
}

/** The public key set Epic fetches to verify our assertions; null without a key. */
export function jwks() {
  const key = privateKey();
  if (!key) return null;
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: JWT_KID, alg: 'RS384', use: 'sig' }] };
}

/** A private_key_jwt client assertion for one token request (RFC 7523). */
export function clientAssertion(clientId, tokenEndpoint, now = Date.now()) {
  const key = privateKey();
  if (!key) return null;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS384', typ: 'JWT', kid: JWT_KID });
  const iat = Math.floor(now / 1000);
  const claims = b64({ iss: clientId, sub: clientId, aud: tokenEndpoint, jti: randomUUID(), iat, nbf: iat, exp: iat + 240 });
  const sig = sign('sha384', Buffer.from(`${head}.${claims}`), key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

// Vendors whose registration uses our JWK set (Epic app 61862, both clients).
const JWT_VENDORS = ['epic', 'epic-sandbox'];

async function tokenRequest(conn, form) {
  const client = clientFor(conn.vendor) ?? { id: conn.client_id, secret: '' };
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams(form);
  const assertion = JWT_VENDORS.includes(conn.vendor) ? clientAssertion(client.id, conn.token_endpoint) : null;
  if (assertion) {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', assertion);
  } else if (client.secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  else body.set('client_id', client.id);
  const res = await timedFetch(conn.token_endpoint, { method: 'POST', headers, body });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new RecordsError(502, `the provider refused the sign-in (${tok.error_description || tok.error || `HTTP ${res.status}`})`);
  return tok;
}

async function saveTokens(connId, tok, extra = {}) {
  const expires = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null;
  const [conn] = await db()`
    update health_connections set
      access_token = ${seal(tok.access_token)},
      refresh_token = coalesce(${tok.refresh_token ? seal(tok.refresh_token) : null}, refresh_token),
      token_expires_at = ${expires},
      scope = coalesce(${tok.scope ?? null}, scope),
      patient_ref = coalesce(${extra.patient ?? null}, patient_ref),
      status = ${extra.status ?? 'active'},
      last_error = null,
      updated_at = now()
    where id = ${connId} returning *`;
  return conn;
}

/** The provider sent the patient back: trade the code for tokens. */
export async function finish({ state, code, error, error_description }) {
  const sql = db();
  const [s] = state
    ? await sql`delete from health_connect_states where state = ${String(state)} and expires_at > now() returning *`
    : [];
  if (!s) fail(400, 'this sign-in link expired; start again');
  const [conn] = await sql`select * from health_connections where id = ${s.connection_id}`;
  if (!conn) fail(400, 'this connection was removed; start again');
  if (error || !code) {
    await sql`update health_connections set status = 'error', last_error = ${String(error_description || error || 'no code').slice(0, 300)}, updated_at = now() where id = ${conn.id}`;
    return { connection: conn, return_to: s.return_to, error: error_description || error || 'the provider did not grant access' };
  }
  try {
    const tok = await tokenRequest(conn, { grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri(), code_verifier: s.verifier });
    if (!tok.patient) fail(502, 'the provider did not say which patient record you opened');
    return { connection: await saveTokens(conn.id, tok, { patient: tok.patient }), return_to: s.return_to };
  } catch (err) {
    await sql`update health_connections set status = 'error', last_error = ${err.message.slice(0, 300)}, updated_at = now() where id = ${conn.id}`;
    return { connection: conn, return_to: s.return_to, error: err.message };
  }
}

/** A live access token, refreshed when it is about to expire. */
async function accessToken(conn) {
  const soon = conn.token_expires_at && new Date(conn.token_expires_at).getTime() < Date.now() + 60_000;
  if (!soon) return { conn, token: unseal(conn.access_token) };
  if (!conn.refresh_token) {
    await db()`update health_connections set status = 'expired', last_error = 'access expired; reconnect to refresh', updated_at = now() where id = ${conn.id}`;
    fail(409, `${conn.provider_name}: access expired; reconnect to import again`);
  }
  const tok = await tokenRequest(conn, { grant_type: 'refresh_token', refresh_token: unseal(conn.refresh_token) });
  const next = await saveTokens(conn.id, tok, { status: 'syncing' });
  return { conn: next, token: tok.access_token };
}

/* -------------------------------------------------------------- classifying -- */

const cc = (c) => c?.text || c?.coding?.find((x) => x.display)?.display || c?.coding?.[0]?.code || null;
const codes = (list) => (list ?? []).flatMap((c) => (c.coding ?? []).map((x) => `${x.code ?? ''} ${x.display ?? ''}`.toLowerCase()).concat((c.text ?? '').toLowerCase()));
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : typeof v === 'string' && /^\d{4}(-\d{2})?$/.test(v) ? `${v}${v.length === 4 ? '-01-01' : '-01'}` : null);

export function humanName(r) {
  const n = r?.name?.find((x) => x.use === 'official') ?? r?.name?.[0];
  if (!n) return null;
  return n.text || [...(n.given ?? []), n.family].filter(Boolean).join(' ') || null;
}

const IMAGING = /imaging|radiology|\brad\b|x-?ray|\bct\b|mri|ultrasound|mammo|dicom|18748-4/;
const SUMMARY = /after visit|avs|discharge|visit summary|summary of care|continuity of care|ccd|clinical summary|18842-5|34133-9|11506-3/;

/** Which bucket a resource goes in, a one-line title, and its date. */
export function classify(r) {
  const t = r.resourceType;
  const firstDate = (...vs) => vs.map(day).find(Boolean) ?? null;
  switch (t) {
    case 'Patient':
      return { category: 'profile', title: humanName(r) ?? 'Patient', recorded_on: day(r.birthDate) };
    case 'Encounter':
      return {
        category: 'visits',
        title: cc(r.type?.[0]) || cc(r.serviceType) || r.class?.display || 'Visit',
        recorded_on: firstDate(r.period?.start, r.period?.end),
      };
    case 'DocumentReference': {
      const kinds = [...codes(r.type ? [r.type] : []), ...codes(r.category)].join(' ');
      const title = r.description || cc(r.type) || r.content?.[0]?.attachment?.title || 'Document';
      const category = SUMMARY.test(`${kinds} ${title.toLowerCase()}`) ? 'summaries' : IMAGING.test(kinds) ? 'imaging' : 'notes';
      return { category, title, recorded_on: firstDate(r.context?.period?.start, r.date, r.content?.[0]?.attachment?.creation) };
    }
    case 'Composition':
      return { category: SUMMARY.test(codes([r.type]).join(' ')) ? 'summaries' : 'notes', title: r.title || cc(r.type) || 'Document', recorded_on: day(r.date) };
    case 'DiagnosticReport': {
      const kinds = codes(r.category).join(' ');
      return {
        category: IMAGING.test(kinds) ? 'imaging' : /\blab\b|laboratory|pathology/.test(kinds) || !kinds ? 'labs' : 'reports',
        title: cc(r.code) || 'Report',
        recorded_on: firstDate(r.effectiveDateTime, r.effectivePeriod?.start, r.issued),
      };
    }
    case 'Observation': {
      const kinds = codes(r.category).join(' ');
      const category = /laboratory/.test(kinds) ? 'labs' : /vital/.test(kinds) ? 'vitals' : IMAGING.test(kinds) ? 'imaging' : 'observations';
      return { category, title: cc(r.code) || 'Observation', recorded_on: firstDate(r.effectiveDateTime, r.effectivePeriod?.start, r.issued) };
    }
    case 'ImagingStudy':
      return { category: 'imaging', title: r.description || cc(r.procedureCode?.[0]) || r.series?.[0]?.bodySite?.display || 'Imaging study', recorded_on: day(r.started) };
    case 'Media':
      return { category: 'imaging', title: r.content?.title || cc(r.type) || 'Image', recorded_on: firstDate(r.createdDateTime, r.issued) };
    case 'MedicationRequest':
    case 'MedicationStatement':
      return {
        category: 'medications',
        title: cc(r.medicationCodeableConcept) || r.medicationReference?.display || 'Medication',
        recorded_on: firstDate(r.authoredOn, r.effectiveDateTime, r.effectivePeriod?.start, r.dateAsserted),
      };
    case 'Condition':
      return { category: 'conditions', title: cc(r.code) || 'Condition', recorded_on: firstDate(r.onsetDateTime, r.recordedDate) };
    case 'AllergyIntolerance':
      return { category: 'allergies', title: cc(r.code) || 'Allergy', recorded_on: firstDate(r.onsetDateTime, r.recordedDate) };
    case 'Immunization':
      return { category: 'immunizations', title: cc(r.vaccineCode) || 'Immunization', recorded_on: firstDate(r.occurrenceDateTime, r.recorded) };
    case 'Procedure':
      return { category: 'procedures', title: cc(r.code) || 'Procedure', recorded_on: firstDate(r.performedDateTime, r.performedPeriod?.start) };
    case 'CarePlan':
    case 'Goal':
      return { category: 'care_plans', title: r.title || cc(r.description) || r.description?.text || cc(r.category?.[0]) || t, recorded_on: firstDate(r.period?.start, r.startDate, r.created) };
    case 'Coverage':
      return { category: 'insurance', title: r.payor?.[0]?.display || cc(r.type) || 'Coverage', recorded_on: day(r.period?.start) };
    default:
      return { category: 'other', title: cc(r.code) || cc(r.type) || t, recorded_on: firstDate(r.date, r.authoredOn, r.period?.start) };
  }
}

export const CATEGORIES = [
  ['profile', 'Personal information'],
  ['visits', 'Visits'],
  ['summaries', 'After-visit summaries'],
  ['notes', 'Notes'],
  ['labs', 'Lab results'],
  ['imaging', 'Imaging'],
  ['reports', 'Reports'],
  ['medications', 'Medications'],
  ['conditions', 'Conditions'],
  ['allergies', 'Allergies'],
  ['immunizations', 'Immunizations'],
  ['procedures', 'Procedures'],
  ['vitals', 'Vitals'],
  ['observations', 'Other measurements'],
  ['care_plans', 'Care plans'],
  ['insurance', 'Insurance'],
  ['other', 'Other'],
];

/** A short second line for a list: the value of a lab, the status of a med. */
export function detail(r) {
  const q = r.valueQuantity;
  if (q) return `${q.value ?? ''}${q.unit ? ` ${q.unit}` : ''}${r.interpretation?.[0] ? ` (${cc(r.interpretation[0])})` : ''}`.trim();
  if (r.valueString) return r.valueString.slice(0, 120);
  if (r.valueCodeableConcept) return cc(r.valueCodeableConcept);
  if (r.resourceType === 'Observation' && r.component?.length)
    return r.component.map((c) => `${cc(c.code)}: ${c.valueQuantity?.value ?? cc(c.valueCodeableConcept) ?? ''}${c.valueQuantity?.unit ? ` ${c.valueQuantity.unit}` : ''}`).join(', ').slice(0, 160);
  if (r.resourceType === 'MedicationRequest') return [r.dosageInstruction?.[0]?.text, r.status].filter(Boolean).join(' · ');
  if (r.resourceType === 'Condition') return cc(r.clinicalStatus) ?? '';
  if (r.resourceType === 'AllergyIntolerance') return [cc(r.reaction?.[0]?.manifestation?.[0]), r.criticality].filter(Boolean).join(' · ');
  if (r.resourceType === 'Encounter') return [r.serviceProvider?.display, r.participant?.[0]?.individual?.display].filter(Boolean).join(' · ');
  if (r.resourceType === 'DiagnosticReport') return r.conclusion?.slice(0, 160) ?? (r.result?.length ? `${r.result.length} results` : '');
  if (r.resourceType === 'DocumentReference') return r.author?.[0]?.display ?? '';
  return r.status ?? '';
}

/** The patient's demographics and identifiers, flattened for display and export. */
export function profileOf(p) {
  if (!p) return null;
  const tel = (sys) => (p.telecom ?? []).filter((t) => t.system === sys && t.value).map((t) => `${t.value}${t.use ? ` (${t.use})` : ''}`);
  return {
    name: humanName(p),
    birth_date: p.birthDate ?? null,
    sex: p.gender ?? null,
    phones: tel('phone'),
    emails: tel('email'),
    addresses: (p.address ?? []).map((a) => a.text || [...(a.line ?? []), a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ')),
    identifiers: (p.identifier ?? []).filter((i) => i.value).map((i) => ({ type: cc(i.type) || i.system || 'id', value: i.value })),
    language: cc(p.communication?.[0]?.language),
    marital_status: cc(p.maritalStatus),
    contacts: (p.contact ?? []).map((c) => ({ name: humanName({ name: c.name ? [c.name] : [] }), relationship: cc(c.relationship?.[0]), phone: c.telecom?.find((t) => t.system === 'phone')?.value ?? null })),
    general_practitioner: p.generalPractitioner?.map((g) => g.display).filter(Boolean) ?? [],
  };
}

/** Every file a resource points at. */
export function attachmentsOf(r) {
  const list = [];
  const add = (a, title) => a && (a.url || a.data) && list.push({ ...a, title: a.title || title });
  if (r.resourceType === 'DocumentReference') for (const c of r.content ?? []) add(c.attachment, r.description || cc(r.type));
  if (r.resourceType === 'DiagnosticReport') for (const a of r.presentedForm ?? []) add(a, cc(r.code));
  if (r.resourceType === 'Media') add(r.content, cc(r.type) || 'Image');
  if (r.resourceType === 'Patient') for (const a of r.photo ?? []) add(a, 'Photo');
  return list;
}

/* --------------------------------------------------------------------- sync -- */

// Patient-access resources (US Core). Each entry's fallbacks are searches to
// try when the plain one is refused: Epic, for one, wants a category on some.
const SEARCHES = [
  ['AllergyIntolerance'],
  ['Condition', ['problem-list-item', 'encounter-diagnosis', 'health-concern']],
  ['Encounter'],
  ['DocumentReference', ['clinical-note', 'imaging-result', 'correspondence']],
  ['DiagnosticReport', ['LAB', 'RAD', 'imaging', 'cardiology']],
  ['Observation', ['laboratory', 'vital-signs', 'social-history', 'imaging', 'procedure', 'survey', 'exam']],
  ['MedicationRequest'],
  ['MedicationStatement'],
  ['Immunization'],
  ['Procedure'],
  ['ImagingStudy'],
  ['Media'],
  ['CarePlan'],
  ['Goal'],
  ['Coverage'],
  ['ServiceRequest'],
  ['CareTeam'],
  ['Device'],
];

function fhirClient(conn0) {
  let conn = conn0;
  let token = null;
  const base = conn.fhir_base;
  async function get(url, accept = 'application/fhir+json') {
    if (!sameOrigin(url, base)) throw new Error(`refusing to follow ${new URL(url).origin}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token || attempt) ({ conn, token } = await accessToken(attempt ? { ...conn, token_expires_at: new Date(0) } : conn));
      const res = await timedFetch(url, { headers: { authorization: `Bearer ${token}`, accept } });
      if (res.status === 401 && !attempt && conn.refresh_token) continue;
      return res;
    }
  }
  return { get, base };
}

/** Each page of a search, until the server stops giving a next link. */
async function* pages(client, url) {
  let next = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const res = await client.get(next);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const bundle = await res.json();
    yield (bundle.entry ?? []).map((e) => e.resource).filter(Boolean);
    next = bundle.link?.find((l) => l.relation === 'next')?.url ?? null;
  }
}

async function upsert(conn, r) {
  if (!r?.resourceType || !r.id || r.resourceType === 'OperationOutcome') return null;
  const { category, title, recorded_on } = classify(r);
  const [row] = await db()`
    insert into health_records (connection_id, user_id, resource_type, resource_id, category, title, recorded_on, resource)
    values (${conn.id}, ${conn.user_id}, ${r.resourceType}, ${r.id}, ${category}, ${title?.slice(0, 300) ?? null}, ${recorded_on}, ${r})
    on conflict (connection_id, resource_type, resource_id) do update set
      category = excluded.category, title = excluded.title, recorded_on = excluded.recorded_on,
      resource = excluded.resource, fetched_at = now()
    returning id`;
  return row.id;
}

async function searchAll(client, conn, type, fallbacks, patient) {
  const url = (cat) => `${client.base}/${type}?patient=${encodeURIComponent(patient)}&_count=${PAGE_SIZE}${cat ? `&category=${encodeURIComponent(cat)}` : ''}`;
  const run = async (u) => {
    let n = 0;
    for await (const list of pages(client, u)) for (const r of list) if (r.resourceType === type && (await upsert(conn, r))) n++;
    return n;
  };
  try {
    return { n: await run(url()) };
  } catch (err) {
    if (!fallbacks?.length || ![400, 403, 422].includes(err.status)) return { n: 0, error: `${type}: ${err.message}` };
    let n = 0;
    const errors = [];
    for (const cat of fallbacks) {
      try {
        n += await run(url(cat));
      } catch (e) {
        if (![400, 403, 404, 422].includes(e.status)) errors.push(`${type}?category=${cat}: ${e.message}`);
      }
    }
    return { n, error: errors.join('; ') || null };
  }
}

async function fetchFile(client, conn, recordId, att, i) {
  const sql = db();
  if (att.data) {
    const bytes = Buffer.from(att.data, 'base64');
    return storeFile(sql, conn, recordId, `inline:${i}`, att, bytes, att.contentType);
  }
  const url = new URL(att.url, `${client.base}/`).toString();
  const [have] = await sql`select 1 from health_files where record_id = ${recordId} and source_url = ${url}`;
  if (have) return false;
  // Files only come from the provider's own server: the token never goes elsewhere.
  if (!sameOrigin(url, client.base)) return false;
  let res = await client.get(url, att.contentType || '*/*');
  // A Binary may redirect to a storage URL that is signed already: follow one hop,
  // without our token, and only to a public address.
  if (res.status >= 301 && res.status <= 308 && res.headers.get('location')) {
    const to = new URL(res.headers.get('location'), url).toString();
    await assertPublicUrl(to);
    res = await timedFetch(to, { headers: { accept: att.contentType || '*/*' } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_FILE_BYTES) return false;
  let bytes = Buffer.from(await res.arrayBuffer());
  let type = (res.headers.get('content-type') || att.contentType || 'application/octet-stream').split(';')[0];
  // Some servers answer a Binary read with the FHIR Binary resource, not the bytes.
  if (/fhir\+json|application\/json/.test(type) && !/json/.test(att.contentType ?? '')) {
    const b = JSON.parse(bytes.toString('utf8'));
    if (b.resourceType === 'Binary' && b.data) {
      bytes = Buffer.from(b.data, 'base64');
      type = b.contentType || att.contentType || 'application/octet-stream';
    }
  }
  if (bytes.length > MAX_FILE_BYTES) return false;
  return storeFile(sql, conn, recordId, url, att, bytes, type);
}

async function storeFile(sql, conn, recordId, url, att, bytes, type) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const r = await sql`
    insert into health_files (record_id, connection_id, user_id, source_url, title, content_type, size, sha256, data)
    values (${recordId}, ${conn.id}, ${conn.user_id}, ${url}, ${att.title?.slice(0, 200) ?? null}, ${type ?? null}, ${bytes.length}, ${sha}, ${bytes})
    on conflict (record_id, source_url) do nothing returning id`;
  return r.length > 0;
}

/**
 * A prescription often names its drug by reference (medicationReference ->
 * Medication/123) rather than inline. Fetch each referenced Medication once,
 * keep it (the export stays complete) and title the prescriptions with its name.
 */
async function resolveMedications(client, conn, errors) {
  const sql = db();
  const rows = await sql`
    select id, resource from health_records
    where connection_id = ${conn.id} and resource_type in ('MedicationRequest', 'MedicationStatement')
      and resource->'medicationReference'->>'reference' is not null`;
  const names = new Map();
  for (const row of rows) {
    const r = row.resource;
    const ref = r.medicationReference.reference;
    if (!names.has(ref)) {
      let name = null;
      const contained = ref.startsWith('#') ? r.contained?.find((c) => `#${c.id}` === ref) : null;
      if (contained) name = cc(contained.code);
      else if (/^(Medication\/[\w.-]+|https?:\/\/)/.test(ref)) {
        try {
          const res = await client.get(new URL(ref, `${client.base}/`).toString());
          if (res.ok) {
            const med = await res.json();
            if (med.resourceType === 'Medication') {
              await sql`
                insert into health_records (connection_id, user_id, resource_type, resource_id, category, title, recorded_on, resource)
                values (${conn.id}, ${conn.user_id}, 'Medication', ${med.id}, 'other', ${cc(med.code)?.slice(0, 300) ?? 'Medication'}, null, ${med})
                on conflict (connection_id, resource_type, resource_id) do update set resource = excluded.resource, title = excluded.title, fetched_at = now()`;
              name = cc(med.code);
            }
          }
        } catch (err) {
          if (errors.length < 50) errors.push(`${ref}: ${err.message}`);
        }
      }
      names.set(ref, name);
    }
    const name = names.get(ref);
    if (name) await sql`update health_records set title = ${name.slice(0, 300)} where id = ${row.id}`;
  }
  // A statement may name no drug at all, only the prescription it is based on.
  await sql`
    update health_records s set title = r.title
    from health_records r
    where s.connection_id = ${conn.id} and s.resource_type = 'MedicationStatement' and s.title = 'Medication'
      and r.connection_id = s.connection_id and r.resource_type = 'MedicationRequest' and r.title <> 'Medication'
      and s.resource->'basedOn'->0->>'reference' = 'MedicationRequest/' || r.resource_id`;
}

/**
 * Copy everything. Safe to call again: records upsert by FHIR id, files skip
 * what is already stored. Returns counts; failures per type land in last_error.
 */
export async function sync(connectionId) {
  const sql = db();
  const [conn] = await sql`
    update health_connections set status = 'syncing', updated_at = now()
    where id = ${connectionId} and status in ('active', 'error', 'syncing')
      and (status <> 'syncing' or updated_at < now() - interval '15 minutes')
      and access_token is not null
    returning *`;
  if (!conn) return { skipped: true };
  const errors = [];
  const counts = {};
  let files = 0;
  try {
    const client = fhirClient(conn);
    const patient = conn.patient_ref;
    const res = await client.get(`${client.base}/Patient/${encodeURIComponent(patient)}`);
    if (!res.ok) throw new Error(`could not read your patient record (HTTP ${res.status})`);
    await upsert(conn, await res.json());
    counts.Patient = 1;
    for (const [type, fallbacks] of SEARCHES) {
      const r = await searchAll(client, conn, type, fallbacks, patient);
      if (r.n) counts[type] = r.n;
      if (r.error) errors.push(r.error);
    }
    await resolveMedications(client, conn, errors);
    const rows = await sql`
      select id, resource from health_records
      where connection_id = ${conn.id} and resource_type in ('DocumentReference', 'DiagnosticReport', 'Media', 'Patient')`;
    let tried = 0;
    for (const row of rows) {
      const atts = attachmentsOf(row.resource);
      for (let i = 0; i < atts.length && tried < MAX_FILES_PER_SYNC; i++, tried++) {
        try {
          if (await fetchFile(client, conn, row.id, atts[i], i)) files++;
        } catch (err) {
          if (errors.length < 50) errors.push(`file ${atts[i].url ?? 'inline'}: ${err.message}`);
        }
      }
    }
    await sql`
      update health_connections set status = 'active', last_synced_at = now(),
        last_error = ${errors.length ? errors.slice(0, 20).join('\n').slice(0, 2000) : null}, updated_at = now()
      where id = ${conn.id}`;
    return { counts, files, errors };
  } catch (err) {
    const expired = err instanceof RecordsError && err.status === 409;
    await sql`
      update health_connections set status = ${expired ? 'expired' : 'error'}, last_error = ${err.message.slice(0, 500)}, updated_at = now()
      where id = ${conn.id}`;
    return { counts, files, errors: [...errors, err.message], failed: true };
  }
}

/** Start a sync without waiting; the connection's status shows progress. */
export function syncInBackground(connectionId) {
  sync(connectionId).catch((err) => console.error('[records] sync', connectionId, err.message));
}

/* -------------------------------------------------------------------- reads -- */

const CONNECTION_COLUMNS = (sql) => sql`
  c.id, c.provider_name, c.vendor, c.fhir_base, c.status, c.last_synced_at, c.last_error, c.created_at,
  (select count(*)::int from health_records r where r.connection_id = c.id) as records,
  (select count(*)::int from health_files f where f.connection_id = c.id) as files`;

export async function connections(userId) {
  const sql = db();
  const rows = await sql`select ${CONNECTION_COLUMNS(sql)} from health_connections c
                         where c.user_id = ${userId} and c.status <> 'pending' order by c.created_at`;
  const shares = rows.length
    ? await sql`select s.connection_id, s.org_id, o.name as org_name, s.shared_at from health_connection_shares s
                join organizations o on o.id = s.org_id where s.connection_id = any(${rows.map((r) => r.id)})`
    : [];
  for (const r of rows) r.shared_with = shares.filter((s) => s.connection_id === r.id).map(({ org_id, org_name, shared_at }) => ({ org_id, org_name, shared_at }));
  return rows;
}

export async function connectionFor(userId, id) {
  const [c] = await db()`select * from health_connections where id = ${id} and user_id = ${userId}`;
  if (!c) fail(404, 'no such connection');
  return c;
}

/** Counts per category plus the newest profile: the overview. */
export async function overview(userId, scope = {}) {
  const sql = db();
  const where = scopeWhere(sql, userId, scope);
  const cats = await sql`select category, count(*)::int as n from health_records r where ${where} group by category`;
  const [p] = await sql`select resource from health_records r where ${where} and resource_type = 'Patient' order by fetched_at desc limit 1`;
  const [f] = await sql`select count(*)::int as n, coalesce(sum(size), 0)::bigint as bytes from health_files f
                        where f.record_id in (select id from health_records r where ${where})`;
  const by = Object.fromEntries(cats.map((c) => [c.category, c.n]));
  return {
    profile: profileOf(p?.resource),
    categories: CATEGORIES.filter(([k]) => by[k]).map(([key, label]) => ({ key, label, count: by[key] })),
    total: cats.reduce((n, c) => n + c.n, 0),
    files: f.n,
    bytes: Number(f.bytes),
  };
}

/**
 * Whose records: a user's own (optionally one connection), or for a practice,
 * only connections that patient shared with it.
 */
function scopeWhere(sql, userId, { connectionId, orgId, patientId } = {}) {
  if (orgId)
    return sql`r.connection_id in (select connection_id from health_connection_shares where org_id = ${orgId} and patient_id = ${patientId})`;
  return connectionId ? sql`r.user_id = ${userId} and r.connection_id = ${connectionId}` : sql`r.user_id = ${userId}`;
}

export async function items(userId, { category, q, limit = 100, offset = 0, ...scope } = {}) {
  const sql = db();
  const where = scopeWhere(sql, userId, scope);
  const rows = await sql`
    select r.id, r.connection_id, c.provider_name, r.resource_type, r.category, r.title, r.recorded_on::text as recorded_on, r.resource
    from health_records r join health_connections c on c.id = r.connection_id
    where ${where}
      ${category ? sql`and r.category = ${category}` : sql``}
      ${q ? sql`and r.title ilike ${`%${String(q).replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : sql``}
    order by r.recorded_on desc nulls last, r.title
    limit ${Math.min(Number(limit) || 100, 500)} offset ${Math.max(Number(offset) || 0, 0)}`;
  const files = rows.length
    ? await sql`select id, record_id, title, content_type, size from health_files where record_id = any(${rows.map((r) => r.id)}) order by title`
    : [];
  return rows.map(({ resource, ...r }) => ({
    ...r,
    detail: detail(resource),
    files: files.filter((f) => f.record_id === r.id).map(({ record_id, ...f }) => f),
  }));
}

export async function item(userId, id, scope = {}) {
  const sql = db();
  const [r] = await sql`select r.id, r.connection_id, r.resource_type, r.resource_id, r.category, r.title, r.recorded_on::text as recorded_on, r.resource, r.fetched_at, c.provider_name from health_records r join health_connections c on c.id = r.connection_id
                        where r.id = ${id} and ${scopeWhere(sql, userId, scope)}`;
  if (!r) fail(404, 'no such record');
  const files = await sql`select id, title, content_type, size, sha256 from health_files where record_id = ${r.id}`;
  return { ...r, detail: detail(r.resource), files };
}

export async function file(userId, id, scope = {}) {
  const sql = db();
  const [f] = await sql`select f.* from health_files f join health_records r on r.id = f.record_id
                        where f.id = ${id} and ${scopeWhere(sql, userId, scope)}`;
  if (!f) fail(404, 'no such file');
  return f;
}

/* ------------------------------------------------------------------- export -- */

const EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/tiff': 'tif',
  'image/webp': 'webp', 'text/plain': 'txt', 'text/html': 'html', 'text/rtf': 'rtf', 'application/rtf': 'rtf',
  'application/xml': 'xml', 'text/xml': 'xml', 'application/dicom': 'dcm', 'application/json': 'json',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
const safe = (s, max = 80) => String(s ?? '').replace(/[^\w .,()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'untitled';
const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

function profileText(p, provider) {
  if (!p) return `No patient record was returned by ${provider}.\n`;
  const lines = [`Personal information from ${provider}`, ''];
  const kv = (k, v) => v && (Array.isArray(v) ? v.length : true) && lines.push(`${`${k}:`.padEnd(22)} ${Array.isArray(v) ? v.join('; ') : v}`);
  kv('Name', p.name);
  kv('Date of birth', p.birth_date);
  kv('Sex', p.sex);
  kv('Phone', p.phones);
  kv('Email', p.emails);
  kv('Address', p.addresses);
  kv('Language', p.language);
  kv('Marital status', p.marital_status);
  kv('Primary care', p.general_practitioner);
  for (const i of p.identifiers) kv(i.type.replace(/^https?:\/\//, ''), i.value);
  for (const c of p.contacts) kv('Contact', [c.name, c.relationship, c.phone].filter(Boolean).join(', '));
  return `${lines.join('\n')}\n`;
}

/**
 * Everything for a user (or one connection, or what a patient shared with a
 * practice) as a ZIP: per provider a readable patient.txt, records.md and
 * labs.csv, the raw FHIR JSON by category, and every file; plus one FHIR Bundle.
 */
export async function exportZip(userId, scope = {}) {
  const sql = db();
  const where = scopeWhere(sql, userId, scope);
  const rows = await sql`
    select r.id, r.connection_id, c.provider_name, r.resource_type, r.category, r.title, r.recorded_on::text as recorded_on, r.resource
    from health_records r join health_connections c on c.id = r.connection_id
    where ${where} order by c.provider_name, r.category, r.recorded_on desc nulls last`;
  const files = rows.length
    ? await sql`select f.* from health_files f where f.record_id = any(${rows.map((r) => r.id)})`
    : [];
  const today = new Date().toISOString().slice(0, 10);
  const root = `tleehealth-records-${today}`;
  const entries = [];
  const label = Object.fromEntries(CATEGORIES);
  const byConn = new Map();
  for (const r of rows) {
    if (!byConn.has(r.connection_id)) byConn.set(r.connection_id, []);
    byConn.get(r.connection_id).push(r);
  }
  const usedDirs = new Set();
  for (const [connId, list] of byConn) {
    let dir = safe(list[0].provider_name, 60);
    while (usedDirs.has(dir)) dir += '_';
    usedDirs.add(dir);
    const p = list.find((r) => r.resource_type === 'Patient');
    entries.push({ name: `${root}/${dir}/patient.txt`, data: profileText(profileOf(p?.resource), list[0].provider_name) });

    const md = [`# ${list[0].provider_name}`, '', `Exported ${today} from tleehealth.com. Raw FHIR JSON is in the fhir/ folder.`, ''];
    const cats = [...new Set(list.map((r) => r.category))];
    for (const cat of cats) {
      const of = list.filter((r) => r.category === cat);
      md.push(`## ${label[cat] ?? cat} (${of.length})`, '');
      for (const r of of) md.push(`- ${r.recorded_on ? `${String(r.recorded_on instanceof Date ? r.recorded_on.toISOString() : r.recorded_on).slice(0, 10)} ` : ''}${r.title ?? r.resource_type}${detail(r.resource) ? ` — ${detail(r.resource)}` : ''}`);
      md.push('');
      entries.push({ name: `${root}/${dir}/fhir/${cat}.json`, data: JSON.stringify(of.map((r) => r.resource), null, 2) });
    }
    entries.push({ name: `${root}/${dir}/records.md`, data: md.join('\n') });

    const labs = list.filter((r) => r.resource_type === 'Observation' && r.category === 'labs');
    if (labs.length) {
      const head = 'date,test,value,unit,reference_range,interpretation,status';
      const lines = labs.map((r) => {
        const o = r.resource;
        const rr = o.referenceRange?.[0];
        const range = rr?.text || [rr?.low?.value, rr?.high?.value].filter((v) => v != null).join('-');
        return [day(o.effectiveDateTime) ?? '', r.title, o.valueQuantity?.value ?? o.valueString ?? cc(o.valueCodeableConcept) ?? '', o.valueQuantity?.unit ?? '', range ?? '', cc(o.interpretation?.[0]) ?? '', o.status ?? '']
          .map(csvCell).join(',');
      });
      entries.push({ name: `${root}/${dir}/labs.csv`, data: `${head}\n${lines.join('\n')}\n` });
    }

    const used = new Set();
    for (const f of files.filter((x) => x.connection_id === connId)) {
      const rec = list.find((r) => r.id === f.record_id);
      const d = rec?.recorded_on ? String(rec.recorded_on instanceof Date ? rec.recorded_on.toISOString() : rec.recorded_on).slice(0, 10) : 'undated';
      const ext = EXT[f.content_type] ?? 'bin';
      let name = `${d} ${safe(f.title || rec?.title)}`;
      while (used.has(`${rec?.category}/${name}`)) name += '_';
      used.add(`${rec?.category}/${name}`);
      entries.push({ name: `${root}/${dir}/files/${rec?.category ?? 'other'}/${name}.${ext}`, data: new Uint8Array(f.data) });
    }
  }
  const bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: rows.map((r) => ({ fullUrl: `urn:tleehealth:${r.provider_name}:${r.resource_type}/${r.resource.id}`, resource: r.resource })),
  };
  entries.push({ name: `${root}/fhir-bundle.json`, data: JSON.stringify(bundle) });
  entries.push({
    name: `${root}/README.txt`,
    data: `Your health records, exported from tleehealth.com on ${today}.\n\n` +
      `${byConn.size} provider${byConn.size === 1 ? '' : 's'}, ${rows.length} records, ${files.length} files.\n\n` +
      'Each provider folder has:\n' +
      '  patient.txt   your personal information as that provider has it\n' +
      '  records.md    every record, readable\n' +
      '  labs.csv      lab results, one per line (when there are any)\n' +
      '  files/        after-visit summaries, notes, reports and images, as the provider sent them\n' +
      '  fhir/         the raw records (HL7 FHIR R4 JSON), by category\n\n' +
      'fhir-bundle.json holds every record in one FHIR Bundle, which other health apps can import.\n' +
      'This file contains protected health information. Store it somewhere private.\n',
  });
  return { filename: `${root}.zip`, bytes: zip(entries), records: rows.length, files: files.length };
}

/** Everything as one FHIR Bundle, the files inlined as Binary resources. */
export async function exportBundle(userId, scope = {}) {
  const sql = db();
  const where = scopeWhere(sql, userId, scope);
  const rows = await sql`select r.id, r.resource, c.provider_name from health_records r join health_connections c on c.id = r.connection_id where ${where}`;
  const files = rows.length ? await sql`select * from health_files where record_id = any(${rows.map((r) => r.id)})` : [];
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [
      ...rows.map((r) => ({ fullUrl: `urn:tleehealth:${r.provider_name}:${r.resource.resourceType}/${r.resource.id}`, resource: r.resource })),
      ...files.map((f) => ({
        fullUrl: f.source_url.startsWith('inline:') ? `urn:tleehealth:file:${f.id}` : f.source_url,
        resource: { resourceType: 'Binary', id: f.id, contentType: f.content_type, data: Buffer.from(f.data).toString('base64') },
      })),
    ],
  };
}
