/**
 * tleehealth: the practice from the terminal.
 *
 *   tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]
 *   tleehealth caseload [--month YYYY-MM] [--all] [--json]
 *   tleehealth superbill [--month YYYY-MM] [--csv] [--json]
 *   tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note TEXT] [--date YYYY-MM-DD]
 *   tleehealth records [--category C] [--q TEXT] [--connection ID] [--json]
 *   tleehealth providers QUERY
 *   tleehealth share CONNECTION_ID --org ORG [--off]
 *   tleehealth disconnect CONNECTION_ID
 *   tleehealth export [--format zip|bundle] [--out FILE] [--connection ID]
 *   tleehealth file FILE_ID [--out FILE]
 *   tleehealth access [--json]
 *   tleehealth health
 *   tleehealth login [KEY]
 *   tleehealth dashboard | tui
 *
 * TLEEHEALTH_API_KEY and TLEEHEALTH_URL override the saved config; TLEEHEALTH_ORG
 * (or --org) picks the practice when you are on more than one.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  createVault, decryptObject, encryptObject, lockVault, packFile, rewrapVaultKey,
  unlockWithPassphrase, unlockWithRecoveryKey, unpackFile,
} from './vault-crypto.js';
import {
  caseload, connect, connection, disconnect, exportRecords, health, logTime, providers, recordAccess, recordFile, recordItems, records,
  deleteRecordVault, deleteRecordVaultObject, downloadRecordVaultObject, me, readRecordVaultManifest,
  recordVaultStatus, resolveAuth, saveConfig, saveRecordVaultKey, saveRecordVaultManifest,
  schedule, shareConnection, superbill, syncConnection, uploadRecordVaultObject,
  applyCredits, createInvite, creditBalance, invites, redeemCode,
} from './client.js';

const HELP = `tleehealth: telehealth and practice management.

  tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]   the front-desk day
  tleehealth caseload [--month YYYY-MM] [--all] [--json]            navigation patients and minutes this month
  tleehealth superbill [--month YYYY-MM] [--csv]                    billable PIN/CHI/CCM codes for the month
  tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note T] [--date YYYY-MM-DD]

Your health records from other providers (MyChart and any SMART on FHIR portal):
  tleehealth providers QUERY                                        search provider names; automatic connections are paused
  tleehealth records [--category C] [--q TEXT] [--json]             overview, or one category: visits summaries notes labs imaging ...
  tleehealth share CONNECTION_ID --org ORG [--off]                  show a connection to a practice you are a patient of
  tleehealth export [--format zip|bundle] [--out FILE]              download everything: personal info, summaries, labs, notes, images
  tleehealth file FILE_ID [--out FILE]                              one attached file
  tleehealth access                                                 who at which practice opened your shared records
  tleehealth disconnect CONNECTION_ID                               remove it and everything it imported

End-to-end encrypted personal vault (client-side encryption; separate from legacy records):
  tleehealth vault status                                           vault setup and encrypted file count
  tleehealth vault setup                                            create vault, passphrase and recovery key
  tleehealth vault recover                                          unlock with recovery key and rotate passphrase
  tleehealth vault import FILE...                                   encrypt files locally and upload ciphertext
  tleehealth vault list                                             unlock and list decrypted filenames
  tleehealth vault get OBJECT_ID [--out FILE]                       decrypt one file locally
  tleehealth vault delete OBJECT_ID                                 delete an encrypted file
  tleehealth vault destroy                                          permanently delete the encrypted vault

Credit codes and invites (days of a practice's paid plan):
  tleehealth redeem CODE [--org ORG] [--keep]                       redeem a code onto a practice (--keep: into your balance)
  tleehealth credits [--apply DAYS] [--org ORG]                     your balance; --apply moves days onto a practice
  tleehealth invite [--note TEXT]                                   make an invite link (3 per account)
  tleehealth invites [--json]                                       your invites and what is left

  tleehealth health                                                 is the API up
  tleehealth login [KEY]                                            save an API key
  tleehealth dashboard                                              the dashboard, as a screen (alias: tui)

Environment: TLEEHEALTH_API_KEY, TLEEHEALTH_URL, TLEEHEALTH_ORG (or --org).`;

export function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (arg === '-h') flags.help = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

export function formatDay(day) {
  const lines = [`${day.org?.name ? `${day.org.name}  ` : ''}${day.date}`];
  if (!day.appointments.length) lines.push('  nothing booked');
  for (const a of day.appointments)
    lines.push(
      `${a.time}  ${a.location.padEnd(11)} ${a.provider.padEnd(11)} ${a.patient.padEnd(11)} ${a.type.padEnd(14)} ${a.mode.padEnd(9)} ${a.status}`,
    );
  return lines.join('\n');
}

const codes = (r) => r.lines.map((l) => `${l.code}${l.units > 1 ? ` x${l.units}` : ''}`).join(' + ');

export function formatCaseload(c) {
  const lines = [`caseload ${c.month}${c.mine ? ' (mine)' : ''}`];
  if (!c.caseload.length) lines.push('  no active enrollments');
  for (const r of c.caseload) {
    const toGo = r.next_unit_in == null ? 'all units' : `${r.next_unit_in} min to next`;
    const state = r.blockers.length ? `hold: ${r.blockers.join('; ')}` : r.lines.length ? 'ready' : '';
    lines.push(
      `${(r.patient ?? '').padEnd(18)} ${r.program_name.padEnd(7)} ${String(r.minutes).padStart(4)} min  ${(codes(r) || '-').padEnd(16)} ${toGo.padEnd(16)} ${state}  ${r.program_id}`,
    );
  }
  return lines.join('\n');
}

export function formatSuperbill(sb) {
  const lines = [`superbill ${sb.month}: ${sb.ready} ready, ${sb.held} on hold, ${sb.under} under threshold`];
  for (const r of sb.rows)
    lines.push(
      `${(r.patient ?? '').padEnd(18)} ${r.program_name.padEnd(7)} ${String(r.minutes).padStart(4)} min  ${(codes(r) || '-').padEnd(16)} ${r.ready ? 'ready' : r.lines.length ? `hold: ${r.blockers.join('; ')}` : `${r.next_unit_in} min short`}`,
    );
  const totals = Object.entries(sb.totals);
  if (totals.length) lines.push(`ready to bill: ${totals.map(([c, n]) => `${c} x${n}`).join(', ')}`);
  return lines.join('\n');
}

const ACCESS_LABEL = { 'records.read': 'viewed', 'records.file': 'opened a file', 'records.export': 'downloaded everything', 'records.share': 'you shared', 'records.unshare': 'you stopped sharing' };

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

export function formatRecords(r) {
  if (!r.connections.length)
    return 'No records imported. Download files from your provider portal, import them in the web app at /portal/records, then use tleehealth records or export.';
  const lines = [];
  for (const c of r.connections)
    lines.push(
      `${c.provider_name.padEnd(36)} ${c.status.padEnd(8)} ${String(c.records).padStart(5)} records ${String(c.files).padStart(4)} files  ${c.last_synced_at ? `synced ${String(c.last_synced_at).slice(0, 16).replace('T', ' ')}` : 'not synced'}${c.shared_with?.length ? `  shared: ${c.shared_with.map((s) => s.org_name).join(', ')}` : ''}  ${c.id}`,
    );
  const p = r.profile;
  if (p) {
    lines.push('', `${p.name ?? ''}${p.birth_date ? `  born ${p.birth_date}` : ''}${p.sex ? `  ${p.sex}` : ''}`);
    for (const v of [...p.phones, ...p.emails, ...p.addresses]) lines.push(`  ${v}`);
    for (const i of p.identifiers) lines.push(`  ${i.type}: ${i.value}`);
  }
  lines.push('', `${r.total} records, ${r.files} files (${fmtBytes(r.bytes)})`);
  for (const c of r.categories) lines.push(`  ${c.label.padEnd(24)} ${String(c.count).padStart(5)}   --category ${c.key}`);
  return lines.join('\n');
}

export function formatItems(items) {
  if (!items.length) return 'nothing here';
  return items
    .map((i) => {
      const d = i.recorded_on ? String(i.recorded_on).slice(0, 10) : '          ';
      const files = i.files.length ? `  [${i.files.map((f) => `${f.title ?? 'file'} ${f.id}`).join(', ')}]` : '';
      return `${d}  ${(i.title ?? i.resource_type).slice(0, 48).padEnd(48)} ${(i.detail ?? '').slice(0, 40)}${files}`;
    })
    .join('\n');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* the printed URL is enough */
  }
}

