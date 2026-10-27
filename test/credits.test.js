// Credit codes + invites end to end through the app against a real Postgres.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configured, close, db } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

const { app } = configured() ? await import('../apps/web/src/app.js') : { app: null };
const auth = configured() ? await import('../apps/web/src/auth.js') : null;
const credits = configured() ? await import('../apps/web/src/credits.js') : null;

async function magic(email, opts) {
  const url = new URL(await auth.createLoginLink(email, opts));
  return app.request(`/auth/magic?t=${url.searchParams.get('t')}`);
}
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

function client(cookie) {
  const call = async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}

describe.skipIf(!configured())('credit codes + invites', () => {
  const tag = Date.now();
  let owner, orgId;

  beforeAll(async () => {
    await migrate({ log: () => {} });
    await credits.warm();
    owner = client(cookieOf(await magic(`credowner${tag}@example.com`)));
    orgId = (await owner.post('/orgs', { name: `Credit Practice ${tag}` })).body.org.id;
  });
  afterAll(() => close());

  test('a code redeemed for a practice extends paid_through past the trial', async () => {
    const { code } = await credits.getCredits().mint({ grant: { unit: credits.UNIT, amount: 30 } });
    const r = await owner.post('/credits/redeem', { code, org_id: orgId });
    expect(r.status).toBe(200);
    expect(r.body.applied.ok).toBe(true);
    const days = (new Date(r.body.applied.paid_through) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(43.9); // 14 trial + 30
    expect(days).toBeLessThan(44.1);
    expect((await owner.get(`/orgs/${orgId}/billing`)).body.billing.paid_through).toBeTruthy();

    const again = await owner.post('/credits/redeem', { code });
    expect(again.status).toBe(400);
    expect(again.body.reason).toBe('already_redeemed');
  });

  test('a bad practice never burns the code', async () => {
    const { code } = await credits.getCredits().mint({ grant: { unit: credits.UNIT, amount: 5 } });
    const other = client(cookieOf(await magic(`credother${tag}@example.com`)));
    const r = await other.post('/credits/redeem', { code, org_id: orgId });
    expect(r.status).toBe(404);
    expect((await owner.post('/credits/redeem', { code })).body.balance).toBe(5);
    const apply = await owner.post(`/orgs/${orgId}/billing/apply-credits`, { days: 6 });
    expect(apply.status).toBe(400);
    expect((await owner.post(`/orgs/${orgId}/billing/apply-credits`, { days: 5 })).body.ok).toBe(true);
    expect((await owner.get('/credits')).body.balance).toBe(0);
  });

  test('an invite on the signup link is accepted when that link creates the account', async () => {
    const inv = await owner.post('/invites', { note: 'friend' });
    expect(inv.status).toBe(201);
    expect(inv.body.invite.url).toContain(`/i/${inv.body.invite.code}`);
    const res = await magic(`credfriend${tag}@example.com`, { invite: inv.body.invite.code });
    expect(res.headers.get('location')).toBe('/app/invites?joined=1');
    const friend = client(cookieOf(res));
    expect((await friend.get('/credits')).body.balance).toBe(credits.INVITE_BONUS_DAYS);
    expect((await owner.get('/credits')).body.balance).toBe(credits.INVITE_BONUS_DAYS);
    // signing in again later with another invite does nothing
    const inv2 = await owner.post('/invites', {});
    const again = await magic(`credfriend${tag}@example.com`, { invite: inv2.body.invite.code });
    expect(again.headers.get('location')).toBe('/app');
  });

  test('concurrent double-accept: one wins, the other is already_invited and stays unused', async () => {
    const a = client(cookieOf(await magic(`credinvA${tag}@example.com`)));
    const b = client(cookieOf(await magic(`credinvB${tag}@example.com`)));
    const newbie = client(cookieOf(await magic(`crednew${tag}@example.com`)));
    const ca = (await a.post('/invites', {})).body.invite.code;
    const cb = (await b.post('/invites', {})).body.invite.code;
    const rs = await Promise.all([newbie.post('/invites/accept', { code: ca }), newbie.post('/invites/accept', { code: cb })]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const lost = rs.find((r) => r.status !== 200);
    expect(lost.body.reason).toBe('already_invited');
    expect((await newbie.get('/credits')).body.balance).toBe(credits.INVITE_BONUS_DAYS);
    const loser = rs[0].status === 200 ? b : a;
    expect((await loser.get('/invites')).body.invites[0].usedBy).toBeNull();
    expect((await loser.get('/credits')).body.balance).toBe(0);
  });

  test('gates: throwaway domains, mailbox aliases, self, old accounts', async () => {
    const inviter = client(cookieOf(await magic(`credgate${tag}@example.com`)));
    const code = (await inviter.post('/invites', {})).body.invite.code;
    const throw_ = client(cookieOf(await magic(`x${tag}@mailinator.com`)));
    expect((await throw_.post('/invites/accept', { code })).body.reason).toBe('throwaway_email');
    expect((await inviter.post('/invites/accept', { code })).body.reason).toBe('self');
    const alias = client(cookieOf(await magic(`credgate${tag}+2@example.com`)));
    expect((await alias.post('/invites/accept', { code })).body.reason).toBe('duplicate_account');
    const old = client(cookieOf(await magic(`credold${tag}@example.com`)));
    await db()`update users set created_at = now() - interval '8 days' where email = ${`credold${tag}@example.com`}`;
    expect((await old.post('/invites/accept', { code })).body.reason).toBe('account_too_old');
    expect((await inviter.get('/invites')).body.invites[0].usedBy).toBeNull();
  });

  test('/i/<code> keeps the invite and links to signup', async () => {
    const res = await app.request('/i/INV-ABCD-EFGH-JKMN');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('th_invite=INV-ABCD-EFGH-JKMN');
    expect(await res.text()).toContain('/signup?invite=INV-ABCD-EFGH-JKMN');
    expect((await app.request('/invites')).headers.get('location')).toBe('/app/invites');
  });

  test('/auth/link stores the cookie invite on the emailed link', async () => {
    const email = `credlink${tag}@example.com`;
    await app.request('/api/v1/auth/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'th_invite=INV-ZZZZ-ZZZZ-ZZZZ' },
      body: JSON.stringify({ email }),
    });
    const [row] = await db()`select invite from login_tokens where email = ${email}`;
    expect(row.invite).toBe('INV-ZZZZ-ZZZZ-ZZZZ');
  });

  test('mailboxKey folds +tags and Gmail dots', () => {
    expect(credits.mailboxKey('J.Doe+x@GoogleMail.com')).toBe('jdoe@gmail.com');
  });
});
