# tleehealth.com

Telehealth and practice management on the CoinPay/Profullstack stack: scheduling,
prescriptions, tests and labs, after-visit summaries, notifications and newsletters,
AI follow-up calls on every appointment (Telnyx), and health-record import from any
provider. One account can own many orgs; each org has locations, a manager and a bill.

**Pricing:** each org pays for every user on its team: $10/seat/month, or $199/month for
up to 1,000 seats, whichever is lower. Patients and leads are free.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | Bun + Hono: landing page, `/app` dashboard and `/patient` previews, PWA, `/api/v1` |
| `design` | the design canvas artboards (`*.dc.html`); `python3 design/build.py` regenerates `apps/web/public/*.html` |
| `packages/cli` | `@profullstack/tleehealth`: CLI, hqtui front-desk TUI (`tleehealth tui`), API client |
| `packages/mcp` | `@profullstack/tleehealth-mcp`: MCP server over stdio |
| `bin/install.sh` | `curl -fsSL https://tleehealth.com/install.sh \| sh` |

```sh
bun install
bun test
bun run dev        # http://localhost:3000
```

## Shipping

- **Deploy:** every push to `master` runs `deploy-dev2.yml`, which calls
  `/home/anthony/www/tleehealth.com/deploy-app.sh <sha>` on dev2 (provisioned by
  `cli-tools/dev2/dev2-site`, entry `sites.d/tleehealth.com.json`). Secrets come from
  the logicsrc vault `tleehealth.com--prod` at deploy time, never from a committed `.env`.
- **Release:** bump `version` in both `packages/*/package.json` and merge. `release.yml`
  tags `vX.Y.Z`, creates the GitHub release and publishes both packages to npm.

The schedule endpoint serves clearly marked demo data until accounts and orgs land.
