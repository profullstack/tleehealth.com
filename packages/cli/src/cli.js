/**
 * tleehealth: the practice from the terminal.
 *
 *   tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]
 *   tleehealth caseload [--month YYYY-MM] [--all] [--json]
 *   tleehealth superbill [--month YYYY-MM] [--csv] [--json]
 *   tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note TEXT] [--date YYYY-MM-DD]
 *   tleehealth records [--category C] [--q TEXT] [--connection ID] [--json]
 *   tleehealth providers QUERY
 *   tleehealth connect QUERY | --provider ID | --fhir URL [--name N] [--no-open]
 *   tleehealth sync [CONNECTION_ID] [--wait]
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
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  caseload, connect, connection, disconnect, exportRecords, health, logTime, providers, recordAccess, recordFile, recordItems, records,
  resolveAuth, saveConfig, schedule, shareConnection, superbill, syncConnection,
} from './client.js';

const HELP = `tleehealth: telehealth and practice management.

  tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]   the front-desk day
  tleehealth caseload [--month YYYY-MM] [--all] [--json]            navigation patients and minutes this month
  tleehealth superbill [--month YYYY-MM] [--csv]                    billable PIN/CHI/CCM codes for the month
  tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note T] [--date YYYY-MM-DD]

Your health records from other providers (MyChart and any SMART on FHIR portal):
  tleehealth providers QUERY                                        find your provider (every Epic/MyChart organization)
  tleehealth connect QUERY | --provider ID | --fhir URL             sign in there in your browser; everything is imported
  tleehealth records [--category C] [--q TEXT] [--json]             overview, or one category: visits summaries notes labs imaging ...
  tleehealth sync [CONNECTION_ID] [--wait]                          import again (all connections when no id)
  tleehealth share CONNECTION_ID --org ORG [--off]                  show a connection to a practice you are a patient of
  tleehealth export [--format zip|bundle] [--out FILE]              download everything: personal info, summaries, labs, notes, images
  tleehealth file FILE_ID [--out FILE]                              one attached file
  tleehealth access                                                 who at which practice opened your shared records
  tleehealth disconnect CONNECTION_ID                               remove it and everything it imported

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
    return 'No providers connected. Find yours with: tleehealth providers "<name>"  then  tleehealth connect "<name>"';
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

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const auth = await resolveAuth({ server: flags.server, key: flags.key });
  switch (cmd) {
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
