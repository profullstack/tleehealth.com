// tleehealth app. Plain ES module, no build step. Talks only to /api/v1.

const root = document.getElementById('root');
const modal = document.getElementById('modal');
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TEAM = ['owner', 'org_manager', 'provider', 'staff', 'advocate'];
const ADMIN = ['owner', 'org_manager'];
const CLINICIAN = ['owner', 'provider'];
const BILLERS = ['owner', 'org_manager', 'provider'];
const TYPE_LABEL = { owner: 'Owner', org_manager: 'Org manager', provider: 'Provider', staff: 'Staff', advocate: 'Advocate', patient: 'Patient', lead: 'Lead' };
const STATUS = ['scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'];
const STATUS_BADGE = { scheduled: '', confirmed: 'b-ok', checked_in: 'b-info', completed: 'b-ok', cancelled: '', no_show: 'b-alert' };

/* ---------------------------------------------------------------- helpers -- */

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nice = (s) => String(s ?? '').replace(/_/g, ' ');
const todayISO = () => new Date().toLocaleDateString('en-CA');
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const range = (lo, hi) => (lo != null && hi != null ? `${lo}–${hi}` : hi != null ? `≤ ${hi}` : lo != null ? `≥ ${lo}` : '');
const dot = (...xs) => xs.filter(Boolean).join(' · ');
const CALL_BADGE = { queued: '', dialing: 'b-info', in_progress: 'b-info', completed: 'b-ok', no_answer: 'b-warn', voicemail: 'b-warn', failed: 'b-alert', skipped: '', cancelled: '' };
function callBadge(c) {
  if (!c) return '';
  const label =
    c.status === 'queued' ? `${c.kind === 'reminder' ? 'reminder' : 'follow-up'} ${fmtShort(c.due_at)}`
    : c.status === 'completed' ? (c.flagged ? 'needs follow-up' : 'done')
    : nice(c.status);
  const cls = c.status === 'completed' && c.flagged ? 'b-alert' : CALL_BADGE[c.status] ?? '';
  const title = c.summary || c.skip_reason || '';
  return `<span class="badge ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}
const fmtShort = (d) => {
  const x = new Date(d);
  const sameDay = x.toDateString() === new Date().toDateString();
  return sameDay ? fmtTime(x) : x.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
async function showCall(id) {
  const { call: c } = await get(`/orgs/${state.orgId}/calls/${id}`);
  const lines = (c.transcript ?? [])
    .filter((m) => m.content)
    .map((m) => `<div style="margin:6px 0"><span class="mono small ${m.role === 'assistant' ? 'dim' : ''}">${m.role === 'assistant' ? 'Agent' : 'Patient'}</span><div>${esc(m.content)}</div></div>`)
    .join('');
  openModal(
    `${c.kind === 'reminder' ? 'Reminder' : 'Follow-up'} call · ${esc(c.patient ?? '')}`,
    `<div class="stack">
      <dl class="kv"><dt>Status</dt><dd>${callBadge(c)}</dd><dt>When</dt><dd>${c.ended_at ? `${fmtDate(c.ended_at)} ${fmtTime(c.ended_at)}` : '—'}</dd>
      <dt>Attempts</dt><dd>${c.attempts}</dd>${c.summary ? `<dt>Summary</dt><dd>${esc(c.summary)}</dd>` : ''}${c.flag_reason ? `<dt>For staff</dt><dd class="flag-high">${esc(c.flag_reason)}</dd>` : ''}${c.skip_reason ? `<dt>Skipped</dt><dd>${esc(c.skip_reason)}</dd>` : ''}${c.last_error ? `<dt>Last error</dt><dd class="dim">${esc(c.last_error)}</dd>` : ''}</dl>
      ${lines ? `<div class="card"><div class="card-b" style="max-height:320px;overflow:auto">${lines}</div></div>` : '<p class="dim small">No transcript.</p>'}
      ${c.flagged && !c.resolved_at ? `<button class="primary" id="resolve-call">Mark handled</button>` : c.resolved_at ? '<span class="badge b-ok">handled</span>' : ''}
    </div>`,
  );
  document.getElementById('resolve-call')?.addEventListener('click', async () => {
    await post(`/orgs/${state.orgId}/calls/${c.id}/resolve`);
    modal.close();
    toast('Marked handled');
    render();
  });
}
const money = (cents) => (cents == null ? 'custom' : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`);
const shiftDay = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};
const logo = `<svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="8" stroke="#7CF2B0" stroke-width="2"/><path d="M6 15h4l2-5 4 9 2-4h4" stroke="#7CF2B0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.textContent = msg;
  if (bad) t.className = 'bad';
  document.getElementById('toast').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

class ApiError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    go('/signin');
    throw new ApiError('Please sign in');
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`);
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);

/** Run an action, toast its error, re-render on success. */
async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
    await render();
  } catch (err) {
    toast(err.message, true);
  }
}

/** Form values as an object; empty strings dropped. */
function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) if (v !== '') out[k] = v;
  return out;
}