/** Sign in at the provider in a browser, then wait for the import to land. */
async function connectFlow(auth, flags, query) {
  let provider = flags.provider;
  if (!provider && !flags.fhir) {
    if (!query) throw new Error('usage: tleehealth connect "<provider name>" | --provider ID | --fhir URL');
    const { providers: hits } = await providers(auth, query);
    if (!hits.length) throw new Error(`no provider matches "${query}"; try fewer words, or --fhir with its FHIR address`);
    const exact = hits.find((h) => h.name.toLowerCase() === query.toLowerCase());
    if (hits.length > 1 && !exact) {
      console.log(`${hits.length} match. Pick one with --provider:`);
      for (const h of hits) console.log(`  ${h.id.padEnd(48)} ${h.name}`);
      return 1;
    }
    provider = (exact ?? hits[0]).id;
  }
  const r = await connect(auth, { provider, fhirBase: flags.fhir, name: flags.name });
  console.log(`Sign in to ${r.provider_name} and allow access:\n\n  ${r.authorize_url}\n`);
  if (!flags['no-open']) openBrowser(r.authorize_url);
  process.stderr.write('Waiting for you to finish in the browser');
  const started = Date.now();
  let c;
  while (Date.now() - started < 15 * 60_000) {
    await new Promise((res) => setTimeout(res, 2000));
    c = (await connection(auth, r.connection_id)).connection;
    if (c.status === 'error' || c.status === 'expired') break;
    if (c.status === 'active' && c.last_synced_at) break;
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (c?.status !== 'active') throw new Error(c?.last_error || 'timed out waiting for the provider sign-in');
  console.log(`Imported ${c.records} records and ${c.files} files from ${c.provider_name}.${c.last_error ? `\nSome parts could not be read:\n${c.last_error}` : ''}`);
  return 0;
}

async function save(bytes, out) {
  if (out === '-') return void process.stdout.write(bytes);
  await writeFile(out, bytes, { mode: 0o600 });
  process.stderr.write(`Saved ${fmtBytes(bytes.length)} to ${out}. It holds health information; keep it private.\n`);
}

async function promptSecret(label) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Vault secrets require an interactive terminal; do not pass them as command-line arguments.');
  }
  process.stderr.write(`${label}: `);
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}

