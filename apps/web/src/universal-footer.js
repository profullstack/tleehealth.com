import { footerHtml, footerHtmlSync } from '@profullstack/footer';

const options = {
  site: 'https://tleehealth.com/',
  owner: { name: 'tleehealth', url: 'https://tleehealth.com/' },
  links: [
    { label: 'Start a practice', href: '/app' },
    { label: 'Terms', href: '/terms' },
    { label: 'Privacy', href: '/privacy' },
    { label: 'Contact', href: 'mailto:hello@tleehealth.com' },
  ],
  pwamartHref: 'https://pwamart.com/for?site=https://tleehealth.com/',
  builtIndieHref: 'https://built.indie.pit.world/for?site=https://tleehealth.com/',
};
const TTL_MS = 15 * 60 * 1000;

let html = footerHtmlSync(options);
let fetchedAt = 0;
let inflight = null;

async function refresh() {
  inflight ??= footerHtml(options)
    .then((value) => {
      html = value;
      fetchedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

/** Append the universal footer to each HTML page, keeping it in server markup. */
export async function withUniversalFooter(page) {
  if (Date.now() - fetchedAt > TTL_MS) await refresh();
  const i = page.lastIndexOf('</body>');
  if (i === -1) return page;
  const registration = page.includes('/pwa-register.js') ? '' : '<script src="/pwa-register.js" defer></script>\n';
  return `${page.slice(0, i)}${registration}${html}\n${page.slice(i)}`;
}
