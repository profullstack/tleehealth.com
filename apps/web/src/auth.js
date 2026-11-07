import { createHash, randomBytes } from 'node:crypto';
import { db, orgs } from '@tleehealth/db';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';

/**
 * Magic link + passkey. No passwords. Ported from bg0ne's auth package.
 *
 * The emailed link proves the address, and the address is the account. It is
 * also how someone a practice added (team member or patient) gets in: their
 * org_people row carries their email, and the first sign-in links it.
 */

const TOKEN_TTL_MINUTES = 20;
const sha = (t) => createHash('sha256').update(t).digest();

export const rpName = 'tleehealth';
// rpID comes from SITE_URL, not the request: a passkey made on one hostname does
// not exist on another, and the failure has no visible error.
export const rpID = () => new URL(config.siteUrl).hostname;
export const expectedOrigins = () => {
  const site = new URL(config.siteUrl);
  const host = site.hostname.replace(/^www\./, '');
  return [`${site.protocol}//${host}`, `${site.protocol}//www.${host}`];
};

/* -------------------------------------------------------------- magic link -- */

/**
 * `profile` is the validated signup form (@profullstack/profile fields), held on
 * the token because the account row does not exist until the link is spent.
 * Bound as text and cast, so the driver never JSON-encodes the string a second time.
 */
export async function createLoginLink(email, { profile = null, invite = null, next = null } = {}) {
  const token = randomBytes(32).toString('base64url');
  await db()`
    insert into login_tokens (token_hash, email, expires_at, profile, invite)
    values (${sha(token)}, ${email.trim().toLowerCase()}, ${new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000)},
            ${profile ? JSON.stringify(profile) : null}::text::jsonb, ${invite})`;
  const afterSignIn = next === '/health/' ? '&next=%2Fhealth%2F' : '';
  return `${config.siteUrl}/auth/magic?t=${token}${afterSignIn}`;
}

/**
 * Spend a link. An address nobody has used before gets an account; `created`
 * says so, and `invite` is the invite the signup carried (accepted only then).
 */
export async function consumeLoginLink(token, { userAgent } = {}) {
  const [row] = await db()`
    update login_tokens set used_at = now()
    where token_hash = ${sha(token)} and used_at is null and expires_at > now()
    returning email, invite`;
  if (!row) return null;
  const profile = await takeSignupProfile(sha(token));
  const { created, ...user } = await findOrCreateUser(row.email);
  return { user, created: Boolean(created), invite: row.invite ?? null, sessionId: await startSession(user.id, userAgent), profile };
}

/**
 * The signup fields a just-spent link carried, handed out once and then cleared.
 * RETURNING sees the row after the update, so the old value comes from a subquery.
 */
async function takeSignupProfile(tokenHash) {
  const [row] = await db()`
    update login_tokens t set profile = null
    from (
      select token_hash, profile from login_tokens
      where token_hash = ${tokenHash} and used_at is not null and profile is not null
      for update
    ) old
    where t.token_hash = old.token_hash
    returning old.profile`;
  if (!row) return null;
  return typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile;
}

export async function findOrCreateUser(email) {
  const sql = db();
  const e = email.trim().toLowerCase();
  const [user] = await sql`
    insert into users (email) values (${e})
    on conflict (lower(email)) do update set email = users.email
    returning *, (xmax = 0) as created`;
  await linkPeople(user);
  return user;
}

const ORG_ROLE = { owner: 'owner', org_manager: 'admin', provider: 'member', staff: 'member', advocate: 'member' };

/**
 * Attach every org_people row added under this address to the account, and give
 * team members their @profullstack/orgs membership. Runs on each sign-in, so
 * someone added after their account existed is linked next time they sign in too.
 */
export async function linkPeople(user) {
  const sql = db();
  const rows = await sql`
    update org_people set user_id = ${user.id}
    where lower(email) = ${user.email.toLowerCase()} and user_id is null
      and not exists (select 1 from org_people p2 where p2.org_id = org_people.org_id and p2.user_id = ${user.id})
    returning org_id, user_type`;
  for (const r of rows)
    if (ORG_ROLE[r.user_type]) await orgs.addMember(sql, { orgId: r.org_id, userId: user.id, role: ORG_ROLE[r.user_type] });
}

