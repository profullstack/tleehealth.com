# tleehealth.com

Telehealth and practice management on the CoinPay/Profullstack stack: scheduling,
prescriptions, tests and labs, after-visit summaries, notifications and newsletters,
AI follow-up calls on every appointment (Telnyx), and patient-uploaded health-record
files from provider portals. Patient advocates (navigators) keep care plans and log
their time
against care-management programs; the monthly superbill turns those minutes into
Medicare's PIN (G0023/G0024), CHI (G0019/G0022) and CCM (99490/99439) codes. One account can own many orgs; each org has locations, a manager and a bill.

**Health-record import** (`apps/web/src/records.js`): patients can upload files they
downloaded from MyChart or another portal at `/portal/records`. The server classifies
the files and stores their contents for the patient to review, export and optionally
share with a practice. Automatic provider connections are paused: `POST
/api/v1/records/connect` returns 410. The SMART/FHIR importer remains in the codebase,
but is not the current import path.

**End-to-end encrypted personal vault:** the PWA and CLI can encrypt user-selected
files on-device before upload. The API stores ciphertext and an encrypted index;
MCP exposes opaque status only and cannot decrypt the vault. Existing imported
records, old file uploads, provider sync, exports and clinic charts remain
server-readable. There is no desktop app, E2EE provider sync or E2EE chat in this
repository. See [`docs/e2ee-record-vault.md`](docs/e2ee-record-vault.md) for the
exact boundary, recovery behavior and metadata the server can see.

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
| `docs/e2ee-record-vault.md` | E2EE vault protocol, limits and legacy-data boundary |
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
- **Release:** bump the matching `packages/cli` and `packages/mcp` versions and merge.
  `release.yml` tags that CLI version, creates the GitHub release, and publishes the
  shared vault crypto package, CLI and MCP package to npm in dependency order.

The API is listed at https://tleehealth.com/llms.txt.