async function promptLine(label) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}

function validateManifest(doc) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.files) || doc.files.length > 50_000) {
    throw new Error('The encrypted vault index is invalid. Your files remain encrypted.');
  }
  return doc.files.filter((f) => f && typeof f.id === 'string' && /^[0-9a-f-]{36}$/i.test(f.id)
    && typeof f.name === 'string' && f.name.length <= 255 && Number.isSafeInteger(f.size) && f.size >= 0
    && typeof f.type === 'string' && typeof f.category === 'string');
}

async function readVaultManifest(auth, handle, userId) {
  const { revision, ciphertext } = await readRecordVaultManifest(auth);
  if (!ciphertext) return { revision, files: [] };
  const clear = await decryptObject(handle, userId, '00000000-0000-4000-8000-000000000001', ciphertext);
  try { return { revision, files: validateManifest(JSON.parse(new TextDecoder().decode(clear))) }; }
  finally { clear.fill(0); ciphertext.fill(0); }
}

async function writeVaultManifest(auth, handle, userId, revision, files) {
  const clear = new TextEncoder().encode(JSON.stringify({ version: 1, files }));
  let sealed;
  try { sealed = await encryptObject(handle, userId, '00000000-0000-4000-8000-000000000001', clear); }
  finally { clear.fill(0); }
  try { return await saveRecordVaultManifest(auth, revision, sealed); }
  finally { sealed.fill(0); }
}

async function removeVaultManifestEntry(auth, handle, userId, id) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readVaultManifest(auth, handle, userId);
    try {
      await writeVaultManifest(auth, handle, userId, current.revision, current.files.filter((file) => file.id !== id));
      return;
    } catch (err) {
      if (err.status !== 409 || attempt === 3) throw err;
    }
  }
}

async function unlockVault(auth, userId, status) {
  if (!status.configured) throw new Error('No encrypted vault yet. Run `tleehealth vault setup`.');
  const passphrase = await promptSecret('Vault passphrase');
  return unlockWithPassphrase(userId, passphrase, status.envelope);
}

