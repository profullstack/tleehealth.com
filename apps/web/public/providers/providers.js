const form = document.getElementById('dir-form');
const status = document.getElementById('dir-status');
const resultsCard = document.getElementById('results-card');
const results = document.getElementById('results');
const detailCard = document.getElementById('detail-card');
const searchCard = document.getElementById('search-card');
const pager = document.getElementById('pager');
const FIELDS = ['q', 'specialty', 'type', 'city', 'state', 'zip'];

async function api(path) {
  const res = await fetch(`/api/v1${path}`, { headers: { accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The directory did not answer. Try again in a moment.');
  return data;
}

const where = (p) => [p.city, p.state].filter(Boolean).join(', ') + (p.postal_code ? ` ${p.postal_code}` : '');
const display = (p) => (p.credential ? `${p.name}, ${p.credential}` : p.name);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderResults(data, params) {
  results.replaceChildren();
  resultsCard.hidden = false;
  document.getElementById('results-title').textContent = data.results.length
    ? `${data.results.length} provider${data.results.length === 1 ? '' : 's'} on this page`
    : 'No provider matched';
  if (!data.results.length) results.append(el('li', '', 'Try the last name only, fewer filters, or a nearby city.'));
  for (const p of data.results) {
    const item = el('li');
    const main = el('div');
    const name = el('a', 'name', display(p));
    name.href = `/providers/${p.npi}`;
    main.append(name, el('div', 'spec', p.specialty || 'Specialty not listed'), el('div', 'where', `${where(p)} · NPI ${p.npi}${p.active ? '' : ' · inactive'}`));
    item.append(main, el('span', 'tag', p.type === 'organization' ? 'Organization' : 'Person'));
    results.append(item);
  }
  const link = (page) => `/providers?${new URLSearchParams({ ...params, page: String(page) })}`;
  pager.hidden = data.page === 1 && !data.more;
  document.getElementById('page-label').textContent = `Page ${data.page}`;
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  prev.hidden = data.page === 1;
  prev.href = link(data.page - 1);
  next.hidden = !data.more;
  next.href = link(data.page + 1);
}

function renderDetail({ provider: p }) {
  searchCard.hidden = true;
  resultsCard.hidden = true;
  detailCard.hidden = false;
  document.title = `${display(p)} · Provider directory · tleehealth`;
  document.getElementById('detail-type').textContent = p.type === 'organization' ? 'Organization' : 'Person';
  document.getElementById('detail-name').textContent = display(p);
  document.getElementById('detail-registry').href = p.registry_url;
  const list = document.getElementById('detail-list');
  list.replaceChildren();
  const rows = [
    ['NPI', p.npi],
    ['Status', p.active ? 'Active' : 'Inactive'],
    ['Primary specialty', p.specialty || 'Not listed'],
    ['Also listed', p.specialties.filter((s) => s !== p.specialty).join('; ')],
    ['Address', p.address],
    ['Location', where(p)],
    ['Phone', p.phone],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    list.append(el('dt', '', label), el('dd', '', value));
  }
}

async function search(params) {
  status.textContent = 'Searching…';
  try {
    renderResults(await api(`/providers?${new URLSearchParams(params)}`), params);
    status.textContent = '';
  } catch (err) {
    resultsCard.hidden = true;
    status.textContent = err.message;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const params = {};
  for (const field of FIELDS) {
    const value = String(data.get(field) ?? '').trim();
    if (value) params[field] = value;
  }
  if (!Object.keys(params).some((k) => ['q', 'specialty', 'city', 'zip'].includes(k))) {
    status.textContent = 'Enter a name, a specialty, a city or a ZIP code.';
    return;
  }
  history.pushState(null, '', `/providers?${new URLSearchParams(params)}`);
  search(params);
});

async function route() {
  const npi = location.pathname.match(/^\/providers\/(\d{10})$/)?.[1];
  if (npi) {
    try {
      renderDetail(await api(`/providers/${npi}`));
    } catch (err) {
      status.textContent = err.message;
    }
    return;
  }
  detailCard.hidden = true;
  searchCard.hidden = false;
  const query = new URLSearchParams(location.search);
  const params = {};
  for (const field of [...FIELDS, 'page']) if (query.get(field)) params[field] = query.get(field);
  for (const field of FIELDS) form.elements[field].value = params[field] ?? '';
  if (Object.keys(params).length) await search(params);
  else resultsCard.hidden = true;
}

try {
  const meta = await api('/providers/specialties');
  const chips = document.getElementById('chips');
  for (const s of meta.specialties) {
    form.elements.specialty.append(new Option(s.label, s.id));
    const chip = el('a', '', s.label);
    chip.href = `/providers?specialty=${s.id}`;
    chips.append(chip);
  }
  for (const code of meta.states) form.elements.state.append(new Option(code, code));
} catch (err) {
  status.textContent = err.message;
}
window.addEventListener('popstate', route);
route();
