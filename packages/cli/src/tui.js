/**
 * tleehealth dashboard (also `tleehealth tui`): the practice and your records on one screen.
 *
 *   1 Today     the day's appointments across every location, with AI call state
 *   2 Needs     flagged calls, refill requests, labs to release, summaries to sign
 *   3 Caseload  navigation patients and this month's minutes toward their codes
 *   4 Records   your records imported from other providers (MyChart, any SMART on FHIR portal)
 *
 * Keys: 1-4 or Tab switch · Up/Down pick · Left/Right day (Today) · Enter open (Records)
 * Esc back · s sync · e export everything · r refresh · q quit.
 */
import { writeFile } from 'node:fs/promises';
import { createApp } from '@profullstack/hqtui';
import { caseload, dashboardDay, exportRecords, me, recordItems, records, resolveDate, syncConnection } from './client.js';

export const TABS = ['Today', 'Needs', 'Caseload', 'Records'];
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ymd = (v) => (v ? String(v).slice(0, 10) : '');
const lastCall = (a) => {
  const c = (a.calls ?? []).at(-1);
  return c ? `${c.kind} ${c.status.replace('_', ' ')}${c.flagged ? ' !' : ''}` : '';
};

export function initialState(date) {
  return {
    tab: 0,
    date: resolveDate(date),
    selected: [0, 0, 0, 0],
    me: null,
    day: null,
    caseload: null,
    records: null,
    category: null, // Records: the open category
    items: null,
    status: 'Loading…',
    errors: {},
  };
}

const needsRows = (day) => {
  const n = day?.needs ?? {};
  return [
    ...(n.calls ?? []).map((x) => ({ kind: 'call', who: x.patient, what: x.flag_reason || x.summary || `${x.kind} call`, when: ymd(x.ended_at) })),
    ...(n.refills ?? []).map((x) => ({ kind: 'refill', who: x.patient, what: `${x.medication}${x.dose ? ` ${x.dose}` : ''}`, when: ymd(x.requested_at) })),
    ...(n.labs ?? []).map((x) => ({ kind: 'release lab', who: x.patient, what: `${x.test_name} ${x.value ?? x.value_text ?? ''}${x.unit ? ` ${x.unit}` : ''}${x.flag && x.flag !== 'normal' ? ` (${x.flag})` : ''}`, when: '' })),
    ...(n.summaries ?? []).map((x) => ({ kind: 'sign summary', who: x.patient, what: 'visit summary draft', when: '' })),
  ];
};

/** How many rows the current tab's list has, for Up/Down. */
export function rowCount(s) {
  if (s.tab === 0) return s.day?.appointments?.length ?? 0;
  if (s.tab === 1) return needsRows(s.day).length;
  if (s.tab === 2) return s.caseload?.caseload?.length ?? 0;
  return s.category ? (s.items?.length ?? 0) : (s.records?.categories?.length ?? 0);
}

