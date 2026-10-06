import { configured } from '@tleehealth/db';
import { migrate } from '@tleehealth/db/migrate';
import { app } from './app.js';

// Production never runs without its database; the deploy's health check then
// fails loudly instead of serving a site that cannot store anything.
if (process.env.NODE_ENV === 'production' && !configured())
  throw new Error('DATABASE_URL is not set (it comes from the vault via deploy-app.sh)');

// Migrations run on every boot, before the server listens, so no deploy skips one.
if (configured()) await migrate();

const port = Number(process.env.PORT || 3000);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`[web] tleehealth listening on :${server.port}`);
