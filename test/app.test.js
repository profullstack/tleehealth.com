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
  test('the app shell is served for every app route', async () => {
    for (const path of ['/app', '/app/patients', '/signin', '/portal']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('/assets/app.js');
    }
    expect((await get('/patient')).status).toBe(301);
  });
  test('terms and privacy pages are served and linked from the landing page', async () => {
    const terms = await get('/terms');
    expect(terms.status).toBe(200);
    expect(await terms.text()).toContain('Terms of use');
    const privacy = await get('/privacy');
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain('Disconnecting a provider deletes');
    const home = await (await get('/')).text();
    expect(home).toContain('href="/terms"');
    expect(home).toContain('href="/privacy"');
  });
  test('the JWKS paths answer (404 with no signing key configured)', async () => {
    for (const p of ['/.well-known/jwks.json', '/.well-known/jwks-sandbox.json']) expect([200, 404]).toContain((await get(p)).status);
  });
  test('app assets are served', async () => {
    expect((await get('/assets/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await get('/assets/app.css')).status).toBe(200);
    expect((await get('/assets/webauthn.js')).status).toBe(200);
  });
  test('landing page has no unfilled design holes', async () => {
    expect(await (await get('/')).text()).not.toContain('{{');
  });
  test('landing footer server-renders the Profullstack webring row, one copyright line', async () => {
    const home = await (await get('/')).text();
    const foot = home.match(/<footer\b[^>]*data-pfs-footer[^>]*>[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(foot).not.toBe('');
    expect(foot).toContain('class="webring pfs-footer__ring"');
    expect(foot).toContain('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Ftleehealth.pwa.pit.world%2F');
    expect(foot).toContain('https://rssamplifier.com/ring/profullstack/previous?from=https%3A%2F%2Ftleehealth.pwa.pit.world%2F');
    expect(foot.match(/&copy;/g)?.length).toBe(1);
  });
  test('healthz', async () => expect((await get('/healthz')).status).toBe(200));
  test('health tracker requires a session for its shell and assets', async () => {
    for (const path of ['/health', '/health/']) {
      const page = await get(path);
      expect(page.status).toBe(302);
      expect(page.headers.get('location')).toBe('/signin?next=%2Fhealth%2F');
    }
    for (const path of ['/health/health.css', '/health/health.js', '/health/manifest.webmanifest']) {
      expect((await get(path)).status).toBe(401);
    }
    const worker = await get('/health/sw.js');
    expect(worker.status).toBe(200);
    expect(worker.headers.get('service-worker-allowed')).toBe('/health/');
    const workerSource = await worker.text();
    expect(workerSource).toContain('tleehealth-health-v5');
    expect(workerSource).toContain("client.navigate('/health/')");
  });
  test('units module is public and imported by the tracker and account page', async () => {
    const res = await get('/assets/units.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('export function detectUnits');
    expect(await (await get('/assets/app.js')).text()).toContain("from '/assets/units.js'");
  });
  test('patient portal links to the free local health tracker', async () => {
    const source = await (await get('/assets/app.js')).text();
    expect(source).toContain("link('/health/', 'Free tracker')");
    expect(source).toContain('Free health tracker');
    expect(source).toContain('href="/health/">Open tracker');
    expect(source).toContain('Sign in to track readings');
  });
  test('sign out clears the browser session cookie', async () => {
    const res = await app.request('/api/v1/auth/signout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('th_session=;');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  test('api health reports the database', async () => {
    const res = await get('/api/v1/health');
    const body = await res.json();
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(['ok', 'down', 'unconfigured']).toContain(body.database);
    expect(res.status).toBe(body.database === 'ok' ? 200 : 503);
  });
  test('schedule needs sign-in', async () => {
    expect((await get('/api/v1/schedule?date=2026-10-07')).status).toBe(401);
  });
  test('unknown api path is JSON 404', async () => {
    const res = await get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not found');
  });
  test('pwa + installer are served', async () => {
    expect((await get('/manifest.webmanifest')).status).toBe(200);
    const worker = await get('/sw.js');
    expect(worker.status).toBe(200);
    expect(await worker.text()).toContain('tleehealth-v10');
    expect(await (await get('/install.sh')).text()).toContain('@profullstack/tleehealth');
  });
});
