import { describe, expect, test } from 'bun:test';
import { app } from '../apps/web/src/app.js';

const get = (path) => app.request(path);

describe('web', () => {
  test('landing page names the product and the prices', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('tleehealth');
    expect(html).toContain('$199');
    expect(html).toContain('$10');
  });
  test('dashboard and patient previews are served', async () => {
    expect((await get('/app')).status).toBe(200);
    expect((await get('/patient')).status).toBe(200);
  });
  test('built pages have no unfilled design holes', async () => {
    for (const path of ['/', '/app', '/patient']) expect(await (await get(path)).text()).not.toContain('{{');
  });
  test('healthz', async () => expect((await get('/healthz')).status).toBe(200));
  test('api health reports the database', async () => {
    const res = await get('/api/v1/health');
    const body = await res.json();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(['ok', 'down', 'unconfigured']).toContain(body.database);
    expect(res.status).toBe(body.database === 'ok' ? 200 : 503);
  });
  test('schedule is marked demo and validates the date', async () => {
    const day = await (await get('/api/v1/schedule?date=2026-10-07')).json();
    expect(day.demo).toBe(true);
    expect(day.date).toBe('2026-10-07');
    expect(day.appointments.length).toBeGreaterThan(0);
    expect((await get('/api/v1/schedule?date=nope')).status).toBe(400);
  });
  test('unknown api path is JSON 404', async () => {
    const res = await get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });
  test('pwa + installer are served', async () => {
    expect((await get('/manifest.webmanifest')).status).toBe(200);
    expect((await get('/sw.js')).status).toBe(200);
    expect(await (await get('/install.sh')).text()).toContain('@profullstack/tleehealth');
  });
});
