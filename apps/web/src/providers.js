/**
 * The provider directory: every US clinician and healthcare organization that
 * holds an NPI. The data is the CMS NPPES registry (US public domain), the
 * same registry NicheDB's health collection ingests (nichedb.dev/f/providers).
 * Searches go to the registry's own API because it answers name and location
 * queries in well under a second.
 */
const NPPES = 'https://npiregistry.cms.hhs.gov/api/';
const TTL_MS = 10 * 60_000;
const MAX_CACHE = 500;
const PAGE = 20;
const MAX_SKIP = 1000;

export class ProvidersError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new ProvidersError(status, message);
};

export const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

// Label shown to people, and the registry taxonomy term it searches. The
// registry matches terms loosely, so facility specialties look only at
// organizations unless the search asks for people.
export const SPECIALTIES = [
  ['family-medicine', 'Family medicine', 'Family Medicine'],
  ['internal-medicine', 'Internal medicine', 'Internal Medicine'],
  ['pediatrics', 'Pediatrics', 'Pediatrics'],
  ['cardiology', 'Cardiology', 'Cardiovascular Disease'],
  ['endocrinology', 'Endocrinology and diabetes', 'Endocrinology*'],
  ['nephrology', 'Nephrology (kidney)', 'Nephrology'],
  ['neurology', 'Neurology', 'Neurology'],
  ['obgyn', 'Obstetrics and gynecology', 'Obstetrics & Gynecology'],
  ['dermatology', 'Dermatology', 'Dermatology'],
  ['psychiatry', 'Psychiatry', 'Psychiatry'],
  ['psychology', 'Psychology', 'Psychologist'],
  ['orthopedics', 'Orthopedic surgery', 'Orthopaedic Surgery'],
  ['emergency', 'Emergency medicine', 'Emergency Medicine'],
  ['nurse-practitioner', 'Nurse practitioner', 'Nurse Practitioner'],
  ['physician-assistant', 'Physician assistant', 'Physician Assistant'],
  ['dentist', 'Dentist', 'Dentist'],
  ['optometry', 'Optometry', 'Optometrist'],
  ['physical-therapy', 'Physical therapy', 'Physical Therapist'],
  ['chiropractic', 'Chiropractic', 'Chiropractor'],
  ['pharmacy', 'Pharmacy', 'Pharmacy', true],
  ['hospital', 'Hospital', 'General Acute Care Hospital', true],
  ['urgent-care', 'Urgent care', 'Urgent Care', true],
  ['laboratory', 'Clinical laboratory', 'Clinical Medical Laboratory', true],
  ['home-health', 'Home health', 'Home Health', true],
].map(([id, label, term, facility = false]) => ({ id, label, term, facility }));

