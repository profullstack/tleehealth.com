/**
 * The pit.world network footer, fetched server-side from pit.world/snippets and
 * appended as the last thing in <body> on every page.
 *
 * Module-level cache: the first page waits for the first fetch (3 s timeout);
 * after that a copy older than an hour refreshes in the background and a failed
 * fetch keeps the stale copy. With no copy at all the page is left unchanged.
 */
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=tleehealth.com';
const TTL_MS = 60 * 60 * 1000;

let html = '';
let fetchedAt = 0;
let inflight = null;

function refresh() {
  inflight ??= fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`pit footer ${res.status}`);
      const text = await res.text();
      if (!text.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
      html = text;
      fetchedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The page with the network footer inserted before its last </body>. */
export async function withPitFooter(page) {
  if (Date.now() - fetchedAt > TTL_MS) {
    if (html) refresh();
    else await refresh();
  }
  const i = page.lastIndexOf('</body>');
  return html && i !== -1 ? `${page.slice(0, i)}${html}\n${page.slice(i)}` : page;
}
