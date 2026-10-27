import { db } from '@tleehealth/db';
import { Credits, postgresStore as creditStore } from '@profullstack/redeem-credits';
import { Affiliates, postgresStore as affStore } from '@profullstack/affiliates';

/**
 * Credit codes (@profullstack/redeem-credits) and invites (@profullstack/affiliates).
 *
 * What both grant is `pro_days`: days of a practice's paid plan. They land in the
 * user's balance (the redeem-credits ledger) and an owner or org manager applies
 * them to a practice, which moves org_billing.paid_through forward, the same
 * column a CoinPay payment extends. No health data is read or written here.
 */

export const UNIT = 'pro_days';
export const INVITE_QUOTA = 3;
export const INVITE_BONUS_DAYS = 7;
export const INVITER_MONTHLY_CAP = 3;
export const INVITEE_MAX_AGE_DAYS = 7;
const TRIAL_DAYS = 14;
const DAY_MS = 86400_000;

/** node-postgres shaped adapter over the app's porsager client. */
const pool = () => ({
  query: async (text, params) => ({ rows: params?.length ? await db().unsafe(text, params) : await db().unsafe(text) }),
});

let credits = null;
let affiliates = null;
export const getCredits = () => (credits ??= new Credits(creditStore(pool())));
export const getAffiliates = () => (affiliates ??= new Affiliates(affStore(pool()), { defaultQuota: INVITE_QUOTA }));

/** Create the module tables at boot, not on a first request. */
export async function warm() {
  await getCredits().list();
  await getAffiliates().quota('00000000-0000-0000-0000-000000000000');
}

export const REDEEM_MESSAGES = {
  invalid: 'that code is not valid',
  expired: 'that code has expired',
  used_up: 'that code has already been used',
  already_redeemed: 'you already redeemed that code',
  revoked: 'that code was revoked',
};

/**
 * Move `days` from the user's balance onto a practice's paid period. The caller
 * has checked the user is its owner or org manager. The spend is compare-and-swap
 * safe; if the period write fails the days go back.
 */
export async function applyDays(userId, orgId, days) {
  if (!Number.isInteger(days) || days < 1 || days > 36500) return { ok: false, error: 'pick a whole number of days' };
  const c = getCredits();
  const spent = await c.spend(userId, UNIT, days, `org:${orgId}`);
  if (!spent.ok) return { ok: false, error: `you have ${spent.balance} day${spent.balance === 1 ? '' : 's'} to apply`, balance: spent.balance };
  try {
    // A practice still in its free trial keeps the trial: paid time starts when it ends.
    const [b] = await db()`
      insert into org_billing (org_id, paid_through)
      select o.id, greatest(now(), o.created_at + make_interval(days => ${TRIAL_DAYS})) + make_interval(days => ${days})
      from organizations o where o.id = ${orgId}
      on conflict (org_id) do update set paid_through =
        greatest(coalesce(org_billing.paid_through, now()), now(),
                 (select created_at from organizations where id = ${orgId}) + make_interval(days => ${TRIAL_DAYS}))
        + make_interval(days => ${days})
      returning paid_through`;
    if (!b) throw new Error('no such practice');
    return { ok: true, days, paid_through: b.paid_through, balance: spent.balance };
  } catch (err) {
    await c.grant(userId, { unit: UNIT, amount: days }, `refund:org:${orgId}`);
    throw err;
  }
}

/* ----------------------------------------------------------------- invites -- */

let disposable = null;
async function throwaway(email) {
  disposable ??= new Set((await import('disposable-email-domains')).default);
  const domain = String(email).toLowerCase().split('@')[1] ?? '';
  if (!domain) return true;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (disposable.has(parts.slice(i).join('.'))) return true;
  return false;
}

/** Same mailbox: no +tags, no dots on Gmail, googlemail = gmail. */
export function mailboxKey(email) {
  let [local = '', domain = ''] = String(email).trim().toLowerCase().split('@');
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export const ACCEPT_MESSAGES = {
  not_found: 'sign in first',
  account_too_old: `invites are for new accounts (first ${INVITEE_MAX_AGE_DAYS} days)`,
  throwaway_email: 'invites are not open to throwaway email addresses',
  duplicate_account: 'another tleehealth account already uses that mailbox',
  invalid: 'that invite code is not valid',
  expired: 'that invite has expired',
  used: 'that invite has already been used',
  self: 'you cannot accept your own invite',
  revoked: 'that invite was revoked',
  already_invited: 'your account has already accepted an invite',
};

/** Gates on the invitee. Every account here is email-verified: the emailed link made it. */
async function gate(userId, now) {
  const [u] = await db()`select id, email, created_at from users where id = ${userId}`;
  if (!u) return 'not_found';
  if (now - new Date(u.created_at).getTime() > INVITEE_MAX_AGE_DAYS * DAY_MS) return 'account_too_old';
  if (await throwaway(u.email)) return 'throwaway_email';
  const key = mailboxKey(u.email);
  const [local, domain] = key.split('@');
  // Candidates on the same domain (googlemail folded into gmail), compared in JS.
  const others = await db()`
    select email from users where id <> ${userId}
      and lower(split_part(email, '@', 2)) in (${domain}, ${domain === 'gmail.com' ? 'googlemail.com' : domain})`;
  if (others.some((o) => mailboxKey(o.email) === `${local}@${domain}`)) return 'duplicate_account';
  return null;
}

/**
 * Accept an invite for a new account and pay both sides INVITE_BONUS_DAYS.
 * redeemInvite() is the one atomic gate (one invite per account; a second is
 * refused `already_invited` and left unused); invitedBy() is never pre-checked.
 */
export async function acceptInvite(userId, code, now = Date.now()) {
  const g = await gate(userId, now);
  if (g) return { ok: false, reason: g };
  const r = await getAffiliates().redeemInvite(code, userId);
  if (!r.ok) return { ok: false, reason: r.reason };

  const monthStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1));
  const [{ n }] = await db()`
    select count(*)::int as n from invite_bonuses
    where inviter_id = ${r.inviterId} and inviter_paid and created_at >= ${monthStart}`;
  const inviterPaid = n < INVITER_MONTHLY_CAP;
  const [row] = await db()`
    insert into invite_bonuses (invitee_id, inviter_id, invite_id, days, inviter_paid)
    values (${userId}, ${r.inviterId}, ${r.inviteId}, ${INVITE_BONUS_DAYS}, ${inviterPaid})
    on conflict (invitee_id) do nothing returning invitee_id`;
  if (!row) return { ok: true, inviterId: r.inviterId, inviteeDays: 0, inviterDays: 0 };
  const grant = { unit: UNIT, amount: INVITE_BONUS_DAYS };
  await getCredits().grant(userId, grant, `invite:${r.inviteId}:invitee`);
  if (inviterPaid) await getCredits().grant(r.inviterId, grant, `invite:${r.inviteId}:inviter`);
  return { ok: true, inviterId: r.inviterId, inviteeDays: INVITE_BONUS_DAYS, inviterDays: inviterPaid ? INVITE_BONUS_DAYS : 0 };
}

/** Invite codes are INV-XXXX-XXXX-XXXX; keep only what could be one. */
export const cleanInvite = (v) => {
  const s = String(v ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  return s.length >= 12 ? s : null;
};
export const INVITE_COOKIE = 'th_invite';
