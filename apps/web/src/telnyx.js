import { createPublicKey, verify as verifySignature } from 'node:crypto';

/**
 * Telnyx Call Control v2, the few commands the AI calls need. Plain fetch.
 *
 * Settings come from the environment (vault tleehealth--prod):
 *   TELNYX_API_KEY        account key (Bearer)
 *   TELNYX_CONNECTION_ID  the "tleehealth" Call Control application
 *   TELNYX_FROM_NUMBER    the caller ID, a number on that application
 *   TELNYX_PUBLIC_KEY     webhook signing key (Portal > Keys & Credentials > Public Key)
 *   TELNYX_VOICE          optional TTS voice for the agent
 */

const API = 'https://api.telnyx.com/v2';
const env = (k) => process.env[k] ?? '';

export const enabled = () =>
  Boolean(env('TELNYX_API_KEY') && env('TELNYX_CONNECTION_ID') && env('TELNYX_FROM_NUMBER'));

// A Telnyx-hosted voice and model keep the conversation under Telnyx's BAA.
export const voice = () => env('TELNYX_VOICE') || 'Telnyx.KokoroTTS.af';

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('TELNYX_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`telnyx ${path.split('/actions/')[1] ?? path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export function readClientState(s) {
  if (!s) return {};
  try {
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** Place the call. Returns the call_control_id that every later webhook carries. */
export async function dial({ to, clientState }) {
  const { data } = await post('/calls', {
    connection_id: env('TELNYX_CONNECTION_ID'),
    to,
    from: env('TELNYX_FROM_NUMBER'),
    client_state: b64(clientState),
    timeout_secs: 30,
    time_limit_secs: 600,
    // Know whether a person or a voicemail answered before the agent starts talking.
    answering_machine_detection: 'premium',
    answering_machine_detection_config: { total_analysis_time_millis: 5000 },
  });
  return data.call_control_id;
}

/** Run the conversation: the model talks until it has filled `parameters`. */
export function gatherUsingAi(callControlId, { greeting, instructions, parameters, clientState }) {
  return post(`/calls/${callControlId}/actions/gather_using_ai`, {
    greeting,
    parameters,
    assistant: { instructions },
    voice: voice(),
    language: 'en',
    send_message_history_updates: false,
    user_response_timeout_ms: 15_000,
    client_state: b64(clientState),
  });
}

export function speak(callControlId, text, clientState) {
  return post(`/calls/${callControlId}/actions/speak`, {
    payload: text,
    voice: voice(),
    client_state: clientState ? b64(clientState) : undefined,
  });
}

export function hangup(callControlId) {
  return post(`/calls/${callControlId}/actions/hangup`, {}).catch(() => {});
}

/* --------------------------------------------------------------- webhooks -- */

function publicKey(value) {
  const v = value.trim();
  if (v.startsWith('-----BEGIN')) return createPublicKey(v);
  const raw = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  return createPublicKey(
    raw.length === 32
      ? { key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' }
      : { key: raw, format: 'der', type: 'spki' },
  );
}

/**
 * Telnyx signs `${timestamp}|${rawBody}` with ed25519. Checked over the RAW body:
 * re-serialised JSON does not match. Five minutes of clock skew allowed.
 */
export function verifyWebhook({ rawBody, signature, timestamp, toleranceSeconds = 300 }) {
  const key = env('TELNYX_PUBLIC_KEY');
  if (!key || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  try {
    return verifySignature(null, Buffer.from(`${timestamp}|${rawBody}`), publicKey(key), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