/* ---------------------------------------------------------------- sessions -- */

async function startSession(userId, userAgent) {
  const id = randomBytes(32).toString('base64url');
  await db()`
    insert into sessions (id, user_id, user_agent, expires_at)
    values (${id}, ${userId}, ${userAgent ?? null}, ${new Date(Date.now() + config.session.ttlDays * 86400_000)})`;
  return id;
}

/** Start CoinPay OAuth with server-held PKCE material and one-use state. */
export async function createCoinPayOAuthState(userId = null, next = null) {
  const nonce = randomBytes(32).toString('base64url');
  const state = next === '/health/' ? `${nonce}.health` : nonce;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const sql = db();
  await sql`delete from coinpay_oauth_states where expires_at <= now()`;
  await sql`
    insert into coinpay_oauth_states (state_hash, code_verifier, user_id, expires_at)
    values (${sha(state)}, ${verifier}, ${userId}, ${new Date(Date.now() + 10 * 60_000)})`;
  return { state, challenge };
}

/** Consume the state before any token exchange so callbacks cannot be replayed. */
export async function takeCoinPayOAuthState(state) {
  if (!state || state.length > 200) return null;
  const [row] = await db()`
    delete from coinpay_oauth_states
    where state_hash = ${sha(state)} and expires_at > now()
    returning code_verifier, user_id`;
  return row ? { codeVerifier: row.code_verifier, userId: row.user_id ?? null, next: state.endsWith('.health') ? '/health/' : null } : null;
}

/**
 * Profullstack Pass (https://coinpayportal.com/pass) from a CoinPay userinfo
 * body: `pass: { active, expires_at }`. Active only when `active === true` AND
 * `expires_at` parses to a date still in the future; anything else is no pass.
 */
export function passFromUserinfo(identity, now = new Date()) {
  const pass = identity && typeof identity === 'object' ? identity.pass : null;
  if (!pass || typeof pass !== 'object') return { active: false, expiresAt: null };
  const d = typeof pass.expires_at === 'string' && pass.expires_at.trim() ? new Date(pass.expires_at) : null;
  const expiresAt = d && Number.isFinite(d.getTime()) ? d : null;
  return { active: pass.active === true && expiresAt !== null && expiresAt.getTime() > now.getTime(), expiresAt };
}

/** Exchange the authorization code, then ask CoinPay's userinfo endpoint for its stable subject. */
export async function coinPaySubjectFromCode(code, codeVerifier) {
  return (await coinPayIdentityFromCode(code, codeVerifier)).subject;
}

