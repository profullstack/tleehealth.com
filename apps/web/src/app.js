import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ping } from '@tleehealth/db';
import { Hono } from 'hono';
import { demoDay } from './demo.js';

const here = dirname(fileURLToPath(import.meta.url));
const pub = (name) => readFileSync(join(here, '..', 'public', name));
const root = join(here, '..', '..', '..');
const VERSION = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const INSTALL_SH = readFileSync(join(root, 'bin/install.sh'), 'utf8');

export const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
});

// Pages are built from the design canvas (design/*.dc.html) by design/build.py.
const html = (name) => (c) => c.html(pub(name).toString());
app.get('/', html('index.html'));
app.get('/app', html('app.html'));
app.get('/patient', html('patient.html'));
app.get('/healthz', (c) => c.text('ok'));

/* --------------------------------------------------------------------- API -- */
// Everything a browser, the CLI, the TUI and the MCP server do goes through /api/v1.

app.get('/api/v1', (c) =>
  c.json({
    name: 'tleehealth',
    version: VERSION,
    endpoints: ['GET /api/v1/health', 'GET /api/v1/schedule?date=YYYY-MM-DD'],
    docs: 'https://tleehealth.com/llms.txt',
  }),
);

// Up means the app AND its database answer; 503 otherwise so monitors and the
// deploy's verify step see a broken database as a broken site.
app.get('/api/v1/health', async (c) => {
  const database = await ping();
  const ok = database === 'ok';
  return c.json({ ok, service: 'tleehealth', version: VERSION, database }, ok ? 200 : 503);
});

// Front-desk day view. Until accounts and orgs land this serves a clearly marked demo
// day, so the CLI, TUI and MCP can be built against the real response shape.
app.get('/api/v1/schedule', (c) => {
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400);
  return c.json(demoDay(date));
});

app.notFound((c) =>
  c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.text('Not found', 404),
);

/* ------------------------------------------------------------- PWA + misc -- */

app.get('/manifest.webmanifest', (c) =>
  c.body(pub('manifest.webmanifest'), 200, { 'content-type': 'application/manifest+json' }),
);
app.get('/sw.js', (c) =>
  c.body(pub('sw.js'), 200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }),
);
app.get('/icon.svg', (c) =>
  c.body(pub('icon.svg'), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }),
);
app.get('/favicon.ico', (c) => c.redirect('/icon.svg', 301));
app.get('/install.sh', (c) => c.body(INSTALL_SH, 200, { 'content-type': 'text/x-shellscript' }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /\n'));
app.get('/llms.txt', (c) =>
  c.text(`# tleehealth

> Telehealth and practice management: scheduling, prescriptions, labs, after-visit
> summaries, AI follow-up calls (Telnyx) and health-record import from any provider.

Pricing: $10 per team seat per month, or $199/month for up to 1,000 seats. Patients and leads are free.

## API
- GET https://tleehealth.com/api/v1/health
- GET https://tleehealth.com/api/v1/schedule?date=YYYY-MM-DD  (demo data until accounts launch)

## Tools
- CLI + TUI: npm i -g @profullstack/tleehealth  (or: curl -fsSL https://tleehealth.com/install.sh | sh)
- MCP: npx -y @profullstack/tleehealth-mcp
`),
);
