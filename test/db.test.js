// Runs against a real Postgres when DATABASE_URL is set (CI provides one).
import { afterAll, describe, expect, test } from 'bun:test';
import { close, configured, db, orgs, ping } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

describe.skipIf(!configured())('database', () => {
  afterAll(() => close());

  test('migrations apply, and a second run is a no-op', async () => {
    await migrate({ log: () => {} });
    expect(await migrate({ log: () => {} })).toBe(0);
    expect(await ping()).toBe('ok');
  });

  test('only the team is billed', async () => {
    const sql = db();
    const [owner] = await sql`insert into users (email) values (${`o${Date.now()}@example.com`}) returning id`;
    const org = await orgs.createOrg(sql, { name: `Test Practice ${Date.now()}`, userId: owner.id });
    const [loc] = await sql`insert into locations (org_id, name, booking_slug) values (${org.id}, 'Mission St', 'mission') returning id`;
    for (const t of ['owner', 'provider', 'staff', 'patient', 'lead'])
      await sql`insert into org_people (org_id, user_type, email) values (${org.id}, ${t}, ${`${t}@example.com`})`;
    const [{ seats }] = await sql`select seats from org_seats where org_id = ${org.id}`;
    expect(Number(seats)).toBe(3);
    expect(loc.id).toBeTruthy();
  });
});
