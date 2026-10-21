// Billing checkout: a CoinPay hosted checkout session (any coin or PayPal, never a
// card: Stripe is banned for the owner) filed under who paid and for which site,
// and a CoinPay refusal is a readable 502.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { close, configured } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

describe.skipIf(!configured())('billing checkout', () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  let reply = { status: 201, body: { success: true, id: 'cs_test1', url: 'https://coinpayportal.com/checkout/cs_test1' } };
  let web, auth, cookie, orgId;

  beforeAll(async () => {
    await migrate({ log: () => {} });
    Object.assign(process.env, { COINPAY_API_KEY: 'cp_test_x', COINPAY_BUSINESS_ID: 'biz_test' });
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).startsWith('https://coinpayportal.com/')) {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      }
      return realFetch(url, init);
    };
    const { configurePayments } = await import('../packages/payments/src/index.js');
    const { config } = await import('../apps/web/src/config.js');
    const { db } = await import('../packages/db/src/index.js');
    configurePayments({ sql: db(), coinpay: config.coinpay, siteUrl: config.siteUrl });
    web = (await import('../apps/web/src/app.js')).app;
    auth = await import('../apps/web/src/auth.js');
    const url = new URL(await auth.createLoginLink(`bill${Date.now()}@example.com`));
    cookie = (await web.request(`/auth/magic?t=${url.searchParams.get('t')}`)).headers.get('set-cookie').split(';')[0];
    const res = await web.request('/api/v1/orgs', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Billing Test' }) });
    orgId = (await res.json()).org.id;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.COINPAY_API_KEY;
    delete process.env.COINPAY_BUSINESS_ID;
    await close();
  });

  const checkout = () => web.request(`/api/v1/orgs/${orgId}/billing/checkout`, { method: 'POST', headers: { cookie } });

  test('opens a hosted checkout session filed under the payer, never a card', async () => {
    const res = await checkout();
    expect(res.status).toBe(200);
    expect((await res.json()).checkout_url).toBe('https://coinpayportal.com/checkout/cs_test1');
    const body = sent.at(-1);
    expect(body.amount).toBe(10);
    expect(body.customer_email).toMatch(/^bill\d+@example\.com$/);
    expect(body.account_id).toBeTruthy();
    expect(body.property).toBeTruthy();
    expect(body.metadata.org_id).toBe(orgId);
    expect(body.payment_method).toBeUndefined();
    expect(body.blockchain).toBeUndefined();
  });

  test('a CoinPay refusal is a readable 502, not an internal error', async () => {
    reply = { status: 400, body: { success: false, error: 'nope' } };
    const res = await checkout();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('CoinPay could not start the payment');
  });
});