/** The screen, as a pure function of state: the app and the tests both draw it. */
export function view(s) {
  return ({ ui, theme }) => {
    const sel = s.selected[s.tab];
    const org = s.me?.orgs?.[0];
    const noPractice = s.me && !s.me.orgs?.length;
    ui.column({ gap: 0 }, (root) => {
      root.row({ size: 1 }, (row) => {
        row.tabs({ tabs: TABS.map((t, i) => `${i + 1} ${t}`), active: s.tab, variant: 'underline' });
      });
      const body = (fn) => root.column({ size: '1fr' }, fn);

      if (s.tab < 3 && noPractice) {
        body((b) =>
          b.panel({ title: TABS[s.tab] }, (p) => {
            p.text('You are not on a practice team. Press 4 for your health records.', { fg: theme.muted });
          }),
        );
      } else if (s.tab === 0) {
        const appts = s.day?.appointments ?? [];
        const n = s.day?.needs ?? {};
        body((b) =>
          b.row({ gap: 1 }, (r) => {
            r.panel({ title: `${org?.name ?? 'Practice'} · ${s.date}`, subtitle: `${appts.length} appointments`, size: '3fr' }, (p) => {
              if (!appts.length) p.text(s.errors.day ?? 'Nothing booked. Left/Right moves a day.', { fg: theme.muted });
              else
                p.table({
                  rows: appts,
                  selected: sel,
                  followSelection: true,
                  columns: [
                    { key: 'time', title: 'Time', width: 8, render: (a) => hhmm(a.starts_at) },
                    { key: 'patient', title: 'Patient', width: 16 },
                    { key: 'provider', title: 'Provider', width: 14, render: (a) => a.provider ?? 'unassigned' },
                    { key: 'where', title: 'Where', width: 12, render: (a) => (a.mode === 'video' ? 'video' : (a.location ?? '')) },
                    { key: 'reason', title: 'Reason', render: (a) => a.reason ?? '' },
                    { key: 'status', title: 'Status', width: 11, render: (a) => a.status.replace('_', ' ') },
                    { key: 'call', title: 'AI call', width: 18, render: lastCall },
                  ],
                });
            });
            r.panel({ title: 'Waiting on you', size: '1fr' }, (p) => {
              p.keyValues([
                { label: 'Flagged calls', value: String(n.calls?.length ?? 0), color: n.calls?.length ? theme.danger : undefined },
                { label: 'Refills', value: String(n.refills?.length ?? 0), color: n.refills?.length ? theme.warning : undefined },
                { label: 'Labs to release', value: String(n.labs?.length ?? 0), color: n.labs?.length ? theme.warning : undefined },
                { label: 'To sign', value: String(n.summaries?.length ?? 0) },
              ]);
              const rec = s.records;
              if (rec) {
                p.spacer(1);
                p.label('Your records');
                p.keyValues([
                  { label: 'Providers', value: String(rec.connections.length) },
                  { label: 'Records', value: String(rec.total) },
                  { label: 'Files', value: String(rec.files) },
                ]);
              }
            });
          }),
        );
      } else if (s.tab === 1) {
        const rows = needsRows(s.day);
        body((b) =>
          b.panel({ title: 'Needs a human', subtitle: `${rows.length} open` }, (p) => {
            if (!rows.length) p.text(s.errors.day ?? 'All clear.', { fg: theme.muted });
            else
              p.table({
                rows,
                selected: sel,
                followSelection: true,
                columns: [
                  { key: 'kind', title: 'What', width: 13, color: (r) => (r.kind === 'call' ? theme.danger : undefined) },
                  { key: 'who', title: 'Patient', width: 18 },
                  { key: 'what', title: 'Detail' },
                  { key: 'when', title: 'When', width: 10 },
                ],
              });
          }),
        );
      } else if (s.tab === 2) {
        const rows = s.caseload?.caseload ?? [];
        body((b) =>
          b.panel({ title: `Caseload ${s.caseload?.month ?? ''}`, subtitle: `${rows.length} enrollments` }, (p) => {
            if (!rows.length) p.text(s.errors.caseload ?? 'No active program enrollments.', { fg: theme.muted });
            else
              p.table({
                rows,
                selected: sel,
                followSelection: true,
                columns: [
                  { key: 'patient', title: 'Patient', width: 18 },
                  { key: 'program_name', title: 'Program', width: 8 },
                  { key: 'minutes', title: 'Min', width: 5, align: 'right' },
                  { key: 'codes', title: 'Codes', width: 18, render: (r) => r.lines.map((l) => `${l.code}${l.units > 1 ? ` x${l.units}` : ''}`).join(' + ') || '-' },
                  { key: 'next', title: 'To next', width: 10, render: (r) => (r.next_unit_in == null ? 'all units' : `${r.next_unit_in} min`) },
                  { key: 'state', title: 'State', render: (r) => (r.blockers.length ? `hold: ${r.blockers.join('; ')}` : r.lines.length ? 'ready' : ''), color: (r) => (r.blockers.length ? theme.warning : undefined) },
                ],
              });
          }),
        );
      } else {
        const rec = s.records;
        body((b) =>
          b.row({ gap: 1 }, (r) => {
            r.column({ size: '2fr', gap: 0 }, (left) => {
              left.panel({ title: 'Connected providers', size: Math.max(4, (rec?.connections.length ?? 0) + 3) }, (p) => {
                if (!rec?.connections.length) p.text(s.errors.records ?? 'None yet. Connect one in the app (My health → Connect) or: tleehealth connect "<name>"', { fg: theme.muted });
                else
                  p.table({
                    rows: rec.connections,
                    header: false,
                    columns: [
                      { key: 'provider_name', title: 'Provider' },
                      { key: 'status', width: 8, color: (c) => (c.status === 'active' ? theme.success : c.status === 'syncing' ? theme.accent : theme.danger) },
                      { key: 'records', width: 12, render: (c) => `${c.records} records` },
                      { key: 'files', width: 9, render: (c) => `${c.files} files` },
                      { key: 'synced', width: 16, render: (c) => (c.last_synced_at ? String(c.last_synced_at).slice(0, 16).replace('T', ' ') : 'not synced') },
                    ],
                  });
              });
              left.panel({ title: s.category ? `${rec?.categories.find((c) => c.key === s.category)?.label ?? s.category} · Esc back` : 'Categories · Enter opens', size: '1fr' }, (p) => {
                if (s.category) {
                  const items = s.items ?? [];
                  if (!items.length) p.text(s.items ? 'Nothing here.' : 'Loading…', { fg: theme.muted });
                  else
                    p.table({
                      rows: items,
                      selected: sel,
                      followSelection: true,
                      columns: [
                        { key: 'recorded_on', title: 'Date', width: 10, render: (i) => ymd(i.recorded_on) },
                        { key: 'title', title: 'Record', render: (i) => i.title ?? i.resource_type },
                        { key: 'detail', title: 'Detail', width: 28, render: (i) => i.detail ?? '' },
                        { key: 'files', title: 'Files', width: 6, align: 'right', render: (i) => (i.files.length ? String(i.files.length) : '') },
                      ],
                    });
                } else if (rec?.categories.length)
                  p.table({
                    rows: rec.categories,
                    selected: sel,
                    header: false,
                    columns: [
                      { key: 'label', title: 'Category' },
                      { key: 'count', width: 7, align: 'right' },
                    ],
                  });
                else p.text('No records yet.', { fg: theme.muted });
              });
            });
            r.panel({ title: 'Personal information', size: '1fr' }, (p) => {
              const pr = rec?.profile;
              if (!pr) return void p.text('Appears after the first import.', { fg: theme.muted });
              p.keyValues(
                [
                  { label: 'Name', value: pr.name ?? '' },
                  { label: 'Born', value: pr.birth_date ?? '' },
                  { label: 'Sex', value: pr.sex ?? '' },
                  ...pr.phones.map((v) => ({ label: 'Phone', value: v })),
                  ...pr.emails.map((v) => ({ label: 'Email', value: v })),
                  ...pr.addresses.map((v) => ({ label: 'Address', value: v })),
                  ...pr.identifiers.slice(0, 6).map((i) => ({ label: i.type.slice(0, 14), value: i.value })),
                ].filter((r) => r.value),
              );
            });
          }),
        );
      }
      root.statusBar({
        items: [
          { key: '1-4', label: 'tabs' },
          { key: '↑↓', label: 'pick' },
          ...(s.tab === 0 ? [{ key: '←→', label: 'day' }] : []),
          ...(s.tab === 3 ? [{ key: '⏎', label: 'open' }, { key: 's', label: 'sync' }, { key: 'e', label: 'export all' }] : []),
          { key: 'r', label: 'refresh' },
          { key: 'q', label: 'quit' },
        ],
        right: [{ label: s.status }],
      });
    });
  };
}

