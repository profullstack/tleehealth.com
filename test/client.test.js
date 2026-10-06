import { describe, expect, test } from 'bun:test';
import { formatCaseload, formatDay, formatSuperbill, parse } from '../packages/cli/src/cli.js';
import { resolveDate } from '../packages/cli/src/client.js';
import { handle } from '../packages/mcp/src/server.js';

describe('cli', () => {
  test('parse flags', () => {
    expect(parse(['schedule', '--date', 'tomorrow', '--json'])).toEqual({
      positional: ['schedule'],
      flags: { date: 'tomorrow', json: true },
    });
  });
  test('resolveDate', () => {
    expect(resolveDate('2026-01-02')).toBe('2026-01-02');
    expect(resolveDate('today')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => resolveDate('someday')).toThrow();
  });
  test('formatDay names the practice and handles an empty day', () => {
    const out = formatDay({ date: '2026-10-07', org: { name: 'Lin Family Practice' }, appointments: [] });
    expect(out).toContain('Lin Family Practice');
    expect(out).toContain('nothing booked');
  });
  test('caseload and superbill print one line per enrollment', () => {
    const row = {
      patient: 'Rosa Diaz', program_name: 'PIN', minutes: 95, program_id: 'p1', next_unit_in: 25, blockers: [], ready: true,
      lines: [{ code: 'G0023', units: 1 }, { code: 'G0024', units: 1 }],
    };
    const c = formatCaseload({ month: '2026-10', mine: true, caseload: [row] });
    expect(c).toContain('caseload 2026-10 (mine)');
    expect(c).toContain('G0023 + G0024');
    expect(c).toContain('25 min to next');
    const sb = formatSuperbill({ month: '2026-10', ready: 1, held: 0, under: 0, rows: [row], totals: { G0023: 1, G0024: 1 } });
    expect(sb).toContain('ready to bill: G0023 x1, G0024 x1');
  });
});

describe('mcp', () => {
  test('lists tools', async () => {
    const { tools } = await handle({ method: 'tools/list' });
    expect(tools.map((t) => t.name)).toEqual(['get_schedule', 'get_caseload', 'get_superbill', 'log_navigation_time', 'api_health']);
  });
  test('initialize', async () => {
    expect((await handle({ method: 'initialize' })).serverInfo.name).toBe('tleehealth');
  });
});
