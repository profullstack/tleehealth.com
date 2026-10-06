/**
 * tleehealth: the practice from the terminal.
 *
 *   tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]
 *   tleehealth health
 *   tleehealth login [KEY]
 *   tleehealth tui
 *
 * TLEEHEALTH_API_KEY and TLEEHEALTH_URL override the saved config.
 */
import { createInterface } from 'node:readline/promises';
import { health, resolveAuth, saveConfig, schedule } from './client.js';

const HELP = `tleehealth: telehealth and practice management.

  tleehealth schedule [--date today|tomorrow|YYYY-MM-DD] [--json]   the front-desk day
  tleehealth health                                                 is the API up
  tleehealth login [KEY]                                            save an API key
  tleehealth tui                                                    the day view, as a screen

Environment: TLEEHEALTH_API_KEY, TLEEHEALTH_URL.`;

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
