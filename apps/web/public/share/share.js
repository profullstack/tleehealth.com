import { KINDS, fromBase64Url, openShare, shareIdFrom, toCsv, toFhirBundle } from '/assets/share-format.js';

const gate = document.getElementById('gate');
const gateCard = document.getElementById('gate-card');
const shared = document.getElementById('shared');
const rows = document.getElementById('rows');
let payload = null;
let sealed = null;
let shareId = null;

const formatDate = (value) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function cell(row, text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  row.append(td);
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showMessage(titleText, bodyText) {
  gate.replaceChildren();
  const h2 = document.createElement('h2');
  h2.textContent = titleText;
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = bodyText;
  gate.append(h2, p);
}

function showGate(message = '') {
  gate.innerHTML = `
    <p class="eyebrow">Passkey needed</p><h2>Open the shared readings</h2>
    <form id="open-form" class="gate-form">
      <label>Share passkey<input name="passkey" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required></label>
      <button class="primary" type="submit">Open readings</button><p class="hint" id="gate-message" role="status"></p>
    </form>
    <p class="hint" id="expiry"></p>`;
  document.getElementById('gate-message').textContent = message;
  document.getElementById('expiry').textContent = `This link works until ${formatDate(sealed.expires_at)}, or until the person who shared it revokes it.`;
  const form = document.getElementById('open-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('gate-message');
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Decrypting in this browser…';
    try {
      payload = await openShare(shareId, String(new FormData(form).get('passkey')), sealed.envelope, fromBase64Url(sealed.ciphertext));
      form.reset();
      render();
    } catch (err) {
      status.textContent = err.message || 'That passkey does not open this share.';
      button.disabled = false;
    }
  });
  form.querySelector('input').focus();
}

function render() {
  gateCard.hidden = true;
  shared.hidden = false;
  const count = payload.readings.length;
  document.getElementById('shared-title').textContent = payload.from ? `Readings from ${payload.from}` : 'Shared readings';
  document.getElementById('shared-meta').textContent = `${count} reading${count === 1 ? '' : 's'} · shared ${formatDate(payload.sharedAt)}`;
  const message = document.getElementById('shared-message');
  message.hidden = !payload.message;
  message.textContent = payload.message;
  rows.replaceChildren();
  for (const r of payload.readings) {
    const row = document.createElement('tr');
    cell(row, KINDS[r.kind].name, 'measure');
    cell(row, `${r.value} ${r.unit}`, 'reading');
    cell(row, formatDate(r.takenAt), 'date');
    cell(row, r.note, 'note');
    rows.append(row);
  }
}

function lock() {
  payload = null;
  rows.replaceChildren();
  shared.hidden = true;
  gateCard.hidden = false;
  showGate('Locked. Enter the passkey to open the readings again.');
}

const stamp = () => new Date().toISOString().slice(0, 10);
document.getElementById('dl-fhir').addEventListener('click', () =>
  download(`shared-readings-${stamp()}.fhir.json`, 'application/fhir+json', JSON.stringify(toFhirBundle(payload), null, 2)));
document.getElementById('dl-csv').addEventListener('click', () =>
  download(`shared-readings-${stamp()}.csv`, 'text/csv', toCsv(payload)));
document.getElementById('dl-json').addEventListener('click', () =>
  download(`shared-readings-${stamp()}.json`, 'application/json', JSON.stringify(payload, null, 2)));
document.getElementById('print').addEventListener('click', () => window.print());
document.getElementById('close').addEventListener('click', lock);
window.addEventListener('pageshow', (event) => {
  if (event.persisted && payload) lock();
});

try {
  shareId = shareIdFrom(location.pathname);
  const res = await fetch(`/api/v1/shared/${shareId}`, { cache: 'no-store', credentials: 'omit' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) showMessage('This share is no longer available', 'The link has expired or the person who shared it revoked it. Ask them for a new link.');
  else if (!res.ok) showMessage('Could not load this share', data.error || 'Try again in a few minutes.');
  else {
    sealed = data;
    showGate();
  }
} catch {
  showMessage('Could not load this share', 'Check the link and your connection, then try again.');
}