async function establishVault(auth, userId, { recover = false } = {}) {
  const status = await recordVaultStatus(auth);
  let handle;
  let envelope;
  let recoveryKey;
  if (recover) {
    if (!status.configured) throw new Error('No encrypted vault exists to recover.');
    const enteredRecoveryKey = await promptSecret('Recovery key');
    const passphrase = await promptSecret('New vault passphrase');
    const confirm = await promptSecret('Repeat new passphrase');
    if (passphrase !== confirm) throw new Error('Passphrases do not match.');
    handle = await unlockWithRecoveryKey(userId, enteredRecoveryKey, status.envelope);
    ({ envelope, recoveryKey } = await rewrapVaultKey(userId, handle, passphrase));
  } else {
    if (status.configured) throw new Error('A vault already exists. Use `tleehealth vault recover` to rotate its passphrase.');
    const passphrase = await promptSecret('New vault passphrase');
    const confirm = await promptSecret('Repeat passphrase');
    if (passphrase !== confirm) throw new Error('Passphrases do not match.');
    const created = await createVault(userId, passphrase);
    handle = created.handle;
    envelope = created.envelope;
    recoveryKey = created.recoveryKey;
  }
  process.stderr.write('\nSave this new recovery key somewhere separate from your computer. It can unlock every file in this vault.\n\n');
  process.stdout.write(`${recoveryKey}\n\n`);
  if ((await promptLine('Type SAVED after you have stored the recovery key: ')) !== 'SAVED') {
    lockVault(handle);
    throw new Error('Vault setup cancelled; the key was not saved to the server.');
  }
  try {
    await saveRecordVaultKey(auth, envelope);
    process.stderr.write(recover ? 'Vault keys rotated.\n' : 'Encrypted vault created.\n');
  } finally {
    lockVault(handle);
  }
}

