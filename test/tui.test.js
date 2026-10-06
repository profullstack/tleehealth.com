// The dashboard drawn off-screen: every tab renders from plain state.
import { describe, expect, test } from 'bun:test';
import { renderToText } from '@profullstack/hqtui/testing';
import { formatItems, formatRecords } from '../packages/cli/src/cli.js';
import { initialState, rowCount, view } from '../packages/cli/src/tui.js';

const RECORDS = {
  connections: [{ id: 'c1', provider_name: 'Lin Clinic MyChart', status: 'active', records: 14, files: 4, last_synced_at: '2026-10-06T12:00:00Z', shared_with: [] }],
  profile: { name: 'Ada Lin', birth_date: '1980-02-03', sex: 'female', phones: ['555-0100'], emails: [], addresses: ['1 Main St, Oakland, CA'], identifiers: [{ type: 'MRN', value: 'E12345' }], contacts: [], general_practitioner: [] },
  categories: [{ key: 'summaries', label: 'After-visit summaries', count: 1 }, { key: 'labs', label: 'Lab results', count: 3 }],
  total: 14,
  files: 4,
  bytes: 2048,
};

function state(tab) {
  const s = initialState('2026-10-07');
  s.tab = tab;
  s.me = { user: { email: 'ada@example.com' }, orgs: [{ id: 'o1', name: 'Lin Family Practice' }] };
  s.day = {
    date: '2026-10-07',
    appointments: [{ id: 'a1', starts_at: '2026-10-07T16:00:00Z', patient: 'Rosa Diaz', provider: 'Dr Lin', location: 'Mission St', mode: 'in_person', reason: 'Annual physical', status: 'confirmed', calls: [{ kind: 'reminder', status: 'completed' }] }],
    needs: { calls: [{ patient: 'Sam Roe', kind: 'followup', flag_reason: 'chest pain mentioned', ended_at: '2026-10-06T18:00:00Z' }], refills: [{ patient: 'Rosa Diaz', medication: 'Metformin', dose: '500 mg', requested_at: '2026-10-06' }], labs: [], summaries: [] },
  };
  s.caseload = { month: '2026-10', caseload: [{ patient: 'Rosa Diaz', program_name: 'PIN', minutes: 75, lines: [{ code: 'G0023', units: 1 }], next_unit_in: 15, blockers: [] }] };
  s.records = RECORDS;
  s.status = 'ready';
  return s;
}

const draw = (s) => renderToText(view(s), { width: 140, height: 30 });

describe('dashboard', () => {
  test('Today: appointments, AI call state, and what is waiting', () => {
    const out = draw(state(0));
    expect(out).toContain('1 Today');
    expect(out).toContain('Rosa Diaz');
    expect(out).toContain('reminder completed');
    expect(out).toContain('Flagged calls');
    expect(out).toContain('Your records');
  });

  test('Needs: flagged calls and refills in one list', () => {
    const out = draw(state(1));
    expect(out).toContain('chest pain mentioned');
    expect(out).toContain('Metformin 500 mg');
    expect(rowCount(state(1))).toBe(2);
  });

  test('Caseload: minutes and codes', () => {
    const out = draw(state(2));
    expect(out).toContain('G0023');
    expect(out).toContain('15 min');
  });

  test('Records: providers, categories, personal information', () => {
    const out = draw(state(3));
    expect(out).toContain('Lin Clinic MyChart');
    expect(out).toContain('After-visit summaries');
    expect(out).toContain('E12345');
    expect(out).toContain('export all');
  });

  test('Records: an open category lists its records', () => {
    const s = state(3);
    s.category = 'labs';
    s.items = [{ id: 'i1', title: 'A1c', recorded_on: '2026-09-01', detail: '6.1 %', files: [], resource_type: 'Observation' }];
    const out = draw(s);
    expect(out).toContain('Lab results · Esc back');
    expect(out).toContain('6.1 %');
  });

  test('a patient with no practice still gets Records', () => {
    const s = state(0);
    s.me.orgs = [];
    expect(draw(s)).toContain('not on a practice team');
  });
});

describe('records cli output', () => {
  test('overview shows providers, PII and categories', () => {
    const out = formatRecords(RECORDS);
    expect(out).toContain('Lin Clinic MyChart');
    expect(out).toContain('MRN: E12345');
    expect(out).toContain('--category labs');
  });
  test('no connections points at connect', () => {
    expect(formatRecords({ ...RECORDS, connections: [] })).toContain('tleehealth connect');
  });
  test('items list files with their ids', () => {
    expect(formatItems([{ title: 'AVS', recorded_on: '2026-09-01', detail: '', files: [{ id: 'f1', title: 'AVS' }], resource_type: 'DocumentReference' }])).toContain('AVS f1');
  });
});