/** The screen as plain text, without a terminal: for tests and snapshots. */
export async function renderText(s, options = { width: 120, height: 30 }) {
  const { renderToText } = await import('@profullstack/hqtui/testing');
  return renderToText(view(s), options);
}

export async function runTui(auth, { date, org } = {}) {
  const s = initialState(date);
  const app = await createApp({ fps: 20, quitKeys: [] });
  const say = (msg) => {
    s.status = msg;
    app.invalidate();
  };

  const loadDay = async () => {
    if (!s.me?.orgs?.length) return;
    try {
      s.day = await dashboardDay(auth, { org, date: s.date });
      delete s.errors.day;
    } catch (err) {
      s.day = null;
      s.errors.day = err.message;
    }
  };
  const loadRecords = async () => {
    try {
      s.records = await records(auth);
      delete s.errors.records;
    } catch (err) {
      s.errors.records = err.message;
    }
  };
  const loadItems = async () => {
    s.items = null;
    app.invalidate();
    try {
      s.items = (await recordItems(auth, { category: s.category, limit: 500 })).items;
    } catch (err) {
      s.items = [];
      say(err.message);
    }
  };
  const loadAll = async () => {
    say('Loading…');
    try {
      s.me = await me(auth);
    } catch (err) {
      return say(err.message);
    }
    await Promise.all([
      loadDay(),
      loadRecords(),
      s.me.orgs?.length
        ? caseload(auth, { org, all: true }).then((c) => (s.caseload = c)).catch((err) => (s.errors.caseload = err.message))
        : null,
    ]);
    if (s.category) await loadItems();
    say(`${s.me.user.email}${s.me.orgs?.[0] ? ` · ${s.me.orgs[0].name}` : ''}`);
  };

  const move = (d) => {
    const n = rowCount(s);
    if (n) s.selected[s.tab] = (s.selected[s.tab] + d + n) % n;
  };

  app.on('key', (e) => {
    if (e.key === 'ctrl+c' || e.char === 'q') return app.quit();
    if (e.char && '1234'.includes(e.char)) s.tab = Number(e.char) - 1;
    else if (e.name === 'tab') s.tab = (s.tab + (e.shift ? 3 : 1)) % 4;
    else if (e.name === 'up') move(-1);
    else if (e.name === 'down') move(1);
    else if (s.tab === 0 && (e.name === 'left' || e.name === 'right')) {
      s.date = shift(s.date, e.name === 'left' ? -1 : 1);
      s.selected[0] = 0;
      say(`Loading ${s.date}…`);
      return void loadDay().then(() => say(s.date));
    } else if (e.char === 'r') return void loadAll();
    else if (s.tab === 3 && e.name === 'enter' && !s.category && s.records?.categories.length) {
      s.category = s.records.categories[s.selected[3]]?.key;
      s.selected[3] = 0;
      return void loadItems();
    } else if (s.tab === 3 && (e.name === 'escape' || e.name === 'backspace') && s.category) {
      const i = s.records.categories.findIndex((c) => c.key === s.category);
      s.category = null;
      s.items = null;
      s.selected[3] = Math.max(0, i);
    } else if (s.tab === 3 && e.char === 's') {
      const ids = (s.records?.connections ?? []).filter((c) => ['active', 'error'].includes(c.status)).map((c) => c.id);
      if (!ids.length) return say('Nothing to sync');
      say('Importing…');
      return void Promise.all(ids.map((id) => syncConnection(auth, id, { wait: true })))
        .then(loadAll)
        .catch((err) => say(err.message));
    } else if (s.tab === 3 && e.char === 'e') {
      say('Exporting everything…');
      return void exportRecords(auth)
        .then(async (r) => {
          const out = r.filename ?? 'tleehealth-records.zip';
          await writeFile(out, r.bytes, { mode: 0o600 });
          say(`Saved ${out} (${Math.round(r.bytes.length / 1024)} KB)`);
        })
        .catch((err) => say(err.message));
    }
    app.invalidate();
  });

  app.render(view(s));
  void loadAll();
  await app.start();
}
