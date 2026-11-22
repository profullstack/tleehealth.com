import { db } from '@tleehealth/db';

/**
 * Every call tleehealth makes to c0mpute.com goes through this file.
 *
 * c0mpute is where "Ask AI about my records" runs and is paid for. The patient
 * (or practice user) connects their own c0mpute.com account with OAuth (PKCE,
 * public client, scope "inference"); each question is billed to that account's
 * compute balance. Record excerpts go ONLY to c0mpute's house lane
 * (`x-c0mpute-lane: house`): a Profullstack-operated node, never the open
 * peer-to-peer network, never a free tier. c0mpute answers 503 when the house
 * node is down; we never retry anywhere else.
 */

export const ASK_TIMEOUT_MS = 280_000;
const CALL_TIMEOUT_MS = 15_000;
export const TOP_UP_URL = 'https://c0mpute.com/checkout';

export const base = () => (process.env.C0MPUTE_URL || 'https://c0mpute.com').replace(/\/+$/, '');

export class C0mputeError extends Error {
  /** reason: balance_required | house_lane_unavailable | invalid_token | rate_limited | not_house | upstream */
  constructor(status, reason, message, extra = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    Object.assign(this, extra);
  }
}

async function timed(url, init = {}, ms = CALL_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms), redirect: 'manual' });
  } catch (err) {
    throw new C0mputeError(503, 'upstream', `c0mpute.com did not answer (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
  }
}

/* ------------------------------------------------------------- discovery -- */

let discovered = null; // { base, at, meta }

/** RFC 8414 metadata, cached for an hour per base URL. */
export async function discover() {
  const b = base();
  if (discovered && discovered.base === b && Date.now() - discovered.at < 3600_000) return discovered.meta;
  const res = await timed(`${b}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new C0mputeError(503, 'upstream', `c0mpute sign-in is unavailable (HTTP ${res.status})`);
  const meta = await res.json();
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (typeof meta[k] !== 'string' || !meta[k].startsWith('https://') && !meta[k].startsWith(b))
      throw new C0mputeError(503, 'upstream', `c0mpute sign-in metadata is missing ${k}`);
  }
  discovered = { base: b, at: Date.now(), meta };
  return meta;
}

export function _resetDiscovery() {
  discovered = null;
}

/** Our public client id for this redirect URI: registered once, then read from the database. */
export async function clientIdFor(redirectUri) {
  const sql = db();
  const b = base();
  const [row] = await sql`select client_id from c0mpute_oauth_clients where redirect_uri = ${redirectUri} and base_url = ${b}`;
  if (row) return row.client_id;
  const meta = await discover();
  const res = await timed(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'tleehealth',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.client_id !== 'string') throw new C0mputeError(503, 'upstream', `could not register with c0mpute (HTTP ${res.status})`);
  await sql`insert into c0mpute_oauth_clients (redirect_uri, base_url, client_id) values (${redirectUri}, ${b}, ${body.client_id})
            on conflict (redirect_uri, base_url) do update set client_id = excluded.client_id, created_at = now()`;
  return body.client_id;
}

