/**
 * tleehealth tui: the front-desk day view.
 *
 * Today's appointments across every location, with the AI reminder-call state of
 * each. Up/Down picks a row, Left/Right moves a day, r refreshes, Ctrl+C or q quits.
 */
import { createApp } from '@profullstack/hqtui';
import { resolveDate, schedule } from './client.js';

const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function runTui(auth, date) {
  const state = { date: resolveDate(date), day: null, selected: 0, status: 'Loading…' };
  const app = await createApp({ fps: 20, quitKeys: [] });

  const load = async () => {
    state.status = 'Loading…';
    app.invalidate();
    try {
      state.day = await schedule(auth, state.date);
      state.selected = 0;
      state.status = `${state.day.appointments.length} appointments${state.day.org?.name ? ` · ${state.day.org.name}` : ''}`;
    } catch (err) {
      state.day = null;
      state.status = err.message;
    }
    app.invalidate();
  };

  app.on('key', (event) => {
    if (event.key === 'ctrl+c' || event.char === 'q') return app.quit();
    const rows = state.day?.appointments ?? [];
    if (event.name === 'up' || event.name === 'down') {
      if (rows.length) state.selected = (state.selected + (event.name === 'up' ? -1 : 1) + rows.length) % rows.length;
    } else if (event.name === 'left' || event.name === 'right') {
      state.date = shift(state.date, event.name === 'left' ? -1 : 1);
      return void load();
    } else if (event.char === 'r') return void load();
    app.invalidate();
  });

  app.render(({ ui, theme }) => {
    ui.column({ gap: 1 }, (root) => {
      root.panel({ title: `tleehealth · front desk · ${state.date}` }, (panel) => {
        panel.text('Up/Down pick · Left/Right day · r refresh · q quit', { fg: theme.muted });
        panel.text(state.status, { fg: theme.muted });
      });
      const rows = state.day?.appointments ?? [];
      const locations = [...new Set(rows.map((a) => a.location))];
      for (const loc of locations) {
        root.panel({ title: loc }, (panel) => {
          for (const a of rows) {
            if (a.location !== loc) continue;
            const i = rows.indexOf(a);
            const mark = i === state.selected ? '›' : ' ';
            panel.text(
              `${mark} ${a.time}  ${a.provider.padEnd(11)} ${a.patient.padEnd(11)} ${a.type.padEnd(14)} ${a.mode.padEnd(9)} ${a.status}`,
              { fg: i === state.selected ? theme.accent : undefined },
            );
          }
        });
      }
    });
  });

  void load();
  await app.start();
}
