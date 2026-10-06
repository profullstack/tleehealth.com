import { describe, expect, test } from 'bun:test';
import { formatDay, parse } from '../packages/cli/src/cli.js';
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
});

describe('mcp', () => {
  test('lists tools', async () => {
    const { tools } = await handle({ method: 'tools/list' });
    expect(tools.map((t) => t.name)).toEqual(['get_schedule', 'api_health']);
  });
  test('initialize', async () => {
    expect((await handle({ method: 'initialize' })).serverInfo.name).toBe('tleehealth');
  });
});
