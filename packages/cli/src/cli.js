/**
 * tleehealth: the practice from the terminal.
 *
 *   tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]
 *   tleehealth caseload [--month YYYY-MM] [--all] [--json]
 *   tleehealth superbill [--month YYYY-MM] [--csv] [--json]
 *   tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note TEXT] [--date YYYY-MM-DD]
 *   tleehealth health
 *   tleehealth login [KEY]
 *   tleehealth tui
 *
 * TLEEHEALTH_API_KEY and TLEEHEALTH_URL override the saved config; TLEEHEALTH_ORG
 * (or --org) picks the practice when you are on more than one.
 */
import { createInterface } from 'node:readline/promises';
import { caseload, health, logTime, resolveAuth, saveConfig, schedule, superbill } from './client.js';

const HELP = `tleehealth: telehealth and practice management.

  tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]   the front-desk day
  tleehealth caseload [--month YYYY-MM] [--all] [--json]            navigation patients and minutes this month
  tleehealth superbill [--month YYYY-MM] [--csv]                    billable PIN/CHI/CCM codes for the month
  tleehealth log-time PROGRAM_ID MINUTES [--activity A] [--note T] [--date YYYY-MM-DD]
  tleehealth health                                                 is the API up
  tleehealth login [KEY]                                            save an API key
  tleehealth tui                                                    the day view, as a screen

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
    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(auth, flags.date);
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}; try tleehealth help`);
  }
}
