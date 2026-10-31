// The shared @profullstack/profile fields on signup, against a real Postgres
// (DATABASE_URL; CI provides one): asked for in signup mode only, carried on the
// magic-link token (the account does not exist until the link is spent), and saved
// into user_profiles on verify.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { close, configured, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';
import { app } from '../apps/web/src/app.js';

const auth = configured() ? await import('../apps/web/src/auth.js') : null;

const link = (body) =>
  app.request('/api/v1/auth/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the signup page shell carries the profile fields, once each', async () => {
  const html = await (await app.request('/signup')).text();
  for (const name of ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url'])
    expect(html.match(new RegExp(`name="${name}"`, 'g'))?.length).toBe(1);
  // The shared footer has its own email field; the profile template does not.
  const fields = html.match(/<template id="profile-fields">[\s\S]*?<\/template>/)?.[0] ?? '';
  expect(fields).not.toContain('name="email"');
  expect((await app.request('/assets/profile.js')).headers.get('content-type')).toContain('javascript');
});

describe.skipIf(!configured())('signup profile', () => {
  const tag = Date.now();

  beforeAll(() => migrate({ log: () => {} }));
  afterAll(() => close());

  test('a signup without a last name is refused before any link exists', async () => {
    const email = `nolast${tag}@acme.com`;
    const res = await link({ mode: 'signup', email, first_name: 'Ada' });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).errors)).toContain('last_name');
    const [{ n }] = await db()`select count(*)::int as n from login_tokens where email = ${email}`;
    expect(n).toBe(0);
  });

  test('plain sign-in is never asked for the fields', async () => {
    const email = `plain${tag}@acme.com`;
    expect((await link({ email })).status).toBe(200);
    const [row] = await db()`select profile from login_tokens where email = ${email}`;
    expect(row.profile).toBeNull();
  });

  test('signup fields ride the token and are saved when the link is spent', async () => {
    const email = `ada${tag}@acme.com`;
    const res = await link({
      mode: 'signup',
      email: email.replace('ada', 'Ada'),
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'https://www.acme.com/about',
      job_title: 'VP Engineering',
      linkedin_url: 'in/ada-lovelace',
    });
    expect(res.status).toBe(200);
    const [token] = await db()`select profile from login_tokens where email = ${email}`;
    expect(token.profile).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });

    // The route's link went to the mailer; mint one the same way to spend it here.
    const url = new URL(await auth.createLoginLink(email, { profile: token.profile }));
    const spent = await app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
    expect(spent.status).toBe(302);
    const cookie = spent.headers.get('set-cookie').split(';')[0];

    const me = await app.request('/api/v1/me/profile', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).profile).toMatchObject({
      email,
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'acme.com',
      job_title: 'VP Engineering',
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace',
    });
    // Handed out once: the spent token no longer holds the fields.
    const [{ n }] = await db()`select count(*)::int as n from login_tokens
                               where email = ${email} and used_at is not null and profile is not null`;
    expect(n).toBe(0);
  });

  test('the profile API answers 401 without a session', async () => {
    const res = await app.request('/api/v1/me/profile');
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty('error');
  });
});
