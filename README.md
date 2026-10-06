# tleehealth.com

Telehealth and practice management on the CoinPay/Profullstack stack: scheduling,
prescriptions, tests and labs, after-visit summaries, notifications and newsletters,
AI follow-up calls on every appointment (Telnyx), and health-record import from any
provider. Patient advocates (navigators) keep care plans and log their time
against care-management programs; the monthly superbill turns those minutes into
Medicare's PIN (G0023/G0024), CHI (G0019/G0022) and CCM (99490/99439) codes. One account can own many orgs; each org has locations, a manager and a bill.

**Health-record import** (`apps/web/src/records.js`): a patient connects MyChart, or any
SMART on FHIR patient portal, at `/portal/records` (or `tleehealth connect`). We copy
everything that API returns, including personal information, visits, after-visit summaries,
notes, labs, imaging, medications, conditions, allergies, immunizations, procedures and the
attached PDFs and images. The patient can download all of it as one zip or FHIR bundle, and
share a connection with a practice. Tokens are sealed with `HEALTH_TOKEN_KEY` (vault).
MyChart needs `EPIC_CLIENT_ID` from an app registered at fhir.epic.com; until then only
the demo sandbox (and servers configured with `SMART_CLIENT_ID`) can connect.

**Pricing:** each org pays for every user on its team: $10/seat/month, or $199/month for
up to 1,000 seats, whichever is lower. Patients and leads are free.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | Bun + Hono: landing page, the app (`/app` for the team, `/portal` for patients, `/signin`), PWA, `/api/v1`, CoinPay webhook |
| `apps/web/public/app` | the browser app: plain ES module + CSS, no build step, talks only to `/api/v1` |
| `packages/db` | Postgres client and migrations (run on every boot); `@profullstack/orgs` for orgs and members |
| `packages/payments` | the shared CoinPay module, copied byte-for-byte from tipoffwatch (`d18b3088`) |
| `design` | the design canvas artboards (`*.dc.html`); `python3 design/build.py` regenerates the landing page |
| `packages/cli` | `@profullstack/tleehealth`: CLI, hqtui front-desk TUI (`tleehealth tui`), API client |
| `packages/mcp` | `@profullstack/tleehealth-mcp`: MCP server over stdio |
| `bin/install.sh` | `curl -fsSL https://tleehealth.com/install.sh \| sh` |

```sh
bun install
bun test           # DATABASE_URL=postgres://… runs the API tests too
bun run dev        # http://localhost:3000 (without RESEND_API_KEY the sign-in link is printed to the log)
```

## Shipping

- **Deploy:** every push to `master` runs `deploy-dev2.yml`, which calls
  `/home/anthony/www/tleehealth.com/deploy-app.sh <sha>` on dev2 (provisioned by
  `cli-tools/dev2/dev2-site`, entry `sites.d/tleehealth.com.json`). Secrets come from
  the logicsrc vault `tleehealth.com--prod` at deploy time, never from a committed `.env`.
- **Release:** bump `version` in both `packages/*/package.json` and merge. `release.yml`
  tags `vX.Y.Z`, creates the GitHub release and publishes both packages to npm.

The API is listed at https://tleehealth.com/llms.txt.