const clean = (v, max = 80) => {
  const s = String(v ?? '').replace(/[^\p{L}\p{N} .,'&*-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
};
const title = (s) =>
  String(s ?? '').toLowerCase().replace(/(^|[\s\-'./(&])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).trim();

/** NPI check digit: Luhn over the number prefixed with 80840. */
export function validNpi(npi) {
  const text = String(npi ?? '');
  if (!/^[12]\d{9}$/.test(text)) return false;
  let sum = 24; // the constant the 80840 prefix contributes
  for (let i = 0; i < 9; i += 1) {
    let d = Number(text[8 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(text[9]);
}

function shape(r) {
  const basic = r.basic ?? {};
  const org = r.enumeration_type === 'NPI-2';
  const location = (r.addresses ?? []).find((a) => a.address_purpose === 'LOCATION') ?? r.addresses?.[0] ?? {};
  const taxonomies = (r.taxonomies ?? []).filter((t) => t.desc);
  const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
  const credential = clean(basic.credential, 24);
  const name = org
    ? title(basic.organization_name)
    : [title(basic.first_name), title(basic.middle_name).slice(0, 1), title(basic.last_name)].filter(Boolean).join(' ');
  const out = {
    npi: String(r.number),
    type: org ? 'organization' : 'individual',
    name: name || `NPI ${r.number}`,
    credential: org ? '' : credential,
    specialty: primary?.desc ?? '',
    specialties: [...new Set(taxonomies.map((t) => t.desc))].slice(0, 6),
    city: title(location.city),
    state: String(location.state ?? '').toUpperCase().slice(0, 2),
    postal_code: String(location.postal_code ?? '').slice(0, 5),
    active: basic.status === 'A',
    registry_url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
  };
  // A sole practitioner's listed address and phone are often their home, so a
  // person's entry stops at the city. Organizations publish a place of business.
  if (org) {
    out.address = [title(location.address_1), title(location.address_2)].filter(Boolean).join(', ');
    out.phone = String(location.telephone_number ?? '').slice(0, 20);
  }
  return out;
}

const cache = new Map();
async function registry(params, fetchImpl) {
  const url = `${NPPES}?${new URLSearchParams({ version: '2.1', ...params })}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  } catch {
    fail(502, 'The provider registry did not answer. Try again in a moment.');
  }
  if (!res.ok) fail(502, 'The provider registry did not answer. Try again in a moment.');
  const data = await res.json().catch(() => null);
  if (!data || data.Errors) {
    const reason = data?.Errors?.[0]?.description;
    fail(400, reason ? `The registry refused that search: ${reason}` : 'The registry refused that search.');
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(url, { at: Date.now(), data });
  return data;
}

/**
 * Search the directory. `q` is a person's name ("jane smith", "smith") or an
 * organization name; narrow with specialty, city, state, zip and type.
 */
export async function searchProviders(input = {}, { fetchImpl = fetch } = {}) {
  const q = clean(input.q);
  const city = clean(input.city, 60);
  const state = String(input.state ?? '').toUpperCase();
  const zip = String(input.zip ?? '').replace(/\D/g, '').slice(0, 5);
  const specialty = SPECIALTIES.find((s) => s.id === input.specialty);
  const asked = ['individual', 'organization'].includes(input.type) ? input.type : '';
  const page = Math.min(Math.max(Number.parseInt(input.page, 10) || 1, 1), MAX_SKIP / PAGE + 1);
  const type = asked || (specialty?.facility ? 'organization' : '');
  if (state && !STATES.includes(state)) fail(400, 'state must be a two-letter US state');
  if (input.specialty && !specialty) fail(400, 'unknown specialty');
  if (zip && zip.length !== 5) fail(400, 'zip must be five digits');
  if (!q && !city && !zip && !specialty) fail(400, 'Enter a name, a specialty, a city or a ZIP code.');
  if (q && q.replace(/[^\p{L}\p{N}]/gu, '').length < 2) fail(400, 'Enter at least two letters of the name.');

  const common = { limit: String(PAGE), skip: String((page - 1) * PAGE) };
  if (city) common.city = city;
  if (state) common.state = state;
  if (zip) common.postal_code = zip;
  if (specialty) common.taxonomy_description = specialty.term;

  const lookups = [];
  if (!q) {
    lookups.push({ ...common, ...(type ? { enumeration_type: type === 'organization' ? 'NPI-2' : 'NPI-1' } : {}) });
  } else {
    const words = q.split(' ').filter(Boolean);
    if (type !== 'organization') {
      const person = { ...common, enumeration_type: 'NPI-1', use_first_name_alias: 'true' };
      if (words.length === 1) person.last_name = `${words[0]}*`;
      else {
        person.first_name = `${words[0]}*`;
        person.last_name = `${words[words.length - 1]}*`;
      }
      lookups.push(person);
    }
    if (type !== 'individual') lookups.push({ ...common, enumeration_type: 'NPI-2', organization_name: `${q}*` });
  }

  const answers = await Promise.all(lookups.map((params) => registry(params, fetchImpl)));
  const seen = new Set();
  const results = [];
  let more = false;
  for (const data of answers) {
    if ((data.results ?? []).length >= PAGE) more = true;
    for (const r of data.results ?? []) {
      if (seen.has(r.number)) continue;
      seen.add(r.number);
      results.push(shape(r));
    }
  }
  return { page, more: more && page * PAGE < MAX_SKIP, results, source: SOURCE };
}

export async function getProvider(npi, { fetchImpl = fetch } = {}) {
  if (!validNpi(npi)) fail(400, 'That is not a valid NPI number.');
  const data = await registry({ number: String(npi) }, fetchImpl);
  const row = data.results?.[0];
  if (!row) fail(404, 'No provider holds that NPI.');
  return { provider: shape(row), source: SOURCE };
}

export const SOURCE = {
  name: 'NPPES, Centers for Medicare & Medicaid Services (US public domain)',
  registry: 'https://npiregistry.cms.hhs.gov/',
  dataset: 'https://nichedb.dev/f/providers',
};
