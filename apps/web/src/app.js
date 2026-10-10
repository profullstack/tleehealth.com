import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ping } from '@tleehealth/db';
import { footerHtml } from '@profullstack/footer';
import { Hono } from 'hono';
import { api, coinpayWebhook } from './api.js';
import * as auth from './auth.js';
import * as calls from './calls.js';
import * as records from './records.js';
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
// The footer is @profullstack/footer, rendered on the server so the ring's verifier
// sees it and template releases on jsDelivr @latest reach the page within the hour.
const FOOTER = {
  site: 'https://tleehealth.com/',
  links: [
    { label: 'Terms', href: '/terms' },
    { label: 'Privacy', href: '/privacy' },
  ],
  tagline: 'BAA with every practice · every read audit-logged · encrypted at rest',
};
app.get('/', async (c) =>
  c.html(pub('index.html').toString().replace('<!--pfs-footer-->', await footerHtml(FOOTER))),
);
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

// The provider (MyChart or any SMART on FHIR portal) sends the patient back here
// after they sign in there and allow access. The import starts right away.
app.get('/connect/callback', async (c) => {
  const q = c.req.query();
  const r = await records.finish(q).catch((err) => ({ error: err.message, return_to: 'portal' }));
  if (!r.error && r.connection) records.syncInBackground(r.connection.id);
  if (r.return_to === 'cli') {
    const name = String(r.connection?.provider_name ?? 'your provider').replace(/[<>&"]/g, '');
    const msg = r.error
      ? `Could not connect: ${String(r.error).replace(/[<>&"]/g, '')}`
      : `Connected to ${name}. Your records are importing now; you can close this tab and go back to the terminal.`;
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>tleehealth</title>
<body style="font:16px system-ui;background:#0b0f0d;color:#e6efe9;display:grid;place-items:center;min-height:90vh"><p style="max-width:32em">${msg}</p></body>`, r.error ? 400 : 200);
  }
  const to = new URL('/portal/records', 'http://x');
  if (r.error) to.searchParams.set('error', String(r.error).slice(0, 200));
  else to.searchParams.set('connected', r.connection.id);
  return c.redirect(`${to.pathname}${to.search}`, 302);
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
// Our public signing key for JWT client authentication (Epic fetches this).
// Epic wants distinct non-production and production URLs, so the sandbox
// registration points at the second path; both serve the same public key.
const jwksRoute = (c) => {
  const set = records.jwks();
  return set ? c.json(set, 200, { 'cache-control': 'public, max-age=3600' }) : c.json({ keys: [] }, 404);
};
app.get('/.well-known/jwks.json', jwksRoute);
app.get('/.well-known/jwks-sandbox.json', jwksRoute);
app.get('/.well-known/openwebring.json', (c) =>
  c.json({
    openwebring: '0.1',
    site: { url: 'https://tleehealth.com/', name: 'tleehealth' },
    made_by: 'both',
    rings: [{ ring: 'https://rssamplifier.com/ring/profullstack', slug: 'tleehealth-com' }],
  }),
);
app.get('/terms', (c) => c.html(pub('terms.html').toString()));
app.get('/privacy', (c) => c.html(pub('privacy.html').toString()));
app.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /portal\n'));
app.get('/llms.txt', (c) =>
  c.text(`# tleehealth

> Telehealth and practice management: scheduling across offices, prescriptions and
> refills, labs, after-visit summaries and a patient portal. One account can own many
> practices; each has locations, a team and its own bill. Patient advocates run care
> plans and log navigation time, and the superbill turns it into Medicare's
> care-management codes (PIN, CHI, CCM).

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
- GET /records/providers?q=mychart name      providers to connect: every Epic/MyChart organization, plus any SMART on FHIR server by address
- POST /records/connect                     {"provider_id"} or {"fhir_base"}: returns authorize_url; the patient signs in there and allows access
- GET /records                              connections, personal information, counts per category
- GET /records/items?category=&q=&connection=  imported records: visits, after-visit summaries, notes, labs, imaging, meds, conditions, allergies, immunizations, procedures
- GET /records/files/:id                    an attached file (PDF summary, note, image)
- POST /records/connections/:id/sync, DELETE /records/connections/:id (deletes everything imported)
- PUT /records/connections/:id/share        {"org_id","shared"}: show a connection to a practice you are a patient of
- GET /records/export?format=zip|bundle     download everything: readable files + raw FHIR, or one FHIR Bundle
- GET /orgs/:org/patients/:id/records       what that patient shared with the practice (audit-logged)
- GET|PUT /orgs/:org/call-settings          AI calls: on/off, hours before/after, calling window, attempts
- POST /orgs/:org/appointments/:id/call     call the patient now ({"kind":"reminder"|"followup"})
- GET /orgs/:org/calls/:id                  outcome, summary and transcript; POST .../resolve when handled
- GET|PUT /orgs/:org/patients/:id/care-plan, POST .../care-plan/items, PATCH /orgs/:org/care-plan-items/:id
                                            goals and tasks with owners and due dates; shared plans show in the portal
- POST /orgs/:org/patients/:id/programs     enroll in PIN, PIN peer support, CHI or CCM (consent, initiating visit, billing practitioner)
- PATCH /orgs/:org/programs/:id             consent (renews it), billing practitioner, end
- POST /orgs/:org/programs/:id/time         log navigation minutes ({"minutes", "activity", "note", "performed_on"})
- GET /orgs/:org/caseload?month=YYYY-MM     enrollments, minutes toward G0023/G0024, G0019/G0022, 99490/99439, open tasks
- GET /orgs/:org/superbill?month=YYYY-MM&format=csv
                                            the month's billable codes per patient, ready or on hold with the reason

## Tools
- CLI + TUI: npm i -g @profullstack/tleehealth  (or: curl -fsSL https://tleehealth.com/install.sh | sh)
- MCP: npx -y @profullstack/tleehealth-mcp
`),
);
