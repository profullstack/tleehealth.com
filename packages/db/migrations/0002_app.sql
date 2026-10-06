-- The working app: sign-in, scheduling, clinical records, billing and the audit log.

-- ------------------------------------------------------------------ sign-in --
-- Magic link + passkey only. The emailed link proves the address and the address
-- is the account; there are no passwords to leak or reset.

create table login_tokens (
  token_hash  bytea primary key,
  email       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index login_tokens_expires_idx on login_tokens (expires_at);

create table sessions (
  id          text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table passkeys (
  credential_id text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

-- WebAuthn challenges live server-side, keyed by a short-lived cookie, so a
-- challenge can be used once and cannot be chosen by the client.
create table webauthn_challenges (
  id          text primary key,
  challenge   text not null,
  user_id     uuid references users(id) on delete cascade,
  expires_at  timestamptz not null
);

-- API keys for the CLI, TUI and MCP. Only the sha256 is stored.
create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  key_hash    bytea not null unique,
  prefix      text not null,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

-- ------------------------------------------------------------------- people --

alter table org_people add column status text not null default 'active'
  check (status in ('active', 'archived'));
alter table org_people add column dob date;
alter table org_people add column notes text;
alter table org_people add column source text; -- where a lead came from
create index org_people_email_idx on org_people (lower(email));

-- ------------------------------------------------------------- scheduling --

create table appointments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  location_id  uuid references locations(id) on delete set null,
  provider_id  uuid references org_people(id) on delete set null,
  patient_id   uuid not null references org_people(id) on delete cascade,
  starts_at    timestamptz not null,
  minutes      int not null default 30 check (minutes between 5 and 480),
  mode         text not null default 'in_person' check (mode in ('in_person', 'video')),
  status       text not null default 'scheduled'
    check (status in ('scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show')),
  reason       text,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index appointments_org_day_idx on appointments (org_id, starts_at);
create index appointments_patient_idx on appointments (patient_id, starts_at);

-- --------------------------------------------------------------- clinical --

create table medications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  patient_id    uuid not null references org_people(id) on delete cascade,
  name          text not null,
  dose          text,
  directions    text,
  refills_left  int not null default 0 check (refills_left >= 0),
  status        text not null default 'active' check (status in ('active', 'stopped')),
  prescriber_id uuid references org_people(id) on delete set null,
  created_at    timestamptz not null default now(),
  stopped_at    timestamptz
);
create index medications_patient_idx on medications (patient_id);

create table refill_requests (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  medication_id  uuid not null references medications(id) on delete cascade,
  patient_id     uuid not null references org_people(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  note           text,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references org_people(id) on delete set null,
  decided_at     timestamptz
);
create index refill_requests_org_status_idx on refill_requests (org_id, status);
-- One open request per medication: a patient tapping twice makes one request.
create unique index refill_requests_one_pending on refill_requests (medication_id) where status = 'pending';

create table lab_results (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  patient_id    uuid not null references org_people(id) on delete cascade,
  test_name     text not null,
  value         numeric,
  value_text    text,
  unit          text,
  ref_low       numeric,
  ref_high      numeric,
  flag          text generated always as (
    case when value is null then null
         when ref_low is not null and value < ref_low then 'low'
         when ref_high is not null and value > ref_high then 'high'
         else 'normal' end) stored,
  collected_at  date not null default current_date,
  notes         text,
  entered_by    uuid references org_people(id) on delete set null,
  released_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (value is not null or value_text is not null)
);
create index lab_results_patient_idx on lab_results (patient_id, test_name, collected_at);

create table visit_summaries (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  appointment_id uuid unique references appointments(id) on delete set null,
  patient_id     uuid not null references org_people(id) on delete cascade,
  provider_id    uuid references org_people(id) on delete set null,
  diagnosis      text,
  instructions   text,
  med_changes    text,
  follow_up_on   date,
  status         text not null default 'draft' check (status in ('draft', 'signed')),
  signed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index visit_summaries_patient_idx on visit_summaries (patient_id);

-- ---------------------------------------------------------------- billing --
-- An org prepays a month at a time through CoinPay. paid_through is the only
-- fact access depends on; payments is what the shared CoinPay module writes.

create table org_billing (
  org_id        uuid primary key references organizations(id) on delete cascade,
  billing_user  uuid references users(id) on delete set null,
  paid_through  timestamptz
);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null,
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null,
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);

-- One month per settled payment, however many times its webhook is delivered.
create table billing_grants (
  payment_id  uuid primary key references payments(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  granted_at  timestamptz not null default now()
);

-- -------------------------------------------------------------- audit log --
-- Every read of a patient record and every write to one lands here.

create table audit_log (
  id          bigserial primary key,
  org_id      uuid references organizations(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  action      text not null,
  subject     text,
  at          timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (org_id, at desc);

-- A lead can be just a name the front desk took down; it needs at least one of these.
alter table org_people drop constraint if exists org_people_check;
alter table org_people add constraint org_people_identifiable
  check (user_id is not null or email is not null or phone is not null or name is not null);
