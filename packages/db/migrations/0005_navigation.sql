-- Navigation: care plans, care-management programs and the time logged against
-- them, so a practice can bill Medicare's time-based codes (PIN G0023/G0024,
-- PIN peer support G0140/G0146, CHI G0019/G0022, CCM 99490/99439) for the work
-- its advocates and staff already do. The codes and their minute thresholds live
-- in apps/web/src/navigation.js; the database stores facts, not prices.

-- ----------------------------------------------------------- advocate seat --

-- An advocate is on the team and pays a seat. The generated column has to be
-- rebuilt to say so, and the view that reads it with it.
drop view org_seats;
alter table org_people drop column billable;
alter table org_people add column billable boolean generated always as
  (user_type in ('owner', 'org_manager', 'provider', 'staff', 'advocate')) stored;
create view org_seats as
  select org_id, count(*) filter (where billable) as seats
  from org_people group by org_id;

-- A superbill names the billing practitioner by NPI.
alter table org_people add column npi text check (npi ~ '^\d{10}$');

-- -------------------------------------------------------------- care plans --
-- One active plan per patient: the problem, the goals, and who does what by when.
-- Shared plans show in the patient's portal.

create table care_plans (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  patient_id  uuid not null references org_people(id) on delete cascade,
  title       text not null default 'Care plan',
  summary     text,
  owner_id    uuid references org_people(id) on delete set null,
  shared      boolean not null default false,
  status      text not null default 'active' check (status in ('active', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index care_plans_one_active on care_plans (patient_id) where status = 'active';
create index care_plans_org_idx on care_plans (org_id);

create table care_plan_items (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references care_plans(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  kind        text not null default 'task' check (kind in ('goal', 'task')),
  text        text not null,
  owner_id    uuid references org_people(id) on delete set null,  -- null: the patient
  due_on      date,
  status      text not null default 'open' check (status in ('open', 'done', 'dropped')),
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index care_plan_items_plan_idx on care_plan_items (plan_id, status);

-- ---------------------------------------------------------------- programs --
-- A patient enrolled in a care-management program. What a claim needs on file:
-- the condition, consent (renewed yearly for PIN and CHI), the initiating visit
-- with the billing practitioner, and who bills.

create table care_programs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id) on delete cascade,
  patient_id           uuid not null references org_people(id) on delete cascade,
  program              text not null check (program in ('pin', 'pin_ps', 'chi', 'ccm')),
  condition            text,
  navigator_id         uuid references org_people(id) on delete set null,
  billing_provider_id  uuid references org_people(id) on delete set null,
  consent_at           timestamptz,
  consent_by           uuid references org_people(id) on delete set null,
  initiating_visit_on  date,
  status               text not null default 'active' check (status in ('active', 'ended')),
  started_on           date not null default current_date,
  ended_on             date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index care_programs_one_active on care_programs (patient_id, program) where status = 'active';
create index care_programs_org_idx on care_programs (org_id, status);
create index care_programs_navigator_idx on care_programs (navigator_id) where status = 'active';

-- Minutes of navigation work, each against one program, so no minute is counted
-- toward two codes.
create table care_time (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  program_id    uuid not null references care_programs(id) on delete cascade,
  patient_id    uuid not null references org_people(id) on delete cascade,
  person_id     uuid references org_people(id) on delete set null,
  minutes       int not null check (minutes between 1 and 240),
  performed_on  date not null default current_date,
  activity      text not null default 'coordination' check (activity in
                  ('assessment', 'care_plan', 'coordination', 'referral', 'prior_auth',
                   'scheduling', 'education', 'community_resources', 'call', 'other')),
  note          text,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index care_time_program_month_idx on care_time (program_id, performed_on);
create index care_time_org_month_idx on care_time (org_id, performed_on);