export async function authorizeUrl({ clientId, redirectUri, state, challenge }) {
  const meta = await discover();
  const u = new URL(meta.authorization_endpoint);
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'inference',
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Code -> c0k_ key. */
export async function exchangeCode({ code, clientId, redirectUri, verifier }) {
  const meta = await discover();
  const res = await timed(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== 'string')
    throw new C0mputeError(400, 'upstream', `c0mpute refused the sign-in: ${String(body.error_description || body.error || `HTTP ${res.status}`).slice(0, 200)}`);
  return { token: body.access_token, scope: body.scope ?? null };
}

/* -------------------------------------------------------------- account -- */

/** { id, name, balance } of the account a key belongs to. */
export async function me(token) {
  const res = await timed(`${base()}/api/v1/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new C0mputeError(401, 'invalid_token', 'c0mpute no longer accepts this connection; reconnect c0mpute');
  if (!res.ok) throw new C0mputeError(503, 'upstream', `c0mpute account lookup failed (HTTP ${res.status})`);
  const b = await res.json();
  if (!b?.id) throw new C0mputeError(503, 'upstream', 'c0mpute did not say which account this is');
  return { id: String(b.id), name: b.name ? String(b.name).slice(0, 120) : null, balance: b.balance ?? null };
}

/** RFC 7009: best effort, never throws. */
export async function revoke(token) {
  try {
    await timed(`${base()}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* the local copy is deleted either way */
  }
}

/* ------------------------------------------------------------------ ask -- */

async function errorFrom(res) {
  const body = await res.json().catch(() => ({}));
  const e = body?.error && typeof body.error === 'object' ? body.error : { message: typeof body?.error === 'string' ? body.error : '' };
  const reason = e.reason ?? e.code ?? null;
  if (res.status === 401 || res.status === 403)
    return new C0mputeError(401, 'invalid_token', 'c0mpute no longer accepts this connection; reconnect c0mpute');
  if (res.status === 402)
    return new C0mputeError(402, 'balance_required', 'Your c0mpute balance is empty. Add funds on c0mpute.com/checkout, then ask again.', {
      top_up: typeof e.top_up === 'string' && e.top_up.startsWith('https://') ? e.top_up : TOP_UP_URL,
    });
  if (res.status === 429) return new C0mputeError(429, 'rate_limited', 'Too many questions right now; try again in a few minutes.');
  if (res.status === 503 || reason === 'house_lane_unavailable')
    return new C0mputeError(503, 'house_lane_unavailable', 'The private AI node is offline right now. Try again later; your records were not sent anywhere else.');
  return new C0mputeError(502, 'upstream', `c0mpute could not answer (HTTP ${res.status}${e.message ? `: ${String(e.message).slice(0, 160)}` : ''})`);
}

/**
 * One question on the house lane. Streams (so no proxy cuts an idle wait) and
 * returns the whole answer: { text, meta }. Throws C0mputeError.
 */
export async function askHouse(token, messages, { maxTokens = 800, signal } = {}) {
  const timeout = AbortSignal.timeout(ASK_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-c0mpute-lane': 'house',
      },
      body: JSON.stringify({ messages, max_tokens: Math.min(1024, maxTokens), temperature: 0.2, stream: true, c0mpute: { lane: 'house' } }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    throw new C0mputeError(504, 'upstream', err?.name === 'TimeoutError' ? 'The private AI node took too long to answer.' : 'c0mpute.com did not answer.');
  }
  if (!res.ok) throw await errorFrom(res);
  // Defense in depth: an answer that did not come from the house lane is refused.
  if ((res.headers.get('x-c0mpute-lane') ?? '').toLowerCase() !== 'house') {
    await res.body?.cancel().catch(() => {});
    throw new C0mputeError(502, 'not_house', 'c0mpute did not confirm the private house lane; the answer was refused.');
  }
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    // A non-streamed answer is accepted too.
    const b = await res.json();
    return { text: b?.choices?.[0]?.message?.content ?? '', meta: b?.x_c0mpute ?? null, model: b?.model ?? null };
  }
  let text = '';
  let meta = null;
  let model = null;
  let buf = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw new C0mputeError(504, 'upstream', err?.name === 'TimeoutError' ? 'The private AI node took too long to answer.' : 'The answer was cut off.');
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue; // ": keepalive", ": status", blank
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { text, meta, model };
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new C0mputeError(502, 'upstream', `The private AI node failed: ${String(j.error.message ?? 'engine error').slice(0, 160)}`);
        if (j.x_c0mpute) meta = j.x_c0mpute;
        if (j.model) model = j.model;
        const d = j.choices?.[0]?.delta?.content;
        if (typeof d === 'string') text += d;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text, meta, model };
}
