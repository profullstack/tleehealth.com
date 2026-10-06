/**
 * The tleehealth API, as function calls. Shared by the CLI, the TUI and the MCP
 * server. Plain fetch, no dependencies: runs on Node 20+ or Bun.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CONFIG_FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'tleehealth',
  'config.json',
);

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

/** Server and key: flags and environment first, then the saved config. */
export async function resolveAuth({ server, key } = {}) {
  const saved = await loadConfig();
  return {
    server: (server || process.env.TLEEHEALTH_URL || saved.server || 'https://tleehealth.com').replace(/\/+$/, ''),
    key: key || process.env.TLEEHEALTH_API_KEY || saved.key || '',
  };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ? `${body.error} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function call(auth, path, init = {}) {
  const res = await fetch(`${auth.server}${path}`, {
    ...init,
    headers: { ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}), ...(init.headers ?? {}) },
  });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof body === 'string' ? { error: body.slice(0, 200) } : body);
  return body;
}

export const health = (auth) => call(auth, '/api/v1/health');

/** The front-desk day: appointments across every location, with reminder-call state. */
export function schedule(auth, date = today()) {
  return call(auth, `/api/v1/schedule?date=${encodeURIComponent(resolveDate(date))}`);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function resolveDate(input) {
  if (!input || input === 'today') return today();
  if (input === 'tomorrow') return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  throw new Error(`date is today, tomorrow or YYYY-MM-DD, not "${input}"`);
}
