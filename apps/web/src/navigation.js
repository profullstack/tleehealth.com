/**
 * Care-management programs and the Medicare time-based codes they bill.
 *
 * Pure functions: the API reads minutes from care_time and asks this module what
 * they add up to. Prices vary by locality and change yearly, so none are kept
 * here; a superbill lists codes and units, and the biller prices them.
 *
 * A unit counts only when its whole time is met: G0023 at 60 minutes, each G0024
 * at another 30. The CPT "midpoint" rule (a unit at 31 minutes) does NOT apply to
 * these codes. CMS, CY2024 PFS final rule, 88 FR 78941: "if a patient requires
 * less than 60 minutes per month for PIN services, then their needs may be best
 * suited to other types of care management services." CMS also declined shorter
 * increments for CHI (88 FR 78925), and the CY2025/2026 rules kept the 60 minutes.
 * CCM's descriptors say "at least 20 minutes". Never add a midpoint option back:
 * it would bill Medicare for time not spent.
 */

export const PROGRAMS = {
  pin: {
    name: 'Principal Illness Navigation',
    short: 'PIN',
    first: { code: 'G0023', minutes: 60 },
    addon: { code: 'G0024', minutes: 30, max: null },
    yearlyConsent: true,
    about: 'One serious, high-risk condition expected to last at least 3 months.',
  },
  pin_ps: {
    name: 'Principal Illness Navigation, peer support',
    short: 'PIN-PS',
    first: { code: 'G0140', minutes: 60 },
    addon: { code: 'G0146', minutes: 30, max: null },
    yearlyConsent: true,
    about: 'PIN for a serious behavioral health condition, by a certified peer specialist.',
  },
  chi: {
    name: 'Community Health Integration',
    short: 'CHI',
    first: { code: 'G0019', minutes: 60 },
    addon: { code: 'G0022', minutes: 30, max: null },
    yearlyConsent: true,
    about: 'Upstream drivers (housing, food, transport) that get in the way of the treatment plan.',
  },
  ccm: {
    name: 'Chronic Care Management',
    short: 'CCM',
    first: { code: '99490', minutes: 20 },
    addon: { code: '99439', minutes: 20, max: 2 },
    yearlyConsent: false,
    needsCarePlan: true,
    about: 'Two or more chronic conditions expected to last 12 months or more, with a care plan.',
  },
};

export const ACTIVITIES = [
  'assessment',
  'care_plan',
  'coordination',
  'referral',
  'prior_auth',
  'scheduling',
  'education',
  'community_resources',
  'call',
  'other',
];

/**
 * What a month's minutes bill under a program: [{ code, units }], and how many
 * more minutes reach the next unit (null when the add-on is capped out).
 */
export function unitsFor(program, totalMinutes) {
  const p = PROGRAMS[program];
  if (!p) throw new Error(`unknown program ${program}`);
  const total = Math.max(0, Math.floor(totalMinutes || 0));
  const firstAt = p.first.minutes;
  if (total < firstAt) return { lines: [], next: firstAt - total };

  const lines = [{ code: p.first.code, units: 1 }];
  // Add-on units start counting after the first code's full time.
  const past = total - p.first.minutes;
  const addAt = p.addon.minutes;
  let addUnits = past < addAt ? 0 : 1 + Math.floor((past - addAt) / p.addon.minutes);
  if (p.addon.max != null) addUnits = Math.min(addUnits, p.addon.max);
  if (addUnits) lines.push({ code: p.addon.code, units: addUnits });

  const capped = p.addon.max != null && addUnits >= p.addon.max;
  return { lines, next: capped ? null : p.first.minutes + addUnits * p.addon.minutes + addAt - total };
}

/** 'YYYY-MM' -> { start: 'YYYY-MM-01', end: first day of the next month }. */
export function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

export const thisMonth = (d = new Date()) => d.toISOString().slice(0, 7);

export const ymd = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * What stops an enrollment from billing this month. Empty means ready.
 * enrollment: a care_programs row plus `billing_npi` and `has_care_plan`.
 */
export function blockers(enrollment, month) {
  const p = PROGRAMS[enrollment.program];
  const { start, end } = monthRange(month);
  const out = [];
  if (!enrollment.consent_at) out.push('no consent on file');
  else {
    const consent = ymd(enrollment.consent_at);
    if (consent >= end) out.push('consent was recorded after this month');
    else if (p.yearlyConsent) {
      // Renewed yearly: consent must be under a year old on the month's last day.
      const last = new Date(`${end}T00:00:00Z`);
      last.setUTCDate(last.getUTCDate() - 1);
      const yearBefore = new Date(last);
      yearBefore.setUTCFullYear(yearBefore.getUTCFullYear() - 1);
      if (consent <= ymd(yearBefore)) out.push('consent is over a year old; renew it');
    }
  }
  const visit = ymd(enrollment.initiating_visit_on);
  if (!visit) out.push('no initiating visit with the billing practitioner');
  else if (visit >= end) out.push('the initiating visit is after this month');
  if (!enrollment.billing_provider_id) out.push('no billing practitioner');
  else if (!enrollment.billing_npi) out.push("the billing practitioner's NPI is missing");
  if (!enrollment.condition) out.push('no condition recorded');
  if (p.needsCarePlan && !enrollment.has_care_plan) out.push('needs a care plan');
  if (ymd(enrollment.started_on) >= end) out.push('enrolled after this month');
  if (enrollment.status === 'ended' && ymd(enrollment.ended_on) < start) out.push('ended before this month');
  return out;
}

/** One superbill row per enrollment with time this month. */
export function superbillRow(enrollment, minutes, month) {
  const { lines, next } = unitsFor(enrollment.program, minutes);
  const blocked = blockers(enrollment, month);
  return {
    program_id: enrollment.id,
    patient_id: enrollment.patient_id,
    patient: enrollment.patient,
    dob: ymd(enrollment.dob),
    program: enrollment.program,
    program_name: PROGRAMS[enrollment.program].short,
    condition: enrollment.condition,
    billing_provider: enrollment.billing_provider,
    billing_npi: enrollment.billing_npi,
    navigator: enrollment.navigator,
    minutes,
    lines,
    next_unit_in: next,
    blockers: blocked,
    ready: lines.length > 0 && blocked.length === 0,
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // Leading = + - @ would run as a formula when the CSV is opened in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The superbill as CSV: one line per billable code, ready rows first. */
export function superbillCsv(rows, { month, practice }) {
  const head = ['month', 'practice', 'patient', 'dob', 'program', 'condition', 'billing_provider', 'npi', 'code', 'units', 'minutes', 'status'];
  const out = [head.join(',')];
  for (const r of rows) {
    const status = r.ready ? 'ready' : r.lines.length ? `hold: ${r.blockers.join('; ')}` : `under threshold (${r.next_unit_in} min to go)`;
    const lines = r.lines.length ? r.lines : [{ code: '', units: 0 }];
    for (const l of lines)
      out.push(
        [month, practice, r.patient, r.dob, r.program_name, r.condition, r.billing_provider, r.billing_npi, l.code, l.units, r.minutes, status]
          .map(csvCell)
          .join(','),
      );
  }
  return `${out.join('\n')}\n`;
}
