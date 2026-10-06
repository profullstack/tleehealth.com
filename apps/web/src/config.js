/**
 * Settings, read from the environment on every access. The deploy writes the
 * environment from the vault (tleehealth--prod); nothing here has a secret default.
 */
const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  get siteUrl() {
    return env('SITE_URL', 'http://localhost:3000').replace(/\/$/, '');
  },
  get isProd() {
    return env('NODE_ENV') === 'production';
  },
  session: { cookie: 'th_session', ttlDays: 30 },
  mail: {
    get enabled() {
      return Boolean(process.env.RESEND_API_KEY);
    },
    get resendKey() {
      return env('RESEND_API_KEY');
    },
    get from() {
      return env('MAIL_FROM', 'tleehealth <noreply@tleehealth.com>');
    },
  },
  // Passed WHOLE to the shared payments module: its getters read the environment
  // on every access, which that module depends on.
  coinpay: {
    get enabled() {
      return Boolean(process.env.COINPAY_API_KEY && process.env.COINPAY_BUSINESS_ID);
    },
    get baseUrl() {
      return env('COINPAY_API_URL', 'https://coinpayportal.com').replace(/\/$/, '');
    },
    get apiKey() {
      return env('COINPAY_API_KEY');
    },
    get businessId() {
      return env('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return env('COINPAY_WEBHOOK_SECRET');
    },
    get defaultChain() {
      return env('COINPAY_DEFAULT_CHAIN', 'USDC_POL');
    },
  },
};

/** Seat pricing: $10 per team seat, capped at $199 for up to 1,000 seats. */
export const PRICE = { seatCents: 1000, capCents: 19900, capSeats: 1000 };

export function monthlyCents(seats) {
  const n = Math.max(1, Number(seats) || 0);
  if (n > PRICE.capSeats) return null; // above 1,000 seats is not priced yet
  return Math.min(n * PRICE.seatCents, PRICE.capCents);
}