function openModal(title, html, onSubmit) {
  modal.innerHTML = `<div class="m-h"><h2>${esc(title)}</h2><button type="button" class="sm" data-close aria-label="Close">Close</button></div><div class="m-b">${html}</div>`;
  modal.showModal();
  modal.querySelector('[data-close]').onclick = () => modal.close();
  const form = modal.querySelector('form');
  if (form && onSubmit)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const err = form.querySelector('.err');
      btn.disabled = true;
      try {
        await onSubmit(formData(form), e.submitter);
        modal.close();
        await render();
      } catch (ex) {
        if (err) err.textContent = ex.message;
        else toast(ex.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  form?.querySelector('input,select,textarea')?.focus();
}

/* ----------------------------------------------------------------- state -- */

const state = { me: null, orgId: null, org: null };
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function go(path) {
  if (location.pathname + location.search !== path) history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/app"], a[href^="/portal"], a[href="/signin"]');
  if (a && !e.metaKey && !e.ctrlKey && !a.target) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});

const me = () => state.org?.me ?? {};
const is = (types) => types.includes(me().user_type);

async function loadMe() {
  state.me = await get('/me');
  const ids = state.me.orgs.map((o) => o.id);
  state.orgId = ids.includes(store.get('org')) ? store.get('org') : ids[0] ?? null;
  state.org = state.orgId ? await get(`/orgs/${state.orgId}`) : null;
}

/* ---------------------------------------------------------------- router -- */

async function render() {
  const path = location.pathname;
  const q = new URLSearchParams(location.search);
  try {
    if (path === '/signin') return renderSignin(q);
    await loadMe();
    if (path.startsWith('/portal')) return renderPortal();
    if (!state.orgId) return state.me.patient_of.length && path !== '/app/new' ? go('/portal') : renderNewPractice();
    if (path === '/app/new') return renderNewPractice();

    const m = path.match(/^\/app\/patients\/([0-9a-f-]{36})$/);
    let view;
    if (m) view = await viewChart(m[1]);
    else if (path === '/app/patients') view = await viewPeople('patient', q);
    else if (path === '/app/leads') view = await viewPeople('lead', q);
    else if (path === '/app/team') view = await viewTeam();
    else if (path === '/app/caseload') view = await viewCaseload(q);
    else if (path === '/app/superbill' && is(BILLERS)) view = await viewSuperbill(q);
    else if (path === '/app/locations') view = viewLocations();
    else if (path === '/app/billing') view = await viewBilling(q);
    else if (path === '/app/settings') view = await viewSettings();
    else view = await viewToday(q);
    root.innerHTML = shell(path, view.html);
    bindShell();
    view.bind?.();
  } catch (err) {
    if (err instanceof ApiError && err.message === 'Please sign in') return;
    root.innerHTML = `<div class="center"><div class="auth"><h1>Something went wrong</h1><p class="muted">${esc(err.message)}</p><a class="btn" href="/app">Try again</a></div></div>`;
  }
}

/* ----------------------------------------------------------------- shell -- */

function shell(path, main) {
  const o = state.org;
  const navItem = (href, label, extra = '') =>
    `<a href="${href}" class="${path === href || (href !== '/app' && path.startsWith(href)) ? 'on' : ''}">${label}${extra}</a>`;
  return `<div class="shell">
  <aside class="side">
    <a class="brand" href="/app">${logo} tleehealth</a>
    <label class="f"><span class="label" style="padding:0">Practice</span>
      <select id="org-switch">
        ${state.me.orgs.map((x) => `<option value="${x.id}" ${x.id === state.orgId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        <option value="__new">+ New practice</option>
      </select></label>
    <div class="dim small" style="padding:0 4px">${esc(TYPE_LABEL[me().user_type])} · ${o.locations.length} location${o.locations.length === 1 ? '' : 's'}</div>
    <nav class="nav" aria-label="Practice">
      ${navItem('/app', 'Today')}
      ${navItem('/app/patients', 'Patients')}
      ${navItem('/app/leads', 'Leads')}
      ${navItem('/app/caseload', 'Caseload')}
      ${is(BILLERS) ? navItem('/app/superbill', 'Superbill') : ''}
      ${navItem('/app/team', 'Team')}
      ${navItem('/app/locations', 'Locations')}
      ${is(ADMIN) ? navItem('/app/billing', 'Billing', o.billing.active ? '' : '<span class="count">unpaid</span>') : ''}
      ${navItem('/app/settings', 'Settings')}
      ${state.me.patient_of.length ? navItem('/portal', 'My health') : ''}
    </nav>
  </aside>
  <main class="main" id="main">
    ${o.billing.active ? '' : `<div class="card"><div class="card-b row" style="justify-content:space-between"><span><span class="badge b-alert">read-only</span> This practice's trial has ended and it is unpaid.</span>${is(ADMIN) ? '<a class="btn primary sm" href="/app/billing">Pay now</a>' : ''}</div></div>`}
    ${main}
  </main></div>`;
}

function bindShell() {
  const sw = document.getElementById('org-switch');
  sw.onchange = () => {
    if (sw.value === '__new') return go('/app/new');
    store.set('org', sw.value);
    go('/app');
  };
}

/* --------------------------------------------------------------- sign-in -- */

function renderSignin(q) {
  const email = q.get('email') ?? '';
  root.innerHTML = `<div class="center"><div class="auth">
    <a class="brand" href="/" style="padding:0">${logo} tleehealth</a>
    <h1>Sign in</h1>
    ${q.get('error') === 'expired' ? '<p class="err">That link has expired or was already used. Send a new one.</p>' : ''}
    <form id="link-form" class="stack">
      <label class="f">Email<input name="email" type="email" autocomplete="email webauthn" required value="${esc(email)}"></label>
      <button class="primary" type="submit">Email me a sign-in link</button>
      <p class="err" id="link-err"></p>
    </form>
    <div class="or">or</div>
    <button id="passkey-btn" type="button">Sign in with a passkey</button>
    <p class="dim small">No passwords. New here? Enter your email and the link creates your account. Patients: use the email your practice has on file.</p>
  </div></div>`;
  document.getElementById('link-form').onsubmit = async (e) => {
    e.preventDefault();
    const { email } = formData(e.target);
    try {
      await post('/auth/link', { email });
      e.target.innerHTML = `<div class="card"><div class="card-b"><h2>Check your email</h2><p class="muted">We sent a sign-in link to <b>${esc(email)}</b>. It works once and expires in 20 minutes.</p></div></div>`;
    } catch (err) {
      document.getElementById('link-err').textContent = err.message;
    }
  };
  document.getElementById('passkey-btn').onclick = passkeySignIn;
}

async function passkeySignIn() {
  try {
    if (!window.SimpleWebAuthnBrowser) throw new Error('Passkeys are not available in this browser');
    const { options, challengeId } = await post('/auth/passkey/login/options');
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    await post('/auth/passkey/login/verify', { response, challengeId });
    go('/app');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled' : err.message, true);
  }
}

/* ---------------------------------------------------------- new practice -- */

function renderNewPractice() {
  const first = !state.me.orgs.length;
  root.innerHTML = `<div class="center"><div class="auth">
    <a class="brand" href="/app" style="padding:0">${logo} tleehealth</a>
    <h1>${first ? 'Set up your practice' : 'Add a practice'}</h1>
    <p class="muted">You'll be its owner. Add more offices, your team and patients next. The first 14 days are free; then $10 per team member per month, or $199 for up to 1,000.</p>
    <form class="stack" id="np">
      <label class="f">Practice name<input name="name" required placeholder="Lin Family Practice"></label>
      <label class="f">First office<input name="location" placeholder="Mission St"></label>
      <label class="f">Time zone<input name="timezone" value="${esc(TZ)}"></label>
      <button class="primary" type="submit">Create practice</button>
      <p class="err"></p>
    </form>
    ${first ? `<p class="dim small">Signed in as ${esc(state.me.user.email)}. A patient? Your practice adds you by email, and your records appear here. <button class="link" id="so">Sign out</button></p>` : '<a class="btn" href="/app">Cancel</a>'}
  </div></div>`;
  const f = document.getElementById('np');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { org } = await post('/orgs', formData(f));
      store.set('org', org.id);
      go('/app');
    } catch (err) {
      f.querySelector('.err').textContent = err.message;
    }
  };
  document.getElementById('so')?.addEventListener('click', signOut);
}

async function signOut() {
  await post('/auth/signout');
  location.href = '/signin';
}

/* ----------------------------------------------------------------- today -- */

async function viewToday(q) {
  const date = q.get('date') ?? todayISO();
  const loc = q.get('location') ?? '';
  const t = await get(`/orgs/${state.orgId}/today?date=${date}&tz=${encodeURIComponent(TZ)}`);
  const appts = loc ? t.appointments.filter((a) => a.location_id === loc) : t.appointments;
  const now = Date.now();
  const nowId = appts.find((a) => new Date(a.starts_at).getTime() + a.minutes * 60000 > now && new Date(a.starts_at).getTime() <= now)?.id;
  const n = t.needs;
  const clin = is(CLINICIAN);

  const rows = appts
    .map(
      (a) => `<tr class="${a.id === nowId ? 'now' : ''}">
      <td class="mono" style="white-space:nowrap">${fmtTime(a.starts_at)}<div class="dim small">${a.minutes} min</div></td>
      <td style="white-space:nowrap"><a href="/app/patients/${a.patient_id}">${esc(a.patient ?? 'Unnamed')}</a><div class="dim small">${esc(a.reason ?? '')}</div></td>
      <td class="muted">${esc(a.provider ?? '—')}</td>
      <td class="muted">${a.mode === 'video' ? 'Video' : esc(a.location ?? '—')}</td>
      <td><select class="inline" data-status="${a.id}" aria-label="Status">${STATUS.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${nice(s)}</option>`).join('')}</select></td>
      <td>${(() => {
        const r = a.calls?.find((x) => x.kind === 'reminder');
        const f = a.calls?.find((x) => x.kind === 'followup');
        // Before the visit the reminder matters; once it happened, the follow-up does.
        const after = ['completed', 'no_show', 'checked_in'].includes(a.status);
        const shown = after ? f ?? r : r && !['skipped', 'cancelled'].includes(r.status) ? r : f ?? r;
        return `<span class="row" style="gap:6px;flex-wrap:nowrap">${shown ? (['queued', 'skipped', 'cancelled'].includes(shown.status) ? callBadge(shown) : `<button class="link small" data-call="${shown.id}">${callBadge(shown)}</button>`) : '<span class="dim small">none</span>'}<button class="sm" data-callnow="${a.id}" data-kind="${['completed', 'no_show'].includes(a.status) ? 'followup' : 'reminder'}" title="Call the patient now">Call</button></span>`;
      })()}</td>
      <td>${clin ? `<button class="sm" data-summary="${a.id}">${a.summary_id ? (a.summary_status === 'signed' ? 'Summary ✓' : 'Summary draft') : 'Summary'}</button>` : a.summary_status ? `<span class="badge">${a.summary_status}</span>` : ''}</td>
    </tr>`,
    )
    .join('');

  const html = `
  <div class="head">
    <div><h1>${fmtDay(date)}</h1><div class="dim small">${appts.length} appointment${appts.length === 1 ? '' : 's'} · ${esc(state.org.org.name)}</div></div>
    <div class="row">
      <a class="btn sm" href="/app?date=${shiftDay(date, -1)}${loc ? `&location=${loc}` : ''}" aria-label="Previous day">‹</a>
      <a class="btn sm" href="/app">Today</a>
      <a class="btn sm" href="/app?date=${shiftDay(date, 1)}${loc ? `&location=${loc}` : ''}" aria-label="Next day">›</a>
      <input type="date" id="pick-date" value="${date}" style="width:auto" aria-label="Pick a date">
      <select id="pick-loc" class="inline" aria-label="Location"><option value="">All locations</option>${state.org.locations.map((l) => `<option value="${l.id}" ${l.id === loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <button class="primary" id="new-appt">New appointment</button>
    </div>
  </div>
  <div class="cols">
    <section class="card wide" aria-label="Schedule">
      <div class="card-h"><h2>Schedule</h2><span class="dim small mono">${esc(TZ)}</span></div>
      ${appts.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Patient</th><th>Provider</th><th>Where</th><th>Status</th><th>Agent call</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">Nothing booked${loc ? ' at this location' : ''} on this day. <button class="link" id="new-appt-2">Book an appointment</button></div>`}
    </section>
    <div class="narrow">
      <section class="card" aria-label="Needs a human">
        <div class="card-h"><h2>Needs a human</h2><span class="dim small">${n.calls.length + n.refills.length + n.labs.length + n.summaries.length}</span></div>
        ${
          n.calls.length + n.refills.length + n.labs.length + n.summaries.length
            ? `<ul class="list">
          ${n.calls
            .map(
              (c) => `<li><span><span class="${/URGENT/.test(c.flag_reason ?? '') ? 'flag-high' : ''}">${esc(c.flag_reason ?? c.summary)}</span><div class="sub"><a href="/app/patients/${c.patient_id}">${esc(c.patient)}</a> · ${c.kind === 'reminder' ? 'reminder' : 'follow-up'} call${c.phone ? ` · <span class="mono">${esc(c.phone)}</span>` : ''}</div></span>
              <button class="sm" data-call="${c.id}">Transcript</button></li>`,
            )
            .join('')}
          ${n.refills
            .map(
              (r) => `<li><span><span>Refill: ${esc(r.medication)} ${esc(r.dose ?? '')}</span><div class="sub"><a href="/app/patients/${r.patient_id}">${esc(r.patient)}</a></div></span>
              ${clin ? `<span class="row"><button class="sm primary" data-refill="${r.id}" data-d="approve">Approve</button><button class="sm" data-refill="${r.id}" data-d="deny">Deny</button></span>` : '<span class="badge b-warn">for a provider</span>'}</li>`,
            )
            .join('')}
          ${n.labs
            .map(
              (l) => `<li><span><span>Lab: ${esc(l.test_name)} ${esc(l.value ?? l.value_text)}${esc(l.unit ?? '')}</span><div class="sub"><a href="/app/patients/${l.patient_id}">${esc(l.patient)}</a> ${l.flag && l.flag !== 'normal' ? `<span class="flag-${l.flag}">· ${l.flag}</span>` : ''}</div></span>
              ${clin ? `<button class="sm" data-release="${l.id}">Release</button>` : '<span class="badge">unreleased</span>'}</li>`,
            )
            .join('')}
          ${n.summaries
            .map(
              (s) => `<li><span><span>Visit summary draft</span><div class="sub"><a href="/app/patients/${s.patient_id}">${esc(s.patient)}</a></div></span>
              ${clin && s.appointment_id ? `<button class="sm" data-summary="${s.appointment_id}">Review &amp; sign</button>` : '<span class="badge">draft</span>'}</li>`,
            )
            .join('')}
        </ul>`
            : '<div class="empty">All clear: no calls, refills, results or summaries waiting.</div>'
        }
      </section>
    </div>
  </div>`;

  return {
    html,
    bind() {
      const nav = (d, l) => go(`/app?date=${d}${l ? `&location=${l}` : ''}`);
      document.getElementById('pick-date').onchange = (e) => nav(e.target.value, loc);
      document.getElementById('pick-loc').onchange = (e) => nav(date, e.target.value);
      for (const id of ['new-appt', 'new-appt-2']) document.getElementById(id)?.addEventListener('click', () => appointmentModal({ date }));
      bindClinicalButtons(appts);
    },
  };
}

/** Status selects, refill/lab/summary buttons: shared by Today and the chart. */
function bindClinicalButtons(appts = []) {
  const main = document.getElementById('main');
  main.querySelectorAll('[data-status]').forEach((s) => {
    s.onchange = () => act(() => api('PATCH', `/orgs/${state.orgId}/appointments/${s.dataset.status}`, { status: s.value }), 'Status updated');
  });
  main.querySelectorAll('[data-refill]').forEach((b) => {
    b.onclick = () => act(() => post(`/orgs/${state.orgId}/refills/${b.dataset.refill}/${b.dataset.d}`), b.dataset.d === 'approve' ? 'Refill approved' : 'Refill denied');
  });
  main.querySelectorAll('[data-release]').forEach((b) => {
    b.onclick = () => act(() => post(`/orgs/${state.orgId}/labs/${b.dataset.release}/release`), 'Released to the patient');
  });
  main.querySelectorAll('[data-summary]').forEach((b) => {
    b.onclick = () => summaryModal(b.dataset.summary, appts);
  });
  main.querySelectorAll('[data-call]').forEach((b) => {
    b.onclick = () => showCall(b.dataset.call).catch((err) => toast(err.message, true));
  });
  main.querySelectorAll('[data-callnow]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const { call } = await post(`/orgs/${state.orgId}/appointments/${b.dataset.callnow}/call`, { kind: b.dataset.kind });
        toast(call.status === 'dialing' ? 'Calling now' : call.status === 'skipped' ? `Not called: ${call.skip_reason}` : call.status === 'no_answer' ? 'Outside calling hours; queued for the next window' : `Queued (${nice(call.status)})`, call.status === 'skipped');
        await render();
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
    };
  });
}

/* ------------------------------------------------------------ appointment -- */

async function appointmentModal({ date = todayISO(), patientId } = {}) {
  const [{ people }, { people: team }] = await Promise.all([
    get(`/orgs/${state.orgId}/people?type=patient,lead`),
    get(`/orgs/${state.orgId}/people?type=provider,owner`),
  ]);
  if (!people.length) {
    toast('Add a patient or lead first', true);
    return go('/app/patients');
  }
  openModal(
    'New appointment',
    `<form class="stack">
      <label class="f">Patient<select name="patient_id" required>${people
        .map((p) => `<option value="${p.id}" ${p.id === patientId ? 'selected' : ''}>${esc(p.name ?? p.email ?? p.phone)}${p.user_type === 'lead' ? ' (lead)' : ''}</option>`)
        .join('')}</select></label>
      <div class="grid2">
        <label class="f">Date<input type="date" name="date" value="${date}" required></label>
        <label class="f">Time<input type="time" name="time" value="09:00" required></label>
        <label class="f">Length<select name="minutes">${[15, 20, 30, 45, 60, 90].map((m) => `<option ${m === 30 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="f">Type<select name="mode"><option value="in_person">In person</option><option value="video">Video</option></select></label>
        <label class="f">Provider<select name="provider_id"><option value="">Unassigned</option>${team.map((p) => `<option value="${p.id}">${esc(p.name ?? p.email)}</option>`).join('')}</select></label>
        <label class="f">Location<select name="location_id"><option value="">None</option>${state.org.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
      </div>
      <label class="f">Reason<input name="reason" placeholder="Follow-up"></label>
      <label class="row small muted" style="gap:8px"><input type="checkbox" name="call_consent" value="yes" checked style="width:18px;min-height:18px"> Patient agreed to automated reminder and follow-up calls from our AI assistant</label>
      <p class="err"></p>
      <button class="primary" type="submit">Book</button>
    </form>`,
    async (d) => {
      const when = new Date(`${d.date}T${d.time}`);
      if (Number.isNaN(when.getTime()) || when.getFullYear() > 2200) throw new Error('Pick a valid date and time');
      const starts_at = when.toISOString();
      await post(`/orgs/${state.orgId}/appointments`, { ...d, starts_at, minutes: Number(d.minutes), call_consent: d.call_consent === 'yes' });
      toast('Booked');
    },
  );
}

async function summaryModal(appointmentId) {
  // The chart holds the current draft, if any.
  const day = await get(`/orgs/${state.orgId}/today?date=${todayISO()}&tz=${encodeURIComponent(TZ)}`).catch(() => null);
  let appt = day?.appointments.find((a) => a.id === appointmentId);
  let summary = null;
  let patientId = appt?.patient_id;
  if (!patientId) {
    const { summaries } = await get(`/orgs/${state.orgId}/summaries`);
    patientId = summaries.find((s) => s.appointment_id === appointmentId)?.patient_id;
  }
  if (patientId) {
    const chart = await get(`/orgs/${state.orgId}/patients/${patientId}`);
    summary = chart.summaries.find((s) => s.appointment_id === appointmentId) ?? null;
    appt ??= chart.appointments.find((a) => a.id === appointmentId);
  }
  const signed = summary?.status === 'signed';
  openModal(
    `Visit summary${appt ? ` · ${fmtDate(appt.starts_at)}` : ''}`,
    `<form class="stack">
      ${signed ? `<p class="badge b-ok">Signed ${fmtDate(summary.signed_at)}: visible to the patient, no longer editable</p>` : ''}
      <label class="f">Diagnosis<textarea name="diagnosis" ${signed ? 'disabled' : ''}>${esc(summary?.diagnosis)}</textarea></label>
      <label class="f">Instructions<textarea name="instructions" ${signed ? 'disabled' : ''}>${esc(summary?.instructions)}</textarea></label>
      <label class="f">Medication changes<textarea name="med_changes" ${signed ? 'disabled' : ''}>${esc(summary?.med_changes)}</textarea></label>
      <label class="f">Follow up on<input type="date" name="follow_up_on" value="${esc(summary?.follow_up_on?.slice?.(0, 10) ?? '')}" ${signed ? 'disabled' : ''}></label>
      <p class="err"></p>
      ${signed ? '' : '<div class="row"><button type="submit" name="act" value="save">Save draft</button><button class="primary" type="submit" name="act" value="sign">Sign &amp; send to patient</button></div>'}
    </form>`,
    signed
      ? null
      : async (d, submitter) => {
          const { summary: s } = await api('PUT', `/orgs/${state.orgId}/appointments/${appointmentId}/summary`, d);
          if (submitter?.value === 'sign') {
            await post(`/orgs/${state.orgId}/summaries/${s.id}/sign`);
            toast('Signed and released to the patient');
          } else toast('Draft saved');
        },
  );
}

/* ---------------------------------------------------------------- people -- */

async function viewPeople(type, q) {
  const search = q.get('q') ?? '';
  const { people } = await get(`/orgs/${state.orgId}/people?type=${type}${search ? `&q=${encodeURIComponent(search)}` : ''}`);
  const lead = type === 'lead';
  const html = `
  <div class="head"><h1>${lead ? 'Leads' : 'Patients'}</h1>
    <div class="row"><form id="search" role="search"><input name="q" type="search" placeholder="Search name, email, phone" value="${esc(search)}" aria-label="Search"></form>
    <button class="primary" id="add">${lead ? 'Add lead' : 'Add patient'}</button></div></div>
  <section class="card">
    ${
      people.length
        ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th>${lead ? '<th>Source</th>' : '<th>Portal</th>'}<th></th></tr></thead><tbody>
      ${people
        .map(
          (p) => `<tr><td>${lead ? esc(p.name ?? '—') : `<a href="/app/patients/${p.id}">${esc(p.name ?? p.email ?? 'Unnamed')}</a>`}</td>
          <td class="muted">${esc(p.email ?? '')}</td><td class="muted mono small">${esc(p.phone ?? '')}</td>
          <td>${lead ? esc(p.source ?? '') : p.has_account ? '<span class="badge b-ok">signed in</span>' : p.email ? '<span class="badge">invited</span>' : '<span class="dim small">no email</span>'}</td>
          <td style="text-align:right">${lead ? `<span class="row" style="justify-content:flex-end"><button class="sm" data-book="${p.id}">Book</button><button class="sm" data-convert="${p.id}">Make patient</button></span>` : `<button class="sm" data-book="${p.id}">Book</button>`}</td></tr>`,
        )
        .join('')}
      </tbody></table></div>`
        : `<div class="empty">${search ? 'No matches.' : lead ? 'No leads yet. Add people who asked about the practice; booking one makes them a patient.' : 'No patients yet. Add one, and they can sign in with their email to see visits, results and prescriptions.'}</div>`
    }
  </section>`;
  return {
    html,
    bind() {
      document.getElementById('search').onsubmit = (e) => {
        e.preventDefault();
        const v = new FormData(e.target).get('q');
        go(`/app/${lead ? 'leads' : 'patients'}${v ? `?q=${encodeURIComponent(v)}` : ''}`);
      };
      document.getElementById('add').onclick = () => personModal(type);
      document.querySelectorAll('[data-book]').forEach((b) => (b.onclick = () => appointmentModal({ patientId: b.dataset.book })));
      document.querySelectorAll('[data-convert]').forEach(
        (b) => (b.onclick = () => act(() => api('PATCH', `/orgs/${state.orgId}/people/${b.dataset.convert}`, { user_type: 'patient' }), 'Now a patient')),
      );
    },
  };
}

function personModal(type) {
  const team = TEAM.includes(type) || type === 'team';
  openModal(
    team ? 'Invite to the team' : type === 'lead' ? 'Add lead' : 'Add patient',
    `<form class="stack">
      ${team ? `<label class="f">Role<select name="user_type"><option value="provider">Provider</option><option value="staff">Staff</option><option value="advocate">Advocate (navigator)</option><option value="org_manager">Org manager</option></select></label>` : `<input type="hidden" name="user_type" value="${type}">`}
      <label class="f">Name<input name="name" ${team ? '' : 'required'}></label>
      <label class="f">Email<input name="email" type="email" ${team ? 'required' : ''}></label>
      <div class="grid2"><label class="f">Phone<input name="phone" type="tel"></label>
      ${type === 'patient' ? '<label class="f">Date of birth<input name="dob" type="date"></label>' : ''}
      ${type === 'lead' ? '<label class="f">Source<input name="source" placeholder="Newsletter, call, referral"></label>' : ''}</div>
      ${team ? '' : '<label class="row small muted" style="gap:8px"><input type="checkbox" name="call_consent" value="yes" style="width:18px;min-height:18px"> Agreed to automated calls from our AI assistant</label>'}
      ${team ? '<p class="dim small">Each team member is a $10/month seat (the practice pays $199/month at most). They get an email and sign in with it.</p>' : type === 'patient' ? '<p class="dim small">With an email, they get a note and can sign in to see their visits, results and prescriptions.</p>' : ''}
      <p class="err"></p>
      <button class="primary" type="submit">${team ? 'Send invite' : 'Add'}</button>
    </form>`,
    async (d) => {
      await post(`/orgs/${state.orgId}/people`, { ...d, call_consent: d.call_consent === 'yes' });
      toast(team ? 'Invited' : 'Added');
    },
  );
}

/* ----------------------------------------------------------------- chart -- */

async function viewChart(id) {
  const c = await get(`/orgs/${state.orgId}/patients/${id}`);
  const p = c.patient;
  const clin = is(CLINICIAN);
  const byTest = {};
  for (const l of c.labs) (byTest[l.test_name] ??= []).push(l);
  const html = `
  <div class="head">
    <div><a class="dim small" href="/app/patients">← Patients</a><h1>${esc(p.name ?? p.email ?? 'Patient')}</h1>
      <div class="dim small">${[p.dob ? `Born ${p.dob.slice(0, 10)}` : '', p.email, p.phone].filter(Boolean).map(esc).join(' · ')}</div></div>
    <div class="row"><button class="primary" id="book">Book appointment</button></div>
  </div>
  <div class="cols">
    <div class="wide stack">
      <section class="card"><div class="card-h"><h2>Appointments</h2></div>
        ${
          c.appointments.length
            ? `<div class="scroll"><table><tbody>${c.appointments
                .map(
                  (a) => `<tr><td class="mono small">${fmtDate(a.starts_at)} ${fmtTime(a.starts_at)}</td><td>${esc(a.reason ?? '')}<div class="dim small">${esc(a.provider ?? 'Unassigned')} · ${a.mode === 'video' ? 'Video' : esc(a.location ?? '')}</div></td>
                  <td><select class="inline" data-status="${a.id}" aria-label="Status">${STATUS.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${nice(s)}</option>`).join('')}</select></td>
                  <td style="text-align:right">${clin ? `<button class="sm" data-summary="${a.id}">Summary</button>` : ''}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<div class="empty">No appointments yet.</div>'
        }
      </section>
      ${p.user_type === 'patient' ? carePlanCard(c.care_plan) : ''}
      <section class="card"><div class="card-h"><h2>Results</h2><button class="sm" id="add-lab">Add result</button></div>
        ${
          c.labs.length
            ? `<div class="scroll"><table><thead><tr><th>Test</th><th>Result</th><th>Range</th><th>Date</th><th></th></tr></thead><tbody>${Object.entries(byTest)
                .flatMap(([, rows]) => rows)
                .map(
                  (l) => `<tr><td>${esc(l.test_name)}</td><td class="mono ${l.flag ? `flag-${l.flag}` : ''}">${esc(l.value ?? l.value_text)} ${esc(l.unit ?? '')}${l.flag && l.flag !== 'normal' ? ` · ${l.flag}` : ''}</td>
                  <td class="dim small mono">${esc(range(l.ref_low, l.ref_high))}</td><td class="dim small">${esc(String(l.collected_at).slice(0, 10))}</td>
                  <td style="text-align:right">${l.released_at ? '<span class="badge b-ok">released</span>' : clin ? `<button class="sm" data-release="${l.id}">Release</button>` : '<span class="badge">unreleased</span>'}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<div class="empty">No results yet.</div>'
        }
      </section>
      <section class="card"><div class="card-h"><h2>Visit summaries</h2></div>
        ${
          c.summaries.length
            ? `<ul class="list">${c.summaries
                .map(
                  (s) => `<li><span><span>${esc(s.diagnosis ?? 'No diagnosis')}</span><div class="sub">${esc(s.provider ?? '')} · ${s.status === 'signed' ? `signed ${fmtDate(s.signed_at)}` : 'draft'}</div></span>
                  ${s.appointment_id ? `<button class="sm" data-summary="${s.appointment_id}">${s.status === 'signed' ? 'View' : 'Edit'}</button>` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<div class="empty">Write one from an appointment.</div>'
        }
      </section>
    </div>
    <div class="narrow">
      ${p.user_type === 'patient' ? programsCard(c.programs, id) : ''}
      <section class="card"><div class="card-h"><h2>Medications</h2>${clin ? '<button class="sm" id="add-med">Prescribe</button>' : ''}</div>
        ${
          c.medications.length
            ? `<ul class="list">${c.medications
                .map(
                  (m) => `<li><span><span>${esc(m.name)} ${esc(m.dose ?? '')}</span><div class="sub">${esc(m.directions ?? '')}${m.status === 'stopped' ? ' · stopped' : ` · ${m.refills_left} refill${m.refills_left === 1 ? '' : 's'} left`}</div></span>
                  ${m.status === 'active' ? `<span class="row">${clin ? `<button class="sm danger" data-stop="${m.id}">Stop</button>` : `<button class="sm" data-req="${m.id}">Request refill</button>`}</span>` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<div class="empty">No medications on file.</div>'
        }
      </section>
      ${
        c.refills.length
          ? `<section class="card"><div class="card-h"><h2>Refill requests</h2></div><ul class="list">${c.refills
              .map(
                (r) => `<li><span><span>${esc(r.medication)}</span><div class="sub">${fmtDate(r.requested_at)}</div></span>${r.status === 'pending' && clin ? `<span class="row"><button class="sm primary" data-refill="${r.id}" data-d="approve">Approve</button><button class="sm" data-refill="${r.id}" data-d="deny">Deny</button></span>` : `<span class="badge ${r.status === 'approved' ? 'b-ok' : r.status === 'denied' ? 'b-alert' : 'b-warn'}">${r.status}</span>`}</li>`,
              )
              .join('')}</ul></section>`
          : ''
      }
      <section class="card"><div class="card-h"><h2>Agent calls</h2></div>
        ${
          c.calls.length
            ? `<ul class="list">${c.calls
                .map(
                  (x) => `<li><span><span>${x.kind === 'reminder' ? 'Reminder' : 'Follow-up'} ${callBadge(x)}</span><div class="sub">${esc(x.summary ?? x.skip_reason ?? (x.status === 'queued' ? `due ${fmtDate(x.due_at)} ${fmtTime(x.due_at)}` : ''))}</div></span>
                  ${x.has_transcript || x.summary ? `<button class="sm" data-call="${x.id}">View</button>` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<div class="empty">No calls yet. Each appointment gets a reminder before and a follow-up after.</div>'
        }
      </section>
      <section class="card"><div class="card-h"><h2>Details</h2></div><div class="card-b"><dl class="kv">
        <dt>Type</dt><dd>${TYPE_LABEL[p.user_type]}</dd>
        <dt>AI calls</dt><dd>${p.call_opt_out_at ? 'Opted out' : p.call_consent_at ? `Consented ${fmtDate(p.call_consent_at)}` : 'No consent on file'} <button class="link small" id="toggle-consent">${p.call_consent_at && !p.call_opt_out_at ? 'Turn off' : 'Record consent'}</button></dd>
        <dt>Portal</dt><dd>${p.user_id ? 'Signed in' : p.email ? 'Invited by email' : 'No email on file'}</dd>
        <dt>Added</dt><dd>${fmtDate(p.created_at)}</dd>
        ${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ''}
      </dl></div></section>
    </div>
  </div>`;
  return {
    html,
    bind() {
      document.getElementById('book').onclick = () => appointmentModal({ patientId: id });
      document.getElementById('toggle-consent').onclick = () => {
        const on = !(p.call_consent_at && !p.call_opt_out_at);
        if (on && !confirm('Record that this patient agreed to automated reminder and follow-up calls?')) return;
        act(() => api('PATCH', `/orgs/${state.orgId}/people/${id}`, { call_consent: on }), on ? 'Consent recorded' : 'Calls turned off');
      };
      bindClinicalButtons(c.appointments);
      if (p.user_type === 'patient') {
        bindCarePlan(id, c.care_plan);
        bindProgramButtons(c.programs);
        document.getElementById('enroll').onclick = () => enrollModal(id).catch((err) => toast(err.message, true));
      }
      document.getElementById('add-med')?.addEventListener('click', () =>
        openModal(
          'Prescribe',
          `<form class="stack"><label class="f">Medication<input name="name" required placeholder="Metformin"></label>
           <div class="grid2"><label class="f">Dose<input name="dose" placeholder="500 mg"></label><label class="f">Refills<input name="refills" type="number" min="0" value="0"></label></div>
           <label class="f">Directions<input name="directions" placeholder="Twice daily with food"></label>
           <p class="dim small">Prints and faxes for now; e-prescribing to pharmacies is coming.</p><p class="err"></p>
           <button class="primary" type="submit">Add to medications</button></form>`,
          async (d) => {
            await post(`/orgs/${state.orgId}/patients/${id}/medications`, { ...d, refills: Number(d.refills || 0) });
            toast('Prescribed');
          },
        ),
      );
      document.querySelectorAll('[data-stop]').forEach(
        (b) => (b.onclick = () => confirm('Stop this medication?') && act(() => api('PATCH', `/orgs/${state.orgId}/medications/${b.dataset.stop}`, { status: 'stopped' }), 'Stopped')),
      );
      document.querySelectorAll('[data-req]').forEach(
        (b) => (b.onclick = () => act(() => post(`/orgs/${state.orgId}/patients/${id}/refills`, { medication_id: b.dataset.req }), 'Refill requested')),
      );
      document.getElementById('add-lab').onclick = () =>
        openModal(
          'Add result',
          `<form class="stack"><label class="f">Test<input name="test_name" required placeholder="A1C"></label>
           <div class="grid2"><label class="f">Result<input name="value" required placeholder="7.9"></label><label class="f">Unit<input name="unit" placeholder="%"></label>
           <label class="f">Range low<input name="ref_low" inputmode="decimal"></label><label class="f">Range high<input name="ref_high" inputmode="decimal" placeholder="5.7"></label>
           <label class="f">Collected<input type="date" name="collected_at" value="${todayISO()}"></label></div>
           <label class="f">Notes<textarea name="notes"></textarea></label>
           <p class="dim small">Results stay hidden from the patient until a provider releases them.</p><p class="err"></p>
           <button class="primary" type="submit">Save result</button></form>`,
          async (d) => {
            await post(`/orgs/${state.orgId}/patients/${id}/labs`, d);
            toast('Saved');
          },
        );
    },
  };
}

/* ------------------------------------------------------------ navigation -- */
// Care plans, care-management programs (PIN, CHI, CCM) and the minutes logged
// toward their billing codes. Shared by the chart and the caseload.

const PROGRAM_NAME = { pin: 'PIN', pin_ps: 'PIN peer support', chi: 'CHI', ccm: 'CCM' };
const ACTIVITY_LABEL = {
  assessment: 'Assessment',
  care_plan: 'Care planning',
  coordination: 'Care coordination',
  referral: 'Referral',
  prior_auth: 'Prior authorization',
  scheduling: 'Scheduling',
  education: 'Education',
  community_resources: 'Community resources',
  call: 'Phone call',
  other: 'Other',
};
const thisMonthISO = () => todayISO().slice(0, 7);
const shiftMonth = (m, n) => {
  const d = new Date(`${m}-15T12:00:00`);
  d.setMonth(d.getMonth() + n);
  return d.toLocaleDateString('en-CA').slice(0, 7);
};
const fmtMonth = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });
const codesText = (r) => r.lines.map((l) => `${l.code}${l.units > 1 ? ` ×${l.units}` : ''}`).join(' + ');

/** Minutes toward the next unit, as a bar and a line of text. */
function progress(r) {
  const target = r.next_unit_in == null ? r.minutes : r.minutes + r.next_unit_in;
  const pct = target ? Math.min(100, Math.round((r.minutes / target) * 100)) : 0;
  const text = r.next_unit_in == null ? 'every unit earned this month' : `${r.next_unit_in} min to ${r.lines.length ? 'the next add-on' : 'the first code'}`;
  return `<div class="meter ${r.blockers.length ? 'held' : ''}" role="img" aria-label="${r.minutes} minutes, ${esc(text)}"><i style="width:${pct}%"></i></div>
    <div class="dim small">${r.minutes} min${r.lines.length ? ` · <b class="mono">${esc(codesText(r))}</b>` : ''} · ${esc(text)}</div>`;
}
const blockerBadge = (r) =>
  r.blockers.length ? `<span class="badge b-warn" title="${esc(r.blockers.join('\n'))}">${r.blockers.length === 1 ? esc(r.blockers[0]) : `${r.blockers.length} things missing`}</span>` : r.lines.length ? '<span class="badge b-ok">ready to bill</span>' : '';

function logTimeModal(programId, label = '') {
  openModal(
    `Log time${label ? ` · ${label}` : ''}`,
    `<form class="stack">
      <div class="grid2">
        <label class="f">Minutes<input name="minutes" type="number" min="1" max="240" required value="15"></label>
        <label class="f">Date<input name="performed_on" type="date" value="${todayISO()}" max="${todayISO()}"></label>
      </div>
      <label class="f">Activity<select name="activity">${Object.entries(ACTIVITY_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'coordination' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">What you did<textarea name="note" placeholder="Called the oncology office to move the port placement; prior auth sent to Aetna"></textarea></label>
      <p class="dim small">Count only your own time on this patient's navigation, and only once: the same minutes cannot go toward two programs.</p>
      <p class="err"></p><button class="primary" type="submit">Log time</button></form>`,
    async (d) => {
      const { program: r } = await post(`/orgs/${state.orgId}/programs/${programId}/time`, { ...d, minutes: Number(d.minutes) });
      toast(r?.lines.length ? `${r.minutes} min this month: ${codesText(r)}` : `${r?.minutes ?? d.minutes} min logged`);
    },
  );
}

async function timeModal(programId, label) {
  const month = thisMonthISO();
  const { time } = await get(`/orgs/${state.orgId}/programs/${programId}/time?month=${month}`);
  openModal(
    `${label} · ${fmtMonth(month)}`,
    time.length
      ? `<ul class="list">${time
          .map(
            (t) => `<li><span><span>${t.minutes} min · ${esc(ACTIVITY_LABEL[t.activity] ?? t.activity)}</span><div class="sub">${esc(dot(String(t.performed_on).slice(0, 10), t.by, t.note))}</div></span>
            <button class="sm danger" data-deltime="${t.id}">Delete</button></li>`,
          )
          .join('')}</ul>`
      : '<div class="empty">No time logged this month.</div>',
  );
  modal.querySelectorAll('[data-deltime]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm('Delete this time entry?')) return;
        try {
          await api('DELETE', `/orgs/${state.orgId}/time/${b.dataset.deltime}`);
          b.closest('li').remove();
          toast('Deleted');
          modal.addEventListener('close', () => render(), { once: true });
        } catch (err) {
          toast(err.message, true);
        }
      }),
  );
}

async function enrollModal(patientId) {
  const [{ programs }, { people: clinicians }, { people: team }] = await Promise.all([
    get('/navigation/programs'),
    get(`/orgs/${state.orgId}/people?type=provider,owner`),
    get(`/orgs/${state.orgId}/people?type=team`),
  ]);
  openModal(
    'Enroll in a program',
    `<form class="stack">
      <label class="f">Program<select name="program" id="prog-pick">${Object.entries(programs)
        .map(([k, p]) => `<option value="${k}">${esc(p.name)} (${p.first.code}/${p.addon.code})</option>`)
        .join('')}</select></label>
      <p class="dim small" id="prog-about">${esc(Object.values(programs)[0].about)}</p>
      <label class="f">Condition<input name="condition" required placeholder="Stage III colon cancer"></label>
      <div class="grid2">
        <label class="f">Billing practitioner<select name="billing_provider_id" required>${clinicians.map((p) => `<option value="${p.id}">${esc(p.name ?? p.email)}${p.npi ? '' : ' (no NPI yet)'}</option>`).join('')}</select></label>
        <label class="f">Navigator<select name="navigator_id">${team.map((p) => `<option value="${p.id}" ${p.id === me().person_id ? 'selected' : ''}>${esc(p.name ?? p.email)}</option>`).join('')}</select></label>
        <label class="f">Initiating visit<input name="initiating_visit_on" type="date" max="${todayISO()}"></label>
        <label class="f">Starts<input name="started_on" type="date" value="${todayISO()}"></label>
      </div>
      <p class="dim small">Leave the initiating visit blank to use the patient's last completed visit with the billing practitioner.</p>
      <label class="row small muted" style="gap:8px"><input type="checkbox" name="consent" value="yes" style="width:18px;min-height:18px"> The patient agreed to this program today, and was told about any cost sharing</label>
      <p class="err"></p><button class="primary" type="submit">Enroll</button></form>`,
    async (d) => {
      await post(`/orgs/${state.orgId}/patients/${patientId}/programs`, { ...d, consent: d.consent === 'yes' });
      toast('Enrolled');
    },
  );
  const pick = document.getElementById('prog-pick');
  pick.onchange = () => (document.getElementById('prog-about').textContent = programs[pick.value].about);
}

/** Program buttons on the chart and the caseload. */
function bindProgramButtons(rows) {
  const label = (id) => {
    const r = rows.find((x) => x.program_id === id);
    return r ? `${PROGRAM_NAME[r.program]} · ${r.patient ?? ''}` : '';
  };
  const main = document.getElementById('main');
  main.querySelectorAll('[data-logtime]').forEach((b) => (b.onclick = () => logTimeModal(b.dataset.logtime, label(b.dataset.logtime))));
  main.querySelectorAll('[data-timeview]').forEach((b) => (b.onclick = () => timeModal(b.dataset.timeview, label(b.dataset.timeview)).catch((err) => toast(err.message, true))));
  main.querySelectorAll('[data-consent-prog]').forEach(
    (b) =>
      (b.onclick = () =>
        confirm('Record that the patient agreed to this program today (and was told about cost sharing)?') &&
        act(() => api('PATCH', `/orgs/${state.orgId}/programs/${b.dataset.consentProg}`, { consent: true }), 'Consent recorded')),
  );
  main.querySelectorAll('[data-endprog]').forEach(
    (b) => (b.onclick = () => confirm('End this program? Time already logged still bills for its month.') && act(() => api('PATCH', `/orgs/${state.orgId}/programs/${b.dataset.endprog}`, { status: 'ended' }), 'Program ended')),
  );
}

function programsCard(rows, patientId) {
  return `<section class="card" aria-label="Programs"><div class="card-h"><h2>Programs</h2><button class="sm" id="enroll" data-patient="${patientId}">Enroll</button></div>
    ${
      rows.length
        ? `<ul class="list">${rows
            .map(
              (r) => `<li style="flex-direction:column;align-items:stretch"><div class="row" style="justify-content:space-between"><span><b>${esc(PROGRAM_NAME[r.program])}</b> <span class="muted">${esc(r.condition ?? '')}</span></span>${blockerBadge(r)}</div>
              ${progress(r)}
              <div class="dim small">${esc(dot(r.navigator && `navigator ${r.navigator}`, r.billing_provider && `bills under ${r.billing_provider}`))}</div>
              <div class="row"><button class="sm primary" data-logtime="${r.program_id}">Log time</button><button class="sm" data-timeview="${r.program_id}">Entries</button>${r.consent_at ? '' : `<button class="sm" data-consent-prog="${r.program_id}">Record consent</button>`}<button class="sm danger" data-endprog="${r.program_id}">End</button></div></li>`,
            )
            .join('')}</ul>`
        : '<div class="empty">Not enrolled. Navigation (PIN), community health integration (CHI) and chronic care management (CCM) pay for the coordination your team already does.</div>'
    }</section>`;
}

function carePlanCard(plan) {
  const items = plan?.items ?? [];
  const li = (i) => {
    const overdue = i.status === 'open' && i.due_on && String(i.due_on).slice(0, 10) < todayISO();
    return `<li><span><span class="${i.status === 'done' ? 'done-text' : ''}">${esc(i.text)}</span><div class="sub">${esc(dot(i.kind === 'task' && (i.owner ?? 'Patient'), i.due_on && `due ${String(i.due_on).slice(0, 10)}`))}${overdue ? ' · <span class="flag-high">overdue</span>' : ''}</div></span>
      <span class="row">${i.status === 'open' ? `<button class="sm" data-item="${i.id}" data-s="done">Done</button>` : `<button class="sm" data-item="${i.id}" data-s="open">Reopen</button>`}<button class="sm danger" data-item="${i.id}" data-s="dropped" aria-label="Remove">×</button></span></li>`;
  };
  const goals = items.filter((i) => i.kind === 'goal');
  const tasks = items.filter((i) => i.kind === 'task');
  return `<section class="card" aria-label="Care plan"><div class="card-h"><h2>${esc(plan?.title ?? 'Care plan')}</h2>
      <span class="row">${plan ? (plan.shared ? '<span class="badge b-ok">shared with patient</span>' : '<span class="badge">team only</span>') : ''}
      ${plan ? `<button class="sm" id="plan-share" data-on="${plan.shared ? '' : 'yes'}">${plan.shared ? 'Unshare' : 'Share'}</button>` : ''}<button class="sm" id="plan-edit">${plan ? 'Edit' : 'Start a plan'}</button><button class="sm primary" id="plan-add">Add</button></span></div>
    ${
      plan
        ? `${plan.summary ? `<div class="card-b muted" style="white-space:pre-line">${esc(plan.summary)}</div>` : ''}
      ${goals.length ? `<div class="label" style="padding:10px 18px 0">Goals</div><ul class="list">${goals.map(li).join('')}</ul>` : ''}
      ${tasks.length ? `<div class="label" style="padding:10px 18px 0">Tasks</div><ul class="list">${tasks.map(li).join('')}</ul>` : ''}
      ${items.length ? '' : '<div class="empty">No goals or tasks yet.</div>'}`
        : '<div class="empty">No care plan. Write down the problem, the goals, and who does what by when; share it so the patient sees it in their portal.</div>'
    }</section>`;
}

function bindCarePlan(patientId, plan) {
  document.getElementById('plan-edit').onclick = () =>
    openModal(
      'Care plan',
      `<form class="stack"><label class="f">Title<input name="title" value="${esc(plan?.title ?? 'Care plan')}"></label>
       <label class="f">Problem and approach<textarea name="summary" placeholder="What we are working on, and how">${esc(plan?.summary ?? '')}</textarea></label>
       <p class="err"></p><button class="primary" type="submit">Save</button></form>`,
      async (d) => {
        await api('PUT', `/orgs/${state.orgId}/patients/${patientId}/care-plan`, d);
        toast('Care plan saved');
      },
    );
  document.getElementById('plan-share')?.addEventListener('click', (e) => {
    const on = e.currentTarget.dataset.on === 'yes';
    act(() => api('PUT', `/orgs/${state.orgId}/patients/${patientId}/care-plan`, { shared: on }), on ? 'Shared to the portal' : 'Hidden from the portal');
  });
  document.getElementById('plan-add').onclick = async () => {
    const { people: team } = await get(`/orgs/${state.orgId}/people?type=team`);
    openModal(
      'Add to the care plan',
      `<form class="stack"><label class="f">Type<select name="kind"><option value="task">Task</option><option value="goal">Goal</option></select></label>
       <label class="f">What<input name="text" required placeholder="Get prior authorization for the PET scan"></label>
       <div class="grid2"><label class="f">Who<select name="owner_id"><option value="patient">The patient</option>${team.map((p) => `<option value="${p.id}" ${p.id === me().person_id ? 'selected' : ''}>${esc(p.name ?? p.email)}</option>`).join('')}</select></label>
       <label class="f">Due<input name="due_on" type="date"></label></div>
       <p class="err"></p><button class="primary" type="submit">Add</button></form>`,
      async (d) => {
        await post(`/orgs/${state.orgId}/patients/${patientId}/care-plan/items`, d);
        toast('Added');
      },
    );
  };
  document.querySelectorAll('[data-item]').forEach(
    (b) => (b.onclick = () => act(() => api('PATCH', `/orgs/${state.orgId}/care-plan-items/${b.dataset.item}`, { status: b.dataset.s }), b.dataset.s === 'done' ? 'Done' : b.dataset.s === 'dropped' ? 'Removed' : 'Reopened')),
  );
}

async function viewCaseload(q) {
  const month = q.get('month') ?? thisMonthISO();
  const scope = q.get('all') === '1' ? '&all=1' : q.get('mine') === '1' ? '&mine=1' : '';
  const { caseload, mine } = await get(`/orgs/${state.orgId}/caseload?month=${month}${scope}`);
  const link = (m, s = scope) => `/app/caseload?month=${m}${s}`;
  const ready = caseload.filter((r) => !r.blockers.length && r.lines.length).length;
  const html = `
  <div class="head">
    <div><h1>Caseload</h1><div class="dim small">${fmtMonth(month)} · ${caseload.length} enrollment${caseload.length === 1 ? '' : 's'} · ${ready} ready to bill</div></div>
    <div class="row">
      <a class="btn sm" href="${link(shiftMonth(month, -1))}" aria-label="Previous month">‹</a>
      <a class="btn sm" href="${link(thisMonthISO())}">This month</a>
      <a class="btn sm" href="${link(shiftMonth(month, 1))}" aria-label="Next month">›</a>
      <a class="btn sm" href="${link(month, mine ? '&all=1' : '&mine=1')}">${mine ? 'Everyone\'s patients' : 'Only mine'}</a>
    </div>
  </div>
  <section class="card">${
    caseload.length
      ? `<div class="scroll"><table><thead><tr><th>Patient</th><th>Program</th><th style="min-width:200px">This month</th><th>Tasks</th><th>Billing</th><th></th></tr></thead><tbody>${caseload
          .map(
            (r) => `<tr><td><a href="/app/patients/${r.patient_id}">${esc(r.patient ?? 'Unnamed')}</a><div class="dim small">${esc(r.navigator ?? '')}</div></td>
            <td>${esc(PROGRAM_NAME[r.program])}<div class="dim small">${esc(r.condition ?? '')}</div></td>
            <td>${progress(r)}</td>
            <td>${r.open_tasks ? `${r.open_tasks} open${r.overdue_tasks ? ` · <span class="flag-high">${r.overdue_tasks} overdue</span>` : ''}` : '<span class="dim small">none</span>'}</td>
            <td>${blockerBadge(r)}</td>
            <td style="text-align:right"><span class="row" style="justify-content:flex-end;flex-wrap:nowrap"><button class="sm primary" data-logtime="${r.program_id}">Log time</button><button class="sm" data-timeview="${r.program_id}">Entries</button></span></td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : `<div class="empty">${mine ? 'No patients are assigned to you yet. ' : ''}Enroll patients from their chart (Programs → Enroll); they show up here with their minutes toward each month's billing codes.</div>`
  }</section>
  <p class="dim small">Minutes count toward PIN (G0023 at 60, G0024 per 30 more), CHI (G0019/G0022) and CCM (99490 at 20, 99439 per 20 more, up to two). The superbill lists what is ready.</p>`;
  return { html, bind: () => bindProgramButtons(caseload) };
}

async function viewSuperbill(q) {
  const month = q.get('month') ?? thisMonthISO();
  const sb = await get(`/orgs/${state.orgId}/superbill?month=${month}`);
  const link = (m) => `/app/superbill?month=${m}`;
  const totals = Object.entries(sb.totals);
  const html = `
  <div class="head">
    <div><h1>Superbill</h1><div class="dim small">${fmtMonth(month)} · ${sb.ready} ready · ${sb.held} on hold · ${sb.under} under the time threshold</div></div>
    <div class="row">
      <a class="btn sm" href="${link(shiftMonth(month, -1))}" aria-label="Previous month">‹</a>
      <a class="btn sm" href="${link(thisMonthISO())}">This month</a>
      <a class="btn sm" href="${link(shiftMonth(month, 1))}" aria-label="Next month">›</a>
      <a class="btn primary sm" href="/api/v1/orgs/${state.orgId}/superbill?month=${month}&format=csv" download>Download CSV</a>
    </div>
  </div>
  <div class="cols">
    <section class="card wide">${
      sb.rows.length
        ? `<div class="scroll"><table><thead><tr><th>Patient</th><th>Program</th><th>Billing practitioner</th><th>Minutes</th><th>Codes</th><th>Status</th></tr></thead><tbody>${sb.rows
            .map(
              (r) => `<tr><td style="white-space:nowrap"><a href="/app/patients/${r.patient_id}">${esc(r.patient ?? 'Unnamed')}</a><div class="dim small">${r.dob ? `born ${esc(r.dob)}` : ''}</div></td>
              <td>${esc(r.program_name)}<div class="dim small">${esc(r.condition ?? '')}</div></td>
              <td>${esc(r.billing_provider ?? '—')}<div class="dim small mono">${esc(r.billing_npi ?? '')}</div></td>
              <td class="mono">${r.minutes}</td>
              <td class="mono">${r.lines.length ? esc(codesText(r)) : `<span class="dim small">${r.next_unit_in} min short</span>`}</td>
              <td>${r.ready ? '<span class="badge b-ok">ready</span>' : r.lines.length ? `<span class="badge b-warn" title="${esc(r.blockers.join('\n'))}">hold</span><div class="dim small">${esc(r.blockers.join('; '))}</div>` : '<span class="badge">under threshold</span>'}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : '<div class="empty">No navigation time logged this month.</div>'
    }</section>
    <div class="narrow">
      <section class="card"><div class="card-h"><h2>Ready to bill</h2></div>${
        totals.length ? `<ul class="list">${totals.map(([code, n]) => `<li><span class="mono">${esc(code)}</span><span class="mono">× ${n}</span></li>`).join('')}</ul>` : '<div class="empty">Nothing ready yet.</div>'
      }</section>
      <section class="card"><div class="card-b dim small stack">
        <span>One line per code, per patient, per month, for your biller or clearinghouse. Prices vary by locality, so none are shown.</span>
        <span>A code counts only when its full time is met: 60 minutes for G0023 (and G0019, G0140), 30 more for each add-on, 20 for CCM. Medicare does not allow rounding up from 31 minutes on these codes.</span>
        <span>On hold means a claim would be missing something: consent (renewed yearly for PIN and CHI), the initiating visit, the billing practitioner's NPI, or for CCM a care plan.</span>
      </div></section>
    </div>
  </div>`;
  return {
    html,
  };
}

/* ------------------------------------------------------------------ team -- */

async function viewTeam() {
  const { people } = await get(`/orgs/${state.orgId}/people?type=team`);
  const admin = is(ADMIN);
  const html = `
  <div class="head"><div><h1>Team</h1><div class="dim small">${people.length} seat${people.length === 1 ? '' : 's'} · patients and leads are free</div></div>
    ${admin ? '<button class="primary" id="invite">Invite</button>' : ''}</div>
  <section class="card"><div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>NPI</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${people
      .map(
        (p) => `<tr><td>${esc(p.name ?? '—')}</td><td class="muted">${esc(p.email ?? '')}</td>
        <td>${CLINICIAN.includes(p.user_type) ? (admin ? `<button class="link small mono" data-npi="${p.id}" data-v="${esc(p.npi ?? '')}">${esc(p.npi ?? 'add NPI')}</button>` : `<span class="mono small">${esc(p.npi ?? '—')}</span>`) : '<span class="dim small">—</span>'}</td>
        <td>${admin && p.user_type !== 'owner' ? `<select class="inline" data-role="${p.id}" aria-label="Role">${['org_manager', 'provider', 'staff', 'advocate'].map((t) => `<option value="${t}" ${t === p.user_type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select>` : `<span class="badge b-team">${TYPE_LABEL[p.user_type]}</span>`}</td>
        <td>${p.has_account ? '<span class="badge b-ok">active</span>' : '<span class="badge">invited</span>'}</td>
        <td style="text-align:right">${admin && p.user_type !== 'owner' ? `<button class="sm danger" data-remove="${p.id}">Remove</button>` : ''}</td></tr>`,
      )
      .join('')}
  </tbody></table></div></section>`;
  return {
    html,
    bind() {
      document.getElementById('invite')?.addEventListener('click', () => personModal('team'));
      document.querySelectorAll('[data-npi]').forEach(
        (b) =>
          (b.onclick = () =>
            openModal(
              'NPI',
              `<form class="stack"><label class="f">National Provider Identifier<input name="npi" inputmode="numeric" pattern="\\d{10}" maxlength="10" value="${esc(b.dataset.v)}" placeholder="10 digits"></label>
               <p class="dim small">Printed on the superbill as the billing practitioner. Look it up at npiregistry.cms.hhs.gov.</p><p class="err"></p>
               <button class="primary" type="submit">Save</button></form>`,
              async (d) => {
                await api('PATCH', `/orgs/${state.orgId}/people/${b.dataset.npi}`, { npi: d.npi ?? '' });
                toast('NPI saved');
              },
            )),
      );
      document.querySelectorAll('[data-role]').forEach(
        (s) => (s.onchange = () => act(() => api('PATCH', `/orgs/${state.orgId}/people/${s.dataset.role}`, { user_type: s.value }), 'Role changed')),
      );
      document.querySelectorAll('[data-remove]').forEach(
        (b) => (b.onclick = () => confirm('Remove this person from the team?') && act(() => api('DELETE', `/orgs/${state.orgId}/people/${b.dataset.remove}`), 'Removed')),
      );
    },
  };
}

/* ------------------------------------------------------------- locations -- */

function viewLocations() {
  const admin = is(ADMIN);
  const html = `
  <div class="head"><h1>Locations</h1>${admin ? '<button class="primary" id="add-loc">Add location</button>' : ''}</div>
  <section class="card">${
    state.org.locations.length
      ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Address</th><th>Phone</th><th>Time zone</th><th></th></tr></thead><tbody>${state.org.locations
          .map(
            (l) => `<tr><td>${esc(l.name)}</td><td class="muted">${esc(l.address ?? '')}</td><td class="muted mono small">${esc(l.phone ?? '')}</td><td class="dim small">${esc(l.timezone)}</td>
            <td style="text-align:right">${admin ? `<button class="sm" data-edit="${l.id}">Edit</button> <button class="sm danger" data-del="${l.id}">Delete</button>` : ''}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : '<div class="empty">No locations yet. Video-only practices can skip this.</div>'
  }</section>`;
  const form = (l = {}) => `<form class="stack"><label class="f">Name<input name="name" required value="${esc(l.name ?? '')}" placeholder="Valencia"></label>
    <label class="f">Address<input name="address" value="${esc(l.address ?? '')}"></label>
    <div class="grid2"><label class="f">Phone<input name="phone" type="tel" value="${esc(l.phone ?? '')}"></label><label class="f">Time zone<input name="timezone" value="${esc(l.timezone ?? TZ)}"></label></div>
    <p class="err"></p><button class="primary" type="submit">Save</button></form>`;
  return {
    html,
    bind() {
      document.getElementById('add-loc')?.addEventListener('click', () =>
        openModal('Add location', form(), async (d) => {
          await post(`/orgs/${state.orgId}/locations`, d);
          toast('Location added');
        }),
      );
      document.querySelectorAll('[data-edit]').forEach(
        (b) =>
          (b.onclick = () =>
            openModal('Edit location', form(state.org.locations.find((l) => l.id === b.dataset.edit)), async (d) => {
              await api('PATCH', `/orgs/${state.orgId}/locations/${b.dataset.edit}`, d);
              toast('Saved');
            })),
      );
      document.querySelectorAll('[data-del]').forEach(
        (b) => (b.onclick = () => confirm('Delete this location? Its appointments stay, without a location.') && act(() => api('DELETE', `/orgs/${state.orgId}/locations/${b.dataset.del}`), 'Deleted')),
      );
    },
  };
}

/* --------------------------------------------------------------- billing -- */

async function viewBilling(q) {
  const { billing: b, payments } = await get(`/orgs/${state.orgId}/billing`);
  const html = `
  <div class="head"><h1>Billing</h1></div>
  ${q.get('paid') ? '<div class="card"><div class="card-b">Thanks. Your month is added as soon as CoinPay confirms the payment, usually within a few minutes.</div></div>' : ''}
  <div class="cols">
    <section class="card wide"><div class="card-h"><h2>${esc(state.org.org.name)}</h2>${b.active ? '<span class="badge b-ok">active</span>' : '<span class="badge b-alert">unpaid</span>'}</div>
      <div class="card-b stack">
        <dl class="kv">
          <dt>Team seats</dt><dd>${b.seats}</dd>
          <dt>Monthly price</dt><dd><b>${money(b.monthly_cents)}</b> <span class="dim small">($10 × ${b.seats}, never more than $199 up to 1,000 seats)</span></dd>
          <dt>Paid through</dt><dd>${b.paid_through ? fmtDate(b.paid_through) : '—'}</dd>
          <dt>Free trial</dt><dd>${new Date(b.trial_ends) > new Date() ? `ends ${fmtDate(b.trial_ends)}` : 'ended'}</dd>
        </dl>
        ${b.payments_enabled ? `<div><button class="primary" id="pay">Pay ${money(b.monthly_cents)} for one month</button></div><p class="dim small">Paid in crypto (USDC and other coins) through CoinPay. Each payment adds one month.</p>` : '<p class="muted">Online payment is not switched on yet. Your practice keeps working; we will email the owner before it is needed.</p>'}
      </div></section>
    <section class="card narrow"><div class="card-h"><h2>Payments</h2></div>
      ${payments.length ? `<ul class="list">${payments.map((p) => `<li><span>${money(p.amount_cents)}<div class="sub">${fmtDate(p.created_at)}</div></span><span class="badge">${esc(p.status)}</span></li>`).join('')}</ul>` : '<div class="empty">No payments yet.</div>'}
    </section>
  </div>`;
  return {
    html,
    bind() {
      document.getElementById('pay')?.addEventListener('click', async () => {
        try {
          const { checkout_url } = await post(`/orgs/${state.orgId}/billing/checkout`);
          location.href = checkout_url;
        } catch (err) {
          toast(err.message, true);
        }
      });
    },
  };
}

/* -------------------------------------------------------------- settings -- */

async function viewSettings() {
  const [{ keys }, cs] = await Promise.all([get('/keys'), get(`/orgs/${state.orgId}/call-settings`)]);
  const s = cs.settings;
  const html = `
  <div class="head"><h1>Settings</h1><button id="signout">Sign out</button></div>
  <div class="cols">
    <div class="wide stack">
      <section class="card"><div class="card-h"><h2>You</h2></div><div class="card-b">
        <form id="me-form" class="row"><label class="f" style="flex:1">Name<input name="name" value="${esc(state.me.user.name ?? '')}"></label><button type="submit" style="align-self:flex-end">Save</button></form>
        <p class="dim small">${esc(state.me.user.email)}</p></div></section>
      <section class="card"><div class="card-h"><h2>Passkeys</h2><button class="sm" id="add-passkey">Add a passkey</button></div>
        <div class="card-b muted">${state.me.passkeys ? `${state.me.passkeys} passkey${state.me.passkeys === 1 ? '' : 's'} saved. Sign in with Face ID, Touch ID or your security key.` : 'Add one to sign in without waiting for an email.'}</div></section>
      ${is(ADMIN) ? `<section class="card"><div class="card-h"><h2>AI calls</h2>${cs.calling_configured ? '' : '<span class="badge b-warn">not connected yet</span>'}</div><div class="card-b">
        <form id="calls-form" class="stack">
          <label class="row" style="gap:8px"><input type="checkbox" name="enabled" value="yes" ${s.enabled ? 'checked' : ''} style="width:18px;min-height:18px"> Call every patient before and after each visit</label>
          <div class="grid2">
            <label class="f">Reminder, hours before<input name="reminder_hours_before" type="number" min="1" max="168" value="${s.reminder_hours_before}"></label>
            <label class="f">Follow-up, hours after<input name="followup_hours_after" type="number" min="1" max="168" value="${s.followup_hours_after}"></label>
            <label class="f">Call from (local hour)<input name="call_window_start" type="number" min="0" max="23" value="${s.call_window_start}"></label>
            <label class="f">Call until (local hour)<input name="call_window_end" type="number" min="1" max="24" value="${s.call_window_end}"></label>
            <label class="f">Attempts per call<input name="max_attempts" type="number" min="1" max="5" value="${s.max_attempts}"></label>
          </div>
          <p class="dim small">Only patients who agreed to automated calls are called, and the assistant always says it is automated. It confirms, cancels or takes reschedule requests, and passes anything clinical to your team under Needs a human.</p>
          <div><button type="submit">Save call settings</button></div>
        </form></div></section>
      <section class="card"><div class="card-h"><h2>Practice</h2></div><div class="card-b"><form id="org-form" class="row"><label class="f" style="flex:1">Practice name<input name="name" value="${esc(state.org.org.name)}"></label><button type="submit" style="align-self:flex-end">Rename</button></form></div></section>` : ''}
    </div>
    <section class="card narrow"><div class="card-h"><h2>API keys</h2><button class="sm" id="new-key">New key</button></div>
      <div class="card-b dim small">For the CLI, TUI and MCP server: <span class="mono">tleehealth login</span> or <span class="mono">TLEEHEALTH_API_KEY</span>.</div>
      ${keys.length ? `<ul class="list">${keys.map((k) => `<li><span class="mono small">${esc(k.prefix)}…<div class="sub">${esc(k.name)} · ${k.last_used_at ? `used ${fmtDate(k.last_used_at)}` : 'never used'}</div></span><button class="sm danger" data-revoke="${k.id}">Revoke</button></li>`).join('')}</ul>` : ''}
    </section>
  </div>`;
  return {
    html,
    bind() {
      document.getElementById('signout').onclick = signOut;
      document.getElementById('me-form').onsubmit = (e) => {
        e.preventDefault();
        act(() => api('PATCH', '/me', formData(e.target)), 'Saved');
      };
      document.getElementById('calls-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const d = formData(e.target);
        act(() => api('PUT', `/orgs/${state.orgId}/call-settings`, { ...d, enabled: d.enabled === 'yes' }), 'Call settings saved');
      });
      document.getElementById('org-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('PATCH', `/orgs/${state.orgId}`, formData(e.target)), 'Renamed');
      });
      document.getElementById('add-passkey').onclick = async () => {
        try {
          if (!window.SimpleWebAuthnBrowser) throw new Error('Passkeys are not available in this browser');
          const { options, challengeId } = await post('/auth/passkey/register/options');
          const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
          await post('/auth/passkey/register/verify', { response, challengeId });
          toast('Passkey saved');
          render();
        } catch (err) {
          toast(err.name === 'NotAllowedError' ? 'Cancelled' : err.message, true);
        }
      };
      document.getElementById('new-key').onclick = async () => {
        try {
          const k = await post('/keys', { name: 'cli' });
          openModal('Your new API key', `<div class="stack"><p class="muted">Copy it now. It is shown once.</p><div class="keybox">${esc(k.key)}</div><p class="dim small mono">export TLEEHEALTH_API_KEY=${esc(k.key)}</p></div>`);
          modal.addEventListener('close', () => render(), { once: true });
        } catch (err) {
          toast(err.message, true);
        }
      };
      document.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = () => act(() => api('DELETE', `/keys/${b.dataset.revoke}`), 'Revoked')));
    },
  };
}

/* ---------------------------------------------------------------- portal -- */

async function renderPortal() {
  const { practices } = await get('/portal');
  const name = state.me.user.name?.split(' ')[0];
  const body = practices.length
    ? practices
        .map((pr) => {
          const next = pr.appointments.find((a) => new Date(a.starts_at) > new Date());
          const tests = {};
          for (const l of pr.labs) (tests[l.test_name] ??= []).push(l);
          return `<div class="dim small">${esc(pr.org.name)}</div>
      ${
        next
          ? `<section class="hero-card" aria-label="Next visit"><div class="eyebrow">Next visit · ${next.mode === 'video' ? 'video' : 'in person'}</div>
            <div><div style="font-size:24px;font-weight:600;letter-spacing:-.02em">${fmtDate(next.starts_at)} · ${fmtTime(next.starts_at)}</div>
            <div class="muted small">${esc(dot(next.provider, next.reason, next.mode !== 'video' && next.location ? [next.location, next.address].filter(Boolean).join(', ') : ''))}</div></div>
            <div class="row">${['scheduled', 'confirmed'].includes(next.status) ? `${next.status === 'confirmed' ? '<span class="badge b-ok">confirmed</span>' : `<button class="primary" data-pa="${next.id}" data-x="confirm">Confirm</button>`}<button data-pa="${next.id}" data-x="cancel">Cancel visit</button>` : `<span class="badge ${STATUS_BADGE[next.status]}">${nice(next.status)}</span>`}</div></section>`
          : '<section class="card"><div class="empty">No upcoming visits. Call the practice to book.</div></section>'
      }
      ${pr.appointments.length > 1 ? `<section class="card"><div class="card-h"><h2>Upcoming</h2></div><ul class="list">${pr.appointments.slice(1).map((a) => `<li><span>${fmtDate(a.starts_at)} ${fmtTime(a.starts_at)}<div class="sub">${esc(a.provider ?? '')} · ${a.mode === 'video' ? 'video' : esc(a.location ?? '')}</div></span><span class="badge ${STATUS_BADGE[a.status]}">${nice(a.status)}</span></li>`).join('')}</ul></section>` : ''}
      ${
        pr.care_plan
          ? `<section class="card" aria-label="Your care plan"><div class="card-h"><h2>${esc(pr.care_plan.title)}</h2><span class="dim small">${esc(pr.care_plan.owner ? `with ${pr.care_plan.owner}` : '')}</span></div>
        ${pr.care_plan.summary ? `<div class="card-b muted" style="white-space:pre-line">${esc(pr.care_plan.summary)}</div>` : ''}
        ${pr.care_plan.items.length ? `<ul class="list">${pr.care_plan.items
          .map(
            (i) => `<li><span><span class="${i.status === 'done' ? 'done-text' : ''}">${i.kind === 'goal' ? '<b>Goal:</b> ' : ''}${esc(i.text)}</span><div class="sub">${esc(dot(i.kind === 'task' && i.owner, i.due_on && `by ${String(i.due_on).slice(0, 10)}`))}</div></span>${i.status === 'done' ? '<span class="badge b-ok">done</span>' : ''}</li>`,
          )
          .join('')}</ul>` : ''}</section>`
          : ''
      }
      <section class="card"><div class="card-h"><h2>Results</h2></div>${
        pr.labs.length
          ? `<ul class="list">${Object.entries(tests)
              .map(([t, rows]) => {
                const l = rows[0];
                const trend = rows.length > 1 ? ` <span class="dim small">· was ${esc(rows[1].value ?? rows[1].value_text)}</span>` : '';
                return `<li><span><span>${esc(t)}</span><div class="sub">${esc(String(l.collected_at).slice(0, 10))}${range(l.ref_low, l.ref_high) ? ` · range ${esc(range(l.ref_low, l.ref_high))}` : ''}</div></span><span class="mono ${l.flag ? `flag-${l.flag}` : ''}">${esc(l.value ?? l.value_text)}${esc(l.unit ?? '')}${trend}</span></li>`;
              })
              .join('')}</ul>`
          : '<div class="empty">Results appear here once your provider releases them.</div>'
      }</section>
      <section class="card"><div class="card-h"><h2>Medications</h2></div>${
        pr.medications.length
          ? `<ul class="list">${pr.medications
              .map(
                (m) => `<li><span><span>${esc(m.name)} ${esc(m.dose ?? '')}</span><div class="sub">${esc(m.directions ?? '')} · ${m.refills_left} refill${m.refills_left === 1 ? '' : 's'} left</div></span>
                ${m.refill_pending ? '<span class="badge b-warn">refill requested</span>' : `<button class="sm" data-refill-me="${m.id}">Request refill</button>`}</li>`,
              )
              .join('')}</ul>`
          : '<div class="empty">No medications on file.</div>'
      }</section>
      <section class="card"><div class="card-b row" style="justify-content:space-between"><span><b>Reminder calls</b><div class="dim small">${pr.calls_ok ? 'Our automated assistant calls before and after each visit.' : 'You will not get automated calls.'}</div></span>
        <button class="sm" data-calls="${pr.org.id}" data-on="${pr.calls_ok ? '' : 'yes'}">${pr.calls_ok ? 'Turn off' : 'Turn on'}</button></div></section>
      ${pr.summaries.length ? `<section class="card"><div class="card-h"><h2>Visit summaries</h2></div><div class="card-b stack">${pr.summaries.map((s) => `<div><div class="dim small">${esc(dot(fmtDate(s.signed_at), s.provider))}</div>${s.diagnosis ? `<div><b>${esc(s.diagnosis)}</b></div>` : ''}${s.instructions ? `<div class="muted" style="white-space:pre-line">${esc(s.instructions)}</div>` : ''}${s.med_changes ? `<div class="small">Medication changes: ${esc(s.med_changes)}</div>` : ''}${s.follow_up_on ? `<div class="small">Follow up: ${esc(String(s.follow_up_on).slice(0, 10))}</div>` : ''}</div>`).join('<hr style="border:0;border-top:1px solid var(--line);width:100%">')}</div></section>` : ''}`;
        })
        .join('')
    : `<section class="card"><div class="card-b"><h2>Nothing here yet</h2><p class="muted">Your practice adds you with this email address (${esc(state.me.user.email)}). Once they do, your visits, results and prescriptions show up here.</p></div></section>`;
  root.innerHTML = `<div class="portal">
    <div class="head"><a class="brand" href="/portal" style="padding:0">${logo} tleehealth</a><div class="row">${state.me.orgs.length ? '<a class="btn sm" href="/app">Practice</a>' : ''}<button class="sm" id="signout">Sign out</button></div></div>
    <h1>${name ? `Hi, ${esc(name)}` : 'Your health'}</h1>
    ${body}</div>`;
  document.getElementById('signout').onclick = signOut;
  root.querySelectorAll('[data-pa]').forEach(
    (b) =>
      (b.onclick = () =>
        (b.dataset.x !== 'cancel' || confirm('Cancel this visit?')) &&
        act(() => post(`/portal/appointments/${b.dataset.pa}/${b.dataset.x}`), b.dataset.x === 'confirm' ? 'Confirmed' : 'Cancelled')),
  );
  root.querySelectorAll('[data-calls]').forEach(
    (b) => (b.onclick = () => act(() => post('/portal/calls', { org_id: b.dataset.calls, calls_ok: b.dataset.on === 'yes' }), b.dataset.on === 'yes' ? 'Reminder calls on' : 'Reminder calls off')),
  );
  root.querySelectorAll('[data-refill-me]').forEach((b) => (b.onclick = () => act(() => post('/portal/refills', { medication_id: b.dataset.refillMe }), 'Refill requested')));
}

render();