async function vaultCommand(auth, action, args, flags) {
  const status = await recordVaultStatus(auth);
  if (action === 'status') {
    console.log(status.configured
      ? `Encrypted vault configured · ${status.objects} encrypted files · ${fmtBytes(status.bytes)} stored (2 GB limit)\nNames and file contents are encrypted on your device. Run tleehealth vault list to unlock and view filenames.`
      : 'No encrypted vault yet. Run `tleehealth vault setup`.');
    return 0;
  }
  if (action === 'setup' || action === 'recover') {
    const { user } = await me(auth);
    await establishVault(auth, user.id, { recover: action === 'recover' });
    return 0;
  }
  if (action === 'destroy') {
    if (!status.configured) throw new Error('No encrypted vault exists.');
    if ((await promptLine('Permanently delete all encrypted vault files and its key? Type DESTROY: ')) !== 'DESTROY') throw new Error('Cancelled.');
    await deleteRecordVault(auth);
    console.log('Encrypted vault and all its files deleted.');
    return 0;
  }
  if (!['import', 'list', 'get', 'delete'].includes(action)) {
    throw new Error('usage: tleehealth vault {status|setup|recover|import|list|get|delete|destroy}');
  }
  const { user } = await me(auth);
  const handle = await unlockVault(auth, user.id, status);
  try {
    const current = await readVaultManifest(auth, handle, user.id);
    if (action === 'list') {
      for (const f of current.files) console.log(`${f.id}  ${String(f.imported_at ?? '').slice(0, 10).padEnd(10)}  ${f.category.padEnd(14)} ${fmtBytes(f.size).padStart(8)}  ${f.name}`);
      if (!current.files.length) console.log('No encrypted files. Import with `tleehealth vault import FILE...`.');
      return 0;
    }
    if (action === 'import') {
      if (!args.length) throw new Error('usage: tleehealth vault import FILE...');
      const uploaded = [];
      const additions = [];
      try {
        for (const path of args) {
          const bytes = new Uint8Array(await readFile(path));
          if (bytes.byteLength > 100 * 1024 * 1024) {
            bytes.fill(0);
            throw new Error(`${path}: each file must be 100 MB or smaller.`);
          }
          const id = randomUUID();
          const meta = { id, name: basename(path).slice(0, 255), type: 'application/octet-stream', size: bytes.byteLength, category: 'reports', imported_at: new Date().toISOString() };
          let packed;
          let sealed;
          try { packed = packFile(meta, bytes); } finally { bytes.fill(0); }
          try { sealed = await encryptObject(handle, user.id, id, packed); } finally { packed.fill(0); }
          try { await uploadRecordVaultObject(auth, id, sealed); } finally { sealed.fill(0); }
          uploaded.push(id);
          additions.push(meta);
        }
        await writeVaultManifest(auth, handle, user.id, current.revision, [...current.files, ...additions]);
      } catch (err) {
        await Promise.allSettled(uploaded.map((id) => deleteRecordVaultObject(auth, id)));
        throw err;
      }
      console.log(`Encrypted and imported ${additions.length} file${additions.length === 1 ? '' : 's'}.`);
      return 0;
    }
    if (action === 'get') {
      const id = args[0];
      const entry = current.files.find((f) => f.id === id);
      if (!entry) throw new Error('No such file in the encrypted vault index.');
      const { bytes: sealed } = await downloadRecordVaultObject(auth, id);
      let clear;
      let unpacked;
      try {
        clear = await decryptObject(handle, user.id, id, sealed);
      } finally {
        sealed.fill(0);
      }
      try {
        unpacked = unpackFile(clear);
      } finally {
        clear.fill(0);
      }
      if (unpacked.metadata.id !== id || unpacked.metadata.size !== unpacked.bytes.byteLength) {
        unpacked.bytes.fill(0);
        throw new Error('Decrypted file does not match its encrypted index.');
      }
      const out = typeof flags.out === 'string' ? flags.out : join('.', basename(entry.name));
      try { await writeFile(out, unpacked.bytes, { mode: 0o600, flag: 'wx' }); }
      finally { unpacked.bytes.fill(0); }
      console.log(`Decrypted ${entry.name} to ${out} (mode 0600).`);
      return 0;
    }
    if (action === 'delete') {
      const id = args[0];
      if (!current.files.some((f) => f.id === id)) throw new Error('No such file in the encrypted vault index.');
      await removeVaultManifestEntry(auth, handle, user.id, id);
      await deleteRecordVaultObject(auth, id);
      console.log('Encrypted file deleted.');
      return 0;
    }
    throw new Error('usage: tleehealth vault {status|setup|recover|import|list|get|delete|destroy}');
  } finally {
    lockVault(handle);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const auth = await resolveAuth({ server: flags.server, key: flags.key });
  switch (cmd) {
    case 'vault':
      return vaultCommand(auth, rest[0] ?? 'status', rest.slice(1), flags);
    case 'health': {
      const h = await health(auth);
      console.log(`${auth.server}  ok=${h.ok}  v${h.version}`);
      return h.ok ? 0 : 1;
    }
    case 'schedule': {
      const day = await schedule(auth, flags.date);
      console.log(flags.json ? JSON.stringify(day, null, 2) : formatDay(day));
      return 0;
    }
    case 'caseload': {
      const c = await caseload(auth, { org: flags.org, month: flags.month, all: Boolean(flags.all) });
      console.log(flags.json ? JSON.stringify(c, null, 2) : formatCaseload(c));
      return 0;
    }
    case 'superbill': {
      const sb = await superbill(auth, { org: flags.org, month: flags.month, csv: Boolean(flags.csv) });
      console.log(flags.csv ? sb.trimEnd() : flags.json ? JSON.stringify(sb, null, 2) : formatSuperbill(sb));
      return 0;
    }
    case 'log-time': {
      const [program, minutes] = rest;
      if (!program || !minutes) throw new Error('usage: tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note TEXT]');
      const r = await logTime(auth, { org: flags.org, program, minutes, activity: flags.activity, note: flags.note, date: flags.date });
      const p = r.program;
      console.log(`${minutes} min logged. ${p.patient ?? ''} ${p.program_name}: ${p.minutes} min this month${p.lines.length ? `, ${codes(p)}` : ''}${p.blockers.length ? ` (hold: ${p.blockers.join('; ')})` : ''}`);
      return 0;
    }
    case 'login': {
      let key = rest[0];
      if (!key) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        key = (await rl.question('API key: ')).trim();
        rl.close();
      }
      const file = await saveConfig({ key, server: auth.server });
      process.stderr.write(`Saved to ${file}.\n`);
      return 0;
    }
    case 'records': {
      if (flags.category || flags.q) {
        const r = await recordItems(auth, { category: flags.category, q: flags.q, connection: flags.connection, limit: flags.limit });
        console.log(flags.json ? JSON.stringify(r.items, null, 2) : formatItems(r.items));
      } else {
        const r = await records(auth, { connection: flags.connection });
        console.log(flags.json ? JSON.stringify(r, null, 2) : formatRecords(r));
      }
      return 0;
    }
    case 'access': {
      const { access } = await recordAccess(auth);
      if (flags.json) console.log(JSON.stringify(access, null, 2));
      else if (!access.length) console.log('No practice has opened your shared records.');
      else for (const a of access) console.log(`${String(a.at).slice(0, 16).replace('T', ' ')}  ${a.org_name.padEnd(28)} ${(a.you ? 'you' : a.who ?? '').padEnd(24)} ${ACCESS_LABEL[a.action] ?? a.action}`);
      return 0;
    }
    case 'providers': {
      const { providers: hits } = await providers(auth, rest.join(' '));
      if (flags.json) console.log(JSON.stringify(hits, null, 2));
      else for (const h of hits) console.log(`${h.id.padEnd(48)} ${h.name}${h.ready ? '' : '  (not available yet)'}`);
      return 0;
    }
    case 'connect':
      return connectFlow(auth, flags, rest.join(' '));
    case 'sync': {
      const ids = rest.length
        ? rest
        : (await records(auth)).connections.filter((c) => c.status === 'active' || c.status === 'error').map((c) => c.id);
      if (!ids.length) throw new Error('nothing to sync; connect a provider first');
      for (const id of ids) {
        const r = await syncConnection(auth, id, { wait: Boolean(flags.wait) });
        const n = Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0);
        console.log(flags.wait ? `${id}: ${n} records, ${r.files ?? 0} new files${r.errors?.length ? `, ${r.errors.length} problems` : ''}` : `${id}: import started`);
      }
      return 0;
    }
    case 'share': {
      const [id] = rest;
      if (!id || !flags.org) throw new Error('usage: tleehealth share CONNECTION_ID --org ORG [--off]');
      await shareConnection(auth, id, { org: flags.org, shared: !flags.off });
      console.log(flags.off ? 'No longer shared.' : 'Shared. The practice sees these records in your chart.');
      return 0;
    }
    case 'disconnect': {
      const [id] = rest;
      if (!id) throw new Error('usage: tleehealth disconnect CONNECTION_ID');
      await disconnect(auth, id);
      console.log('Disconnected; everything imported through it was deleted.');
      return 0;
    }
    case 'export': {
      const r = await exportRecords(auth, { format: flags.format, connection: flags.connection });
      await save(r.bytes, typeof flags.out === 'string' ? flags.out : (r.filename ?? 'tleehealth-records.zip'));
      return 0;
    }
    case 'file': {
      const [id] = rest;
      if (!id) throw new Error('usage: tleehealth file FILE_ID [--out FILE]');
      const r = await recordFile(auth, id);
      await save(r.bytes, typeof flags.out === 'string' ? flags.out : (r.filename ?? id));
      return 0;
    }
    case 'redeem': {
      if (!rest[0]) throw new Error('usage: tleehealth redeem CODE [--org ORG] [--keep]');
      const r = await redeemCode(auth, { code: rest[0], org: flags.org, keep: Boolean(flags.keep) });
      console.log(
        r.applied?.ok
          ? `Added ${r.applied.days} days. Paid through ${String(r.applied.paid_through).slice(0, 10)}.`
          : `Added ${r.grant.amount} days to your balance (${r.balance} now).${r.applied?.error ? ` ${r.applied.error}` : ''}`,
      );
      return 0;
    }
    case 'credits': {
      if (flags.apply) {
        const r = await applyCredits(auth, { org: flags.org, days: flags.apply });
        console.log(`Added ${r.days} days. Paid through ${String(r.paid_through).slice(0, 10)}. Balance ${r.balance}.`);
        return 0;
      }
      const c = await creditBalance(auth);
      console.log(flags.json ? JSON.stringify(c, null, 2) : `${c.balance} ${c.unit.replace('_', ' ')}`);
      return 0;
    }
    case 'invite': {
      const r = await createInvite(auth, { note: flags.note });
      console.log(`${r.invite.url}
(shown once; ${r.quota.left} of ${r.quota.total} left)`);
      return 0;
    }
    case 'invites': {
      const r = await invites(auth);
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.quota.left} of ${r.quota.total} invites left. Each gives you both ${r.bonus_days} days.`);
        for (const i of r.invites)
          console.log(`  ${new Date(i.createdAt).toISOString().slice(0, 10)}  ${(i.note || 'invite').padEnd(24)} ${i.revokedAt ? 'revoked' : i.usedAt ? 'accepted' : 'open'}`);
      }
      return 0;
    }
    case 'dashboard':
    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(auth, { date: flags.date, org: flags.org });
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}; try tleehealth help`);
  }
}
