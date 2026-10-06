-- tleehealth initial schema. Orgs, org members, teams and invites come from
-- @profullstack/orgs (organizations, org_members, teams, team_members,
-- org_invites), applied first by migrate(). This file adds what a practice needs
-- on top: accounts, locations, and the people in an org with their user type.

-- An account: one login. It can own many orgs, manage orgs it was handed, and be
-- a patient somewhere else. Auth (magic link + passkey) attaches here later.
create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

-- A location is an office of an org. Each one maps to an orgs team so staff can be
-- grouped by office with the package's own membership rules.
create table locations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  team_id       uuid references teams(id) on delete set null,
  name          text not null,
  address       text,
  phone         text,
  timezone      text not null default 'America/Los_Angeles',
  hours         jsonb not null default '{}'::jsonb,
  booking_slug  text not null,
  created_at    timestamptz not null default now(),
  unique (org_id, booking_slug)
);
create index locations_org_idx on locations (org_id);

-- Everyone in an org has exactly one user type there. The team (owner, org
-- manager, providers, staff) is billed per seat; patients and leads are free.
create type user_type as enum ('owner', 'org_manager', 'provider', 'staff', 'patient', 'lead');

create table org_people (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid references users(id) on delete set null, -- a lead may have no account yet
  user_type   user_type not null,
  name        text,
  email       text,
  phone       text,
  billable    boolean generated always as (user_type in ('owner', 'org_manager', 'provider', 'staff')) stored,
  created_at  timestamptz not null default now(),
  check (user_id is not null or email is not null or phone is not null)
);
create unique index org_people_org_user_key on org_people (org_id, user_id) where user_id is not null;
create index org_people_org_type_idx on org_people (org_id, user_type);

-- Limit a person to particular locations; no rows means every location in the org.
create table org_person_locations (
  person_id    uuid not null references org_people(id) on delete cascade,
  location_id  uuid not null references locations(id) on delete cascade,
  primary key (person_id, location_id)
);

-- Seats an org pays for: what billing reads. min($10 x seats, $199) up to 1,000.
create view org_seats as
  select org_id, count(*) filter (where billable) as seats
  from org_people group by org_id;
