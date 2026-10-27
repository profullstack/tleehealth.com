/**
 * The crawl door: AI training crawlers, headless browsers and SEO scrapers buy a
 * day pass ($1 a day over x402, or any coin / PayPal through CoinPay's hosted
 * checkout) on /crawl, and get a 402 everywhere else. People, verified search
 * crawlers, AI chat/search fetchers and signed-in users are never charged, and
 * the API, webhooks and health check are never metered. Built only with a scoped
 * key and a payee, so a local or self-hosted server never sells.
 */
import { createGateway } from '@profullstack/x402-gateway';

export function createCrawlGate(env = process.env) {
  const apiKey = env.COINPAY_X402_KEY || '';
  const payTo = env.CRAWL_PAY_TO || '';
  if (!apiKey || !payTo) return null;
  const site = env.SITE_URL && !/localhost|127\.0\.0\.1/.test(env.SITE_URL) ? env.SITE_URL : 'https://tleehealth.com';
  return createGateway({
    siteUrl: site.replace(/\/+$/, ''),
    siteName: 'tleehealth',
    coinpay: { apiKey },
    payTo,
    contact: 'mailto:anthony@profullstack.com',
    openPaths: ['/healthz', '/install.sh', '/llms.txt', '/api/', '/webhooks/', '/i/'],
    exempt: (request) => /(?:^|;\s*)th_session=/.test(request.headers.get('cookie') ?? ''),
  });
}
