import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ping } from '@tleehealth/db';
import { Hono } from 'hono';
import { api, coinpayWebhook } from './api.js';
import * as auth from './auth.js';
import * as calls from './calls.js';
import * as telnyx from './telnyx.js';

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
  if (c.req.path.startsWith('/api/')) c.header('cache-control', 'no-store');
});

// The landing page is built from the design canvas (design/Main.dc.html).
app.get('/', (c) => c.html(pub('index.html').toString()));
app.get('/healthz', (c) => c.text('ok'));

// The app: one shell for the team, patients and sign-in. It talks only to /api/v1.
const shell = (c) => c.html(pub('app/index.html').toString());
for (const p of ['/app', '/app/*', '/signin', '/portal', '/portal/*']) app.get(p, shell);
app.get('/patient', (c) => c.redirect('/portal', 301));
const asset = (name, type) => (c) =>
  c.body(pub(`app/${name}`), 200, { 'content-type': type, 'cache-control': 'no-cache' });
app.get('/assets/app.js', asset('app.js', 'text/javascript; charset=utf-8'));
app.get('/assets/app.css', asset('app.css', 'text/css; charset=utf-8'));
// The WebAuthn browser helper, served from our own origin rather than a CDN.
const WEBAUTHN_JS = [join(here, '..', 'node_modules'), join(root, 'node_modules')]
  .map((d) => join(d, '@simplewebauthn/browser/dist/bundle/index.umd.min.js'))
  .map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  })
  .find(Boolean);
app.get('/assets/webauthn.js', (c) =>
  WEBAUTHN_JS
    ? c.body(WEBAUTHN_JS, 200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' })
    : c.text('missing', 404),
);

// The emailed sign-in link lands here, sets the session and goes to the app.
app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  const s = token ? await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') }) : null;
  if (!s) return c.redirect('/signin?error=expired', 302);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  return c.redirect('/app', 302);
});

app.post('/webhooks/coinpay', coinpayWebhook);

// Telnyx call events for the AI calls. Signed with ed25519 over the raw body.
app.post('/webhooks/telnyx', async (c) => {
  const raw = await c.req.text();
  const ok = telnyx.verifyWebhook({
    rawBody: raw,
    signature: c.req.header('telnyx-signature-ed25519'),
    timestamp: c.req.header('telnyx-timestamp'),
  });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  // Always 200 once verified: a thrown error here would make Telnyx retry an
  // event we already half-applied. Failures are logged and visible on the call row.
  const result = await calls.handleTelnyxEvent(event).catch((err) => {
    console.error('[telnyx]', event?.data?.event_type, err.message);
    return { error: err.message };
  });
  // Event type and what we did with it; no patient details.
  console.log(`[telnyx] ${event?.data?.event_type} -> ${Object.entries(result ?? {}).map(([k, v]) => `${k}:${typeof v === 'string' ? v.slice(0, 40) : v}`).join(' ')}`);
  return c.json({ ok: true, result });
});

/* --------------------------------------------------------------------- API -- */

app.get('/api/v1', (c) => c.json({ name: 'tleehealth', version: VERSION, docs: 'https://tleehealth.com/llms.txt' }));

// Up means the app AND its database answer; 503 otherwise.
app.get('/api/v1/health', async (c) => {
  const database = await ping();
  const ok = database === 'ok';
  return c.json({ ok, service: 'tleehealth', version: VERSION, database }, ok ? 200 : 503);
});

app.route('/api/v1', api);

app.notFound((c) =>
  c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.text('Not found', 404),
);

/* ------------------------------------------------------------- PWA + misc -- */

app.get('/manifest.webmanifest', (c) =>
  c.body(pub('manifest.webmanifest'), 200, { 'content-type': 'application/manifest+json' }),
);
app.get('/sw.js', (c) => c.body(pub('sw.js'), 200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }));
app.get('/icon.svg', (c) =>
  c.body(pub('icon.svg'), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }),
);
app.get('/favicon.ico', (c) => c.redirect('/icon.svg', 301));
app.get('/install.sh', (c) => c.body(INSTALL_SH, 200, { 'content-type': 'text/x-shellscript' }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /portal\n'));
app.get('/llms.txt', (c) =>
  c.text(`# tleehealth

> Telehealth and practice management: scheduling across offices, prescriptions and
> refills, labs, after-visit summaries and a patient portal. One account can own many
> practices; each has locations, a team and its own bill.

Pricing: $10 per team seat per month, or $199/month for up to 1,000 seats. Patients and leads are free.

## API (https://tleehealth.com/api/v1)
Authenticate with a session cookie or \`Authorization: Bearer th_live_...\` (create a key in the app under Settings).
- GET /health
- GET /me                                   your practices and user type in each
- GET /schedule?date=YYYY-MM-DD&org=<id>    the day's appointments
- GET /orgs/:org/today                      appointments + refills, labs and summaries waiting on a human
- GET|POST /orgs/:org/people?type=team|patient|lead
- GET|POST /orgs/:org/appointments, PATCH /orgs/:org/appointments/:id
- GET /orgs/:org/patients/:id               the chart (audit-logged)
- POST /orgs/:org/patients/:id/medications | labs | refills
- POST /orgs/:org/refills/:id/approve|deny, /orgs/:org/labs/:id/release
- PUT /orgs/:org/appointments/:id/summary, POST /orgs/:org/summaries/:id/sign
- GET /portal                               a patient's own visits, meds, results and summaries
- GET|PUT /orgs/:org/call-settings          AI calls: on/off, hours before/after, calling window, attempts
- POST /orgs/:org/appointments/:id/call     call the patient now ({"kind":"reminder"|"followup"})
- GET /orgs/:org/calls/:id                  outcome, summary and transcript; POST .../resolve when handled

## Tools
- CLI + TUI: npm i -g @profullstack/tleehealth  (or: curl -fsSL https://tleehealth.com/install.sh | sh)
- MCP: npx -y @profullstack/tleehealth-mcp
`),
);