/** The same exchange, returning the subject and the Profullstack Pass claim. */
export async function coinPayIdentityFromCode(code, codeVerifier) {
  if (!config.coinpayOAuth.enabled || !code || code.length > 4096) throw new Error('CoinPay sign-in unavailable');
  const tokenResponse = await fetch(config.coinpayOAuth.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.coinpayOAuth.clientId,
      redirect_uri: config.coinpayOAuth.redirectUri,
      code_verifier: codeVerifier,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || typeof tokens?.access_token !== 'string' || !tokens.access_token)
    throw new Error('CoinPay sign-in failed');

  const userResponse = await fetch(config.coinpayOAuth.userInfoUrl, {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const identity = await userResponse.json().catch(() => null);
  if (!userResponse.ok || typeof identity?.sub !== 'string' || !identity.sub || identity.sub.length > 500)
    throw new Error('CoinPay identity could not be verified');
  // CoinPay explicitly marks email unverified; identity matching uses sub only.
  return { subject: identity.sub, pass: passFromUserinfo(identity) };
}

/** Link by provider subject only. The caller must already have an active session. */
export async function linkCoinPayIdentity(userId, subject) {
  const sql = db();
  const [inserted] = await sql`
    insert into coinpay_identities (subject, user_id) values (${subject}, ${userId})
    on conflict do nothing returning user_id`;
  if (inserted) return 'linked';
  const [bySubject] = await sql`select user_id from coinpay_identities where subject = ${subject}`;
  if (bySubject) return bySubject.user_id === userId ? 'linked' : 'already_used';
  const [byUser] = await sql`select subject from coinpay_identities where user_id = ${userId}`;
  return byUser ? 'account_has_other_identity' : 'failed';
}

export async function coinPayIdentityLinked(userId) {
  const [row] = await db()`select exists(select 1 from coinpay_identities where user_id = ${userId}) as linked`;
  return Boolean(row?.linked);
}

export async function unlinkCoinPayIdentity(userId) {
  await db()`delete from coinpay_identities where user_id = ${userId}`;
}

/** Resolve a linked identity and create a regular tleehealth session. */
export async function signInWithCoinPay(subject, userAgent) {
  const [user] = await db()`
    select u.* from coinpay_identities i join users u on u.id = i.user_id
    where i.subject = ${subject}`;
  if (!user) return null;
  await linkPeople(user);
  return { user, sessionId: await startSession(user.id, userAgent) };
}

export async function userFromSession(sessionId) {
  if (!sessionId) return null;
  const [u] = await db()`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.expires_at > now()`;
  return u ?? null;
}

export async function endSession(sessionId) {
  if (sessionId) await db()`delete from sessions where id = ${sessionId}`;
}

export function sessionCookie(sessionId, { clear = false } = {}) {
  const parts = [
    `${config.session.cookie}=${clear ? '' : sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${config.session.ttlDays * 86400}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

/* ---------------------------------------------------------------- passkeys -- */

async function saveChallenge(challenge, userId = null) {
  const id = randomBytes(18).toString('base64url');
  await db()`
    insert into webauthn_challenges (id, challenge, user_id, expires_at)
    values (${id}, ${challenge}, ${userId}, ${new Date(Date.now() + 5 * 60_000)})`;
  return id;
}

async function takeChallenge(id) {
  if (!id) return null;
  const [row] = await db()`
    delete from webauthn_challenges where id = ${id} and expires_at > now() returning challenge, user_id`;
  return row ?? null;
}

export async function passkeyRegistrationOptions(user) {
  const existing = await db()`select credential_id, transports from passkeys where user_id = ${user.id}`;
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpID(),
    userName: user.email,
    userID: Buffer.from(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  return { options, challengeId: await saveChallenge(options.challenge, user.id) };
}

export async function verifyPasskeyRegistration({ user, response, challengeId }) {
  const ch = await takeChallenge(challengeId);
  if (!ch || ch.user_id !== user.id) return false;
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
  });
  if (!v.verified || !v.registrationInfo) return false;
  const { credential } = v.registrationInfo;
  await db()`
    insert into passkeys (credential_id, user_id, public_key, counter, transports)
    values (${credential.id}, ${user.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
            ${response.response?.transports ?? []})
    on conflict (credential_id) do nothing`;
  return true;
}

export async function passkeyAuthenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rpID(), userVerification: 'preferred' });
  return { options, challengeId: await saveChallenge(options.challenge) };
}

export async function verifyPasskeyAuthentication({ response, challengeId, userAgent }) {
  const ch = await takeChallenge(challengeId);
  if (!ch) return null;
  const [stored] = await db()`select * from passkeys where credential_id = ${response?.id ?? ''}`;
  if (!stored) return null;
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
  if (!v.verified) return null;
  await db()`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now()
             where credential_id = ${stored.credential_id}`;
  const [user] = await db()`select * from users where id = ${stored.user_id}`;
  await linkPeople(user);
  return { user, sessionId: await startSession(user.id, userAgent) };
}

/* ---------------------------------------------------------------- api keys -- */

const API_PREFIX = 'th_live_';

export async function createApiKey({ userId, name = 'default' }) {
  const plaintext = `${API_PREFIX}${randomBytes(24).toString('base64url')}`;
  const [row] = await db()`
    insert into api_keys (user_id, name, key_hash, prefix)
    values (${userId}, ${name}, ${sha(plaintext)}, ${plaintext.slice(0, API_PREFIX.length + 6)})
    returning id, name, prefix, created_at`;
  return { ...row, key: plaintext };
}

export async function userFromApiKey(header) {
  const token = String(header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith(API_PREFIX)) return null;
  const [u] = await db()`
    update api_keys k set last_used_at = now() from users u
    where k.key_hash = ${sha(token)} and k.revoked_at is null and u.id = k.user_id
    returning u.*`;
  return u ?? null;
}
